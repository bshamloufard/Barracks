import {
  type AgentEvent,
  type AssistantTextFragment,
  buildClientEndpointPath,
  buildSupervisorEndpointPath,
  type ControlPlaneToClientMessage,
  type ControlPlaneToSupervisorMessage,
  parseControlPlaneToClientMessage,
  parseControlPlaneToSupervisorMessage,
  type RecordedThreadEvent,
} from "@barrack/protocol";
import { openTestSocket, type TestSocket } from "./test-socket.js";

/**
 * A stand-in for a sandbox supervisor that speaks the protocol but runs no
 * agent: the test decides which agent events and fragments it sends.
 */
export class FakeSupervisor {
  readonly #socket: TestSocket<ControlPlaneToSupervisorMessage>;

  constructor(socket: TestSocket<ControlPlaneToSupervisorMessage>) {
    this.#socket = socket;
  }

  get inbox() {
    return this.#socket.inbox;
  }

  get closed() {
    return this.#socket.closed;
  }

  sendAgentEvent(event: AgentEvent): void {
    this.#socket.sendMessage({ type: "agent_event", event });
  }

  sendTextFragment(fragment: Omit<AssistantTextFragment, "type">): void {
    this.#socket.sendMessage({
      type: "stream_fragment",
      fragment: { type: "assistant_text_fragment", ...fragment },
    });
  }

  sendRawFrame(frameText: string): void {
    this.#socket.sendRawFrame(frameText);
  }

  close(): Promise<void> {
    return this.#socket.close();
  }
}

/** A stand-in for the web client, reading and writing protocol messages directly. */
export class TestClient {
  readonly #socket: TestSocket<ControlPlaneToClientMessage>;

  constructor(socket: TestSocket<ControlPlaneToClientMessage>) {
    this.#socket = socket;
  }

  get inbox() {
    return this.#socket.inbox;
  }

  get closed() {
    return this.#socket.closed;
  }

  /** The thread events received so far, in the order they arrived. */
  get threadEvents(): RecordedThreadEvent[] {
    return this.inbox.messages.flatMap((message) =>
      message.type === "thread_event"
        ? [{ sequence: message.sequence, recordedAt: message.recordedAt, event: message.event }]
        : [],
    );
  }

  waitForSequence(sequence: number): Promise<void> {
    return this.inbox.waitUntil(`thread event ${sequence} has arrived`, () =>
      this.threadEvents.some((recordedEvent) => recordedEvent.sequence === sequence),
    );
  }

  sendUserMessage(text: string): void {
    this.#socket.sendMessage({ type: "send_user_message", text });
  }

  interruptAgent(): void {
    this.#socket.sendMessage({ type: "interrupt_agent" });
  }

  sendRawFrame(frameText: string): void {
    this.#socket.sendRawFrame(frameText);
  }

  close(): Promise<void> {
    return this.#socket.close();
  }
}

export async function connectFakeSupervisor(
  baseUrl: string,
  threadId: string,
  supervisorToken: string,
): Promise<FakeSupervisor> {
  const socket = await openTestSocket(
    `${baseUrl}${buildSupervisorEndpointPath({ threadId })}`,
    { Authorization: `Bearer ${supervisorToken}` },
    parseControlPlaneToSupervisorMessage,
  );
  return new FakeSupervisor(socket);
}

export async function connectTestClient(
  baseUrl: string,
  threadId: string,
  lastSeenSequence: number,
  origin: string,
): Promise<TestClient> {
  const socket = await openTestSocket(
    `${baseUrl}${buildClientEndpointPath({ threadId, lastSeenSequence })}`,
    { Origin: origin },
    parseControlPlaneToClientMessage,
  );
  return new TestClient(socket);
}
