import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../lib/db.js';
import type { DaemonHealth, Settings } from '../../lib/protocol.js';
import { styles } from './styles.ts';

interface ChecklistItem {
  label: string;
  done: boolean;
  shown: boolean;
}

/**
 * A partially-set-up install today just shows empty tabs with no unifying explanation —
 * `background.ts`'s `pollUsage()` already has a doc comment flagging "no org id known yet
 * (open claude.ai's Settings > Usage once)" as a real, currently-invisible gap. This surfaces that (and the other
 * silent prerequisites) as a plain checklist, informational only — never a blocking gate — and
 * disappears once everything is done so it doesn't linger as clutter for an already-working
 * install.
 */
export function SetupChecklist({ settings, daemonHealth }: { settings: Settings; daemonHealth: DaemonHealth | null }) {
  // Resolved to a boolean inside the query itself, not left as the raw `get()`/`count()` result
  // — `db.meta.get()` on a genuinely-missing key resolves to `undefined`, the same value
  // `useLiveQuery` uses to mean "hasn't resolved yet", so checking the raw result for
  // `=== undefined` could never tell "not visited yet" apart from "still loading" and would
  // permanently hide this section for the exact case it exists to flag.
  const visitedClaudeAi = useLiveQuery(async () => Boolean(await db.meta.get('orgId')), []);
  const capturedSnapshot = useLiveQuery(async () => (await db.limitSnapshots.count()) > 0, []);

  const daemonPaired = Boolean(settings.daemonToken);

  const items: ChecklistItem[] = [
    { label: 'Opened Settings → Usage on claude.ai once, so headroom can detect your account', done: visitedClaudeAi === true, shown: true },
    { label: 'First usage snapshot captured', done: capturedSnapshot === true, shown: true },
    { label: 'Local daemon paired (optional — unlocks CLI attribution & search)', done: daemonPaired, shown: true },
    { label: 'Daemon reachable right now', done: daemonHealth?.ok === true, shown: daemonPaired },
  ];
  const visible = items.filter((item) => item.shown);
  const doneCount = visible.filter((item) => item.done).length;

  if (visitedClaudeAi === undefined || capturedSnapshot === undefined) return null; // still loading
  if (doneCount === visible.length) return null; // fully set up — nothing to flag

  return (
    <section style={styles.section}>
      <h2 style={styles.heading}>
        Setup status ({doneCount}/{visible.length})
      </h2>
      <ul style={styles.checklist}>
        {visible.map((item) => (
          <li key={item.label} style={styles.checklistItem}>
            <span style={item.done ? styles.checklistDone : styles.checklistPending}>{item.done ? '✓' : '○'}</span>{' '}
            {item.label}
          </li>
        ))}
      </ul>
    </section>
  );
}
