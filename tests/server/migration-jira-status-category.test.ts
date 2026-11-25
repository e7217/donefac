import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildMigrationOptions, buildMigrationPlan } from '../../server/migration-planner.js';
import { parseJira } from '../../server/legacy-import-jira.js';
import type { MigrationPackage } from '../../server/migration-contracts.js';
import type { MigrationConfiguration } from '../../shared/types.js';

const now = '2026-11-25T03:00:00Z';
const createdAt = '2026-10-01T04:00:00Z';
const completedAt = '2026-10-02T04:00:00Z';
const actor = { id: 'actor', name: '검토자', email: 'reviewer@example.test', color: '#123456' };

function source(id: string, filename: string, body: string, instanceKey = 'team-jira'): MigrationPackage {
  const bytes = Buffer.from(body);
  const dataset = parseJira(new Map([[filename, bytes]]), instanceKey);
  return { dataset, summary: { id, filename, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
    actorId: actor.id, source: dataset.source, version: 1, createdAt: now, counts: {}, errors: 0, warnings: 0,
    fileCount: 1, expandedBytes: bytes.length, applySupported: false } };
}

function rest(id: string, statuses: { id?: string; name: string; statusCategory?: { id?: number; key?: string } }[], instanceKey?: string, offset = 0) {
  const issues = statuses.map((status, index) => ({ id: String(100 + offset * 10 + index), key: `JIRA${offset}-${index + 1}`, fields: {
    project: { id: String(500 + offset), key: `JIRA${offset}`, name: '원본 Jira' }, summary: status.name, status, issuetype: { id: '700', name: 'Task' },
    created: createdAt, updated: now, resolutiondate: completedAt,
  }, changelog: { startAt: 0, total: 0, histories: [] } }));
  return source(id, 'issues.json', JSON.stringify({ startAt: 0, total: issues.length, issues }), instanceKey);
}

function review(packages: MigrationPackage[], configuration: MigrationConfiguration = buildMigrationOptions(packages).defaultConfiguration) {
  configuration.projects = configuration.projects.map((project, index) => ({ ...project, key: `T${index + 1}` }));
  return buildMigrationPlan({ id: 'category-review', configuration, now, actorId: actor.id, users: [actor], existingProjectKeys: [], packages });
}

function statusesByLabel(packages: MigrationPackage[]) {
  const options = buildMigrationOptions(packages);
  return Object.fromEntries(options.statuses.map(option => [option.label, options.defaultConfiguration.statuses[option.id]]));
}

test('Jira REST status categories govern imported work while retaining compatible local refinements', () => {
  const pkg = rest('rest', [
    { id: '1001', name: 'Shipped', statusCategory: { key: 'done', id: 3 } },
    { id: '1002', name: 'Quality Check', statusCategory: { key: 'indeterminate', id: 4 } },
    { id: '1003', name: 'Closed for Draft', statusCategory: { key: 'new', id: 2 } },
    { id: '1004', name: '개발 검토', statusCategory: { key: 'indeterminate' } },
    { id: '1005', name: '취소', statusCategory: { key: 'done', id: 3 } },
    { id: '1006', name: 'Backlog', statusCategory: { key: 'new', id: 2 } },
    { id: '1007', name: '이전 완료', statusCategory: { key: 'undefined', id: 1 } },
    { name: '식별자 없는 완료', statusCategory: { key: 'new', id: 2 } },
  ]);
  const expected = { Shipped: 'done', 'Quality Check': 'in_progress', 'Closed for Draft': 'todo', '개발 검토': 'review',
    '취소': 'cancelled', Backlog: 'backlog', '이전 완료': 'done', '식별자 없는 완료': 'done' };
  assert.deepEqual(statusesByLabel([pkg]), expected);
  const plan = review([pkg]);
  assert.equal(plan.preview.canApply, true, JSON.stringify(plan.preview.notices));
  assert.deepEqual(Object.fromEntries(plan.workflows[0].statuses.map(status => [status.label, status.category])), expected);
  assert.equal(plan.issues.find(issue => issue.title === 'Shipped')?.completedAt, new Date(completedAt).toISOString());
  assert.equal(plan.issues.find(issue => issue.title === 'Closed for Draft')?.completedAt, null);

  const options = buildMigrationOptions([pkg]);
  const shipped = options.statuses.find(status => status.label === 'Shipped')!;
  options.defaultConfiguration.statuses[shipped.id] = 'todo';
  const overridden = review([pkg], options.defaultConfiguration);
  assert.equal(overridden.preview.canApply, true, JSON.stringify(overridden.preview.notices));
  assert.equal(overridden.workflows[0].statuses.find(status => status.label === 'Shipped')?.category, 'todo');
  assert.equal(overridden.issues.find(issue => issue.title === 'Shipped')?.completedAt, null);
  assert.ok(overridden.preview.requiredAcknowledgements.includes('JIRA_STATUS_CATEGORY_OVERRIDE'));
});

