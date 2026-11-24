import type {
  AgentEventMessage,
  ConfigureModelAccess,
  RecordedThreadEvent,
  ThreadEvent,
  UserMessageEvent,
} from "@barrack/protocol";
import { closeCodes, maximumFrameLength, measureLargestThreadEventFrame } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import { standardCloseCodes } from "../standard-close-codes.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type { SupervisorConnection } from "./connections.js";
import { type MissedRange, readMissedEvents } from "./read-missed-events.js";
import type { RelayForSupervisors, SupervisorAttachment } from "./supervisor-attachment.js";
import type { ThreadActivity } from "./thread-activity.js";
import {
  type ModelAccessConnection,
  newModelAccessConnection,
  type ThreadModelAccess,
} from "./thread-model-access.js";

/*
 * One supervisor connection that said hello and was welcomed, for as long as
 * it is its thread's supervisor: numbered, acknowledged delivery in both
 * directions over it, and what it was told of its thread's model access.
 * Agent events it sends are recorded exactly once, in number order, and
 * acknowledged only once recorded; user messages are handed to it in
 * sequence order, each once, and their delivery noted when it acknowledges
 * them (see the handshake in `packages/protocol/src/supervisor-messages.ts`).
 */

export type SupervisorSessionOptions = {
  threadId: string;
  connection: SupervisorConnection;
  supervisorInstanceId: string;
  /** Every event of this instance up to this number is already recorded. */
  lastRecordedEventNumber: number;
  /** How far user messages are known handed to this supervisor's agent; see `deliveryCursor`. */
  deliveryCursor: number;
  threadEventLog: ThreadEventLog;
  threadActivity: ThreadActivity;
  modelAccess: ThreadModelAccess;
  /** Shows clients what the session records, and keeps how far user messages are delivered. */
  relay: RelayForSupervisors;
  /** Decides whether this session is still the thread's supervisor, and forgets it when it breaks. */
  attachment: SupervisorAttachment;
  logger: Logger;
};

export class SupervisorSession {
  readonly connection: SupervisorConnection;
  readonly supervisorInstanceId: string;
  readonly #threadId: string;
  readonly #threadEventLog: ThreadEventLog;
  readonly #threadActivity: ThreadActivity;
  readonly #modelAccess: ThreadModelAccess;
  readonly #relay: RelayForSupervisors;
  readonly #attachment: SupervisorAttachment;
  readonly #logger: Logger;
  /** Every event of this instance up to this number is recorded. */
  #lastRecordedEventNumber: number;
  /**
   * How far the thread's history has been searched for user messages to
   * hand this supervisor. Every user message at or before it was either
   * sent on this connection or delivered before the supervisor attached.
   */
  #deliveryCursor: number;
  /** Its sandbox is being stopped, so it is handed no more user messages. */
  #isSandboxStopping = false;
  /**
   * The model access last sent on this connection, as sent, so the same is
   * not sent again. It holds a key, in memory only, as the message did.
   */
  #sentModelAccess: string | undefined;
  /** What this connection was given for the model proxy; see `ModelAccessConnection`. */
  #modelAccessConnection: ModelAccessConnection = newModelAccessConnection();

  constructor(options: SupervisorSessionOptions) {
    this.connection = options.connection;
    this.supervisorInstanceId = options.supervisorInstanceId;
    this.#threadId = options.threadId;
    this.#threadEventLog = options.threadEventLog;
    this.#threadActivity = options.threadActivity;
    this.#modelAccess = options.modelAccess;
    this.#relay = options.relay;
    this.#attachment = options.attachment;
    this.#logger = options.logger;
    this.#lastRecordedEventNumber = options.lastRecordedEventNumber;
    this.#deliveryCursor = options.deliveryCursor;
  }

  get deliveryCursor(): number {
    return this.#deliveryCursor;
  }

  /** Tells the supervisor which of its events are recorded; it sends the rest again. */
  welcome(): void {
    this.connection.send({
      type: "supervisor_welcome",
      lastRecordedEventNumber: this.#lastRecordedEventNumber,
    });
  }

