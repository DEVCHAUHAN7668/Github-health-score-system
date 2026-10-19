import express from 'express';
import healthRouter from './routes/health.js';
import repositoryRouter from './routes/repository.js';

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use('/api/health', healthRouter);
app.use('/api/repository', repositoryRouter);
app.use('/api', (_request, response) => {
  response.status(404).json({
    success: false,
    error: { code: 'API_ROUTE_NOT_FOUND', message: 'API route not found.' },
  });
});

export function errorHandler(error, _request, response, _next) {
  if (error?.type === 'entity.parse.failed') {
    return response.status(400).json({
      success: false,
      error: { code: 'INVALID_JSON', message: 'Request body must contain valid JSON.' },
    });
  }
  const status = Number.isInteger(error.status) ? error.status : 500;
  const code = error.code ?? 'INTERNAL_SERVER_ERROR';
  if (status >= 500 && error.exposeMessage !== true) {
    const pending = [error];
    const seen = new Set();
    const causes = [];
    while (pending.length && seen.size < 8) {
      const item = pending.shift();
      if (!item || typeof item !== 'object' || seen.has(item)) continue;
      seen.add(item);
      causes.push({
        ...(typeof item.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,49}$/.test(item.name) ? { name: item.name } : {}),
        ...(typeof item.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(item.code) ? { code: item.code } : {}),
      });
      if (item.cause) pending.push(item.cause);
      if (Array.isArray(item.errors)) pending.push(...item.errors);
    }
    console.error('[API] Unexpected request error', { status, causes });
  }
  const message = status >= 500 && status !== 503 && error.exposeMessage !== true
    ? 'An unexpected server error occurred.'
    : error.message;
  const details = {};
  if (Number.isInteger(error.upstreamStatus)) details.upstreamStatus = error.upstreamStatus;
  if (typeof error.causeCode === 'string' && /^[A-Z0-9_]{2,64}$/.test(error.causeCode)) details.causeCode = error.causeCode;
  if (error.limitType) details.limitType = error.limitType;
  if (error.rateLimit) details.rateLimit = error.rateLimit;
  if (error.rateLimit?.retryAt) details.retryAt = error.rateLimit.retryAt;
  response.status(status).json({ success: false, error: { code, message, ...details } });
}

app.use(errorHandler);

export default app;
