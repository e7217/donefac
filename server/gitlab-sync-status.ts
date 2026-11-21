import type { StatementSync } from 'node:sqlite';
import type { GitlabActivitySyncAttempt, GitlabDeploymentSyncAttempt, GitlabSyncRepositoryResult, GitlabSyncStatus } from '../shared/types.js';
import type { Store } from './store.js';

type SyncKind = 'activity' | 'deployments';
type SyncAttempt = GitlabActivitySyncAttempt | GitlabDeploymentSyncAttempt;
type AttemptDates = 'completedAt' | 'lastSuccessfulAt';
type DeploymentOutcome = Omit<Extract<GitlabDeploymentSyncAttempt, { status: 'ok' }>, AttemptDates> |
  Omit<Extract<GitlabDeploymentSyncAttempt, { status: 'error' }>, AttemptDates>;
type StoredAttempt = { sequence: number; successful_sequence: number | null; json: string };

/** At most one completed attempt and one successful timestamp per repository and read operation. */
export class GitlabManualSyncStatus {
  private sequence: number;
  private readonly get: StatementSync;
  private readonly put: StatementSync;

  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS gitlab_manual_sync_status (
      repository_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('activity','deployments')),
      sequence INTEGER NOT NULL, successful_sequence INTEGER, json TEXT NOT NULL,
      PRIMARY KEY(repository_id, kind)
    );`);
    this.sequence = Number(store.db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM gitlab_manual_sync_status').get()?.sequence ?? 0);
    this.get = store.db.prepare('SELECT sequence,successful_sequence,json FROM gitlab_manual_sync_status WHERE repository_id=? AND kind=?');
    this.put = store.db.prepare(`INSERT INTO gitlab_manual_sync_status(repository_id,kind,sequence,successful_sequence,json)
      VALUES(?,?,?,?,?) ON CONFLICT(repository_id,kind) DO UPDATE SET
      sequence=excluded.sequence,successful_sequence=excluded.successful_sequence,json=excluded.json`);
  }

  start(): number {
    return ++this.sequence;
  }

  list(settingsVersion: number, repositoryIds: readonly number[]): GitlabSyncStatus {
    const rows = this.store.db.prepare('SELECT repository_id,kind,json FROM gitlab_manual_sync_status').all();
    const attempts = new Map(rows.map(row => [`${row.repository_id}:${row.kind}`, String(row.json)]));
    return { settingsVersion, repositories: repositoryIds.map(repositoryId => {
      const activity = attempts.get(`${repositoryId}:activity`);
      const deployments = attempts.get(`${repositoryId}:deployments`);
      return { repositoryId, activity: activity ? JSON.parse(activity) as GitlabActivitySyncAttempt : null,
        deployments: deployments ? JSON.parse(deployments) as GitlabDeploymentSyncAttempt : null };
    }) };
  }

  clear(): void {
    this.store.db.exec('DELETE FROM gitlab_manual_sync_status');
  }

  remove(repositoryId: number, kind?: SyncKind): void {
    if (kind) this.store.db.prepare('DELETE FROM gitlab_manual_sync_status WHERE repository_id=? AND kind=?').run(repositoryId, kind);
    else this.store.db.prepare('DELETE FROM gitlab_manual_sync_status WHERE repository_id=?').run(repositoryId);
  }

  activity(sequence: number, completedAt: string, includeHistory: boolean, results: readonly GitlabSyncRepositoryResult[]): void {
    for (const result of results) {
      const { projectId, counts, historyLimits } = result;
      const summary = { projectId, counts, ...(historyLimits ? { historyLimits } : {}) };
      const outcome: GitlabSyncRepositoryResult = result.status === 'ok' ? { ...summary, status: 'ok', error: null }
        : { ...summary, status: 'error', error: result.error };
      this.save(projectId, 'activity', sequence, { completedAt, lastSuccessfulAt: null, includeHistory, result: outcome }, result.status === 'ok');
    }
  }

  deployments(repositoryId: number, sequence: number, completedAt: string, outcome: DeploymentOutcome): void {
    this.save(repositoryId, 'deployments', sequence, { ...outcome, completedAt, lastSuccessfulAt: null }, outcome.status === 'ok');
  }

  private save(repositoryId: number, kind: SyncKind, sequence: number, attempt: SyncAttempt, successful: boolean): void {
    const stored = this.get.get(repositoryId, kind) as StoredAttempt | undefined;
    const replaceAttempt = !stored || sequence > stored.sequence;
    const previousSuccess = stored?.successful_sequence ?? null;
    const replaceSuccess = successful && (previousSuccess === null || sequence > previousSuccess);
    if (!replaceAttempt && !replaceSuccess) return;

    const previous = stored ? JSON.parse(stored.json) as SyncAttempt : null;
    const summary = { ...(replaceAttempt ? attempt : previous!),
      lastSuccessfulAt: replaceSuccess ? attempt.completedAt : previous?.lastSuccessfulAt ?? null };
    this.put.run(repositoryId, kind, replaceAttempt ? sequence : stored!.sequence,
      replaceSuccess ? sequence : previousSuccess, JSON.stringify(summary));
  }
}
