import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { errorHandler } from '../src/app.js';
import { createRepositoryRouter } from '../src/routes/repository.js';

async function startApp(t, router) {
  const app = express();
  app.use(express.json());
  app.use('/api/repository', router);
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}/api/repository/analyze`;
}

test('analyze endpoint returns a scored real analysis response without database persistence', async (t) => {
  let received;
  const endpoint = await startApp(t, createRepositoryRouter({
    analyzeRepository: async (repository) => {
      received = repository;
      return { repository: { fullName: `${repository.owner}/${repository.repo}` } };
    },
    scoreRepository: () => ({ overallScore: 80, status: 'Healthy', categories: [], recommendations: [] }),
  }));
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://github.com/facebook/react' }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(received, { owner: 'facebook', repo: 'react' });
  assert.equal(body.success, true);
  assert.equal(body.data.repository.fullName, 'facebook/react');
  assert.equal(body.data.health.overallScore, 80);
  assert.equal(body.data.metadata.dataSource, 'GitHub REST API');
  assert.equal('historyId' in body.data.metadata, false);
});

test('analyze endpoint retains repositoryUrl field compatibility', async (t) => {
  let received;
  const endpoint = await startApp(t, createRepositoryRouter({
    analyzeRepository: async (repository) => {
      received = repository;
      return { repository: { name: repository.repo, fullName: `${repository.owner}/${repository.repo}`, url: `https://github.com/${repository.owner}/${repository.repo}` }, dataAvailability: { readme: false } };
    },
  }));
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repositoryUrl: 'https://github.com/octocat/Hello-World' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received, { owner: 'octocat', repo: 'Hello-World' });
});

test('rate-limited GitHub analysis is forwarded without returning a successful result', async (t) => {
  const endpoint = await startApp(t, createRepositoryRouter({
    analyzeRepository: async () => {
      const error = new Error('GitHub primary API rate limit reached.');
      error.status = 429;
      error.code = 'GITHUB_RATE_LIMITED';
      error.limitType = 'primary_unauthenticated';
      error.rateLimit = { limit: 60, remaining: 0, retryAt: '2026-10-20T10:00:00.000Z' };
      throw error;
    },
    scoreRepository: () => { throw new Error('A failed analysis must not be scored.'); },
  }));
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://github.com/owner/repo' }),
  });
  const body = await response.json();
  assert.equal(response.status, 429);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'GITHUB_RATE_LIMITED');
});
