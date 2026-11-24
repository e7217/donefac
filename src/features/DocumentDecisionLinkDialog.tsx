'use client';

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link2, X } from 'lucide-react';
import type { DocPage, DocumentDecisionSource, DocumentIssueLinkResult, DocumentSourceSelection, FeatureProps } from '../../shared/types';
import { issueSearchAliasLabel, matchingIssueSearchAliases, normalizeWorkspaceSearchKey } from '../../shared/workspace-search';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import './document-decision-link.css';

export type DecisionLinkSource = Pick<DocPage, 'id' | 'title' | 'version' | 'projectId'> & (
  { sourceSelection: DocumentSourceSelection } | { comment: { id: string; source: DocumentDecisionSource } }
);

type Props = Pick<FeatureProps, 'data' | 'actorId' | 'refresh' | 'notify'> & {
  source: DecisionLinkSource;
  onClose: () => void;
  reloadComments: () => void;
};
type Attempt = { actorId: string; issueId: string; body: string };

const RESULTS_LIMIT = 40;
const UNKNOWN_RESULT = '연결 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.';
const CONFIRM_UNKNOWN_CLOSE = '연결이 저장됐을 수 있습니다. 문서의 연결 목록에서 확인할 수 있습니다. 창을 닫을까요?';

export function DocumentDecisionLinkDialog({ source, data, actorId, refresh, notify, onClose, reloadComments }: Props) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const [project, setProject] = useState(source.projectId ?? '');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [replayRejected, setReplayRejected] = useState(false);
  const [sourceConflict, setSourceConflict] = useState(false);
  const [issueConflict, setIssueConflict] = useState<{ issueId: string; message: string } | null>(null);
  const [error, setError] = useState('');
  const excerpt = 'comment' in source ? source.comment.source : source.sourceSelection;

  const matches = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const keyQuery = normalizeWorkspaceSearchKey(query);
    return data.issues.flatMap(issue => {
      if (project && issue.projectId !== project) return [];
      const aliases = matchingIssueSearchAliases(data, issue.id, keyQuery);
      const currentKey = normalizeWorkspaceSearchKey(issue.key);
      if (search && !`${issue.key} ${issue.title}`.toLocaleLowerCase().includes(search) &&
          !(keyQuery && currentKey.includes(keyQuery)) && !aliases.length) return [];
      const exact = currentKey === keyQuery ? 2 : Number(issue.title.toLocaleLowerCase() === search ||
        aliases.some(alias => normalizeWorkspaceSearchKey(alias.key) === keyQuery));
      return [{ issue, aliases, exact }];
    }).sort((a, b) => b.exact - a.exact || a.issue.key.localeCompare(b.issue.key, undefined, { numeric: true }));
  }, [data, project, query]);
  const selected = data.issues.find(issue => issue.id === selectedId);
  const issueError = issueConflict?.issueId === selectedId ? issueConflict.message : '';
  const displayedError = error || issueError;
  const choices = matches.slice(0, RESULTS_LIMIT);
  if (selected && !choices.some(({ issue }) => issue.id === selected.id)) {
    choices.unshift(matches.find(({ issue }) => issue.id === selected.id) ?? { issue: selected, aliases: [], exact: 0 });
  }
  const linked = new Map(data.resourceLinks.filter(link => link.documentId === source.id).map(link => [link.issueId, link]));
  const projects = new Map(data.projects.map(value => [value.id, value.name]));

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    searchInput.current?.focus({ preventScroll: true });
    return () => element.close();
  }, []);

  useEffect(() => {
    function guard(event: Event) {
      if (event.defaultPrevented) return;
      if (pending.current) {
        event.preventDefault();
        notify('연결 결과를 확인한 뒤 이동해 주세요.', 'error');
      } else if (attempt.current && !window.confirm('연결이 저장됐을 수 있습니다. 돌아와서 문서의 연결 목록을 확인할 수 있습니다. 이동할까요?')) {
        event.preventDefault();
      } else {
        afterAcceptedNavigation(event, onClose);
      }
    }
    function unload(event: BeforeUnloadEvent) {
      if (pending.current || attempt.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    }
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [notify, onClose]);

  function close() {
    if (pending.current) return;
    const unknown = Boolean(attempt.current);
    if (unknown && !window.confirm(CONFIRM_UNKNOWN_CLOSE)) return;
    onClose();
    if (unknown) void refresh().catch(() => notify('연결 목록을 불러오지 못했습니다. 문서를 다시 열어 확인해 주세요.', 'error'));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || sourceConflict || replayRejected || (!attempt.current && (!selected || issueError))) return;
    const replay = Boolean(attempt.current);
    const request = attempt.current ?? { actorId, issueId: selectedId, body: JSON.stringify({
      requestId: newRequestId(), expectedDocumentVersion: source.version, issueId: selectedId,
      ...('comment' in source ? { sourceComment: { commentId: source.comment.id, revisionId: source.comment.source.revisionId } }
        : { sourceSelection: source.sourceSelection }),
    }) };
    let confirmed = false;
    pending.current = true;
    attempt.current = request;
    setBusy(true);
    setError('');
    try {
      const result = await api<DocumentIssueLinkResult>(`/documents/${encodeURIComponent(source.id)}/decision-links`, {
        method: 'POST', headers: { 'X-Actor-Id': request.actorId }, body: request.body,
      });
      const saved = result?.link?.documentSource;
      const { from, to, text } = excerpt;
      if (result?.issue?.id !== request.issueId || result.link?.issueId !== request.issueId || result.link.documentId !== source.id
        || !saved?.revisionId || saved.from !== from || saved.to !== to || saved.text !== text
        || ('comment' in source && saved.revisionId !== source.comment.source.revisionId)) throw new Error(UNKNOWN_RESULT);
      confirmed = true;
      await refresh();
      attempt.current = null;
      onClose();
      notify(`${result.issue.key} 업무에 결정 근거를 연결했습니다.`, 'success');
    } catch (cause) {
      const knownFailure = !confirmed && cause instanceof ApiError && [400, 401, 403, 404, 409, 422].includes(cause.status);
      if (knownFailure) {
        attempt.current = null;
        setRecovering(false);
        const details = cause.details as { currentVersion?: number; reason?: string } | undefined;
        const unavailableComment = details?.reason === 'comment_source_unavailable';
        const staleSource = unavailableComment || (cause.status === 409 &&
          (Number.isSafeInteger(details?.currentVersion) || details?.reason === 'source_selection_changed'));
        if (staleSource) setSourceConflict(true);
        if (replay) setReplayRejected(true);
        if (!staleSource && !replay && (cause.status === 409 || cause.status === 404)) {
          setIssueConflict({ issueId: request.issueId, message: cause.message });
        } else if (unavailableComment) {
          setError(cause.message);
        } else if (staleSource) {
          setError('comment' in source ? '문서의 저장본이 변경됐습니다. 최신 문서의 댓글에서 다시 열어 주세요.'
            : '문서의 저장본이 변경됐습니다. 문서에서 본문을 다시 선택해 주세요.');
        } else {
          setError(replay ? `${cause.message} 문서의 연결 목록을 확인해 주세요.` : cause.message);
        }
        if (unavailableComment) reloadComments();
        if (staleSource) await refresh().catch(() => {});
      } else {
        setRecovering(true);
        setError(confirmed ? '결정 근거를 연결했습니다. 목록을 다시 불러와 결과를 확인해 주세요.' : UNKNOWN_RESULT);
        requestAnimationFrame(() => submitButton.current?.focus({ preventScroll: true }));
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="document-decision-link-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); }
    }}>
    <form onSubmit={submit}>
      <header className="document-decision-link-header">
        <div><h2 id={titleId}>기존 업무에 결정 근거 연결</h2>
          <p>{source.title} · {'comment' in source ? '댓글의 원문 저장본' : `버전 ${source.version}`}</p></div>
        <button type="button" className="btn btn-ghost" aria-label="닫기" disabled={busy} onClick={close}><X size={19} aria-hidden="true" /></button>
      </header>
      <section className="document-decision-link-excerpt" aria-label={'comment' in source ? '댓글이 달린 본문' : '선택한 본문'}>
        <blockquote tabIndex={0}>{excerpt.text}</blockquote>
      </section>
      <fieldset disabled={busy || recovering || sourceConflict || replayRejected} className="document-decision-link-controls">
        <div className="document-decision-link-filters">
          <label>프로젝트<select className="field" value={project} onChange={event => { setProject(event.target.value); setSelectedId(''); setError(''); }}>
            <option value="">모든 프로젝트</option>
            {data.projects.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}
          </select></label>
          <label>업무 키 또는 제목 검색<input ref={searchInput} className="field" placeholder="현재·이전 업무 키 또는 제목" value={query} onChange={event => setQuery(event.target.value)} /></label>
        </div>
        <fieldset className="document-decision-link-results">
          <legend>연결할 업무</legend>
          {choices.length ? <div className="document-decision-link-choices">
            {choices.map(({ issue, aliases }) => {
              const link = linked.get(issue.id);
              return <label key={issue.id} className={`document-decision-link-choice${selectedId === issue.id ? ' is-selected' : ''}`}>
                <input type="radio" name="decision-link-issue" aria-label={`${issue.key} ${issue.title}`} checked={selectedId === issue.id}
                  onChange={() => { setSelectedId(issue.id); setError(''); }} />
                <span><span className="document-decision-link-key">{issue.key}</span> {issue.title}
                  <small>{projects.get(issue.projectId)}{link && (link.documentSource ? ' · 결정 근거 연결됨' : ' · 문서 연결됨')}</small>
                  {aliases.length > 0 && <small>{aliases.map(issueSearchAliasLabel).join(' · ')}</small>}
                </span>
              </label>;
            })}
          </div> : <p className="document-decision-link-empty">검색 조건에 맞는 업무가 없습니다.</p>}
          {matches.length > RESULTS_LIMIT && <p className="document-decision-link-empty">검색 결과 {matches.length}개 중 {RESULTS_LIMIT}개를 표시합니다.</p>}
        </fieldset>
      </fieldset>
      {displayedError && <p className="document-decision-link-error" role="alert">{displayedError}</p>}
      <footer>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>취소</button>
        <button ref={submitButton} type="submit" className="btn btn-primary"
          disabled={busy || sourceConflict || replayRejected || (!recovering && (!selected || Boolean(issueError)))}>
          <Link2 size={16} aria-hidden="true" />{busy ? '연결 중…' : recovering ? '연결 결과 다시 확인' : '선택한 업무에 연결'}
        </button>
      </footer>
    </form>
  </dialog>;
}
