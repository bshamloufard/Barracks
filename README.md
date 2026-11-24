# Barrack

Barrack is an open-source, self-hostable, always-on coding-agent platform in the spirit of Devin. You open a thread from any device and describe a task. An agent (the [Pi coding agent](https://github.com/earendil-works/pi)) works on it inside its own cloud sandbox, and you can watch it, steer it, or walk away and come back later on another device.

Barrack has four parts: clients (web first), an always-on control plane, a Postgres data store, and one sandbox per thread. Inside each sandbox, a small supervisor process connects outward to the control plane. See [docs/architecture.md](docs/architecture.md) for the intended design.

## Status

Early development. Milestone 1 (a local proof of the core loop) is in progress. Nothing here is usable yet.

## Prerequisites

- Node.js 22.19 or newer, which the Pi agent requires ([`.nvmrc`](.nvmrc) names the major version, so version managers install the latest 22.x release)
- pnpm 10 (the exact version is pinned in `package.json` under `packageManager`; running `corepack enable` installs it for you)

## Getting started

```sh
pnpm install
pnpm check
```

## Commands

Run all commands from the repository root. Each one covers every package in the workspace.

| Command          | What it does                                                        |
| ---------------- | ------------------------------------------------------------------- |
| `pnpm build`     | Compiles every package to JavaScript.                               |
| `pnpm lint`      | Checks formatting, import order and lint rules with Biome.          |
| `pnpm format`    | Rewrites files to fix formatting, import order and safe lint fixes. |
| `pnpm typecheck` | Type-checks every package with the TypeScript compiler.             |
| `pnpm test`      | Runs every package's tests with Vitest.                             |
| `pnpm check`     | Runs lint, typecheck and test. CI runs this plus `pnpm build`.      |

## Repository layout

```
.github/workflows/   CI: runs pnpm check and pnpm build on every push and pull request
docs/                Architecture overview and decision log
packages/protocol/   @barrack/protocol: messages shared by the control plane, supervisor and clients
biome.json           Formatter and linter configuration
tsconfig.base.json   Strict TypeScript settings that every package extends
vitest.config.ts     Test runner configuration covering every package
```

Applications (the web client, control plane and sandbox supervisor) will live under `apps/`, and shared libraries under `packages/`.

## Documentation

- [docs/architecture.md](docs/architecture.md): how the parts fit together.
- [docs/decisions.md](docs/decisions.md): the decision log, recording each choice and why it was made.

## Licence

[MIT](LICENSE)
