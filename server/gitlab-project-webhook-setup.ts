import { createHash, randomUUID } from 'node:crypto';
import type { GitlabProjectWebhook, GitlabProjectWebhookAuthMode, GitlabProjectWebhookHistory, GitlabProjectWebhookReview } from '../shared/gitlab-project-webhooks.js';
import { createGitlabProjectWebhook, GitlabReadError, listGitlabProjectWebhooks, readGitlabProjectWebhookHistory, supportsGitlabProjectWebhookSigning } from './gitlab-read-sync.js';
import type { Store } from './store.js';

type Connection = {
  baseUrl: string;
  version: number;
  projectIds: readonly number[];
  authMode: GitlabProjectWebhookAuthMode | null;
  readToken(): string | null;
  matchesCredential(value: string): boolean;
};
type Review = { settingsVersion: number; repositoryId: number; baseUrl: string; actorId: string; expiresAt: number };
const REVIEW_TTL_MS = 10 * 60_000;
const MAX_REVIEWS = 256;
const DEFINITE_REJECTIONS = new Set([400, 401, 403, 404, 405, 410, 422, 429]);

export class GitlabProjectWebhookSetupError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

function requestFields(input: unknown, fields: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(field => !fields.includes(field))) {
    throw new GitlabProjectWebhookSetupError(400, 'GitLab 웹훅 설정 요청을 확인해 주세요.');
  }
  return input as Record<string, unknown>;
}

function submittedCredential(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GitlabProjectWebhookSetupError(400, 'GitLab 관리 토큰이나 웹훅 인증 값을 확인해 주세요.');
  }
  return value;
}

function receiverAddress(publicOrigin?: string): string | undefined {
  if (!publicOrigin) return undefined;
  const url = new URL(publicOrigin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('GitLab 웹훅 수신에는 Teamspace의 HTTPS 기본 주소가 필요합니다.');
  }
  return new URL('/api/integrations/gitlab/webhook', url).href;
}

function externalError(error: unknown, creating = false): GitlabProjectWebhookSetupError {
  const status = error instanceof GitlabReadError ? error.httpStatus : null;
  if (status === 401) return new GitlabProjectWebhookSetupError(401, 'GitLab 토큰을 확인해 주세요.');
  if (status === 403) return new GitlabProjectWebhookSetupError(403, '저장소의 Maintainer 또는 Owner 권한과 API 토큰 범위를 확인해 주세요.');
  if (status === 404) return new GitlabProjectWebhookSetupError(404, 'GitLab에서 저장소나 웹훅 목록을 읽을 수 없습니다. 저장소 ID와 토큰 권한을 확인해 주세요.');
  if (status === 429) return new GitlabProjectWebhookSetupError(429, 'GitLab 요청 한도에 도달했습니다. 잠시 뒤 다시 점검해 주세요.');
  if (creating && status !== null && DEFINITE_REJECTIONS.has(status)) {
    return new GitlabProjectWebhookSetupError(422, 'GitLab이 웹훅 등록을 거절했습니다. 수신 주소, 인증 방식과 GitLab 버전을 확인해 주세요.');
  }
  return new GitlabProjectWebhookSetupError(502, 'GitLab 프로젝트 웹훅 목록을 확인하지 못했습니다. 연결과 다음 페이지를 확인해 주세요.');
}

function historyReadError(error: unknown): GitlabProjectWebhookSetupError {
  if (error instanceof GitlabReadError) {
    if (error.httpStatus === 401 || error.httpStatus === 403 || error.httpStatus === 429) return externalError(error);
    if (error.httpStatus === 404) return new GitlabProjectWebhookSetupError(404,
      'GitLab 웹훅 전송 이력을 찾을 수 없습니다. 웹훅이 변경되었거나 권한 또는 GitLab 버전에서 조회를 지원하는지 확인해 주세요.');
    if (error.code === 'timeout') return new GitlabProjectWebhookSetupError(504, 'GitLab 웹훅 전송 이력의 응답 시간이 초과되었습니다. 다시 확인해 주세요.');
    if (error.code === 'response-too-large') return new GitlabProjectWebhookSetupError(502, 'GitLab 웹훅 전송 이력이 응답 크기 한도를 초과했습니다.');
    if (error.code === 'invalid-response') return new GitlabProjectWebhookSetupError(502, 'GitLab 웹훅 전송 이력의 응답 형식을 확인할 수 없습니다.');
  }
  return new GitlabProjectWebhookSetupError(502, 'GitLab 웹훅 전송 이력을 조회하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.');
}

function isConfigured(hook: GitlabProjectWebhook): boolean {
  return hook.receiverExact !== false && hook.pushEvents && hook.mergeRequestEvents && hook.pipelineEvents &&
    hook.deploymentEvents === true && hook.sslVerification && hook.unfilteredPush && hook.standardPayload && hook.active !== false;
}

export class GitlabProjectWebhookSetup {
  readonly receiverUrl: string | undefined;
  private readonly reviews = new Map<string, Review>();
  private readonly registering = new Set<string>();

