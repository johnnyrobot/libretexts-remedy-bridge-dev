FROM node:22-bookworm-slim

# Required-mode ownership and FULL/WAL ledger use the local POSIX Python helper.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && python3 -c "import sqlite3, fcntl" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/conductor-panel/package.json packages/conductor-panel/package.json
COPY tools/patch-cxone-utf8.mjs tools/patch-cxone-utf8.mjs
RUN npm ci --no-audit

COPY . .
RUN npm run build --workspace @libretexts/remedy-core \
    && npm run build --workspace @libretexts/remedy-cli \
    && npm run build --workspace @libretexts/remedy-conductor-panel

EXPOSE 5175
CMD ["npx", "tsx", "packages/conductor-panel/server/server.ts"]
