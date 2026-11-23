'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type FormEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, ListTree, Plus, SlidersHorizontal, Table2, X } from 'lucide-react';
import { MAX_DOCUMENT_LABELS, MAX_DOCUMENT_LABEL_LENGTH } from '../../shared/document-labels';
import {
  collectDocumentPropertyReport, DOCUMENT_PROPERTIES_DEFAULTS, DOCUMENT_PROPERTY_REPORT_DEFAULTS, MAX_DOCUMENT_PROPERTY_ENTRIES,
  MAX_DOCUMENT_PROPERTY_GROUP_LENGTH, MAX_DOCUMENT_PROPERTY_NAME_LENGTH, MAX_DOCUMENT_PROPERTY_REPORT_LIMIT,
  MAX_DOCUMENT_PROPERTY_REPORT_TITLE_LENGTH, MAX_DOCUMENT_PROPERTY_VALUE_LENGTH,
  normalizeDocumentPropertiesOptions, normalizeDocumentPropertyReportOptions,
  type DocumentPropertiesOptions, type DocumentPropertyReportOptions,
} from '../../shared/document-properties';
import type { WorkspaceSnapshot } from '../../shared/types';
import './document-properties.css';

type DraftTracker = (dirty: boolean) => void;
type SettingsLifecycle = { onClose: () => void; onDraftChange: DraftTracker };
type EditorActions<Options> = {
  onChange?: (options: Options, baseline: Options | null) => boolean;
  onDelete?: () => void;
  onSettingsDraftChange?: DraftTracker;
};
type SettingsProps<Options> = SettingsLifecycle & {
  options: Options | null;
  onApply: NonNullable<EditorActions<Options>['onChange']>;
};

function useSettingsDraft<Options, Draft>(options: Options | null, fromOptions: (options: Options | null) => Draft,
  onDraftChange: DraftTracker, onClose: () => void) {
  const [baseline, setBaseline] = useState(options);
  const [draft, setDraft] = useState(() => fromOptions(options));
  const [error, setError] = useState('');
  const outdated = JSON.stringify(baseline) !== JSON.stringify(options);
  const dirty = JSON.stringify(draft) !== JSON.stringify(fromOptions(baseline));

  useLayoutEffect(() => {
    onDraftChange(dirty);
    return () => onDraftChange(false);
  }, [dirty, onDraftChange]);

  return {
    baseline, draft, error, outdated, setError,
    update(patch: Partial<Draft>) { setDraft(current => ({ ...current, ...patch })); setError(''); },
    cancel() { if (!dirty || window.confirm('적용하지 않은 설정을 버릴까요?')) onClose(); },
    loadLatest() {
      if (dirty && !window.confirm('입력한 값을 버리고 최신 설정을 불러올까요?')) return;
      setBaseline(options);
      setDraft(fromOptions(options));
      setError('');
    },
  };
}

function SettingsForm({ label, submitLabel, outdated, error, disabled, cancel, loadLatest, onSubmit, children }: {
  label: string;
  submitLabel: string;
  outdated: boolean;
  error: string;
  disabled?: boolean;
  cancel: () => void;
  loadLatest: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return <form className="doc-properties-form" aria-label={label} onSubmit={onSubmit} onKeyDown={event => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }}>
    {children}
    {outdated ? <p className="doc-properties-error" role="alert">다른 곳에서 이 블록을 변경했습니다. 입력한 값은 유지됩니다.</p>
      : error && <p className="doc-properties-error" role="alert">{error}</p>}
    <div className="doc-properties-form-actions">
      <button type="button" className="btn btn-ghost" onClick={cancel}>취소</button>
      {outdated && <button type="button" className="btn" onClick={loadLatest}>최신 설정 불러오기</button>}
      <button type="submit" className="btn btn-primary" disabled={outdated || disabled}>{submitLabel}</button>
    </div>
  </form>;
}

