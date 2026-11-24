# Architecture

> **Built so far (Milestone 1):** the control plane, a sandbox supervisor running Pi or a fake agent, and a bare web client, all on one machine, with history kept in memory. **Not built yet:** the data store, sign-in, cloud sandboxes and their providers, the thread list and the desktop view. Sections that describe the intended design say so. Update this document as code lands, so that it always matches what the code actually does.

## The four parts

| Part             | What it does                                                                                         | Where it runs                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Clients          | Thread list, conversation view, live desktop view                                                    | Browser first; iPhone and Mac apps later        |
| Control plane    | Authenticates users, creates and stops sandboxes, relays messages in both directions, stores history | An always-on hosted service                     |
| Data store       | Users, threads, and the ordered record of everything each agent did                                  | Managed Postgres                                |
| Thread sandboxes | One isolated Linux computer per thread, holding the agent, the workspace and a graphical desktop     | A sandbox provider, behind a swappable boundary |

Clients are thin: all state lives on the server, so any client that can make web requests and hold a live connection can take part.

The control plane never sleeps. Sandboxes do: they start when a thread has work and stop when it is idle, because idle sandboxes still cost money.

Today the clients are one web page per thread ([`apps/web`](../apps/web)), the control plane ([`apps/control-plane`](../apps/control-plane)) keeps history in memory instead of a data store, and the sandbox is the developer's own machine, where the supervisor ([`apps/sandbox-supervisor`](../apps/sandbox-supervisor)) runs as an ordinary process. The rest of the table is intended.

## Two core design ideas

### The sandbox connects outward to the control plane

A small supervisor process inside each sandbox starts the agent and opens a connection back to the control plane. The control plane never reaches into the sandbox. A sandbox therefore needs no inbound networking, so a hosted provider, a rented server, or a developer's own laptop can all host one in the same way. This is what makes sandbox providers swappable in practice.

### Every event is recorded in order before it is shown

The control plane stores each agent event with its position in the thread's sequence, and only then forwards it to whoever is watching. A client that reconnects says where it left off and receives everything it missed. This one mechanism gives the full history, viewing from several devices at once, and the ability to close a laptop and pick the thread up on a phone.

## Protocol

The messages exchanged between clients, the control plane and sandbox supervisors are defined once, as zod schemas in [`packages/protocol`](../packages/protocol), and validated wherever they cross a boundary. The schemas are the reference for every field; this section explains how the pieces fit.

Both hops are WebSockets carrying one JSON message per frame. Which thread a connection belongs to, and the protocol version the peer speaks, travel in the URL of the upgrade request (`/threads/{threadId}/supervisor` and `/threads/{threadId}/client`), so no message repeats them.

### Thread events and stream fragments

What the agent does reaches the rest of the system in Barrack's own vocabulary. The supervisor translates the Pi agent's events into it, so nothing outside the supervisor depends on Pi. That vocabulary has two classes:

- **Thread events** are the durable history: the user's messages, the agent starting and settling, each completed assistant message, and each tool execution starting and finishing. The control plane stores each one with its **sequence**, which is 1 for a thread's first event and one more for each later event, with no gaps, and only then forwards it. The user's own messages are recorded by the control plane the moment it accepts them; the agent never emits them.
- **Stream fragments** are pieces of assistant text sent while the model is still producing it. They are relayed live, never stored or sequenced, and may be dropped. The completed assistant message that follows is the record and supersedes them.

The agent's run ends with a single `agent_run_settled` event, which means the agent has finished and has nothing queued. Thread status keys off that event alone. Model provider failures, such as a rejected key or an exhausted quota, end an assistant message with an error; `agent_failed` is reserved for the agent process itself breaking.

### Reconnecting

A client opens one connection per thread it is viewing and says, in the URL, the last sequence it already holds (0 for none). The control plane first sends a replay announcement naming the inclusive range of sequences the client missed, possibly empty, then exactly those events in order, and only then live traffic. The client can therefore tell catching up from watching live, and a reconnect never loses or repeats a thread event. If the client claims a sequence the control plane does not hold (its in-memory history was lost in a restart), the control plane replays the thread from sequence 1, and a client sent an announcement that starts at or before its last seen sequence discards everything it holds and rebuilds from the replay.

