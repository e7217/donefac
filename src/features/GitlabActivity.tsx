'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowRight, ClipboardCheck, ExternalLink, FileDiff, FlaskConical, GitBranch, GitCommitHorizontal, GitMerge, Link2, MessageSquarePlus, Workflow, RefreshCw, Unlink2 } from 'lucide-react';
import { commentWebUrl } from '../../shared/comment-web-links';
import { gitlabObjectSha, gitlabPipelineLinkIdentity, isGitlabBranchName, isRestorableGitlabLink } from '../../shared/gitlab-links';
import { GITLAB_MERGE_READINESS_LABELS, isGitlabMergeReadinessBlocked } from '../../shared/gitlab-merge-readiness';
import { gitlabPipelineSourceLabel } from '../../shared/gitlab-pipeline-source';
import { matchingGitlabSearchLinks, normalizeGitlabSearchInput } from '../../shared/gitlab-search';
import type { GitlabActivityFilters } from '../../shared/gitlab-activity-filter';
import { GITLAB_MR_CHANGED_FILE_LIMIT } from '../../shared/types';
import type {
  FeatureProps, GitlabBranchMergeRequests, GitlabIssueRefreshResult, GitlabLink, GitlabMergeReadiness, GitlabMergeRequestChangedFile, GitlabMergeRequestChangedFiles, GitlabMergeRequestDiscussions, GitlabMergeRequestPipeline, GitlabMergeRequestReview, GitlabPipelineFailedTests,
  GitlabPipelineJob, GitlabPipelineJobs, GitlabPipelineTestReport, GitlabPipelineTriggerJob, GitlabTestCounts,
} from '../../shared/types';
import { api, ApiError } from '../lib/api';
import type { OpenIssueForReview } from '../lib/issue-review';
import './gitlab-activity.css';
import './gitlab-pipeline-jobs.css';

const kinds = [
  { kind: 'branch', label: '브랜치', Icon: GitBranch },
  { kind: 'commit', label: '커밋', Icon: GitCommitHorizontal },
  { kind: 'merge_request', label: 'MR', Icon: GitMerge },
  { kind: 'pipeline', label: '파이프라인', Icon: Workflow },
] as const;

const states = new Map([
  ['active', '활성'], ['deleted', '삭제됨'], ['committed', '커밋됨'],
  ['opened', '열림'], ['merged', '병합됨'], ['closed', '닫힘'],
  ['created', '생성됨'], ['pending', '대기 중'], ['running', '실행 중'],
  ['preparing', '실행 준비 중'], ['waiting_for_resource', '리소스 대기'], ['waiting_for_callback', '외부 응답 대기'],
  ['success', '성공'], ['failed', '실패'], ['canceled', '취소됨'],
  ['cancelled', '취소됨'], ['skipped', '건너뜀'], ['manual', '수동 실행'],
  ['scheduled', '예약됨'], ['unknown', '미확인'],
]);
const PAGE_SIZE = 12;
export function gitlabActivityUrl(webUrl: unknown, kind: GitlabLink['kind']): URL | null {
  if (typeof webUrl !== 'string') return null;
  try {
    const url = new URL(webUrl);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    if (kind === 'branch' && url.pathname.includes('/-/tree/')) url.searchParams.set('ref_type', 'heads');
    return url;
  } catch {
    return null;
  }
}

export function gitlabActivityKindLabel(kind: GitlabLink['kind']): string {
  return kinds.find(value => value.kind === kind)?.label ?? 'GitLab';
}

export function gitlabActivityStateLabel(state: string): string {
  return states.get(state) ?? state;
}

export type GitlabLinkedStatusAction = 'refresh' | 'status-review';

export function gitlabLinkedStatusRefreshPath(issueId: string, linkId: string, action: GitlabLinkedStatusAction = 'refresh'): string {
  return `/issues/${encodeURIComponent(issueId)}/gitlab-links/${encodeURIComponent(linkId)}/${action}`;
}

export function isGitlabLinkedStatusRefreshResult(
  result: GitlabIssueRefreshResult | undefined, link: GitlabLink, action: GitlabLinkedStatusAction = 'refresh',
): result is GitlabIssueRefreshResult {
  if (!result || result.skipped !== 0 || !Array.isArray(result.links) || !Array.isArray(result.failures) ||
    result.links.length + result.failures.length !== 1 ||
    result.links.some(saved => saved?.id !== link.id || saved.issueId !== link.issueId || saved.projectId !== link.projectId ||
      saved.kind !== link.kind || typeof saved.state !== 'string') ||
    result.failures.some(failure => failure?.linkId !== link.id || typeof failure.message !== 'string')) return false;

  const review = result.statusReview;
  if (review === undefined) return true;
  if (action !== 'status-review' || result.failures.length || (link.kind !== 'merge_request' && link.kind !== 'pipeline')) return false;
  if (review?.kind === 'ambiguous') return true;
  return review?.kind === 'suggestion' && review.suggestion?.issueId === link.issueId &&
    JSON.stringify(review.suggestion.evidence?.link) === JSON.stringify(result.links[0]);
}

function activityTime(value: unknown) {
  return typeof value === 'string' ? Date.parse(value) || 0 : 0;
}

type PipelineTarget = { linkId: string; issueId: string; repositoryId: number; pipelineId: number; url: URL };
type PipelineTestTarget = PipelineTarget & { mergeRequestRevision?: string };
type ReviewTarget = { linkId: string; issueId: string; repositoryId: number; mergeRequestIid: number; url: URL };
type BranchTarget = { linkId: string; issueId: string; repositoryId: number; sourceBranch: string; origin: string; repositoryPath: string };
export type BranchMergeRequest = GitlabBranchMergeRequests['openMergeRequests'][number];
type ActivityLookup<Value> = { kind: 'loading' } | { kind: 'stale' } | { kind: 'failed'; message: string } | { kind: 'ready'; result: Value };
type ReviewPerson = GitlabMergeRequestReview['reviewers'][number];

const reviewStateLabels = {
  unreviewed: '검토 전', review_started: '검토 중', reviewed: '검토 완료', requested_changes: '수정 요청',
  approved: '승인', unapproved: '승인 철회', unknown: '상태 미확인',
} satisfies Record<ReviewPerson['state'], string>;

function mergeRequestTarget(link: GitlabLink, url: URL | null): ReviewTarget | null {
  if (link.kind !== 'merge_request' || !url || !link.issueId) return null;
  const object = /^gitlab:[a-f0-9]{12}:([1-9]\d*):merge_request:([1-9]\d*):/u.exec(link.id);
  const route = /^\/.+?\/(?:-\/)?merge_requests\/([1-9]\d*)\/?$/u.exec(url.pathname);
  if (!object || !route || link.id.slice(object[0].length) !== link.issueId ||
      !Number.isSafeInteger(link.projectId) || String(link.projectId) !== object[1] ||
      !Number.isSafeInteger(link.iid) || String(link.iid) !== route[1]) return null;
  const mrUrl = new URL(url.href);
  mrUrl.search = '';
  mrUrl.hash = '';
  return { linkId: link.id, issueId: link.issueId, repositoryId: link.projectId, mergeRequestIid: link.iid, url: mrUrl };
}

function isReviewIdentity(value: unknown): value is Pick<ReviewPerson, 'id' | 'name' | 'username'> {
  if (!value || typeof value !== 'object') return false;
  const { id, name, username } = value as Partial<ReviewPerson>;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && typeof name === 'string' &&
    typeof username === 'string' && Boolean(name.trim() || username.trim());
}

function isReviewResult(result: GitlabMergeRequestReview | undefined, target: ReviewTarget): result is GitlabMergeRequestReview {
  if (!result || result.linkId !== target.linkId || result.repositoryId !== target.repositoryId ||
      result.mergeRequestIid !== target.mergeRequestIid || typeof result.checkedAt !== 'string' || !Number.isFinite(Date.parse(result.checkedAt)) ||
      !['reviewers', 'merge_request', 'unavailable'].includes(result.reviewerSource) || typeof result.reviewersHasMore !== 'boolean' ||
      !Array.isArray(result.reviewers) || !result.reviewers.every(person => isReviewIdentity(person) && Object.hasOwn(reviewStateLabels, person.state)) ||
      new Set(result.reviewers.map(person => person.id)).size !== result.reviewers.length) return false;
  const approval = result.approvals;
  return approval === null || Boolean(approval && Array.isArray(approval.approvers) && approval.approvers.every(isReviewIdentity) &&
    new Set(approval.approvers.map(person => person.id)).size === approval.approvers.length && typeof approval.hasMore === 'boolean' &&
    [approval.required, approval.remaining].every(count => count === null || Number.isSafeInteger(count) && count >= 0));
}

const failureReasonLabels = new Map([
  ['script_failure', '작업 스크립트 실패'],
  ['runner_system_failure', '러너 시스템 오류'],
  ['stuck_or_timeout_failure', '작업이 멈췄거나 시간이 초과됨'],
  ['job_execution_timeout', '작업 실행 시간 초과'],
  ['runner_unsupported', '러너에서 지원하지 않는 작업'],
  ['scheduler_failure', '작업 예약 오류'],
]);

function pipelineTarget(link: GitlabLink, url: URL | null): PipelineTarget | null {
  if (link.kind !== 'pipeline' || !url || !link.issueId) return null;
  const object = /^gitlab:[a-f0-9]{12}:([1-9]\d*):pipeline:([1-9]\d*):/u.exec(link.id);
  const route = /^\/.+?\/(?:-\/)?pipelines\/([1-9]\d*)\/?$/u.exec(url.pathname);
  if (!object || !route || object[2] !== route[1] || link.id.slice(object[0].length) !== link.issueId ||
      !Number.isSafeInteger(link.projectId) || String(link.projectId) !== object[1]) return null;
  const pipelineId = Number(object[2]);
  if (!Number.isSafeInteger(pipelineId)) return null;
  const pipelineUrl = new URL(url.href);
  pipelineUrl.search = '';
  pipelineUrl.hash = '';
  return { linkId: link.id, issueId: link.issueId, repositoryId: link.projectId, pipelineId, url: pipelineUrl };
}

function isPipelineJobsResult(result: GitlabPipelineJobs | undefined, target: PipelineTarget): result is GitlabPipelineJobs {
  if (!result || result.linkId !== target.linkId || result.repositoryId !== target.repositoryId || result.pipelineId !== target.pipelineId ||
      typeof result.status !== 'string' || !result.status || typeof result.checkedAt !== 'string' || !Number.isFinite(Date.parse(result.checkedAt)) ||
      typeof result.configurationError !== 'boolean' || typeof result.hasMore !== 'boolean' || !Array.isArray(result.jobs)) return false;
  const ids = new Set<number>();
  return result.jobs.every(job => {
    if (!job || !Number.isSafeInteger(job.id) || job.id < 1 || ids.has(job.id) || typeof job.name !== 'string' ||
        typeof job.stage !== 'string' || (job.status !== 'failed' && job.status !== 'manual') || typeof job.allowFailure !== 'boolean' ||
        (job.failureReason !== null && typeof job.failureReason !== 'string') || typeof job.webUrl !== 'string') return false;
    ids.add(job.id);
    return true;
  });
}

function pipelineJobUrl(job: Pick<GitlabPipelineTriggerJob, 'id' | 'webUrl'>, target: PipelineTarget): URL | null {
  const url = gitlabActivityUrl(job.webUrl, 'pipeline');
  const repositoryPath = target.url.pathname.replace(/\/(?:-\/)?pipelines\/[1-9]\d*\/?$/u, '');
  return url && url.origin === target.url.origin && !url.search && !url.hash &&
    url.pathname === `${repositoryPath}/-/jobs/${job.id}` ? url : null;
}

