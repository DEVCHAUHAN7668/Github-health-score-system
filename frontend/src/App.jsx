import { useState } from 'react';
import {
  Activity, AlertCircle, ArrowDownRight, ArrowRight, ArrowUpRight, BookOpen,
  Check, CircleHelp, Clock3, Code2, Download, ExternalLink, FileCode2,
  GitBranch, Github, Gauge, Lightbulb, LoaderCircle, Search, ShieldCheck,
  Sparkles, Star, TriangleAlert, X,
} from 'lucide-react';
import { analyzeRepository, parseRepositoryUrl } from './services/repositoryApi.js';
import { saveAnalysisHistory } from './services/localHistory.js';
import HistoryPanel from './components/HistoryPanel.jsx';

const formatNumber = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? new Intl.NumberFormat().format(Number(value)) : '—';
const formatDate = (value) => {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
};

function Sidebar({ view, onNavigate }) {
  const historyActive = view === 'history' || view === 'report';
  return <aside className="sidebar">
    <a className="brand" href="#top" aria-label="RepoLens home"><span className="brand-mark"><Gauge size={19} /></span><span>Repo<span className="brand-light">Lens</span></span></a>
    <div className="side-label">WORKSPACE</div>
    <nav className="side-nav" aria-label="Main navigation">
      <button className={`nav-item nav-button ${view === 'analyzer' ? 'active' : ''}`} type="button" onClick={() => onNavigate('analyzer')}><Activity size={17} /> Repository analyzer</button>
      <button className={`nav-item nav-button ${historyActive ? 'active' : ''}`} type="button" onClick={() => onNavigate('history')}><GitBranch size={17} /> Analysis history</button>
    </nav>
    <div className="sidebar-bottom"><div className="side-help-icon"><CircleHelp size={17} /></div><div><strong>Need a hand?</strong><span>Explore the project README</span></div><ArrowRight size={15} /></div>
  </aside>;
}

function Header({ view }) {
  const label = view === 'history' ? 'Analysis history' : view === 'report' ? 'Previous report' : 'Repository analyzer';
  return <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>{label}</strong></div><div className="topbar-right"><span className="api-status"><i /> API connected</span><a className="github-link" href="https://github.com" target="_blank" rel="noreferrer"><Github size={17} /> GitHub <ExternalLink size={13} /></a></div></header>;
}

function EmptyState() {
  return <section className="empty-state"><div className="empty-icon"><Search size={25} /></div><h2>Your repository insights start here</h2><p>Paste a public GitHub repository URL above to get a detailed snapshot of its health.</p><div className="empty-chips"><span><ShieldCheck size={14} /> Documentation</span><span><Activity size={14} /> Activity</span><span><Code2 size={14} /> Organization</span></div></section>;
}

function ErrorState({ error, onDismiss }) {
  const statusText = error.code === 'GITHUB_DNS_ERROR' ? 'The backend could not resolve GitHub.'
    : error.code === 'GITHUB_TLS_ERROR' ? 'The secure connection to GitHub failed.'
      : error.code === 'GITHUB_CONNECTION_REFUSED' ? 'The connection to GitHub was refused.'
        : error.code === 'GITHUB_NETWORK_ERROR' ? 'The backend could not connect to GitHub.'
          : error.code === 'GITHUB_TIMEOUT' ? 'GitHub did not respond before the request timed out.'
            : error.status === 400 ? 'Check the repository URL and try again.'
    : error.status === 403 ? 'GitHub denied this request. The API rate limit may be exhausted.'
      : error.status === 404 ? 'The repository could not be found or is not publicly accessible.'
        : error.status === 429 ? 'GitHub API rate limit reached.'
          : error.status === 502 ? 'The backend could not reach GitHub.'
            : error.status === 504 ? 'The GitHub request timed out.'
              : error.code === 'BACKEND_UNREACHABLE' ? 'The analyzer backend is unavailable.' : 'The analysis could not be completed.';
  return <div className="error-panel" role="alert"><div className="error-symbol"><TriangleAlert size={20} /></div><div className="error-copy"><strong>{statusText}</strong><p>{error.message}</p>{error.code && <code>{error.code}</code>}{error.causeCode && <p className="retry-time">Network detail: {error.causeCode}</p>}{error.retryAt && <p className="retry-time">Try again after {formatDate(error.retryAt)}.</p>}</div><button className="icon-button" onClick={onDismiss} aria-label="Dismiss error"><X size={17} /></button></div>;
}

