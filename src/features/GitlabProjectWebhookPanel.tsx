'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Copy, Link2, Search } from 'lucide-react';
import type { GitlabProjectWebhookHistory, GitlabProjectWebhookReview } from '../../shared/gitlab-project-webhooks';
import type { GitlabSettings } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { GitlabWebhookAutomationResult, gitlabWebhookAuthenticationLabels, gitlabWebhookEventLabels } from './GitlabWebhookStatusPanel';
import './gitlab-project-webhook.css';

type Action = 'review' | 'register';
type Hook = GitlabProjectWebhookReview['hooks'][number];
type HistoryRead = { hookId: number; value: GitlabProjectWebhookHistory | null; error?: string };
type SetupError = { message: string; offerManualSetup?: boolean };

const receiverPath = '/api/integrations/gitlab/webhook';
const staleReviewMessage = '연결 설정이나 점검 결과가 변경되었습니다. 최신 설정을 확인하고 다시 점검해 주세요.';
const resultMessages: Record<GitlabProjectWebhookReview['state'], string> = {
  missing: '이 수신 주소에 등록된 웹훅이 없습니다.',
  configured: 'GitLab에 필요한 웹훅 설정이 등록되어 있습니다.',
  review: 'GitLab에서 기존 웹훅 설정을 확인해 주세요.',
  unknown: 'GitLab에서 웹훅 설정을 확인하지 못했습니다.',
  created: 'GitLab에 웹훅을 등록했습니다.',
};
const messageReceiptLabels = {
  matched: '같은 메시지 인증 수신 확인',
  unconfirmed: '같은 메시지 인증 수신 미확인',
  unavailable: '같은 메시지 대조 불가',
};

function operationError(error: unknown, action: Action) {
  if (error instanceof ApiError) {
    if (error.status === 409) return staleReviewMessage;
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      return action === 'register'
        ? '저장소 ID와 Maintainer 또는 Owner 권한의 API 토큰을 확인하고 다시 점검해 주세요.'
        : '저장소 ID를 확인하고 웹훅을 볼 수 있는 GitLab 토큰으로 다시 점검해 주세요.';
    }
    if (error.status === 400) return action === 'register'
      ? 'Teamspace에 저장한 웹훅 인증 값을 확인한 뒤 다시 점검해 주세요.'
      : '저장소 웹훅을 조회할 수 있는 GitLab 토큰을 확인해 주세요.';
    if (error.status === 422) return error.message;
    if (error.status === 429) return 'GitLab 요청 한도에 도달했습니다. 잠시 뒤 다시 점검해 주세요.';
  }
  return action === 'register'
    ? '웹훅 등록 결과를 확인하지 못했습니다. 다시 점검하거나 GitLab의 웹훅 목록을 확인해 주세요.'
    : '웹훅 설정을 점검하지 못했습니다. 다시 점검하거나 GitLab의 웹훅 목록을 확인해 주세요.';
}

function historyError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 409) return staleReviewMessage;
    if (error.status === 400 || error.status === 401 || error.status === 403) {
      return 'GitLab 관리 토큰과 저장소의 Maintainer 또는 Owner 권한을 확인해 주세요.';
    }
    if (error.status === 404) {
      if (error.details && typeof error.details === 'object' && 'reason' in error.details && error.details.reason === 'receiver_changed') {
        return '현재 Teamspace 수신 주소와 일치하는 웹훅이 없습니다. 웹훅 설정을 다시 점검해 주세요.';
      }
      return 'GitLab 전송 이력을 읽을 수 없습니다. GitLab 17.3 이상과 저장소 조회 권한을 확인해 주세요.';
    }
    if (error.status === 429) return 'GitLab 요청 한도에 도달했습니다. 잠시 뒤 다시 확인해 주세요.';
    if (error.status === 504) return 'GitLab 전송 이력 조회 시간이 초과되었습니다. 잠시 뒤 다시 확인해 주세요.';
  }
  return 'GitLab 전송 이력을 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
}

