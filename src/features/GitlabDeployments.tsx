'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Download, ExternalLink, RefreshCw, Rocket } from 'lucide-react';
import { gitlabObjectSha } from '../../shared/gitlab-links';
import type { GitlabDeployment, GitlabDeploymentPage, GitlabDeploymentSyncResult, GitlabLink, GitlabSettings } from '../../shared/types';
import { api } from '../lib/api';
import { gitlabActivityUrl } from './GitlabActivity';
import './gitlab-deployments.css';

const statusLabels: Record<GitlabDeployment['status'], string> = {
  blocked: '차단됨',
  created: '대기 중',
  running: '실행 중',
  success: '성공',
  failed: '실패',
  canceled: '취소됨',
  skipped: '건너뜀',
};

const tierLabels: ReadonlyMap<string, string> = new Map([
  ['production', '프로덕션'], ['staging', '스테이징'], ['testing', '테스트'], ['development', '개발'], ['other', '기타'],
]);

type DeploymentRequest = { scope: string; offset: number };
type DeploymentResponse = { scope: string; request: DeploymentRequest; links?: readonly GitlabLink[] } &
  ({ page: GitlabDeploymentPage } | { error: string });
type SyncState = { pending: true } | { pending: false; result: GitlabDeploymentSyncResult } | { pending: false; error: string };

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
  const { deploymentId, environment, environmentTier, repositoryId, status, changedAt, sha, mergeRequests } = deployment;
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
      {deployment.source === 'sync' && <span>GitLab 동기화</span>}
      {mergeRequests && mergeRequests.length > 0 && <span>포함 MR {mergeRequests.length}개</span>}
    </div>
    {source && <a className="gitlab-deployment-source" href={source.href} target="_blank" rel="noopener noreferrer">
      {source.label}<ExternalLink size={13} aria-hidden="true" />
    </a>}
  </li>;
}

function DeploymentSync({ repositoryId, settingsVersion, refreshPage }: {
  repositoryId: number;
  settingsVersion: number;
  refreshPage: () => void;
}) {
  const [state, setState] = useState<SyncState | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);

  async function syncDeployments() {
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setState({ pending: true });
    try {
      const result = await api<GitlabDeploymentSyncResult>('/integrations/gitlab/deployments/sync', {
        method: 'POST',
        body: JSON.stringify({ repositoryId, expectedVersion: settingsVersion }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result?.repositoryId !== repositoryId || result.settingsVersion !== settingsVersion) {
        throw new Error('이 저장소의 배포 동기화 결과를 확인하지 못했습니다.');
      }
      setState({ pending: false, result });
      refreshPage();
    } catch (cause) {
      if (!controller.signal.aborted) {
        setState({ pending: false, error: cause instanceof Error ? cause.message : 'GitLab 배포 이력을 동기화하지 못했습니다.' });
      }
    } finally {
      activeRequest.current = null;
    }
  }

  const result = state && 'result' in state ? state.result : null;
  return <div className="gitlab-deployment-sync">
    <button className="btn" type="button" aria-disabled={state?.pending ?? false} onClick={() => void syncDeployments()}>
      <Download size={14} aria-hidden="true" />배포 이력 동기화
    </button>
    {state?.pending && <p className="gitlab-deployment-hint" role="status">GitLab에서 배포 이력을 읽고 있습니다.</p>}
    {state && 'error' in state && <p className="error-text" role="alert">{state.error}</p>}
    {result && <div className="gitlab-deployment-sync-report" role="status" aria-label="배포 이력 동기화 결과">
      <p>배포 {result.deploymentsRead}건 조회 · {result.deploymentsStored}건 반영 · 포함 MR {result.mergeRequestsStored}건 반영</p>
      {result.deploymentLimitReached && <p>배포 조회 한도에 도달했습니다.</p>}
      {result.associationUnavailable > 0 && <p>포함 MR을 조회하지 못한 배포 {result.associationUnavailable}건</p>}
      {result.associationLimited > 0 && <p>포함 MR 조회 한도에 도달한 배포 {result.associationLimited}건</p>}
    </div>}
  </div>;
}

function DeploymentHistory({ path, repositoryId, settingsVersion, links, heading, description, empty, renderSyncControl }: {
  path: string;
  repositoryId?: number;
  settingsVersion?: number;
  links?: readonly GitlabLink[];
  heading: ReactNode;
  description: string;
  empty: string;
  renderSyncControl?: (refreshPage: () => void) => ReactNode;
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
  function refreshPage() {
    setRequest(current => ({ scope, offset: current.scope === scope ? current.offset : 0 }));
  }

  return <>
    <div className="gitlab-deployment-heading">
      {heading}
      <button className="btn btn-ghost" type="button" aria-disabled={pending} onClick={() => browse(0)}>
        <RefreshCw size={14} aria-hidden="true" />배포 새로고침
      </button>
    </div>
    <p className="gitlab-deployment-hint">{description}</p>
    {renderSyncControl?.(refreshPage)}
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
      description="업무에 연결된 커밋 또는 GitLab이 배포에 포함됐다고 확인한 MR의 기록입니다."
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
      description="선택한 저장소의 배포 웹훅과 GitLab에서 동기화한 배포를 확인합니다."
      renderSyncControl={refreshPage => <DeploymentSync key={`${baseUrl}:${version}:${repositoryId}`} repositoryId={repositoryId}
        settingsVersion={version} refreshPage={refreshPage} />}
      empty="이 저장소에 저장된 GitLab 배포가 없습니다." />
  </section>;
}
