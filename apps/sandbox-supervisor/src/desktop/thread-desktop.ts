import type {
  ControlPlaneDesktopMessage,
  DesktopControlHolder,
  SupervisorDesktopMessage,
} from "@barrack/protocol";
import type { AgentProcessLauncher } from "../agent-process/agent-process-launcher.js";
import type { DesktopConfiguration } from "../configuration.js";
import type { Logger } from "../logger.js";
import { DesktopControlFile } from "./desktop-control-file.js";
import { DesktopStreams } from "./desktop-streams.js";
import { type DesktopTiming, noDesktopExplanation, SandboxDesktop } from "./sandbox-desktop.js";

export type ThreadDesktopSettings = {
  /** Undefined for a sandbox without a desktop; every request is then answered so. */
  configuration: DesktopConfiguration | undefined;
  controlPlaneUrl: string;
  threadId: string;
  supervisorToken: string;
  launcher: AgentProcessLauncher;
  sourceEnvironment: NodeJS.ProcessEnv;
  /** Sends a report to the control plane if connected; returns whether it went out. */
  sendDesktopMessage: (message: SupervisorDesktopMessage) => boolean;
  logger: Logger;
  timing?: Partial<DesktopTiming>;
};

/**
 * The supervisor's side of the thread's desktop: keeps the desktop running
 * (`SandboxDesktop`), tells the control plane whether there is one, opens
 * the streams the control plane asks for (`DesktopStreams`), and writes who
 * holds the desktop's input where the agent's computer tool reads it
 * (`DesktopControlFile`).
 */
export class ThreadDesktop {
  readonly #settings: ThreadDesktopSettings;
  readonly #logger: Logger;
  readonly #sandboxDesktop: SandboxDesktop;
  readonly #controlFile: DesktopControlFile | undefined;
  readonly #streams: DesktopStreams | undefined;
  /** Control changes are written one after another, so the last one said is the one on disk. */
  #controlWrites: Promise<void> = Promise.resolve();
  #controlHolder: DesktopControlHolder = "agent";

  constructor(settings: ThreadDesktopSettings) {
    this.#settings = settings;
    this.#logger = settings.logger;
    const { configuration } = settings;
    this.#sandboxDesktop = new SandboxDesktop({
      configuration,
      launcher: settings.launcher,
      sourceEnvironment: settings.sourceEnvironment,
      workingDirectory: "/",
      logger: settings.logger,
      onAvailabilityChanged: () => this.reportAvailability(),
      ...(settings.timing === undefined ? {} : { timing: settings.timing }),
    });
    if (configuration === undefined) {
      return;
    }
    this.#controlFile = new DesktopControlFile(configuration.controlFile);
    this.#streams = new DesktopStreams({
      controlPlaneUrl: settings.controlPlaneUrl,
      threadId: settings.threadId,
      supervisorToken: settings.supervisorToken,
      vncPort: configuration.vncPort,
      reportFailure: (streamId, reason) =>
        settings.sendDesktopMessage({ type: "desktop_stream_failed", streamId, reason }),
      logger: settings.logger,
    });
  }

  /** Who holds the desktop's input now, as the agent's tools must respect it. */
  get controlHolder(): DesktopControlHolder {
    return this.#controlHolder;
  }

  /** Gives the agent control, whatever a previous supervisor left written, then starts the desktop. */
  async start(): Promise<void> {
    await this.#writeControl("agent");
    this.#sandboxDesktop.start();
  }

  async stop(): Promise<void> {
    this.#streams?.closeAll();
    await this.#sandboxDesktop.stop();
  }

  /** Said after every welcome, and whenever the desktop starts or stops. */
  reportAvailability(): void {
    this.#settings.sendDesktopMessage({
      type: "desktop_availability",
      ...this.#sandboxDesktop.availability,
    });
  }

  handle(message: ControlPlaneDesktopMessage): void {
    switch (message.type) {
      case "open_desktop_stream":
        this.#openStream(message.streamId);
        return;
      case "desktop_control":
        this.#logger.info({ holder: message.holder }, "The desktop's control changed hands");
        void this.#writeControl(message.holder);
        return;
    }
  }

  #openStream(streamId: string): void {
    if (this.#streams === undefined) {
      this.#settings.sendDesktopMessage({
        type: "desktop_stream_failed",
        streamId,
        reason: noDesktopExplanation,
      });
      return;
    }
    this.#streams.open(streamId);
  }

  /** A failure is logged: the computer tool then goes on with what the file said before. */
  #writeControl(holder: DesktopControlHolder): Promise<void> {
    this.#controlHolder = holder;
    const controlFile = this.#controlFile;
    if (controlFile === undefined) {
      return Promise.resolve();
    }
    this.#controlWrites = this.#controlWrites
      .then(() => controlFile.write(holder))
      .catch((error: unknown) => {
        this.#logger.error({ err: error, holder }, "Could not write who controls the desktop");
      });
    return this.#controlWrites;
  }
}
