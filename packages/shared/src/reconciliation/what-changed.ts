/**
 * "What changed?" — comparative facts about local CLI activity and (optionally) server-observed
 * account usage, built from two already-reduced window summaries the caller provides. This file
 * never fetches or shapes raw data itself; it only decides which comparisons clear a
 * significance threshold and how to word the ones that do. Critically, the two windows it
 * compares must already represent *equal elapsed durations* — comparing a partial current week
 * against a prior week's full total would make every number look artificially smaller than
 * normal purely from less time having passed. Building that equal-elapsed pairing is the
 * caller's job (it needs real wall-clock/reset-boundary data this module deliberately doesn't
 * see); this module only ever trusts what it's given.
 */

export interface WindowUsageSummary {
  totalTokens: number;
  /** Project path -> tokens observed in this window. */
  projectTokens: Record<string, number>;
  /** Model name -> tokens observed in this window. */
  modelTokens: Record<string, number>;
  largestSession: { projectPath: string; tokens: number } | null;
}

/** Server-observed weekly-bar movement, in percentage points, over each window's own elapsed
 *  portion — e.g. "the bar has moved 14 points so far this window" vs "12 points over the same
 *  portion last window." Entirely separate from the CLI token figures above: this is the one
 *  SERVER-OBSERVED input, never conflated with the LOCALLY-OBSERVED ones. */
export interface AccountUsageMovement {
  currentPercentPoints: number;
  previousPercentPoints: number;
}

export interface WhatChangedFinding {
  kind: 'account-usage' | 'cli-volume' | 'project-share' | 'model-share' | 'largest-session';
  text: string;
}

/** A share swing below this many percentage points is noise ("48% -> 49%"), not a finding. */
const SHARE_CHANGE_THRESHOLD_PP = 10;
/** Below this share of the window's own total, "the largest contributor" isn't actually large. */
const MIN_SHARE_TO_MENTION_PERCENT = 15;
/** A token-volume swing below this relative change isn't worth a sentence. */
const VOLUME_CHANGE_THRESHOLD_RATIO = 0.15;
/** Below this many points of difference, two windows' account-usage movement reads as the same. */
const ACCOUNT_MOVEMENT_THRESHOLD_PP = 10;

function topShare(tokens: Record<string, number>, total: number): { key: string; sharePercent: number } | null {
  if (total <= 0) return null;
  let best: { key: string; sharePercent: number } | null = null;
  for (const [key, value] of Object.entries(tokens)) {
    const sharePercent = (value / total) * 100;
    if (!best || sharePercent > best.sharePercent) best = { key, sharePercent };
  }
  return best;
}

function dimensionFinding(
  kind: 'project-share' | 'model-share',
  current: Record<string, number>,
  currentTotal: number,
  previous: Record<string, number> | null,
  previousTotal: number,
): WhatChangedFinding | null {
  const currentTop = topShare(current, currentTotal);
  if (!currentTop) return null;

  if (previous && previousTotal > 0) {
    const previousShare = ((previous[currentTop.key] ?? 0) / previousTotal) * 100;
    const delta = currentTop.sharePercent - previousShare;
    if (Math.abs(delta) >= SHARE_CHANGE_THRESHOLD_PP) {
      const direction = delta > 0 ? 'increased' : 'decreased';
      return {
        kind,
        text: `${currentTop.key} share ${direction} from ${Math.round(previousShare)}% to ${Math.round(currentTop.sharePercent)}% compared with the same elapsed portion of the previous window.`,
      };
    }
  }

  if (currentTop.sharePercent >= MIN_SHARE_TO_MENTION_PERCENT) {
    return { kind, text: `${currentTop.key} represents ${Math.round(currentTop.sharePercent)}% of observed CLI activity this window.` };
  }
  return null;
}

function largestSessionFinding(current: WindowUsageSummary): WhatChangedFinding | null {
  if (!current.largestSession || current.totalTokens <= 0) return null;
  const sharePercent = (current.largestSession.tokens / current.totalTokens) * 100;
  if (sharePercent < MIN_SHARE_TO_MENTION_PERCENT) return null;
  return { kind: 'largest-session', text: `One session represents ${Math.round(sharePercent)}% of observed CLI activity.` };
}

function cliVolumeFinding(current: WindowUsageSummary, previous: WindowUsageSummary | null): WhatChangedFinding | null {
  if (!previous || previous.totalTokens <= 0) return null;
  const relative = (current.totalTokens - previous.totalTokens) / previous.totalTokens;
  if (Math.abs(relative) < VOLUME_CHANGE_THRESHOLD_RATIO) return null;
  const direction = relative > 0 ? 'up' : 'down';
  return {
    kind: 'cli-volume',
    text: `Observed CLI tokens ${direction} ${Math.round(Math.abs(relative) * 100)}% compared with the same elapsed portion of the previous window.`,
  };
}

function accountUsageFinding(movement: AccountUsageMovement | null): WhatChangedFinding | null {
  if (!movement) return null;
  const delta = movement.currentPercentPoints - movement.previousPercentPoints;
  if (Math.abs(delta) < ACCOUNT_MOVEMENT_THRESHOLD_PP) return null;
  const direction = delta > 0 ? 'faster' : 'slower';
  return {
    kind: 'account-usage',
    text: `Weekly usage has moved ${Math.round(movement.currentPercentPoints)} points so far this window — ${direction} than the ${Math.round(movement.previousPercentPoints)}-point move over the same portion of the previous window.`,
  };
}

/**
 * Returns only the findings that cleared their own significance threshold — an empty array when
 * nothing materially changed, never a filler "nothing much happened" entry. `previous: null`
 * (no comparable prior window — a fresh install, or a daemon younger than one weekly cycle)
 * silently drops every comparison-shaped finding, leaving only the current-window-only facts
 * (largest project/session, if either clears its own share floor).
 */
export function computeWhatChanged(
  current: WindowUsageSummary,
  previous: WindowUsageSummary | null,
  accountMovement: AccountUsageMovement | null = null,
): WhatChangedFinding[] {
  return [
    accountUsageFinding(accountMovement),
    cliVolumeFinding(current, previous),
    dimensionFinding('project-share', current.projectTokens, current.totalTokens, previous?.projectTokens ?? null, previous?.totalTokens ?? 0),
    dimensionFinding('model-share', current.modelTokens, current.totalTokens, previous?.modelTokens ?? null, previous?.totalTokens ?? 0),
    largestSessionFinding(current),
  ].filter((finding): finding is WhatChangedFinding => finding !== null);
}