function isTriggerJobsResult(value: GitlabPipelineJobs['triggerJobs'] | undefined): value is NonNullable<GitlabPipelineJobs['triggerJobs']> {
  if (!value || typeof value.hasMore !== 'boolean' || !Array.isArray(value.jobs)) return false;
  const validStatus = (status: unknown) => typeof status === 'string' && /^[a-z][a-z0-9_]{0,39}$/u.test(status);
  const validId = (id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
  const nullableString = (value: unknown) => value === null || typeof value === 'string';
  const ids = new Set<number>();
  return value.jobs.every(job => {
    if (!job || !validId(job.id) || ids.has(job.id) || typeof job.name !== 'string' || typeof job.stage !== 'string' ||
        !validStatus(job.status) || typeof job.allowFailure !== 'boolean' || !nullableString(job.failureReason) || !nullableString(job.webUrl)) return false;
    ids.add(job.id);
    const downstream = job.downstream;
    return downstream === null || Boolean(downstream && validId(downstream.id) && validStatus(downstream.status) && nullableString(downstream.webUrl));
  });
}

function downstreamPipelineUrl(downstream: NonNullable<GitlabPipelineTriggerJob['downstream']>, target: PipelineTarget): URL | null {
  const url = gitlabActivityUrl(downstream.webUrl, 'pipeline');
  const pipeline = url && /^\/(?:[^/]+\/){2,}-\/pipelines\/([1-9]\d*)$/u.exec(url.pathname);
  return url && url.origin === target.url.origin && !url.search && !url.hash && pipeline?.[1] === String(downstream.id) ? url : null;
}

function pipelineJobsMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403) return 'CI 작업 조회 권한을 확인해 주세요.';
    if (cause.status === 404) return '연결된 GitLab 파이프라인을 찾을 수 없습니다.';
    if (cause.status === 409) return '파이프라인이나 GitLab 연결이 변경되었습니다. 다시 확인해 주세요.';
    if (cause.status === 429) return 'GitLab 요청 제한이 풀린 뒤 다시 확인해 주세요.';
    if (cause.message) return cause.message;
  }
  return 'GitLab CI 작업을 불러오지 못했습니다. 다시 확인해 주세요.';
}

function useActivityLookup<Value, Query = undefined>(revision: string, read: (signal: AbortSignal, query?: Query) => Promise<Value | null>,
  invalidResult: string, errorMessage: (cause: unknown) => string) {
  const [snapshot, setSnapshot] = useState<{ revision: string; view: ActivityLookup<Value> | null }>({ revision, view: null });
  const request = useRef<{ revision: string; controller: AbortController } | null>(null);
  const view = snapshot.view;
  // Preserve the open panel while discarding results from the previous observation.
  if (snapshot.revision !== revision) setSnapshot({ revision, view: view ? { kind: 'stale' } : null });
  useEffect(() => () => {
    if (request.current?.revision !== revision) return;
    request.current.controller.abort();
    request.current = null;
  }, [revision]);

  async function load(query?: Query) {
    if (request.current?.revision === revision) return;
    request.current?.controller.abort();
    const controller = new AbortController();
    const active = { revision, controller };
    request.current = active;
    const loading: ActivityLookup<Value> = { kind: 'loading' };
    setSnapshot({ revision, view: loading });
    const finish = (next: ActivityLookup<Value>) => {
      if (!controller.signal.aborted) setSnapshot(current => current.view === loading ? { revision, view: next } : current);
    };
    try {
      const result = await read(controller.signal, query);
      finish(result !== null ? { kind: 'ready', result } : { kind: 'failed', message: invalidResult });
    } catch (cause) {
      finish({ kind: 'failed', message: errorMessage(cause) });
    } finally {
      if (request.current === active) request.current = null;
    }
  }

  function toggle() {
    if (!view) {
      void load();
      return;
    }
    request.current?.controller.abort();
    request.current = null;
    setSnapshot({ revision, view: null });
  }
  return { view, toggle, load };
}

function branchMergeRequestTarget(link: GitlabLink, url: URL | null): BranchTarget | null {
  const { issueId, id, projectId, sourceBranch } = link;
  if (link.kind !== 'branch' || link.state !== 'active' || !url || !issueId || !isGitlabBranchName(sourceBranch) || !isRestorableGitlabLink(link)) return null;
  const object = /^gitlab:[a-f0-9]{12}:([1-9]\d*):branch:[a-f0-9]{64}:/u.exec(id);
  if (!object || object[1] !== String(projectId) || id.slice(object[0].length) !== issueId) return null;
  const treePath = `/-/tree/${encodeURIComponent(sourceBranch)}`;
  return { linkId: id, issueId, repositoryId: projectId, sourceBranch, origin: url.origin, repositoryPath: url.pathname.slice(0, -treePath.length) };
}

function scopedBranchMergeRequestUrl(value: unknown, target: BranchTarget, route: string): URL | null {
  const url = gitlabActivityUrl(value, 'merge_request');
  return url && url.href === value && !url.href.includes('#') && url.origin === target.origin &&
    url.pathname === `${target.repositoryPath}/-/merge_requests/${route}` ? url : null;
}

export function gitlabBranchMergeRequestsPath(issueId: string, linkId: string): string {
  return `/issues/${encodeURIComponent(issueId)}/gitlab-links/${encodeURIComponent(linkId)}/branch-merge-requests`;
}

export function matchesBranchMergeRequestLink(link: GitlabLink | undefined, branch: GitlabLink, mr: BranchMergeRequest): boolean {
  const instance = branch.id.split(':', 2)[1];
  if (!link || link.kind !== 'merge_request' || link.issueId !== branch.issueId || link.projectId !== branch.projectId ||
      link.iid !== mr.iid || link.id !== `gitlab:${instance}:${branch.projectId}:merge_request:${mr.id}:${branch.issueId}`) return false;
  const url = gitlabActivityUrl(link.webUrl, 'merge_request');
  const suffix = `/merge_requests/${mr.iid}`;
  const path = url?.pathname.replace(/\/$/u, '');
  if (!url || url.search || url.hash || !path?.endsWith(suffix)) return false;
  url.pathname = path.endsWith(`/-${suffix}`) ? path : `${path.slice(0, -suffix.length)}/-${suffix}`;
  return url.href === mr.webUrl;
}

function newBranchMergeRequestUrl(result: GitlabBranchMergeRequests, target: BranchTarget): URL | null {
  if (result.hasMore || result.openMergeRequests.length || !result.targetBranch || !result.targetSha || result.targetSha === result.sourceSha) return null;
  const url = scopedBranchMergeRequestUrl(result.newMergeRequestUrl, target, 'new');
  const repository = String(target.repositoryId);
  const params = [
    ['merge_request[source_branch]', target.sourceBranch], ['merge_request[target_branch]', result.targetBranch],
    ['merge_request[source_project_id]', repository], ['merge_request[target_project_id]', repository],
  ];
  return url && url.searchParams.size === params.length && params.every(([key, value]) => url.searchParams.get(key) === value) ? url : null;
}

function isBranchMergeRequestsResult(result: GitlabBranchMergeRequests | undefined, target: BranchTarget, requestedTarget?: string): result is GitlabBranchMergeRequests {
  if (!result || result.linkId !== target.linkId || typeof result.branchRevision !== 'string' || !/^[a-f\d]{64}$/u.test(result.branchRevision) ||
      result.repositoryId !== target.repositoryId || result.sourceBranch !== target.sourceBranch ||
      typeof result.sourceSha !== 'string' || gitlabObjectSha(result.sourceSha) !== result.sourceSha || /^0+$/u.test(result.sourceSha) ||
      typeof result.checkedAt !== 'string' || !Number.isFinite(Date.parse(result.checkedAt)) ||
      typeof result.suggestedTitle !== 'string' || !result.suggestedTitle.trim() ||
      (result.defaultBranch !== null && !isGitlabBranchName(result.defaultBranch)) ||
      (result.targetBranch === null ? result.targetSha !== null : !isGitlabBranchName(result.targetBranch) ||
        result.targetBranch !== (requestedTarget ?? result.defaultBranch) || result.targetBranch === target.sourceBranch ||
        typeof result.targetSha !== 'string' || gitlabObjectSha(result.targetSha) !== result.targetSha || /^0+$/u.test(result.targetSha)) ||
      (result.newMergeRequestUrl !== null && typeof result.newMergeRequestUrl !== 'string') ||
      typeof result.hasMore !== 'boolean' || !Array.isArray(result.openMergeRequests)) return false;

  const ids = new Set<number>();
  const iids = new Set<number>();
  return result.openMergeRequests.every(mr => {
    if (!mr || !Number.isSafeInteger(mr.id) || mr.id < 1 || ids.has(mr.id) ||
        !Number.isSafeInteger(mr.iid) || mr.iid < 1 || iids.has(mr.iid) || typeof mr.title !== 'string' || !mr.title.trim() ||
        !isGitlabBranchName(mr.targetBranch) || mr.targetBranch === target.sourceBranch) return false;
    const url = scopedBranchMergeRequestUrl(mr.webUrl, target, String(mr.iid));
    if (!url || url.href !== `${url.origin}${url.pathname}`) return false;
    ids.add(mr.id);
    iids.add(mr.iid);
    return true;
  });
}

function branchMergeRequestsMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403) return 'GitLab 연결과 브랜치 및 MR 조회 권한을 확인해 주세요.';
    if (cause.status === 404) return 'GitLab에서 브랜치를 찾을 수 없습니다. 대상 브랜치 이름과 GitLab 연결을 확인해 주세요.';
    if (cause.status === 409) return '브랜치 또는 GitLab 연결이 변경되었습니다. 다시 확인해 주세요.';
    if (cause.status === 429) return 'GitLab 요청 제한이 풀린 뒤 다시 확인해 주세요.';
  }
  return 'GitLab 브랜치의 MR을 불러오지 못했습니다. 다시 확인해 주세요.';
}

type AttachmentFeedback = { result: GitlabBranchMergeRequests; id: number } & (
  { kind: 'saving' } | { kind: 'failed'; stale: boolean; message: string }
);

function branchAttachmentError(cause: unknown) {
  if (cause instanceof ApiError) {
    if (cause.status === 404 || cause.status === 409) return '브랜치 또는 MR 정보가 변경되었습니다. 브랜치 MR을 다시 확인해 주세요.';
    if (cause.status === 401 || cause.status === 403) return 'GitLab 연결과 MR 조회 권한을 확인해 주세요.';
    if (cause.status === 429) return 'GitLab 요청 제한이 풀린 뒤 다시 연결해 주세요.';
  }
  return 'MR 연결 결과를 확인하지 못했습니다. 다시 연결해 주세요.';
}