function ScoreCard({ health, onDownload, canDownload }) {
  const score = typeof health?.overallScore === 'number' && Number.isFinite(health.overallScore) ? health.overallScore : null;
  const circumference = 2 * Math.PI * 47;
  const progress = score === null ? 0 : Math.max(0, Math.min(100, score));
  return <section className="score-card card">
    <div className="score-main"><div className="score-ring" style={{ '--progress': `${progress}%` }}><div className="ring-inner"><span className="score-value">{score ?? '—'}</span><span className="score-denom">/ 100</span></div><svg viewBox="0 0 110 110" aria-hidden="true"><circle className="ring-track" cx="55" cy="55" r="47" /><circle className="ring-progress" cx="55" cy="55" r="47" style={{ strokeDasharray: circumference, strokeDashoffset: circumference * (1 - progress / 100) }} /></svg></div>
      <div className="score-text"><div className="eyebrow">OVERALL HEALTH</div><h2>{health?.status || 'Score unavailable'}</h2><p>{health?.partial ? 'Some metrics were unavailable; this score is based on the data collected.' : 'Based on repository signals collected from GitHub.'}</p></div></div>
    <div className="score-actions"><div className="score-badge"><Sparkles size={15} /> Health snapshot</div>{canDownload && <button className="download-report" type="button" onClick={onDownload}><Download size={15} /> Download Health Report</button>}</div>
  </section>;
}

function CategoryScores({ categories = [] }) {
  return <section className="card categories-card"><div className="section-heading"><div><div className="eyebrow">HEALTH BREAKDOWN</div><h2>Category scores</h2></div><span className="count-pill">{categories.length} categories</span></div>
    {categories.length ? <div className="category-list">{categories.map((item, index) => {
      const percentage = typeof item.percentage === 'number' && Number.isFinite(item.percentage) ? Math.max(0, Math.min(100, item.percentage)) : null;
      const icons = [BookOpen, Clock3, FileCode2, AlertCircle, Activity];
      const Icon = icons[index % icons.length];
      return <article className="category-row" key={`${item.name}-${index}`}><span className={`category-icon tone-${index % 5}`}><Icon size={17} /></span><div className="category-content"><div className="category-title"><strong>{item.name}</strong><span>{item.earnedPoints ?? '—'}<i> / {item.maxPoints ?? '—'}</i></span></div><div className="progress-track"><span style={{ width: `${percentage ?? 0}%` }} /></div>{item.explanation && <p>{item.explanation}</p>}{Array.isArray(item.evidence) && item.evidence.length > 0 && <ul className="category-evidence">{item.evidence.map((evidence, evidenceIndex) => <li key={`${evidence}-${evidenceIndex}`}>{evidence}</li>)}</ul>}{Array.isArray(item.unavailableEvidence) && item.unavailableEvidence.length > 0 && <p className="unavailable-evidence">Unavailable: {item.unavailableEvidence.join('; ')}</p>}</div></article>;
    })}</div> : <p className="muted-text">Category breakdown was not returned by the API.</p>}</section>;
}

