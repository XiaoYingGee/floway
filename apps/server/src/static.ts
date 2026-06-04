import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { Hono } from 'hono';

import type { ExecutionContext, Hono as HonoApp } from 'hono';

// Replicates wrangler.example.jsonc's `run_worker_first` list: the exact set of
// paths the Worker handles. Everything else is a static asset / SPA route. We
// must gate on this because apps/api's authMiddleware runs on '*' and would
// 401 any unknown path — so static requests must never enter `app`.
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
  || p === '/models';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const contentTypeFor = (path: string): string =>
  CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

// Build the outer server: API paths delegate to the unchanged upstream `app`
// (preserving its middleware + executionCtx), all other GETs serve the built
// Vue SPA from webDist with index.html fallback for client-side routes —
// mirroring wrangler's `not_found_handling: single-page-application`.
export const buildRootApp = (app: HonoApp, webDist: string): Hono => {
  const root = new Hono();
  const distRoot = resolve(webDist);

  const readAsset = async (path: string): Promise<Uint8Array | null> => {
    const full = resolve(distRoot, '.' + normalize('/' + path));
    if (full !== distRoot && !full.startsWith(distRoot + sep)) return null; // traversal guard
    try {
      if (!(await stat(full)).isFile()) return null;
      return new Uint8Array(await readFile(full));
    } catch {
      return null;
    }
  };

  // 1) Worker paths → upstream app, untouched. Pass the original Request and the
  // node-server executionCtx so background waitUntil work keeps functioning.
  root.all('*', async (c, next) => {
    if (!isWorkerPath(c.req.path)) return next();
    // The upstream Responses endpoint registers GET WebSocket upgrades that rely
    // on Cloudflare's `WebSocketPair` / `Response{webSocket}` runtime API, which
    // does not exist under @hono/node-server. Forwarding such a request would
    // throw `ReferenceError: WebSocketPair is not defined` deep in the handler
    // and surface as an opaque 500. Reject it cleanly instead: this transport is
    // simply unsupported in the self-hosted Node build.
    if (
      c.req.method === 'GET'
      && c.req.header('upgrade')?.toLowerCase() === 'websocket'
      && (c.req.path === '/responses' || c.req.path === '/v1/responses')
    ) {
      return c.json(
        { error: { message: 'WebSocket transport is not supported by the self-hosted server; use the POST /responses HTTP endpoint.', type: 'not_implemented', code: 'websocket_unsupported' } },
        501,
      );
    }
    let executionCtx: ExecutionContext | undefined;
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = undefined;
    }
    return app.fetch(c.req.raw, undefined, executionCtx);
  });

  // 2) Static assets, then 3) SPA fallback to index.html for any other GET.
  root.get('*', async c => {
    const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
    const asset = await readAsset(reqPath);
    if (asset) {
      return c.body(asset as unknown as ArrayBuffer, 200, { 'Content-Type': contentTypeFor(reqPath) });
    }
    const indexHtml = await readAsset('/index.html');
    if (indexHtml) {
      return c.body(indexHtml as unknown as ArrayBuffer, 200, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    return c.text('Web assets not found. Run `pnpm build:web` first.', 404);
  });

  return root;
};
