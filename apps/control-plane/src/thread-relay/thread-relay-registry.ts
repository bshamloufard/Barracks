import type { ControlPlaneDesktopMessage, ControlPlaneWorkspaceMessage } from "@barrack/protocol";
import type { DesktopSupervisorChannel } from "../desktop/thread-desktops.js";
import type { Logger } from "../logger.js";
import type { ThreadRuns } from "../sandbox-lifecycle/thread-runs.js";
import type {
  OpenRun,
  PublicationOutcomeEvent,
  ThreadEventLog,
} from "../thread-event-log/thread-event-log.js";
import type { ThreadAccess } from "../threads/thread-access.js";
import type { ClientConnection, SupervisorConnection } from "./connections.js";
import type { ThreadActivity } from "./thread-activity.js";
import type { ThreadDesktopState } from "./thread-desktop-state.js";
import type { ThreadModelAccess } from "./thread-model-access.js";
import { ThreadRelay } from "./thread-relay.js";
import type { ThreadWorkspaces } from "./thread-workspaces.js";

/** A thread's sandbox began stopping, or the thread began being deleted, on this control plane. */
export type ThreadEnding = "stop" | "deletion";

export type ThreadEndingListener = (threadId: string, ending: ThreadEnding) => void;

export type ThreadRelayRegistryOptions = {
  threadEventLog: ThreadEventLog;
  threadActivity: ThreadActivity;
  workspaces?: ThreadWorkspaces;
  modelAccess?: ThreadModelAccess;
  desktops?: ThreadDesktopState;
  logger: Logger;
};

/**
 * Hands out the one relay for each thread, creating it the first time a
 * supervisor or client connects. The WebSocket endpoints admit supervisors
 * only with their thread's token, and clients only with a `ThreadAccess`.
 *
 * A relay is dropped as soon as it has no supervisor, no clients and no
 * queued work, so the map holds only threads someone is connected to. The
 * history lives in the event log, so dropping a relay loses at most the text
 * of a message that was still streaming when its supervisor went away, which
 * is not part of the record (see `InProgressAssistantText`).
 *
 * Peers attach through the registry, which finds or creates the relay and
 * attaches the peer in one synchronous step. A relay is therefore never
 * dropped between being handed out and having its peer attached.
 *
 * It is also how the sandbox lifecycle reaches a thread's run (`ThreadRuns`),
 * so that what the lifecycle records is in sequence with everything else.
 */
export class ThreadRelayRegistry implements ThreadRuns, DesktopSupervisorChannel {
  readonly #options: ThreadRelayRegistryOptions;
  readonly #relaysByThreadId = new Map<string, ThreadRelay>();
  readonly #endingListeners: ThreadEndingListener[] = [];

  constructor(options: ThreadRelayRegistryOptions) {
    this.#options = options;
  }

  /** Returns the relay the supervisor is now attached to. */
  attachSupervisor(threadId: string, connection: SupervisorConnection): ThreadRelay {
    const relay = this.#relayFor(threadId);
    relay.attachSupervisor(connection);
    return relay;
  }

  /**
   * Returns the relay the client is now attached to. It takes proof that the
   * client's user owns the thread, so no client is attached without that
   * check.
   */
  attachClient(
    access: ThreadAccess,
    connection: ClientConnection,
    lastSeenSequence: number,
  ): ThreadRelay {
    const relay = this.#relayFor(access.threadId);
    relay.attachClient(connection, lastSeenSequence);
    return relay;
  }

  prepareForStop(threadId: string): void {
    this.#relaysByThreadId.get(threadId)?.prepareForStop();
    this.#tellEndingListeners(threadId, "stop");
  }

  prepareForDeletion(threadId: string): void {
    this.#tellEndingListeners(threadId, "deletion");
  }

  /**
   * Calls `listener` whenever a thread's sandbox begins stopping, or a thread
   * begins being deleted, through this control plane: how work for a thread
   * outside its relay (a publication) learns to give up.
   */
  listenForEndings(listener: ThreadEndingListener): void {
    this.#endingListeners.push(listener);
  }