function PropertyBlock<Fields extends object>({ label, title, summary, icon, settings, onDelete, onSettingsDraftChange, children }: {
  label: string;
  title?: string;
  summary?: string;
  icon: ReactNode;
  settings?: { component: ComponentType<Fields & SettingsLifecycle>; props: Fields };
  onDelete?: () => void;
  onSettingsDraftChange?: DraftTracker;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const dirty = useRef(false);
  const Settings = settings?.component;
  const trackDraft = useCallback((value: boolean) => {
    dirty.current = value;
    onSettingsDraftChange?.(value);
  }, [onSettingsDraftChange]);

  function closeSettings() {
    setOpen(false);
    toggle.current?.focus({ preventScroll: true });
  }

  function toggleSettings() {
    if (!open) setOpen(true);
    else if (!dirty.current || window.confirm('적용하지 않은 설정을 버릴까요?')) closeSettings();
  }

  return <section className="doc-properties-block" aria-label={label}>
    <header className="doc-properties-heading">
      {icon}
      <strong>{title || label}</strong>
      {summary && <span>{summary}</span>}
      {(settings || onDelete) && <div className="doc-properties-actions">
        {settings && <button ref={toggle} type="button" className="btn btn-ghost docs-icon-button" title={`${label} 설정`} aria-label={`${label} 설정`}
          aria-expanded={open} onClick={toggleSettings}><SlidersHorizontal size={14} aria-hidden="true" /></button>}
        {onDelete && <button type="button" className="btn btn-ghost docs-icon-button" title={`${label} 삭제`} aria-label={`${label} 삭제`}
          onClick={() => { if (!dirty.current || window.confirm('적용하지 않은 설정을 버리고 블록을 삭제할까요?')) onDelete(); }}><X size={14} aria-hidden="true" /></button>}
      </div>}
    </header>
    {open && settings && Settings && <Settings {...settings.props} onDraftChange={trackDraft} onClose={closeSettings} />}
    {children}
  </section>;
}

function propertiesDraft(options: DocumentPropertiesOptions | null) { return options ?? DOCUMENT_PROPERTIES_DEFAULTS; }

function PropertiesSettings({ options, onApply, onClose, onDraftChange }: SettingsProps<DocumentPropertiesOptions>) {
  const state = useSettingsDraft(options, propertiesDraft, onDraftChange, onClose);
  const { draft } = state;
  const groupInput = useRef<HTMLInputElement>(null);
  const entryNames = useRef<(HTMLInputElement | null)[]>([]);

  useLayoutEffect(() => { groupInput.current?.focus({ preventScroll: true }); }, []);

  function changeEntry(index: number, change: Partial<DocumentPropertiesOptions['entries'][number]>) {
    state.update({ entries: draft.entries.map((entry, position) => position === index ? { ...entry, ...change } : entry) });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.outdated) return;
    const updated = normalizeDocumentPropertiesOptions(draft);
    if (!updated) {
      state.setError('속성마다 서로 다른 이름을 입력하고 그룹과 값의 길이를 확인해 주세요.');
      return;
    }
    if (JSON.stringify(updated) !== JSON.stringify(state.baseline) && !onApply(updated, state.baseline)) {
      state.setError('속성이 변경되었습니다. 최신 설정을 확인해 주세요.');
      return;
    }
    onClose();
  }

  return <SettingsForm {...state} label="문서 속성 설정" submitLabel="문서 속성 적용" onSubmit={submit}>
    <div className="doc-properties-fields">
      <label>속성 그룹<input ref={groupInput} value={draft.group} maxLength={MAX_DOCUMENT_PROPERTY_GROUP_LENGTH}
        onChange={event => state.update({ group: event.target.value })} /></label>
      <label className="doc-properties-check"><input type="checkbox" checked={draft.hidden}
        onChange={event => state.update({ hidden: event.target.checked })} />원본에서 숨기기</label>
    </div>
    {draft.entries.map(({ name, value }, index) => <div key={index} className="doc-properties-entry-fields">
      <label>속성 이름 {index + 1}<input ref={element => { entryNames.current[index] = element; }} value={name}
        maxLength={MAX_DOCUMENT_PROPERTY_NAME_LENGTH} onChange={event => changeEntry(index, { name: event.target.value })} /></label>
      <label>속성 값 {index + 1}<textarea rows={2} value={value} maxLength={MAX_DOCUMENT_PROPERTY_VALUE_LENGTH}
        onChange={event => changeEntry(index, { value: event.target.value })} /></label>
      <button type="button" className="btn btn-ghost docs-icon-button" aria-label={`속성 ${index + 1} 삭제`}
        onClick={() => state.update({ entries: draft.entries.filter((_, position) => position !== index) })}><X size={14} aria-hidden="true" /></button>
    </div>)}
    <button type="button" className="btn doc-properties-add" disabled={draft.entries.length >= MAX_DOCUMENT_PROPERTY_ENTRIES} onClick={() => {
      const index = draft.entries.length;
      state.update({ entries: [...draft.entries, { name: '', value: '' }] });
      requestAnimationFrame(() => entryNames.current[index]?.focus({ preventScroll: true }));
    }}><Plus size={14} aria-hidden="true" />속성 추가</button>
  </SettingsForm>;
}

