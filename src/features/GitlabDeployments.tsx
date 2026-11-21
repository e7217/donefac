'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { ExternalLink, RefreshCw, Rocket } from 'lucide-react';
import { gitlabObjectSha } from '../../shared/gitlab-links';
import type { GitlabDeployment, GitlabDeploymentPage, GitlabLink, GitlabSettings } from '../../shared/types';
import { api } from '../lib/api';
import { gitlabActivityUrl } from './GitlabActivity';
import './gitlab-deployments.css';

const statusLabels: Record<GitlabDeployment['status'], string> = {
  blocked: '차단됨',
  running: '실행 중',
  success: '성공',
  failed: '실패',
  canceled: '취소됨',
};

const tierLabels: ReadonlyMap<string, string> = new Map([
  ['production', '프로덕션'], ['staging', '스테이징'], ['testing', '테스트'], ['development', '개발'], ['other', '기타'],
]);

type DeploymentRequest = { scope: string; offset: number };
type DeploymentResponse = { scope: string; request: DeploymentRequest; links?: readonly GitlabLink[] } &
  ({ page: GitlabDeploymentPage } | { error: string });

function deploymentSource({ jobUrl, projectUrl, sha }: GitlabDeployment) {
  const project = gitlabActivityUrl(projectUrl, 'commit');
  if (!project || project.search || project.hash) return null;
  const repositoryPath = project.pathname.replace(/\/+$/u, '');
  const job = gitlabActivityUrl(jobUrl, 'commit');
  const jobPrefix = `${repositoryPath}/-/jobs/`;
  if (job && job.origin === project.origin && !job.search && !job.hash && job.pathname.startsWith(jobPrefix) &&
      /^[1-9]\d*$/u.test(job.pathname.slice(jobPrefix.length))) {
    return { href: job.href, label: 'GitLab 작업 열기' };
  }
  const commit = gitlabObjectSha(sha);
  if (!commit) return null;
  project.pathname = `${repositoryPath}/-/commit/${commit}`;
  return { href: project.href, label: 'GitLab 커밋 열기' };
}

