import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('release packaging creates a versioned archive and matching checksum without overwriting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'release-test-'));
  try {
    const script = resolve('scripts/package-release.sh');
    const run = () => spawnSync('/bin/sh', [script, '0.1.0', dir], { encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const name = 'local-deploy-0.1.0.tar.gz';
    const data = await readFile(join(dir, name));
    const digest = createHash('sha256').update(data).digest('hex');
    assert.equal((await readFile(join(dir, `${name}.sha256`), 'utf8')).trim(), `${digest}  ${name}`);
    const contents = spawnSync('tar', ['-tzf', join(dir, name)], { encoding: 'utf8' });
    assert.equal(contents.status, 0);
    assert.match(contents.stdout, /start\.sh/);
    assert.match(contents.stdout, /local-service\/dashboard\/index\.html/);
    assert.match(contents.stdout, /cloud\/publish\.mjs/);
    assert.match(contents.stdout, /cloud\/hosting\.yaml/);
    assert.notEqual(run().status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