function BranchMergeRequests({ branch, target, revision, manualActions }: {
  branch: GitlabLink; target: BranchTarget; revision: string; manualActions?: ManualLinkActions;
}) {
  const panelId = useId();
  const [targetDraft, setTargetDraft] = useState<string | null>(null);
  const [requestedTarget, setRequestedTarget] = useState<string>();
  const [attachment, setAttachment] = useState<AttachmentFeedback | null>(null);
  const attaching = attachment?.kind === 'saving';
  const { view, toggle, load } = useActivityLookup<GitlabBranchMergeRequests, string>(revision, async (signal, branch) => {
    const path = gitlabBranchMergeRequestsPath(target.issueId, target.linkId);
    const query = branch === undefined ? '' : `?${new URLSearchParams({ targetBranch: branch })}`;
    const result = await api<GitlabBranchMergeRequests | undefined>(`${path}${query}`, { method: 'GET', cache: 'no-store', signal });
    return isBranchMergeRequestsResult(result, target, branch) ? result : null;
  }, '연결된 브랜치의 MR 응답을 확인할 수 없습니다. 다시 확인해 주세요.', branchMergeRequestsMessage);
  const result = view?.kind === 'ready' ? view.result : null;
  const busy = view?.kind === 'loading';
  const feedback = attachment?.result === result ? attachment : null;
  const hasExisting = Boolean(result && (result.openMergeRequests.length || result.hasMore));
  const draft = targetDraft ?? result?.targetBranch ?? '';
  const validDraft = isGitlabBranchName(draft) && draft !== target.sourceBranch;
  const verifiedDraft = result?.targetBranch === draft;
  const newUrl = result && verifiedDraft ? newBranchMergeRequestUrl(result, target) : null;

  function togglePanel() {
    if (attaching) return;
    if (view) {
      setTargetDraft(null);
      setRequestedTarget(undefined);
    }
    toggle();
  }

  function verifyTarget() {
    if (!validDraft || busy) return;
    setTargetDraft(draft);
    setRequestedTarget(draft);
    void load(draft);
  }

  async function attach(mr: BranchMergeRequest) {
    if (!result || !manualActions || manualActions.disabled || attaching || (feedback?.kind === 'failed' && feedback.stale)) return;
    const attempt = { result, id: mr.id, kind: 'saving' } as const;
    setAttachment(attempt);
    try {
      await manualActions.attachMergeRequest(branch, mr, result.branchRevision);
      setAttachment(current => current === attempt ? null : current);
    } catch (cause) {
      const stale = cause instanceof ApiError && (cause.status === 404 || cause.status === 409);
      setAttachment(current => current === attempt ? { ...attempt, kind: 'failed', stale, message: branchAttachmentError(cause) } : current);
    }
  }

  return <div className="gitlab-activity-inspection">
    <button className="btn btn-ghost" type="button" aria-expanded={Boolean(view)} aria-controls={view ? panelId : undefined}
      aria-disabled={attaching || undefined} onClick={togglePanel}>
      <GitMerge aria-hidden="true" size={14} />{view ? '브랜치 MR 닫기' : '브랜치 MR 확인'}
    </button>
    {view && <section id={panelId} className="gitlab-activity-inspection-panel" aria-label="GitLab 브랜치 MR" aria-busy={busy || attaching}>
      {busy && <p role="status">GitLab 브랜치의 MR을 확인하고 있습니다.</p>}
      {view.kind === 'stale' && <p role="status">브랜치 또는 티켓이 변경되었습니다. MR을 다시 확인해 주세요.</p>}
      {view.kind === 'failed' && <p className="gitlab-activity-inspection-warning" role="alert">{view.message}</p>}
      {result && (hasExisting ? <>
        {result.openMergeRequests.length > 0 && <ul className="gitlab-branch-mr-list" aria-label="열린 MR">
          {result.openMergeRequests.map(mr => <ExistingBranchMergeRequest key={mr.id} mr={mr}
            linked={manualActions?.hasMergeRequest(branch, mr) ?? false} feedback={feedback?.id === mr.id ? feedback : null}
            disabled={Boolean(manualActions?.disabled || attaching || (feedback?.kind === 'failed' && feedback.stale))}
            onAttach={manualActions ? () => void attach(mr) : undefined} />)}
        </ul>}
        {result.hasMore && <p className="gitlab-activity-inspection-warning" role="status">열린 MR 목록이 일부만 확인되었습니다. GitLab에서 이 브랜치의 MR을 확인해 주세요.</p>}
      </> : <p role="status">이 브랜치에 열린 MR이 없습니다.</p>)}
      {!hasExisting && (result || targetDraft !== null) && <>
        {result && !result.targetBranch && <p>대상 브랜치를 입력하고 확인해 주세요.{result.defaultBranch && <> 기본 브랜치 <code>{result.defaultBranch}</code></>}</p>}
        <div className="gitlab-branch-mr-field">
          <label>대상 브랜치
            <input className="field" value={draft} maxLength={512} spellCheck={false} autoCapitalize="none" autoComplete="off"
              aria-invalid={Boolean(draft && !validDraft)} disabled={busy} onChange={event => setTargetDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  verifyTarget();
                }
              }} />
          </label>
          <button className="btn btn-ghost" type="button" disabled={!validDraft || busy} onClick={verifyTarget}>대상 브랜치 확인</button>
        </div>
        {draft && !validDraft && <p className="gitlab-activity-inspection-warning">
          {draft === target.sourceBranch ? '소스 브랜치와 다른 대상 브랜치를 입력해 주세요.' : '올바른 GitLab 브랜치 이름을 입력해 주세요.'}
        </p>}
        {result && verifiedDraft && (result.targetSha === result.sourceSha
          ? <p>소스 브랜치와 대상 브랜치의 HEAD가 같습니다. 다른 대상 브랜치를 선택해 주세요.</p>
          : !newUrl && <p className="gitlab-activity-inspection-warning">새 GitLab MR 링크를 확인할 수 없습니다. 대상 브랜치를 다시 확인해 주세요.</p>)}
        {newUrl && result && <BranchMergeRequestCreation key={`${result.checkedAt}:${result.suggestedTitle}`} url={newUrl} title={result.suggestedTitle} />}
      </>}
      <button type="button" className="btn btn-ghost" aria-disabled={busy || attaching} onClick={() => { if (!attaching) void load(requestedTarget); }}>
        <RefreshCw aria-hidden="true" size={14} />브랜치 MR 다시 확인
      </button>
    </section>}
  </div>;
}

function ExistingBranchMergeRequest({ mr, linked, feedback, disabled, onAttach }: {
  mr: BranchMergeRequest; linked: boolean; feedback: AttachmentFeedback | null; disabled: boolean; onAttach?: () => void;
}) {
  const link = useRef<HTMLAnchorElement>(null);
  const transferFocus = useRef(false);
  useLayoutEffect(() => {
    if (!linked) return;
    if (transferFocus.current && document.activeElement === document.body) link.current?.focus({ preventScroll: true });
    transferFocus.current = false;
  }, [linked]);

  return <li>
    <strong>{mr.title}</strong>
    <span>대상 브랜치 <code>{mr.targetBranch}</code></span>
    <div className="gitlab-activity-actions">
      <a ref={link} className="btn btn-ghost" href={mr.webUrl} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" size={14} />MR !{mr.iid} 열기</a>
      {linked ? <span className="gitlab-activity-state" role="status">티켓에 연결됨</span> : onAttach &&
        <button type="button" className="btn btn-ghost" aria-disabled={disabled}
          aria-label={`MR !${mr.iid} 티켓에 연결`} onClick={event => {
            if (disabled) return;
            transferFocus.current = document.activeElement === event.currentTarget;
            onAttach();
          }}>{feedback?.kind === 'saving' ? '연결 중…' : `MR !${mr.iid} 티켓에 연결`}</button>}
    </div>
    {!linked && feedback?.kind === 'failed' && <p className="gitlab-activity-inspection-warning" role="alert">{feedback.message}</p>}
  </li>;
}

function BranchMergeRequestCreation({ url, title }: { url: URL; title: string }) {
  const titleInput = useRef<HTMLInputElement>(null);
  const [copyStatus, setCopyStatus] = useState('');

  async function copyTitle() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(title);
      } else {
        titleInput.current?.select();
        if (!document.execCommand('copy')) throw new Error('clipboard unavailable');
      }
      setCopyStatus('MR 제목을 복사했습니다.');
    } catch {
      titleInput.current?.focus();
      titleInput.current?.select();
      setCopyStatus('선택된 MR 제목을 직접 복사해 주세요.');
    }
  }

  return <>
    <div className="gitlab-branch-mr-field">
      <label>추천 MR 제목<input ref={titleInput} className="field" value={title} readOnly /></label>
      <button type="button" className="btn btn-ghost" onClick={() => void copyTitle()}>MR 제목 복사</button>
    </div>
    {copyStatus && <p role="status">{copyStatus}</p>}
    <a className="btn btn-ghost" href={url.href} target="_blank" rel="noopener noreferrer">
      <ExternalLink aria-hidden="true" size={14} />GitLab에서 새 MR 열기
    </a>
  </>;
}

function PipelineJobs({ target, revision }: { target: PipelineTarget; revision: string }) {
  const { view, toggle, load } = useActivityLookup(revision, async signal => {
    const path = `/issues/${encodeURIComponent(target.issueId)}/gitlab-links/${encodeURIComponent(target.linkId)}/pipeline-jobs`;
    const result = await api<GitlabPipelineJobs | undefined>(path, { method: 'GET', cache: 'no-store', signal });
    return isPipelineJobsResult(result, target) ? result : null;
  }, '연결된 파이프라인의 CI 작업 응답을 확인할 수 없습니다.', pipelineJobsMessage);

  return <PipelineJobsInspection view={view} toggle={toggle} reload={() => void load()}>
    {view?.kind === 'ready' && <PipelineJobsResult result={view.result} target={target} />}
  </PipelineJobsInspection>;
}

function PipelineJobsInspection({ view, toggle, reload, disabled = false, children }: {
  view: ActivityLookup<unknown> | null;
  toggle: () => void;
  reload: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const panelId = useId();
  return <div className="gitlab-activity-inspection">
    <button className="btn btn-ghost" type="button" aria-expanded={Boolean(view)} aria-controls={view ? panelId : undefined}
      aria-disabled={disabled || undefined} onClick={() => { if (!disabled) toggle(); }}>
      <Workflow aria-hidden="true" size={14} />{view ? 'CI 작업 닫기' : 'CI 작업 확인'}
    </button>
    {view && <section id={panelId} className="gitlab-activity-inspection-panel" aria-label="GitLab CI 작업" aria-busy={view.kind === 'loading'}>
      {view.kind === 'loading' && <p role="status">GitLab CI 작업을 확인하고 있습니다.</p>}
      {view.kind === 'stale' && <p role="status">파이프라인이 변경되었습니다. CI 작업을 다시 확인해 주세요.</p>}
      {view.kind === 'failed' && <p className="gitlab-activity-inspection-warning" role="alert">{view.message}</p>}
      {view.kind === 'ready' && children}
      <button type="button" className="btn btn-ghost" aria-disabled={disabled || view.kind === 'loading'}
        onClick={() => { if (!disabled) reload(); }}>
        <RefreshCw aria-hidden="true" size={14} />CI 작업 다시 확인
      </button>
    </section>}
  </div>;
}

function PipelineJobsResult({ result, target, showStatus = true }: { result: GitlabPipelineJobs; target: PipelineTarget; showStatus?: boolean }) {
  const triggers = isTriggerJobsResult(result.triggerJobs) ? result.triggerJobs : null;
  return <>
    {showStatus && <p className="gitlab-activity-inspection-meta" role="status">파이프라인 상태 <strong>{gitlabActivityStateLabel(result.status)}</strong>
      <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString('ko-KR')}</time>
    </p>}
    {result.configurationError && <p className="gitlab-activity-inspection-warning">GitLab에서 파이프라인 설정 오류를 보고했습니다.</p>}
    {result.jobs.length === 0 ? <p>조회한 CI 작업 중 실패 또는 수동 대기 상태가 없습니다.</p> :
      <ul className="gitlab-pipeline-job-list" aria-label="실패 및 수동 실행 작업">
        {result.jobs.map(job => <PipelineJobRow key={job.id} job={job} target={target} />)}
      </ul>}
    {result.hasMore && <p>조회 한도를 넘은 작업은 <a href={target.url.href} target="_blank" rel="noopener noreferrer">GitLab</a>에서 확인하세요.</p>}
    <section className="gitlab-trigger-jobs" aria-label="GitLab 트리거 작업">
      <h4>트리거 작업</h4>
      {!triggers ? <p className="gitlab-activity-inspection-warning">GitLab 트리거 작업을 확인하지 못했습니다.</p>
        : !triggers.jobs.length ? <p>조회한 트리거 작업이 없습니다.</p>
          : <ul className="gitlab-pipeline-job-list" aria-label="트리거 작업">
            {triggers.jobs.map(job => <PipelineJobRow key={job.id} job={job} target={target}>
              {job.downstream && <DownstreamPipeline downstream={job.downstream} target={target} />}
            </PipelineJobRow>)}
          </ul>}
      {triggers?.hasMore && <p>나머지 트리거 작업은 <a href={target.url.href} target="_blank" rel="noopener noreferrer">GitLab</a>에서 확인하세요.</p>}
    </section>
  </>;
}

function PipelineJobRow({ job, target, children }: { job: GitlabPipelineJob | GitlabPipelineTriggerJob; target: PipelineTarget; children?: React.ReactNode }) {
  const href = pipelineJobUrl(job, target);
  const reason = job.failureReason && (failureReasonLabels.get(job.failureReason) ?? job.failureReason);
  return <li className="gitlab-pipeline-job">
    {href ? <a className="gitlab-pipeline-job-link" href={href.href} target="_blank" rel="noopener noreferrer">
      <strong>{job.name}</strong><ExternalLink aria-hidden="true" size={13} />
    </a> : <strong>{job.name}</strong>}
    <div className="gitlab-activity-inspection-meta">
      <span className="gitlab-pipeline-job-state" data-state={job.status}>{gitlabActivityStateLabel(job.status)}</span>
      <span>{job.stage}</span>
      <span>{job.allowFailure ? '실패 허용' : '성공 필요'}</span>
      {reason && <span>{reason}</span>}
    </div>
    {children}
  </li>;
}