function RepositoryCard({ repository, license }) {
  if (!repository) return null;
  const fullName = repository.fullName || [repository.owner?.login, repository.name].filter(Boolean).join('/');
  const topics = Array.isArray(repository.topics) ? repository.topics : [];
  const details = [
    { label: 'Stars', value: formatNumber(repository.stars ?? repository.stargazers_count), icon: Star },
    { label: 'Forks', value: formatNumber(repository.forks ?? repository.forks_count), icon: GitBranch },
    { label: 'Open issues', value: formatNumber(repository.openIssuesCount ?? repository.openIssues ?? repository.open_issues_count), icon: AlertCircle },
    { label: 'Primary language', value: repository.language || 'Not specified', icon: Code2 },
  ];
  return <section className="card repository-card"><div className="section-heading"><div><div className="eyebrow">REPOSITORY</div><h2>About this project</h2></div>{repository.url && <a className="external-icon" href={repository.url} target="_blank" rel="noreferrer" aria-label="Open repository on GitHub"><ExternalLink size={17} /></a>}</div>
    <a className="repo-name" href={repository.url || '#'} target={repository.url ? '_blank' : undefined} rel="noreferrer"><Github size={17} /> {fullName || 'Repository'} <ExternalLink size={13} /></a>
    <p className="repo-description">{repository.description || 'No repository description provided.'}</p>
    {topics.length > 0 && <div className="topic-list">{topics.map(topic => <span key={topic}>{topic}</span>)}</div>}
    <div className="metadata-grid">{details.map(({ label, value, icon: Icon }) => <div className="metadata-item" key={label}><span><Icon size={14} /> {label}</span><strong>{value}</strong></div>)}</div>
    <div className="repo-footer"><span>Updated {formatDate(repository.updatedAt || repository.updated_at)}</span><span>License: {license?.name || repository.license?.name || 'Not detected'}</span></div>
  </section>;
}

function Findings({ health }) {
  const groups = [
    { title: 'Strengths', values: health?.strengths, icon: ArrowUpRight, className: 'strengths', empty: 'No strengths were reported.' },
    { title: 'Areas to improve', values: health?.weaknesses, icon: ArrowDownRight, className: 'weaknesses', empty: 'No weaknesses were reported.' },
    { title: 'Recommendations', values: health?.recommendations, icon: Lightbulb, className: 'recommendations', empty: 'No recommendations were reported.' },
  ];
  return <section className="findings-grid">{groups.map(group => <article className={`card finding-card ${group.className}`} key={group.title}><div className="finding-heading"><span><group.icon size={17} /></span><h3>{group.title}</h3></div>{Array.isArray(group.values) && group.values.length ? <ul>{group.values.map((value, index) => <li key={`${value?.issue || value?.message || value}-${index}`}>
    {typeof value === 'string' ? value : <><strong>{value?.issue || value?.message || 'Finding'}</strong>{value?.why && <p>{value.why}</p>}{value?.action && <p className="finding-action">Action: {value.action}</p>}{value?.priority && <span className="finding-priority">{value.priority} priority</span>}{value?.evidence && <p>Evidence: {Array.isArray(value.evidence) ? value.evidence.join('; ') : value.evidence}</p>}</>}
  </li>)}</ul> : <p className="muted-text">{group.empty}</p>}</article>)}</section>;
}

function Results({ data }) {
  const health = data?.health;
  const repository = data?.repository;
  const unavailable = health?.unavailableEvidence || data?.dataAvailability?.unavailable || [];
  const canDownload = Boolean(repository && health && typeof health.overallScore === 'number' && Number.isFinite(health.overallScore) && health.status);
  return <div className="results"><ScoreCard health={health} canDownload={canDownload} onDownload={async () => { const { downloadHealthReport } = await import('./services/healthReport.js'); downloadHealthReport(data); }} /><div className="dashboard-grid"><CategoryScores categories={health?.categories} /><RepositoryCard repository={repository} license={data?.license} /></div><Findings health={health} />
    {unavailable.length > 0 && <div className="availability-note"><AlertCircle size={16} /><span><strong>Some data was unavailable</strong> {Array.isArray(unavailable) ? unavailable.map(item => typeof item === 'string' ? item : [item.category, item.evidence].filter(Boolean).join(': ')).join(' · ') : String(unavailable)}</span></div>}
  </div>;
}

