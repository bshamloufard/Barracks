import type {
  AssistantTextFragment,
  ClientCommand,
  ControlPlaneDesktopMessage,
  ControlPlaneWorkspaceMessage,
  RecordedThreadEvent,
  StreamFragmentMessage,
  SupervisorToControlPlaneMessage,
} from "@barrack/protocol";
import { closeCodes } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import { standardCloseCodes } from "../standard-close-codes.js";
import type {
  OpenRun,
  PublicationOutcomeEvent,
  ThreadEventLog,
} from "../thread-event-log/thread-event-log.js";
import { ClientCommands } from "./client-commands.js";
import type { ClientConnection, SupervisorConnection } from "./connections.js";
import { RelayQueue } from "./relay-queue.js";
import { SupervisorAttachment } from "./supervisor-attachment.js";
import { supervisorMessagesBacklogLimit } from "./supervisor-backlog.js";
import type { ThreadActivity } from "./thread-activity.js";
import { ThreadClients } from "./thread-clients.js";
import {
  isSupervisorDesktopMessage,
  noThreadDesktops,
  type ThreadDesktopState,
} from "./thread-desktop-state.js";
import { noThreadModelAccess, type ThreadModelAccess } from "./thread-model-access.js";
import {
  emptyThreadWorkspaces,
  isSupervisorWorkspaceMessage,
  type ThreadWorkspaces,
} from "./thread-workspaces.js";

export type ThreadRelayOptions = {
  threadId: string;
  threadEventLog: ThreadEventLog;
  threadActivity: ThreadActivity;
  /** What the thread's workspace holds; empty when omitted. */
  workspaces?: ThreadWorkspaces;
  /** The thread's model and its owner's key; none when omitted. */
  modelAccess?: ThreadModelAccess;
  /** Who holds threads' desktops, and where desktop reports go; none when omitted. */
  desktops?: ThreadDesktopState;
  logger: Logger;
  /**
   * Called whenever the relay is left with no supervisor, no clients and no
   * queued work, which is when it can be dropped.
   */
  whenUnused: () => void;
};

/**
 * Coordinates one thread: its supervisor and the clients watching it. It
 * enforces the rules the product depends on: every thread event is recorded
 * before any client is shown it; every client sees each thread event
 * exactly once, in sequence order, however it joins (`ThreadClients`);
 * every agent event the supervisor sends is recorded exactly once and
 * acknowledged only once it is; and every user message is handed to the
 * agent, in order, even if no supervisor was connected when it was sent
 * (`SupervisorSession`, for the supervisor `SupervisorAttachment` welcomed).
 *
 * Messages from the supervisor and from clients go through one queue
 * (`RelayQueue`), so the thread's events are recorded and broadcast in the
 * order they arrived. Replaying history to a newly connected client
 * deliberately does not, so a slow replay never delays live traffic for
 * everyone else.
 */
export class ThreadRelay {
  readonly threadId: string;
  readonly #threadEventLog: ThreadEventLog;
  readonly #logger: Logger;
  readonly #whenUnused: () => void;
  readonly #queue: RelayQueue;
  readonly #clients: ThreadClients;
  readonly #supervisors: SupervisorAttachment;
  readonly #clientCommands: ClientCommands;

