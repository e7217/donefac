'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowRight, ExternalLink, GitBranch, RefreshCw } from 'lucide-react';
import { gitlabObjectSha, isGitlabBranchName } from '../../shared/gitlab-links';
import type { FeatureProps, GitlabIssueBranchResult, GitlabIssueBranchReview, GitlabIssueBranchTarget, GitlabLink, GitlabSettings } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { gitlabActivityUrl } from './GitlabActivity';

type Props = Pick<FeatureProps, 'refresh'> & {
  issueId: string;
  issueKey: string;
  settings: GitlabSettings | null;
  loadingSettings: boolean;
  settingsError: string;
  disabled: boolean;
  reloadSettings: () => void;
  onClose: () => void;
  onDraftChange: (dirty: boolean, pending: boolean) => void;
  onLinked: (link: GitlabLink) => void;
  onRevealBranch: (link: GitlabLink) => void;
};
type Action = 'preview' | 'apply' | 'reconcile' | 'refresh';
type Lookup = { repositoryId: number; branch: string };

const ambiguousApplyStatuses = new Set([408, 425, 499]);
const refreshSettingsReasons = new Set(['settings_changed', 'repository_not_configured']);
const resetReviewReasons = new Set(['review_required', 'settings_changed', 'issue_changed', 'issue_missing', 'repository_not_configured',
  'branch_claimed', 'gitlab_write_rejected']);
const actionLabels: Record<Action, string> = {
  preview: 'GitLab에서 저장소와 기준 커밋을 확인하는 중입니다.',
  apply: 'GitLab 브랜치를 만들고 있습니다.',
  reconcile: 'GitLab에서 브랜치 생성 결과를 확인하는 중입니다.',
  refresh: 'GitLab 활동 목록을 다시 불러오는 중입니다.',
};
const resultLabels: Record<GitlabIssueBranchResult['state'], string> = {
  created: 'GitLab 브랜치를 만들고 티켓에 연결했습니다.',
  found: 'GitLab에서 일치하는 브랜치를 확인하고 티켓에 연결했습니다.',
  existing: '이 이름은 이미 사용됐습니다. GitLab에서 브랜치를 확인한 뒤 링크를 추가하거나 다른 이름을 지정하세요.',
  pending: '브랜치 생성 결과를 아직 확인하지 못했습니다. GitLab에서 결과를 다시 확인하세요.',
  conflict: '현재 브랜치의 커밋이 검토한 기준과 다릅니다. GitLab에서 브랜치를 확인하세요.',
  link_needed: 'GitLab에서 브랜치를 확인했습니다. 티켓 연결을 다시 확인하세요.',
  deleted: '이전에 연결한 브랜치가 삭제되었습니다. 같은 이름을 사용하려면 브랜치를 다시 미리보세요.',
};

function errorReason(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== 'object' || !('reason' in error.details)) return;
  return typeof error.details.reason === 'string' ? error.details.reason : undefined;
}

function hasUncertainApply(error: unknown) {
  return !(error instanceof ApiError) || error.status >= 500 || ambiguousApplyStatuses.has(error.status);
}

function errorMessage(error: unknown, token?: string) {
  const message = error instanceof Error ? error.message : 'GitLab 브랜치 요청을 처리하지 못했습니다.';
  return token ? message.replaceAll(token, '[숨김]') : message;
}

function matchesTarget(value: GitlabIssueBranchReview, target: Lookup) {
  if (value?.target?.repositoryId !== target.repositoryId || value.target.branch !== target.branch) return false;
  if (value.state !== 'ready') return Object.hasOwn(resultLabels, value.state);
  const sha = gitlabObjectSha(value.target.sourceSha);
  return Boolean(typeof value.previewId === 'string' && value.previewId && Number.isFinite(Date.parse(value.expiresAt)) &&
    value.target.repositoryPath && value.target.ref && sha && !/^0+$/.test(sha));
}

