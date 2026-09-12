import { useState } from 'react';
import type { DaemonSearchMatch } from '@headroom/shared';
import { exportDaemonSession, searchDaemonSessions } from '../../../lib/daemon-client.js';
import { downloadMarkdown, resumeCommand } from '../../../lib/downloads.js';
import type { Settings } from '../../../lib/protocol.js';

const SEARCH_PAGE_SIZE = 10;

export function SessionSearch({ settings }: { settings: Settings }) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<DaemonSearchMatch[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function runSearch(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      // Submitting an empty query clears back to the pre-search state, rather than silently
      // leaving whatever the previous query's results were on screen — a cleared search bar
      // should mean a cleared result list, not a no-op.
      setSearched(false);
      setMatches([]);
      setHasMore(false);
      setError(null);
      return;
    }

    setSearched(true);
    setError(null);
    const result = await searchDaemonSessions(settings, trimmed, { limit: SEARCH_PAGE_SIZE, offset: 0 });
    if (!result.ok) {
      setError(result.message);
      setMatches([]);
      setHasMore(false);
      return;
    }
    setMatches(result.data.matches);
    setHasMore(result.data.hasMore);
  }

  async function loadMore(): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) return;

    setLoadingMore(true);
    try {
      const result = await searchDaemonSessions(settings, trimmed, { limit: SEARCH_PAGE_SIZE, offset: matches.length });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // Appends rather than replaces — this is a "load more" page, not a fresh search. A
      // duplicate could in principle appear if a session's lastActivity changed between the two
      // fetches and reordered it across the page boundary; sessionId as the list key means a
      // duplicate would just be a rendering no-op, not a crash.
      setMatches((current) => [...current, ...result.data.matches]);
      setHasMore(result.data.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }

  async function copyResumeCommand(match: DaemonSearchMatch): Promise<void> {
    await navigator.clipboard.writeText(resumeCommand(match));
    setCopiedId(match.sessionId);
    setTimeout(() => setCopiedId((current) => (current === match.sessionId ? null : current)), 2000);
  }

  async function exportMatch(match: DaemonSearchMatch): Promise<void> {
    const exported = await exportDaemonSession(settings, match.sessionId);
    if (exported.ok) downloadMarkdown(`${match.sessionId}.md`, exported.data);
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Search CLI sessions</h2>
      </div>
      <form className="search-form" onSubmit={runSearch}>
        <input
          className="search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search session content…"
        />
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
      {searched && !error && matches.length === 0 && <p className="hint">No matches.</p>}
      {matches.map((match) => (
        <div key={match.sessionId} className="result-card">
          <p className="result-snippet">{match.snippet}</p>
          <p className="result-meta">
            {match.cwd ?? 'unknown directory'} · {match.matchCount} match{match.matchCount === 1 ? '' : 'es'}
            {match.lastActivity && ` · last active ${new Date(match.lastActivity).toLocaleDateString()}`}
          </p>
          <div className="result-actions">
            <button type="button" className="btn" onClick={() => void copyResumeCommand(match)}>
              {copiedId === match.sessionId ? 'Copied!' : 'Copy resume command'}
            </button>
            <button type="button" className="btn" onClick={() => void exportMatch(match)}>
              Export markdown
            </button>
          </div>
        </div>
      ))}
      {hasMore && (
        <div className="search-pagination">
          <button type="button" className="btn" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </section>
  );
}
