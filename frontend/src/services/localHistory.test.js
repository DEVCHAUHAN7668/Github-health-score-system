import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYSIS_HISTORY_STORAGE_KEY,
  clearAnalysisHistory,
  deleteAnalysisHistoryEntry,
  loadAnalysisHistory,
  saveAnalysisHistory,
} from './localHistory.js';

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}

function analysis({ analyzedAt = '2026-10-19T12:00:00.000Z', readme = 'large README content' } = {}) {
  return {
    repository: {
      owner: { login: 'facebook' }, name: 'react', fullName: 'facebook/react', url: 'https://github.com/facebook/react',
      description: 'A library', stars: 100, topics: ['javascript'],
    },
    readme: { content: readme },
    health: {
      overallScore: 88, status: 'Healthy', partial: false,
      categories: [{ name: 'Documentation Quality', earnedPoints: 22, maxPoints: 25, explanation: 'Evidence', evidence: ['README found'] }],
      strengths: ['A description is present.'], weaknesses: [], recommendations: [], unavailableEvidence: [],
    },
    metadata: { analyzedAt, dataSource: 'GitHub REST API' },
  };
}

test('saves only a successful report snapshot and loads it for reopening', () => {
  const storage = createStorage();
  const saved = saveAnalysisHistory(analysis(), storage);
  assert.equal(saved.owner, 'facebook');
  assert.equal(saved.name, 'react');
  assert.equal(saved.overallScore, 88);
  assert.equal(saved.report.repository.url, 'https://github.com/facebook/react');
  assert.equal(saved.report.health.recommendations.length, 0);
  assert.equal('readme' in saved.report, false);
  assert.equal(loadAnalysisHistory(storage)[0].id, saved.id);
  assert.ok(storage.getItem(ANALYSIS_HISTORY_STORAGE_KEY));
});

test('orders history newest first, deletes one entry, and clears all entries', () => {
  const storage = createStorage();
  saveAnalysisHistory(analysis({ analyzedAt: '2026-10-18T12:00:00.000Z' }), storage);
  const newest = saveAnalysisHistory(analysis({ analyzedAt: '2026-10-19T12:00:00.000Z' }), storage);
  assert.equal(loadAnalysisHistory(storage)[0].id, newest.id);
  assert.equal(deleteAnalysisHistoryEntry(newest.id, storage).length, 1);
  assert.equal(loadAnalysisHistory(storage).length, 1);
  clearAnalysisHistory(storage);
  assert.deepEqual(loadAnalysisHistory(storage), []);
});

test('does not create history for incomplete analysis or silently hide corrupt saved data', () => {
  const storage = createStorage();
  assert.throws(() => saveAnalysisHistory({ repository: {}, health: { overallScore: 20, status: 'Poor' } }, storage), { code: 'INVALID_ANALYSIS_RESULT' });
  storage.setItem(ANALYSIS_HISTORY_STORAGE_KEY, '{broken');
  assert.throws(() => loadAnalysisHistory(storage), { code: 'LOCAL_HISTORY_CORRUPT' });
});

test('reports browser storage failures instead of pretending the history was saved', () => {
  const storage = { getItem() { return null; }, setItem() { throw new Error('quota'); }, removeItem() {} };
  assert.throws(() => saveAnalysisHistory(analysis(), storage), { code: 'LOCAL_HISTORY_WRITE_FAILED' });
});
