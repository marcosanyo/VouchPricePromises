# Vouch on Cloud Run: one service serves the API, the MCP-over-HTTP routes and the web app.
# The database is a snapshot of the local one (data/snapshot/vouch.db, `npm -w server run snapshot`).
# Only the local Mac writes the real database; demo runs on Cloud Run write to the instance's
# copy, which a new revision or a restart replaces with the snapshot again.
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY web web
RUN npm -w web run build && npm prune --omit=dev

FROM node:26-slim
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/web/dist web/dist
COPY package.json ./
COPY server server
COPY data/snapshot/vouch.db data/vouch.db
WORKDIR /app/server
CMD ["node", "src/server.ts"]