function DownstreamPipeline({ downstream, target }: { downstream: NonNullable<GitlabPipelineTriggerJob['downstream']>; target: PipelineTarget }) {
  const url = downstreamPipelineUrl(downstream, target);
  const label = `다운스트림 파이프라인 #${downstream.id}`;
  return <div className="gitlab-activity-inspection-meta">
    {url ? <a className="gitlab-pipeline-job-link" href={url.href} target="_blank" rel="noopener noreferrer" aria-label={`${label} 열기`}>
      {label}<ExternalLink aria-hidden="true" size={13} />
    </a> : <span>{label}</span>}
    <span className="gitlab-pipeline-job-state" data-state={downstream.status}>{gitlabActivityStateLabel(downstream.status)}</span>
  </div>;
}

function isTestCounts(value: unknown): value is GitlabTestCounts {
  if (!value || typeof value !== 'object') return false;
  const { count, passed, failed, skipped, errors, reportError } = value as Partial<GitlabTestCounts>;
  return typeof reportError === 'boolean' && [count, passed, failed, skipped, errors].every(item =>
    typeof item === 'number' && Number.isSafeInteger(item) && item >= 0);
}

function isPipelineTestReport(result: GitlabPipelineTestReport | undefined, target: PipelineTarget): result is GitlabPipelineTestReport {
  return Boolean(result && result.linkId === target.linkId && result.repositoryId === target.repositoryId &&
    result.pipelineId === target.pipelineId && typeof result.status === 'string' && result.status &&
    typeof result.checkedAt === 'string' && Number.isFinite(Date.parse(result.checkedAt)) && typeof result.hasMore === 'boolean' &&
    isTestCounts(result.total) && Array.isArray(result.suites) &&
    result.suites.every(suite => isTestCounts(suite) && typeof suite.name === 'string' && suite.name.trim()));
}

function pipelineTestPath(target: PipelineTestTarget, result: 'test-report' | 'failed-tests') {
  const { issueId, linkId, mergeRequestRevision } = target;
  if (mergeRequestRevision) {
    const query = new URLSearchParams({ revision: mergeRequestRevision });
    return `${gitlabMergeRequestPipelinePath(issueId, linkId)}-${result}?${query}`;
  }
  return `/issues/${encodeURIComponent(issueId)}/gitlab-links/${encodeURIComponent(linkId)}/pipeline-${result}`;
}

function pipelineTestReportMessage(cause: unknown, label = '테스트 결과', mergeRequest = false): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403) return `GitLab 연결과 ${label} 조회 권한을 확인해 주세요.`;
    if (cause.status === 404) {
      if (cause.message === `GitLab에서 이 파이프라인의 ${label}를 제공하지 않습니다.`) return cause.message;
      return '연결된 GitLab 파이프라인을 찾을 수 없습니다.';
    }
    if (cause.status === 409) return mergeRequest
      ? 'MR 또는 최신 파이프라인이 변경되었습니다. MR 최신 파이프라인 다시 확인을 눌러 주세요.'
      : '파이프라인이나 GitLab 연결이 변경되었습니다. 다시 확인해 주세요.';
    if (cause.status === 429) return 'GitLab 요청 제한이 풀린 뒤 다시 확인해 주세요.';
  }
  return `GitLab ${label}를 불러오지 못했습니다. 다시 확인해 주세요.`;
}

function PipelineTestReport({ target, revision }: { target: PipelineTestTarget; revision: string }) {
  const panelId = useId();
  const { view, toggle, load } = useActivityLookup(revision, async signal => {
    const result = await api<GitlabPipelineTestReport | undefined>(pipelineTestPath(target, 'test-report'), { method: 'GET', cache: 'no-store', signal });
    return isPipelineTestReport(result, target) ? result : null;
  }, '연결된 파이프라인의 테스트 결과 응답을 확인할 수 없습니다.',
    cause => pipelineTestReportMessage(cause, '테스트 결과', Boolean(target.mergeRequestRevision)));

  return <div className="gitlab-activity-inspection">
    <button className="btn btn-ghost" type="button" aria-expanded={Boolean(view)} aria-controls={view ? panelId : undefined} onClick={toggle}>
      <FlaskConical aria-hidden="true" size={14} />{view ? '테스트 결과 닫기' : '테스트 결과 확인'}
    </button>
    {view && <section id={panelId} className="gitlab-activity-inspection-panel" aria-label="GitLab 테스트 결과" aria-busy={view.kind === 'loading'}>
      {view.kind === 'loading' && <p role="status">GitLab 테스트 결과를 확인하고 있습니다.</p>}
      {view.kind === 'stale' && <p role="status">파이프라인이 변경되었습니다. 테스트 결과를 다시 확인해 주세요.</p>}
      {view.kind === 'failed' && <p className="gitlab-activity-inspection-warning" role="alert">{view.message}</p>}
      {view.kind === 'ready' && <PipelineTestReportResult result={view.result} target={target} revision={revision} />}
      <div className="gitlab-test-report-actions">
        <button type="button" className="btn btn-ghost" aria-disabled={view.kind === 'loading'} onClick={() => void load()}>
          <RefreshCw aria-hidden="true" size={14} />테스트 결과 다시 확인
        </button>
        <a className="gitlab-test-report-link" href={target.url.href} target="_blank" rel="noopener noreferrer">
          GitLab에서 파이프라인 열기 <ExternalLink aria-hidden="true" size={13} />
        </a>
      </div>
    </section>}
  </div>;
}

const testCount = new Intl.NumberFormat('ko-KR');

function TestCounts({ counts, label }: { counts: GitlabTestCounts; label?: string }) {
  return <div className="gitlab-test-counts" role={label ? 'group' : undefined} aria-label={label}>
    <span>전체 {testCount.format(counts.count)}개</span>
    <span>성공 {testCount.format(counts.passed)}개</span>
    <span>실패 {testCount.format(counts.failed)}개</span>
    <span>건너뜀 {testCount.format(counts.skipped)}개</span>
    <span>오류 {testCount.format(counts.errors)}개</span>
  </div>;
}

function PipelineTestReportResult({ result, target, revision }: { result: GitlabPipelineTestReport; target: PipelineTestTarget; revision: string }) {
  const reportError = result.total.reportError || result.suites.some(suite => suite.reportError);
  const hasFailures = result.total.failed > 0 || result.total.errors > 0 || result.suites.some(suite => suite.failed > 0 || suite.errors > 0);
  return <>
    <p className="gitlab-activity-inspection-meta" role="status">파이프라인 상태 <strong>{gitlabActivityStateLabel(result.status)}</strong>
      <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString('ko-KR')}</time>
    </p>
    <TestCounts counts={result.total} label="전체 테스트" />
    {reportError && <p className="gitlab-activity-inspection-warning">GitLab에서 테스트 보고서 오류를 보고했습니다.</p>}
    {result.total.count === 0 && !reportError && !result.hasMore && <p>GitLab에서 확인한 테스트가 없습니다.</p>}
    {(hasFailures || reportError || result.hasMore) && <PipelineFailedTests target={target} revision={revision} />}
    {result.suites.length > 0 && <ul className="gitlab-test-suite-list" role="list" aria-label="테스트 스위트">
      {result.suites.map((suite, index) => <li className="gitlab-test-suite" key={`${suite.name}:${index}`}>
        <strong>{suite.name}</strong>
        <TestCounts counts={suite} />
        {suite.reportError && <span className="gitlab-activity-inspection-warning">보고서 오류</span>}
      </li>)}
    </ul>}
    {result.hasMore && <p>일부 테스트 스위트만 표시합니다.</p>}
  </>;
}

function isPipelineFailedTestsResult(result: GitlabPipelineFailedTests | undefined, target: PipelineTarget): result is GitlabPipelineFailedTests {
  const isLabel = (value: unknown) => typeof value === 'string' && value.length <= 255 && Boolean(value.trim());
  return Boolean(result && result.linkId === target.linkId && result.repositoryId === target.repositoryId &&
    result.pipelineId === target.pipelineId && typeof result.status === 'string' && result.status &&
    typeof result.checkedAt === 'string' && Number.isFinite(Date.parse(result.checkedAt)) && typeof result.hasMore === 'boolean' &&
    Array.isArray(result.cases) && result.cases.every(testCase => testCase && isLabel(testCase.suite) && isLabel(testCase.name) &&
      (testCase.className === undefined || isLabel(testCase.className)) && (testCase.status === 'failed' || testCase.status === 'error')));
}

function PipelineFailedTests({ target, revision }: { target: PipelineTestTarget; revision: string }) {
  const panelId = useId();
  const { view, toggle, load } = useActivityLookup(revision, async signal => {
    const result = await api<GitlabPipelineFailedTests | undefined>(pipelineTestPath(target, 'failed-tests'), { method: 'GET', cache: 'no-store', signal });
    return isPipelineFailedTestsResult(result, target) ? result : null;
  }, '연결된 파이프라인의 실패 테스트 상세 응답을 확인할 수 없습니다.',
    cause => pipelineTestReportMessage(cause, '실패 테스트 상세', Boolean(target.mergeRequestRevision)));

  return <div className="gitlab-failed-tests">
    <button className="btn btn-ghost" type="button" aria-expanded={Boolean(view)} aria-controls={view ? panelId : undefined} onClick={toggle}>
      {view ? '실패 테스트 닫기' : '실패 테스트 확인'}
    </button>
    {view && <section id={panelId} className="gitlab-activity-inspection-panel" aria-label="GitLab 실패 테스트" aria-busy={view.kind === 'loading'}>
      {view.kind === 'loading' && <p role="status">GitLab 실패 테스트를 확인하고 있습니다.</p>}
      {view.kind === 'stale' && <p role="status">파이프라인이 변경되었습니다. 실패 테스트를 다시 확인해 주세요.</p>}
      {view.kind === 'failed' && <p className="gitlab-activity-inspection-warning" role="alert">{view.message}</p>}
      {view.kind === 'ready' && <>
        <p className="gitlab-activity-inspection-meta">조회 시각
          <time dateTime={view.result.checkedAt}>{new Date(view.result.checkedAt).toLocaleString('ko-KR')}</time>
        </p>
        {view.result.cases.length ? <ul className="gitlab-test-suite-list" role="list" aria-label="실패 및 오류 테스트" tabIndex={0}>
          {view.result.cases.map((testCase, index) => <li className="gitlab-test-suite" key={`${testCase.name}:${index}`}>
            <div className="gitlab-activity-inspection-meta">
              <strong>{testCase.name}</strong><span className="gitlab-activity-inspection-warning">{testCase.status === 'failed' ? '실패' : '오류'}</span>
            </div>
            <div className="gitlab-activity-inspection-meta"><span>{testCase.suite}</span>{testCase.className && <code>{testCase.className}</code>}</div>
          </li>)}
        </ul> : <p>조회한 테스트 상세에 실패 또는 오류 테스트가 없습니다.</p>}
        {view.result.hasMore && <p>조회 범위가 제한되었습니다. 전체 테스트를 GitLab에서 확인해 주세요.</p>}
      </>}
      <div className="gitlab-test-report-actions">
        <button type="button" className="btn btn-ghost" aria-disabled={view.kind === 'loading'} onClick={() => void load()}>
          <RefreshCw aria-hidden="true" size={14} />실패 테스트 다시 확인
        </button>
        <a className="gitlab-test-report-link" href={target.url.href} target="_blank" rel="noopener noreferrer">
          GitLab 원본 파이프라인 열기 <ExternalLink aria-hidden="true" size={13} />
        </a>
      </div>
    </section>}
  </div>;
}

function mergeRequestReviewMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403) return 'GitLab 연결과 MR 검토 조회 권한을 확인해 주세요.';
    if (cause.status === 404) return '연결된 GitLab MR을 찾을 수 없습니다.';
    if (cause.status === 409) return 'MR 또는 GitLab 연결이 변경되었습니다. 다시 확인해 주세요.';
    if (cause.status === 429) return 'GitLab 요청 제한이 풀린 뒤 다시 확인해 주세요.';
  }
  return 'GitLab MR 검토 정보를 불러오지 못했습니다. 다시 확인해 주세요.';
}

function MergeRequestReview({ target, revision, directDiscussions }: { target: ReviewTarget; revision: string; directDiscussions: boolean }) {
  const panelId = useId();
  const { view, toggle, load } = useActivityLookup(revision, async signal => {
    const path = `/issues/${encodeURIComponent(target.issueId)}/gitlab-links/${encodeURIComponent(target.linkId)}/merge-request-review`;
    const result = await api<GitlabMergeRequestReview | undefined>(path, { method: 'GET', cache: 'no-store', signal });
    return isReviewResult(result, target) ? result : null;
  }, '연결된 MR의 검토 정보 응답을 확인할 수 없습니다.', mergeRequestReviewMessage);

  return <div className="gitlab-activity-inspection">
    {directDiscussions && <MergeRequestDiscussions target={target} revision={revision} />}
    <button className="btn btn-ghost" type="button" aria-expanded={Boolean(view)} aria-controls={view ? panelId : undefined} onClick={toggle}>
      <GitMerge aria-hidden="true" size={14} />{view ? 'MR 검토 닫기' : 'MR 검토 확인'}
    </button>
    {view && <section id={panelId} className="gitlab-activity-inspection-panel" aria-label="GitLab MR 검토" aria-busy={view.kind === 'loading'}>
      {view.kind === 'loading' && <p role="status">GitLab MR 검토 정보를 확인하고 있습니다.</p>}
      {view.kind === 'stale' && <p role="status">MR이 변경되었습니다. 검토 정보를 다시 확인해 주세요.</p>}
      {view.kind === 'failed' && <p className="gitlab-activity-inspection-warning" role="alert">{view.message}</p>}
      {view.kind === 'ready' && <>
        <MergeRequestReviewResult result={view.result} url={target.url} />
        {!directDiscussions && <MergeRequestDiscussions target={target} revision={revision} />}
      </>}
      <button type="button" className="btn btn-ghost" aria-disabled={view.kind === 'loading'} onClick={() => void load()}>
        <RefreshCw aria-hidden="true" size={14} />MR 검토 다시 확인
      </button>
    </section>}
  </div>;
}

type AvailableMergeRequestPipeline = Extract<GitlabMergeRequestPipeline, { kind: 'pipeline' }>;
export type MergeRequestObservedPipeline = AvailableMergeRequestPipeline['pipeline'];
type MergeRequestPipelineSnapshot = Exclude<GitlabMergeRequestPipeline, AvailableMergeRequestPipeline> |
  (AvailableMergeRequestPipeline & { target: PipelineTarget });

const unavailableMergeRequestPipeline = {
  no_pipeline: '이 MR에 최신 파이프라인이 없습니다.',
  pipeline_unavailable: 'MR의 최신 파이프라인을 확인할 수 없습니다.',
  repository_not_connected: 'MR 파이프라인의 저장소가 GitLab 연결에 포함되지 않았습니다.',
} satisfies Record<Exclude<GitlabMergeRequestPipeline['kind'], 'pipeline'>, string>;

export function gitlabMergeRequestPipelinePath(issueId: string, linkId: string): string {
  return `/issues/${encodeURIComponent(issueId)}/gitlab-links/${encodeURIComponent(linkId)}/merge-request-pipeline`;
}

export function matchesMergeRequestPipelineLink(link: GitlabLink | undefined, mr: GitlabLink, pipeline: MergeRequestObservedPipeline,
  newlyCreated = false): boolean {
  if (link?.kind !== 'pipeline' || mr.kind !== 'merge_request' || link.issueId !== mr.issueId ||
      link.projectId !== pipeline.repositoryId) return false;
  const identity = gitlabPipelineLinkIdentity(link);
  if (!identity || identity.instance !== mr.id.split(':', 2)[1] || identity.objectId !== pipeline.pipelineId) return false;
  if (newlyCreated) return link.sourceSha === pipeline.sha && link.webUrl === pipeline.webUrl;
  if (link.sourceSha != null && gitlabObjectSha(link.sourceSha) !== pipeline.sha) return false;
  const saved = gitlabActivityUrl(link.webUrl, 'pipeline');
  const verified = gitlabActivityUrl(pipeline.webUrl, 'pipeline');
  const route = saved && /^\/.+?\/(?:-\/)?pipelines\/([1-9]\d*)\/?$/u.exec(saved.pathname);
  return Boolean(saved && verified && !saved.search && !saved.hash && saved.origin === verified.origin && route?.[1] === String(pipeline.pipelineId));
}

async function readMergeRequestPipeline(target: ReviewTarget, signal: AbortSignal, withJobs = false): Promise<MergeRequestPipelineSnapshot | null> {
  const path = `${gitlabMergeRequestPipelinePath(target.issueId, target.linkId)}${withJobs ? '-jobs' : ''}`;
  const result = await api<GitlabMergeRequestPipeline | undefined>(path, { method: 'GET', cache: 'no-store', signal });
  if (!result || result.linkId !== target.linkId || result.repositoryId !== target.repositoryId ||
      result.mergeRequestIid !== target.mergeRequestIid || typeof result.checkedAt !== 'string' || !Number.isFinite(Date.parse(result.checkedAt))) return null;
  if (result.kind !== 'pipeline') return Object.hasOwn(unavailableMergeRequestPipeline, result.kind) ? result : null;

  const pipeline = result.pipeline;
  if (typeof result.revision !== 'string' || !/^[a-f\d]{64}$/u.test(result.revision) ||
      !pipeline || !Number.isSafeInteger(pipeline.repositoryId) || pipeline.repositoryId < 1 ||
      !Number.isSafeInteger(pipeline.pipelineId) || pipeline.pipelineId < 1 ||
      !pipeline.sha || gitlabObjectSha(pipeline.sha) !== pipeline.sha || /^0+$/u.test(pipeline.sha) ||
      typeof pipeline.status !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/u.test(pipeline.status) ||
      (pipeline.updatedAt !== null && (typeof pipeline.updatedAt !== 'string' || !Number.isFinite(Date.parse(pipeline.updatedAt))))) return null;
  const url = gitlabActivityUrl(pipeline.webUrl, 'pipeline');
  const route = url && /^\/(?:[^/]+\/){2,}-\/pipelines\/([1-9]\d*)$/u.exec(url.pathname);
  if (!url || url.origin !== target.url.origin || url.href !== pipeline.webUrl || url.href !== `${url.origin}${url.pathname}` ||
      route?.[1] !== String(pipeline.pipelineId)) return null;
  const pipelineTarget = { linkId: target.linkId, issueId: target.issueId,
    repositoryId: pipeline.repositoryId, pipelineId: pipeline.pipelineId, url };
  if (result.jobs !== undefined && !isPipelineJobsResult(result.jobs, pipelineTarget)) return null;
  return { ...result, target: pipelineTarget };
}

function mergeRequestPipelineMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403) return 'GitLab 연결과 MR 파이프라인 조회 권한을 확인해 주세요.';
    if (cause.status === 404) return '연결된 GitLab MR을 찾을 수 없습니다.';
    if (cause.status === 409) return 'MR 또는 GitLab 연결이 변경되었습니다. 다시 확인해 주세요.';
    if (cause.status === 429) return 'GitLab 요청 제한이 풀린 뒤 다시 확인해 주세요.';
  }
  return 'GitLab MR의 최신 파이프라인을 불러오지 못했습니다. 다시 확인해 주세요.';
}

function MergeRequestPipeline({ target, revision, mr, manualActions, reviewStatus }: {
  target: ReviewTarget; revision: string; mr: GitlabLink; manualActions?: ManualLinkActions;
  reviewStatus?: GitlabActivityStatusActions['reviewStatus'];
}) {
  const panelId = useId();
  const { view, toggle, load } = useActivityLookup(revision, signal => readMergeRequestPipeline(target, signal),
    'MR의 최신 파이프라인 응답을 확인할 수 없습니다.', mergeRequestPipelineMessage);
  const disabled = Boolean(manualActions?.disabled);

  return <div className="gitlab-activity-inspection">
    <button type="button" className="btn btn-ghost" aria-expanded={Boolean(view)} aria-controls={view ? panelId : undefined}
      aria-disabled={disabled || undefined} onClick={() => { if (!disabled) toggle(); }}>
      <Workflow aria-hidden="true" size={14} />{view ? 'MR 최신 파이프라인 닫기' : 'MR 최신 파이프라인 확인'}
    </button>
    {view && <section id={panelId} className="gitlab-activity-inspection-panel gitlab-mr-pipeline-inspection"
      aria-label="GitLab MR 최신 파이프라인" aria-busy={view.kind === 'loading'}>
      {view.kind === 'loading' && <p role="status">GitLab에서 MR의 최신 파이프라인을 확인하고 있습니다.</p>}
      {view.kind === 'stale' && <p role="status">MR이 변경되었습니다. 최신 파이프라인을 다시 확인해 주세요.</p>}
      {view.kind === 'failed' && <p className="gitlab-activity-inspection-warning" role="alert">{view.message}</p>}
      {view.kind === 'ready' && <MergeRequestPipelineDetails initial={view.result} target={target} revision={revision}
        mr={mr} manualActions={manualActions} reviewStatus={reviewStatus} />}
      <button type="button" className="btn btn-ghost" aria-disabled={disabled || view.kind === 'loading'}
        onClick={() => { if (!disabled) void load(); }}>
        <RefreshCw aria-hidden="true" size={14} />MR 최신 파이프라인 다시 확인
      </button>
    </section>}
  </div>;
}

function MergeRequestPipelineDetails({ initial, target, revision, mr, manualActions, reviewStatus }: {
  initial: MergeRequestPipelineSnapshot; target: ReviewTarget; revision: string; mr: GitlabLink; manualActions?: ManualLinkActions;
  reviewStatus?: GitlabActivityStatusActions['reviewStatus'];
}) {
  const [observation, setObservation] = useState({ initial, current: initial, changed: false });
  if (observation.initial !== initial) setObservation({ initial, current: initial, changed: false });
  const { current, changed } = observation;
  const { view, toggle, load } = useActivityLookup(revision, async signal => {
    const next = await readMergeRequestPipeline(target, signal, true);
    if (next && !signal.aborted) {
      setObservation(previous => {
        if (previous.initial !== initial) return previous;
        const prior = previous.current.kind === 'pipeline' ? previous.current.pipeline : null;
        const changed = prior !== null && next.kind === 'pipeline' &&
          (prior.repositoryId !== next.pipeline.repositoryId || prior.pipelineId !== next.pipeline.pipelineId || prior.sha !== next.pipeline.sha);
        return { initial, current: next, changed };
      });
    }
    return next;
  }, 'MR 파이프라인의 CI 작업 응답을 확인할 수 없습니다.', pipelineJobsMessage);

  if (current.kind !== 'pipeline') return <p role="status">{unavailableMergeRequestPipeline[current.kind]}</p>;
  const { pipeline } = current;
  return <>
    <p className="gitlab-activity-inspection-meta" role="status">최신 파이프라인 상태 <strong>{gitlabActivityStateLabel(pipeline.status)}</strong>
      <time dateTime={current.checkedAt}>{new Date(current.checkedAt).toLocaleString('ko-KR')}</time>
    </p>
    <a className="gitlab-pipeline-job-link" href={current.target.url.href} target="_blank" rel="noopener noreferrer"
      aria-label={`파이프라인 #${pipeline.pipelineId} GitLab에서 열기`}>
      파이프라인 #{pipeline.pipelineId}<ExternalLink aria-hidden="true" size={13} />
    </a>
    {changed && <p role="status">MR의 최신 파이프라인이 바뀌어 현재 정보를 표시합니다.</p>}
    {manualActions && <MergeRequestPipelineAttachment result={current} mr={mr} actions={manualActions}
      reviewStatus={reviewStatus} verifying={view?.kind === 'loading'} />}
    <PipelineJobsInspection view={view} toggle={toggle} reload={() => void load()} disabled={manualActions?.disabled}>
      {view?.kind === 'ready' && view.result === current && (current.jobs
        ? <PipelineJobsResult result={current.jobs} target={current.target} showStatus={false} />
        : <p role="status">현재 파이프라인의 CI 작업을 다시 확인해 주세요.</p>)}
    </PipelineJobsInspection>
    <PipelineTestReport target={{ ...current.target, mergeRequestRevision: current.revision }}
      revision={JSON.stringify([revision, current.revision, pipeline.status, pipeline.updatedAt])} />
  </>;
}

