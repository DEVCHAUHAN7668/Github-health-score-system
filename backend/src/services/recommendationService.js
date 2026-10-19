/** Build recommendations only from findings supported by retrieved GitHub data. */
export function generateRecommendations(findings) {
  const actions = {
    missing_readme: {
      why: 'A README helps visitors understand and use the project.',
      action: 'Add a README describing the project purpose, setup, and usage.',
      priority: 'High',
    },
    short_readme: {
      why: 'The available README contains little explanatory content.',
      action: 'Expand the README with setup, usage, and contribution details.',
      priority: 'Medium',
    },
    missing_description: {
      why: 'The repository page does not summarize the project.',
      action: 'Add a concise repository description on GitHub.',
      priority: 'Low',
    },
    missing_license: {
      why: 'Visitors cannot determine the terms for reusing the project.',
      action: 'Review and add an appropriate license if the project is intended for reuse.',
      priority: 'Medium',
    },
    old_activity: {
      why: 'The latest push is older than the configured maintenance threshold.',
      action: 'Review the project maintenance status and update it if it is still active.',
      priority: 'Low',
    },
    limited_structure: {
      why: 'The retrieved root listing shows very few organization indicators.',
      action: 'Consider adding a structure appropriate to the project, such as source, tests, or contribution guidance.',
      priority: 'Low',
    },
    stale_open_issues: {
      why: 'Several sampled open issues have not been updated for more than 180 days.',
      action: 'Review the stale open issues and close, update, or triage them where appropriate.',
      priority: 'Medium',
    },
    no_recent_commits: {
      why: 'No commits were returned by the recent-commit request.',
      action: 'Review whether development is active or the repository is intentionally stable.',
      priority: 'Low',
    },
  };

  return findings.map((finding) => {
    const action = actions[finding.code];
    if (!action) return null;
    return {
      issue: finding.message,
      why: action.why,
      action: action.action,
      priority: action.priority,
      evidence: finding.evidence,
    };
  }).filter(Boolean);
}
