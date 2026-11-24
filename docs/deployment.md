# Deploying Barrack

> [!WARNING]
> **Nothing here has been deployed yet.** Sign-in exists: users sign in with Supabase Auth, the control plane verifies every access token itself, admits only the email addresses you list, and shows each user only their own threads. But it has never run against a real Supabase project, Railway or Daytona (see [what the first deployment must confirm](#not-yet-verified)), and some limits remain: the model provider keys you configure reach every sandbox, where any agent can read them; a thread's branch, which the agent writes, is pushed into the user's own repository, where its continuous integration runs it with the repository's secrets (see [GitHub](#4-github-optional-private-repositories-and-pull-requests)); and the gaps listed in the [decision log](decisions.md) under "Security gaps that remain open" are still open. Admit only people you trust with your keys and your sandbox budget.

There are two ways to run Barrack:

- **[Hosted](#hosted-railway-supabase-and-daytona)**: the control plane on Railway, Postgres on Supabase, sandboxes on Daytona. No machine of your own stays on. **Not yet tried against the real services**; see [what the first deployment must confirm](#not-yet-verified).
- **[On one machine](#on-one-machine-with-docker-compose)**: Postgres, the control plane and every sandbox in Docker on a machine you control, with Docker Compose, signing in through a Supabase project. **Run end to end before sign-in existed**, not since (see [what was verified](#what-was-verified)).

Both run the same image, built by the [`Dockerfile`](../Dockerfile) at the repository root: the built control plane with its production dependencies only, and the built web client, which it serves. It runs as an unprivileged user, listens on port 8787, applies database migrations at startup, and on SIGTERM closes its connections, waits for sandbox creations under way and exits. It is configured entirely by environment variables. It carries Git, with which it checks and pushes the branches threads publish. Its `control-plane-with-docker-cli` stage adds the Docker CLI, which only the Docker sandbox provider needs.

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

### 1b. Supabase: sign-in

The same project signs users in. The web client asks for a six-digit code by email and hands the control plane the access token Supabase gives it; the control plane checks it against the project's published public keys, so it never needs a secret key. In the project's dashboard:

1. **Asymmetric signing keys.** Under **Project Settings → JWT Keys**, the current key must be asymmetric (ECC P-256 is recommended). New projects have one; a project still on the legacy HS256 secret must rotate to one. The control plane fetches the public keys at startup and refuses to start, saying so, if there are none. Until it has read them it does not listen; while Supabase cannot be reached, or answers with anything but a key set, it logs each attempt and tries again, for as long as it takes, as it does for the database.
2. **The code in the email.** Under **Authentication → Email Templates**, edit the **Magic Link** template to include `{{ .Token }}`, the code, for example `<p>Your Barrack code: {{ .Token }}</p>`. No redirect URLs are needed.
3. **Mail for everyone else.** Supabase's built-in sender delivers only to the project's team members, about twice an hour. For anyone outside the team to sign in, set up custom SMTP under **Authentication → SMTP Settings**.
4. **Sign-ups off.** Supabase lets anyone sign up by default. List the addresses that may use Barrack in `BARRACK_ALLOWED_USER_EMAILS` (the control plane refuses everyone else, once Supabase confirms they own their address), and once each of them has signed in once, turn off **Allow new users to sign up** under **Authentication → Sign In / Providers**. Leave "Confirm email" on and anonymous sign-ins off, as they are by default.
5. **The publishable key only.** Under **Project Settings → API Keys**, copy the project URL (`BARRACK_SUPABASE_URL`) and the **publishable** key, `sb_publishable_…` (`BARRACK_SUPABASE_PUBLISHABLE_KEY`). It is handed to every browser. Never use the secret key or the legacy `service_role` key: the control plane refuses to start with one.

More in the [control plane's README](../apps/control-plane/README.md#signing-users-in).

### 2. Daytona: the sandbox image

1. Create a Daytona account and an API key (`DAYTONA_API_KEY`).
2. Build the [sandbox image](../sandbox-image/README.md) for `linux/amd64`, which Daytona requires, with a tag of its own (Daytona rejects `latest`):

   ```sh
   docker build --platform linux/amd64 --file sandbox-image/Dockerfile --tag barrack-sandbox:$(git rev-parse --short HEAD) .
   ```

   Build it from the same revision as the control plane. A supervisor speaks one protocol version, and the control plane refuses any other, so a snapshot from an older build cannot connect: its supervisor exits saying which version was expected. The image also gives the supervisor a state directory of its own, `/var/lib/barrack/supervisor` (`BARRACK_SUPERVISOR_STATE_DIRECTORY`), where it records how far the agent has been handed user messages; a custom image must provide one that only the supervisor's user can write.

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
5. Under **Variables**, set the values marked "dashboard" below (the raw editor accepts the multi-line certificate). Sealing them hides them from the dashboard and API afterwards. For every model provider key you set, add a `preserve()` line to `.railway/railway.ts`, or a later apply may delete it.
6. Deploy.

### 4. GitHub (optional): private repositories and pull requests

Without this step, threads can start from public repositories, cloned without credentials, and nothing can be published; the settings page and the new-thread form say that GitHub is not set up. With it, users connect their GitHub account in Settings, start threads on their own repositories, and push a thread's branch or open a pull request from the thread's page. How it works, and what it does not protect against, is in the [architecture](architecture.md#working-with-a-git-repository) and the [decision log](decisions.md).

Register a GitHub App for your installation (on GitHub: **Settings → Developer settings → GitHub Apps → New GitHub App**, or the same under an organisation's settings), with exactly these settings, `<domain>` being the control plane's public domain:

| Setting | Value | Why |
| --- | --- | --- |
| Homepage URL | `https://<domain>` | GitHub requires one. |
| Callback URL | `https://<domain>/github/callback` | The web client's page that finishes connecting. It must be the first callback URL: Barrack sends no `redirect_uri`, so GitHub uses the first. |
| Expire user authorization tokens | on (the default) | Barrack revokes the user's token as soon as it has read their repositories, and never stores it; expiry is a second fence. |
| Request user authorization (OAuth) during installation | **off** | That flow comes back without the single-use `state` Barrack ties each sign-in to, and would be refused. Barrack starts the sign-in itself. |
| Enable Device Flow | off | Not used. |
| Setup URL | `https://<domain>/?page=settings`, with **Redirect on update** on | After installing, users land in Settings and connect. The `installation_id` GitHub adds is ignored: it can be spoofed, and Barrack asks GitHub which installations the user can reach instead. |
| Webhook | **Active** off | Barrack uses no webhooks. |
| Repository permissions | **Contents: Read and write**, **Pull requests: Read and write**, **Metadata: Read-only** | Read for the sandbox's clone, write for the control plane's push, pull requests to open one, metadata to check the user may still push. Nothing else, and never **Workflows**: without it, GitHub refuses any push that changes `.github/workflows`. |
| Organization and account permissions | none | |
| Where can this GitHub App be installed? | **Only on this account** if every repository is yours or this organisation's; otherwise **Any account** | GitHub lets a private App be installed only on the account that owns it. A public App grants nothing by itself: only users of this installation who connect their GitHub account in Barrack can use it, and only on repositories they can push to. |

Then, on the App's page:

1. Note the **Client ID** (`BARRACK_GITHUB_APP_CLIENT_ID`) and the App's URL name, the last part of `https://github.com/apps/<slug>` (`BARRACK_GITHUB_APP_SLUG`).
2. **Generate a new client secret** (`BARRACK_GITHUB_APP_CLIENT_SECRET`).
3. **Generate a private key**, which downloads a `.pem` file. Its whole contents are `BARRACK_GITHUB_APP_PRIVATE_KEY`; a dashboard that stores it on one line, with `\n` for each line break, works too. Keep no other copy.
4. Set the four in Railway's dashboard, sealed, and add a `preserve()` line for each to `.railway/railway.ts`, as for model provider keys. All four or none: the control plane refuses to start with some only.
5. **Install App**, on the repositories threads may work on. Users then connect GitHub in Barrack's Settings.

GitHub's [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) can register an App from a description in one click, but it hands the private key and secrets back to a page of the registering application, which would then have to store them or show them once to be pasted into these variables, and redeploy: no fewer steps for something done once, and a route that receives the App's key. Registering by hand was chosen instead.

What to set on GitHub besides, since Barrack cannot enforce it:

- **Protect the default branch** (and any branch that deploys) with a ruleset or branch protection requiring a pull request. Barrack pushes only to `barrack/<thread>` and the sandbox holds no token that can write, but these rules guard against everything else. On a private repository they need a paid GitHub plan.
- **Keep repository secrets from untrusted branches.** A thread's branch lives in the repository itself, so a workflow triggered by `push` or `pull_request` runs the agent's code with the secrets branches of the repository get, which a fork's pull request would not. Put deployment secrets in [environments](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment) with required reviewers, or keep workflows that hold secrets off branches matching `barrack/*`.
- **Two people for a merge**, if you want one: the pull request is opened by the App, so the user who asked can approve it alone; require two approvals or code owners to prevent that.

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
| `BARRACK_AUTHENTICATION`                 | set by `.railway/railway.ts` | `supabase`                                                                                | Users sign in with Supabase Auth. The other value, `development-single-user`, is refused anywhere but a loopback address.                                                                                  |
| `BARRACK_SUPABASE_URL`                   | yes, dashboard               | `https://<project-ref>.supabase.co`                                                       | The Supabase project users sign in with ([step 1b](#1b-supabase-sign-in)).                                                                                                                                 |
| `BARRACK_SUPABASE_PUBLISHABLE_KEY`       | yes, dashboard               | `sb_publishable_…`                                                                        | The project's publishable key, handed to every browser. A secret key is refused.                                                                                                                           |
| `BARRACK_ALLOWED_USER_EMAILS`            | yes, dashboard               | `you@example.com,friend@example.com`                                                      | Who may use this installation, or `anyone-who-can-sign-in`. An address counts once Supabase confirms the user owns it.                                                                                     |
| `BARRACK_SUPABASE_JWT_ISSUER`            | no (`<URL>/auth/v1`)         | `https://auth.example.com/auth/v1`                                                        | The `iss` the project's tokens carry, only if a custom domain changes it.                                                                                                                                  |
| `BARRACK_MODEL`                          | yes, dashboard               | `anthropic/<model-id>`                                                                    | Pi's model, as `provider/model`.                                                                                                                                                                           |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … | one, dashboard (secret)      | `sk-…`                                                                                    | The key for `BARRACK_MODEL`'s provider, forwarded to every sandbox until each user brings their own. The full list is in [`model-credentials.ts`](../apps/control-plane/src/threads/model-credentials.ts). |
| `DAYTONA_API_KEY`                        | yes, dashboard (secret)      | `dtn_…`                                                                                   | Daytona API key.                                                                                                                                                                                           |
| `BARRACK_DAYTONA_SNAPSHOT`               | yes, dashboard               | `barrack-sandbox-1a2b3c4`                                                                 | The snapshot pushed in step 2.                                                                                                                                                                             |
| `DAYTONA_TARGET`                         | no                           | `us`                                                                                      | Daytona region; the organisation's default when unset.                                                                                                                                                     |
| `BARRACK_DAYTONA_AUTO_ARCHIVE_MINUTES`   | no (60)                      | `60`                                                                                      | Minutes after a stop before Daytona archives a sandbox, ending its disk charge.                                                                                                                            |
| `BARRACK_SANDBOX_IDLE_MINUTES`           | no (10)                      | `10`                                                                                      | A running sandbox with no message and no agent activity for this long, and no run open, is stopped; a message wakes it.                                                                                    |
| `BARRACK_RUNNING_SANDBOXES_PER_USER`     | no (3)                       | `3`                                                                                       | How many sandboxes one user may have running (or starting, or stopping) at once.                                                                                                                           |
| `BARRACK_RUNNING_SANDBOXES_IN_TOTAL`     | no (no limit)                | `3`                                                                                       | How many may run at once in the whole installation; set it to what the Daytona plan's resources allow.                                                                                                     |
| `BARRACK_SANDBOX_CHECK_SECONDS`          | no (30)                      | `30`                                                                                      | How often sandboxes are compared with Daytona and checked for idleness; an operation cut short by a redeploy is finished within two of these.                                                              |
| `BARRACK_DATABASE_URL`                   | yes, dashboard (secret)      | `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres` | Supabase's session pooler. Without it history is kept in memory and lost on every deploy.                                                                                                                  |
| `BARRACK_DATABASE_CA_CERTIFICATE`        | yes, dashboard               | `-----BEGIN CERTIFICATE-----…`                                                            | Supabase's certificate authority, to verify the database.                                                                                                                                                  |
| `BARRACK_DATABASE_TLS`                   | no (`verify-full`)           | `verify-full`                                                                             | Leave as it is for Supabase.                                                                                                                                                                               |
| `BARRACK_DATABASE_POOL_SIZE`             | no (5)                       | `5`                                                                                       | Connections held open; Supabase's session pooler allows 15 per role on the Free plan.                                                                                                                      |
| `BARRACK_DATABASE_KEEP_ALIVE_MINUTES`    | no (240)                     | `240`                                                                                     | Minutes between queries that keep a free Supabase project from pausing; 0 turns them off.                                                                                                                  |
| `PI_OFFLINE`, `PI_CACHE_RETENTION`       | no                           | `1`, `long`                                                                               | Pi's settings, forwarded to sandboxes.                                                                                                                                                                     |
| `BARRACK_GITHUB_APP_CLIENT_ID`           | no, dashboard                | `Iv23li…`                                                                                 | The GitHub App's client ID ([step 4](#4-github-optional-private-repositories-and-pull-requests)). With the next three, or none: without them threads clone public repositories only.                          |
| `BARRACK_GITHUB_APP_CLIENT_SECRET`       | no, dashboard (secret)       | `…`                                                                                       | The App's client secret, with which the control plane exchanges a user's sign-in code.                                                                                                                     |
| `BARRACK_GITHUB_APP_PRIVATE_KEY`         | no, dashboard (secret)       | `-----BEGIN RSA PRIVATE KEY-----…`                                                        | The App's private key; it never leaves the control plane, which signs with it to mint short-lived tokens.                                                                                                 |
| `BARRACK_GITHUB_APP_SLUG`                | no, dashboard                | `barrack-for-me`                                                                          | The App's URL name, for the link that installs it.                                                                                                                                                         |
| `BARRACK_GITHUB_URL`                     | no (`https://github.com`)    | `https://github.com`                                                                      | Where GitHub is; leave it unset. Tests point it at a stand-in.                                                                                                                                             |
| `BARRACK_GITHUB_API_URL`                 | no (`https://api.github.com`) | `https://api.github.com`                                                                 | Where GitHub's API is; leave it unset. Tests point it at a stand-in.                                                                                                                                       |
| `BARRACK_ALLOW_PLAIN_HTTP_REPOSITORIES`  | never in a deployment        | `development-only`                                                                        | Accepts `http://` repositories and GitHub addresses, for tests and local Git servers only.                                                                                                                 |
| `BARRACK_LOG_LEVEL`                      | no (`info`)                  | `debug`                                                                                   | Log detail; logs are JSON lines in Railway's log view.                                                                                                                                                     |
| `BARRACK_CONTROL_PLANE_HOST`             | set by the image             | `0.0.0.0`                                                                                 | Interface to listen on; the image listens on all of them, as Railway requires.                                                                                                                             |
| `BARRACK_CONTROL_PLANE_PORT`             | set by the image             | `8787`                                                                                    | Port to listen on; keep it equal to `PORT`.                                                                                                                                                                |
| `BARRACK_WEB_CLIENT_DIRECTORY`           | set by the image             | `/opt/barrack/web`                                                                        | Where the image keeps the built web client.                                                                                                                                                                |

<!-- railway-variables:end -->

#### After the first deploy, check

- The build log says it used the Dockerfile, and the deploy log shows, as JSON lines: `Applied a database migration` (once per migration, the first time), `Querying the database at this interval…` with `keepAliveIntervalInMinutes: 240`, `Creating thread sandboxes` with `sandboxProvider: "daytona"`, and `Control plane listening` on `0.0.0.0:8787`. The deployment turns active once `/health` answers.
- `https://<domain>/health` answers `{"status":"ok"}` and `https://<domain>/` asks you to sign in. A code arrives by email for an address on `BARRACK_ALLOWED_USER_EMAILS`, and signing in with it shows the thread list; another address is told it is not allowed.
- Creating a thread makes a sandbox appear in Daytona's dashboard, the log shows `The thread's sandbox is ready` and then `Supervisor connected` for that `threadId`, and a message gets a reply.
- Closing the tab and reopening the thread shows its whole history; a redeploy keeps it, the old deployment's log ends with `Shut down cleanly`, and the supervisors reconnect to the new one.
- In Supabase's table editor, the `barrack` schema holds `users`, `threads`, `thread_events`, `thread_sequence_counters`, `thread_repositories`, `github_connections`, `github_connection_attempts` and `schema_migrations`.

#### Not yet verified

None of this has run against Railway, Supabase or Daytona: there were no credentials to do so. What has been checked is listed under [what was verified](#what-was-verified). The first real deployment must confirm:

1. **Railway's Infrastructure as Code**: `.railway/railway.ts` type-checks against the `railway` SDK (3.16.0) and evaluates to the expected service, but has never been planned or applied. Confirm that `railway config apply` creates the service with these settings, that `preserve()` accepts a variable not yet set (if the plan refuses, set the secrets in the dashboard first and apply again), whether an apply deletes variables the file leaves out, and that `${{RAILWAY_PUBLIC_DOMAIN}}` resolves inside these variables.
2. **The build on Railway**: the image has been built here only with base images that carry a local proxy's certificate authority, and in CI with the real ones; Railway's builder has not built it.
3. **Port and health check**: that `PORT=8787` makes Railway health-check and route its generated domain to 8787.
4. **Shutdown on redeploy**: that Railway sends SIGTERM and allows the 120-second drain, and that with no overlap supervisors and browsers reconnect to the new deployment. If the old instance is killed in the middle of creating, stopping or starting a sandbox, the new one takes the operation over once its lease lapses (within two `BARRACK_SANDBOX_CHECK_SECONDS`); confirm that in the log (`Taking over a sandbox operation…`).
5. **Supabase**: that the session pooler accepts the connection with `verify-full` against the downloaded certificate, and that the keep-alive's query counts as activity. Supabase does not define "sufficient activity"; it emails a warning about a week before pausing a project, so watch for one in the first weeks.
6. **Daytona**: the provider has only run against a stand-in for Daytona's API. Confirm the snapshot push command (Daytona's CLI for its generally available platform may be installed as `daytona` or `daytona-v0`) and its size flags, that a Tier 1 sandbox's supervisor can hold a WebSocket open to `*.up.railway.app`, and how the supervisor's token, which is in the sandbox's environment, can be reached through Daytona's own command interface (see the open gaps in the [decision log](decisions.md)). For the lifecycle: that stopping a sandbox lets its supervisor end the agent's run (Daytona's stop is not known to send a signal the supervisor can act on; the control plane interrupts the agent first and closes any run left open, so history stays right either way); that starting a sandbox **archived** after `BARRACK_DAYTONA_AUTO_ARCHIVE_MINUTES` restores it with its files and Pi's session, and how long that takes (the page shows "Waking the sandbox…" meanwhile, and the lease is renewed for as long as it takes); that `getStatus` reports an archived sandbox as `stopped`, and a deleted one as `missing`; and that a stopped or archived sandbox no longer counts against the organisation's limits on running resources, while it still counts against storage until deleted (delete threads you no longer need).
7. **Sign-in**: it has run only against the tests' stand-in for Supabase Auth, which signs tokens the way Supabase documents. Confirm that the control plane finds the project's published keys at startup, that the Magic Link template's code arrives (through custom SMTP for anyone outside the project's team), that signing in with it gives a token the control plane accepts, that its check of a listed address against Supabase (`/auth/v1/user`) admits a confirmed user and refuses others, and that a token refreshed while a thread is open keeps its connection open.
8. **Costs**: the figures above come from pricing pages, not from a bill.
9. **GitHub**: nothing has run against a real GitHub App; every flow ran only against the tests' stand-in, which answers as GitHub's documentation describes. Confirm that linking with the settings above works (the callback reaches `/github/callback` with a code and the state, and finishing it lists your repositories), that a sandbox clones a private repository with the token the control plane mints and cannot push with it, that publishing pushes `barrack/<thread>` and opens one pull request as the App, and that a push changing `.github/workflows` is refused by GitHub with a message the thread shows. GitHub's new, longer token format (rolling out since 2026-04-27) fits every limit here, but has not been seen.

## On one machine with Docker Compose

[`compose.yaml`](../compose.yaml) runs Postgres, the control plane and a Docker socket proxy; the control plane creates each thread's sandbox as a sibling container on the same Docker. It needs Docker Engine with Compose 2.24 or newer, on Linux or Docker Desktop.

1. Build the sandbox image (`barrack-sandbox:dev`): `pnpm sandbox-image:build`, or without Node, `docker build --file sandbox-image/Dockerfile --tag barrack-sandbox:dev .`
2. Set up a Supabase project for sign-in as in [step 1b](#1b-supabase-sign-in); this path needs no Supabase database. Development mode's single shared user is refused here, because the control plane listens on every interface of its container, where sandboxes can reach it.
3. Write a `.env` file beside `compose.yaml` (it is ignored by Git):

   ```sh
   BARRACK_DATABASE_PASSWORD=<letters and digits>
   BARRACK_SUPABASE_URL=https://<project-ref>.supabase.co
   BARRACK_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…
   BARRACK_ALLOWED_USER_EMAILS=you@example.com
   BARRACK_MODEL=anthropic/<model-id>
   ANTHROPIC_API_KEY=<your key>
   # Or, to try it without a model: BARRACK_AGENT_HARNESS=fake
   ```

   Compose refuses to start without the first four. For private repositories and pull requests, also register a GitHub App as in [step 4](#4-github-optional-private-repositories-and-pull-requests) and add its four `BARRACK_GITHUB_APP_` variables here.

   Every variable in it reaches the control plane, so the control plane's other settings ([its README](../apps/control-plane/README.md#configuration)) can go here too. With rootless Docker, also set `DOCKER_SOCKET` to its socket's path.

4. `docker compose up --build --detach`, then open <http://localhost:8787/> and sign in.

The port is published on `127.0.0.1` only. To use it from another machine, forward it over SSH (`ssh -L 8787:127.0.0.1:8787 <host>`), or put it behind a reverse proxy that serves HTTPS, since access tokens must not cross a network in the clear, and add that origin to `BARRACK_ALLOWED_CLIENT_ORIGINS`.

After upgrading Barrack, rebuild the sandbox image too (step 1): a sandbox from an image built before the upgrade may speak an older protocol version, which the control plane refuses.

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

A sandbox reaches the control plane as `ws://control-plane:8787`, and the internet. It cannot reach Postgres or the socket proxy, whose networks it never joins, and the Docker socket is not in it. Sandboxes can reach each other, as they could on Docker's default bridge, and, like any container, services on the host that listen on all interfaces, and the cloud metadata address (below).

### The cloud metadata address

> **On a cloud VM, block this before running agents.** A sandbox can reach `169.254.169.254`, where most clouds (AWS, Google Cloud, Azure, DigitalOcean, Hetzner and others) answer the machine's own metadata, and on several of them hand out credentials for the machine's cloud account. Any agent, or anything it downloads, could read them. Nothing in Compose or in Barrack stops it: Docker gives no per-network way to refuse one destination.

The Compose file names the sandboxes' bridge interface `barrack-sandbox`, so one rule on the host, in Docker's `DOCKER-USER` chain (which Docker consults for all traffic it forwards and never flushes), refuses that address to sandboxes alone:

```sh
sudo iptables -I DOCKER-USER -i barrack-sandbox -d 169.254.169.254 -j REJECT
```

It holds across `docker compose down` and `up`, since the interface keeps its name, but not across a reboot: save it with your distribution's mechanism (for example `iptables-save` with the `iptables-persistent` package on Debian and Ubuntu), or run it from a unit that starts after Docker. On AWS, also refuse `169.254.170.2` (container credentials) and, if the sandbox network ever gets IPv6, `fd00:ec2::254`. To check it, from a sandbox (`docker exec --user barrack-agent <container> node -e …` connecting to `169.254.169.254` on port 80) the connection should be refused while the internet still answers.

This rule was tested on 2026-11-24 with Docker 29.9 and its default `iptables` firewall backend, on a network declared exactly as in `compose.yaml`: before it, a container on the network got an answer from `169.254.169.254`; after it, the connection was refused, for root and for an unprivileged user alike, while `1.1.1.1:443` still connected, and it still applied after the network was removed and created again. With Docker's `nftables` backend (`docker info` shows `Firewall Backend: nftables`) there is no `DOCKER-USER` chain; an equivalent rule in a table of your own was not tested.

### The Docker socket

Whoever can create containers through Docker's API can start one that is privileged or mounts the host's files, and so controls the host as root. The control plane must create containers, so **a flaw in the control plane could become control of the machine.** Run this only on a machine you would trust it with. Two things narrow the exposure:

- The control plane never holds the socket. It reaches Docker through [wollomatic/socket-proxy](https://github.com/wollomatic/socket-proxy), which answers only the control plane and forwards only the calls the Docker provider makes: create a container; start, stop, wait for, remove and inspect a container named by its full 64-character ID; inspect a container named `barrack-thread-…`; and the version check. Listing containers, `exec`, logs, pulls, builds, volumes and networks are refused. The proxy holds no capabilities and has a read-only filesystem.
- **These calls are not limited to sandboxes.** The proxy matches only the request's path and cannot tell a sandbox from any other container by its ID, so it would let the control plane start, stop, remove or inspect any container, Postgres's included, whose full ID it had. What keeps it to its own sandboxes is that it cannot list containers: the full IDs it can know are those `docker run` gave it, and its own, which a process can read inside its container. A container ID is 256 random bits, so another container's cannot be guessed. (The proxy offers no way to filter by the target container's labels, and `docker run` itself starts and waits for the container by ID, so the rules cannot name sandboxes only.)

The proxy does not look inside a create request, so it cannot stop a privileged one; a check showed it accepting one. Filtering request bodies, or a Docker authorization plugin, would close that and is not done.

### What was verified

On 2026-11-24, on one Linux machine with Docker 29.9 and Compose 5.7, building with local base images that carry a proxy's certificate authority (the build arguments `NODE_IMAGE`, `RUNTIME_BASE_IMAGE` and `DOCKER_CLI_IMAGE` replace the base images; nothing about that is committed):

- The image alone, against a throwaway Postgres: migrations applied, `/health` answered `{"status":"ok"}`, `/` served the web client, a thread was created, the keep-alive queried every minute when set to 1, and SIGTERM ended it with `Shut down cleanly` and exit code 0 in 0.1 seconds.
- Compose: a thread created through the API got a sandbox container from `barrack-sandbox:dev` on the `barrack-sandboxes` network; a message sent through a client WebSocket was recorded and answered by the fake agent, and the run settled; after the control plane restarted, the thread's history replayed from Postgres and every supervisor reconnected. From inside a sandbox, as the agent's user: the control plane connected; `database` and `docker-api` did not resolve, their addresses timed out, the published port on the network's gateway was refused, and no Docker socket existed. Through the proxy, `docker ps` and `docker exec` were refused.

That run came before sign-in and acknowledged delivery were added. Since then Compose has been checked only to refuse to start without the sign-in settings (`docker compose config`); running it with a real Supabase project is still to do.
