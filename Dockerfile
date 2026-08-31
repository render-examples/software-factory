FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force && chown -R node:node /app

COPY --chown=node:node . .

EXPOSE 3000

USER node

CMD ["node", "--import", "tsx", "app/src/server.ts"]
