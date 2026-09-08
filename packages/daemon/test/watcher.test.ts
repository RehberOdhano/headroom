import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchSessionLogs, type SessionWatcher } from '../src/watcher.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string;
let watcher: SessionWatcher | undefined;

describe('watchSessionLogs', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'headroom-watcher-'));
    mkdirSync(path.join(dir, 'projects', 'proj'), { recursive: true });
  });

  afterEach(async () => {
    await watcher?.close();
    watcher = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    'fires onChange (debounced) when a .jsonl file is written',
    async () => {
      watcher = watchSessionLogs(dir, 50);
      await sleep(300); // let the initial recursive scan settle before writing

      const fired = new Promise<void>((resolve) => {
        watcher!.onChange(resolve);
      });
      writeFileSync(path.join(dir, 'projects', 'proj', 'session.jsonl'), '{"type":"user"}\n');

      await fired;
    },
    5000,
  );

  it(
    'does not fire for a non-.jsonl file',
    async () => {
      watcher = watchSessionLogs(dir, 50);
      await sleep(300);

      let fired = false;
      watcher.onChange(() => {
        fired = true;
      });
      writeFileSync(path.join(dir, 'projects', 'proj', 'notes.txt'), 'hello');
      await sleep(400);

      expect(fired).toBe(false);
    },
    5000,
  );

  it(
    'stops notifying after unsubscribe',
    async () => {
      watcher = watchSessionLogs(dir, 50);
      await sleep(300);

      let count = 0;
      const unsubscribe = watcher.onChange(() => {
        count += 1;
      });
      unsubscribe();
      writeFileSync(path.join(dir, 'projects', 'proj', 'a.jsonl'), '{}\n');
      await sleep(400);

      expect(count).toBe(0);
    },
    5000,
  );
});
