# @barrack/control-plane

The service between thread sandboxes and clients. Each thread's sandbox supervisor connects to it over a WebSocket, and so does each client viewing the thread. The control plane records every agent event in the thread's ordered history before showing it to anyone, relays streamed text live, and passes the user's messages and interrupts to the supervisor.

> **Do not expose this build to a network.** Clients are not authenticated until Milestone 3: anyone who can reach the port can read every thread and send messages to its agent. It listens only on `127.0.0.1` by default, and checks the `Origin` header so that other websites open in your browser cannot connect. Keep it that way.

History is stored in Postgres when `BARRACK_DATABASE_URL` is set, and survives restarts. Without it, history is kept in memory and lost when the process stops, which suits local development only; the control plane says so in a warning at startup.

## How it is organised

| Path                          | What it holds                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                 | Reads configuration, opens the event log, starts the server, shuts down on SIGINT or SIGTERM.                          |
| `src/migrate.ts`              | Applies pending database migrations and exits.                                                                         |
| `src/configuration.ts`        | Environment variables, validated together at startup.                                                                  |
| `src/control-plane-server.ts` | One HTTP server on one port: HTTP routes plus both WebSocket endpoints.                                                |
| `src/http-app.ts`             | `GET /health`, and the built web client when configured (Hono).                                                        |
| `src/database/`               | Database settings, the connection pool, the migration runner, and waiting for the database at startup (`pg`).          |
| `migrations/`                 | The SQL migrations, applied in name order.                                                                             |
| `src/thread-event-log/`       | The `ThreadEventLog` interface, which assigns sequences, with its Postgres and in-memory implementations.              |
| `src/thread-relay/`           | `ThreadRelay`: per-thread ordering of recording, broadcasting, paged replay and in-progress text. No sockets in here.  |
| `src/websocket/`              | Upgrade routing, supervisor authorisation, origin check, frame validation, heartbeats and slow-client handling (`ws`). |
| `src/test-support/`           | Fake peers and fake connections, a pausable event log, the log contract suite, test database helpers. Not built.       |

The endpoints and messages are defined in [`@barrack/protocol`](../../packages/protocol); see [docs/architecture.md](../../docs/architecture.md) for how they fit together.

## Configuration

| Variable                          | Default                                                                                   | Meaning                                                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BARRACK_SUPERVISOR_TOKEN`        | none, required                                                                            | Shared secret every supervisor sends as `Authorization: Bearer <token>`. At least 32 characters. Never logged.                                      |
| `BARRACK_CONTROL_PLANE_HOST`      | `127.0.0.1`                                                                               | Interface to listen on.                                                                                                                             |
| `BARRACK_CONTROL_PLANE_PORT`      | `8787`                                                                                    | Port for HTTP and both WebSocket endpoints.                                                                                                         |
| `BARRACK_ALLOWED_CLIENT_ORIGINS`  | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:8787,http://127.0.0.1:8787` | Comma-separated browser origins allowed to open the client endpoint.                                                                                |
| `BARRACK_WEB_CLIENT_DIRECTORY`    | unset                                                                                     | Directory of the built web client (`apps/web/dist`). When set, the control plane serves it.                                                         |
| `BARRACK_LOG_LEVEL`               | `info`                                                                                    | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                                                                                     |
| `BARRACK_DATABASE_URL`            | unset: history in memory                                                                  | `postgres://user:password@host:port/database`, with no query parameters. Never logged; logs name only the host, port and database.                  |
| `BARRACK_DATABASE_TLS`            | `verify-full`                                                                             | `verify-full` encrypts and checks the server's certificate and host name. `disable` sends everything in the clear; see below for when that is fine. |
| `BARRACK_DATABASE_CA_CERTIFICATE` | unset: the authorities Node trusts                                                        | PEM text of the certificate authority to trust instead. Required for Supabase.                                                                      |
| `BARRACK_DATABASE_POOL_SIZE`      | `5`                                                                                       | Most database connections one control plane holds open at once (1 to 100).                                                                          |

If anything is wrong, the control plane refuses to start and lists every problem.

## The database

Postgres 16 and 17 are tested; CI uses 17, which Supabase runs. The control plane keeps its tables in a schema of its own, `barrack`, creating it if needed, so the database role it connects as needs permission to create a schema (the owner of the database has it).

### Supabase

