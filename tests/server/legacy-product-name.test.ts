import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readMappingFile } from '../../server/migration-mapping.js';
import { SourcePreservationService } from '../../server/source-preservation.js';
import { Store } from '../../server/store.js';
import { currentProductFormat, currentProductId, LEGACY_PRODUCT_ID, withCurrentRelationOrigin } from '../../shared/legacy-name.js';
import type { Issue, IssueRelation } from '../../shared/types.js';
import { adoptLegacyBrowserStorage } from '../../src/lib/legacy-storage.js';

const timestamp = '2026-11-27T10:00:00.000Z';
const legacy = LEGACY_PRODUCT_ID;

function issue(id: string): Issue {
  return {
    id, key: id, projectId: 'team', title: `업무 ${id}`, description: '', type: 'task', status: 'todo', priority: 'medium',
    assigneeId: null, collaboratorIds: [], parentId: null, labels: [], startDate: null, endDate: null, dueDate: null,
    estimate: null, cycle: null, module: null, release: null, createdAt: timestamp, updatedAt: timestamp,
    completedAt: null, version: 1,
  };
}

test('a data directory written before the rename is adopted with its relations under the current origin', t => {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-legacy-name-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const before = new Store(directory);
  new SourcePreservationService(before);
  before.put('projects', { id: 'team', key: 'TEAM', name: 'team', description: '', color: '#112233', createdAt: timestamp });
  before.put('issues', issue('a'));
  before.put('issues', issue('b'));
  const relation = { id: 'rel-1', sourceIssueId: 'a', targetIssueId: 'b', type: 'blocks', version: 1, createdAt: timestamp, origin: legacy };
  before.db.prepare('INSERT INTO issue_relations(id,source_issue_id,target_issue_id,json) VALUES(?,?,?,?)')
    .run(relation.id, relation.sourceIssueId, relation.targetIssueId, JSON.stringify(relation));
  before.db.exec(`CREATE UNIQUE INDEX issue_relations_${legacy}_pair ON issue_relations(source_issue_id,target_issue_id)`);
  before.db.close();
  renameSync(join(directory, 'donefac.sqlite'), join(directory, `${legacy}.sqlite`));

  const after = new Store(directory);
  t.after(() => after.db.close());
  new SourcePreservationService(after);
  assert.equal(existsSync(join(directory, `${legacy}.sqlite`)), false);
  assert.equal(existsSync(join(directory, 'donefac.sqlite')), true);
  assert.equal(after.get<IssueRelation>('issue_relations', 'rel-1')?.origin, 'donefac');
  const indexes = after.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='issue_relations'").all()
    .map(row => (row as { name: string }).name);
  assert.ok(indexes.includes('issue_relations_donefac_pair'));
  assert.ok(!indexes.includes(`issue_relations_${legacy}_pair`));
});

test('legacy identifiers in imported files map to the current product name', () => {
  assert.equal(currentProductId(legacy), 'donefac');
  assert.equal(currentProductId('docmost'), 'docmost');
  assert.equal(currentProductFormat(`${legacy}-migration-mapping`), 'donefac-migration-mapping');
  assert.equal(currentProductFormat('docmost-metadata'), 'docmost-metadata');
  assert.deepEqual(withCurrentRelationOrigin({ id: 'r', origin: legacy }), { id: 'r', origin: 'donefac' });
  const imported: { id: string; origin?: unknown } = { id: 'r' };
  assert.equal(withCurrentRelationOrigin(imported), imported);
  const mapping = { format: `${legacy}-migration-mapping`, version: 1, configuration: {}, mappedUsers: {},
    packages: [{ id: 'pkg-1', sha256: 'a'.repeat(64), product: 'jira', instanceKey: 'jira-main', format: 'jira-json' }] };
  assert.equal(readMappingFile(mapping).format, 'donefac-migration-mapping');
});

test('browser drafts stored under legacy keys move to the current keys without overwriting newer ones', () => {
  const values = new Map<string, string>([
    [`${legacy}:document-draft:user:doc`, 'old draft'],
    [`${legacy}.actor`, 'user-seo'],
    [`${legacy}:comment-draft:1\nkey`, 'comment'],
    [`${legacy}:issue-comment-draft:1:x`, 'stale'],
    ['donefac:issue-comment-draft:1:x', 'current'],
    ['unrelated', 'kept'],
  ]);
  const storage = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  } satisfies Storage;
  adoptLegacyBrowserStorage(storage);
  assert.equal(values.get('donefac:document-draft:user:doc'), 'old draft');
  assert.equal(values.get('donefac.actor'), 'user-seo');
  assert.equal(values.get('donefac:comment-draft:1\nkey'), 'comment');
  assert.equal(values.get('donefac:issue-comment-draft:1:x'), 'current');
  assert.equal(values.get(`${legacy}:issue-comment-draft:1:x`), 'stale');
  assert.equal(values.has(`${legacy}:document-draft:user:doc`), false);
  assert.equal(values.get('unrelated'), 'kept');
});
