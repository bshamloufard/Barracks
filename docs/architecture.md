# Architecture

> **Built so far:** Milestone 1, and Milestone 2's parts, tested locally: a web client with a thread list, a control plane that creates each thread and its sandbox, sandbox providers for Docker, Daytona and local development, a sandbox image in which the agent runs as its own user, and thread history in Postgres. **Not built yet:** sign-in, any deployment, the control plane stopping, resuming or reconciling sandboxes, acknowledged delivery, per-user model access and the desktop view. Daytona and Supabase have never been run against. Sections that describe intended design say so. Update this document as code lands, so that it always matches what the code does.

## The four parts

| Part             | What it does                                                                               | Built today                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Clients          | Thread list, conversation view, live desktop view                                          | One web page ([`apps/web`](../apps/web)) with the list and the conversation                   |
| Control plane    | Authenticates users, creates and stops sandboxes, relays messages both ways, keeps history | [`apps/control-plane`](../apps/control-plane): creates threads and sandboxes, relays, records |
| Data store       | Users, threads, and the ordered record of everything each agent did                        | Postgres (threads and their events), or memory for development                                |
| Thread sandboxes | One isolated Linux computer per thread: the agent, its workspace, a graphical desktop      | A container from [`sandbox-image`](../sandbox-image), through a provider; no desktop yet      |

Clients are thin: all state lives on the server. The control plane never sleeps; sandboxes are meant to stop when idle, though nothing stops them yet.

## Two core design ideas

**The sandbox connects outward.** A small supervisor process inside each sandbox ([`apps/sandbox-supervisor`](../apps/sandbox-supervisor)) starts the agent and opens a WebSocket back to the control plane. The control plane never reaches into a sandbox, so a sandbox needs no inbound networking, and any provider, rented server or laptop can host one the same way.

**Every event is recorded in order before it is shown.** The control plane stores each event with its position in the thread's sequence and only then forwards it. A client that reconnects says where it left off and receives everything it missed: full history, several devices at once, and closing a laptop to pick the thread up on a phone.

## Creating a thread

1. The thread list's **New thread** sends `POST /api/threads` ([`http/threads-routes.ts`](../apps/control-plane/src/http/threads-routes.ts)), which checks the request's origin.
2. The control plane mints a thread identifier and a **supervisor token for that thread alone** (32 random bytes), records the thread with the token's SHA-256 digest and its sandbox `creating`, and answers at once ([`threads/thread-creator.ts`](../apps/control-plane/src/threads/thread-creator.ts)). The token itself is never stored, logged or returned.
3. In the background it asks the configured provider to create the sandbox, handing over the supervisor's environment: the control plane's URL, the thread, its token, and the agent's settings. The sandbox is then recorded `ready` with its identifier, or `failed` with a reason the page shows. A thread left `creating` by a control plane restart is marked failed at the next startup.
4. The sandbox's supervisor connects to `/threads/{threadId}/supervisor` with `Authorization: Bearer <token>`. The upgrade is accepted only if the token's digest matches the one recorded for that thread, compared in constant time ([`websocket/supervisor-authorization.ts`](../apps/control-plane/src/websocket/supervisor-authorization.ts)), so one sandbox cannot act as another thread's supervisor.

## Sandbox providers

The control plane sees only the `SandboxProvider` interface ([`packages/sandbox-providers`](../packages/sandbox-providers)): create a thread's sandbox, start, stop, destroy, read its state, and get an address for a service inside it. Providers hold no lifecycle policy; whenever a sandbox runs, its supervisor runs with the environment it was created with. One is chosen by `BARRACK_SANDBOX_PROVIDER`:

- **docker**: a container per thread from the sandbox image, through the Docker CLI, with every capability dropped but the two the supervisor needs to start the agent. Tested end to end.
- **daytona**: a Daytona sandbox from a snapshot of the image. Built and unit-tested against a fake API; never run against Daytona.
- **local-process**: for `pnpm dev` and fast tests. A directory and a supervisor process on the control plane's own machine, with no isolation at all; refused unless development use is declared, and only on a loopback address.
- **fake**: in memory, for the control plane's own tests.

## Inside a sandbox: two users

