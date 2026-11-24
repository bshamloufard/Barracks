# Sandbox supervisor

A small long-running Node process that lives inside a thread's sandbox (for Milestone 1, on the developer's machine). It:

1. starts the coding agent ([Pi](https://github.com/earendil-works/pi), or a scripted fake);
2. dials **out** to the control plane over a WebSocket, so the sandbox needs no inbound networking;
3. translates what the agent does into Barrack's protocol (`@barrack/protocol`) and sends it;
4. carries out what the control plane asks: deliver a user message, interrupt the agent.

## Configuration

Everything comes from environment variables, checked at startup. Every problem is listed at once, and values are never echoed.

| Variable                      | Required | Meaning                                                                                       |
| ----------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `BARRACK_CONTROL_PLANE_URL`   | yes      | WebSocket base URL of the control plane, e.g. `ws://127.0.0.1:8787`                           |
| `BARRACK_THREAD_ID`           | yes      | The thread this sandbox belongs to                                                            |
| `BARRACK_SUPERVISOR_TOKEN`    | yes      | Sent as `Authorization: Bearer …`. Never logged and never passed to the agent                 |
| `BARRACK_AGENT_HARNESS`       | no       | `pi` (default) or `fake`                                                                      |
| `BARRACK_MODEL`               | for `pi` | Pi's `provider/model` form, e.g. `anthropic/<model-id>`                                       |
| `BARRACK_WORKSPACE_DIRECTORY` | for `pi` | The agent's working directory                                                                 |
| `BARRACK_STATE_DIRECTORY`     | for `pi` | Pi's sessions (`pi/sessions`) and agent directory (`pi/agent`: credentials, settings, models) |
| `BARRACK_LOG_LEVEL`           | no       | `debug`, `info` (default), `warn` or `error`                                                  |

Pi gets an environment built from an allowlist (see [`src/pi/pi-environment.ts`](src/pi/pi-environment.ts)): basics such as `PATH` and `HOME`, proxy settings, every `PI_*` variable, and model provider keys such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Ambient cloud credentials (`AWS_*`, `GOOGLE_*`) are deliberately not passed.

## Running it

Build first (from the repository root): `pnpm install && pnpm build`.

**With the fake agent** (no model, no API key):

```sh
BARRACK_CONTROL_PLANE_URL=ws://127.0.0.1:8787 \
BARRACK_THREAD_ID=<thread id> \
BARRACK_SUPERVISOR_TOKEN=<supervisor token> \
BARRACK_AGENT_HARNESS=fake \
node apps/sandbox-supervisor/dist/main.js
```

The fake agent quotes each message back word by word. A message containing `[tool]` makes it call a tool first; one containing `[fail]` makes it fail as if its process had crashed.

**With Pi** (needs a model provider key):

```sh
ANTHROPIC_API_KEY=<key> \
BARRACK_CONTROL_PLANE_URL=ws://127.0.0.1:8787 \
BARRACK_THREAD_ID=<thread id> \
BARRACK_SUPERVISOR_TOKEN=<supervisor token> \
BARRACK_MODEL=anthropic/<model-id> \
BARRACK_WORKSPACE_DIRECTORY=/path/to/a/checkout \
BARRACK_STATE_DIRECTORY=$HOME/.barrack/thread-state \
node apps/sandbox-supervisor/dist/main.js
```

`pnpm --filter @barrack/sandbox-supervisor exec pi --list-models <search>` lists the model identifiers Pi knows. Pi runs with full access to whatever its process can reach; on a developer machine, point it at a workspace you are happy for it to change.

`pnpm --filter @barrack/sandbox-supervisor start` runs the same entry point with the variables from your shell.

## How it behaves

- **Pi** runs as a child process in RPC mode, driven by our own JSONL client ([`src/pi`](src/pi)). Readiness is the answer to `get_state`. User messages are sent one at a time as `prompt` with `streamingBehavior: "steer"`, so a busy agent takes them up after its current turn. A message Pi refuses is reported as an errored assistant message. An interrupt is `clear_queue` then `abort`.
- **Translation** ([`src/pi/pi-event-translator.ts`](src/pi/pi-event-translator.ts)) is pure. A run starts at the first `agent_start` after idle and settles only on Pi's `agent_settled`. User and tool result messages are not forwarded. Tool output over 64 Ki characters keeps its first quarter and last three quarters, where errors and summaries appear.
- **Crashes**: if Pi exits unexpectedly the supervisor sends `agent_failed` and starts Pi again on the next user message, reopening the same session file so the conversation continues.
- **Stopping**: on `SIGINT` or `SIGTERM` the supervisor closes Pi's stdin (a signal would cut off Pi's last events), waits, escalates to signals if needed, then closes the socket.
- **Connection**: reconnects with capped, jittered exponential backoff (up to about 15 s). During an outage agent events wait in a bounded backlog and are sent in order on reconnect; stream fragments are dropped. If the backlog fills, the supervisor exits with an error rather than lose history. It exits without reconnecting when the control plane refuses the upgrade with a 4xx status that retrying cannot change (every one but `408` and `429`: wrong credentials, an unsupported protocol version, an unknown endpoint) or closes with `supersededByNewerSupervisor`; `5xx` answers and network errors are retried. Its own pings detect a dead connection. Events in flight when a connection drops can still be lost: acknowledged delivery is Milestone 2.
- **Logs**: one JSON object per line on stdout ([pino](https://getpino.io)), each tagged with the thread.

## Tests

`pnpm test` from the root runs them all. The Pi integration test ([`src/pi/pi-agent-harness.integration.test.ts`](src/pi/pi-agent-harness.integration.test.ts)) runs the pinned Pi against a mock model server on `127.0.0.1`, with no network and no API key.
