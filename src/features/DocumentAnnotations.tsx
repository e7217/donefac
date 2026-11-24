'use client';

import { createContext, useContext, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type Editor, type NodeViewProps } from '@tiptap/react';
import type { AnyExtension } from '@tiptap/core';
import { TextSelection, type SelectionBookmark, type Transaction } from '@tiptap/pm/state';
import { Pencil, X } from 'lucide-react';
import {
  CALLOUT_LABELS, CALLOUT_VARIANTS, MAX_CALLOUT_TITLE_LENGTH, MAX_STATUS_BADGE_LABEL_LENGTH,
  STATUS_BADGE_TONE_LABELS, STATUS_BADGE_TONES, isCalloutVariant, isStatusBadgeTone,
} from '../../shared/document-nodes';
import { useDocumentSlashRange, type DocumentSlashAnchor } from './document-slash-insertion';
import './document-annotations.css';

export type DocumentAnnotationKind = 'callout' | 'statusBadge';
type AnnotationAttrs = Record<string, unknown>;
type AnnotationTarget = { getPos: NodeViewProps['getPos']; attrs: AnnotationAttrs };
export type DocumentAnnotationSelection = {
  kind: DocumentAnnotationKind;
  documentId: string;
  editor: Editor;
  opener: HTMLElement | null;
} & (
  { mode: 'insert'; bookmark: SelectionBookmark; slash?: DocumentSlashAnchor } |
  { mode: 'edit'; target: AnnotationTarget }
);
export type OpenDocumentAnnotation = (editor: Editor, kind: DocumentAnnotationKind, opener: HTMLElement | null, target?: AnnotationTarget) => void;

const AnnotationContext = createContext<OpenDocumentAnnotation | undefined>(undefined);
export const DocumentAnnotationProvider = AnnotationContext.Provider;

const calloutVariant = (attrs: AnnotationAttrs) => isCalloutVariant(attrs.variant) ? attrs.variant : 'info';
const statusTone = (attrs: AnnotationAttrs) => isStatusBadgeTone(attrs.tone) ? attrs.tone : 'neutral';
const textAttr = (value: unknown) => typeof value === 'string' ? value : '';

function CalloutHeader({ attrs, children }: { attrs: AnnotationAttrs; children?: ReactNode }) {
  const label = CALLOUT_LABELS[calloutVariant(attrs)];
  const title = textAttr(attrs.title);
  return <div className="document-callout-header" contentEditable={false}>
    <div className="document-callout-heading">
      {title && <span className="document-callout-kind">{label}</span>}
      <strong>{title || label}</strong>
    </div>
    {children}
  </div>;
}

export function ReadonlyCallout({ attrs, children }: { attrs: AnnotationAttrs; children: ReactNode }) {
  return <aside className="document-callout" data-teamspace-node="callout" data-callout-variant={calloutVariant(attrs)} data-callout-title={textAttr(attrs.title)}>
    <CalloutHeader attrs={attrs} />
    <div className="document-callout-content" data-teamspace-callout-content="">{children}</div>
  </aside>;
}

export function ReadonlyStatusBadge({ attrs }: { attrs: AnnotationAttrs }) {
  const label = textAttr(attrs.label);
  return <span className="document-status-badge" data-teamspace-node="statusBadge" data-status-tone={statusTone(attrs)} data-status-label={label}>{label}</span>;
}

function CalloutNodeView({ node, getPos, editor }: NodeViewProps) {
  const open = useContext(AnnotationContext);
  const { attrs } = node;
  return <NodeViewWrapper as="aside" className="document-callout" data-teamspace-node="callout"
    data-callout-variant={calloutVariant(attrs)} data-callout-title={textAttr(attrs.title)}>
    <CalloutHeader attrs={attrs}>
      {open && <button className="document-callout-edit" type="button" aria-label="안내 상자 설정" title="안내 상자 설정"
        onClick={event => open(editor, 'callout', event.currentTarget, { getPos, attrs })}><Pencil size={14} aria-hidden="true" /></button>}
    </CalloutHeader>
    <NodeViewContent className="document-callout-content" data-teamspace-callout-content="" />
  </NodeViewWrapper>;
}

