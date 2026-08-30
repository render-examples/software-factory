FROM node:22

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force

COPY . .

EXPOSE 3000

CMD ["node", "--import", "tsx", "app/src/server.ts"]
