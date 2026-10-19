import test from 'node:test';
import assert from 'node:assert/strict';
import { InvalidRepositoryUrlError, parseRepositoryUrl } from '../src/utils/repositoryUrl.js';

test('parses a GitHub repository URL and strips a .git suffix', () => {
  assert.deepEqual(parseRepositoryUrl('https://github.com/octocat/Hello-World.git'), { owner: 'octocat', repo: 'Hello-World' });
});

test('parses a standard GitHub URL with an optional trailing slash', () => {
  assert.deepEqual(parseRepositoryUrl('https://github.com/facebook/react'), { owner: 'facebook', repo: 'react' });
  assert.deepEqual(parseRepositoryUrl('https://github.com/facebook/react/'), { owner: 'facebook', repo: 'react' });
});

test('rejects non-GitHub URLs, extra paths, and malformed input', () => {
  for (const value of ['not a URL', 'https://example.com/a/b', 'http://github.com/a/b', 'https://github.com/a/b/tree/main', 'https://user@github.com/a/b', 'https://github.com/a/%E0%A4%A']) {
    assert.throws(() => parseRepositoryUrl(value), InvalidRepositoryUrlError);
  }
});

test('requires a non-empty string', () => {
  assert.throws(() => parseRepositoryUrl(null), InvalidRepositoryUrlError);
  assert.throws(() => parseRepositoryUrl(' '), InvalidRepositoryUrlError);
});
