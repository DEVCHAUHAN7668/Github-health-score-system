import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_MAXIMUMS, calculateHealthScore, healthStatusForScore } from '../src/services/healthScoreService.js';

const now = Date.parse('2026-01-01T00:00:00.000Z');

function complete(overrides = {}) {
  return {
    repository: {
      name: 'sample', description: 'A sample project', pushedAt: '2025-12-20T00:00:00Z',
      createdAt: '2020-01-01T00:00:00Z', stars: 20, forks: 3,
    },
    readme: { content: `# Project\n${'Useful setup and usage information. '.repeat(10)}` },
    rootFiles: [
      { name: 'package.json', type: 'file' }, { name: 'src', type: 'dir' },
      { name: 'test', type: 'dir' }, { name: 'README.md', type: 'file' },
    ],
    recentCommits: [{ date: '2025-12-20T00:00:00Z' }],
    license: { key: 'mit', name: 'MIT License', spdxId: 'MIT' },
    issueSample: [{ state: 'closed', updatedAt: '2025-12-20T00:00:00Z' }, { state: 'open', updatedAt: '2025-12-20T00:00:00Z' }],
    dataAvailability: { repository: true, readme: true, rootFiles: true, recentCommits: true, license: true, openIssues: true },
    collectionAvailability: { repository: true, readme: true, rootFiles: true, recentCommits: true, license: true, openIssues: true },
    ...overrides,
  };
}

test('maximum category weights total exactly 100', () => {
  assert.equal(Object.values(CATEGORY_MAXIMUMS).reduce((sum, points) => sum + points, 0), 100);
});

test('status labels use the configured score boundaries', () => {
  assert.equal(healthStatusForScore(0), 'Poor');
  assert.equal(healthStatusForScore(39), 'Poor');
  assert.equal(healthStatusForScore(40), 'Needs Improvement');
  assert.equal(healthStatusForScore(59), 'Needs Improvement');
  assert.equal(healthStatusForScore(60), 'Moderate');
  assert.equal(healthStatusForScore(79), 'Moderate');
  assert.equal(healthStatusForScore(80), 'Healthy');
  assert.equal(healthStatusForScore(100), 'Healthy');
  assert.throws(() => healthStatusForScore(101), /between 0 and 100/);
});

test('complete repository evidence is scored with five categories and bounded score', () => {
  const result = calculateHealthScore(complete(), { now });
  assert.equal(result.categories.length, 5);
  assert.equal(result.overallScore, result.categories.reduce((sum, item) => sum + item.earnedPoints, 0));
  assert.ok(result.overallScore >= 0 && result.overallScore <= 100);
  for (const category of result.categories) {
    assert.ok(category.earnedPoints <= category.maxPoints);
    assert.ok(category.percentage >= 0 && category.percentage <= 100);
    assert.ok(Array.isArray(category.evidence));
    assert.ok(Array.isArray(category.calculation));
    assert.equal(category.calculation.reduce((sum, part) => sum + part.earnedPoints, 0), category.earnedPoints);
    for (const part of category.calculation) {
      assert.ok(typeof part.status === 'string');
      assert.ok(Array.isArray(part.evidence));
      assert.ok(part.earnedPoints >= 0 && part.earnedPoints <= part.maxPoints);
    }
  }
});

test('missing README, license, and description generate only evidence-backed recommendations', () => {
  const input = complete({
    repository: { description: null, pushedAt: '2025-12-20T00:00:00Z' }, readme: null, license: null,
    dataAvailability: { repository: true, readme: false, rootFiles: true, recentCommits: true, license: false, openIssues: true },
    collectionAvailability: { repository: true, readme: true, rootFiles: true, recentCommits: true, license: true, openIssues: true },
  });
  const result = calculateHealthScore(input, { now });
  const issues = result.recommendations.map(({ issue }) => issue);
  assert.ok(issues.includes('No README is available.'));
  assert.ok(issues.includes('No license information is available.'));
  assert.ok(issues.includes('No repository description is set.'));
  assert.equal(result.partial, false);
  assert.deepEqual(result.unavailableEvidence, []);
  assert.equal(result.categories.find(({ name }) => name === 'Documentation Quality').earnedPoints, 0);
});

test('old activity gets partial credit and only produces stale recommendation past configured threshold', () => {
  const result = calculateHealthScore(complete({ repository: { pushedAt: '2020-01-01T00:00:00Z', stars: 0, forks: 0 } }), { now });
  const maintenance = result.categories.find(({ name }) => name === 'Maintenance');
  assert.equal(maintenance.earnedPoints, 10);
  assert.ok(result.recommendations.some(({ issue }) => issue.includes('older than the maintenance threshold')));
});

