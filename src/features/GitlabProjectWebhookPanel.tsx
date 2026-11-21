'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Copy, Link2, Search } from 'lucide-react';
import type { GitlabProjectWebhookReview } from '../../shared/gitlab-project-webhooks';
import type { GitlabSettings } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import './gitlab-project-webhook.css';

type Action = 'review' | 'register';
type Hook = GitlabProjectWebhookReview['hooks'][number];

const receiverPath = '/api/integrations/gitlab/webhook';
const staleReviewMessage = '연결 설정이나 점검 결과가 변경되었습니다. 최신 설정을 확인하고 다시 점검해 주세요.';
const resultMessages: Record<GitlabProjectWebhookReview['state'], string> = {
  missing: '이 수신 주소에 등록된 웹훅이 없습니다.',
  configured: 'GitLab에 필요한 웹훅 설정이 등록되어 있습니다.',
  review: 'GitLab에서 기존 웹훅 설정을 확인해 주세요.',
  unknown: 'GitLab에서 웹훅 설정을 확인하지 못했습니다.',
  created: 'GitLab에 웹훅을 등록했습니다.',
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

function ExistingHook({ hook }: { hook: Hook }) {
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
  </li>;
}

export function GitlabProjectWebhookPanel({ settings }: { settings: GitlabSettings }) {
  const id = useId();
  const { baseUrl, projectIds, version, webhookReceiverUrl } = settings;
  const [repositoryId, setRepositoryId] = useState(projectIds[0] ?? 0);
  const [managementToken, setManagementToken] = useState('');
  const [webhookCredential, setWebhookCredential] = useState('');
  const [result, setResult] = useState<GitlabProjectWebhookReview | null>(null);
  const [activeAction, setActiveAction] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const receiver = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const busy = activeAction !== null;
  const reviewAvailable = Boolean(webhookReceiverUrl && baseUrl && projectIds.includes(repositoryId));
  const registrationAvailable = result?.state === 'missing' && Boolean(result.reviewId && result.authMode && !result.configurationChanged);
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
    setWebhookCredential('');
    setError('');
  }

  async function runAction(event: FormEvent<HTMLFormElement>, action: Action) {
    event.preventDefault();
    if (!reviewAvailable || request.current) return;
    if (action === 'register' && (!registrationAvailable || !management || !hasCredential)) return;
    const controller = new AbortController();
    request.current = controller;
    setActiveAction(action);
    if (action === 'review') setResult(null);
    setWebhookCredential('');
    setError('');
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
        setError(staleReviewMessage);
        return;
      }
      setResult(value);
    } catch (cause) {
      if (request.current === controller) {
        setResult(null);
        setError(operationError(cause, action));
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setActiveAction(null);
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
            disabled={busy} onChange={event => setManagementToken(event.target.value)} aria-describedby={`${id}-management`} />
        </label>
        <button type="submit" className="btn" disabled={busy}><Search size={15} aria-hidden="true" />
          {result || error ? '다시 점검' : '웹훅 설정 점검'}
        </button>
      </form>
      <p id={`${id}-management`} className="gitlab-project-webhook-note">
        점검은 저장한 읽기 토큰으로 시도할 수 있습니다. 등록하려면 저장소의 웹훅을 관리할 수 있는 <code>api</code> 토큰을 입력하세요.
      </p>
      {activeAction && <p role="status">{activeAction === 'review' ? '웹훅 설정을 점검하고 있습니다.' : 'GitLab에 웹훅을 등록하고 있습니다.'}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {result && <div className="gitlab-project-webhook-result">
        <p role="status">{resultMessages[result.state]}</p>
        {result.configurationChanged && <p className="error-text">Teamspace 연결 설정이 바뀌었습니다. 최신 설정을 불러온 뒤 다시 점검해 주세요.</p>}
        {result.hooks.length > 1 && <p>같은 수신 주소를 사용하는 웹훅이 {result.hooks.length}개 있습니다.</p>}
        {result.hooks.length > 0 && <ul className="gitlab-project-webhook-hooks" aria-label="등록된 웹훅" role="list">
          {result.hooks.map(hook => <ExistingHook key={hook.id} hook={hook} />)}
        </ul>}
        {result.state === 'unknown' && <p>다시 점검하거나 GitLab의 웹훅 목록에서 등록 상태를 직접 확인해 주세요.</p>}
        {result.state === 'missing' && !result.authMode && !result.configurationChanged &&
          <p>GitLab 연결에서 웹훅 인증 값을 먼저 저장해 주세요.</p>}
        {(result.state === 'created' || result.state === 'configured') &&
          <p>GitLab에서 테스트 이벤트를 보낸 뒤 아래의 웹훅 수신 확인에서 인증 결과를 확인하세요.</p>}
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
    </>}
    {webhookReceiverUrl && !reviewAvailable && <p>GitLab 주소와 프로젝트 ID를 입력하고 연결 설정을 저장해 주세요.</p>}
  </section>;
}
