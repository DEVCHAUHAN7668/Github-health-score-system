export class InvalidRepositoryUrlError extends Error {
  constructor(message = 'Provide a valid public GitHub repository URL.') {
    super(message);
    this.name = 'InvalidRepositoryUrlError';
  }
}

/** Parse only github.com URLs that identify exactly one owner and repository. */
export function parseRepositoryUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRepositoryUrlError();
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new InvalidRepositoryUrlError();
  }

  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.port) {
    throw new InvalidRepositoryUrlError();
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parts.some((part) => part.includes('%2f') || part.includes('%5c'))) {
    throw new InvalidRepositoryUrlError();
  }

  let owner;
  let rawName;
  try {
    owner = decodeURIComponent(parts[0]);
    rawName = decodeURIComponent(parts[1]);
  } catch {
    throw new InvalidRepositoryUrlError();
  }
  const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName;
  const validSegment = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
  if (!validSegment.test(owner) || !validSegment.test(name)) {
    throw new InvalidRepositoryUrlError();
  }

  return { owner, repo: name };
}
