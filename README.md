# Barrack

Barrack is an open-source, self-hostable, always-on coding-agent platform in the spirit of Devin. You open a thread from any device and describe a task. An agent (the [Pi coding agent](https://github.com/earendil-works/pi)) works on it inside its own cloud sandbox, and you can watch it, steer it, or walk away and come back later on another device.

Barrack has four parts: clients (web first), an always-on **control plane** (the service users and sandboxes connect to), a Postgres data store, and one **sandbox** (an isolated Linux computer) per thread. Inside each sandbox a small **supervisor** process starts the agent and connects outward to the control plane. See [docs/architecture.md](docs/architecture.md) for how they fit together.

## Status

**Nothing has been deployed, and nothing has run against a real outside service.** Every milestone below that says "built" has been tested on one machine: with stand-ins for the outside services, in Docker containers, and against Postgres. The real Pi agent has run only against a local mock model. Railway, Supabase, Daytona, a real GitHub App and real model providers have never been used, because there were no credentials. The code for each of them is written and tested against a stand-in that answers as its documentation describes; [the first-deployment checklist](docs/deployment.md#first-deployment-checklist) lists what a first real run must confirm.

The project is built in the eight milestones of its plan:

| Milestone                                                         | Status                   | What remains                                                                                               |
| ----------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 1. Local proof: a prompt in a web page reaches the agent and back | Built and tested locally | Nothing                                                                                                    |
| 2. One thread in the cloud (Railway, Supabase, Daytona)           | Built and tested locally | A first deployment: never run on Railway, Supabase or Daytona                                              |
| 3. Many threads: sign-in, thread lifecycle, Git repositories      | Built and tested locally | Sign-in against a real Supabase project, and the GitHub flows against a real GitHub App                    |
| 4. Bring your own model access                                    | Built and tested locally | A real ChatGPT sign-in: plans were connected only against a stand-in for OpenAI's sign-in                  |
| 5. Live desktop and computer use                                  | Built and tested locally | A run on Daytona                                                                                           |
| 6. Second sandbox provider (Docker beside Daytona)                | Built and tested locally | The same thread on Daytona: only Docker has ever run                                                       |
| 7. Hardening: keys kept out of sandboxes, usage caps, recovery    | Built and tested locally | The model proxy against real providers; the gaps the [decision log](docs/decisions.md) still lists as open |
| 8. Native apps for iPhone and Mac                                 | Not built                | Everything: no Swift toolchain was available; deleting an account must be built first                      |

**What works today, on one machine:** creating threads from a thread list, each in a sandbox of its own (a Docker container, or a plain local process for development); several threads at once; stopping, resuming and deleting a thread, and idle sandboxes stopping by themselves; history kept in Postgres and replayed after a restart, with nothing lost when the control plane or a supervisor is killed mid-run; sign-in and per-user access checks (tested with a stand-in token issuer); starting a thread from a Git repository and publishing its branch (tested with a stand-in for GitHub); each user's own model keys, stored encrypted, with a model per thread; a ChatGPT plan, connected once through OpenAI's "Sign in with ChatGPT" programme and used by every thread for OpenAI models, where the operator runs the installation for themselves alone (tested with stand-ins for OpenAI's sign-in and API); the live desktop, which the user watches and can take over, and the agent's computer tool (a browser test drives it in Docker); and, for eight providers, the model proxy that keeps a user's key out of the sandbox and counts and caps usage.

> [!WARNING]
> **Admit only people you trust.** `pnpm dev` has no sign-in: every client is one fixed user, so the control plane listens only on `127.0.0.1` and `localhost`, and each agent can run any command on your machine. With Supabase sign-in each user sees and controls only their own threads, but for providers the control plane does not relay, a user's own model key is placed in their threads' sandboxes, where the agent (and any code a repository makes it run) can read it; Settings says, per provider, where the key lives. Use keys with a spending limit.

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

Then add your model provider's key in **Settings** (under Model access), and choose a model for each new thread from the providers and models the pinned Pi supports, or type any other `provider/model`. A provider key in your shell, such as `ANTHROPIC_API_KEY`, is not used: each thread runs on the key its user added, as in a deployment. Keys added during a `pnpm dev` run are sealed under a key made up for that run and kept in memory, so they are gone when it stops; with `BARRACK_DATABASE_URL`, also set `BARRACK_MODEL_CREDENTIAL_KEY` (`openssl rand -base64 32`) and keep it. The control plane forwards `PI_CACHE_RETENTION` to each sandbox, whose Pi always runs offline ([its README](apps/control-plane/README.md#pis-settings)). Each thread's Pi works in its sandbox's `workspace/`, made a Git repository of its own, and keeps its sessions and settings in that sandbox's `state/`. Pi can run any command your user can, and read the key it is given.

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

`pnpm test` needs no network, API key or Docker. It skips the tests that need a database unless `BARRACK_TEST_DATABASE_URL` is set (`pnpm test-database:start` prints the value), those that need Docker unless `BARRACK_DOCKER_TESTS=1` (which `pnpm test:docker` sets), and the Daytona contract unless `DAYTONA_API_KEY` and `BARRACK_DAYTONA_SNAPSHOT` are set; each skipped suite says why in its name. The desktop's Docker test, and the test that runs the built web client under its Content-Security-Policy (which needs no Docker), drive the web client in Chromium through Playwright, which is not a dependency: they use one installed where Node finds it (`NODE_PATH`), with its browser, and are skipped, saying so, without one. `BARRACK_DESKTOP_SCREENSHOTS` names a directory for its screenshots of the viewer. The Docker tests use the image `barrack-sandbox:dev` unless `BARRACK_DOCKER_TEST_IMAGE` names another; give each checkout or parallel run an image tag of its own (built with `docker build --file sandbox-image/Dockerfile --tag <tag> .`), since several sharing one Docker daemon would otherwise rebuild `barrack-sandbox:dev` under each other's tests. CI runs the database tests in `pnpm check` and the Docker tests in a job of their own.

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
tests/fake-chatgpt-sign-in/  A stand-in for OpenAI's "Sign in with ChatGPT" server, so tests connect a plan with no account
scripts/dev/                 The pnpm dev command
Dockerfile                   The control plane's image, which also serves the built web client
compose.yaml                 Everything on one machine with Docker Compose (docs/deployment.md)
.railway/railway.ts          The control plane's Railway service, as Railway Infrastructure as Code
docs/                        Architecture overview, decision log and deployment guide
.github/workflows/           CI: pnpm check and pnpm build with Postgres, and the Docker tests
```

Each folder under `apps/`, `packages/` and `tests/`, and `sandbox-image/`, has a README saying what it is for, how to run and test it, and where its main files are.

## Documentation

- [docs/architecture.md](docs/architecture.md): how the parts fit together, and the path of one prompt through them.
- [docs/decisions.md](docs/decisions.md): the decision log, recording each choice, where it departs from the project plan, and why.
- [docs/deployment.md](docs/deployment.md): deploying, hosted on Railway, Supabase and Daytona, or on one machine with Docker Compose, with the [first-deployment checklist](docs/deployment.md#first-deployment-checklist): what the owner must supply, in what order, and what a first real run must check.

## Licence

[MIT](LICENSE)
