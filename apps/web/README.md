# @barrack/web

The Barrack web client. It has two pages:

- **The thread list** (`/`): every thread, newest first, with when it was created and whether its sandbox is starting, ready or failed, and a **New thread** button that asks the control plane to create a thread (and its sandbox) and opens it.
- **A thread** (`/?thread={threadId}`): connects to the control plane, shows the conversation as it streams in, and lets you send the agent messages and interrupt it. Until the agent first connects it says the thread is starting its sandbox; if the sandbox could not be created it shows the reason. Closing the tab, losing the network or reloading the page loses nothing: on reconnect it tells the control plane the last event it holds and is sent exactly what it missed.

It is deliberately bare: React and a small hand-written stylesheet, no UI framework, no router and no sign-in yet.

## How it is organised

| Path                  | What it holds                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/page-address.ts` | Which page the address shows, and the address of each. Tested.                                                   |
| `src/api/`            | The threads HTTP API: list, fetch and create threads, each answer checked against the protocol.                  |
| `src/thread-list/`    | The thread list page's pure reducer (tested) and the hook that loads the list and creates threads.               |
| `src/thread-state/`   | The pure reducer that is the only code changing what a thread's page shows, and a small store around it. Tested. |
| `src/connection/`     | The thread's WebSocket (validation of every message, reconnecting with capped backoff), and polling its record.  |
| `src/use-thread.ts`   | Follows a thread's record and, once it exists, its live connection, for as long as a component is mounted.       |
| `src/components/`     | The pages: thread list, status line, conversation, tool execution rows, message box.                             |
| `src/presentation/`   | Small pure helpers that turn protocol values and state into what the user reads. Tested.                         |

**How the page learns that a sandbox failed.** The thread's record (`GET /api/threads/{threadId}`) carries its sandbox's state. The thread page fetches it when it opens and again every second while the sandbox is being created, and stops once it is ready or failed; a failure's reason comes with it. Whether the agent is reachable right now comes, as before, from the thread's WebSocket.

## Configuration

| Setting                            | Default | Meaning                                                                                                     |
| ---------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `BARRACK_CONTROL_PLANE_PORT` (dev) | `8787`  | Where the Vite dev server forwards `/api/…`, `/threads/…` WebSockets and `/health` (always on `127.0.0.1`). |

The page always talks to the control plane at its own origin: through Vite's proxy in development, or directly when the control plane serves the built page. The control plane only accepts origins on its allow list, which by default covers `http://localhost:5173` and `http://127.0.0.1:5173`.

## Running it

`pnpm dev` at the repository root runs it with a control plane. To run it on its own against a control plane that is already running (see [its README](../control-plane/README.md)), from the repository root:

```sh
pnpm --filter @barrack/web dev
```

and open <http://localhost:5173/>.

To build the static files the control plane serves in production:

```sh
pnpm build   # writes apps/web/dist
```
