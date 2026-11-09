# syntax=docker/dockerfile:1
#
# Expenses Tracker — the app image (Next.js standalone server). It needs a PostgreSQL database: set DATABASE_URL
# (postgres://user:password@host:5432/dbname). The Compose files in this repository start Postgres alongside it.
#
#   docker build -t expenses-tracker .
#   docker run -d -p 3000:3000 -e DATABASE_URL=postgres://... expenses-tracker
#
# Pure JavaScript, so one build works for linux/amd64 and linux/arm64 (buildx --platform linux/amd64,linux/arm64).

ARG NODE_IMAGE=node:24-bookworm-slim

# ---- deps: install node_modules from the lockfile only (cached until package*.json change) ----------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency needs an install script for the build (esbuild's postinstall is only used by
# dev tools), so the slim image needs no compiler toolchain.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --ignore-scripts

# ---- build: next build -> .next/standalone ----------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build \
 # Next's standard standalone step: static assets and public/ are not part of the traced output.
 && cp -r .next/static .next/standalone/.next/static \
 && cp -r public .next/standalone/public \
 # Migrations are traced in by outputFileTracingIncludes; copy them explicitly so the image never depends on it.
 && rm -rf .next/standalone/drizzle && cp -r drizzle .next/standalone/drizzle

# ---- runner: only the standalone server, as a non-root user ----------------------------------------------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    MIGRATIONS_DIR=/app/drizzle

# The base image ships a `node` user (uid/gid 1000). No DATABASE_URL here: the app requires it in production.
COPY --from=build --chown=node:node /app/.next/standalone ./

USER node
EXPOSE 3000

# No curl/wget in the image: use Node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server.js"]