type MergeRequestPipelineAttachmentFeedback = { result: AvailableMergeRequestPipeline } & (
  { kind: 'saving' } | { kind: 'failed'; stale: boolean; message: string }
);

function mergeRequestPipelineAttachmentError(cause: unknown) {
  if (cause instanceof ApiError) {
    if (cause.status === 404 || cause.status === 409) return 'MR 또는 파이프라인 정보가 변경되었습니다. 최신 파이프라인을 다시 확인해 주세요.';
    if (cause.status === 401 || cause.status === 403) return 'GitLab 연결과 파이프라인 조회 권한을 확인해 주세요.';
    if (cause.status === 429) return 'GitLab 요청 제한이 풀린 뒤 다시 연결해 주세요.';
  }
  return '파이프라인 연결 결과를 확인하지 못했습니다. 다시 연결해 주세요.';
}

function MergeRequestPipelineAttachment({ result, mr, actions, reviewStatus, verifying }: {
  result: AvailableMergeRequestPipeline; mr: GitlabLink; actions: ManualLinkActions;
  reviewStatus?: GitlabActivityStatusActions['reviewStatus']; verifying: boolean;
}) {
  const linked = actions.findMergeRequestPipeline(mr, result.pipeline);
  const [feedback, setFeedback] = useState<MergeRequestPipelineAttachmentFeedback | null>(null);
  const current = feedback?.result === result ? feedback : null;
  const attaching = current?.kind === 'saving';
  const disabled = actions.disabled || verifying || attaching;
  const reviewButton = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const transferFocus = useRef(false);
  useLayoutEffect(() => {
    if (!linked || disabled || !transferFocus.current) return;
    transferFocus.current = false;
    if (document.activeElement === document.body) (reviewButton.current ?? status.current)?.focus({ preventScroll: true });
  }, [linked, disabled]);

  async function attach(trigger: HTMLButtonElement) {
    if (disabled || (current?.kind === 'failed' && current.stale)) return;
    transferFocus.current = document.activeElement === trigger;
    const attempt = { result, kind: 'saving' } as const;
    setFeedback(attempt);
    try {
      await actions.attachMergeRequestPipeline(mr, result.pipeline, result.revision);
      setFeedback(previous => previous === attempt ? null : previous);
    } catch (cause) {
      const stale = cause instanceof ApiError && (cause.status === 404 || cause.status === 409);
      setFeedback(previous => previous === attempt ? { ...attempt, kind: 'failed', stale, message: mergeRequestPipelineAttachmentError(cause) } : previous);
    }
  }

  return <>
    <div className="gitlab-activity-actions">
      {linked ? <>
        <span ref={status} tabIndex={-1} className="gitlab-activity-state" role="status">티켓에 연결됨</span>
        {reviewStatus && <button ref={reviewButton} type="button" className="btn btn-ghost" aria-disabled={disabled || undefined}
          onClick={event => { if (!disabled) reviewStatus(linked, event.currentTarget); }}>
          <ClipboardCheck aria-hidden="true" size={14} />연결한 파이프라인으로 상태 검토
        </button>}
      </> : <button type="button" className="btn btn-ghost" aria-label="이 업무에 파이프라인 연결"
        aria-disabled={disabled || (current?.kind === 'failed' && current.stale) || undefined}
        onClick={event => void attach(event.currentTarget)}>
        {attaching ? '연결 중…' : '이 업무에 파이프라인 연결'}
      </button>}
    </div>
    {!linked && current?.kind === 'failed' && <p className="gitlab-activity-inspection-warning" role="alert">{current.message}</p>}
  </>;
}

function reviewPersonLabel({ name, username }: Pick<ReviewPerson, 'name' | 'username'>) {
  if (!username) return name;
  return name && name !== username ? `${name} (@${username})` : `@${username}`;
}

function MergeRequestReviewResult({ result, url }: { result: GitlabMergeRequestReview; url: URL }) {
  const { reviewerSource, reviewers, reviewersHasMore, approvals } = result;
  return <>
    <p className="gitlab-activity-inspection-meta">조회 시각 <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString('ko-KR')}</time></p>
    <h4>검토자</h4>
    {reviewerSource === 'unavailable' ? <p>GitLab에서 검토자 목록을 확인하지 못했습니다.</p> : <>
      {reviewers.length ? <ul className="gitlab-review-people" role="list" aria-label="검토자">{reviewers.map(person => <li key={person.id}>
        <strong>{reviewPersonLabel(person)}</strong><span>{reviewStateLabels[reviewerSource === 'merge_request' ? 'unknown' : person.state]}</span>
      </li>)}</ul> : <p>지정된 검토자가 없습니다.</p>}
      {reviewerSource === 'merge_request' && reviewers.length > 0 && <p>MR 기본 정보에서 확인한 검토자입니다.</p>}
      {reviewersHasMore && <p>나머지 검토자는 <a href={url.href} target="_blank" rel="noopener noreferrer">GitLab</a>에서 확인하세요.</p>}
    </>}
    <h4>승인 정보</h4>
    {!approvals ? <p>GitLab에서 승인 정보를 확인하지 못했습니다.</p> : <>
      {approvals.required !== null && approvals.remaining !== null && approvals.remaining <= approvals.required &&
        <p>필요한 승인 {approvals.required}개 · 남은 승인 {approvals.remaining}개</p>}
      {approvals.approvers.length ? <ul className="gitlab-review-people" role="list" aria-label="승인자">
        {approvals.approvers.map(person => <li key={person.id}><strong>{reviewPersonLabel(person)}</strong></li>)}
      </ul> : <p>확인된 승인자가 없습니다.</p>}
      {approvals.hasMore && <p>나머지 승인자는 <a href={url.href} target="_blank" rel="noopener noreferrer">GitLab</a>에서 확인하세요.</p>}
    </>}
  </>;
}

function isMergeRequestDiscussionsResult(result: GitlabMergeRequestDiscussions | undefined, target: ReviewTarget): result is GitlabMergeRequestDiscussions {
  if (!result || result.linkId !== target.linkId || result.repositoryId !== target.repositoryId ||
      result.mergeRequestIid !== target.mergeRequestIid || typeof result.checkedAt !== 'string' || !Number.isFinite(Date.parse(result.checkedAt)) ||
      typeof result.hasMore !== 'boolean' || !Array.isArray(result.threads)) return false;
  const ids = new Set<number>();
  return result.threads.every(thread => {
    if (!thread || !Number.isSafeInteger(thread.noteId) || thread.noteId < 1 || ids.has(thread.noteId) ||
        (thread.author !== null && typeof thread.author !== 'string') ||
        typeof thread.excerpt !== 'string' || typeof thread.excerptTruncated !== 'boolean' ||
        (thread.filePath !== null && typeof thread.filePath !== 'string')) return false;
    ids.add(thread.noteId);
    if (thread.line === null) return thread.lineSide === null;
    return Boolean(thread.filePath) && Number.isSafeInteger(thread.line) && thread.line > 0 &&
      (thread.lineSide === 'old' || thread.lineSide === 'new');
  });
}

function mergeRequestDiscussionsMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403) return 'GitLab 연결과 MR 토론 조회 권한을 확인해 주세요.';
    if (cause.status === 404) return 'GitLab에서 이 MR의 토론을 조회할 수 없습니다.';
    if (cause.status === 409) return 'MR 또는 GitLab 연결이 변경되었습니다. 미해결 토론을 다시 확인해 주세요.';
    if (cause.status === 429) return 'GitLab 요청 제한이 풀린 뒤 다시 확인해 주세요.';
    if (cause.status === 501) return '이 GitLab 연결에서는 MR 토론 조회를 지원하지 않습니다.';
  }
  return 'GitLab 미해결 토론을 불러오지 못했습니다. 다시 확인해 주세요.';
}

function MergeRequestDiscussions({ target, revision }: { target: ReviewTarget; revision: string }) {
  const panelId = useId();
  const { view, toggle, load } = useActivityLookup(revision, async signal => {
    const path = `/issues/${encodeURIComponent(target.issueId)}/gitlab-links/${encodeURIComponent(target.linkId)}/merge-request-discussions`;
    const result = await api<GitlabMergeRequestDiscussions | undefined>(path, { method: 'GET', cache: 'no-store', signal });
    return isMergeRequestDiscussionsResult(result, target) ? result : null;
  }, '연결된 MR의 미해결 토론 응답을 확인할 수 없습니다.', mergeRequestDiscussionsMessage);

  return <div className="gitlab-review-discussions">
    <button className="btn btn-ghost" type="button" aria-expanded={Boolean(view)} aria-controls={view ? panelId : undefined} onClick={toggle}>
      {view ? '미해결 토론 닫기' : '미해결 토론 확인'}
    </button>
    {view && <section id={panelId} className="gitlab-activity-inspection-panel" aria-label="GitLab 미해결 토론" aria-busy={view.kind === 'loading'}>
      {view.kind === 'loading' && <p role="status">GitLab 미해결 토론을 확인하고 있습니다.</p>}
      {view.kind === 'stale' && <p role="status">MR이 변경되었습니다. 미해결 토론을 다시 확인해 주세요.</p>}
      {view.kind === 'failed' && <p className="gitlab-activity-inspection-warning" role="alert">{view.message}</p>}
      {view.kind === 'ready' && <MergeRequestDiscussionsResult result={view.result} url={target.url} />}
      <div className="gitlab-discussion-actions">
        <button type="button" className="btn btn-ghost" aria-disabled={view.kind === 'loading'} onClick={() => void load()}>
          <RefreshCw aria-hidden="true" size={14} />미해결 토론 다시 확인
        </button>
        <a className="gitlab-discussion-link" href={target.url.href} target="_blank" rel="noopener noreferrer">
          GitLab에서 MR 열기 <ExternalLink aria-hidden="true" size={13} />
        </a>
      </div>
    </section>}
  </div>;
}

function MergeRequestDiscussionsResult({ result, url }: { result: GitlabMergeRequestDiscussions; url: URL }) {
  return <>
    <p className="gitlab-activity-inspection-meta">조회 시각 <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString('ko-KR')}</time></p>
    {result.threads.length > 0 ? <ul className="gitlab-discussion-list" role="list" aria-label="미해결 토론" tabIndex={0}>
      {result.threads.map(thread => {
        const noteUrl = new URL(url.href);
        noteUrl.hash = `note_${thread.noteId}`;
        return <li className="gitlab-discussion" key={thread.noteId}>
          {(thread.author || thread.filePath) && <div className="gitlab-activity-inspection-meta">
            {thread.author && <strong>{thread.author}</strong>}
            {thread.filePath && <code>{thread.filePath}{thread.line !== null && `:${thread.line}`}</code>}
            {thread.lineSide && <span>{thread.lineSide === 'old' ? '변경 전' : '변경 후'}</span>}
          </div>}
          <p className="gitlab-discussion-excerpt">{thread.excerpt || '토론 미리보기가 없습니다.'}{thread.excerptTruncated && '…'}</p>
          <a className="gitlab-discussion-link" href={noteUrl.href} target="_blank" rel="noopener noreferrer">
            GitLab에서 토론 열기 <ExternalLink aria-hidden="true" size={13} />
          </a>
        </li>;
      })}
    </ul> : <p>{result.hasMore ? '조회 범위에서 미해결 토론을 찾지 못했습니다.' : '표시할 수 있는 미해결 토론이 없습니다.'}</p>}
    {result.hasMore && <p>조회 범위가 제한되었습니다. 전체 토론을 GitLab에서 확인해 주세요.</p>}
  </>;
}