  /**
   * Tells a supervisor that has just been welcomed its thread's model and
   * key, before it is handed any user message. Returns false, having closed
   * the connection, if that cannot be read; the supervisor then tries again.
   */
  async describeModelAccess(): Promise<boolean> {
    try {
      await this.#sendModelAccess(
        await this.#modelAccess.describe(this.#threadId, this.#modelAccessConnection),
      );
      return true;
    } catch (error) {
      this.#logger.error({ err: error }, "Could not read the thread's model access");
      this.#attachment.forgetSupervisor();
      this.connection.close(
        standardCloseCodes.internalError,
        "The control plane could not read the thread's model access",
      );
      return false;
    }
  }

  /**
   * Tells the supervisor its model access again if it has changed since it
   * was last told. A failure to read it is logged and leaves the supervisor
   * with what it has; the next refresh tries again.
   */
  async refreshModelAccess(): Promise<void> {
    try {
      await this.#sendModelAccess(
        await this.#modelAccess.describe(this.#threadId, this.#modelAccessConnection),
      );
    } catch (error) {
      this.#logger.error({ err: error }, "Could not read the thread's model access to refresh it");
    }
  }

  /** Never logs the message, which holds the owner's key. */
  async #sendModelAccess(message: ConfigureModelAccess): Promise<void> {
    const serialised = JSON.stringify(message);
    if (serialised === this.#sentModelAccess) {
      return;
    }
    if (this.connection.send(message)) {
      this.#sentModelAccess = serialised;
      this.#logger.info(
        { model: message.model, hasCredential: message.credential !== null },
        "Told the supervisor its thread's model access",
      );
    }
  }

  /**
   * The thread's sandbox is about to stop: the agent is asked to end its run,
   * and is handed no more user messages, which it would only lose.
   */
  prepareForStop(): void {
    this.#isSandboxStopping = true;
    if (this.connection.send({ type: "interrupt_agent" })) {
      this.#logger.info("Interrupted the agent because its sandbox is stopping");
    }
  }

  /** The stop is over and this supervisor is still here: it is handed what was held back. */
  async finishStop(): Promise<void> {
    if (!this.#isSandboxStopping) {
      return;
    }
    this.#isSandboxStopping = false;
    // The stop revoked the thread's model proxy tokens (see `assembleModelProxy`),
    // so a sandbox left running is given new ones.
    this.#modelAccessConnection = newModelAccessConnection();
    await this.refreshModelAccess();
    const newestSequence = await this.#threadEventLog.readNewestSequence(this.#threadId);
    await this.handOverUserMessagesThrough(newestSequence);
  }

  /**
   * Records each event once and in its instance's number order, then
   * acknowledges it. An event at or below the last one recorded is a resend
   * (the acknowledgement was lost) and is acknowledged again without being
   * recorded; one that skips a number breaks the protocol, since the
   * supervisor resends everything unacknowledged in order.
   */
  async recordAgentEvent(message: AgentEventMessage): Promise<void> {
    const { eventNumber, event } = message;
    const nextEventNumber = this.#lastRecordedEventNumber + 1;
    if (eventNumber < nextEventNumber) {
      this.#acknowledgeAgentEvents();
      return;
    }
    if (eventNumber > nextEventNumber) {
      this.#logger.warn({ eventNumber, nextEventNumber }, "A supervisor skipped an event number");
      this.#attachment.forgetSupervisor();
      refuseSupervisor(this.connection, "A supervisor skipped an event number", this.#logger);
      return;
    }
    if (!this.#fitsInClientFrame(event)) {
      return;
    }
    // The clone's events count as activity as the agent's do: a sandbox
    // cloning is at work for its thread. A clone outlasting the idle period
    // with no message waiting may still be stopped, and is redone on waking.
    await this.#threadActivity.recordAgentActivity(this.#threadId);
    try {
      const outcome = await this.#threadEventLog.appendSupervisorEvent(this.#threadId, event, {
        supervisorInstanceId: this.supervisorInstanceId,
        eventNumber,
      });
      this.#lastRecordedEventNumber = eventNumber;
      this.#acknowledgeAgentEvents();
      if (outcome.isAlreadyRecorded) {
        this.#logger.info({ eventNumber }, "An agent event sent again was already recorded");
        return;
      }
      this.#noteReportedUsage(event);
      await this.#relay.broadcastRecordedEvent(outcome.recordedEvent);
    } catch (error) {
      // The supervisor keeps every event it has not seen acknowledged, so it
      // is disconnected and sends them again when it reconnects. It is
      // forgotten at once, not when its socket finishes closing: events it
      // sent after this one may already be waiting in the queue, and
      // recording them would leave a hole in the thread's history.
      this.#logger.error({ err: error, eventType: event.type }, "Could not record an agent event");
      this.#attachment.forgetSupervisor();
      this.connection.close(
        standardCloseCodes.internalError,
        "The control plane could not record an event",
      );
    }
  }

  /**
   * Counted once, as its event is recorded once, and not awaited: it is the
   * sandbox's own account, kept to be shown, and the thread's events need
   * not wait for it.
   */
  #noteReportedUsage(event: AgentEventMessage["event"]): void {
    if (event.type !== "assistant_message" || event.usage === undefined) {
      return;
    }
    this.#modelAccess.noteReportedUsage(this.#threadId, event.usage).catch((error: unknown) => {
      this.#logger.error({ err: error }, "Could not count the usage the agent reported");
    });
  }

  #acknowledgeAgentEvents(): void {
    this.connection.send({
      type: "agent_events_recorded",
      throughEventNumber: this.#lastRecordedEventNumber,
    });
  }

  /**
   * An event recorded but too large to send would break every replay of the
   * thread, so one whose client frame could exceed the limit is refused
   * before it is recorded. A supervisor that leaves the room the protocol
   * asks for (`maximumAgentEventFrameLength`) never sends one; one that does
   * has broken the protocol, and is disconnected as for any invalid message.
   */
  #fitsInClientFrame(event: ThreadEvent): boolean {
    const frameLength = measureLargestThreadEventFrame(event);
    if (frameLength <= maximumFrameLength) {
      return true;
    }
    this.#logger.error(
      { eventType: event.type, frameLength, maximumFrameLength },
      "Refused an agent event too large to send to clients; disconnecting the supervisor",
    );
    this.#attachment.forgetSupervisor();
    this.connection.close(closeCodes.invalidMessage, "An agent event too large to send to clients");
    return false;
  }

  /**
   * The supervisor can only acknowledge a message it was sent. The furthest
   * delivery is stored so that a supervisor starting afresh, with no record
   * of its own, is not handed messages an earlier one already gave the
   * agent.
   */
  async noteUserMessagesDelivered(throughSequence: number): Promise<void> {
    if (throughSequence > this.#deliveryCursor) {
      this.#logger.warn(
        { throughSequence, deliveryCursor: this.#deliveryCursor },
        "A supervisor acknowledged user messages it was never sent",
      );
      this.#attachment.forgetSupervisor();
      refuseSupervisor(this.connection, "A supervisor acknowledged unsent messages", this.#logger);
      return;
    }
    if (throughSequence <= this.#relay.userMessagesDeliveredThrough()) {
      return;
    }
    await this.recordUserMessagesDelivered(throughSequence);
  }

  /**
   * Failing to store the furthest delivery is logged and not fatal: the
   * supervisor that acknowledged it keeps its own record, so only a sandbox
   * that also lost its disk could be handed the message again.
   */
  async recordUserMessagesDelivered(throughSequence: number): Promise<void> {
    this.#relay.advanceUserMessagesDeliveredThrough(throughSequence);
    try {
      await this.#threadEventLog.recordUserMessagesDelivered(this.#threadId, throughSequence);
    } catch (error) {
      this.#logger.error(
        { err: error, throughSequence },
        "Could not store how far user messages were delivered; a fresh sandbox could be handed them again",
      );
    }
  }

  /**
   * Every recorded event moves the delivery cursor on. One that does not
   * follow straight after it means events were recorded elsewhere (another
   * control plane instance, or an append reported as failed that was
   * committed after all), and any user message among them is handed over
   * first, so messages reach the agent in sequence order. While its sandbox
   * is stopping the cursor stays where it is, so what is held back is
   * handed over if the stop fails.
   */
  async followRecordedEvent(recordedEvent: RecordedThreadEvent): Promise<void> {
    const { sequence, event } = recordedEvent;
    if (this.#isSandboxStopping || sequence <= this.#deliveryCursor) {
      return;
    }
    if (event.type === "user_message") {
      // The key may have been replaced, or the model switched, through
      // another control plane instance since this supervisor was told.
      await this.refreshModelAccess();
    }
    await this.handOverUserMessagesThrough(sequence - 1);
    if (event.type === "user_message") {
      this.#deliverUserMessage(sequence, event);
    }
    this.#deliveryCursor = sequence;
  }

  /**
   * Hands the supervisor every user message after its delivery cursor up to
   * `throughSequence`, reading them from the log. A supervisor whose
   * messages cannot be read is disconnected, so that it reconnects and the
   * search starts again from what it has acknowledged.
   */
  async handOverUserMessagesThrough(throughSequence: number): Promise<void> {
    if (this.#isSandboxStopping || throughSequence <= this.#deliveryCursor) {
      return;
    }
    const range: MissedRange = {
      afterSequence: this.#deliveryCursor,
      lastSequence: throughSequence,
    };
    try {
      for await (const recordedEvent of readMissedEvents(
        this.#threadEventLog,
        this.#threadId,
        range,
      )) {
        const { sequence, event } = recordedEvent;
        if (event.type === "user_message") {
          this.#deliverUserMessage(sequence, event);
        }
      }
      this.#deliveryCursor = throughSequence;
    } catch (error) {
      this.#logger.error({ err: error }, "Could not read the user messages a supervisor lacks");
      if (this.#attachment.session === this) {
        this.#attachment.forgetSupervisor();
      }
      this.connection.close(standardCloseCodes.internalError, "Could not read user messages");
    }
  }

  /**
   * A socket that is closing refuses the message; it stays undelivered in
   * history and is handed over when the supervisor reconnects.
   */
  #deliverUserMessage(sequence: number, event: UserMessageEvent): void {
    const isAccepted = this.connection.send({
      type: "deliver_user_message",
      sequence,
      messageId: event.messageId,
      text: event.text,
    });
    this.#logger.info(
      { sequence, messageId: event.messageId, isAccepted },
      "Sent a user message to the supervisor",
    );
  }
}

/** Closes a supervisor connection that broke the protocol, saying how. */
export function refuseSupervisor(
  connection: SupervisorConnection,
  reason: string,
  logger: Logger,
): void {
  logger.warn({ reason }, "Closing a supervisor connection that broke the protocol");
  connection.close(closeCodes.invalidMessage, reason);
}
