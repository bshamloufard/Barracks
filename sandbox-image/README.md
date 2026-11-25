# Sandbox image

The computer a thread runs on. It holds Node (the exact version the repository requires, taken from the official Node image), Git, the built sandbox supervisor with its production dependencies (including the pinned Pi agent), a workspace at `/workspace` and the agent's persistent state at `/var/lib/barrack/state`. Its default command runs the supervisor, configured entirely from the environment (see [the supervisor's README](../apps/sandbox-supervisor/README.md)); the image already sets `BARRACK_WORKSPACE_DIRECTORY`, `BARRACK_STATE_DIRECTORY`, `BARRACK_SUPERVISOR_SECRETS_DIRECTORY` and `BARRACK_AGENT_USER`, so a provider only adds the control plane URL, the thread and the agent's settings, and puts the supervisor's token in `/var/lib/barrack/secrets` (see below).

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
- Firefox comes from Mozilla's APT repository (`packages.mozilla.org`), checked against Mozilla's signing key kept here in [`packages.mozilla.org.asc`](packages.mozilla.org.asc) (fingerprint `35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3`, as [Mozilla's installation page](https://support.mozilla.org/kb/install-firefox-linux) gives it), and only Firefox is taken from there. That repository keeps current versions only, so each build gets the Firefox of its day. **This route has been built only by Daytona's builder**, for the first deployment's snapshot on 2026-11-25, and that Firefox has not been run: the network where Barrack was developed blocks `packages.mozilla.org`, so every image tested took the next route; the [first-deployment checklist](../docs/deployment.md#first-deployment-checklist) says how to check it. Where the build cannot reach it, hand it an unpacked official Firefox for Linux (the `firefox` directory of Mozilla's tarball for the image's architecture) instead:

  ```sh
  pnpm sandbox-image:build --build-arg FIREFOX_SOURCE=build-context --build-context firefox=/path/to/firefox
  ```

The image has been built and tested only on amd64; Daytona needs amd64, while an arm64 machine running Compose would build it for arm64, untried. `pnpm test:docker` builds it and runs the tests that use it: the providers' Docker contract, the isolation tests below, and threads end to end with the real Pi.

The image is large: about 1.8 GB unpacked, most of it the desktop (Mesa and LLVM, which Ubuntu's X servers depend on) and Firefox. See the [decision log](../docs/decisions.md) for why the desktop is always part of it.

## The desktop

`barrack-desktop` runs the sandbox's graphical desktop in the foreground, as whoever runs it, until its standard input closes: TigerVNC's `Xvnc` (X server and VNC server in one process) on display `:1` at 1280×800, serving VNC on `127.0.0.1:5900` only and without a password, every viewer shared, viewers unable to resize it, at most 15 updates a second; and the Openbox window manager. It clears the X server's lock and socket a stopped sandbox left in `/tmp`, whose process number may now belong to a living process. The supervisor runs it as the agent (`BARRACK_DESKTOP_COMMAND`, which the image sets with `DISPLAY=:1`) whenever the sandbox runs, and starts it again whenever it ends. Nothing outside the sandbox reaches the VNC server: the supervisor opens a stream to it only when the control plane asks (see the [architecture](../docs/architecture.md#the-live-desktop)).

The agent may start Firefox (`firefox URL &`) and use its computer tool. Firefox's enterprise policy, [`firefox-policies.json`](firefox-policies.json) in `/etc/firefox/policies`, turns off updates, telemetry, studies and first-run pages, and accepts Mozilla's terms of use on the users' behalf (`SkipTermsOfUse`; remove it to have each sandbox's first Firefox window ask instead). Its content processes keep Firefox's own seccomp sandbox in a container without user namespaces.

The supervisor writes who holds the desktop's input, `agent` or `user`, to `/run/barrack-desktop/control` (`BARRACK_DESKTOP_CONTROL_FILE`), a directory the agent may read and not write. **Anything typed into the desktop, passwords included, is readable by the agent**, which shares the X server's user and the browser profile.

### For Daytona

The Daytona provider creates sandboxes from a Daytona snapshot of this image, named by `BARRACK_DAYTONA_SNAPSHOT`. `pnpm sandbox-image:daytona-snapshot <name>` has Daytona's own builder build it from the current commit, with no Docker here: it exports the commit, puts this Dockerfile at the export's root (Daytona resolves `COPY` sources against the Dockerfile's directory, and these are written from the repository root) and uploads only what the `COPY` lines name. It needs a Daytona key with `write:snapshots`, which the control plane's key does not have. The first deployment's snapshot was built through the same SDK calls, made by hand: active, 1.15 GB, entrypoint `tini --`; the command itself has not been run against Daytona. Daytona's CLI can instead push a locally built image, for example `daytona snapshot push barrack-sandbox:dev --name barrack-sandbox-<version>` (untried; Daytona rejects tags such as `latest`). Use a new name for each build. The [deployment guide](../docs/deployment.md#2-daytona-the-sandbox-image) has the steps, and its checklist what to confirm.

## What runs, and as whom

`tini` is the first process. It starts the supervisor (`barrack-run-supervisor`), forwards stop signals to it, and reaps orphaned processes that the agent's commands leave behind. When the supervisor exits, the container stops, and its exit code tells a requested stop (0) from a failure.

`barrack-ensure-supervisor` starts the supervisor in the background unless one is already running. Providers that do not use the image's default command (Daytona decides a sandbox's first process itself) run it after every create and start. `barrack-ensure-supervisor --check` only reports, by its exit status, whether one is running. Run either as root (the supervisor is then started as `barrack-supervisor`) or as `barrack-supervisor`; no other user may open its lock.

### Keeping the supervisor's secrets from the agent

The supervisor runs as `barrack-supervisor` and starts the agent as `barrack-agent` (see [the supervisor's README](../apps/sandbox-supervisor/README.md#which-user-the-agent-runs-as)). Linux shows a process's environment, memory and file descriptors, and lets it be signalled or traced, only by processes of its own user, so the agent cannot reach the supervisor's token through its process. If `BARRACK_AGENT_USER` is missing (a platform that does not pass the image's environment on) or the supervisor was started as `barrack-agent` (a user override), the supervisor refuses to start the agent and says why, rather than share its user; the Daytona provider sets `BARRACK_AGENT_USER` itself for that reason.

| User                 | UID   | Groups                         | Owns                                                                                                           |
| -------------------- | ----- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `barrack-supervisor` | 10001 | its own, and `barrack-agent`'s | `/run/barrack`, `/var/log/barrack`, `/var/lib/barrack/supervisor` (0750) and `/var/lib/barrack/secrets` (0700) |
| `barrack-agent`      | 10002 | its own only                   | `/workspace` and `/var/lib/barrack/state` (0710), `/home/barrack-agent` (0700)                                 |

**What each side may touch.** The agent owns everything it works on: its workspace, Pi's state under `/var/lib/barrack/state` (in `pi/agent/auth.json`, which the supervisor writes as the agent, 0600, the thread's token for the control plane's model proxy, or for a provider it does not relay the thread owner's model key; settings, models and session files) and its home. The supervisor needs only to pass through two of those: Node changes into the workspace as the supervisor before `run-as-agent` changes user, and the supervisor checks that the session file it is about to resume still exists. So the supervisor is in the agent's group, and the agent's directories give that group search access (0710) but not listing; the agent's home is closed to it. No other user can enter any of them, whatever modes the agent gives the files inside. The supervisor's own directories hold its process ID file, the lock that serialises starting it, its log, the record of how far the agent has been handed user messages, which the agent must not be able to rewrite, and its token; the agent cannot enter them.

**How the supervisor gets its token.** Not from the environment, which every process started in the sandbox gets, `docker exec --user barrack-agent` included. The provider puts it in `/var/lib/barrack/secrets/BARRACK_SUPERVISOR_TOKEN`, owned by `barrack-supervisor`, mode 0400, in a directory only that user may enter (0700): Docker before the container first starts, through `docker cp` from standard input, so it is in the container's own layer, never in the image or `docker inspect`; Daytona through its file API. It stays there across a stop and a start, and the supervisor reads it at every start, refusing to run if the file or directory is open to anyone else.

**How the supervisor changes user.** `/opt/barrack/bin/run-as-agent` is built from [`run-as-agent.c`](run-as-agent.c), about a hundred lines meant to be read whole, compiled statically in a build stage of its own (the compiler stays there), and given the `setuid` and `setgid` file capabilities; it is owned by root and the `barrack-supervisor` group, mode 0750, so the agent can neither run nor read it. It runs only for the supervisor's user, takes nothing but a program's absolute path and its arguments, makes its caller `barrack-agent` (10002) with that user's group alone, drops every capability (permitted, effective, inheritable and ambient), sets `no_new_privs`, and executes the program with `execv`, so `PATH` plays no part. No argument, variable or file chooses the user: so the supervisor's user, even one an attacker controls, can become the agent and nobody else, and the agent's processes can never gain a privilege again. The supervisor checks at startup that a process the helper starts is the agent, with the agent's group alone and `no_new_privs` set, and refuses to start otherwise.

A container must keep `SETUID` and `SETGID` in its capability bounding set (Docker's default does, and the Docker provider drops every other capability) and must not set `no-new-privileges`, which would stop `run-as-agent` from receiving them; the supervisor's startup check fails clearly without them. No file in the image has the setuid or setgid bit (the build removes them all), and `run-as-agent` is the only file with capabilities (checked with `getcap -r` over the exported image).

Stopping and starting a sandbox keeps everything as it was: the files the agent wrote stay its own, and the supervisor, started again as `barrack-supervisor`, resumes Pi's session from `pi/sessions`. A container made from an image built before this split keeps that image, and so its single user, until it is recreated; nothing has to be migrated.

To act inside a running sandbox as the agent, use `docker exec --user barrack-agent`; the default user is the supervisor's, which cannot list the agent's directories. Neither user's processes inherit any secret from the container's environment.

#### Repository credentials

The supervisor answers Git's credential helper on a socket in `/run/barrack-git`, owned by the supervisor and open to the agent's group only (`BARRACK_GIT_HELPER_SOCKET`). The agent can ask it directly, as Git does, so it can obtain what the helper is given: a token that reads the thread's one repository, for an hour. Nothing that can write to a repository ever enters the sandbox; publishing is done by the control plane (see the [architecture](../docs/architecture.md#working-with-a-git-repository)).

#### What the agent can still reach

Checked by `pnpm test:docker` ([`docker-agent-isolation.test.ts`](../tests/end-to-end/src/docker-agent-isolation.test.ts)), in which the real Pi runs a probe ([`agent-isolation-probe.mjs`](../tests/end-to-end/src/support/agent-isolation-probe.mjs)) as the agent and its own tool output is asserted, with a process left running through `docker exec` as each user beforehand. Closed:

- **Every process of another user**: the supervisor, `tini`, and whatever `docker exec` started as `barrack-supervisor`. Their `environ`, `fd` and `mem` fail with `EACCES`, which also shows that `ptrace` is refused, since `mem` is guarded by the same check, and signals fail with `EPERM`. Command lines and `status` stay readable, as for any process, and hold nothing secret.
- **The token anywhere the agent can read**: every readable `/proc/*/environ` and `/proc/*/cmdline` (including the agent's own `docker exec` process, whose environment is the container's), and every readable file outside `/usr`, `/proc`, `/sys` and `/dev`, plus `/dev/shm`, searched for it: not found.
- **The token through `docker exec` or the container's configuration**: the container's environment holds no token, so no process started with `docker exec`, as either user, inherits one, and `docker inspect` shows none; the agent cannot list `/var/lib/barrack/secrets` or read the token in it (`EACCES`). The providers' contract suite checks the same of every provider with a command interface. Nothing inside a Docker container serves its configuration; the cloud's metadata address is covered below.
- **The supervisor's own files**: its run directory, log, state directory (how far the agent has been handed messages) and secrets directory: `EACCES`. The desktop's control file can be read and not written; the agent cannot create a file beside the Git helper's socket.
- **Core dumps**: the Docker provider sets the core file size limit to 0, soft and hard, for every process in the sandbox (`--ulimit core=0`), so a crashed supervisor writes none, whatever it set; the agent cannot make it crash by a signal anyway.
- **Places the supervisor runs or reads**: the agent can write nowhere outside its workspace, its home, Pi's state and the shared temporary directories (`/tmp`, `/var/tmp`, `/run/lock`, `/dev/shm`), none of which the supervisor runs anything from or reads configuration from: every other path in the sandbox was tried for writing, and none could be.
- **File descriptors crossing to the agent**: Pi holds only its standard input, output and error from the supervisor (socket pairs); no process of the agent holds the supervisor's connection to the control plane or anything under `/run/barrack` or `/var/log/barrack`. Node opens everything else close-on-exec, and `run-as-agent` executes Pi in its own place, so nothing else is inherited. The supervisor's own standard output and error go to Docker's log, which the agent cannot reach.
- **The helper**: running or reading `run-as-agent` fails with `EACCES`.
- **Capabilities**: the agent's permitted, effective, inheritable and ambient sets are empty, and `no_new_privs` is set, so no file can give it a privilege.
- **Setuid and setgid programs**: none exist (every file in the image was checked). A process `docker exec` starts as the agent does not have `no_new_privs`, and one would run with `SETUID` and `SETGID` for it.
- **Holding the start lock** to keep `barrack-ensure-supervisor` from starting a supervisor, or **a process with a matching command line** to make it think one is running: the lock is in a directory the agent cannot enter, and a running supervisor must also belong to `barrack-supervisor`.

Open:

- **Pi's output channel**: the agent's processes run as Pi's user, so they can reach Pi's standard output (by tracing Pi, for instance) and write records the supervisor will take as Pi's. That is by design: Pi and its tools are one trust domain, and the supervisor treats everything from Pi as untrusted input, checked before it is translated. It affects only this thread's history; it does not reach the token. A flaw in that parsing is the way to the supervisor's user, below.
- **The Git helper's socket** answers the agent as it answers Git: a token that can read this thread's one repository, for an hour. By design; nothing that can write ever enters the sandbox.
- **What reaches the model provider.** For a provider the control plane relays (Anthropic, OpenAI and the others marked "Your key stays on the server" in Settings), the sandbox never holds the owner's key: `pi/agent/auth.json` holds a token that works only at the control plane's model proxy, for this thread and provider, while the thread runs, and `pi/agent/models.json` points Pi at the proxy ([`docker-model-proxy.test.ts`](../tests/end-to-end/src/docker-model-proxy.test.ts) searches every file and process the agent can read for the real keys and finds neither). For any other provider the owner's key itself is in `auth.json`, the agent's to read: Pi needs it to work, and the agent runs as Pi. So can any code a repository makes the agent run (a test script, a Git hook, a build step), which could send it anywhere; a user starting threads on repositories they do not trust should prefer a relayed provider, or use a key with a spending limit. Neither is in any process's environment, so nothing started with `docker exec` or a provider's command interface, as either user, inherits it ([`docker-model-access.test.ts`](../tests/end-to-end/src/docker-model-access.test.ts) checks every readable `/proc/*/environ`), and the supervisor's user cannot read the file.
- **The network**: the agent can reach the internet, and so send anything it can read anywhere; and, on Docker, the other sandboxes on the same network, as it could on Docker's default bridge (they listen on nothing but loopback). Closing either means an egress policy, which Barrack does not have.
- **The cloud metadata address**, `169.254.169.254`: on a cloud VM, the network lets a sandbox ask it for the machine's credentials. The container cannot refuse it by itself; the host must (see [the deployment guide](../docs/deployment.md#the-cloud-metadata-address)).
- **The kernel**: a container shares the host's kernel, behind Docker's default seccomp profile and namespaces, with no user namespace remapping; a kernel flaw would let the agent out of the container altogether. A sandbox in its own virtual machine (gVisor, Kata, Firecracker) would close it, at a cost Barrack has not taken on.
- **Disk**: Docker limits a sandbox's memory, processors and processes, but not its disk, so an agent can fill the host's. Docker's per-container size limit needs `overlay2` on XFS with project quotas; on such a host, `--storage-opt size=` would close it.
- **Daytona**: never run. Its daemon listens inside the sandbox, and if a process there can ask it for a command or a file without the API key, the agent can become any user, root included. The [first-deployment checklist](../docs/deployment.md#first-deployment-checklist) says how to check.

#### What the supervisor's user can do

Code execution in the supervisor (a flaw in how it parses what Pi writes, say) gives an attacker the supervisor's user. Checked by the same test, through `docker exec --user barrack-supervisor` ([`supervisor-user-probe.mjs`](../tests/end-to-end/src/support/supervisor-user-probe.mjs)). Closed:

- **Root, or any user but the agent**: the user holds no capability (only `SETUID` and `SETGID` remain in the bounding set, which only a file's capabilities could raise, and only `run-as-agent` has any); `setpriv` to root fails with `EPERM`; `run-as-agent` makes it `barrack-agent` with that group alone, refuses an argument that tries to name a user, and refuses a program not named by its absolute path.
- **The image's software**: it cannot write the helper's directory, the supervisor's code or the start scripts.
- **The file holding the model proxy's token or a model key**: `EACCES` when read directly.

Open, and inherent to its job:

- **Everything the agent can do**, through `run-as-agent`, the model proxy's token or a non-relayed provider's key included; and, as a member of the agent's group, reading the agent's files whose names it knows and whose modes let the group read.
- **This thread's token**, and so acting as this thread's supervisor: recording events in this thread's history, asking for this repository's read token, uploading a publication bundle (which the control plane treats as hostile). Not another thread's: the control plane accepts a token only for the thread it was minted for.
