import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  type AssistantTextFragment,
  buildClientEndpointPath,
  buildSupervisorEndpointPath,
  type ControlPlaneToClientMessage,
  type ControlPlaneToSupervisorMessage,
  type DeliverUserMessage,
  parseControlPlaneToClientMessage,
  parseControlPlaneToSupervisorMessage,
  type RecordedThreadEvent,
} from "@barrack/protocol";
import { openTestSocket, type TestSocket } from "./test-socket.js";

/**
 * A stand-in for a sandbox supervisor that speaks the protocol but runs no
 * agent: the test decides which agent events and fragments it sends, and
 * when it acknowledges what it is sent. Unlike a real supervisor it keeps
 * nothing for resending; a test resends by calling `sendAgentEventNumbered`.
 */
export class FakeSupervisor {
  readonly supervisorInstanceId: string;
  readonly #socket: TestSocket<ControlPlaneToSupervisorMessage>;
  #nextEventNumber = 1;

  constructor(socket: TestSocket<ControlPlaneToSupervisorMessage>, supervisorInstanceId: string) {
    this.#socket = socket;
    this.supervisorInstanceId = supervisorInstanceId;
  }

  get inbox() {
    return this.#socket.inbox;
  }

  get closed() {
    return this.#socket.closed;
  }

  /** The user messages it has been handed, in the order they arrived, redeliveries included. */
  get deliveredUserMessages(): DeliverUserMessage[] {
    return this.inbox.messages.filter((message) => message.type === "deliver_user_message");
  }

  /** Says hello and waits for the welcome, after which the control plane treats it as attached. */
  async sayHello(userMessagesDeliveredThroughSequence = 0): Promise<void> {
    this.#socket.sendMessage({
      type: "supervisor_hello",
      supervisorInstanceId: this.supervisorInstanceId,
      userMessagesDeliveredThroughSequence,
    });
    await this.inbox.waitFor("the welcome", (message) => message.type === "supervisor_welcome");
  }

  /** Sends `event` with the next event number, as a supervisor sends each new event. */
  sendAgentEvent(event: AgentEvent): void {
    this.sendAgentEventNumbered(this.#nextEventNumber, event);
    this.#nextEventNumber += 1;
  }

  sendAgentEventNumbered(eventNumber: number, event: AgentEvent): void {
    this.#socket.sendMessage({ type: "agent_event", eventNumber, event });
  }

  acknowledgeUserMessages(throughSequence: number): void {
    this.#socket.sendMessage({ type: "user_messages_delivered", throughSequence });
  }

  /** Resolves once the control plane has acknowledged events up to `eventNumber`. */
  waitUntilRecorded(eventNumber: number): Promise<void> {
    return this.inbox.waitUntil(`events through ${eventNumber} are acknowledged`, (messages) =>
      messages.some(
        (message) =>
          message.type === "agent_events_recorded" && message.throughEventNumber >= eventNumber,
      ),
    );
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

  authenticate(accessToken: string): void {
    this.#socket.sendMessage({ type: "authenticate", accessToken });
  }

  sendRawFrame(frameText: string): void {
    this.#socket.sendRawFrame(frameText);
  }

  close(): Promise<void> {
    return this.#socket.close();
  }
}

export type FakeSupervisorOptions = {
  /** A fresh one by default; reuse one to act as the same supervisor process reconnecting. */
  supervisorInstanceId?: string;
};

export async function connectFakeSupervisor(
  baseUrl: string,
  threadId: string,
  supervisorToken: string,
  options: FakeSupervisorOptions = {},
): Promise<FakeSupervisor> {
  const socket = await openTestSocket(
    `${baseUrl}${buildSupervisorEndpointPath({ threadId })}`,
    { Authorization: `Bearer ${supervisorToken}` },
    parseControlPlaneToSupervisorMessage,
  );
  return new FakeSupervisor(socket, options.supervisorInstanceId ?? randomUUID());
}

/**
 * Opens a client's connection and, given a token, authenticates at once, as
 * every client must, and waits for the first answer (the replay announcement)
 * or for the connection to close; a client may send nothing else before.
 * Without a token, the test decides what is sent first.
 */
export async function connectTestClient(
  baseUrl: string,
  threadId: string,
  lastSeenSequence: number,
  origin: string,
  accessToken: string | undefined,
): Promise<TestClient> {
  const socket = await openTestSocket(
    `${baseUrl}${buildClientEndpointPath({ threadId, lastSeenSequence })}`,
    { Origin: origin },
    parseControlPlaneToClientMessage,
  );
  const client = new TestClient(socket);
  if (accessToken !== undefined) {
    client.authenticate(accessToken);
    await Promise.race([
      client.inbox.waitUntil("the replay announcement", (messages) => messages.length > 0),
      client.closed,
    ]);
  }
  return client;
}
