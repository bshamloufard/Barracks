# Decision log

Each entry records a decision, what the project plan said about it, what we actually did, and why. Newest entries go at the bottom.

## 2026-11-24: pnpm workspaces for the monorepo

- **What the plan said:** TypeScript across the system, with types shared between the control plane, sandbox supervisor and clients. No package manager or repository layout was specified.
- **What we did:** One repository managed as a pnpm workspace, with applications under `apps/` and shared libraries under `packages/`.
- **Why:** Workspaces let the parts share code such as message definitions without publishing packages. pnpm's strict dependency layout stops a package from importing anything it has not declared.

## 2026-11-24: Biome as the formatter and linter

- **What the plan said:** Use an automatic formatter and a linter from the first commit, and keep both passing.
- **What we did:** Biome does both, using its recommended rules, with explicit `any`, non-null assertions and unused code treated as errors. `pnpm lint` also fails on warnings.
- **Why:** One fast tool with one config file, instead of a separate formatter and linter whose settings have to be kept from conflicting.

## 2026-11-24: Vitest as the test runner

- **What the plan said:** Test the behaviour that matters. No test runner was specified.
- **What we did:** Vitest, configured once at the root so `pnpm test` runs the tests in every workspace package.
- **Why:** It runs TypeScript ES modules directly with no separate compile step, and it is fast enough to run on every change.

## 2026-11-24: TypeScript 7 with strict settings

- **What the plan said:** Use strict type checking and avoid escape hatches that switch the type checker off.
- **What we did:** TypeScript 7, the current stable release, with `strict` plus extra checks for index access, optional properties, overrides, implicit returns and switch fall-through, shared through `tsconfig.base.json`.
- **Why:** TypeScript 7's compiler is much faster, which keeps `pnpm typecheck` cheap. It has no stable programmatic API yet, so any future tool that loads the compiler as a library may need a TypeScript 6 install alongside it.

## 2026-11-24: A fresh codebase rather than extending Deputies

- **What the plan said:** Read Deputies first, and say so if extending it would serve the goals better than a fresh, smaller codebase.
- **What we did:** Started fresh. Deputies (0.28.0) runs Pi inside its control plane and reaches into sandboxes for every tool call, the opposite of our sandbox-connects-outward design, and it is about 120,000 lines of mostly out-of-scope features. We borrow from it, under its MIT licence, the ordered single-statement event append, the subscribe-then-replay-then-flush stream handler, the small provider interface with lifecycle policy kept outside providers, and testing with a fake runner and a fake provider.
- **Why:** Rebuilding Deputies around an outward-connecting sandbox would mean rewriting its core while carrying code we do not need. The cost we accept: with the agent inside the sandbox, model credentials and the agent's session file live there too, so a model-traffic proxy (Milestone 7) and backing the session up off the sandbox become our job.

## 2026-11-24: Pi driven as a subprocess through our own JSONL client

- **What the plan said:** Drive Pi either as a controlled subprocess or through its TypeScript SDK, chosen after reading the documentation for both.
- **What we did:** The supervisor runs Pi in its RPC mode as a child process and talks to it through a small JSONL client of our own, not the SDK and not Pi's bundled `RpcClient`, which has a hard 30-second request timeout.
- **Why:** A Pi crash cannot take the supervisor down with it, the wire protocol has been more stable than the TypeScript API (5 of 13 releases since 1.0 broke the API), and extensions still load in RPC mode. Signing in, which RPC mode cannot do, will be handled outside it.

## 2026-11-24: WebSockets on both hops

- **What the plan said:** The transports between sandbox and control plane and between control plane and clients were left open.
- **What we did:** Both hops are WebSockets carrying one JSON message per frame.
- **Why:** Messages flow in both directions on both hops, and Railway caps plain HTTP responses, server-sent events included, at 15 minutes, while WebSockets may stay open indefinitely.

## 2026-11-24: Durable events are sequenced; streamed text fragments are not stored

- **What the plan said:** Work out how to shape stored events so that history is cheap to replay and the stream of small text fragments does not bloat the database.
- **What we did:** Thread events are stored with a gapless per-thread sequence that clients resume from. Stream fragments are relayed live and dropped; the completed assistant message is the record. The supervisor truncates large tool output and records its original size.
- **Why:** OpenHands' measurements put text messages at 0.6% and tool output at 78% of stored bytes, so storing fragments would multiply the number of rows for no lasting value, while tool output is where the size actually is.

## 2026-11-24: A Barrack-owned event vocabulary, translated in the supervisor

- **What the plan said:** Keep the agent harness behind a narrow boundary so that replacing it does not ripple through the system.
- **What we did:** `@barrack/protocol` defines Barrack's own thread events and stream fragments, and the supervisor translates Pi's events into them. No Pi event shapes appear outside the supervisor.
- **Why:** This is that narrow boundary: the control plane, the data store and the clients depend only on our vocabulary, so a different harness would need only a new translation in the supervisor.

## 2026-11-24: Hono for HTTP, `ws` for WebSockets

- **What the plan said:** The control plane is a TypeScript service; the choice of web framework is ours.
- **What we did:** Hono's request listener from `@hono/node-server` serves the HTTP routes on a plain Node HTTP server, and `ws` in `noServer` mode handles that server's `upgrade` event for both WebSocket endpoints.
- **Why:** `@hono/node-server`'s built-in WebSocket support hands handlers an abstract socket, and we need the raw one: to refuse an upgrade with an HTTP status, read `bufferedAmount` to drop slow clients, send pings, and wait for write callbacks during replay.

## 2026-11-24: pino for logs