test('native search and administrator XML statuses use their exact source IDs and retain label-only fallback', () => {
  const search = source('search', 'search.xml', `<rss><channel>
    <item><project id="500" key="JIRA">원본 Jira</project><key id="101">JIRA-1</key><summary>현장 완료</summary>
      <created>${createdAt}</created><updated>${now}</updated><resolved>${completedAt}</resolved><type id="700">Task</type><status id="1001">Shipped</status>
      <statusCategory id="3" key="done" colorName="green"/></item>
    <item><project id="500" key="JIRA">원본 Jira</project><key id="102">JIRA-2</key><summary>검증 중</summary>
      <created>${now}</created><updated>${now}</updated><type id="700">Task</type><status id="1002">Quality Check</status>
      <statusCategory id="4" key="indeterminate"/></item>
    <item><project id="500" key="JIRA">원본 Jira</project><key id="103">JIRA-3</key><summary>날짜 대기</summary>
      <created>${now}</created><updated>${now}</updated><type id="700">Task</type><status id="1003">Closed for Draft</status>
      <statusCategory id="2" key="new"/><statusCategory id="3" key="done"/></item>
  </channel></rss>`);
  const backup = source('backup', 'entities.xml', `<entity-engine-xml>
    <Project id="500" pkey="JIRA" name="원본 Jira"/><IssueType id="700" pname="Task"/>
    <Status id="1004" pname="Published" statuscategory="3"/><Status id="1005" pname="검토"/>
    <Issue id="201" project="500" number="11" summary="출시 업무" status="1004" issuetype="700" created="${now}" updated="${now}"/>
    <Issue id="202" project="500" number="12" summary="검토 업무" status="1005" issuetype="700" created="${now}" updated="${now}"/>
  </entity-engine-xml>`);
  assert.deepEqual(statusesByLabel([search]), { Shipped: 'done', 'Quality Check': 'in_progress', 'Closed for Draft': undefined });
  assert.deepEqual(statusesByLabel([backup]), { Published: 'done', '검토': 'review' });
  const notReady = review([search]);
  assert.equal(notReady.preview.canApply, false);
  assert.ok(notReady.preview.notices.some(notice => notice.code === 'JIRA_STATUS_CATEGORY_CONFLICT' && notice.severity === 'error'));
  const searchOptions = buildMigrationOptions([search]);
  const disputed = searchOptions.statuses.find(status => status.label === 'Closed for Draft')!;
  searchOptions.defaultConfiguration.statuses[disputed.id] = 'todo';
  const reviewed = review([search], searchOptions.defaultConfiguration);
  assert.equal(reviewed.preview.canApply, true, JSON.stringify(reviewed.preview.notices));
  assert.equal(reviewed.issues.find(issue => issue.title === '현장 완료')?.completedAt, new Date(completedAt).toISOString());
  assert.equal(review([backup]).preview.canApply, true);
  assert.deepEqual(statusesByLabel([source('csv', 'issues.csv', 'Issue key,Summary,Status,Issue Type\nCSV-1,이전 업무,Closed,Task\n')]), { Closed: 'done' });
});

test('disagreeing Jira categories leave the mapping unselected until specifically reviewed', () => {
  const first = rest('first', [{ id: '1001', name: 'Shipped', statusCategory: { key: 'done', id: 3 } }]);
  const later = rest('later', [{ id: '1001', name: 'Draft', statusCategory: { key: 'new', id: 2 } }], 'team-jira', 1);
  const differentSource = rest('different', [{ id: '1001', name: 'Ready for Review', statusCategory: { key: 'indeterminate', id: 4 } }], 'other-jira');
  const contradictory = rest('malformed', [{ id: '3000', name: '완료', statusCategory: { key: 'done', id: 2 } }], 'team-jira', 2);
  const packages = [first, later, differentSource, contradictory];
  const options = buildMigrationOptions(packages);
  assert.deepEqual(statusesByLabel(packages), { Shipped: undefined, Draft: undefined, 'Ready for Review': 'review', '완료': undefined });
  const missing = review(packages, structuredClone(options.defaultConfiguration));
  assert.equal(missing.preview.canApply, false);
  assert.equal(missing.preview.notices.filter(notice => notice.code === 'JIRA_STATUS_CATEGORY_CONFLICT' && notice.severity === 'error').length, 3);
  for (const status of options.statuses) options.defaultConfiguration.statuses[status.id] ??= 'done';
  const explicitlyMapped = review(packages, options.defaultConfiguration);
  assert.equal(explicitlyMapped.preview.canApply, true, JSON.stringify(explicitlyMapped.preview.notices));
  assert.ok(explicitlyMapped.preview.requiredAcknowledgements.includes('JIRA_STATUS_CATEGORY_CONFLICT'));
  assert.equal(explicitlyMapped.preview.notices.filter(notice => notice.code === 'JIRA_STATUS_CATEGORY_CONFLICT' && notice.severity === 'warning').length, 3);
});

test('a new Jira project starts in an active status despite terminal source rows coming first', () => {
  const shipped = { id: '1001', name: 'Shipped', statusCategory: { key: 'done', id: 3 } };
  const reviewStatus = { id: '1002', name: 'Review', statusCategory: { key: 'indeterminate', id: 4 } };
  const progress = { id: '1003', name: 'Working', statusCategory: { key: 'indeterminate', id: 4 } };
  const backlog = { id: '1004', name: 'Backlog', statusCategory: { key: 'new', id: 2 } };
  const open = { id: '1005', name: 'Open', statusCategory: { key: 'new', id: 2 } };
  for (const [statuses, expected] of [
    [[shipped, reviewStatus, progress, backlog, open], 'Open'],
    [[shipped, reviewStatus, progress, backlog], 'Backlog'],
    [[shipped, reviewStatus, progress], 'Review'],
    [[shipped, progress, reviewStatus], 'Working'],
    [[shipped], 'Shipped'],
  ] as const) {
    const apply = review([rest('initial', [...statuses])]);
    assert.equal(apply.preview.canApply, true, JSON.stringify(apply.preview.notices));
    const workflow = apply.workflows[0];
    assert.equal(workflow.statuses.find(status => status.id === workflow.initialStatusId)?.label, expected);
  }
});
