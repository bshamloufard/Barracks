import { randomUUID } from "node:crypto";
import type {
  AssistantTextFragment,
  ClientToControlPlaneMessage,
  ControlPlaneToClientMessage,
  RecordedThreadEvent,
  SupervisorConnectionStatus,
  SupervisorToControlPlaneMessage,
  ThreadEvent,
} from "@barrack/protocol";
import { closeCodes } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import { standardCloseCodes } from "../standard-close-codes.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type { ClientConnection, SupervisorConnection } from "./connections.js";
import { InProgressAssistantText } from "./in-progress-assistant-text.js";
import { readMissedEvents } from "./read-missed-events.js";
import { SerialTaskQueue } from "./serial-task-queue.js";

/**
 * While a client is being replayed its history, everything else meant for it
 * waits here, because the protocol promises it nothing but the announced
 * events until the replay is over.
 */
type ClientPhase =
  | { name: "replaying"; heldBackMessages: ControlPlaneToClientMessage[] }
  | { name: "live" };

/**
 * Coordinates one thread: its supervisor, the clients watching it, and the
 * text of any assistant message still being streamed. It enforces the two
 * rules the product depends on: every thread event is recorded before any
 * client is shown it, and every client sees each thread event exactly once,
 * in sequence order, however it joins.
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
  readonly #queue = new SerialTaskQueue();
  readonly #inProgressText = new InProgressAssistantText();
  readonly #clientPhases = new Map<ClientConnection, ClientPhase>();
  #supervisor: SupervisorConnection | undefined;

  constructor(threadId: string, threadEventLog: ThreadEventLog, logger: Logger) {
    this.threadId = threadId;
    this.#threadEventLog = threadEventLog;
    this.#logger = logger;
  }

  attachSupervisor(connection: SupervisorConnection): void {
    this.#enqueue("attach a supervisor", async () => {
      const previousSupervisor = this.#supervisor;
      this.#supervisor = connection;
      if (previousSupervisor !== undefined) {
        this.#logger.warn("A newer supervisor connected; closing the previous one");
        previousSupervisor.close(
          closeCodes.supersededByNewerSupervisor,
          "A newer supervisor connected for this thread",
        );
        return;
      }
      this.#broadcastSupervisorConnectionStatus();
    });
  }

  detachSupervisor(connection: SupervisorConnection): void {
    this.#enqueue("detach a supervisor", async () => {
      if (this.#supervisor !== connection) {
        return;
      }
      this.#forgetSupervisor();
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
      if (this.#supervisor !== connection) {
        this.#logger.warn(
          { messageType: message.type },
          "Ignored a message from a supervisor that is no longer attached to this thread",
        );
        return;
      }
      if (message.type === "stream_fragment") {
        this.#relayAssistantTextFragment(message.fragment);
        return;
      }
      await this.#recordAgentEvent(connection, message.event);
    });
  }

  receiveFromClient(connection: ClientConnection, message: ClientToControlPlaneMessage): void {
    this.#enqueue(`handle ${message.type} from a client`, async () => {
      if (message.type === "send_user_message") {
        await this.#acceptUserMessage(connection, message.text);
        return;
      }
      this.#forwardInterrupt(connection);
    });
  }

  /**
   * Replays the history the client missed, then switches it to live traffic.
   * The client is registered before the log is read, so any event recorded
   * while the replay is under way is held back for it rather than missed;
   * held-back events the replay already covered are then skipped, so none is
   * sent twice.
   */
  async attachClient(connection: ClientConnection, lastSeenSequence: number): Promise<void> {
    const heldBackMessages: ControlPlaneToClientMessage[] = [];
    this.#clientPhases.set(connection, { name: "replaying", heldBackMessages });
    const missed = await readMissedEvents(
      this.#threadEventLog,
      this.threadId,
      lastSeenSequence,
      this.#logger,
    );
    const lastReplayedSequence = missed.events.at(-1)?.sequence ?? missed.afterSequence;
    await connection.sendAndWaitUntilWritten({
      type: "replay_announcement",
      firstSequence: missed.afterSequence + 1,
      lastSequence: lastReplayedSequence,
    });
    for (const recordedEvent of missed.events) {
      await connection.sendAndWaitUntilWritten({ type: "thread_event", ...recordedEvent });
    }
    if (!this.#clientPhases.has(connection)) {
      return;
    }
    // From here to the end nothing is awaited, so no event can slip in
    // between the held-back messages and the switch to live.
    this.#sendHeldBackMessages(connection, heldBackMessages, lastReplayedSequence);
    connection.send(this.#supervisorConnectionStatus());
    for (const fragment of this.#inProgressText.toCoalescedFragments()) {
      connection.send({ type: "stream_fragment", fragment });
    }
    this.#clientPhases.set(connection, { name: "live" });
    this.#logger.info({ replayedEventCount: missed.events.length }, "Client caught up and is live");
  }

  detachClient(connection: ClientConnection): void {
    this.#clientPhases.delete(connection);
  }

  async #recordAgentEvent(supervisor: SupervisorConnection, event: ThreadEvent): Promise<void> {
    try {
      await this.#recordAndBroadcast(event);
    } catch (error) {
      // The supervisor cannot be told which event was lost, so it is
      // disconnected rather than left believing the event was recorded. It is
      // forgotten at once, not when its socket finishes closing: events it
      // sent after the lost one may already be waiting in the queue, and
      // recording them would leave a silent hole in the thread's history.
      this.#logger.error({ err: error, eventType: event.type }, "Could not record an agent event");
      this.#forgetSupervisor();
      supervisor.close(
        standardCloseCodes.internalError,
        "The control plane could not record an event",
      );
    }
  }

  #forgetSupervisor(): void {
    this.#supervisor = undefined;
    this.#broadcastSupervisorConnectionStatus();
  }

  async #acceptUserMessage(client: ClientConnection, text: string): Promise<void> {
    const supervisor = this.#supervisor;
    if (supervisor === undefined) {
      this.#rejectClientMessage(
        client,
        "No agent is connected to this thread, so the message was not sent. Try again once the agent is connected.",
      );
      return;
    }
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
    // Delivered only after it is recorded, so the agent never acts on a
    // message that is missing from the thread's history: that could never be
    // repaired. The opposite failure, a recorded message the agent did not
    // get, is visible in the thread and reported to the sender below, and
    // acknowledged delivery will be able to redeliver it from the log.
    const isAccepted = supervisor.send({ type: "deliver_user_message", messageId, text });
    if (!isAccepted) {
      this.#logger.warn({ messageId }, "Recorded a user message the supervisor could not be sent");
      this.#rejectClientMessage(
        client,
        "The message was recorded but could not be delivered to the agent, because its connection is closing. Send it again once the agent has reconnected.",
      );
      return;
    }
    this.#logger.info({ messageId }, "Delivered a user message to the supervisor");
  }

  #forwardInterrupt(client: ClientConnection): void {
    const supervisor = this.#supervisor;
    if (supervisor === undefined) {
      this.#rejectClientMessage(
        client,
        "No agent is connected to this thread, so there is nothing to interrupt.",
      );
      return;
    }
    const isAccepted = supervisor.send({ type: "interrupt_agent" });
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
    this.#logger.info(
      { sequence: recordedEvent.sequence, eventType: event.type },
      "Recorded a thread event",
    );
    this.#forgetTextSupersededBy(event);
    this.#broadcast({ type: "thread_event", ...recordedEvent });
    return recordedEvent;
  }

  #forgetTextSupersededBy(event: ThreadEvent): void {
    if (event.type === "assistant_message") {
      this.#inProgressText.discardMessage(event.messageId);
    }
    if (event.type === "agent_run_settled" || event.type === "agent_failed") {
      this.#inProgressText.discardAll();
    }
  }

  #relayAssistantTextFragment(fragment: AssistantTextFragment): void {
    const isStillTracked = this.#inProgressText.append(fragment);
    if (!isStillTracked) {
      this.#logger.warn(
        { messageId: fragment.messageId },
        "Stopped keeping streamed text for an assistant message that grew past the size limit",
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

  #broadcast(message: ControlPlaneToClientMessage): void {
    for (const client of this.#clientPhases.keys()) {
      this.#sendToClient(client, message);
    }
  }

  #sendToClient(client: ClientConnection, message: ControlPlaneToClientMessage): void {
    const phase = this.#clientPhases.get(client);
    if (phase?.name === "replaying") {
      phase.heldBackMessages.push(message);
      return;
    }
    client.send(message);
  }

  /**
   * Thread events the replay already covered are skipped. Fragments and
   * connection status are skipped too, because the client is sent the
   * current status and all in-progress text right after these.
   */
  #sendHeldBackMessages(
    client: ClientConnection,
    heldBackMessages: ControlPlaneToClientMessage[],
    lastReplayedSequence: number,
  ): void {
    for (const message of heldBackMessages) {
      const isNewThreadEvent =
        message.type === "thread_event" && message.sequence > lastReplayedSequence;
      if (isNewThreadEvent || message.type === "client_message_rejected") {
        client.send(message);
      }
    }
  }

  #enqueue(description: string, task: () => Promise<void>): void {
    this.#queue.enqueue(task).catch((error: unknown) => {
      this.#logger.error({ err: error }, `Failed to ${description}`);
    });
  }
}
