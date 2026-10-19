import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubService, GitHubApiError } from '../src/services/githubService.js';

function response(status, body = {}, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: { cancel: async () => {} },
    json: async () => body,
    clone() { return { json: async () => body }; },
  };
}

function successfulApiResponse(url) {
  const path = new URL(url).pathname;
  if (path === '/repos/facebook/react') {
    return response(200, {
      id: 123,
      name: 'react',
      full_name: 'facebook/react',
      html_url: 'https://github.com/facebook/react',
      private: false,
      default_branch: 'main',
      stargazers_count: 10,
      forks_count: 2,
      subscribers_count: 3,
      open_issues_count: 4,
      topics: ['javascript'],
    });
  }
  if (path.endsWith('/readme')) return response(200, { name: 'README.md', path: 'README.md', encoding: 'base64', content: Buffer.from('# React').toString('base64') });
  if (path.endsWith('/contents') || path.endsWith('/commits') || path.endsWith('/issues')) return response(200, []);
  if (path.endsWith('/license')) return response(404);
  throw new Error(`Unexpected API endpoint: ${url}`);
}

test('returns structured repository information from successful mocked API responses', async () => {
  const urls = [];
  const service = createGitHubService({ fetchImpl: async (url) => { urls.push(url); return successfulApiResponse(url); }, logger: { error() {} } });
  const result = await service.analyze({ owner: 'facebook', repo: 'react' });
  assert.equal(urls[0], 'https://api.github.com/repos/facebook/react');
  assert.equal(urls.length, 6);
  assert.equal(result.repository.fullName, 'facebook/react');
  assert.equal(result.readme.content, '# React');
  assert.deepEqual(result.rootFiles, []);
  assert.equal(result.dataAvailability.license, false);
});

test('requests repository data from the official GitHub REST API URL', async () => {
  const urls = [];
  const service = createGitHubService({ fetchImpl: async (url) => {
    urls.push(url);
    return response(404);
  }, logger: { error() {} } });
  await assert.rejects(service.analyze({ owner: 'facebook', repo: 'react' }), (error) => error.code === 'REPOSITORY_NOT_FOUND');
  assert.ok(urls.includes('https://api.github.com/repos/facebook/react'));
  assert.deepEqual(urls, ['https://api.github.com/repos/facebook/react']);
});

test('maps a missing repository response to a structured API error', async () => {
  const service = createGitHubService({ fetchImpl: async () => response(404), logger: { error() {} } });
  await assert.rejects(service.analyze({ owner: 'missing', repo: 'repo' }), (error) => {
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.status, 404);
    assert.equal(error.code, 'REPOSITORY_NOT_FOUND');
    return true;
  });
});

test('maps exhausted GitHub HTTP 403 primary rate limits with reset headers and does not retry', async () => {
  let calls = 0;
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const service = createGitHubService({ fetchImpl: async () => { calls += 1; return response(403, { message: 'API rate limit exceeded' }, {
    'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset),
  }); }, logger: { error() {} } });
  await assert.rejects(service.analyze({ owner: 'octocat', repo: 'repo' }), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'GITHUB_RATE_LIMITED');
    assert.equal(error.upstreamStatus, 403);
    assert.equal(error.limitType, 'primary_unauthenticated');
    assert.equal(error.rateLimit.limit, 5000);
    assert.equal(error.rateLimit.remaining, 0);
    assert.equal(error.rateLimit.retryAt, new Date(reset * 1000).toISOString());
    return true;
  });
  await assert.rejects(service.analyze({ owner: 'octocat', repo: 'repo' }), (error) => error.code === 'GITHUB_RATE_LIMITED');
  assert.equal(calls, 1);
});

test('maps GitHub 403 rate limit response bodies to HTTP 429', async () => {
  const service = createGitHubService({ fetchImpl: async () => response(403, { message: 'API rate limit exceeded' }), logger: { error() {} } });
  await assert.rejects(service.analyze({ owner: 'octocat', repo: 'repo' }), (error) => error.status === 429 && error.code === 'GITHUB_RATE_LIMITED');
});

