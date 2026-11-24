# Architecture

> **Built so far:** Milestone 1, and Milestone 2's parts, tested locally: a web client with a thread list, a control plane that creates each thread and its sandbox, sandbox providers for Docker, Daytona and local development, a sandbox image in which the agent runs as its own user, thread history in Postgres, and acknowledged delivery between supervisor and control plane that survives either being killed. From Milestone 3: sign-in with Supabase Auth, verified by the control plane, and every thread belonging to one user. **Not built yet:** any deployment, the control plane stopping, resuming or reconciling sandboxes, per-user model access and the desktop view. Daytona and Supabase have never been run against. Sections that describe intended design say so. Update this document as code lands, so that it always matches what the code does.

## The four parts

| Part             | What it does                                                                               | Built today                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Clients          | Thread list, conversation view, live desktop view                                          | One web page ([`apps/web`](../apps/web)) with the list and the conversation                                   |
| Control plane    | Authenticates users, creates and stops sandboxes, relays messages both ways, keeps history | [`apps/control-plane`](../apps/control-plane): signs users in, creates threads and sandboxes, relays, records |
| Data store       | Users, threads, and the ordered record of everything each agent did                        | Postgres (users, threads and their events), or memory for development                                         |
| Thread sandboxes | One isolated Linux computer per thread: the agent, its workspace, a graphical desktop      | A container from [`sandbox-image`](../sandbox-image), through a provider; no desktop yet                      |

Clients are thin: all state lives on the server. The control plane never sleeps; sandboxes are meant to stop when idle, though nothing stops them yet.

## Two core design ideas

**The sandbox connects outward.** A small supervisor process inside each sandbox ([`apps/sandbox-supervisor`](../apps/sandbox-supervisor)) starts the agent and opens a WebSocket back to the control plane. The control plane never reaches into a sandbox, so a sandbox needs no inbound networking, and any provider, rented server or laptop can host one the same way.

**Every event is recorded in order before it is shown.** The control plane stores each event with its position in the thread's sequence and only then forwards it. A client that reconnects says where it left off and receives everything it missed: full history, several devices at once, and closing a laptop to pick the thread up on a phone.

## Signing in, and who sees what

A user signs in with **Supabase Auth**, by a six-digit code sent by email, in the web client through supabase-js. The client learns where to sign in from the control plane (`GET /api/client-configuration`, the one API route that needs no token), so one build of the client serves any installation. Supabase hands the client an access token, a JWT that supabase-js refreshes before it expires.

The **control plane verifies every token itself** ([`authentication/`](../apps/control-plane/src/authentication)): its signature against the project's published public keys (fetched and cached with jose, and fetched again for a key it has not seen, which is how a rotated key is picked up), the issuer, the audience `authenticated`, an asymmetric algorithm, the expiry with 30 seconds' tolerance, `role: authenticated` and not anonymous. The user is the token's `sub`. An installation admits only the email addresses it lists (`BARRACK_ALLOWED_USER_EMAILS`), confirmed by asking Supabase, unless it says `anyone-who-can-sign-in`. A user is recorded on their first authenticated request, and every thread records its owner.

**A user sees and controls only their own threads**, and another user's thread is answered exactly as one that does not exist. This is enforced once per transport:

- **HTTP:** a middleware on all of `/api/*`, mounted before any route, requires `Authorization: Bearer <access token>` except on the listed public paths ([`http/require-signed-in-user.ts`](../apps/control-plane/src/http/require-signed-in-user.ts)). Routes learn the user only from it, and the thread store has no way to list or find a thread for a user without the owner's identifier. A test requests every registered route without a token.
- **Client WebSocket:** browsers cannot put headers on a WebSocket, and a URL ends up in logs, so the token is the **first message**. After the upgrade (whose `Origin`, when sent, must be allowed) the connection's session ([`websocket/client-session.ts`](../apps/control-plane/src/websocket/client-session.ts)) accepts only an `authenticate` message within 5 seconds, verifies it, checks that the user owns the thread, and only then attaches the client to the thread's relay, which demands a `ThreadAccess` that only that check can produce. The client sends each refreshed token on the open connection, which must name the same user; when the newest expires without a replacement, the connection closes with `accessTokenExpired`, and the client refreshes and reconnects from its last seen sequence.

The supervisor endpoint is unchanged: a sandbox proves itself with its thread's token, not a user's.

For local work, an explicit **development mode** (`BARRACK_AUTHENTICATION=development-single-user`, which `pnpm dev` sets) has one fixed user whose token the control plane hands to any client. It is refused unless the control plane listens on a loopback address; with Supabase it may listen anywhere.

