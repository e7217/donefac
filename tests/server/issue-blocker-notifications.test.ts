import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { IssueBlockerNotifications } from '../../server/issue-blocker-notifications.js';
import { SourcePreservationService } from '../../server/source-preservation.js';
import { Store } from '../../server/store.js';
import type { Issue, IssueRelation, ProjectWorkflow } from '../../shared/types.js';
import { defaultWorkflow } from '../../shared/workflow-helpers.js';

const timestamp = '2026-11-20T10:11:12.000Z';
const actor = 'member';
const projectId = 'team';
const otherProjectId = 'other';
const event = (id: string, kind: 'issue-block-added' | 'issue-block-resolved', detail: string) =>
  ({ id, actor, kind, createdAt: timestamp, detail });

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-blocker-notifications-'));
  const store = new Store(directory);
  t.after(() => { store.db.close(); rmSync(directory, { recursive: true, force: true }); });
  new SourcePreservationService(store);
  for (const id of [projectId, otherProjectId]) {
    store.put('projects', { id, key: id.toUpperCase(), name: id, description: '', color: '#112233', createdAt: timestamp });
  }
  const workflow = defaultWorkflow(projectId);
  const workflows = new Map<string, ProjectWorkflow>([[projectId, {
    ...workflow,
    statuses: [...workflow.statuses,
      { id: 'shipped', category: 'done', color: '#112233', label: '출시' },
      { id: 'paused', category: 'review', color: '#112233', label: '재검토' },
    ],
  }]]);
  const getWorkflow = (id: string) => workflows.get(id) ?? defaultWorkflow(id);
  const captured: ReturnType<typeof event>[] = [];
  const notifications = new IssueBlockerNotifications(store, getWorkflow, (issue, actor, kind, createdAt, detail) => {
    captured.push({ id: issue.id, actor, kind, createdAt, detail });
  });
  function issue(key: string, overrides: Partial<Issue> = {}) {
    const value: Issue = {
      id: key, key, projectId, title: `업무 ${key}`, description: '', type: 'task', status: 'todo', priority: 'medium',
      assigneeId: null, collaboratorIds: [], parentId: null, labels: [], startDate: null, endDate: null, dueDate: null,
      estimate: null, cycle: null, module: null, release: null, createdAt: timestamp, updatedAt: timestamp,
      completedAt: null, version: 1, ...overrides,
    };
    store.put('issues', value);
    return value;
  }
  function putRelation(value: IssueRelation) {
    store.db.prepare(`INSERT INTO issue_relations(id,source_issue_id,target_issue_id,json) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET source_issue_id=excluded.source_issue_id,target_issue_id=excluded.target_issue_id,json=excluded.json`)
      .run(value.id, value.sourceIssueId, value.targetIssueId, JSON.stringify(value));
  }
  function changeRelation(before: IssueRelation | undefined, after: IssueRelation | undefined) {
    store.transaction(() => {
      if (before && before.id !== after?.id) store.remove('issue_relations', before.id);
      if (after) putRelation(after);
      notifications.relationChanged(before, after, actor, timestamp);
    });
  }
  function changeIssue(before: Issue, changes: Partial<Issue>) {
    const after = { ...before, ...changes };
    store.transaction(() => {
      store.put('issues', after);
      notifications.sourceStatusChanged(before, after, actor, timestamp);
    });
    return after;
  }
  return { store, getWorkflow, captured, notifications, issue, putRelation, changeRelation, changeIssue };
}

function relation(source: Issue, target: Issue, changes: Partial<IssueRelation> = {}): IssueRelation {
  return {
    id: `${source.id}:${target.id}`, sourceIssueId: source.id, targetIssueId: target.id,
    origin: 'donefac', type: 'blocks', version: 1, createdAt: timestamp, ...changes,
  };
}

test('relation changes emit cause-specific notifications after saves and direction reversals', t => {
  const f = fixture(t);
  const source = f.issue('TEAM-1', { title: '첫 줄\r\n둘째 줄\t메모\u0085완료' });
  const target = f.issue('OTHER-2', { projectId: otherProjectId });
  const another = f.issue('TEAM-3');
  f.putRelation(relation(another, target));

  const related = relation(target, source, { type: 'related' });
  const first = { ...related, type: 'blocks', version: 2, sourceIssueId: source.id, targetIssueId: target.id };
  const samePair = { ...first, version: 3 };
  const reversed = { ...samePair, version: 4, sourceIssueId: target.id, targetIssueId: source.id };
  const duplicate = { ...reversed, version: 5, type: 'duplicates' };
  f.changeRelation(undefined, related);
  f.changeRelation(related, first);
  f.changeRelation(first, samePair);
  f.changeRelation(samePair, reversed);
  f.changeRelation(reversed, duplicate);
  f.changeRelation(duplicate, undefined);
  assert.deepEqual(f.captured, [
    event(target.id, 'issue-block-added', 'TEAM-1 첫 줄 둘째 줄 메모 완료'),
    event(target.id, 'issue-block-resolved', 'TEAM-1 첫 줄 둘째 줄 메모 완료'),
    event(source.id, 'issue-block-added', 'OTHER-2 업무 OTHER-2'),
    event(source.id, 'issue-block-resolved', 'OTHER-2 업무 OTHER-2'),
  ]);
  assert.ok(f.store.get('issue_relations', relation(another, target).id));
  assert.ok(f.captured.every(value => !/\p{Cc}/u.test(value.detail)));
});

