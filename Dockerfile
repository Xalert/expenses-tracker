# syntax=docker/dockerfile:1
#
# Expenses Tracker — self-contained image (Next.js standalone server + SQLite).
#
#   docker build -t expenses-tracker .
#   docker run -d -p 3000:3000 -v expenses-data:/data expenses-tracker
#
# Builds natively for linux/amd64 and linux/arm64. The image must be built for the platform it runs on:
# better-sqlite3 is a native module and the copy traced into the standalone output is the one installed here.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---- deps: install node_modules from the lockfile only (cached until package*.json change) ----------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
# --ignore-scripts: better-sqlite3 ships prebuilt binaries for linux-x64/arm64 (glibc and musl) inside the npm
# package, but npm still runs an implicit `node-gyp rebuild` for its binding.gyp, which needs python3/make/g++.
# No other dependency needs an install script for the build (esbuild's postinstall is only used by dev tools).
# The second command fails the build early if the native module cannot load on this platform.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --ignore-scripts \
 && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()"

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
 && rm -rf .next/standalone/drizzle && cp -r drizzle .next/standalone/drizzle \
 # better-sqlite3 bundles prebuilt binaries for every OS; the image only needs the Linux ones.
 && find .next/standalone/node_modules/better-sqlite3/prebuilds -type f ! -name 'linux*' -delete

# ---- runner: only the standalone server, as a non-root user ----------------------------------------------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATABASE_URL=/data/app.db \
    MIGRATIONS_DIR=/app/drizzle

# The base image ships a `node` user (uid/gid 1000). /data holds the SQLite file (+ -wal/-shm).
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/.next/standalone ./

USER node
VOLUME ["/data"]
EXPOSE 3000

# No curl/wget in the image: use Node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server.js"]
