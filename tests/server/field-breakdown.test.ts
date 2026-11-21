import assert from 'node:assert/strict';
import test from 'node:test';
import type { CustomFieldDefinition, CustomFieldKind, Issue, User } from '../../shared/types.js';
import { buildIssueFieldBreakdown, FieldBreakdownError } from '../../server/field-breakdown.js';

const now = '2026-11-19T00:00:00.000Z';
const users: User[] = [
  { id: 'alice', name: '같은 이름', email: 'alice@example.test', color: '#112233' },
  { id: 'bob', name: '같은 이름', email: 'bob@example.test', color: '#445566' },
];
function field(kind: CustomFieldKind = 'text', extra: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: 'attribute', name: '집계 필드', description: '', kind, required: false, issueTypes: [], archived: false,
    options: [{ id: 'a', name: '첫 선택', archived: false }, { id: 'b', name: '보관된 선택', archived: true }],
    ...extra,
  };
}
function issue(id: string, value?: Issue['customFields'], extra: Partial<Issue> = {}): Issue {
  return {
    id, projectId: 'p', key: `P-${id}`, title: `업무 ${id}`, description: '', type: 'incident', status: 'todo',
    priority: 'medium', assigneeId: null, collaboratorIds: [], parentId: null, labels: [],
    startDate: null, endDate: null, dueDate: null, estimate: null, cycle: null, module: null, release: null,
    version: 1, createdAt: now, updatedAt: now, completedAt: null, customFields: value, ...extra,
  };
}
function input(kind: CustomFieldKind, issues: Issue[], extra: Partial<Parameters<typeof buildIssueFieldBreakdown>[0]> = {}) {
  return { projectId: 'p', field: field(kind), issues, users, savedView: null, schemaVersion: 1, generatedAt: now, ...extra };
}
const values = (result: ReturnType<typeof buildIssueFieldBreakdown>) => result.report.groups.filter(bucket => bucket.kind === 'value');
const status = (expected: number) => (error: unknown) => error instanceof FieldBreakdownError && error.status === expected;

test('population separates missing and nonapplicable issues and retains zero with finite numeric statistics', () => {
  const result = buildIssueFieldBreakdown(input('number', [
    issue('1', { attribute: 0 }), issue('2', { attribute: 5 }), issue('3', { attribute: null }),
    issue('4'), issue('5', { attribute: 7 }, { type: 'request' }), issue('6', { attribute: '' }),
  ], { field: field('number', { issueTypes: ['incident'] }) }));
  assert.equal(result.report.totalIssues, 6);
  assert.equal(result.report.applicableIssues, 5);
  assert.equal(result.report.populatedIssues, 2);
  assert.equal(result.report.missingIssues, 3);
  assert.equal(result.report.notApplicableIssues, 1);
  assert.deepEqual(result.report.numeric, { min: 0, max: 5, average: 2.5, sum: 5 });
  assert.deepEqual(result.report.groups.slice(-2), [
    { id: 'missing', label: '값 없음', kind: 'missing', count: 3 },
    { id: 'not-applicable', label: '유형 미적용', kind: 'not_applicable', count: 1 },
  ]);
  assert.deepEqual(result.issuesByBucket.get('missing')!.map(item => item.id), ['3', '4', '6']);
  assert.deepEqual(result.issuesByBucket.get('not-applicable')!.map(item => item.id), ['5']);
  for (const bucket of result.report.groups) assert.equal(result.issuesByBucket.get(bucket.id)!.length, bucket.count);
});

test('false is populated and labels use the shared checkbox formatting rather than truthiness', () => {
  const result = buildIssueFieldBreakdown(input('checkbox', [issue('1', { attribute: false }), issue('2', { attribute: true }), issue('3')]));
  assert.equal(result.report.populatedIssues, 2);
  assert.equal(result.report.numeric, null);
  assert.deepEqual(new Set(values(result).map(bucket => bucket.label)), new Set(['예', '아니요']));
  assert.equal(result.report.missingIssues, 1);
});

