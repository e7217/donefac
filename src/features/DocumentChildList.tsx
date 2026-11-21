'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { FileText, ListTree, SlidersHorizontal, X } from 'lucide-react';
import {
  DOCUMENT_CHILD_LIST_DEFAULTS, MAX_DOCUMENT_CHILD_LIST_DEPTH, MAX_DOCUMENT_CHILD_LIST_FIRST,
  MAX_DOCUMENT_CHILD_LIST_TITLE_LENGTH, normalizeDocumentChildListOptions, projectDocumentChildren,
  type DocumentChildListOptions,
} from '../../shared/document-child-list';
import type { WorkspaceSnapshot } from '../../shared/types';
import './document-label-list.css';
import './document-child-list.css';

type Projection = ReturnType<typeof projectDocumentChildren>;
type Props = {
  attrs?: Record<string, unknown>;
  data: WorkspaceSnapshot;
  documentId: string | null;
  projection?: Projection;
  renderLimit?: number;
  openDocument: (id: string) => void;
  onChange?: (changes: Partial<DocumentChildListOptions>, baseline: DocumentChildListOptions | null) => boolean;
  onDelete?: () => void;
  onSettingsDraftChange?: (dirty: boolean) => void;
};

type Draft = Omit<DocumentChildListOptions, 'depth' | 'first'> & { depth: string; first: string };
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const pageSize = 25;
const headings = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

function draftFrom(options: DocumentChildListOptions | null): Draft {
  const source = options ?? DOCUMENT_CHILD_LIST_DEFAULTS;
  return { ...source, depth: source.depth === 'all' ? '' : String(source.depth), first: source.first?.toString() ?? '' };
}

function scopedDraft(draft: Draft): Draft {
  return { ...draft, documentId: draft.scope === 'document' ? draft.documentId : null, projectId: draft.scope === 'space' ? draft.projectId : null };
}

