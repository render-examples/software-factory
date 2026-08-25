# Builds the whole render-factory monorepo and runs the workflows service.
# The library packages (engine/store/sdk/gateway) compile to dist via `pnpm build`;
# the workflows package runs from source with tsx, importing the built deps.
# One image, three commands (gateway / worker / workflows) selected by compose.
FROM node:22.13-slim

# git: the spec-to-pr workflow clones/commits/pushes the target repo.
# curl + ca-certificates: the cron services POST to the gateway admin routes,
# and git needs CA certs for HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV npm_config_verify_deps_before_run=false
RUN npm install -g pnpm@11.9.0

WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

ENV PORT=3000
EXPOSE 3000

CMD ["pnpm", "--filter", "@render-factory/workflows", "start"]
