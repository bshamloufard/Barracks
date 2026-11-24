import { randomUUID } from "node:crypto";
import type {
  AgentEventMessage,
  AssistantTextFragment,
  ClientCommand,
  ClientMessageRejected,
  ControlPlaneToClientMessage,
  RecordedThreadEvent,
  SupervisorConnectionStatus,
  SupervisorHello,
  SupervisorToControlPlaneMessage,
  ThreadEvent,
  ThreadEventMessage,
  UserMessageDeliveryStatus,
  UserMessageEvent,
} from "@barrack/protocol";
import { closeCodes, maximumFrameLength, measureLargestThreadEventFrame } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import { standardCloseCodes } from "../standard-close-codes.js";
import type {
  SupervisorResumePoint,
  ThreadEventLog,
} from "../thread-event-log/thread-event-log.js";
import type { ClientConnection, SupervisorConnection } from "./connections.js";
import { InProgressAssistantText } from "./in-progress-assistant-text.js";
import { findMissedRange, type MissedRange, readMissedEvents } from "./read-missed-events.js";
import { SerialTaskQueue } from "./serial-task-queue.js";

/** The messages that must still reach a client once its replay is over. */
type HeldBackMessage = ThreadEventMessage | ClientMessageRejected;

/**
 * While a client is being replayed its history, the protocol promises it
 * nothing but the announced events, so thread events recorded meanwhile and
 * rejections of what it sent wait here. Stream fragments and the two
 * statuses are dropped instead: the client is sent the current statuses and
 * the text streamed so far when its replay ends, which supersede them, so
 * holding them would only cost memory for as long as a slow replay lasts.
 *
 * A live client is sent each thread event only if it is the one after the
 * last it was sent. An event at or below that was already replayed to it: an
 * append can be committed, and so replayed, before the log's answer reaches
 * the relay and the relay broadcasts it. An event further on means the
 * client missed one this relay never broadcast, because another control
 * plane instance recorded it or because an append reported as failed was
 * committed after all; that client is disconnected, so it reconnects and
 * replays what it missed from the log, rather than being shown a gap.
 */
type ClientPhase =
  | { name: "replaying"; heldBackMessages: HeldBackMessage[] }
  | { name: "live"; lastSentSequence: number };

/** The thread's supervisor, once it has said hello and been welcomed. */
type AttachedSupervisor = {
  connection: SupervisorConnection;
  supervisorInstanceId: string;
  /** Every event of this instance up to this number is recorded. */
  lastRecordedEventNumber: number;
  /**
   * How far the thread's history has been searched for user messages to
   * hand this supervisor. Every user message at or before it was either
   * sent on this connection or delivered before the supervisor attached.
   */
  deliveryCursor: number;
};

export type ThreadRelayOptions = {
  threadId: string;
  threadEventLog: ThreadEventLog;
  logger: Logger;
  /**
   * Called whenever the relay is left with no supervisor, no clients and no
   * queued work, which is when it can be dropped.
   */
  whenUnused: () => void;
};

/**
 * Closes a run in place of the supervisor that started it; shown to the user
 * after "The agent stopped working: ".
 */
export const abandonedRunErrorMessage =
  "the process supervising it in its sandbox stopped in the middle of this run and has since been replaced, so the run could not finish. Anything the agent did after the last step shown here was lost. Send a message to carry on.";

/**
 * Coordinates one thread: its supervisor, the clients watching it, and the
 * text of any assistant message still being streamed. It enforces the rules
 * the product depends on: every thread event is recorded before any client
 * is shown it; every client sees each thread event exactly once, in sequence
 * order, however it joins; every agent event the supervisor sends is
 * recorded exactly once and acknowledged only once it is; and every user
 * message is handed to the agent, in order, even if no supervisor was
 * connected when it was sent (see the handshake in
 * `packages/protocol/src/supervisor-messages.ts`).
 *
 * Messages from the supervisor and from clients go through one queue, so the
 * thread's events are recorded and broadcast in the order they arrived.
 * Replaying history to a newly connected client deliberately does not, so a
 * slow replay never delays live traffic for everyone else.
 */
