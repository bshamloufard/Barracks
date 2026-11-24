import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  agentEventSchema,
  type ConfigureModelAccess,
  type DeliverUserMessage,
  maximumAgentEventFrameLength,
  type StreamFragment,
  streamFragmentSchema,
  type WorkspaceEvent,
  workspaceEventSchema,
} from "@barrack/protocol";
import { z } from "zod";
import type { AgentHarness, AgentHarnessObserver } from "./agent-harness.js";
import type { AgentProcessLauncher } from "./agent-process/agent-process-launcher.js";
import type { SupervisorConfiguration } from "./configuration.js";
import {
  type AgentRequest,
  type ConnectionTiming,
  ControlPlaneConnection,
  type WorkspaceMessage,
} from "./control-plane/control-plane-connection.js";
import { createAgentHarness } from "./create-agent-harness.js";
import { DeliveredUserMessages } from "./delivery/delivered-user-messages.js";
import { fitAgentEventInFrame, measureAgentEventFrame } from "./fit-agent-event-in-frame.js";
import type { Logger } from "./logger.js";
import type { SecretRedactor } from "./secret-redactor.js";
import type { CredentialAnswer } from "./workspace/git-credential-server.js";
import { sendPublicationBundle } from "./workspace/publication-bundle.js";
import { ThreadWorkspace } from "./workspace/thread-workspace.js";

export type SupervisorSettings = {
  configuration: SupervisorConfiguration;
  /** The supervisor's own environment; the agent's is built from an allowlist of it. */
  sourceEnvironment: NodeJS.ProcessEnv;
  /** Decides which operating-system user the agent runs as. */
  agentProcessLauncher: AgentProcessLauncher;
  logger: Logger;
  /**
   * Learns each model credential as it arrives, and keeps every one out of
   * what the agent reports; the logger should use the same one.
   */
  secretRedactor: SecretRedactor;
  /** Something happened that the supervisor cannot recover from; it should exit. */
  onFatalError: (error: Error) => void;
  connectionTiming?: Partial<ConnectionTiming>;
  /** How long a credential request waits for the control plane. */
  credentialRequestTimeoutInMilliseconds?: number;
};

const defaultCredentialRequestTimeoutInMilliseconds = 30_000;

/**
 * Joins the agent to the control plane: what the agent does is checked and
 * sent to the control plane, and what the control plane asks for is carried
 * out on the agent, each user message exactly once.
 */
export class Supervisor {
  readonly #configuration: SupervisorConfiguration;
  readonly #logger: Logger;
  readonly #connection: ControlPlaneConnection;
  readonly #harness: AgentHarness;
  readonly #workspace: ThreadWorkspace;
  readonly #credentialRequestTimeoutInMilliseconds: number;
  readonly #secretRedactor: SecretRedactor;
  /** Credential requests sent to the control plane, by request identifier. */
  readonly #pendingCredentialRequests = new Map<string, (answer: CredentialAnswer) => void>();
  /** Read from disk when the supervisor starts. */
  #deliveredUserMessages: DeliveredUserMessages | undefined;
  /** Requests from the control plane, carried out one after another in the order they came. */
  #agentRequests: Promise<void> = Promise.resolve();