function deliveryHint(status: number | null) {
  if (status === null) return 'GitLab의 전송 상세와 Teamspace 수신 주소·TLS 설정을 확인해 주세요.';
  if (status === 401 || status === 403) return 'Teamspace 웹훅 인증 값과 프록시의 수신 경로 접근을 확인해 주세요.';
  if (status === 404 || (status >= 300 && status < 400)) return 'GitLab에 등록된 HTTPS 수신 주소와 프록시 경로를 확인해 주세요.';
  if (status >= 500) return 'Teamspace와 프록시의 오류 기록을 확인해 주세요.';
  return null;
}

function WebhookHistory({ value }: { value: GitlabProjectWebhookHistory }) {
  const receipt = value.localReceipt;
  const hint = value.attempts.length ? deliveryHint(value.attempts[0].status) : null;
  return <section className="gitlab-project-webhook-history" aria-label="GitLab 최근 전송">
    <h4>GitLab 최근 전송</h4>
    {value.partial && <p className="gitlab-project-webhook-note">확인할 수 있는 전송만 표시합니다.</p>}
    {hint && <p>{hint}</p>}
    {value.attempts.length ? <>
      <p className="gitlab-project-webhook-note">HTTP 상태는 개별 전송 시도의 응답입니다. 같은 메시지의 재전송에는 동일한 Teamspace 인증 수신 기록이 표시될 수 있습니다.</p>
      <ol className="gitlab-project-webhook-attempts" aria-label="GitLab 최근 전송 내역" role="list">
        {value.attempts.map(attempt => {
          const messageReceipt = attempt.messageReceipt ?? { status: 'unavailable' as const };
          return <li key={attempt.id} aria-label={`GitLab 전송 #${attempt.id}`}>
            <div><strong>{gitlabWebhookEventLabels[attempt.event]}</strong>
              <span className="gitlab-project-webhook-http" data-ok={attempt.status !== null && attempt.status >= 200 && attempt.status < 300}>
                {attempt.status === null ? 'HTTP 응답 없음' : `HTTP ${attempt.status}`}
              </span>
            </div>
            <small>{attempt.sentAt ? <><span className="sr-only">GitLab 전송 시각 </span>
              <time dateTime={attempt.sentAt}>{new Date(attempt.sentAt).toLocaleString('ko-KR')}</time></> : '전송 시각 미제공'}
              {attempt.durationMs !== null && <> · {attempt.durationMs.toLocaleString('ko-KR')}ms</>}
            </small>
            <p className="gitlab-project-webhook-message-receipt">
              <strong data-receipt-status={messageReceipt.status}>{messageReceiptLabels[messageReceipt.status]}</strong>
              {messageReceipt.status === 'matched' && <small>
                {gitlabWebhookAuthenticationLabels[messageReceipt.delivery.authentication]} · <span className="sr-only">Teamspace 인증 수신 시각 </span>
                <time dateTime={messageReceipt.delivery.receivedAt}>
                  {new Date(messageReceipt.delivery.receivedAt).toLocaleString('ko-KR')}
                </time>
              </small>}
            </p>
            {messageReceipt.status === 'matched' && <GitlabWebhookAutomationResult delivery={messageReceipt.delivery} />}
          </li>;
        })}
      </ol>
    </> : <p>확인된 GitLab 전송 기록이 없습니다.</p>}
    <div className="gitlab-project-webhook-local-receipt">
      <h4>Teamspace 인증 수신</h4>
      {receipt ? <p>이 저장소의 마지막 인증 수신 · {gitlabWebhookEventLabels[receipt.event]} · {gitlabWebhookAuthenticationLabels[receipt.authentication]}
        {' · '}<time dateTime={receipt.receivedAt}>{new Date(receipt.receivedAt).toLocaleString('ko-KR')}</time></p>
        : <p>이 저장소의 인증 수신 기록이 없습니다.</p>}
    </div>
  </section>;
}

