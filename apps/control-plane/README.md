# @barrack/control-plane

The service between thread sandboxes and clients. It creates threads: each new thread gets a sandbox of its own from the configured [sandbox provider](../../packages/sandbox-providers), whose supervisor is given a token minted for that thread alone. Each thread's supervisor then connects to the control plane over a WebSocket, and so does each client viewing the thread. The control plane records every agent event in the thread's ordered history before showing it to anyone, relays streamed text live, and passes the user's messages and interrupts to the supervisor. Delivery between supervisor and control plane is acknowledged both ways, so each agent event is recorded exactly once and each user message reaches the agent exactly once, in order, even across either side being killed (see [the architecture](../../docs/architecture.md#acknowledged-delivery)).

Users sign in with Supabase Auth, and the control plane verifies every access token itself: each user sees and controls only their own threads (see [Signing users in](#signing-users-in)). With Supabase authentication it may listen on any address. In development mode (`BARRACK_AUTHENTICATION=development-single-user`, which `pnpm dev` uses) there is no sign-in and every client is one fixed user, so it refuses to listen anywhere but a loopback address, and answers only requests and WebSocket upgrades addressed to `localhost`, `127.0.0.1` or `[::1]` (any port), on every path, with `403 forbidden_host`. Listening on loopback keeps other machines out, but a website you visit can point its own domain at 127.0.0.1 (DNS rebinding) and then read whatever the control plane answers it, since its requests count as same-origin and carry no `Origin` header; its `Host` header still names its domain, which is why that is checked. The check also refuses anything reaching a development control plane through a proxy that keeps the original `Host`. With Supabase, other websites cannot act through your browser because the access token is never sent automatically, as a cookie would be; the control plane also refuses browser requests from an `Origin` it does not serve the client from.

> **Not yet ready for strangers.** Sign-in is in place, but nothing has been deployed or run against a real Supabase project, sandboxes are never stopped, and model provider keys in the control plane's environment reach every sandbox (see below). Admit only people you trust.

Threads and their history are stored in Postgres when `BARRACK_DATABASE_URL` is set, and survive restarts. Without it, they are kept in memory and lost when the process stops, which suits local development only; the control plane says so in a warning at startup.

## Threads and their sandboxes

1. `POST /api/threads` mints a thread identifier (a UUID) and a supervisor token (32 random bytes), records the thread with the token's SHA-256 digest and its sandbox `creating`, and answers `201` at once.
2. In the background it asks the provider to create the sandbox, with the supervisor's environment: `BARRACK_CONTROL_PLANE_URL` (from `BARRACK_SANDBOX_CONTROL_PLANE_URL`), `BARRACK_THREAD_ID`, `BARRACK_SUPERVISOR_TOKEN`, `BARRACK_AGENT_HARNESS`, and for Pi `BARRACK_MODEL`, the model provider keys and the Pi settings described below. The token goes nowhere else: it is never stored, logged or returned.
3. When the provider answers, the thread's sandbox is recorded `ready`; if it refuses, or stays unavailable after two more tries (1 s and 5 s later), it is recorded `failed` with a reason the user is shown. If the sandbox was created but cannot be recorded, it is destroyed, so none is left running unrecorded. A provider that reports the sandbox already exists on a retry is taken to have created it on the earlier attempt.
4. The supervisor's WebSocket upgrade is accepted only with the token minted for the thread in its URL, compared by digest in constant time: another thread's valid token gets `401`. Clients can connect only to their own threads, after authenticating (see [Signing users in](#signing-users-in)).

A client learns that the sandbox failed, and why, from the thread's `sandbox` field, fetching `GET /api/threads/{threadId}` until it leaves `creating`; whether the agent is reachable right now it learns from the thread's WebSocket, as before.

**After a restart**, a thread whose sandbox was still being created when the control plane stopped is marked `failed` at startup, with a reason saying so. A sandbox the provider may have made for it was never recorded, so it is not destroyed: the log names each such thread, and for Docker its container is labelled `barrack.thread-id=<thread>`. This assumes one control plane per database. Stopping, resuming and reconciling sandboxes properly come with the thread lifecycle in Milestone 3.

### Model provider keys (temporary)

Until each user brings their own model access (Milestone 4), a control plane running Pi forwards the model provider keys in its own environment to every sandbox: the variables listed in [`src/threads/model-credentials.ts`](src/threads/model-credentials.ts), the same list the supervisor passes on to Pi, such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Every thread can spend on those keys and every agent can read them. Their names are logged at startup, never their values.

### Pi's settings

A control plane running Pi also forwards two of Pi's own settings from its environment to every sandbox, when set: `PI_OFFLINE` (no automatic network activity at Pi's startup, for sandboxes without general internet access) and `PI_CACHE_RETENTION` (`long` for extended prompt caching). The list is in [`src/threads/pi-settings.ts`](src/threads/pi-settings.ts); other `PI_` variables are not forwarded.

## The HTTP API

JSON in and out, with shapes defined in [`@barrack/protocol`](../../packages/protocol/src/threads-api.ts). Errors answer `{ "error": { "code": "...", "message": "..." } }`.

Every `/api` request but the client configuration needs `Authorization: Bearer <access token>`: without a valid one it answers `401 unauthorized`, and for a signed-in user the installation does not admit, `403 not_allowed`. A browser request whose `Origin` is not allowed answers `403 forbidden_origin`; one without `Origin` (a native app) is let through to authenticate. Requests see only the signed-in user's threads: another user's thread answers `404` exactly as a missing one does.

| Request                         | Answer                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/client-configuration` | `200 { "authentication": … }`: the Supabase URL and publishable key to sign in with, or development mode's token. Public. |
| `POST /api/threads` with `{}`   | `201 { "thread": Thread }`, owned by the user. Needs `Content-Type: application/json` (`415`).                            |
| `GET /api/threads`              | `200 { "threads": [Thread, …] }`, the user's own, newest first, at most 100.                                              |
| `GET /api/threads/{threadId}`   | `200 { "thread": Thread }`, or `404`.                                                                                     |

A `Thread` is `{ "threadId": "…", "createdAt": "2026-11-24T09:00:00.000Z", "sandbox": { "state": "creating" | "ready" } | { "state": "failed", "reason": "…" } }`. When the store cannot be reached, requests answer `503`.

## Signing users in

**Over HTTP**, each request carries the access token. **Over the client WebSocket**, `/threads/{threadId}/client`, the first message must be `{ "type": "authenticate", "accessToken": "…" }`, within 5 seconds; anything else, or nothing, closes the connection with `notAuthenticated` (4401) having sent nothing. The control plane then checks that the user owns the thread (`threadNotFound`, 4404, if not, the same as for a missing thread) and only then replays, sends the thread's current statuses (whether its supervisor is connected, and how far user messages have been delivered) and goes live. The client sends each refreshed token on the open connection; one for another user closes it (4401), and when the newest expires it closes with `accessTokenExpired` (4402), after which the client refreshes its token and reconnects from its last seen sequence. A user the installation does not admit is closed with `userNotAllowed` (4403).

Tokens are verified against the Supabase project's published public keys (issuer, audience `authenticated`, ES256 or RS256, expiry with 30 seconds' tolerance, a signed-in, non-anonymous user). The user is the token's `sub`, recorded in `barrack.users` on their first authenticated request. An address on `BARRACK_ALLOWED_USER_EMAILS` counts only once Supabase confirms the user owns it, which the control plane asks Supabase once per user.

**What a self-hoster sets up in Supabase:**

1. **Asymmetric signing keys.** Under Project Settings, JWT Keys, the current key must be an asymmetric one (ECC P-256 is recommended). New projects have one; an older project still on the legacy HS256 secret must rotate. The control plane fetches the public keys at startup and refuses to start, saying so, if there are none. Until it has read them it does not listen; while Supabase cannot be reached, or answers with anything but a key set, it logs each attempt and tries again, for as long as it takes, as it does for the database.
2. **The email code.** Under Authentication, Email Templates, edit the **Magic Link** template to include `{{ .Token }}`, the six-digit code, for example `<p>Your Barrack code: {{ .Token }}</p>`. No redirect URLs are needed.
3. **Mail.** Supabase's built-in sender reaches only the project's team members, about twice an hour. To let anyone else sign in, set up custom SMTP under Authentication, SMTP Settings.
4. **Who may sign up.** Supabase lets anyone sign up by default. List the allowed addresses in `BARRACK_ALLOWED_USER_EMAILS` and, once everyone has signed in once, turn off "Allow new users to sign up". Leave "Confirm email" and anonymous sign-ins as they are by default (on and off); the control plane refuses anonymous users anyway.
5. **Barrack's settings.** The project URL and its **publishable** key (`sb_publishable_…`) from Project Settings, API Keys. Never the secret key: the control plane refuses one, since it is handed to every browser.

Threads created before sign-in existed have no owner and are shown to nobody; give one an owner with `update barrack.threads set owner_user_id = '<user id>' where thread_id = '<thread id>';` once that user has signed in.

## How it is organised

| Path                          | What it holds                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main.ts`                 | Reads configuration, opens storage, builds the sandbox provider, starts the server, shuts down on SIGINT or SIGTERM.                                         |
| `src/migrate.ts`              | Applies pending database migrations and exits.                                                                                                               |
| `src/configuration.ts`        | Environment variables, validated together at startup.                                                                                                        |
| `src/control-plane-server.ts` | One HTTP server on one port: HTTP routes plus both WebSocket endpoints.                                                                                      |
| `src/http/`                   | `GET /health`, the client configuration, the threads API, the sign-in middleware and origin check, and the built web client when configured (Hono).          |
| `src/authentication/`         | Sign-in settings, verifying Supabase's (and development mode's) access tokens, the allow-list, and the `Authenticator` both transports use.                  |
| `src/users/`                  | The `UserStore` interface and its implementations.                                                                                                           |
| `src/threads/`                | The `ThreadStore` interface and its implementations, creating threads and their sandboxes, supervisor tokens.                                                |
| `src/storage/`                | Opens Postgres (migrated) or memory for the thread store and the event log.                                                                                  |
| `src/database/`               | Database settings, the connection pool, the migration runner, and waiting for the database at startup (`pg`).                                                |
| `migrations/`                 | The SQL migrations, applied in name order.                                                                                                                   |
| `src/thread-event-log/`       | The `ThreadEventLog` interface, which assigns sequences, with its Postgres and in-memory implementations.                                                    |
| `src/thread-relay/`           | `ThreadRelay`: per-thread recording, acknowledgements, redelivery, paged replay and in-progress text. No sockets here.                                       |
| `src/websocket/`              | Upgrade routing, per-thread supervisor tokens, each client's session (authentication, ownership, expiry), frame validation, heartbeats, slow clients (`ws`). |
| `src/test-support/`           | Fake peers and connections, a pausable event log, the store and log contract suites, test database helpers. Not built.                                       |

The endpoints and messages are defined in [`@barrack/protocol`](../../packages/protocol); see [docs/architecture.md](../../docs/architecture.md) for how they fit together.

## Configuration

| Variable                              | Default                                                                                   | Meaning                                                                                                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BARRACK_AUTHENTICATION`              | `supabase`                                                                                | `supabase`, or `development-single-user`: no sign-in, one fixed user, only with a loopback `BARRACK_CONTROL_PLANE_HOST`.                                                                                      |
| `BARRACK_SUPABASE_URL`                | none; required for `supabase`                                                             | The project URL, `https://<project-ref>.supabase.co` (`http://` only on a loopback address, for a local Supabase stack).                                                                                      |
| `BARRACK_SUPABASE_PUBLISHABLE_KEY`    | none; required for `supabase`                                                             | The project's publishable key, handed to every client. A secret key is refused.                                                                                                                               |
| `BARRACK_SUPABASE_JWT_ISSUER`         | `<BARRACK_SUPABASE_URL>/auth/v1`                                                          | The `iss` the project's tokens carry, if a custom domain changes it.                                                                                                                                          |
| `BARRACK_ALLOWED_USER_EMAILS`         | none; required for `supabase`                                                             | Comma-separated email addresses allowed to use the installation (case does not matter), or `anyone-who-can-sign-in`.                                                                                          |
| `BARRACK_SANDBOX_PROVIDER`            | none, required                                                                            | `docker`, `daytona`, `local-process` (development only) or `fake`, with that provider's settings; see [its README](../../packages/sandbox-providers).                                                         |
| `BARRACK_SANDBOX_CONTROL_PLANE_URL`   | none, required                                                                            | The control plane's `ws://` or `wss://` URL as sandboxes reach it, which differs from where it listens: `ws://host.docker.internal:8787` for Docker on this machine, the public `wss://` URL in a deployment. |
| `BARRACK_AGENT_HARNESS`               | `pi`                                                                                      | What new sandboxes' supervisors run: `pi` or `fake`.                                                                                                                                                          |
| `BARRACK_MODEL`                       | none; required for `pi`                                                                   | Pi's `provider/model`, e.g. `anthropic/<model-id>`.                                                                                                                                                           |
| `PI_OFFLINE`, `PI_CACHE_RETENTION`    | unset                                                                                     | Forwarded to sandboxes running Pi; see [Pi's settings](#pis-settings).                                                                                                                                        |
| `BARRACK_CONTROL_PLANE_HOST`          | `127.0.0.1`                                                                               | Interface to listen on. Must be a loopback address with the `local-process` provider or in development mode.                                                                                                  |
| `BARRACK_CONTROL_PLANE_PORT`          | `8787`                                                                                    | Port for HTTP and both WebSocket endpoints.                                                                                                                                                                   |
| `BARRACK_ALLOWED_CLIENT_ORIGINS`      | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:8787,http://127.0.0.1:8787` | Comma-separated browser origins allowed to use the API and open the client endpoint.                                                                                                                          |
| `BARRACK_WEB_CLIENT_DIRECTORY`        | unset                                                                                     | Directory of the built web client (`apps/web/dist`). When set, the control plane serves it.                                                                                                                   |
| `BARRACK_LOG_LEVEL`                   | `info`                                                                                    | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                                                                                                                                               |
| `BARRACK_DATABASE_URL`                | unset: history in memory                                                                  | `postgres://user:password@host:port/database`, with no query parameters. Never logged; logs name only the host, port and database.                                                                            |
| `BARRACK_DATABASE_TLS`                | `verify-full`                                                                             | `verify-full` encrypts and checks the server's certificate and host name. `disable` sends everything in the clear; see below for when that is fine.                                                           |
| `BARRACK_DATABASE_CA_CERTIFICATE`     | unset: the authorities Node trusts                                                        | PEM text of the certificate authority to trust instead. Required for Supabase.                                                                                                                                |
| `BARRACK_DATABASE_POOL_SIZE`          | `5`                                                                                       | Most database connections one control plane holds open at once (1 to 100).                                                                                                                                    |
| `BARRACK_DATABASE_KEEP_ALIVE_MINUTES` | `240`                                                                                     | Minutes between the queries that keep an idle free Supabase project from pausing (0 turns them off, at most 1440).                                                                                            |

If anything is wrong, the control plane refuses to start and lists every problem.

## The database

Postgres 16 and 17 are tested; CI uses 17, which Supabase runs. The control plane keeps its tables in a schema of its own, `barrack`, creating it if needed, so the database role it connects as needs permission to create a schema (the owner of the database has it).

### Supabase

- **Connect through the session pooler**, on port 5432: the _Session pooler_ string in the project's **Connect** panel, which looks like `postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`. The direct connection (`db.<project-ref>.supabase.co`) is IPv6 only, and Railway services have no outbound IPv6 unless it is turned on. The transaction pooler (port 6543) does not keep a session per client, which breaks the advisory lock migrations rely on, and prepared statements.
- **Trust Supabase's certificate authority.** Supabase signs its database certificates with its own authority, so verification fails without it. Download it under **Database settings → SSL configuration** and put the file's contents in `BARRACK_DATABASE_CA_CERTIFICATE` (Railway accepts multi-line values). Leave `BARRACK_DATABASE_TLS` at `verify-full`. If the certificate cannot be verified, the control plane refuses to start and says which variable to set.
- **Pool size.** The session pooler serves at most the project's _Pool Size_ connections (15 by default) per database role, shared with everything else using that role. The default of 5 leaves room for a second control plane during a redeploy, and for you.
- **Free projects pause** after a week without enough database activity, and an idle control plane queries the database only when a thread is used. So it also reads one row from `barrack.schema_migrations` every `BARRACK_DATABASE_KEEP_ALIVE_MINUTES` (four hours by default, after each previous query has finished), which keeps a project in use for Barrack from being paused. A failed query is logged and tried again at the next interval; the keep-alive stops before the pool closes at shutdown. Supabase does not define how much activity is enough; see [`src/database/database-keep-alive.ts`](src/database/database-keep-alive.ts).

The tables are not exposed through Supabase's Data API: it serves only the schemas you list as exposed, and every table has row level security turned on with no policies, so even an exposed schema would yield no rows to the `anon` or `authenticated` roles. See the comment at the top of [the first migration](migrations/0001_create_thread_event_log.sql).

### Other Postgres

- With a certificate from a public authority, set only `BARRACK_DATABASE_URL`.
- With a private authority, also set `BARRACK_DATABASE_CA_CERTIFICATE` to its certificate, for example `BARRACK_DATABASE_CA_CERTIFICATE="$(cat root.crt)"`.
- A database without TLS on the same machine or a private network (a local Docker container, say) needs `BARRACK_DATABASE_TLS=disable`; the control plane warns at startup that the connection is unencrypted. Never use it across the internet.

### Migrations

Migrations are plain SQL files in [`migrations/`](migrations), named `NNNN_description.sql` and applied in name order, each in its own transaction, with unqualified names created in the `barrack` schema. The control plane applies any pending ones at startup, before it accepts connections, so deploying a new version is all it takes; `pnpm --filter @barrack/control-plane migrate` applies them without starting the server (after `pnpm build`, with the same database variables).

- Applied migrations are recorded, with a checksum, in `barrack.schema_migrations`. **Never edit a migration that has been applied anywhere**: the control plane refuses to start if an applied file has changed, or if the database has a migration this build lacks (as after rolling back to an older version). Put every change in a new file.
- Two instances starting at once take turns under a Postgres advisory lock, so each migration runs once.

#### Migrations written in parallel

`0010` (acknowledged delivery) and `0020` (users and thread owners) were written on separate branches and merged together; each works on a fresh database in numeric order. A database migrated by the sign-in branch before that merge has `0020` applied without `0010`, and the control plane refuses to start on it, naming both. Only development and test databases can be in that state. Either drop its schema, losing its threads, and let the control plane migrate it afresh:

```sh
psql "$BARRACK_DATABASE_URL" --command 'drop schema barrack cascade'
```

or keep its threads by applying `0010` by hand and recording it as the control plane would, from the repository root:

```sh
migration=apps/control-plane/migrations/0010_acknowledge_supervisor_delivery.sql
psql "$BARRACK_DATABASE_URL" --single-transaction --set ON_ERROR_STOP=1 \
  --command 'set local search_path to barrack' \
  --file "$migration" \
  --command "insert into barrack.schema_migrations (name, checksum) values ('$(basename "$migration")', '$(sha256sum "$migration" | cut -d ' ' -f 1)')"
```

The two migrations touch different tables, so applying `0010` after `0020` leaves the same schema as applying them in order. A database migrated by the acknowledged-delivery branch needs nothing: it gains `0020` at the next start.

### When the database is unavailable

- At startup the control plane waits for the database, retrying with growing delays up to 30 seconds and logging each failure, and does not listen until it has migrated. A deployment that cannot reach its database therefore fails its health check instead of restarting in a loop. Errors that waiting cannot fix, such as a wrong password, an unverifiable certificate or a failing migration, stop it with a message.
- While running, a query waits at most 10 seconds for a connection and 30 seconds for an answer. An event that cannot be recorded disconnects its supervisor, which reconnects and sends it again; a client whose history cannot be read is disconnected, and reconnects. Nothing crashes, and once the database answers again everything carries on.
- `GET /health` reports only that the process is up. A separate readiness check is not needed, because the server does not listen until the database is migrated, and Railway consults the health check only while a deployment starts.

## Running it

`pnpm dev` at the repository root runs it in development mode with the web client and the local-process provider. With Docker sandboxes the control plane must listen on Docker's bridge address, which the agents can reach too, so development mode is refused there and you need a Supabase project, [set up as above](#signing-users-in). From the repository root, after `pnpm install` and `pnpm sandbox-image:build`:

```sh
export BARRACK_SUPABASE_URL=https://<project-ref>.supabase.co BARRACK_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…
export BARRACK_ALLOWED_USER_EMAILS=you@example.com
export BARRACK_SANDBOX_PROVIDER=docker BARRACK_DOCKER_IMAGE=barrack-sandbox:dev
export BARRACK_AGENT_HARNESS=fake
# Containers reach the host through Docker's bridge, so listen on its gateway address
# (reachable from this machine and its containers only, never 0.0.0.0).
export BARRACK_CONTROL_PLANE_HOST="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
export BARRACK_SANDBOX_CONTROL_PLANE_URL=ws://host.docker.internal:8787

# Development: restarts on every change.
pnpm --filter @barrack/control-plane dev

# Built: compile once, then run, also serving the built web client.
pnpm build
BARRACK_WEB_CLIENT_DIRECTORY="$PWD/apps/web/dist" pnpm --filter @barrack/control-plane start
```

The built client is then at `http://<that address>:8787/` (add it to `BARRACK_ALLOWED_CLIENT_ORIGINS`). `pnpm --filter` runs scripts inside `apps/control-plane`, so give `BARRACK_WEB_CLIENT_DIRECTORY` as an absolute path.

To keep history across restarts locally, start the throwaway test database (below) and add `BARRACK_DATABASE_URL=postgres://barrack:barrack@127.0.0.1:54329/barrack_test BARRACK_DATABASE_TLS=disable`.

Logs are JSON lines on standard output. Every line about a thread carries its `threadId`; pipe through `pino-pretty` if you want them readable.

## Tests

`pnpm test` at the repository root runs them. They start a real control plane on an ephemeral port with the fake sandbox provider, create threads through the API, and drive them with real WebSocket connections from a fake supervisor (holding the token the provider was given) and test clients. Most run as development mode's user; the tests of sign-in and access control (`src/access-control.test.ts`, `src/authentication/`) verify real tokens from a test identity issuer ([`tests/test-identity-issuer`](../../tests/test-identity-issuer)), which serves a key set on localhost as Supabase does, so no Supabase project is needed.

The tests of the Postgres thread store, the Postgres event log and the migration runner need a real database. Without one they are skipped, and their names say why. To run them:

```sh
pnpm test-database:start   # Postgres 17 in Docker on 127.0.0.1:54329, data in memory
export BARRACK_TEST_DATABASE_URL=postgres://barrack:barrack@127.0.0.1:54329/barrack_test
pnpm test
pnpm test-database:stop    # removes the container and its data
```

Each test works in a schema of its own with a random name and drops it afterwards, so any database you can create schemas in will do. TLS is off for the test database unless `BARRACK_TEST_DATABASE_TLS=verify-full` (with `BARRACK_TEST_DATABASE_CA_CERTIFICATE` if needed). CI always runs them, against a Postgres service container.
