# @floway-dev/server — self-hosted Node runtime

A drop-in **server deployment** of Floway that runs on any Node host instead of
Cloudflare Workers. It does **not modify** the forked upstream code in
`apps/api` / `apps/web`. Instead it provides a parallel entry point
(`src/entry.ts`) that injects server-native implementations into the exact same
runtime interfaces that `apps/api/entry-cloudflare.ts` injects Cloudflare
bindings into.

## How it stays merge-safe with upstream

Every Cloudflare dependency in `apps/api` sits behind an interface with a global
`init*()` injector. The business code only ever calls `getRepo()`,
`getFileProvider()`, `getImageProcessor()`, `getEnv()` — it never touches a
binding directly. This package only **adds files**; it edits nothing upstream
and reaches `apps/api` internals by relative path (`../../api/src/...`), which
sidesteps that package's `exports` map. So `git pull` on the upstream fork never
conflicts with this folder.

| Cloudflare binding | Interface (apps/api) | Server implementation |
| --- | --- | --- |
| D1 (`DB`) | `D1Database` → `D1Repo` | `better-sqlite3` (`src/repo/sqlite-d1.ts`) |
| R2 (`FILES`) | `FileProvider` | local filesystem (`src/runtime/fs-file-provider.ts`) |
| Images (`IMAGES`) | `ImageProcessor` | `sharp` (`src/image/sharp-processor.ts`) |
| KV (`KV`) | image cache get/put | SQLite table (`src/image/sqlite-kv.ts`) |
| Cron trigger | `scheduled()` | hourly `setInterval` (`src/entry.ts`) |
| env vars | `getEnv()` | `process.env` |

The upstream D1 migrations in `apps/api/migrations/*.sql` are applied verbatim
(D1 is SQLite), tracked in a `_server_migrations` table.

## Quick start (local)

```bash
# from the repo root
pnpm install
pnpm --filter @floway-dev/web run build       # produce apps/web/dist

cp apps/server/.env.example apps/server/.env   # set ADMIN_KEY at minimum
pnpm --filter @floway-dev/server run build      # bundle the server (esbuild)
pnpm --filter @floway-dev/server start          # start on http://localhost:8788
```

The server **auto-applies migrations on boot**, so no separate migrate step is
required. To apply schema separately (ops workflows) run
`pnpm --filter @floway-dev/server migrate` after a build. `pnpm dev` rebuilds
and starts in one step.

> Native modules: if `pnpm install` reports "Ignored build scripts" for
> `better-sqlite3`/`sharp`, run `pnpm rebuild better-sqlite3 sharp` (or
> `pnpm approve-builds`) so their prebuilt binaries are installed.

Open `http://localhost:8788/`, log in with `ADMIN_KEY`, complete the GitHub
device-flow login, create an API key, then point any OpenAI/Anthropic/Gemini
client at the same origin (e.g. `POST /v1/chat/completions`).

## Why a bundle step

The server is bundled with **esbuild** before running — the same bundler
wrangler uses for the Worker. A single bundle pass over `apps/api` resolves
CJS/ESM named-import interop (e.g. `import { buf } from 'crc-32'`) that raw Node
ESM rejects, so the unmodified upstream code runs identically off Cloudflare.
`better-sqlite3` and `sharp` are kept external so their native binaries load at
runtime.

## Configuration

See `.env.example`. Key variables:

- `ADMIN_KEY` — protects the dashboard/control plane (required).
- `PORT` — HTTP port (default `8788`).
- `DATA_DIR` — holds `floway.db` and spilled payload files (default `./data`).
- `DB_PATH` — override the SQLite file location (default `<DATA_DIR>/floway.db`).
- `RUNTIME_LOCATION` — label shown in performance telemetry.

## Docker

Build from the **repo root** (the image needs the whole monorepo); the
Dockerfile and its ignore file live in this folder.

### Compose (recommended)

```bash
cd apps/server
ADMIN_KEY=your-secret docker compose up -d --build
docker compose logs -f      # follow logs
docker compose down         # stop; named volume (data) is kept
```

### Plain docker

```bash
docker build -f apps/server/Dockerfile -t floway .
docker run -d --name floway \
  -e ADMIN_KEY=your-secret \
  -p 8788:8788 \
  -v /data/floway:/data/floway \
  floway
```

### What gets mounted — files vs logs

`/data` is a **shared host root across projects**, so Floway is namespaced under
`/data/floway` (the in-image default `DATA_DIR=/data/floway`). Never mount the
bare `/data`.

- **Files (persistent state) → bind-mount the host's `/data/floway`.** Everything
  stateful lives under it:
  - `/data/floway/floway.db` (+ `-wal` / `-shm` sidecars) — the SQLite database.
  - `/data/floway/files/…` — spilled responses payloads (the R2 replacement).

  Because it's a host bind mount, the data sits alongside other projects under
  `/data` and survives `down`/restarts. Override the host path with
  `FLOWAY_DATA=/somewhere docker compose up`. Back up by copying
  `/data/floway/floway.db*` or `sqlite3 floway.db ".backup"`.

- **Logs → container stdout/stderr, not a mounted file.** The app logs to
  stdout/stderr (request logging + startup/cleanup lines), captured by Docker's
  logging driver. Read them with `docker compose logs -f` / `docker logs -f
  floway`. The compose file enables `json-file` rotation (10 MB × 3). If you
  want logs as a host file, either redirect (`docker logs floway > floway.log`)
  or point Docker at a different logging driver — no app change needed.

The container also defines a `HEALTHCHECK` hitting `/api/health`, so
`docker ps` shows health status.

## Notes

- `better-sqlite3` and `sharp` ship prebuilt native binaries for common
  platforms; no build toolchain is needed in the normal case.
- The SQLite database uses WAL mode. For backups, copy `floway.db` plus its
  `-wal`/`-shm` sidecars, or use `sqlite3 .backup`.
- To swap storage later (S3 for files, Postgres, Redis cache), implement the
  same interface and change one line in `src/entry.ts` — no business code moves.
