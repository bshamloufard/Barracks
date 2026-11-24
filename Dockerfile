# The control plane's production image: the built control plane with its
# production dependencies only, and the built web client, which it serves.
# Build it from the repository root:
#
#   docker build --tag barrack-control-plane .
#
# It is configured entirely by environment variables and listens on 8787; see
# docs/deployment.md. Railway builds this file because it is named
# `Dockerfile` at the repository root, and builds the last stage below.
#
# The default image carries no Docker CLI, because hosted deployments create
# sandboxes through Daytona's API. The stage `control-plane-with-docker-cli`
# adds the CLI for the Docker sandbox provider, as compose.yaml uses it.

# Every base image is pinned by digest, so a rebuild gets the same bytes. The
# Node image is the one the sandbox image uses, so both run the same Node.
# Each can be replaced with a build argument, for a mirror for example.
ARG NODE_IMAGE=node:22.23.5-trixie-slim@sha256:fbd104a10cdcca7ab9fb59c10eaabbadde592dd8b3bd297038236aec621437ea
ARG RUNTIME_BASE_IMAGE=debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
ARG DOCKER_CLI_IMAGE=docker:29.9.3-cli@sha256:5a7af0dcb0e46c803efe9b45371dd21cb500e5b4453250394ac6f06d49b6e6f1

# --- Build the control plane and the web client ----------------------------
FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repository

# Fetching from the lockfile alone means this layer, the slow one, is reused
# until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm fetch

COPY tsconfig.base.json ./
COPY packages/protocol/ packages/protocol/
COPY packages/sandbox-providers/ packages/sandbox-providers/
COPY apps/control-plane/ apps/control-plane/
COPY apps/web/ apps/web/
# `deploy` writes the control plane with only its production dependencies,
# workspace packages copied in rather than linked (which the setting asks
# for), into a directory that runs on its own. Of the control plane's own
# files only the compiled code and the SQL migrations, which it reads at
# startup, are kept.
RUN pnpm install --offline --frozen-lockfile \
      --filter "@barrack/control-plane..." --filter "@barrack/web..." \
 && pnpm --filter "@barrack/control-plane..." --filter "@barrack/web..." build \
 && pnpm --config.inject-workspace-packages=true --filter @barrack/control-plane \
      deploy --offline --prod /opt/barrack/control-plane \
 && cd /opt/barrack/control-plane \
 && find . -mindepth 1 -maxdepth 1 \
      ! -name dist ! -name migrations ! -name node_modules ! -name package.json \
      -exec rm -rf {} + \
 && cp -R /repository/apps/web/dist /opt/barrack/web

FROM ${NODE_IMAGE} AS node-runtime

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

# --- The control plane -----------------------------------------------------
# Debian with only the Node binary from the official image, rather than the
# whole Node image: the control plane needs neither npm, yarn nor corepack,
# and leaving them out saves about 90 MB.
FROM ${RUNTIME_BASE_IMAGE} AS control-plane

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

# Git, to publish threads' work branches: the control plane checks each
# sandbox's bundle and pushes it (see src/publication). ca-certificates for
# Git over HTTPS. git-man and the other recommended packages are not needed.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# A user of its own with no login shell: nothing in the control plane needs
# root, and the Docker variant below reaches Docker through a socket proxy
# over TCP, so it needs no membership of the host's docker group either.
RUN groupadd --gid 10000 barrack \
 && useradd --uid 10000 --gid barrack --create-home --shell /usr/sbin/nologin barrack

COPY --from=build /opt/barrack/control-plane/ /opt/barrack/control-plane/
COPY --from=build /opt/barrack/web/ /opt/barrack/web/

# Defaults for running in a container. Inside one, the control plane must
# listen on every interface to be reachable at all; who can reach it is
# decided by what publishes the port (compose.yaml publishes it on
# 127.0.0.1 only). Every other setting comes from the environment.
ENV NODE_ENV=production \
    BARRACK_CONTROL_PLANE_HOST=0.0.0.0 \
    BARRACK_CONTROL_PLANE_PORT=8787 \
    BARRACK_WEB_CLIENT_DIRECTORY=/opt/barrack/web

USER barrack
WORKDIR /opt/barrack/control-plane
EXPOSE 8787

# Node runs as the first process and receives SIGTERM itself: main.ts handles
# it by closing every connection, waiting for sandbox creations under way and
# closing the database pool. No init process is needed, because the only
# processes the control plane starts are Git and docker CLI commands, which
# it waits for and so reaps. `docker run <image> dist/migrate.js` applies migrations
# without starting the server.
ENTRYPOINT ["node"]
CMD ["dist/main.js"]

# --- The control plane with the Docker CLI, for the Docker sandbox provider --
FROM control-plane AS control-plane-with-docker-cli
# The CLI is a static binary, so it runs on this image as it is.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

# --- The default image -----------------------------------------------------
# `docker build` and Railway build the last stage, which is the plain image.
FROM control-plane
