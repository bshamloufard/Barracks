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
- **Superseded** by "run-as-agent is a program of our own that can become the agent and no one else" below, which keeps the file capabilities and narrows what they can do.

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
- **What we did:** These are known and not yet closed. (1) Closed: the token was in the sandbox's environment (the container's, and on Daytona the sandbox's `envVars`), so anything started with `docker exec` or a provider's command interface inherited it, including as the agent's user; it is now a file only the supervisor's user can read (see "A supervisor's secrets are files only its user can read" below). (2) Closed: `run-as-agent` could switch to any user, so the supervisor's user was effectively root in the container; it is now a program that can only become `barrack-agent` (see "run-as-agent is a program of our own that can become the agent and no one else" below). (3) None of this has been examined on Daytona, whose own processes and command interface may offer the agent a way round; fix: examine and test it there before relying on it. (4) There was no user sign-in, so anyone who could reach the control plane controlled every thread; closed by Supabase sign-in and per-user access checks on the server (see the entries below).
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

## 2026-11-24: The control plane waits for Supabase's key set before it listens

- **What the plan said:** Nothing specific; the control plane is always on.
- **What we did:** At startup the control plane reads the project's key set before it listens. Only a definite answer that the project publishes no asymmetric key (a key set without one) fails the start; no connection, a timeout, an error status or a page that is not a key set is logged, without secrets, and retried with backoff from one second, doubling to at most thirty, for as long as it takes, as the database is.
- **Why:** Railway restarts a failed service only a bounded number of times, so exiting during a short Supabase outage would leave the service down after Supabase came back. Listening before the check passes would gain nothing: no token can be verified without the key set, and a health check that keeps failing stops a new deployment replacing a working one. A wrong `BARRACK_SUPABASE_URL` is retried too, since from outside it can look like an outage; each attempt's log says to check it.

## 2026-11-24: Development mode answers only requests addressed to loopback

- **What the plan said:** Enforce access on the server. An earlier entry limited development mode to a loopback listening address.
- **What we did:** In development mode the control plane refuses, with `403 forbidden_host`, every HTTP request and WebSocket upgrade whose `Host` is not `localhost`, an address in `127.0.0.0/8` or `[::1]`, with any port, on every path including `/health` and the web client's files. The rule follows from the authentication in effect rather than a setting of its own, so nothing can run development mode without it. The supervisor endpoint is not exempt: in development mode the control plane listens only on loopback, so the only sandboxes that can reach it, the local-process provider's, do so by `127.0.0.1`; Docker sandboxes need a non-loopback address and therefore Supabase or the tests' issuer, where the rule does not apply.
- **Why:** A loopback listening address keeps other machines out but not a web page that re-points its own domain at 127.0.0.1 (DNS rebinding): the browser then sends its GET requests without `Origin` and lets the page read the thread list, and the development token is handed to anyone who asks. The `Host` header still carries the page's domain, and no page can change it. The same check refuses non-browser clients that reach a development control plane through a proxy keeping the original `Host`, which, with the local-process provider, would otherwise be code execution on the developer's machine. With Supabase the control plane must answer under any domain, and the access token protects it.

## 2026-11-24: A client that has not authenticated may send only what authenticating needs

- **What the plan said:** Validate anything that crosses a boundary.
- **What we did:** Until a client connection is authenticated and found to own its thread, the control plane counts the bytes it receives on the connection's socket and destroys the connection once they exceed the largest `authenticate` message (the longest token with every character escaped as `\uXXXX`, plus a kilobyte: about 97 KiB); and it refuses unparsed any frame larger than that. Once attached, the general frame limit applies. The supervisor endpoint is unchanged: its thread's token is checked before the upgrade is accepted, so no frame on it comes from a peer without that thread's credential.
- **Why:** `ws` holds each frame whole before emitting it, and takes `maxPayload` from the server, the same for every connection, with no way to lower it for one ([its documentation](https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketserveroptions-callback)). The protocol's 4 Mi character frames (up to 12 MiB of UTF-8) are needed by supervisors, so anyone able to open a client connection could make the control plane buffer and parse megabytes per connection without a token. Counting the socket's bytes bounds what `ws` holds to the limit plus the one read that crosses it; a separate server with a smaller `maxPayload` for clients would still have let an unauthenticated client send the largest user message.

## 2026-11-24: The agent shares the supervisor's user only when that is chosen by name

- **What the plan said:** Connections between sandbox and control plane must be authenticated per thread, so that one sandbox cannot impersonate another; treat everything inside a sandbox as untrusted.
- **What we did:** The supervisor starts Pi as the supervisor's own user only with `BARRACK_AGENT_SHARES_SUPERVISOR_USER=development-only`. Without it, a missing `BARRACK_AGENT_USER`, or one that is the supervisor's own user by name or ID, stops the supervisor at startup with a message naming the variable and both ways to fix it. The local-process provider sets the variable itself, since it has no second user and already requires declaring development use; the Daytona provider passes `BARRACK_AGENT_USER=barrack-agent` explicitly; the Docker provider relies on the image's environment, which Docker always applies, and a container started with its user overridden is refused by the supervisor.
- **Why:** An agent of the same user reads the supervisor's token from `/proc` and can then act as the thread's supervisor. Before, that happened silently whenever the variable was missing, which a platform that does not pass the image's environment to its processes (not yet checked on Daytona) or a user override would cause. A separate variable with one accepted value, like `BARRACK_ALLOW_UNISOLATED_SANDBOXES`, makes the choice explicit without a magic user name.

## 2026-11-24: Compose names the sandboxes' bridge so the host can refuse the cloud metadata address

- **What the plan said:** Give sandboxes the fewest credentials possible; treat everything inside a sandbox as untrusted.
- **What we did:** The `barrack-sandboxes` network's bridge interface is named `barrack-sandbox`, and the deployment guide gives one host rule, `iptables -I DOCKER-USER -i barrack-sandbox -d 169.254.169.254 -j REJECT`, with a warning to apply it on any cloud VM. Tested here with Docker 29.9's iptables backend: the address answered a sandbox before and was refused after, for root and an unprivileged user, while the internet still answered, and the rule outlived recreating the network. The guide also now says exactly what the socket proxy allows: start, stop, wait for, remove and inspect any container by its full ID, not only sandboxes, an earlier entry and the guide having said otherwise.
- **Why:** On most clouds the metadata address hands out the machine's credentials, and a sandbox reached it. Docker has no per-network way to refuse one destination: an `internal` network would cut the internet agents need, and a rule inside the container needs `NET_ADMIN`, which sandboxes do not get. `DOCKER-USER` is the chain Docker reserves for such rules and never flushes, and a fixed interface name lets one rule cover sandboxes alone. The proxy matches only paths, offers no filter on the target container's labels, and `docker run` starts and waits by ID, so the rules cannot be narrowed to sandboxes; that the control plane cannot list containers, and so knows only the IDs it created and its own, is what keeps it to them.

## 2026-11-24: The control plane records each sandbox's state, and changes it only by compare-and-set

- **What the plan said:** Stopping and resuming threads, automatic shutdown of idle sandboxes and a limit on how many run (Milestone 3); the control plane should own when a sandbox stops; recovery when the control plane restarts mid-task (Milestone 7).
- **What we did:** Each thread records its sandbox as `creating`, `running`, `stopping`, `stopped`, `starting`, `failed` (with a reason; resumable if it still has a sandbox) or `deleting`, with a version. The legal changes are one table in `thread-store.ts`, and every change is an update conditional on the version its caller read and on the current state being one the change is legal from. A destroyed sandbox has no state of its own: deleting removes the thread. A provider operation that fails records the state `getStatus` then reports, with the failure as a `problem` the page shows, and only if that cannot be read is the sandbox recorded `failed`.
- **Why:** Railway may run two instances at once during a redeploy, and a user can press Stop twice; a conditional update lets exactly one of them act, without locks held across slow provider calls. Recording what the provider reports after a failure keeps the record truthful, so the user always has something to do: stop again, resume, or delete.

## 2026-11-24: Operations under way hold a lease, and one whose lease lapses is taken over

