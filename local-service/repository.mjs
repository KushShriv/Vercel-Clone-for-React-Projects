// Accept only a canonical repository address, never a Git option or arbitrary host.
export function parseRepositoryUrl(value) {
  if (typeof value !== 'string') throw new TypeError('Expected a GitHub repository URL');
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,99})$/.exec(value);
  if (!match || match[1].endsWith('-') || match[1].includes('--') || match[2] === '.' || match[2] === '..') {
    throw new Error('Expected https://github.com/<owner>/<repository>');
  }
  const repo = match[2].endsWith('.git') ? match[2].slice(0, -4) : match[2];
  if (!repo || repo === '.' || repo === '..') throw new Error('Invalid repository name');
  return `https://github.com/${match[1]}/${repo}.git`;
}
