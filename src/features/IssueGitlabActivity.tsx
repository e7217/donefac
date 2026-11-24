'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { ArrowRight, ExternalLink, GitBranch, GitMerge, Link2, RefreshCw } from 'lucide-react';
import { AUTOMATION_TRIGGER_LABELS } from '../../shared/automation';
import { GITLAB_DEPLOYMENT_STATES, type FeatureProps, type GitlabBranchMergeRequestAttachment, type GitlabDeployment,
  type GitlabDeploymentReviewResult, type GitlabIssueRefreshResult, type GitlabLink, type GitlabSettings,
  type GitlabStatusSuggestion } from '../../shared/types';
import { api, ApiError, apiResponse, post, remove } from '../lib/api';
import type { GitlabIssueReviewSelection } from '../lib/issue-review';
import { gitlabActivityKindLabel, gitlabActivityStateLabel, gitlabActivityUrl, gitlabBranchMergeRequestsPath, GitlabActivityList,
  GitlabActivityRefresh, gitlabLinkedStatusRefreshPath, gitlabMergeRequestPipelinePath, isGitlabLinkedStatusRefreshResult,
  matchesBranchMergeRequestLink, matchesMergeRequestPipelineLink,
  type BranchMergeRequest, type GitlabLinkedStatusAction, type MergeRequestObservedPipeline } from './GitlabActivity';
import { IssueGitlabBranchCreate } from './IssueGitlabBranchCreate';
import { deploymentSource, gitlabDeploymentKey, gitlabDeploymentStatusLabels, IssueGitlabDeployments } from './GitlabDeployments';

type Props = Pick<FeatureProps, 'refresh' | 'notify'> & {
  issueId: string;
  issueKey: string;
  issueVersion: number;
  links: readonly GitlabLink[];
  gitlabActivitySelection?: GitlabIssueReviewSelection;
  gitlabActivityFocusRef: RefObject<boolean>;
  disabled: boolean;
  onDraftChange: (dirty: boolean, pending: boolean, discard: () => void) => void;
  isCurrentStatusSuggestion: (suggestion: GitlabStatusSuggestion) => boolean;
  canPrepareStatusSuggestion: (suggestion: GitlabStatusSuggestion) => boolean;
  onPrepareStatusSuggestion: (suggestion: GitlabStatusSuggestion) => void;
};
type Draft = { repositoryId: string; url: string; existing?: GitlabLink };
type LinkView = { source: readonly GitlabLink[]; rows: readonly GitlabLink[] };
type RefreshFailure = GitlabIssueRefreshResult['failures'][number] & { label: string };
type CheckingFeedback = { kind: 'checking'; linkId?: string; deploymentKey?: string; action: GitlabLinkedStatusAction };
type RefreshFeedback = CheckingFeedback | { kind: 'failed'; message: string } | {
  kind: 'finished'; checked: number; skipped: number; failures: RefreshFailure[]; workspaceRefreshFailed: boolean;
  issueVersion: number;
  statusReview?: GitlabIssueRefreshResult['statusReview'];
  pipelineReview?: GitlabIssueRefreshResult['pipelineReview'];
  selectedReview?: 'reviewed' | 'no-proposal';
  verifiedState?: { label: string; state: string };
  deploymentReview?: GitlabDeploymentReviewResult['state'];
};

const deploymentReviewMessages: Record<Exclude<GitlabDeploymentReviewResult['state'], 'ready'>, string> = {
  'not-success': '이 배포가 성공하면 상태 변경을 검토할 수 있습니다.',
  'completion-unverified': 'GitLab에서 이 배포 작업의 완료 시각을 확인할 수 없습니다.',
  superseded: '같은 환경에 더 최근에 완료된 성공 배포가 있습니다.',
  'latest-unverified': '이 배포가 같은 환경의 최신 성공 배포인지 확인할 수 없습니다.',
  'link-unverified': '이 배포와 티켓의 자동 연결을 확인할 수 없습니다.',
  'no-rule': '이 배포로 제안할 상태 변경이 없습니다.',
};

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : 'GitLab 연결 요청을 처리하지 못했습니다.';
}

function gitlabLinkLabel(link: GitlabLink) {
  const kind = gitlabActivityKindLabel(link.kind);
  return link.kind === 'branch' ? `${kind} ${link.sourceBranch || link.title}`
    : `${kind} ${link.kind === 'merge_request' ? '!' : '#'}${link.iid} ${link.title}`;
}

