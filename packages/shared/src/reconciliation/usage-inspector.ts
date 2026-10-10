/**
 * Correlates local Claude Code CLI sessions against a time window — the "WHAT local activity
 * occurred during this interval" half of the Usage Inspector. This is correlation, never
 * causation: a session overlapping the window is reported as locally-observed activity during
 * that period, never as having "caused" or being "responsible for" any account-level usage
 * change. claude.ai web-chat usage in the same window is real and entirely invisible to this —
 * `hasLocalActivity: false` is itself a valid, useful result, not an error case to special-case
 * away.
 */

export interface SessionOverlapInput {
  sessionId: string;
  projectPath: string;
  firstActivity: string;
  lastActivity: string;
  totalTokens: number;
  modelBreakdowns: { modelName: string; inputTokens: number; outputTokens: number }[];
}

export interface ShareOf {
  key: string;
  tokens: number;
  sharePercent: number;
}

export interface UsageInspectorResult {
  windowStart: string;
  windowEnd: string;
  hasLocalActivity: boolean;
  totalObservedTokens: number;
  /** Sorted descending by share — the largest contributor first. */
  projectShares: ShareOf[];
  modelShares: ShareOf[];
  /** Up to the 3 largest overlapping sessions by token volume. */
  largestSessions: { sessionId: string; projectPath: string; tokens: number }[];
}

const MAX_LARGEST_SESSIONS = 3;

function sessionOverlaps(session: SessionOverlapInput, startMs: number, endMs: number): boolean {
  const sessionStart = new Date(session.firstActivity).getTime();
  const sessionEnd = new Date(session.lastActivity).getTime();
  return sessionStart <= endMs && sessionEnd >= startMs;
}

function sharesFromTotals(totals: Map<string, number>, grandTotal: number): ShareOf[] {
  return [...totals.entries()]
    .map(([key, tokens]) => ({ key, tokens, sharePercent: grandTotal > 0 ? (tokens / grandTotal) * 100 : 0 }))
    .sort((a, b) => b.tokens - a.tokens);
}

export function correlateLocalActivity(
  sessions: SessionOverlapInput[],
  windowStart: string,
  windowEnd: string,
): UsageInspectorResult {
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();
  const overlapping = sessions.filter((s) => sessionOverlaps(s, startMs, endMs));

  const totalObservedTokens = overlapping.reduce((sum, s) => sum + s.totalTokens, 0);
  const projectTotals = new Map<string, number>();
  const modelTotals = new Map<string, number>();
  for (const session of overlapping) {
    projectTotals.set(session.projectPath, (projectTotals.get(session.projectPath) ?? 0) + session.totalTokens);
    for (const model of session.modelBreakdowns) {
      modelTotals.set(model.modelName, (modelTotals.get(model.modelName) ?? 0) + model.inputTokens + model.outputTokens);
    }
  }

  return {
    windowStart,
    windowEnd,
    hasLocalActivity: overlapping.length > 0,
    totalObservedTokens,
    projectShares: sharesFromTotals(projectTotals, totalObservedTokens),
    modelShares: sharesFromTotals(modelTotals, totalObservedTokens),
    largestSessions: [...overlapping]
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, MAX_LARGEST_SESSIONS)
      .map((s) => ({ sessionId: s.sessionId, projectPath: s.projectPath, tokens: s.totalTokens })),
  };
}
