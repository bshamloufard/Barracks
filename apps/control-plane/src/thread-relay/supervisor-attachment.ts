import type {
  RecordedThreadEvent,
  SupervisorDesktopMessage,
  SupervisorHello,
  SupervisorToControlPlaneMessage,
  SupervisorWorkspaceMessage,
} from "@barrack/protocol";
import { closeCodes } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import { standardCloseCodes } from "../standard-close-codes.js";
import type {
  OpenRun,
  SupervisorResumePoint,
  ThreadEventLog,
} from "../thread-event-log/thread-event-log.js";
import type { SupervisorConnection } from "./connections.js";
import { refuseSupervisor, SupervisorSession } from "./supervisor-session.js";
import type { ThreadActivity } from "./thread-activity.js";
import type { ThreadDesktopState } from "./thread-desktop-state.js";
import type { ThreadModelAccess } from "./thread-model-access.js";
import type { ThreadWorkspaces } from "./thread-workspaces.js";

/*
 * Which of a thread's supervisor connections is its supervisor. A connection
 * is admitted, a few at most, and must say hello before anything else; once
 * its hello checks out it is welcomed as a `SupervisorSession`, superseding
 * the one before, and stays the thread's supervisor until it disconnects,
 * breaks the protocol, or is superseded in turn. Workspace requests and
 * desktop reports from it are passed on to whoever answers them.
 */

/**
 * A thread has one supervisor, which may briefly have a second connection
 * open while it reconnects; more than this is a sandbox misbehaving.
 */
const maximumOpenSupervisorConnections = 4;

/**
 * Closes a run in place of the supervisor that started it; shown to the user
 * after "The agent stopped working: ".
 */
export const abandonedRunErrorMessage =
  "the process supervising it in its sandbox stopped in the middle of this run and has since been replaced, so the run could not finish. Anything the agent did after the last step shown here was lost. Send a message to carry on.";

/**
 * What the supervisor side asks of its thread's relay, which alone reaches
 * the clients and records events in sequence with everything else.
 */
export interface RelayForSupervisors {
  /** Shows clients an event just recorded, and hands the supervisor any user message it makes due. */
  broadcastRecordedEvent(recordedEvent: RecordedThreadEvent): Promise<void>;
  /** Records the end of `run` as a failure if it is still open; returns whether this closed it. */
  closeRun(run: OpenRun, errorMessage: string): Promise<boolean>;
  /** Tells clients whether a supervisor is attached now. */
  broadcastSupervisorConnectionStatus(): void;
  /** The furthest delivery of user messages known, which only grows. */
  userMessagesDeliveredThrough(): number;
  /** Moves the furthest delivery on to `throughSequence`, telling clients, if that is further. */
  advanceUserMessagesDeliveredThrough(throughSequence: number): void;
}

export type SupervisorAttachmentOptions = {
  threadId: string;
  threadEventLog: ThreadEventLog;
  threadActivity: ThreadActivity;
  workspaces: ThreadWorkspaces;
  modelAccess: ThreadModelAccess;
  desktops: ThreadDesktopState;
  relay: RelayForSupervisors;
  logger: Logger;
};

export class SupervisorAttachment {
  readonly #options: SupervisorAttachmentOptions;
  readonly #threadId: string;
  readonly #logger: Logger;
  /** Every supervisor connection admitted and not yet closed, whatever its state. */
  readonly #openConnections = new Set<SupervisorConnection>();
  /** Supervisor connections that have not yet said hello. */
  readonly #connectingConnections = new Set<SupervisorConnection>();
  #session: SupervisorSession | undefined;

  constructor(options: SupervisorAttachmentOptions) {
    this.#options = options;
    this.#threadId = options.threadId;
    this.#logger = options.logger;
  }

  /** The thread's supervisor: the connection that said hello last and was welcomed, if it is still here. */
  get session(): SupervisorSession | undefined {
    return this.#session;
  }

  /** No supervisor is attached and none is waiting to say hello; any connection left is only closing. */
  get isUnused(): boolean {
    return this.#session === undefined && this.#connectingConnections.size === 0;
  }

