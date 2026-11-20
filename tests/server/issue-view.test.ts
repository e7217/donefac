import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultIssueSchema } from '../../shared/issue-schema.js';
import { createIssueViewMatcher, IssueViewPlanningFilterError, parseIssueViewPlanningFilter } from '../../shared/issue-view.js';
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
