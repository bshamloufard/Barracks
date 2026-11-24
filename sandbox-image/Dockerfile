# The computer a thread runs on: Node, Git, the sandbox supervisor and the
# pinned Pi agent, a graphical desktop with Firefox, and the supervisor as
# the default command. Build it from the repository root
# (`pnpm sandbox-image:build`); see README.md.

# Both base images are pinned by digest, so a rebuild gets the same bytes.
# The Node image supplies the exact Node version the repository requires.
ARG NODE_IMAGE=node:22.23.5-trixie-slim@sha256:fbd104a10cdcca7ab9fb59c10eaabbadde592dd8b3bd297038236aec621437ea
ARG BASE_IMAGE=ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b
# Where Firefox comes from: `mozilla-apt`, Mozilla's APT repository (the
# default), or `build-context`, an unpacked official Firefox build for
# Linux handed to the build as the named context `firefox`
# (`--build-context firefox=<directory>`), for builds that cannot reach
# packages.mozilla.org. See README.md.
ARG FIREFOX_SOURCE=mozilla-apt

# --- Build the supervisor and gather its production dependencies ----------
FROM ${NODE_IMAGE} AS supervisor-build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repository

# Fetching from the lockfile alone means this layer, the slow one, is reused
# until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm fetch

COPY tsconfig.base.json ./
COPY packages/protocol/ packages/protocol/
COPY apps/sandbox-supervisor/ apps/sandbox-supervisor/
# `deploy` writes the supervisor with only its production dependencies,
# workspace packages included, into a directory that runs on its own. It
# copies workspace packages rather than linking them, which this setting
# (given here so the workspace's own installs are unaffected) asks for.
RUN pnpm install --offline --frozen-lockfile --filter "@barrack/sandbox-supervisor..." \
 && pnpm --filter "@barrack/sandbox-supervisor..." build \
 && pnpm --config.inject-workspace-packages=true --filter @barrack/sandbox-supervisor \
      deploy --offline --prod /opt/barrack/supervisor \
 && cd /opt/barrack/supervisor \
 && find . -mindepth 1 -maxdepth 1 ! -name dist ! -name node_modules ! -name package.json \
      -exec rm -rf {} +

FROM ${NODE_IMAGE} AS node-runtime

