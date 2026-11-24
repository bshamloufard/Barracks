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
- **Why:** Exiting would strand an agent that is still working; the logged error points at the bug. Since delivery is acknowledged, an agent event the control plane refused is sent again after every reconnection, so such a bug stops the thread's history at that event, loudly, rather than leaving a gap. The supervisor checks every event against the protocol before sending it, so only a control plane and supervisor that disagree about the protocol can get there.

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

## 2026-11-24: The agent runs as its own operating-system user

- **What the plan said:** Treat everything inside a sandbox as untrusted, and give sandboxes the fewest credentials possible.
- **What we did:** This replaces the Milestone 1 limitation that the supervisor and Pi shared a user. In the sandbox image the supervisor runs as `barrack-supervisor` and starts Pi as `barrack-agent` through `run-as-agent`, which only the supervisor's group may run, and it signals the agent's processes through the same helper. Under `pnpm dev` both still run as the developer's user.
- **Why:** Linux shows a process's environment and memory, and allows signals and tracing, only within one user, so this is what keeps the supervisor's token from the agent. Commands started with `docker exec` still see the token until it is handed over some other way than the container's environment; see the open gaps below.

## 2026-11-24: A user's message is recorded before it is delivered

- **What the plan said:** Every event is recorded in order before it is shown.
- **What we did:** The control plane records a `user_message` and broadcasts it before sending it to the supervisor. One that cannot be sent waits in history and is delivered when a supervisor next attaches (see acknowledged delivery below).
- **Why:** A message the agent acted on but history lacks could never be repaired, while one recorded but undelivered is visible and is redelivered.

## 2026-11-24: Streamed text is shown only for the message being produced

- **What the plan said:** Stream fragments are relayed live and superseded by the completed message.
- **What we did:** Text that was never completed is discarded when another message starts streaming or the run settles or fails. The control plane, which keeps the text for clients joining mid-message, and the web client's reducer apply the same rule.
- **Why:** Otherwise a page that reconnected would show different leftovers from a page that watched all along.

## 2026-11-24: A failed model request is held back until Pi says whether it will retry

- **What the plan said:** Show the user model provider failures; nothing should be lost silently.
- **What we did:** An assistant message that ended in a provider error is held until Pi shows whether it will retry (`agent_end.willRetry`, or `compaction_start` for an overflow followed by `compaction_end.willRetry`). It is dropped when the retry's run starts and recorded as soon as anything else follows.
- **Why:** A failure Pi recovers from then shows no error, and one it cannot shows exactly one.

## 2026-11-24: Every frame fits, with room for the control plane's envelope

- **What the plan said:** Validate everything that crosses a boundary; bound what a sandbox can make the control plane store and send.
- **What we did:** A supervisor's agent event frames must fit `maximumFrameLength` less `threadEventEnvelopeAllowance` (1 KiB), both in the protocol. An oversized message keeps the start and end of each text block, oversized tool arguments become a note of their size, and failing that the content becomes a notice; an oversized stream fragment is dropped and logged. The control plane refuses to record an event whose frame to clients could not fit, bounds the streamed text it keeps by its escaped length, and never sends a client an oversized frame.
- **Why:** An event recorded but too large to send would break every replay of its thread, so the guarantee is checked on both sides of the envelope.

## 2026-11-24: Thread identifiers are limited to URL- and file-name-safe characters

- **What the plan said:** Nothing specific.
- **What we did:** Thread identifiers must match `[A-Za-z0-9_-]{1,64}`, in the protocol and as a check in the database.
- **Why:** They appear in URL paths and in names of files and containers, so nothing in them may need escaping or be read as a path.

## 2026-11-24: Every run the agent starts ends exactly once

- **What the plan said:** Thread status and sandbox shutdown depend on Pi's run lifecycle.
- **What we did:** The Pi harness guarantees that every `agent_run_started` is followed by exactly one `agent_run_settled` or `agent_failed`, including when Pi crashes or is stopped mid-run. When the supervisor process itself dies mid-run, the control plane records the `agent_failed` (see below).
- **Why:** Clients and, later, idle shutdown can then trust a run's end instead of guessing from silence.

## 2026-11-24: Each thread's supervisor gets a token of its own, stored as a digest

- **What the plan said:** Connections between sandbox and control plane must be authenticated per thread.
- **What we did:** The shared `BARRACK_SUPERVISOR_TOKEN` is gone. Creating a thread mints 32 random bytes for it, records only their SHA-256 digest, and hands the token to the provider in the supervisor's environment; a supervisor's upgrade is compared against its thread's digest in constant time.
- **Why:** Reading the threads table does not let anyone connect as a supervisor, and one sandbox's token is worthless for any other thread. A fast digest suffices because the token is random.

## 2026-11-24: Threads are recorded at once, and their sandboxes created in the background

