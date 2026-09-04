import chokidar from 'chokidar';
import path from 'node:path';

export interface SessionWatcher {
  /** Registers a listener fired (debounced) whenever a `.jsonl` file under `projects/` is
   *  added, changed, or removed. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
  close(): Promise<void>;
}

/**
 * Watches `<claudeConfigDir>/projects` for session-log changes, debounced (Claude Code writes
 * a session file incrementally, one line per turn — without debouncing, a single reply would
 * fire many change events in quick succession). Backs `GET /events` so the extension can
 * refetch on real change instead of polling on a timer.
 *
 * chokidar 5 dropped glob support — watch the whole `projects` directory recursively and
 * filter to `.jsonl` files via `ignored` instead of a glob pattern.
 */
export function watchSessionLogs(claudeConfigDir: string, debounceMs = 500): SessionWatcher {
  const projectsDir = path.join(claudeConfigDir, 'projects');
  const listeners = new Set<() => void>();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const watcher = chokidar.watch(projectsDir, {
    ignored: (filePath, stats) => (stats?.isFile() ?? false) && !filePath.endsWith('.jsonl'),
    ignoreInitial: true,
    persistent: true,
  });

  const notify = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      for (const listener of listeners) listener();
    }, debounceMs);
  };

  watcher.on('add', notify).on('change', notify).on('unlink', notify);

  return {
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      clearTimeout(debounceTimer);
      listeners.clear();
      await watcher.close();
    },
  };
}
