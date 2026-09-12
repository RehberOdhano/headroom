function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function downloadMarkdown(filename: string, content: string): void {
  triggerDownload(filename, new Blob([content], { type: 'text/markdown' }));
}

/** Quotes a field only when it needs it (contains a comma, quote, or newline) — the minimum
 *  CSV escaping needed for data that's already just numbers and project paths, no dependency
 *  needed for something this small. */
function csvField(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const csv = [headers, ...rows].map((row) => row.map(csvField).join(',')).join('\n');
  triggerDownload(filename, new Blob([csv], { type: 'text/csv' }));
}

export function resumeCommand(match: { cwd: string | null; sessionId: string }): string {
  return match.cwd ? `cd ${match.cwd} && claude --resume ${match.sessionId}` : `claude --resume ${match.sessionId}`;
}
