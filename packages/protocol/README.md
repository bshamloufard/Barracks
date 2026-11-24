# @barrack/protocol

Every message and HTTP request that crosses a boundary between Barrack's parts, defined once as [zod](https://zod.dev) schemas: between a sandbox's supervisor and the control plane, between a client and the control plane, and on the desktop's connections. The control plane, the supervisor and the web client all import it, and each validates what it receives with these schemas before acting on it. How the messages fit together is in the [architecture](../../docs/architecture.md#protocol).

The protocol is at version 6. [`src/protocol-version.ts`](src/protocol-version.ts) says what each version added; raise it whenever a message changes in a way an older peer could not understand, since a sandbox can outlive a control plane release and the control plane refuses a peer that speaks another version.

## Main files

| File                                                                                                                                                                                 | What it defines                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [`supervisor-messages.ts`](src/supervisor-messages.ts), [`workspace-messages.ts`](src/workspace-messages.ts)                                                                         | The supervisor's connection: hello and welcome, numbered events and their acknowledgement, user messages, the workspace |
| [`client-messages.ts`](src/client-messages.ts)                                                                                                                                       | A client's connection, and the order of what it is sent after it authenticates                                          |
| [`desktop-messages.ts`](src/desktop-messages.ts)                                                                                                                                     | The desktop viewer's connection and the stream a supervisor dials                                                       |
| [`thread-events.ts`](src/thread-events.ts), [`agent-events.ts`](src/agent-events.ts), [`repository-events.ts`](src/repository-events.ts)                                             | The durable history: user messages, the agent's runs, messages and tools, and the repository's clone and publications   |
| [`stream-fragments.ts`](src/stream-fragments.ts)                                                                                                                                     | Pieces of text relayed live and never stored                                                                            |
| [`endpoints.ts`](src/endpoints.ts), [`close-codes.ts`](src/close-codes.ts)                                                                                                           | The WebSocket URLs, and why the control plane closes a connection                                                       |
| [`limits.ts`](src/limits.ts)                                                                                                                                                         | The largest frame, and the other bounds on what a sandbox may send                                                      |
| [`threads-api.ts`](src/threads-api.ts), [`github-connection-api.ts`](src/github-connection-api.ts), [`model-access.ts`](src/model-access.ts), [`model-usage.ts`](src/model-usage.ts) | The HTTP API                                                                                                            |
| [`index.ts`](src/index.ts)                                                                                                                                                           | What the package exports                                                                                                |

## Building and testing

Run from the repository root. `pnpm build:packages` compiles it to `dist/`, which the other packages import; `pnpm test` and `pnpm typecheck` do that first. Its tests (`src/*.test.ts`) check what each schema accepts and refuses, and run with `pnpm test`.
