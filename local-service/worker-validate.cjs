const fs = require('node:fs');
const path = require('node:path');
function loadFile(name) {
  const stat = fs.lstatSync(name);
  if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw Error(`${name} must be a regular file under 10 MiB`);
  return JSON.parse(fs.readFileSync(name, 'utf8'));
}
try {
  const pkg = loadFile('package.json');
  const lock = loadFile('package-lock.json');
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!dependencies.react || !dependencies['react-dom'] || !dependencies.vite || pkg.scripts?.build !== 'vite build') throw Error('Expected React, React DOM, Vite, and the exact build script "vite build"');
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object') throw Error('Expected npm lockfile version 2 or 3');
  for (const [name, item] of Object.entries(lock.packages)) {
    if (item.link || (item.resolved && (typeof item.resolved !== 'string' || !/^https:\/\/registry\.npmjs\.org\/[A-Za-z0-9@%+_.~/-]+\.tgz$/.test(item.resolved)))) throw Error(`Unsupported dependency source: ${name}`);
  }
  // Do not let repository config override registry or introduce extra npm behavior.
  fs.rmSync(path.join(process.cwd(), '.npmrc'), { force: true });
} catch (error) { console.error(`Unsupported repository: ${error.message}`); process.exitCode = 1; }
