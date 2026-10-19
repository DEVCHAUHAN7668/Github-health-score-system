import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, Clock3, ExternalLink, Github, RotateCw, Trash2 } from 'lucide-react';
import { clearAnalysisHistory, deleteAnalysisHistoryEntry, loadAnalysisHistory } from '../services/localHistory.js';

function dateLabel(value) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export default function HistoryPanel({ onOpen }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    try {
      setRecords(loadAnalysisHistory());
    } catch (loadError) {
      setError(loadError);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function remove(id) {
    try {
      setRecords(deleteAnalysisHistoryEntry(id));
      setError(null);
    } catch (deleteError) {
      setError(deleteError);
    }
  }

  function clear() {
    try {
      clearAnalysisHistory();
      setRecords([]);
      setError(null);
    } catch (clearError) {
      setError(clearError);
    }
  }

  return <section className="history-panel">
    <div className="history-heading"><div><div className="eyebrow">SAVED ANALYSES</div><h2>Analysis history</h2><p>Reports are saved in this browser only.</p></div><div className="history-actions"><button className="history-refresh" type="button" onClick={load} disabled={loading}><RotateCw size={15} className={loading ? 'spin' : ''} /> Refresh</button><button className="history-clear" type="button" onClick={clear} disabled={loading}><Trash2 size={15} /> Clear history</button></div></div>
    {loading && <div className="history-state"><RotateCw size={22} className="spin" /><strong>Loading saved analyses…</strong></div>}
    {!loading && error && <div className="history-state history-error" role="alert"><AlertCircle size={19} /><div><strong>Could not access analysis history</strong><p>{error.message}</p>{error.code && <code>{error.code}</code>}</div><button type="button" onClick={load}>Try again</button></div>}
    {!loading && !error && records.length === 0 && <div className="history-state history-empty"><Clock3 size={22} /><strong>No saved analyses yet</strong><p>Analyze a repository to create your first history record.</p></div>}
    {!loading && !error && records.length > 0 && <div className="history-table-wrap"><div className="history-table-head"><span>REPOSITORY</span><span>HEALTH SCORE</span><span>STATUS</span><span>ANALYZED</span><span /></div>{records.map((record) => <article className="history-row" key={record.id}><div className="history-repo"><span className="history-github"><Github size={16} /></span><div><strong>{record.owner}/{record.name}</strong><a href={record.url} target="_blank" rel="noreferrer">View on GitHub <ExternalLink size={11} /></a></div></div><strong className="history-score">{Number.isFinite(record.overallScore) ? `${record.overallScore}/100` : '—'}</strong><span className={`history-status ${String(record.status || '').toLowerCase().replace(/\s+/g, '-')}`}>{record.status || 'Unavailable'}</span><time className="history-date" dateTime={record.analyzedAt}>{dateLabel(record.analyzedAt)}</time><div className="history-row-actions"><button className="history-open" type="button" onClick={() => onOpen(record.report)} aria-label={`Open report for ${record.owner}/${record.name}`}><span>Open report</span><ArrowRight size={15} /></button><button className="history-delete" type="button" onClick={() => remove(record.id)} aria-label={`Delete saved report for ${record.owner}/${record.name}`} title="Delete report"><Trash2 size={15} /></button></div></article>)}</div>}
  </section>;
}
