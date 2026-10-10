import {
  computeWhatChanged,
  type AccountUsageMovement,
  type WhatChangedFinding,
  type WindowUsageSummary,
} from '@headroom/shared';
import { getDaemonByModel, getDaemonByProject, getDaemonDaily, getDaemonSessions } from './daemon-client.js';
import { formatCcusageDate } from './format.js';
import type { Settings } from './protocol.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface SimpleRange {
  since: string;
  until: string;
}

async function fetchWindowUsageSummary(settings: Settings, range: SimpleRange): Promise<WindowUsageSummary | null> {
  const [daily, byProject, byModel, sessions] = await Promise.all([
    getDaemonDaily(settings, range),
    getDaemonByProject(settings, range),
    getDaemonByModel(settings, range),
    getDaemonSessions(settings, range),
  ]);
  if (!daily.ok) return null;

  const projectTokens: Record<string, number> = {};
  if (byProject.ok) {
    for (const [project, days] of Object.entries(byProject.data.projects)) {
      projectTokens[project] = days.reduce((sum, d) => sum + d.totalTokens, 0);
    }
  }

  const modelTokens: Record<string, number> = {};
  if (byModel.ok) {
    for (const model of byModel.data.models) modelTokens[model.modelName] = model.inputTokens + model.outputTokens;
  }

  let largestSession: WindowUsageSummary['largestSession'] = null;
  if (sessions.ok) {
    for (const session of sessions.data.sessions) {
      if (!largestSession || session.totalTokens > largestSession.tokens) {
        largestSession = { projectPath: session.projectPath, tokens: session.totalTokens };
      }
    }
  }

  return { totalTokens: daily.data.totals.totalTokens, projectTokens, modelTokens, largestSession };
}

/** The latest known weekly-bar percent at or before `timestampMs` — the nearest preceding
 *  snapshot, since captures are sampled periodically rather than continuous. `null` when no
 *  snapshot that old exists (e.g. an account younger than the window being asked about). */
function percentAtOrBefore(history: { capturedAt: string; percent: number }[], timestampMs: number): number | null {
  let best: { capturedAt: string; percent: number } | null = null;
  for (const point of history) {
    const pointMs = new Date(point.capturedAt).getTime();
    if (pointMs <= timestampMs && (!best || pointMs > new Date(best.capturedAt).getTime())) best = point;
  }
  return best?.percent ?? null;
}

/**
 * Builds the "what changed" findings for the weekly window: the current elapsed portion of this
 * week against the *same elapsed duration* of the preceding week — never a partial week against
 * a full one. `weeklyHistory` only needs to cover `percent`/`capturedAt` for the weekly bar; the
 * account-usage-movement finding is silently omitted (not a crash) if history doesn't reach far
 * enough back to cover the previous window.
 */
export async function loadWhatChanged(
  settings: Settings,
  weeklyResetsAt: string,
  weeklyHistory: { capturedAt: string; percent: number }[],
  now: Date = new Date(),
): Promise<WhatChangedFinding[]> {
  const windowStart = new Date(new Date(weeklyResetsAt).getTime() - WEEK_MS);
  const previousWindowStart = new Date(windowStart.getTime() - WEEK_MS);
  const elapsedMs = now.getTime() - windowStart.getTime();
  const previousWindowEnd = new Date(previousWindowStart.getTime() + elapsedMs);

  const [current, previous] = await Promise.all([
    fetchWindowUsageSummary(settings, { since: formatCcusageDate(windowStart), until: formatCcusageDate(now) }),
    fetchWindowUsageSummary(settings, {
      since: formatCcusageDate(previousWindowStart),
      until: formatCcusageDate(previousWindowEnd),
    }),
  ]);
  if (!current) return [];

  const currentPercentPoints = percentAtOrBefore(weeklyHistory, now.getTime());
  const windowStartPercent = percentAtOrBefore(weeklyHistory, windowStart.getTime()) ?? 0;
  const previousWindowStartPercent = percentAtOrBefore(weeklyHistory, previousWindowStart.getTime());
  const previousWindowEndPercent = percentAtOrBefore(weeklyHistory, previousWindowEnd.getTime());

  let accountMovement: AccountUsageMovement | null = null;
  if (currentPercentPoints !== null && previousWindowStartPercent !== null && previousWindowEndPercent !== null) {
    accountMovement = {
      currentPercentPoints: currentPercentPoints - windowStartPercent,
      previousPercentPoints: previousWindowEndPercent - previousWindowStartPercent,
    };
  }

  return computeWhatChanged(current, previous, accountMovement);
}
