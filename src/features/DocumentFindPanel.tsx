'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Editor } from '@tiptap/react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useOutlineDocument } from './DocumentEditorOutline';
import { revealDocumentTarget } from './DocumentOutline';
import {
  DOCUMENT_FIND_QUERY_LIMIT, DOCUMENT_FIND_REPLACEMENT_LIMIT, documentFindReplacementFitsBatch, findDocumentText,
  replaceDocumentFindMatches, showDocumentFindMatches,
} from './document-find';
import './document-find.css';

type Props = {
  editor: Editor;
  inputRef: RefObject<HTMLInputElement | null>;
  canReplace: boolean;
  onClose: () => void;
};

export function DocumentFindPanel({ editor, inputRef, canReplace, onClose }: Props) {
  const doc = useOutlineDocument(editor);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [index, setIndex] = useState(0);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [notice, setNotice] = useState('');
  const [revealRequest, setRevealRequest] = useState(0);
  const handledReveal = useRef(0);
  const replacementInput = useRef<HTMLInputElement>(null);
  const result = useMemo(() => doc ? findDocumentText(doc, query, caseSensitive) : null, [doc, query, caseSensitive]);
  const count = result?.matches.length ?? 0;
  const active = Math.min(index, count - 1);
  const canEdit = canReplace && editor.isEditable;
  const showReplace = canEdit && replaceOpen;

  useLayoutEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, [inputRef]);
  useLayoutEffect(() => {
    if (showReplace) replacementInput.current?.focus({ preventScroll: true });
  }, [showReplace]);
  useLayoutEffect(() => {
    if (doc && result) showDocumentFindMatches(editor, doc, result.matches, active);
    if (handledReveal.current === revealRequest) return;
    handledReveal.current = revealRequest;
    if (!count || !doc) return;
    if (editor.isDestroyed || editor.state.doc !== doc) return;
    const root = editor.view.dom;
    const target = root.querySelector<HTMLElement>('[data-document-find-active]');
    if (target) revealDocumentTarget(target, root);
  }, [editor, doc, result, active, count, revealRequest]);
  useEffect(() => () => {
    if (!editor.isDestroyed) showDocumentFindMatches(editor, editor.state.doc, [], -1);
  }, [editor]);

  function requestReveal() { setRevealRequest(value => value + 1); }

  function resetPosition() {
    setIndex(0);
    setNotice('');
    requestReveal();
  }

  function navigate(step: 1 | -1) {
    if (!count) return;
    setIndex((active + step + count) % count);
    setNotice('');
    requestReveal();
  }

  function replace(all: boolean) {
    if (!doc || !result || active < 0 || !canEdit || (all && result.truncated)) return;
    const candidates = all ? result.matches : [result.matches[active]];
    const changes = candidates.filter(match => doc.textBetween(match.from, match.to) !== replacement);
    if (!changes.length) {
      setNotice('바꿀 내용이 없습니다.');
      return;
    }
    if (!documentFindReplacementFitsBatch(replacement, changes.length)) {
      setNotice('한 번에 바꿀 텍스트가 너무 많습니다. 검색 범위를 줄이거나 현재 결과를 바꿔 주세요.');
      return;
    }
    if (!replaceDocumentFindMatches(editor, doc, changes, replacement)) {
      setNotice('현재 본문을 다시 확인한 뒤 바꿔 주세요.');
      return;
    }
    const next = findDocumentText(editor.state.doc, query, caseSensitive);
    const afterReplacement = changes[0].from + replacement.length;
    const nextIndex = all ? 0 : next.matches.findIndex(match => match.from >= afterReplacement);
    setIndex(Math.max(0, nextIndex));
    setNotice(`${changes.length.toLocaleString('ko-KR')}곳을 바꿨습니다.`);
    requestReveal();
  }

  return <section role="search" aria-label="문서 본문 찾기" className="docs-find-panel" onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }}>
    <div className="docs-find-controls">
      <input ref={inputRef} type="text" className="field" aria-label="찾을 텍스트" placeholder="찾을 텍스트"
        autoComplete="off" maxLength={DOCUMENT_FIND_QUERY_LIMIT} value={query} onChange={event => {
          setQuery(event.currentTarget.value);
          resetPosition();
        }} onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            navigate(event.shiftKey ? -1 : 1);
          }
        }} />
      <button type="button" className="btn" aria-label="이전 결과" title="이전 결과" disabled={!count} onClick={() => navigate(-1)}>
        <ChevronUp size={16} aria-hidden="true" />
      </button>
      <button type="button" className="btn" aria-label="다음 결과" title="다음 결과" disabled={!count} onClick={() => navigate(1)}>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <button type="button" className="btn btn-ghost" aria-label="찾기 닫기" title="찾기 닫기" onClick={onClose}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
    <div className="docs-find-options">
      <span role="status" className="docs-find-count">{query && (count
        ? `${count.toLocaleString('ko-KR')}개${result?.truncated ? ' 이상' : ''} 중 ${(active + 1).toLocaleString('ko-KR')}번째`
        : '검색 결과 없음')}</span>
      <label><input type="checkbox" checked={caseSensitive} onChange={event => {
        setCaseSensitive(event.currentTarget.checked);
        resetPosition();
      }} />대소문자 구분</label>
      {canEdit && <button type="button" className="btn btn-ghost" aria-expanded={showReplace} onClick={() => {
        if (showReplace) inputRef.current?.focus({ preventScroll: true });
        setReplaceOpen(value => !value);
        setNotice('');
      }}>{showReplace ? '바꾸기 닫기' : '바꾸기 열기'}</button>}
    </div>
    {showReplace && <div className="docs-find-replace">
      <input ref={replacementInput} type="text" className="field" aria-label="바꿀 텍스트" placeholder="바꿀 텍스트"
        autoComplete="off" maxLength={DOCUMENT_FIND_REPLACEMENT_LIMIT} value={replacement} onChange={event => {
          setReplacement(event.currentTarget.value);
          setNotice('');
        }} />
      <button type="button" className="btn" disabled={!count} onClick={() => replace(false)}>현재 결과 바꾸기</button>
      <button type="button" className="btn" disabled={!count || result?.truncated} onClick={() => replace(true)}>모두 바꾸기</button>
    </div>}
    {showReplace && result?.truncated && <p className="docs-find-message">모두 바꾸려면 찾을 텍스트를 더 구체적으로 입력하세요.</p>}
    {notice && <p className="docs-find-message" role="status">{notice}</p>}
  </section>;
}
