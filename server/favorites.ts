import type { Favorite, FavoriteRecord, FavoriteResourceType } from '../shared/types.js';
import type { Store } from './store.js';

type FavoriteReferences = { users: ReadonlySet<string>; issueIds: ReadonlySet<string>; documentIds: ReadonlySet<string> };

const fields = ['userId', 'resourceType', 'resourceId', 'createdAt'];
const selectFields = 'resource_type AS resourceType, resource_id AS resourceId, created_at AS createdAt';
const insertFavorite = 'INSERT INTO resource_favorites (user_id, resource_type, resource_id, created_at) VALUES (?,?,?,?)';

export class FavoriteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function readBackupFavorite(value: unknown, refs: FavoriteReferences): FavoriteRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    throw new FavoriteError(400, '백업의 즐겨찾기 데이터 형식을 확인해 주세요.');
  }
  const { userId, resourceType, resourceId, createdAt } = value as Record<string, unknown>;
  if (typeof userId !== 'string' || !userId || !refs.users.has(userId) ||
      (resourceType !== 'issue' && resourceType !== 'document') || typeof resourceId !== 'string' || !resourceId ||
      !(resourceType === 'issue' ? refs.issueIds : refs.documentIds).has(resourceId)) {
    throw new FavoriteError(400, '백업의 즐겨찾기 팀원과 대상을 확인해 주세요.');
  }
  if (typeof createdAt !== 'string' || createdAt.length !== 24 || !Number.isFinite(Date.parse(createdAt)) ||
      new Date(createdAt).toISOString() !== createdAt) {
    throw new FavoriteError(400, '백업의 즐겨찾기 등록 시각을 확인해 주세요.');
  }
  return { userId, resourceType, resourceId, createdAt };
}

export class FavoritesService {
  constructor(private readonly store: Store) {
    // Resource IDs can remain in the trash until restored or permanently deleted.
    store.db.exec(`CREATE TABLE IF NOT EXISTS resource_favorites (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL CHECK(resource_type IN ('issue', 'document')),
      resource_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, resource_type, resource_id)
    );
    CREATE INDEX IF NOT EXISTS resource_favorites_target ON resource_favorites(resource_type, resource_id);`);
  }

  list(userId: string): Favorite[] {
    const rows = this.store.db.prepare(`SELECT ${selectFields} FROM resource_favorites AS favorite
      WHERE user_id=? AND CASE resource_type
        WHEN 'issue' THEN EXISTS (SELECT 1 FROM issues WHERE id=favorite.resource_id)
        WHEN 'document' THEN EXISTS (SELECT 1 FROM documents WHERE id=favorite.resource_id)
      END ORDER BY created_at DESC, resource_type, resource_id`).all(userId) as unknown as Favorite[];
    return rows.map(row => ({ ...row }));
  }

  add(userId: string, resourceType: FavoriteResourceType, resourceId: string): Favorite {
    return this.store.transaction(() => {
      this.requireLiveResource(resourceType, resourceId);
      this.store.db.prepare(`${insertFavorite} ON CONFLICT(user_id, resource_type, resource_id) DO NOTHING`)
        .run(userId, resourceType, resourceId, new Date().toISOString());
      const row = this.store.db.prepare(`SELECT ${selectFields} FROM resource_favorites
        WHERE user_id=? AND resource_type=? AND resource_id=?`).get(userId, resourceType, resourceId) as unknown as Favorite;
      return { ...row };
    });
  }

  remove(userId: string, resourceType: FavoriteResourceType, resourceId: string): void {
    this.store.transaction(() => {
      this.requireLiveResource(resourceType, resourceId);
      this.store.db.prepare('DELETE FROM resource_favorites WHERE user_id=? AND resource_type=? AND resource_id=?')
        .run(userId, resourceType, resourceId);
    });
  }

  removeTarget(resourceType: FavoriteResourceType, resourceId: string): void {
    this.store.db.prepare('DELETE FROM resource_favorites WHERE resource_type=? AND resource_id=?').run(resourceType, resourceId);
  }

  all(): FavoriteRecord[] {
    const rows = this.store.db.prepare(`SELECT user_id AS userId, ${selectFields} FROM resource_favorites
      ORDER BY user_id, resource_type, resource_id`).all() as unknown as FavoriteRecord[];
    return rows.map(row => ({ ...row }));
  }

  validateRestore(raw: unknown, refs: FavoriteReferences): FavoriteRecord[] {
    if (!Array.isArray(raw)) throw new FavoriteError(400, '백업의 즐겨찾기 목록을 확인해 주세요.');
    const seen = new Set<string>();
    return Array.from(raw, value => {
      const row = readBackupFavorite(value, refs);
      const key = JSON.stringify([row.userId, row.resourceType, row.resourceId]);
      if (seen.has(key)) throw new FavoriteError(400, '백업에 중복된 즐겨찾기가 있습니다.');
      seen.add(key);
      return row;
    });
  }

  restore(rows: readonly FavoriteRecord[]): void {
    this.store.db.exec('DELETE FROM resource_favorites');
    const insert = this.store.db.prepare(insertFavorite);
    for (const { userId, resourceType, resourceId, createdAt } of rows) insert.run(userId, resourceType, resourceId, createdAt);
  }

  private requireLiveResource(resourceType: FavoriteResourceType, resourceId: string): void {
    const table = resourceType === 'issue' ? 'issues' : 'documents';
    if (!this.store.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(resourceId)) {
      throw new FavoriteError(404, '즐겨찾기할 업무 또는 문서를 찾을 수 없습니다.');
    }
  }
}
