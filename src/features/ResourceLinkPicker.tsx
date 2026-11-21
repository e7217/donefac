'use client';

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Link2, Search } from 'lucide-react';
import type { Project } from '../../shared/types';
import './resource-link-picker.css';

export type ResourceLinkCandidate = {
  id: string;
  title: string;
  projectId: string | null;
  key?: string;
  context?: string;
};

type Props = {
  kind: 'document' | 'issue';
  items: readonly ResourceLinkCandidate[];
  projects: readonly Pick<Project, 'id' | 'key' | 'name'>[];
  busy?: boolean;
  onLink: (id: string) => void | boolean | Promise<void | boolean>;
};

const PAGE_SIZE = 5;
const ALL_SCOPES = '';
const COMMON_SCOPE = 'common';
const sortLabels = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' }).compare;

const projectScope = (projectId: string) => `project:${projectId}`;
const normalizeSearch = (text: string) => text.trim().normalize('NFKC').toLocaleLowerCase('ko');

export function ResourceLinkPicker({ kind, items, projects, busy = false, onLink }: Props) {
  const documentPicker = kind === 'document';
  const label = documentPicker ? '문서' : '업무';
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState(ALL_SCOPES);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  const focusAfterLink = useRef<HTMLButtonElement | null>(null);
  const disabled = busy || submitting;
  const projectById = useMemo(() => new Map(projects.map(project => [project.id, project])), [projects]);
  const scopeOptions = useMemo(() => [...projects].sort((a, b) => sortLabels(a.name, b.name) || sortLabels(a.key, b.key)), [projects]);
  const candidates = useMemo(() => items.map(item => {
    const project = item.projectId === null ? undefined : projectById.get(item.projectId);
    const projectLabel = item.projectId === null ? '팀 공통 문서' : project?.name ?? '프로젝트';
    const title = item.title.trim() || `제목 없는 ${label}`;
    return {
      ...item,
      title,
      meta: [projectLabel, item.context].filter(Boolean).join(' › '),
      scope: item.projectId === null ? COMMON_SCOPE : projectScope(item.projectId),
      searchText: normalizeSearch([item.key, title, project?.key, projectLabel, item.context].filter(Boolean).join(' ')),
      searchKey: item.key ? normalizeSearch(item.key) : '',
    };
  }).sort((a, b) => sortLabels(a.title, b.title) || sortLabels(a.meta, b.meta) ||
    sortLabels(a.key ?? '', b.key ?? '') || sortLabels(a.id, b.id)), [items, label, projectById]);
  const knownScope = (documentPicker && scope === COMMON_SCOPE) || scopeOptions.some(project => projectScope(project.id) === scope);
  const activeScope = knownScope ? scope : ALL_SCOPES;
  const matches = useMemo(() => {
    const normalizedQuery = normalizeSearch(query);
    const terms = normalizedQuery.split(/\s+/u).filter(Boolean);
    const scoped = candidates.filter(candidate => (!activeScope || candidate.scope === activeScope) &&
      terms.every(term => candidate.searchText.includes(term)));
    if (documentPicker || !normalizedQuery) return scoped;
    return scoped.sort((a, b) => Number(b.searchKey === normalizedQuery) - Number(a.searchKey === normalizedQuery));
  }, [activeScope, candidates, documentPicker, query]);
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selected = matches.find(item => item.id === selectedId);
  const resultStatus = visible.length
    ? `검색 결과 ${matches.length}개${lastPage ? ` · ${currentPage + 1}/${lastPage + 1} 페이지` : ''}`
    : documentPicker ? '연결할 수 있는 문서가 없습니다.' : '연결할 수 있는 업무가 없습니다.';

  useEffect(() => {
    const trigger = focusAfterLink.current;
    if (disabled || !trigger) return;
    focusAfterLink.current = null;
    if (document.activeElement === document.body || document.activeElement === trigger) {
      const target = trigger.disabled ? search.current : trigger;
      target?.focus({ preventScroll: true });
    }
  }, [disabled]);

  function resetResults() {
    setPage(0);
    setSelectedId(null);
    setError('');
  }

  async function confirmLink(event: MouseEvent<HTMLButtonElement>) {
    if (!selected || disabled || pending.current) return;
    const trigger = event.currentTarget;
    pending.current = true;
    setSubmitting(true);
    setError('');
    try {
      if (await onLink(selected.id) !== false) {
        setSelectedId(null);
      }
    } catch {
      setError('연결을 저장하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      focusAfterLink.current = trigger;
      pending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="resource-link-picker" aria-label={`연결할 ${label} 선택`} aria-busy={disabled}>
      <div className="resource-link-filters">
        <label>
          <span>연결할 {label} 검색</span>
          <span className="resource-link-search">
            <Search size={15} aria-hidden="true" />
            <input ref={search} className="field" type="search" value={query} disabled={disabled}
              placeholder={documentPicker ? '제목 또는 상위 문서' : '업무 번호 또는 제목'}
              onChange={event => { setQuery(event.target.value); resetResults(); }}
              onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault(); }} />
          </span>
        </label>
        <label>
          <span>{documentPicker ? '문서 공간' : '업무 프로젝트'}</span>
          <select className="field" value={activeScope} disabled={disabled}
            onChange={event => { setScope(event.target.value); resetResults(); }}>
            <option value={ALL_SCOPES}>{documentPicker ? '모든 공간' : '모든 프로젝트'}</option>
            {documentPicker && <option value={COMMON_SCOPE}>팀 공통 문서</option>}
            {scopeOptions.map(project => (
              <option value={projectScope(project.id)} key={project.id}>{project.key} · {project.name}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="resource-link-result-status" role="status">{resultStatus}</p>
      {visible.length > 0 && <ul className="resource-link-results" aria-label={`${label} 검색 결과`} role="list">
        {visible.map(item => (
          <li key={item.id}>
            <button type="button" aria-pressed={item.id === selectedId} disabled={disabled}
              onClick={() => { setSelectedId(item.id === selectedId ? null : item.id); setError(''); }}>
              <span>
                <strong>{item.key && <><span>{item.key}</span>{' · '}</>}{item.title}</strong>
                <small>{item.meta}</small>
              </span>
              {item.id === selectedId && <Check size={15} aria-hidden="true" />}
            </button>
          </li>
        ))}
      </ul>}
      {lastPage > 0 && <nav className="resource-link-pages" aria-label={`${label} 검색 결과 페이지`}>
        <button className="btn btn-ghost" type="button" aria-label={`${label} 이전 페이지`} disabled={disabled || currentPage === 0}
          onClick={() => setPage(currentPage - 1)}><ArrowLeft size={15} aria-hidden="true" />이전</button>
        <button className="btn btn-ghost" type="button" aria-label={`${label} 다음 페이지`} disabled={disabled || currentPage === lastPage}
          onClick={() => setPage(currentPage + 1)}>다음<ArrowRight size={15} aria-hidden="true" /></button>
      </nav>}
      {error && <p className="resource-link-error" role="alert">{error}</p>}
      <div className="resource-link-confirm">
        {selected && <div className="resource-link-selection">
          <small>선택한 {label}</small>
          <strong>{selected.key && `${selected.key} · `}{selected.title}</strong>
          <small>{selected.meta}</small>
        </div>}
        <button className="btn btn-primary" type="button" disabled={disabled || !selected} onClick={event => void confirmLink(event)}>
          <Link2 size={14} aria-hidden="true" />{disabled && selected ? '연결 중…' : `${label} 연결`}
        </button>
      </div>
    </section>
  );
}