test('old high-popularity repositories are not automatically called unhealthy', () => {
  const result = calculateHealthScore(complete({ repository: { createdAt: '2018-01-01T00:00:00Z', pushedAt: '2020-01-01T00:00:00Z', stars: 1500, forks: 0 } }), { now });
  assert.ok(!result.recommendations.some(({ issue }) => issue.includes('older than the maintenance threshold')));
});

test('a single recent commit cannot earn all development points', () => {
  const result = calculateHealthScore(complete(), { now });
  assert.equal(result.categories.find(({ name }) => name === 'Maintenance').earnedPoints, 25);
  assert.equal(result.categories.find(({ name }) => name === 'Development Activity').earnedPoints, 9);
});

test('five recent commits can earn full development activity points', () => {
  const commits = Array.from({ length: 5 }, (_, index) => ({ date: `2025-12-${20 - index}T00:00:00Z` }));
  const result = calculateHealthScore(complete({ recentCommits: commits }), { now });
  assert.equal(result.categories.find(({ name }) => name === 'Development Activity').earnedPoints, 15);
});

test('open-heavy issue sample is not penalized by volume alone and includes calculation evidence', () => {
  const issueSample = [
    ...Array.from({ length: 15 }, () => ({ state: 'open', updatedAt: '2025-12-20T00:00:00Z' })),
    ...Array.from({ length: 5 }, () => ({ state: 'closed', updatedAt: '2025-12-20T00:00:00Z' })),
  ];
  const result = calculateHealthScore(complete({ issueSample }), { now });
  const category = result.categories.find(({ name }) => name === 'Issue Management');
  assert.equal(category.earnedPoints, 11);
  assert.ok(!result.recommendations.some(({ issue }) => issue.includes('open issues')));
  assert.ok(category.calculation.some(({ criterion }) => criterion === 'Closed issue share'));
  assert.ok(category.calculation.some(({ criterion }) => criterion === 'Recent issue updates'));
});

test('stale open issue samples support a triage recommendation', () => {
  const issueSample = [
    ...Array.from({ length: 8 }, () => ({ state: 'open', updatedAt: '2025-01-01T00:00:00Z' })),
    ...Array.from({ length: 2 }, () => ({ state: 'closed', updatedAt: '2025-12-20T00:00:00Z' })),
  ];
  const result = calculateHealthScore(complete({ issueSample }), { now });
  assert.ok(result.recommendations.some(({ issue }) => issue.includes('not been updated recently')));
});

test('an empty issue sample receives neutral rather than full issue-management points', () => {
  const result = calculateHealthScore(complete({ issueSample: [] }), { now });
  const category = result.categories.find(({ name }) => name === 'Issue Management');
  assert.equal(category.earnedPoints, 12);
  assert.equal(category.maxPoints, 15);
});

test('unavailable optional data is marked partial and not treated as confirmed absent', () => {
  const result = calculateHealthScore(complete({
    readme: null, license: null, rootFiles: null, recentCommits: null, issueSample: null,
    dataAvailability: { repository: true, readme: false, rootFiles: false, recentCommits: false, license: false, openIssues: false },
    collectionAvailability: { repository: true, readme: false, rootFiles: false, recentCommits: false, license: false, openIssues: false },
  }), { now });
  assert.equal(result.partial, true);
  assert.equal(result.unavailableEvidence.length, 5);
  assert.deepEqual(result.recommendations.map(({ issue }) => issue), []);
});

test('missing issue sample is reported as unavailable without an issue recommendation', () => {
  const result = calculateHealthScore(complete({ issueSample: null, dataAvailability: { repository: true, readme: true, rootFiles: true, recentCommits: true, license: true, openIssues: false }, collectionAvailability: { repository: true, readme: true, rootFiles: true, recentCommits: true, license: true, openIssues: false } }), { now });
  assert.equal(result.categories.find(({ name }) => name === 'Issue Management').unavailableEvidence[0], 'Issue sample unavailable');
  assert.equal(result.recommendations.some(({ issue }) => issue.toLowerCase().includes('issue')), false);
});

test('score and recommendations are deterministic for identical input and clock', () => {
  const input = complete();
  assert.deepEqual(calculateHealthScore(input, { now }), calculateHealthScore(input, { now }));
});

test('invalid input is rejected rather than producing a fabricated report', () => {
  assert.throws(() => calculateHealthScore(null), /Repository analysis data is required/);
});
