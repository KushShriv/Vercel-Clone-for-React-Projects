import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Call only after the worker has stopped and the output is no longer writable by it.
export async function validateArtifacts(root, { maxBytes, maxFiles }) {
  let bytes = 0;
  let files = 0;
  const entry = await lstat(join(root, 'index.html')).catch(() => null);
  if (!entry?.isFile()) throw new Error('Output requires a regular index.html');
  async function visit(dir) {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Output contains a symlink');
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        files++;
        bytes += info.size;
        if (files > maxFiles) throw new Error('Output has too many files');
        if (bytes > maxBytes) throw new Error('Output exceeds size limit');
      } else throw new Error('Output contains a non-regular file');
    }
  }
  await visit(root);
  return { bytes, files };
}
