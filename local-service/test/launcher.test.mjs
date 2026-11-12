import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const launcher = resolve('start.sh');
async function script(path, content) { await writeFile(path, `#!/bin/sh\n${content}\n`); await chmod(path, 0o755); }
test('launcher fails clearly when Docker is missing or unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launcher-test-'));
  try {
    await script(join(dir, 'node'), 'if [ "$1" = "-v" ]; then echo v22.0.0; else echo started; fi');
    const env = { ...process.env, HOME: dir, PATH: `${dir}:/usr/bin:/bin` };
    let result = spawnSync('/bin/sh', [launcher], { encoding: 'utf8', env });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /docker/i);
    await script(join(dir, 'docker'), 'exit 1');
    result = spawnSync('/bin/sh', [launcher], { encoding: 'utf8', env });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /docker/i);
    await script(join(dir, 'docker'), 'exit 0');
    result = spawnSync('/bin/sh', [launcher], { encoding: 'utf8', env });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /started/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('launcher finds a Docker Desktop CLI in the user Applications folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launcher-home-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    const bin = join(dir, 'bin');
    const dockerBin = join(dir, 'Applications/Docker.app/Contents/Resources/bin');
    await mkdir(bin, { recursive: true });
    await mkdir(dockerBin, { recursive: true });
    await script(join(bin, 'node'), 'if [ "$1" = "-v" ]; then echo v22.0.0; else echo started; fi');
    await script(join(dockerBin, 'docker'), 'exit 0');
    const result = spawnSync('/bin/sh', [launcher], { encoding: 'utf8', env: { ...process.env, HOME: dir, PATH: `${bin}:/usr/bin:/bin` } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /started/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