export function DocumentPropertiesCard({ attrs, onChange, onDelete, onSettingsDraftChange }: EditorActions<DocumentPropertiesOptions> & { attrs?: Record<string, unknown> }) {
  const options = useMemo(() => normalizeDocumentPropertiesOptions(attrs), [attrs]);
  if (options?.hidden && !onChange) return null;
  const summary = [options?.group, options?.hidden ? '원본에서 숨김' : ''].filter(Boolean).join(' · ');
  return <PropertyBlock label="문서 속성" summary={summary} icon={<ListTree size={16} aria-hidden="true" />}
    onDelete={onDelete} onSettingsDraftChange={onSettingsDraftChange}
    settings={onChange ? { component: PropertiesSettings, props: { options, onApply: onChange } } : undefined}>
    {options?.entries.length ? <dl className="doc-properties-values">
      {options.entries.map(({ name, value }) => <div key={name}><dt>{name}</dt><dd>{value || '—'}</dd></div>)}
    </dl> : <p className="doc-properties-message">{options ? '입력한 속성이 없습니다.' : '저장된 문서 속성을 확인할 수 없습니다.'}</p>}
  </PropertyBlock>;
}

function reportDraft(options: DocumentPropertyReportOptions | null) {
  const source = options ?? DOCUMENT_PROPERTY_REPORT_DEFAULTS;
  return { ...source, labels: source.labels.join('\n'), columns: source.columns.join('\n'), limit: String(source.limit) };
}

function lines(text: string) { return text.split('\n').map(line => line.trim()).filter(Boolean); }

