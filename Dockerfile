# Builds the whole render-factory monorepo and runs the example demo app.
# The library packages (engine/store/sdk/gateway) compile to dist via `pnpm build`;
# the demo app (examples/demo) runs from source with tsx, importing the built deps.
# One image, three commands (gateway / worker / workflows) selected by compose.
FROM node:22-slim

# git: the issue-to-pr workflow clones/commits/pushes the target repo.
# curl + ca-certificates: the cron services POST to the gateway admin routes,
# and git needs CA certs for HTTPS. (Add the target repo's toolchain here too —
# e.g. python/go — if the coding agent must run non-Node test suites.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy the full workspace, then install + build. pnpm resolves workspace:* deps
# to the local packages; turbo builds them in dependency order.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

ENV PORT=3000
EXPOSE 3000

# Default to the gateway (web). compose overrides `command` for the other lanes.
CMD ["pnpm", "--filter", "@render-factory/example-demo", "start"]