In the sandbox image, the supervisor runs as `barrack-supervisor` and starts Pi as `barrack-agent` through `run-as-agent`, a copy of `setpriv` that alone carries the capabilities to change user and only the supervisor's group may run. Linux shows a process's environment and memory, and lets it be signalled or traced, only to its own user, so the agent cannot reach the token through the supervisor's process. The agent owns its workspace and Pi's state; the supervisor's run and log directories are closed to it. What remains open is listed in the [sandbox image's README](../sandbox-image/README.md#what-the-agent-can-still-reach) and the [decision log](decisions.md). Under `pnpm dev` both run as the developer's user.

## History

Thread events are appended to the thread event log ([`thread-event-log/`](../apps/control-plane/src/thread-event-log)), which assigns each a **sequence**: 1 for a thread's first event, one more for each later one, no gaps. With `BARRACK_DATABASE_URL` set it is Postgres, in a schema of its own, migrated at startup; one statement updates the thread's counter row and inserts the event, so sequences stay gapless even with two writers. Without it, memory.

A client connecting to `/threads/{threadId}/client` names the last sequence it holds. The control plane announces the range it missed, replays exactly those events **a page of 100 at a time**, paced by how fast the client reads, and only then sends live traffic. A live client is sent each event only if it is the one after the last it was sent: one it already has is skipped, and one further on means it missed an event this control plane never broadcast (another instance recorded it, say), so it is **disconnected to replay rather than shown a gap**. A client claiming more than the log holds is replayed from sequence 1.

Every frame must fit the protocol's `maximumFrameLength`. A supervisor's event frames leave `threadEventEnvelopeAllowance` (1 KiB) for the envelope the control plane adds, and the control plane refuses to record an event whose frame to clients could not fit, since a recorded event that cannot be sent would break every replay.

## Protocol

The messages are defined once, as zod schemas in [`packages/protocol`](../packages/protocol), and validated wherever they cross a boundary. Both hops are WebSockets with one JSON message per frame; the thread and protocol version travel in the upgrade URL. The HTTP threads API is defined there too.

- **Thread events** are the durable history: the user's messages (recorded by the control plane the moment it accepts them), the agent's run starting and settling, each completed assistant message, and each tool execution starting and finishing. Every `agent_run_started` is followed by exactly one `agent_run_settled` or `agent_failed`.
- **Stream fragments** are pieces of assistant text sent while the model produces it: relayed live, never stored, and superseded by the completed message.

| Connection                 | Direction                  | Messages                                                                                                   |
| -------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Supervisor ⇄ control plane | Supervisor → control plane | An agent event; a stream fragment                                                                          |
|                            | Control plane → supervisor | Deliver a user message; interrupt the agent                                                                |
| Client ⇄ control plane     | Client → control plane     | Send a user message; interrupt the agent                                                                   |
|                            | Control plane → client     | Replay announcement; a recorded thread event; a stream fragment; supervisor connection status; a rejection |

## One prompt, end to end

What happens, in the code as built, when a user types a message in a thread's page and the agent replies.

1. **Web page.** The message box ([`components/message-composer.tsx`](../apps/web/src/components/message-composer.tsx)) hands the text to the thread's connection ([`connection/thread-connection.ts`](../apps/web/src/connection/thread-connection.ts)), which sends `send_user_message` on its WebSocket to `/threads/{threadId}/client`. In development, Vite's proxy forwards it to the control plane.
2. **Control plane, in.** The upgrade router ([`websocket/route-upgrade.ts`](../apps/control-plane/src/websocket/route-upgrade.ts)) accepted this connection in [`websocket/client-endpoint.ts`](../apps/control-plane/src/websocket/client-endpoint.ts) after checking its origin and that the thread exists. Every frame is validated ([`websocket/receive-messages.ts`](../apps/control-plane/src/websocket/receive-messages.ts)) and handed to the thread's relay ([`thread-relay/thread-relay.ts`](../apps/control-plane/src/thread-relay/thread-relay.ts)), which handles one message at a time.
3. **Recorded, then delivered.** The relay appends a `user_message` event to the thread event log ([`postgres-thread-event-log.ts`](../apps/control-plane/src/thread-event-log/postgres-thread-event-log.ts)), broadcasts it to every client watching, and only then sends `deliver_user_message` to the thread's supervisor, so the agent never acts on a message missing from history.
4. **Supervisor.** The supervisor's outbound connection ([`control-plane/control-plane-connection.ts`](../apps/sandbox-supervisor/src/control-plane/control-plane-connection.ts)) validates the message and passes it to [`supervisor.ts`](../apps/sandbox-supervisor/src/supervisor.ts) and on to the Pi harness ([`pi/pi-agent-harness.ts`](../apps/sandbox-supervisor/src/pi/pi-agent-harness.ts)), which writes it to Pi's standard input as a steering `prompt` ([`pi/pi-rpc-client.ts`](../apps/sandbox-supervisor/src/pi/pi-rpc-client.ts)). Pi runs as a child process, as the agent's user where the sandbox has one ([`agent-process/`](../apps/sandbox-supervisor/src/agent-process)).
5. **Agent output, translated.** Pi answers with JSON lines. Each is parsed ([`pi/pi-records.ts`](../apps/sandbox-supervisor/src/pi/pi-records.ts)) and translated into Barrack's vocabulary ([`pi/pi-event-translator.ts`](../apps/sandbox-supervisor/src/pi/pi-event-translator.ts)): text deltas become stream fragments; the run starting, each completed message, each tool execution and the run settling become agent events. The supervisor fits each in a frame, checks it against the protocol and sends it, holding agent events in a bounded backlog while the control plane is unreachable.
6. **Control plane, out.** The relay passes stream fragments straight to clients, keeping the current message's text so far ([`thread-relay/in-progress-assistant-text.ts`](../apps/control-plane/src/thread-relay/in-progress-assistant-text.ts)) for clients that join mid-message. It records each agent event and then broadcasts it.
7. **Web page, rendered.** The connection validates each message and dispatches it to the thread's store; the pure reducer ([`thread-state/thread-state.ts`](../apps/web/src/thread-state/thread-state.ts)) appends fragments to a streaming entry, replaces it with the completed message, and ignores any sequence it has already applied. React re-renders from that state.

The end-to-end tests in [`tests/end-to-end`](../tests/end-to-end) create threads through the API and run steps 2 to 6 with the real processes: with the fake agent and local-process sandboxes in `pnpm test`, and in Docker sandboxes, with the real Pi against a mock model, in `pnpm test:docker`.