test('maps GitHub HTTP 429 as a secondary limit and includes Retry-After without retrying', async () => {
  let calls = 0;
  const service = createGitHubService({ fetchImpl: async () => {
    calls += 1;
    return response(429, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '60' });
  }, logger: { error() {} } });
  await assert.rejects(service.analyze({ owner: 'octocat', repo: 'repo' }), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.upstreamStatus, 429);
    assert.equal(error.limitType, 'secondary');
    assert.equal(error.rateLimit.retryAfter, '60');
    assert.ok(Date.parse(error.rateLimit.retryAt) > Date.now());
    return true;
  });
  assert.equal(calls, 1);
});

test('does not classify a non-rate-limit GitHub 403 as rate limiting', async () => {
  const service = createGitHubService({ fetchImpl: async () => response(403, { message: 'Resource not accessible by integration' }, {
    'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1792454400',
  }), logger: { error() {} } });
  await assert.rejects(service.analyze({ owner: 'octocat', repo: 'repo' }), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.code, 'GITHUB_FORBIDDEN');
    assert.equal(error.upstreamStatus, 403);
    assert.equal(error.rateLimit.limit, 5000);
    assert.equal(error.rateLimit.remaining, 4999);
    return true;
  });
});

test('sends the configured token as a Bearer authorization header without logging it', async () => {
  const fakeToken = 'test-token-value';
  let receivedHeaders;
  const logs = [];
  const service = createGitHubService({
    token: fakeToken,
    fetchImpl: async (_url, options) => { receivedHeaders = options.headers; return response(404); },
    logger: { error: (...args) => logs.push(args) },
  });
  await assert.rejects(service.analyze({ owner: 'octocat', repo: 'repo' }));
  assert.equal(receivedHeaders.Authorization, `Bearer ${fakeToken}`);
  assert.equal(JSON.stringify(logs).includes(fakeToken), false);
});

test('sends the configured token on every GitHub endpoint request', async () => {
  const seen = [];
  const service = createGitHubService({
    token: 'test-token-value',
    fetchImpl: async (url, options) => { seen.push({ url, authorization: options.headers.Authorization }); return successfulApiResponse(url); },
    logger: { error() {} },
  });
  await service.analyze({ owner: 'facebook', repo: 'react' });
  assert.equal(seen.length, 6);
  assert.ok(seen.every((request) => request.authorization === 'Bearer test-token-value'));
});

test('omits Authorization when no GitHub token is configured', async () => {
  let receivedHeaders;
  const service = createGitHubService({
    token: '',
    fetchImpl: async (_url, options) => { receivedHeaders = options.headers; return response(404); },
    logger: { error() {} },
  });
  await assert.rejects(service.analyze({ owner: 'octocat', repo: 'repo' }));
  assert.equal(Object.hasOwn(receivedHeaders, 'Authorization'), false);
});

test('logs the failed GitHub URL and auth state without logging authorization data', async () => {
  const logs = [];
  const token = 'test-only-secret';
  const service = createGitHubService({
    token,
    fetchImpl: async () => response(403, { message: 'Resource not accessible by integration' }),
    logger: { error: (...args) => logs.push(args) },
  });
  await assert.rejects(service.analyze({ owner: 'facebook', repo: 'react' }), (error) => error.status === 403);
  const serialized = JSON.stringify(logs);
  assert.ok(serialized.includes('https://api.github.com/repos/facebook/react'));
  assert.ok(serialized.includes('"authenticated":true'));
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes('Bearer'), false);
});

test('caches successful endpoint responses across repeated analysis calls', async () => {
  let calls = 0;
  const service = createGitHubService({
    fetchImpl: async (url) => { calls += 1; return successfulApiResponse(url); },
    logger: { error() {} },
  });
  await service.analyze({ owner: 'facebook', repo: 'react' });
  await service.analyze({ owner: 'facebook', repo: 'react' });
  assert.equal(calls, 7); // Five cached successful responses; the optional license 404 is retried.
});

test('deduplicates concurrent analysis requests for the same repository', async () => {
  let calls = 0;
  const service = createGitHubService({
    fetchImpl: async (url) => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return successfulApiResponse(url); },
    logger: { error() {} },
  });
  await Promise.all([
    service.analyze({ owner: 'facebook', repo: 'react' }),
    service.analyze({ owner: 'facebook', repo: 'react' }),
  ]);
  assert.equal(calls, 6);
});

