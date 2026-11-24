import {
  type AgentEvent,
  type ControlPlaneToSupervisorMessage,
  type SupervisorToControlPlaneMessage,
  supervisorToControlPlaneMessageSchema,
} from "@barrack/protocol";
import { z } from "zod";
import type { AgentHarness, AgentHarnessObserver } from "./agent-harness.js";
import type { AgentProcessLauncher } from "./agent-process/agent-process-launcher.js";
import type { SupervisorConfiguration } from "./configuration.js";
import {
  type ConnectionTiming,
  ControlPlaneConnection,
} from "./control-plane/control-plane-connection.js";
import { createAgentHarness } from "./create-agent-harness.js";
import {
  fitAgentEventInFrame,
  maximumSupervisorFrameLength,
  measureAgentEventFrame,
} from "./fit-agent-event-in-frame.js";
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
 * out on the agent.
 */
export class Supervisor {
  readonly #logger: Logger;
  readonly #connection: ControlPlaneConnection;
  readonly #harness: AgentHarness;

  constructor(settings: SupervisorSettings) {
    const { configuration, logger } = settings;
    this.#logger = logger;
    this.#connection = new ControlPlaneConnection({
      controlPlaneUrl: configuration.controlPlaneUrl,
      threadId: configuration.threadId,
      supervisorToken: configuration.supervisorToken,
      logger,
      onMessage: (message) => this.#handleControlPlaneMessage(message),
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

  async start(): Promise<void> {
    this.#logger.info("Starting the supervisor");
    this.#connection.open();
    await this.#harness.start();
  }

  /** Stops the agent first, so its last events can still reach the control plane. */
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
        this.#send({ type: "agent_event", event });
      },
      onStreamFragment: (fragment) => this.#send({ type: "stream_fragment", fragment }),
      onAgentProcessEnded: (ending) => {
        this.#logger.info(ending, "The agent's process ended");
      },
    };
  }

  /**
   * The control plane closes the connection on any invalid frame, losing
   * it, so a message that would fail its checks is held back here and
   * logged instead. An event too large for one frame is sent shrunk, saying
   * what was left out; a stream fragment that large is dropped, because the
   * completed message that follows it is the record.
   */
  #send(message: SupervisorToControlPlaneMessage): void {
    const validation = supervisorToControlPlaneMessageSchema.safeParse(message);
    if (!validation.success) {
      this.#logger.error(
        { messageType: message.type, reason: z.prettifyError(validation.error) },
        "Not sending a message that breaks the protocol",
      );
      return;
    }
    const frameLength = JSON.stringify(message).length;
    if (frameLength <= maximumSupervisorFrameLength) {
      this.#connection.send(message);
      return;
    }
    if (message.type === "stream_fragment") {
      this.#logger.warn({ frameLength }, "Dropping a stream fragment too large for one frame");
      return;
    }
    this.#sendOversizedEvent(message.event, frameLength);
  }

  #sendOversizedEvent(event: AgentEvent, frameLength: number): void {
    const fittedEvent = fitAgentEventInFrame(event);
    const fittedFrameLength = measureAgentEventFrame(fittedEvent);
    if (fittedFrameLength > maximumSupervisorFrameLength) {
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
    this.#connection.send({ type: "agent_event", event: fittedEvent });
  }

  #handleControlPlaneMessage(message: ControlPlaneToSupervisorMessage): void {
    switch (message.type) {
      case "deliver_user_message":
        this.#logger.info({ messageId: message.messageId }, "Received a user message");
        this.#harness.deliverUserMessage({ messageId: message.messageId, text: message.text });
        return;
      case "interrupt_agent":
        this.#logger.info("Received an interrupt");
        this.#harness.interrupt().catch((error: unknown) => {
          this.#logger.error({ err: error }, "Interrupting the agent failed");
        });
        return;
    }
  }
}