function ReportSettings({ options, projects, onApply, onClose, onDraftChange }: SettingsProps<DocumentPropertyReportOptions> & {
  projects: WorkspaceSnapshot['projects'];
}) {
  const state = useSettingsDraft(options, reportDraft, onDraftChange, onClose);
  const { draft } = state;
  const titleInput = useRef<HTMLInputElement>(null);
  const missingProject = draft.projectId !== null && !projects.some(project => project.id === draft.projectId);

  useLayoutEffect(() => { titleInput.current?.focus({ preventScroll: true }); }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.outdated || missingProject) return;
    const updated = normalizeDocumentPropertyReportOptions({ ...draft, labels: lines(draft.labels), columns: lines(draft.columns), limit: Number(draft.limit) });
    if (!updated) {
      state.setError(`라벨은 ${MAX_DOCUMENT_LABELS}개, 열은 ${MAX_DOCUMENT_PROPERTY_ENTRIES}개까지 입력할 수 있습니다. 줄마다 하나씩 쓰고 같은 이름의 열은 한 번만 입력해 주세요.`);
      return;
    }
    if (JSON.stringify(updated) !== JSON.stringify(state.baseline) && !onApply(updated, state.baseline)) {
      state.setError('보고서가 변경되었습니다. 최신 설정을 확인해 주세요.');
      return;
    }
    onClose();
  }

  return <SettingsForm {...state} label="문서 속성 보고서 설정" submitLabel="보고서 설정 적용" disabled={missingProject} onSubmit={submit}>
    <div className="doc-properties-fields">
      <label>보고서 제목<input ref={titleInput} maxLength={MAX_DOCUMENT_PROPERTY_REPORT_TITLE_LENGTH} value={draft.title}
        onChange={event => state.update({ title: event.target.value })} /></label>
      <label>문서 공간<select value={draft.projectId ?? ''} onChange={event => state.update({ projectId: event.target.value || null })}>
        <option value="">팀 공통 문서</option>
        {missingProject && <option value={draft.projectId ?? ''}>찾을 수 없는 프로젝트</option>}
        {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
      <label>속성 그룹<input value={draft.group} placeholder="모든 그룹" maxLength={MAX_DOCUMENT_PROPERTY_GROUP_LENGTH}
        onChange={event => state.update({ group: event.target.value })} /></label>
      <label>라벨 일치 방식<select value={draft.match} onChange={event => state.update({ match: event.target.value as DocumentPropertyReportOptions['match'] })}>
        <option value="all">모든 라벨</option><option value="any">라벨 하나 이상</option>
      </select></label>
      <label>문서 라벨<textarea rows={2} placeholder="한 줄에 라벨 하나" maxLength={MAX_DOCUMENT_LABELS * (MAX_DOCUMENT_LABEL_LENGTH + 1)}
        value={draft.labels} onChange={event => state.update({ labels: event.target.value })} /></label>
      <label>표시 열<textarea rows={2} placeholder="한 줄에 속성 이름 하나 · 비우면 자동" maxLength={MAX_DOCUMENT_PROPERTY_ENTRIES * (MAX_DOCUMENT_PROPERTY_NAME_LENGTH + 1)}
        value={draft.columns} onChange={event => state.update({ columns: event.target.value })} /></label>
      <label>정렬<select value={draft.sort} onChange={event => state.update({ sort: event.target.value as DocumentPropertyReportOptions['sort'] })}>
        <option value="title">문서 제목</option><option value="updated">수정일</option>
      </select></label>
      <label>최대 행 수<input required type="number" min={1} max={MAX_DOCUMENT_PROPERTY_REPORT_LIMIT} value={draft.limit}
        onChange={event => state.update({ limit: event.target.value })} /></label>
      <label className="doc-properties-check"><input type="checkbox" checked={draft.descending}
        onChange={event => state.update({ descending: event.target.checked })} />내림차순</label>
    </div>
  </SettingsForm>;
}

const REPORT_PAGE_SIZE = 20;
type Report = ReturnType<typeof collectDocumentPropertyReport>;

