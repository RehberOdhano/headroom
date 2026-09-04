import type { DailyReport, ModelBreakdown } from './adapters/ccusage.schemas.js';

export interface ModelAggregate extends ModelBreakdown {}

/** Sums each model's breakdown across every daily entry. No separate ccusage call needed. */
export function aggregateByModel(report: DailyReport): ModelAggregate[] {
  const byModel = new Map<string, ModelAggregate>();

  for (const day of report.daily) {
    for (const breakdown of day.modelBreakdowns) {
      const existing = byModel.get(breakdown.modelName);
      if (!existing) {
        byModel.set(breakdown.modelName, { ...breakdown });
        continue;
      }
      existing.cacheCreationTokens += breakdown.cacheCreationTokens;
      existing.cacheReadTokens += breakdown.cacheReadTokens;
      existing.cost += breakdown.cost;
      existing.inputTokens += breakdown.inputTokens;
      existing.outputTokens += breakdown.outputTokens;
    }
  }

  return [...byModel.values()];
}
