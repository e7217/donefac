'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { GitlabSettings, GitlabWebhookDelivery, GitlabWebhookStatus } from '../../shared/types';
import { api } from '../lib/api';

const eventLabels: Record<GitlabWebhookDelivery['event'], string> = {
  push: 'Push',
  tag_push: 'Tag Push',
  merge_request: 'Merge Request',
  pipeline: 'Pipeline',
  deployment: '배포 이벤트',
  other: '기타',
};
const authenticationLabels: Record<GitlabWebhookDelivery['authentication'], string> = {
  'secret-token': 'Secret Token',
  'signing-token': 'Signing Token',
};

type ReceiptState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; status: GitlabWebhookStatus };

export function GitlabWebhookStatusPanel({ settings }: { settings: GitlabSettings }) {
  const { version, projectIds, webhookSecretConfigured, signingTokenConfigured } = settings;
  const hasRepositories = projectIds.length > 0;
  const authenticationConfigured = webhookSecretConfigured || signingTokenConfigured;
  const [state, setState] = useState<ReceiptState>({ kind: 'loading' });
  const request = useRef<AbortController | null>(null);

  const readStatus = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    void api<GitlabWebhookStatus>('/integrations/gitlab/webhook-status', { signal: controller.signal, cache: 'no-store' }).then(status => {
      if (request.current !== controller) return;
      if (status.settingsVersion !== version) {
        setState({ kind: 'error', message: '연결 설정이 변경되었습니다. 최신 설정을 불러온 뒤 다시 확인하세요.' });
        return;
      }
      setState({ kind: 'ready', status });
    }).catch(() => {
      if (request.current === controller) setState({ kind: 'error', message: '웹훅 수신 상태를 불러오지 못했습니다.' });
    }).finally(() => {
      if (request.current === controller) request.current = null;
    });
  }, [version]);

  useEffect(() => {
    if (hasRepositories) readStatus();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [hasRepositories, readStatus]);

  const deliveries = state.kind === 'ready'
    ? new Map(state.status.repositories.map(repository => [repository.repositoryId, repository.lastDelivery]))
    : null;

  return <section className="card gitlab-webhook-status" aria-labelledby="gitlab-webhook-status-title">
    <div className="card-heading gitlab-webhook-status-heading">
      <h2 id="gitlab-webhook-status-title">GitLab 웹훅 수신 확인</h2>
      <button type="button" className="btn" disabled={!hasRepositories || state.kind === 'loading'} onClick={() => {
        setState({ kind: 'loading' });
        readStatus();
      }}><RefreshCw size={14} aria-hidden="true" />수신 상태 새로고침</button>
    </div>
    {hasRepositories ? <>
      <p>저장한 설정을 기준으로 저장소별 마지막 인증 수신을 표시합니다. 업무 연결 0건도 수신 기록에 포함됩니다.</p>
      <p>GitLab의 최근 이벤트에서 전송 결과를 확인할 수 있습니다.</p>
      {state.kind === 'loading' && <p role="status">웹훅 수신 상태를 확인하는 중입니다.</p>}
      {state.kind === 'error' && <p className="error-text" role="alert">{state.message}</p>}
      {deliveries && <ul className="gitlab-preview-repositories gitlab-webhook-repositories" aria-label="저장소별 웹훅 수신 상태">
        {projectIds.map(repositoryId => {
          const delivery = deliveries.get(repositoryId);
          return <li key={repositoryId}><section aria-label={`저장소 ${repositoryId}`}>
            <h3>저장소 {repositoryId} {delivery ? <span className="badge gitlab-preview-ok">인증 수신 확인</span>
              : <span className="badge gitlab-webhook-waiting">{authenticationConfigured ? '인증 수신 대기' : '웹훅 인증 미설정'}</span>}</h3>
            {delivery && <>
              <p>{eventLabels[delivery.event]} · {authenticationLabels[delivery.authentication]}</p>
              <p><time dateTime={delivery.receivedAt}>{new Date(delivery.receivedAt).toLocaleString('ko-KR')}</time></p>
              {delivery.event === 'deployment'
                ? <p>{delivery.duplicate ? '중복 전송' : delivery.deploymentUpdated ? '배포 기록 반영' : '배포 상태 변경 없음'}</p>
                : <p>업무 연결 {delivery.linked}건 · 자동화 기록 {delivery.automationRuns}건{delivery.duplicate && ' · 중복 전송'}</p>}
            </>}
          </section></li>;
        })}
      </ul>}
    </> : <p>GitLab 프로젝트 ID를 입력하고 연결 설정을 저장해 주세요.</p>}
  </section>;
}
