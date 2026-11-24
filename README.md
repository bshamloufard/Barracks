# Barrack

Barrack is an open-source, self-hostable, always-on coding-agent platform in the spirit of Devin. You open a thread from any device and describe a task. An agent (the [Pi coding agent](https://github.com/earendil-works/pi)) works on it inside its own cloud sandbox, and you can watch it, steer it, or walk away and come back later on another device.

Barrack has four parts: clients (web first), an always-on control plane, a Postgres data store, and one sandbox per thread. Inside each sandbox, a small supervisor process connects outward to the control plane. See [docs/architecture.md](docs/architecture.md) for how they fit together.

> [!WARNING]
> **This build has no user sign-in.** Anyone who can reach the control plane can create threads, read every thread and send messages to its agent, which can run any command in its sandbox (and under `pnpm dev`, on your machine). Keep it on localhost: `pnpm dev` listens only on `127.0.0.1` and `localhost`. Do not expose it to a network.

## Status

**Milestone 1 is complete:** on one machine, a prompt typed in the web page reaches the agent through the control plane and a sandbox supervisor, and the agent's reply streams back.

**Milestone 2's parts are built and tested locally, with Docker and Postgres:** threads are created from a thread list, each with a sandbox of its own and a supervisor token minted for it alone; sandboxes come from a provider chosen by configuration (Docker, Daytona, or local processes for development); the agent runs as its own operating-system user inside the sandbox image; and thread history is stored in Postgres and replayed in pages after a restart. **Nothing is deployed**, and Daytona, Railway and Supabase have not been exercised, for lack of credentials. There is no sign-in yet, so it must stay on localhost. The loop has been run with the real Pi against a local mock model, not yet with a real model provider.

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

Open <http://localhost:5173/>, choose **New thread**, and send a message. `pnpm dev` starts the control plane and the web client. The control plane creates each thread's sandbox with the **local-process provider**: a directory under `.barrack-dev/sandboxes/` (git-ignored) and a supervisor process on your machine, with **no isolation**, run as your user. History is kept in memory and lost when it stops.

By default every supervisor runs a **fake agent** that needs no model or API key: it quotes your message back word by word, a message containing `[tool]` makes it call a tool first, and one containing `[fail]` makes it fail as if it had crashed.

Ctrl-C stops everything, supervisors included. If either service stops on its own, `pnpm dev` stops the other and exits with an error. Their logs are interleaved in the terminal, each line labelled with the service that wrote it.

### With the real Pi agent

Set `BARRACK_MODEL` to a model in Pi's `provider/model` form, along with that provider's API key:

```sh
ANTHROPIC_API_KEY=<your key> BARRACK_MODEL=anthropic/<model-id> pnpm dev
```

`pnpm --filter @barrack/sandbox-supervisor exec pi --list-models <search>` lists the model identifiers Pi knows. The control plane forwards an allowlist of model provider keys, and `PI_OFFLINE` and `PI_CACHE_RETENTION`, to each sandbox ([its README](apps/control-plane/README.md#threads-and-their-sandboxes)). Each thread's Pi works in its sandbox's `workspace/`, made a Git repository of its own, and keeps its sessions and settings in that sandbox's `state/`. A thread starts with empty Pi state, so Pi sign-ins and custom models (`models.json`) do not carry over between threads; use a provider key. Pi can run any command your user can.

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

`pnpm test` needs no network, API key or Docker. It skips the tests that need a database unless `BARRACK_TEST_DATABASE_URL` is set (`pnpm test-database:start` prints the value), those that need Docker unless `BARRACK_DOCKER_TESTS=1` (which `pnpm test:docker` sets), and the Daytona contract unless `DAYTONA_API_KEY` and `BARRACK_DAYTONA_SNAPSHOT` are set; each skipped suite says why in its name. CI runs the database tests in `pnpm check` and the Docker tests in a job of their own.

## Repository layout

```
apps/control-plane/          Creates threads and their sandboxes, relays between supervisors and clients, records history
apps/sandbox-supervisor/     Runs the agent (Pi or a fake) in a thread's sandbox and dials out to the control plane
apps/web/                    The web client: the thread list and a thread's conversation, streamed live
packages/protocol/           @barrack/protocol: the messages and HTTP API all three share, as zod schemas
packages/sandbox-providers/  The boundary to the computers threads run on: Docker, Daytona, local process, fake
sandbox-image/               The image a thread's sandbox runs: Ubuntu, Node, the supervisor and Pi, two users
tests/end-to-end/            Tests that run the real control plane and supervisors together, locally and in Docker
tests/mock-model-server/     A stand-in OpenAI-compatible model, so tests run the real Pi with no network or key
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
