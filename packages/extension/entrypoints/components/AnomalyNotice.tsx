import type { ReactNode } from 'react';

/**
 * Shared presentational shell for an anomaly warning — used by both the dashboard's Overview
 * cards and the popup. Purely visual: callers own all wording (headline/note text), so the
 * "never imply causation" rule lives entirely at the call site (`describeUsageAnomaly`,
 * `BarSection`'s own anomaly text), not here.
 */
export function AnomalyNotice({
  headline,
  note,
  children,
  title,
}: {
  headline: string;
  note?: string | null;
  children?: ReactNode;
  /** Forwarded to the outer element — callers use this for a provenance tooltip. */
  title?: string;
}) {
  return (
    <div className="anomaly-notice" role="status" title={title}>
      <div className="anomaly-notice-header">
        <span className="anomaly-notice-icon" aria-hidden="true">
          ⚠
        </span>
        <p className="anomaly-notice-headline">{headline}</p>
      </div>
      {note && <p className="anomaly-notice-note">{note}</p>}
      {children && <div className="anomaly-notice-action">{children}</div>}
    </div>
  );
}