  constructor(private readonly store: Store, private readonly getConnection: () => Connection, publicOrigin?: string) {
    this.receiverUrl = receiverAddress(publicOrigin);
    store.db.exec('CREATE TABLE IF NOT EXISTS gitlab_project_webhook_pending (target TEXT PRIMARY KEY, attempt TEXT NOT NULL)');
  }

  private connection(expected: unknown): Connection {
    const connection = this.getConnection();
    if (!Number.isSafeInteger(expected) || expected !== connection.version) {
      throw new GitlabProjectWebhookSetupError(Number.isSafeInteger(expected) ? 409 : 400,
        'GitLab 연결 설정이 변경되었습니다. 최신 설정에서 다시 점검해 주세요.', { currentVersion: connection.version });
    }
    return connection;
  }

  private target(input: Record<string, unknown>) {
    const connection = this.connection(input.expectedVersion);
    const receiverUrl = this.receiverUrl;
    if (!receiverUrl) throw new GitlabProjectWebhookSetupError(409, 'Teamspace 팀 접속 HTTPS 주소를 먼저 설정해 주세요.');
    if (!connection.baseUrl) throw new GitlabProjectWebhookSetupError(409, 'GitLab 기본 주소를 먼저 저장해 주세요.');
    const { repositoryId } = input;
    if (typeof repositoryId !== 'number' || !Number.isSafeInteger(repositoryId) || repositoryId < 1) {
      throw new GitlabProjectWebhookSetupError(400, '점검할 GitLab 저장소를 선택해 주세요.');
    }
    if (!connection.projectIds.includes(repositoryId)) throw new GitlabProjectWebhookSetupError(403, '저장된 GitLab 저장소를 선택해 주세요.');
    const key = createHash('sha256').update(JSON.stringify([connection.baseUrl, repositoryId, receiverUrl])).digest('hex');
    return { connection, repositoryId, receiverUrl, key };
  }

  private async findHooks(target: ReturnType<GitlabProjectWebhookSetup['target']>, token: string, signal?: AbortSignal) {
    const { connection, repositoryId, receiverUrl } = target;
    try {
      return await listGitlabProjectWebhooks({ baseUrl: connection.baseUrl, token }, repositoryId, receiverUrl, signal);
    } catch (error) { throw externalError(error); }
  }

  private confirmPending(key: string, attempt?: string) {
    if (attempt) this.store.db.prepare('DELETE FROM gitlab_project_webhook_pending WHERE target=? AND attempt=?').run(key, attempt);
    else this.store.db.prepare('DELETE FROM gitlab_project_webhook_pending WHERE target=?').run(key);
  }

  private result(target: ReturnType<GitlabProjectWebhookSetup['target']>, hooks: GitlabProjectWebhook[]): GitlabProjectWebhookReview {
    const pending = this.store.db.prepare('SELECT 1 FROM gitlab_project_webhook_pending WHERE target=?').get(target.key);
    const state = hooks.length === 1 && isConfigured(hooks[0]) ? 'configured' : hooks.length ? 'review' : pending ? 'unknown' : 'missing';
    return { settingsVersion: target.connection.version, repositoryId: target.repositoryId, receiverUrl: target.receiverUrl,
      authMode: target.connection.authMode, state, hooks };
  }

  async review(value: unknown, actorId: string, signal?: AbortSignal): Promise<GitlabProjectWebhookReview> {
    const input = requestFields(value, ['expectedVersion', 'repositoryId', 'managementToken', 'actorId']);
    const target = this.target(input);
    const token = input.managementToken === undefined ? target.connection.readToken() : submittedCredential(input.managementToken).trim();
    if (!token) throw new GitlabProjectWebhookSetupError(400, '저장소 웹훅을 조회할 GitLab 토큰을 입력해 주세요.');
    const hooks = await this.findHooks(target, token, signal);
    this.connection(target.connection.version);
    if (hooks.length) this.confirmPending(target.key);
    const result = this.result(target, hooks);
    if (result.state === 'missing' && result.authMode) {
      const now = Date.now();
      for (const [id, saved] of this.reviews) if (saved.expiresAt <= now) this.reviews.delete(id);
      if (this.reviews.size >= MAX_REVIEWS) this.reviews.delete(this.reviews.keys().next().value!);
      const reviewId = randomUUID();
      this.reviews.set(reviewId, { settingsVersion: target.connection.version, repositoryId: target.repositoryId,
        baseUrl: target.connection.baseUrl, actorId, expiresAt: now + REVIEW_TTL_MS });
      result.reviewId = reviewId;
    }
    return result;
  }

