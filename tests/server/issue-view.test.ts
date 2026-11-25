import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultIssueSchema } from '../../shared/issue-schema.js';
import {
  createIssueViewMatcher, ISSUE_VIEW_STATUS_LIMIT, IssueViewAssigneeFilterError, IssueViewPlanningFilterError, IssueViewReporterFilterError,
  IssueViewStatusFilterError, issueViewStatusCriteria, issueViewStatusIds, issueViewUsesCurrentUser, parseIssueViewAssigneeFilter, parseIssueViewPlanningFilter,
  issueViewToday, parseIssueViewReporterFilter, parseIssueViewStatusIds,
} from '../../shared/issue-view.js';
import type { Issue, PlanningItem, SavedViewState } from '../../shared/types.js';

const projectId = 'team-project';
const now = '2026-11-20T00:00:00Z';
const schema = defaultIssueSchema(projectId);
const defaultFilters = { query: '', status: 'all', assigneeId: 'all', type: 'all' };

function plan(id: string, kind: PlanningItem['kind'], extra: Partial<PlanningItem> = {}): PlanningItem {
  return { id, projectId, kind, name: id, status: 'active', description: '', ownerId: null, startDate: null, endDate: null,
    targetDate: null, createdAt: now, updatedAt: now, version: 1, ...extra };
}

function issue(extra: Partial<Issue> = {}): Issue {
  return { id: 'issue', projectId, key: 'TS-1', title: '릴리스 검토', description: '', type: '작업', status: 'todo', priority: 'medium',
    assigneeId: null, collaboratorIds: [], parentId: null, labels: [], startDate: null, endDate: null, dueDate: null, estimate: null,
    cycle: null, module: null, release: null, createdAt: now, updatedAt: now, completedAt: null, version: 1, ...extra };
}

const matcher = (criteria: Partial<SavedViewState['filters']> = {}) => createIssueViewMatcher({ ...defaultFilters, ...criteria }, { users: [] }, schema);

test('rolling deadline filters intersect fixed bounds and use Seoul civil dates', () => {
  const planning = parseIssueViewPlanningFilter({ dates: { mode: 'due_relative', fromDays: -1, toDays: 1, from: '2024-02-29' } }, projectId, []);
  const before = issueViewToday(new Date('2024-02-29T14:59:59Z'));
  const after = issueViewToday(new Date('2024-02-29T15:00:00Z'));
  assert.deepEqual([before, after], ['2024-02-29', '2024-03-01']);
  const matches = (date: string) => createIssueViewMatcher({ ...defaultFilters, planning }, { users: [] }, schema, undefined, date);
  const tickets = ['2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02', null]
    .map(dueDate => issue({ dueDate, startDate: '2024-02-29', endDate: '2024-03-01' }));
  assert.deepEqual(tickets.filter(matches(before)), [tickets[1], tickets[2]]);
  assert.deepEqual(tickets.filter(matches(after)), [tickets[1], tickets[2], tickets[3]]);
  for (const dates of [
    { mode: 'due_relative', from: '2024-02-29' }, { mode: 'due_relative', fromDays: '0' },
    { mode: 'due_relative', fromDays: 0.5 }, { mode: 'due_relative', toDays: 3651 },
    { mode: 'due_relative', fromDays: 1, toDays: 0 }, { mode: 'due_set', toDays: 0 },
  ]) assert.throws(() => parseIssueViewPlanningFilter({ dates }, projectId, []), IssueViewPlanningFilterError);
});

test('saved status sets use exact IDs, canonical form, and compose with every other issue condition', () => {
  assert.equal(parseIssueViewStatusIds([]), undefined);
  assert.deepEqual(parseIssueViewStatusIds(['review', 'in_progress', 'review']), ['in_progress', 'review']);
  assert.deepEqual(issueViewStatusCriteria([]), { status: 'all' });
  assert.deepEqual(issueViewStatusCriteria(['review', 'review']), { status: 'review' });
  const set = issueViewStatusCriteria(['review', 'in_progress', 'removed', 'review']);
  assert.deepEqual(set, { status: 'all', statusIds: ['in_progress', 'removed', 'review'] });
  assert.deepEqual(issueViewStatusIds(set), ['in_progress', 'removed', 'review']);
  const review = issue({ status: 'review', labels: ['needs-docs'] });
  const progress = issue({ status: 'in_progress', labels: ['needs-docs'] });
  const done = issue({ status: 'done', labels: ['needs-docs'] });
  const noLabel = issue({ status: 'review' });
  const examples = [review, progress, done, noLabel];
  assert.deepEqual(examples.filter(matcher({ ...set, labels: { include: ['needs-docs'] } })), [review, progress]);
  assert.deepEqual(examples.filter(matcher({ status: 'review' })), [review, noLabel]);
  assert.deepEqual(examples.filter(matcher(issueViewStatusCriteria(['removed', 'pending-new-status']))), []);
  assert.deepEqual(examples.filter(matcher({ status: 'done', statusIds: ['review', 'in_progress'] })), [done]);
  for (const invalid of [
    'review', null, [1], [''], ['all'], [' review'], ['re\nview'], ['\ud800'], ['x'.repeat(81)],
    Array.from({ length: ISSUE_VIEW_STATUS_LIMIT + 1 }, (_, index) => `status-${index}`),
  ]) assert.throws(() => parseIssueViewStatusIds(invalid), IssueViewStatusFilterError);
});

