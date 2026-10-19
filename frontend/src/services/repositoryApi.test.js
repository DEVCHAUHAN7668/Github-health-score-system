import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRepository, parseRepositoryUrl } from './repositoryApi.js';

const successfulData = { repository: { name: 'repo' }, health: { overallScore: 73, status: 'Moderate' } };

test('analyzeRepository posts the URL to the backend and returns its real analysis data', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: successfulData }) };
  };
  assert.deepEqual(await analyzeRepository('https://github.com/facebook/react'), successfulData);
  assert.equal(request.url, '/api/repository/analyze');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { url: 'https://github.com/facebook/react' });
});

test('analysis preserves backend error status, code, message, and retry time', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => JSON.stringify({ success: false, error: {
    code: 'GITHUB_RATE_LIMITED', message: 'Retry after reset.', retryAt: '2026-10-20T00:00:00.000Z', limitType: 'primary_unauthenticated',
  } }) });
  await assert.rejects(analyzeRepository('https://github.com/facebook/react'), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'GITHUB_RATE_LIMITED');
    assert.equal(error.message, 'Retry after reset.');
    assert.equal(error.retryAt, '2026-10-20T00:00:00.000Z');
    assert.equal(error.limitType, 'primary_unauthenticated');
    return true;
  });
});

test('analysis preserves the backend network cause code for actionable diagnostics', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => JSON.stringify({ success: false, error: {
    code: 'GITHUB_DNS_ERROR', message: 'Could not resolve GitHub.', causeCode: 'ENOTFOUND',
  } }) });
  await assert.rejects(analyzeRepository('https://github.com/facebook/react'), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.code, 'GITHUB_DNS_ERROR');
    assert.equal(error.causeCode, 'ENOTFOUND');
    assert.equal(error.message, 'Could not resolve GitHub.');
    return true;
  });
});

test('analysis surfaces backend network failures and malformed success responses', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  await assert.rejects(analyzeRepository('https://github.com/facebook/react'), { code: 'BACKEND_UNREACHABLE' });
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: {} }) });
  await assert.rejects(analyzeRepository('https://github.com/facebook/react'), { code: 'INVALID_ANALYSIS_RESPONSE', status: 200 });
});

test('identifies the empty text response produced when the Vite proxy cannot connect', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    headers: new Headers({ 'content-type': 'text/plain' }),
    text: async () => '',
  });
  await assert.rejects(analyzeRepository('https://github.com/facebook/react'), (error) => {
    assert.equal(error.status, 500);
    assert.equal(error.code, 'BACKEND_UNREACHABLE');
    assert.match(error.message, /127\.0\.0\.1:5000/);
    return true;
  });
});

test('reports non-JSON backend errors without exposing an HTML stack trace', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    headers: new Headers({ 'content-type': 'text/html' }),
    text: async () => '<html><body>secret stack trace</body></html>',
  });
  await assert.rejects(analyzeRepository('https://github.com/facebook/react'), (error) => {
    assert.equal(error.status, 500);
    assert.equal(error.code, 'NON_JSON_BACKEND_RESPONSE');
    assert.match(error.message, /Check the backend terminal/);
    assert.equal(error.message.includes('secret stack trace'), false);
    return true;
  });
});

test('parseRepositoryUrl accepts a public repository URL and rejects unrelated domains', () => {
  assert.deepEqual(parseRepositoryUrl('https://github.com/facebook/react'), { owner: 'facebook', repository: 'react' });
  assert.equal(parseRepositoryUrl('https://example.com/facebook/react'), null);
});
