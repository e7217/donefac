'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { FileText, ListFilter, SlidersHorizontal, X } from 'lucide-react';
import { documentLabelKey, MAX_DOCUMENT_LABEL_LENGTH, MAX_DOCUMENT_LABELS, normalizeDocumentLabel, normalizeDocumentLabels } from '../../shared/document-labels';
import {
  DOCUMENT_LABEL_LIST_DEFAULTS, MAX_DOCUMENT_LABEL_LIST_LIMIT, MAX_DOCUMENT_LABEL_LIST_TITLE_LENGTH,
  normalizeDocumentLabelListOptions, type DocumentLabelListOptions,
} from '../../shared/document-label-list';
import type { DocPage, WorkspaceSnapshot } from '../../shared/types';
import './document-label-list.css';

type Props = {
  attrs?: Record<string, unknown>;
  data: WorkspaceSnapshot;
  documentId: string | null;
  openDocument?: (id: string) => void;
  renderLimit?: number;
  onChange?: (attributes: Partial<DocumentLabelListOptions>) => void;
  onDelete?: () => void;
  onSettingsDraftChange?: (dirty: boolean) => void;
};

type Draft = Omit<DocumentLabelListOptions, 'limit'> & { limit: string };
const pageSize = 25;
const titleSort = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const number = new Intl.NumberFormat('ko');

function matchingDocuments(documents: DocPage[], options: DocumentLabelListOptions, documentId: string | null) {
  if (!options.labels.length) return [];
  const keys = options.labels.map(documentLabelKey);
  const matching = documents.filter(document => {
    if (document.projectId !== options.projectId || (options.excludeCurrent && document.id === documentId)) return false;
    const labels = new Set((document.labels ?? []).map(documentLabelKey));
    return options.match === 'all' ? keys.every(key => labels.has(key)) : keys.some(key => labels.has(key));
  });
  const dateField = options.sort === 'created' ? 'createdAt' : 'updatedAt';
  const titleOrder = options.sort === 'title';
  return matching.map(document => ({ document, time: titleOrder ? 0 : Date.parse(document[dateField]) || 0 }))
    .sort((a, b) => {
      const order = titleOrder ? titleSort.compare(a.document.title, b.document.title) : a.time - b.time;
      if (order) return options.descending ? -order : order;
      if (a.document.id === b.document.id) return 0;
      return a.document.id < b.document.id ? -1 : 1;
    })
    .map(({ document }) => document);
}

function suggestedLabels(documents: DocPage[], projectId: string | null, labels: string[], query: string) {
  const search = documentLabelKey(query.trim());
  if (!search) return [];
  const seen = new Set(labels.map(documentLabelKey));
  const suggestions: string[] = [];
  for (const document of documents) {
    if (document.projectId !== projectId) continue;
    for (const label of document.labels ?? []) {
      const key = documentLabelKey(label);
      if (seen.has(key) || key === search || !key.includes(search)) continue;
      seen.add(key);
      suggestions.push(label);
      if (suggestions.length === 5) return suggestions.sort(titleSort.compare);
    }
  }
  return suggestions.sort(titleSort.compare);
}