test('reporter filter admits exact member IDs, explicit unset and missing data', () => {
  const parse = (value: unknown) => parseIssueViewReporterFilter(value, [{ id: 'owner' }, { id: 'all' }]);
  assert.equal(parse(undefined), undefined);
  assert.equal(parse(null), undefined);
  assert.deepEqual(parse({ kind: 'member', memberId: 'all' }), { kind: 'member', memberId: 'all' });
  assert.deepEqual(parse({ kind: 'unset' }), { kind: 'unset' });
  assert.deepEqual(parse({ kind: 'unknown' }), { kind: 'unknown' });
  assert.deepEqual(parse({ kind: 'current-user' }), { kind: 'current-user' });
  for (const invalid of [
    [], {}, 'owner', { kind: 'all' }, { kind: 'member' }, { kind: 'member', memberId: 2 },
    { kind: 'member', memberId: 'owner ' }, { kind: 'member', memberId: 'missing' },
    { kind: 'member', memberId: 'owner', extra: true }, { kind: 'unset', memberId: undefined },
    { kind: 'unknown', memberId: null }, { kind: 'current-user', memberId: 'owner' }, Object.create({ kind: 'unset' }),
    { get kind() { throw new Error('unexpected reporter getter'); } },
  ]) assert.throws(() => parse(invalid), IssueViewReporterFilterError);
});

test('current-user assignee admits only a symbolic condition', () => {
  assert.equal(parseIssueViewAssigneeFilter(null), undefined);
  assert.equal(parseIssueViewAssigneeFilter(undefined), undefined);
  const currentUser = { kind: 'current-user' };
  assert.deepEqual(parseIssueViewAssigneeFilter(currentUser), currentUser);
  for (const invalid of [
    [], {}, 'current-user', { kind: 'member', memberId: 'owner' }, { ...currentUser, memberId: 'owner' },
    { ...currentUser, extra: undefined }, Object.create(currentUser),
    { get kind() { throw new Error('unexpected assignee getter'); } },
  ]) assert.throws(() => parseIssueViewAssigneeFilter(invalid), IssueViewAssigneeFilterError);
});

test('a shared current-user criterion follows the actual viewer and composes with fixed and other viewer filters', () => {
  const owner = { id: 'owner', name: 'Owner', email: 'owner@example.test', color: '#123456' };
  const teammate = { id: 'teammate', name: 'Teammate', email: 'teammate@example.test', color: '#abcdef' };
  const data = { users: [owner, teammate] };
  const currentUser = { kind: 'current-user' } as const;
  const selfAssigned = issue({ assigneeId: owner.id, reporterId: owner.id, status: 'review' });
  const assigned = issue({ assigneeId: owner.id, reporterId: teammate.id, status: 'review' });
  const reported = issue({ assigneeId: teammate.id, reporterId: owner.id, status: 'review' });
  const removed = issue({ assigneeId: 'missing', reporterId: 'missing', status: 'review' });
  const issues = [selfAssigned, assigned, reported, removed, issue({ status: 'review' }), issue({ assigneeId: owner.id })];
  const filters = { ...defaultFilters, status: 'review', assignee: currentUser };
  assert.equal(issueViewUsesCurrentUser(filters), true);
  assert.equal(issueViewUsesCurrentUser({ ...defaultFilters, assigneeId: owner.id }), false);
  assert.deepEqual(issues.filter(createIssueViewMatcher(filters, data, schema, owner.id)), [selfAssigned, assigned]);
  assert.deepEqual(issues.filter(createIssueViewMatcher(filters, data, schema, teammate.id)), [reported]);
  for (const missing of [undefined, 'missing']) {
    assert.deepEqual(issues.filter(createIssueViewMatcher(filters, data, schema, missing)), []);
    assert.deepEqual(issues.filter(createIssueViewMatcher({ ...defaultFilters, reporter: currentUser }, data, schema, missing)), []);
  }
  assert.deepEqual(issues.filter(createIssueViewMatcher({ ...filters, reporter: currentUser }, data, schema, owner.id)), [selfAssigned]);
  assert.deepEqual(issues.filter(createIssueViewMatcher({ ...filters, reporter: currentUser }, data, schema, teammate.id)), []);
  assert.deepEqual(issues.filter(createIssueViewMatcher({ ...defaultFilters, assigneeId: teammate.id, reporter: currentUser }, data, schema, owner.id)), [reported]);
});

test('saved reporter criteria compose with status and assignee without merging missing and unset', () => {
  const legacy = issue();
  const unset = issue({ reporterId: null });
  const member = issue({ reporterId: 'owner', assigneeId: 'user-seo', status: 'review' });
  const examples = [legacy, unset, member, issue({ reporterId: 'user-seo', assigneeId: 'owner' })];
  assert.deepEqual(examples.filter(matcher()), examples);
  assert.deepEqual(examples.filter(matcher({ reporter: { kind: 'unknown' } })), [legacy]);
  assert.deepEqual(examples.filter(matcher({ reporter: { kind: 'unset' } })), [unset]);
  const match = matcher({ reporter: { kind: 'member', memberId: 'owner' }, assigneeId: 'user-seo', status: 'review' });
  assert.deepEqual([...examples, { ...member, status: 'todo' }, { ...member, assigneeId: 'owner' }].filter(match), [member]);
});