function StatusBadgeNodeView({ node, getPos, editor }: NodeViewProps) {
  const open = useContext(AnnotationContext);
  const { attrs } = node;
  const label = textAttr(attrs.label);
  const tone = statusTone(attrs);
  return <NodeViewWrapper as="span" className="document-status-node" contentEditable={false}
    data-teamspace-node="statusBadge" data-status-tone={tone} data-status-label={label}>
    {open ? <button className="document-status-badge" type="button" data-status-tone={tone} aria-label={`상태 배지 설정 · ${label}`}
      title="상태 배지 설정" onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        open(editor, 'statusBadge', event.currentTarget, { getPos, attrs });
      }}>{label}</button>
      : <span className="document-status-badge" data-status-tone={tone}>{label}</span>}
  </NodeViewWrapper>;
}

export function decorateDocumentAnnotation(extension: AnyExtension): AnyExtension {
  if (extension.name === 'callout') return extension.extend({ addNodeView() { return ReactNodeViewRenderer(CalloutNodeView); } });
  if (extension.name === 'statusBadge') return extension.extend({ addNodeView() { return ReactNodeViewRenderer(StatusBadgeNodeView, { as: 'span' }); } });
  return extension;
}

export function DocumentAnnotationDialog({ selection, onClose }: { selection: DocumentAnnotationSelection; onClose: () => void }) {
  const { editor, kind, mode } = selection;
  const isCallout = kind === 'callout';
  const name = isCallout ? '안내 상자' : '상태 배지';
  const title = `${name} ${mode === 'edit' ? '설정' : '삽입'}`;
  const initialAttrs = mode === 'edit' ? selection.target.attrs : {};
  const [variant, setVariant] = useState(() => calloutVariant(initialAttrs));
  const [tone, setTone] = useState(() => statusTone(initialAttrs));
  const [text, setText] = useState(() => {
    if (mode === 'edit') return textAttr(isCallout ? initialAttrs.title : initialAttrs.label);
    if (isCallout || selection.slash) return '';
    const { $from, $to, from, to } = selection.bookmark.resolve(editor.state.doc);
    return $from.sameParent($to) ? editor.state.doc.textBetween(from, to, ' ').trim().slice(0, MAX_STATUS_BADGE_LABEL_LENGTH) : '';
  });
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const slash = mode === 'insert' ? selection.slash : undefined;
  const resolveSlash = useDocumentSlashRange(editor, slash);
  const bookmark = useRef(mode === 'insert' && !slash ? selection.bookmark : null);
  const inserted = useRef(false);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    const map = ({ transaction }: { transaction: Transaction }) => {
      if (bookmark.current) bookmark.current = bookmark.current.map(transaction.mapping);
    };
    editor.on('transaction', map);
    return () => {
      editor.off('transaction', map);
      element?.close();
      requestAnimationFrame(() => {
        if (!inserted.current && selection.opener?.isConnected) selection.opener.focus({ preventScroll: true });
        else if (!editor.isDestroyed && editor.view.dom.isConnected) editor.view.focus();
      });
    };
  }, [editor, selection.opener]);

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editor.isDestroyed || !editor.isEditable) { setError('편집할 문서를 다시 열어 주세요.'); return; }
    const value = text.trim();
    if (/[\u0000-\u001f\u007f]/u.test(value)) { setError('한 줄로 입력해 주세요.'); return; }
    if (!isCallout && !value) { setError('배지 이름을 입력해 주세요.'); return; }
    const attrs = isCallout ? { title: value, variant } : { label: value, tone };
    const { state } = editor;
    try {
      if (mode === 'edit') {
        const pos = selection.target.getPos();
        const current = pos === undefined ? null : state.doc.nodeAt(pos);
        if (pos === undefined || current?.type.name !== kind || current.attrs !== selection.target.attrs &&
          Object.entries(selection.target.attrs).some(([key, original]) => current.attrs[key] !== original)) {
          setError(`${name}이 변경되었거나 삭제되었습니다. 최신 본문에서 다시 열어 주세요.`);
          return;
        }
        if (Object.entries(attrs).some(([key, next]) => current.attrs[key] !== next)) {
          editor.view.dispatch(state.tr.setNodeMarkup(pos, undefined, attrs, current.marks));
        }
      } else {
        const range = slash ? resolveSlash() : null;
        if (slash && !range) {
          setError('슬래시 명령이 변경되었습니다. 편집 위치를 다시 선택해 주세요.');
          return;
        }
        const position = range ?? bookmark.current?.resolve(state.doc);
        if (!position) return;
        const tr = state.tr;
        const node = state.schema.nodes[kind].create(attrs, isCallout ? state.schema.nodes.paragraph.create() : null);
        if (isCallout) {
          if (range) tr.delete(range.from, range.to);
          const at = tr.mapping.map(range?.from ?? position.to);
          tr.replaceRangeWith(at, at, node);
        } else {
          const { from, to } = range ?? position;
          if (!state.doc.resolve(from).sameParent(state.doc.resolve(to))) throw new Error();
          tr.replaceWith(from, to, node);
        }
        let nodePosition: number | undefined;
        tr.doc.descendants((item, pos) => {
          if (item === node) nodePosition = pos;
          return nodePosition === undefined;
        });
        if (nodePosition === undefined) throw new Error();
        tr.setSelection(TextSelection.near(tr.doc.resolve(nodePosition + (isCallout ? 2 : node.nodeSize))));
        editor.view.dispatch(tr.scrollIntoView());
        inserted.current = true;
      }
      onClose();
    } catch {
      setError(`이 위치에는 ${name}을 적용할 수 없습니다.`);
    }
  }

  return <dialog ref={dialog} className="document-annotation-dialog" aria-label={title}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); } }}>
    <form onSubmit={apply}>
      <header className="docs-modal-header">
        <h2>{title}</h2>
        <button type="button" className="btn btn-ghost docs-icon-button" aria-label="닫기" onClick={onClose}><X size={17} /></button>
      </header>
      <label className="docs-modal-label">{isCallout ? '안내 상자 제목 (선택)' : '배지 이름'}
        <input ref={input} className="field" value={text} onChange={event => setText(event.target.value)}
          maxLength={isCallout ? MAX_CALLOUT_TITLE_LENGTH : MAX_STATUS_BADGE_LABEL_LENGTH} required={!isCallout} />
      </label>
      {isCallout ? <label className="docs-modal-label">안내 상자 유형
        <select className="field" value={variant} onChange={event => { if (isCalloutVariant(event.target.value)) setVariant(event.target.value); }}>
          {CALLOUT_VARIANTS.map(item => <option key={item} value={item}>{CALLOUT_LABELS[item]}</option>)}
        </select>
      </label> : <label className="docs-modal-label">배지 색상
        <select className="field" value={tone} onChange={event => { if (isStatusBadgeTone(event.target.value)) setTone(event.target.value); }}>
          {STATUS_BADGE_TONES.map(item => <option key={item} value={item}>{STATUS_BADGE_TONE_LABELS[item]}</option>)}
        </select>
      </label>}
      {error && <p className="docs-panel-error" role="alert">{error}</p>}
      <footer className="docs-modal-footer">
        <button className="btn btn-ghost" type="button" onClick={onClose}>취소</button>
        <button className="btn btn-primary" type="submit">{mode === 'edit' ? '적용' : '삽입'}</button>
      </footer>
    </form>
  </dialog>;
}