- **What the plan said:** Recovery after a control plane restart (Milestone 7).
- **What we did:** `creating`, `starting`, `stopping` and `deleting` carry a lease of two check intervals (60 s by default), renewed four times a lease by the control plane doing the provider call. At startup and every check, an operation whose lease has expired is taken over by compare-and-set and carried on from its provider step. This replaces failing every thread still creating at startup. A creation taken over mints a new token and records its digest before asking for a sandbox; if the provider says the sandbox exists (the first attempt made it), it is adopted and the earlier digest recorded again.
- **Corrected (third review):** An operation whose lease was taken carried on: a creation that finished after a take-over found its record changed and destroyed "its" sandbox, which the taker had just adopted, leaving a thread recorded running on a destroyed sandbox. Now an operation checks its lease once more when the provider call returns, as well as at each renewal; one that has lost it tries the provider no more, records nothing and removes no history. A creation destroys the sandbox it made only when that is certain to be its alone: the thread is gone, or settled without naming it; while another control plane holds the creation, the sandbox is left for it to adopt. A deletion checks its lease again before removing history, since a taker whose destroy failed keeps the thread.
- **Why:** Failing whatever is `creating` at startup failed the creations an old instance was still doing during a redeploy's overlap. A lease an alive instance renews cannot lapse under it, while a killed one's lapses within a minute or two, and every provider operation is safe to repeat, so finishing is better than failing. Timeouts were rejected: a Daytona start from archive can take minutes, and nothing could tell a slow operation from an abandoned one.

## 2026-11-24: Reconciliation trusts the provider for settled sandboxes

- **What the plan said:** Nothing specific.
- **What we did:** Every check compares each `running` sandbox with `getStatus`; at startup, `stopped` and `failed` ones too. A running one the provider reports stopped is recorded stopped, failed is recorded failed (resumable), missing is recorded failed without a sandbox; a stopped or failed one the provider runs is recorded running, with a fresh idle period. Any run a sandbox that stopped by itself left open is closed in history. Transitional provider states are left until they settle.
- **Why:** Running sandboxes cost money and can stop by themselves (a crashed supervisor, a host restart), so they are checked often; nothing but the control plane starts a stopped one, so once at startup is enough. Recording a running sandbox as running, rather than stopping it again, never kills work a lost answer hid, and idle shutdown stops it if it is idle.

## 2026-11-24: A sandbox idle for ten minutes, with no run open and nothing to deliver, is stopped

- **What the plan said:** Automatic shutdown of idle sandboxes; an open question asks for the right idle period.
- **What we did:** Idle means no user message, no agent event and no publication under way for `BARRACK_SANDBOX_IDLE_MINUTES` (default 10), and right now no run open and no user message waiting to be delivered. Activity is noted in the thread's row before the message or event is recorded (agent events at most once a minute, or a quarter of the idle period, per thread). A client merely watching is not activity. A publication notes activity when it starts and every 30 seconds until it ends, since a sandbox quiet for nearly the idle period could otherwise be stopped while it makes the bundle (found by the third review). The stop is a compare-and-set that also requires the last activity to be the one read. `SandboxLifecycle.recordAgentActivity` is where the live desktop will count as activity.
- **Why:** Ten minutes is Open-Inspect's default and covers a short break, while waking costs seconds (Docker) to a minute or two (Daytona restoring an archive) and loses nothing: files and Pi's session are kept and history is in the control plane. An open run is never cut short, since a build can print nothing for minutes; a hung agent therefore keeps its sandbox until stopped by hand, which is the safer error. Counting a watching client, as Open-Inspect does, would let a forgotten tab keep a sandbox billing for ever, and watching needs only the control plane. Deciding from the database alone makes it survive restarts and work with two instances.

## 2026-11-24: A message wakes a stopped sandbox

- **What the plan said:** The per-thread computers wake when there is work.
- **What we did:** Before a user message is recorded, the lifecycle admits it: a stopped sandbox is moved to `starting` and started, a stopping one is asked (a flag on the thread) to start again once it has stopped, and the message waits in history and is delivered when the supervisor attaches. While a sandbox is stopping, its supervisor is handed no new messages, which it would only lose. A message to a thread being deleted is refused. A failed sandbox is not woken by a message; the user resumes it.
- **Why:** The user should never have to press Resume first. Holding messages back from a supervisor being stopped means each reaches an agent that will answer it.

## 2026-11-24: At most three running sandboxes per user, and optionally per installation

- **What the plan said:** A limit on how many run concurrently; per-user concurrency limits (Milestone 7).
- **What we did:** Creating, resuming and waking a sandbox are refused when the user already has `BARRACK_RUNNING_SANDBOXES_PER_USER` (default 3) sandboxes creating, running, starting or stopping, or being deleted while they still have a sandbox (added after the third review: a destroy that fails returns the thread to the state the provider reports, so deleting and creating anew was a way past the limit), or the installation `BARRACK_RUNNING_SANDBOXES_IN_TOTAL` (unset by default). The refusal is `409 sandbox_limit_reached`, or a rejected message, naming the user's sandboxes taking a place, so the user knows which to stop. The count and the change are one transaction behind an advisory lock.
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

## 2026-11-24: A supervisor that floods its thread is disconnected, not slowed down

- **What the plan said:** Treat everything inside a sandbox as untrusted.
- **What we did:** What a thread's supervisors have sent and the relay has not yet handled is counted, in characters of its frames, per thread. Past the supervisor's own limit on unconfirmed events plus one frame (36 Mi characters), the connection is closed with 1013 and the message dropped; what was queued before it is still recorded. Stream fragments get a separate 1 Mi budget and are dropped past it, along with the rest of that message's fragments. A thread accepts at most four supervisor connections at once.
- **Why:** The relay queued every frame without limit, so a compromised sandbox could grow the control plane by hundreds of megabytes while one append was slow (a test grew it by 639 MiB with 150 large frames; it now grows by about 90 MiB, most of it frames on their way to being refused) and take every thread down. Pausing the socket instead was rejected: it would also stop pongs being read, so the heartbeat would drop the supervisor anyway, under a misleading reason. Disconnecting loses nothing durable, since a supervisor keeps every event until it is confirmed and resends them all on reconnecting; and an honest supervisor never reaches the bound, because it never has more than its unconfirmed limit in flight. The limit is shared from the protocol package so the two cannot drift apart.

## 2026-11-24: A thread accepts every supervisor token minted for its creation

- **What the plan said:** Connections between sandbox and control plane must be authenticated per thread.
- **What we did:** A thread records the digest of the token minted with it, and adds one more each time its creation is taken over from a control plane that has gone (migration `0050`). A supervisor presenting any of them is let in. An adopted sandbox is started, which launches its supervisor if it is not running.
- **Why:** A take-over must mint a new token, since the earlier one was never stored, and record it before asking the provider, or a sandbox made with it could never connect. But when the provider answers that the thread's sandbox already exists, nothing says which attempt made it: the take-over's own first request may have gone through while seeming to fail, or an earlier take-over may have been cut short after recording its token. Restoring the previous digest, as before, locked out the supervisor in both cases, leaving a thread recorded running whose agent could never connect. Destroying the found sandbox and making a new one was rejected, since its agent may already have worked on the user's first message. Every token in the list was only ever handed to this thread's sandbox through the provider, so accepting them all lets no other sandbox in.

## 2026-11-24: A user message carries an identifier its client mints, recorded once per thread

- **What the plan said:** Event ordering and replay are what must not break.
- **What we did:** `send_user_message` carries a `messageId` the client mints once per composed message (128 random bits, checked against a fixed shape and length) and reuses on every retry. The event log records a user message once per thread and identifier, enforced by a unique index inside the append (migration `0060`); a second append records nothing and returns the event recorded first, which the relay broadcasts, so clients that missed it see it and the supervisor is handed it if it never was. A rejection names the refused message. The page keeps each message until its thread event arrives and offers to send it again or discard it. The change came in alongside working with a repository, so protocol version 3 (below) covers it; alone, it would not have raised the version.
- **Why:** An append can commit after the database connection reported a timeout; the user was told the message was not saved, sent it again, and the agent received it twice. Only an identifier chosen before the first attempt can tell a retry from a new message. The control plane minting it was rejected, since the retry is a new request it cannot connect to the first. Supervisors are unaffected by this change, so on its own it would not have raised the version, which turns every running supervisor away; a page left open from before is told to reload.

## 2026-11-24: Closing a run on the control plane's initiative is one conditional append