test('planning filter canonicalizes omitted input and validates selector scope, kind and date bounds', () => {
  const plans = [plan('prior-cycle', 'cycle', {status: 'archived'}), plan('team-module', 'module'), plan('other-cycle', 'cycle', {projectId: 'another-project'})];
  const parse = (value: unknown) => parseIssueViewPlanningFilter(value, projectId, plans);
  assert.equal(parse(undefined), undefined);
  assert.equal(parse({}), undefined);
  assert.deepEqual(parse({moduleId: null, cycleId: 'prior-cycle', dates: {mode:'overlap', from: '2028-02-29'}}),
    {cycleId: 'prior-cycle', moduleId: null, dates: {mode: 'overlap', from: '2028-02-29'}});
  assert.deepEqual(parse({dates: {mode: 'due', to: '2026-11-20'}}), {dates: {mode: 'due', to: '2026-11-20'}});
  assert.deepEqual(parse({dates: {mode: 'planned'}}), {dates: {mode: 'planned'}});
  for (const value of [
    null, [], {unknown: true}, {cycleId: undefined}, {cycleId: ''}, {cycleId: 2}, {cycleId: 'missing'},
    {cycleId: 'other-cycle'}, {cycleId: 'team-module'}, {get cycleId() { throw new Error('unexpected getter'); }},
    {dates: null}, {dates: {}}, {dates: {mode: 'unknown'}}, {dates: {mode: 'due'}}, {dates: {mode: 'planned', to: '2026-11-20'}},
    {dates: {mode: 'needs_dates', from: null}}, {dates: {mode: 'overlap', start: '2026-11-20'}},
    {dates: {mode: 'overlap', from: '2026-02-29'}}, {dates: {mode: 'due', from: '2026-11-2'}},
    {dates: {mode: 'due', from: null, to: '2026-11-20'}}, {dates: {mode: 'due', from: '2026-11-22', to: '2026-11-21'}},
  ]) assert.throws(() => parse(value), IssueViewPlanningFilterError);
});

test('view matches every plan selector and the existing issue filters without requiring stored planning keys', () => {
  const current = issue({cycleId: 'cycle', releaseId: 'release', assigneeId: 'owner'});
  const match = matcher({ assigneeId: 'owner', query: '검토', planning: {cycleId: 'cycle', moduleId: null, releaseId: 'release'} });
  assert.equal(match(current), true);
  for (const change of [ {cycleId: null}, {moduleId: 'module'}, {releaseId: 'different'}, {assigneeId: null}, {title: '다른 업무'} ]) {
    assert.equal(match({...current, ...change}), false);
  }
  assert.equal(matcher()(current), true);
  assert.equal(matcher({planning:{cycleId: null}})(issue()), true);
});

test('schedule completeness, overlap and actual due windows count inclusive calendar boundaries', () => {
  const complete = issue({startDate:'2026-11-14', endDate:'2026-11-17', dueDate:'2026-11-20'});
  const missing = issue({startDate:'2026-11-15', dueDate:'2026-11-18'});
  const reversed = issue({startDate:'2026-11-27', endDate:'2026-11-26'});
  const invalid = issue({startDate:'2026-11-15', endDate:'2026-11-31', dueDate:'2026-11-31'});
  const planned = matcher({planning:{dates:{mode:'planned'}}});
  const needsDates = matcher({planning:{dates:{mode:'needs_dates'}}});
  assert.equal(planned(complete), true);
  assert.equal(needsDates(complete), false);
  for (const candidate of [missing, reversed, invalid, issue()]) {
    assert.equal(planned(candidate), false);
    assert.equal(needsDates(candidate), true);
  }

  const overlap = matcher({planning:{dates:{mode:'overlap', from:'2026-11-17', to:'2026-11-18'}}});
  assert.equal(overlap(complete), true);
  assert.equal(overlap(issue({startDate:'2026-11-18', endDate:'2026-11-18'})), true);
  assert.equal(overlap(issue({startDate:'2026-11-19', endDate:'2026-11-19'})), false);
  assert.equal(overlap(missing), false);
  assert.equal(matcher({planning:{dates:{mode:'overlap', to:'2026-11-14'}}})(complete), true);
  assert.equal(matcher({planning:{dates:{mode:'overlap', from:'2026-11-18'}}})(complete), false);

  const due = matcher({planning:{dates:{mode:'due', from:'2026-11-18', to:'2026-11-20'}}});
  assert.equal(due(complete), true);
  assert.equal(due(missing), true);
  assert.equal(due(issue({endDate:'2026-11-20'})), false);
  assert.equal(due(invalid), false);
  assert.equal(matcher({planning:{dates:{mode:'due', to:'2026-11-18'}}})(complete), false);
});
