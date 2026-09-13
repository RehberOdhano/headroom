import { describe, expect, it } from 'vitest';
import { inferStackFromTags } from './infer-stack.js';

describe('inferStackFromTags', () => {
  it('returns "none" for no tags at all', () => {
    expect(inferStackFromTags([])).toBe('none');
  });

  it('returns "other" when tags were picked but none match a built-in template', () => {
    expect(inferStackFromTags(['Ruby', 'Ruby on Rails'])).toBe('other');
  });

  it('infers java from "Java" or "Spring Boot"', () => {
    expect(inferStackFromTags(['Java', 'PostgreSQL'])).toBe('java');
    expect(inferStackFromTags(['Spring Boot'])).toBe('java');
  });

  it('infers kotlin from "Kotlin"', () => {
    expect(inferStackFromTags(['Kotlin', 'PostgreSQL'])).toBe('kotlin');
  });

  it('infers csharp from "C#"', () => {
    expect(inferStackFromTags(['C#'])).toBe('csharp');
  });

  it('prefers kotlin over java when both are tagged, deterministically', () => {
    expect(inferStackFromTags(['Java', 'Kotlin'])).toBe('kotlin');
  });

  it('infers node-typescript from a JS/TS-side framework tag', () => {
    expect(inferStackFromTags(['React', 'PostgreSQL'])).toBe('node-typescript');
  });

  it('infers python from a Python framework tag', () => {
    expect(inferStackFromTags(['FastAPI', 'PostgreSQL'])).toBe('python');
  });

  it('infers go from a Go framework tag', () => {
    expect(inferStackFromTags(['Gin', 'Redis'])).toBe('go');
  });

  it('matches case-insensitively', () => {
    expect(inferStackFromTags(['react'])).toBe('node-typescript');
  });

  it('prefers node-typescript when tags for multiple stacks are present, deterministically', () => {
    expect(inferStackFromTags(['Python', 'TypeScript'])).toBe('node-typescript');
  });
});
