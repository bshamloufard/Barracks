# @barrack/control-plane

The service between thread sandboxes and clients. Each thread's sandbox supervisor connects to it over a WebSocket, and so does each client viewing the thread. The control plane records every agent event in the thread's ordered history before showing it to anyone, relays streamed text live, and passes the user's messages and interrupts to the supervisor.

> **Do not expose this build to a network.** Clients are not authenticated until Milestone 3: anyone who can reach the port can read every thread and send messages to its agent. It listens only on `127.0.0.1` by default, and checks the `Origin` header so that other websites open in your browser cannot connect. Keep it that way.

This is the Milestone 1 build: history is kept in memory and lost when the process stops.

## How it is organised

| Path                          | What it holds                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                 | Reads configuration, starts the server, shuts down on SIGINT or SIGTERM.                                               |
| `src/configuration.ts`        | Environment variables, validated together at startup.                                                                  |
| `src/control-plane-server.ts` | One HTTP server on one port: HTTP routes plus both WebSocket endpoints.                                                |
| `src/http-app.ts`             | `GET /health`, and the built web client when configured (Hono).                                                        |
| `src/thread-event-log/`       | The `ThreadEventLog` interface, which assigns sequences, and its in-memory implementation.                             |
| `src/thread-relay/`           | `ThreadRelay`: per-thread ordering of recording, broadcasting, replay and in-progress text. No sockets in here.        |
| `src/websocket/`              | Upgrade routing, supervisor authorisation, origin check, frame validation, heartbeats and slow-client handling (`ws`). |
| `src/test-support/`           | Fake peers and fake connections, a pausable event log, the log contract suite. Not part of the build.                  |

The endpoints and messages are defined in [`@barrack/protocol`](../../packages/protocol); see [docs/architecture.md](../../docs/architecture.md) for how they fit together.

## Configuration

| Variable                         | Default                                                                                   | Meaning                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `BARRACK_SUPERVISOR_TOKEN`       | none, required                                                                            | Shared secret every supervisor sends as `Authorization: Bearer <token>`. At least 32 characters. Never logged. |
| `BARRACK_CONTROL_PLANE_HOST`     | `127.0.0.1`                                                                               | Interface to listen on.                                                                                        |
| `BARRACK_CONTROL_PLANE_PORT`     | `8787`                                                                                    | Port for HTTP and both WebSocket endpoints.                                                                    |
| `BARRACK_ALLOWED_CLIENT_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:8787,http://127.0.0.1:8787` | Comma-separated browser origins allowed to open the client endpoint.                                           |
| `BARRACK_WEB_CLIENT_DIRECTORY`   | unset                                                                                     | Directory of the built web client (`apps/web/dist`). When set, the control plane serves it.                    |
| `BARRACK_LOG_LEVEL`              | `info`                                                                                    | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                                                |

If anything is wrong, the control plane refuses to start and lists every problem.

## Running it

From the repository root, after `pnpm install`:

```sh
export BARRACK_SUPERVISOR_TOKEN="$(openssl rand -hex 32)"

# Development: restarts on every change.
pnpm --filter @barrack/control-plane dev

# Built: compile once, then run, also serving the built web client.
pnpm build
BARRACK_WEB_CLIENT_DIRECTORY="$PWD/apps/web/dist" pnpm --filter @barrack/control-plane start
```

The built client is then at <http://127.0.0.1:8787/?thread=local>. `pnpm --filter` runs scripts inside `apps/control-plane`, so give `BARRACK_WEB_CLIENT_DIRECTORY` as an absolute path.

Logs are JSON lines on standard output. Every line about a thread carries its `threadId`; pipe through `pino-pretty` if you want them readable.

## Tests

`pnpm test` at the repository root runs them. They start a real control plane on an ephemeral port and drive it with real WebSocket connections from a fake supervisor and test clients.
