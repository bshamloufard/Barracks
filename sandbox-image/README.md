# Sandbox image

The computer a thread runs on. It holds Node (the exact version the repository requires, taken from the official Node image), Git, the built sandbox supervisor with its production dependencies (including the pinned Pi agent), a workspace at `/workspace` and the agent's persistent state at `/var/lib/barrack/state`. Its default command runs the supervisor, configured entirely from the environment (see [the supervisor's README](../apps/sandbox-supervisor/README.md)); the image already sets `BARRACK_WORKSPACE_DIRECTORY` and `BARRACK_STATE_DIRECTORY`, so a provider only adds the control plane URL, the thread, the supervisor's token and the agent's settings.

## Building it

From the repository root, with Docker running:

```sh
pnpm sandbox-image:build
```

This builds `barrack-sandbox:dev` from [`Dockerfile`](Dockerfile), with the repository root as the context; [`.dockerignore`](../.dockerignore) sends only what the image needs. Extra arguments go to `docker build`, for example `pnpm sandbox-image:build --build-arg HTTPS_PROXY=http://proxy.example:3128`.

- Both base images are pinned by digest, and dependencies come from `pnpm-lock.yaml`, so a rebuild produces the same software. Update the digests deliberately.
- The lockfile is fetched in a layer of its own, so editing the supervisor rebuilds in seconds; only a lockfile change fetches packages again.
- The sandbox itself is Ubuntu 24.04, the distribution coding tools and agents most often expect. The build stage runs on the official Node image.
- `NODE_IMAGE` and `BASE_IMAGE` build arguments replace the two base images, for example with a mirror.

## What runs, and as whom

`tini` is the first process. It starts the supervisor (`barrack-run-supervisor`), forwards stop signals to it, and reaps orphaned processes that the agent's commands leave behind. When the supervisor exits, the container stops, and its exit code tells a requested stop (0) from a failure.

`barrack-ensure-supervisor` starts the supervisor in the background unless one is already running. Providers that do not use the image's default command (Daytona decides a sandbox's first process itself) run it after every create and start. `barrack-ensure-supervisor --check` only reports, by its exit status, whether one is running.

### Keeping the supervisor's secrets from the agent

The image has two users:

| User                 | UID   | Owns                                                       |
| -------------------- | ----- | ---------------------------------------------------------- |
| `barrack-supervisor` | 10001 | nothing the agent can reach; it is in `barrack-agent`'s group, so it can read the workspace and the agent's state |
| `barrack-agent`      | 10002 | `/workspace`, `/var/lib/barrack/state` (including `pi/agent` and `pi/sessions`), `/home/barrack-agent` |

The supervisor's token is only in its environment, and Linux shows a process's environment (`/proc/<pid>/environ`) only to the same user. So once the supervisor runs as `barrack-supervisor` and the agent as `barrack-agent`, the agent cannot read the token.

The supervisor changes user through `/opt/barrack/bin/run-as-agent`, a copy of `setpriv` that carries the `setuid` and `setgid` file capabilities and that only the `barrack-supervisor` group may run. The supervisor's own process has no capabilities; the agent ends up with none either, and cannot run `run-as-agent`. A container must keep `SETUID` and `SETGID` in its capability bounding set for this to work (Docker's default does, and the Docker provider drops every other capability), and must not set `no-new-privileges`, which would stop `run-as-agent` from receiving them. This was checked in a container started as the Docker provider starts one: the agent's process had no capabilities, could not read the supervisor's environment (`EACCES`), could not `setuid(0)` (`EPERM`) and could not run `run-as-agent` (`EACCES`).

**Until the supervisor launches the agent this way, both run as `barrack-agent`**, because the `SUPERVISOR_USER` build argument defaults to it. To separate them, the supervisor must:

1. When `BARRACK_AGENT_USER` is set and differs from the user the supervisor runs as, start Pi as
   `/opt/barrack/bin/run-as-agent --reuid=<user> --regid=<user> --init-groups -- /usr/local/bin/node <pi entry point> <arguments>`
   instead of spawning `process.execPath` directly.
2. Give Pi `HOME=/home/<user>`, `USER=<user>` and `LOGNAME=<user>` (the agent user's, not its own), since `setpriv` leaves the environment as it is.
3. Rely on `pi/agent` and `pi/sessions` already existing under the state directory (the image creates them, owned by the agent), since the supervisor cannot create directories there itself.

Then change the default of `SUPERVISOR_USER` in the Dockerfile to `barrack-supervisor`, in the same change.
