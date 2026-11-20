'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { GitlabRepositoryCandidate, GitlabRepositorySearch } from '../../shared/types';
import { api } from '../lib/api';

type SearchState = {
  result: GitlabRepositorySearch | null;
  loading: boolean;
  error: string;
};

const emptySearch: SearchState = { result: null, loading: false, error: '' };
const searchPath = '/integrations/gitlab/repository-search';

export function GitlabRepositoryPicker({ baseUrl, token, settingsVersion, selectedIds, maxRepositories, onAdd }: {
  baseUrl: string;
  token: string;
  settingsVersion: number;
  selectedIds: number[];
  maxRepositories: number;
  onAdd: (id: number) => void;
}) {
  const headingId = useId();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchState>(emptySearch);
  const [selectionError, setSelectionError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const pending = useRef<AbortController | null>(null);
  const canSearch = Boolean(baseUrl.trim() && query.trim());
  const atCapacity = selectedIds.length >= maxRepositories;

  useEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
  }, []);

  function changeQuery(value: string) {
    pending.current?.abort();
    pending.current = null;
    setQuery(value);
    setSearch(emptySearch);
    setSelectionError('');
    setAnnouncement('');
  }

  async function load(page: number) {
    if (!canSearch || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setSearch(previous => ({ ...previous, loading: true, error: '' }));
    setSelectionError('');
    setAnnouncement('');
    try {
      const result = await api<GitlabRepositorySearch>(searchPath, {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ expectedVersion: settingsVersion, baseUrl, ...(token ? { token } : {}), query: query.trim(), page }),
      });
      if (result.settingsVersion !== settingsVersion || result.page !== page) throw new Error('설정과 일치하는 검색 결과를 받지 못했습니다.');
      if (pending.current === controller) setSearch({ result, loading: false, error: '' });
    } catch (cause) {
      if (pending.current === controller) {
        const error = cause instanceof Error ? cause.message : 'GitLab 저장소를 검색하지 못했습니다.';
        setSearch(previous => ({ ...previous, loading: false, error }));
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

  function add(repository: GitlabRepositoryCandidate) {
    if (atCapacity || selectedIds.includes(repository.id)) return;
    try {
      onAdd(repository.id);
      setSelectionError('');
      setAnnouncement(`${repository.pathWithNamespace} 저장소를 추가했습니다.`);
    } catch (cause) {
      setAnnouncement('');
      setSelectionError(cause instanceof Error ? cause.message : '저장소를 추가하지 못했습니다.');
    }
  }

  const { result, loading, error } = search;
  const hasPagination = result && (result.page > 1 || result.hasNextPage);
  const resultAnnouncement = !loading && !error && result && result.repositories.length > 0
    ? `${result.page}페이지에서 저장소 ${result.repositories.length}개를 찾았습니다.` : '';

  return <section className="gitlab-repository-picker" aria-labelledby={headingId}>
    <h3 id={headingId}>GitLab 저장소 찾기</h3>
    <div className="gitlab-repository-search-controls">
      <label className="form-label">저장소 이름 또는 전체 경로
        <input className="field" type="search" value={query} autoComplete="off" maxLength={200}
          onChange={event => changeQuery(event.target.value)} onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void load(1);
          }} />
      </label>
      <button className="btn" type="button" disabled={!canSearch || loading} onClick={() => void load(1)}>
        <Search size={15} aria-hidden="true" />저장소 검색
      </button>
    </div>
    {loading && <p className="help-text" role="status">GitLab 저장소를 조회하는 중입니다.</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {selectionError && <p className="error-text" role="alert">{selectionError}</p>}
    <div className="sr-only" role="status">{announcement || resultAnnouncement}</div>
    {result && result.repositories.length === 0 && !loading && <p className="help-text" role="status">이 페이지에 일치하는 저장소가 없습니다.</p>}
    {result && result.repositories.length > 0 && <ul className="gitlab-repository-search-results" aria-label="GitLab 저장소 검색 결과">
      {result.repositories.map(repository => {
        const selected = selectedIds.includes(repository.id);
        return <li key={repository.id}>
          <div className="gitlab-repository-result-name">
            <a href={repository.webUrl} target="_blank" rel="noreferrer">{repository.name}<span className="sr-only"> GitLab에서 새 탭으로 열기</span></a>
            <small>{repository.pathWithNamespace} · ID {repository.id}</small>
          </div>
          <button className="btn btn-ghost" type="button" aria-disabled={selected || atCapacity || loading}
            aria-label={`${repository.pathWithNamespace} 저장소 ${selected ? '추가됨' : '추가'}`}
            onClick={() => { if (!loading) add(repository); }}>
            {selected ? '추가됨' : '추가'}
          </button>
        </li>;
      })}
    </ul>}
    {atCapacity && result && <p className="help-text" role="status">최대 {maxRepositories}개까지 저장소를 선택할 수 있습니다.</p>}
    {hasPagination && <nav className="gitlab-repository-search-pages" aria-label="저장소 검색 페이지">
      <button className="btn btn-ghost" type="button" aria-label="저장소 이전 페이지" disabled={loading || result.page <= 1}
        onClick={() => void load(result.page - 1)}>이전</button>
      <span className="help-text">{result.page}페이지</span>
      <button className="btn btn-ghost" type="button" aria-label="저장소 다음 페이지" disabled={loading || !result.hasNextPage}
        onClick={() => void load(result.page + 1)}>다음</button>
    </nav>}
  </section>;
}