function ReportRows({ report, title, limit, documentId, openDocument }: {
  report: Report;
  title: string;
  limit: number;
  documentId: string | null;
  openDocument: (id: string) => void;
}) {
  const [requestedPage, setPage] = useState(1);
  const count = Math.min(limit, report.rows.length);
  const pageCount = Math.ceil(count / REPORT_PAGE_SIZE);
  const page = Math.min(requestedPage, pageCount);
  const first = (page - 1) * REPORT_PAGE_SIZE;
  const rows = report.rows.slice(first, Math.min(first + REPORT_PAGE_SIZE, count));
  const modified = (event: { button: number; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }) =>
    event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;

  return <>
    <div className="doc-properties-table-scroll" role="region" aria-label="문서 속성 보고서 표" tabIndex={0}>
      <table aria-label={title}><thead><tr><th scope="col">문서</th>{report.columns.map(name => <th key={name} scope="col">{name}</th>)}</tr></thead>
        <tbody>{rows.map(({ id, document, group, entries }) => {
          const title = document.title || '제목 없는 문서';
          return <tr key={id}><th scope="row">
            <a aria-label={`원본 문서 열기 ${title}`} aria-current={document.id === documentId ? 'page' : undefined}
              href={`#/${encodeURIComponent(document.projectId ?? 'all')}/documents/${encodeURIComponent(document.id)}`}
              onMouseDown={event => { if (!modified(event)) event.preventDefault(); }}
              onClick={event => {
                event.stopPropagation();
                if (!modified(event)) { event.preventDefault(); openDocument(document.id); }
              }}>{title}</a>
            {group && <small>{group}</small>}
          </th>{report.columns.map(name => <td key={name}>{Object.hasOwn(entries, name) && entries[name] ? entries[name] : '—'}</td>)}</tr>;
        })}</tbody>
      </table>
    </div>
    {(pageCount > 1 || count < report.total) && <footer className="doc-properties-pagination">
      <span role="status">{report.total.toLocaleString('ko-KR')}행 중 {(first + 1).toLocaleString('ko-KR')}–{(first + rows.length).toLocaleString('ko-KR')}행 표시</span>
      {pageCount > 1 && <div>
        <button type="button" className="btn btn-ghost" aria-label="보고서 이전 페이지" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={14} aria-hidden="true" /></button>
        <span>{page} / {pageCount}</span>
        <button type="button" className="btn btn-ghost" aria-label="보고서 다음 페이지" disabled={page >= pageCount} onClick={() => setPage(page + 1)}><ChevronRight size={14} aria-hidden="true" /></button>
      </div>}
    </footer>}
  </>;
}

export function DocumentPropertyReportCard({ attrs, data, documentId, openDocument, projection, renderLimit, onChange, onDelete, onSettingsDraftChange }:
EditorActions<DocumentPropertyReportOptions> & {
  attrs?: Record<string, unknown>;
  data: WorkspaceSnapshot;
  documentId: string | null;
  openDocument: (id: string) => void;
  projection?: Report;
  renderLimit?: number;
}) {
  const options = useMemo(() => normalizeDocumentPropertyReportOptions(attrs), [attrs]);
  const space = options?.projectId === null ? '팀 공통' : data.projects.find(project => project.id === options?.projectId)?.name;
  const report = useMemo(() => options && space !== undefined ? projection ?? collectDocumentPropertyReport(data.documents, options) : null,
    [data.documents, options, projection, space]);
  const title = options?.title || '문서 속성 보고서';
  const limit = renderLimit ?? report?.rows.length ?? 0;
  const summary = space === undefined ? '' : [space, options?.group, report?.total ? `${report.total.toLocaleString('ko-KR')}행` : ''].filter(Boolean).join(' · ');

  return <PropertyBlock label="문서 속성 보고서" title={title} summary={summary} icon={<Table2 size={16} aria-hidden="true" />}
    onDelete={onDelete} onSettingsDraftChange={onSettingsDraftChange}
    settings={onChange ? { component: ReportSettings, props: { projects: data.projects, options, onApply: onChange } } : undefined}>
    {options && report?.rows.length && limit > 0 ? <ReportRows key={JSON.stringify(options)} report={report} title={title}
      limit={limit} documentId={documentId} openDocument={openDocument} />
      : <p className="doc-properties-message">{!options ? '저장된 속성 보고서 설정을 확인할 수 없습니다.'
        : space === undefined ? '보고서의 프로젝트를 찾을 수 없습니다.'
          : !options.labels.length ? '속성을 모을 문서의 라벨을 지정해 주세요.'
            : report?.rows.length ? '보고서 표시 한도에 도달했습니다.' : '조건과 일치하는 문서 속성이 없습니다.'}</p>}
  </PropertyBlock>;
}