test('multi-select counts distinct option memberships once per issue and keeps complete sorted drilldown rows', () => {
  const result = buildIssueFieldBreakdown(input('multi_select', [
    issue('10', { attribute: ['a', 'a', 'b'] }), issue('2', { attribute: ['b'] }), issue('3', { attribute: [] }),
  ]));
  const first = values(result).find(bucket => bucket.label === '첫 선택')!;
  const archived = values(result).find(bucket => bucket.label === '보관된 선택')!;
  assert.equal(first.count, 1);
  assert.equal(archived.count, 2);
  assert.equal(values(result)[0].id, archived.id);
  assert.equal(result.report.populatedIssues, 2);
  assert.equal(result.report.missingIssues, 1);
  assert.deepEqual(result.issuesByBucket.get(archived.id), [
    { id: '2', key: 'P-2', title: '업무 2' }, { id: '10', key: 'P-10', title: '업무 10' },
  ]);
});

test('stable value IDs survive field/option renames and archives while revision detects changed labels', () => {
  const source = input('select', [issue('1', { attribute: 'b' })]);
  const before = buildIssueFieldBreakdown(source);
  const renamed = structuredClone(source);
  renamed.field.name = '변경된 필드';
  renamed.field.archived = true;
  renamed.field.options[1].name = '다른 표시 이름';
  const after = buildIssueFieldBreakdown(renamed);
  assert.equal(values(before)[0].id, values(after)[0].id);
  assert.equal(values(after)[0].label, '다른 표시 이름');
  assert.equal(after.report.field.archived, true);
  assert.notEqual(after.report.revision, before.report.revision);
  const identities = [
    values(buildIssueFieldBreakdown(input('text', [issue('1', { attribute: '0' })])))[0].id,
    values(buildIssueFieldBreakdown(input('number', [issue('1', { attribute: 0 })])))[0].id,
    values(buildIssueFieldBreakdown(input('checkbox', [issue('1', { attribute: false })])))[0].id,
  ];
  assert.equal(new Set(identities).size, 3);
});

test('duplicate user labels are disambiguated without changing exact value identity; absent historical labels fall back to IDs', () => {
  const result = buildIssueFieldBreakdown(input('user', [issue('1', { attribute: 'alice' }), issue('2', { attribute: 'bob' }), issue('3', { attribute: 'removed-user' })]));
  assert.equal(new Set(values(result).map(bucket => bucket.label)).size, 3);
  assert.equal(values(result).filter(bucket => bucket.label.startsWith('같은 이름 · ')).length, 2);
  assert.ok(values(result).some(bucket => bucket.label === 'removed-user'));
  const missingOption = buildIssueFieldBreakdown(input('select', [issue('1', { attribute: 'old-option' })]));
  assert.equal(values(missingOption)[0].label, 'old-option');
});

test('reporter dimensions keep explicit blanks and missing records separate in rows, columns and revision fingerprints', () => {
  const reporter = field('user', { id: 'builtin:reporter', name: '요청자', options: [] });
  const issues = [issue('1', {}, { reporterId: 'alice' }), issue('2', {}, { reporterId: 'bob' }),
    issue('3', {}, { reporterId: null }), issue('4')];
  const grouped = input('user', issues, { field: reporter, groupBy: 'reporter' });
  const rows = buildIssueFieldBreakdown(grouped);
  assert.equal(rows.report.populatedIssues, 2);
  assert.equal(rows.report.missingIssues, 2);
  assert.equal(new Set(values(rows).map(bucket => bucket.label)).size, 2);
  assert.deepEqual(rows.report.groups.filter(bucket => bucket.kind === 'missing'), [
    { id: 'missing', label: '미지정', kind: 'missing', count: 1 },
    { id: 'unknown', label: '기록 없음', kind: 'missing', count: 1 },
  ]);
  assert.deepEqual(rows.issuesByBucket.get('missing')?.map(item => item.id), ['3']);
  assert.deepEqual(rows.issuesByBucket.get('unknown')?.map(item => item.id), ['4']);

  const compared = input('select', issues, {
    field: field('select', { id: 'builtin:status', name: '상태', options: [{ id: 'todo', name: '대기', archived: false }] }),
    groupBy: 'status', comparison: { by: 'reporter', field: reporter },
  });
  const columns = buildIssueFieldBreakdown(compared);
  assert.deepEqual(columns.report.comparison?.columns.slice(-2), [
    { id: 'missing', label: '미지정', count: 1 }, { id: 'unknown', label: '기록 없음', count: 1 },
  ]);
  assert.equal(columns.columnByIssue.get('3'), 'missing');
  assert.equal(columns.columnByIssue.get('4'), 'unknown');
  const swapped = [...issues.slice(0, 2), issue('3'), issue('4', {}, { reporterId: null })];
  for (const [source, original] of [[grouped, rows], [compared, columns]] as const) {
    const next = buildIssueFieldBreakdown({ ...source, issues: swapped });
    assert.deepEqual(next.report.groups, original.report.groups);
    assert.deepEqual(next.report.comparison, original.report.comparison);
    assert.notEqual(next.report.revision, original.report.revision);
  }
});

