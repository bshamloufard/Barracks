import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  agentEventSchema,
  type DeliverUserMessage,
  maximumAgentEventFrameLength,
  type StreamFragment,
  streamFragmentSchema,
} from "@barrack/protocol";
import { z } from "zod";
import type { AgentHarness, AgentHarnessObserver } from "./agent-harness.js";
import type { AgentProcessLauncher } from "./agent-process/agent-process-launcher.js";
import type { SupervisorConfiguration } from "./configuration.js";
import {
  type AgentRequest,
  type ConnectionTiming,
  ControlPlaneConnection,
} from "./control-plane/control-plane-connection.js";
import { createAgentHarness } from "./create-agent-harness.js";
import { DeliveredUserMessages } from "./delivery/delivered-user-messages.js";
import { fitAgentEventInFrame, measureAgentEventFrame } from "./fit-agent-event-in-frame.js";
import type { Logger } from "./logger.js";

export type SupervisorSettings = {
  configuration: SupervisorConfiguration;
  /** The supervisor's own environment; the agent's is built from an allowlist of it. */
  sourceEnvironment: NodeJS.ProcessEnv;
  /** Decides which operating-system user the agent runs as. */
  agentProcessLauncher: AgentProcessLauncher;
  logger: Logger;
  /** Something happened that the supervisor cannot recover from; it should exit. */
  onFatalError: (error: Error) => void;
  connectionTiming?: Partial<ConnectionTiming>;
};

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
  /** Read from disk when the supervisor starts. */
  #deliveredUserMessages: DeliveredUserMessages | undefined;
  /** Requests from the control plane, carried out one after another in the order they came. */
  #agentRequests: Promise<void> = Promise.resolve();

  constructor(settings: SupervisorSettings) {
    const { configuration, logger } = settings;
    this.#configuration = configuration;
    this.#logger = logger;
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
      onFatalError: settings.onFatalError,
      ...(settings.connectionTiming === undefined ? {} : { timing: settings.connectionTiming }),
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
   * frame is sent shrunk, saying what was left out.
   */
  #sendAgentEvent(event: AgentEvent): void {
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

  /** A fragment that would fail the checks is dropped: the completed message that follows is the record. */
  #sendStreamFragment(fragment: StreamFragment): void {
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
      case "interrupt_agent":
        this.#logger.info("Received an interrupt");
        this.#harness.interrupt().catch((error: unknown) => {
          this.#logger.error({ err: error }, "Interrupting the agent failed");
        });
        return;
    }
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
    this.#logger.info({ sequence, messageId }, "Handing a user message to the agent");
    await deliveredUserMessages.noteHandingOver(sequence);
    this.#harness.deliverUserMessage({ messageId, text: message.text });
    this.#connection.acknowledgeUserMessages(sequence);
  }
}
