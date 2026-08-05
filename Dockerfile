# Multi-stage build for Coolify (or any Docker host).
# NOTE: the subscription backend just needs CLAUDE_CODE_OAUTH_TOKEN as an env/secret
# — no volume or profile mount. The API-key backend needs ANTHROPIC_API_KEY.
# The usage dashboard's SQLite DB (./data) is ephemeral in a container; mount a
# volume at /app/data (or set METRICS_DB) if you want usage history to persist.
# better-sqlite3 installs a prebuilt binary on common linux archs; on exotic archs
# add build tooling (apt-get install -y python3 make g++) before npm install.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# `ant` CLI is only needed for the subscription backend; install if you use it.
# (For the api backend you can delete the next line.)
# RUN <install ant here for your platform>
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["node", "dist/server.js"]
