import { type DesktopAvailability, maximumErrorMessageLength } from "@barrack/protocol";
import type {
  AgentProcessLauncher,
  AgentProcessStdio,
} from "../agent-process/agent-process-launcher.js";
import type { DesktopConfiguration } from "../configuration.js";
import type { Logger } from "../logger.js";
import { isVncServerAnswering } from "./vnc-server-probe.js";

export type DesktopAvailabilityReport = Omit<DesktopAvailability, "type">;

export type DesktopTiming = {
  /** How long a started desktop has to answer on its VNC port. */
  startupTimeoutInMilliseconds: number;
  probeIntervalInMilliseconds: number;
  /** The first pause before starting a desktop that ended; it doubles up to the maximum. */
  firstRestartDelayInMilliseconds: number;
  maximumRestartDelayInMilliseconds: number;
  /** A desktop that ran this long before ending is restarted after the first delay again. */
  stableRunInMilliseconds: number;
  /**
   * How many times in a row a desktop may end before it ran stably, before
   * it is given up on and reported unavailable rather than restarted for
   * ever while claiming to be starting.
   */
  maximumConsecutiveFailures: number;
  /** How long stopping waits for the desktop to end once asked. */
  stopTimeoutInMilliseconds: number;
};

export const defaultDesktopTiming: DesktopTiming = {
  startupTimeoutInMilliseconds: 20_000,
  probeIntervalInMilliseconds: 100,
  firstRestartDelayInMilliseconds: 1_000,
  maximumRestartDelayInMilliseconds: 30_000,
  stableRunInMilliseconds: 60_000,
  maximumConsecutiveFailures: 5,
  stopTimeoutInMilliseconds: 5_000,
};

export type SandboxDesktopSettings = {
  /** Undefined for a sandbox without a desktop. */
  configuration: DesktopConfiguration | undefined;
  /** The desktop runs as the agent, like everything else the agent can see. */
  launcher: AgentProcessLauncher;
  /** Where `PATH` and the locale are taken from; nothing else of it is passed on. */
  sourceEnvironment: NodeJS.ProcessEnv;
  workingDirectory: string;
  logger: Logger;
  onAvailabilityChanged: (availability: DesktopAvailabilityReport) => void;
  timing?: Partial<DesktopTiming>;
  /** Asks whether the VNC server answers; replaced in tests. */
  isVncServerAnswering?: (port: number) => Promise<boolean>;
};

export const noDesktopExplanation =
  "This sandbox has no desktop: its image does not provide one (the sandbox runs without a display).";

const restartingExplanation = "The sandbox's desktop stopped and is being started again.";
const startingExplanation = "The sandbox's desktop is starting.";

/** Enough of what the desktop printed to say why it ended. */
const recentOutputMaximumLength = 2_000;

/**
 * Keeps the sandbox's desktop running for as long as the supervisor runs:
 * starts the desktop command as the agent, reports the desktop available
 * once its VNC server answers, and starts it again, after a growing pause,
 * whenever it ends. A desktop that does not answer in time is asked to end,
 * and so is restarted too.
 *
 * The command runs in the foreground and ends when its standard input
 * closes, which is how it is stopped: the supervisor runs as another user
 * and cannot signal the agent's processes.
 */