# --- Build run-as-agent -----------------------------------------------------
# The helper through which the supervisor runs things as the agent
# (run-as-agent.c), linked statically so no loader takes part while it holds
# its capabilities. The compiler stays in this stage.
FROM ${BASE_IMAGE} AS run-as-agent-build
RUN apt-get update \
 && apt-get install --yes --no-install-recommends gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/*
COPY sandbox-image/run-as-agent.c /build/
RUN gcc -static -O2 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2 -fstack-protector-strong \
      -o /build/run-as-agent /build/run-as-agent.c

# --- The sandbox, before its browser --------------------------------------
FROM ${BASE_IMAGE} AS sandbox-base

# Two users, so that the agent cannot read the supervisor's secrets. Their
# IDs are also compiled into run-as-agent.c, which can make its caller
# barrack-agent alone; the supervisor checks at startup that they agree. The
# supervisor's token is in a file only its user can read, and then in its
# memory, which /proc shows to its own user alone; and Linux lets a process
# signal or trace only processes of its own user. The supervisor is a member of the agent's group, for the
# access to the agent's directories described below; the agent is in no group
# but its own.
RUN groupadd --gid 10001 barrack-supervisor \
 && groupadd --gid 10002 barrack-agent \
 && useradd --uid 10002 --gid barrack-agent --create-home --shell /bin/bash barrack-agent \
 && useradd --uid 10001 --gid barrack-supervisor --groups barrack-agent --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin barrack-supervisor

# git for the agent's work, ca-certificates for git over HTTPS, and tini to
# forward signals to the supervisor and reap the orphans an agent's commands
# leave behind.
#
# The supervisor starts the agent through run-as-agent, which alone carries
# the capabilities to change user, which only the supervisor's group may run
# (or read), and which can make its caller barrack-agent and no one else,
# with no capabilities and no way to gain any (no_new_privs). Granting them
# to this small program keeps the supervisor's own process unprivileged, and
# its user short of root. The ownership is set before the capabilities,
# since changing a file's owner clears them. libcap2-bin is needed only to
# grant them, so it goes again in the same layer. The directories are made
# first, since COPY would give them the file's owner and mode, which would
# close /opt/barrack, and with it Node's packages, to the agent.
RUN install -d -m 0755 /opt/barrack /opt/barrack/bin
COPY --from=run-as-agent-build --chown=root:barrack-supervisor --chmod=0750 \
      /build/run-as-agent /opt/barrack/bin/run-as-agent
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates git libcap2-bin tini \
 && setcap cap_setuid,cap_setgid=ep /opt/barrack/bin/run-as-agent \
 && apt-get purge --yes --auto-remove libcap2-bin \
 && rm -rf /var/lib/apt/lists/*

# Node, npm and corepack, exactly as the official image installs them.
COPY --from=node-runtime /usr/local/bin/ /usr/local/bin/
COPY --from=node-runtime /usr/local/lib/node_modules/ /usr/local/lib/node_modules/

# The desktop (see barrack-desktop): TigerVNC's Xvnc, X server and VNC
# server in one process; Openbox, which gives a clicked window the keyboard
# and needs no session bus; xdotool, through which the agent's computer tool
# uses the mouse and keyboard; and two font families for web pages. Each X
# server and VNC server Ubuntu packages pulls in Mesa and LLVM, most of this
# layer's size. X clients find the server through /tmp/.X11-unix, which only
# root may create.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
      tigervnc-standalone-server openbox xdotool fonts-dejavu-core fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -m 1777 /tmp/.X11-unix
COPY --chmod=0755 sandbox-image/barrack-desktop /usr/local/bin/
# Firefox reads this enterprise policy wherever it is installed: no terms of
# use dialog (accepted on the users' behalf; see docs/decisions.md), no
# updates (the image brings them), no telemetry, studies or first-run pages.
COPY sandbox-image/firefox-policies.json /etc/firefox/policies/policies.json

# --- Firefox, from Mozilla's APT repository ---------------------------------
FROM sandbox-base AS firefox-from-mozilla-apt
# Mozilla's signing key is kept in the repository, so the build does not
# trust whatever key a download returns; its fingerprint is
# 35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3, as Mozilla publishes it
# (https://support.mozilla.org/kb/install-firefox-linux). Only Firefox is
# taken from that repository, and never Ubuntu's Firefox, which is a
# transitional package for the snap; Mozilla's own instructions pin every
# package, which would let it replace any of Ubuntu's. The repository keeps
# only current versions, so each build gets the Firefox of its day.
COPY sandbox-image/packages.mozilla.org.asc /etc/apt/keyrings/packages.mozilla.org.asc
RUN echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" \
      > /etc/apt/sources.list.d/mozilla.list \
 && printf '%s\n' 'Package: firefox*' 'Pin: origin packages.mozilla.org' 'Pin-Priority: 1000' '' \
      'Package: firefox*' 'Pin: release o=Ubuntu' 'Pin-Priority: -1' > /etc/apt/preferences.d/mozilla \
 && apt-get update \
 && apt-get install --yes --no-install-recommends firefox \
 && rm -rf /var/lib/apt/lists/*

# --- Firefox, from a build handed to the build ------------------------------
# For builds that cannot reach packages.mozilla.org: the named build context
# `firefox` holds an unpacked official Firefox for Linux (the `firefox`
# directory of Mozilla's tarball), and the libraries Mozilla's package
# depends on come from Ubuntu.
FROM sandbox-base AS firefox-from-build-context
COPY --from=firefox / /usr/lib/firefox/
RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
      libgtk-3-0t64 libasound2t64 libx11-xcb1 libdbus-1-3 libxtst6 \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/lib/firefox/firefox /usr/local/bin/firefox

# --- The sandbox ------------------------------------------------------------
FROM firefox-from-${FIREFOX_SOURCE} AS sandbox

# The capability bounding set keeps SETUID and SETGID for run-as-agent, and
# the container's no-new-privileges cannot be set without disarming it. Every
# process run-as-agent starts sets no_new_privs itself, so nothing the agent
# runs can gain privileges; but a process `docker exec` starts as the agent
# does not have it, and any setuid or setgid program would run with those two
# capabilities for it, and a flaw in one (su, passwd, mount...) would let it
# become the supervisor, or root. Nothing here needs them, so none keep the
# bit.
RUN find / -xdev -type f -perm /6000 -exec chmod ug-s {} +

# The agent owns its workspace, its state (Pi's credentials, settings and
# sessions) and its home. The supervisor needs only to pass through the first
# two: Node changes into the workspace as the supervisor before run-as-agent
# changes user, and the supervisor checks that the session file it resumes
# still exists. So the agent's group, which holds the supervisor, may search
# these directories (0710) but not list them, and the agent's home is closed
# (0700). The supervisor's own directories are closed to the agent (0750):
# its process ID file, the lock that serialises starting it, its log, and
# the state it keeps across its own restarts (how far the agent has been
# handed user messages), which the agent must not be able to rewrite.
#
# Git's credential helper, which runs as the agent, asks the supervisor for
# repository credentials on a socket in /run/barrack-git: the supervisor's,
# and open to the agent's group alone, so nothing else in the sandbox can
# reach it. What it answers is read-only and short-lived, and assumed to be
# the agent's.
#
# The supervisor writes who holds the desktop's input to a file in
# /run/barrack-desktop, which the agent's computer tool reads and the agent
# cannot change.
#
# The sandbox provider puts the supervisor's secrets (its token) in
# /var/lib/barrack/secrets, one file each, owned by the supervisor and mode
# 0400, in the container's own layer, never in an image layer or the
# environment; the directory is the supervisor's alone (0700).
RUN install -d -o barrack-agent -g barrack-agent -m 0710 \
      /workspace /var/lib/barrack/state \
      /var/lib/barrack/state/pi /var/lib/barrack/state/pi/agent /var/lib/barrack/state/pi/sessions \
 && chmod 0700 /home/barrack-agent \
 && install -d -o barrack-supervisor -g barrack-supervisor -m 0750 \
      /run/barrack /var/log/barrack /var/lib/barrack/supervisor \
 && install -d -o barrack-supervisor -g barrack-supervisor -m 0700 /var/lib/barrack/secrets \
 && install -d -o barrack-supervisor -g barrack-agent -m 0750 /run/barrack-git \
 && install -d -o barrack-supervisor -g barrack-supervisor -m 0755 /run/barrack-desktop \
 && install -o barrack-supervisor -g barrack-supervisor -m 0640 /dev/null /run/barrack/ensure-supervisor.lock \
 && install -o barrack-supervisor -g barrack-supervisor -m 0640 /dev/null /var/log/barrack/supervisor.log

COPY --from=supervisor-build /opt/barrack/supervisor/ /opt/barrack/supervisor/
COPY --chmod=0755 sandbox-image/barrack-run-supervisor sandbox-image/barrack-ensure-supervisor \
      /usr/local/bin/

# Without BARRACK_AGENT_USER, or with the supervisor started as that same
# user, the supervisor refuses to start the agent rather than let it read the
# supervisor's token; providers that may not pass this environment on set it
# themselves.
ENV BARRACK_WORKSPACE_DIRECTORY=/workspace \
    BARRACK_STATE_DIRECTORY=/var/lib/barrack/state \
    BARRACK_SUPERVISOR_STATE_DIRECTORY=/var/lib/barrack/supervisor \
    BARRACK_SUPERVISOR_SECRETS_DIRECTORY=/var/lib/barrack/secrets \
    BARRACK_GIT_HELPER_SOCKET=/run/barrack-git/credential.sock \
    BARRACK_SUPERVISOR_USER=barrack-supervisor \
    BARRACK_AGENT_USER=barrack-agent \
    BARRACK_DESKTOP_COMMAND=/usr/local/bin/barrack-desktop \
    BARRACK_DESKTOP_CONTROL_FILE=/run/barrack-desktop/control \
    DISPLAY=:1

USER barrack-supervisor
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/barrack-run-supervisor"]
