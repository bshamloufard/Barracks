import type {
  AgentEventMessage,
  AssistantTextFragment,
  ClientCommand,
  ClientMessageRejected,
  ControlPlaneToClientMessage,
  ControlPlaneWorkspaceMessage,
  RecordedThreadEvent,
  SendUserMessage,
  StreamFragmentMessage,
  SupervisorConnectionStatus,
  SupervisorHello,
  SupervisorToControlPlaneMessage,
  SupervisorWorkspaceMessage,
  ThreadEvent,
  ThreadEventMessage,
  UserMessageDeliveryStatus,
  UserMessageEvent,
} from "@barrack/protocol";
import { closeCodes, maximumFrameLength, measureLargestThreadEventFrame } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import { standardCloseCodes } from "../standard-close-codes.js";
import type {
  OpenRun,
  PublicationOutcomeEvent,
  SupervisorResumePoint,
  ThreadEventLog,
} from "../thread-event-log/thread-event-log.js";
import type { ClientConnection, SupervisorConnection } from "./connections.js";
import { InProgressAssistantText } from "./in-progress-assistant-text.js";
import { findMissedRange, type MissedRange, readMissedEvents } from "./read-missed-events.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import { SupervisorBacklog, supervisorMessagesBacklogLimit } from "./supervisor-backlog.js";
import type { ThreadActivity } from "./thread-activity.js";
import {
  emptyThreadWorkspaces,
  isSupervisorWorkspaceMessage,
  type ThreadWorkspaces,
} from "./thread-workspaces.js";

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

/**
 * A thread has one supervisor, which may briefly have a second connection
 * open while it reconnects; more than this is a sandbox misbehaving.
 */
const maximumOpenSupervisorConnections = 4;

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
  /** Its sandbox is being stopped, so it is handed no more user messages. */
  isSandboxStopping: boolean;
};

