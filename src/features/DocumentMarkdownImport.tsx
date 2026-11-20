'use client';

import { useLayoutEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { ReadonlyDocumentContent } from './DocumentBlocks';

export type MarkdownImportPreview = ReturnType<typeof import('./document-markdown-import')['previewMarkdownImport']>;
type ImportOperation = 'read' | 'preview' | null;

function keepPreviewInPlace(event: SyntheticEvent) {
  if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();
}

export function DocumentMarkdownImport({ preview, onPreview, disabled }: {
  preview: MarkdownImportPreview | null;
  onPreview: (preview: MarkdownImportPreview | null, fileTitle?: string) => void;
  disabled: boolean;
}) {
  const [source, setSource] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState<ImportOperation>(null);
  const [error, setError] = useState('');
  const sourceField = useRef<HTMLTextAreaElement>(null);
  const operation = useRef<{ token: number; kind: ImportOperation }>({ token: 0, kind: null });

  useLayoutEffect(() => {
    sourceField.current?.focus();
    const activeOperation = operation.current;
    return () => { activeOperation.token++; };
  }, []);

  function invalidate(kind: ImportOperation = null) {
    const token = ++operation.current.token;
    operation.current.kind = kind;
    setError('');
    setBusy(kind);
    onPreview(null);
    return token;
  }

  function finish(token: number) {
    if (operation.current.token === token) {
      operation.current.kind = null;
      setBusy(null);
    }
  }

  async function readFile(file: File) {
    const token = invalidate('read');
    try {
      const { MAX_MARKDOWN_IMPORT_BYTES } = await import('./document-markdown-import');
      if (operation.current.token !== token) return;
      if (file.size > MAX_MARKDOWN_IMPORT_BYTES) throw new Error('Markdown 파일은 512KiB까지 가져올 수 있습니다.');
      const bytes = await file.arrayBuffer();
      if (operation.current.token !== token) return;
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('UTF-8로 저장한 Markdown 파일을 선택해 주세요.'); }
      if (!text.trim()) throw new Error('내용이 있는 Markdown 파일을 선택해 주세요.');
      setSource(text);
      setFileName(file.name);
    } catch (cause) {
      if (operation.current.token === token) setError(cause instanceof Error ? cause.message : '파일을 읽지 못했습니다.');
    } finally {
      finish(token);
    }
  }

  async function convert() {
    const token = invalidate('preview');
    try {
      const { previewMarkdownImport } = await import('./document-markdown-import');
      if (operation.current.token !== token) return;
      const result = previewMarkdownImport(source, sourceUrl.trim() || undefined);
      onPreview(result, fileName.replace(/\.(?:md|markdown|mdown)$/i, ''));
    } catch (cause) {
      if (operation.current.token === token) setError(cause instanceof Error ? cause.message : 'Markdown 미리보기를 만들지 못했습니다.');
    } finally {
      finish(token);
    }
  }

  return <div className="docs-markdown-import">
    <label className="docs-modal-label">Markdown 파일<input className="field" type="file" accept=".md,.markdown,.mdown,text/markdown,text/plain"
      disabled={disabled} onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) void readFile(file);
      }} /></label>
    {fileName && <span className="docs-markdown-filename">{fileName}</span>}
    <label className="docs-modal-label">Markdown 내용<textarea ref={sourceField} className="field" rows={6} value={source} disabled={disabled}
      placeholder="Markdown을 붙여넣으세요."
      onChange={event => { invalidate(); setSource(event.target.value); setFileName(''); }} /></label>
    <div>
      <label className="docs-modal-label">원본 파일 URL<input className="field" type="url" value={sourceUrl} disabled={disabled}
        placeholder="https://gitlab.example/team/project/-/blob/main/README.md" aria-describedby="docs-markdown-url-hint"
        onChange={event => { if (operation.current.kind !== 'read') invalidate(); setSourceUrl(event.target.value); }} /></label>
      <small className="docs-markdown-hint" id="docs-markdown-url-hint">선택 사항입니다. 상대 링크를 원본 파일 주소 기준으로 연결합니다.</small>
    </div>
    <div className="docs-markdown-actions"><button className="btn btn-ghost" type="button" disabled={disabled || Boolean(busy) || !source.trim()}
      onClick={() => void convert()}>{busy === 'preview' && <Loader2 size={14} className="docs-spin" />} 미리보기</button>
      {busy === 'read' && <span role="status">파일 읽는 중…</span>}
    </div>
    {error && <p className="error-text docs-markdown-message" role="alert">{error}</p>}
    {preview && <section className="docs-markdown-result" aria-labelledby="docs-markdown-preview-title">
      <h3 id="docs-markdown-preview-title">Markdown 미리보기</h3>
      {!!preview.warnings.length && <ul className="docs-markdown-warnings" aria-label="가져오기 확인 사항">
        {preview.warnings.map(warning => <li key={warning.code}>{warning.message}{warning.count > 1 ? ` (${warning.count}건)` : ''}</li>)}
      </ul>}
      <div className="docs-markdown-preview" onClickCapture={keepPreviewInPlace} onAuxClickCapture={keepPreviewInPlace}
        onContextMenuCapture={keepPreviewInPlace} onDragStartCapture={keepPreviewInPlace}>
        <ReadonlyDocumentContent content={preview.content} nodeBudget={1_000} mode="pinned" />
      </div>
    </section>}
  </div>;
}