  /**
   * Admits a supervisor connection, which becomes the thread's supervisor
   * once it says hello. Each open connection can hold a frame being
   * received, up to `maximumFrameLength`, before anything reaches the
   * relay, so a sandbox is allowed only a few at once.
   */
  admit(connection: SupervisorConnection): void {
    if (this.#openConnections.size >= maximumOpenSupervisorConnections) {
      this.#logger.warn(
        { openConnectionCount: this.#openConnections.size },
        "Refused a supervisor connection: too many are open for this thread",
      );
      connection.close(
        standardCloseCodes.tryAgainLater,
        "Too many supervisor connections are open for this thread",
      );
      return;
    }
    this.#openConnections.add(connection);
    this.#connectingConnections.add(connection);
  }

  /** The connection's socket has closed, so it no longer counts against the limit. */
  noteClosed(connection: SupervisorConnection): void {
    this.#openConnections.delete(connection);
  }

  /** Lets go of a closed connection, and of the thread's supervisor if it was that one. */
  detach(connection: SupervisorConnection): void {
    this.#connectingConnections.delete(connection);
    if (this.#session?.connection === connection) {
      this.forgetSupervisor();
    }
  }

  /**
   * The session of `connection` if it is the thread's supervisor. Otherwise
   * the message it sent, of `messageType`, is ignored, or the connection
   * refused if it never said hello, and this returns undefined.
   */
  sessionOf(
    connection: SupervisorConnection,
    messageType: SupervisorToControlPlaneMessage["type"],
  ): SupervisorSession | undefined {
    const session = this.#session;
    if (session?.connection === connection) {
      return session;
    }
    this.#ignoreUnattachedSupervisorMessage(connection, messageType);
    return undefined;
  }