function DocumentLabelListSettings({ options, data, onApply, onClose, onDraftChange }: {
  options: DocumentLabelListOptions | null;
  data: WorkspaceSnapshot;
  onApply: NonNullable<Props['onChange']>;
  onClose: () => void;
  onDraftChange: (dirty: boolean) => void;
}) {
  const [baseline] = useState(options);
  const [draft, setDraft] = useState<Draft>(() => {
    const value = options ?? DOCUMENT_LABEL_LIST_DEFAULTS;
    return { ...value, limit: String(value.limit) };
  });
  const [labelInput, setLabelInput] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const outdated = JSON.stringify(baseline) !== JSON.stringify(options);
  const missingProject = draft.projectId !== null && !data.projects.some(project => project.id === draft.projectId);
  const suggestions = useMemo(() => suggestedLabels(data.documents, draft.projectId, draft.labels, labelInput),
    [data.documents, draft.projectId, draft.labels, labelInput]);
  const startingOptions = baseline ?? DOCUMENT_LABEL_LIST_DEFAULTS;
  const dirty = Boolean(labelInput.trim()) || JSON.stringify(draft) !== JSON.stringify({ ...startingOptions, limit: String(startingOptions.limit) });

  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => {
    onDraftChange(dirty);
    return () => onDraftChange(false);
  }, [dirty, onDraftChange]);

  function setOption<Key extends keyof Draft>(key: Key, value: Draft[Key]) {
    setDraft(previous => ({ ...previous, [key]: value }));
    setError('');
  }

  function labelsWithInput(value = labelInput) {
    if (!value.trim()) return draft.labels;
    const label = normalizeDocumentLabel(value);
    if (!label) {
      setError(`라벨은 ${MAX_DOCUMENT_LABEL_LENGTH}자 이내로 입력해 주세요.`);
      return null;
    }
    if (draft.labels.some(value => documentLabelKey(value) === documentLabelKey(label))) {
      setError('이미 추가한 라벨입니다.');
      return null;
    }
    const labels = normalizeDocumentLabels([...draft.labels, label]);
    if (!labels) setError(`라벨은 ${MAX_DOCUMENT_LABELS}개까지 추가할 수 있습니다.`);
    return labels;
  }

  function addLabel(value = labelInput) {
    if (!value.trim()) return;
    const labels = labelsWithInput(value);
    if (!labels) return;
    setOption('labels', labels);
    setLabelInput('');
    input.current?.focus({ preventScroll: true });
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (outdated || missingProject) return;
    const labels = labelsWithInput();
    if (labels === null) return;
    const updated = normalizeDocumentLabelListOptions({ ...draft, labels, limit: Number(draft.limit) });
    if (!updated) {
      setError('문서 목록 제목과 최대 문서 수를 확인해 주세요.');
      return;
    }
    const changes = Object.fromEntries(Object.entries(updated).filter(([key, value]) =>
      !baseline || JSON.stringify(baseline[key as keyof DocumentLabelListOptions]) !== JSON.stringify(value))) as Partial<DocumentLabelListOptions>;
    if (Object.keys(changes).length) onApply(changes);
    onClose();
  }

  return <form className="doc-label-list-settings" aria-label="문서 목록 설정" onSubmit={apply} onKeyDown={event => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }}>
    <div className="doc-label-list-filter-labels">
      <label>목록 라벨
        <input ref={input} value={labelInput} onChange={event => { setLabelInput(event.target.value); setError(''); }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            addLabel();
          }} />
      </label>
      <button type="button" className="btn" onClick={() => addLabel()} disabled={!labelInput.trim()}>목록 라벨 추가</button>
      {!!suggestions.length && <div className="doc-label-list-suggestions" role="group" aria-label="기존 라벨 추천">
        {suggestions.map(label => <button key={label} type="button" className="btn btn-ghost" onClick={() => addLabel(label)}>{label}</button>)}
      </div>}
      {!!draft.labels.length && <ul className="doc-label-list-chips" aria-label="목록 라벨 조건">
        {draft.labels.map(label => <li key={label}>
          <span>{label}</span>
          <button type="button" aria-label={`목록 라벨 ${label} 삭제`} onClick={() => {
            setOption('labels', draft.labels.filter(value => value !== label));
            input.current?.focus({ preventScroll: true });
          }}><X size={13} aria-hidden="true" /></button>
        </li>)}
      </ul>}
    </div>
    <div className="doc-label-list-fields">
      <label>문서 목록 범위<select value={draft.projectId ?? ''} onChange={event => setOption('projectId', event.target.value || null)}>
        <option value="">팀 공통 문서</option>
        {missingProject && <option value={draft.projectId ?? ''}>찾을 수 없는 프로젝트</option>}
        {data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
      <label>라벨 일치 방식<select value={draft.match} onChange={event => setOption('match', event.target.value === 'all' ? 'all' : 'any')}>
        <option value="any">하나라도 일치</option><option value="all">모두 일치</option>
      </select></label>
      <label>문서 목록 정렬<select value={draft.sort} onChange={event => {
        const { value } = event.target;
        if (value === 'title' || value === 'created' || value === 'updated') setOption('sort', value);
      }}><option value="updated">수정일</option><option value="created">작성일</option><option value="title">제목</option></select></label>
      <label>최대 문서 수<input type="number" min={1} max={MAX_DOCUMENT_LABEL_LIST_LIMIT} step={1} required value={draft.limit}
        onChange={event => setOption('limit', event.target.value)} /></label>
      <label className="doc-label-list-title-input">목록 제목<input value={draft.title} maxLength={MAX_DOCUMENT_LABEL_LIST_TITLE_LENGTH}
        onChange={event => setOption('title', event.target.value)} /></label>
    </div>
    <div className="doc-label-list-checkboxes">
      <label><input type="checkbox" checked={draft.descending} onChange={event => setOption('descending', event.target.checked)} />내림차순</label>
      <label><input type="checkbox" checked={draft.showLabels} onChange={event => setOption('showLabels', event.target.checked)} />문서 라벨 표시</label>
      <label><input type="checkbox" checked={draft.showSpace} onChange={event => setOption('showSpace', event.target.checked)} />공간 이름 표시</label>
      <label><input type="checkbox" checked={draft.excludeCurrent} onChange={event => setOption('excludeCurrent', event.target.checked)} />현재 문서 제외</label>
    </div>
    {(outdated || error) && <p className="doc-label-list-error" role="alert">{outdated ? '목록 설정이 변경되었습니다. 창을 닫고 다시 열어 주세요.' : error}</p>}
    <div className="doc-label-list-settings-actions">
      <button type="button" className="btn btn-ghost" onClick={onClose}>취소</button>
      <button type="submit" className="btn btn-primary" disabled={outdated || missingProject}>목록 설정 적용</button>
    </div>
  </form>;
}

