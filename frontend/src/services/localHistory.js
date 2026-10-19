const STORAGE_KEY = 'repolens.analysisHistory.v1';
const MAX_HISTORY_ITEMS = 50;

export class LocalHistoryError extends Error {
  constructor(message, code = 'LOCAL_HISTORY_ERROR') {
    super(message);
    this.name = 'LocalHistoryError';
    this.code = code;
  }
}

function getStorage(storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target) throw new Error('localStorage is unavailable');
    return target;
  } catch {
    throw new LocalHistoryError('Browser storage is unavailable. Check your browser privacy settings.', 'LOCAL_STORAGE_UNAVAILABLE');
  }
}

function validateEntry(entry) {
  return entry && typeof entry === 'object'
    && typeof entry.id === 'string'
    && typeof entry.owner === 'string'
    && typeof entry.name === 'string'
    && typeof entry.url === 'string'
    && Number.isFinite(entry.overallScore)
    && typeof entry.status === 'string'
    && typeof entry.analyzedAt === 'string'
    && entry.report?.repository && entry.report?.health;
}

function readEntries(storage) {
  const target = getStorage(storage);
  let raw;
  try {
    raw = target.getItem(STORAGE_KEY);
  } catch {
    throw new LocalHistoryError('Could not read saved analysis history from browser storage.', 'LOCAL_HISTORY_READ_FAILED');
  }
  if (raw === null) return [];
  try {
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.some((entry) => !validateEntry(entry))) throw new Error('Invalid history data');
    return entries;
  } catch {
    throw new LocalHistoryError('Saved analysis history is unreadable. Clear browser history storage to start again.', 'LOCAL_HISTORY_CORRUPT');
  }
}

function writeEntries(storage, entries) {
  const target = getStorage(storage);
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    throw new LocalHistoryError('Could not save analysis history. Browser storage may be full or disabled.', 'LOCAL_HISTORY_WRITE_FAILED');
  }
}

function copyFinding(finding) {
  if (typeof finding === 'string') return finding;
  if (!finding || typeof finding !== 'object') return null;
  return {
    issue: finding.issue,
    message: finding.message,
    why: finding.why,
    action: finding.action,
    priority: finding.priority,
    evidence: finding.evidence,
  };
}

function createReport(data) {
  const sourceRepository = data?.repository;
  const health = data?.health;
  if (!sourceRepository || !health || !Number.isFinite(health.overallScore) || typeof health.status !== 'string') {
    throw new LocalHistoryError('The backend response did not contain a complete successful analysis.', 'INVALID_ANALYSIS_RESULT');
  }

  const fullName = sourceRepository.fullName;
  let owner = sourceRepository.owner?.login;
  let name = sourceRepository.name;
  if ((!owner || !name) && typeof fullName === 'string') [owner, name] = fullName.split('/', 2);
  if ((!owner || !name) && typeof sourceRepository.url === 'string') {
    try {
      const parts = new URL(sourceRepository.url).pathname.split('/').filter(Boolean);
      owner ||= parts[0];
      name ||= parts[1];
    } catch {
      // The validation below reports an incomplete repository response.
    }
  }
  const url = sourceRepository.url;
  const analyzedAt = data.metadata?.analyzedAt;
  if (!owner || !name || typeof url !== 'string' || !/^https:\/\/github\.com\//i.test(url)
    || typeof analyzedAt !== 'string' || !Number.isFinite(Date.parse(analyzedAt))) {
    throw new LocalHistoryError('The backend response did not contain valid repository details or analysis time.', 'INVALID_ANALYSIS_RESULT');
  }

  const repository = {
    owner: { login: owner },
    name,
    fullName: fullName || `${owner}/${name}`,
    url,
  };
  for (const key of ['description', 'defaultBranch', 'createdAt', 'updatedAt', 'pushedAt', 'stars', 'forks', 'watchers', 'openIssuesCount', 'language', 'topics']) {
    if (sourceRepository[key] !== undefined) repository[key] = sourceRepository[key];
  }

  const report = {
    repository,
    license: data.license ?? null,
    health: {
      overallScore: health.overallScore,
      status: health.status,
      categories: Array.isArray(health.categories) ? health.categories : [],
      strengths: Array.isArray(health.strengths) ? health.strengths : [],
      weaknesses: Array.isArray(health.weaknesses) ? health.weaknesses.map(copyFinding).filter(Boolean) : [],
      recommendations: Array.isArray(health.recommendations) ? health.recommendations.map(copyFinding).filter(Boolean) : [],
      partial: health.partial === true,
      unavailableEvidence: Array.isArray(health.unavailableEvidence) ? health.unavailableEvidence : [],
    },
    metadata: { analyzedAt, dataSource: data.metadata?.dataSource || 'GitHub REST API' },
  };
  return { owner, name, url, analyzedAt, report };
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function loadAnalysisHistory(storage) {
  return readEntries(storage).sort((left, right) => Date.parse(right.analyzedAt) - Date.parse(left.analyzedAt));
}

export function saveAnalysisHistory(data, storage) {
  const report = createReport(data);
  const entries = readEntries(storage);
  const entry = {
    id: createId(),
    ...report,
    overallScore: report.report.health.overallScore,
    status: report.report.health.status,
  };
  writeEntries(storage, [entry, ...entries].slice(0, MAX_HISTORY_ITEMS));
  return entry;
}

export function deleteAnalysisHistoryEntry(id, storage) {
  const entries = readEntries(storage);
  const next = entries.filter((entry) => entry.id !== id);
  if (next.length !== entries.length) writeEntries(storage, next);
  return next;
}

export function clearAnalysisHistory(storage) {
  const target = getStorage(storage);
  try {
    target.removeItem(STORAGE_KEY);
  } catch {
    throw new LocalHistoryError('Could not clear analysis history from browser storage.', 'LOCAL_HISTORY_CLEAR_FAILED');
  }
}

export const ANALYSIS_HISTORY_STORAGE_KEY = STORAGE_KEY;
