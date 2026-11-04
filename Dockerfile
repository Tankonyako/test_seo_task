# node 24+ runs .ts files directly (type stripping), so there is no build step
FROM node:26-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY config.json ./
ENTRYPOINT ["node", "src/main.ts"]