test('long Unicode labels remain bounded and distinguish truncated prefixes and special bucket labels', () => {
  const prefix = '😀'.repeat(180);
  const first = `${prefix}${'a'.repeat(19000)}-first`, second = `${prefix}${'b'.repeat(19000)}-second`;
  const source = input('text', [issue('1', { attribute: first }), issue('2', { attribute: second }), issue('3', { attribute: '값 없음' })]);
  const result = buildIssueFieldBreakdown(source);
  const groups = values(result);
  assert.equal(groups.length, 3);
  assert.equal(new Set(result.report.groups.map(bucket => bucket.label)).size, 5);
  for (const bucket of groups) {
    assert.ok(Array.from(bucket.label).length <= 180);
    assert.match(bucket.id, /^value:[a-f\d]{64}$/);
  }
  const changed = structuredClone(source);
  changed.issues[0].customFields!.attribute = `${first}-hidden-change`;
  const next = buildIssueFieldBreakdown(changed);
  assert.notEqual(next.report.revision, result.report.revision);
  assert.notEqual(values(next).find(bucket => next.issuesByBucket.get(bucket.id)![0].id === '1')!.id,
    groups.find(bucket => result.issuesByBucket.get(bucket.id)![0].id === '1')!.id);
  assert.ok(JSON.stringify(result.report).length < 5000);
});

test('numeric totals handle true overflow, intermediate overflow/cancellation and tiny residuals without Infinity', () => {
  const maximum = Number.MAX_VALUE;
  const cases: [number[], number | null, number][] = [
    [[maximum, maximum], null, maximum],
    [[-maximum, -maximum], null, -maximum],
    [[maximum, maximum, -maximum], maximum, maximum / 3],
    [[maximum, -maximum, 1], 1, 1 / 3],
    [[maximum, -maximum, Number.MIN_VALUE], Number.MIN_VALUE, 0],
    [[maximum, -maximum, Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE], 3 * Number.MIN_VALUE, Number.MIN_VALUE],
    [[1.25, -2.5, 0], -1.25, -1.25 / 3],
    [[-0, 0], 0, 0],
  ];
  for (const [numbers, sum, average] of cases) {
    const result = buildIssueFieldBreakdown(input('number', numbers.map((value, index) => issue(String(index), { attribute: value }))));
    assert.equal(result.report.numeric!.sum, sum);
    assert.equal(result.report.numeric!.average, average);
    assert.ok(Number.isFinite(result.report.numeric!.min));
    assert.ok(Number.isFinite(result.report.numeric!.max));
    assert.ok(Number.isFinite(result.report.numeric!.average));
    assert.deepEqual(buildIssueFieldBreakdown({ ...input('number', []), issues: [...numbers].reverse().map((value, index) => issue(String(index), { attribute: value })) }).report.numeric, result.report.numeric);
  }
});

test('empty/all-inapplicable populations have no fabricated numeric statistics and fixed zero buckets remain available', () => {
  const empty = buildIssueFieldBreakdown(input('number', []));
  assert.equal(empty.report.totalIssues, 0);
  assert.equal(empty.report.numeric, null);
  assert.equal(empty.report.groups.length, 2);
  assert.deepEqual([...empty.issuesByBucket.keys()], ['missing', 'not-applicable']);
  const notApplicable = buildIssueFieldBreakdown(input('number', [issue('1', { attribute: 10 }, { type: 'request' })], { field: field('number', { issueTypes: ['incident'] }) }));
  assert.equal(notApplicable.report.numeric, null);
  assert.equal(notApplicable.report.applicableIssues, 0);
  assert.equal(notApplicable.report.missingIssues, 0);
  assert.equal(notApplicable.report.notApplicableIssues, 1);
  for (const kind of ['date', 'url'] as const) {
    const result = buildIssueFieldBreakdown(input(kind, [issue('1', { attribute: kind === 'date' ? '2024-02-29' : 'https://example.test/path' })]));
    assert.equal(result.report.numeric, null);
    assert.equal(values(result).length, 1);
  }
});

