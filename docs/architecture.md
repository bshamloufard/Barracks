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

## Shared protocol

The messages exchanged between clients, the control plane and sandbox supervisors are defined once, in [`packages/protocol`](../packages/protocol), and validated at runtime wherever they cross a boundary.
