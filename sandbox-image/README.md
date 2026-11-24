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
- Firefox comes from Mozilla's APT repository (`packages.mozilla.org`), checked against Mozilla's signing key kept here in [`packages.mozilla.org.asc`](packages.mozilla.org.asc) (fingerprint `35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3`, as [Mozilla's installation page](https://support.mozilla.org/kb/install-firefox-linux) gives it), and only Firefox is taken from there. That repository keeps current versions only, so each build gets the Firefox of its day. Where the build cannot reach it, hand it an unpacked official Firefox for Linux (the `firefox` directory of Mozilla's tarball for the image's architecture) instead:

  ```sh
  pnpm sandbox-image:build --build-arg FIREFOX_SOURCE=build-context --build-context firefox=/path/to/firefox
  ```

The image is large: about 1.8 GB unpacked, most of it the desktop (Mesa and LLVM, which Ubuntu's X servers depend on) and Firefox. See the [decision log](../docs/decisions.md) for why the desktop is always part of it.

## The desktop

`barrack-desktop` runs the sandbox's graphical desktop in the foreground, as whoever runs it, until its standard input closes: TigerVNC's `Xvnc` (X server and VNC server in one process) on display `:1` at 1280×800, serving VNC on `127.0.0.1:5900` only and without a password, every viewer shared, viewers unable to resize it, at most 15 updates a second; and the Openbox window manager. It clears the X server's lock and socket a stopped sandbox left in `/tmp`, whose process number may now belong to a living process. The supervisor runs it as the agent (`BARRACK_DESKTOP_COMMAND`, which the image sets with `DISPLAY=:1`) whenever the sandbox runs, and starts it again whenever it ends. Nothing outside the sandbox reaches the VNC server: the supervisor opens a stream to it only when the control plane asks (see the [architecture](../docs/architecture.md#the-live-desktop)).

The agent may start Firefox (`firefox URL &`) and use its computer tool. Firefox's enterprise policy, [`firefox-policies.json`](firefox-policies.json) in `/etc/firefox/policies`, turns off updates, telemetry, studies and first-run pages, and accepts Mozilla's terms of use on the users' behalf (`SkipTermsOfUse`; remove it to have each sandbox's first Firefox window ask instead). Its content processes keep Firefox's own seccomp sandbox in a container without user namespaces.

The supervisor writes who holds the desktop's input, `agent` or `user`, to `/run/barrack-desktop/control` (`BARRACK_DESKTOP_CONTROL_FILE`), a directory the agent may read and not write. **Anything typed into the desktop, passwords included, is readable by the agent**, which shares the X server's user and the browser profile.

### For Daytona

The Daytona provider creates sandboxes from a Daytona snapshot of this image, named by `BARRACK_DAYTONA_SNAPSHOT`. Daytona's CLI can push a locally built image as a snapshot, for example `daytona snapshot push barrack-sandbox:dev --name barrack-sandbox-<version>`. Use a new name for each build, since Daytona rejects tags such as `latest`. This route has not yet been tried against a live Daytona account.

## What runs, and as whom

`tini` is the first process. It starts the supervisor (`barrack-run-supervisor`), forwards stop signals to it, and reaps orphaned processes that the agent's commands leave behind. When the supervisor exits, the container stops, and its exit code tells a requested stop (0) from a failure.

`barrack-ensure-supervisor` starts the supervisor in the background unless one is already running. Providers that do not use the image's default command (Daytona decides a sandbox's first process itself) run it after every create and start. `barrack-ensure-supervisor --check` only reports, by its exit status, whether one is running. Run either as root (the supervisor is then started as `barrack-supervisor`) or as `barrack-supervisor`; no other user may open its lock.

### Keeping the supervisor's secrets from the agent

The supervisor runs as `barrack-supervisor` and starts the agent as `barrack-agent` (see [the supervisor's README](../apps/sandbox-supervisor/README.md#which-user-the-agent-runs-as)). Linux shows a process's environment, memory and file descriptors, and lets it be signalled or traced, only by processes of its own user, so the agent cannot reach the supervisor's token through its process. If `BARRACK_AGENT_USER` is missing (a platform that does not pass the image's environment on) or the supervisor was started as `barrack-agent` (a user override), the supervisor refuses to start the agent and says why, rather than share its user; the Daytona provider sets `BARRACK_AGENT_USER` itself for that reason.

| User                 | UID   | Groups                         | Owns                                                                                                           |
| -------------------- | ----- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `barrack-supervisor` | 10001 | its own, and `barrack-agent`'s | `/run/barrack`, `/var/log/barrack`, `/var/lib/barrack/supervisor` (0750) and `/var/lib/barrack/secrets` (0700) |
| `barrack-agent`      | 10002 | its own only                   | `/workspace` and `/var/lib/barrack/state` (0710), `/home/barrack-agent` (0700)                                 |

**What each side may touch.** The agent owns everything it works on: its workspace, Pi's state under `/var/lib/barrack/state` (the thread owner's model key in `pi/agent/auth.json`, which the supervisor writes as the agent, 0600; settings, models and session files) and its home. The supervisor needs only to pass through two of those: Node changes into the workspace as the supervisor before `run-as-agent` changes user, and the supervisor checks that the session file it is about to resume still exists. So the supervisor is in the agent's group, and the agent's directories give that group search access (0710) but not listing; the agent's home is closed to it. No other user can enter any of them, whatever modes the agent gives the files inside. The supervisor's own directories hold its process ID file, the lock that serialises starting it, its log, the record of how far the agent has been handed user messages, which the agent must not be able to rewrite, and its token; the agent cannot enter them.

**How the supervisor gets its token.** Not from the environment, which every process started in the sandbox gets, `docker exec --user barrack-agent` included. The provider puts it in `/var/lib/barrack/secrets/BARRACK_SUPERVISOR_TOKEN`, owned by `barrack-supervisor`, mode 0400, in a directory only that user may enter (0700): Docker before the container first starts, through `docker cp` from standard input, so it is in the container's own layer, never in the image or `docker inspect`; Daytona through its file API. It stays there across a stop and a start, and the supervisor reads it at every start, refusing to run if the file or directory is open to anyone else.

**How the supervisor changes user.** `/opt/barrack/bin/run-as-agent` is a copy of `setpriv` with the `setuid` and `setgid` file capabilities, owned by root and the `barrack-supervisor` group, mode 0750: the agent can neither run nor read it. The supervisor's own process has no capabilities; the agent ends up with none either. A container must keep `SETUID` and `SETGID` in its capability bounding set (Docker's default does, and the Docker provider drops every other capability) and must not set `no-new-privileges`, which would stop `run-as-agent` from receiving them; the supervisor checks this at startup and refuses to start without it. No file in the image has the setuid or setgid bit (the build removes them all), and `run-as-agent` is the only file with capabilities (checked with `getcap -r /`).

