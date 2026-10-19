import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

// Load backend/.env relative to this service, even if the process starts from the project root.
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const API_BASE = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 1;
const DEFAULT_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 250;
const RATE_LIMIT_COOLDOWN_MS = 60_000;

function configuredNumber(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function safeDiagnosticText(value) {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, 240)
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/gi, '[REDACTED]')
    .replace(/([?&](?:access_token|token)=)[^&\s]*/gi, '$1[REDACTED]');
}

function inspectNetworkError(error) {
  const pending = [error];
  const visited = new Set();
  const causes = [];
  const codes = new Set();
  const names = new Set();
  while (pending.length && visited.size < 12) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    if (typeof current.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,49}$/.test(current.name)) names.add(current.name);
    if (typeof current.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(current.code)) codes.add(current.code);
    causes.push({
      ...(typeof current.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,49}$/.test(current.name) ? { name: current.name } : {}),
      ...(typeof current.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(current.code) ? { code: current.code } : {}),
      ...(safeDiagnosticText(current.message) ? { message: safeDiagnosticText(current.message) } : {}),
      ...(typeof current.syscall === 'string' ? { syscall: safeDiagnosticText(current.syscall) } : {}),
      ...(typeof current.address === 'string' ? { address: safeDiagnosticText(current.address) } : {}),
      ...(Number.isInteger(current.port) ? { port: current.port } : {}),
    });
    if (current.cause) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }

  const codeList = [...codes];
  let category = 'network';
  if (names.has('TimeoutError') || names.has('AbortError') || codeList.some((code) => [
    'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  ].includes(code))) category = 'timeout';
  else if (codeList.some((code) => ['ENOTFOUND', 'EAI_AGAIN'].includes(code))) category = 'dns';
  else if (codeList.some((code) => /^(CERT_|ERR_TLS|ERR_SSL|ERR_OSSL|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)/.test(code))) category = 'tls';
  else if (codeList.includes('ECONNREFUSED')) category = 'connection_refused';

  const causeCode = codeList.find((code) => {
    if (category === 'timeout') return ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code);
    if (category === 'dns') return ['ENOTFOUND', 'EAI_AGAIN'].includes(code);
    if (category === 'tls') return /^(CERT_|ERR_TLS|ERR_SSL|ERR_OSSL|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)/.test(code);
    if (category === 'connection_refused') return code === 'ECONNREFUSED';
    return true;
  });
  return { category, causeCode, causes };
}

function isRetryableNetworkError(details) {
  return ['ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(details.causeCode)
    || ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(details.causeCode)
    || details.causes.some(({ name }) => name === 'TimeoutError' || name === 'AbortError');
}

function proxyEnvironmentDetails() {
  const configured = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY
    || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy);
  const enabledForNodeFetch = process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy');
  return { proxyConfigured: configured, nodeEnvProxyEnabled: enabledForNodeFetch };
}

export class GitHubApiError extends Error {
  constructor(message, status, code, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'GitHubApiError';
    this.status = status;
    this.code = code;
    this.exposeMessage = true;
    Object.assign(this, details);
  }
}

function rateLimitDetails(response) {
  const limit = response.headers.get('x-ratelimit-limit');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const resetSeconds = Number(response.headers.get('x-ratelimit-reset'));
  const retryAfter = response.headers.get('retry-after');
  const resetDate = Number.isFinite(resetSeconds) && resetSeconds > 0 ? new Date(resetSeconds * 1000) : null;
  const resetAt = resetDate && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : null;

  let retryAt = resetAt;
  if (retryAfter) {
    const retryAfterSeconds = Number(retryAfter);
    const retryAfterDate = Number.isFinite(retryAfterSeconds)
      ? Date.now() + Math.max(0, retryAfterSeconds) * 1000
      : Date.parse(retryAfter);
    if (Number.isFinite(retryAfterDate)) retryAt = new Date(retryAfterDate).toISOString();
  }

  return {
    limit: limit !== null && /^\d+$/.test(limit) ? Number(limit) : null,
    remaining: remaining !== null && /^\d+$/.test(remaining) ? Number(remaining) : null,
    resetAt,
    retryAfter,
    retryAt,
  };
}

async function apiError(response, authenticated) {
  const rateLimit = rateLimitDetails(response);
  const upstreamDetails = { upstreamStatus: response.status, rateLimit };
  if (response.status === 404) {
    return new GitHubApiError('Repository not found or it is not publicly accessible.', 404, 'REPOSITORY_NOT_FOUND', upstreamDetails);
  }
  if (response.status === 401) {
    return new GitHubApiError('GitHub rejected the configured authentication token.', 502, 'GITHUB_AUTHENTICATION_FAILED', upstreamDetails);
  }
  let message = '';
  try {
    message = (await response.clone().json())?.message ?? '';
  } catch {
    // The status and headers still provide enough information when the body is unavailable.
  }
  const secondaryLimit = response.status === 429 || (response.status === 403 && (
    response.headers.has('retry-after') || /secondary rate limit|abuse detection/i.test(message)
  ));
  const primaryLimit = response.status === 403 && !secondaryLimit && (
    rateLimit.remaining === 0 || /API rate limit exceeded/i.test(message)
  );
  if (primaryLimit || secondaryLimit) {
    const limitType = primaryLimit ? (authenticated ? 'primary_authenticated' : 'primary_unauthenticated') : 'secondary';
    return new GitHubApiError(
      `GitHub ${primaryLimit ? 'primary' : 'secondary'} API rate limit reached.${rateLimit.retryAt ? ` Retry after ${rateLimit.retryAt}.` : ' Try again later.'}`,
      429,
      'GITHUB_RATE_LIMITED',
      { upstreamStatus: response.status, rateLimit, limitType },
    );
  }
  if (response.status === 403) {
    return new GitHubApiError('GitHub denied access to this repository.', 403, 'GITHUB_FORBIDDEN', upstreamDetails);
  }
  return new GitHubApiError(`GitHub API request failed with status ${response.status}.`, 502, 'GITHUB_API_ERROR', upstreamDetails);
}

export function createGitHubService({
  fetchImpl = fetch,
  token = process.env.GITHUB_TOKEN,
  logger = console,
  timeoutMs = configuredNumber(process.env.GITHUB_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS),
  retries = configuredNumber(process.env.GITHUB_RETRIES, DEFAULT_RETRIES, 0, 1),
  cacheTtlMs = configuredNumber(process.env.GITHUB_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS, 0, 300_000),
} = {}) {
  // The service instance owns its cache, so cached data cannot cross token configurations.
  const cache = new Map();
  const inFlight = new Map();
  const analysisInFlight = new Map();
  let rateLimitBlock = null;

  function cachedValue(url) {
    const entry = cache.get(url);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(url);
      return undefined;
    }
    return entry.value;
  }

  function cacheValue(url, value, response) {
    if (cacheTtlMs <= 0 || /(?:no-store|private)/i.test(response.headers.get('cache-control') ?? '')) return;
    const cacheControl = response.headers.get('cache-control') ?? '';
    const maxAge = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i);
    const ttl = maxAge ? Math.min(cacheTtlMs, Number(maxAge[1]) * 1000) : cacheTtlMs;
    if (ttl <= 0) return;
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(url, { value, expiresAt: Date.now() + ttl });
  }

  async function request(path, { optional = false } = {}) {
    const url = `${API_BASE}${path}`;
    const cached = cachedValue(url);
    if (cached !== undefined) return cached;
    if (inFlight.has(url)) return inFlight.get(url);
    if (rateLimitBlock && rateLimitBlock.until > Date.now()) {
      const { error } = rateLimitBlock;
      throw new GitHubApiError(error.message, error.status, error.code, {
        upstreamStatus: error.upstreamStatus, rateLimit: error.rateLimit, limitType: error.limitType,
      });
    }
    rateLimitBlock = null;

    const requestPromise = performRequest(url, path, { optional });
    inFlight.set(url, requestPromise);
    try {
      return await requestPromise;
    } finally {
      inFlight.delete(url);
    }
  }

  async function performRequest(url, path, { optional }) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github-repository-health-analyzer',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!(response.status >= 500 && response.status <= 599 && attempt < retries)) break;
        try {
          await response.body?.cancel();
        } catch {
          // A failed response body should not prevent the one bounded retry.
        }
        logger.error?.('[GitHub API] Transient HTTP response; retrying', {
          url,
          status: response.status,
          attempt: attempt + 1,
        });
      } catch (error) {
        const diagnostic = inspectNetworkError(error);
        const { category } = diagnostic;
        const retryable = isRetryableNetworkError(diagnostic);
        logger.error?.('[GitHub API] Request failed', {
          url,
          authenticated: Boolean(token),
          category,
          causes: diagnostic.causes,
          ...proxyEnvironmentDetails(),
          attempt: attempt + 1,
        });
        if (!retryable || attempt >= retries) {
          const errors = {
            timeout: ['The GitHub API request timed out. Check network or proxy responsiveness, then try again.', 504, 'GITHUB_TIMEOUT'],
            dns: ['Could not resolve the GitHub API host. Check DNS and network settings.', 502, 'GITHUB_DNS_ERROR'],
            tls: ['Could not establish a trusted TLS connection to GitHub. Check system certificates or HTTPS inspection settings.', 502, 'GITHUB_TLS_ERROR'],
            connection_refused: ['The connection to the GitHub API was refused. Check outbound HTTPS, firewall, or proxy settings.', 502, 'GITHUB_CONNECTION_REFUSED'],
            network: ['Could not connect to the GitHub API. Check network access, firewall, and HTTPS proxy settings.', 502, 'GITHUB_NETWORK_ERROR'],
          };
          const [message, status, code] = errors[category];
          throw new GitHubApiError(message, status, code, {
            ...(diagnostic.causeCode ? { causeCode: diagnostic.causeCode } : {}),
            cause: error,
          });
        }
      }
    }
    if (optional && response.status === 404) return null;
    if (!response.ok) {
      const error = await apiError(response, Boolean(token));
      logger.error?.('[GitHub API] Response failed', {
        url,
        authenticated: Boolean(token),
        status: response.status,
        category: error.code === 'GITHUB_RATE_LIMITED' ? 'rate_limit' : 'http',
        code: error.code,
        upstreamStatus: error.upstreamStatus,
        rateLimit: error.rateLimit,
        ...(error.limitType ? { limitType: error.limitType } : {}),
      });
      if (error.code === 'GITHUB_RATE_LIMITED') {
        const retryAtMs = Date.parse(error.rateLimit?.retryAt ?? '');
        rateLimitBlock = {
          until: Number.isFinite(retryAtMs) && retryAtMs > Date.now() ? retryAtMs : Date.now() + RATE_LIMIT_COOLDOWN_MS,
          error,
        };
      }
      throw error;
    }
    try {
      const value = await response.json();
      cacheValue(url, value, response);
      return value;
    } catch {
      if (optional) return null;
      throw new GitHubApiError('GitHub returned an unreadable API response.', 502, 'GITHUB_INVALID_RESPONSE');
    }
  }

  async function optionalRequest(path) {
    try {
      return { value: await request(path, { optional: true }), available: true };
    } catch (error) {
      if (!(error instanceof GitHubApiError)) throw error;
      // A rate limit makes this analysis incomplete; fail instead of persisting a scored report.
      if (error.code === 'GITHUB_RATE_LIMITED') throw error;
      // Metadata already established repository access. Preserve a partial analysis when an
      // optional metric is unavailable, and retain a safe reason for the client.
      return {
        value: null,
        available: false,
        error: {
          code: error.code,
          message: error.message,
          ...(Number.isInteger(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
          ...(error.limitType ? { limitType: error.limitType } : {}),
          ...(error.rateLimit ? { rateLimit: error.rateLimit } : {}),
        },
      };
    }
  }

  return {
    async analyze({ owner, repo }) {
      const analysisKey = `${owner}/${repo}`;
      if (analysisInFlight.has(analysisKey)) return analysisInFlight.get(analysisKey);
      const analysisPromise = analyzeRepository({ owner, repo });
      analysisInFlight.set(analysisKey, analysisPromise);
      try {
        return await analysisPromise;
      } finally {
        analysisInFlight.delete(analysisKey);
      }
    },
  };

  async function analyzeRepository({ owner, repo }) {
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      // Validate repository access before requesting any supplementary endpoints.
      const repository = await request(base);
      const [readmeResult, filesResult, commitsResult, issuesResult, licenseResult] = await Promise.all([
        optionalRequest(`${base}/readme`),
        optionalRequest(`${base}/contents`),
        optionalRequest(`${base}/commits?per_page=5`),
        optionalRequest(`${base}/issues?state=all&sort=updated&direction=desc&per_page=100`),
        optionalRequest(`${base}/license`),
      ]);
      const readme = readmeResult.value;
      const files = filesResult.value;
      const commits = commitsResult.value;
      const issues = issuesResult.value;
      const license = licenseResult.value;

      const readmeContent = readme?.content && readme.encoding === 'base64'
        ? Buffer.from(readme.content, 'base64').toString('utf8')
        : null;
      const rootFiles = Array.isArray(files)
        ? files.map(({ name, path, type, size, html_url: htmlUrl }) => ({ name, path, type, size, htmlUrl }))
        : null;

      return {
        repository: {
          id: repository.id,
          name: repository.name,
          fullName: repository.full_name,
          url: repository.html_url,
          description: repository.description,
          isPrivate: repository.private,
          defaultBranch: repository.default_branch,
          createdAt: repository.created_at,
          updatedAt: repository.updated_at,
          pushedAt: repository.pushed_at,
          stars: repository.stargazers_count,
          forks: repository.forks_count,
          watchers: repository.subscribers_count,
          openIssuesCount: repository.open_issues_count,
          language: repository.language,
          topics: repository.topics ?? [],
        },
        readme: readme ? { name: readme.name, path: readme.path, content: readmeContent } : null,
        rootFiles,
        recentCommits: Array.isArray(commits) ? commits.map((commit) => ({
          sha: commit.sha,
          message: commit.commit?.message ?? null,
          author: commit.commit?.author?.name ?? null,
          date: commit.commit?.committer?.date ?? commit.commit?.author?.date ?? null,
          url: commit.html_url,
        })) : null,
        license: license ? {
          key: license.license?.key ?? null,
          name: license.license?.name ?? null,
          spdxId: license.license?.spdx_id ?? null,
          url: license.html_url ?? null,
        } : repository.license ? {
          key: repository.license.key,
          name: repository.license.name,
          spdxId: repository.license.spdx_id,
          url: repository.license.url,
        } : null,
        openIssues: Array.isArray(issues) ? issues
          .filter((issue) => !issue.pull_request)
          .filter((issue) => issue.state === 'open')
          .slice(0, 10)
          .map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, createdAt: issue.created_at, url: issue.html_url })) : null,
        issueSample: Array.isArray(issues) ? issues.filter((issue) => !issue.pull_request)
          .map((issue) => ({ number: issue.number, state: issue.state, createdAt: issue.created_at, updatedAt: issue.updated_at })) : null,
        optionalErrors: Object.fromEntries([
          ['readme', readmeResult], ['rootFiles', filesResult], ['recentCommits', commitsResult], ['openIssues', issuesResult], ['license', licenseResult],
        ].filter(([, result]) => result.error).map(([name, result]) => [name, result.error])),
        dataAvailability: {
          repository: true,
          readme: Boolean(readme),
          rootFiles: Array.isArray(files),
          recentCommits: Array.isArray(commits),
          license: Boolean(license || repository.license),
          openIssues: Array.isArray(issues),
        },
        collectionAvailability: {
          repository: true,
          readme: readmeResult.available,
          rootFiles: filesResult.available && Array.isArray(files),
          recentCommits: commitsResult.available && Array.isArray(commits),
          license: licenseResult.available,
          openIssues: issuesResult.available && Array.isArray(issues),
        },
      };
  }
}

export const githubService = createGitHubService();
