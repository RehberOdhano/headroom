import { describe, expect, it } from 'vitest';
import {
  agentDefinitionSchema,
  claudeConfigSnapshotSchema,
  claudeMdContentResponseSchema,
  claudeMdListResponseSchema,
  knownProjectsResponseSchema,
  settingsLayerSchema,
} from './schemas.js';

const emptyLayer = { path: '/tmp/settings.json', exists: false, defaultMode: null, allow: [], ask: [], deny: [] };

describe('settingsLayerSchema', () => {
  it('parses an existing populated layer', () => {
    const result = settingsLayerSchema.safeParse({
      path: '/project/.claude/settings.json',
      exists: true,
      defaultMode: 'auto',
      allow: ['WebFetch'],
      ask: ['Bash(git push *)'],
      deny: ['Bash(rm -rf *)'],
    });
    expect(result.success).toBe(true);
  });

  it('parses a missing layer', () => {
    expect(settingsLayerSchema.safeParse(emptyLayer).success).toBe(true);
  });
});

describe('claudeConfigSnapshotSchema', () => {
  it('parses a snapshot with no project selected (project/local null)', () => {
    const result = claudeConfigSnapshotSchema.safeParse({
      global: emptyLayer,
      project: null,
      local: null,
      hooks: [],
      skills: [],
      agents: [],
    });
    expect(result.success).toBe(true);
  });

  it('defaults agents to [] when the key is missing entirely — a not-yet-restarted daemon\'s response, since it only picks up a new field on restart, not on disk change', () => {
    const result = claudeConfigSnapshotSchema.safeParse({
      global: emptyLayer,
      project: null,
      local: null,
      hooks: [],
      skills: [],
      // no `agents` key at all
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.agents).toEqual([]);
  });

  it('parses a full snapshot with hooks, skills, and agents', () => {
    const result = claudeConfigSnapshotSchema.safeParse({
      global: emptyLayer,
      project: { ...emptyLayer, path: '/project/.claude/settings.json', exists: true },
      local: { ...emptyLayer, path: '/project/.claude/settings.local.json', exists: true },
      hooks: [
        {
          event: 'PreToolUse',
          matcher: 'Edit|Write',
          command: 'echo hi',
          timeout: 10,
          statusMessage: null,
          source: '/project/.claude/settings.json',
        },
      ],
      skills: [
        {
          name: 'adr',
          description: 'Record an architecture decision.',
          argumentHint: '<decision-title>',
          allowedTools: ['Read', 'Glob', 'Write'],
          path: '/project/.claude/skills/adr/SKILL.md',
        },
      ],
      agents: [
        {
          name: 'reviewer',
          description: 'Reviews a diff against a spec.',
          model: 'inherit',
          path: '/project/.claude/agents/reviewer.md',
          scope: 'project',
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('agentDefinitionSchema', () => {
  it('parses an agent with no model set', () => {
    const result = agentDefinitionSchema.safeParse({
      name: 'reviewer',
      description: 'Reviews a diff against a spec.',
      model: null,
      path: '/project/.claude/agents/reviewer.md',
      scope: 'project',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a scope outside project/global', () => {
    const result = agentDefinitionSchema.safeParse({
      name: 'reviewer',
      description: '',
      model: null,
      path: '/project/.claude/agents/reviewer.md',
      scope: 'org-wide',
    });
    expect(result.success).toBe(false);
  });
});

describe('knownProjectsResponseSchema', () => {
  it('parses a project list', () => {
    const result = knownProjectsResponseSchema.safeParse({
      projects: [{ path: '/Users/you/projects/app', lastActivity: '2026-09-01T00:00:00.000Z' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('claudeMdListResponseSchema / claudeMdContentResponseSchema', () => {
  it('parses a file list', () => {
    const result = claudeMdListResponseSchema.safeParse({
      files: [{ path: '/project/CLAUDE.md', relativePath: 'CLAUDE.md' }],
    });
    expect(result.success).toBe(true);
  });

  it('parses file content', () => {
    expect(claudeMdContentResponseSchema.safeParse({ content: '# Notes' }).success).toBe(true);
  });
});
