'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ExternalLink, GitBranch, GitCommitHorizontal, GitMerge, Workflow, RefreshCw, Unlink2 } from 'lucide-react';
import { gitlabObjectSha } from '../../shared/gitlab-links';
import { isGitlabMergeReadinessBlocked } from '../../shared/gitlab-merge-readiness';
import { gitlabPipelineSourceLabel } from '../../shared/gitlab-pipeline-source';
import type { FeatureProps, GitlabLink, GitlabMergeReadiness, GitlabMergeRequestReview, GitlabPipelineJob, GitlabPipelineJobs } from '../../shared/types';
import { api, ApiError } from '../lib/api';
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
  ['success', '성공'], ['failed', '실패'], ['canceled', '취소됨'],
  ['cancelled', '취소됨'], ['skipped', '건너뜀'], ['manual', '수동 실행'],
  ['scheduled', '예약됨'], ['unknown', '미확인'],
]);
const PAGE_SIZE = 12;
const readinessLabels = {
  ready: '병합 가능',
  checking: '병합 상태 검사 중',
  draft: '초안',
  conflict: '충돌 해결 필요',
  approval_required: '승인 대기',
  changes_requested: '수정 요청',
  discussions_unresolved: '미해결 토론',
  ci_required: '파이프라인 통과 필요',
  ci_running: '파이프라인 실행 중',
  rebase_required: '리베이스 필요',
  dependency: '선행 병합 요청 대기',
  policy: '정책 또는 상태 검사 확인',
  blocked: '병합 차단',
  unknown: '병합 상태 미확인',
} satisfies Record<GitlabMergeReadiness['state'], string>;

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

function activityTime(value: unknown) {
  return typeof value === 'string' ? Date.parse(value) || 0 : 0;
}

type JobTarget = { linkId: string; issueId: string; repositoryId: number; pipelineId: number; url: URL };
type ReviewTarget = { linkId: string; issueId: string; repositoryId: number; mergeRequestIid: number; url: URL };
type ActivityLookup<Value> = { kind: 'loading' } | { kind: 'stale' } | { kind: 'failed'; message: string } | { kind: 'ready'; result: Value };
type ReviewPerson = GitlabMergeRequestReview['reviewers'][number];

const reviewStateLabels = {
  unreviewed: '검토 전', review_started: '검토 중', reviewed: '검토 완료', requested_changes: '수정 요청',
  approved: '승인', unapproved: '승인 철회', unknown: '상태 미확인',
} satisfies Record<ReviewPerson['state'], string>;