test('does not return a successful partial report when an optional endpoint is rate limited', async () => {
  const calls = [];
  const service = createGitHubService({
    fetchImpl: async (url) => {
      calls.push(url);
      if (new URL(url).pathname.endsWith('/readme')) return response(403, { message: 'API rate limit exceeded' }, {
        'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      });
      return successfulApiResponse(url);
    },
    logger: { error() {} },
  });
  await assert.rejects(service.analyze({ owner: 'facebook', repo: 'react' }), (error) => error.code === 'GITHUB_RATE_LIMITED' && error.limitType === 'primary_unauthenticated');
  assert.ok(calls.includes('https://api.github.com/repos/facebook/react'));
});

test('classifies a configured-token primary limit separately from an unauthenticated limit', async () => {
  const service = createGitHubService({
    token: 'configured-token',
    fetchImpl: async () => response(403, { message: 'API rate limit exceeded' }, {
      'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    }),
    logger: { error() {} },
  });
  await assert.rejects(service.analyze({ owner: 'octocat', repo: 'repo' }), (error) => error.limitType === 'primary_authenticated');
});

test('maps network failures to a structured gateway error', async () => {
  const service = createGitHubService({ fetchImpl: async () => { throw new Error('offline'); }, logger: { error() {} } });
  await assert.rejects(service.analyze({ owner: 'octocat', repo: 'repo' }), (error) => error.status === 502 && error.code === 'GITHUB_NETWORK_ERROR');
});

test('maps timeouts separately and logs diagnostics without request headers', async () => {
  const logs = [];
  const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError', code: 'ETIMEDOUT' });
  const service = createGitHubService({
    token: 'secret-token',
    fetchImpl: async () => { throw timeout; },
    logger: { error: (...args) => logs.push(args) },
  });
  await assert.rejects(service.analyze({ owner: 'facebook', repo: 'react' }), (error) => error.status === 504 && error.code === 'GITHUB_TIMEOUT');
  assert.equal(logs.length, 2);
  assert.deepEqual(logs[0][1], {
    url: 'https://api.github.com/repos/facebook/react',
    authenticated: true,
    category: 'timeout',
    causes: [{ name: 'TimeoutError', code: 'ETIMEDOUT', message: 'timeout' }],
    proxyConfigured: false,
    nodeEnvProxyEnabled: false,
    attempt: 1,
  });
  assert.equal(JSON.stringify(logs).includes('secret-token'), false);
});

test('retries a transient HTTP 500 once and then returns the real repository data', async () => {
  let metadataAttempts = 0;
  const service = createGitHubService({
    fetchImpl: async (url) => {
      if (url === 'https://api.github.com/repos/facebook/react' && metadataAttempts++ === 0) return response(500);
      return successfulApiResponse(url);
    },
    logger: { error() {} },
  });
  const result = await service.analyze({ owner: 'facebook', repo: 'react' });
  assert.equal(metadataAttempts, 2);
  assert.equal(result.repository.fullName, 'facebook/react');
});

test('does not retry a final HTTP 500 response', async () => {
  let calls = 0;
  const service = createGitHubService({ fetchImpl: async () => { calls += 1; return response(500); }, logger: { error() {} } });
  await assert.rejects(service.analyze({ owner: 'facebook', repo: 'react' }), (error) => error.status === 502 && error.code === 'GITHUB_API_ERROR');
  assert.equal(calls, 2);
});

test('preserves repository data and marks an optional endpoint unavailable after HTTP 500', async () => {
  let readmeCalls = 0;
  const service = createGitHubService({
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith('/readme')) { readmeCalls += 1; return response(500); }
      return successfulApiResponse(url);
    },
    logger: { error() {} },
  });
  const data = await service.analyze({ owner: 'facebook', repo: 'react' });
  assert.equal(readmeCalls, 2); // one bounded retry
  assert.equal(data.repository.fullName, 'facebook/react');
  assert.equal(data.collectionAvailability.readme, false);
  assert.equal(data.dataAvailability.readme, false);
  assert.equal(data.optionalErrors.readme.code, 'GITHUB_API_ERROR');
});

test('maps DNS and TLS failures separately from generic network failures', async () => {
  for (const [causeCode, expectedCode] of [
    ['ENOTFOUND', 'GITHUB_DNS_ERROR'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'GITHUB_TLS_ERROR'],
  ]) {
    const failure = Object.assign(new Error('request failed'), { cause: Object.assign(new Error(causeCode), { code: causeCode }) });
    const service = createGitHubService({ fetchImpl: async () => { throw failure; }, logger: { error() {} } });
    await assert.rejects(service.analyze({ owner: 'facebook', repo: 'react' }), (error) => error.code === expectedCode);
  }
});

test('classifies nested Node fetch causes and bounds connection retries', async () => {
  let calls = 0;
  const logs = [];
  const osError = Object.assign(new Error('socket details'), { code: 'ECONNREFUSED' });
  const aggregate = new AggregateError([osError], 'connect failed');
  const fetchError = Object.assign(new TypeError('fetch failed'), { cause: aggregate });
  const service = createGitHubService({
    fetchImpl: async () => { calls += 1; throw fetchError; },
    logger: { error: (...args) => logs.push(args) },
  });
  await assert.rejects(service.analyze({ owner: 'facebook', repo: 'react' }), (error) => {
    assert.equal(error.code, 'GITHUB_CONNECTION_REFUSED');
    assert.equal(error.causeCode, 'ECONNREFUSED');
    return true;
  });
  assert.equal(calls, 2);
  assert.ok(JSON.stringify(logs).includes('ECONNREFUSED'));
  assert.equal(JSON.stringify(logs).includes('socket details'), true);
});

test('logs safe low-level EACCES diagnostics while redacting credential-like text', async () => {
  const logs = [];
  const socketError = Object.assign(new Error('connect EACCES 20.207.73.85:443 Bearer ghp_abcdefghijklmnopqrst'), {
    code: 'EACCES', syscall: 'connect', address: '20.207.73.85', port: 443,
  });
  const fetchError = Object.assign(new TypeError('fetch failed'), { cause: socketError });
  const service = createGitHubService({ fetchImpl: async () => { throw fetchError; }, logger: { error: (...args) => logs.push(args) } });
  await assert.rejects(service.analyze({ owner: 'facebook', repo: 'react' }), (error) => error.code === 'GITHUB_NETWORK_ERROR' && error.causeCode === 'EACCES');
  const logged = JSON.stringify(logs);
  assert.ok(logged.includes('connect EACCES 20.207.73.85:443'));
  assert.ok(logged.includes('"syscall":"connect"'));
  assert.ok(logged.includes('"address":"20.207.73.85"'));
  assert.ok(logged.includes('"port":443'));
  assert.equal(logged.includes('ghp_abcdefghijklmnopqrst'), false);
});

test('classifies nested DNS, TLS and timeout causes by their low-level code', async () => {
  const cases = [
    ['ENOTFOUND', 'GITHUB_DNS_ERROR'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'GITHUB_TLS_ERROR'],
    ['ETIMEDOUT', 'GITHUB_TIMEOUT'],
  ];
  for (const [causeCode, expectedCode] of cases) {
    const lowLevel = Object.assign(new Error('private diagnostic text'), { code: causeCode });
    const service = createGitHubService({
      fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: new AggregateError([lowLevel]) }); },
      logger: { error() {} },
    });
    await assert.rejects(service.analyze({ owner: 'facebook', repo: 'react' }), (error) => {
      assert.equal(error.code, expectedCode);
      assert.equal(error.causeCode, causeCode);
      return true;
    });
  }
});

test('classifies Node fetch connection timeout errors as timeouts', async () => {
  const error = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
  });
  const service = createGitHubService({ fetchImpl: async () => { throw error; }, logger: { error() {} } });
  await assert.rejects(service.analyze({ owner: 'facebook', repo: 'react' }), (failure) => failure.status === 504 && failure.code === 'GITHUB_TIMEOUT');
});
