import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClaudeMdFile } from '@headroom/shared';
import { getDaemonClaudeMdContent, getDaemonClaudeMdList, updateDaemonClaudeMdContent, type DaemonResult } from '../../../lib/daemon-client.js';
import { renderMarkdownSafely } from '../../../lib/markdown.js';
import type { Settings } from '../../../lib/protocol.js';

type ViewMode = 'preview' | 'source';

export function ClaudeMdSection({ settings, projectDir }: { settings: Settings; projectDir: string }) {
  const [files, setFiles] = useState<DaemonResult<{ files: ClaudeMdFile[] }> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<DaemonResult<{ content: string }> | null>(null);
  const [draft, setDraft] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelected(null);
    setLoaded(null);
    setDraft('');
    setSaveError(null);
    void getDaemonClaudeMdList(settings, projectDir).then(setFiles);
  }, [settings.daemonUrl, settings.daemonToken, projectDir]);

  const dirty = loaded?.ok ? draft !== loaded.data.content : false;
  const renderedHtml = useMemo(() => renderMarkdownSafely(draft), [draft]);

  async function open(filePath: string): Promise<void> {
    setSelected(filePath);
    setSaveError(null);
    setViewMode('preview');
    const result = await getDaemonClaudeMdContent(settings, projectDir, filePath);
    setLoaded(result);
    setDraft(result.ok ? result.data.content : '');
  }

  async function save(): Promise<void> {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await updateDaemonClaudeMdContent(settings, projectDir, selected, draft);
      if (result.ok) setLoaded(result);
      else setSaveError(result.message);
    } finally {
      setSaving(false);
    }
  }

  function revert(): void {
    if (loaded?.ok) setDraft(loaded.data.content);
  }

  async function copyCurrent(): Promise<void> {
    const text = viewMode === 'source' ? draft : (previewRef.current?.textContent ?? draft);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">CLAUDE.md</h2>
      </div>
      {files === null && (
        <p className="hint">
          <span className="spinner" aria-hidden="true" />
          Looking for CLAUDE.md files…
        </p>
      )}
      {files && !files.ok && <p className="error-text">{files.message}</p>}
      {files?.ok && files.data.files.length === 0 && <p className="hint">No CLAUDE.md files found in this project.</p>}
      {files?.ok && files.data.files.length > 0 && (
        <div className="result-actions" style={{ marginBottom: 'var(--space-3)' }}>
          {files.data.files.map((file) => (
            <button
              key={file.path}
              type="button"
              className="btn"
              disabled={selected === file.path}
              onClick={() => void open(file.path)}
            >
              {file.relativePath}
            </button>
          ))}
        </div>
      )}
      {loaded && !loaded.ok && <p className="error-text">{loaded.message}</p>}
      {loaded?.ok && (
        <>
          <div className="md-toolbar">
            <div className="segmented" role="group" aria-label="View mode">
              <button type="button" aria-pressed={viewMode === 'preview'} onClick={() => setViewMode('preview')}>
                Preview
              </button>
              <button type="button" aria-pressed={viewMode === 'source'} onClick={() => setViewMode('source')}>
                Source (.md)
              </button>
            </div>
            <div className="result-actions">
              <button type="button" className="btn" onClick={() => void copyCurrent()}>
                {copied ? 'Copied!' : `Copy ${viewMode === 'source' ? '.md' : 'preview'}`}
              </button>
              {viewMode === 'source' && (
                <>
                  <button type="button" className="btn" disabled={!dirty} onClick={revert}>
                    Revert
                  </button>
                  <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </>
              )}
            </div>
          </div>
          {saveError && <p className="error-text">{saveError}</p>}
          {dirty && viewMode === 'source' && <p className="hint">Unsaved changes — Save writes directly to the file on disk.</p>}
          {viewMode === 'preview' ? (
            <div ref={previewRef} className="claude-md-preview markdown-body" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          ) : (
            <textarea
              className="md-editor"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
            />
          )}
        </>
      )}
    </section>
  );
}