export class ThreadRelay {
  readonly threadId: string;
  readonly #threadEventLog: ThreadEventLog;
  readonly #logger: Logger;
  readonly #whenUnused: () => void;
  readonly #queue = new SerialTaskQueue();
  #queuedTaskCount = 0;
  readonly #inProgressText = new InProgressAssistantText();
  readonly #clientPhases = new Map<ClientConnection, ClientPhase>();
  /** Supervisor connections that have not yet said hello. */
  readonly #connectingSupervisors = new Set<SupervisorConnection>();
  #supervisor: AttachedSupervisor | undefined;
  /** The furthest delivery of user messages this relay knows of; it only grows. */
  #userMessagesDeliveredThrough = 0;

  constructor(options: ThreadRelayOptions) {
    this.threadId = options.threadId;
    this.#threadEventLog = options.threadEventLog;
    this.#logger = options.logger;
    this.#whenUnused = options.whenUnused;
  }

  /** Registers a supervisor connection, which becomes the thread's supervisor once it says hello. */
  attachSupervisor(connection: SupervisorConnection): void {
    this.#connectingSupervisors.add(connection);
  }

  detachSupervisor(connection: SupervisorConnection): void {
    this.#enqueue("detach a supervisor", async () => {
      this.#connectingSupervisors.delete(connection);
      if (this.#supervisor?.connection === connection) {
        this.#forgetSupervisor();
      }
    });
  }

  /**
   * Messages from a supervisor that is no longer this thread's supervisor
   * are ignored. That covers one superseded by a newer supervisor, and one
   * dropped because an event it sent could not be recorded.
   */
  receiveFromSupervisor(
    connection: SupervisorConnection,
    message: SupervisorToControlPlaneMessage,
  ): void {
    this.#enqueue(`handle ${message.type} from the supervisor`, async () => {
      if (message.type === "supervisor_hello") {
        await this.#greetSupervisor(connection, message);
        return;
      }
      const supervisor = this.#supervisor;
      if (supervisor?.connection !== connection) {
        this.#ignoreUnattachedSupervisorMessage(connection, message.type);
        return;
      }
      switch (message.type) {
        case "stream_fragment":
          this.#relayAssistantTextFragment(message.fragment);
          return;
        case "agent_event":
          await this.#recordSupervisorEvent(supervisor, message);
          return;
        case "user_messages_delivered":
          await this.#noteUserMessagesDelivered(supervisor, message.throughSequence);
          return;
      }
    });
  }

  receiveFromClient(connection: ClientConnection, message: ClientCommand): void {
    this.#enqueue(`handle ${message.type} from a client`, async () => {
      if (message.type === "send_user_message") {
        await this.#acceptUserMessage(connection, message.text);
        return;
      }
      this.#forwardInterrupt(connection);
    });
  }

  /**
   * Registers the client at once, then replays the history it missed and
   * switches it to live traffic. A client whose replay fails is detached and
   * disconnected, so it reconnects and tries again.
   */
  attachClient(connection: ClientConnection, lastSeenSequence: number): void {
    const heldBackMessages: HeldBackMessage[] = [];
    this.#clientPhases.set(connection, { name: "replaying", heldBackMessages });
    this.#replayThenGoLive(connection, lastSeenSequence, heldBackMessages).catch(
      (error: unknown) => {
        this.#logger.error({ err: error }, "Could not replay the thread's history to a client");
        this.detachClient(connection);
        connection.close(standardCloseCodes.internalError, "Could not replay the thread's history");
      },
    );
  }

  detachClient(connection: ClientConnection): void {
    this.#clientPhases.delete(connection);
    this.#reportIfUnused();
  }

  /**
   * The client was registered before the log is read, so any event recorded
   * while the replay is under way is held back for it rather than missed;
   * events the replay already covered are then skipped, so none is sent
   * twice. A client that detaches part way is sent nothing more.
   */
  async #replayThenGoLive(
    connection: ClientConnection,
    lastSeenSequence: number,
    heldBackMessages: HeldBackMessage[],
  ): Promise<void> {
    const range = await findMissedRange(
      this.#threadEventLog,
      this.threadId,
      lastSeenSequence,
      this.#logger,
    );
    this.#advanceUserMessagesDeliveredThrough(
      await this.#threadEventLog.readUserMessagesDeliveredThrough(this.threadId),
    );
    const wasReplayCompleted = await this.#replayMissedEvents(connection, range);
    if (!wasReplayCompleted) {
      return;
    }
    // From here to the end nothing is awaited, so no event can slip in
    // between the held-back messages and the switch to live.
    this.#clientPhases.set(connection, { name: "live", lastSentSequence: range.lastSequence });
    for (const message of heldBackMessages) {
      this.#sendToClient(connection, message);
    }
    connection.send(this.#supervisorConnectionStatus());
    connection.send(this.#userMessageDeliveryStatus());
    for (const fragment of this.#inProgressText.toCoalescedFragments()) {
      connection.send({ type: "stream_fragment", fragment });
    }
    this.#logger.info(
      { replayedEventCount: range.lastSequence - range.afterSequence },
      "Client caught up and is live",
    );
  }

  /**
   * Makes a connection that said hello the thread's supervisor: checks its
   * claim, closes a run an earlier supervisor left open, tells it which of
   * its events are recorded, and hands it the user messages it lacks.
   */
  async #greetSupervisor(connection: SupervisorConnection, hello: SupervisorHello): Promise<void> {
    if (!this.#connectingSupervisors.delete(connection)) {
      this.#refuseSupervisor(connection, "A supervisor said hello twice");
      return;
    }
    const resumePoint = await this.#readResumePoint(connection, hello.supervisorInstanceId);
    if (resumePoint === undefined) {
      return;
    }
    const claimedDelivery = hello.userMessagesDeliveredThroughSequence;
    if (claimedDelivery > resumePoint.newestSequence) {
      this.#logger.warn(
        { claimedDelivery, newestSequence: resumePoint.newestSequence },
        "A supervisor claims to have delivered user messages beyond the thread's history",
      );
      this.#refuseSupervisor(connection, "A supervisor claimed an impossible delivery position");
      return;
    }
    this.#supersedePreviousSupervisor();
    if (!(await this.#closeRunAbandonedByEarlierSupervisor(connection, hello, resumePoint))) {
      this.#broadcastSupervisorConnectionStatus();
      return;
    }
    const supervisor: AttachedSupervisor = {
      connection,
      supervisorInstanceId: hello.supervisorInstanceId,
      lastRecordedEventNumber: resumePoint.lastRecordedEventNumber,
      deliveryCursor: Math.max(claimedDelivery, resumePoint.userMessagesDeliveredThrough),
    };
    this.#supervisor = supervisor;
    connection.send({
      type: "supervisor_welcome",
      lastRecordedEventNumber: resumePoint.lastRecordedEventNumber,
    });
    this.#logger.info(
      {
        supervisorInstanceId: hello.supervisorInstanceId,
        lastRecordedEventNumber: resumePoint.lastRecordedEventNumber,
        userMessagesDeliveredThrough: supervisor.deliveryCursor,
      },
      "Supervisor attached",
    );
    this.#broadcastSupervisorConnectionStatus();
    this.#advanceUserMessagesDeliveredThrough(resumePoint.userMessagesDeliveredThrough);
    if (claimedDelivery > resumePoint.userMessagesDeliveredThrough) {
      await this.#recordUserMessagesDelivered(claimedDelivery);
    }
    await this.#sendUserMessagesUpTo(supervisor, resumePoint.newestSequence);
  }

  async #readResumePoint(
    connection: SupervisorConnection,
    supervisorInstanceId: string,
  ): Promise<SupervisorResumePoint | undefined> {
    try {
      return await this.#threadEventLog.readSupervisorResumePoint(
        this.threadId,
        supervisorInstanceId,
      );
    } catch (error) {
      this.#logger.error({ err: error }, "Could not read where a connecting supervisor resumes");
      connection.close(
        standardCloseCodes.internalError,
        "The control plane could not read history",
      );
      return undefined;
    }
  }

  /**
   * A run is open in history but was started by another supervisor process:
   * that process has gone (a supervisor's identity lasts as long as its
   * process), and with it whatever it had not yet had recorded, so nobody
   * will ever send the run's end. Clients would show the agent working for
   * ever, so the control plane records the end itself, as a failure, since
   * the run did not complete. A supervisor that merely disconnected comes
   * back as the same instance and finishes its own run, however long it was
   * away. Returns false, having closed the connection, if it could not be
   * recorded; the supervisor then tries again.
   */
  async #closeRunAbandonedByEarlierSupervisor(
    connection: SupervisorConnection,
    hello: SupervisorHello,
    resumePoint: SupervisorResumePoint,
  ): Promise<boolean> {
    const openedBy = resumePoint.openRunSupervisorInstanceId;
    if (openedBy === undefined || openedBy === hello.supervisorInstanceId) {
      return true;
    }
    this.#logger.warn(
      { abandonedBySupervisorInstanceId: openedBy },
      "Closing a run whose supervisor was replaced before the run ended",
    );
    try {
      await this.#recordAndBroadcast({
        type: "agent_failed",
        errorMessage: abandonedRunErrorMessage,
      });
      return true;
    } catch (error) {
      this.#logger.error({ err: error }, "Could not close a run an earlier supervisor left open");
      connection.close(
        standardCloseCodes.internalError,
        "The control plane could not record an event",
      );
      return false;
    }
  }

  #supersedePreviousSupervisor(): void {
    const previousSupervisor = this.#supervisor;
    if (previousSupervisor === undefined) {
      return;
    }
    this.#supervisor = undefined;
    this.#logger.warn("A newer supervisor connected; closing the previous one");
    previousSupervisor.connection.close(
      closeCodes.supersededByNewerSupervisor,
      "A newer supervisor connected for this thread",
    );
  }

  /**
   * Records each event once and in its instance's number order, then
   * acknowledges it. An event at or below the last one recorded is a resend
   * (the acknowledgement was lost) and is acknowledged again without being
   * recorded; one that skips a number breaks the protocol, since the
   * supervisor resends everything unacknowledged in order.
   */
  async #recordSupervisorEvent(
    supervisor: AttachedSupervisor,
    message: AgentEventMessage,
  ): Promise<void> {
    const { eventNumber, event } = message;
    const nextEventNumber = supervisor.lastRecordedEventNumber + 1;
    if (eventNumber < nextEventNumber) {
      this.#acknowledgeAgentEvents(supervisor);
      return;
    }
    if (eventNumber > nextEventNumber) {
      this.#logger.warn({ eventNumber, nextEventNumber }, "A supervisor skipped an event number");
      this.#forgetSupervisor();
      this.#refuseSupervisor(supervisor.connection, "A supervisor skipped an event number");
      return;
    }
    if (!this.#fitsInClientFrame(supervisor.connection, event)) {
      return;
    }
    try {
      const outcome = await this.#threadEventLog.appendSupervisorEvent(this.threadId, event, {
        supervisorInstanceId: supervisor.supervisorInstanceId,
        eventNumber,
      });
      supervisor.lastRecordedEventNumber = eventNumber;
      this.#acknowledgeAgentEvents(supervisor);
      if (outcome.isAlreadyRecorded) {
        this.#logger.info({ eventNumber }, "An agent event sent again was already recorded");
        return;
      }
      await this.#broadcastRecordedEvent(outcome.recordedEvent);
    } catch (error) {
      // The supervisor keeps every event it has not seen acknowledged, so it
      // is disconnected and sends them again when it reconnects. It is
      // forgotten at once, not when its socket finishes closing: events it
      // sent after this one may already be waiting in the queue, and
      // recording them would leave a hole in the thread's history.
      this.#logger.error({ err: error, eventType: event.type }, "Could not record an agent event");
      this.#forgetSupervisor();
      supervisor.connection.close(
        standardCloseCodes.internalError,
        "The control plane could not record an event",
      );
    }
  }

  #acknowledgeAgentEvents(supervisor: AttachedSupervisor): void {
    supervisor.connection.send({
      type: "agent_events_recorded",
      throughEventNumber: supervisor.lastRecordedEventNumber,
    });
  }

  /**
   * An event recorded but too large to send would break every replay of the
   * thread, so one whose client frame could exceed the limit is refused
   * before it is recorded. A supervisor that leaves the room the protocol
   * asks for (`maximumAgentEventFrameLength`) never sends one; one that does
   * has broken the protocol, and is disconnected as for any invalid message.
   */
  #fitsInClientFrame(connection: SupervisorConnection, event: ThreadEvent): boolean {
    const frameLength = measureLargestThreadEventFrame(event);
    if (frameLength <= maximumFrameLength) {
      return true;
    }
    this.#logger.error(
      { eventType: event.type, frameLength, maximumFrameLength },
      "Refused an agent event too large to send to clients; disconnecting the supervisor",
    );
    this.#forgetSupervisor();
    connection.close(closeCodes.invalidMessage, "An agent event too large to send to clients");
    return false;
  }

  /**
   * The supervisor can only acknowledge a message it was sent. The furthest
   * delivery is stored so that a supervisor starting afresh, with no record
   * of its own, is not handed messages an earlier one already gave the
   * agent. Failing to store it is logged and not fatal: the supervisor that
   * acknowledged it keeps its own record, so only a sandbox that also lost
   * its disk could be handed the message again.
   */
  async #noteUserMessagesDelivered(
    supervisor: AttachedSupervisor,
    throughSequence: number,
  ): Promise<void> {
    if (throughSequence > supervisor.deliveryCursor) {
      this.#logger.warn(
        { throughSequence, deliveryCursor: supervisor.deliveryCursor },
        "A supervisor acknowledged user messages it was never sent",
      );
      this.#forgetSupervisor();
      this.#refuseSupervisor(supervisor.connection, "A supervisor acknowledged unsent messages");
      return;
    }
    if (throughSequence <= this.#userMessagesDeliveredThrough) {
      return;
    }
    await this.#recordUserMessagesDelivered(throughSequence);
  }

  async #recordUserMessagesDelivered(throughSequence: number): Promise<void> {
    this.#advanceUserMessagesDeliveredThrough(throughSequence);
    try {
      await this.#threadEventLog.recordUserMessagesDelivered(this.threadId, throughSequence);
    } catch (error) {
      this.#logger.error(
        { err: error, throughSequence },
        "Could not store how far user messages were delivered; a fresh sandbox could be handed them again",
      );
    }
  }

  #advanceUserMessagesDeliveredThrough(throughSequence: number): void {
    if (throughSequence <= this.#userMessagesDeliveredThrough) {
      return;
    }
    this.#userMessagesDeliveredThrough = throughSequence;
    this.#broadcast(this.#userMessageDeliveryStatus());
  }

  #forgetSupervisor(): void {
    this.#supervisor = undefined;
    this.#broadcastSupervisorConnectionStatus();
  }

  #refuseSupervisor(connection: SupervisorConnection, reason: string): void {
    this.#logger.warn({ reason }, "Closing a supervisor connection that broke the protocol");
    connection.close(closeCodes.invalidMessage, reason);
  }

  /**
   * Anything but a hello from a connection that has not said hello breaks
   * the protocol. From a connection that was attached once and is no longer
   * (superseded, or dropped after a failed append) it is just late.
   */
  #ignoreUnattachedSupervisorMessage(
    connection: SupervisorConnection,
    messageType: SupervisorToControlPlaneMessage["type"],
  ): void {
    if (this.#connectingSupervisors.delete(connection)) {
      this.#refuseSupervisor(connection, `A supervisor sent ${messageType} before saying hello`);
      return;
    }
    this.#logger.warn(
      { messageType },
      "Ignored a message from a supervisor that is no longer attached to this thread",
    );
  }

  /**
   * Recorded whether or not an agent is connected: a message sent while the
   * thread's sandbox is starting or asleep waits in history, and clients
   * show it as waiting (see `UserMessageDeliveryStatus`), until a supervisor
   * attaches and is handed it.
   */
  async #acceptUserMessage(client: ClientConnection, text: string): Promise<void> {
    const messageId = randomUUID();
    try {
      await this.#recordAndBroadcast({ type: "user_message", messageId, text });
    } catch (error) {
      this.#logger.error({ err: error }, "Could not record a user message");
      this.#rejectClientMessage(
        client,
        "The message could not be saved, so it was not sent. Please try again.",
      );
      return;
    }
    if (this.#supervisor === undefined) {
      this.#logger.info(
        { messageId },
        "Recorded a user message to deliver once a supervisor attaches",
      );
    }
  }

  /** Interrupts are delivered at most once; see `interruptAgentMessageSchema`. */
  #forwardInterrupt(client: ClientConnection): void {
    const supervisor = this.#supervisor;
    if (supervisor === undefined) {
      this.#rejectClientMessage(
        client,
        "No agent is connected to this thread, so there is nothing to interrupt. Messages waiting for the agent will still reach it when it connects.",
      );
      return;
    }
    const isAccepted = supervisor.connection.send({ type: "interrupt_agent" });
    if (!isAccepted) {
      this.#rejectClientMessage(
        client,
        "The interrupt could not be delivered to the agent, because its connection is closing. Try again once the agent has reconnected.",
      );
      return;
    }
    this.#logger.info("Forwarded an interrupt to the supervisor");
  }

  async #recordAndBroadcast(event: ThreadEvent): Promise<RecordedThreadEvent> {
    const recordedEvent = await this.#threadEventLog.append(this.threadId, event);
    await this.#broadcastRecordedEvent(recordedEvent);
    return recordedEvent;
  }

  /**
   * Every recorded event moves the supervisor's delivery cursor on. One
   * that does not follow straight after it means events were recorded
   * elsewhere (another control plane instance, or an append reported as
   * failed that was committed after all), and any user message among them
   * is handed over first, so messages reach the agent in sequence order.
   */
  async #broadcastRecordedEvent(recordedEvent: RecordedThreadEvent): Promise<void> {
    const { sequence, event } = recordedEvent;
    this.#logger.info({ sequence, eventType: event.type }, "Recorded a thread event");
    this.#forgetTextSupersededBy(event);
    this.#broadcast({ type: "thread_event", ...recordedEvent });
    const supervisor = this.#supervisor;
    if (supervisor === undefined || sequence <= supervisor.deliveryCursor) {
      return;
    }
    await this.#sendUserMessagesUpTo(supervisor, sequence - 1);
    if (event.type === "user_message") {
      this.#deliverUserMessage(supervisor, sequence, event);
    }
    supervisor.deliveryCursor = sequence;
  }

  /**
   * Hands the supervisor every user message after its delivery cursor up to
   * `throughSequence`, reading them from the log. A supervisor whose
   * messages cannot be read is disconnected, so that it reconnects and the
   * search starts again from what it has acknowledged.
   */
  async #sendUserMessagesUpTo(
    supervisor: AttachedSupervisor,
    throughSequence: number,
  ): Promise<void> {
    if (throughSequence <= supervisor.deliveryCursor) {
      return;
    }
    const range: MissedRange = {
      afterSequence: supervisor.deliveryCursor,
      lastSequence: throughSequence,
    };
    try {
      for await (const recordedEvent of readMissedEvents(
        this.#threadEventLog,
        this.threadId,
        range,
      )) {
        const { sequence, event } = recordedEvent;
        if (event.type === "user_message") {
          this.#deliverUserMessage(supervisor, sequence, event);
        }
      }
      supervisor.deliveryCursor = throughSequence;
    } catch (error) {
      this.#logger.error({ err: error }, "Could not read the user messages a supervisor lacks");
      if (this.#supervisor === supervisor) {
        this.#forgetSupervisor();
      }
      supervisor.connection.close(standardCloseCodes.internalError, "Could not read user messages");
    }
  }

  /**
   * A socket that is closing refuses the message; it stays undelivered in
   * history and is handed over when the supervisor reconnects.
   */
  #deliverUserMessage(
    supervisor: AttachedSupervisor,
    sequence: number,
    event: UserMessageEvent,
  ): void {
    const isAccepted = supervisor.connection.send({
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

  #forgetTextSupersededBy(event: ThreadEvent): void {
    if (event.type === "assistant_message") {
      this.#inProgressText.discardMessage(event.messageId);
    }
    if (event.type === "agent_run_settled" || event.type === "agent_failed") {
      this.#inProgressText.discardCurrentMessage();
    }
  }

  #relayAssistantTextFragment(fragment: AssistantTextFragment): void {
    if (this.#inProgressText.append(fragment) === "exceeded_limit") {
      this.#logger.warn(
        { messageId: fragment.messageId },
        "Stopped keeping streamed text for an assistant message that went past a size limit",
      );
    }
    this.#broadcast({ type: "stream_fragment", fragment });
  }

  #rejectClientMessage(client: ClientConnection, reason: string): void {
    this.#logger.info({ reason }, "Rejected a client message");
    this.#sendToClient(client, { type: "client_message_rejected", reason });
  }

  #broadcastSupervisorConnectionStatus(): void {
    const status = this.#supervisorConnectionStatus();
    this.#logger.info(
      { isSupervisorConnected: status.isSupervisorConnected },
      "Supervisor connection changed",
    );
    this.#broadcast(status);
  }

  #supervisorConnectionStatus(): SupervisorConnectionStatus {
    return {
      type: "supervisor_connection_status",
      isSupervisorConnected: this.#supervisor !== undefined,
    };
  }

  #userMessageDeliveryStatus(): UserMessageDeliveryStatus {
    return {
      type: "user_message_delivery_status",
      deliveredThroughSequence: this.#userMessagesDeliveredThrough,
    };
  }

  #broadcast(message: ControlPlaneToClientMessage): void {
    for (const client of this.#clientPhases.keys()) {
      this.#sendToClient(client, message);
    }
  }

  #sendToClient(client: ClientConnection, message: ControlPlaneToClientMessage): void {
    const phase = this.#clientPhases.get(client);
    if (phase?.name === "replaying") {
      if (message.type === "thread_event" || message.type === "client_message_rejected") {
        phase.heldBackMessages.push(message);
      }
      return;
    }
    if (phase !== undefined && message.type === "thread_event") {
      if (message.sequence <= phase.lastSentSequence) {
        return;
      }
      if (message.sequence > phase.lastSentSequence + 1) {
        this.#disconnectClientThatMissedEvents(client, phase.lastSentSequence, message.sequence);
        return;
      }
      phase.lastSentSequence = message.sequence;
    }
    client.send(message);
  }

  #disconnectClientThatMissedEvents(
    client: ClientConnection,
    lastSentSequence: number,
    nextSequence: number,
  ): void {
    this.#logger.warn(
      { lastSentSequence, nextSequence },
      "A live client would have missed thread events; disconnecting it so it replays them",
    );
    this.detachClient(client);
    client.close(
      standardCloseCodes.internalError,
      "Thread events were recorded that this connection was not sent; reconnect to replay them",
    );
  }

  /**
   * Sends the announcement, then the announced events as they are read from
   * the log a page at a time. Returns false if the client detached before
   * the replay was over.
   */
  async #replayMissedEvents(client: ClientConnection, range: MissedRange): Promise<boolean> {
    if (!this.#clientPhases.has(client)) {
      return false;
    }
    await client.sendAndWaitUntilWritten({
      type: "replay_announcement",
      firstSequence: range.afterSequence + 1,
      lastSequence: range.lastSequence,
    });
    const missedEvents = readMissedEvents(this.#threadEventLog, this.threadId, range);
    for await (const recordedEvent of missedEvents) {
      if (!this.#clientPhases.has(client)) {
        return false;
      }
      await client.sendAndWaitUntilWritten({ type: "thread_event", ...recordedEvent });
    }
    return this.#clientPhases.has(client);
  }

  #enqueue(description: string, task: () => Promise<void>): void {
    this.#queuedTaskCount += 1;
    this.#queue
      .enqueue(task)
      .catch((error: unknown) => {
        this.#logger.error({ err: error }, `Failed to ${description}`);
      })
      .finally(() => {
        this.#queuedTaskCount -= 1;
        this.#reportIfUnused();
      });
  }

  /**
   * The check and the callback run in one synchronous step, as does the
   * registry's attaching of a peer, so no peer can attach between the relay
   * being found unused and the registry dropping it.
   */
  #reportIfUnused(): void {
    const isUnused =
      this.#supervisor === undefined &&
      this.#connectingSupervisors.size === 0 &&
      this.#clientPhases.size === 0 &&
      this.#queuedTaskCount === 0;
    if (isUnused) {
      this.#whenUnused();
    }
  }
}
