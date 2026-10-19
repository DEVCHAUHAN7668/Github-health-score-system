import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import app, { errorHandler } from '../src/app.js';
import { GitHubApiError } from '../src/services/githubService.js';

test('health endpoint returns HTTP 200', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
});

test('malformed JSON receives a structured HTTP 400 error', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/repository/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{broken',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    success: false,
    error: { code: 'INVALID_JSON', message: 'Request body must contain valid JSON.' },
  });
});

test('unknown API paths return a JSON 404 response', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/not-a-route`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), {
    success: false,
    error: { code: 'API_ROUTE_NOT_FOUND', message: 'API route not found.' },
  });
});

test('rate-limit errors include upstream status and retry metadata in the HTTP response', async (t) => {
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  const testApp = express();
  testApp.get('/rate-limited', (_request, _response, next) => next(new GitHubApiError(
    `GitHub primary API rate limit reached. Retry after ${retryAt}.`,
    429,
    'GITHUB_RATE_LIMITED',
    {
      upstreamStatus: 403,
      limitType: 'primary',
      rateLimit: { limit: 60, remaining: 0, resetAt: retryAt, retryAfter: null, retryAt },
    },
  )));
  testApp.use(errorHandler);
  const server = testApp.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/rate-limited`);
  const body = await response.json();
  assert.equal(response.status, 429);
  assert.equal(body.error.code, 'GITHUB_RATE_LIMITED');
  assert.equal(body.error.upstreamStatus, 403);
  assert.equal(body.error.limitType, 'primary');
  assert.equal(body.error.rateLimit.remaining, 0);
  assert.equal(body.error.retryAt, retryAt);
});

test('exposes safe GitHub network diagnostics while keeping unexpected server errors generic', async () => {
  const githubError = new GitHubApiError('Check DNS and network settings.', 502, 'GITHUB_DNS_ERROR', { causeCode: 'ENOTFOUND' });
  const response = { status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  errorHandler(githubError, {}, response, () => {});
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.body.error, {
    code: 'GITHUB_DNS_ERROR', message: 'Check DNS and network settings.', causeCode: 'ENOTFOUND',
  });

  const unexpected = { status: 500, code: 'INTERNAL_SERVER_ERROR', message: 'secret internal detail' };
  const genericResponse = { status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  errorHandler(unexpected, {}, genericResponse, () => {});
  assert.equal(genericResponse.body.error.message, 'An unexpected server error occurred.');
});
