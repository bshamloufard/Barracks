# Sandbox supervisor

A small long-running Node process that lives inside a thread's sandbox: a container from the [sandbox image](../../sandbox-image), or under `pnpm dev` an ordinary process on the developer's machine. It:

1. starts the coding agent ([Pi](https://github.com/earendil-works/pi), or a scripted fake);
2. dials **out** to the control plane over a WebSocket, so the sandbox needs no inbound networking;
3. translates what the agent does into Barrack's protocol (`@barrack/protocol`) and sends it;
4. carries out what the control plane asks: deliver a user message (each exactly once), interrupt the agent.

## Configuration

Everything comes from environment variables, checked at startup. Every problem is listed at once, and values are never echoed. The control plane sets them when it creates the thread's sandbox (see [its README](../control-plane/README.md#threads-and-their-sandboxes)), and the sandbox image sets the directories and the agent's user.

| Variable                             | Required | Meaning                                                                                                 |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `BARRACK_CONTROL_PLANE_URL`          | yes      | WebSocket base URL of the control plane, e.g. `ws://127.0.0.1:8787`                                     |
| `BARRACK_THREAD_ID`                  | yes      | The thread this sandbox belongs to                                                                      |
| `BARRACK_SUPERVISOR_TOKEN`           | yes      | This thread's own token, sent as `Authorization: Bearer …`. Never logged; see below for who can read it |
| `BARRACK_SUPERVISOR_STATE_DIRECTORY` | yes      | What the supervisor keeps across its own restarts; only its user should be able to write here           |
| `BARRACK_AGENT_HARNESS`              | no       | `pi` (default) or `fake`                                                                                |
| `BARRACK_MODEL`                      | for `pi` | Pi's `provider/model` form, e.g. `anthropic/<model-id>`                                                 |
| `BARRACK_WORKSPACE_DIRECTORY`        | for `pi` | The agent's working directory                                                                           |
| `BARRACK_STATE_DIRECTORY`            | for `pi` | Pi's sessions (`pi/sessions`) and agent directory (`pi/agent`: credentials, settings, models)           |
| `BARRACK_AGENT_USER`                 | no       | The operating-system user Pi runs as; see below. Unset, Pi runs as the supervisor's own user            |
| `BARRACK_LOG_LEVEL`                  | no       | `debug`, `info` (default), `warn` or `error`                                                            |

Pi gets an environment built from an allowlist (see [`src/pi/pi-environment.ts`](src/pi/pi-environment.ts)): basics such as `PATH` and `HOME`, proxy settings, every `PI_*` variable, and model provider keys such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Ambient cloud credentials (`AWS_*`, `GOOGLE_*`) are deliberately not passed.

### Which user the agent runs as

Leaving the token out of Pi's environment stops it from turning up in something Pi prints or sends to the model by accident. Keeping it from a determined agent takes a different operating-system user, because Linux shows a process's environment (`/proc/<pid>/environ`), memory and file descriptors, and lets it be signalled or traced, only by processes of the same user.

How Pi is started is decided in one place, [`src/agent-process`](src/agent-process), so the Pi harness has no idea which user it runs as:

- **Same user** (`BARRACK_AGENT_USER` unset, or naming the supervisor's own user): Pi is spawned with the supervisor's Node, exactly as on a developer's machine, macOS included. The agent can read the supervisor's token through `/proc`; treat it as readable.
- **Separate user** (the [sandbox image](../../sandbox-image) sets `BARRACK_AGENT_USER=barrack-agent` and runs the supervisor as `barrack-supervisor`): Pi is started as `/opt/barrack/bin/run-as-agent --reuid=<uid> --regid=<gid> --init-groups -- <node> <Pi> <arguments>`. `run-as-agent` is a copy of `setpriv` with the setuid and setgid file capabilities, which only the supervisor's group may run; it changes user and then executes Node in its own place, so Pi has no capabilities. `HOME`, `USER`, `LOGNAME` and `SHELL` are set to the agent user's. The supervisor cannot signal the agent's processes either, so to stop them it runs a short `kill(-1)` as the agent through the same helper, which reaches every process of that user, including commands that started a session of their own.

At startup, before connecting, the supervisor checks a separate user thoroughly and exits with a message naming the problem: an unknown user, a missing or unusable helper, a helper that cannot change user (a sandbox without the `SETUID` and `SETGID` capabilities, or with `no-new-privileges`), and any of the workspace, `pi/agent` and `pi/sessions` that the agent cannot write to. The last check runs a real process as the agent through the helper, so it proves the whole route. The supervisor never creates the agent's directories in this mode; it needs only to pass through them (see the sandbox image's README).

What the agent can and cannot reach as that user is listed in the sandbox image's README.

## Running it

The control plane starts every supervisor: it creates each thread's sandbox through its [sandbox provider](../../packages/sandbox-providers) with a token minted for that thread alone, which it keeps only as a digest and never reveals. There is no shared token any more, so a supervisor cannot simply be started by hand against a control plane. `pnpm dev` at the repository root runs the control plane with the local-process provider, which starts each thread's supervisor from its sources as an ordinary process; that is the way to run one locally.

**To debug a supervisor**, change how the local-process provider starts it rather than starting it yourself: run the control plane with the variables `pnpm dev` gives it ([`scripts/dev/services.ts`](../../scripts/dev/services.ts)), but with `BARRACK_LOCAL_SUPERVISOR_COMMAND` set to, for example, `["node", "--inspect=0", "/absolute/path/to/apps/sandbox-supervisor/dist/main.js"]`. Paths must be absolute, since each supervisor starts in its sandbox's workspace, and `--inspect=0` gives each one a free port, which Node prints.

**To start one by hand** for a thread that already exists, you need that thread's token, which exists only in the environment of the supervisor the provider started. With the local-process provider that is a process of your own user, so on Linux `tr '\0' '\n' < /proc/<its pid>/environ | grep ^BARRACK_` shows its variables. A supervisor started with the same thread and token replaces it, since the newest supervisor of a thread wins, and the one it replaced exits:

```sh
BARRACK_CONTROL_PLANE_URL=ws://127.0.0.1:8787 \
BARRACK_THREAD_ID=<thread id> \
BARRACK_SUPERVISOR_TOKEN=<that thread's token> \
BARRACK_AGENT_HARNESS=fake \
node apps/sandbox-supervisor/dist/main.js
```

Build it first (`pnpm build`). Add `BARRACK_SUPERVISOR_STATE_DIRECTORY` (any directory of your own) as well. For Pi instead of the fake agent, set `BARRACK_MODEL`, the model provider's key, `BARRACK_WORKSPACE_DIRECTORY` and `BARRACK_STATE_DIRECTORY` as in the table above. Run this way, Pi runs as your own user and can read the token, as with any supervisor and agent that share a user.

The fake agent quotes each message back word by word. A message containing `[tool]` makes it call a tool first; one containing `[fail]` makes it fail as if its process had crashed. `pnpm --filter @barrack/sandbox-supervisor exec pi --list-models <search>` lists the model identifiers Pi knows.

## How it behaves

- **Pi** runs as a child process in RPC mode, driven by our own JSONL client ([`src/pi`](src/pi)). Readiness is the answer to `get_state`. User messages are sent one at a time as `prompt` with `streamingBehavior: "steer"`, so a busy agent takes them up after its current turn. A message Pi refuses is reported as an errored assistant message. An interrupt is `clear_queue` then `abort`, and drops messages not yet sent. Starting Pi, sending a message, interrupting and stopping take turns in one queue, so a message sent right after an interrupt reaches Pi only once `abort` has been answered and starts a run of its own.
- **Translation** ([`src/pi/pi-event-translator.ts`](src/pi/pi-event-translator.ts)) is pure. A run starts at the first `agent_start` after idle and settles only on Pi's `agent_settled`. User and tool result messages are not forwarded. An assistant message that ended in a model provider error is held back until Pi shows whether it will retry the request (`agent_end.willRetry`, or `compaction_end.willRetry` after a context overflow): it is dropped when the retry starts and recorded as soon as anything else happens, so a failure Pi recovers from shows no error and one it cannot shows exactly one. Tool output over 64 Ki characters keeps its first quarter and last three quarters, where errors and summaries appear.
- **Crashes**: if Pi exits unexpectedly the supervisor sends `agent_failed`, which also ends any run in progress, and starts Pi again on the next user message, reopening the same session file so the conversation continues.
- **A sandbox stopped and started again**: the supervisor starts as a new process, and Pi is started with the thread's identifier as its session identifier in the state directory, which reopens the session it wrote before the stop, so the model is sent the earlier turns (the Docker test `docker-thread-lifecycle.test.ts` checks it). The control plane interrupts the agent before it stops a sandbox, and hands the supervisor no messages while it stops.
- **Stopping**: on `SIGINT` or `SIGTERM` the supervisor closes Pi's stdin (a signal would cut off Pi's last events), waits, escalates to signals if needed, then closes the socket. Pi writes nothing more once its input closes, so a run in progress is reported as settled and interrupted: every run the control plane hears start, it hears end. Every wait is bounded ([`src/pi/pi-stop-timing.ts`](src/pi/pi-stop-timing.ts)): a stop waits at most 3 s for the command Pi is busy with (an interrupt waits for Pi to answer `abort`, which a hung Pi never does), then gives Pi 5 s after its input closes, then sends SIGTERM and after 3 s SIGKILL to the agent's process and every process it started, and gives up waiting 2 s later. That is 13 s at worst, inside the 15 s a Docker sandbox allows. As the supervisor's own user, those signals go to Pi and its descendants as `ps` lists them, which misses a command that left the tree; as a separate user they go to every process of that user.
- **Connection**: reconnects with capped, jittered exponential backoff (up to about 15 s). It exits without reconnecting when the control plane refuses the upgrade with a 4xx status that retrying cannot change (every one but `408` and `429`: wrong credentials, an unsupported protocol version, an unknown endpoint), giving the control plane's reason, or closes with `supersededByNewerSupervisor`; `5xx` answers and network errors are retried. Its own pings detect a dead connection.
- **Acknowledged delivery** (the handshake is in [`packages/protocol/src/supervisor-messages.ts`](../../packages/protocol/src/supervisor-messages.ts)): every connection opens with a hello naming this process (a fresh identifier each start) and how far the agent has been handed user messages. Agent events are numbered and kept in memory ([`src/control-plane/unconfirmed-agent-events.ts`](src/control-plane/unconfirmed-agent-events.ts)) until the control plane confirms them recorded, and everything unconfirmed is sent again after each welcome; stream fragments are sent only on a welcomed connection and otherwise dropped. A user message's sequence is written to `BARRACK_SUPERVISOR_STATE_DIRECTORY` ([`src/delivery/delivered-user-messages.ts`](src/delivery/delivered-user-messages.ts)) before the agent is handed it, so a redelivery, even after a restart, is acknowledged but not handed over again. Stopping waits up to 5 s for the last events to be confirmed.
- **What a supervisor restart loses**: the delivery position survives it; unconfirmed agent events do not (normally milliseconds' worth, or everything since a control plane outage began), and the control plane then closes the run this process left open, saying work was lost. A message noted but not yet handed over when the process dies is lost rather than repeated. If more than 32 Mi characters of events wait unconfirmed, the supervisor exits with an error rather than drop one or keep growing.
- **Size**: every frame must fit the protocol's `maximumAgentEventFrameLength`: `maximumFrameLength` less `threadEventEnvelopeAllowance` (1 KiB) for the envelope the control plane adds when it forwards an event to viewers ([`src/fit-agent-event-in-frame.ts`](src/fit-agent-event-in-frame.ts)). The control plane refuses to record an event whose frame to viewers would not fit, and disconnects the supervisor that sent it. An assistant message too large for that has the middle cut out of each text block, and tool call arguments too large replaced by a note saying how large they were; if that is still too large, its content becomes a notice that it was left out. A stream fragment too large is dropped and logged, since the completed message is the record.
- **Logs**: one JSON object per line on stdout ([pino](https://getpino.io)), each tagged with the thread.

## Tests

`pnpm test` from the root runs them all. The Pi integration test ([`src/pi/pi-agent-harness.integration.test.ts`](src/pi/pi-agent-harness.integration.test.ts)) runs the pinned Pi against a mock model server on `127.0.0.1`, with no network and no API key. The mock is shared with the end-to-end tests as the workspace package [`@barrack/mock-model-server`](../../tests/mock-model-server). Stopping a Pi that answers nothing is tested with a stand-in ([`src/test-support/unresponsive-pi.mjs`](src/test-support/unresponsive-pi.mjs)).

The separate-user launcher's signalling is not tested here: it signals every process of the user it runs as, which in a unit test would be the test runner's own. `pnpm test:docker` covers it, and everything else about the separate user, with the real image and the real Pi ([`tests/end-to-end/src/docker-agent-isolation.test.ts`](../../tests/end-to-end/src/docker-agent-isolation.test.ts)).