function DocumentLabelListRows({ documents, space, options, openDocument, limit }: {
  documents: DocPage[];
  space: string;
  options: DocumentLabelListOptions;
  openDocument: Props['openDocument'];
  limit: number;
}) {
  const [visible, setVisible] = useState(pageSize);
  const shown = documents.slice(0, Math.min(visible, limit));
  return <>
    {!!shown.length && <ul className="doc-label-list-rows">
      {shown.map(document => {
        const title = document.title || '제목 없는 문서';
        const row = <>
          <FileText size={14} aria-hidden="true" />
          <span className="doc-label-list-row-body">
            <span className="doc-label-list-document-name"><strong>{title}</strong>{options.showSpace && <small>{space}</small>}</span>
            {options.showLabels && !!document.labels?.length && <span className="doc-label-list-row-labels">
              {document.labels.map(label => <span key={label}>{label}</span>)}
            </span>}
          </span>
        </>;
        return <li key={document.id}>{openDocument ? <button type="button" className="doc-label-list-row" aria-label={`목록 문서 열기 ${title}`}
          onMouseDown={event => event.preventDefault()} onClick={event => { event.stopPropagation(); openDocument(document.id); }}>{row}</button>
          : <div className="doc-label-list-row">{row}</div>}</li>;
      })}
    </ul>}
    {shown.length < documents.length && <footer className="doc-label-list-footer">
      <span>{number.format(documents.length)}개 중 {number.format(shown.length)}개 표시</span>
      {shown.length < Math.min(limit, documents.length) && <button type="button" className="btn btn-ghost" onClick={() => setVisible(previous => previous + pageSize)}>문서 더 보기</button>}
    </footer>}
  </>;
}

export function DocumentLabelListCard({ attrs, data, documentId, openDocument, renderLimit, onChange, onDelete, onSettingsDraftChange }: Props) {
  const settingsButton = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsDirty = useRef(false);
  const trackDraft = useCallback((dirty: boolean) => {
    settingsDirty.current = dirty;
    onSettingsDraftChange?.(dirty);
  }, [onSettingsDraftChange]);
  const options = useMemo(() => normalizeDocumentLabelListOptions(attrs), [attrs]);
  const space = options?.projectId === null ? '팀 공통' : data.projects.find(project => project.id === options?.projectId)?.name;
  const matching = useMemo(() => options && space !== undefined ? matchingDocuments(data.documents, options, documentId) : [], [data.documents, documentId, options, space]);
  const limit = Math.min(options?.limit ?? 0, renderLimit === undefined ? Infinity : Math.max(0, Math.floor(renderLimit)));
  const editable = Boolean(onChange);

  function closeSettings() {
    setSettingsOpen(false);
    settingsButton.current?.focus({ preventScroll: true });
  }

  return <section className="doc-label-list" aria-label="라벨별 문서 목록">
    <header className="doc-label-list-heading">
      <ListFilter size={16} aria-hidden="true" />
      <strong>{options?.title || '라벨별 문서 목록'}</strong>
      {options && options.labels.length > 0 && space !== undefined && <span className="doc-label-list-count">{number.format(matching.length)}개</span>}
      {(editable || onDelete) && <div className="doc-label-list-actions">
        {editable && <button ref={settingsButton} type="button" className="btn btn-ghost docs-icon-button" aria-label="문서 목록 설정" aria-expanded={settingsOpen}
          title="문서 목록 설정" onClick={() => {
            if (!settingsOpen) setSettingsOpen(true);
            else if (!settingsDirty.current || window.confirm('적용하지 않은 문서 목록 설정을 버릴까요?')) closeSettings();
          }}><SlidersHorizontal size={14} aria-hidden="true" /></button>}
        {onDelete && <button type="button" className="btn btn-ghost docs-icon-button" aria-label="문서 목록 삭제" title="문서 목록 삭제"
          onMouseDown={event => event.preventDefault()} onClick={onDelete}><X size={14} aria-hidden="true" /></button>}
      </div>}
    </header>
    {settingsOpen && onChange && <DocumentLabelListSettings options={options} data={data} onApply={onChange} onClose={closeSettings} onDraftChange={trackDraft} />}
    {!options ? <p className="doc-label-list-message">문서 목록 설정을 확인해 주세요.</p>
      : space === undefined ? <p className="doc-label-list-message">목록의 프로젝트를 찾을 수 없습니다.</p>
        : !options.labels.length ? <p className="doc-label-list-message">목록에 표시할 문서의 라벨을 지정해 주세요.</p>
          : !matching.length ? <p className="doc-label-list-message">조건에 맞는 문서가 없습니다.</p>
            : <DocumentLabelListRows key={JSON.stringify(options)} documents={matching} space={space} options={options} openDocument={openDocument} limit={limit} />}
  </section>;
}