- **What the plan said:** Every `agent_run_started` is followed by exactly one end.
- **What we did:** The event log's plain `append` is gone. A run nobody else can end is closed with `closeOpenRun(thread, run, event)`, which appends the `agent_failed` only if the run opened by the named supervisor instance is still the open one, in one statement in Postgres (an update conditional on the counter row, which re-checks after waiting for another's lock) and one step in memory. The relay uses it for a run an earlier supervisor abandoned; stops, failed operations and reconciliation read which run is open before they record the sandbox's new state at their version, and close that run afterwards.
- **Why:** Checking that a run was open and then appending were two steps, so two control planes (during a redeploy's overlap, a supervisor reconnecting to the other instance, say) or a stop racing the agent's own end of its run, attached elsewhere, could each record an end. Naming the run by its opener also keeps a late close from ending a run a woken sandbox has opened since. An end the supervisor itself sends after the control plane closed its run is still recorded, since its delivery must be acknowledged; that needs the supervisor to outlive its sandbox's stop, which a completed stop rules out.

## 2026-11-24: A redeploy always runs two control planes at once, and each shared part is safe for it

- **What the plan said:** Control plane hosting on Railway.
- **What we did:** Corrected `.railway/railway.ts`, which said no overlap kept two instances apart, and documented in [deployment](deployment.md#two-instances-at-once) what each shared part does while two run. The settings are unchanged: no overlap, a 120-second drain, one replica.
- **Why:** Railway routes traffic to a new deployment only once its health check passes, and stops the old one only then (Railway's [health check](https://docs.railway.com/deployments/healthchecks) and [teardown](https://docs.railway.com/deployments/deployment-teardown) documentation), so the new instance has migrated the database and started sweeping while the old one still serves, and the old one keeps working while it drains. `overlapSeconds: 0` only removes the extra wait before SIGTERM. Checked against the code: versioned transitions, renewed leases, the conditional idle stop, the keyed appends and the conditional close of a run make sandbox operations and history safe with two instances; migrations are serialised by a lock but run while the old release serves, so they must stay backward compatible for one release. What remains is a moment in which a supervisor and a browser can be on different instances, which delays a message or skips an interrupt but loses nothing.

## 2026-11-24: A stop that reports failing but stopped the sandbox counts as a stop

- **What the plan said:** Stop and resume without losing the user's work or messages.
- **What we did:** When the provider's stop throws (other than for a missing sandbox), the stop asks the provider for the sandbox's state; if it is stopped, the stop is finished as a successful one: the run left open is closed, and the thread becomes `stopped`, or `starting` if a message asked for a wake meanwhile.
- **Why:** Recording `stopped` through the general failure path cleared the wake request with the state change, so a message sent while the sandbox was stopping waited for an agent nothing would start. A stop whose answer was lost did what was asked, so treating it as done is both truthful and what keeps the message moving.

## 2026-11-24: A deleted thread's history is removed again behind the relay's queue

- **What the plan said:** Nothing specific; deleting a thread removes it and its history for good.
- **What we did:** After the thread's record is removed, its history is removed through the thread's relay queue, after whatever the relay was already doing, rather than straight away; with no relay for the thread on this control plane it is removed at once.
- **Why:** A user message admitted just before the deletion began could be appended after both removals, leaving history rows for a thread that no longer exists, against what deleting promises. In the queue the removal follows that append, and a message queued later is refused because the thread is gone. The same race through another control plane instance, possible only during a redeploy's overlap, is not covered; closing it would need the append to check the thread's record in the same statement, coupling the event log to the threads table, which was not worth it for that window.

## 2026-11-24: A message the limit keeps from waking a sandbox is refused, kept by the page, and never left waiting unexplained

- **What the plan said:** Per-user concurrency limits; users see what their agents are doing.
- **What we did:** Checked what a user sees when a message would wake a stopped sandbox but the running-sandbox limit refuses: the message is not recorded, and the rejection says which limit, that the message was not sent, and which of the user's sandboxes to stop. Two gaps were fixed. The page used to clear the message box on sending, losing the text of a refused message; it now keeps the message, marked not sent, with Send again and Discard. And a message whose wake lost three races in a row was recorded with no wake; it is now refused like any other that cannot be delivered. A message that does wait while its sandbox is stopped or failed (a start that failed after a wake, say) is shown with "Resume the thread to deliver this message" rather than as merely waiting, so a page opened later explains it too.
- **Why:** Refusing at the moment of sending, with the remedy named, beats recording a message for an agent that cannot start: on a later reload there is then nothing waiting to explain. Where something does wait, the conversation is the one place a returning user looks.

## 2026-11-24: A thread starts from at most one repository, public or through a GitHub App

- **What the plan said:** Add working with a Git repository: clone at the start, and push a branch or open a pull request at the end. Repository access should be limited to the repositories the user chose.
- **What we did:** A thread may name one repository by its HTTPS URL, a base branch (the default branch if left out), and how it is reached: `none`, a public repository cloned with no credential, from which nothing can be published; or `github_app`, one of the user's repositories through the installation's GitHub App. URLs with credentials, queries, fragments, percent-encoding or `..`, and every scheme but `https`, are refused; `http` is accepted only with `BARRACK_ALLOW_PLAIN_HTTP_REPOSITORIES=development-only`, which the tests' Git server needs. The repository is written in the same transaction as the thread (migration 0040), so no sandbox is made without the repository it was asked for. Other hosts are not built; the model leaves room for them (the bundle and push are host-agnostic, only token minting, linking and pull requests are GitHub's).
- **Why:** One repository keeps credentials to one repository per sandbox. A public repository needs nothing from Barrack to clone, and offering it costs nothing; publishing needs a way to write, which only the App provides.

## 2026-11-24: The sandbox gets only a read-only token for its one repository, by asking

- **What the plan said:** Give sandboxes the fewest credentials possible, scoped as narrowly as possible; open question: the simplest safe way to give a sandbox access to a private repository.
- **What we did:** Git in the sandbox has a credential helper, run as the agent, that asks the supervisor on a Unix socket (in the image, a directory only the agent's group may enter), which asks the control plane on its authenticated socket. The control plane takes the repository from the connection's thread, never from the request, checks that the owner's GitHub link still lists it, and answers with an installation token restricted to that repository and to `contents: read` (GitHub adds `metadata: read`; an answer granting anything else is refused). Tokens are reused while they have more than fifteen minutes left; a sandbox may ask 30 times at once and once every two seconds after, and once GitHub refuses a mint for a thread it is not asked again for that thread for a minute. Nothing stores the token: not the clone's configuration, a URL, an argument, a log or an event, which the tests check by searching for it.
- **Why:** This is the research's recommendation, and the agent can ask the helper as well as Git can, so whatever the helper returns must be assumed to be the agent's. **What an agent holding it can still do:** read the whole repository (it can already read the checkout, and its partial clone fetches the rest on demand) and its history, including any secret ever committed, for the hour the token lives, and ask for another while its sandbox runs; and send all of it anywhere its network reaches. It cannot write anything on GitHub: no push to any branch, no tag, no release, no pull request. A user who disconnects GitHub, or reconnects without the repository, stops new tokens; so does losing access on GitHub itself (see "Read tokens are minted only after GitHub confirms the owner can still read"). A thread whose repository the App loses can still work on what it cloned, but cannot fetch, and cannot publish.

## 2026-11-24: Read tokens are minted only after GitHub confirms the owner can still read

- **What the plan said:** Repository access should be limited to the repositories the user chose; a user can only ever reach their own.
- **What we did:** Before each read token is minted for a sandbox (about twice an hour while it is busy, since tokens are reused until a quarter of an hour before they expire), the control plane asks GitHub, as it does before creating a thread or publishing, whether the App still reaches the repository and whether the owner can still read it (`checkLiveRepositoryAccess`, which now tells "GitHub said no" from "GitHub could not be asked"). If GitHub says no, the token handed out last is revoked and the request refused, naming the reason, which the agent's Git prints; the thread keeps running on what it cloned, cannot fetch, and cannot publish. If GitHub cannot be asked (an outage, a timeout, a rate limit), no token is minted, but the one handed out last, which the sandbox already holds, is given again while it has a minute left, so a brief outage does not stop a working thread; past that, requests are refused saying GitHub could not be asked. Either refusal is not retried with GitHub for a minute.
- **Why:** Only the link stored when the user connected was checked, so someone removed from an organisation kept getting fresh tokens for an old thread's repository for as long as the thread ran. Asking at each mint costs two GitHub requests an hour per busy thread; asking at every request would cost one per Git operation. Treating an unanswered question as "no" for minting is failing closed; handing out again a token the sandbox already has gives away nothing new.

## 2026-11-24: Publishing is the control plane's, from a bundle it treats as hostile

- **What the plan said:** Push a branch or open a pull request at the end.
- **What we did:** The user's **Push branch** or **Open pull request** makes the control plane check with GitHub that the owner may still push, ask the supervisor for `git bundle create - <base>..refs/heads/barrack/<thread>` (made as the agent, at most 100 MB, within two minutes), uploaded over HTTP with the supervisor's token to an address valid for that one publication, and then, in a throwaway bare repository with no configuration read, hooks off and only HTTPS allowed: read the header itself (one reference, the work branch; SHA-1; not filtered), fetch the base branch without contents, `git bundle verify`, index the pack with `--fsck-objects`, fetch the one branch, and push it to `barrack/<thread>` with a write token for that one repository, decided by ancestry and carrying Git's lease on the branch as it was read (see "Publishing moves the branch by ancestry" below; this entry first described a rule by commit identity, which a review showed let an agent overwrite someone else's commit). A branch already at the commit being published is taken as published, without being recorded as Barrack's push; and a recorded pull request is kept by later publications that opened none. A pull request is opened as the App at most once per thread; later publications move its branch. Outcomes are thread events, each recorded at most once, keyed by an identifier the control plane mints for the publication (migration 0070), since the event log takes no append without a key.
- **Why:** With the write token in the control plane only, nothing the agent does can reach any branch but its own, and only when the user asks. The upload travels over HTTP rather than the supervisor's socket because a bundle can be far larger than a frame (4 Mi characters, a third of that in binary as base64) and would hold up the thread's events, and because a publication is a request that can simply be retried, so it needs no acknowledged delivery. The research flagged two things as unverified, both checked: a thin bundle verifies, fetches and pushes from a partial (blobless) clone, fetching any delta base it needs; but `git fetch` from a bundle does **not** check objects even with `fetch.fsckObjects` and `transfer.fsckObjects` set (Git 2.43; it took a tree containing `.git/hooks`), so the pack is checked with `index-pack --fsck-objects` first.

## 2026-11-24: Publishing moves the branch by ancestry, and replaces only Barrack's own push

- **What the plan said:** Push a branch at the end; treat the agent's output as untrusted.
- **What we did:** The control plane fetches the work branch as it is in the repository (its history, without contents) and decides (`push-decision.ts`): a branch that does not exist is created; a fast-forward is always pushed, whoever made what is there; anything else is pushed only over `replaceable_commit` (migration 0090), Barrack's own last push while nothing anyone else pushed lies beneath it. A push sets it to the new commit when the branch was absent or at it, and clears it when the push went on top of someone else's commit; a branch already at the commit being published changes nothing. When Git cannot tell whether one commit is an ancestor of the other, nothing is pushed. Every push carries Git's lease on the commit read, so one made by someone between the decision and the push fails it with a message saying so. Rows from before have no replaceable commit, so those threads can add to their branches but not rewrite them.
- **Why:** The rule by identity recorded whatever commit it found at the branch's tip as Barrack's: an agent could fetch a person's commit with its read token, publish exactly it (no push needed, so it was recorded), then rewrite the branch and publish again, and the lease on that commit passed, overwriting it. It also refused a plain fast-forward on top of a person's commit, the one case that loses nothing. Clearing the replaceable commit after a push on top of someone else's closes the same attack one step longer (build on their commit, publish, then rewrite both away). A second column, rather than changing what `last_published_commit` means, keeps the thread summary's "last pushed" true.

## 2026-11-24: The write token is offered to the repository's own URL alone, and redirects are not followed

- **What the plan said:** Give sandboxes the fewest credentials possible, scoped as narrowly as possible; secrets never leave where they belong.
- **What we did:** The control plane's credential helper is configured as `credential.<remote URL>.helper` with `credential.useHttpPath=true`, so Git asks it only for that scheme, host, port and path, and `http.followRedirects=false`, so a redirect fails the command. Both are from Git's documentation ([gitcredentials](https://git-scm.com/docs/gitcredentials), [`http.followRedirects`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-httpfollowRedirects)) and checked with Git 2.43: before, a remote answering with a redirect to another host had that host sent the write token.
- **Why:** The helper answered for any host, and Git's default follows a redirect on the first request of a fetch or push, so whoever could make the repository's address redirect (a compromised mirror, a misconfigured proxy, a test server) would receive a token able to push. Publishing a thread whose repository was renamed since, which GitHub redirects, now fails with Git's message; a new thread on the new address works. That is rare, and visible.

## 2026-11-24: Deleting a thread abandons its publication; stopping its sandbox ends the wait for the bundle

- **What the plan said:** Deleting a thread removes it and its history for good.
- **What we did:** When a deletion begins (`SandboxOperations` calls `ThreadRuns.prepareForDeletion`), the relay registry tells the publisher, which stops waiting for the thread's bundle, kills any Git it is running (an abort signal kills Git's process group), skips the push and the pull request, and records nothing, answering the user that the thread is being deleted. Before it pushes and before it records, it also reads the thread's record and gives up if it is gone or `deleting`, which covers a deletion begun before the publication was registered, or through another control plane. When a stop begins, a publication still waiting for the bundle fails at once with "The thread's sandbox is stopping…", recorded like any failure; one that has the bundle carries on, since the sandbox is no longer needed.
- **Why:** Publish then Delete left the publication waiting out its three minutes, then recorded its failure into the deleted thread's history through a relay made afresh for it; had the bundle arrived first, the branch would have been pushed for a thread that no longer exists. A stopped sandbox will never send its bundle, so waiting for it only delays the answer. A publication that already holds its bundle is the user's request, unaffected by the sandbox stopping, so it is finished. A deletion through another instance in the moment between the record being read and the push or the append is not covered, the same narrow window documented for a user message.

## 2026-11-24: The thread's branch lives in the user's repository, so their CI runs the agent's code

- **What the plan said:** Treat everything inside a sandbox as untrusted, including the agent's output.
- **What we did:** Nothing in Barrack stops this; the deployment guide tells operators what to set on GitHub. `barrack/<thread>` is a branch of the repository itself, so workflows triggered by `push` or `pull_request` run the agent's code with the secrets GitHub gives branches of the repository, which a fork's pull request would not get. The App has no `workflows` permission, so a publication that changes `.github/workflows` is refused by GitHub, but the agent can change any script an existing workflow runs. The pull request is opened by the App, so the user who asked can approve it alone.
- **Why:** Pushing to a fork would avoid it, at the cost of creating and keeping forks for every user, which needs more of the App than it should have. Until then, environment-protected secrets with required reviewers, or keeping secret-holding workflows off `barrack/*`, is the mitigation; branch protection on the default branch is the user's guard against everything else.

## 2026-11-24: GitHub links are made by the user who started them, from GitHub's own answers

- **What the plan said:** Nothing specific; the brief asked for a signed, single-use state bound to the user, and never trusting an installation identifier from a redirect.
- **What we did:** The state is 32 random bytes, kept as its SHA-256 with the user and a PKCE verifier for ten minutes, and removed on first use whoever presents it; it is not signed. The callback is a page of the web client, which finishes the link with the user's own access token, so a state another user started, or one replayed or expired, is refused. The control plane reads the user, their installations of the App and the repositories they can push to with the user's token, stores that list, and revokes the token before answering. The App is registered with "Request user authorization during installation" off, since GitHub then redirects without Barrack's state, and with the Setup URL pointing at Settings, where the user connects. GitHub's manifest flow was considered for registration and not used: it hands the App's key to a page of the registering application, which would then have to store or display it, for something done once.
- **Why:** A state stored on the server is unguessable, bound to a user and single-use without a signing key to configure and rotate; a signed one would still need the server-side record to be single-use. Finishing the link with the user's bearer token, rather than on a redirect that carries no credential, is what binds the GitHub account to the right Barrack user, and GitHub's documentation warns that the setup URL's `installation_id` can be spoofed.

## 2026-11-24: A partial clone, onto Barrack's own branch, authored by the user

- **What the plan said:** Nothing specific; the brief asked for a decision on the kind of clone and the commit identity.
- **What we did:** The supervisor clones with `--filter=blob:none`, as the agent, into the workspace, and switches to `barrack/<thread id>`. Commits are authored as the user: with a GitHub link, `name <id+login@users.noreply.github.com>`, which GitHub attributes to them without publishing their address; without one, `Barrack user <user-<digest>@users.noreply.barrack.invalid>`, since the sign-in gives Barrack no address it knows the user verified and would want published.
- **Why:** A shallow clone starts fastest but leaves the agent without history (log, blame, merge bases) and breaks once the base branch moves; a full clone of a large repository can take minutes. A partial clone has the whole history at a fraction of the size, fetches contents through the same read-only helper as needed, and bundles and publishes as a full one does.

## 2026-11-24: A failed clone keeps messages from the agent

- **What the plan said:** Handle failure deliberately; never silently.
- **What we did:** The supervisor reports `repository_clone_failed` with Git's reason, gives the agent no message while its workspace lacks the repository, and tries the clone again before each message. A message that still cannot be given is acknowledged as delivered, so it is not handed over later out of context, and the failure event that comes with it says so.
- **Why:** An agent answering in an empty workspace would look as if it had the repository. Retrying on the next message lets a user fix the cause (install the App, say) and carry on without a new thread.

## 2026-11-24: A branch name is whatever Git accepts for a branch, and the agent waits for its workspace's description

- **What the plan said:** Validate anything that crosses a boundary.
- **What we did:** The protocol's `branchNameSchema` now follows `git check-ref-format --branch` rule for rule ([its documentation](https://git-scm.com/docs/git-check-ref-format)): any character but controls, space, `~ ^ : ? * [ \`; no `..`, `@{` or `//`; no `/` at either end or `.` at the end; no part starting with `.` or ending with `.lock`; not `HEAD`, `@`, or anything starting with `-`. It differs from Git in two ways, both stricter: control characters beyond ASCII (U+0080 to U+009F), invisible on a page, are refused, as is text that is not well-formed Unicode; checked against Git 2.43 on sixty names. The control plane checks GitHub's default branch when a thread is created and refuses, naming it, one it cannot use (asking for a base branch instead); linking logs such repositories and still links them. The supervisor gives the agent no message before the workspace has been described: one that comes first is withheld and reported as a failed clone, saying to stop and resume the thread. A schema refinement accepting more, not a new message, so the protocol version is unchanged; a supervisor of the previous release refuses the names it always refused.
- **Why:** The rule was letters, digits and `. _ - /` only, while GitHub's `default_branch` was stored unchecked: a repository whose default branch was `release+1`, `fix#12` or `développement` got a thread whose `prepare_workspace` the supervisor refused as invalid and ignored, leaving its workspace counted as ready, so the agent was given messages with no repository and no clone event. Accepting what Git accepts fixes the cause; what Git refuses is what could be read as an option, a revision or a path, which is what the narrow rule was protecting against. Withholding until described closes the same gap for any other reason a description might not arrive.

## 2026-11-24: Working with a repository is protocol version 3

- **What the plan said:** Nothing specific.
- **What we did:** The supervisor's messages gain `prepare_workspace`, credential requests and answers, `create_publication_bundle` and `publication_bundle_failed`; its numbered events may now be workspace events; and thread events gain the repository's. These are incompatible, so the version moves from 2 to 3, once; the same increment covers `send_user_message` gaining its `messageId` (above), written at the same time. Workspace requests are answered outside the relay's queue, which only records and orders the thread's events; see below for what bounds them.
- **Why:** A supervisor of version 2 would not prepare the workspace, and a control plane of version 2 would close a supervisor sending a credential request as invalid.

## 2026-11-24: What a supervisor makes the control plane hold is bounded however it sends it

- **What the plan said:** Treat everything inside a sandbox as untrusted.
- **What we did:** Checked, when the repository work and the relay's bound on queued supervisor messages were merged, every way a sandbox reaches the control plane besides the queue. Credential requests and bundle failures are answered outside the queue (a credential can wait on GitHub); they stay so, and are bounded instead: a request over the per-thread rate is refused without awaiting anything, and logged once per spell of refusals rather than each time; GitHub is asked to mint at most once at a time per thread, and not for a minute after it refused; and the control plane's send buffer to a supervisor is limited to 16 MiB, past which the supervisor is disconnected with 1013. A deleted thread's cached token and allowance are dropped. A bundle upload is taken only for a publication waiting for it, once, from that thread's supervisor (checked as for its WebSocket, so every token minted for the thread's creation is accepted and an unknown thread is refused like a wrong token); it streams to disk with its size counted as it arrives, and is cut off the moment the publication stops waiting (the sandbox reported a failure, or the three minutes ran out), so a stalled or failed upload stops writing to a file about to be removed.
- **Why:** The relay's bound covered what waits to be recorded, but answers are sent whether or not the supervisor reads them: a sandbox sending refused credential requests as fast as it can, without reading, made the control plane keep every answer, and log every refusal. A mint GitHub refuses is never cached, so a sandbox whose App installation lost the repository could otherwise spend the installation's API allowance, shared by every user of it, at the rate limit. The send buffer limit holds over a hundred and fifty of the longest user messages, far more than waits for an honest supervisor that reconnects; acknowledgements are tiny. Putting the requests in the queue was rejected: one waiting on GitHub would hold up the thread's events.

## 2026-11-24: The clone's events are a supervisor's events in every respect

- **What the plan said:** Nothing specific; the event log and the idle shutdown were written before repositories.
- **What we did:** Checked, when the two were merged, that the clone's numbered events take the agent's path throughout: recorded once per instance and number by the same keyed append, acknowledged and resent alike, ignored by the open-run bookkeeping (neither opens nor closes a run, so neither a control plane's close of an abandoned run nor a stop's is affected), and counted as activity for the idle shutdown like the agent's.
- **Why:** A cloning sandbox is working for its thread, so its events keep it from being taken for idle. A clone that outlasts the idle period with nothing waiting for it can still be stopped; nobody is waiting, and it is cloned again when the sandbox next wakes, since only a finished clone is recorded. Exempting cloning sandboxes from idle shutdown was rejected: a clone that hangs would keep its sandbox billing until its fifteen-minute limit, for nothing.

## 2026-11-24: Publishing's Git runs under limits on memory, processor time, wall time and disk

- **What the plan said:** Treat everything inside a sandbox as untrusted.
- **What we did:** Every Git process a publication runs gets 1 GiB of address space, 120 s of processor time and at most 2 GiB in any one file, set by `/bin/sh` with `ulimit` before it `exec`s Git, so every process Git starts inherits them; each command also gets 300 s of wall time, and the publication's directory 2 GiB in all, measured every 200 ms; both are enforced by killing Git's process group, which Git runs in alone. Git is told to use one thread, small pack windows and to stream blobs over 64 MiB, so that honest input stays well within the address space. A limit that stops Git fails the publication with a message naming the step and the limit. The base branch is still fetched whole (without file contents), bounded by the same limits rather than by depth. The control plane logs at startup which limits the machine cannot apply: the address-space limit is applied on Linux only, since macOS accepts it without enforcing it.
- **Why:** A third review indexed a pack of 16 KB holding a delta that declares a 2 GiB result: `index-pack --fsck-objects` held 2,068 MiB within six seconds, and `bundle verify`, which never reads the pack, had passed it; `git fetch` from the bundle would have indexed it again. Measured in the control plane's image as its unprivileged user, the same pack now stops in 0.1 s at 20 MiB with "Out of memory, malloc failed", and the publication fails saying it needed more memory than allowed. The limits leave room for the largest bundle Barrack takes (100 MB): a file of a few hundred megabytes still publishes. `ulimit` was chosen over `prlimit` (Linux only) and cgroups (not available to an unprivileged process everywhere); it works wherever there is a POSIX shell. Parsing the pack to refuse declared sizes before Git reads it was rejected: it would mean inflating every object in a second, hand-written parser of hostile input, while the limits bound whatever Git does, the fetches from the user's repository included. A shallow base branch was rejected because deciding whether a push is a fast-forward needs the history between the two commits.

## 2026-11-24: A local-process supervisor records itself before it runs

- **What the plan said:** Nothing specific; the local-process provider is for development and the fast tests.
- **What we did:** The provider launches each supervisor through `/bin/sh`, which writes its own process identifier (kept by `exec`) to `supervisor.pid`, then tells the provider on a pipe, then becomes the supervisor. Before, the provider wrote the identifier itself once the process had started.
- **Why:** `thread-lifecycle.test.ts` › "a start has the start finished by its successor" failed about one run in ten: logs showed the control plane killed after starting the supervisor and before recording it, so its successor, taking over the start, saw no supervisor and launched a second, which replaced the first in the middle of the run it had just begun (`agent_failed`). The fault was the provider's, not the test's or the timing's: a start must be safe to repeat, and an unrecorded supervisor made it not. Recorded by the launch itself, a supervisor never runs unseen; if the provider is gone before reading the pipe, the shell dies of SIGPIPE before the supervisor starts, which reads as a supervisor that exited. Docker and Daytona were never affected, since their start finds the one container. The shell costs nothing on the macOS and Linux machines this provider runs on.

## 2026-11-24: Each user's model keys are stored by the control plane, sealed, not near their sandboxes

- **What the plan said:** From Milestone 4 each user's threads run on that user's own access, which is only ever used for their own threads. For a subscription sign-in it prefers the credential to live with the user's sandboxes rather than in Barrack's central database, and if central storage is necessary it must be encrypted, scoped to its owner, and justified here.
- **What we did:** The API-key half of Milestone 4. Users add one key per model provider in Settings; the control plane stores each in `model_credentials` (migration 0080), sealed with AES-256-GCM under a key from its configuration, bound to its owner and provider as the cipher's associated data, and opens one only to send it to that owner's own thread whose model needs it. Clients see a key's provider, when it was added and its last four characters, never more.
- **Why:** A key must outlive every sandbox: threads are created and deleted, sandboxes stopped, archived and recreated, and a user's key serves all their threads. Keeping it near the sandboxes would mean a store shared by a user's sandboxes, which no provider offers safely (Daytona's volumes are last-write-wins FUSE mounts, per the research), or asking the user for the key in every thread. Central storage is the only place a key survives all that; sealed under a key the database never holds, a copy of the database alone yields nothing, and the binding stops a row's ciphertext being moved to another user or provider and opened there. The last four characters are kept readable so the list needs no key opened; they say nothing usable about a key of at least eight. The subscription half may yet keep its refresh token elsewhere; see the last entry below.

## 2026-11-24: The sealing key comes from configuration, rotates by resealing at startup, and its absence stops the control plane

- **What the plan said:** Encrypted and scoped to its owner; nothing about keys.
- **What we did:** `BARRACK_MODEL_CREDENTIAL_KEY` is required: base64 of 32 random bytes (`openssl rand -base64 32`). Each sealed key records the fingerprint of the key that sealed it (the start of an HMAC of a fixed label under it). To rotate, the new key goes in `BARRACK_MODEL_CREDENTIAL_KEY` and the old in `BARRACK_MODEL_CREDENTIAL_PREVIOUS_KEYS`; at startup the control plane seals every stored key again under the new one, each only if unchanged since read, and the old can then be removed. If any stored key was sealed under a key it was not given, it refuses to start, naming how many and the fingerprint. `pnpm dev` makes up a key per run while keys are kept in memory, and asks for one with a database.
- **Corrected (third review):** Resealing only at startup was not safe across a redeploy's overlap. The old instance, holding only the old key, could no longer open anything the new one had resealed, read it as "no credential" and sent that to its supervisors, which erased their keys; and a key saved through the old instance was sealed under the old key after the new one's startup pass, so removing the previous key as the guide said then stopped the control plane from starting. Now a credential sealed under a key the instance does not hold is never described as missing: the relay leaves an attached supervisor the key it has (and turns away one attaching, which reconnects, normally to the new instance); a credential that fails authentication is still withdrawn. Resealing runs at startup and every five minutes, skips (and counts) what it cannot open instead of stopping at it, and logs when nothing is left under another key; [deployment](deployment.md#users-model-keys-and-the-key-that-seals-them) gives the two-deploy procedure, removing the previous key only after that log line.
- **Why:** A key in the environment is what every secret here already is, and what Railway and Compose seal; a key management service would add a dependency no installation has yet. Refusing to start, rather than starting with some keys unreadable, turns the commonest cause (a forgotten or mistyped variable after a redeploy) into an error at once instead of threads that quietly cannot run; an operator whose key is truly lost is told to delete those rows, and users add their keys again. Resealing at startup needs no separate tool, and the compare on each row keeps a key a user replaced meanwhile.

## 2026-11-24: A key is checked for plausibility only; no test call to the provider

- **What the plan said:** Validate anything that crosses a boundary.
- **What we did:** A key must be 8 to 8,192 printable characters with no spaces, quotation marks or backslashes, and a catalogued provider's settings must be exactly those it needs. The control plane never calls a provider with a user's key.
- **Why:** A test call would need, for each of forty providers, an endpoint and a request that costs nothing and proves the key; the control plane does not run Pi and would have to duplicate what Pi knows, and calling a provider from the control plane with a user's key is a capability worth not having. The first run already says in plain words when the provider rejects the key, and sending again after replacing it takes seconds. No key contains a quotation mark or backslash, and refusing them means a key reads the same inside a JSON log line as outside it, which the supervisor's redaction relies on.

## 2026-11-24: The key reaches Pi through Pi's own credential file, written as the agent, never an environment

- **What the plan said:** Secrets never go in logs or stored events. Give sandboxes the fewest credentials possible. The agent can read whatever is inside its sandbox, and the documentation must say so.
- **What we did:** The control plane forwards no model key of its own any more, and nothing about models is in a sandbox's environment. The owner's key travels in `configure_model_access` over the supervisor's authenticated connection, after `prepare_workspace` and again whenever it or the model changes. The Pi harness writes it to `auth.json` in Pi's agent directory as the agent's user (a short Node program run through `run-as-agent`, reading the contents on its standard input, writing a new 0600 file and renaming it over the old), and erases it when the key is withdrawn, when the supervisor starts (a killed one's leftover) and when it stops. Model provider keys are no longer passed from the supervisor's environment to Pi's.
- **Why:** Pi's environment is every tool's environment: a key there is printed by `env`, a crash report or a debugging session into the model's context and the thread's history, and inherited by anything started in the sandbox through `docker exec` or a provider's command interface if it is the container's. In Pi's credential file it is read only on purpose. Pi rereads that file whenever it changes (verified against the pinned Pi: a rewritten file's key is sent on the next request with no restart), which is also what a refreshed subscription token will need. The agent can still read the file, since it must use the key; an untrusted repository's code, which runs as the agent, can read and send it anywhere. That is inherent while keys are in sandboxes, documented in the sandbox image's README and the deployment guide, with the advice to use keys with a spending limit; keeping keys out of sandboxes is Milestone 7.

## 2026-11-24: Every key a supervisor received is redacted from what it reports and logs

- **What the plan said:** Secrets never go in logs or stored events.
- **What we did:** The supervisor remembers each key it is sent, for as long as its process lives, and replaces any occurrence in every agent event and stream fragment, and in every finished log line (a pino `streamWrite` hook), with `[redacted model credential]`.
- **Why:** A provider that echoes a key in its error body, or a tool that prints the credential file, would otherwise put it in stored history. This is a safety net, not a boundary: an agent that means to can encode the key past it.

## 2026-11-24: The model catalogue is generated from the pinned Pi and committed

- **What the plan said:** Pi supports many providers, which gives model swapping without extra work.
- **What we did:** `packages/model-catalogue` holds `model-catalogue.json`, generated by `pnpm --filter @barrack/model-catalogue generate` from the pinned Pi's own model runtime: each provider with an API key login, what that login asks for (run with made-up answers to see the secret it prompts for and the settings it stores), and its chat models, the common providers first. One setting Azure's login does not ask for but needs (its endpoint) is added by hand. A test fails when the package's Pi differs from the supervisor's pin, or when regenerating gives anything else. The control plane serves the file; the web client lets a user pick from it or type any `provider/model`.
- **Why:** The control plane must not install or run Pi, and the list must be what the pinned agent really supports, not what its documentation says. Generating at build time from the installed package would need Pi wherever the control plane is built; committing the generated file, guarded by a test that regenerates it, gives the same truth with no such dependency. Providers add models between Pi releases, and Pi itself refreshes its catalogue online, so the list is presented as a snapshot and any identifier is accepted.

## 2026-11-24: Switching a thread's model starts Pi again on the new model, between runs

- **What the plan said:** A model choice per thread, changeable; resumable on a different model.
- **What we did:** A model switch takes effect when the run in progress has ended: the harness stops Pi and starts it again on the new model with the thread's session file, so the new model is sent the conversation so far. A replaced key for the same provider needs no restart. A removed key stops Pi, after its run, until a key comes back.
- **Why:** Pi's `set_model` accepts only a model available when Pi started, and the pinned Pi works out which providers have credentials once, at startup (verified: after `auth.json` gained a second provider's key, `set_model` to it still answered "Model not found"; with its key removed from the file, a provider's requests fail "Provider is not configured", and Pi is not relied on to notice the key's return). A restart between runs costs about a second and is the one path that always works; resuming the session file is how a stopped sandbox already carries a conversation on.

## 2026-11-24: Provider failures are classified in the harness into four kinds the user can act on

- **What the plan said:** Handle plan limits gracefully: stop cleanly, tell the user why, be resumable later or on a different model.
- **What we did:** An errored assistant message carries an optional `errorKind`: `credential_missing`, `credential_rejected`, `quota_exhausted` or `rate_limited`. The Pi harness derives it from Pi's error report (`classify-model-access-error.ts`): quota first, with the phrases Pi itself treats as exhausted quota plus Anthropic's credit message, because quota arrives as a 429 like a rate limit and needs the opposite advice; then a rejected key; then a rate limit, which reaches the user only once Pi's own retries have run out. The web client explains each kind with its next step and shows the provider's own words beneath. Each of the first four was reproduced with the pinned Pi against the mock model server returning OpenAI's documented error bodies, in `pi-agent-harness.integration.test.ts`; Anthropic's wordings come from its documentation and have not been seen through Pi.
- **Why:** The client must not read meaning into a provider's wording, and only the harness knows how its agent reports errors. Four kinds are what a user can do something different about; anything else keeps its own message.

## 2026-11-24: A message to a thread without a key is refused, and the agent answers one that slips through

- **What the plan said:** Tell the user why, and let them carry on.
- **What we did:** Before recording a user message, the relay asks whether the thread has a model and its owner a key for its provider; if not, the message is refused (as for the sandbox limit) with which key to add and where, and the page keeps it to send again. A message recorded before the key was removed reaches an agent with no key, which answers it with an errored message of kind `credential_missing`, in a run of its own, without starting Pi.
- **Why:** Refusing before recording neither wakes a sandbox for nothing nor leaves a message waiting that no agent could answer; the harness's own answer covers what was recorded earlier, so nothing fails obscurely either way. Adding the key sends it to the running sandbox at once, so the next message works with nothing recreated.

## 2026-11-24: Each user's own model access is protocol version 4

- **What the plan said:** Nothing specific.
- **What we did:** `configure_model_access` joins the control plane's messages to supervisors, `errorKind` the errored assistant message, and the sandbox's environment loses `BARRACK_MODEL`. The version moves from 3 to 4, once.
- **Why:** A version 3 supervisor would run on the model from its environment, which no longer has one, and close on the unknown message; a version 3 control plane would send no key.

## 2026-11-24: What remains for connecting a ChatGPT subscription

- **What the plan said:** Users connect a ChatGPT plan once, and their threads run on it; the sign-in should live as close to their sandboxes as possible.
- **What we did:** Nothing for it yet: which route to take awaits the project owner's decision. What is built leaves room for it: a stored credential is a sealed value bound to its owner and provider, which can hold a refresh token as well as a key; `configure_model_access` carries a credential with a `kind`, to which an access token with its expiry can be added, and is sent again whenever the control plane says, as a refresher would before each expiry; and Pi rereads its credential file mid-run, so a refreshed token can replace the old without a restart.
- **Why:** Still to decide: where the refresh token lives (the research recommends the control plane, with one refresher per credential serialised in the database, and only short-lived access tokens in sandboxes), the sign-in route itself, and whether the plan's preference for keeping the sign-in near the sandbox can be met at all given rotating refresh tokens.

## 2026-11-24: The desktop travels through a stream the sandbox dials out, not the provider's address

- **What the plan said:** Use the browser-based remote desktop the sandbox provides (noVNC), embedded in the web client; protect it so only the thread's owner reaches it; prefer what works inside the sandbox whatever the provider. Open question: "How is the desktop view authenticated when it is served from the provider's address rather than ours?"
- **What we did:** The question does not arise: the desktop is not served from the provider's address. Inside the sandbox a VNC server listens on loopback only. When a viewer opens a thread's desktop, the control plane mints a stream identifier and asks the thread's supervisor, on its existing connection, to open it; the supervisor dials a second outbound WebSocket with the thread's token, joins it to the VNC server, and the control plane splices it to the viewer. The handshake is in `packages/protocol/src/desktop-messages.ts`. The provider boundary's `getServiceAddress` stays, unused by the desktop. Barrack's image ships the VNC server; only noVNC's client is used, in the web page, never noVNC's own page or a websockify server.
- **Why:** No inbound port and no provider-specific code, so Docker, Daytona and anything later behave the same; ownership is checked by the control plane with the session the user already has, per connection, rather than by a bearer URL anyone holding it could use; and only a relay we run can enforce view-only server-side. The cost is that every desktop byte crosses the control plane, and its host's egress (see the next entries). A spike on 2026-11-24 measured the two extra hops at about 1.2 ms added latency locally; across regions it is the distance between them.

## 2026-11-24: Xvnc, Openbox and xdotool, always in the image, kept running by the supervisor

- **What the plan said:** A desktop in each sandbox; a video-codec streamer later if quality is poor.
- **What we did:** TigerVNC's Xvnc (X server and VNC server in one process) at 1280×800×24, Openbox and xdotool, with DejaVu and Liberation fonts, run as the agent with no capabilities by `barrack-desktop`, which the supervisor starts whenever the sandbox runs and starts again, with a growing pause, whenever it ends. It serves loopback only, without a password, every viewer shared, viewers unable to resize it, at most 15 updates a second. It clears the X lock a stopped sandbox leaves (process numbers restart, so the lock's may name a living process). The desktop is part of every image, not a build option.
- **Why:** Measured on 2026-11-24: 37 MiB and no CPU idle, answering 0.13 s after starting; Xvfb with x11vnc costs more for an unmaintained second process; jwm does not give a clicked window the keyboard; xfwm4 needs a session bus; Xfce costs 191 MiB. Always running removes a race between a viewer and the agent's tool, and lets the agent's commands open windows at any time. Always in the image keeps one image to build, test and push, and every thread able to use it; the cost is size: the image grows from 129 MB to 416 MB compressed (`docker save | gzip`, measured 2026-11-24) and from 628 MB to 1.76 GB unpacked, mostly Mesa and LLVM that Ubuntu's X servers depend on and Firefox. That is paid on each snapshot push and first pull, not per thread. A sandbox without the command (`BARRACK_DESKTOP_COMMAND`) simply has no desktop, which the supervisor and the page handle, so a slimmer image remains possible.

## 2026-11-24: Firefox from Mozilla's APT repository, with the terms of use accepted by policy

- **What the plan said:** Nothing specific: the agent should be able to open a browser and click through a page.
- **What we did:** Firefox's `.deb` from `packages.mozilla.org`, with Mozilla's signing key kept in the repository (fingerprint `35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3`, as Mozilla's installation page gives it) and an APT pin for `firefox*` only, so that repository can replace no other package. An enterprise policy turns off updates, telemetry, studies and first-run pages, and sets `SkipTermsOfUse`. The agent starts Firefox when it wants it. A build that cannot reach Mozilla's repository may pass `FIREFOX_SOURCE=build-context` and an unpacked official Firefox as the named context `firefox`.
- **Why:** Ubuntu's own `firefox` and `chromium` are transitional packages for snaps, which do not run in containers. Firefox's content sandbox (seccomp) works in an unprivileged container, where Chrome needs `--no-sandbox` (no user namespaces under Docker's default seccomp profile), and Firefox is MPL-licensed and built for amd64 and arm64. `SkipTermsOfUse` means that, by Mozilla's policy documentation, whoever runs the installation "represent[s] that you accept … the Terms of Use on behalf of all individuals to whom you provide access to this browser"; an operator who does not want that removes the line, and each sandbox's first Firefox window then asks once. Not verified here: this network blocks `packages.mozilla.org`, so the `mozilla-apt` stage has not been built; the key was taken from `keyserver.ubuntu.com` and checked against Mozilla's published fingerprint; the image tested was built with the build-context route from Mozilla's official 161.0 Linux build as repackaged unmodified by conda-forge. The repository keeps current versions only, so each build takes the Firefox of its day.

## 2026-11-24: Viewers watch; one takes control explicitly, and the control plane enforces it

- **What the plan said:** The user can take over the mouse themselves.
- **What we did:** Every viewer opens watching. The control plane reads what each viewer sends as VNC messages and forwards keyboard, pointer, clipboard and screen-size messages only from the one viewer that asked for control (`take_desktop_control`), forces every session shared, rewrites the viewer's encodings to an allowed list (no H.264, which would feed the sandbox's bytes to the browser's video decoder), and closes a viewer that sends anything it does not recognise. Several viewers may watch at once. Who holds control is told to the thread's clients (`desktop_control_status`, so each viewer knows whether it is the one) and to the supervisor (`desktop_control`), which writes it to a file the agent's computer tool reads and the agent cannot write. While the user holds control, the tool refuses mouse and keyboard actions and says why. Giving control back, or the controlling viewer's connection closing (a hidden tab closes it), returns it to the agent.
- **Why:** noVNC's own view-only setting is a courtesy a modified page ignores; dropping input on the server is not. The agent's pause is cooperative and not a security boundary: the agent owns the display and could drive it with `xdotool` from its shell; it is there so the user and the agent do not fight over the mouse.

## 2026-11-24: Everything on the desktop path is bounded, in both directions and at both hops

- **What the plan said:** Treat everything inside a sandbox as untrusted.
- **What we did:** The control plane stops reading one side of a desktop stream while the other has more than 1 MiB waiting to be sent, until it drains below 256 KiB, so TCP pushes back to the sender; the supervisor's side relays through Node's stream pipeline, which does the same. A viewer that stays above the mark for 20 s is disconnected. A sandbox may send a viewer 4 MiB a second on average, a viewer the sandbox 512 KiB. Desktop frames are limited to 1 MiB, clipboard pastes to 256 KiB, a thread to four viewers, a supervisor to four open streams. A stream identifier is accepted once, only for the thread it was minted for, and forgotten after 10 s. A text frame from the sandbox's side ends the stream. What the sandbox sends is relayed, not parsed: noVNC decodes it into a canvas, and nothing it says (the desktop's name, its clipboard) is shown as markup or copied to the user's clipboard.
- **Why:** A spike's relay without flow control grew to 957 MiB in four seconds with a viewer that stopped reading; with it, 69 MiB. The rate cap is a cost guard well above the desktop's own 15-updates-a-second output (see the next entry), so it only throttles what nobody needs.

## 2026-11-24: What the live desktop costs in bandwidth, and where to run the control plane

- **What the plan said:** Nothing specific.
- **What we did:** noVNC's defaults (quality 6, compression 2) and Xvnc's 15 updates a second. Measured on 2026-11-24 with one viewer: a still screen sends nothing; an agent opening a browser, loading a page and clicking sent 0.18 MiB in 25 s; continuous full-screen motion sends 0.6 to 3.5 MB/s (2 to 13 GB an hour), all of it the control plane's egress. Each extra viewer is the same again.
- **Why:** At Railway's $0.05 per GB of egress, watching an agent work costs well under a cent an hour and continuous motion $0.11 to $0.64 an hour. The control plane belongs in the same region as the sandboxes, since every desktop byte, and every keystroke of a user in control, takes the path through it (see the deployment guide).

## 2026-11-24: The agent's computer tool works inside the sandbox, and history keeps only words

- **What the plan said:** Give the agent tools to take screenshots and control the mouse and keyboard, preferring what works inside the sandbox regardless of provider.
- **What we did:** One `computer` tool (screenshot; click, double-click, right and middle click, move, drag, scroll; key; type; wait), a Pi extension in the supervisor's Pi harness, loaded only in a sandbox with a desktop. Screenshots are read from the local VNC server and encoded as PNG in the tool, so the model sees exactly what the user sees; input goes through `xdotool`. Screenshots are the display's own 1280×800 pixels, within every current model's image limits and Pi's own, so coordinates are one to one; a larger display is shrunk by averaging and the model's coordinates scaled back. Only the newest three screenshots stay in the model's context, older ones replaced in batches of three so a provider's prompt cache changes rarely. Each action but `screenshot` returns a fresh screenshot. The tool refuses for a model that cannot see images. The fake agent's `[desktop]` does the same without Pi. In Barrack's history a tool result keeps only its text (`[image: image/png]` marks where an image was), and the page shows computer calls in words ("Clicked at (400, 383)").
- **Why:** Provider-native computer use (Daytona's) needs their packages and API and works on one provider only. Storing screenshots would add tens of kilobytes per action to a history that must stay cheap to replay; the user has the live desktop instead.

## 2026-11-24: Watching keeps no sandbox awake; the controlling user's input does

- **What the plan said:** Idle sandboxes are stopped automatically.
- **What we did:** An open viewer is not activity. Keyboard, pointer and clipboard messages the control plane forwards from the viewer holding control are, noted at most once an interval like the agent's. A viewer of a thread whose sandbox is not running is told so (`desktop_unavailable`, `sandbox_not_running`), and the page offers to wake it; nothing wakes it silently. The desktop comes back when the sandbox resumes, since the supervisor starts it again.
- **Why:** A forgotten tab must not keep a sandbox billing all night, as already decided for a thread's clients; a user typing into the desktop is working, and their sandbox should not stop under them.

## 2026-11-24: Anything typed into the desktop is the agent's to read

- **What the plan said:** A user's secrets stay out of reach of others; nothing about the desktop specifically.
- **What we did:** The page says so while the user holds control, and the documentation repeats it: everything typed into the desktop, passwords included, can be read by the agent. Its processes share the X server's user, so they can log keystrokes and read the screen and the page; the model sees screenshots; the browser profile on the sandbox's disk may keep passwords and cookies, which survive stops; and the keystrokes pass through the control plane (relayed, never logged or stored).
- **Why:** Nothing can prevent it while the desktop is the agent's. Users should enter only credentials they would hand the agent, prefer throwaway or narrowly scoped accounts, sign out and delete the profile or the thread afterwards, and never enter a password manager's master password or their Barrack sign-in there.

## 2026-11-24: Daytona's lower tiers limit what the agent's browser can open

- **What the plan said:** Daytona first.
- **What we did:** Nothing in code. On Daytona's Tiers 1 and 2, network access is restricted to an allow-list of essential services and cannot be changed per sandbox (Daytona's network-limits documentation, read 2026-11-24). The desktop stream is a second connection to the control plane's own host, allowed whenever the supervisor's is, so the desktop works; but the agent's browser can open only allow-listed sites and pages served in the sandbox. Browsing the web in general needs Tier 3 or Daytona's own outbound proxy settings.
- **Why:** The milestone's demonstration uses a page served to the sandbox, which works on every tier; an operator expecting the agent to browse the internet must know the limit is Daytona's, not Barrack's. Not run against Daytona.

## 2026-11-24: A local-process sandbox has no desktop

- **What the plan said:** Nothing specific about `pnpm dev`.
- **What we did:** A sandbox has a desktop only when its image names the command that runs one (`BARRACK_DESKTOP_COMMAND`); the local-process provider sets none, so `pnpm dev` threads show "This sandbox has no desktop" and the agent's computer tool says there is no screen. The supervisor gives Pi a `DISPLAY` only from its desktop configuration, never from its own environment.
- **Why:** Several local sandboxes would share one display number and one VNC port, and a developer's `DISPLAY` would let the agent open windows on, and read, their own screen. The desktop is tested in Docker instead.

## 2026-11-24: The live desktop is protocol version 5

- **What the plan said:** Nothing specific.
- **What we did:** The desktop viewer and desktop stream endpoints, `open_desktop_stream` and `desktop_control` to supervisors, `desktop_availability` and `desktop_stream_failed` from them, and `desktop_control_status` to clients. The version moves from 4 to 5, once.
- **Why:** A version 4 supervisor would ignore the stream requests and say nothing of its desktop, and a version 4 page would close on the new status message.

## 2026-11-24: A supervisor's secrets are files only its user can read, never its environment

- **What the plan said:** Give sandboxes the fewest credentials possible; connections between sandbox and control plane must be authenticated per thread, so that one sandbox cannot impersonate another.
- **What we did:** A sandbox creation request now has two parts: `supervisorEnvironment`, plain settings, and `supervisorSecrets`, today the token alone. Every provider hands each secret to the supervisor as a file named after it in `BARRACK_SUPERVISOR_SECRETS_DIRECTORY`, which only the supervisor's user can read, kept across a stop and a start, and the contract suite checks that no secret is in what the provider reports about a sandbox nor readable by a process its own command interface starts as the agent's user. Docker creates the container, unpacks a tar archive read from the CLI's standard input into `/var/lib/barrack/secrets` (`docker container cp -`, which keeps the archive's owner, 10001, and mode, 0400; `--archive` would give the container user's instead), then starts it; Daytona uploads each file with its file API and sets owner and mode before launching the supervisor; local-process writes a 0600 file in a 0700 directory, which keeps it out of the environment but not from an agent of the same user. `start` takes `replacementSecrets`, which a creation taken over uses to give a sandbox it adopts its own token. The supervisor refuses to start if the directory or file belongs to another user or is open to anyone else, if the file is a link, or if `BARRACK_SUPERVISOR_TOKEN` is in its environment.
- **Why:** An environment reaches every process started in the sandbox, whoever runs it and however (`docker exec --user barrack-agent`, a provider's command API), and is shown by `docker inspect` and Daytona's sandbox record. A file keeps a mode. Standard input was rejected because nothing gives it again when a stopped sandbox starts; a Docker secret needs Swarm; a bind-mounted file would leave the token on the host and need the control plane's own filesystem shared with the daemon, which Compose's socket proxy setup does not have. The file is in the container's writable layer, so `docker commit` or `docker export` would carry it, which only someone with the daemon, who is root anyway, can do. A take-over hands its token over again because the attempt that made the sandbox may have died between creating it and writing the file; the thread accepts every token minted for its creation anyway.

## 2026-11-24: run-as-agent is a program of our own that can become the agent and no one else

- **What the plan said:** Treat everything inside a sandbox as untrusted; give sandboxes the fewest credentials possible.
- **What we did:** `run-as-agent` is now [`sandbox-image/run-as-agent.c`](../sandbox-image/run-as-agent.c), about a hundred lines of C compiled statically with the distribution's `gcc` in a build stage of the image (the compiler never reaches the sandbox), with the same `setuid` and `setgid` file capabilities, owner and mode as the copy of `setpriv` it replaces. The user (10002), group (10002, and no other) and caller (10001) are compiled in; it takes only a program's absolute path and its arguments, runs it with `execv`, drops every capability and the ambient set, and sets `no_new_privs` first. The supervisor checks at startup that what it starts is `BARRACK_AGENT_USER` with that user's group alone and `no_new_privs` set. The container keeps only `SETUID` and `SETGID` in its bounding set and still runs without `no-new-privileges`.
- **Why:** With `setpriv` the supervisor's user could become root, so code execution in the supervisor meant root in the container. Wrapping `setpriv` cannot close that: the capabilities belong to whichever file carries them, and a wrapper the supervisor's user runs could not keep it from running the capable file directly, while giving the capabilities to a wrapper script means giving them to its interpreter. A purpose-built program small enough to read whole was the only form that removes the choice of user rather than hiding it; C, compiled statically, adds no runtime to the image and keeps the dynamic loader out of the privileged moment. `no-new-privileges` on the container would stop the helper receiving its capabilities, so the container still cannot set it, and Docker's bounding set cannot drop below the two the helper needs; instead the helper sets `no_new_privs` for every process of the agent's, which gives the agent's side what the container-wide setting would. A root process that starts the agent on the supervisor's request would let the container set `no-new-privileges` too, at the cost of a root process listening inside the sandbox; not done.
