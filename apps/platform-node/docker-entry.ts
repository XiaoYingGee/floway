import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';

import { bootstrapNodePlatform } from './src/bootstrap.ts';
import { applyMigrations } from './src/migrate.ts';
import {
  app,
  initBackgroundSchedulerResolver,
  initRepo,
  runScheduledMaintenance,
  SqlRepo,
} from '@floway-dev/gateway';

initBackgroundSchedulerResolver(_c => promise => {
  promise.catch(err => console.error('[background]', err));
});

const dbPath = process.env.FLOWAY_DB_PATH ?? '/data/floway/floway.db';
const filesDir = process.env.FLOWAY_FILES_DIR ?? '/data/floway/files';
const port = Number(process.env.PORT ?? 8788);

const { db } = bootstrapNodePlatform({ dbPath, filesDir });
await applyMigrations(db);
initRepo(new SqlRepo(db));

const SCHEDULED_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;
const sweep = (): void => {
  runScheduledMaintenance().catch(err => console.error('[scheduled]', err));
};
setTimeout(sweep, STARTUP_DELAY_MS).unref();
setInterval(sweep, SCHEDULED_INTERVAL_MS).unref();

const isWorkerPath = (p: string): boolean =>
  p === '/favicon.ico'
  || p.startsWith('/api/')
  || p === '/auth' || p.startsWith('/auth/')
  || p.startsWith('/v1/') || p.startsWith('/v1beta/')
  || p.startsWith('/chat/')
  || p === '/responses'
  || p === '/messages' || p.startsWith('/messages/')
  || p === '/embeddings'
  || p.startsWith('/images/')
  || p === '/models'
  || p.startsWith('/azure-api.codex/');

const root = new Hono();

root.all('*', async (c, next) => {
  if (!isWorkerPath(c.req.path)) return next();

  if (
    c.req.method === 'GET'
    && c.req.header('upgrade')?.toLowerCase() === 'websocket'
  ) {
    return c.json(
      { error: { message: 'WebSocket transport is not supported by the self-hosted server.', type: 'not_implemented', code: 'websocket_unsupported' } },
      501,
    );
  }

  return app.fetch(c.req.raw);
});

root.use('*', serveStatic({ root: '../web/dist' }));
root.get('*', serveStatic({ root: '../web/dist', path: 'index.html' }));

serve({ fetch: root.fetch, port }, info => {
  console.log(`floway listening on http://localhost:${info.port}`);
});
