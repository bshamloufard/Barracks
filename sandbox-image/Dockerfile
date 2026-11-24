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

# Two users, so that the agent cannot read the supervisor's secrets. The agent
# owns the workspace and its own state; the supervisor can read both (it is in
# the agent's group) to find the agent's session file. The supervisor's token
# lives only in its environment, which /proc shows to its own user alone.
RUN groupadd --gid 10001 barrack-supervisor \
 && groupadd --gid 10002 barrack-agent \
 && useradd --uid 10002 --gid barrack-agent --create-home --shell /bin/bash barrack-agent \
 && useradd --uid 10001 --gid barrack-supervisor --groups barrack-agent --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin barrack-supervisor

# git for the agent's work, ca-certificates for git over HTTPS, and tini to
# forward signals to the supervisor and reap the orphans an agent's commands
# leave behind.
#
# The supervisor is to start the agent through run-as-agent, a copy of
# setpriv that alone carries the capabilities to change user, and that only
# the supervisor's group may run. It changes to the agent's user and runs the
# agent, which ends up with no capabilities at all. Granting them to this
# small binary keeps the supervisor's own process unprivileged. libcap2-bin
# is needed only to grant them, so it goes again in the same layer.
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

# Which user the supervisor runs as. Until the supervisor starts the agent
# through run-as-agent, both run as the agent's user; switching this to
# barrack-supervisor separates them (see README.md).
ARG SUPERVISOR_USER=barrack-agent

RUN install -d -o barrack-agent -g barrack-agent -m 0750 \
      /workspace /var/lib/barrack/state \
      /var/lib/barrack/state/pi /var/lib/barrack/state/pi/agent /var/lib/barrack/state/pi/sessions \
 && install -d -o "${SUPERVISOR_USER}" -g "${SUPERVISOR_USER}" -m 0755 /run/barrack /var/log/barrack \
 && install -o "${SUPERVISOR_USER}" -g "${SUPERVISOR_USER}" -m 0644 /dev/null /run/barrack/ensure-supervisor.lock \
 && install -o "${SUPERVISOR_USER}" -g "${SUPERVISOR_USER}" -m 0640 /dev/null /var/log/barrack/supervisor.log

COPY --from=supervisor-build /opt/barrack/supervisor/ /opt/barrack/supervisor/
COPY --chmod=0755 sandbox-image/barrack-run-supervisor sandbox-image/barrack-ensure-supervisor \
      /usr/local/bin/

ENV BARRACK_WORKSPACE_DIRECTORY=/workspace \
    BARRACK_STATE_DIRECTORY=/var/lib/barrack/state \
    BARRACK_SUPERVISOR_USER=${SUPERVISOR_USER} \
    BARRACK_AGENT_USER=barrack-agent

USER ${SUPERVISOR_USER}
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/barrack-run-supervisor"]
