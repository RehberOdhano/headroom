import { correlateLocalActivity, type UsageInspectorResult } from '@headroom/shared';
import { getDaemonSessions } from './daemon-client.js';
import { formatCcusageDate, formatTokens } from './format.js';
import type { Settings } from './protocol.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Loads the real session data for a window and correlates it — see `correlateLocalActivity`'s
 * doc comment for the correlation-not-causation framing this is built on. The daemon's
 * `/sessions` route buckets by whole calendar days (ccusage's own `--since`/`--until`
 * granularity), so this asks for a day on either side of the real window and lets
 * `correlateLocalActivity` do the precise, timestamp-level overlap filtering.
 */
export async function loadUsageInspector(
  settings: Settings,
  windowStart: string,
  windowEnd: string,
): Promise<UsageInspectorResult | null> {
  const since = formatCcusageDate(new Date(new Date(windowStart).getTime() - DAY_MS));
  const until = formatCcusageDate(new Date(new Date(windowEnd).getTime() + DAY_MS));
  const sessions = await getDaemonSessions(settings, { since, until });
  if (!sessions.ok) return null;
  return correlateLocalActivity(sessions.data.sessions, windowStart, windowEnd);
}

/**
 * Wording rules are load-bearing here, not stylistic: "observed during this period", "largest
 * local contributor", "correlated local activity" — never "caused", "responsible for", or "this
 * session consumed X% of your weekly limit", since none of that is something this data can
 * actually support. A jump with no matching local activity is a valid, useful result on its own
 * — said explicitly, not glossed over.
 */
export function formatUsageInspectorFindings(result: UsageInspectorResult): string[] {
  if (!result.hasLocalActivity) {
    return [
      'Headroom did not observe local Claude Code activity matching this increase. Usage from claude.ai or other unobserved sources may have contributed.',
    ];
  }

  const lines: string[] = [];
  const topProject = result.projectShares[0];
  if (topProject) {
    lines.push(`Largest local contributor observed during this period: ${topProject.key} (${Math.round(topProject.sharePercent)}% of observed local activity).`);
  }
  if (result.modelShares.length > 0) {
    const modelText = result.modelShares.map((m) => `${m.key} ${Math.round(m.sharePercent)}%`).join(', ');
    lines.push(`Correlated local activity by model: ${modelText}.`);
  }
  if (result.largestSessions.length > 0) {
    const sessionText = result.largestSessions.map((s) => `${s.projectPath} (${formatTokens(s.tokens)})`).join(', ');
    lines.push(`Largest sessions observed during this period: ${sessionText}.`);
  }
  return lines;
}
