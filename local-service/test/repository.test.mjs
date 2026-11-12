import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepositoryUrl } from '../repository.mjs';

test('accepts canonical public GitHub repository URLs', () => {
  assert.equal(parseRepositoryUrl('https://github.com/example/my-app'), 'https://github.com/example/my-app.git');
  assert.equal(parseRepositoryUrl('https://github.com/example/my-app.git'), 'https://github.com/example/my-app.git');
});

test('rejects URLs that are not exact GitHub repository addresses', () => {
  for (const url of ['http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://github.com/a/b/tree/main', 'https://user@github.com/a/b', 'https://github.com/a/b?x=1', 'https://github.com/a/../b', 'https://github.com/a/%2e%2e', 'https://github.com/a/-bad', 'https://github.com/a/b#x', 'https://github.com:443/a/b']) {
    assert.throws(() => parseRepositoryUrl(url), undefined, url);
  }
});
