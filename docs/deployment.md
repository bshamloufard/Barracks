# Deploying Barrack

> [!WARNING]
> **Do not deploy Barrack to a public address until user sign-in exists.** This build has none: anyone who can reach the control plane can create threads, read every thread and command its agent, which runs any command in its sandbox and spends your model keys. The hosted path below is written so that it is ready when sign-in lands; until then, use the single-machine path, which publishes the control plane on `127.0.0.1` only.

There are two ways to run Barrack:

- **[Hosted](#hosted-railway-supabase-and-daytona)**: the control plane on Railway, Postgres on Supabase, sandboxes on Daytona. No machine of your own stays on. **Not yet tried against the real services**; see [what the first deployment must confirm](#not-yet-verified).
- **[On one machine](#on-one-machine-with-docker-compose)**: Postgres, the control plane and every sandbox in Docker on a machine you control, with Docker Compose. **Run end to end** (see [what was verified](#what-was-verified)).

Both run the same image, built by the [`Dockerfile`](../Dockerfile) at the repository root: the built control plane with its production dependencies only, and the built web client, which it serves. It runs as an unprivileged user, listens on port 8787, applies database migrations at startup, and on SIGTERM closes its connections, waits for sandbox creations under way and exits. It is configured entirely by environment variables. Its `control-plane-with-docker-cli` stage adds the Docker CLI, which only the Docker sandbox provider needs.

## Hosted: Railway, Supabase and Daytona

### What it costs

For one or two people with a few threads, about 40 sandbox-hours a month, as researched on **2026-11-24** (prices change; check each service's pricing page):

| Service                                                | Estimate                                                                                                                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Railway Hobby plan, control plane (~0.1 vCPU, ~256 MB) | $5 a month, which includes $5 of usage that covers it                                                                                                                                                          |
| Daytona, 40 h at 2 vCPU and 4 GiB ($0.1656 an hour)    | about $6.60, paid from Daytona's one-time $200 of free credit while it lasts (about 1,200 such hours); stopped sandboxes are archived after an hour, which ends their disk charge                              |
| Supabase Free plan                                     | $0, but a free project pauses after a week of too little database activity; the control plane's [keep-alive](../apps/control-plane/README.md#supabase) prevents that. Supabase Pro, which never pauses, is $25 |
| **Total**                                              | **about $5 a month** while the Daytona credit lasts, then about $12                                                                                                                                            |

Model usage is billed by your model provider and is likely the largest cost.

### 1. Supabase: the database

1. Create a project on the Free plan, in the region closest to the Railway region you will use. Keep its database password.
2. Open the project's **Connect** panel, choose **Session pooler**, and copy the string: `postgresql://postgres.<project-ref>:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres`. Put the password in it, [percent-encoding](https://en.wikipedia.org/wiki/Percent-encoding) any of `@ : / ? # & %` or spaces, and add no query parameters (the control plane refuses them). This is `BARRACK_DATABASE_URL`.
   - Why the session pooler: the direct host is IPv6 only on the Free plan, and Railway services have no outbound IPv6 unless it is turned on; the pooler is IPv4 on every plan, and session mode (port 5432) keeps the session that migrations' advisory lock needs. The transaction pooler (port 6543) does not. [Supabase: connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres).
3. Under **Database settings → SSL configuration**, download the certificate. Its contents are `BARRACK_DATABASE_CA_CERTIFICATE`: Supabase signs with its own authority, and the control plane verifies the server's certificate and host name (`verify-full`) against it. You can also turn on **Enforce SSL on incoming connections** there.

The control plane creates its tables in a schema of its own, `barrack`, with row level security on and no policies, so Supabase's Data API serves nothing from them. More in the [control plane's README](../apps/control-plane/README.md#supabase).

### 2. Daytona: the sandbox image

1. Create a Daytona account and an API key (`DAYTONA_API_KEY`).
2. Build the [sandbox image](../sandbox-image/README.md) for `linux/amd64`, which Daytona requires, with a tag of its own (Daytona rejects `latest`):

   ```sh
   docker build --platform linux/amd64 --file sandbox-image/Dockerfile --tag barrack-sandbox:$(git rev-parse --short HEAD) .
   ```

3. Push it as a snapshot with Daytona's CLI, choosing a new name for each build. Its name is `BARRACK_DAYTONA_SNAPSHOT`. A snapshot carries the size of the sandboxes made from it; see the command's `--help` for CPU, memory and disk (2 vCPU, 4 GiB and 8 GiB suit an agent).

   ```sh
   daytona snapshot push barrack-sandbox:<tag> --name barrack-sandbox-<tag>
   ```

**Tiers and network access.** On Daytona's Tier 1 (email verified) and Tier 2 (card added, $25 top-up), a sandbox can reach only Daytona's list of [essential services](https://www.daytona.io/docs/en/network-limits): package registries, GitHub, the major model providers, `*.supabase.co`, and `*.railway.app`, among others. So:

- The control plane must be reached at its **generated `*.up.railway.app` domain**. A custom domain of your own is not on the list and sandboxes could not connect to it.
- The agent cannot browse arbitrary websites. Full internet access starts at Tier 3, which needs a $500 top-up.
- Tier 1 pools a small allowance across running sandboxes (around 10 vCPU and 30 GiB of storage); each sandbox has at most 4 vCPU, 8 GiB of memory and 10 GiB of disk. A stopped sandbox holds storage until it is archived.

The Daytona provider turns Daytona's auto-stop off (it ignores an agent working inside the sandbox) and archives stopped sandboxes after `BARRACK_DAYTONA_AUTO_ARCHIVE_MINUTES`; see the [providers' README](../packages/sandbox-providers/README.md).

### 3. Railway: the control plane

The service is described as code in [`.railway/railway.ts`](../.railway/railway.ts), Railway's Infrastructure as Code, which replaced `railway.json` (deprecated; existing files stop being read on 2026-12-01). Railway does not read it when deploying: the Railway CLI applies it to your project. It sets the Dockerfile builder, the health check on `/health`, exactly one replica, no sleeping when idle, a 120-second drain for the control plane's shutdown, restarting after a crash, and every variable that is not a secret. The comments in the file say why for each. Use the Hobby plan or above: the Free plan runs services serverless, putting them to sleep when idle.

1. Create an empty project in Railway's dashboard.
2. With the [Railway CLI](https://docs.railway.com/cli) (5.42.1 or newer), from the repository root after `pnpm install`:

   ```sh
   railway login
   railway link            # choose the project and its environment
   railway config plan     # read what it will create
   railway config apply
   ```

   This creates the `control-plane` service. Read every later plan too: it marks any variable or setting it would delete.

3. In the service's settings, connect your GitHub repository (the root directory is the repository root). Railway finds the root `Dockerfile` and builds its last stage.
4. Under **Networking**, generate a domain for port 8787. The variables refer to it as `${{RAILWAY_PUBLIC_DOMAIN}}`, so generate it before the first deploy.
5. Under **Variables**, set the secrets marked "dashboard" below (the raw editor accepts the multi-line certificate). Sealing them hides them from the dashboard and API afterwards. For every model provider key you set, add a `preserve()` line to `.railway/railway.ts`, or a later apply may delete it.
6. Deploy.

#### Variables

Every variable the control plane reads in this deployment. A test ([`deployment-guide.test.ts`](../apps/control-plane/src/deployment-guide.test.ts)) fails if this table and the configuration schema disagree.

<!-- railway-variables:start -->

| Variable                                 | Required                     | Example                                                                                   | What it is for                                                                                                                                                                                             |
| ---------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                   | set by `.railway/railway.ts` | `8787`                                                                                    | Tells Railway which port to health-check and route its domain to; the image listens on 8787.                                                                                                               |
| `BARRACK_SANDBOX_PROVIDER`               | set by `.railway/railway.ts` | `daytona`                                                                                 | Which provider creates sandboxes.                                                                                                                                                                          |
| `BARRACK_SANDBOX_CONTROL_PLANE_URL`      | set by `.railway/railway.ts` | `wss://${{RAILWAY_PUBLIC_DOMAIN}}`                                                        | Where sandboxes' supervisors connect.                                                                                                                                                                      |
| `BARRACK_ALLOWED_CLIENT_ORIGINS`         | set by `.railway/railway.ts` | `https://${{RAILWAY_PUBLIC_DOMAIN}}`                                                      | Browser origins allowed to open threads and create them.                                                                                                                                                   |
| `BARRACK_AGENT_HARNESS`                  | set by `.railway/railway.ts` | `pi`                                                                                      | What runs in sandboxes: Pi, or `fake` for a smoke test without a model.                                                                                                                                    |
| `BARRACK_MODEL`                          | yes, dashboard               | `anthropic/<model-id>`                                                                    | Pi's model, as `provider/model`.                                                                                                                                                                           |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … | one, dashboard (secret)      | `sk-…`                                                                                    | The key for `BARRACK_MODEL`'s provider, forwarded to every sandbox until each user brings their own. The full list is in [`model-credentials.ts`](../apps/control-plane/src/threads/model-credentials.ts). |
| `DAYTONA_API_KEY`                        | yes, dashboard (secret)      | `dtn_…`                                                                                   | Daytona API key.                                                                                                                                                                                           |
| `BARRACK_DAYTONA_SNAPSHOT`               | yes, dashboard               | `barrack-sandbox-1a2b3c4`                                                                 | The snapshot pushed in step 2.                                                                                                                                                                             |
| `DAYTONA_TARGET`                         | no                           | `us`                                                                                      | Daytona region; the organisation's default when unset.                                                                                                                                                     |
| `BARRACK_DAYTONA_AUTO_ARCHIVE_MINUTES`   | no (60)                      | `60`                                                                                      | Minutes after a stop before Daytona archives a sandbox, ending its disk charge.                                                                                                                            |
| `BARRACK_DATABASE_URL`                   | yes, dashboard (secret)      | `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres` | Supabase's session pooler. Without it history is kept in memory and lost on every deploy.                                                                                                                  |
| `BARRACK_DATABASE_CA_CERTIFICATE`        | yes, dashboard               | `-----BEGIN CERTIFICATE-----…`                                                            | Supabase's certificate authority, to verify the database.                                                                                                                                                  |
| `BARRACK_DATABASE_TLS`                   | no (`verify-full`)           | `verify-full`                                                                             | Leave as it is for Supabase.                                                                                                                                                                               |
| `BARRACK_DATABASE_POOL_SIZE`             | no (5)                       | `5`                                                                                       | Connections held open; Supabase's session pooler allows 15 per role on the Free plan.                                                                                                                      |
| `BARRACK_DATABASE_KEEP_ALIVE_MINUTES`    | no (240)                     | `240`                                                                                     | Minutes between queries that keep a free Supabase project from pausing; 0 turns them off.                                                                                                                  |
| `PI_OFFLINE`, `PI_CACHE_RETENTION`       | no                           | `1`, `long`                                                                               | Pi's settings, forwarded to sandboxes.                                                                                                                                                                     |
| `BARRACK_LOG_LEVEL`                      | no (`info`)                  | `debug`                                                                                   | Log detail; logs are JSON lines in Railway's log view.                                                                                                                                                     |
| `BARRACK_CONTROL_PLANE_HOST`             | set by the image             | `0.0.0.0`                                                                                 | Interface to listen on; the image listens on all of them, as Railway requires.                                                                                                                             |
| `BARRACK_CONTROL_PLANE_PORT`             | set by the image             | `8787`                                                                                    | Port to listen on; keep it equal to `PORT`.                                                                                                                                                                |
| `BARRACK_WEB_CLIENT_DIRECTORY`           | set by the image             | `/opt/barrack/web`                                                                        | Where the image keeps the built web client.                                                                                                                                                                |

<!-- railway-variables:end -->

**Sign-in** will add variables of its own (for Supabase Auth); they belong in this table, and the test above fails until they are added.

#### After the first deploy, check

- The build log says it used the Dockerfile, and the deploy log shows, as JSON lines: `Applied a database migration` (once per migration, the first time), `Querying the database at this interval…` with `keepAliveIntervalInMinutes: 240`, `Creating thread sandboxes` with `sandboxProvider: "daytona"`, and `Control plane listening` on `0.0.0.0:8787`. The deployment turns active once `/health` answers.
- `https://<domain>/health` answers `{"status":"ok"}` and `https://<domain>/` shows the thread list.
- Creating a thread makes a sandbox appear in Daytona's dashboard, the log shows `The thread's sandbox is ready` and then `Supervisor connected` for that `threadId`, and a message gets a reply.
- Closing the tab and reopening the thread shows its whole history; a redeploy keeps it, the old deployment's log ends with `Shut down cleanly`, and the supervisors reconnect to the new one.
- In Supabase's table editor, the `barrack` schema holds `threads`, `thread_events` and `schema_migrations`.

#### Not yet verified

None of this has run against Railway, Supabase or Daytona: there were no credentials to do so. What has been checked is listed under [what was verified](#what-was-verified). The first real deployment must confirm:

1. **Railway's Infrastructure as Code**: `.railway/railway.ts` type-checks against the `railway` SDK (3.16.0) and evaluates to the expected service, but has never been planned or applied. Confirm that `railway config apply` creates the service with these settings, that `preserve()` accepts a variable not yet set (if the plan refuses, set the secrets in the dashboard first and apply again), whether an apply deletes variables the file leaves out, and that `${{RAILWAY_PUBLIC_DOMAIN}}` resolves inside these variables.
2. **The build on Railway**: the image has been built here only with base images that carry a local proxy's certificate authority, and in CI with the real ones; Railway's builder has not built it.
3. **Port and health check**: that `PORT=8787` makes Railway health-check and route its generated domain to 8787.
4. **Shutdown on redeploy**: that Railway sends SIGTERM and allows the 120-second drain, and that with no overlap supervisors and browsers reconnect to the new deployment. A thread created in the seconds a redeploy takes may be marked failed: the new instance fails, at startup, every thread still being created, assuming it is the only instance.
5. **Supabase**: that the session pooler accepts the connection with `verify-full` against the downloaded certificate, and that the keep-alive's query counts as activity. Supabase does not define "sufficient activity"; it emails a warning about a week before pausing a project, so watch for one in the first weeks.
6. **Daytona**: the provider has only run against a stand-in for Daytona's API. Confirm the snapshot push command (Daytona's CLI for its generally available platform may be installed as `daytona` or `daytona-v0`) and its size flags, that a Tier 1 sandbox's supervisor can hold a WebSocket open to `*.up.railway.app`, and how the supervisor's token, which is in the sandbox's environment, can be reached through Daytona's own command interface (see the open gaps in the [decision log](decisions.md)).
7. **Costs**: the figures above come from pricing pages, not from a bill.

## On one machine with Docker Compose

[`compose.yaml`](../compose.yaml) runs Postgres, the control plane and a Docker socket proxy; the control plane creates each thread's sandbox as a sibling container on the same Docker. It needs Docker Engine with Compose 2.24 or newer, on Linux or Docker Desktop.

1. Build the sandbox image (`barrack-sandbox:dev`): `pnpm sandbox-image:build`, or without Node, `docker build --file sandbox-image/Dockerfile --tag barrack-sandbox:dev .`
2. Write a `.env` file beside `compose.yaml` (it is ignored by Git):

   ```sh
   BARRACK_DATABASE_PASSWORD=<letters and digits>
   BARRACK_MODEL=anthropic/<model-id>
   ANTHROPIC_API_KEY=<your key>
   # Or, to try it without a model: BARRACK_AGENT_HARNESS=fake
   ```

   Every variable in it reaches the control plane, so the control plane's other settings ([its README](../apps/control-plane/README.md#configuration)) can go here too. With rootless Docker, also set `DOCKER_SOCKET` to its socket's path.

3. `docker compose up --build --detach`, then open <http://localhost:8787/>.

The port is published on `127.0.0.1` only. To use it from another machine, forward it over SSH (`ssh -L 8787:127.0.0.1:8787 <host>`) rather than publishing it, until sign-in exists.

**Stopping.** Sandboxes are not part of the Compose project, so remove them first, then the rest; `--volumes` also deletes the database:

```sh
docker ps --all --quiet --filter label=barrack.sandbox | xargs -r docker rm --force
docker compose down
```

### What can reach what

| Network      | Members                                   | Internet              |
| ------------ | ----------------------------------------- | --------------------- |
| `database`   | Postgres, the control plane               | none (internal)       |
| `docker-api` | the socket proxy, the control plane       | none (internal)       |
| `sandboxes`  | the control plane, every thread's sandbox | yes, for agents' work |

A sandbox reaches the control plane as `ws://control-plane:8787`, and the internet. It cannot reach Postgres or the socket proxy, whose networks it never joins, and the Docker socket is not in it. Sandboxes can reach each other, as they could on Docker's default bridge, and, like any container, services on the host that listen on all interfaces.

### The Docker socket

Whoever can create containers through Docker's API can start one that is privileged or mounts the host's files, and so controls the host as root. The control plane must create containers, so **a flaw in the control plane could become control of the machine.** Run this only on a machine you would trust it with. Two things narrow the exposure:

- The control plane never holds the socket. It reaches Docker through [wollomatic/socket-proxy](https://github.com/wollomatic/socket-proxy), which answers only the control plane and forwards only the calls the Docker provider makes: create, start, stop, wait for and remove a container, inspect a sandbox by name or ID, and the version check. Listing containers, `exec`, logs, pulls, builds, volumes and networks are refused. The proxy holds no capabilities and has a read-only filesystem.
- It cannot read other containers: it cannot list them, and it may inspect only containers named `barrack-thread-…` or ones whose full ID it already knows.

The proxy does not look inside a create request, so it cannot stop a privileged one; a check showed it accepting one. Filtering request bodies, or a Docker authorization plugin, would close that and is not done.

### What was verified

On 2026-11-24, on one Linux machine with Docker 29.9 and Compose 5.7, building with local base images that carry a proxy's certificate authority (the build arguments `NODE_IMAGE`, `RUNTIME_BASE_IMAGE` and `DOCKER_CLI_IMAGE` replace the base images; nothing about that is committed):

- The image alone, against a throwaway Postgres: migrations applied, `/health` answered `{"status":"ok"}`, `/` served the web client, a thread was created, the keep-alive queried every minute when set to 1, and SIGTERM ended it with `Shut down cleanly` and exit code 0 in 0.1 seconds.
- Compose: a thread created through the API got a sandbox container from `barrack-sandbox:dev` on the `barrack-sandboxes` network; a message sent through a client WebSocket was recorded and answered by the fake agent, and the run settled; after the control plane restarted, the thread's history replayed from Postgres and every supervisor reconnected. From inside a sandbox, as the agent's user: the control plane connected; `database` and `docker-api` did not resolve, their addresses timed out, the published port on the network's gateway was refused, and no Docker socket existed. Through the proxy, `docker ps` and `docker exec` were refused.
