import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import type { FileProvider } from '../../../api/src/runtime/file-provider.ts';

// Disk-backed FileProvider replacing the R2 bucket. Object keys (e.g.
// "responses-items/v1/expires/<bucket>/<id>") map 1:1 to files under
// <root>/<key>. Keys are produced internally by apps/api, never by clients,
// but we still confine every resolved path to the root as defence in depth.
export class FsFileProvider implements FileProvider {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    const full = resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`Refusing file key escaping storage root: ${key}`);
    }
    return full;
  }

  // Convert an absolute file path back to its forward-slash storage key so
  // prefix matching is OS-independent (forward slashes on Windows too).
  private keyFor(path: string): string {
    return relative(this.root, path).split(sep).join('/');
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of await this.listKeys(prefix)) {
      await rm(this.pathFor(key), { force: true });
    }
  }

  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    await this.walk(this.root, key => {
      if (key.startsWith(prefix)) keys.push(key);
    });
    return keys;
  }

  private async walk(dir: string, visit: (key: string) => void): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(path, visit);
      } else {
        visit(this.keyFor(path));
      }
    }
  }
}
