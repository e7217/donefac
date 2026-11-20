'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { GitMerge, Link2, RefreshCw } from 'lucide-react';
import type { FeatureProps, GitlabLink, GitlabSettings } from '../../shared/types';
import { api, ApiError, post, remove } from '../lib/api';
import { GitlabActivityList, GitlabActivityRefresh } from './GitlabActivity';

type Props = Pick<FeatureProps, 'refresh' | 'notify'> & {
  issueId: string;
  issueKey: string;
  links: readonly GitlabLink[];
  disabled: boolean;
  onDraftChange: (dirty: boolean, pending: boolean, discard: () => void) => void;
};
type Draft = { repositoryId: string; url: string; existing?: GitlabLink };
type LinkView = { source: readonly GitlabLink[]; rows: readonly GitlabLink[] };

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : 'GitLab 연결 요청을 처리하지 못했습니다.';
}

export function IssueGitlabActivity({ issueId, issueKey, links, refresh, notify, disabled, onDraftChange }: Props) {
  const formHeading = useId(), unlinkHeading = useId();
  const [view, setView] = useState<LinkView>(() => ({ source: links, rows: links }));
  if (view.source !== links) setView({ source: links, rows: links });
  const visibleLinks = view.source === links ? view.rows : links;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<GitlabLink | null>(null);
  const [settings, setSettings] = useState<GitlabSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const settingsRequest = useRef<AbortController | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const focusAfterClose = useRef<{ target: HTMLButtonElement | null } | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const cancelUnlink = useRef<HTMLButtonElement>(null);
  const path = `/issues/${encodeURIComponent(issueId)}/gitlab-links`;

  useEffect(() => () => settingsRequest.current?.abort(), []);

  const discard = useCallback(() => {
    settingsRequest.current?.abort();
    setLoading(false);
    setDraft(null);
    setUnlinkTarget(null);
    setActionError('');
  }, []);
  const defaultRepository = draft?.existing?.projectId ?? (settings?.projectIds.length === 1 ? settings.projectIds[0] : undefined);
  const dirty = Boolean(draft && (draft.url.trim() !== (draft.existing?.webUrl ?? '') ||
    (draft.repositoryId && Number(draft.repositoryId) !== defaultRepository)));
  useLayoutEffect(() => {
    onDraftChange(dirty, busy, discard);
    return () => onDraftChange(false, false, discard);
  }, [dirty, busy, discard, onDraftChange]);
  useLayoutEffect(() => {
    if (draft || unlinkTarget || busy || disabled || !focusAfterClose.current) return;
    const { target } = focusAfterClose.current;
    focusAfterClose.current = null;
    (target?.isConnected && !target.disabled ? target : addButton.current)?.focus({ preventScroll: true });
  }, [draft, unlinkTarget, busy, disabled]);

  async function readSettings(defaultRepository: boolean) {
    settingsRequest.current?.abort();
    const controller = new AbortController();
    settingsRequest.current = controller;
    setLoading(true);
    setSettingsError('');
    setSettings(null);
    try {
      const result = await api<GitlabSettings>('/integrations/gitlab', { signal: controller.signal });
      if (controller.signal.aborted) return;
      setSettings(result);
      setDraft(current => {
        if (!current || result.projectIds.includes(Number(current.repositoryId))) return current;
        const selectOnlyRepo = defaultRepository && !current.repositoryId && result.projectIds.length === 1;
        return { ...current, repositoryId: selectOnlyRepo ? String(result.projectIds[0]) : '' };
      });
    } catch (cause) {
      if (!controller.signal.aborted) setSettingsError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function closeAction() {
    focusAfterClose.current = { target: opener.current };
    opener.current = null;
    discard();
  }

  function showEditor(trigger: HTMLButtonElement, link?: GitlabLink) {
    opener.current = trigger;
    setActionError('');
    setUnlinkTarget(null);
    setDraft({ repositoryId: link ? String(link.projectId) : '', url: link?.webUrl ?? '', existing: link });
    void readSettings(!link);
    requestAnimationFrame(() => linkInput.current?.focus());
  }

  function showUnlink(link: GitlabLink, trigger: HTMLButtonElement) {
    opener.current = trigger;
    setActionError('');
    setUnlinkTarget(link);
    requestAnimationFrame(() => cancelUnlink.current?.focus());
  }

  async function afterChange(message: string) {
    try {
      await refresh();
      notify(message);
    } catch {
      notify(`${message} GitLab 활동을 새로고침해 주세요.`, 'error');
    }
  }

  async function mutate(action: () => Promise<void>, recoverConflict: () => Promise<void>) {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true);
    setActionError('');
    try {
      await action();
    } catch (cause) {
      setActionError(errorMessage(cause));
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404)) await recoverConflict();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const noRepository = Boolean(settings && (!settings.baseUrl || !settings.projectIds.length));
  const canSubmit = Boolean(draft?.url.trim() && settings?.baseUrl && settings.projectIds.includes(Number(draft.repositoryId)));
  const target = unlinkTarget && visibleLinks.find(link => link.id === unlinkTarget.id);
  const staleTarget = unlinkTarget && target?.manualLinkId !== unlinkTarget.manualLinkId;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !settings || !canSubmit || loading) return;
    void mutate(async () => {
      const link = await post<GitlabLink>(path, {
        repositoryId: Number(draft.repositoryId), url: draft.url.trim(), expectedSettingsVersion: settings.version,
      });
      setView(current => ({ source: current.source, rows: [...current.rows.filter(row => row.id !== link.id), link] }));
      await afterChange(draft.existing ? 'GitLab 연결을 다시 확인했습니다.' : 'GitLab 연결을 저장했습니다.');
      closeAction();
    }, () => readSettings(false));
  }

  function unlink() {
    if (!unlinkTarget?.manualLinkId || staleTarget) return;
    const { id, manualLinkId } = unlinkTarget;
    void mutate(async () => {
      await remove(`${path}/${encodeURIComponent(id)}?${new URLSearchParams({ expectedManualLinkId: manualLinkId })}`);
      setView(current => ({ source: current.source, rows: current.rows.filter(row => row.id !== id) }));
      await afterChange('GitLab 연결을 해제했습니다.');
      closeAction();
    }, () => refresh().catch(() => undefined));
  }

  function cancelOnEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (!busy) closeAction();
  }

  const actionOpen = Boolean(draft || unlinkTarget);
  const controlsDisabled = disabled || busy;

  return <section className="issue-related-section" aria-label="GitLab">
    <div className="gitlab-activity-header"><h3><GitMerge aria-hidden="true" size={16} />GitLab <span>{visibleLinks.length}</span></h3>
      <div className="gitlab-activity-actions">
        <GitlabActivityRefresh refresh={refresh} notify={notify} disabled={controlsDisabled} />
        <button ref={addButton} className="btn" type="button" disabled={controlsDisabled || actionOpen}
          onClick={event => showEditor(event.currentTarget)}><Link2 aria-hidden="true" size={15} />GitLab 링크 추가</button>
      </div>
    </div>
    {draft && <form className="gitlab-activity-editor" aria-labelledby={formHeading} aria-busy={busy} onSubmit={submit} onKeyDown={cancelOnEscape}>
      <h4 id={formHeading}>{draft.existing ? 'GitLab 링크 다시 확인' : 'GitLab 링크 추가'}</h4>
      {loading && <p className="gitlab-activity-hint" role="status">GitLab 설정을 불러오는 중입니다.</p>}
      {settingsError && <p className="issue-form-error" role="alert">{settingsError}</p>}
      {noRepository && <p className="gitlab-activity-hint" role="status">개발 · GitLab에서 연결 주소와 저장소 ID를 저장해 주세요.</p>}
      {!noRepository && settings?.baseUrl && <p className="gitlab-activity-hint">연결 주소 {settings.baseUrl}</p>}
      <label className="issue-form-label">GitLab 저장소
        <select className="field" value={draft.repositoryId} disabled={controlsDisabled || loading || !settings || noRepository} required
          onChange={event => setDraft({ ...draft, repositoryId: event.target.value })}>
          <option value="">저장소 선택</option>
          {settings?.projectIds.map(id => <option value={id} key={id}>저장소 #{id}</option>)}
        </select>
      </label>
      <label className="issue-form-label">GitLab URL
        <input ref={linkInput} className="field" type="url" value={draft.url} autoComplete="off" spellCheck={false} maxLength={4000} required disabled={controlsDisabled}
          aria-describedby={`${formHeading}-url-help`} onChange={event => setDraft({ ...draft, url: event.target.value })} />
      </label>
      <p id={`${formHeading}-url-help`} className="gitlab-activity-hint">브랜치, 전체 SHA가 포함된 커밋, MR, 파이프라인 주소를 연결할 수 있습니다.</p>
      {actionError && <p className="issue-form-error" role="alert">{actionError}</p>}
      <div className="gitlab-activity-actions">
        <button className="btn btn-ghost" type="button" disabled={busy} onClick={closeAction}>취소</button>
        <button className="btn" type="button" disabled={controlsDisabled || loading} onClick={() => void readSettings(true)}>
          <RefreshCw aria-hidden="true" size={14} />설정 다시 불러오기
        </button>
        <button className="btn btn-primary" type="submit" disabled={controlsDisabled || loading || !canSubmit}>
          {busy ? '확인 중…' : 'GitLab 링크 연결'}
        </button>
      </div>
    </form>}
    {unlinkTarget && <div className="gitlab-activity-editor" role="group" aria-labelledby={unlinkHeading} aria-busy={busy} onKeyDown={cancelOnEscape}>
      <h4 id={unlinkHeading}>GitLab 연결 해제</h4>
      <p className="gitlab-activity-hint">{unlinkTarget.title}</p>
      {(actionError || staleTarget) && <p className="issue-form-error" role="alert">{actionError || '현재 연결이 변경되었습니다. 목록에서 다시 확인해 주세요.'}</p>}
      <div className="gitlab-activity-actions">
        <button ref={cancelUnlink} className="btn btn-ghost" type="button" disabled={busy} onClick={closeAction}>취소</button>
        <button className="btn issue-btn-danger" type="button" disabled={controlsDisabled || Boolean(staleTarget)} onClick={unlink}>연결 해제</button>
      </div>
    </div>}
    {visibleLinks.length ? <GitlabActivityList links={visibleLinks} manualActions={{ disabled: controlsDisabled || actionOpen,
      verify: (link, trigger) => showEditor(trigger, link), unlink: showUnlink }} />
      : <p className="issue-section-empty">연결된 개발 기록이 없습니다. 브랜치 이름이나 커밋 메시지에 {issueKey}를 넣어 자동으로 연결할 수 있습니다.</p>}
  </section>;
}