  finishStop(threadId: string): void {
    this.#relaysByThreadId.get(threadId)?.finishStop();
  }

  /** A relay is made for this if nobody is connected, and dropped again once it is done. */
  closeOpenRun(threadId: string, run: OpenRun, errorMessage: string): Promise<void> {
    return this.#relayFor(threadId).closeOpenRun(run, errorMessage);
  }

  /** With no relay for the thread, nothing of it can be on its way into the log here. */
  forgetDeletedThread(threadId: string): Promise<void> {
    this.#options.workspaces?.forgetThread(threadId);
    const relay = this.#relaysByThreadId.get(threadId);
    if (relay === undefined) {
      return this.#options.threadEventLog.deleteHistory(threadId);
    }
    return relay.forgetDeletedThread();
  }

  /**
   * Tells the thread's attached supervisor its model access again, if it
   * has changed. A thread with no relay here has no supervisor attached
   * here, and its supervisor is told when it next attaches.
   */
  refreshModelAccess(threadId: string): void {
    this.#relaysByThreadId.get(threadId)?.refreshModelAccess();
  }

  /** Sends to the thread's attached supervisor; false if none is attached here. */
  sendWorkspaceMessage(threadId: string, message: ControlPlaneWorkspaceMessage): boolean {
    return this.#relaysByThreadId.get(threadId)?.sendWorkspaceMessage(message) ?? false;
  }

  /** Sends to the thread's attached supervisor; false if none is attached here. */
  sendDesktopMessage(threadId: string, message: ControlPlaneDesktopMessage): boolean {
    return this.#relaysByThreadId.get(threadId)?.sendDesktopMessage(message) ?? false;
  }

  /** A thread with no relay here has no clients here to tell. */
  broadcastDesktopControlStatus(threadId: string): void {
    this.#relaysByThreadId.get(threadId)?.broadcastDesktopControlStatus();
  }

  /** Whether the thread's supervisor is attached to this control plane, welcomed. */
  isSupervisorAttached(threadId: string): boolean {
    return this.#relaysByThreadId.get(threadId)?.isSupervisorAttached ?? false;
  }

  /** A relay is made for this if nobody is connected, and dropped again once it is done. */
  recordPublicationOutcome(
    threadId: string,
    publicationId: string,
    event: PublicationOutcomeEvent,
  ): Promise<void> {
    return this.#relayFor(threadId).recordPublicationOutcome(publicationId, event);
  }

  #tellEndingListeners(threadId: string, ending: ThreadEnding): void {
    for (const listener of this.#endingListeners) {
      listener(threadId, ending);
    }
  }

  #relayFor(threadId: string): ThreadRelay {
    const existingRelay = this.#relaysByThreadId.get(threadId);
    if (existingRelay !== undefined) {
      return existingRelay;
    }
    const logger = this.#options.logger.child({ threadId });
    const relay: ThreadRelay = new ThreadRelay({
      threadId,
      threadEventLog: this.#options.threadEventLog,
      threadActivity: this.#options.threadActivity,
      ...(this.#options.workspaces === undefined ? {} : { workspaces: this.#options.workspaces }),
      ...(this.#options.modelAccess === undefined
        ? {}
        : { modelAccess: this.#options.modelAccess }),
      ...(this.#options.desktops === undefined ? {} : { desktops: this.#options.desktops }),
      logger,
      whenUnused: () => this.#drop(relay, logger),
    });
    this.#relaysByThreadId.set(threadId, relay);
    return relay;
  }

  /**
   * A relay already dropped can still report itself unused, when a peer's
   * socket finishes closing late, so only the thread's current relay is
   * removed.
   */
  #drop(relay: ThreadRelay, logger: Logger): void {
    if (this.#relaysByThreadId.get(relay.threadId) !== relay) {
      return;
    }
    this.#relaysByThreadId.delete(relay.threadId);
    logger.info("Dropped the thread's relay, which has no connections left");
  }
}