- **Connect through the session pooler**, on port 5432: the _Session pooler_ string in the project's **Connect** panel, which looks like `postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`. The direct connection (`db.<project-ref>.supabase.co`) is IPv6 only, and Railway services have no outbound IPv6 unless it is turned on. The transaction pooler (port 6543) does not keep a session per client, which breaks the advisory lock migrations rely on, and prepared statements.
- **Trust Supabase's certificate authority.** Supabase signs its database certificates with its own authority, so verification fails without it. Download it under **Database settings → SSL configuration** and put the file's contents in `BARRACK_DATABASE_CA_CERTIFICATE` (Railway accepts multi-line values). Leave `BARRACK_DATABASE_TLS` at `verify-full`. If the certificate cannot be verified, the control plane refuses to start and says which variable to set.
- **Pool size.** The session pooler serves at most the project's _Pool Size_ connections (15 by default) per database role, shared with everything else using that role. The default of 5 leaves room for a second control plane during a redeploy, and for you.
- **Free projects pause** after a week without enough database activity. The control plane queries the database only when a thread is being used, so a week with no use at all pauses the project.

The tables are not exposed through Supabase's Data API: it serves only the schemas you list as exposed, and every table has row level security turned on with no policies, so even an exposed schema would yield no rows to the `anon` or `authenticated` roles. See the comment at the top of [the first migration](migrations/0001_create_thread_event_log.sql).

### Other Postgres

- With a certificate from a public authority, set only `BARRACK_DATABASE_URL`.
- With a private authority, also set `BARRACK_DATABASE_CA_CERTIFICATE` to its certificate, for example `BARRACK_DATABASE_CA_CERTIFICATE="$(cat root.crt)"`.
- A database without TLS on the same machine or a private network (a local Docker container, say) needs `BARRACK_DATABASE_TLS=disable`; the control plane warns at startup that the connection is unencrypted. Never use it across the internet.

### Migrations

Migrations are plain SQL files in [`migrations/`](migrations), named `NNNN_description.sql` and applied in name order, each in its own transaction, with unqualified names created in the `barrack` schema. The control plane applies any pending ones at startup, before it accepts connections, so deploying a new version is all it takes; `pnpm --filter @barrack/control-plane migrate` applies them without starting the server (after `pnpm build`, with the same database variables).

- Applied migrations are recorded, with a checksum, in `barrack.schema_migrations`. **Never edit a migration that has been applied anywhere**: the control plane refuses to start if an applied file has changed, or if the database has a migration this build lacks (as after rolling back to an older version). Put every change in a new file.
- Two instances starting at once take turns under a Postgres advisory lock, so each migration runs once.

### When the database is unavailable

- At startup the control plane waits for the database, retrying with growing delays up to 30 seconds and logging each failure, and does not listen until it has migrated. A deployment that cannot reach its database therefore fails its health check instead of restarting in a loop. Errors that waiting cannot fix, such as a wrong password, an unverifiable certificate or a failing migration, stop it with a message.
- While running, a query waits at most 10 seconds for a connection and 30 seconds for an answer. An event that cannot be recorded disconnects its supervisor, which reconnects; a client whose history cannot be read is disconnected, and reconnects. Nothing crashes, and once the database answers again everything carries on.
- `GET /health` reports only that the process is up. A separate readiness check is not needed, because the server does not listen until the database is migrated, and Railway consults the health check only while a deployment starts.

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

To keep history across restarts locally, start the throwaway test database (below) and add `BARRACK_DATABASE_URL=postgres://barrack:barrack@127.0.0.1:54329/barrack_test BARRACK_DATABASE_TLS=disable`.

Logs are JSON lines on standard output. Every line about a thread carries its `threadId`; pipe through `pino-pretty` if you want them readable.

## Tests

`pnpm test` at the repository root runs them. They start a real control plane on an ephemeral port and drive it with real WebSocket connections from a fake supervisor and test clients.

The tests of the Postgres event log and the migration runner need a real database. Without one they are skipped, and their names say why. To run them:

```sh
pnpm test-database:start   # Postgres 17 in Docker on 127.0.0.1:54329, data in memory
export BARRACK_TEST_DATABASE_URL=postgres://barrack:barrack@127.0.0.1:54329/barrack_test
pnpm test
pnpm test-database:stop    # removes the container and its data
```

Each test works in a schema of its own with a random name and drops it afterwards, so any database you can create schemas in will do. TLS is off for the test database unless `BARRACK_TEST_DATABASE_TLS=verify-full` (with `BARRACK_TEST_DATABASE_CA_CERTIFICATE` if needed). CI always runs them, against a Postgres service container.
