# Multi-stage build for Coolify (or any Docker host).
# NOTE: for the subscription backend, the `ant` OAuth profile must be available
# at runtime. Mount it as a volume (see README → Coolify) — do NOT bake it into
# the image. The API-key backend needs no such mount.
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
