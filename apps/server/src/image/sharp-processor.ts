import { createHash } from 'node:crypto';

import sharp from 'sharp';

import type { SqliteImageCache } from './sqlite-kv.ts';
import type { ImageDimensions, ImageProcessor, ImageSizeCalculator } from '../../../api/src/image/types.ts';

// These mirror the constants in apps/api/src/image/cloudflare.ts so the
// self-hosted encode path is behaviourally identical to the Cloudflare one:
// same WebP quality, same content-addressed cache key, same 30-day TTL.
const WEBP_QUALITY = 82;
const CACHE_KEY_PREFIX = 'imgwebp';
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

// Server-native ImageProcessor: sharp replaces the Cloudflare Images binding,
// a SQLite table replaces the KV cache. The cache-key scheme is copied exactly
// from the Cloudflare processor so a changed quality or per-model target size
// can never serve a stale result.
export class SharpImageProcessor implements ImageProcessor {
  // `now` is injected as a thunk so tests can pin time; defaults to wall clock.
  constructor(
    private readonly cache: SqliteImageCache,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async compressToWebp(input: Uint8Array, targetSize: ImageSizeCalculator): Promise<Uint8Array> {
    // Resize only when sharp can read the source dimensions; undecodable-as-
    // metadata bytes are still re-encoded to WebP without a resize, matching
    // the Cloudflare path's behaviour.
    let target: ImageDimensions | null = null;
    try {
      const { width, height } = await sharp(input).metadata();
      if (width !== undefined && height !== undefined) target = targetSize({ width, height });
    } catch {
      target = null;
    }

    const targetKey = target ? `${target.width}x${target.height}` : 'orig';
    const key = `${CACHE_KEY_PREFIX}:${sha256Hex(input)}:${targetKey}:webp:q${WEBP_QUALITY}`;

    const now = this.now();
    const cached = this.cache.get(key, now);
    if (cached) return cached;

    let pipeline = sharp(input);
    if (target) {
      // fit:'inside' + withoutEnlargement === Cloudflare's 'scale-down': fit
      // within the box, preserve aspect ratio, never upscale past the source.
      pipeline = pipeline.resize({ width: target.width, height: target.height, fit: 'inside', withoutEnlargement: true });
    }
    const output = new Uint8Array(await pipeline.webp({ quality: WEBP_QUALITY }).toBuffer());

    this.cache.put(key, output, CACHE_TTL_SECONDS, now);
    return output;
  }
}