function matchesDeploymentReview(result: GitlabDeploymentReviewResult, selected: GitlabDeployment, issueId: string) {
  const deployment = result?.deployment;
  if (!deployment || gitlabDeploymentKey(deployment) !== gitlabDeploymentKey(selected) ||
      deployment.environment !== selected.environment || deployment.sha !== selected.sha ||
      !GITLAB_DEPLOYMENT_STATES.includes(deployment.status) || !Number.isFinite(Date.parse(deployment.changedAt))) return false;
  const { state, statusReview } = result;
  if (state !== 'ready') return Object.hasOwn(deploymentReviewMessages, state) && !statusReview;
  if (deployment.status !== 'success' || !statusReview) return false;
  if (statusReview.kind === 'ambiguous') return true;
  const { suggestion } = statusReview;
  const evidence = suggestion?.evidence;
  return suggestion?.issueId === issueId && typeof suggestion.token === 'string' && Number.isFinite(Date.parse(suggestion.expiresAt)) &&
    evidence?.trigger === 'deployment.succeeded' && evidence.link?.issueId === issueId && evidence.link.projectId === selected.repositoryId &&
    Number.isFinite(Date.parse(evidence.occurredAt)) && evidence.deployment?.status === 'success' &&
    gitlabDeploymentKey(evidence.deployment) === gitlabDeploymentKey(deployment) && evidence.deployment.environment === deployment.environment &&
    evidence.deployment.sha === deployment.sha && evidence.deployment.changedAt === deployment.changedAt &&
    evidence.deployment.projectUrl === deployment.projectUrl && evidence.deployment.jobUrl === deployment.jobUrl;
}

