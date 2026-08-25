# Builds the whole render-factory monorepo and runs the workflows service.
# The library packages (engine/store/sdk/gateway) compile to dist via `pnpm build`;
# the workflows package runs from source with tsx, importing the built deps.
# One image, three commands (gateway / workflows) selected by compose or start command.
FROM node:22.13-slim

# git: the spec-to-pr workflow clones/commits/pushes the target repo.
# curl + ca-certificates: the cron services POST to the gateway admin routes,
# and git needs CA certs for HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm@11.9.0

WORKDIR /app

COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

USER node

ENV PORT=3000
EXPOSE 3000

# Use node+tsx directly to avoid pnpm's runtime deps check which tries
# to write temp files to /app (fails on Render's read-only filesystem).
CMD ["node", "--import", "tsx", "workflows/src/server.ts"]
