'use client';

import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { NodeViewWrapper, type Editor, type NodeViewProps } from '@tiptap/react';
import { documentTocOptions, isDocumentTocLayout, isDocumentTocLevel, type DocumentTocLevel, type DocumentTocOptions } from '../../shared/document-nodes';
import { editorHeadings, useOutlineDocument } from './DocumentEditorOutline';
import { jumpToReadonlyHeading, OutlineEntries, revealDocumentTarget, type DocumentOutlineEntry } from './DocumentOutline';

const levels: DocumentTocLevel[] = [1, 2, 3];
const headingPageSize = 100;

const preserveSelection = (event: MouseEvent<HTMLElement>) => event.preventDefault();

function DocumentToc<Target extends string | number>({ entries, options, navigate, controls, editable }: {
  entries: DocumentOutlineEntry<Target>[];
  options: DocumentTocOptions;
  navigate: (target: Target) => void;
  controls?: ReactNode;
  editable?: boolean;
}) {
  const [limit, setLimit] = useState(headingPageSize);
  const { minLevel, maxLevel, layout } = options;
  const selected = entries.filter(entry => entry.title && entry.level >= minLevel && entry.level <= maxLevel);
  return <>
    <div className="document-toc-header"><strong>본문 목차</strong>{controls}</div>
    {selected.length ? <OutlineEntries entries={selected} label="본문 목차" layout={layout} limit={limit}
      onNavigate={navigate} onMouseDown={editable ? preserveSelection : undefined} />
      : <p className="document-toc-empty">선택한 단계에 제목이 없습니다.</p>}
    {selected.length > limit && <button type="button" className="btn btn-ghost document-toc-more"
      onMouseDown={editable ? preserveSelection : undefined} onClick={() => setLimit(current => current + headingPageSize)}>
      목차 제목 더 보기 ({limit.toLocaleString()} / {selected.length.toLocaleString()})
    </button>}
  </>;
}

export function ReadonlyDocumentToc({ entries, attrs }: { entries: DocumentOutlineEntry[]; attrs?: Record<string, unknown> }) {
  const marker = useRef<HTMLElement>(null);
  function navigate(target: string) {
    const root = marker.current?.closest<HTMLElement>('[data-document-outline-root]');
    if (root) jumpToReadonlyHeading(root, target);
  }
  return <aside ref={marker} className="document-toc" data-teamspace-node="documentToc">
    <DocumentToc entries={entries} options={documentTocOptions(attrs)} navigate={navigate} />
  </aside>;
}

export function DocumentTocNodeView({ node, editor, selected, updateAttributes, deleteNode }: NodeViewProps) {
  const content = useOutlineDocument(editor);
  const options = documentTocOptions(node.attrs);
  const entries = content ? editorHeadings(content) : [];
  function navigate(position: number) {
    if (editor.isDestroyed || editor.state.doc !== content) return;
    const heading = editor.view.nodeDOM(position);
    if (heading instanceof HTMLElement) revealDocumentTarget(heading, editor.view.dom);
  }
  return <NodeViewWrapper as="aside" className={`document-toc${selected ? ' is-selected' : ''}`} data-teamspace-node="documentToc" contentEditable={false}>
    <DocumentToc entries={entries} options={options} navigate={navigate} editable controls={editor.isEditable && <details className="document-toc-settings">
      <summary>목차 설정</summary>
      <div className="document-toc-fields">
        <label>시작 제목 단계
          <select value={options.minLevel} onChange={event => {
            const minLevel = Number(event.target.value);
            if (editor.isEditable && isDocumentTocLevel(minLevel) && minLevel <= options.maxLevel) updateAttributes({ minLevel });
          }}>{levels.filter(level => level <= options.maxLevel).map(level => <option key={level} value={level}>제목 {level}</option>)}</select>
        </label>
        <label>끝 제목 단계
          <select value={options.maxLevel} onChange={event => {
            const maxLevel = Number(event.target.value);
            if (editor.isEditable && isDocumentTocLevel(maxLevel) && maxLevel >= options.minLevel) updateAttributes({ maxLevel });
          }}>{levels.filter(level => level >= options.minLevel).map(level => <option key={level} value={level}>제목 {level}</option>)}</select>
        </label>
        <label>목차 배치
          <select value={options.layout} onChange={event => {
            const { value } = event.target;
            if (editor.isEditable && isDocumentTocLayout(value)) updateAttributes({ layout: value });
          }}><option value="list">세로 목록</option><option value="flat">가로 목록</option></select>
        </label>
        <button type="button" className="btn btn-ghost" onClick={() => { if (editor.isEditable) deleteNode(); }}>목차 블록 삭제</button>
      </div>
    </details>} />
  </NodeViewWrapper>;
}

export function insertDocumentToc(editor: Editor | null) {
  if (!editor?.isEditable) return false;
  return editor.chain().focus().insertContent([{ type: 'documentToc' }, { type: 'paragraph' }]).run();
}