export type ThreadRelayOptions = {
  threadId: string;
  threadEventLog: ThreadEventLog;
  threadActivity: ThreadActivity;
  /** What the thread's workspace holds; empty when omitted. */
  workspaces?: ThreadWorkspaces;
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
  readonly #threadActivity: ThreadActivity;
  readonly #workspaces: ThreadWorkspaces;
  readonly #logger: Logger;
  readonly #whenUnused: () => void;
  readonly #queue = new SerialTaskQueue();
  #queuedTaskCount = 0;
  readonly #inProgressText = new InProgressAssistantText();
  readonly #backlog = new SupervisorBacklog();
  readonly #clientPhases = new Map<ClientConnection, ClientPhase>();
  /** Every supervisor connection attached and not yet closed, whatever its state. */
  readonly #openSupervisorConnections = new Set<SupervisorConnection>();
  /** Supervisor connections that have not yet said hello. */
  readonly #connectingSupervisors = new Set<SupervisorConnection>();
  #supervisor: AttachedSupervisor | undefined;
  /** The furthest delivery of user messages this relay knows of; it only grows. */
  #userMessagesDeliveredThrough = 0;

  constructor(options: ThreadRelayOptions) {
    this.threadId = options.threadId;
    this.#threadEventLog = options.threadEventLog;
    this.#threadActivity = options.threadActivity;
    this.#workspaces = options.workspaces ?? emptyThreadWorkspaces;
    this.#logger = options.logger;
    this.#whenUnused = options.whenUnused;
  }

  /**
   * Registers a supervisor connection, which becomes the thread's supervisor
   * once it says hello. Each open connection can hold a frame being
   * received, up to `maximumFrameLength`, before anything reaches the
   * relay, so a sandbox is allowed only a few at once.
   */
  attachSupervisor(connection: SupervisorConnection): void {
    if (this.#openSupervisorConnections.size >= maximumOpenSupervisorConnections) {
      this.#logger.warn(
        { openConnectionCount: this.#openSupervisorConnections.size },
        "Refused a supervisor connection: too many are open for this thread",
      );
      connection.close(
        standardCloseCodes.tryAgainLater,
        "Too many supervisor connections are open for this thread",
      );
      return;
    }
    this.#openSupervisorConnections.add(connection);
    this.#connectingSupervisors.add(connection);
  }

  detachSupervisor(connection: SupervisorConnection): void {
    this.#openSupervisorConnections.delete(connection);
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
   *
   * What waits in the queue is bounded (see `SupervisorBacklog`):
   * `frameLength` is the length of the frame the message came in, which the
   * WebSocket endpoint passes on; anything else measures it.
   *
   * Workspace requests are answered outside the queue: minting a credential
   * waits on GitHub, and must not hold up the thread's events. They are
   * bounded by other means (see `#forwardWorkspaceRequest`).
   */
  receiveFromSupervisor(
    connection: SupervisorConnection,
    message: SupervisorToControlPlaneMessage,
    frameLength: number = JSON.stringify(message).length,
  ): void {
    if (message.type === "stream_fragment") {
      this.#queueStreamFragment(connection, message.fragment, frameLength);
      return;
    }
    if (isSupervisorWorkspaceMessage(message)) {
      this.#forwardWorkspaceRequest(connection, message);
      return;
    }
    if (!this.#backlog.admitMessage(frameLength)) {
      this.#disconnectOverflowingSupervisor(connection);
      return;
    }
    this.#enqueue(`handle ${message.type} from the supervisor`, async () => {
      try {
        await this.#handleSupervisorMessage(connection, message);
      } finally {
        this.#backlog.releaseMessage(frameLength);
      }
    });
  }

  async #handleSupervisorMessage(
    connection: SupervisorConnection,
    message: Exclude<SupervisorToControlPlaneMessage, StreamFragmentMessage>,
  ): Promise<void> {
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
      case "agent_event":
        await this.#recordSupervisorEvent(supervisor, message);
        return;
      case "user_messages_delivered":
        await this.#noteUserMessagesDelivered(supervisor, message.throughSequence);
        return;
    }
  }

  /**
   * Fragments keep their place among the supervisor's other messages, so
   * they share the queue, but a fragment that does not fit its own budget
   * is dropped rather than held; see `SupervisorBacklog`.
   */
  #queueStreamFragment(
    connection: SupervisorConnection,
    fragment: AssistantTextFragment,
    frameLength: number,
  ): void {
    if (!this.#backlog.admitFragment(fragment.messageId, frameLength)) {
      this.#logger.debug(
        { messageId: fragment.messageId },
        "Dropped a stream fragment while the relay is behind",
      );
      return;
    }
    this.#enqueue("relay a stream fragment from the supervisor", async () => {
      this.#backlog.releaseFragment(frameLength);
      if (this.#supervisor?.connection !== connection) {
        this.#ignoreUnattachedSupervisorMessage(connection, "stream_fragment");
        return;
      }
      this.#relayAssistantTextFragment(fragment);
    });
  }

  /**
   * The supervisor sent more than may wait for the thread while earlier
   * messages are still being recorded. Those are still recorded; this one
   * and everything after it are not, and the supervisor sends them again
   * once it reconnects, by which time the queue has drained.
   */
  #disconnectOverflowingSupervisor(connection: SupervisorConnection): void {
    this.#logger.warn(
      { ...this.#backlog.queuedLengths, limit: supervisorMessagesBacklogLimit },
      "A supervisor sent more than may wait to be recorded for its thread; disconnecting it",
    );
    connection.close(
      standardCloseCodes.tryAgainLater,
      "The control plane is behind recording this thread's events; send them again later",
    );
  }

  receiveFromClient(connection: ClientConnection, message: ClientCommand): void {
    this.#enqueue(`handle ${message.type} from a client`, async () => {
      if (message.type === "send_user_message") {
        await this.#acceptUserMessage(connection, message);
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
   * The thread's sandbox is about to stop: the agent is asked to end its run,
   * and is handed no more user messages, which it would only lose. They wait
   * in history for the supervisor that attaches once the sandbox is woken.
   * Unlike a user's interrupt, there is nobody to tell if no supervisor is
   * attached here: the sandbox's stop ends the run either way.
   */
  prepareForStop(): void {
    this.#enqueue("prepare the agent for its sandbox stopping", async () => {
      const supervisor = this.#supervisor;
      if (supervisor === undefined) {
        return;
      }
      supervisor.isSandboxStopping = true;
      if (supervisor.connection.send({ type: "interrupt_agent" })) {
        this.#logger.info("Interrupted the agent because its sandbox is stopping");
      }
    });
  }

  /**
   * The stop is over. A supervisor still attached (the stop failed, and its
   * sandbox runs on) is handed the user messages held back meanwhile.
   */
  finishStop(): void {
    this.#enqueue("resume handing user messages over after a stop", async () => {
      const supervisor = this.#supervisor;
      if (supervisor === undefined || !supervisor.isSandboxStopping) {
        return;
      }
      supervisor.isSandboxStopping = false;
      const newestSequence = await this.#threadEventLog.readNewestSequence(this.threadId);
      await this.#sendUserMessagesUpTo(supervisor, newestSequence);
    });
  }

  /**
   * Records the end of `run` as a failure with `errorMessage`, if it is
   * still open: its sandbox has stopped, so no agent will end it. It goes
   * through the queue, after everything the supervisor sent before its
   * sandbox stopped. Resolves once recorded, or once found already closed.
   */
  closeOpenRun(run: OpenRun, errorMessage: string): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#enqueue("close a run left open by a stopped sandbox", async () => {
      try {
        if (await this.#closeRun(run, errorMessage)) {
          this.#logger.info("Closed the run the stopped sandbox left open");
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    return promise;
  }

  /** Returns whether this closed the run; it may have been closed already, by anyone. */
  async #closeRun(run: OpenRun, errorMessage: string): Promise<boolean> {
    const recordedEvent = await this.#threadEventLog.closeOpenRun(this.threadId, run, {
      type: "agent_failed",
      errorMessage,
    });
    if (recordedEvent === undefined) {
      return false;
    }
    await this.#broadcastRecordedEvent(recordedEvent);
    return true;
  }

  /**
   * The thread was deleted: everyone attached is disconnected, its
   * supervisor forgotten, and its history removed once the work already
   * queued is done. A user message admitted just before the deletion began
   * may still be on its way into the log; removing the history after it,
   * in the queue, leaves none of it behind, and a message queued later is
   * refused, since its thread no longer exists. Resolves once removed.
   */
  forgetDeletedThread(): Promise<void> {
    this.#disconnectEveryone();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#enqueue("remove a deleted thread's history", async () => {
      try {
        await this.#threadEventLog.deleteHistory(this.threadId);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    return promise;
  }

  /**
   * Sends a workspace message to the attached supervisor; returns false if
   * there is none, or its connection is closing.
   */
  sendWorkspaceMessage(message: ControlPlaneWorkspaceMessage): boolean {
    return this.#supervisor?.connection.send(message) ?? false;
  }

  /**
   * Records how a publication the control plane carried out ended, in
   * sequence with everything else. A publication's outcome is recorded at
   * most once, however often this is called for it (see
   * `ThreadEventLog.appendPublicationOutcome`).
   */
  recordPublicationOutcome(publicationId: string, event: PublicationOutcomeEvent): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#enqueue(`record ${event.type}`, async () => {
      try {
        const outcome = await this.#threadEventLog.appendPublicationOutcome(
          this.threadId,
          event,
          publicationId,
        );
        if (outcome.isAlreadyRecorded) {
          this.#logger.info({ publicationId }, "A publication's outcome was already recorded");
        } else {
          await this.#broadcastRecordedEvent(outcome.recordedEvent);
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    return promise;
  }

  #disconnectEveryone(): void {
    for (const client of [...this.#clientPhases.keys()]) {
      this.detachClient(client);
      client.close(closeCodes.threadNotFound, "This thread has been deleted");
    }
    const supervisors = [...this.#openSupervisorConnections];
    this.#openSupervisorConnections.clear();
    this.#connectingSupervisors.clear();
    this.#supervisor = undefined;
    for (const supervisor of supervisors) {
      supervisor.close(standardCloseCodes.goingAway, "This thread has been deleted");
    }
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
      isSandboxStopping: false,
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
    if (!(await this.#describeWorkspace(supervisor))) {
      return;
    }
    this.#advanceUserMessagesDeliveredThrough(resumePoint.userMessagesDeliveredThrough);
    if (claimedDelivery > resumePoint.userMessagesDeliveredThrough) {
      await this.#recordUserMessagesDelivered(claimedDelivery);
    }
    await this.#sendUserMessagesUpTo(supervisor, resumePoint.newestSequence);
  }

  /**
   * Tells a supervisor that has just been welcomed what its workspace should
   * hold, before it is handed any user message, so the agent never starts
   * without the repository. Returns false, having closed the connection, if
   * that cannot be read; the supervisor then tries again.
   */
  async #describeWorkspace(supervisor: AttachedSupervisor): Promise<boolean> {
    try {
      const preparation = await this.#workspaces.describe(this.threadId, {
        agentHasWorkedBefore: supervisor.deliveryCursor > 0,
      });
      supervisor.connection.send(preparation);
      return true;
    } catch (error) {
      this.#logger.error({ err: error }, "Could not read what the thread's workspace should hold");
      this.#forgetSupervisor();
      supervisor.connection.close(
        standardCloseCodes.internalError,
        "The control plane could not read the thread's workspace",
      );
      return false;
    }
  }

  /**
   * Not queued, so not counted in the backlog; what a supervisor can make
   * the control plane hold through these is bounded elsewhere. A bundle
   * failure settles at most one waiting publication, at once. Credential
   * requests past a per-thread rate are refused without awaiting anything
   * (`RepositoryCredentials`), GitHub is asked at most once at a time per
   * thread and not again for a minute after refusing, and the answers
   * wait in the supervisor's send buffer, which is bounded too
   * (`WebSocketSupervisorConnection`).
   */
  #forwardWorkspaceRequest(
    connection: SupervisorConnection,
    message: SupervisorWorkspaceMessage,
  ): void {
    if (this.#supervisor?.connection !== connection) {
      this.#ignoreUnattachedSupervisorMessage(connection, message.type);
      return;
    }
    this.#workspaces.handleSupervisorRequest(this.threadId, message, (answer) =>
      connection.send(answer),
    );
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
   * away. Another control plane may close the same run at the same moment,
   * so the end is recorded only if the run is still open. Returns false,
   * having closed the connection, if it could not be recorded; the
   * supervisor then tries again.
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
      await this.#closeRun({ openedBySupervisorInstanceId: openedBy }, abandonedRunErrorMessage);
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
    await this.#threadActivity.recordAgentActivity(this.threadId);
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
   * attaches and is handed it. The sandbox lifecycle is asked first, and
   * wakes a stopped sandbox for it; it refuses only a message no agent
   * could receive, such as one to a thread being deleted.
   *
   * A message sent again with an identifier already recorded (its client
   * was told it was not saved, but it was) is not recorded again. The
   * event recorded the first time is broadcast instead, which shows it to
   * clients that were never sent it and is skipped by those that were, and
   * hands it to the supervisor if it was never handed over.
   */
  async #acceptUserMessage(client: ClientConnection, message: SendUserMessage): Promise<void> {
    const { messageId, text } = message;
    try {
      const admission = await this.#threadActivity.admitUserMessage(this.threadId, text);
      if (!admission.isAccepted) {
        this.#rejectClientMessage(client, admission.reason, messageId);
        return;
      }
      const outcome = await this.#threadEventLog.appendUserMessage(this.threadId, {
        type: "user_message",
        messageId,
        text,
      });
      if (outcome.isAlreadyRecorded) {
        this.#logger.info(
          { messageId, sequence: outcome.recordedEvent.sequence },
          "A user message sent again was already recorded",
        );
      }
      await this.#broadcastRecordedEvent(outcome.recordedEvent);
    } catch (error) {
      this.#logger.error({ err: error, messageId }, "Could not record a user message");
      this.#rejectClientMessage(
        client,
        "The message could not be saved, so it was not sent. Please try again.",
        messageId,
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

  /**
   * Every recorded event moves the supervisor's delivery cursor on. One
   * that does not follow straight after it means events were recorded
   * elsewhere (another control plane instance, or an append reported as
   * failed that was committed after all), and any user message among them
   * is handed over first, so messages reach the agent in sequence order.
   * While its sandbox is stopping the cursor stays where it is, so what is
   * held back is handed over if the stop fails.
   */
  async #broadcastRecordedEvent(recordedEvent: RecordedThreadEvent): Promise<void> {
    const { sequence, event } = recordedEvent;
    this.#logger.info({ sequence, eventType: event.type }, "Recorded a thread event");
    this.#forgetTextSupersededBy(event);
    this.#broadcast({ type: "thread_event", ...recordedEvent });
    const supervisor = this.#supervisor;
    if (
      supervisor === undefined ||
      supervisor.isSandboxStopping ||
      sequence <= supervisor.deliveryCursor
    ) {
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
    if (supervisor.isSandboxStopping || throughSequence <= supervisor.deliveryCursor) {
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

  /** `messageId` names the user message refused; an interrupt has none. */
  #rejectClientMessage(client: ClientConnection, reason: string, messageId?: string): void {
    this.#logger.info({ reason, messageId }, "Rejected a client message");
    this.#sendToClient(client, {
      type: "client_message_rejected",
      reason,
      ...(messageId === undefined ? {} : { messageId }),
    });
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
