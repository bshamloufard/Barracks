# Barrack

Barrack is an open-source, self-hostable, always-on coding-agent platform in the spirit of Devin. You open a thread from any device and describe a task. An agent (the [Pi coding agent](https://github.com/earendil-works/pi)) works on it inside its own cloud sandbox, and you can watch it, steer it, or walk away and come back later on another device.

Barrack has four parts: clients (web first), an always-on control plane, a Postgres data store, and one sandbox per thread. Inside each sandbox, a small supervisor process connects outward to the control plane. See [docs/architecture.md](docs/architecture.md) for how they fit together.

> [!WARNING]
> **This build has no user authentication.** Anyone who can reach the control plane can read every thread and send messages to its agent, which can run any command on the machine it runs on. Keep it on localhost: `pnpm dev` only listens on `127.0.0.1` and `localhost`. Do not expose it to a network.

## Status

**Milestone 1 complete: the local loop.** On one machine, a prompt typed in the web page reaches the agent through the control plane and a sandbox supervisor, and the agent's reply streams back. History is kept in memory, so it is lost when the control plane stops. The loop has been exercised with the real Pi binary against a local mock model; a run with a real model provider key is still to come. There is no cloud deployment, persistence, sign-in or thread list yet.

## Prerequisites

- Node.js 22.19 or newer, which the Pi agent requires ([`.nvmrc`](.nvmrc) names the major version, so version managers install the latest 22.x release)
- pnpm 10 (the exact version is pinned in `package.json` under `packageManager`; running `corepack enable` installs it for you)
- macOS or Linux (on Windows, use WSL), and Git

## Run it locally

```sh
pnpm install
pnpm dev
```

Open <http://localhost:5173/?thread=local> and send a message. `pnpm dev` starts the control plane, a sandbox supervisor and the web client together for one thread, with a fresh secret shared by the control plane and the supervisor. By default the supervisor runs a **fake agent** that needs no model or API key: it quotes your message back word by word, a message containing `[tool]` makes it call a tool first, and one containing `[fail]` makes it fail as if it had crashed.

Ctrl-C stops everything. If any of the three stops on its own, `pnpm dev` stops the others and exits with an error. Their logs are interleaved in the terminal, each line labelled with the service that wrote it.

### With the real Pi agent

Set `BARRACK_MODEL` to a model in Pi's `provider/model` form, along with that provider's API key:

```sh
ANTHROPIC_API_KEY=<your key> BARRACK_MODEL=anthropic/<model-id> pnpm dev
```

`pnpm --filter @barrack/sandbox-supervisor exec pi --list-models <search>` lists the model identifiers Pi knows. Pi works in `.barrack-dev/workspace` and keeps its sessions and settings in `.barrack-dev/state`, both git-ignored; the workspace is made a Git repository of its own so the agent's Git commands never touch Barrack's. Set `BARRACK_WORKSPACE_DIRECTORY` or `BARRACK_STATE_DIRECTORY` to use other directories. Pi can run any command your user can, so only point it at a workspace you are happy for it to change.

Pi gets only an allowlist of your environment: basics such as `PATH`, every `PI_*` variable, and model provider keys such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (see the [supervisor's README](apps/sandbox-supervisor/README.md)).

## Commands

Run all commands from the repository root. Each one covers every package in the workspace.

| Command          | What it does                                                                  |
| ---------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`       | Runs the control plane, a supervisor and the web client for one local thread. |
| `pnpm build`     | Compiles every package to JavaScript.                                         |
| `pnpm lint`      | Checks formatting, import order and lint rules with Biome.                    |
| `pnpm format`    | Rewrites files to fix formatting, import order and safe lint fixes.           |
| `pnpm typecheck` | Builds the shared packages, then type-checks every package.                   |
| `pnpm test`      | Builds the shared packages, then runs every test with Vitest.                 |
| `pnpm check`     | Runs lint, typecheck and test. CI runs this plus `pnpm build`.                |

`pnpm test` includes end-to-end tests that start the real control plane and supervisor and drive them over WebSockets; they need no network or API key.

## Repository layout

```
apps/control-plane/       Relays between supervisors and clients, recording every thread event first
apps/sandbox-supervisor/  Runs the agent (Pi or a fake) in a thread's sandbox and dials out to the control plane
apps/web/                 The web client: one thread's conversation, streamed live
packages/protocol/        @barrack/protocol: the messages all three share, as zod schemas
tests/end-to-end/         Tests that run the control plane and supervisor together as real processes
scripts/dev/              The pnpm dev command
docs/                     Architecture overview and decision log
.github/workflows/        CI: runs pnpm check and pnpm build on every push and pull request
```

Each application has a README describing its configuration and how it is organised.

## Documentation

- [docs/architecture.md](docs/architecture.md): how the parts fit together, and the path of one prompt through them.
- [docs/decisions.md](docs/decisions.md): the decision log, recording each choice and why it was made.

## Licence

[MIT](LICENSE)
