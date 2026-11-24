# @barrack/web

The Barrack web client for Milestone 1: one page showing one thread. It connects to the control plane, shows the conversation as it streams in, and lets you send the agent messages and interrupt it. Closing the tab, losing the network or restarting the page loses nothing: on reconnect it tells the control plane the last event it holds and is sent exactly what it missed.

It is deliberately bare: React and a small hand-written stylesheet, no UI framework, no thread list and no sign-in yet.

## How it is organised

| Path                | What it holds                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/thread-state/` | The pure reducer that is the only code changing what the page shows, and a small store around it. Tested. |
| `src/connection/`   | The WebSocket to the control plane: validation of every message, and reconnecting with capped backoff.    |
| `src/use-thread.ts` | Connects a component to a thread for as long as it is mounted.                                            |
| `src/components/`   | The page: status line, conversation, tool execution rows, message box.                                    |
| `src/presentation/` | Small pure helpers that turn protocol values into text. Tested.                                           |

## Configuration

| Setting                            | Default | Meaning                                                                                           |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `?thread=` in the page address     | `local` | Which thread to show: 1 to 64 letters, digits, `_` or `-`. Milestone 1 has no thread records.     |
| `BARRACK_CONTROL_PLANE_PORT` (dev) | `8787`  | Where the Vite dev server forwards `/threads/…` WebSockets and `/health` (always on `127.0.0.1`). |

The page always talks to the control plane at its own origin: through Vite's proxy in development, or directly when the control plane serves the built page. The control plane only accepts origins on its allow list, which by default covers `http://localhost:5173` and `http://127.0.0.1:5173`.

## Running it

Start the control plane first (see [its README](../control-plane/README.md)), then from the repository root:

```sh
pnpm --filter @barrack/web dev
```

and open <http://localhost:5173/?thread=local>. Messages can be sent once a sandbox supervisor is connected to the same thread.

To build the static files the control plane serves in production:

```sh
pnpm build   # writes apps/web/dist
```
