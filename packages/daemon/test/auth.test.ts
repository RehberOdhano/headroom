import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateToken, isPaired, markPaired, readOrCreateToken } from '../src/auth.js';

// A temp dir, never the real ~/.config/claude-usage — these tests must not touch (or worse,
// delete) a real token on whatever machine runs them.
let configDir: string;

describe('auth token', () => {
  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), 'headroom-token-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('generateToken writes a 64-char hex token to disk', () => {
    const token = generateToken(configDir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path.join(configDir, 'token'), 'utf-8')).toBe(token);
  });

  it('readOrCreateToken creates one if none exists', () => {
    expect(existsSync(path.join(configDir, 'token'))).toBe(false);
    const token = readOrCreateToken(configDir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(path.join(configDir, 'token'))).toBe(true);
  });

  it('readOrCreateToken returns the same token on repeated calls', () => {
    const first = readOrCreateToken(configDir);
    const second = readOrCreateToken(configDir);
    expect(second).toBe(first);
  });
});

describe('pairing marker', () => {
  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), 'headroom-pairing-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('is unpaired until markPaired is called', () => {
    expect(isPaired(configDir)).toBe(false);
    markPaired(configDir);
    expect(isPaired(configDir)).toBe(true);
  });

  it('generateToken clears an existing pairing marker, reopening the pairing window', () => {
    markPaired(configDir);
    expect(isPaired(configDir)).toBe(true);

    generateToken(configDir);
    expect(isPaired(configDir)).toBe(false);
  });
});