function DocumentChildListSettings({ options, data, onApply, onClose, onDraftChange }: {
  options: DocumentChildListOptions | null;
  data: WorkspaceSnapshot;
  onApply: NonNullable<Props['onChange']>;
  onClose: () => void;
  onDraftChange: (dirty: boolean) => void;
}) {
  const [baseline, setBaseline] = useState(options);
  const [draft, setDraft] = useState(() => draftFrom(options));
  const [error, setError] = useState('');
  const scopeInput = useRef<HTMLSelectElement>(null);
  const outdated = JSON.stringify(baseline) !== JSON.stringify(options);
  const dirty = JSON.stringify(scopedDraft(draft)) !== JSON.stringify(draftFrom(baseline));
  const missingDocument = draft.scope === 'document' && !data.documents.some(document => document.id === draft.documentId);
  const missingProject = draft.scope === 'space' && draft.projectId !== null && !data.projects.some(project => project.id === draft.projectId);
  const choices = useMemo(() => {
    if (draft.scope !== 'document') return [];
    const projects = new Map(data.projects.map(project => [project.id, project.name]));
    const documents = new Map(data.documents.map(document => [document.id, document]));
    return data.documents.map(document => {
      const space = document.projectId === null ? '팀 공통' : projects.get(document.projectId);
      const parent = document.parentId ? documents.get(document.parentId)?.title : null;
      const label = [space, parent, document.title].filter(Boolean).join(' / ');
      return { id: document.id, label };
    }).sort((left, right) => collator.compare(left.label, right.label) || left.id.localeCompare(right.id));
  }, [data.documents, data.projects, draft.scope]);

  useLayoutEffect(() => { scopeInput.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => {
    onDraftChange(dirty);
    return () => onDraftChange(false);
  }, [dirty, onDraftChange]);

  function setOption<Key extends keyof Draft>(key: Key, value: Draft[Key]) {
    setDraft(previous => ({ ...previous, [key]: value }));
    setError('');
  }

  function loadLatest() {
    setBaseline(options);
    setDraft(draftFrom(options));
    setError('');
    scopeInput.current?.focus({ preventScroll: true });
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (outdated || missingDocument || missingProject) return;
    const updated = normalizeDocumentChildListOptions({ ...scopedDraft(draft),
      depth: draft.depth === '' ? 'all' : Number(draft.depth), first: draft.first === '' ? null : Number(draft.first),
    });
    if (!updated) {
      setError('목록 범위, 표시 단계, 문서 수와 제목을 확인해 주세요.');
      return;
    }
    const changes = Object.fromEntries(Object.entries(updated).filter(([key, value]) =>
      !baseline || baseline[key as keyof DocumentChildListOptions] !== value)) as Partial<DocumentChildListOptions>;
    if (Object.keys(changes).length && !onApply(changes, baseline)) {
      setError('목록 설정이 변경되었습니다. 최신 설정을 확인해 주세요.');
      return;
    }
    onClose();
  }

  return <form className="doc-label-list-settings" aria-label="하위 문서 목록 설정" onSubmit={apply} onKeyDown={event => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }}>
    <div className="doc-label-list-fields">
      <label>목록 범위<select ref={scopeInput} value={draft.scope} onChange={event => setOption('scope', event.target.value as Draft['scope'])}>
        <option value="current">이 문서</option><option value="document">다른 상위 문서</option>
        <option value="current-space">이 문서의 공간</option><option value="space">지정한 공간</option>
      </select></label>
      {draft.scope === 'document' && <label>상위 문서<select required value={draft.documentId ?? ''} onChange={event => setOption('documentId', event.target.value || null)}>
        <option value="">상위 문서 선택</option>
        {missingDocument && draft.documentId && <option value={draft.documentId}>찾을 수 없는 문서</option>}
        {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select></label>}
      {draft.scope === 'space' && <label>문서 공간<select value={draft.projectId ?? ''} onChange={event => setOption('projectId', event.target.value || null)}>
        <option value="">팀 공통 문서</option>
        {missingProject && <option value={draft.projectId ?? ''}>찾을 수 없는 프로젝트</option>}
        {data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>}
      <label>표시 단계<input type="number" min={1} max={MAX_DOCUMENT_CHILD_LIST_DEPTH} step={1} placeholder="모든 단계" value={draft.depth}
        onChange={event => setOption('depth', event.target.value)} /></label>
      <label>최상위 문서 수<input type="number" min={1} max={MAX_DOCUMENT_CHILD_LIST_FIRST} step={1} placeholder="모두 표시" value={draft.first}
        onChange={event => setOption('first', event.target.value)} /></label>
      <label>문서 정렬<select value={draft.sort} onChange={event => setOption('sort', event.target.value as Draft['sort'])}>
        <option value="title">제목</option><option value="created">작성일</option><option value="updated">수정일</option>
      </select></label>
      <label>표시 형식<select value={draft.style} onChange={event => setOption('style', event.target.value as Draft['style'])}>
        <option value="list">목록</option>{headings.map((heading, index) => <option key={heading} value={heading}>제목 {index + 1}</option>)}
      </select></label>
      <label className="doc-label-list-title-input">목록 제목<input maxLength={MAX_DOCUMENT_CHILD_LIST_TITLE_LENGTH} value={draft.title}
        onChange={event => setOption('title', event.target.value)} /></label>
    </div>
    <div className="doc-label-list-checkboxes"><label><input type="checkbox" checked={draft.descending}
      onChange={event => setOption('descending', event.target.checked)} />내림차순</label></div>
    {outdated && <p className="doc-label-list-error" role="alert">다른 곳에서 목록 설정을 변경했습니다. 입력한 값은 유지됩니다.</p>}
    {!outdated && error && <p className="doc-label-list-error" role="alert">{error}</p>}
    <div className="doc-label-list-settings-actions">
      <button type="button" className="btn btn-ghost" onClick={onClose}>취소</button>
      {outdated && <button type="button" className="btn" onClick={() => {
        if (!dirty || window.confirm('입력한 값을 버리고 최신 목록 설정을 불러올까요?')) loadLatest();
      }}>최신 목록 설정 불러오기</button>}
      <button type="submit" className="btn btn-primary" disabled={outdated || missingDocument || missingProject}>목록 설정 적용</button>
    </div>
  </form>;
}

type TreeRow = Projection['items'][number] & { children: TreeRow[] };

function groupChildRows(items: Projection['items']): TreeRow[] {
  const roots: TreeRow[] = [];
  const parents: TreeRow[] = [];
  for (const item of items) {
    while (parents.length && parents[parents.length - 1].depth >= item.depth) parents.pop();
    const row = { ...item, children: [] };
    const siblings = parents[parents.length - 1]?.children ?? roots;
    siblings.push(row);
    parents.push(row);
  }
  return roots;
}

function ChildRows({ rows, style, documentId, openDocument }: {
  rows: TreeRow[];
  style: DocumentChildListOptions['style'];
  documentId: string | null;
  openDocument: Props['openDocument'];
}) {
  return <ul className="doc-child-list-rows">{rows.map(({ document, depth, children }) => {
    const Heading = style === 'list' ? null : headings[Math.min(headings.length - 1, headings.indexOf(style) + depth - 1)];
    const link = <a className="doc-child-list-link" aria-current={document.id === documentId ? 'page' : undefined}
      style={{ paddingInlineStart: `${11 + Math.min(8, depth - 1) * 10}px` }}
      href={`#/${encodeURIComponent(document.projectId ?? 'all')}/documents/${encodeURIComponent(document.id)}`}
      onMouseDown={event => {
        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) event.preventDefault();
      }} onClick={event => {
        event.stopPropagation();
        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          event.preventDefault();
          openDocument(document.id);
        }
      }}><FileText size={14} aria-hidden="true" /><span>{document.title || '제목 없는 문서'}</span></a>;
    return <li key={document.id}>
      {Heading ? <Heading className="doc-child-list-row-heading">{link}</Heading> : link}
      {!!children.length && <ChildRows rows={children} style={style} documentId={documentId} openDocument={openDocument} />}
    </li>;
  })}</ul>;
}

