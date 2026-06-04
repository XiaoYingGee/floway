import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { serve } from '@hono/node-server';

import { SqliteImageCache } from './image/sqlite-kv.ts';
import { SharpImageProcessor } from './image/sharp-processor.ts';
import { ENV_FILE, WEB_DIST } from './paths.ts';
import { openDatabase, resolveDbPath } from './repo/db.ts';
import { runMigrations } from './repo/migrate.ts';
import { SqliteD1 } from './repo/sqlite-d1.ts';
import { FsFileProvider } from './runtime/fs-file-provider.ts';
import { buildRootApp } from './static.ts';
// Upstream (apps/api) modules, reached by relative path so this package never
// edits the forked tree. These are the exact injection points entry-cloudflare.ts
// uses; we feed them server-native implementations instead of CF bindings.
import { app } from '../../api/src/app.ts';
import { initImageProcessor } from '../../api/src/image/index.ts';
import { D1Repo } from '../../api/src/repo/d1.ts';
import { getRepo, initRepo } from '../../api/src/repo/index.ts';
import { RESPONSES_ITEM_PAYLOAD_TTL_MS, startOfUtcHour, sweepExpiredResponsesItemPayloadFiles } from '../../api/src/repo/responses-payload.ts';
import { initEnv } from '../../api/src/runtime/env.ts';
import { initFileProvider } from '../../api/src/runtime/file-provider.ts';

// Matches entry-cloudflare.ts: responses rows are referenceable until the
// sweeper removes them; the row TTL only bounds storage.
const RESPONSES_ITEM_ROW_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Best-effort load of apps/server/.env (Node ≥20.12). Real env vars always win
// because loadEnvFile does not overwrite already-set keys.
const loadDotEnv = (): void => {
  if (existsSync(ENV_FILE)) {
    try {
      process.loadEnvFile(ENV_FILE);
    } catch {
      // Older Node without loadEnvFile, or unreadable file: rely on real env.
    }
  }
};

const runScheduledCleanup = async (imageCache: SqliteImageCache): Promise<void> => {
  const now = startOfUtcHour(Date.now());
  await getRepo().responsesItems.clearPayloadOlderThan(now - RESPONSES_ITEM_PAYLOAD_TTL_MS);
  await sweepExpiredResponsesItemPayloadFiles(now);
  await getRepo().responsesSnapshots.deleteOlderThan(now - RESPONSES_ITEM_ROW_TTL_MS);
  await getRepo().responsesItems.deleteOlderThan(now - RESPONSES_ITEM_ROW_TTL_MS);
  imageCache.pruneExpired(Date.now());
};

const main = (): void => {
  loadDotEnv();

  const dataDir = process.env.DATA_DIR?.trim() || './data';
  const port = Number(process.env.PORT) || 8788;
  const webDist = WEB_DIST;

  // 1) Open SQLite and apply the apps/api migrations before anything reads it.
  const db = openDatabase();
  const applied = runMigrations(db);
  if (applied.length > 0) console.log(`Applied ${applied.length} migration(s).`);

  // 2) Wire every runtime interface to a server-native implementation —
  // the Node analogue of entry-cloudflare.ts's initRuntime().
  initEnv(name => process.env[name] ?? '');
  initRepo(new D1Repo(new SqliteD1(db)));
  initFileProvider(new FsFileProvider(resolve(dataDir, 'files')));
  const imageCache = new SqliteImageCache(db);
  initImageProcessor(new SharpImageProcessor(imageCache));

  if (!process.env.ADMIN_KEY) {
    console.warn('WARNING: ADMIN_KEY is not set — the dashboard/control plane will reject all admin logins.');
  }

  // 3) Replicate the Cron Trigger: run the cleanup hourly (and once at boot).
  void runScheduledCleanup(imageCache).catch(err => console.error('Scheduled cleanup failed:', err));
  setInterval(() => {
    void runScheduledCleanup(imageCache).catch(err => console.error('Scheduled cleanup failed:', err));
  }, HOUR_MS);

  // 4) Serve API (delegated to the upstream app) + the built web console.
  const root = buildRootApp(app, webDist);
  serve({ fetch: root.fetch, port }, info => {
    console.log(`Floway server listening on http://localhost:${info.port}`);
    console.log(`  SQLite : ${resolveDbPath()}`);
    console.log(`  Files  : ${resolve(dataDir, 'files')}`);
    console.log(`  Web    : ${existsSync(webDist) ? webDist : webDist + ' (missing — run `pnpm build:web`)'}`);
  });
};

main();
