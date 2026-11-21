import { createHash, randomUUID } from 'node:crypto';
import { gitlabObjectSha, isGitlabBranchName } from '../shared/gitlab-links.js';
import type { GitlabIssueBranchResult, GitlabIssueBranchReview, GitlabIssueBranchTarget, GitlabLink, Issue } from '../shared/types.js';
import { createGitlabIssueBranch, GitlabReadError, readGitlabBranchHead, readGitlabBranchTarget } from './gitlab-read-sync.js';
import type { Store } from './store.js';

type Connection = { baseUrl: string; version: number; projectIds: readonly number[]; readToken(): string | null };
type IssueIdentity = Pick<Issue, 'id' | 'key' | 'projectId'>;
type Review = {
  issue: IssueIdentity;
  actorId: string;
  version: number;
  baseUrl: string;
  target: GitlabIssueBranchTarget;
  expiresAt: number;
};
type Attempt = {
  previewId: string;
  issue: IssueIdentity;
  actorId: string;
  target: GitlabIssueBranchTarget;
  state: 'pending' | 'confirmed' | 'observed';
  linkId?: string;
};
type Attach = (input: { issue: Issue; target: GitlabIssueBranchTarget; observedSha: string; actorId: string }) => GitlabLink;

const REVIEW_TTL = 10 * 60_000;
const MAX_REVIEWS = 256;
const KNOWN_REJECTIONS = new Set([401, 403, 404, 405, 410, 415, 422, 429]);

export class GitlabIssueBranchError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) { super(message); }
}

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'actorId' && !allowed.includes(key))) {
    throw new GitlabIssueBranchError(400, 'GitLab 브랜치 요청을 확인해 주세요.');
  }
  return value as Record<string, unknown>;
}

function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,2000}$/u.test(value.trim())) {
    throw new GitlabIssueBranchError(400, 'GitLab API 토큰을 확인해 주세요.', { reason: 'invalid_token' });
  }
  return value.trim();
}

function refName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const sha = gitlabObjectSha(value);
  if (sha ? !/^0+$/u.test(sha) : isGitlabBranchName(value)) return value as string;
  throw new GitlabIssueBranchError(400, '기준 브랜치 이름이나 전체 커밋 SHA를 확인해 주세요.');
}

function assertTargetWithoutCredential(target: GitlabIssueBranchTarget, credential: string | null) {
  if (!credential) return;
  const encoded = encodeURIComponent(credential.toWellFormed());
  if ([target.branch, target.ref, target.repositoryPath, target.sourceSha, target.webUrl].some(value =>
    value === credential || value === encoded || credential.length >= 8 && (value.includes(credential) || value.includes(encoded)))) {
    throw new GitlabIssueBranchError(400, '브랜치 또는 저장소 정보에 토큰을 포함할 수 없습니다.');
  }
}

function sameIssue(issue: Issue | undefined, saved: IssueIdentity): issue is Issue {
  return issue?.id === saved.id && issue.key === saved.key && issue.projectId === saved.projectId;
}

function branchKey(baseUrl: string, repositoryId: number, branch: string) {
  return createHash('sha256').update(JSON.stringify([baseUrl, repositoryId, branch])).digest('hex');
}

function parseAttempt(row: unknown): Attempt | undefined {
  return row ? JSON.parse((row as { attempt: string }).attempt) as Attempt : undefined;
}

function remoteError(cause: unknown, creating = false): GitlabIssueBranchError {
  const status = cause instanceof GitlabReadError ? cause.httpStatus : null;
  const details = { reason: creating ? 'gitlab_write_rejected' : 'gitlab_read_failed', httpStatus: status };
  if (status === 401) return new GitlabIssueBranchError(401, 'GitLab API 토큰을 확인해 주세요.', details);
  if (status === 403) return new GitlabIssueBranchError(403, '저장소 권한과 GitLab API 토큰 범위를 확인해 주세요.', details);
  if (status === 404) return new GitlabIssueBranchError(404, 'GitLab 저장소 또는 기준 브랜치·커밋을 찾을 수 없습니다.', details);
  if (status === 429) return new GitlabIssueBranchError(429, 'GitLab 요청 한도에 도달했습니다. 잠시 뒤 다시 확인해 주세요.', details);
  return new GitlabIssueBranchError(creating ? 422 : 502, creating
    ? 'GitLab에서 브랜치 생성을 거절했습니다. 저장소 권한과 브랜치 규칙을 확인해 주세요.'
    : 'GitLab 브랜치 정보를 확인하지 못했습니다. 연결과 기준 브랜치·커밋을 확인해 주세요.', details);
}

