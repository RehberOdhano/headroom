import { describe, expect, it } from 'vitest';
import { RELEASE_NOTES, shouldShowReleaseNotes } from '../lib/release-notes.js';

const version = Object.keys(RELEASE_NOTES)[0]!;

describe('shouldShowReleaseNotes', () => {
  it('stays quiet on a fresh install (nothing recorded)', () => {
    expect(shouldShowReleaseNotes(undefined, version)).toBe(false);
  });
  it('shows after an update to a version with notes', () => {
    expect(shouldShowReleaseNotes('0.0.1', version)).toBe(true);
  });
  it('stays quiet when the version is unchanged or has no notes', () => {
    expect(shouldShowReleaseNotes(version, version)).toBe(false);
    expect(shouldShowReleaseNotes('0.0.1', '9.9.9')).toBe(false);
  });
});
