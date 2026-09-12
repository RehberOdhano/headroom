import type { PermissionEffect } from '@headroom/shared';

export const EFFECTS: PermissionEffect[] = ['allow', 'ask', 'deny'];

export function effectLabel(effect: PermissionEffect): string {
  return effect === 'allow' ? 'Allow' : effect === 'ask' ? 'Ask' : 'Deny';
}

/** Small inline SVGs, not a new icon-library dependency, for the three override buttons in the
 *  known-risky-commands table — icon-only saves real width over "Override: Allow/Ask/Deny" ×3
 *  per row. Each consuming button still carries a text `title`/`aria-label`, so this is a visual
 *  compaction, not an accessibility regression — `aria-hidden` here because the button itself
 *  already names the action. */
function AllowIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AskIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M5.7 6.1a2.3 2.3 0 1 1 3.3 2.1c-.7.35-1.1.9-1.1 1.55v.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="12.2" r="0.95" fill="currentColor" />
    </svg>
  );
}

function DenyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function effectIcon(effect: PermissionEffect) {
  return effect === 'allow' ? <AllowIcon /> : effect === 'ask' ? <AskIcon /> : <DenyIcon />;
}