export class SandboxDesktop {
  readonly #settings: SandboxDesktopSettings;
  readonly #timing: DesktopTiming;
  readonly #logger: Logger;
  readonly #isVncServerAnswering: (port: number) => Promise<boolean>;
  #availability: DesktopAvailabilityReport = {
    status: "starting",
    explanation: startingExplanation,
  };
  #process: AgentProcessStdio | undefined;
  #exited: Promise<void> = Promise.resolve();
  #restartTimer: NodeJS.Timeout | undefined;
  #restartAttempt = 0;
  #isStopping = false;

  constructor(settings: SandboxDesktopSettings) {
    this.#settings = settings;
    this.#timing = { ...defaultDesktopTiming, ...settings.timing };
    this.#logger = settings.logger.child({ component: "desktop" });
    this.#isVncServerAnswering = settings.isVncServerAnswering ?? isVncServerAnswering;
  }

  get availability(): DesktopAvailabilityReport {
    return this.#availability;
  }

  start(): void {
    const { configuration } = this.#settings;
    if (configuration === undefined) {
      this.#report({ status: "none", explanation: noDesktopExplanation });
      return;
    }
    this.#launch(configuration);
  }

  /** Asks the desktop to end and waits a little for it; it never starts again after this. */
  async stop(): Promise<void> {
    this.#isStopping = true;
    clearTimeout(this.#restartTimer);
    const desktopProcess = this.#process;
    if (desktopProcess === undefined) {
      return;
    }
    desktopProcess.stdin.end();
    const timedOut = new Promise<"timed out">((resolve) =>
      setTimeout(() => resolve("timed out"), this.#timing.stopTimeoutInMilliseconds).unref(),
    );
    if ((await Promise.race([this.#exited, timedOut])) === "timed out") {
      this.#logger.warn("The desktop did not end in time after being asked to; leaving it");
    }
  }

  #launch(configuration: DesktopConfiguration): void {
    const startedAt = Date.now();
    const desktopProcess = this.#settings.launcher.launchCommand({
      executable: configuration.command,
      arguments: [],
      workingDirectory: this.#settings.workingDirectory,
      environment: this.#buildEnvironment(configuration),
    });
    this.#process = desktopProcess;
    this.#logger.info({ command: configuration.command }, "Starting the desktop");
    const recentOutput = this.#collectOutput(desktopProcess);
    const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
    this.#exited = exited;
    let hasExited = false;
    const handleEnd = (description: string) => {
      if (hasExited) {
        return;
      }
      hasExited = true;
      markExited();
      this.#handleExit(configuration, description, Date.now() - startedAt, recentOutput());
    };
    desktopProcess.once("exit", (exitCode, signal) =>
      handleEnd(signal === null ? `exit code ${exitCode}` : `signal ${signal}`),
    );
    desktopProcess.once("error", (error) => handleEnd(`could not be run: ${error.message}`));
    void this.#waitUntilAnswering(configuration, desktopProcess, () => hasExited);
  }

  async #waitUntilAnswering(
    configuration: DesktopConfiguration,
    desktopProcess: AgentProcessStdio,
    hasExited: () => boolean,
  ): Promise<void> {
    const deadline = Date.now() + this.#timing.startupTimeoutInMilliseconds;
    while (!hasExited() && !this.#isStopping) {
      if (await this.#isVncServerAnswering(configuration.vncPort)) {
        this.#report({ status: "running" });
        this.#logger.info({ vncPort: configuration.vncPort }, "The desktop is running");
        return;
      }
      if (Date.now() > deadline) {
        this.#logger.warn(
          { vncPort: configuration.vncPort },
          "The desktop did not answer in time; asking it to end so it is started again",
        );
        desktopProcess.stdin.end();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.#timing.probeIntervalInMilliseconds));
    }
  }

  #handleExit(
    configuration: DesktopConfiguration,
    description: string,
    runTimeInMilliseconds: number,
    recentOutput: string,
  ): void {
    this.#process = undefined;
    if (this.#isStopping) {
      this.#logger.info({ description }, "The desktop ended");
      return;
    }
    if (runTimeInMilliseconds >= this.#timing.stableRunInMilliseconds) {
      this.#restartAttempt = 0;
    }
    if (this.#restartAttempt + 1 >= this.#timing.maximumConsecutiveFailures) {
      this.#giveUp(description, recentOutput);
      return;
    }
    const delay = Math.min(
      this.#timing.firstRestartDelayInMilliseconds * 2 ** this.#restartAttempt,
      this.#timing.maximumRestartDelayInMilliseconds,
    );
    this.#restartAttempt += 1;
    this.#logger.warn(
      { description, recentOutput, restartDelayInMilliseconds: delay },
      "The desktop ended unexpectedly; starting it again later",
    );
    this.#report({ status: "starting", explanation: restartingExplanation });
    this.#restartTimer = setTimeout(() => this.#launch(configuration), delay);
  }

  /**
   * A desktop that keeps ending at once (a broken image, a runtime that will
   * not run Xvnc) would otherwise be restarted for ever, every thirty
   * seconds, and shown as starting the whole time. It is reported
   * unavailable instead, with its own last words, until the supervisor is
   * started again, as resuming the thread does.
   */
  #giveUp(description: string, recentOutput: string): void {
    const failures = this.#timing.maximumConsecutiveFailures;
    this.#logger.error(
      { description, recentOutput, failures },
      "The desktop ended before running stably too many times in a row; giving up on it",
    );
    const lastWords = recentOutput.trim().split("\n").at(-1)?.trim() ?? "";
    const explanation = `The sandbox's desktop stopped ${failures} times in a row soon after starting, so it is not started again until the sandbox restarts${lastWords === "" ? "" : `. It last said: ${lastWords}`}`;
    this.#report({ status: "none", explanation: limitLength(explanation) });
  }

  /** The desktop's own messages are kept for diagnosis, not logged line by line. */
  #collectOutput(desktopProcess: AgentProcessStdio): () => string {
    let output = "";
    const keep = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-recentOutputMaximumLength);
    };
    desktopProcess.stdout.on("data", keep);
    desktopProcess.stderr.on("data", keep);
    return () => output;
  }

  /**
   * Only what the desktop needs: no token, no key, nothing else of the
   * supervisor's. The launcher sets the variables that name the user.
   */
  #buildEnvironment(configuration: DesktopConfiguration): NodeJS.ProcessEnv {
    const { PATH: searchPath, LANG: locale } = this.#settings.sourceEnvironment;
    return {
      ...(searchPath === undefined ? {} : { PATH: searchPath }),
      ...(locale === undefined ? {} : { LANG: locale }),
      DISPLAY: configuration.display,
      BARRACK_DESKTOP_VNC_PORT: String(configuration.vncPort),
    };
  }

  #report(availability: DesktopAvailabilityReport): void {
    const isUnchanged =
      availability.status === this.#availability.status &&
      availability.explanation === this.#availability.explanation;
    this.#availability = availability;
    if (!isUnchanged) {
      this.#settings.onAvailabilityChanged(availability);
    }
  }
}

function limitLength(text: string): string {
  return text.length <= maximumErrorMessageLength
    ? text
    : `${text.slice(0, maximumErrorMessageLength - 1)}…`;
}
