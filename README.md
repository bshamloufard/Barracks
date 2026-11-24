# Barrack

Barrack is an open-source, self-hostable, always-on coding-agent platform in the spirit of Devin. You open a thread from any device and describe a task. An agent (the [Pi coding agent](https://github.com/earendil-works/pi)) works on it inside its own cloud sandbox, and you can watch it, steer it, or walk away and come back later on another device.

Barrack has four parts: clients (web first), an always-on control plane, a Postgres data store, and one sandbox per thread. Inside each sandbox, a small supervisor process connects outward to the control plane. See [docs/architecture.md](docs/architecture.md) for how they fit together.

> [!WARNING]
> **`pnpm dev` has no sign-in.** It runs the control plane in development mode, where every client is one fixed user, so the control plane refuses to listen anywhere but `127.0.0.1` and `localhost`; each agent can run any command on your machine. With Supabase sign-in the control plane may listen anywhere, and each user sees and controls only their own threads, but nothing has been deployed yet, and for providers the control plane does not relay, each user's own model key reaches their threads' sandboxes, where the agent (and any code a repository makes it run) can read it (Settings says, per provider, where the key lives): admit only people you trust, and use keys with a spending limit.

## Status

**Milestone 1 is complete:** on one machine, a prompt typed in the web page reaches the agent through the control plane and a sandbox supervisor, and the agent's reply streams back.

**Milestone 2's parts are built and tested locally, with Docker and Postgres:** threads are created from a thread list, each with a sandbox of its own and a supervisor token minted for it alone; sandboxes come from a provider chosen by configuration (Docker, Daytona, or local processes for development); the agent runs as its own operating-system user inside the sandbox image; thread history is stored in Postgres and replayed in pages after a restart; and delivery between a sandbox's supervisor and the control plane is acknowledged both ways, so killing either mid-run loses no recorded event and hands no message to the agent twice, and a message sent while the agent is away waits for it. **Nothing is deployed**, and Daytona, Railway and Supabase have not been exercised, for lack of credentials. **Milestone 3 has begun:** users sign in with Supabase Auth by an emailed code, the control plane verifies every token itself and admits only listed addresses, and each thread belongs to one user, over HTTP and WebSocket alike; and the thread lifecycle is built: several threads run at once (three, each in its own container with the real Pi, tested together), a thread can be stopped, resumed and deleted, a message wakes a stopped one with its conversation intact, idle sandboxes stop after ten minutes, a limit caps how many run per user, and the control plane reconciles its records with the provider and finishes operations a killed instance left. Threads can also start from a Git repository: a public one, or one of the user's own through the installation's GitHub App, which they link in Settings; the sandbox clones it before the agent starts and holds only a read-only token for it, and the control plane pushes the thread's branch and opens a pull request when the user asks. That has run against a stand-in for GitHub only, never a real GitHub App. **Milestone 4's API-key half is built:** each user adds their own model keys in Settings, stored encrypted, chooses a model for each thread and can switch it, and each thread runs on its owner's key alone, handed to the agent outside any environment; a rejected key, an exhausted quota and a rate limit each end the run with a plain message and the next step. Connecting a ChatGPT subscription is not built yet. **Milestone 5 is built and accepted in Docker:** each sandbox has a graphical desktop with Firefox, embedded live in the thread page and reachable only by the thread's owner, which the user watches and can take control of, and the agent has a computer tool to see and drive it; a browser test watches the real Pi open Firefox in its sandbox and click through a page, then takes the mouse and keyboard itself. The loop has been run with the real Pi against a local mock model, not yet with a real model provider.

## Prerequisites

- Node.js 22.19 or newer, which the Pi agent requires ([`.nvmrc`](.nvmrc) names the major version, so version managers install the latest 22.x release)
- pnpm 10 (the exact version is pinned in `package.json` under `packageManager`; running `corepack enable` installs it for you)
- macOS or Linux (on Windows, use WSL), and Git
- Docker, only for the sandbox image, its tests and the throwaway test database

## Run it locally

```sh
pnpm install
pnpm dev
```

Open <http://localhost:5173/>, choose **New thread** (optionally with a public repository's URL to clone), and send a message. `pnpm dev` starts the control plane and the web client. The control plane creates each thread's sandbox with the **local-process provider**: a directory under `.barrack-dev/sandboxes/` (git-ignored) and a supervisor process on your machine, with **no isolation**, run as your user. History is kept in memory and lost when it stops.

By default every supervisor runs a **fake agent** that needs no model or API key: it quotes your message back word by word, a message containing `[tool]` makes it call a tool first, one containing `[fail]` makes it fail as if it had crashed, `[model]` makes it say which model the thread is on, and `[quota]` makes it fail as a provider out of quota would. A thread may be given a model or not; one given a model is answered only while you have a key for its provider, as with the real agent.

Ctrl-C stops everything, supervisors included. If either service stops on its own, `pnpm dev` stops the other and exits with an error. Their logs are interleaved in the terminal, each line labelled with the service that wrote it.

### With the real Pi agent

```sh
BARRACK_AGENT_HARNESS=pi pnpm dev
```

Then add your model provider's key in **Settings** (under Model access), and choose a model for each new thread from the providers and models the pinned Pi supports, or type any other `provider/model`. A provider key in your shell, such as `ANTHROPIC_API_KEY`, is not used: each thread runs on the key its user added, as in a deployment. Keys added during a `pnpm dev` run are sealed under a key made up for that run and kept in memory, so they are gone when it stops; with `BARRACK_DATABASE_URL`, also set `BARRACK_MODEL_CREDENTIAL_KEY` (`openssl rand -base64 32`) and keep it. The control plane forwards `PI_OFFLINE` and `PI_CACHE_RETENTION` to each sandbox ([its README](apps/control-plane/README.md#pis-settings)). Each thread's Pi works in its sandbox's `workspace/`, made a Git repository of its own, and keeps its sessions and settings in that sandbox's `state/`. Pi can run any command your user can, and read the key it is given.

### With Docker sandboxes and Postgres

`pnpm sandbox-image:build` builds the sandbox image; the [control plane's README](apps/control-plane/README.md#running-it) shows how to run it with Docker sandboxes, and with the throwaway database so history survives a restart.

## Commands

Run all commands from the repository root. Each one covers every package in the workspace.

| Command                                          | What it does                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `pnpm dev`                                       | Runs the control plane (with local-process sandboxes) and the web client.                       |
| `pnpm build`                                     | Compiles every package to JavaScript.                                                           |
| `pnpm lint`                                      | Checks formatting, import order and lint rules with Biome.                                      |
| `pnpm format`                                    | Rewrites files to fix formatting, import order and safe lint fixes.                             |
| `pnpm typecheck`                                 | Builds the shared packages, then type-checks every package.                                     |
| `pnpm test`                                      | Builds the shared packages, then runs every test with Vitest.                                   |
| `pnpm check`                                     | Runs lint, typecheck and test. CI runs this plus `pnpm build`.                                  |
| `pnpm sandbox-image:build`                       | Builds the sandbox image `barrack-sandbox:dev` ([sandbox-image/](sandbox-image/README.md)).     |
| `pnpm test:docker`                               | Builds the sandbox image, then runs every test including those that run real containers.        |
| `pnpm test-database:start`, `test-database:stop` | Starts or removes a throwaway Postgres in Docker on `127.0.0.1:54329`, with its data in memory. |

`pnpm test` needs no network, API key or Docker. It skips the tests that need a database unless `BARRACK_TEST_DATABASE_URL` is set (`pnpm test-database:start` prints the value), those that need Docker unless `BARRACK_DOCKER_TESTS=1` (which `pnpm test:docker` sets), and the Daytona contract unless `DAYTONA_API_KEY` and `BARRACK_DAYTONA_SNAPSHOT` are set; each skipped suite says why in its name. The desktop's Docker test also drives the web client in Chromium through Playwright, which is not a dependency: it uses one installed where Node finds it (`NODE_PATH`), with its browser, and is skipped, saying so, without one. `BARRACK_DESKTOP_SCREENSHOTS` names a directory for its screenshots of the viewer. The Docker tests use the image `barrack-sandbox:dev` unless `BARRACK_DOCKER_TEST_IMAGE` names another; give each checkout or parallel run an image tag of its own (built with `docker build --file sandbox-image/Dockerfile --tag <tag> .`), since several sharing one Docker daemon would otherwise rebuild `barrack-sandbox:dev` under each other's tests. CI runs the database tests in `pnpm check` and the Docker tests in a job of their own.

## Repository layout

```
apps/control-plane/          Creates threads and their sandboxes, relays between supervisors and clients, records history
apps/sandbox-supervisor/     Runs the agent (Pi or a fake) in a thread's sandbox and dials out to the control plane
apps/web/                    The web client: the thread list and a thread's conversation, streamed live
packages/protocol/           @barrack/protocol: the messages and HTTP API all three share, as zod schemas
packages/model-catalogue/    The providers and models the pinned Pi supports, generated from it for the control plane
packages/sandbox-providers/  The boundary to the computers threads run on: Docker, Daytona, local process, fake
sandbox-image/               The image a thread's sandbox runs: Ubuntu, Node, the supervisor and Pi, two users
tests/end-to-end/            Tests that run the real control plane and supervisors together, locally and in Docker
tests/fake-github/           A stand-in for GitHub: its API, its sign-in and Git over HTTP, so no test reaches GitHub
tests/mock-model-server/     A stand-in OpenAI-compatible model, so tests run the real Pi with no network or key
tests/test-identity-issuer/  A stand-in for Supabase Auth's token issuer, so tests verify real tokens with no project
scripts/dev/                 The pnpm dev command
docs/                        Architecture overview and decision log
.github/workflows/           CI: pnpm check and pnpm build with Postgres, and the Docker tests
```

The applications, the sandbox providers and the sandbox image each have a README describing their configuration and how they are organised.

## Documentation

- [docs/architecture.md](docs/architecture.md): how the parts fit together, and the path of one prompt through them.
- [docs/decisions.md](docs/decisions.md): the decision log, recording each choice and why it was made.
- [docs/deployment.md](docs/deployment.md): deploying, hosted on Railway, Supabase and Daytona, or on one machine with Docker Compose.

## Licence

[MIT](LICENSE)
