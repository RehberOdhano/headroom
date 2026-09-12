import { describe, expect, it } from 'vitest';
import { resumeCommand } from '../lib/downloads.js';

describe('resumeCommand', () => {
  it('cds into the session\'s working directory before resuming', () => {
    expect(resumeCommand({ cwd: '/Users/x/project', sessionId: 'abc-123' })).toBe(
      'cd /Users/x/project && claude --resume abc-123',
    );
  });

  it('omits the cd when the working directory is unknown', () => {
    expect(resumeCommand({ cwd: null, sessionId: 'abc-123' })).toBe('claude --resume abc-123');
  });
});
