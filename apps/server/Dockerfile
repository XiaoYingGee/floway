# Self-hosted Floway server image.
#
# Bundles the server with esbuild (the same bundler wrangler uses for the
# Worker, which resolves CJS/ESM interop across apps/api) and runs the output
# with node. better-sqlite3 and sharp install prebuilt native binaries for
# linux/x64+arm64 on Node 22, so no compiler toolchain is required.
#
# Build from the REPO ROOT (the build needs the whole monorepo):
#   docker build -f apps/server/Dockerfile -t floway .

FROM node:22-slim
WORKDIR /app

RUN corepack enable

COPY . .

# pnpm v10 blocks dependency build scripts unless allow-listed. Inject the
# allow-list into the in-image package.json only (the host repo is never
# touched) so `pnpm install` runs the native postinstalls: better-sqlite3 +
# sharp (server runtime), esbuild (server bundle), vue-demi (web build).
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.pnpm=p.pnpm||{};p.pnpm.onlyBuiltDependencies=Array.from(new Set([...(p.pnpm.onlyBuiltDependencies||[]),'better-sqlite3','sharp','esbuild','vue-demi']));fs.writeFileSync('package.json',JSON.stringify(p,null,2));"

# Install, then build the web console and bundle the server.
RUN pnpm install --no-frozen-lockfile \
  && pnpm --filter @floway-dev/web run build \
  && pnpm --filter @floway-dev/server run build

ENV NODE_ENV=production \
    DATA_DIR=/data/floway \
    PORT=8788

# All persistent state lives here: floway.db (+ -wal/-shm) and spilled payload
# files under /data/floway/files. /data is a shared host root across projects,
# so this project is namespaced under /data/floway. Mount a volume to survive
# container restarts.
VOLUME /data/floway
EXPOSE 8788

# Liveness via the public health endpoint (Node 22 has global fetch).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# ADMIN_KEY must be provided at runtime, e.g.:
#   docker run -e ADMIN_KEY=... -p 8788:8788 -v /data/floway:/data/floway floway
CMD ["node", "apps/server/dist/entry.js"]
