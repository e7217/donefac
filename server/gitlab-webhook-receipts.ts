import { createHash } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import type { GitlabWebhookDelivery } from '../shared/types.js';
import type { Store } from './store.js';

const MAX_RECEIPTS = 10_000;
const RECEIPT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MESSAGE_DIGEST = /^[a-f\d]{64}$/u;

export interface GitlabWebhookReceiptScope {
  instance: string;
  repositoryId: number;
  event: GitlabWebhookDelivery['event'];
  receiverUrl: string;
}

function scopeDigest({ instance, repositoryId, event, receiverUrl }: GitlabWebhookReceiptScope): string {
  return createHash('sha256').update(JSON.stringify([instance, repositoryId, event, receiverUrl])).digest('hex');
}

function cutoff(): string {
  return new Date(Date.now() - RECEIPT_AGE_MS).toISOString();
}

/** Call writes inside the transaction that commits the authenticated delivery or settings change. */
export class GitlabWebhookReceipts {
  private readonly insert: StatementSync;
  private readonly find: StatementSync;
  private readonly deleteExpired: StatementSync;
  private readonly deleteOverflow: StatementSync;

  constructor(private readonly store: Store) {
    const { db } = store;
    db.exec(`CREATE TABLE IF NOT EXISTS gitlab_webhook_receipts (
      id INTEGER PRIMARY KEY,
      scope_digest TEXT NOT NULL,
      message_digest TEXT NOT NULL,
      repository_id INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      delivery TEXT NOT NULL,
      UNIQUE(scope_digest, message_digest)
    );
    CREATE INDEX IF NOT EXISTS gitlab_webhook_receipts_repository ON gitlab_webhook_receipts(repository_id);
    CREATE INDEX IF NOT EXISTS gitlab_webhook_receipts_received ON gitlab_webhook_receipts(received_at DESC,id DESC);`);
    this.insert = db.prepare(`INSERT INTO gitlab_webhook_receipts(scope_digest,message_digest,repository_id,received_at,delivery)
      VALUES(?,?,?,?,?) ON CONFLICT(scope_digest,message_digest) DO NOTHING`);
    this.find = db.prepare(`SELECT delivery FROM gitlab_webhook_receipts
      WHERE scope_digest=? AND message_digest=? AND received_at>?`);
    this.deleteExpired = db.prepare('DELETE FROM gitlab_webhook_receipts WHERE received_at<=?');
    this.deleteOverflow = db.prepare(`DELETE FROM gitlab_webhook_receipts WHERE id IN (
      SELECT id FROM gitlab_webhook_receipts ORDER BY received_at DESC,id DESC LIMIT -1 OFFSET ?
    )`);
    this.deleteExpired.run(cutoff());
  }

  remember(scope: GitlabWebhookReceiptScope, digest: string, delivery: GitlabWebhookDelivery): void {
    const { event, authentication, receivedAt, duplicate, linked, automationRuns, deploymentUpdated, stateAutomation } = delivery;
    if (scope.event !== event || event === 'other' || !MESSAGE_DIGEST.test(digest)) return;
    const threshold = cutoff();
    if (receivedAt <= threshold) return;
    this.deleteExpired.run(threshold);
    // Retain the first summary, including whether that authenticated request was already a duplicate.
    const summary: GitlabWebhookDelivery = { event, authentication, receivedAt, duplicate, linked, automationRuns,
      ...(deploymentUpdated ? { deploymentUpdated } : {}), ...(stateAutomation ? { stateAutomation } : {}) };
    const result = this.insert.run(scopeDigest(scope), digest, scope.repositoryId, receivedAt, JSON.stringify(summary));
    if (result.changes) this.deleteOverflow.run(MAX_RECEIPTS);
  }

  match(scope: GitlabWebhookReceiptScope, digest: string): GitlabWebhookDelivery | null {
    if (scope.event === 'other' || !MESSAGE_DIGEST.test(digest)) return null;
    const row = this.find.get(scopeDigest(scope), digest, cutoff()) as { delivery: string } | undefined;
    return row ? JSON.parse(row.delivery) as GitlabWebhookDelivery : null;
  }

  clear(repositoryId?: number): void {
    if (repositoryId === undefined) this.store.db.exec('DELETE FROM gitlab_webhook_receipts');
    else this.store.db.prepare('DELETE FROM gitlab_webhook_receipts WHERE repository_id=?').run(repositoryId);
  }
}
