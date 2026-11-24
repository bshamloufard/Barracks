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

## 2026-11-24: The agent runs as its own operating-system user

- **What the plan said:** Treat everything inside a sandbox as untrusted, and give sandboxes the fewest credentials possible.
- **What we did:** This replaces the Milestone 1 limitation that the supervisor and Pi shared a user. In the sandbox image the supervisor runs as `barrack-supervisor` and starts Pi as `barrack-agent` through `run-as-agent`, which only the supervisor's group may run, and it signals the agent's processes through the same helper. Under `pnpm dev` both still run as the developer's user.
- **Why:** Linux shows a process's environment and memory, and allows signals and tracing, only within one user, so this is what keeps the supervisor's token from the agent. Commands started with `docker exec` still see the token until it is handed over some other way than the container's environment; see the open gaps below.

## 2026-11-24: A user's message is recorded before it is delivered

- **What the plan said:** Every event is recorded in order before it is shown.
- **What we did:** The control plane records a `user_message` and broadcasts it before sending it to the supervisor; if it cannot be sent, the sender is told it was recorded but not delivered.
- **Why:** A message the agent acted on but history lacks could never be repaired, while one recorded but undelivered is visible, reported, and can be redelivered once delivery is acknowledged.

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
- **What we did:** The Pi harness guarantees that every `agent_run_started` is followed by exactly one `agent_run_settled` or `agent_failed`, including when Pi crashes or is stopped mid-run.
- **Why:** Clients and, later, idle shutdown can then trust a run's end instead of guessing from silence.

## 2026-11-24: Acknowledged delivery is deferred

- **What the plan said:** Every event is recorded in order; nothing should be lost silently.
- **What we did:** Messages are not yet acknowledged in either direction, so a message accepted by a half-open connection can be lost: an agent event on its way to the control plane, or a user message on its way to the supervisor, which the thread then shows as sent.
- **Why:** It needs a resume protocol on both hops (acknowledgements and a supervisor hello), planned for the rest of Milestone 2; until then the outage backlog and record-before-deliver keep losses rare and visible.

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
- **What we did:** Milestone 2's parts are built and tested locally only; deploying waits for sign-in (Milestone 3).
- **Why:** Deployed as planned, the control plane would be on the internet with no authentication: anyone could create threads and command agents.

## 2026-11-24: An idle control plane does not keep a free Supabase project awake

- **What the plan said:** Confirm that the running control plane generates enough activity to stop a free project pausing, and note the outcome.
- **What we did:** The control plane queries the database only when a thread is created or used, so a week without use would let a free project pause. A small periodic query is needed; it is not built yet.
- **Why:** Supabase pauses free projects after about a week of low activity, and an always-on service that is merely idle does not count.

## 2026-11-24: Security gaps that remain open

- **What the plan said:** Apply the security baseline from the first milestone that touches the cloud.
- **What we did:** These are known and not yet closed. (1) The token is in the sandbox's environment (the container's, and on Daytona the sandbox's `envVars`), so anything started with `docker exec` or a provider's command interface inherits it, including as the agent's user; fix: hand it to the supervisor through a file only its user can read, or standard input. (2) `run-as-agent` can switch to any user, so the supervisor's user is effectively root in the container; fix: a helper that can only become `barrack-agent`, or the supervisor in a container of its own. (3) None of this has been examined on Daytona, whose own processes and command interface may offer the agent a way round; fix: examine and test it there before relying on it. (4) There was no user sign-in, so anyone who could reach the control plane controlled every thread; closed by Supabase sign-in and per-user access checks on the server (see the entries below).
- **Why:** Each fix is larger than the change that revealed it, and none matters while nothing is deployed; they are listed so none is forgotten.

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
