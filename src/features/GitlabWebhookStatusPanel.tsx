'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { GITLAB_WEBHOOK_TRACKED_EVENTS, type GitlabSettings, type GitlabWebhookDelivery, type GitlabWebhookStatus } from '../../shared/types';
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

function deliveryResult(delivery: GitlabWebhookDelivery) {
  if (delivery.event === 'deployment') {
    return delivery.duplicate ? '중복 전송' : delivery.deploymentUpdated ? '배포 기록 반영' : '배포 상태 변경 없음';
  }
  return `업무 연결 ${delivery.linked}건 · 자동화 기록 ${delivery.automationRuns}건${delivery.duplicate ? ' · 중복 전송' : ''}`;
}

export function GitlabWebhookStatusPanel({ settings }: { settings: GitlabSettings }) {
  const { version, projectIds, webhookSecretConfigured, signingTokenConfigured } = settings;
  const hasRepositories = projectIds.length > 0;
  const authenticationConfigured = webhookSecretConfigured || signingTokenConfigured;
  const [state, setState] = useState<ReceiptState>({ kind: 'loading' });
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
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
    ? new Map(state.status.repositories.map(repository => [repository.repositoryId, repository]))
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
      <p>저장소별 최근 수신과 이벤트별 반영 결과를 확인합니다. 업무 연결 0건도 인증 수신에 포함됩니다.</p>
      {state.kind === 'loading' && <p role="status">웹훅 수신 상태를 확인하는 중입니다.</p>}
      {state.kind === 'error' && <p className="error-text" role="alert">{state.message}</p>}
      {deliveries && <ul className="gitlab-preview-repositories gitlab-webhook-repositories" aria-label="저장소별 웹훅 수신 상태">
        {projectIds.map(repositoryId => {
          const repository = deliveries.get(repositoryId);
          const delivery = repository?.lastDelivery;
          const events = GITLAB_WEBHOOK_TRACKED_EVENTS.map(event => ({
            event,
            receipt: repository?.lastAcceptedByEvent?.[event] ??
              (delivery?.event === event && !delivery.duplicate ? delivery : undefined),
          }));
          const observed = events.filter(({ receipt }) => receipt).length;
          return <li key={repositoryId}><section aria-label={`저장소 ${repositoryId}`}>
            <h3>저장소 {repositoryId} {delivery ? <span className="badge gitlab-preview-ok">인증 수신 확인</span>
              : <span className="badge gitlab-webhook-waiting">{authenticationConfigured ? '인증 수신 대기' : '웹훅 인증 미설정'}</span>}</h3>
            {delivery && <>
              <p>{eventLabels[delivery.event]} · {authenticationLabels[delivery.authentication]}</p>
              <p><time dateTime={delivery.receivedAt}>{new Date(delivery.receivedAt).toLocaleString('ko-KR')}</time></p>
              <p>{deliveryResult(delivery)}</p>
            </>}
            <details className="gitlab-webhook-event-evidence" open={expanded.has(repositoryId)} onToggle={event => {
              const open = event.currentTarget.open;
              setExpanded(previous => {
                if (previous.has(repositoryId) === open) return previous;
                const next = new Set(previous);
                if (open) next.add(repositoryId);
                else next.delete(repositoryId);
                return next;
              });
            }}>
              <summary>이벤트별 수신 {observed}/{events.length}</summary>
              <ul className="gitlab-webhook-events" aria-label="이벤트별 인증 수신" role="list">
                {events.map(({ event, receipt }) => <li key={event}>
                  <strong>{eventLabels[event]}</strong>
                  {receipt ? <div>
                    <p><time dateTime={receipt.receivedAt}>{new Date(receipt.receivedAt).toLocaleString('ko-KR')}</time> · {authenticationLabels[receipt.authentication]}</p>
                    <p>{deliveryResult(receipt)}</p>
                  </div> : <span>{authenticationConfigured ? '수신 대기' : '인증 미설정'}</span>}
                </li>)}
              </ul>
            </details>
          </section></li>;
        })}
      </ul>}
    </> : <p>GitLab 프로젝트 ID를 입력하고 연결 설정을 저장해 주세요.</p>}
  </section>;
}
