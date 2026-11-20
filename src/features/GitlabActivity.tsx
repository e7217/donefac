'use client';

import { useState } from 'react';
import { ExternalLink, GitBranch, GitCommitHorizontal, GitMerge, Workflow, RefreshCw, Unlink2 } from 'lucide-react';
import { gitlabObjectSha } from '../../shared/gitlab-links';
import { isGitlabMergeReadinessBlocked } from '../../shared/gitlab-merge-readiness';
import type { FeatureProps, GitlabLink, GitlabMergeReadiness } from '../../shared/types';
import './gitlab-activity.css';

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

export function gitlabActivityUrl(webUrl: unknown): URL | null {
  if (typeof webUrl !== 'string') return null;
  try {
    const url = new URL(webUrl);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url : null;
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
  const url = gitlabActivityUrl(link.webUrl);
  const deleted = link.kind === 'branch' && link.state === 'deleted';
  const legacyCommitId = link.kind === 'commit' ? url?.pathname.match(/\/commit\/([^/]+)\/?$/)?.[1] : null;
  const sha = gitlabObjectSha(link.sourceSha) ?? gitlabObjectSha(legacyCommitId);
  const branch = typeof link.sourceBranch === 'string' ? link.sourceBranch : '';
  const title = (link.kind === 'branch' && branch) || (typeof link.title === 'string' && link.title) || '이름 없음';
  const hasNumber = Number.isSafeInteger(link.iid) && link.iid > 0;
  const number = hasNumber && link.kind === 'merge_request' ? `!${link.iid}` : hasNumber && link.kind === 'pipeline' ? `#${link.iid}` : null;
  const state = typeof link.state === 'string' && link.state ? link.state : 'unknown';
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
      {link.kind === 'branch' && sha && <span className="gitlab-activity-detail">{deleted ? '삭제 전 HEAD' : '확인한 HEAD'} <code title={sha}>{sha.slice(0, 8)}</code></span>}
      {link.kind === 'commit' && branch && <span className="gitlab-activity-detail">{branch}</span>}
      {link.kind === 'merge_request' && state === 'opened' && <MergeReadiness value={link.mergeReadiness} />}
      {link.originalJiraKey && <span className="gitlab-activity-detail">원본 Jira 키 <code>{link.originalJiraKey}</code></span>}
      {link.manualLinkId && <span className="gitlab-activity-detail gitlab-activity-manual-label">수동 연결</span>}
      {issueKey && issueContext && <button className="text-link gitlab-activity-issue" type="button" onClick={() => issueContext.openIssue(link.issueId)}>{issueKey}</button>}
    </div>
    <span className="gitlab-activity-state">{gitlabActivityStateLabel(state)}</span>
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