- **What the plan said:** Starting a thread starts its sandbox.
- **What we did:** `POST /api/threads` records the thread and answers immediately; the sandbox is created afterwards, retried twice while the provider is unavailable, and the thread recorded `ready` or `failed` with a reason. A sandbox that cannot be recorded is destroyed.
- **Why:** A real provider can take minutes, and no sandbox may be left running unrecorded.

## 2026-11-24: Threads left creating by a restart are failed at startup

- **What the plan said:** Recovery when the control plane restarts mid-task belongs to Milestone 7.
- **What we did:** At startup, every thread still marked `creating` is marked failed, with a reason saying the control plane restarted while its sandbox was being created, and logged. A sandbox the provider may have made for it was never recorded, so it is not destroyed. This assumes one control plane per database.
- **Why:** Otherwise such a thread would show as starting for ever; finding and finishing them properly comes with the thread lifecycle.
- **Superseded** by "Operations under way hold a lease, and one whose lease lapses is taken over" below.

## 2026-11-24: A local-process sandbox provider for development

- **What the plan said:** Docker on the developer's own computer is the way to develop without a cloud account.
- **What we did:** `pnpm dev` and the fast end-to-end tests create threads through the control plane with a `local-process` provider: a directory and a supervisor process per thread on the same machine, with no isolation. It is refused unless `BARRACK_ALLOW_UNISOLATED_SANDBOXES=development-only` is set and the control plane listens only on loopback. This supersedes `pnpm dev` hand-starting one supervisor with a shared token.
- **Why:** It keeps `pnpm dev` and `pnpm test` free of Docker while every thread still goes through the same creation path and per-thread tokens as in production.

## 2026-11-24: Pi's offline and caching settings are forwarded to sandboxes

- **What the plan said:** Nothing specific.
- **What we did:** A control plane running Pi forwards `PI_OFFLINE` and `PI_CACHE_RETENTION` from its own environment to every sandbox, as it forwards model keys; no other `PI_` variable.
- **Why:** Once the control plane built each supervisor's environment, Pi in a sandbox could no longer be told to stay offline, which the tests and any sandbox without general internet access need. An allowlist keeps a developer's own Pi session variables out.

## 2026-11-24: Postgres through `pg` and Supabase's session pooler, in a schema of its own

- **What the plan said:** Supabase for Postgres.
- **What we did:** The control plane connects with `pg` through Supabase's session pooler (port 5432), keeps its tables in a `barrack` schema with row level security on and no policies, and verifies TLS with Supabase's own certificate authority.
- **Why:** The direct host is IPv6 only, which Railway lacks by default; the transaction pooler breaks the advisory lock migrations need; and the `public` schema is served to anyone holding the project's publishable key.

## 2026-11-24: Our own migration runner

- **What the plan said:** Nothing specific.
- **What we did:** About 150 lines apply plain SQL files in name order, each in its own transaction, under an advisory lock, recording a checksum of each; the control plane refuses to start if an applied file changed or the database has one this build lacks.
- **Why:** A migration library would bring more than the few rules we need, and these rules are easy to read and test.

## 2026-11-24: Events are stored as `json`, and replayed in pages of 100

- **What the plan said:** Make history cheap to replay.
- **What we did:** Each event is a `json` column, not `jsonb`, appended with its counter in one statement. Replay reads 100 events at a time.
- **Why:** `jsonb` rejects U+0000 and unpaired surrogates, which tool output can contain, and would reject the append; `json` keeps the exact text. A page of 100 bounds a replay's memory at about 13 MB even of maximum-size tool output.

## 2026-11-24: A live client that would see a gap is disconnected

- **What the plan said:** A client receives every event exactly once, in order.
- **What we did:** A live client is sent an event only if it is the next after the last it was sent; an earlier one is skipped as already replayed, and a later one disconnects the client so it replays what it missed.
- **Why:** This covers an append committed after it was reported failed and two control plane instances writing one thread, without the relay having to know which happened.

## 2026-11-24: Docker through its CLI

- **What the plan said:** Docker on a machine we control, as the second provider.
- **What we did:** The Docker provider runs the `docker` CLI with `execFile`, passing secrets through the CLI's environment and never its arguments.
- **Why:** No dependency, and the CLI honours the operator's contexts, `DOCKER_HOST` and credential helpers; arguments would show the token to every user on the machine.

## 2026-11-24: Daytona through its SDK's `v0` namespace, with auto-stop off

- **What the plan said:** Daytona first; the control plane should own when a sandbox stops, since Daytona's idle auto-stop ignores work inside the sandbox.
- **What we did:** `@daytona/sdk` 2.1.0 through `v0`, its generally available platform. Sandboxes are created with auto-stop off (0), auto-delete off (-1) and archived 60 minutes after a stop.
- **Why:** Archiving stops disk billing and frees storage quota; stopping is the control plane's decision. None of this has been run against Daytona.

## 2026-11-24: The Docker provider was built to a working state before Daytona