### Message families

| Connection                 | Direction                  | Messages                                                                                                   |
| -------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Supervisor ⇄ control plane | Supervisor → control plane | An agent event; a stream fragment                                                                          |
|                            | Control plane → supervisor | Deliver a user message; interrupt the agent                                                                |
| Client ⇄ control plane     | Client → control plane     | Send a user message; interrupt the agent                                                                   |
|                            | Control plane → client     | Replay announcement; a recorded thread event; a stream fragment; supervisor connection status; a rejection |

## One prompt, end to end

What happens, in the code as built, when a user types a message in the web page and the agent replies.

1. **Web page.** The message box ([`components/message-composer.tsx`](../apps/web/src/components/message-composer.tsx)) hands the text to the thread's connection ([`connection/thread-connection.ts`](../apps/web/src/connection/thread-connection.ts)), which sends `send_user_message` on the page's WebSocket to `/threads/{threadId}/client`. In development, Vite's proxy forwards it to the control plane.
2. **Control plane, in.** The upgrade router ([`websocket/route-upgrade.ts`](../apps/control-plane/src/websocket/route-upgrade.ts)) accepted this connection in [`websocket/client-endpoint.ts`](../apps/control-plane/src/websocket/client-endpoint.ts) after checking its origin. Every frame is validated against the protocol ([`websocket/receive-messages.ts`](../apps/control-plane/src/websocket/receive-messages.ts)) and handed to the thread's relay ([`thread-relay/thread-relay.ts`](../apps/control-plane/src/thread-relay/thread-relay.ts)), which handles one message at a time.
3. **Recorded, then delivered.** The relay appends a `user_message` event to the thread event log ([`thread-event-log/in-memory-thread-event-log.ts`](../apps/control-plane/src/thread-event-log/in-memory-thread-event-log.ts)), which assigns its sequence, broadcasts it to every client watching, and only then sends `deliver_user_message` to the thread's supervisor.
4. **Supervisor.** The supervisor's outbound connection ([`control-plane/control-plane-connection.ts`](../apps/sandbox-supervisor/src/control-plane/control-plane-connection.ts)) validates the message and passes it to [`supervisor.ts`](../apps/sandbox-supervisor/src/supervisor.ts), which gives it to the agent harness. The Pi harness ([`pi/pi-agent-harness.ts`](../apps/sandbox-supervisor/src/pi/pi-agent-harness.ts)) writes it to Pi's standard input as a steering `prompt` through its JSONL client ([`pi/pi-rpc-client.ts`](../apps/sandbox-supervisor/src/pi/pi-rpc-client.ts)); Pi runs as a child process ([`pi/pi-process.ts`](../apps/sandbox-supervisor/src/pi/pi-process.ts)).
5. **Agent output, translated.** Pi answers with JSON lines on its standard output. Each is parsed ([`pi/pi-records.ts`](../apps/sandbox-supervisor/src/pi/pi-records.ts)) and translated into Barrack's vocabulary ([`pi/pi-event-translator.ts`](../apps/sandbox-supervisor/src/pi/pi-event-translator.ts)): text deltas become stream fragments, and the run starting, each completed assistant message, each tool execution and the run settling become agent events. The supervisor checks each against the protocol and sends it, holding agent events in a bounded backlog while the control plane is unreachable.
6. **Control plane, out.** The relay passes stream fragments straight to clients, keeping the text so far ([`thread-relay/in-progress-assistant-text.ts`](../apps/control-plane/src/thread-relay/in-progress-assistant-text.ts)) for clients that join mid-message. It records each agent event in the log and then broadcasts it.
7. **Web page, rendered.** The connection validates each message and dispatches it to the thread's store; the pure reducer ([`thread-state/thread-state.ts`](../apps/web/src/thread-state/thread-state.ts)) appends fragments to a streaming entry, replaces it with the completed message when that is recorded, and ignores any sequence it has already applied. React re-renders the conversation from that state.

The end-to-end tests in [`tests/end-to-end`](../tests/end-to-end) run steps 2 to 6 with the real processes and the fake agent.
