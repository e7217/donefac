import type { User, UserEmailChangeResult } from '../shared/types.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import type { Store } from './store.js';
import { workspaceRestoreGeneration } from './workspace-revisions.js';

type Reason = 'invalid_request' | 'workspace_changed' | 'request_conflict' | 'member_changed' | 'member_unavailable' | 'version_exhausted';
type Receipt = { actorId: string; userId: string; fingerprint: string; appliedVersion: number };

export class UserEmailChangeError extends Error {
  constructor(public status: number, message: string, public details: { reason: Reason; currentUser?: User }) { super(message); }
}

export function nextUserVersion(user: User) {
  const next = (user.version ?? 1) + 1;
  if (!Number.isSafeInteger(next)) {
    throw new UserEmailChangeError(409, '팀원 정보 버전 범위를 초과했습니다.', { reason: 'version_exhausted' });
  }
  return next;
}

export class UserEmailChangeService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS user_email_change_requests (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      applied_version INTEGER NOT NULL
    )`);
  }

  change(userId: string, actorId: string, input: Record<string, unknown>, normalizeEmail: (email: unknown) => string,
    recordActivity: () => void): UserEmailChangeResult {
    const { requestId, expectedVersion, restoreGeneration } = input;
    if (Object.keys(input).some(key => !['email', 'requestId', 'expectedVersion', 'restoreGeneration'].includes(key)) ||
        !Object.hasOwn(input, 'email') || typeof requestId !== 'string' || !creationRequestId.test(requestId) ||
        typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
        typeof restoreGeneration !== 'string' || !restoreGeneration || restoreGeneration.length > 100) {
      throw new UserEmailChangeError(400, '이메일 변경 요청과 팀원 버전을 확인해 주세요.', { reason: 'invalid_request' });
    }
    const id = requestId.toLowerCase();
    const email = normalizeEmail(input.email);
    const fingerprint = creationRequestFingerprint({ email, expectedVersion, restoreGeneration });
    return this.store.transaction(() => {
      if (workspaceRestoreGeneration(this.store) !== restoreGeneration) {
        throw new UserEmailChangeError(409, '작업 공간이 복원되었습니다. 현재 팀원 정보를 확인해 주세요.', { reason: 'workspace_changed' });
      }
      const receipt = this.store.db.prepare(`SELECT actor_id AS actorId, user_id AS userId, fingerprint,
        applied_version AS appliedVersion FROM user_email_change_requests WHERE id=?`).get(id) as Receipt | undefined;
      if (receipt && (receipt.actorId !== actorId || receipt.userId !== userId || receipt.fingerprint !== fingerprint)) {
        throw new UserEmailChangeError(409, '이미 사용한 이메일 변경 요청입니다. 현재 팀원 정보를 확인해 주세요.', { reason: 'request_conflict' });
      }
      const user = this.store.get<User>('users', userId);
      if (!user) throw new UserEmailChangeError(404, '팀원을 찾을 수 없습니다.', { reason: 'member_unavailable' });
      if (receipt) return { user, appliedVersion: receipt.appliedVersion, duplicate: true };

      const version = user.version ?? 1;
      if (version !== expectedVersion) {
        throw new UserEmailChangeError(409, '다른 작업자가 팀원 정보를 변경했습니다. 현재 주소를 확인해 주세요.', { reason: 'member_changed', currentUser: user });
      }
      const updated = user.email === email ? user : { ...user, email, version: nextUserVersion(user) };
      if (updated !== user) {
        this.store.put('users', updated);
        recordActivity();
      }
      const appliedVersion = updated.version ?? 1;
      this.store.db.prepare(`INSERT INTO user_email_change_requests(id,actor_id,user_id,fingerprint,applied_version)
        VALUES (?,?,?,?,?)`).run(id, actorId, userId, fingerprint, appliedVersion);
      return { user: updated, appliedVersion, duplicate: false };
    });
  }
}
