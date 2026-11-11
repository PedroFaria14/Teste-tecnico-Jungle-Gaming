FROM oven/bun:1.4.4-alpine

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000
# `exec` direto (sem shell) para o processo receber o SIGTERM do Docker.
CMD ["bun", "run", "src/main.ts"]