function DeploymentRow({ deployment, showRepository }: { deployment: GitlabDeployment; showRepository: boolean }) {
  const source = deploymentSource(deployment);
  const { deploymentId, environment, environmentTier, repositoryId, status, changedAt, sha } = deployment;
  const tier = environmentTier && environmentTier !== environment.toLowerCase() ? tierLabels.get(environmentTier) : undefined;
  return <li className="gitlab-deployment-row" data-deployment-id={deploymentId} data-deployment-status={status}>
    <div className="gitlab-deployment-title">
      <strong>{environment}</strong>
      {tier && <span className="gitlab-deployment-tier">{tier}</span>}
      <span className="gitlab-deployment-status">{statusLabels[status]}</span>
    </div>
    <div className="gitlab-deployment-meta">
      {showRepository && <span>저장소 #{repositoryId}</span>}
      <time dateTime={changedAt}>{new Date(changedAt).toLocaleString('ko-KR')}</time>
      <code title={sha}>{sha.slice(0, 12)}</code>
    </div>
    {source && <a className="gitlab-deployment-source" href={source.href} target="_blank" rel="noopener noreferrer">
      {source.label}<ExternalLink size={13} aria-hidden="true" />
    </a>}
  </li>;
}

function DeploymentHistory({ path, repositoryId, settingsVersion, links, heading, description, empty }: {
  path: string;
  repositoryId?: number;
  settingsVersion?: number;
  links?: readonly GitlabLink[];
  heading: ReactNode;
  description: string;
  empty: string;
}) {
  const scope = JSON.stringify([path, repositoryId, settingsVersion]);
  const [request, setRequest] = useState<DeploymentRequest>({ scope, offset: 0 });
  const [response, setResponse] = useState<DeploymentResponse | null>(null);
  const current = response?.scope === scope ? response : null;
  const pending = current?.request !== request || current.links !== links;
  const page = current && 'page' in current ? current.page : null;
  const error = !pending && current && 'error' in current ? current.error : '';
  const requestedOffset = request.scope === scope ? request.offset : 0;

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams(repositoryId === undefined ? {} : { repositoryId: String(repositoryId) });
    query.set('offset', String(requestedOffset));
    void api<GitlabDeploymentPage>(`${path}?${query}`, { cache: 'no-store', signal: controller.signal }).then(page => {
      if (!controller.signal.aborted) setResponse({ scope, request, links, page });
    }).catch(cause => {
      if (!controller.signal.aborted) {
        setResponse({ scope, request, links, error: cause instanceof Error ? cause.message : 'GitLab 배포 기록을 불러오지 못했습니다.' });
      }
    });
    return () => controller.abort();
  }, [path, repositoryId, request, requestedOffset, links, scope]);

  const previousOffset = page ? Math.max(0, page.offset - page.limit) : 0;
  const previousAvailable = Boolean(page?.offset);
  const nextAvailable = Boolean(page && page.offset + page.limit < page.total);
  function browse(offset: number) {
    if (!pending) setRequest({ scope, offset });
  }

  return <>
    <div className="gitlab-deployment-heading">
      {heading}
      <button className="btn btn-ghost" type="button" aria-disabled={pending} onClick={() => browse(0)}>
        <RefreshCw size={14} aria-hidden="true" />배포 새로고침
      </button>
    </div>
    <p className="gitlab-deployment-hint">{description}</p>
    {pending && <p className="gitlab-deployment-hint" role="status">배포 기록을 불러오는 중입니다.</p>}
    <div className="gitlab-deployment-results" aria-busy={pending}>
      {error && <p className="error-text" role="alert">{error}</p>}
      {page && page.items.length > 0 && <ul className="gitlab-deployment-list" role="list" aria-label="GitLab 배포 목록">
        {page.items.map(deployment => <DeploymentRow key={`${deployment.instance}:${deployment.repositoryId}:${deployment.deploymentId}`}
          deployment={deployment} showRepository={repositoryId === undefined} />)}
      </ul>}
      {!pending && page && page.items.length === 0 && <p className="gitlab-deployment-hint">{empty}</p>}
      {page && (previousAvailable || nextAvailable) && <nav className="gitlab-deployment-pages" aria-label="GitLab 배포 페이지">
        <button className="btn btn-ghost" type="button" aria-disabled={pending || !previousAvailable} onClick={() => { if (previousAvailable) browse(previousOffset); }}>이전 배포</button>
        <span>{page.items.length ? `${page.offset + 1}–${page.offset + page.items.length} / ${page.total}` : `0 / ${page.total}`}</span>
        <button className="btn btn-ghost" type="button" aria-disabled={pending || !nextAvailable} onClick={() => { if (nextAvailable) browse(page.offset + page.limit); }}>다음 배포</button>
      </nav>}
    </div>
  </>;
}

export function IssueGitlabDeployments({ issueId, links }: { issueId: string; links: readonly GitlabLink[] }) {
  const headingId = useId();
  return <section className="gitlab-deployments gitlab-deployments-issue" aria-labelledby={headingId}>
    <DeploymentHistory key={issueId} path={`/issues/${encodeURIComponent(issueId)}/gitlab-deployments`} links={links}
      heading={<h4 id={headingId}><Rocket size={16} aria-hidden="true" />연결된 GitLab 배포</h4>}
      description="업무와 같은 커밋 또는 MR의 병합 결과 커밋이 배포된 기록입니다."
      empty="이 업무에서 확인된 GitLab 배포가 없습니다." />
  </section>;
}

export function RepositoryGitlabDeployments({ settings }: { settings: GitlabSettings }) {
  const headingId = useId();
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<number>();
  const { projectIds, version, baseUrl } = settings;
  const repositoryId = selectedRepositoryId !== undefined && projectIds.includes(selectedRepositoryId) ? selectedRepositoryId : projectIds[0];
  if (!baseUrl || repositoryId === undefined) return null;
  return <section className="card gitlab-deployments" aria-labelledby={headingId}>
    <DeploymentHistory path="/integrations/gitlab/deployments" repositoryId={repositoryId} settingsVersion={version}
      heading={<><h2 id={headingId}><Rocket size={18} aria-hidden="true" />GitLab 배포 기록</h2>
        <label className="gitlab-deployment-repository">배포 저장소
          <select className="field" value={repositoryId} onChange={event => setSelectedRepositoryId(Number(event.target.value))}>
            {projectIds.map(id => <option key={id} value={id}>저장소 #{id}</option>)}
          </select>
        </label></>}
      description="선택한 저장소에서 배포 웹훅으로 받은 기록입니다."
      empty="이 저장소에서 수신한 GitLab 배포가 없습니다." />
  </section>;
}