function ExistingHook({ hook, children }: { hook: Hook; children?: ReactNode }) {
  const flags = [
    ['Push', hook.pushEvents],
    ['Merge Request', hook.mergeRequestEvents],
    ['Pipeline', hook.pipelineEvents],
    ['배포 이벤트', hook.deploymentEvents ?? null],
    ['SSL 검증', hook.sslVerification],
    ['모든 브랜치 Push', hook.unfilteredPush],
    ['기본 전송 본문', hook.standardPayload],
  ] as const;

  return <li>
    <h3>웹훅 #{hook.id}</h3>
    {hook.receiverExact === false && <p>수신 경로는 같으며 GitLab의 등록 주소를 확인해 주세요.</p>}
    <ul className="gitlab-project-webhook-events" aria-label="웹훅 설정" role="list">
      {flags.map(([label, enabled]) => <li key={label} data-enabled={enabled === true}>
        {label} {enabled === null ? '확인 불가' : enabled ? '켜짐' : '꺼짐'}
      </li>)}
    </ul>
    {hook.deploymentEvents !== true && <p>GitLab 저장소의 Settings → Webhooks에서 이 웹훅의 Deployment events를 켠 뒤 다시 점검하세요.</p>}
    <p>{hook.active === null ? '전송 상태 확인 불가' : hook.active ? '전송 가능' : '전송 중지'}</p>
    {children}
  </li>;
}

