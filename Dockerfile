# Builds the whole render-agents monorepo and runs the example demo app.
# The library packages (engine/store/sdk/gateway) compile to dist via `pnpm build`;
# the demo app (examples/demo) runs from source with tsx, importing the built deps.
# One image, three commands (gateway / worker / workflows) selected by compose.
FROM node:22-slim

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
CMD ["pnpm", "--filter", "@render-agents/example-demo", "start"]