- **What the plan said:** Daytona first (Milestone 2), Docker second (Milestone 6).
- **What we did:** Both providers exist, but only the Docker one has been run; the Daytona provider is tested against an in-memory stand-in.
- **Why:** No Daytona credentials were available, and Docker proves the provider boundary and the sandbox image end to end in the meantime.

## 2026-11-24: The sandbox image is Ubuntu 24.04 with Node from the official image

- **What the plan said:** Decide how the base sandbox image is built and kept current.
- **What we did:** The runtime image is Ubuntu 24.04; Node, npm and corepack are copied from the official Node image. Both are pinned by digest, and the supervisor is installed from the lockfile.
- **Why:** Ubuntu is what coding tools and agents most often expect, the official image gives the exact Node version the repository requires, and digests make rebuilds reproducible.

## 2026-11-24: The supervisor changes user through a copy of `setpriv` with file capabilities

- **What the plan said:** Keep secrets from the agent; the sandbox is the security boundary.
- **What we did:** `run-as-agent` is a copy of `setpriv` carrying only the `setuid` and `setgid` file capabilities, runnable only by the supervisor's group; the supervisor's own process has no capabilities, and no file in the image keeps a setuid or setgid bit.
- **Why:** The supervisor stays unprivileged, and `no-new-privileges` cannot be set without disarming the helper, so no setuid program may remain for the agent to abuse. The cost: the helper can switch to any user, so the supervisor's user is effectively root in the container (see the open gaps below).

## 2026-11-24: Docker tests are opt-in, with a CI job of their own

- **What the plan said:** Test the provider boundary and sandbox lifecycle.
- **What we did:** Tests that run real containers run only with `BARRACK_DOCKER_TESTS=1` (`pnpm test:docker`, which builds the image first), and CI runs them in a separate job that also checks no container was left behind.
- **Why:** They need the image built from the current sources and take far longer, so `pnpm test` stays fast and needs no Docker.

## 2026-11-24: A mock model server shared by the tests

- **What the plan said:** A fake agent and fake providers make most of the system testable without model spend.
- **What we did:** A stand-in OpenAI-compatible model lives in the workspace package `tests/mock-model-server`, used by the supervisor's Pi integration test and the Docker end-to-end tests.
- **Why:** The real Pi can then be tested without network or key, and one mock serves both instead of two drifting copies.

## 2026-11-24: No deployment until sign-in exists

- **What the plan said:** Milestone 2 deploys the control plane on Railway, with events in Supabase.
- **What we did:** Milestone 2's parts are built and tested locally only; deploying waited for sign-in (Milestone 3). Sign-in now exists (see below) and the deployment files are written, but nothing has been deployed yet; [the deployment guide](deployment.md#not-yet-verified) lists what the first deployment must confirm.
- **Why:** Deployed as planned, the control plane would be on the internet with no authentication: anyone could create threads and command agents.

## 2026-11-24: An idle control plane does not keep a free Supabase project awake

- **What the plan said:** Confirm that the running control plane generates enough activity to stop a free project pausing, and note the outcome.
- **What we did:** The control plane queries the database only when a thread is created or used, so a week without use would let a free project pause. A small periodic query is needed; it is not built yet.
- **Why:** Supabase pauses free projects after about a week of low activity, and an always-on service that is merely idle does not count.

## 2026-11-24: Security gaps that remain open

- **What the plan said:** Apply the security baseline from the first milestone that touches the cloud.
- **What we did:** These are known and not yet closed. (1) The token is in the sandbox's environment (the container's, and on Daytona the sandbox's `envVars`), so anything started with `docker exec` or a provider's command interface inherits it, including as the agent's user; fix: hand it to the supervisor through a file only its user can read, or standard input. (2) `run-as-agent` can switch to any user, so the supervisor's user is effectively root in the container; fix: a helper that can only become `barrack-agent`, or the supervisor in a container of its own. (3) None of this has been examined on Daytona, whose own processes and command interface may offer the agent a way round; fix: examine and test it there before relying on it. (4) There was no user sign-in, so anyone who could reach the control plane controlled every thread; closed by Supabase sign-in and per-user access checks on the server (see the entries below).
- **Why:** Each fix is larger than the change that revealed it, and none matters while nothing is deployed; they are listed so none is forgotten.

## 2026-11-24: One control plane image, with the Docker CLI only in a variant

- **What the plan said:** Host the control plane on Railway; the web client can be hosted alongside it. Prefer small, budget-conscious infrastructure.
- **What we did:** The root `Dockerfile` builds one image holding the control plane, with its production dependencies only (`pnpm deploy --prod`), and the built web client, which it serves. It runs as an unprivileged user on Debian with only the Node binary from the pinned official Node image, and Node receives SIGTERM itself, with no init process. The Docker CLI is added only in the `control-plane-with-docker-cli` stage, which Compose builds; the last stage, which Railway builds, has none.
- **Why:** One image to build, test and deploy, and one origin, so no cross-site setup between client and control plane. Hosted deployments create sandboxes through Daytona's API and would carry the CLI's 44 MB unused; the control plane starts no process but the CLI and waits for each, so it reaps its own children without an init. Leaving out npm, yarn and corepack saves about 90 MB.