## Creating a thread

1. The thread list's **New thread** sends `POST /api/threads` with the user's access token ([`http/threads-routes.ts`](../apps/control-plane/src/http/threads-routes.ts)).
2. The control plane mints a thread identifier and a **supervisor token for that thread alone** (32 random bytes), records the thread with its owner, the token's SHA-256 digest and its sandbox `creating`, and answers at once ([`threads/thread-creator.ts`](../apps/control-plane/src/threads/thread-creator.ts)). The token itself is never stored, logged or returned.
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

A client connecting to `/threads/{threadId}/client` names the last sequence it holds. Once it has authenticated and been found to own the thread, the control plane announces the range it missed, replays exactly those events **a page of 100 at a time**, paced by how fast the client reads, then sends whether the supervisor is connected, how far user messages have been delivered, and the text streamed so far of a message in progress, and only then live traffic (the order is specified in [`client-messages.ts`](../packages/protocol/src/client-messages.ts)). A live client is sent each event only if it is the one after the last it was sent: one it already has is skipped, and one further on means it missed an event this control plane never broadcast (another instance recorded it, say), so it is **disconnected to replay rather than shown a gap**. A client claiming more than the log holds is replayed from sequence 1.

## Acknowledged delivery

Between a supervisor and the control plane nothing durable is lost to a dying connection, half-open or not, or to either side being killed; the handshake is specified in [`supervisor-messages.ts`](../packages/protocol/src/supervisor-messages.ts).

