import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { WhatChangedFinding } from '@headroom/shared';
import { db } from '../../../lib/db.js';
import { loadWhatChanged } from '../../../lib/what-changed.js';
import { PROVENANCE_LABEL } from '../../../lib/provenance.js';
import type { Settings } from '../../../lib/protocol.js';

/**
 * Comparative facts about this weekly window vs. the same elapsed portion of the previous one —
 * entirely derived, never shown at all when nothing clears its own significance threshold (see
 * `computeWhatChanged`'s doc comment). Renders nothing while loading or once settled on an empty
 * result, rather than a "Loading…"/"Nothing changed" placeholder — this section simply isn't
 * there when it has nothing real to say.
 */
export function WhatChanged({ settings }: { settings: Settings }) {
  const [findings, setFindings] = useState<WhatChangedFinding[]>([]);
  const allSnapshots = useLiveQuery(() => db.limitSnapshots.orderBy('capturedAt').toArray(), []);

  useEffect(() => {
    if (!allSnapshots) return;
    const latestWeekly = [...allSnapshots].reverse().find((s) => s.weekly)?.weekly;
    if (!latestWeekly) {
      setFindings([]);
      return;
    }
    const weeklyHistory = allSnapshots
      .filter((s) => s.weekly)
      .map((s) => ({ capturedAt: s.capturedAt, percent: s.weekly!.percent }));
    void loadWhatChanged(settings, latestWeekly.resetsAt, weeklyHistory).then(setFindings);
  }, [allSnapshots, settings.daemonUrl, settings.daemonToken]);

  if (findings.length === 0) return null;

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">What changed</h2>
      </div>
      {findings.map((finding) => (
        <p key={finding.kind} className="hint" title={finding.kind === 'account-usage' ? PROVENANCE_LABEL.server : PROVENANCE_LABEL.derived}>
          {finding.text}
        </p>
      ))}
    </section>
  );
}
