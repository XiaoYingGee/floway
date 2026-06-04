import { build } from 'esbuild';

// Bundle the server the same way wrangler bundles the Worker: a single esbuild
// pass over the entry points pulls in all of apps/api and resolves every
// CJS/ESM named-import interop quirk (e.g. `import { buf } from 'crc-32'`) that
// raw Node ESM rejects. Native addons are kept external so their .node binaries
// load at runtime instead of being (impossibly) bundled.
await build({
  // Flat output (dist/entry.js, dist/migrate.js) so both bundles sit exactly
  // one level under the package root — see src/paths.ts for why that matters.
  entryPoints: [
    { in: 'src/entry.ts', out: 'entry' },
    { in: 'src/repo/cli-migrate.ts', out: 'migrate' },
  ],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['better-sqlite3', 'sharp'],
  // Bundled CJS dependencies may call require(); define it for the ESM output.
  banner: { js: "import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);" },
  logLevel: 'info',
});