export function GitlabProjectWebhookPanel({ settings }: { settings: GitlabSettings }) {
  const id = useId();
  const { baseUrl, projectIds, version, webhookReceiverUrl } = settings;
  const [repositoryId, setRepositoryId] = useState(projectIds[0] ?? 0);
  const [managementToken, setManagementToken] = useState('');
  const [webhookCredential, setWebhookCredential] = useState('');
  const [result, setResult] = useState<GitlabProjectWebhookReview | null>(null);
  const [activeAction, setActiveAction] = useState<Action | 'history' | null>(null);
  const [history, setHistory] = useState<HistoryRead | null>(null);
  const [error, setError] = useState<SetupError | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const receiver = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const busy = activeAction !== null;
  const reviewAvailable = Boolean(webhookReceiverUrl && baseUrl && projectIds.includes(repositoryId));
  const registrationAvailable = result?.state === 'missing' && Boolean(result.reviewId && result.authMode && !result.configurationChanged);
  const manualSetupAvailable = !result?.configurationChanged && (result?.state === 'unknown' || error?.offerManualSetup);
  const management = managementToken.trim();
  const hasCredential = Boolean(webhookCredential.trim());
  const credentialLabel = result?.authMode === 'signature' ? 'Signing Token' : 'Secret Token';

  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, []);

  async function copyReceiver() {
    if (!webhookReceiverUrl) return;
    try {
      await navigator.clipboard.writeText(webhookReceiverUrl);
      setCopyStatus('수신 주소를 복사했습니다.');
    } catch {
      receiver.current?.focus();
      receiver.current?.select();
      setCopyStatus('선택된 수신 주소를 복사해 주세요.');
    }
  }

  function chooseRepository(id: number) {
    setRepositoryId(id);
    setResult(null);
    setHistory(null);
    setWebhookCredential('');
    setError(null);
  }

  async function runAction(event: FormEvent<HTMLFormElement>, action: Action) {
    event.preventDefault();
    if (!reviewAvailable || request.current) return;
    if (action === 'register' && (!registrationAvailable || !management || !hasCredential)) return;
    const controller = new AbortController();
    request.current = controller;
    setActiveAction(action);
    if (action === 'review') setResult(null);
    setHistory(null);
    setWebhookCredential('');
    setError(null);
    try {
      const value = await api<GitlabProjectWebhookReview>(`/integrations/gitlab/project-webhook-${action}`, {
        method: 'POST',
        signal: controller.signal,
        cache: 'no-store',
        body: JSON.stringify({
          expectedVersion: version, repositoryId, ...(management ? { managementToken: management } : {}),
          ...(action === 'register' ? { reviewId: result?.reviewId, webhookCredential } : {}),
        }),
      });
      if (request.current !== controller) return;
      if (value.repositoryId !== repositoryId || value.receiverUrl !== webhookReceiverUrl ||
          (value.settingsVersion !== version && !value.configurationChanged)) {
        setResult(null);
        setError({ message: staleReviewMessage });
        return;
      }
      setResult(value);
    } catch (cause) {
      if (request.current === controller) {
        const status = cause instanceof ApiError ? cause.status : null;
        const uncertainRegistration = action === 'register' && (status === null || status >= 500);
        setResult(null);
        setError({ message: operationError(cause, action), offerManualSetup: status !== 409 &&
          (uncertainRegistration || manualSetupAvailable) });
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setActiveAction(null);
      }
    }
  }

  async function readHistory(hook: Hook, opener: HTMLButtonElement) {
    if (!reviewAvailable || request.current || hook.receiverExact === false || result?.configurationChanged ||
        result?.settingsVersion !== version || result.repositoryId !== repositoryId) return;
    const controller = new AbortController();
    request.current = controller;
    setActiveAction('history');
    setHistory({ hookId: hook.id, value: null });
    try {
      const value = await api<GitlabProjectWebhookHistory>('/integrations/gitlab/project-webhook-history', {
        method: 'POST', signal: controller.signal, cache: 'no-store',
        body: JSON.stringify({ expectedVersion: version, repositoryId, hookId: hook.id, ...(management ? { managementToken: management } : {}) }),
      });
      if (request.current !== controller) return;
      if (value.settingsVersion !== version || value.repositoryId !== repositoryId || value.hookId !== hook.id) {
        setHistory({ hookId: hook.id, value: null, error: staleReviewMessage });
      } else setHistory({ hookId: hook.id, value });
    } catch (cause) {
      if (request.current === controller) setHistory({ hookId: hook.id, value: null, error: historyError(cause) });
    } finally {
      if (request.current === controller) {
        request.current = null;
        setActiveAction(null);
        requestAnimationFrame(() => {
          if (opener.isConnected && document.activeElement === document.body) opener.focus({ preventScroll: true });
        });
      }
    }
  }

  return <section className="card gitlab-project-webhook" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>GitLab 프로젝트 웹훅 설정</h2>
    <p>GitLab 저장소의 Settings → Webhooks에서 Teamspace 수신 주소와 이벤트를 설정할 수 있습니다.</p>
    {webhookReceiverUrl ? <>
      <div className="gitlab-project-webhook-address">
        <label>웹훅 수신 주소<input ref={receiver} className="field" readOnly value={webhookReceiverUrl} /></label>
        <button type="button" className="btn" onClick={() => void copyReceiver()}>
          <Copy size={15} aria-hidden="true" />수신 주소 복사
        </button>
      </div>
      {copyStatus && <p className="gitlab-project-webhook-note" role="status">{copyStatus}</p>}
    </> : <p className="gitlab-project-webhook-note">
      GitLab에서 접근할 수 있는 Teamspace 배포 주소에 수신 경로 <code>{receiverPath}</code>를 붙여 사용하세요.
      Teamspace에 수신 주소가 설정되면 이 화면에서 점검할 수 있습니다.
    </p>}
    <p className="gitlab-project-webhook-note">Push, Merge Request, Pipeline, Deployment events를 켜고 SSL 검증을 사용하세요.</p>
    {reviewAvailable && <>
      <p className="gitlab-project-webhook-note">저장된 GitLab 주소 <code>{baseUrl}</code></p>
      <form className="gitlab-project-webhook-fields" onSubmit={event => void runAction(event, 'review')}>
        <label>웹훅 저장소
          <select className="field" value={repositoryId} disabled={busy} onChange={event => chooseRepository(Number(event.target.value))}>
            {projectIds.map(repository => <option key={repository} value={repository}>저장소 {repository}</option>)}
          </select>
        </label>
        <label>GitLab 관리 API 토큰
          <input className="field" type="password" autoComplete="new-password" maxLength={2000} value={managementToken}
            disabled={busy} onChange={event => { setManagementToken(event.target.value); setHistory(null); }} aria-describedby={`${id}-management`} />
        </label>
        <button type="submit" className="btn" disabled={busy}><Search size={15} aria-hidden="true" />
          {result || error ? '다시 점검' : '웹훅 설정 점검'}
        </button>
      </form>
      <p id={`${id}-management`} className="gitlab-project-webhook-note">
        점검은 저장한 읽기 토큰으로 시도할 수 있습니다. 등록하려면 저장소의 웹훅을 관리할 수 있는 <code>api</code> 토큰을 입력하세요.
      </p>
      {activeAction && activeAction !== 'history' && <p role="status">{activeAction === 'review' ? '웹훅 설정을 점검하고 있습니다.' : 'GitLab에 웹훅을 등록하고 있습니다.'}</p>}
      {error && <p className="error-text" role="alert">{error.message}</p>}
      {result && <div className="gitlab-project-webhook-result">
        <p role="status">{resultMessages[result.state]}</p>
        {result.configurationChanged && <p className="error-text">Teamspace 연결 설정이 바뀌었습니다. 최신 설정을 불러온 뒤 다시 점검해 주세요.</p>}
        {result.hooks.length > 1 && <p>같은 수신 주소를 사용하는 웹훅이 {result.hooks.length}개 있습니다.</p>}
        {result.hooks.length > 0 && <ul className="gitlab-project-webhook-hooks" aria-label="등록된 웹훅" role="list">
          {result.hooks.map(hook => <ExistingHook key={hook.id} hook={hook}>
            {hook.receiverExact !== false && !result.configurationChanged && <div className="gitlab-project-webhook-history-actions">
              <button type="button" className="btn" disabled={busy} onClick={event => void readHistory(hook, event.currentTarget)}>최근 전송 확인</button>
            </div>}
            {history?.hookId === hook.id && <>
              {activeAction === 'history' && <p role="status">GitLab 전송 이력을 확인하고 있습니다.</p>}
              {history.error && <p className="error-text" role="alert">{history.error}</p>}
              {history.value && <WebhookHistory value={history.value} />}
            </>}
          </ExistingHook>)}
        </ul>}
        {result.state === 'missing' && !result.authMode && !result.configurationChanged &&
          <p>GitLab 연결에서 웹훅 인증 값을 먼저 저장해 주세요.</p>}
        {(result.state === 'created' || result.state === 'configured') &&
          <p>GitLab에서 이벤트를 보낸 뒤 최근 전송과 이 저장소의 인증 수신을 확인하세요.</p>}
        {registrationAvailable && <>
          <form className="gitlab-project-webhook-fields" onSubmit={event => void runAction(event, 'register')}>
            <label>웹훅 {credentialLabel} 다시 입력
              <input className="field" type="password" autoComplete="new-password" maxLength={2000} value={webhookCredential} disabled={busy}
                onChange={event => setWebhookCredential(event.target.value)} aria-describedby={`${id}-credential`} />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy || !management || !hasCredential}>
              <Link2 size={15} aria-hidden="true" />GitLab에 웹훅 등록
            </button>
          </form>
          <p id={`${id}-credential`} className="gitlab-project-webhook-note">
            Teamspace에 저장한 {credentialLabel} 값을 입력한 뒤 등록을 누르면 저장소에 웹훅을 추가합니다.
          </p>
        </>}
      </div>}
      {manualSetupAvailable && <section className="gitlab-project-webhook-manual" aria-labelledby={`${id}-manual`}>
        <h3 id={`${id}-manual`}>GitLab 웹훅 수동 등록</h3>
        <p>GitLab의 저장소 {repositoryId}에서 <strong>Settings → Webhooks</strong>를 열고 위의 웹훅 수신 주소를 찾으세요. 같은 주소가 목록에 있으면 Teamspace에서 <strong>다시 점검</strong>을 누르세요.</p>
        {(settings.signingTokenConfigured || settings.webhookSecretConfigured) ? <ol>
          <li>주소가 없을 때만 <strong>Add new webhook</strong>을 열고 위에서 복사한 수신 주소를 URL에 붙여 넣으세요.</li>
          <li>{settings.signingTokenConfigured ? <>
            <strong>Signing token</strong>에 Teamspace에 저장한 값을 입력하세요. <strong>Generate signing token</strong> 버튼이 보이면 버튼을 누른 뒤 생성된 값을 Teamspace에 저장한 값으로 바꾸세요.
          </> : <>
            <strong>Secret token</strong>에 Teamspace에 저장한 값을 입력하세요.
          </>}</li>
          <li>Push, Merge Request, Pipeline, Deployment events와 SSL 검증을 켜세요. Push는 모든 브랜치를 선택하고 기본 전송 본문을 사용하세요.</li>
          <li>GitLab에서 웹훅을 저장한 뒤 Teamspace에서 <strong>다시 점검</strong>을 누르세요.</li>
        </ol> : <p>GitLab 연결에서 웹훅 인증 값을 먼저 저장하고 다시 점검하세요.</p>}
      </section>}
    </>}
    {webhookReceiverUrl && !reviewAvailable && <p>GitLab 주소와 프로젝트 ID를 입력하고 연결 설정을 저장해 주세요.</p>}
  </section>;
}