  async history(value: unknown, signal?: AbortSignal): Promise<Omit<GitlabProjectWebhookHistory, 'localReceipt'>> {
    const input = requestFields(value, ['expectedVersion', 'repositoryId', 'hookId', 'managementToken', 'actorId']);
    const target = this.target(input);
    const { connection, repositoryId, receiverUrl } = target;
    const { hookId } = input;
    if (typeof hookId !== 'number' || !Number.isSafeInteger(hookId) || hookId < 1) {
      throw new GitlabProjectWebhookSetupError(400, '전송 이력을 조회할 웹훅을 선택해 주세요.');
    }
    const token = input.managementToken === undefined ? connection.readToken() : submittedCredential(input.managementToken).trim();
    if (!token) throw new GitlabProjectWebhookSetupError(400, '웹훅 전송 이력을 조회할 GitLab 토큰을 입력해 주세요.');

    const checkCurrent = () => {
      signal?.throwIfAborted();
      this.connection(connection.version);
    };
    const hooks = await this.findHooks(target, token, signal).finally(checkCurrent);
    if (!hooks.some(hook => hook.id === hookId && hook.receiverExact !== false)) {
      throw new GitlabProjectWebhookSetupError(404, '현재 Teamspace 수신 주소와 일치하는 웹훅이 없습니다. 웹훅 설정을 다시 점검해 주세요.',
        { reason: 'receiver_changed' });
    }

    const result = await readGitlabProjectWebhookHistory({ baseUrl: connection.baseUrl, token }, repositoryId, hookId, receiverUrl, signal)
      .catch(error => { throw historyReadError(error); }).finally(checkCurrent);
    return { settingsVersion: connection.version, repositoryId, hookId, attempts: result.attempts, partial: result.partial };
  }

  async register(value: unknown, actorId: string, signal?: AbortSignal): Promise<GitlabProjectWebhookReview> {
    const input = requestFields(value, ['expectedVersion', 'repositoryId', 'reviewId', 'managementToken', 'webhookCredential', 'actorId']);
    const target = this.target(input);
    const { connection, repositoryId, key } = target;
    const review = typeof input.reviewId === 'string' ? this.reviews.get(input.reviewId) : undefined;
    if (!review || review.expiresAt <= Date.now() || review.actorId !== actorId || review.settingsVersion !== connection.version ||
      review.repositoryId !== repositoryId || review.baseUrl !== connection.baseUrl) {
      throw new GitlabProjectWebhookSetupError(409, '같은 작업자로 해당 저장소의 웹훅 설정을 다시 점검해 주세요.');
    }
    const mode = connection.authMode;
    const token = submittedCredential(input.managementToken).trim();
    const credential = submittedCredential(input.webhookCredential);
    if (!mode || !connection.matchesCredential(credential)) throw new GitlabProjectWebhookSetupError(400, '저장한 웹훅 인증 값을 다시 입력해 주세요.');

    if (this.registering.has(key)) throw new GitlabProjectWebhookSetupError(409, '이 저장소의 웹훅 등록이 진행 중입니다. 잠시 뒤 다시 점검해 주세요.');
    this.registering.add(key);
    try { return await this.registerReviewed(target, token, { mode, value: credential }, signal); }
    finally { this.registering.delete(key); }
  }

  private async registerReviewed(target: ReturnType<GitlabProjectWebhookSetup['target']>, token: string,
    credential: { mode: GitlabProjectWebhookAuthMode; value: string }, signal?: AbortSignal): Promise<GitlabProjectWebhookReview> {
    const { connection, repositoryId, receiverUrl, key } = target;
    const hooks = await this.findHooks(target, token, signal);
    this.connection(connection.version);
    if (hooks.length) {
      this.confirmPending(key);
      return this.result(target, hooks);
    }
    const current = this.result(target, []);
    if (current.state === 'unknown') return current;
    if (credential.mode === 'signature') {
      const supportsSigning = await supportsGitlabProjectWebhookSigning({ baseUrl: connection.baseUrl, token }, signal)
        .catch(error => { throw externalError(error); });
      this.connection(connection.version);
      if (!supportsSigning) throw new GitlabProjectWebhookSetupError(422,
        '서명 토큰 자동 등록에는 GitLab 19.1 이상이 필요합니다. GitLab에서 웹훅 지원 여부를 확인해 주세요.');
    }
    signal?.throwIfAborted();
    const attempt = randomUUID();
    const claimed = this.store.db.prepare('INSERT OR IGNORE INTO gitlab_project_webhook_pending (target,attempt) VALUES (?,?)').run(key, attempt);
    if (Number(claimed.changes) === 0) return this.result(target, []);

    // A disconnected browser or server cannot prove that GitLab did not receive this write.
    // Keep the attempt until GitLab explicitly rejects it or a subsequent list finds the hook.
    let created: GitlabProjectWebhook;
    try {
      created = await createGitlabProjectWebhook({ baseUrl: connection.baseUrl, token }, repositoryId, receiverUrl, credential);
    } catch (error) {
      if (error instanceof GitlabReadError && error.httpStatus !== null && DEFINITE_REJECTIONS.has(error.httpStatus)) {
        this.confirmPending(key, attempt);
        throw externalError(error, true);
      }
      return { ...this.result(target, []), state: 'unknown', ...this.configurationChange(connection.version) };
    }
    this.confirmPending(key, attempt);
    return { ...this.result(target, [created]), state: 'created', ...this.configurationChange(connection.version) };
  }

  private configurationChange(version: number): { configurationChanged?: true } {
    return this.getConnection().version === version ? {} : { configurationChanged: true };
  }
}