export class GitlabIssueBranchCreation {
  private readonly reviews = new Map<string, Review>();

  constructor(private readonly store: Store, private readonly readConnection: () => Connection, private readonly attach: Attach) {
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS gitlab_issue_branch_attempts (
      target_key TEXT PRIMARY KEY,
      preview_id TEXT NOT NULL UNIQUE,
      attempt TEXT NOT NULL
    )`);
  }

  private currentIssue(id: string): Issue {
    const issue = this.store.get<Issue>('issues', id);
    if (!issue) throw new GitlabIssueBranchError(404, '업무를 찾을 수 없습니다.', { reason: 'issue_missing' });
    return issue;
  }

  private connection(expectedVersion: unknown, repositoryId: number, baseUrl?: string): Connection {
    const connection = this.readConnection();
    if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new GitlabIssueBranchError(400, 'GitLab 연결 설정을 확인해 주세요.');
    }
    if (expectedVersion !== connection.version || (baseUrl !== undefined && baseUrl !== connection.baseUrl)) {
      throw new GitlabIssueBranchError(409, 'GitLab 연결 설정이 변경되었습니다. 최신 설정에서 다시 확인해 주세요.',
        { reason: 'settings_changed', currentVersion: connection.version });
    }
    if (!connection.baseUrl || !connection.projectIds.includes(repositoryId)) {
      throw new GitlabIssueBranchError(403, '저장된 GitLab 저장소를 선택해 주세요.', { reason: 'repository_not_configured' });
    }
    return connection;
  }

  private selection(input: Record<string, unknown>) {
    const { repositoryId, branch } = input;
    if (typeof repositoryId !== 'number' || !Number.isSafeInteger(repositoryId) || repositoryId < 1) {
      throw new GitlabIssueBranchError(400, 'GitLab 저장소를 선택해 주세요.');
    }
    if (!isGitlabBranchName(branch) || gitlabObjectSha(branch)) {
      throw new GitlabIssueBranchError(400, '브랜치 이름을 확인해 주세요. 커밋 SHA는 생성 기준에 입력해 주세요.');
    }
    const connection = this.connection(input.expectedSettingsVersion, repositoryId);
    return { connection, repositoryId, branch, key: branchKey(connection.baseUrl, repositoryId, branch) };
  }

  private ownedAttempt(key: string, issueId: string): Attempt | undefined {
    const attempt = parseAttempt(this.store.db.prepare('SELECT attempt FROM gitlab_issue_branch_attempts WHERE target_key=?').get(key));
    if (attempt && attempt.issue.id !== issueId) {
      throw new GitlabIssueBranchError(409, '다른 업무에서 이 저장소의 같은 브랜치 이름을 사용했습니다.', { reason: 'branch_claimed' });
    }
    return attempt;
  }

  private result(attempt: Attempt, reportCreation = false): GitlabIssueBranchResult {
    const { target } = attempt;
    if (attempt.state === 'pending') return { state: 'pending', target };
    const observedSha = target.sourceSha;
    if (!attempt.linkId) return { state: 'link_needed', target, observedSha };
    const link = this.store.get<GitlabLink>('gitlab_links', attempt.linkId);
    if (!link || link.issueId !== attempt.issue.id || link.projectId !== target.repositoryId ||
        link.kind !== 'branch' || link.sourceBranch !== target.branch || link.state !== 'active') {
      return { state: 'existing', target, observedSha };
    }
    return { state: reportCreation && attempt.state === 'confirmed' ? 'created' : 'found', target, link,
      observedSha: link.sourceSha ?? observedSha };
  }

  private recheck(review: Review) {
    if (review.expiresAt <= Date.now()) throw this.expired();
    if (!this.store.get('users', review.actorId)) throw this.expired();
    this.connection(review.version, review.target.repositoryId, review.baseUrl);
    if (!sameIssue(this.currentIssue(review.issue.id), review.issue)) {
      throw new GitlabIssueBranchError(409, '업무의 프로젝트 또는 번호가 변경되었습니다. 브랜치를 다시 검토해 주세요.', { reason: 'issue_changed' });
    }
  }

  private expired() {
    return new GitlabIssueBranchError(409, '같은 작업자로 브랜치와 기준 커밋을 다시 검토해 주세요.', { reason: 'review_required' });
  }

  private saveAttempt(key: string, attempt: Attempt) {
    this.store.db.prepare('UPDATE gitlab_issue_branch_attempts SET attempt=? WHERE target_key=? AND preview_id=?')
      .run(JSON.stringify(attempt), key, attempt.previewId);
    return attempt;
  }

  private markObserved(key: string, attempt: Attempt, state: 'confirmed' | 'observed'): Attempt {
    return this.store.transaction(() => {
      const current = this.ownedAttempt(key, attempt.issue.id);
      if (!current || current.previewId !== attempt.previewId || current.state !== 'pending') return current ?? attempt;
      return this.saveAttempt(key, { ...current, state });
    });
  }

  private linkObserved(key: string, attempt: Attempt, connection: Connection, actorId: string, issueIdentity: IssueIdentity,
    reportCreation = false): GitlabIssueBranchResult {
    if (attempt.state === 'pending' || attempt.linkId) return this.result(attempt);
    try {
      return this.store.transaction(() => {
        const current = this.ownedAttempt(key, attempt.issue.id);
        if (!current || current.previewId !== attempt.previewId || current.state === 'pending' || current.linkId) {
          return this.result(current ?? attempt);
        }
        const issue = this.store.get<Issue>('issues', current.issue.id);
        if (!sameIssue(issue, issueIdentity) || !this.store.get('users', actorId)) return this.result(current);
        this.connection(connection.version, current.target.repositoryId, connection.baseUrl);
        const link = this.attach({ issue, target: current.target, observedSha: current.target.sourceSha, actorId });
        return this.result(this.saveAttempt(key, { ...current, linkId: link.id }), reportCreation);
      });
    } catch {
      // Keep the verified remote outcome if attaching to the local ticket fails.
      return this.result(attempt);
    }
  }

  async preview(issueId: string, value: unknown, actorId: string, signal?: AbortSignal): Promise<GitlabIssueBranchReview> {
    const input = fields(value, ['expectedSettingsVersion', 'repositoryId', 'branch', 'ref', 'accessToken']);
    const { connection, key, repositoryId, branch } = this.selection(input);
    const issue = this.currentIssue(issueId);
    const ref = refName(input.ref);
    const credential = input.accessToken === undefined ? connection.readToken() : token(input.accessToken);
    const previous = this.ownedAttempt(key, issueId);
    if (previous) {
      assertTargetWithoutCredential(previous.target, credential);
      return this.result(previous);
    }

    const { target, existingSha } = await readGitlabBranchTarget({ baseUrl: connection.baseUrl, token: credential }, repositoryId, branch, ref, signal)
      .catch(cause => { signal?.throwIfAborted(); throw remoteError(cause); });
    signal?.throwIfAborted();
    const now = Date.now();
    const review = { issue: { id: issue.id, key: issue.key, projectId: issue.projectId }, actorId, version: connection.version,
      baseUrl: connection.baseUrl, target, expiresAt: now + REVIEW_TTL };
    this.recheck(review);
    assertTargetWithoutCredential(target, credential);
    const concurrent = this.ownedAttempt(key, issueId);
    if (concurrent) {
      assertTargetWithoutCredential(concurrent.target, credential);
      return this.result(concurrent);
    }
    if (existingSha) return { state: 'existing', target, observedSha: existingSha };
    for (const [id, saved] of this.reviews) if (saved.expiresAt <= now) this.reviews.delete(id);
    if (this.reviews.size >= MAX_REVIEWS) this.reviews.delete(this.reviews.keys().next().value!);
    const previewId = randomUUID();
    this.reviews.set(previewId, review);
    return { state: 'ready', target, previewId, expiresAt: new Date(review.expiresAt).toISOString() };
  }

  async apply(issueId: string, value: unknown, actorId: string, signal?: AbortSignal): Promise<GitlabIssueBranchResult> {
    const input = fields(value, ['previewId', 'writeToken']);
    const credential = token(input.writeToken);
    const { previewId } = input;
    if (typeof previewId !== 'string') throw this.expired();
    this.currentIssue(issueId);
    const saved = parseAttempt(this.store.db.prepare('SELECT attempt FROM gitlab_issue_branch_attempts WHERE preview_id=?').get(previewId));
    if (saved) {
      if (saved.issue.id !== issueId || saved.actorId !== actorId) throw this.expired();
      assertTargetWithoutCredential(saved.target, credential);
      return this.result(saved);
    }
    const review = this.reviews.get(previewId);
    if (!review || review.issue.id !== issueId || review.actorId !== actorId) throw this.expired();
    this.recheck(review);
    const { target } = review;
    assertTargetWithoutCredential(target, credential);
    const { branch, repositoryId, sourceSha } = target;
    const remote = { baseUrl: review.baseUrl, token: credential };
    const key = branchKey(review.baseUrl, repositoryId, branch);
    const previous = this.ownedAttempt(key, issueId);
    if (previous) return this.result(previous);

    const existingSha = await readGitlabBranchHead(remote, repositoryId, branch, signal)
      .catch(cause => { signal?.throwIfAborted(); throw remoteError(cause); });
    signal?.throwIfAborted();
    this.recheck(review);
    const concurrent = this.ownedAttempt(key, issueId);
    if (concurrent) return this.result(concurrent);
    if (existingSha) return { state: 'existing', target, observedSha: existingSha };

    const attempt: Attempt = { previewId, issue: review.issue, actorId, target, state: 'pending' };
    const connection = this.store.transaction(() => {
      this.recheck(review);
      const current = this.connection(review.version, repositoryId, review.baseUrl);
      const claimed = this.store.db.prepare('INSERT OR IGNORE INTO gitlab_issue_branch_attempts (target_key,preview_id,attempt) VALUES (?,?,?)')
        .run(key, previewId, JSON.stringify(attempt));
      return Number(claimed.changes) === 1 ? current : null;
    });
    if (!connection) {
      const existing = this.ownedAttempt(key, issueId);
      if (!existing) throw this.expired();
      return this.result(existing);
    }
    this.reviews.delete(previewId);
    try {
      const createdSha = await createGitlabIssueBranch(remote, repositoryId, branch, sourceSha);
      if (createdSha !== sourceSha) return this.result(attempt);
    } catch (cause) {
      if (cause instanceof GitlabReadError && cause.httpStatus !== null && KNOWN_REJECTIONS.has(cause.httpStatus)) {
        this.store.db.prepare(`DELETE FROM gitlab_issue_branch_attempts WHERE target_key=? AND preview_id=? AND json_extract(attempt,'$.state')='pending'`)
          .run(key, previewId);
        throw remoteError(cause, true);
      }
      return this.result(this.ownedAttempt(key, issueId) ?? attempt);
    }
    const confirmed = this.markObserved(key, attempt, 'confirmed');
    return this.linkObserved(key, confirmed, connection, actorId, attempt.issue, true);
  }

  async reconcile(issueId: string, value: unknown, actorId: string, signal?: AbortSignal): Promise<GitlabIssueBranchResult> {
    const input = fields(value, ['expectedSettingsVersion', 'repositoryId', 'branch', 'accessToken']);
    const { connection, key, repositoryId, branch } = this.selection(input);
    const issue = this.currentIssue(issueId);
    const attempt = this.ownedAttempt(key, issueId);
    if (!attempt) throw new GitlabIssueBranchError(404, '확인할 브랜치 생성 요청을 찾을 수 없습니다.', { reason: 'attempt_missing' });
    const credential = input.accessToken === undefined ? connection.readToken() : token(input.accessToken);
    assertTargetWithoutCredential(attempt.target, credential);
    if (attempt.linkId) return this.result(attempt);
    const observedSha = await readGitlabBranchHead({ baseUrl: connection.baseUrl, token: credential }, repositoryId, branch, signal)
      .catch(cause => { signal?.throwIfAborted(); throw remoteError(cause); });
    signal?.throwIfAborted();
    this.connection(connection.version, repositoryId, connection.baseUrl);
    if (!observedSha) return { state: 'pending', target: attempt.target };
    if (observedSha !== attempt.target.sourceSha) return { state: 'conflict', target: attempt.target, observedSha };
    const known = this.markObserved(key, attempt, 'observed');
    return this.linkObserved(key, known, connection, actorId, issue);
  }
}