export function IssueGitlabBranchCreate({ issueId, issueKey, settings, loadingSettings, settingsError,
  disabled, reloadSettings, refresh, onClose, onDraftChange, onLinked, onRevealBranch }: Props) {
  const id = useId();
  const branchInput = useRef<HTMLInputElement>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const reconcileButton = useRef<HTMLButtonElement>(null);
  const resultMessage = useRef<HTMLParagraphElement>(null);
  const request = useRef<AbortController | null>(null);
  const defaultBranch = `feature/${issueKey}`;
  const [branch, setBranch] = useState(defaultBranch);
  const [ref, setRef] = useState('');
  const [selectedRepository, setSelectedRepository] = useState('');
  const [readToken, setReadToken] = useState('');
  const [writeToken, setWriteToken] = useState('');
  const [review, setReview] = useState<GitlabIssueBranchReview | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const defaultRepository = settings?.projectIds.length === 1 ? String(settings.projectIds[0]) : '';
  const ready = review?.state === 'ready' ? review : null;
  const result = review && review.state !== 'ready' ? review : null;
  const linkedBranch = result?.state === 'created' || result?.state === 'found' ? result.link : undefined;
  const linked = Boolean(linkedBranch);
  const canCheck = result?.state === 'pending' || result?.state === 'link_needed' || result?.state === 'conflict';
  const outstanding = result?.state === 'pending' || result?.state === 'link_needed';
  const repository = outstanding ? String(result.target.repositoryId) : selectedRepository || defaultRepository;
  const target: Lookup = { repositoryId: Number(repository), branch: branch.trim() };
  const unavailable = !settings?.baseUrl || !settings.projectIds.length;
  const configuredRepository = Boolean(settings?.projectIds.includes(target.repositoryId));
  const locked = Boolean(disabled || busy || linked || outstanding);
  const dirty = !linked && Boolean(outstanding || branch !== defaultBranch || ref ||
    (selectedRepository && selectedRepository !== defaultRepository) || readToken || writeToken);
  const branchValid = isGitlabBranchName(target.branch) && !gitlabObjectSha(target.branch);
  const refValid = !ref.trim() || isGitlabBranchName(ref.trim());
  const canPreview = !locked && !loadingSettings && !unavailable && configuredRepository && branchValid && refValid;
  const targetUrl = result && result.state !== 'pending' && result.state !== 'deleted'
    ? gitlabActivityUrl(result.target.webUrl, 'branch') : null;

  useLayoutEffect(() => {
    branchInput.current?.focus();
    return () => request.current?.abort();
  }, []);
  useLayoutEffect(() => onDraftChange(dirty, busy !== null), [busy, dirty, onDraftChange]);
  useLayoutEffect(() => {
    if (busy || !review) return;
    if (review.state === 'ready') tokenInput.current?.focus({ preventScroll: true });
    else if (canCheck && reconcileButton.current && !reconcileButton.current.disabled) reconcileButton.current.focus({ preventScroll: true });
    else resultMessage.current?.focus({ preventScroll: true });
  }, [busy, canCheck, review]);
  useEffect(() => {
    if (!ready) return;
    const timeout = window.setTimeout(() => {
      setExpired(true);
      setWriteToken('');
    }, Math.max(0, Date.parse(ready.expiresAt) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [ready]);

  function changeInput() {
    setReview(null);
    setWriteToken('');
    setError('');
    setExpired(false);
  }

  function close() {
    if (request.current) return;
    if (outstanding && !window.confirm('GitLab 브랜치가 생성됐을 수 있습니다. 결과 확인을 닫을까요?')) return;
    if (!outstanding && dirty && !window.confirm('입력한 브랜치 정보를 버릴까요?')) return;
    onClose();
  }

  function onEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function begin(action: Action) {
    if (request.current || disabled) return null;
    const controller = new AbortController();
    request.current = controller;
    onDraftChange(dirty, true);
    setBusy(action);
    setError('');
    return controller;
  }

  function finish(controller: AbortController) {
    if (request.current !== controller) return;
    request.current = null;
    if (!controller.signal.aborted) setBusy(null);
  }

  async function reloadActivity(signal: AbortSignal) {
    try {
      await refresh();
      if (!signal.aborted) setRefreshFailed(false);
    } catch {
      if (!signal.aborted) setRefreshFailed(true);
    }
  }

  async function reflect(value: GitlabIssueBranchResult, signal: AbortSignal) {
    const link = value.link;
    const validLink = link?.issueId === issueId && link.kind === 'branch' && link.projectId === value.target.repositoryId &&
      link.sourceBranch === value.target.branch;
    if ((value.state === 'created' || value.state === 'found') && !validLink) {
      setReview({ ...value, state: 'link_needed', link: undefined });
      return;
    }
    setReview(value);
    if (validLink && (value.state === 'created' || value.state === 'found')) {
      onLinked(link);
      await reloadActivity(signal);
    }
  }

  async function perform(action: Exclude<Action, 'refresh'>, body: Record<string, unknown>, lookup: Lookup,
    token?: string, appliedTarget?: GitlabIssueBranchTarget) {
    const controller = begin(action);
    if (!controller) return;
    if (action === 'apply') setWriteToken('');
    else setReadToken('');
    try {
      const value = await api<GitlabIssueBranchReview>(`/issues/${encodeURIComponent(issueId)}/gitlab-branch/${action}`, {
        method: 'POST', signal: controller.signal, cache: 'no-store', body: JSON.stringify(body),
      });
      if (controller.signal.aborted) return;
      if (!matchesTarget(value, lookup) || (action !== 'preview' && value.state === 'ready')) {
        throw new Error('GitLab 응답에서 요청한 브랜치를 확인할 수 없습니다.');
      }
      if (value.state === 'ready') {
        setExpired(false);
        setReview(value);
      } else await reflect(value, controller.signal);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (action === 'apply' && appliedTarget && hasUncertainApply(cause)) {
        setReview({ state: 'pending', target: appliedTarget });
        return;
      }
      const reason = errorReason(cause);
      if (reason && refreshSettingsReasons.has(reason)) reloadSettings();
      if (action === 'apply' && (reason && resetReviewReasons.has(reason) || cause instanceof ApiError && cause.status === 409)) {
        setReview(null);
      }
      if (action === 'reconcile' && reason === 'attempt_missing') {
        setReview(null);
        setError('저장한 생성 요청이 없습니다. 브랜치 미리보기에서 GitLab의 현재 상태를 다시 확인해 주세요.');
      } else setError(errorMessage(cause, token));
    } finally {
      finish(controller);
    }
  }

  function preview() {
    if (!canPreview || !settings) return;
    setReview(null);
    setWriteToken('');
    const credential = readToken.trim();
    void perform('preview', { ...target, expectedSettingsVersion: settings.version,
      ...(ref.trim() ? { ref: ref.trim() } : {}), ...(credential ? { accessToken: credential } : {}) }, target, credential);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) { preview(); return; }
    if (loadingSettings || locked || !settings || !configuredRepository || !writeToken.trim()) return;
    if (expired || Date.parse(ready.expiresAt) <= Date.now()) {
      setWriteToken('');
      setExpired(true);
      return;
    }
    void perform('apply', { previewId: ready.previewId, writeToken: writeToken.trim() }, ready.target, writeToken.trim(), ready.target);
  }

  function reconcile() {
    if (!result || !canCheck || !settings || loadingSettings || disabled || !settings.projectIds.includes(result.target.repositoryId)) return;
    const lookup = { repositoryId: result.target.repositoryId, branch: result.target.branch };
    const credential = readToken.trim();
    void perform('reconcile', { ...lookup, expectedSettingsVersion: settings.version,
      ...(credential ? { accessToken: credential } : {}) }, lookup, credential);
  }

  async function retryActivity() {
    const controller = begin('refresh');
    if (!controller) return;
    try { await reloadActivity(controller.signal); }
    finally { finish(controller); }
  }

  return <form className="gitlab-activity-editor gitlab-branch-editor" aria-labelledby={`${id}-title`} aria-busy={busy !== null}
    onSubmit={apply} onKeyDown={onEscape}>
    <h4 id={`${id}-title`}>GitLab 브랜치 만들기</h4>
    {loadingSettings && <p className="gitlab-activity-hint" role="status">GitLab 설정을 불러오는 중입니다.</p>}
    {settingsError && <p className="issue-form-error" role="alert">{settingsError}</p>}
    {settings && unavailable && <p className="gitlab-activity-hint" role="status">개발 · GitLab에서 연결 주소와 저장소를 설정해 주세요.</p>}
    {settings?.baseUrl && <p className="gitlab-activity-hint">연결 주소 <code>{settings.baseUrl}</code></p>}
    {!linked && <>
      <label className="issue-form-label" htmlFor={`${id}-repository`}>GitLab 저장소</label>
      <select id={`${id}-repository`} className="field" value={repository} disabled={locked || loadingSettings || unavailable}
        onChange={event => { setSelectedRepository(event.target.value); changeInput(); }}>
        <option value="">저장소 선택</option>
        {repository && !configuredRepository && <option value={repository} disabled>저장소 #{repository} · 현재 설정에 없음</option>}
        {settings?.projectIds.map(repositoryId => <option value={repositoryId} key={repositoryId}>저장소 #{repositoryId}</option>)}
      </select>
      <label className="issue-form-label" htmlFor={`${id}-branch`}>브랜치 이름</label>
      <input ref={branchInput} id={`${id}-branch`} className="field" value={branch} maxLength={512} disabled={locked}
        autoComplete="off" spellCheck={false} aria-describedby={`${id}-name-help`}
        onChange={event => { setBranch(event.target.value); changeInput(); }} />
      <p id={`${id}-name-help`} className="gitlab-activity-hint">커밋과 MR을 자동으로 연결하려면 브랜치 이름에 {issueKey}를 포함하세요.</p>
      <label className="issue-form-label" htmlFor={`${id}-ref`}>기준 브랜치 또는 커밋</label>
      <input id={`${id}-ref`} className="field" value={ref} maxLength={512} disabled={locked}
        placeholder="저장소 기본 브랜치" autoComplete="off" spellCheck={false}
        onChange={event => { setRef(event.target.value); changeInput(); }} />
      {branch.trim() && !branchValid && <p className="gitlab-activity-hint">Git 브랜치 이름 형식에 맞게 입력해 주세요.</p>}
      {!refValid && <p className="gitlab-activity-hint">기준 브랜치 이름이나 전체 커밋 SHA를 입력해 주세요.</p>}
      {!ready && <details className="gitlab-branch-read-token">
        <summary>조회용 토큰 지정</summary>
        <label className="issue-form-label" htmlFor={`${id}-read-token`}>조회용 GitLab API 토큰</label>
        <input id={`${id}-read-token`} className="field" type="password" value={readToken} maxLength={2000} autoComplete="new-password"
          disabled={disabled || busy !== null} onChange={event => setReadToken(event.target.value)} />
      </details>}
    </>}
    {review && <dl className="gitlab-branch-target" aria-label="확인한 브랜치 대상">
      <dt>저장소 경로</dt><dd>{review.target.repositoryPath}</dd>
      <dt>새 브랜치</dt><dd><code>{review.target.branch}</code></dd>
      <dt>기준 참조</dt><dd><code>{review.target.ref || '확인 불가'}</code></dd>
      <dt>기준 커밋 SHA</dt><dd><code>{review.target.sourceSha || '확인 불가'}</code></dd>
      {result?.observedSha && <><dt>확인한 커밋 SHA</dt><dd><code>{result.observedSha}</code></dd></>}
    </dl>}
    {ready && <>
      <label className="issue-form-label" htmlFor={`${id}-write-token`}>GitLab API 토큰</label>
      <input ref={tokenInput} id={`${id}-write-token`} className="field" type="password" value={writeToken} maxLength={2000}
        autoComplete="new-password" disabled={locked || expired} aria-describedby={`${id}-write-help`}
        onChange={event => setWriteToken(event.target.value)} />
      <p id={`${id}-write-help`} className="gitlab-activity-hint">이 저장소에서 브랜치를 만들 수 있는 <code>api</code> 토큰을 입력하세요. 토큰은 이 요청에만 사용됩니다.</p>
      {expired && <p className="gitlab-activity-hint" role="status">미리보기가 만료되었습니다. 다시 확인해 주세요.</p>}
    </>}
    {busy && <p className="gitlab-activity-hint" role="status">{actionLabels[busy]}</p>}
    {result && <p ref={resultMessage} className="gitlab-activity-hint" tabIndex={-1} role="status">{resultLabels[result.state]}</p>}
    {targetUrl && <a className="gitlab-activity-target" href={targetUrl.href} target="_blank" rel="noreferrer">
      GitLab에서 브랜치 열기<ExternalLink size={14} aria-hidden="true" />
    </a>}
    {error && <p className="issue-form-error" role="alert">{error}</p>}
    {refreshFailed && <p className="issue-form-error" role="alert">브랜치 연결은 저장되었습니다. 활동 목록을 다시 불러오세요.</p>}
    <div className="gitlab-activity-actions">
      <button className="btn btn-ghost" type="button" disabled={busy !== null} onClick={close}>닫기</button>
      {linkedBranch && <button className="btn btn-primary" type="button" disabled={disabled || busy !== null}
        onClick={() => onRevealBranch(linkedBranch)}>
        <ArrowRight size={15} aria-hidden="true" />티켓에서 연결한 브랜치 보기
      </button>}
      {!linked && <button className="btn" type="button" disabled={disabled || busy !== null || loadingSettings} onClick={() => {
        if (ready) changeInput();
        setReadToken('');
        reloadSettings();
      }}>
        <RefreshCw aria-hidden="true" size={14} />설정 다시 불러오기
      </button>}
      {canPreview && ready && <button className="btn" type="button" onClick={preview}>브랜치 미리보기</button>}
      {!ready && !linked && !outstanding && <button className="btn btn-primary" type="submit" disabled={!canPreview}>브랜치 미리보기</button>}
      {ready && <button className="btn btn-primary" type="submit" disabled={locked || loadingSettings || !configuredRepository || expired || !writeToken.trim()}>
        <GitBranch size={15} aria-hidden="true" />GitLab 브랜치 만들기
      </button>}
      {canCheck && <button className="btn" ref={reconcileButton} type="button" disabled={disabled || busy !== null || loadingSettings ||
        !settings?.projectIds.includes(result.target.repositoryId)} onClick={reconcile}>생성 결과 다시 확인</button>}
      {outstanding && <button className="btn btn-ghost" type="button" disabled={disabled || busy !== null} onClick={() => {
        changeInput();
        branchInput.current?.focus({ preventScroll: true });
      }}>다른 브랜치 지정</button>}
      {refreshFailed && <button className="btn" type="button" disabled={disabled || busy !== null} onClick={() => void retryActivity()}>활동 목록 다시 불러오기</button>}
    </div>
  </form>;
}