## 2026-11-24: Railway is configured with Infrastructure as Code, not `railway.json`

- **What the plan said:** Host the control plane on Railway.
- **What we did:** `.railway/railway.ts`, applied with `railway config plan` and `railway config apply`, describes the service: the Dockerfile builder, a health check on `/health`, one replica, no sleeping, a 120-second drain with no overlap, restarts on failure, and the variables that are not secret, keeping secrets in Railway with `preserve()`. The `railway` SDK is a root dev dependency, so the file is type-checked.
- **Why:** Railway deprecated `railway.json` and `railway.toml`: new services cannot opt into them, and existing files stop being read on 2026-12-01 ([Railway's documentation](https://docs.railway.com/infrastructure-as-code)). The drain matters because Railway's default is 0 seconds, which would kill the control plane before it finishes shutting down; one replica, because each instance relays only its own connections. None of it has been applied to a real project.

## 2026-11-24: A periodic query keeps a free Supabase project awake

- **What the plan said:** Confirm that the running control plane generates enough activity to stop a free project pausing. An earlier entry found it does not.
- **What we did:** With Postgres configured, the control plane reads one row of `barrack.schema_migrations` every four hours (`BARRACK_DATABASE_KEEP_ALIVE_MINUTES`, 0 turns it off), scheduling each query only after the last has finished, logging failures, and stopping before the pool closes.
- **Why:** Supabase says "a few user requests to the database each day" are typically enough, and six a day leaves a margin. It does not say which queries count, so the keep-alive reads a real table through the same role and pooler as everything else rather than sending `select 1`. Whether it is enough is confirmed only by a project not pausing.

## 2026-11-24: Compose on one machine, with sibling sandboxes behind a socket proxy

- **What the plan said:** Open source and self-hostable; Docker on a machine we control as the second provider.
- **What we did:** `compose.yaml` runs Postgres, the control plane and [wollomatic/socket-proxy](https://github.com/wollomatic/socket-proxy). The control plane reaches Docker only through the proxy, which answers only it and forwards only the calls the Docker provider makes; sandboxes are sibling containers on a `barrack-sandboxes` network (a new `BARRACK_DOCKER_NETWORK` setting) shared with the control plane and nothing else; Postgres and the proxy sit on internal networks of their own; the control plane's port is published on `127.0.0.1` only.
- **Why:** Docker API access amounts to root on the host. Giving the control plane the socket itself would let a flaw in it list, exec into or read any container; the proxy limits it to creating, starting, stopping and removing containers and inspecting sandboxes, and it also lets the control plane run unprivileged without the host's docker group. It does not inspect what a create asks for, so a privileged container can still be created (a check confirmed it); that remains the cost of a control plane that creates containers, and the documentation says so. Networks keep sandboxes from Postgres and the proxy, verified from inside a sandbox; sandboxes can still reach each other, as they could on the default bridge. wollomatic's proxy was chosen over Tecnativa's and LinuxServer's because it allows paths by regular expression per method, so inspection can be limited to sandboxes, and its image holds nothing but the proxy.

## 2026-11-24: Supabase Auth, with every token verified by the control plane, and only asymmetric keys

- **What the plan said:** Supabase for authentication. A user can only ever see or control their own threads, enforced on the server.
- **What we did:** The web client signs in through supabase-js; the control plane verifies each access token itself with jose against the project's published key set (`<project>/auth/v1/.well-known/jwks.json`): issuer, audience `authenticated`, ES256 or RS256 only, expiry with 30 seconds' tolerance, `role: authenticated`, not anonymous, the user being `sub`. Verification sits behind a small `AccessTokenVerifier` interface. A project still signing with the legacy shared secret publishes no keys, and the control plane refuses to start, telling the owner to rotate to an asymmetric key.
- **Why:** Verifying locally costs no request to Supabase per call and keeps the shared secret, which can mint a token for anyone, out of the control plane. New projects sign asymmetrically by default. Accepting HS256 at all would reopen the attack that signs a token with the public key as the secret. Tests verify real tokens from a test issuer (`tests/test-identity-issuer`) through the same code, so no Supabase project is needed.

## 2026-11-24: Sign-in by a six-digit code sent by email

- **What the plan said:** Sign-in, with Sign in with Apple wanted for the native apps later.
- **What we did:** One screen: email address, then the code Supabase emails, verified with `verifyOtp`; the PKCE flow is set explicitly, since supabase-js still defaults to implicit. The client asks the control plane (`GET /api/client-configuration`) for the Supabase URL and publishable key, and loads supabase-js only when the installation uses Supabase. The control plane refuses to start with a secret key in place of the publishable one.
- **Why:** A code needs no redirect URLs, works across devices and the same way in a future SwiftUI app, and needs only one template edit in Supabase (`{{ .Token }}` in the Magic Link template). Served configuration means one built client serves any installation. Supabase's built-in mail sender reaches only the project's team members at about two emails an hour, so anyone else needs custom SMTP.

## 2026-11-24: Installations admit listed email addresses, confirmed by Supabase

- **What the plan said:** Nothing specific; the plan assumes the owner's own accounts.
- **What we did:** `BARRACK_ALLOWED_USER_EMAILS` lists the addresses that may use the installation; with Supabase the control plane will not start without it, and admitting everyone takes the explicit value `anyone-who-can-sign-in`. An address counts only once Supabase confirms the user owns it: Supabase's access tokens carry an `email` claim but no trustworthy claim that it was verified (`user_metadata.email_verified` is editable by the user), so the control plane asks `/auth/v1/user` for `email_confirmed_at`, once per user and address while it runs. A refused user gets HTTP 403 `not_allowed` or close code `userNotAllowed`, and the client says why.
- **Why:** Supabase projects accept sign-ups from anyone by default, and every user can spend the operator's sandbox budget. Refusing to start without a list makes admitting everyone a decision rather than an accident. Owners should also turn sign-ups off in Supabase once their users exist.

## 2026-11-24: Users are keyed by the token's subject, with no link to Supabase's tables

- **What the plan said:** Users and threads in Supabase's Postgres.
- **What we did:** Migration 0020 adds `barrack.users` (the token's `sub` as text, and when it was first seen), recorded on a user's first authenticated request by an insert that does nothing on conflict, and `threads.owner_user_id` referencing it. There is no foreign key to `auth.users`. Threads created before sign-in have no owner and are shown to nobody; an operator can give one an owner with one `update`. Nothing had been deployed, so only development databases hold any.
- **Why:** A foreign key to `auth.users` would tie the schema to Supabase, break the tests' plain Postgres and need privileges on Supabase's schema; and a cascade there could not stop sandboxes anyway. Deleting a thread or assigning it silently to whoever signs in first were both worse than hiding it.

## 2026-11-24: A client's access token is its first WebSocket message

- **What the plan said:** Authenticate clients; the transport was left open.
- **What we did:** After the upgrade (`Origin`, when sent, must be allowed; native apps send none), the control plane accepts only an `authenticate` message within 5 seconds, then checks the thread's owner, and only then replays and goes live, so nothing about a thread reaches an unauthenticated or unauthorised client. The client re-sends each refreshed token, which must name the same user; when the newest expires the control plane closes with `accessTokenExpired` (4402), and the client refreshes and reconnects from its last seen sequence. Other new close codes: `notAuthenticated` (4401), `userNotAllowed` (4403), `threadNotFound` (4404), the same for another user's thread as for a missing one.
- **Why:** Browsers cannot set headers on a WebSocket, and a token in the URL ends up in proxy and access logs. A first message carries no ambient credential, so another site cannot ride on the user's session, and works identically from a native app. Closing at expiry costs nothing, since a reconnect replays exactly what was missed.

## 2026-11-24: Access is enforced at one point per transport

- **What the plan said:** Enforce access on the server, not in the client.
- **What we did:** HTTP: one middleware covers all of `/api/*` before any route is added, with an explicit list of public paths, and a test requests every route registered on the app without a token. WebSocket: the relay registry attaches a client only with a `ThreadAccess`, which only the ownership check can create. The thread store lists and finds threads for a user only by owner.
- **Why:** A contributor adding a route is protected without having to remember, and a route that answers without a token fails a test; a new way of connecting clients cannot reach a relay without the ownership check.

## 2026-11-24: A development mode with one fixed user, on loopback only

- **What the plan said:** The local loop should need no cloud account.
- **What we did:** `BARRACK_AUTHENTICATION=development-single-user` gives every client one fixed user, whose token the control plane hands out; `pnpm dev` sets it. The control plane refuses it unless it listens on a loopback address, and refuses no address with Supabase. Running Docker sandboxes locally therefore needs Supabase (or the tests' issuer), since the control plane must listen on Docker's bridge address, which the agents themselves can reach.
- **Why:** The development token is no secret, so whoever can reach the control plane is the user; on loopback that is only the developer's own machine. It keeps development on the same code paths as real sign-in.

## 2026-11-24: Deleting an account is not built yet

- **What the plan said:** Nothing specific; the App Store requires in-app account deletion once the native apps let people create accounts.
- **What we did:** Nothing yet. A user deleted in Supabase keeps their rows and running sandboxes here, and their last access token stays valid until it expires (at most an hour by default).
- **Why:** Deletion must stop and destroy the user's sandboxes, delete their threads and history, delete the Supabase user with a secret key the control plane does not otherwise need, and close their connections. It is needed before the native apps (Milestone 8).

## 2026-11-24: Acknowledged delivery between supervisor and control plane

- **What the plan said:** Every agent event is recorded in order before it is shown; the control plane must recover when it restarts mid-task (Milestone 7).
- **What we did:** Protocol version 2. Every supervisor connection opens with a hello naming the supervisor process (a fresh identifier per process) and how far the agent has been handed user messages; the welcome says which of that process's numbered agent events are recorded. Events stay with the supervisor until confirmed and are resent after every welcome; user messages carry their sequence and are acknowledged. This replaces the earlier best-effort delivery and its outage backlog. Borrowed from Open-Inspect's acknowledgement and resend of critical events and OpenHands' resumable event stream, reduced to two positions per direction.
- **Why:** Railway gives a stopping service no grace by default, so a control plane can vanish with events in flight, and a half-open socket accepts writes that never arrive. Plain acknowledgements and positions are the least that makes delivery exact; nothing here touches stream fragments.

## 2026-11-24: Idempotent recording is enforced by the event log

- **What the plan said:** Nothing specific.
- **What we did:** Supervisor events are stored with their process identifier and number, under a unique index (migration `0010`). A second insert of the same event fails inside the append statement, rolling its sequence back with it, and is reported as already recorded. The in-memory log keeps the same rule.
- **Why:** A supervisor resends anything unconfirmed, and two control plane instances can record one thread for a moment during a deploy; only the store sees both. The migration is numbered `0010` so its name could not collide with migrations written alongside it; what that did not prevent is described under migrations 0010 and 0020 below.

## 2026-11-24: Unconfirmed agent events are kept in memory, not on the sandbox's disk

- **What the plan said:** Nothing should be lost silently.
- **What we did:** The supervisor keeps unconfirmed events in memory only, at most 32 Mi characters of frames. They survive any outage of the control plane, but not the supervisor process dying: what dies with it is the events not yet confirmed, normally a few milliseconds' worth, or everything since a control plane outage began. When the limit is reached the supervisor exits with an error naming how many events it is losing.
- **Why:** A disk journal would need a write and flush per event, truncation on every confirmation and crash-safe reading, to cover only the rare case of a supervisor dying during a control plane outage. Its effect is visible instead: the run that process left open is closed with a message saying work after the last shown step was lost. At the limit, waiting longer would exhaust memory and dropping events would leave a silent gap; exiting is loud, and the run is closed the same way.

## 2026-11-24: How far the agent has been handed user messages is written before each hand-over

- **What the plan said:** Nothing specific.
- **What we did:** The supervisor writes the sequence of the message it is about to hand over to `BARRACK_SUPERVISOR_STATE_DIRECTORY` (in the image `/var/lib/barrack/supervisor`, closed to the agent) before handing it over, ignores redeliveries at or before it, and tells the control plane in every hello. The control plane also stores the furthest acknowledged position, and delivers after the larger of the two.
- **Why:** Pi resumes its session after a supervisor restart, so a message given twice would appear twice in the agent's conversation. Writing first means a supervisor dying between the write and the hand-over loses that one message instead of repeating it. The control plane's own record keeps a fresh sandbox, which has no file, from being handed old messages.

## 2026-11-24: A run left open by a supervisor process that is gone is closed as failed

- **What the plan said:** Clear handling of sandbox failures (Milestone 7).
- **What we did:** The event log remembers which supervisor process opened the run still open. When a supervisor attaches as a different process, the control plane records `agent_failed`, saying that the process supervising the agent stopped mid-run and was replaced and that work after the last shown step was lost. A supervisor that merely disconnects closes nothing, however long it is away; clients show it as not connected.
- **Why:** `agent_failed` already ends a run in every client and says why, and the run did not complete, so `agent_run_settled` would be untrue. Identity, not time, decides, so a long outage never closes a run that is still going. A run whose sandbox never comes back stays open until thread lifecycle (Milestone 3) attaches a new supervisor.

## 2026-11-24: Messages are accepted while no agent is connected

- **What the plan said:** Sandboxes stop when idle and wake when there is work.
- **What we did:** A message sent while no supervisor is connected is recorded instead of refused, and delivered when one attaches. Clients that have authenticated and been found to own the thread are sent `user_message_delivery_status` after their replay and whenever it advances, and the page shows later user messages as waiting for the agent. Sending is blocked only while the thread is loading or its sandbox could not be created.
- **Why:** The next milestone lets a sandbox sleep, and a message is what should wake it. A one-off notice to the sender would be missed by every other device and lost on reconnect; a delivery position is replayed like any status.

## 2026-11-24: Interrupts are delivered at most once

- **What the plan said:** The user can interrupt the agent.
- **What we did:** An interrupt goes only to a supervisor connected at that moment, and is neither stored, acknowledged nor resent; with none connected the user is told so, and that waiting messages will still be delivered.
- **Why:** An interrupt resent after a reconnection would stop whatever the agent was doing by then, which nobody asked for. One lost to a dying connection shows as a run that keeps going, and the user can press again.

## 2026-11-24: Sign-in and acknowledged delivery share protocol version 2

- **What the plan said:** Nothing specific.
- **What we did:** Client sign-in (an `authenticate` first message) and acknowledged delivery were built side by side from the same base and merged together. Both change the protocol incompatibly, and neither had reached a deployed peer, so they share one increment, version 2. The client connection's order of events is specified once, in `client-messages.ts`: nothing before authentication and the ownership check, then the replay, the supervisor's status, the delivery status, the text streamed so far, and live traffic. Close codes keep one meaning each: 4400 for an invalid message or a broken protocol rule, 4401 to 4404 for sign-in and ownership, 4408 for a slow client, 4409 for a superseded supervisor.
- **Why:** A version per feature would only have marked a state that never ran anywhere. A client that receives the delivery status (or anything else) before it is known to own the thread would leak whether the thread exists, so the status starts after the ownership check like everything else.

## 2026-11-24: Migrations 0010 and 0020 were written in parallel

- **What the plan said:** Nothing specific; our migration runner requires the applied migrations to be exactly the build's first ones, in name order.
- **What we did:** Acknowledged delivery added `0010` and sign-in added `0020`, each on its own branch. They touch different tables (`0010` the event log and its counters, `0020` users and threads' owners), so each applies on a fresh database in numeric order regardless of which was written first, and neither was changed when they were merged: changing an applied migration stops the control plane. A database that ran the sign-in branch before the merge has `0001`, `0002` and `0020` applied and no `0010`, and the control plane refuses to start on it, naming both. Only development and test databases can be in that state, so there is no automatic repair. Its operator either drops the schema (`drop schema barrack cascade;`, losing its threads) and lets the control plane migrate afresh, or keeps its threads by applying `0010` by hand and recording it, as the [control plane's README](../apps/control-plane/README.md#migrations-written-in-parallel) shows. A database that ran the acknowledged-delivery branch has `0010` and simply gains `0020`.
- **Why:** Numbering `0010` and `0020` kept the two names from colliding, but not the order check, which exists so that two databases with the same migrations applied always have the same schema. Relaxing it to allow out-of-order application for this one case would weaken that for every later migration.

## 2026-11-24: The control plane records each sandbox's state, and changes it only by compare-and-set

- **What the plan said:** Stopping and resuming threads, automatic shutdown of idle sandboxes and a limit on how many run (Milestone 3); the control plane should own when a sandbox stops; recovery when the control plane restarts mid-task (Milestone 7).
- **What we did:** Each thread records its sandbox as `creating`, `running`, `stopping`, `stopped`, `starting`, `failed` (with a reason; resumable if it still has a sandbox) or `deleting`, with a version. The legal changes are one table in `thread-store.ts`, and every change is an update conditional on the version its caller read and on the current state being one the change is legal from. A destroyed sandbox has no state of its own: deleting removes the thread. A provider operation that fails records the state `getStatus` then reports, with the failure as a `problem` the page shows, and only if that cannot be read is the sandbox recorded `failed`.
- **Why:** Railway may run two instances at once during a redeploy, and a user can press Stop twice; a conditional update lets exactly one of them act, without locks held across slow provider calls. Recording what the provider reports after a failure keeps the record truthful, so the user always has something to do: stop again, resume, or delete.

## 2026-11-24: Operations under way hold a lease, and one whose lease lapses is taken over

- **What the plan said:** Recovery after a control plane restart (Milestone 7).
- **What we did:** `creating`, `starting`, `stopping` and `deleting` carry a lease of two check intervals (60 s by default), renewed four times a lease by the control plane doing the provider call. At startup and every check, an operation whose lease has expired is taken over by compare-and-set and carried on from its provider step. This replaces failing every thread still creating at startup. A creation taken over mints a new token and records its digest before asking for a sandbox; if the provider says the sandbox exists (the first attempt made it), it is adopted and the earlier digest recorded again.
- **Why:** Failing whatever is `creating` at startup failed the creations an old instance was still doing during a redeploy's overlap. A lease an alive instance renews cannot lapse under it, while a killed one's lapses within a minute or two, and every provider operation is safe to repeat, so finishing is better than failing. Timeouts were rejected: a Daytona start from archive can take minutes, and nothing could tell a slow operation from an abandoned one.

## 2026-11-24: Reconciliation trusts the provider for settled sandboxes

- **What the plan said:** Nothing specific.
- **What we did:** Every check compares each `running` sandbox with `getStatus`; at startup, `stopped` and `failed` ones too. A running one the provider reports stopped is recorded stopped, failed is recorded failed (resumable), missing is recorded failed without a sandbox; a stopped or failed one the provider runs is recorded running, with a fresh idle period. Any run a sandbox that stopped by itself left open is closed in history. Transitional provider states are left until they settle.
- **Why:** Running sandboxes cost money and can stop by themselves (a crashed supervisor, a host restart), so they are checked often; nothing but the control plane starts a stopped one, so once at startup is enough. Recording a running sandbox as running, rather than stopping it again, never kills work a lost answer hid, and idle shutdown stops it if it is idle.

## 2026-11-24: A sandbox idle for ten minutes, with no run open and nothing to deliver, is stopped

- **What the plan said:** Automatic shutdown of idle sandboxes; an open question asks for the right idle period.
- **What we did:** Idle means no user message and no agent event for `BARRACK_SANDBOX_IDLE_MINUTES` (default 10), and right now no run open and no user message waiting to be delivered. Activity is noted in the thread's row before the message or event is recorded (agent events at most once a minute, or a quarter of the idle period, per thread). A client merely watching is not activity. The stop is a compare-and-set that also requires the last activity to be the one read. `SandboxLifecycle.recordAgentActivity` is where the live desktop will count as activity.
- **Why:** Ten minutes is Open-Inspect's default and covers a short break, while waking costs seconds (Docker) to a minute or two (Daytona restoring an archive) and loses nothing: files and Pi's session are kept and history is in the control plane. An open run is never cut short, since a build can print nothing for minutes; a hung agent therefore keeps its sandbox until stopped by hand, which is the safer error. Counting a watching client, as Open-Inspect does, would let a forgotten tab keep a sandbox billing for ever, and watching needs only the control plane. Deciding from the database alone makes it survive restarts and work with two instances.

## 2026-11-24: A message wakes a stopped sandbox

- **What the plan said:** The per-thread computers wake when there is work.
- **What we did:** Before a user message is recorded, the lifecycle admits it: a stopped sandbox is moved to `starting` and started, a stopping one is asked (a flag on the thread) to start again once it has stopped, and the message waits in history and is delivered when the supervisor attaches. While a sandbox is stopping, its supervisor is handed no new messages, which it would only lose. A message to a thread being deleted is refused. A failed sandbox is not woken by a message; the user resumes it.
- **Why:** The user should never have to press Resume first. Holding messages back from a supervisor being stopped means each reaches an agent that will answer it.

## 2026-11-24: At most three running sandboxes per user, and optionally per installation

- **What the plan said:** A limit on how many run concurrently; per-user concurrency limits (Milestone 7).
- **What we did:** Creating, resuming and waking a sandbox are refused when the user already has `BARRACK_RUNNING_SANDBOXES_PER_USER` (default 3) sandboxes creating, running, starting or stopping, or the installation `BARRACK_RUNNING_SANDBOXES_IN_TOTAL` (unset by default). The refusal is `409 sandbox_limit_reached`, or a rejected message, naming the user's sandboxes taking a place, so the user knows which to stop. The count and the change are one transaction behind an advisory lock.
- **Why:** Three is what Milestone 3 must show running at once, and about what the smallest Daytona tier's storage holds. A stopping sandbox still holds its resources for a moment, so it counts, and the message says to wait for it. The installation-wide limit is the smallest honest answer to a provider account's own limits shared by several users: without it, the provider's refusal would surface only as a failed creation.

## 2026-11-24: A thread's title is its first message's first line

- **What the plan said:** A thread list.
- **What we did:** The first line with any text of the first user message, whitespace collapsed, cut at a word boundary to 80 characters with an ellipsis, stored on the thread when that message arrives. Until then the page calls it "New thread". The list shows the title, the sandbox's state, whether the agent is working (from the event log's counter row) and when it was last active, most recently active first.
- **Why:** The first line is usually the task's summary, and storing it means listing threads reads no events. The list's query is one indexed read of the user's threads and one of their counter rows.

## 2026-11-24: Deleting a thread removes it and its history for good

- **What the plan said:** Nothing specific; stopped Daytona sandboxes still cost storage until archived and count against quota.
- **What we did:** `DELETE /api/threads/{threadId}` (from running, stopped or failed) moves the thread to `deleting`, destroys its sandbox, then removes its history and its record, and disconnects anyone watching. The client confirms first. Deleting while a sandbox is starting or stopping is refused until that finishes. A destroy that fails leaves the state the provider reports, with the reason.
- **Why:** Users need a way to free storage and quota. Refusing while another operation is under way keeps two provider operations from racing on one sandbox; destroying first, and removing the record last, means a crash leaves a `deleting` thread whose lease lapses and whose deletion is finished, never a sandbox nobody knows of.

## 2026-11-24: Local-process sandboxes outlive the control plane's process

- **What the plan said:** The provider boundary: create, start, stop, destroy, and their state.
- **What we did:** The interface is unchanged; the contract suite gains a guarantee every provider meets: a provider made afresh finds, stops and starts sandboxes an earlier one created. Docker and Daytona met it already. The local-process provider now keeps each sandbox's record and its supervisor's process identifier in the sandbox's directory, and the fake can be reopened over the same sandboxes.
- **Why:** Reconciliation asks the provider what is true; the local-process provider kept everything in memory and, after a restart, reported every sandbox missing, which would have failed threads whose supervisors were still running.
