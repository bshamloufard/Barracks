import {
  buildClientEndpointPath,
  type ClientToControlPlaneMessage,
  type ControlPlaneToClientMessage,
  parseControlPlaneToClientMessage,
  type ThreadEventMessage,
} from "@barrack/protocol";
import { WebSocket } from "ws";
import { type RunningControlPlane, testClientOrigin } from "./local-system.js";

const waitTimeoutInMilliseconds = 10_000;

type Waiter = { isSatisfied: () => boolean; resolve: () => void };

/**
 * A client of the control plane, speaking the protocol over a real WebSocket
 * the way the web page does. Everything it receives is checked with the
 * protocol's own parser and kept in arrival order.
 */
export class TestClient {
  readonly messages: ControlPlaneToClientMessage[] = [];
  readonly #socket: WebSocket;
  readonly #closed: Promise<void>;
  readonly #waiters = new Set<Waiter>();
  #invalidMessageError: Error | undefined;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    this.#closed = new Promise((resolve) => socket.once("close", () => resolve()));
    // Listening starts before the socket opens, because the control plane
    // may send its first message in the same packet as the upgrade response.
    socket.on("message", (frame) => this.#receive(String(frame)));
  }

  /**
   * Connects as the control plane's signed-in test user: the first message
   * authenticates, and nothing else is sent until the replay announcement
   * has arrived, as the protocol requires.
   */
  static async connect(
    controlPlane: Pick<RunningControlPlane, "webSocketBaseUrl" | "accessToken">,
    threadId: string,
    lastSeenSequence: number,
  ): Promise<TestClient> {
    const path = buildClientEndpointPath({ threadId, lastSeenSequence });
    const socket = new WebSocket(`${controlPlane.webSocketBaseUrl}${path}`, {
      headers: { Origin: testClientOrigin },
    });
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    client.send({ type: "authenticate", accessToken: controlPlane.accessToken });
    await client.waitUntil("the replay announcement", (messages) => messages.length > 0);
    return client;
  }

  send(message: ClientToControlPlaneMessage): void {
    this.#socket.send(JSON.stringify(message));
  }

  threadEvents(): ThreadEventMessage[] {
    return this.messages.filter((message) => message.type === "thread_event");
  }

  /** The sequence of the newest thread event received, or 0 for none. */
  lastSeenSequence(): number {
    return this.threadEvents().at(-1)?.sequence ?? 0;
  }

  /** Resolves once the messages received so far satisfy `isSatisfied`. */
  waitUntil(
    description: string,
    isSatisfied: (messages: readonly ControlPlaneToClientMessage[]) => boolean,
  ): Promise<void> {
    const check = (): boolean => isSatisfied(this.messages);
    if (check()) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        const received = JSON.stringify(this.messages, null, 2);
        reject(new Error(`Timed out waiting until ${description}. Received: ${received}`));
      }, waitTimeoutInMilliseconds);
      const waiter: Waiter = {
        isSatisfied: check,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      this.#waiters.add(waiter);
    });
  }

  waitUntilSupervisorIsConnected(): Promise<void> {
    return this.waitUntil("the supervisor is connected", (messages) =>
      messages.some(
        (message) =>
          message.type === "supervisor_connection_status" && message.isSupervisorConnected,
      ),
    );
  }

  waitUntilRunsHaveSettled(runCount: number): Promise<void> {
    return this.waitUntil(`${runCount} run(s) have settled`, (messages) => {
      const settledRuns = messages.filter(
        (message) => message.type === "thread_event" && message.event.type === "agent_run_settled",
      );
      return settledRuns.length >= runCount;
    });
  }

  /** Closes the connection and waits until it has closed. */
  async close(): Promise<void> {
    this.#socket.close();
    await this.#closed;
    if (this.#invalidMessageError !== undefined) {
      throw this.#invalidMessageError;
    }
  }

  #receive(frameText: string): void {
    const parsed = parseControlPlaneToClientMessage(frameText);
    if (!parsed.ok) {
      this.#invalidMessageError ??= new Error(
        `The control plane sent an invalid message: ${parsed.errorMessage}`,
      );
      return;
    }
    this.messages.push(parsed.value);
    for (const waiter of this.#waiters) {
      if (waiter.isSatisfied()) {
        this.#waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }
}
