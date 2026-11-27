import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { GitlabWebhookDelivery } from '../../shared/types.js';
import { GitlabWebhookReceipts, type GitlabWebhookReceiptScope } from '../../server/gitlab-webhook-receipts.js';
import { Store } from '../../server/store.js';

const scope: GitlabWebhookReceiptScope = {
  instance: 'https://git.example.test', repositoryId: 23, event: 'pipeline',
  receiverUrl: 'https://donefac.example.test/api/integrations/gitlab/webhook',
};
const digest = (message: string) => createHash('sha256').update(message).digest('hex');
const id = digest('internal-message-id');
const week = 7 * 24 * 60 * 60 * 1000;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'donefac-webhook-receipts-'));
  let store = new Store(dir);
  let receipts = new GitlabWebhookReceipts(store);
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get store() { return store; },
    get receipts() { return receipts; },
    reopen() {
      store.db.close();
      store = new Store(dir);
      receipts = new GitlabWebhookReceipts(store);
    },
  };
}

function delivery(changes: Partial<GitlabWebhookDelivery> = {}): GitlabWebhookDelivery {
  return { event: 'pipeline', authentication: 'signing-token', receivedAt: new Date(Date.now()).toISOString(),
    duplicate: false, linked: 1, automationRuns: 2, ...changes };
}

test('matches a digest only within the exact scope and keeps the original successful receipt after restart', t => {
  const f = fixture(t);
  const accepted = delivery({ stateAutomation: { result: 'evaluated', trigger: 'pipeline.failed', occurredAt: '2024-06-05T06:07:08.000Z',
    candidateTickets: 3, outcomes: { changed: 0, no_op: 0, blocked: 0, ignored: 2 },
    heldEvent: { disposition: 'stale', reason: '최신 파이프라인 결과를 유지했습니다.' } } });
  const envelope = { ...accepted, headers: { 'webhook-id': 'internal-message-id', 'x-gitlab-token': 'private-header-value' } };
  f.store.transaction(() => f.receipts.remember(scope, id, envelope));
  f.store.transaction(() => f.receipts.remember(scope, id, delivery({ duplicate: true, linked: 0, automationRuns: 0 })));
  f.reopen();

  assert.deepEqual(f.receipts.match(scope, id), accepted);
  assert.equal(f.receipts.match(scope, digest('another-message')), null);
  for (const different of [
    { ...scope, instance: 'https://other-git.example.test' },
    { ...scope, repositoryId: 24 },
    { ...scope, receiverUrl: 'https://other-donefac.example.test/api/integrations/gitlab/webhook' },
    { ...scope, event: 'push' },
  ] as const) assert.equal(f.receipts.match(different, id), null);
  const columns = f.store.db.prepare('SELECT * FROM gitlab_webhook_receipts').all();
  assert.equal(columns.length, 1);
  assert.doesNotMatch(JSON.stringify(columns), /internal-message-id|private-header-value|donefac\.example|git\.example/u);

  f.receipts.remember(scope, 'unhashed-message-id', accepted);
  f.receipts.remember(scope, digest('mismatched-kind'), delivery({ event: 'push' }));
  f.receipts.remember({ ...scope, event: 'other' }, digest('unsupported-kind'), delivery({ event: 'other' }));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM gitlab_webhook_receipts').get()?.count, 1);
  const rolledBack = digest('uncommitted-message');
  assert.throws(() => f.store.transaction(() => {
    f.receipts.remember(scope, rolledBack, accepted);
    throw new Error('webhook transaction failed');
  }), /transaction failed/u);
  assert.equal(f.receipts.match(scope, rolledBack), null);
});

test('expires first receipt evidence at seven days and starts a new window when a retry authenticates', t => {
  const f = fixture(t);
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const accepted = delivery();
  f.receipts.remember(scope, id, accepted);
  clock += week - 1;
  const duplicate = delivery({ duplicate: true, linked: 0, automationRuns: 0 });
  f.receipts.remember(scope, id, duplicate);
  assert.deepEqual(f.receipts.match(scope, id), accepted);

  clock++;
  assert.equal(f.receipts.match(scope, id), null);
  const authenticatedAgain = delivery({ duplicate: true, linked: 0, automationRuns: 0 });
  f.receipts.remember(scope, id, authenticatedAgain);
  assert.deepEqual(f.receipts.match(scope, id), authenticatedAgain);

  const otherRepository = { ...scope, repositoryId: 24 };
  f.receipts.remember(otherRepository, id, authenticatedAgain);
  f.receipts.clear(scope.repositoryId);
  assert.equal(f.receipts.match(scope, id), null);
  assert.deepEqual(f.receipts.match(otherRepository, id), authenticatedAgain);
  f.receipts.clear();
  assert.equal(f.receipts.match(otherRepository, id), null);
});

test('bounds workspace-wide receipts and evicts the oldest on insertion', t => {
  const f = fixture(t);
  const old = delivery({ receivedAt: new Date(Date.now() - 60_000).toISOString() });
  const recent = delivery();
  f.receipts.remember(scope, id, old);
  f.store.db.prepare(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<9999)
    INSERT INTO gitlab_webhook_receipts(scope_digest,message_digest,repository_id,received_at,delivery)
    SELECT ?,printf('%064x',n),24,?,? FROM ids`).run('0'.repeat(64), recent.receivedAt, JSON.stringify(recent));
  const newId = digest('new-message');
  f.receipts.remember(scope, newId, recent);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM gitlab_webhook_receipts').get()?.count, 10_000);
  assert.equal(f.receipts.match(scope, id), null);
  assert.deepEqual(f.receipts.match(scope, newId), recent);
});
