const API_BASE_URL = (import.meta.env?.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
const BACKEND_PORT = import.meta.env?.VITE_BACKEND_PORT || '5000';

export function parseRepositoryUrl(value) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash) {
      return null;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    const owner = parts[0];
    const repository = parts[1].replace(/\.git$/i, '');
    if (!owner || !repository || owner === '.' || repository === '.' || /[\\\s]/.test(owner + repository)) return null;
    return { owner, repository };
  } catch {
    return null;
  }
}

export async function analyzeRepository(repositoryUrl) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}/repository/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url: repositoryUrl }),
    });
  } catch (cause) {
    const error = new Error('Could not connect to the analyzer backend. Check that it is running on port 5000.');
    error.code = 'BACKEND_UNREACHABLE';
    error.cause = cause;
    throw error;
  }

  let responseText;
  try {
    responseText = await response.text();
  } catch {
    const error = new Error(`Could not read the backend response (HTTP ${response.status}). Check the backend terminal for errors.`);
    error.status = response.status;
    error.code = 'UNREADABLE_BACKEND_RESPONSE';
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    const contentType = response.headers?.get?.('content-type') || 'unknown content type';
    const proxyFailure = response.status >= 500 && !responseText.trim() && /text\/plain/i.test(contentType);
    const error = new Error(proxyFailure
      ? `The Vite proxy could not reach the backend at 127.0.0.1:${BACKEND_PORT}. Start the backend and confirm it is listening on the configured port.`
      : `The backend returned a non-JSON response (HTTP ${response.status}, ${contentType}). Check the backend terminal for the original error.`);
    error.status = response.status;
    error.code = proxyFailure ? 'BACKEND_UNREACHABLE' : 'NON_JSON_BACKEND_RESPONSE';
    throw error;
  }
  if (!response.ok || payload?.success !== true) {
    const detail = payload?.error || {};
    const error = new Error(detail.message || `Analysis failed (HTTP ${response.status}).`);
    error.status = response.status;
    error.code = detail.code;
    error.retryAt = detail.retryAt || detail.rateLimit?.retryAt || null;
    error.limitType = detail.limitType;
    error.causeCode = detail.causeCode;
    throw error;
  }
  if (!payload.data || typeof payload.data !== 'object' || !payload.data.repository || !payload.data.health) {
    const error = new Error('The backend returned an incomplete repository analysis.');
    error.status = response.status;
    error.code = 'INVALID_ANALYSIS_RESPONSE';
    throw error;
  }
  return payload.data;
}
