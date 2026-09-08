import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from './index.js';

describe('package scaffold', () => {
  it('exports a schema version', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});
