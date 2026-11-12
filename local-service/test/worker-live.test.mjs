import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { runWorker, workerContainerArgs } from '../worker.mjs';

// Opt-in: pulls the Docker image and dependencies and contacts GitHub/npm.
const live = process.env.RUN_DOCKER_TESTS === '1';

test('Docker worker applies runtime controls and has no direct network', { skip: !live, timeout: 30000 }, () => {
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
  const name = `vc-test-${randomBytes(6).toString('hex')}`;
  try {
    docker(...workerContainerArgs(name, 'vercel-clone-local-worker:v1'));
    const info = JSON.parse(docker('inspect', name))[0];
    assert.equal(info.Config.User, '1000:1000');
    assert.equal(info.HostConfig.ReadonlyRootfs, true);
    assert.equal(info.HostConfig.Memory, 1024 ** 3);
    assert.equal(info.HostConfig.NanoCpus, 10 ** 9);
    assert.equal(info.HostConfig.PidsLimit, 128);
    assert.equal(info.HostConfig.NetworkMode, 'none');
    assert.deepEqual(info.Mounts, []);
    const probe = "const fs=require('fs'),net=require('net'); console.log('uid='+process.getuid(),'socket='+fs.existsSync('/var/run/docker.sock'));const s=net.connect(443,'1.1.1.1');s.setTimeout(2000,()=>{console.log('network=timeout');s.destroy()});s.on('error',e=>console.log('network='+e.code));s.on('connect',()=>{console.log('network=CONNECTED');s.destroy()})";
    const result = docker('exec', name, 'node', '-e', probe);
    assert.match(result, /uid=1000 socket=false/);
    assert.doesNotMatch(result, /network=CONNECTED/);
  } finally { try { docker('rm', '-f', name); } catch {} }
});

test('Docker worker builds a pinned public React fixture with the preview base', { skip: !live, timeout: 300000 }, async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'vc-live-test-'));
  const commit = '730072fb4865d1a7c71fbdba0d403161914b47e9';
  let actualCommit;
  try {
    await runWorker({ repository: 'https://github.com/amannn/vite-react-starter', revision: commit, outputDir, basePath: '/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/', onCommit: value => { actualCommit = value; } });
    assert.equal(actualCommit, commit);
    assert.ok((await readdir(outputDir)).includes('assets'));
    assert.match(await readFile(join(outputDir, 'index.html'), 'utf8'), /\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\/assets\//);
  } finally { await rm(outputDir, { recursive: true, force: true }); }
});
