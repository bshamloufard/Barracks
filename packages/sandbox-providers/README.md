# Sandbox providers

`@barrack/sandbox-providers` is the boundary between the control plane and the computers threads run on. The control plane depends only on the `SandboxProvider` interface in [`src/sandbox-provider.ts`](src/sandbox-provider.ts): create a thread's sandbox, start it, stop it, destroy it, read its state, and get an address for a service inside it. Everything else happens through the supervisor inside the sandbox, which connects out to the control plane.

- **Providers hold no lifecycle policy.** The control plane decides when a sandbox runs. A provider guarantees that whenever a sandbox is running, its supervisor is running with the environment it was created with and the sandbox's files intact.
- **An identifier always means the same computer.** No operation creates or substitutes a sandbox other than the one named; a thread has at most one sandbox (`SandboxAlreadyExistsError` names it).
- **Idempotent where it means something.** Starting a running sandbox, stopping a stopped one and destroying a missing one do nothing.
- **Typed failures.** `SandboxNotFoundError`, `SandboxProviderUnavailableError` (may pass; retry later), `SandboxRefusedError` (will not pass until something changes) and `SandboxAlreadyExistsError`. Messages never contain the supervisor's environment, and errors never carry a provider's own error object, which can hold credentials.

## Providers

| Provider      | Folder                                   | What a sandbox is                                                                     |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| fake          | [`src/fake`](src/fake)                   | An in-memory record, for tests of the control plane                                   |
| docker        | [`src/docker`](src/docker)               | A container from the [sandbox image](../../sandbox-image), via the docker CLI         |
| daytona       | [`src/daytona`](src/daytona)             | A Daytona sandbox from a snapshot of the sandbox image                                |
| local-process | [`src/local-process`](src/local-process) | **Not a sandbox.** A directory and a child process on the control plane's own machine |

`readSandboxProviderConfiguration(process.env)` reads the choice and `createSandboxProvider(configuration)` builds it.

| Variable                               | For           | Meaning                                                                                                        |
| -------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `BARRACK_SANDBOX_PROVIDER`             | all           | `docker`, `daytona`, `local-process` or `fake`                                                                 |
| `BARRACK_ALLOW_UNISOLATED_SANDBOXES`   | local-process | Must be exactly `development-only`, or the provider is refused                                                 |
| `BARRACK_LOCAL_SANDBOX_DIRECTORY`      | local-process | Absolute path; each sandbox gets a directory in it                                                             |
| `BARRACK_LOCAL_SUPERVISOR_COMMAND`     | local-process | JSON array: the supervisor's executable and arguments, e.g. `["node", "apps/sandbox-supervisor/dist/main.js"]` |
| `BARRACK_LOCAL_STOP_TIMEOUT_SECONDS`   | local-process | Grace period before a stopping supervisor is killed (default 15)                                               |
| `BARRACK_DOCKER_IMAGE`                 | docker        | The sandbox image, e.g. `barrack-sandbox:dev`                                                                  |
| `BARRACK_DOCKER_CPUS`                  | docker        | CPUs per sandbox (default 2)                                                                                   |
| `BARRACK_DOCKER_MEMORY_MEBIBYTES`      | docker        | Memory per sandbox, without swap (default 4096)                                                                |
| `BARRACK_DOCKER_PROCESS_LIMIT`         | docker        | Processes per sandbox (default 1024)                                                                           |
| `BARRACK_DOCKER_STOP_TIMEOUT_SECONDS`  | docker        | Grace period before a stopping supervisor is killed (default 15)                                               |
| `BARRACK_DOCKER_SERVICE_PORTS`         | docker        | Comma-separated ports `getServiceAddress` may hand out (default none)                                          |
| `BARRACK_DOCKER_EXECUTABLE`            | docker        | The docker command (default `docker`)                                                                          |
| `DAYTONA_API_KEY`                      | daytona       | Daytona API key; never logged                                                                                  |
| `BARRACK_DAYTONA_SNAPSHOT`             | daytona       | The snapshot registered from the sandbox image                                                                 |
| `DAYTONA_TARGET`                       | daytona       | Region; the organisation's default when unset                                                                  |
| `BARRACK_DAYTONA_AUTO_ARCHIVE_MINUTES` | daytona       | Minutes after a stop before Daytona archives the sandbox (default 60)                                          |

**Docker.** One container per thread, named `barrack-thread-<thread>` and labelled `barrack.sandbox=true` and `barrack.thread-id=<thread>`; its identifier is the full container ID. The supervisor is the container's main process, and reaches a control plane on the host as `host.docker.internal`. Containers drop every capability except the two the supervisor needs to start the agent as another user, are never privileged, and publish only the configured service ports, on `127.0.0.1`. The supervisor's environment is passed through the docker CLI's own environment, never its arguments. `docker exec` runs as the supervisor's user unless given `--user barrack-agent`, which the agent's files need; either way the process sees the container's environment, token included (see the [sandbox image's README](../../sandbox-image/README.md#what-the-agent-can-still-reach)).

**Daytona.** Built on Daytona's generally available platform through the SDK's `v0` namespace. Auto-stop is off (it ignores an agent working inside the sandbox) and auto-delete is off; stopped sandboxes are archived after `BARRACK_DAYTONA_AUTO_ARCHIVE_MINUTES`, which stops disk billing and frees storage quota at the cost of a slower start. The provider runs the image's `barrack-ensure-supervisor` after every create and start. Service addresses are signed preview URLs bound to one port with an expiry of at most a day, never the standard preview token, which opens every port.

**Local process: not a sandbox.** For `pnpm dev` and the fast cross-application tests only. Each thread's supervisor runs as an ordinary child of the control plane, as the same user, on the same machine, with **no isolation at all**: the agent can read and change everything that user can, including other threads' files and the control plane's environment. It is refused unless `BARRACK_ALLOW_UNISOLATED_SANDBOXES=development-only` is set, and the control plane also refuses it unless it listens on the loopback interface. Each sandbox is a directory `<BARRACK_LOCAL_SANDBOX_DIRECTORY>/local-<uuid>/` holding `workspace/` (made a Git repository of its own, so the agent's Git commands never reach a checkout it happens to sit in), `state/` and `supervisor/`; the supervisor runs in `workspace/` with `BARRACK_WORKSPACE_DIRECTORY`, `BARRACK_STATE_DIRECTORY` and `BARRACK_SUPERVISOR_STATE_DIRECTORY` pointing at them, plus a few basics from the host (`PATH`, `HOME`, locale, proxy settings) and the requested environment, which overrides them. **Stop keeps the files** in the sense that stopping ends the supervisor and leaves the directory on disk, and starting launches the supervisor again in it. But the provider's records live in the control plane's memory: when the control plane exits it asks every supervisor it started to stop, and after a restart every earlier sandbox is reported `missing` while its directory stays on disk until deleted. A supervisor that exits by itself leaves its sandbox `failed`. Service addresses are plain `http://127.0.0.1:<port>/` on the host. Supervisor output goes to the control plane's own standard output.

## Tests

`pnpm test` runs the unit tests and the contract suite ([`src/test-support/sandbox-provider-contract.ts`](src/test-support/sandbox-provider-contract.ts)) against the fake and the local-process provider (with a small stand-in supervisor, [`src/test-support/stand-in-supervisor.ts`](src/test-support/stand-in-supervisor.ts)). The contract runs against real containers with `pnpm test:docker`, and against Daytona only when `DAYTONA_API_KEY` and `BARRACK_DAYTONA_SNAPSHOT` are set; otherwise those suites are skipped with the reason in their name.