- **What the plan said:** Log enough to trace a thread's life from creation to shutdown, and never log secrets.
- **What we did:** Both services log JSON lines to standard output with pino. The control plane logs through a child logger per thread (and per connection) carrying `threadId`; a supervisor serves one thread, so it puts `threadId` in every line's base fields instead.
- **Why:** pino is fast and structured, and filtering on `threadId` follows one thread through both services.

## 2026-11-24: Vite and React for the web client, with state in a pure reducer

- **What the plan said:** A modern web application; the framework and styling approach are ours.
- **What we did:** Vite and React with one hand-written stylesheet. All of a thread's state lives in a pure reducer, held in a small store that React reads through `useSyncExternalStore`.
- **Why:** The page is small, so a UI framework would add more than it saves, and the reducer holds every ordering and replay rule, so those rules are tested without React or a browser.

## 2026-11-24: A client that claims history the log lacks is replayed from the start

- **What the plan said:** A client that reconnects says where it left off and receives everything it missed.
- **What we did:** If a client's last seen sequence is not in the log (the in-memory log loses everything when the control plane restarts), the control plane replays the thread from sequence 1. An announcement starting at or before the client's last seen sequence tells the client to discard its history and rebuild.
- **Why:** Replaying only what follows the claimed sequence would leave that client ignoring every new event as already seen. This catches only a log that is shorter than what the client saw; detecting a different history of the same length needs a log identity, which durable storage (Milestone 2) makes unnecessary.

## 2026-11-24: A prompt the agent refuses is shown as an errored reply

- **What the plan said:** Handle failure deliberately and tell the user why a thread stopped.
- **What we did:** When Pi refuses a user message (no credentials for the model, say), the supervisor records an assistant message that ended in an error, wrapped in a run of its own if the agent was idle.
- **Why:** Otherwise the user would wait for a reply that will never come, and the client already shows model provider errors this way.

## 2026-11-24: The supervisor reconnects after being closed for an invalid message

- **What the plan said:** Nothing specific; the protocol's close code says reconnecting will not help.
- **What we did:** The supervisor logs an error and reconnects anyway.
- **Why:** The offending frame is already gone, and exiting would strand an agent that is still working; the logged error points at the bug.

## 2026-11-24: A bounded outage backlog that fails loudly

- **What the plan said:** Every agent event is recorded in order; nothing should be lost silently.
- **What we did:** While the control plane is unreachable, the supervisor keeps agent events in a backlog of at most 32 Mi characters of serialized frames and sends them in order on reconnect. If it fills, the supervisor exits with an error rather than drop durable events. Events in flight when a connection drops can still be lost; acknowledged delivery is deferred to Milestone 2.
- **Why:** An unbounded backlog could exhaust the sandbox's memory, and a silent gap in history is worse than a visible failure.

## 2026-11-24: Truncated tool output keeps its start and its end

- **What the plan said:** Keep stored history cheap to replay.
- **What we did:** Tool output longer than 64 Ki characters is cut to that length: the first quarter and the last three quarters of the kept text survive, joined by a marker saying how many characters were omitted, and the original size is recorded.
- **Why:** Errors, exit statuses and test summaries sit at the end of command output, while the start shows what the command was doing.

## 2026-11-24: Pi's extension dialogs are cancelled at once

- **What the plan said:** Customise Pi through extensions where needed.
- **What we did:** When an extension asks the user something (select, confirm, input or editor), the supervisor cancels the dialog immediately.
- **Why:** Nobody can answer it in Milestone 1, and an unanswered dialog blocks the agent.

## 2026-11-24: Every user message reaches Pi as a steering prompt

- **What the plan said:** The user can send follow-up instructions while the agent works.
- **What we did:** The supervisor sends every message to Pi as a `prompt` with `streamingBehavior: "steer"`, one at a time.
- **Why:** An idle Pi starts a run and a busy one takes the message up after its current turn, so the supervisor never has to guess whether Pi is busy, which it could get wrong in a race.

## 2026-11-24: Cross-application tests in their own workspace package

- **What the plan said:** Test event ordering and replay; keep the boundaries between parts obvious from the folder layout.
- **What we did:** End-to-end tests live in `tests/end-to-end`, a workspace package beside `apps/` and `packages/`. They start the real control plane and supervisor (with the fake agent) as separate processes from their sources through tsx, and drive them over real WebSockets.
- **Why:** They belong to no single application, and running the services as processes tests them as they really run while importing nothing from them, so applications still never depend on each other's internals.

## 2026-11-24: `pnpm dev` is a small TypeScript script

- **What the plan said:** A README that lets a newcomer run the whole system locally, with single obvious commands.
- **What we did:** `scripts/dev/` starts the control plane, a supervisor and Vite for one thread, with a fresh supervisor token given only to the two services that use it. Each service leads its own process group; on Ctrl-C the script stops the supervisor first, then the rest, and if any service dies it stops the others and exits non-zero.
- **Why:** A process manager such as `concurrently` could run three commands, but not generate a secret for two of them, stop them in order, or kill the Pi process the supervisor starts; a few small typed modules, linted and type-checked like everything else, do all of that with no new dependency. Process groups make it macOS and Linux only.

## 2026-11-24: Known limitation: the supervisor and the agent share an operating-system user

- **What the plan said:** Treat everything inside a sandbox as untrusted, and give sandboxes the fewest credentials possible.
- **What we did:** In Milestone 1 the supervisor and Pi run as the same user. The supervisor's token is kept out of Pi's environment, but a determined agent could still read it from the supervisor process (through `/proc`, for example). Every supervisor shares that one token for now, so it would let the agent connect as the supervisor of any thread.
- **Why:** Separating them, with a different user or a separate container for the supervisor, belongs with sandbox hardening, and per-thread supervisor credentials are due once sandboxes run in the cloud (Milestone 2), as the security baseline requires. Until then, the token should be treated as readable by the agent.