export default function App() {
  const [url, setUrl] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [validationMessage, setValidationMessage] = useState('');
  const [view, setView] = useState('analyzer');
  const [historySaveError, setHistorySaveError] = useState(null);

  function openHistoryReport(report) {
    setView('report');
    setData(report);
    setError(null);
    setHistorySaveError(null);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (isLoading) return;
    if (!parseRepositoryUrl(url)) {
      setData(null);
      setError(null);
      setValidationMessage('Enter a valid public GitHub repository URL, for example https://github.com/facebook/react');
      return;
    }
    setValidationMessage('');
    setError(null);
    setHistorySaveError(null);
    setData(null);
    setView('analyzer');
    setIsLoading(true);
    try {
      const result = await analyzeRepository(url.trim());
      setData(result);
      try {
        saveAnalysisHistory(result);
      } catch (saveError) {
        setHistorySaveError(saveError);
      }
    } catch (requestError) {
      setError(requestError);
    } finally {
      setIsLoading(false);
    }
  }

  return <div className="app-shell" id="top"><Sidebar view={view} onNavigate={setView} /><main className="main-area"><Header view={view} /><div className="page-content" id={view === 'analyzer' ? 'analyzer' : 'history'}>
    {view === 'history' && <HistoryPanel onOpen={openHistoryReport} />}
    {view === 'report' && <section className="previous-report"><button className="back-to-history" type="button" onClick={() => setView('history')}><ArrowRight size={15} /> Back to analysis history</button>{data && <Results data={data} />}</section>}
    {view === 'analyzer' && <>
    <div className="page-intro"><div><div className="eyebrow intro-eyebrow"><span className="sparkle-dot"><Sparkles size={13} /></span> REPOSITORY INTELLIGENCE</div><h1>Understand your repository<span>.</span></h1><p>A clear, evidence-based snapshot of project health with practical ways to improve.</p></div><div className="intro-note"><ShieldCheck size={17} /><span>Public repositories<br /><strong>Read-only analysis</strong></span></div></div>
    <section className="analyze-card" aria-labelledby="analyze-heading"><div className="analyze-card-heading"><div className="input-icon"><Github size={19} /></div><div><h2 id="analyze-heading">Analyze a repository</h2><p>Start with a public GitHub repository URL</p></div></div>
      <form className="analyze-form" onSubmit={handleSubmit} noValidate><label className="sr-only" htmlFor="repository-url">GitHub repository URL</label><div className={`url-field ${validationMessage ? 'invalid' : ''}`}><Github size={18} /><input id="repository-url" type="url" autoComplete="url" placeholder="https://github.com/owner/repository" value={url} onChange={event => { setUrl(event.target.value); setValidationMessage(''); }} aria-invalid={Boolean(validationMessage)} aria-describedby={validationMessage ? 'url-error' : undefined} /><button type="submit" disabled={isLoading}>{isLoading ? <><LoaderCircle size={16} className="spin" /> Analyzing</> : <>Analyze repository <ArrowRight size={16} /></>}</button></div>{validationMessage && <span className="validation-message" id="url-error">{validationMessage}</span>}</form>
      <div className="form-footnote"><Check size={13} /> No code is cloned or modified <span /> Powered by GitHub REST API</div>
    </section>
    {isLoading && <div className="loading-card"><span className="loader-orbit"><LoaderCircle size={25} className="spin" /></span><div><strong>Gathering repository signals</strong><p>Fetching metadata and available health indicators from GitHub…</p></div></div>}
    {!isLoading && error && <ErrorState error={error} onDismiss={() => setError(null)} />}
    {!isLoading && !error && data && <>{historySaveError && <div className="availability-note" role="alert"><AlertCircle size={16} /><span><strong>Analysis succeeded, but it was not saved to this browser.</strong> {historySaveError.message}</span></div>}<Results data={data} /></>}
    {!isLoading && !error && !data && <EmptyState />}
    </>}
    <footer className="page-footer"><span>RepoLens <i>·</i> Repository health analyzer</span><span>Built for clearer open source insights</span></footer>
  </div></main></div>;
}
