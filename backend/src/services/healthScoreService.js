import { generateRecommendations } from './recommendationService.js';

export const CATEGORY_MAXIMUMS = Object.freeze({
  'Documentation Quality': 25,
  Maintenance: 25,
  'Repository Organization': 20,
  'Issue Management': 15,
  'Development Activity': 15,
});

function envThreshold(name, fallback, maximum) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

export const DEFAULT_THRESHOLDS = Object.freeze({
  staleAfterDays: envThreshold('HEALTH_STALE_AFTER_DAYS', 730, 3650),
  meaningfulReadmeCharacters: envThreshold('HEALTH_MEANINGFUL_README_CHARACTERS', 200, 10000),
});

export function healthStatusForScore(score) {
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new RangeError('Health score must be between 0 and 100.');
  if (score >= 80) return 'Healthy';
  if (score >= 60) return 'Moderate';
  if (score >= 40) return 'Needs Improvement';
  return 'Poor';
}

function daysSince(value, now) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 86_400_000) : null;
}

function category(name, maxPoints, earnedPoints, explanation, evidence, unavailableEvidence = [], calculation = []) {
  const boundedPoints = Math.max(0, Math.min(maxPoints, earnedPoints));
  return {
    name,
    maxPoints,
    earnedPoints: boundedPoints,
    percentage: Math.round((boundedPoints / maxPoints) * 100),
    explanation,
    evidence,
    unavailableEvidence,
    calculation,
  };
}

function collectionUnavailable(data, key) {
  if (data?.collectionAvailability && key in data.collectionAvailability) return data.collectionAvailability[key] === false;
  // Without explicit collection status, only treat a positive availability flag as evidence.
  return data?.dataAvailability?.[key] !== true;
}

function calc(criterion, maxPoints, earnedPoints, status, evidence) {
  return { criterion, maxPoints, earnedPoints, status, evidence };
}

