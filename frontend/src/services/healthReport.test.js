import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthReport, createReportFilename } from './healthReport.js';

const sample = {
  repository: { fullName: 'very-long-owner-name-that-should-wrap-cleanly/really-long-repository-name-for-pdf-layout-checking', name: 'really-long-repository-name-for-pdf-layout-checking', url: 'https://github.com/example/project' },
  health: {
    overallScore: 82,
    status: 'Good',
    partial: false,
    categories: [{ name: 'Documentation Quality', earnedPoints: 21, maxPoints: 25, explanation: 'README and license signals.', evidence: ['README present', 'MIT license detected'], unavailableEvidence: [] }],
    strengths: ['A clear README is present.'],
    weaknesses: [{ issue: 'Recent activity is limited.', evidence: 'No commits in the sample period.' }],
    recommendations: [{ issue: 'Limited recent activity.', why: 'Visitors may not know whether the project is maintained.', action: 'Review and update project status.', priority: 'Low', evidence: 'Last commit is older than the configured threshold.' }],
  },
  metadata: { analyzedAt: '2026-10-18T10:30:00.000Z' },
};

test('creates a PDF with report sections and actual analysis content', () => {
  const doc = createHealthReport(sample, { generatedAt: new Date('2026-10-18T10:30:00Z') });
  const content = doc.internal.pages.flat().join(' ');
  for (const expected of ['RepoLens', 'Repository Health Report', 'Repository details', 'Overall health', 'Category breakdown', 'Documentation Quality', 'README present', 'Strengths', 'A clear README is present.', 'Weaknesses', 'Recent activity is limited.', 'Improvement recommendations', 'Review and update project status.', 'Methodology and limitations']) {
    assert.ok(content.includes(expected), `PDF is missing section content: ${expected}`);
  }
  assert.ok(doc.output().startsWith('%PDF-'));
});

test('handles missing optional fields and long repository names', () => {
  const doc = createHealthReport({ repository: { fullName: 'owner/'.padEnd(200, 'x') }, health: { overallScore: 0, status: 'Needs work' } });
  assert.ok(doc.output().startsWith('%PDF-'));
  assert.ok(doc.internal.pages.flat().join(' ').includes('Category data was not included in the analysis response.'));
  const filename = createReportFilename(sample);
  assert.match(filename, /^RepoLens-Health-Report-very-long-owner-name-that-should-wrap-cleanly-.*\.pdf$/);
  assert.ok(filename.length < 200);
});

test('rejects absent successful analysis data', () => {
  assert.throws(() => createHealthReport(null), /successful repository analysis/);
});