  /**
   * Makes a connection that said hello the thread's supervisor: checks its
   * claim, closes a run an earlier supervisor left open, tells it which of
   * its events are recorded, and hands it the user messages it lacks.
   */
  async greet(connection: SupervisorConnection, hello: SupervisorHello): Promise<void> {
    if (!this.#connectingConnections.delete(connection)) {
      refuseSupervisor(connection, "A supervisor said hello twice", this.#logger);
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
      refuseSupervisor(
        connection,
        "A supervisor claimed an impossible delivery position",
        this.#logger,
      );
      return;
    }
    this.#supersedePreviousSupervisor();
    if (!(await this.#closeRunAbandonedByEarlierSupervisor(connection, hello, resumePoint))) {
      this.#options.relay.broadcastSupervisorConnectionStatus();
      return;
    }
    const session = this.#startSession(connection, hello, resumePoint);
    if (!(await this.#describeWorkspace(session))) {
      return;
    }
    if (!(await session.describeModelAccess())) {
      return;
    }
    session.connection.send({
      type: "desktop_control",
      holder: this.#options.desktops.controlHolderOf(this.#threadId),
    });
    this.#options.relay.advanceUserMessagesDeliveredThrough(
      resumePoint.userMessagesDeliveredThrough,
    );
    if (claimedDelivery > resumePoint.userMessagesDeliveredThrough) {
      await session.recordUserMessagesDelivered(claimedDelivery);
    }
    await session.handOverUserMessagesThrough(resumePoint.newestSequence);
  }

  /** Attaches the connection as the thread's supervisor and welcomes it. */
  #startSession(
    connection: SupervisorConnection,
    hello: SupervisorHello,
    resumePoint: SupervisorResumePoint,
  ): SupervisorSession {
    const options = this.#options;
    const session = new SupervisorSession({
      threadId: this.#threadId,
      connection,
      supervisorInstanceId: hello.supervisorInstanceId,
      lastRecordedEventNumber: resumePoint.lastRecordedEventNumber,
      deliveryCursor: Math.max(
        hello.userMessagesDeliveredThroughSequence,
        resumePoint.userMessagesDeliveredThrough,
      ),
      threadEventLog: options.threadEventLog,
      threadActivity: options.threadActivity,
      modelAccess: options.modelAccess,
      relay: options.relay,
      attachment: this,
      logger: this.#logger,
    });
    this.#session = session;
    session.welcome();
    this.#logger.info(
      {
        supervisorInstanceId: hello.supervisorInstanceId,
        lastRecordedEventNumber: resumePoint.lastRecordedEventNumber,
        userMessagesDeliveredThrough: session.deliveryCursor,
      },
      "Supervisor attached",
    );
    void options.threadActivity.recordSupervisorAttached(this.#threadId);
    options.relay.broadcastSupervisorConnectionStatus();
    return session;
  }

  /**
   * Tells a supervisor that has just been welcomed what its workspace should
   * hold, before it is handed any user message, so the agent never starts
   * without the repository. Returns false, having closed the connection, if
   * that cannot be read; the supervisor then tries again.
   */
  async #describeWorkspace(session: SupervisorSession): Promise<boolean> {
    try {
      const preparation = await this.#options.workspaces.describe(this.#threadId, {
        agentHasWorkedBefore: session.deliveryCursor > 0,
      });
      session.connection.send(preparation);
      return true;
    } catch (error) {
      this.#logger.error({ err: error }, "Could not read what the thread's workspace should hold");
      this.forgetSupervisor();
      session.connection.close(
        standardCloseCodes.internalError,
        "The control plane could not read the thread's workspace",
      );
      return false;
    }
  }

  async #readResumePoint(
    connection: SupervisorConnection,
    supervisorInstanceId: string,
  ): Promise<SupervisorResumePoint | undefined> {
    try {
      return await this.#options.threadEventLog.readSupervisorResumePoint(
        this.#threadId,
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
      await this.#options.relay.closeRun(
        { openedBySupervisorInstanceId: openedBy },
        abandonedRunErrorMessage,
      );
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
    const previousSession = this.#session;
    if (previousSession === undefined) {
      return;
    }
    this.#session = undefined;
    this.#logger.warn("A newer supervisor connected; closing the previous one");
    previousSession.connection.close(
      closeCodes.supersededByNewerSupervisor,
      "A newer supervisor connected for this thread",
    );
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
  forwardWorkspaceRequest(
    connection: SupervisorConnection,
    message: SupervisorWorkspaceMessage,
  ): void {
    if (this.sessionOf(connection, message.type) === undefined) {
      return;
    }
    this.#options.workspaces.handleSupervisorRequest(this.#threadId, message, (answer) =>
      connection.send(answer),
    );
  }

  /**
   * Desktop reports need no ordering with the thread's events, so they skip
   * the queue; each is small and replaces the last, so they need no bound
   * beyond the frame's.
   */
  receiveDesktopReport(connection: SupervisorConnection, message: SupervisorDesktopMessage): void {
    if (this.sessionOf(connection, message.type) === undefined) {
      return;
    }
    const { desktops } = this.#options;
    if (message.type === "desktop_stream_failed") {
      desktops.noteStreamFailed(this.#threadId, message.streamId, message.reason);
      return;
    }
    const { type: _type, ...availability } = message;
    desktops.noteAvailability(this.#threadId, availability);
  }

  /**
   * The thread no longer has a supervisor here: what it reported of its
   * desktop no longer holds, and clients are told. Also called by a session
   * that broke, from the moment it broke.
   */
  forgetSupervisor(): void {
    this.#session = undefined;
    this.#options.desktops.noteSupervisorDetached(this.#threadId);
    this.#options.relay.broadcastSupervisorConnectionStatus();
  }

  /** Closes every supervisor connection, attached or not, for a thread that was deleted. */
  disconnectAll(): void {
    const connections = [...this.#openConnections];
    this.#openConnections.clear();
    this.#connectingConnections.clear();
    this.#session = undefined;
    for (const connection of connections) {
      connection.close(standardCloseCodes.goingAway, "This thread has been deleted");
    }
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
    if (this.#connectingConnections.delete(connection)) {
      refuseSupervisor(
        connection,
        `A supervisor sent ${messageType} before saying hello`,
        this.#logger,
      );
      return;
    }
    this.#logger.warn(
      { messageType },
      "Ignored a message from a supervisor that is no longer attached to this thread",
    );
  }
}
