'use client';

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { GitlabDeploymentPreviewResult } from '../../shared/types';
import { api, ApiError } from '../lib/api';

type Preview = { state: 'loading' } | { state: 'error'; message: string } |
  { state: 'ready'; result: GitlabDeploymentPreviewResult };

type Props = {
  actorId: string;
  settingsVersion: number;
  draftRevision: number;
  baseUrl: string;
  token: string;
  projectIds: readonly number[];
};

const previewStatus = {
  ok: '배포를 조회할 수 있습니다.',
  empty: '조회 범위에 배포가 없습니다.',
  partial: '일부 배포 또는 포함 MR만 확인했습니다.',
} satisfies Record<GitlabDeploymentPreviewResult['status'], string>;

function matchesPreview(result: GitlabDeploymentPreviewResult | undefined, repositoryId: number, settingsVersion: number): result is GitlabDeploymentPreviewResult {
  return Boolean(result && result.repositoryId === repositoryId && result.settingsVersion === settingsVersion &&
    Object.hasOwn(previewStatus, result.status) && typeof result.deploymentLimitReached === 'boolean' &&
    [result.deploymentsRead, result.successfulDeployments, result.mergeRequestsRead, result.associationUnavailable,
      result.associationLimited, result.associationDenied, result.associationRateLimited].every(count => Number.isSafeInteger(count) && count >= 0));
}

function previewError(cause: unknown, token: string): string {
  const fallback = 'GitLab 배포를 조회하지 못했습니다. 다시 확인해 주세요.';
  if (!(cause instanceof ApiError)) return fallback;
  const details = cause.details && typeof cause.details === 'object' ? cause.details as { stage?: unknown; httpStatus?: unknown } : undefined;
  const hardRead = cause.status === 502 && (details?.stage === 'project' || details?.stage === 'deployments');
  if (cause.status === 429 || (hardRead && details?.httpStatus === 429)) {
    return 'GitLab 요청 제한이 풀린 뒤 배포 조회를 다시 시도해 주세요.';
  }
  if (hardRead && details?.httpStatus === 404) {
    return details.stage === 'project' ? 'GitLab 저장소를 읽을 수 없습니다. 저장소 ID와 접근 권한을 확인해 주세요.'
      : 'GitLab 배포 이력을 열 수 없습니다. 배포 API 접근 권한을 확인해 주세요.';
  }
  const credential = token.trim();
  return cause.message && (!credential || !cause.message.includes(credential)) ? cause.message : fallback;
}

export function GitlabDeploymentPreview({ actorId, settingsVersion, draftRevision, baseUrl, token, projectIds }: Props) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const repositoryId = selectedId !== null && projectIds.includes(selectedId) ? selectedId : projectIds[0];
  const scope = JSON.stringify([actorId, settingsVersion, draftRevision, repositoryId]);
  const [snapshot, setSnapshot] = useState<{ scope: string; preview: Preview | null }>({ scope, preview: null });
  const request = useRef<{ scope: string; controller: AbortController } | null>(null);
  const preview = snapshot.scope === scope ? snapshot.preview : null;
  if (snapshot.scope !== scope) setSnapshot({ scope, preview: null });
  const canPreview = Boolean(actorId && baseUrl.trim() && repositoryId !== undefined);

  useEffect(() => () => {
    if (request.current?.scope !== scope) return;
    request.current.controller.abort();
    request.current = null;
  }, [scope]);

  function selectRepository(id: number) {
    request.current?.controller.abort();
    request.current = null;
    setSnapshot({ scope, preview: null });
    setSelectedId(id);
  }

  async function load() {
    if (!canPreview || repositoryId === undefined || request.current?.scope === scope) return;
    request.current?.controller.abort();
    const controller = new AbortController();
    const active = { scope, controller };
    request.current = active;
    setSnapshot({ scope, preview: { state: 'loading' } });
    const finish = (next: Preview) => {
      if (request.current === active && !controller.signal.aborted) {
        setSnapshot(current => current.scope === scope ? { scope, preview: next } : current);
      }
    };
    try {
      const result = await api<GitlabDeploymentPreviewResult>('/integrations/gitlab/deployments/preview', {
        method: 'POST', signal: controller.signal, cache: 'no-store', headers: { 'X-Actor-Id': actorId },
        body: JSON.stringify({ repositoryId, expectedVersion: settingsVersion, baseUrl, projectIds, ...(token ? { token } : {}) }),
      });
      finish(matchesPreview(result, repositoryId, settingsVersion) ? { state: 'ready', result }
        : { state: 'error', message: '연결 설정과 일치하는 배포 조회 결과를 받지 못했습니다.' });
    } catch (cause) {
      finish({ state: 'error', message: previewError(cause, token) });
    } finally {
      if (request.current === active) request.current = null;
    }
  }

  return <div className="gitlab-deployment-preview">
    <p className="help-text">입력한 연결 설정으로 배포와 포함 MR을 확인합니다.</p>
    <div className="gitlab-deployment-preview-controls">
      <label className="form-label">배포 조회 저장소
        <select className="field" value={repositoryId ?? ''} disabled={!projectIds.length}
          onChange={event => selectRepository(Number(event.currentTarget.value))}>
          {!projectIds.length && <option value="">저장소를 입력하세요</option>}
          {projectIds.map(id => <option key={id} value={id}>저장소 {id}</option>)}
        </select>
      </label>
      <button className="btn" type="button" disabled={!canPreview || preview?.state === 'loading'} onClick={() => void load()}>
        <Search size={15} aria-hidden="true" />배포 조회 미리보기
      </button>
    </div>
    {preview && <section className="gitlab-deployment-preview-result" aria-label="배포 조회 미리보기 결과">
      {preview.state === 'loading' && <p role="status">입력한 설정으로 GitLab 배포를 조회하는 중입니다.</p>}
      {preview.state === 'error' && <p role="alert" className="error-text">{preview.message}</p>}
      {preview.state === 'ready' && <DeploymentPreviewResult result={preview.result} />}
    </section>}
  </div>;
}

function DeploymentPreviewResult({ result }: { result: GitlabDeploymentPreviewResult }) {
  const observations = [
    result.deploymentLimitReached && '배포 조회 한도에 도달했습니다.',
    result.associationUnavailable > 0 && `포함 MR을 조회하지 못한 배포 ${result.associationUnavailable}건`,
    result.associationLimited > 0 && `포함 MR 조회 한도에 도달한 배포 ${result.associationLimited}건`,
    result.associationDenied > 0 && `포함 MR 조회 권한이 거부된 배포 ${result.associationDenied}건`,
    result.associationRateLimited > 0 && `GitLab 요청 제한으로 포함 MR을 조회하지 못한 배포 ${result.associationRateLimited}건`,
  ].filter((message): message is string => typeof message === 'string');
  return <>
    <h3>저장소 {result.repositoryId}</h3>
    <p role="status">{previewStatus[result.status]}</p>
    <dl className="gitlab-deployment-preview-counts">
      <div><dt>조회 배포</dt><dd>{result.deploymentsRead}건</dd></div>
      <div><dt>성공한 배포</dt><dd>{result.successfulDeployments}건</dd></div>
      {result.successfulDeployments > 0 && <div><dt>조회 포함 MR</dt><dd>{result.mergeRequestsRead}건</dd></div>}
    </dl>
    {result.deploymentsRead > 0 && result.successfulDeployments === 0 &&
      <p>성공한 배포가 없어 포함 MR은 확인하지 않았습니다.</p>}
    {observations.length > 0 && <ul>{observations.map(message => <li key={message}>{message}</li>)}</ul>}
  </>;
}
