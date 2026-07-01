// Pre-deploy gate: wrangler.jsonc is gitignored, so the only place we can
// pin its shape is wrangler.example.jsonc. We compare the real config
// against the example structurally — every key/value in the example must
// match the real one exactly, except <YOUR_*> placeholders, which the real
// must override with a concrete value. Real may carry extra keys (e.g.
// account_id, vars) and extra bindings the example doesn't list. The
// runtime also fails fast on missing bindings, but a 503 from a freshly
// published deploy is worse than a non-zero exit before publish.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, type ParseError } from 'jsonc-parser';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE_PATH = resolve(ROOT, 'wrangler.example.jsonc');
const REAL_PATH = resolve(ROOT, 'wrangler.jsonc');

const PLACEHOLDER_RE = /^<YOUR_[A-Z0-9_]+>$/;
const isPlaceholder = (v: unknown): v is string => typeof v === 'string' && PLACEHOLDER_RE.test(v);

interface Mismatch {
  path: string;
  reason: string;
}

const fmt = (v: unknown): string => JSON.stringify(v);

const isBindingArray = (arr: readonly unknown[]): arr is ReadonlyArray<Record<string, unknown>> =>
  arr.length > 0 && arr.every(
    e => typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>).binding === 'string',
  );

const compare = (expected: unknown, actual: unknown, path: string, out: Mismatch[]): void => {
  if (isPlaceholder(expected)) {
    if (typeof actual !== 'string' || actual.length === 0 || isPlaceholder(actual)) {
      out.push({ path, reason: `placeholder ${expected} must be replaced with a concrete value, got ${fmt(actual)}` });
    }
    return;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push({ path, reason: `expected array, got ${fmt(actual)}` });
      return;
    }
    // Bindings (d1_databases, r2_buckets, kv_namespaces, ...) are identified
    // by their `binding` name, not array position. Match each example entry
    // to the real entry with the same binding; real may carry extras the
    // example doesn't pin.
    if (isBindingArray(expected)) {
      for (const exp of expected) {
        const name = exp.binding as string;
        const match = actual.find(
          (a): a is Record<string, unknown> =>
            typeof a === 'object' && a !== null && (a as Record<string, unknown>).binding === name,
        );
        if (match === undefined) {
          out.push({ path: `${path}[binding=${name}]`, reason: 'binding entry missing' });
          continue;
        }
        compare(exp, match, `${path}[binding=${name}]`, out);
      }
      return;
    }
    if (expected.length !== actual.length) {
      out.push({ path, reason: `expected array of length ${expected.length}, got ${actual.length}` });
      return;
    }
    expected.forEach((v, i) => compare(v, actual[i], `${path}[${i}]`, out));
    return;
  }

  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      out.push({ path, reason: `expected object, got ${fmt(actual)}` });
      return;
    }
    const actualRecord = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      compare(value, actualRecord[key], path === '' ? key : `${path}.${key}`, out);
    }
    return;
  }

  if (expected !== actual) {
    out.push({ path, reason: `expected ${fmt(expected)}, got ${fmt(actual)}` });
  }
};

const parseJsonc = async (path: string): Promise<unknown> => {
  const text = await readFile(path, 'utf8');
  const errors: ParseError[] = [];
  const value = parse(text, errors);
  if (errors.length > 0) {
    console.error(`Failed to parse ${path}:`);
    for (const e of errors) console.error(`  ${JSON.stringify(e)}`);
    process.exit(1);
  }
  return value;
};

const [example, real] = await Promise.all([parseJsonc(EXAMPLE_PATH), parseJsonc(REAL_PATH)]);
const mismatches: Mismatch[] = [];
compare(example, real, '', mismatches);

if (mismatches.length > 0) {
  console.error('wrangler.jsonc drifted from wrangler.example.jsonc:');
  for (const m of mismatches) console.error(`  - ${m.path}: ${m.reason}`);
  console.error('Mirror wrangler.example.jsonc, filling in every <YOUR_*> placeholder with your own value.');
  process.exit(1);
}