Stopping and starting a sandbox keeps everything as it was: the files the agent wrote stay its own, and the supervisor, started again as `barrack-supervisor`, resumes Pi's session from `pi/sessions`. A container made from an image built before this split keeps that image, and so its single user, until it is recreated; nothing has to be migrated.

To act inside a running sandbox as the agent, use `docker exec --user barrack-agent`; the default user is the supervisor's, which cannot list the agent's directories. Neither user's processes inherit any secret from the container's environment.

#### Repository credentials

The supervisor answers Git's credential helper on a socket in `/run/barrack-git`, owned by the supervisor and open to the agent's group only (`BARRACK_GIT_HELPER_SOCKET`). The agent can ask it directly, as Git does, so it can obtain what the helper is given: a token that reads the thread's one repository, for an hour. Nothing that can write to a repository ever enters the sandbox; publishing is done by the control plane (see the [architecture](../docs/architecture.md#working-with-a-git-repository)).

#### What the agent can still reach

Checked by `pnpm test:docker` ([`docker-agent-isolation.test.ts`](../tests/end-to-end/src/docker-agent-isolation.test.ts)), in which the real Pi runs commands as the agent and its own tool output is asserted. Closed:

- **The supervisor's and the first process's (`tini`'s) `/proc` entries**: `environ`, `fd` and `mem` fail with `EACCES`, which also shows that `ptrace` is refused, since `mem` is guarded by the same check. Command lines and `status` stay readable, as for any process, and hold nothing secret.
- **Signals** to the supervisor and to `tini`: `EPERM`.
- **The token anywhere the agent can read**: every readable `/proc/*/environ` and `/proc/*/cmdline`, and every readable file under `/run`, `/var`, `/tmp`, `/dev/shm`, `/home`, `/workspace`, `/etc` and `/root`, searched for it: not found.
- **The token through `docker exec`**: the container's environment holds no token, so a process started with `docker exec`, as either user, does not inherit one, and as the agent it cannot open `/var/lib/barrack/secrets` (the providers' contract suite checks this for every provider with a command interface).
- **File descriptors crossing to the agent**: Pi holds only its standard input, output and error from the supervisor (socket pairs); no process of the agent holds the supervisor's connection to the control plane or anything under `/run/barrack` or `/var/log/barrack`. Node opens everything else close-on-exec, and `setpriv` executes Pi in its own place, so nothing else is inherited.
- **The helper**: running or reading `run-as-agent` fails with `EACCES`.
- **Capabilities**: the agent's permitted, effective and ambient sets are empty.
- **Setuid and setgid programs**: none exist. They would otherwise run with `SETUID` and `SETGID` for whoever runs them, since `no-new-privileges` cannot be set.
- **Shared temporary directories**: the supervisor writes nothing to `/tmp` or `/dev/shm`.
- **Holding the start lock** to keep `barrack-ensure-supervisor` from starting a supervisor, or **a process with a matching command line** to make it think one is running: the lock is in a directory the agent cannot enter, and a running supervisor must also belong to `barrack-supervisor`.

