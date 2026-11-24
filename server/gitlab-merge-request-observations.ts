import type { Store } from './store.js';

export type GitlabMergeRequestReadState = 'opened' | 'closed' | 'merged';

export interface GitlabMergeRequestReadObservation {
  instance: string;
  repositoryId: number;
  objectId: number;
  iid: number;
  updatedAt: string;
  state: GitlabMergeRequestReadState | null;
  source: 'read';
}

type AuthoritativeRead = Omit<GitlabMergeRequestReadObservation, 'state'> & { state: GitlabMergeRequestReadState };

const fields = new Set(['instance', 'repositoryId', 'objectId', 'iid', 'updatedAt', 'state', 'source']);
const projection = `instance, repository_id AS repositoryId, object_id AS objectId, iid, updated_at AS updatedAt, state, 'read' AS source`;

export function isGitlabMergeRequestReadState(value: unknown): value is GitlabMergeRequestReadState {
  return value === 'opened' || value === 'closed' || value === 'merged';
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function canonicalTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function parseRow(value: unknown): GitlabMergeRequestReadObservation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(field => !fields.has(field))) return;
  const { instance, repositoryId, objectId, iid, updatedAt, state, source } = value as Record<string, unknown>;
  if (typeof instance !== 'string' || !/^[a-f0-9]{12}$/u.test(instance) || !positiveId(repositoryId) ||
      !positiveId(objectId) || !positiveId(iid) || !canonicalTime(updatedAt) || source !== 'read' ||
      (state !== null && !isGitlabMergeRequestReadState(state))) return;
  return { instance, repositoryId, objectId, iid, updatedAt, state, source };
}

export class GitlabMergeRequestObservationError extends Error {
  readonly status = 400;

  constructor() { super('백업의 GitLab MR 상태 관측 정보를 확인해 주세요.'); }
}

export class GitlabMergeRequestObservations {
  private readonly find;
  private readonly save;
  private readonly insert;

  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS gitlab_merge_request_observations(
      instance TEXT NOT NULL,
      repository_id INTEGER NOT NULL,
      object_id INTEGER NOT NULL,
      iid INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      state TEXT CHECK (state IN ('opened', 'closed', 'merged')),
      PRIMARY KEY (instance, repository_id, object_id)
    ) WITHOUT ROWID`);
    this.find = store.db.prepare(`SELECT ${projection} FROM gitlab_merge_request_observations
      WHERE instance=? AND repository_id=? AND object_id=?`);
    const insertSql = `INSERT INTO gitlab_merge_request_observations(instance,repository_id,object_id,iid,updated_at,state) VALUES(?,?,?,?,?,?)`;
    this.insert = store.db.prepare(insertSql);
    this.save = store.db.prepare(`${insertSql}
      ON CONFLICT (instance,repository_id,object_id) DO UPDATE SET updated_at=excluded.updated_at,
        state=CASE WHEN excluded.updated_at>gitlab_merge_request_observations.updated_at THEN excluded.state ELSE NULL END
      WHERE excluded.iid=gitlab_merge_request_observations.iid AND (
        excluded.updated_at>gitlab_merge_request_observations.updated_at OR
        (excluded.updated_at=gitlab_merge_request_observations.updated_at AND excluded.state<>gitlab_merge_request_observations.state)
      )`);
  }

  get(instance: string, repositoryId: number, objectId: number | string): GitlabMergeRequestReadObservation | undefined {
    const id = typeof objectId === 'string' && /^[1-9]\d{0,15}$/u.test(objectId) ? Number(objectId) : objectId;
    if (!positiveId(id)) return;
    return this.find.get(instance, repositoryId, id) as GitlabMergeRequestReadObservation | undefined;
  }

  record(read: AuthoritativeRead): void {
    if (parseRow(read) && read.updatedAt <= new Date().toISOString()) {
      this.save.run(read.instance, read.repositoryId, read.objectId, read.iid, read.updatedAt, read.state);
    }
  }

  exportRows(): GitlabMergeRequestReadObservation[] {
    return this.store.db.prepare(`SELECT ${projection} FROM gitlab_merge_request_observations ORDER BY instance,repository_id,object_id`)
      .all() as unknown as GitlabMergeRequestReadObservation[];
  }

  /** Replace the records inside the workspace restore transaction. */
  restore(raw: unknown, exportedAt: unknown, restoredAt: string): void {
    if (!Array.isArray(raw) || (raw.length > 0 && !canonicalTime(exportedAt))) throw new GitlabMergeRequestObservationError();
    const seen = new Set<string>();
    const rows = raw.map(value => {
      const row = parseRow(value);
      if (!row || typeof exportedAt !== 'string' || row.updatedAt > exportedAt || row.updatedAt > restoredAt) {
        throw new GitlabMergeRequestObservationError();
      }
      const key = `${row.instance}:${row.repositoryId}:${row.objectId}`;
      if (seen.has(key)) throw new GitlabMergeRequestObservationError();
      seen.add(key);
      return row;
    });
    this.store.db.exec('DELETE FROM gitlab_merge_request_observations');
    for (const row of rows) this.insert.run(row.instance, row.repositoryId, row.objectId, row.iid, row.updatedAt, row.state);
  }
}
