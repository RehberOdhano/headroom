import type { ClaudeConfigSnapshot, PermissionEffect, SettingsLayer } from '@headroom/shared';

/** Case-insensitive substring match across any number of fields — an empty query matches
 *  everything. Shared by every filter box in the Guardrails tab (Permissions, known-risky
 *  commands, Hooks, Skills, Subagents, Project health) rather than one ad-hoc copy per section. */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((field) => field?.toLowerCase().includes(q));
}

export function findInLayer(layer: SettingsLayer | null, pattern: string): PermissionEffect | null {
  if (!layer) return null;
  if (layer.deny.includes(pattern)) return 'deny';
  if (layer.ask.includes(pattern)) return 'ask';
  if (layer.allow.includes(pattern)) return 'allow';
  return null;
}

export type EffectiveLayer = 'local' | 'project' | 'global';

/** More-specific layers win: local overrides project, which overrides global — same precedence
 *  Claude Code itself applies. Within one layer, deny > ask > allow, though in practice a
 *  well-formed file never lists the same pattern under two effects at once. */
export function resolveEffective(
  snapshot: ClaudeConfigSnapshot,
  pattern: string,
): { effect: PermissionEffect; layer: EffectiveLayer } | null {
  const local = findInLayer(snapshot.local, pattern);
  if (local) return { effect: local, layer: 'local' };
  const project = findInLayer(snapshot.project, pattern);
  if (project) return { effect: project, layer: 'project' };
  const global = findInLayer(snapshot.global, pattern);
  if (global) return { effect: global, layer: 'global' };
  return null;
}