- **Each connection starts with a handshake.** The supervisor's `supervisor_hello` names its **instance** (a fresh identifier each time its process starts) and how far the agent has been handed user messages. The control plane answers `supervisor_welcome` with the last of that instance's events it has recorded.
- **Agent events, exactly once and in order.** Each is numbered within its instance and kept in the supervisor's memory until `agent_events_recorded` confirms it durable; everything unconfirmed is sent again after each welcome. The event log stores an event once per instance and number, enforced by a unique index inside the append statement, so a resend or two overlapping control planes never record one twice, and a duplicate leaves no gap. An event whose append failed is sent again when the supervisor reconnects. The control plane refuses an event that skips a number.
- **User messages, exactly once and in order.** A message is recorded whether or not a supervisor is connected; clients are told how far messages have been delivered (`user_message_delivery_status`) and show the rest as waiting. On every welcome the control plane sends each recorded message after the furthest delivery known, its own record or the supervisor's claim, and then each new one as it is recorded, with its sequence. The supervisor writes the position to its own state directory before handing a message to the agent, ignores anything at or before it, and acknowledges with `user_messages_delivered`.
- **Runs that cannot end are closed.** The event log remembers which instance opened the run still open. A supervisor that reconnects as the same instance finishes its own run, however long it was away; one that attaches as a new instance means the old process, and whatever it had not had confirmed, is gone, so the control plane records `agent_failed` saying so, and clients stop showing the agent working.
- **What can still be lost.** Unconfirmed events are in memory only: if the supervisor process dies, those die with it (normally milliseconds' worth; during a control plane outage, everything since it began). If it dies between noting a message and handing it over, that message is lost rather than repeated. If too many events wait unconfirmed (32 Mi characters), the supervisor exits rather than drop one. Interrupts are sent at most once and never stored. Stream fragments are best-effort.
- **Everything the supervisor claims is checked**: a delivery position beyond the thread's history, an event number that skips one, an acknowledgement of a message never sent, or anything before the hello closes the connection as invalid.

Every frame must fit the protocol's `maximumFrameLength`. A supervisor's event frames leave `threadEventEnvelopeAllowance` (1 KiB) for the envelope the control plane adds, and the control plane refuses to record an event whose frame to clients could not fit, since a recorded event that cannot be sent would break every replay.

## Protocol

The messages are defined once, as zod schemas in [`packages/protocol`](../packages/protocol), and validated wherever they cross a boundary. Both hops are WebSockets with one JSON message per frame; the thread and protocol version travel in the upgrade URL. The HTTP threads API is defined there too.

- **Thread events** are the durable history: the user's messages (recorded by the control plane the moment it accepts them), the agent's run starting and settling, each completed assistant message, and each tool execution starting and finishing. Every `agent_run_started` is followed by exactly one `agent_run_settled` or `agent_failed`.
- **Stream fragments** are pieces of assistant text sent while the model produces it: relayed live, never stored, and superseded by the completed message.

| Connection                 | Direction                  | Messages                                                                                                                                 |
| -------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Supervisor ⇄ control plane | Supervisor → control plane | Hello; a numbered agent event; a stream fragment; user messages delivered                                                                |
|                            | Control plane → supervisor | Welcome; agent events recorded; deliver a user message; interrupt the agent                                                              |
| Client ⇄ control plane     | Client → control plane     | Authenticate (first, and again with each refreshed token); send a user message; interrupt the agent                                      |
|                            | Control plane → client     | Replay announcement; a recorded thread event; a stream fragment; supervisor connection status; user message delivery status; a rejection |

## One prompt, end to end

What happens, in the code as built, when a user types a message in a thread's page and the agent replies.

1. **Web page.** The message box ([`components/message-composer.tsx`](../apps/web/src/components/message-composer.tsx)) hands the text to the thread's connection ([`connection/thread-connection.ts`](../apps/web/src/connection/thread-connection.ts)), which sends `send_user_message` on its WebSocket to `/threads/{threadId}/client`. In development, Vite's proxy forwards it to the control plane.
2. **Control plane, in.** The upgrade router ([`websocket/route-upgrade.ts`](../apps/control-plane/src/websocket/route-upgrade.ts)) accepted this connection in [`websocket/client-endpoint.ts`](../apps/control-plane/src/websocket/client-endpoint.ts) after checking its origin, and its session attached it to the thread once its first message authenticated a user who owns the thread. Every frame is validated ([`websocket/receive-messages.ts`](../apps/control-plane/src/websocket/receive-messages.ts)) and handed to the thread's relay ([`thread-relay/thread-relay.ts`](../apps/control-plane/src/thread-relay/thread-relay.ts)), which handles one message at a time.
3. **Recorded, then delivered.** The relay appends a `user_message` event to the thread event log ([`postgres-thread-event-log.ts`](../apps/control-plane/src/thread-event-log/postgres-thread-event-log.ts)), broadcasts it to every client watching, and only then sends `deliver_user_message`, with the message's sequence, to the thread's supervisor, so the agent never acts on a message missing from history. With no supervisor attached the message waits in history until one is.
4. **Supervisor.** The supervisor's outbound connection ([`control-plane/control-plane-connection.ts`](../apps/sandbox-supervisor/src/control-plane/control-plane-connection.ts)) validates the message and passes it to [`supervisor.ts`](../apps/sandbox-supervisor/src/supervisor.ts), which notes its sequence on disk ([`delivery/delivered-user-messages.ts`](../apps/sandbox-supervisor/src/delivery/delivered-user-messages.ts)), acknowledges it, and hands it to the Pi harness ([`pi/pi-agent-harness.ts`](../apps/sandbox-supervisor/src/pi/pi-agent-harness.ts)), which writes it to Pi's standard input as a steering `prompt` ([`pi/pi-rpc-client.ts`](../apps/sandbox-supervisor/src/pi/pi-rpc-client.ts)). Pi runs as a child process, as the agent's user where the sandbox has one ([`agent-process/`](../apps/sandbox-supervisor/src/agent-process)).
5. **Agent output, translated.** Pi answers with JSON lines. Each is parsed ([`pi/pi-records.ts`](../apps/sandbox-supervisor/src/pi/pi-records.ts)) and translated into Barrack's vocabulary ([`pi/pi-event-translator.ts`](../apps/sandbox-supervisor/src/pi/pi-event-translator.ts)): text deltas become stream fragments; the run starting, each completed message, each tool execution and the run settling become agent events. The supervisor fits each in a frame, checks it against the protocol, numbers each agent event and sends it, keeping it until the control plane confirms it recorded.
6. **Control plane, out.** The relay passes stream fragments straight to clients, keeping the current message's text so far ([`thread-relay/in-progress-assistant-text.ts`](../apps/control-plane/src/thread-relay/in-progress-assistant-text.ts)) for clients that join mid-message. It records each agent event, acknowledges it to the supervisor, and then broadcasts it.
7. **Web page, rendered.** The connection validates each message and dispatches it to the thread's store; the pure reducer ([`thread-state/thread-state.ts`](../apps/web/src/thread-state/thread-state.ts)) appends fragments to a streaming entry, replaces it with the completed message, and ignores any sequence it has already applied. React re-renders from that state.

The end-to-end tests in [`tests/end-to-end`](../tests/end-to-end) create threads through the API and run steps 2 to 6 with the real processes: with the fake agent and local-process sandboxes in `pnpm test` (including killing the control plane or the supervisor mid-run, in [`recovery.test.ts`](../tests/end-to-end/src/recovery.test.ts)), and in Docker sandboxes, with the real Pi against a mock model, in `pnpm test:docker`.