function DocumentChildListRows({ projection, limit, style, documentId, openDocument }: {
  projection: Projection;
  limit: number;
  style: DocumentChildListOptions['style'];
  documentId: string | null;
  openDocument: Props['openDocument'];
}) {
  const [visible, setVisible] = useState(pageSize);
  const shown = Math.min(projection.items.length, limit, visible);
  const rows = groupChildRows(projection.items.slice(0, shown));
  return <>
    <ChildRows rows={rows} style={style} documentId={documentId} openDocument={openDocument} />
    {(shown < projection.items.length || projection.truncated) && <footer className="doc-label-list-footer">
      <span>{projection.truncated ? `표시 한도에 도달했습니다. ${shown}개 표시` : `${projection.items.length}개 중 ${shown}개 표시`}</span>
      {shown < Math.min(limit, projection.items.length) && <button type="button" className="btn btn-ghost"
        onClick={() => setVisible(previous => previous + pageSize)}>하위 문서 더 보기</button>}
    </footer>}
  </>;
}

export function DocumentChildListCard({ attrs, data, documentId, projection, openDocument, renderLimit, onChange, onDelete, onSettingsDraftChange }: Props) {
  const options = useMemo(() => normalizeDocumentChildListOptions(attrs), [attrs]);
  const result = useMemo(() => projection ?? (options && projectDocumentChildren(data.documents, documentId, options)),
    [data.documents, documentId, options, projection]);
  const available = Boolean(result?.available) && !(options?.scope === 'space' && options.projectId !== null &&
    !data.projects.some(project => project.id === options.projectId));
  const settingsButton = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsDirty = useRef(false);
  const trackDraft = useCallback((dirty: boolean) => {
    settingsDirty.current = dirty;
    onSettingsDraftChange?.(dirty);
  }, [onSettingsDraftChange]);

  function closeSettings() {
    setSettingsOpen(false);
    settingsButton.current?.focus({ preventScroll: true });
  }

  return <section className="doc-label-list doc-child-list" aria-label="하위 문서 목록">
    <header className="doc-label-list-heading">
      <ListTree size={16} aria-hidden="true" />
      <strong>{options?.title || '하위 문서 목록'}</strong>
      {result && available && <span className="doc-label-list-count">{result.items.length}개{result.truncated && ' 이상'}</span>}
      {(onChange || onDelete) && <div className="doc-label-list-actions">
        {onChange && <button ref={settingsButton} type="button" className="btn btn-ghost docs-icon-button" aria-label="하위 문서 목록 설정"
          aria-expanded={settingsOpen} title="하위 문서 목록 설정" onClick={() => {
            if (!settingsOpen) setSettingsOpen(true);
            else if (!settingsDirty.current || window.confirm('적용하지 않은 문서 목록 설정을 버릴까요?')) closeSettings();
          }}><SlidersHorizontal size={14} aria-hidden="true" /></button>}
        {onDelete && <button type="button" className="btn btn-ghost docs-icon-button" aria-label="하위 문서 목록 삭제" title="하위 문서 목록 삭제"
          onMouseDown={event => event.preventDefault()} onClick={() => {
            if (!settingsDirty.current || window.confirm('설정 중인 하위 문서 목록을 삭제할까요?')) onDelete();
          }}><X size={14} aria-hidden="true" /></button>}
      </div>}
    </header>
    {settingsOpen && onChange && <DocumentChildListSettings options={options} data={data} onApply={onChange} onClose={closeSettings} onDraftChange={trackDraft} />}
    {!options ? <p className="doc-label-list-message">하위 문서 목록 설정을 확인해 주세요.</p>
      : !available || !result ? <p className="doc-label-list-message">목록의 상위 문서나 공간을 찾을 수 없습니다.</p>
        : !result.items.length ? <p className="doc-label-list-message">표시할 하위 문서가 없습니다.</p>
          : <DocumentChildListRows key={JSON.stringify(options)} projection={result} limit={renderLimit ?? result.items.length}
            style={options.style} documentId={documentId} openDocument={openDocument} />}
  </section>;
}