const fileChangeLabels = { added: '추가', modified: '수정', renamed: '이름 변경', deleted: '삭제' } satisfies Record<GitlabMergeRequestChangedFile['change'], string>;

function isChangedFilesResult(result: GitlabMergeRequestChangedFiles | undefined, target: ReviewTarget): result is GitlabMergeRequestChangedFiles {
  if (!result || result.linkId !== target.linkId || result.repositoryId !== target.repositoryId ||
      result.mergeRequestIid !== target.mergeRequestIid || !Number.isFinite(Date.parse(result.checkedAt)) ||
      typeof result.hasMore !== 'boolean' || !Array.isArray(result.files) || result.files.length > GITLAB_MR_CHANGED_FILE_LIMIT) return false;
  const paths = new Set<string>();
  return result.files.every(file => {
    if (!file || typeof file.oldPath !== 'string' || !file.oldPath || typeof file.newPath !== 'string' || !file.newPath ||
        !Object.hasOwn(fileChangeLabels, file.change) || typeof file.generated !== 'boolean' || typeof file.diffLimited !== 'boolean') return false;
    const pair = JSON.stringify([file.oldPath, file.newPath]);
    if (paths.has(pair)) return false;
    paths.add(pair);
    return true;
  });
}

function changedFilesError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403) return 'GitLab 연결과 MR 변경 파일 조회 권한을 확인해 주세요.';
    if (cause.status === 404) return 'GitLab에서 이 MR의 변경 파일을 조회할 수 없습니다.';
    if (cause.status === 409) return 'MR 또는 GitLab 연결이 변경되었습니다. 변경 파일을 다시 확인해 주세요.';
    if (cause.status === 429) return 'GitLab 요청 제한이 풀린 뒤 다시 확인해 주세요.';
    if (cause.status === 501) return '이 GitLab 연결에서는 MR 변경 파일 조회를 지원하지 않습니다.';
  }
  return 'GitLab 변경 파일을 불러오지 못했습니다. 다시 확인해 주세요.';
}

function MergeRequestChangedFiles({ target, revision }: { target: ReviewTarget; revision: string }) {
  const panelId = useId();
  const { view, toggle, load } = useActivityLookup(revision, async signal => {
    const path = ['/issues', encodeURIComponent(target.issueId), 'gitlab-links', encodeURIComponent(target.linkId), 'merge-request-changed-files'].join('/');
    const result = await api<GitlabMergeRequestChangedFiles | undefined>(path, { method: 'GET', cache: 'no-store', signal });
    return isChangedFilesResult(result, target) ? result : null;
  }, '연결된 MR의 변경 파일 응답을 확인할 수 없습니다.', changedFilesError);
  const changesUrl = new URL(target.url.href);
  changesUrl.pathname = changesUrl.pathname.replace(/\/$/u, '') + '/diffs';

  return <div className="gitlab-activity-inspection">
    <button className="btn btn-ghost" type="button" aria-expanded={Boolean(view)} aria-controls={view ? panelId : undefined} onClick={toggle}>
      <FileDiff size={14} aria-hidden="true" />{view ? '변경 파일 닫기' : '변경 파일 확인'}
    </button>
    {view && <section id={panelId} className="gitlab-activity-inspection-panel" aria-label="GitLab MR 변경 파일" aria-busy={view.kind === 'loading'}>
      {view.kind === 'loading' && <p role="status">GitLab 변경 파일을 확인하고 있습니다.</p>}
      {view.kind === 'stale' && <p role="status">MR이 변경되었습니다. 변경 파일을 다시 확인해 주세요.</p>}
      {view.kind === 'failed' && <p className="gitlab-activity-inspection-warning" role="alert">{view.message}</p>}
      {view.kind === 'ready' && <>
        <p className="gitlab-activity-inspection-meta">조회한 파일 {view.result.files.length}개 · <time dateTime={view.result.checkedAt}>
          {new Date(view.result.checkedAt).toLocaleString('ko-KR')}
        </time></p>
        {view.result.files.length ? <ul className="gitlab-changed-file-list" role="list" aria-label="변경 파일" tabIndex={0}>
          {view.result.files.map(file => <li key={JSON.stringify([file.oldPath, file.newPath])} className="gitlab-changed-file">
            <div className="gitlab-activity-inspection-meta">
              <strong>{fileChangeLabels[file.change]}</strong>
              {file.generated && <span>생성된 파일</span>}
              {file.diffLimited && <span>변경 내용 표시 제한</span>}
            </div>
            <div className="gitlab-activity-inspection-meta">
              {file.change === 'renamed' && <><code>{file.oldPath}</code><span>→</span></>}
              <code>{file.change === 'deleted' ? file.oldPath : file.newPath}</code>
            </div>
          </li>)}
        </ul> : <p>조회한 변경 파일이 없습니다.</p>}
        {view.result.hasMore && <p>조회 범위가 제한되었습니다. 나머지 파일은 GitLab에서 확인해 주세요.</p>}
      </>}
      <div className="gitlab-discussion-actions">
        <button type="button" className="btn btn-ghost" aria-disabled={view.kind === 'loading'} onClick={() => void load()}>
          <RefreshCw aria-hidden="true" size={14} />변경 파일 다시 확인
        </button>
        <a className="gitlab-discussion-link" href={changesUrl.href} target="_blank" rel="noopener noreferrer">
          GitLab에서 변경 열기 <ExternalLink aria-hidden="true" size={13} />
        </a>
      </div>
    </section>}
  </div>;
}

function MergeReadiness({ value }: { value?: GitlabMergeReadiness }) {
  const state = value?.state ?? 'unknown';
  const tone = isGitlabMergeReadinessBlocked(state) ? 'blocked' : state === 'ready' ? 'ready' : 'neutral';
  return <span className="gitlab-merge-readiness" role="group" aria-label="MR 병합 확인">
    <span className="gitlab-merge-badge" data-tone={tone}>{GITLAB_MERGE_READINESS_LABELS[state]}</span>
    {value && <span className="gitlab-merge-observed">
      {value.source === 'read' ? 'GitLab 조회' : 'GitLab 웹훅'} · <time dateTime={value.observedAt}>
        {new Date(value.observedAt).toLocaleString('ko-KR')}
      </time>
    </span>}
  </span>;
}