  constructor(settings: SupervisorSettings) {
    const { configuration, logger } = settings;
    this.#configuration = configuration;
    this.#logger = logger;
    this.#secretRedactor = settings.secretRedactor;
    this.#connection = new ControlPlaneConnection({
      controlPlaneUrl: configuration.controlPlaneUrl,
      threadId: configuration.threadId,
      supervisorToken: configuration.supervisorToken,
      // A new identity for every process: what an earlier process had not
      // had confirmed died with it, which is how the control plane knows to
      // close a run that process left open.
      supervisorInstanceId: randomUUID(),
      readUserMessagesDeliveredThrough: () =>
        this.#deliveredUserMessages?.deliveredThroughSequence ?? 0,
      logger,
      onAgentRequest: (request) => this.#queueAgentRequest(request),
      onWorkspaceMessage: (message) => this.#handleWorkspaceMessage(message),
      onFatalError: settings.onFatalError,
      ...(settings.connectionTiming === undefined ? {} : { timing: settings.connectionTiming }),
    });
    this.#credentialRequestTimeoutInMilliseconds =
      settings.credentialRequestTimeoutInMilliseconds ??
      defaultCredentialRequestTimeoutInMilliseconds;
    this.#workspace = new ThreadWorkspace({
      workspaceDirectory: configuration.workspaceDirectory,
      supervisorStateDirectory: configuration.supervisorStateDirectory,
      credentialSocketPath: configuration.gitCredentialSocketPath,
      launcher: settings.agentProcessLauncher,
      sourceEnvironment: settings.sourceEnvironment,
      reportEvent: (event) => this.#sendWorkspaceEvent(event),
      requestCredential: () => this.#requestCredential(),
      logger,
    });
    this.#harness = createAgentHarness(configuration.agentHarness, this.#createObserver(), {
      threadId: configuration.threadId,
      sourceEnvironment: settings.sourceEnvironment,
      agentProcessLauncher: settings.agentProcessLauncher,
      logger,
    });
  }

  /** Reads what was delivered before a restart first, since every hello repeats it. */
  async start(): Promise<void> {
    this.#logger.info("Starting the supervisor");
    this.#deliveredUserMessages = await DeliveredUserMessages.load(
      this.#configuration.supervisorStateDirectory,
      this.#logger,
    );
    this.#connection.open();
    await this.#harness.start();
  }

  /**
   * Stops the agent first, so its last events can still reach the control
   * plane, and gives the control plane a moment to confirm them.
   */
  async stop(): Promise<void> {
    this.#logger.info("Stopping the supervisor");
    await this.#harness.stop();
    await this.#workspace.stop();
    await this.#connection.close();
    this.#logger.info("Stopped the supervisor");
  }

  #createObserver(): AgentHarnessObserver {
    return {
      onAgentEvent: (event) => {
        this.#logger.info({ eventType: event.type }, "Agent event");
        this.#sendAgentEvent(event);
      },
      onStreamFragment: (fragment) => this.#sendStreamFragment(fragment),
      onAgentProcessEnded: (ending) => {
        this.#logger.info(ending, "The agent's process ended");
      },
    };
  }

  /**
   * The control plane closes the connection on any invalid frame, and an
   * event is sent again until it is recorded, so an event that would fail
   * its checks is held back here and logged instead. One too large for a
   * frame is sent shrunk, saying what was left out. A model credential is
   * never sent, wherever in the event it turned up.
   */
  #sendAgentEvent(reportedEvent: AgentEvent): void {
    const event = this.#secretRedactor.redactValue(reportedEvent);
    const validation = agentEventSchema.safeParse(event);
    if (!validation.success) {
      this.#logger.error(
        { eventType: event.type, reason: z.prettifyError(validation.error) },
        "Not sending an agent event that breaks the protocol",
      );
      return;
    }
    const frameLength = measureAgentEventFrame(event);
    if (frameLength <= maximumAgentEventFrameLength) {
      this.#connection.sendAgentEvent(event);
      return;
    }
    const fittedEvent = fitAgentEventInFrame(event);
    const fittedFrameLength = measureAgentEventFrame(fittedEvent);
    if (fittedFrameLength > maximumAgentEventFrameLength) {
      this.#logger.error(
        { eventType: event.type, frameLength: fittedFrameLength },
        "Not sending an agent event that is too large even after shrinking",
      );
      return;
    }
    this.#logger.warn(
      { eventType: event.type, frameLength, fittedFrameLength },
      "Shrank an agent event too large for one frame",
    );
    this.#connection.sendAgentEvent(fittedEvent);
  }

  /** Workspace events are small and fixed in shape, so they need no shrinking. */
  #sendWorkspaceEvent(event: WorkspaceEvent): void {
    const validation = workspaceEventSchema.safeParse(event);
    if (!validation.success) {
      this.#logger.error(
        { eventType: event.type, reason: z.prettifyError(validation.error) },
        "Not sending a workspace event that breaks the protocol",
      );
      return;
    }
    this.#connection.sendAgentEvent(event);
  }

  /**
   * Asks the control plane for the thread's repository credentials. It
   * never throws: a refusal says why, for Git to show.
   */
  #requestCredential(): Promise<CredentialAnswer> {
    const requestId = randomUUID();
    const { promise, resolve } = Promise.withResolvers<CredentialAnswer>();
    const timer = setTimeout(() => {
      this.#pendingCredentialRequests.delete(requestId);
      resolve({ isGranted: false, reason: "the control plane did not answer in time" });
    }, this.#credentialRequestTimeoutInMilliseconds);
    this.#pendingCredentialRequests.set(requestId, (answer) => {
      clearTimeout(timer);
      this.#pendingCredentialRequests.delete(requestId);
      resolve(answer);
    });
    const isSent = this.#connection.sendWorkspaceMessage({
      type: "repository_credential_request",
      requestId,
    });
    if (!isSent) {
      this.#pendingCredentialRequests.get(requestId)?.({
        isGranted: false,
        reason: "the sandbox is not connected to the control plane right now",
      });
    }
    return promise;
  }

  #handleWorkspaceMessage(message: WorkspaceMessage): void {
    if (message.type === "repository_credential") {
      const { outcome } = message;
      this.#pendingCredentialRequests.get(message.requestId)?.(
        outcome.isGranted
          ? {
              isGranted: true,
              credential: { username: outcome.username, password: outcome.password },
            }
          : { isGranted: false, reason: outcome.reason },
      );
      return;
    }
    this.#logger.info(
      { publicationId: message.publicationId },
      "Asked for the work branch's bundle",
    );
    sendPublicationBundle(message, {
      workspace: this.#workspace,
      supervisorStateDirectory: this.#configuration.supervisorStateDirectory,
      controlPlaneHttpUrl: this.#configuration.controlPlaneUrl.replace(/^ws/, "http"),
      supervisorToken: this.#configuration.supervisorToken,
      logger: this.#logger,
    }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : "The bundle could not be made.";
      this.#logger.warn(
        { publicationId: message.publicationId, reason },
        "Could not send the bundle",
      );
      this.#connection.sendWorkspaceMessage({
        type: "publication_bundle_failed",
        publicationId: message.publicationId,
        reason,
      });
    });
  }

  /** A fragment that would fail the checks is dropped: the completed message that follows is the record. */
  #sendStreamFragment(reportedFragment: StreamFragment): void {
    const fragment = this.#secretRedactor.redactValue(reportedFragment);
    const validation = streamFragmentSchema.safeParse(fragment);
    if (!validation.success) {
      this.#logger.error(
        { reason: z.prettifyError(validation.error) },
        "Not sending a stream fragment that breaks the protocol",
      );
      return;
    }
    const frameLength = JSON.stringify({ type: "stream_fragment", fragment }).length;
    if (frameLength > maximumAgentEventFrameLength) {
      this.#logger.warn({ frameLength }, "Dropping a stream fragment too large for one frame");
      return;
    }
    this.#connection.sendStreamFragment(fragment);
  }

  /**
   * Handing a message over waits for a file write, so requests go through
   * one chain: an interrupt that arrives after a message is carried out
   * after it, as the user sent them.
   */
  #queueAgentRequest(request: AgentRequest): void {
    this.#agentRequests = this.#agentRequests
      .then(() => this.#carryOutAgentRequest(request))
      .catch((error: unknown) => {
        this.#logger.error(
          { err: error, requestType: request.type },
          "Could not carry out a request",
        );
      });
  }

  async #carryOutAgentRequest(request: AgentRequest): Promise<void> {
    switch (request.type) {
      case "deliver_user_message":
        await this.#handOverUserMessage(request);
        return;
      case "prepare_workspace":
        await this.#workspace.prepare(request);
        return;
      case "configure_model_access":
        this.#configureModelAccess(request);
        return;
      case "interrupt_agent":
        this.#logger.info("Received an interrupt");
        this.#harness.interrupt().catch((error: unknown) => {
          this.#logger.error({ err: error }, "Interrupting the agent failed");
        });
        return;
    }
  }

  /** The credential is learnt by the redactor before anything could repeat it. */
  #configureModelAccess(request: ConfigureModelAccess): void {
    if (request.credential !== null) {
      this.#secretRedactor.remember(request.credential.secret);
    }
    this.#logger.info(
      { model: request.model, hasCredential: request.credential !== null },
      "Configuring the agent's model access",
    );
    this.#harness.configureModelAccess({ model: request.model, credential: request.credential });
  }

  /**
   * A message at or before the last one handed over is a redelivery, after
   * an acknowledgement was lost: it is acknowledged again and the agent is
   * not given it a second time.
   */
  async #handOverUserMessage(message: DeliverUserMessage): Promise<void> {
    const deliveredUserMessages = this.#deliveredUserMessages;
    if (deliveredUserMessages === undefined) {
      throw new Error("A user message arrived before the supervisor had started.");
    }
    const { sequence, messageId } = message;
    if (deliveredUserMessages.includes(sequence)) {
      this.#logger.info({ sequence, messageId }, "Ignored a user message the agent already has");
      this.#connection.acknowledgeUserMessages(deliveredUserMessages.deliveredThroughSequence);
      return;
    }
    if (!(await this.#workspace.isReadyForMessages())) {
      // The clone failed, or the workspace was never described, and the
      // user was told so in an event; the message is acknowledged without
      // reaching an agent with no repository.
      this.#logger.warn(
        { sequence, messageId },
        "Withheld a user message from an agent without its repository",
      );
      await deliveredUserMessages.noteHandingOver(sequence);
      this.#connection.acknowledgeUserMessages(sequence);
      return;
    }
    this.#logger.info({ sequence, messageId }, "Handing a user message to the agent");
    await deliveredUserMessages.noteHandingOver(sequence);
    this.#harness.deliverUserMessage({ messageId, text: message.text });
    this.#connection.acknowledgeUserMessages(sequence);
  }
}
