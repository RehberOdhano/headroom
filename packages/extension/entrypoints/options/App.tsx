import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../lib/db.js';
import { redact } from '../../lib/redact.js';
import SettingsPanel from './Settings.tsx';

/**
 * Shows how many raw claude.ai captures are stored locally and lets you export them (ids and
 * free-text content redacted) as fixture JSON.
 *
 * Uses Dexie's `useLiveQuery` rather than a one-shot fetch: Dexie broadcasts writes across
 * same-origin contexts (via BroadcastChannel), so a capture written by the background service
 * worker updates this page immediately without a manual refresh or reopen.
 */
export default function App() {
  const records = useLiveQuery(() => db.rawRecords.orderBy('capturedAt').toArray(), []);

  if (records === undefined) {
    return (
      <main style={{ fontFamily: 'system-ui, sans-serif', padding: '1.5rem', maxWidth: 480 }}>
        <p>Loading…</p>
      </main>
    );
  }

  const counts = records.reduce<Record<string, number>>((acc, record) => {
    acc[record.endpoint] = (acc[record.endpoint] ?? 0) + 1;
    return acc;
  }, {});
  const lastCapturedAt = records.at(-1)?.capturedAt;

  function exportFixtures() {
    const redacted = records!.map((record) => ({
      endpoint: record.endpoint,
      capturedAt: record.capturedAt,
      raw: redact(record.raw),
    }));
    const blob = new Blob([JSON.stringify(redacted, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `headroom-fixtures-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '1.5rem', maxWidth: 480 }}>
      <h1 style={{ fontSize: '1.1rem' }}>Claude Usage Companion — captures</h1>
      <p>
        {records.length} raw capture{records.length === 1 ? '' : 's'} stored locally
        {Object.keys(counts).length > 0
          ? ` (${Object.entries(counts)
              .map(([endpoint, count]) => `${endpoint}: ${count}`)
              .join(', ')})`
          : ''}
        . Updates live as you use claude.ai — no need to reopen this page.
      </p>
      {lastCapturedAt && (
        <p style={{ color: '#666', fontSize: '0.9rem' }}>Last capture: {lastCapturedAt}</p>
      )}
      <button type="button" onClick={exportFixtures} disabled={records.length === 0}>
        Export fixtures
      </button>

      <SettingsPanel />
    </main>
  );
}
