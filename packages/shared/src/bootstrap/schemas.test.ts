import { describe, expect, it } from 'vitest';
import { bootstrapResultSchema, projectDetectionResponseSchema } from './schemas.js';

describe('bootstrapResultSchema', () => {
  it('parses a full result', () => {
    const parsed = bootstrapResultSchema.parse({
      createdFolder: true,
      createdFiles: ['CLAUDE.md', 'package.json'],
      skippedFiles: [],
      scaffoldSkipped: false,
      gitInitialized: true,
      verification: [{ command: 'pnpm install', ok: true, output: '' }],
      inferredStack: 'node-typescript',
    });
    expect(parsed.createdFiles).toHaveLength(2);
    expect(parsed.verification).toHaveLength(1);
    expect(parsed.inferredStack).toBe('node-typescript');
  });

  it('defaults every field for a daemon that has not restarted since this route (or this field) shipped', () => {
    expect(bootstrapResultSchema.parse({})).toEqual({
      createdFolder: false,
      createdFiles: [],
      skippedFiles: [],
      scaffoldSkipped: false,
      gitInitialized: false,
      verification: null,
      inferredStack: 'none',
    });
  });
});

describe('projectDetectionResponseSchema', () => {
  it('parses a full detection', () => {
    const parsed = projectDetectionResponseSchema.parse({ name: 'my-tool', description: 'a cli', technologies: ['Python', 'FastAPI', 'PostgreSQL'] });
    expect(parsed).toEqual({ name: 'my-tool', description: 'a cli', technologies: ['Python', 'FastAPI', 'PostgreSQL'] });
  });

  it('defaults every field for a daemon that has not restarted since this route (or this field) shipped', () => {
    expect(projectDetectionResponseSchema.parse({})).toEqual({ name: null, description: null, technologies: [] });
  });
});