export function GitlabActivityRefresh({ refresh, notify, disabled }: Pick<FeatureProps, 'refresh' | 'notify'> & { disabled?: boolean }) {
  const [busy, setBusy] = useState(false);

  async function reload() {
    setBusy(true);
    try {
      await refresh();
      notify('GitLab 활동을 새로 불러왔습니다.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'GitLab 활동을 불러오지 못했습니다.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return <button className="btn btn-ghost gitlab-activity-refresh" type="button" aria-label="GitLab 활동 새로고침" disabled={busy || disabled} onClick={reload}>
    <RefreshCw aria-hidden="true" size={15} />{busy ? '불러오는 중…' : '새로고침'}
  </button>;
}

type IssueContext = { keys: ReadonlyMap<string, string>; openIssue: (link: GitlabLink, opener: HTMLButtonElement, selectActivity?: boolean) => void };
type ActivityIssueReview = { keys: IssueContext['keys']; openIssue: OpenIssueForReview; fallbackRef: RefObject<HTMLElement | null> };
type ActivityPagination = { pages: GitlabActivityFilters['pages']; onChangePage: (kind: GitlabLink['kind'], page: number) => void };
type ActivitySelection = { link: GitlabLink; rowRef: RefObject<HTMLLIElement | null> };
export type GitlabCheckedActivity = { linkId: string; kind: GitlabLink['kind']; triggerRef: RefObject<HTMLButtonElement | null> };
type ManualLinkActions = {
  disabled: boolean;
  verify: (link: GitlabLink, trigger: HTMLButtonElement) => void;
  unlink: (link: GitlabLink, trigger: HTMLButtonElement) => void;
  hasMergeRequest: (branch: GitlabLink, mr: BranchMergeRequest) => boolean;
  attachMergeRequest: (branch: GitlabLink, mr: BranchMergeRequest, branchRevision: string) => Promise<void>;
  findMergeRequestPipeline: (mr: GitlabLink, pipeline: MergeRequestObservedPipeline) => GitlabLink | undefined;
  attachMergeRequestPipeline: (mr: GitlabLink, pipeline: MergeRequestObservedPipeline, revision: string) => Promise<void>;
};
export type GitlabActivityStatusActions = {
  disabled?: boolean;
  refreshingLinkId?: string | null;
  reviewingLinkId?: string | null;
  checkStatus: (link: GitlabLink, trigger: HTMLButtonElement) => void;
  reviewStatus?: (link: GitlabLink, trigger: HTMLButtonElement) => void;
};
export type GitlabActivityCommentActions = {
  disabled?: boolean;
  add: (reference: { href: string; body: string }) => void;
};

export function GitlabActivityList({ links, issueReview, issueVersions, heading = 'h4', manualActions, statusActions, commentActions, pagination, selection, onCopyActivityLink, checkedActivity }: {
  links: readonly GitlabLink[]; issueReview?: ActivityIssueReview; issueVersions?: ReadonlyMap<string, number>;
  heading?: 'h3' | 'h4'; manualActions?: ManualLinkActions; statusActions?: GitlabActivityStatusActions; pagination?: ActivityPagination;
  selection?: ActivitySelection;
  checkedActivity?: GitlabCheckedActivity;
  commentActions?: GitlabActivityCommentActions;
  onCopyActivityLink?: (linkId: string) => void;
}) {
  const sharedPages = pagination !== undefined;
  const groups = useMemo(() => kinds.map(group => ({ group,
    rows: links.filter(link => link.kind === group.kind).sort((a, b) =>
      activityTime(b.updatedAt) - activityTime(a.updatedAt) || (sharedPages ? a.id.localeCompare(b.id, 'en') : 0)),
  })), [links, sharedPages]);
  const issueContext: IssueContext | undefined = issueReview && {
    keys: issueReview.keys,
    openIssue({ id, issueId, projectId, kind, iid, manualLinkId }, opener, selectActivity = false) {
      const issueIds = [...new Set(groups.flatMap(({ rows }) => rows.map(link => link.issueId)))];
      issueReview.openIssue(issueId, { issueIds, opener, fallback: issueReview.fallbackRef.current,
        gitlabActivity: { link: { id, issueId, projectId, kind, iid, manualLinkId }, selectActivity } });
    },
  };
  return <div className="gitlab-activity-list">{groups.map(({ group, rows }) => rows.length > 0 &&
    <ActivityGroup key={group.kind} group={group} links={rows} issueContext={issueContext} issueVersions={issueVersions}
      heading={heading} manualActions={manualActions} statusActions={statusActions} commentActions={commentActions} pagination={pagination} onCopyActivityLink={onCopyActivityLink}
      checkedActivity={checkedActivity?.kind === group.kind ? checkedActivity : undefined}
      selection={selection?.link.kind === group.kind ? selection : undefined} />)}</div>;
}

function ActivityGroup({ group, links, issueContext, issueVersions, heading: Heading, manualActions, statusActions, commentActions, pagination, selection, onCopyActivityLink, checkedActivity }: {
  group: typeof kinds[number]; links: GitlabLink[]; issueContext?: IssueContext; issueVersions?: ReadonlyMap<string, number>;
  heading: 'h3' | 'h4'; manualActions?: ManualLinkActions; statusActions?: GitlabActivityStatusActions; pagination?: ActivityPagination;
  selection?: ActivitySelection;
  checkedActivity?: GitlabCheckedActivity;
  commentActions?: GitlabActivityCommentActions;
  onCopyActivityLink?: (linkId: string) => void;
}) {
  const [localPage, setLocalPage] = useState<{ page: number; checkedActivity?: GitlabCheckedActivity }>();
  if (checkedActivity && checkedActivity !== localPage?.checkedActivity) {
    const index = links.findIndex(link => link.id === checkedActivity.linkId);
    if (index !== -1) setLocalPage({ page: Math.floor(index / PAGE_SIZE) + 1, checkedActivity });
  }
  const pageCount = Math.ceil(links.length / PAGE_SIZE);
  const selectedIndex = selection && localPage === undefined ? links.indexOf(selection.link) : 0;
  const selectedPage = Math.floor(Math.max(0, selectedIndex) / PAGE_SIZE) + 1;
  const currentPage = Math.min(pagination ? pagination.pages[group.kind] ?? 1 : localPage?.page ?? selectedPage, pageCount);
  const offset = (currentPage - 1) * PAGE_SIZE;
  const Icon = group.Icon;
  function changePage(page: number) {
    if (pagination) pagination.onChangePage(group.kind, page);
    else setLocalPage({ page, checkedActivity });
  }

  return <section className="gitlab-activity-group" aria-label={group.label}>
    <Heading className="gitlab-activity-group-heading"><Icon aria-hidden="true" size={15} />{group.label} <span>{links.length}</span></Heading>
    <ul className="gitlab-activity-rows">{links.slice(offset, offset + PAGE_SIZE).map(link => <ActivityRow key={link.id} link={link} issueContext={issueContext}
      issueVersion={issueVersions?.get(link.issueId)} manualActions={manualActions} statusActions={statusActions} commentActions={commentActions} onCopyActivityLink={onCopyActivityLink}
      checkedActivityTrigger={checkedActivity?.linkId === link.id ? checkedActivity.triggerRef : undefined}
      selectedRowRef={selection?.link === link ? selection.rowRef : undefined} />)}</ul>
    {pageCount > 1 && <nav className="gitlab-activity-pages" aria-label={`${group.label} 페이지 이동`}>
      <button className="btn btn-ghost" type="button" disabled={currentPage === 1} onClick={() => changePage(currentPage - 1)}>이전</button>
      <span role="status">{currentPage} / {pageCount} 페이지</span>
      <button className="btn btn-ghost" type="button" disabled={currentPage === pageCount} onClick={() => changePage(currentPage + 1)}>다음</button>
    </nav>}
  </section>;
}

function savedActivityCommentUrl(link: GitlabLink, url: URL | null): string | undefined {
  if (!url) return undefined;
  const canonical = normalizeGitlabSearchInput(url.href);
  if (!canonical || !matchingGitlabSearchLinks([link], canonical).has(link.issueId)) return undefined;
  const safePath = canonical.replaceAll("'", '%27');
  return commentWebUrl(link.kind === 'branch' ? `${safePath}?ref_type=heads` : safePath);
}

function ActivityRow({ link, issueContext, issueVersion, manualActions, statusActions, commentActions, selectedRowRef, onCopyActivityLink, checkedActivityTrigger }: {
  link: GitlabLink; issueContext?: IssueContext; issueVersion?: number; manualActions?: ManualLinkActions; statusActions?: GitlabActivityStatusActions;
  selectedRowRef?: RefObject<HTMLLIElement | null>;
  checkedActivityTrigger?: RefObject<HTMLButtonElement | null>;
  commentActions?: GitlabActivityCommentActions;
  onCopyActivityLink?: (linkId: string) => void;
}) {
  const selectedLabelId = useId();
  const url = gitlabActivityUrl(link.webUrl, link.kind);
  const pipeline = pipelineTarget(link, url);
  const pipelineRevision = JSON.stringify([link.state, link.updatedAt, link.pipelineObservedAt, link.sourceBranch, link.sourceSha]);
  const mr = mergeRequestTarget(link, url);
  const branchTarget = branchMergeRequestTarget(link, url);
  const deleted = link.kind === 'branch' && link.state === 'deleted';
  const legacyCommitId = link.kind === 'commit' ? url?.pathname.match(/\/commit\/([^/]+)\/?$/)?.[1] : null;
  const sha = gitlabObjectSha(link.sourceSha) ?? gitlabObjectSha(legacyCommitId);
  const branch = typeof link.sourceBranch === 'string' ? link.sourceBranch : '';
  const branchHeadLabel = deleted ? '삭제 전 HEAD' : link.branchObservationSource === 'read' ? 'GitLab에서 확인한 HEAD' : '확인한 HEAD';
  const title = (link.kind === 'branch' && branch) || (typeof link.title === 'string' && link.title) || '이름 없음';
  const hasNumber = Number.isSafeInteger(link.iid) && link.iid > 0;
  const number = hasNumber && link.kind === 'merge_request' ? `!${link.iid}` : hasNumber && link.kind === 'pipeline' ? `#${link.iid}` : null;
  const state = typeof link.state === 'string' && link.state ? link.state : 'unknown';
  const pipelineSource = link.kind === 'pipeline' ? gitlabPipelineSourceLabel(link.pipelineSource, link.pipelineTag) : null;
  const issueKey = issueContext?.keys.get(link.issueId);
  const statusCheck = link.kind === 'pipeline' || link.kind === 'merge_request' || (link.kind === 'branch' && state === 'active') ? statusActions : undefined;
  const reviewStatus = link.kind === 'pipeline' || link.kind === 'merge_request' ? statusActions?.reviewStatus : undefined;
  const statusActionDisabled = statusCheck?.disabled || Boolean(statusCheck?.refreshingLinkId || statusCheck?.reviewingLinkId);
  const refreshing = statusCheck?.refreshingLinkId === link.id;
  const reviewing = statusCheck?.reviewingLinkId === link.id;
  const manual = link.manualLinkId ? manualActions : undefined;
  const commentUrl = commentActions && savedActivityCommentUrl(link, url);
  const titleContent = <>
    {number && <span className="gitlab-activity-number">{number}</span>}
    {link.kind === 'commit' && sha && <code title={sha}>{sha.slice(0, 8)}</code>}
    <strong>{title}</strong>
  </>;

  return <li className="gitlab-activity-row" data-gitlab-link-id={link.id} data-gitlab-kind={link.kind} data-gitlab-state={state}
    ref={selectedRowRef} tabIndex={selectedRowRef ? -1 : undefined} data-gitlab-selected={selectedRowRef ? '' : undefined}
    aria-describedby={selectedRowRef ? selectedLabelId : undefined}>
    <div className="gitlab-activity-body">
      {selectedRowRef && <span id={selectedLabelId} className="gitlab-activity-detail gitlab-activity-selection">선택한 GitLab 활동</span>}
      {url && !deleted
        ? <a className="gitlab-activity-target" href={url.href} target="_blank" rel="noreferrer">
            {titleContent}<ExternalLink aria-hidden="true" size={14} /><span className="sr-only">GitLab에서 새 탭으로 열기</span>
          </a>
        : <div className="gitlab-activity-target">{titleContent}</div>}
      {link.kind === 'branch' && sha && <span className="gitlab-activity-detail">{branchHeadLabel} <code title={sha}>{sha.slice(0, 8)}</code></span>}
      {link.kind === 'commit' && branch && <span className="gitlab-activity-detail">{branch}</span>}
      {link.kind === 'merge_request' && state === 'opened' && <MergeReadiness value={link.mergeReadiness} />}
      {link.originalJiraKey && <span className="gitlab-activity-detail">원본 Jira 키 <code>{link.originalJiraKey}</code></span>}
      {link.manualLinkId && <span className="gitlab-activity-detail gitlab-activity-manual-label">수동 연결</span>}
      {issueKey && issueContext && <button className="text-link gitlab-activity-issue" type="button"
        data-gitlab-review-opener="issue"
        onClick={event => issueContext.openIssue(link, event.currentTarget)}>{issueKey}</button>}
    </div>
    <div className="gitlab-activity-status">
      <span className="gitlab-activity-state">{gitlabActivityStateLabel(state)}</span>
      {pipelineSource && <span className="gitlab-activity-source">{pipelineSource}</span>}
    </div>
    {branchTarget && <BranchMergeRequests key={`${link.id}:${link.manualLinkId ?? ''}:${link.webUrl}`} branch={link} target={branchTarget} manualActions={manualActions}
      revision={JSON.stringify([link.state, link.updatedAt, link.sourceBranch, link.sourceSha, issueVersion])} />}
    {pipeline && <>
      <PipelineJobs key={`jobs:${link.id}:${link.manualLinkId ?? ''}:${pipeline.url.href}`} target={pipeline} revision={pipelineRevision} />
      <PipelineTestReport key={`tests:${link.id}:${link.manualLinkId ?? ''}:${pipeline.url.href}`} target={pipeline} revision={pipelineRevision} />
    </>}
    {mr && <MergeRequestPipeline key={`mr-pipeline:${link.id}:${link.manualLinkId ?? ''}:${mr.url.href}`} target={mr}
      mr={link} manualActions={manualActions} reviewStatus={reviewStatus}
      revision={JSON.stringify([link.state, link.updatedAt, link.sourceBranch, link.sourceSha, link.mergeCommitShas, manualActions ? issueVersion : null])} />}
    {mr && <MergeRequestChangedFiles key={`mr-files:${link.id}:${link.manualLinkId ?? ''}:${mr.url.href}`} target={mr}
      revision={JSON.stringify([link.state, link.updatedAt, link.sourceBranch, link.sourceSha, link.mergeCommitShas])} />}
    {mr && state === 'opened' && <MergeRequestReview key={`${link.id}:${link.manualLinkId ?? ''}:${mr.url.href}`} target={mr}
      directDiscussions={link.mergeReadiness?.state === 'discussions_unresolved'}
      revision={JSON.stringify([link.state, link.updatedAt, link.sourceBranch, link.sourceSha, link.mergeReadiness?.state,
        link.mergeReadiness?.observedAt, link.mergeReadiness?.source])} />}
    {(issueKey || statusCheck || manual || onCopyActivityLink || commentUrl) && <div className="gitlab-activity-row-actions">
      {issueKey && issueContext && <button className="btn btn-ghost" type="button"
        data-gitlab-review-opener="activity"
        onClick={event => issueContext.openIssue(link, event.currentTarget, true)}>
        <ArrowRight size={14} aria-hidden="true" />티켓에서 이 활동 보기
      </button>}
      {onCopyActivityLink && <button className="btn btn-ghost" type="button" onClick={() => onCopyActivityLink(link.id)}>
        <Link2 size={14} aria-hidden="true" />티켓 활동 링크 복사
      </button>}
      {commentActions && commentUrl && <button className="btn btn-ghost" type="button" disabled={commentActions.disabled}
        onClick={() => {
          const caption = title.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, 200).toWellFormed();
          const activity = [`GitLab ${gitlabActivityKindLabel(link.kind)}`, number, link.kind === 'commit' && sha ? sha.slice(0, 8) : null]
            .filter(Boolean).join(' ');
          const summary = [activity, `저장 상태 ${states.get(state) ?? '미확인'}`, caption].filter(Boolean).join(' · ');
          commentActions.add({ href: commentUrl, body: `${summary}\n<${commentUrl}>` });
        }}><MessageSquarePlus size={14} aria-hidden="true" />댓글 초안에 추가</button>}
      {statusCheck && <button ref={checkedActivityTrigger} className="btn btn-ghost" type="button" aria-label="이 GitLab 활동 상태 확인"
        disabled={statusActionDisabled} aria-busy={refreshing || undefined}
        onClick={event => statusCheck.checkStatus(link, event.currentTarget)}>
        <RefreshCw size={14} aria-hidden="true" />{refreshing ? '확인 중…' : '상태 확인'}
      </button>}
      {reviewStatus && <button className="btn btn-ghost" type="button" aria-label="이 활동으로 상태 검토"
        disabled={statusActionDisabled} aria-busy={reviewing || undefined}
        onClick={event => reviewStatus(link, event.currentTarget)}>
        <ClipboardCheck size={14} aria-hidden="true" />{reviewing ? '검토 중…' : '이 활동으로 상태 검토'}
      </button>}
      {manual && <>
        <button className="btn btn-ghost" type="button" aria-label="수동 연결 다시 확인" title="수동 연결 다시 확인"
          disabled={manual.disabled} onClick={event => manual.verify(link, event.currentTarget)}>
          <RefreshCw size={14} aria-hidden="true" />다시 확인
        </button>
        <button className="btn btn-ghost" type="button" aria-label="수동 연결 해제" title="수동 연결 해제"
          disabled={manual.disabled} onClick={event => manual.unlink(link, event.currentTarget)}>
          <Unlink2 size={14} aria-hidden="true" />연결 해제
        </button>
      </>}
    </div>}
  </li>;
}
