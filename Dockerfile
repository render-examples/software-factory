# Builds the whole render-factory monorepo and runs the workflows service.
FROM node:22.13-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm@11.9.0

WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

ENV PORT=3000
EXPOSE 3000

# Run compiled JS directly — no pnpm at runtime.
CMD ["node", "workflows/dist/src/server.js"]
