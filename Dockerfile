FROM node:22.13-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@11.9.0

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# Symlink tsx to a stable path so start commands can use it without pnpm
RUN ln -s /app/node_modules/.bin/tsx /usr/local/bin/tsx

ENV PORT=3000
EXPOSE 3000

CMD ["tsx", "workflows/dist/src/server.js"]