export function IssueGitlabActivity({ issueId, issueKey, issueVersion, links, gitlabActivitySelection, gitlabActivityFocusRef, refresh, notify, disabled, onDraftChange,
  isCurrentStatusSuggestion, canPrepareStatusSuggestion, onPrepareStatusSuggestion }: Props) {
  const formHeading = useId(), unlinkHeading = useId(), selectionMissingId = useId();
  const [view, setView] = useState<LinkView>(() => ({ source: links, rows: links }));
  if (view.source !== links) setView({ source: links, rows: links });
  const visibleLinks = view.source === links ? view.rows : links;
  const selectedLink = gitlabActivitySelection && visibleLinks.find(link => link.issueId === issueId &&
    link.issueId === gitlabActivitySelection.issueId && link.id === gitlabActivitySelection.id &&
    link.projectId === gitlabActivitySelection.projectId && link.kind === gitlabActivitySelection.kind &&
    link.iid === gitlabActivitySelection.iid && link.manualLinkId === gitlabActivitySelection.manualLinkId);
  const selectionMissing = Boolean(gitlabActivitySelection && !selectedLink);
  const activityHeading = useRef<HTMLHeadingElement>(null);
  const selectedRow = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    if (!gitlabActivitySelection || gitlabActivityFocusRef.current) return;
    const target = selectedRow.current ?? activityHeading.current;
    if (!target) return;
    gitlabActivityFocusRef.current = true;
    target.scrollIntoView({ block: 'nearest' });
    target.focus({ preventScroll: true });
  }, [gitlabActivityFocusRef, gitlabActivitySelection]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<GitlabLink | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchDraft, setBranchDraft] = useState({ dirty: false, pending: false });
  const [settings, setSettings] = useState<GitlabSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [actionError, setActionError] = useState('');
  const [refreshFeedback, setRefreshFeedback] = useState<RefreshFeedback | null>(null);
  const currentFeedback = refreshFeedback?.kind === 'finished' && !refreshFeedback.workspaceRefreshFailed &&
    refreshFeedback.issueVersion === issueVersion ? refreshFeedback : undefined;
  const statusReview = currentFeedback?.statusReview;
  const suggestion = statusReview?.kind === 'suggestion' ? statusReview.suggestion : undefined;
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const settingsRequest = useRef<AbortController | null>(null);
  const refreshRequest = useRef<AbortController | null>(null);
  const activityAttachment = useRef<AbortController | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const focusAfterClose = useRef<{ target: HTMLButtonElement | null; revealStatusReview?: boolean } | null>(null);
  const statusReviewResult = useRef<HTMLDivElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const cancelUnlink = useRef<HTMLButtonElement>(null);
  const path = `/issues/${encodeURIComponent(issueId)}/gitlab-links`;

  useEffect(() => () => {
    settingsRequest.current?.abort();
    refreshRequest.current?.abort();
    activityAttachment.current?.abort();
  }, []);
  useEffect(() => {
    if (!suggestion) return;
    const timer = window.setTimeout(() => {
      setRefreshFeedback(current => current?.kind === 'finished' && current.statusReview?.kind === 'suggestion' &&
        current.statusReview.suggestion.token === suggestion.token ? { ...current, statusReview: undefined } : current);
    }, Math.max(0, Date.parse(suggestion.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [suggestion]);

  const discard = useCallback(() => {
    settingsRequest.current?.abort();
    setLoading(false);
    setDraft(null);
    setUnlinkTarget(null);
    setBranchOpen(false);
    setBranchDraft({ dirty: false, pending: false });
    setActionError('');
  }, []);
  const defaultRepository = draft?.existing?.projectId ?? (settings?.projectIds.length === 1 ? settings.projectIds[0] : undefined);
  const dirty = Boolean(draft && (draft.url.trim() !== (draft.existing?.webUrl ?? '') ||
    (draft.repositoryId && Number(draft.repositoryId) !== defaultRepository)));
  useLayoutEffect(() => {
    onDraftChange(dirty || branchDraft.dirty, busy || branchDraft.pending, discard);
    return () => onDraftChange(false, false, discard);
  }, [dirty, busy, branchDraft, discard, onDraftChange]);
  useLayoutEffect(() => {
    if (draft || unlinkTarget || branchOpen || busy || disabled || !focusAfterClose.current) return;
    const { target, revealStatusReview } = focusAfterClose.current;
    focusAfterClose.current = null;
    if (revealStatusReview && statusReviewResult.current) {
      statusReviewResult.current.focus();
      return;
    }
    (target?.isConnected && !target.disabled ? target : addButton.current)?.focus({ preventScroll: true });
  }, [draft, unlinkTarget, branchOpen, busy, disabled]);

  const trackBranchDraft = useCallback((dirty: boolean, pending: boolean) => {
    setBranchDraft(current => current.dirty === dirty && current.pending === pending ? current : { dirty, pending });
  }, []);

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

  function showBranchEditor(trigger: HTMLButtonElement) {
    opener.current = trigger;
    setBranchOpen(true);
    void readSettings(false);
  }

  function showLinkedActivity(link: GitlabLink) {
    setView(current => ({ source: current.source, rows: [...current.rows.filter(row => row.id !== link.id), link] }));
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
      showLinkedActivity(link);
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

  const actionOpen = Boolean(draft || unlinkTarget || branchOpen);
  const controlsDisabled = disabled || busy || branchDraft.pending;
  const canCheckStatus = visibleLinks.some(link => link.kind === 'branch' || link.kind === 'merge_request' || link.kind === 'pipeline');

  async function attachVerifiedActivity(path: string, input: object,
    matches: (link: GitlabLink, newlyCreated: boolean) => boolean, message: string) {
    if (controlsDisabled || actionOpen || pending.current) return;
    const controller = new AbortController();
    activityAttachment.current = controller;
    pending.current = true;
    setBusy(true);
    try {
      const response = await apiResponse(path, {
        method: 'POST', body: JSON.stringify(input), signal: controller.signal,
      });
      const link = await response.json() as GitlabLink | null;
      if (controller.signal.aborted) return;
      if (!link || ![200, 201].includes(response.status) || !matches(link, response.status === 201)) {
        throw new Error('저장한 GitLab 연결 정보를 확인할 수 없습니다.');
      }
      showLinkedActivity(link);
      await afterChange(message);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (!(cause instanceof ApiError) || [404, 408, 409].includes(cause.status) || cause.status >= 500) {
        await refresh().catch(() => undefined);
      }
      if (!controller.signal.aborted) throw cause;
    } finally {
      activityAttachment.current = null;
      pending.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function attachBranchMergeRequest(branch: GitlabLink, mr: BranchMergeRequest, branchRevision: string) {
    const input: GitlabBranchMergeRequestAttachment = {
      mergeRequestId: mr.id, mergeRequestIid: mr.iid, targetBranch: mr.targetBranch, branchRevision,
    };
    return attachVerifiedActivity(gitlabBranchMergeRequestsPath(issueId, branch.id), input,
      link => matchesBranchMergeRequestLink(link, branch, mr), `MR !${mr.iid}을 티켓에 연결했습니다.`);
  }

  function attachMergeRequestPipeline(mr: GitlabLink, pipeline: MergeRequestObservedPipeline, revision: string) {
    const { repositoryId, pipelineId, sha } = pipeline;
    return attachVerifiedActivity(gitlabMergeRequestPipelinePath(issueId, mr.id), { repositoryId, pipelineId, sha, revision },
      (link, newlyCreated) => matchesMergeRequestPipelineLink(link, mr, pipeline, newlyCreated), `파이프라인 #${pipelineId}을 티켓에 연결했습니다.`);
  }

  async function reloadSavedActivity() {
    await refresh();
    if (refreshFeedback?.kind === 'finished' && refreshFeedback.workspaceRefreshFailed) {
      setRefreshFeedback(current => current === refreshFeedback ? { ...refreshFeedback, workspaceRefreshFailed: false } : current);
    }
  }

  async function runStatusCheck(trigger: HTMLButtonElement, check: CheckingFeedback, run: (controller: AbortController) => Promise<void>) {
    if (controlsDisabled || actionOpen || pending.current) return;
    const hadFocus = document.activeElement === trigger;
    const controller = new AbortController();
    refreshRequest.current = controller;
    pending.current = true;
    setBusy(true);
    setRefreshFeedback(check);
    try {
      await run(controller);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setRefreshFeedback({ kind: 'failed', message: errorMessage(cause) });
        if ((check.linkId || check.deploymentKey) && cause instanceof ApiError && (cause.status === 404 || cause.status === 409)) {
          await refresh().catch(() => undefined);
        }
      }
    } finally {
      refreshRequest.current = null;
      pending.current = false;
      if (!controller.signal.aborted) {
        if (hadFocus && (document.activeElement === document.body || document.activeElement === trigger)) {
          focusAfterClose.current = { target: trigger, revealStatusReview: check.action === 'status-review' };
        }
        setBusy(false);
      }
    }
  }

  function checkGitlabStatus(trigger: HTMLButtonElement, selectedLink?: GitlabLink, action: GitlabLinkedStatusAction = 'refresh') {
    const reviewSelected = action === 'status-review';
    return runStatusCheck(trigger, { kind: 'checking', linkId: selectedLink?.id, action }, async controller => {
      const refreshPath = selectedLink ? gitlabLinkedStatusRefreshPath(issueId, selectedLink.id, action) : `${path}/refresh`;
      const result = await api<GitlabIssueRefreshResult>(refreshPath, { method: 'POST', body: '{}', signal: controller.signal });
      if (controller.signal.aborted) return;
      if (selectedLink && !isGitlabLinkedStatusRefreshResult(result, selectedLink, action)) {
        throw new Error('선택한 GitLab 활동의 상태 확인 응답을 확인할 수 없습니다.');
      }
      const previous = new Map(visibleLinks.map(link => [link.id, link]));
      const failures = result.failures.map(failure => {
        const link = previous.get(failure.linkId);
        return { ...failure, label: link ? gitlabLinkLabel(link) : '연결한 GitLab 활동' };
      });
      let workspaceRefreshFailed = false;
      if (result.links.length || result.failures.length) {
        try { await refresh(); }
        catch {
          if (controller.signal.aborted) return;
          workspaceRefreshFailed = true;
          if (result.links.length) setView(current => {
            const confirmed = new Map(result.links.map(link => [link.id, link]));
            const rows = current.rows.map(link => {
              const checked = confirmed.get(link.id);
              confirmed.delete(link.id);
              return checked && (link === previous.get(link.id) || Date.parse(checked.updatedAt) > Date.parse(link.updatedAt)) ? checked : link;
            });
            if (current.source === links) rows.push(...confirmed.values());
            return { source: current.source, rows };
          });
        }
      }
      const verified = selectedLink ? result.links[0] : undefined;
      if (!controller.signal.aborted) setRefreshFeedback({ kind: 'finished', checked: result.links.length,
        skipped: result.skipped, failures, workspaceRefreshFailed, issueVersion,
        statusReview: !selectedLink || reviewSelected ? result.statusReview : undefined,
        pipelineReview: result.pipelineReview,
        selectedReview: reviewSelected && verified ? result.statusReview ? 'reviewed' : 'no-proposal' : undefined,
        verifiedState: verified ? { label: gitlabLinkLabel(verified), state: gitlabActivityStateLabel(verified.state) } : undefined });
    });
  }

  function checkDeploymentStatus(deployment: GitlabDeployment, trigger: HTMLButtonElement, refreshPage: () => void) {
    const deploymentKey = gitlabDeploymentKey(deployment);
    return runStatusCheck(trigger, { kind: 'checking', deploymentKey, action: 'status-review' }, async controller => {
      const reviewPath = `/issues/${encodeURIComponent(issueId)}/gitlab-deployments/${encodeURIComponent(deployment.instance)}` +
        `/${deployment.repositoryId}/${deployment.deploymentId}/status-review`;
      const result = await api<GitlabDeploymentReviewResult>(reviewPath, { method: 'POST', body: '{}', signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!matchesDeploymentReview(result, deployment, issueId)) {
        throw new Error('선택한 GitLab 배포의 상태 확인 응답을 확인할 수 없습니다.');
      }
      refreshPage();
      const workspaceRefreshFailed = await refresh().then(() => false, () => true);
      if (!controller.signal.aborted) setRefreshFeedback({ kind: 'finished', checked: 1, skipped: 0, failures: [], workspaceRefreshFailed,
        issueVersion, statusReview: result.statusReview, deploymentReview: result.state,
        verifiedState: { label: `${deployment.environment} 배포 #${deployment.deploymentId}`,
          state: gitlabDeploymentStatusLabels[result.deployment.status] } });
    });
  }

  return <section className="issue-related-section" aria-label="GitLab">
    <div className="gitlab-activity-header"><h3 ref={activityHeading} tabIndex={-1}
      aria-describedby={selectionMissing ? selectionMissingId : undefined}><GitMerge aria-hidden="true" size={16} />GitLab <span>{visibleLinks.length}</span></h3>
      <div className="gitlab-activity-actions">
        <GitlabActivityRefresh refresh={reloadSavedActivity} notify={notify} disabled={controlsDisabled} />
        {canCheckStatus && <button className="btn" type="button" aria-label="GitLab에서 상태 확인"
          title="이 업무에 연결된 브랜치의 HEAD와 MR·파이프라인 상태를 확인합니다."
          disabled={controlsDisabled || actionOpen} onClick={event => void checkGitlabStatus(event.currentTarget)}>
          <RefreshCw aria-hidden="true" size={15} />{refreshFeedback?.kind === 'checking' && !refreshFeedback.linkId && !refreshFeedback.deploymentKey
            ? '확인 중…' : 'GitLab에서 상태 확인'}
        </button>}
        <button ref={addButton} className="btn" type="button" disabled={controlsDisabled || actionOpen}
          onClick={event => showEditor(event.currentTarget)}><Link2 aria-hidden="true" size={15} />GitLab 링크 추가</button>
        <button className="btn" type="button" disabled={controlsDisabled || actionOpen}
          onClick={event => showBranchEditor(event.currentTarget)}><GitBranch aria-hidden="true" size={15} />GitLab 브랜치 만들기</button>
      </div>
    </div>
    {selectionMissing && <p id={selectionMissingId} className="gitlab-activity-hint" role="status">
      선택한 GitLab 활동을 이 티켓에서 찾을 수 없습니다.
    </p>}
    {refreshFeedback && <div ref={statusReviewResult} tabIndex={-1} role="group" aria-label="GitLab 상태 확인 결과">
      <GitlabStatusFeedback feedback={refreshFeedback} />
      {statusReview?.kind === 'ambiguous' && <p className="gitlab-activity-hint" role="status">
        확인한 GitLab 규칙의 목표 상태가 서로 다릅니다. 티켓에서 상태를 선택해 주세요.
      </p>}
      {Boolean(currentFeedback?.pipelineReview?.superseded) && <p className="gitlab-activity-hint" role="status">
        같은 실행 계열에 더 최신 GitLab 파이프라인이 있습니다. 최신 실행에서 상태를 다시 검토해 주세요.
      </p>}
      {Boolean(currentFeedback?.pipelineReview?.unverified) && <p className="gitlab-activity-hint" role="status">
        GitLab에서 같은 실행 계열의 최신 파이프라인을 확인할 수 없습니다. GitLab 상태를 다시 확인해 주세요.
      </p>}
      {currentFeedback?.selectedReview === 'no-proposal' && !currentFeedback.pipelineReview && <p className="gitlab-activity-hint" role="status">
        이 활동으로 제안할 상태 변경이 없습니다.
      </p>}
      {suggestion && isCurrentStatusSuggestion(suggestion) && <GitlabStatusSuggestionCard suggestion={suggestion}
        selected={currentFeedback?.selectedReview === 'reviewed'}
        canPrepare={canPrepareStatusSuggestion(suggestion)} disabled={controlsDisabled || actionOpen}
        onPrepare={() => onPrepareStatusSuggestion(suggestion)} />}
    </div>}
    {branchOpen && <IssueGitlabBranchCreate issueId={issueId} issueKey={issueKey} settings={settings} loadingSettings={loading}
      settingsError={settingsError} disabled={disabled || busy} reloadSettings={() => void readSettings(false)} refresh={refresh}
      onClose={closeAction} onDraftChange={trackBranchDraft} onLinked={showLinkedActivity} />}
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
    {visibleLinks.length ? <GitlabActivityList links={visibleLinks} issueVersions={new Map([[issueId, issueVersion]])}
      selection={selectedLink ? { link: selectedLink, rowRef: selectedRow } : undefined}
      statusActions={{ disabled: controlsDisabled || actionOpen,
        refreshingLinkId: refreshFeedback?.kind === 'checking' && refreshFeedback.action === 'refresh' ? refreshFeedback.linkId : null,
        reviewingLinkId: refreshFeedback?.kind === 'checking' && refreshFeedback.action === 'status-review' ? refreshFeedback.linkId : null,
        checkStatus: (link, trigger) => void checkGitlabStatus(trigger, link),
        reviewStatus: (link, trigger) => void checkGitlabStatus(trigger, link, 'status-review') }}
      manualActions={{ disabled: controlsDisabled || actionOpen, verify: (link, trigger) => showEditor(trigger, link), unlink: showUnlink,
        hasMergeRequest: (branch, mr) => visibleLinks.some(link => matchesBranchMergeRequestLink(link, branch, mr)),
        attachMergeRequest: attachBranchMergeRequest,
        findMergeRequestPipeline: (mr, pipeline) => visibleLinks.find(link => matchesMergeRequestPipelineLink(link, mr, pipeline)),
        attachMergeRequestPipeline }} />
      : <p className="issue-section-empty">연결된 개발 기록이 없습니다. 브랜치 이름이나 커밋 메시지에 {issueKey}를 넣어 자동으로 연결할 수 있습니다.</p>}
    <IssueGitlabDeployments issueId={issueId} links={links} review={{ disabled: controlsDisabled || actionOpen,
      pendingKey: refreshFeedback?.kind === 'checking' ? refreshFeedback.deploymentKey : undefined,
      check: (deployment, trigger, refreshPage) => void checkDeploymentStatus(deployment, trigger, refreshPage) }} />
  </section>;
}

function GitlabStatusSuggestionCard({ suggestion, selected, canPrepare, disabled, onPrepare }: {
  suggestion: GitlabStatusSuggestion;
  selected: boolean;
  canPrepare: boolean;
  disabled: boolean;
  onPrepare: () => void;
}) {
  const { evidence } = suggestion;
  const { link, trigger, occurredAt } = evidence;
  const deployment = trigger === 'deployment.succeeded' ? evidence.deployment : undefined;
  const targetBranch = 'targetBranch' in evidence ? evidence.targetBranch : undefined;
  const url = deployment ? deploymentSource(deployment) : gitlabActivityUrl(link.webUrl, link.kind);
  const reference = `${gitlabActivityKindLabel(link.kind)} ${link.kind === 'merge_request' ? '!' : '#'}${link.iid}`;
  return <section className="gitlab-activity-editor" aria-label="GitLab 상태 변경 제안">
    <h4>GitLab 상태 변경 제안</h4>
    {deployment ? <p className="gitlab-activity-hint">선택한 GitLab 배포 기준</p>
      : selected && <p className="gitlab-activity-hint">선택한 GitLab 활동 기준</p>}
    <p><strong>{suggestion.fromStatusLabel} <span aria-label="에서">→</span> {suggestion.toStatusLabel}</strong></p>
    <p className="gitlab-activity-hint">{suggestion.rule.name} · {AUTOMATION_TRIGGER_LABELS[trigger]}</p>
    <p className="gitlab-activity-hint">저장소 #{link.projectId} · {deployment
      ? `${deployment.environment} 배포 #${deployment.deploymentId}`
      : <>{reference}{link.sourceBranch && <> · {link.kind === 'merge_request' && '소스 브랜치 '}{link.sourceBranch}</>}</>}
      {' · '}<time dateTime={occurredAt}>{new Date(occurredAt).toLocaleString('ko-KR')}</time></p>
    {link.kind === 'merge_request' && targetBranch && <p className="gitlab-activity-hint">대상 브랜치 <code>{targetBranch}</code></p>}
    {suggestion.blockReason && <p className="gitlab-activity-hint">확인 당시 {suggestion.blockReason}</p>}
    {(url || canPrepare) && <div className="gitlab-activity-actions">
      {url && <a className="btn btn-ghost" href={url.href} target="_blank" rel="noopener noreferrer">
        GitLab 원본 열기 <ExternalLink size={13} aria-hidden="true" />
      </a>}
      {canPrepare && <button type="button" className="btn" disabled={disabled} onClick={() => {
        if (Date.parse(suggestion.expiresAt) > Date.now()) onPrepare();
      }}>
        목표 상태로 편집 <ArrowRight size={13} aria-hidden="true" />
      </button>}
    </div>}
  </section>;
}

function GitlabStatusFeedback({ feedback }: { feedback: RefreshFeedback | null }) {
  if (!feedback) return null;
  return <div className="gitlab-activity-feedback">
    {feedback.kind === 'checking' && <p className="gitlab-activity-hint" role="status">{feedback.deploymentKey
      ? '선택한 GitLab 배포로 상태 변경을 검토하고 있습니다.' : feedback.action === 'status-review'
      ? '선택한 GitLab 활동으로 상태 변경을 검토하고 있습니다.' : 'GitLab에서 상태를 확인하고 있습니다.'}</p>}
    {feedback.kind === 'failed' && <p className="issue-form-error" role="alert">{feedback.message}</p>}
    {feedback.kind === 'finished' && <>
      {!feedback.deploymentReview && <p className="gitlab-activity-hint" role="status">{feedback.failures.length
        ? feedback.checked ? `GitLab 활동 ${feedback.checked}건의 상태를 확인했고 ${feedback.failures.length}건은 확인하지 못했습니다.`
          : `GitLab 활동 ${feedback.failures.length}건의 상태를 확인하지 못했습니다.`
        : feedback.checked ? `GitLab 활동 ${feedback.checked}건의 상태를 확인했습니다.` : '확인할 브랜치, MR 또는 파이프라인이 없습니다.'}
        {feedback.skipped > 0 && ` 이전 활동 ${feedback.skipped}건은 이번 확인 범위를 벗어났습니다.`}</p>}
      {feedback.verifiedState && <p className="gitlab-activity-hint" role="status">
        {feedback.verifiedState.label} · 확인한 상태 <strong>{feedback.verifiedState.state}</strong>
      </p>}
      {feedback.deploymentReview && feedback.deploymentReview !== 'ready' && <p className="gitlab-activity-hint" role="status">
        {deploymentReviewMessages[feedback.deploymentReview]}
      </p>}
      {feedback.failures.length > 0 && <ul className="issue-form-error" aria-label="확인하지 못한 활동">
        {feedback.failures.map(failure => <li key={failure.linkId}><strong>{failure.label}</strong> · {failure.message}</li>)}
      </ul>}
      {feedback.workspaceRefreshFailed && <p className="issue-form-error" role="alert">
        {feedback.checked > 0 && '확인한 GitLab 상태를 저장했습니다. '}작업 공간을 다시 불러오지 못했습니다. GitLab 활동 새로고침을 눌러 주세요.
      </p>}
    </>}
  </div>;
}