/** Deterministic heuristic score. `now` and thresholds are injectable for reproducible tests. */
export function calculateHealthScore(data, { now = Date.now(), thresholds = {} } = {}) {
  if (!data || typeof data !== 'object' || !data.repository) throw new TypeError('Repository analysis data is required.');
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const repo = data.repository;
  const categories = [];
  const findings = [];
  const strengths = [];

  // Documentation (25): README presence/content 15, description 5, license 5.
  let docPoints = 0;
  const docEvidence = [];
  const docUnavailable = [];
  const docCalculation = [];
  if (collectionUnavailable(data, 'readme')) {
    docUnavailable.push('README retrieval unavailable');
    docCalculation.push(calc('README presence and content', 15, 0, 'unavailable', ['README endpoint did not return a usable result.']));
  } else if (data.dataAvailability?.readme === false || data.readme === null) {
    docEvidence.push('GitHub confirmed no README is available.');
    docCalculation.push(calc('README presence and content', 15, 0, 'confirmed_missing', ['GitHub README endpoint returned not found.']));
    findings.push({ code: 'missing_readme', message: 'No README is available.', evidence: 'GitHub README endpoint returned not found.' });
  } else if (data.readme?.content != null) {
    const chars = data.readme.content.replace(/\s/g, '').length;
    const points = chars >= limits.meaningfulReadmeCharacters ? 15 : chars > 0 ? 8 : 3;
    docPoints += points;
    docEvidence.push(`README content was retrieved (${chars} non-whitespace characters).`);
    docCalculation.push(calc('README presence and content', 15, points, 'scored', [`${chars} non-whitespace characters; threshold ${limits.meaningfulReadmeCharacters}.`]));
    if (chars >= limits.meaningfulReadmeCharacters) strengths.push('The repository has a substantive README.');
    else findings.push({ code: 'short_readme', message: 'The README has limited content.', evidence: `${chars} non-whitespace characters; meaningful-content threshold is ${limits.meaningfulReadmeCharacters}.` });
  } else {
    docUnavailable.push('README content was not available');
    docCalculation.push(calc('README presence and content', 15, 0, 'unavailable', ['README response did not contain readable content.']));
  }

  if (repo.description == null || repo.description.trim() === '') {
    docEvidence.push('Repository metadata contains no description.');
    docCalculation.push(calc('Repository description', 5, 0, 'confirmed_missing', ['GitHub repository description is empty.']));
    findings.push({ code: 'missing_description', message: 'No repository description is set.', evidence: 'GitHub repository description is empty.' });
  } else {
    docPoints += 5;
    docEvidence.push('Repository description is present.');
    docCalculation.push(calc('Repository description', 5, 5, 'scored', ['Description is present in repository metadata.']));
    strengths.push('The repository has a description.');
  }
  if (collectionUnavailable(data, 'license')) {
    docUnavailable.push('License retrieval unavailable');
    docCalculation.push(calc('License availability', 5, 0, 'unavailable', ['License endpoint could not be assessed.']));
  } else if (data.dataAvailability?.license === false || !data.license) {
    docEvidence.push('No license is listed in repository metadata or the license endpoint.');
    docCalculation.push(calc('License availability', 5, 0, 'confirmed_missing', ['Repository metadata and license endpoint contain no license.']));
    findings.push({ code: 'missing_license', message: 'No license information is available.', evidence: 'GitHub repository metadata and license endpoint contain no license.' });
  } else {
    docPoints += 5;
    docEvidence.push(`License identified: ${data.license.name ?? data.license.spdxId ?? data.license.key}.`);
    docCalculation.push(calc('License availability', 5, 5, 'scored', [`License identified: ${data.license.name ?? data.license.spdxId ?? data.license.key}.`]));
    strengths.push('A license is available.');
  }
  categories.push(category('Documentation Quality', 25, docPoints, 'README presence/content (15), repository description (5), and license (5). Unavailable evidence is marked separately and earns no points.', docEvidence, docUnavailable, docCalculation));

  // Maintenance is a heuristic: aging alone is not treated as proof of poor quality.
  const ageDays = daysSince(repo.pushedAt, now);
  if (ageDays == null) {
    categories.push(category('Maintenance', 25, 0, 'No valid latest-push date was provided.', [], ['Latest push date unavailable'], [calc('Push recency and repository context', 25, 0, 'unavailable', ['No valid pushedAt timestamp was available.'])]));
  } else {
    const repositoryAgeDays = daysSince(repo.createdAt, now);
    const longLived = repositoryAgeDays != null && repositoryAgeDays >= 1095;
    const stableSignal = longLived && ((repo.stars ?? 0) >= 1000 || (repo.forks ?? 0) >= 100);
    const points = ageDays <= 365 ? 25 : ageDays <= limits.staleAfterDays ? 19 : stableSignal ? 18 : 10;
    const evidence = [
      `Latest push was ${Math.floor(ageDays)} days ago.`,
      ...(repositoryAgeDays == null ? [] : [`Repository age is ${Math.floor(repositoryAgeDays)} days.`]),
      ...(stableSignal ? ['Long repository age and high stars/forks provide a possible stability signal.'] : []),
    ];
    if (ageDays > limits.staleAfterDays && !stableSignal) findings.push({ code: 'old_activity', message: 'The latest push is older than the maintenance threshold.', evidence: `${Math.floor(ageDays)} days since the latest push; threshold is ${limits.staleAfterDays} days.` });
    if (ageDays <= 365) strengths.push('The repository has recent maintenance activity.');
    categories.push(category('Maintenance', 25, points, stableSignal && ageDays > limits.staleAfterDays ? 'Older activity receives partial credit; repository age and popularity are contextual stability signals, not proof of maintenance.' : 'Score is based on the latest push date and a configurable age threshold.', evidence, [], [calc('Push recency and repository context', 25, points, 'scored', evidence)]));
  }

  // Organization rewards observable variety, not a particular framework layout.
  if (collectionUnavailable(data, 'rootFiles') || !Array.isArray(data.rootFiles)) {
    categories.push(category('Repository Organization', 20, 0, 'Root directory information was not available for assessment.', [], ['Root directory listing unavailable'], [calc('Root entry variety and project indicators', 20, 0, 'unavailable', ['The root listing could not be assessed.'])]));
  } else {
    const files = data.rootFiles;
    const hasFiles = files.length > 0;
    const kinds = new Set(files.map((file) => file.type).filter(Boolean));
    const hasDirectories = kinds.has('dir');
    const hasConfig = files.some((file) => /^(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|Makefile|\.github)$/i.test(file.name ?? ''));
    const points = !hasFiles ? 4 : Math.min(20, 8 + Math.min(5, files.length) + (hasDirectories ? 4 : 0) + (hasConfig ? 3 : 0));
    const evidence = [`GitHub returned ${files.length} root entries.`, `Directories present: ${hasDirectories}.`, `Recognizable project configuration present: ${hasConfig}.`];
    if (!hasFiles || files.length <= 2) findings.push({ code: 'limited_structure', message: 'The visible root listing has few organization indicators.', evidence: `${files.length} root entries were returned.` });
    else strengths.push('The root directory contains multiple organization indicators.');
    categories.push(category('Repository Organization', 20, points, 'Organization points reflect visible root entry variety and common configuration indicators; no fixed folder layout is required.', evidence, [], [calc('Root entry variety and project indicators', 20, points, 'scored', [`Entries: ${files.length}; directories: ${hasDirectories}; recognized configuration: ${hasConfig}.`])]));
  }

  // The state mix is a bounded sample, not a global backlog. Recent updates and closures provide context.
  if (collectionUnavailable(data, 'openIssues') || !Array.isArray(data.issueSample)) {
    categories.push(category('Issue Management', 15, 0, 'Issue statistics were unavailable; no issue-management score was inferred.', [], ['Issue sample unavailable'], [calc('Issue sample, closure, and update activity', 15, 0, 'unavailable', ['GitHub issue sample could not be assessed.'])]));
  } else {
    const sample = data.issueSample;
    const open = sample.filter((issue) => issue.state === 'open').length;
    const closed = sample.filter((issue) => issue.state === 'closed').length;
    const recentlyUpdated = sample.filter((issue) => {
      const age = daysSince(issue.updatedAt, now);
      return age != null && age <= 180;
    }).length;
    const datedIssueCount = sample.filter((issue) => daysSince(issue.updatedAt, now) != null).length;
    const evidence = [`Retrieved issue sample: ${sample.length} issues (${open} open, ${closed} closed); pull requests excluded.`, 'The API sample is capped at 100 and is not a repository-wide total.', 'GitHub repository open_issues_count is not used because that metadata count can include pull requests.'];
    const issueUnavailable = [];
    let points;
    let issueCalculation;
    if (sample.length === 0) {
      points = 12; // No issue backlog is observable; reserve points because management behavior cannot be evaluated.
      evidence.push('No issues were returned; this is neutral evidence, not proof of issue-triage quality.');
      issueCalculation = [calc('No open issue backlog observed', 15, 12, 'neutral', ['Zero issue records; 3 points reserved because no management history can be assessed.'])];
    } else {
      const closurePoints = Math.round(5 * closed / sample.length);
      const recencyPoints = datedIssueCount > 0 ? Math.round(5 * recentlyUpdated / datedIssueCount) : 0;
      const samplePoints = 5;
      points = samplePoints + closurePoints + recencyPoints;
      evidence.push(`${recentlyUpdated} of ${datedIssueCount} issues with available update dates were updated within 180 days.`);
      if (datedIssueCount < sample.length) issueUnavailable.push(`Update dates unavailable for ${sample.length - datedIssueCount} sampled issue(s)`);
      issueCalculation = [
        calc('Observable issue sample', 5, samplePoints, 'scored', [`${sample.length} issues returned.`]),
        calc('Closed issue share', 5, closurePoints, 'scored', [`${closed}/${sample.length} sampled issues are closed.`]),
        calc('Recent issue updates', 5, recencyPoints, datedIssueCount === 0 ? 'unavailable' : 'scored', [`${recentlyUpdated}/${datedIssueCount} issues with known update dates were updated within 180 days.`]),
      ];
      const staleOpen = sample.filter((issue) => issue.state === 'open' && (daysSince(issue.updatedAt, now) ?? 0) > 180);
      if (staleOpen.length >= 5 && staleOpen.length / sample.length >= 0.5) {
        findings.push({ code: 'stale_open_issues', message: 'Many sampled open issues have not been updated recently.', evidence: `${staleOpen.length} of ${sample.length} sampled issues are open and older than 180 days since update.` });
      }
      if (closed > 0 && recentlyUpdated > 0) strengths.push('The sampled issues show both closure and recent update activity.');
    }
    categories.push(category('Issue Management', 15, points, 'Scores sample availability, closure share, and update recency. The open count alone does not reduce points or imply poor management.', evidence, issueUnavailable, issueCalculation));
  }

  // Recent commits: distinguish missing endpoint data from an empty successful result.
  if (collectionUnavailable(data, 'recentCommits') || !Array.isArray(data.recentCommits)) {
    categories.push(category('Development Activity', 15, 0, 'Commit activity was unavailable; no activity score was inferred.', [], ['Recent commits unavailable'], [calc('Recent commit count and recency', 15, 0, 'unavailable', ['GitHub commit sample could not be assessed.'])]));
  } else {
    const latest = data.recentCommits[0]?.date;
    const commitAge = daysSince(latest, now);
    const count = data.recentCommits.length;
    const volumePoints = Math.round(Math.min(8, count * 1.6));
    const recencyPoints = commitAge == null ? 0 : commitAge <= 30 ? 7 : commitAge <= 90 ? 5 : commitAge <= 365 ? 3 : commitAge <= limits.staleAfterDays ? 1 : 0;
    const points = count === 0 ? 0 : volumePoints + recencyPoints;
    const evidence = count === 0 ? ['GitHub returned no recent commits.'] : [`GitHub returned ${count} commits (request capped at 5).`, ...(commitAge == null ? ['Latest commit date is unavailable.'] : [`Latest returned commit was ${Math.floor(commitAge)} days ago.`])];
    const activityUnavailable = count > 0 && commitAge == null ? ['Latest commit date unavailable'] : [];
    if (data.recentCommits.length === 0) findings.push({ code: 'no_recent_commits', message: 'No recent commits were returned.', evidence: 'GitHub commits endpoint returned an empty list.' });
    else if (commitAge != null && commitAge <= 365) strengths.push('Recent commits indicate visible development activity.');
    categories.push(category('Development Activity', 15, points, 'Combines commit sample size (up to 8 points) and latest commit recency (up to 7 points); a single recent commit cannot earn all points.', evidence, activityUnavailable, [
      calc('Recent commit sample size', 8, volumePoints, 'scored', [`${count} of up to 5 commits returned.`]),
      calc('Latest commit recency', 7, recencyPoints, count === 0 ? 'not_applicable' : commitAge == null ? 'unavailable' : 'scored', count === 0 ? ['No commits were returned.'] : commitAge == null ? ['Latest commit date unavailable.'] : [`Latest commit age: ${Math.floor(commitAge)} days.`]),
    ]));
  }

  const overallScore = Math.max(0, Math.min(100, categories.reduce((total, item) => total + item.earnedPoints, 0)));
  const status = healthStatusForScore(overallScore);
  const unavailableEvidence = categories.flatMap((item) => item.unavailableEvidence.map((evidence) => ({ category: item.name, evidence })));
  return {
    overallScore,
    status,
    categories,
    strengths: [...new Set(strengths)],
    weaknesses: findings.map(({ message, evidence }) => ({ issue: message, evidence })),
    recommendations: generateRecommendations(findings),
    partial: unavailableEvidence.length > 0,
    unavailableEvidence,
  };
}