test('revision ignores generation time and input ordering but binds issue/schema/view versions, membership and display metadata', () => {
  const source = input('select', [issue('2', { attribute: 'a' }), issue('1', { attribute: 'b' })], { savedView: { id: 'view', name: '내 보기', version: 1 } });
  const before = buildIssueFieldBreakdown(source);
  const reordered = structuredClone(source);
  reordered.generatedAt = '2026-11-20T00:00:00.000Z';
  reordered.issues.reverse();
  reordered.field.options.reverse();
  assert.equal(buildIssueFieldBreakdown(reordered).report.revision, before.report.revision);
  const changes: ((value: typeof source) => void)[] = [
    value => { value.schemaVersion++; }, value => { value.savedView!.version++; },
    value => { value.savedView!.name = '다른 보기'; }, value => { value.issues[0].version++; },
    value => { value.issues[0].title = '다른 제목'; }, value => { value.issues[0].key = 'NEW-2'; },
    value => { value.issues.pop(); }, value => { value.field.archived = true; },
    value => { value.field.options[0].name = '선택 이름 변경'; },
    value => { value.issues[0].customFields!.attribute = 'b'; value.issues[1].customFields!.attribute = 'a'; },
  ];
  for (const change of changes) {
    const modified = structuredClone(source);
    change(modified);
    assert.notEqual(buildIssueFieldBreakdown(modified).report.revision, before.report.revision);
  }
});

test('engine rejects inconsistent inputs and preserves complete 10,000-issue drilldown without truncation', () => {
  const full = Array.from({ length: 10000 }, (_, index) => issue(String(index), { attribute: 'shared' }));
  const result = buildIssueFieldBreakdown(input('text', full));
  assert.equal(result.report.totalIssues, 10000);
  assert.equal(values(result)[0].count, 10000);
  assert.equal(result.issuesByBucket.get(values(result)[0].id)!.length, 10000);
  assert.throws(() => buildIssueFieldBreakdown(input('text', [...full, issue('extra')])), status(413));
  assert.throws(() => buildIssueFieldBreakdown(input('text', [issue('1'), issue('1')])), status(400));
  assert.throws(() => buildIssueFieldBreakdown(input('text', [issue('1', {}, { projectId: 'other' })])), status(400));
  assert.throws(() => buildIssueFieldBreakdown(input('text', [issue('1', {}, { version: 0 })])), status(400));
  assert.throws(() => buildIssueFieldBreakdown(input('text', [], { schemaVersion: 0 })), status(400));
  for (const [kind, value] of [['number', NaN], ['number', Infinity], ['number', '1'], ['checkbox', 'false'], ['date', '2024-02-30']] as const) {
    assert.throws(() => buildIssueFieldBreakdown(input(kind, [issue('1', { attribute: value })])), status(422));
  }
});

test('aggregation does not mutate source arrays and reads only own data values without invoking getters', () => {
  const source = input('multi_select', [issue('2', { attribute: ['b', 'a', 'a'] }), issue('1', { attribute: ['a'] })]);
  const original = structuredClone(source);
  buildIssueFieldBreakdown(source);
  assert.deepEqual(source, original);
  let calls = 0;
  const accessor = Object.defineProperty({}, 'attribute', { get() { calls++; return 'a'; } });
  assert.throws(() => buildIssueFieldBreakdown(input('text', [issue('1', accessor)])), status(422));
  assert.equal(calls, 0);
  const inherited = Object.create({ attribute: 'a' }) as Issue['customFields'];
  const result = buildIssueFieldBreakdown(input('text', [issue('1', inherited)]));
  assert.equal(result.report.missingIssues, 1);
});
