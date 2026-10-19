import { jsPDF } from 'jspdf';

const safeText = (value, fallback = 'Not available') => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
};

function formatFinding(item) {
  if (typeof item === 'string') return [item];
  if (!item || typeof item !== 'object') return [];
  return [item.issue || item.message, item.why, item.action && `Recommended action: ${item.action}`, item.priority && `Priority: ${item.priority}`, item.evidence && `Evidence: ${Array.isArray(item.evidence) ? item.evidence.join('; ') : item.evidence}`].filter(Boolean).map(String);
}

export function createHealthReport(data, { generatedAt = new Date() } = {}) {
  if (!data?.repository || !data?.health) throw new TypeError('A successful repository analysis is required to create the report.');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: false });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 18;
  const contentWidth = pageWidth - margin * 2;
  let y = 20;

  const addPageIfNeeded = (height = 10) => {
    if (y + height > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };
  const writeLines = (text, { size = 10, color = [58, 72, 96], weight = 'normal', indent = 0, gap = 1.5 } = {}) => {
    doc.setFont('helvetica', weight);
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(safeText(text), contentWidth - indent);
    for (const line of lines) {
      addPageIfNeeded(size * 0.4 + gap + 1);
      doc.text(line, margin + indent, y);
      y += size * 0.4 + gap;
    }
  };
  const section = (title) => {
    y += 4;
    addPageIfNeeded(15);
    doc.setDrawColor(225, 231, 241);
    doc.line(margin, y, pageWidth - margin, y);
    y += 8;
    writeLines(title, { size: 13, color: [30, 48, 81], weight: 'bold', gap: 3 });
  };
  const bullet = (text, options) => writeLines(`• ${safeText(text)}`, { ...options, indent: 3, gap: 1.3 });

  const repository = data.repository;
  const urlParts = (() => {
    try {
      const parts = new URL(repository.url).pathname.split('/').filter(Boolean);
      return parts.length >= 2 ? parts : [];
    } catch {
      return [];
    }
  })();
  const fullName = safeText(repository.fullName, [repository.owner?.login || urlParts[0], repository.name || urlParts[1]].filter(Boolean).join('/') || 'Repository');
  const [ownerFromFullName, nameFromFullName] = fullName.includes('/') ? fullName.split('/', 2) : ['', fullName];
  const owner = safeText(repository.owner?.login || ownerFromFullName || urlParts[0], 'Not available');
  const name = safeText(repository.name || nameFromFullName || urlParts[1], 'Not available');
  const analysisTime = data.metadata?.analyzedAt ? new Date(data.metadata.analyzedAt) : generatedAt;
  const analysisDate = Number.isNaN(analysisTime.getTime()) ? generatedAt : analysisTime;
  const score = typeof data.health.overallScore === 'number' && Number.isFinite(data.health.overallScore) ? data.health.overallScore : 'Unavailable';

  doc.setFillColor(239, 243, 255);
  doc.roundedRect(margin, y - 5, contentWidth, 33, 3, 3, 'F');
  writeLines('RepoLens', { size: 10, color: [89, 106, 197], weight: 'bold', gap: 2 });
  writeLines('Repository Health Report', { size: 20, color: [22, 38, 68], weight: 'bold', gap: 4 });
  writeLines(fullName, { size: 11, color: [86, 103, 143], weight: 'normal', gap: 2 });
  y += 3;

  section('Repository details');
  writeLines(`Owner: ${owner}`);
  writeLines(`Repository: ${name}`);
  writeLines(`URL: ${safeText(repository.url)}`);
  writeLines(`Analysis date and time: ${analysisDate.toLocaleString()}`);

  section('Overall health');
  writeLines(`${score} / 100 — ${safeText(data.health.status, 'Status unavailable')}`, { size: 15, color: [66, 88, 190], weight: 'bold', gap: 3 });
  if (data.health.partial === true) writeLines('This is a partial analysis because some data was unavailable.', { size: 9, color: [145, 104, 41] });

  section('Category breakdown');
  if (Array.isArray(data.health.categories) && data.health.categories.length) {
    data.health.categories.forEach((category) => {
      writeLines(`${safeText(category.name, 'Unnamed category')} — ${safeText(category.earnedPoints, 'Unavailable')} / ${safeText(category.maxPoints, 'Unavailable')} points`, { size: 10, color: [33, 51, 84], weight: 'bold', gap: 2 });
      if (category.explanation) writeLines(`Explanation: ${category.explanation}`, { size: 9 });
      if (Array.isArray(category.evidence) && category.evidence.length) category.evidence.forEach((item) => bullet(`Evidence: ${item}`, { size: 9, color: [83, 97, 120] }));
      if (Array.isArray(category.unavailableEvidence) && category.unavailableEvidence.length) category.unavailableEvidence.forEach((item) => bullet(`Unavailable evidence: ${item}`, { size: 9, color: [145, 104, 41] }));
      y += 2;
    });
  } else writeLines('Category data was not included in the analysis response.');

  [
    ['Strengths', data.health.strengths],
    ['Weaknesses', data.health.weaknesses],
    ['Improvement recommendations', data.health.recommendations],
  ].forEach(([title, values]) => {
    section(title);
    if (!Array.isArray(values) || values.length === 0) {
      writeLines('None were returned by the analysis.', { size: 9, color: [112, 126, 149] });
      return;
    }
    values.forEach((item) => {
      const lines = formatFinding(item);
      if (lines.length) lines.forEach((line, index) => bullet(line, { size: index === 0 ? 9.5 : 8.5, color: index === 0 ? [58, 72, 96] : [112, 126, 149] }));
    });
  });

  section('Methodology and limitations');
  writeLines('The report uses the category scores, evidence, and findings returned by RepoLens for this analysis. The overall score is the sum of the backend-calculated category points, bounded by the backend scoring rules.', { size: 9 });
  writeLines('The analysis reflects repository information available through the GitHub REST API at the analysis time. API samples may be limited, optional fields may be unavailable, and this report is not a full source-code audit.', { size: 9 });

  return doc;
}

export function createReportFilename(data) {
  let urlParts = [];
  try {
    urlParts = new URL(data?.repository?.url).pathname.split('/').filter(Boolean);
  } catch {
    // The filename falls back to available repository fields below.
  }
  const fullName = data?.repository?.fullName || [data?.repository?.owner?.login || urlParts[0], data?.repository?.name || urlParts[1]].filter(Boolean).join('/') || 'repository';
  const [owner = 'owner', repository = 'repository'] = fullName.split('/');
  const safePart = (value) => String(value).normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'repository';
  return `RepoLens-Health-Report-${safePart(owner)}-${safePart(repository)}.pdf`;
}

export function downloadHealthReport(data) {
  createHealthReport(data).save(createReportFilename(data));
}
