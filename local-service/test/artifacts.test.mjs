import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateArtifacts } from '../artifacts.mjs';

test('validates a static output and rejects symlinks and oversized output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifacts-test-'));
  try {
    await writeFile(join(root, 'index.html'), 'hello');
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'app.js'), 'js');
    assert.deepEqual(await validateArtifacts(root, { maxBytes: 20, maxFiles: 3 }), { bytes: 7, files: 2 });
    await assert.rejects(validateArtifacts(root, { maxBytes: 6, maxFiles: 3 }), /size/i);
    await assert.rejects(validateArtifacts(root, { maxBytes: 20, maxFiles: 1 }), /files/i);
    await symlink('/etc/passwd', join(root, 'escape'));
    await assert.rejects(validateArtifacts(root, { maxBytes: 100, maxFiles: 5 }), /symlink/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('requires an index.html entry point', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifacts-test-'));
  try { await assert.rejects(validateArtifacts(root, { maxBytes: 20, maxFiles: 3 }), /index.html/i); }
  finally { await rm(root, { recursive: true, force: true }); }
});
