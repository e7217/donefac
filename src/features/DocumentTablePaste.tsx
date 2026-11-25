'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Editor } from '@tiptap/react';
import { ClipboardPaste, X } from 'lucide-react';
import { DOCUMENT_TABLE_PASTE_LIMITS, documentTableFromPaste, parseDocumentTablePaste } from '../../shared/document-table-paste';
import { trackDocumentTableTarget } from './document-table-paste-target';
import './document-table-paste.css';

type Target = { editor: Editor; tracker: NonNullable<ReturnType<typeof trackDocumentTableTarget>> };
type Phase = 'idle' | 'review' | 'position';

export function DocumentTablePaste({ editor, canEdit, onActiveChange }: {
  editor: Editor | null;
  canEdit: boolean;
  onActiveChange: (active: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState('');
  const [header, setHeader] = useState(true);
  const [error, setError] = useState('');
  const target = useRef<Target | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const heading = useId(), note = useId();
  const parsed = useMemo(() => parseDocumentTablePaste(text), [text]);
  const { rows: maxRows, columns: maxColumns } = DOCUMENT_TABLE_PASTE_LIMITS;

  useEffect(() => () => {
    target.current?.tracker.stop();
    onActiveChange(false);
  }, [onActiveChange]);

  useEffect(() => {
    if (!text || phase === 'idle') return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [phase, text]);

  useLayoutEffect(() => {
    if (phase !== 'review') return;
    const element = dialog.current;
    element?.showModal();
    input.current?.focus({ preventScroll: true });
    return () => element?.close();
  }, [phase]);

  function startReview() {
    const tracker = canEdit && editor && trackDocumentTableTarget(editor);
    if (!tracker || !editor) {
      setError('표를 넣을 본문 블록에 커서를 두어 주세요.');
      return;
    }
    target.current?.tracker.stop();
    target.current = { editor, tracker };
    setError('');
    setPhase('review');
    onActiveChange(true);
  }

  function editPosition() {
    target.current?.tracker.stop();
    target.current = null;
    setError('');
    setPhase('position');
    requestAnimationFrame(() => {
      if (editor && !editor.isDestroyed && editor.isEditable) editor.view.focus();
    });
  }

  function finish(inserted: boolean) {
    target.current?.tracker.stop();
    target.current = null;
    onActiveChange(false);
    setPhase('idle');
    setText('');
    setHeader(true);
    setError('');
    requestAnimationFrame(() => {
      if (inserted && editor && !editor.isDestroyed && editor.isEditable) editor.view.focus();
      else opener.current?.focus({ preventScroll: true });
    });
  }

  function cancel() {
    if (!text || window.confirm('붙여넣은 표 데이터를 지우고 닫을까요?')) finish(false);
  }

  function insert(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (parsed.kind !== 'ready') return;
    const active = target.current;
    const result = canEdit && active && active.editor === editor
      ? active.tracker.insert(documentTableFromPaste(parsed.rows, header)) : 'anchor';
    if (result === 'inserted') finish(true);
    else setError(result === 'size' ? '표를 추가하면 문서 용량 또는 블록 수 한도를 넘습니다. 붙여넣을 데이터를 줄여 주세요.'
      : '처음 선택한 블록의 위치를 확인할 수 없습니다. 데이터를 유지한 채 다른 위치를 선택할 수 있습니다.');
  }

  return <>
    <button ref={opener} type="button" className="docs-format-btn" aria-label="표 데이터 붙여넣기" title="표 데이터 붙여넣기"
      disabled={!canEdit || phase !== 'idle'} onMouseDown={event => event.preventDefault()} onClick={startReview}>
      <ClipboardPaste size={15} aria-hidden="true" />
    </button>
    {phase === 'position' && <span className="docs-table-paste-position" role="group" aria-label="표 삽입 위치">
      <span>표를 넣을 블록에 커서를 두세요.</span>
      <button type="button" className="btn docs-selection-action" disabled={!canEdit}
        onMouseDown={event => event.preventDefault()} onClick={startReview}>이 위치에서 표 검토</button>
      <button type="button" className="btn docs-selection-action" onClick={cancel}>표 입력 취소</button>
    </span>}
    {phase !== 'review' && error && <span role="alert">{error}</span>}
    {phase === 'review' && <dialog ref={dialog} className="docs-move-dialog docs-table-paste-dialog" aria-labelledby={heading}
      onCancel={event => { event.preventDefault(); cancel(); }}>
      <form onSubmit={insert}>
        <header className="docs-modal-header">
          <h2 id={heading}>표 데이터 붙여넣기</h2>
          <button type="button" className="btn btn-ghost docs-icon-button" aria-label="표 입력 닫기" onClick={cancel}><X size={18} aria-hidden="true" /></button>
        </header>
        <div className="docs-move-body docs-table-paste-body">
          <p id={note}>스프레드시트에서 복사한 셀이나 탭으로 구분한 데이터를 입력하세요. 최대 {maxRows}행, {maxColumns}열을 현재 블록 뒤에 넣습니다.</p>
          <label className="docs-modal-label">표 데이터
            <textarea ref={input} className="field" rows={5} value={text} spellCheck={false} aria-describedby={note}
              onChange={event => { setText(event.currentTarget.value); setError(''); }} />
          </label>
          <label className="docs-table-paste-header">
            <input type="checkbox" checked={header} onChange={event => setHeader(event.currentTarget.checked)} />첫 행을 머리글로 사용
          </label>
          {parsed.kind === 'error' && <p className="issue-form-error" role="alert">{parsed.message}</p>}
          {parsed.kind === 'ready' && <>
            <p role="status">{parsed.rows.length}행 · {parsed.columns}열</p>
            <div className="docs-table-paste-preview" role="region" tabIndex={0} aria-label="표 데이터 미리보기">
              <table aria-label="삽입할 표">
                {header && <thead><tr>{parsed.rows[0].map((cell, index) => <th scope="col" key={index}>{cell}</th>)}</tr></thead>}
                <tbody>{parsed.rows.slice(header ? 1 : 0).map((row, rowIndex) => <tr key={rowIndex}>
                  {row.map((cell, index) => <td key={index}>{cell}</td>)}
                </tr>)}</tbody>
              </table>
            </div>
          </>}
          {error && <p className="issue-form-error" role="alert">{error}</p>}
        </div>
        <footer className="docs-modal-footer docs-table-paste-footer">
          <button type="button" className="btn" onClick={editPosition}>다른 위치 선택</button>
          <button type="submit" className="btn btn-primary" disabled={!canEdit || parsed.kind !== 'ready'}>표 삽입</button>
        </footer>
      </form>
    </dialog>}
  </>;
}
