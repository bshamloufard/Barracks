import type {
  AgentEvent,
  RecordedThreadEvent,
  ThreadEvent,
  UserMessageEvent,
} from "@barrack/protocol";
import { runBoundaryOf } from "./run-boundary.js";
import type {
  AgentWork,
  SupervisorEventAppendOutcome,
  SupervisorEventOrigin,
  SupervisorResumePoint,
  ThreadEventLog,
  ThreadEventPage,
  UserMessageAppendOutcome,
} from "./thread-event-log.js";

type ThreadHistory = {
  events: RecordedThreadEvent[];
  /** Each user message recorded, by its identifier. */
  userMessagesById: Map<string, RecordedThreadEvent>;
  /** The event numbers recorded from each supervisor instance. */
  recordedEventNumbersByInstance: Map<string, Set<number>>;
  openRunSupervisorInstanceId: string | undefined;
  userMessagesDeliveredThrough: number;
  /** The sequence of the newest user message, or 0 for none. */
  newestUserMessageSequence: number;
};

/**
 * Keeps every thread's history in process memory, for local development and
 * for tests. History is lost when the process exits.
 *
 * Every method changes its thread in one synchronous step, so concurrent
 * calls can never be given the same sequence or record one supervisor event
 * twice.
 */
export class InMemoryThreadEventLog implements ThreadEventLog {
  readonly #historiesByThreadId = new Map<string, ThreadHistory>();

  async append(threadId: string, event: ThreadEvent): Promise<RecordedThreadEvent> {
    return this.#store(this.#historyOf(threadId), event, undefined);
  }

  async appendUserMessage(
    threadId: string,
    event: UserMessageEvent,
  ): Promise<UserMessageAppendOutcome> {
    const history = this.#historyOf(threadId);
    const recordedBefore = history.userMessagesById.get(event.messageId);
    if (recordedBefore !== undefined) {
      return { isAlreadyRecorded: true, recordedEvent: recordedBefore };
    }
    const recordedEvent = this.#store(history, event, undefined);
    history.userMessagesById.set(event.messageId, recordedEvent);
    return { isAlreadyRecorded: false, recordedEvent };
  }

  async appendSupervisorEvent(
    threadId: string,
    event: AgentEvent,
    origin: SupervisorEventOrigin,
  ): Promise<SupervisorEventAppendOutcome> {
    const history = this.#historyOf(threadId);
    const recordedNumbers = history.recordedEventNumbersByInstance.get(origin.supervisorInstanceId);
    if (recordedNumbers?.has(origin.eventNumber)) {
      return { isAlreadyRecorded: true };
    }
    const recordedEvent = this.#store(history, event, origin.supervisorInstanceId);
    const numbers = recordedNumbers ?? new Set<number>();
    numbers.add(origin.eventNumber);
    history.recordedEventNumbersByInstance.set(origin.supervisorInstanceId, numbers);
    return { isAlreadyRecorded: false, recordedEvent };
  }

  async readNewestSequence(threadId: string): Promise<number> {
    return this.#historiesByThreadId.get(threadId)?.events.length ?? 0;
  }

  async readEvents(threadId: string, page: ThreadEventPage): Promise<RecordedThreadEvent[]> {
    const threadEvents = this.#historiesByThreadId.get(threadId)?.events ?? [];
    // Sequence n is stored at index n - 1, so the events after `afterSequence`
    // start at index `afterSequence`, and `throughSequence` is the index just
    // past the last one wanted.
    const start = Math.max(page.afterSequence, 0);
    const end = Math.min(page.throughSequence, start + page.limit);
    return threadEvents.slice(start, Math.max(end, start));
  }

  async readSupervisorResumePoint(
    threadId: string,
    supervisorInstanceId: string,
  ): Promise<SupervisorResumePoint> {
    const history = this.#historiesByThreadId.get(threadId);
    const recordedNumbers = history?.recordedEventNumbersByInstance.get(supervisorInstanceId);
    return {
      newestSequence: history?.events.length ?? 0,
      lastRecordedEventNumber: Math.max(0, ...(recordedNumbers ?? [])),
      userMessagesDeliveredThrough: history?.userMessagesDeliveredThrough ?? 0,
      openRunSupervisorInstanceId: history?.openRunSupervisorInstanceId,
    };
  }

  async readUserMessagesDeliveredThrough(threadId: string): Promise<number> {
    return this.#historiesByThreadId.get(threadId)?.userMessagesDeliveredThrough ?? 0;
  }

  async recordUserMessagesDelivered(threadId: string, throughSequence: number): Promise<void> {
    const history = this.#historyOf(threadId);
    history.userMessagesDeliveredThrough = Math.max(
      history.userMessagesDeliveredThrough,
      throughSequence,
    );
  }

  async readAgentWork(threadId: string): Promise<AgentWork> {
    const history = this.#historiesByThreadId.get(threadId);
    return {
      hasOpenRun: history?.openRunSupervisorInstanceId !== undefined,
      hasUndeliveredUserMessage:
        history !== undefined &&
        history.newestUserMessageSequence > history.userMessagesDeliveredThrough,
    };
  }

  async findThreadsWithOpenRuns(threadIds: readonly string[]): Promise<Set<string>> {
    return new Set(
      threadIds.filter(
        (threadId) =>
          this.#historiesByThreadId.get(threadId)?.openRunSupervisorInstanceId !== undefined,
      ),
    );
  }

  async deleteHistory(threadId: string): Promise<void> {
    this.#historiesByThreadId.delete(threadId);
  }

  #historyOf(threadId: string): ThreadHistory {
    const existing = this.#historiesByThreadId.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const history: ThreadHistory = {
      events: [],
      userMessagesById: new Map(),
      recordedEventNumbersByInstance: new Map(),
      openRunSupervisorInstanceId: undefined,
      userMessagesDeliveredThrough: 0,
      newestUserMessageSequence: 0,
    };
    this.#historiesByThreadId.set(threadId, history);
    return history;
  }

  #store(
    history: ThreadHistory,
    event: ThreadEvent,
    supervisorInstanceId: string | undefined,
  ): RecordedThreadEvent {
    const recordedEvent: RecordedThreadEvent = {
      sequence: history.events.length + 1,
      recordedAt: new Date().toISOString(),
      event,
    };
    history.events.push(recordedEvent);
    if (event.type === "user_message") {
      history.newestUserMessageSequence = recordedEvent.sequence;
    }
    const boundary = runBoundaryOf(event);
    if (boundary === "opens_run") {
      history.openRunSupervisorInstanceId = supervisorInstanceId;
    }
    if (boundary === "closes_run") {
      history.openRunSupervisorInstanceId = undefined;
    }
    return recordedEvent;
  }
}
