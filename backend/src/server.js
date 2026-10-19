import app from './app.js';

const configuredPort = process.env.PORT?.trim();
const port = configuredPort ? Number(configuredPort) : 5000;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('[server] Invalid PORT. Set an integer between 1 and 65535.');
  process.exit(1);
}
console.log(`[config] GITHUB_TOKEN configured: ${Boolean(process.env.GITHUB_TOKEN)}`);
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`GitHub Repository Health Analyzer API listening at http://127.0.0.1:${port}`);
});
server.on('error', (error) => {
  console.error('[server] Could not start listener', {
    port,
    code: typeof error.code === 'string' ? error.code : 'SERVER_START_ERROR',
  });
  process.exitCode = 1;
});
