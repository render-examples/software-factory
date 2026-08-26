FROM node:22.13-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@11.9.0

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

ENV PORT=3000
EXPOSE 3000

# Default: gateway. Workflows service overrides via Dashboard start command.
CMD ["node", "workflows/dist/src/server.js"]
