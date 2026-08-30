FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force

COPY . .

EXPOSE 3000

CMD ["npx", "tsx", "app/src/server.ts"]