  constructor(options: ThreadRelayOptions) {
    const { threadId, threadEventLog, threadActivity, logger } = options;
    const modelAccess = options.modelAccess ?? noThreadModelAccess;
    const desktops = options.desktops ?? noThreadDesktops;
    this.threadId = threadId;
    this.#threadEventLog = threadEventLog;
    this.#logger = logger;
    this.#whenUnused = options.whenUnused;
    this.#queue = new RelayQueue({ logger, whenTaskSettled: () => this.#reportIfUnused() });
    this.#clients = new ThreadClients({
      threadId,
      threadEventLog,
      desktops,
      isSupervisorAttached: () => this.isSupervisorAttached,
      logger,
      whenClientDisconnected: () => this.#reportIfUnused(),
    });
    this.#supervisors = new SupervisorAttachment({
      threadId,
      threadEventLog,
      threadActivity,
      workspaces: options.workspaces ?? emptyThreadWorkspaces,
      modelAccess,
      desktops,
      relay: {
        broadcastRecordedEvent: (recordedEvent) => this.#broadcastRecordedEvent(recordedEvent),
        closeRun: (run, errorMessage) => this.#closeRun(run, errorMessage),
        broadcastSupervisorConnectionStatus: () =>
          this.#clients.broadcastSupervisorConnectionStatus(),
        userMessagesDeliveredThrough: () => this.#clients.userMessagesDeliveredThrough,
        advanceUserMessagesDeliveredThrough: (throughSequence) =>
          this.#clients.advanceUserMessagesDeliveredThrough(throughSequence),
      },
      logger,
    });
    this.#clientCommands = new ClientCommands({
      threadId,
      threadEventLog,
      threadActivity,
      modelAccess,
      clients: this.#clients,
      supervisors: this.#supervisors,
      broadcastRecordedEvent: (recordedEvent) => this.#broadcastRecordedEvent(recordedEvent),
      logger,
    });
  }

  /** Registers a supervisor connection, which becomes the thread's supervisor once it says hello. */
  attachSupervisor(connection: SupervisorConnection): void {
    this.#supervisors.admit(connection);
  }

  detachSupervisor(connection: SupervisorConnection): void {
    this.#supervisors.noteClosed(connection);
    this.#queue.enqueue("detach a supervisor", async () => {
      this.#supervisors.detach(connection);
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
   * bounded by other means (see `SupervisorAttachment.forwardWorkspaceRequest`).
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
    if (isSupervisorDesktopMessage(message)) {
      this.#supervisors.receiveDesktopReport(connection, message);
      return;
    }
    if (isSupervisorWorkspaceMessage(message)) {
      this.#supervisors.forwardWorkspaceRequest(connection, message);
      return;
    }
    const isQueued = this.#queue.enqueueSupervisorMessage(
      frameLength,
      `handle ${message.type} from the supervisor`,
      () => this.#handleSupervisorMessage(connection, message),
    );
    if (!isQueued) {
      this.#disconnectOverflowingSupervisor(connection);
    }
  }

  async #handleSupervisorMessage(
    connection: SupervisorConnection,
    message: Exclude<SupervisorToControlPlaneMessage, StreamFragmentMessage>,
  ): Promise<void> {
    if (message.type === "supervisor_hello") {
      await this.#supervisors.greet(connection, message);
      return;
    }
    const session = this.#supervisors.sessionOf(connection, message.type);
    if (session === undefined) {
      return;
    }
    switch (message.type) {
      case "agent_event":
        await session.recordAgentEvent(message);
        return;
      case "user_messages_delivered":
        await session.noteUserMessagesDelivered(message.throughSequence);
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
    const isQueued = this.#queue.enqueueStreamFragment(
      fragment.messageId,
      frameLength,
      "relay a stream fragment from the supervisor",
      async () => {
        if (this.#supervisors.sessionOf(connection, "stream_fragment") !== undefined) {
          this.#clients.relayAssistantTextFragment(fragment);
        }
      },
    );
    if (!isQueued) {
      this.#logger.debug(
        { messageId: fragment.messageId },
        "Dropped a stream fragment while the relay is behind",
      );
    }
  }

  /**
   * The supervisor sent more than may wait for the thread while earlier
   * messages are still being recorded. Those are still recorded; this one
   * and everything after it are not, and the supervisor sends them again
   * once it reconnects, by which time the queue has drained.
   */
  #disconnectOverflowingSupervisor(connection: SupervisorConnection): void {
    this.#logger.warn(
      { ...this.#queue.queuedSupervisorLengths, limit: supervisorMessagesBacklogLimit },
      "A supervisor sent more than may wait to be recorded for its thread; disconnecting it",
    );
    connection.close(
      standardCloseCodes.tryAgainLater,
      "The control plane is behind recording this thread's events; send them again later",
    );
  }

  receiveFromClient(connection: ClientConnection, message: ClientCommand): void {
    this.#queue.enqueue(`handle ${message.type} from a client`, () =>
      this.#clientCommands.carryOut(connection, message),
    );
  }

  /**
   * Registers the client at once, then replays the history it missed and
   * switches it to live traffic. A client whose replay fails is detached and
   * disconnected, so it reconnects and tries again.
   */
  attachClient(connection: ClientConnection, lastSeenSequence: number): void {
    this.#clients.add(connection);
    this.#clients.replayThenGoLive(connection, lastSeenSequence).catch((error: unknown) => {
      this.#logger.error({ err: error }, "Could not replay the thread's history to a client");
      this.detachClient(connection);
      connection.close(standardCloseCodes.internalError, "Could not replay the thread's history");
    });
  }

  detachClient(connection: ClientConnection): void {
    this.#clients.remove(connection);
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
    this.#queue.enqueue("prepare the agent for its sandbox stopping", async () => {
      this.#supervisors.session?.prepareForStop();
    });
  }

  /**
   * The stop is over. A supervisor still attached (the stop failed, and its
   * sandbox runs on) is handed the user messages held back meanwhile.
   */
  finishStop(): void {
    this.#queue.enqueue("resume handing user messages over after a stop", async () => {
      await this.#supervisors.session?.finishStop();
    });
  }

  /**
   * Records the end of `run` as a failure with `errorMessage`, if it is
   * still open: its sandbox has stopped, so no agent will end it. It goes
   * through the queue, after everything the supervisor sent before its
   * sandbox stopped. Resolves once recorded, or once found already closed.
   */
  closeOpenRun(run: OpenRun, errorMessage: string): Promise<void> {
    return this.#queue.enqueueAndWait(async () => {
      if (await this.#closeRun(run, errorMessage)) {
        this.#logger.info("Closed the run the stopped sandbox left open");
      }
    });
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
    return this.#queue.enqueueAndWait(() => this.#threadEventLog.deleteHistory(this.threadId));
  }

  /**
   * The thread's model, or its owner's key for it, may have changed: the
   * attached supervisor is told, if what it was told is no longer so. A
   * supervisor attached to another control plane instance is told before
   * its next user message instead (see `SupervisorSession.followRecordedEvent`).
   */
  refreshModelAccess(): void {
    this.#queue.enqueue("tell the supervisor its thread's model access", async () => {
      await this.#supervisors.session?.refreshModelAccess();
    });
  }

  /**
   * Sends a workspace message to the attached supervisor; returns false if
   * there is none, or its connection is closing.
   */
  sendWorkspaceMessage(message: ControlPlaneWorkspaceMessage): boolean {
    return this.#supervisors.session?.connection.send(message) ?? false;
  }

  /**
   * Sends a desktop request to the attached supervisor; returns false if
   * there is none, or its connection is closing.
   */
  sendDesktopMessage(message: ControlPlaneDesktopMessage): boolean {
    return this.#supervisors.session?.connection.send(message) ?? false;
  }

  /** Whether a supervisor has said hello and been welcomed, and is still here. */
  get isSupervisorAttached(): boolean {
    return this.#supervisors.session !== undefined;
  }

  /** Tells every client who holds the desktop now. */
  broadcastDesktopControlStatus(): void {
    this.#clients.broadcastDesktopControlStatus();
  }

  /**
   * Records how a publication the control plane carried out ended, in
   * sequence with everything else. A publication's outcome is recorded at
   * most once, however often this is called for it (see
   * `ThreadEventLog.appendPublicationOutcome`).
   */
  recordPublicationOutcome(publicationId: string, event: PublicationOutcomeEvent): Promise<void> {
    return this.#queue.enqueueAndWait(async () => {
      const outcome = await this.#threadEventLog.appendPublicationOutcome(
        this.threadId,
        event,
        publicationId,
      );
      if (outcome.isAlreadyRecorded) {
        this.#logger.info({ publicationId }, "A publication's outcome was already recorded");
        return;
      }
      await this.#broadcastRecordedEvent(outcome.recordedEvent);
    });
  }

  #disconnectEveryone(): void {
    for (const client of this.#clients.all()) {
      this.detachClient(client);
      client.close(closeCodes.threadNotFound, "This thread has been deleted");
    }
    this.#supervisors.disconnectAll();
    this.#reportIfUnused();
  }

  /**
   * Shows every client an event just recorded, then lets the attached
   * supervisor's session hand over any user message the event makes due.
   */
  async #broadcastRecordedEvent(recordedEvent: RecordedThreadEvent): Promise<void> {
    const { sequence, event } = recordedEvent;
    this.#logger.info({ sequence, eventType: event.type }, "Recorded a thread event");
    this.#clients.showRecordedEvent(recordedEvent);
    await this.#supervisors.session?.followRecordedEvent(recordedEvent);
  }

  /**
   * The check and the callback run in one synchronous step, as does the
   * registry's attaching of a peer, so no peer can attach between the relay
   * being found unused and the registry dropping it.
   */
  #reportIfUnused(): void {
    const isUnused = this.#supervisors.isUnused && this.#clients.count === 0 && this.#queue.isIdle;
    if (isUnused) {
      this.#whenUnused();
    }
  }
}