function mergeRequestReviewTarget(link: GitlabLink, url: URL | null): ReviewTarget | null {
  if (link.kind !== 'merge_request' || link.state !== 'opened' || !url || !link.issueId) return null;
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

function pipelineJobsTarget(link: GitlabLink, url: URL | null): JobTarget | null {
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

function isPipelineJobsResult(result: GitlabPipelineJobs | undefined, target: JobTarget): result is GitlabPipelineJobs {
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

function pipelineJobUrl(job: GitlabPipelineJob, target: JobTarget): URL | null {
  const url = gitlabActivityUrl(job.webUrl, 'pipeline');
  const suffix = `/-/jobs/${job.id}`;
  return url && url.origin === target.url.origin && !url.search && !url.hash && url.pathname.length > suffix.length &&
    url.pathname.endsWith(suffix) ? url : null;
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

function useActivityLookup<Value>(revision: string, read: (signal: AbortSignal) => Promise<Value | null>,
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

  async function load() {
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
      const result = await read(controller.signal);
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

function PipelineJobs({ target, revision }: { target: JobTarget; revision: string }) {
  const panelId = useId();
  const { view, toggle, load } = useActivityLookup(revision, async signal => {
    const path = `/issues/${encodeURIComponent(target.issueId)}/gitlab-links/${encodeURIComponent(target.linkId)}/pipeline-jobs`;
    const result = await api<GitlabPipelineJobs | undefined>(path, { method: 'GET', cache: 'no-store', signal });
    return isPipelineJobsResult(result, target) ? result : null;
  }, '연결된 파이프라인의 CI 작업 응답을 확인할 수 없습니다.', pipelineJobsMessage);

  return <div className="gitlab-activity-inspection">
    <button className="btn btn-ghost" type="button" aria-expanded={Boolean(view)} aria-controls={view ? panelId : undefined} onClick={toggle}>
      <Workflow aria-hidden="true" size={14} />{view ? 'CI 작업 닫기' : 'CI 작업 확인'}
    </button>
    {view && <section id={panelId} className="gitlab-activity-inspection-panel" aria-label="GitLab CI 작업" aria-busy={view.kind === 'loading'}>
      {view.kind === 'loading' && <p role="status">GitLab CI 작업을 확인하고 있습니다.</p>}
      {view.kind === 'stale' && <p role="status">파이프라인이 변경되었습니다. CI 작업을 다시 확인해 주세요.</p>}
      {view.kind === 'failed' && <p className="gitlab-activity-inspection-warning" role="alert">{view.message}</p>}
      {view.kind === 'ready' && <PipelineJobsResult result={view.result} target={target} />}
      <button type="button" className="btn btn-ghost" aria-disabled={view.kind === 'loading'} onClick={() => void load()}>
        <RefreshCw aria-hidden="true" size={14} />CI 작업 다시 확인
      </button>
    </section>}
  </div>;
}

function PipelineJobsResult({ result, target }: { result: GitlabPipelineJobs; target: JobTarget }) {
  return <>
    <p className="gitlab-activity-inspection-meta" role="status">파이프라인 상태 <strong>{gitlabActivityStateLabel(result.status)}</strong>
      <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString('ko-KR')}</time>
    </p>
    {result.configurationError && <p className="gitlab-activity-inspection-warning">GitLab에서 파이프라인 설정 오류를 보고했습니다.</p>}
    {result.jobs.length === 0 ? <p>조회한 CI 작업 중 실패 또는 수동 대기 상태가 없습니다.</p> :
      <ul className="gitlab-pipeline-job-list" aria-label="실패 및 수동 실행 작업">{result.jobs.map(job => {
        const href = pipelineJobUrl(job, target);
        const reason = job.failureReason && (failureReasonLabels.get(job.failureReason) ?? job.failureReason);
        return <li className="gitlab-pipeline-job" key={job.id}>
          {href ? <a className="gitlab-pipeline-job-link" href={href.href} target="_blank" rel="noopener noreferrer">
            <strong>{job.name}</strong><ExternalLink aria-hidden="true" size={13} />
          </a> : <strong>{job.name}</strong>}
          <div className="gitlab-activity-inspection-meta">
            <span className="gitlab-pipeline-job-state" data-state={job.status}>{gitlabActivityStateLabel(job.status)}</span>
            <span>{job.stage}</span>
            <span>{job.allowFailure ? '실패 허용' : '성공 필요'}</span>
            {reason && <span>{reason}</span>}
          </div>
        </li>;
      })}</ul>}
    {result.hasMore && <p>조회 한도를 넘은 작업은 <a href={target.url.href} target="_blank" rel="noopener noreferrer">GitLab</a>에서 확인하세요.</p>}
  </>;
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

function MergeRequestReview({ target, revision }: { target: ReviewTarget; revision: string }) {
  const panelId = useId();
  const { view, toggle, load } = useActivityLookup(revision, async signal => {
    const path = `/issues/${encodeURIComponent(target.issueId)}/gitlab-links/${encodeURIComponent(target.linkId)}/merge-request-review`;
    const result = await api<GitlabMergeRequestReview | undefined>(path, { method: 'GET', cache: 'no-store', signal });
    return isReviewResult(result, target) ? result : null;
  }, '연결된 MR의 검토 정보 응답을 확인할 수 없습니다.', mergeRequestReviewMessage);

  return <div className="gitlab-activity-inspection">
    <button className="btn btn-ghost" type="button" aria-expanded={Boolean(view)} aria-controls={view ? panelId : undefined} onClick={toggle}>
      <GitMerge aria-hidden="true" size={14} />{view ? 'MR 검토 닫기' : 'MR 검토 확인'}
    </button>
    {view && <section id={panelId} className="gitlab-activity-inspection-panel" aria-label="GitLab MR 검토" aria-busy={view.kind === 'loading'}>
      {view.kind === 'loading' && <p role="status">GitLab MR 검토 정보를 확인하고 있습니다.</p>}
      {view.kind === 'stale' && <p role="status">MR이 변경되었습니다. 검토 정보를 다시 확인해 주세요.</p>}
      {view.kind === 'failed' && <p className="gitlab-activity-inspection-warning" role="alert">{view.message}</p>}
      {view.kind === 'ready' && <MergeRequestReviewResult result={view.result} url={target.url} />}
      <button type="button" className="btn btn-ghost" aria-disabled={view.kind === 'loading'} onClick={() => void load()}>
        <RefreshCw aria-hidden="true" size={14} />MR 검토 다시 확인
      </button>
    </section>}
  </div>;
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

function MergeReadiness({ value }: { value?: GitlabMergeReadiness }) {
  const state = value?.state ?? 'unknown';
  const tone = isGitlabMergeReadinessBlocked(state) ? 'blocked' : state === 'ready' ? 'ready' : 'neutral';
  return <span className="gitlab-merge-readiness" role="group" aria-label="MR 병합 확인">
    <span className="gitlab-merge-badge" data-tone={tone}>{readinessLabels[state]}</span>
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

type IssueContext = { keys: ReadonlyMap<string, string>; openIssue: FeatureProps['openIssue'] };
type ManualLinkActions = {
  disabled: boolean;
  verify: (link: GitlabLink, trigger: HTMLButtonElement) => void;
  unlink: (link: GitlabLink, trigger: HTMLButtonElement) => void;
};

export function GitlabActivityList({ links, issueContext, heading = 'h4', manualActions }: {
  links: readonly GitlabLink[]; issueContext?: IssueContext; heading?: 'h3' | 'h4'; manualActions?: ManualLinkActions;
}) {
  return <div className="gitlab-activity-list">{kinds.map(group => {
    const rows = links.filter(link => link.kind === group.kind).sort((a, b) => activityTime(b.updatedAt) - activityTime(a.updatedAt));
    return rows.length > 0 && <ActivityGroup key={group.kind} group={group} links={rows} issueContext={issueContext} heading={heading} manualActions={manualActions} />;
  })}</div>;
}

function ActivityGroup({ group, links, issueContext, heading: Heading, manualActions }: {
  group: typeof kinds[number]; links: GitlabLink[]; issueContext?: IssueContext; heading: 'h3' | 'h4'; manualActions?: ManualLinkActions;
}) {
  const [page, setPage] = useState(0);
  const pageCount = Math.ceil(links.length / PAGE_SIZE);
  const currentPage = Math.min(page, pageCount - 1);
  const offset = currentPage * PAGE_SIZE;
  const Icon = group.Icon;

  return <section className="gitlab-activity-group" aria-label={group.label}>
    <Heading className="gitlab-activity-group-heading"><Icon aria-hidden="true" size={15} />{group.label} <span>{links.length}</span></Heading>
    <ul className="gitlab-activity-rows">{links.slice(offset, offset + PAGE_SIZE).map(link => <ActivityRow key={link.id} link={link} issueContext={issueContext} manualActions={manualActions} />)}</ul>
    {pageCount > 1 && <nav className="gitlab-activity-pages" aria-label={`${group.label} 페이지 이동`}>
      <button className="btn btn-ghost" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>이전</button>
      <span role="status">{currentPage + 1} / {pageCount} 페이지</span>
      <button className="btn btn-ghost" type="button" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>다음</button>
    </nav>}
  </section>;
}

function ActivityRow({ link, issueContext, manualActions }: { link: GitlabLink; issueContext?: IssueContext; manualActions?: ManualLinkActions }) {
  const url = gitlabActivityUrl(link.webUrl, link.kind);
  const jobsTarget = pipelineJobsTarget(link, url);
  const reviewTarget = mergeRequestReviewTarget(link, url);
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
  const titleContent = <>
    {number && <span className="gitlab-activity-number">{number}</span>}
    {link.kind === 'commit' && sha && <code title={sha}>{sha.slice(0, 8)}</code>}
    <strong>{title}</strong>
  </>;

  return <li className="gitlab-activity-row" data-gitlab-kind={link.kind} data-gitlab-state={state}>
    <div className="gitlab-activity-body">
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
      {issueKey && issueContext && <button className="text-link gitlab-activity-issue" type="button" onClick={() => issueContext.openIssue(link.issueId)}>{issueKey}</button>}
    </div>
    <div className="gitlab-activity-status">
      <span className="gitlab-activity-state">{gitlabActivityStateLabel(state)}</span>
      {pipelineSource && <span className="gitlab-activity-source">{pipelineSource}</span>}
    </div>
    {jobsTarget && <PipelineJobs key={`${link.id}:${link.manualLinkId ?? ''}:${jobsTarget.url.href}`} target={jobsTarget}
      revision={JSON.stringify([link.state, link.updatedAt, link.sourceBranch, link.sourceSha])} />}
    {reviewTarget && <MergeRequestReview key={`${link.id}:${link.manualLinkId ?? ''}:${reviewTarget.url.href}`} target={reviewTarget}
      revision={JSON.stringify([link.state, link.updatedAt, link.sourceBranch, link.sourceSha, link.mergeReadiness?.state,
        link.mergeReadiness?.observedAt, link.mergeReadiness?.source])} />}
    {link.manualLinkId && manualActions && <div className="gitlab-activity-manual-actions">
      <button className="btn btn-ghost" type="button" aria-label="수동 연결 다시 확인" title="수동 연결 다시 확인"
        disabled={manualActions.disabled} onClick={event => manualActions.verify(link, event.currentTarget)}>
        <RefreshCw size={14} aria-hidden="true" />다시 확인
      </button>
      <button className="btn btn-ghost" type="button" aria-label="수동 연결 해제" title="수동 연결 해제"
        disabled={manualActions.disabled} onClick={event => manualActions.unlink(link, event.currentTarget)}>
        <Unlink2 size={14} aria-hidden="true" />연결 해제
      </button>
    </div>}
  </li>;
}