test('a legacy issue key can be shortened without dropping its title or exceeding the detail limit', t => {
  const f = fixture(t);
  const source = f.issue('TEAM-1', { key: '업무📋'.repeat(170), title: '보존할 원인 업무 제목' });
  const target = f.issue('TEAM-2');
  f.changeRelation(undefined, relation(source, target));
  f.changeIssue(source, { status: 'shipped' });
  assert.equal(f.captured.length, 2);
  assert.ok(f.captured.every(item => item.detail.length <= 500 && item.detail.isWellFormed() && item.detail.endsWith(`… ${source.title}`)));
  assert.match(f.captured[1].detail, /^원인 업무 종료 · /);
});

test('relation notifications skip legacy and canonical relations without two active endpoints', t => {
  const f = fixture(t);
  const source = f.issue('TEAM-1');
  const target = f.issue('TEAM-2');
  const closed = f.issue('TEAM-3', { status: 'shipped' });
  const cancelled = f.issue('OTHER-4', { projectId: otherProjectId, status: 'cancelled' });
  for (const value of [
    relation(source, target, { origin: undefined }),
    relation(source, target, { origin: undefined, type: 'Is Blocked By' }),
    relation(closed, target),
    relation(source, cancelled),
    relation(source, source),
  ]) {
    f.changeRelation(undefined, value);
    f.changeRelation(value, undefined);
  }
  const nowMissing = relation(source, target);
  f.putRelation(nowMissing);
  f.store.remove('issues', source.id);
  f.notifications.relationChanged(nowMissing, undefined, actor, timestamp);
  assert.deepEqual(f.captured, []);
});

test('terminal status changes notify only active outgoing targets and retain other unresolved causes', t => {
  const f = fixture(t);
  const source = f.issue('TEAM-1');
  const target = f.issue('TEAM-2');
  const crossProject = f.issue('OTHER-3', { projectId: otherProjectId });
  const unrelated = f.issue('TEAM-4');
  const legacyTarget = f.issue('TEAM-5');
  const otherCause = f.issue('TEAM-6');
  const closedTarget = f.issue('TEAM-7', { status: 'shipped' });
  for (const value of [
    relation(source, target),
    relation(source, crossProject),
    relation(source, closedTarget),
    relation(otherCause, target),
    relation(source, unrelated, { type: 'related' }),
    relation(source, legacyTarget, { origin: undefined }),
    relation(legacyTarget, source),
  ]) f.putRelation(value);

  const stillOpen = f.changeIssue(source, { status: 'paused' });
  const closed = f.changeIssue(stillOpen, { status: 'shipped', title: '차단 원인\n수정' });
  const stillClosed = f.changeIssue(closed, { status: 'cancelled' });
  f.changeIssue(stillClosed, { status: 'in_progress' });
  assert.deepEqual(f.captured, [
    event(crossProject.id, 'issue-block-resolved', '원인 업무 종료 · TEAM-1 차단 원인 수정'),
    event(target.id, 'issue-block-resolved', '원인 업무 종료 · TEAM-1 차단 원인 수정'),
    event(crossProject.id, 'issue-block-added', '원인 업무 재개 · TEAM-1 차단 원인 수정'),
    event(target.id, 'issue-block-added', '원인 업무 재개 · TEAM-1 차단 원인 수정'),
  ]);
  assert.ok(f.store.get('issue_relations', relation(otherCause, target).id));
});

test('a blocker notification failure rolls back the originating mutation in the caller transaction', t => {
  const f = fixture(t);
  const source = f.issue('TEAM-1');
  const target = f.issue('TEAM-2');
  const value = relation(source, target);
  const service = new IssueBlockerNotifications(f.store, f.getWorkflow, () => {
    f.store.setSetting('test.block-notification', true);
    throw new Error('synthetic notification failure');
  });
  assert.throws(() => f.store.transaction(() => {
    f.putRelation(value);
    service.relationChanged(undefined, value, actor, timestamp);
  }), /synthetic notification failure/);
  assert.equal(f.store.get('issue_relations', value.id), undefined);
  assert.equal(f.store.setting('test.block-notification'), null);
});
