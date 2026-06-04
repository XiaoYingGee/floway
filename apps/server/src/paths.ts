import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolves sibling-package locations in a way that survives esbuild bundling.
// This module sits exactly one level under the package root in BOTH layouts:
//   - source:  apps/server/src/paths.ts
//   - bundle:  apps/server/dist/{entry,migrate}.js  (esbuild inlines this file;
//              its import.meta.url becomes the bundle's, kept flat at dist root)
// so PACKAGE_ROOT is stable regardless of how the code is run.
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Upstream apps/api migrations (applied verbatim — D1 is SQLite).
export const MIGRATIONS_DIR = resolve(PACKAGE_ROOT, '../api/migrations');

// Built Vue console (apps/web/dist), served as static assets + SPA fallback.
export const WEB_DIST = resolve(PACKAGE_ROOT, '../web/dist');

// apps/server/.env, loaded best-effort at startup.
export const ENV_FILE = resolve(PACKAGE_ROOT, '.env');