Open:

- **Pi's output channel**: the agent's processes run as Pi's user, so they can reach Pi's standard output (by tracing Pi, for instance) and write records the supervisor will take as Pi's. That is by design: Pi and its tools are one trust domain, and the supervisor already treats everything from Pi as untrusted input, checked before it is translated. It affects only this thread's history; it does not reach the token.
- **The supervisor itself**: `run-as-agent` can make its caller any user, root included, so the supervisor's user is as good as root in the container (with only `SETUID` and `SETGID` in the bounding set). Code execution in the supervisor, through a flaw in how it parses what Pi writes, say, would give the agent the token and root in the container. Narrowing this means a helper that can only ever switch to `barrack-agent`, or the supervisor in a container of its own.
- **Daytona**: Daytona's own processes inside a sandbox, and how its command API runs commands, have not been examined; if they let a process ask for commands as another user, the agent could use them.
- **The cloud metadata address**, `169.254.169.254`: on a cloud VM, the network lets a sandbox ask it for the machine's credentials. The container cannot refuse it by itself; the host must (see [the deployment guide](../docs/deployment.md#the-cloud-metadata-address)).
- **The thread owner's model key** is the agent's to read, in `pi/agent/auth.json`: Pi needs it to work, and the agent runs as Pi. So can any code a repository makes the agent run (a test script, a Git hook, a build step), which could send it anywhere; a user starting threads on repositories they do not trust should use a key with a spending limit. The key is in no process's environment, so nothing started with `docker exec` or a provider's command interface, as either user, inherits it ([`docker-model-access.test.ts`](../tests/end-to-end/src/docker-model-access.test.ts) checks every readable `/proc/*/environ`), and the supervisor's user cannot read the file. Keeping keys out of the sandbox altogether is Milestone 7.
