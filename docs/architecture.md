# Architecture

> This describes the **intended** design. Most of it is not built yet. Update this document as code lands, so that it always matches what the code actually does.

## The four parts

| Part             | What it does                                                                                         | Where it runs                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Clients          | Thread list, conversation view, live desktop view                                                    | Browser first; iPhone and Mac apps later        |
| Control plane    | Authenticates users, creates and stops sandboxes, relays messages in both directions, stores history | An always-on hosted service                     |
| Data store       | Users, threads, and the ordered record of everything each agent did                                  | Managed Postgres                                |
| Thread sandboxes | One isolated Linux computer per thread, holding the agent, the workspace and a graphical desktop     | A sandbox provider, behind a swappable boundary |

Clients are thin: all state lives on the server, so any client that can make web requests and hold a live connection can take part.

The control plane never sleeps. Sandboxes do: they start when a thread has work and stop when it is idle, because idle sandboxes still cost money.

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

A client opens one connection per thread it is viewing and says, in the URL, the last sequence it already holds (0 for none). The control plane first sends a replay announcement naming the inclusive range of sequences the client missed, possibly empty, then exactly those events in order, and only then live traffic. The client can therefore tell catching up from watching live, and a reconnect never loses or repeats a thread event.

### Message families

| Connection                 | Direction                  | Messages                                                                                                   |
| -------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Supervisor ⇄ control plane | Supervisor → control plane | An agent event; a stream fragment                                                                          |
|                            | Control plane → supervisor | Deliver a user message; interrupt the agent                                                                |
| Client ⇄ control plane     | Client → control plane     | Send a user message; interrupt the agent                                                                   |
|                            | Control plane → client     | Replay announcement; a recorded thread event; a stream fragment; supervisor connection status; a rejection |
