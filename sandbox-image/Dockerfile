# The computer a thread runs on: Node, Git, the sandbox supervisor and the
# pinned Pi agent, with the supervisor as the default command. Build it from
# the repository root (`pnpm sandbox-image:build`); see README.md.

# Both base images are pinned by digest, so a rebuild gets the same bytes.
# The Node image supplies the exact Node version the repository requires.
ARG NODE_IMAGE=node:22.23.5-trixie-slim@sha256:fbd104a10cdcca7ab9fb59c10eaabbadde592dd8b3bd297038236aec621437ea
ARG BASE_IMAGE=ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b

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

# --- The sandbox -----------------------------------------------------------
FROM ${BASE_IMAGE}

# Two users, so that the agent cannot read the supervisor's secrets. The
# supervisor's token lives only in its environment, which /proc shows to its
# own user alone, and Linux lets a process signal or trace only processes of
# its own user. The supervisor is a member of the agent's group, for the
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
# The supervisor starts the agent through run-as-agent, a copy of setpriv
# that alone carries the capabilities to change user, and that only the
# supervisor's group may run (or read). It changes to the agent's user and
# runs the agent, which ends up with no capabilities at all. Granting them to
# this small binary keeps the supervisor's own process unprivileged.
# libcap2-bin is needed only to grant them, so it goes again in the same layer.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates git libcap2-bin tini \
 && install -d -m 0755 /opt/barrack/bin \
 && install -o root -g barrack-supervisor -m 0750 /usr/bin/setpriv /opt/barrack/bin/run-as-agent \
 && setcap cap_setuid,cap_setgid=ep /opt/barrack/bin/run-as-agent \
 && apt-get purge --yes --auto-remove libcap2-bin \
 && rm -rf /var/lib/apt/lists/*

# Node, npm and corepack, exactly as the official image installs them.
COPY --from=node-runtime /usr/local/bin/ /usr/local/bin/
COPY --from=node-runtime /usr/local/lib/node_modules/ /usr/local/lib/node_modules/

# The capability bounding set keeps SETUID and SETGID for run-as-agent, and
# no-new-privileges cannot be set without disarming it, so any setuid or
# setgid program would run with those two capabilities for whoever runs it,
# the agent included, and a flaw in one (su, passwd, mount...) would let the
# agent become the supervisor. Nothing here needs them, so none keep the bit.
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
RUN install -d -o barrack-agent -g barrack-agent -m 0710 \
      /workspace /var/lib/barrack/state \
      /var/lib/barrack/state/pi /var/lib/barrack/state/pi/agent /var/lib/barrack/state/pi/sessions \
 && chmod 0700 /home/barrack-agent \
 && install -d -o barrack-supervisor -g barrack-supervisor -m 0750 \
      /run/barrack /var/log/barrack /var/lib/barrack/supervisor \
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
    BARRACK_SUPERVISOR_USER=barrack-supervisor \
    BARRACK_AGENT_USER=barrack-agent

USER barrack-supervisor
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/barrack-run-supervisor"]
