import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultIssueSchema } from '../../shared/issue-schema.js';
import { createIssueViewMatcher, ISSUE_VIEW_STATUS_LIMIT } from '../../shared/issue-view.js';
import { JiraViewQueryError, translateJiraViewQuery, type JiraViewComponentField, type JiraViewQueryContext, type JiraViewSourceAlias } from '../../shared/jira-view-query.js';
import { JIRA_SAVED_VIEW_QUERY_LIMIT, type Issue } from '../../shared/types.js';

const project = { id: 'project-id', key: 'TEAM', name: 'Team project' };
const context: JiraViewQueryContext = {
  project,
  sourceProjectAliases: ['OLD', '10000'],
  statuses: [{ id: 'review', label: 'In Review' }, { id: 'done', label: '완료' }],
  issueTypes: [{ id: 'bug', name: '버그', archived: false }, { id: 'retired', name: 'Retired', archived: true }],
  users: [
    { id: 'member-a', name: '김 개발', email: 'dev@example.test' },
    { id: 'member-b', name: '이 개발', email: 'qa@example.test' },
  ],
};
const noFilters = { query: '', status: 'all', assigneeId: 'all', type: 'all' };
const schema = defaultIssueSchema(project.id);
const now = '2026-11-20T00:00:00Z';

function issue(extra: Partial<Issue>): Issue {
  return {
    id: 'issue', projectId: project.id, key: 'TEAM-1', title: '업무', description: '', type: 'bug', status: 'review',
    priority: 'medium', assigneeId: null, collaboratorIds: [], parentId: null, labels: [], startDate: null, endDate: null,
    dueDate: null, estimate: null, cycle: null, module: null, release: null, createdAt: now, updatedAt: now,
    completedAt: null, version: 1, ...extra,
  };
}

function match(jql: string) {
  return createIssueViewMatcher(translateJiraViewQuery(jql, context).filters, { users: [] }, schema);
}

test('JQL resolves exact case-insensitive project, workflow, type and member aliases', () => {
  const translated = translateJiraViewQuery(`project = OLD AND (status = "in review" AnD (issuetype = 버그 AND type = bug))
    AND assignee = '김 개발' AND reporter = "QA@example.test"`, context);
  assert.deepEqual(translated.filters, {
    ...noFilters, status: 'review', type: 'bug', assigneeId: 'member-a', reporter: { kind: 'member', memberId: 'member-b' },
  });
  assert.deepEqual(translated.criteria.map(criterion => criterion.field), ['project', 'status', 'type', 'assignee', 'reporter']);
  assert.match(translated.criteria[0].label, /TEAM/);
  assert.deepEqual(translateJiraViewQuery('project = 10000', context).filters, noFilters);
  assert.equal(translateJiraViewQuery('status = 완료', context).criteria[0].field, 'project');
  assert.throws(() => translateJiraViewQuery('project = old', { ...context, blockedSourceProjectAliases: ['OLD'] }), JiraViewQueryError);
  assert.throws(() => translateJiraViewQuery('project = team', { ...context, blockedSourceProjectAliases: ['TEAM'] }), JiraViewQueryError);
  assert.throws(() => translateJiraViewQuery('project = OTHER', context), JiraViewQueryError);
});

test('JQL original aliases resolve to current options without overriding conflicting native values', () => {
  const sourceContext: JiraViewQueryContext = {
    ...context,
    prepareSourceAliases: fields => {
      assert.deepEqual(fields, ['assignee', 'status']);
      return (field, value) => {
        if (field === 'status') return { kind: 'mapped', sourceId: '14', targetId: 'review' };
        switch (value) {
          case 'old-login': return { kind: 'mapped', sourceId: 'original-member', targetId: 'member-a' };
          case 'member-b': return { kind: 'mapped', sourceId: 'original-member', targetId: 'member-a' };
          case 'dev@example.test': return { kind: 'unmapped' };
          case 'member-a': return { kind: 'mapped', sourceId: 'deleted-account', targetId: 'removed-member' };
        }
      };
    },
  };
  const translated = translateJiraViewQuery('assignee = old-login AND status = 14', sourceContext);
  assert.equal(translated.filters.assigneeId, 'member-a');
  assert.equal(translated.filters.status, 'review');
  assert.deepEqual(translated.criteria.slice(1), [
    { field: 'assignee', label: '담당자 · 김 개발' }, { field: 'status', label: '상태 · In Review' },
  ]);
  for (const value of ['member-b', 'dev@example.test', 'member-a']) {
    assert.throws(() => translateJiraViewQuery(`assignee = "${value}" AND status = 14`, sourceContext), JiraViewQueryError);
  }
  assert.doesNotThrow(() => translateJiraViewQuery('assignee IS EMPTY AND labels = release', sourceContext));
  assert.throws(() => translateJiraViewQuery('assignee = old-login OR status = 14', sourceContext), JiraViewQueryError);
});

test('JQL currentUser() preserves symbolic member equality and resolves only for the actual viewer', () => {
  const result = translateJiraViewQuery('project = OLD AND (assignee = CurrentUser ( ) AND reporter = currentuser()) AND status = review', {
    ...context,
    prepareSourceAliases: fields => {
      assert.deepEqual(fields, ['status']);
      return undefined;
    },
  });
  assert.deepEqual(result.filters, { ...noFilters, status: 'review', assignee: { kind: 'current-user' }, reporter: { kind: 'current-user' } });
  assert.deepEqual(result.criteria.slice(1), [
    { field: 'assignee', label: '담당자 · 현재 사용자' }, { field: 'reporter', label: '요청자 · 현재 사용자' },
    { field: 'status', label: '상태 · In Review' },
  ]);
  const data = { users: context.users.map(user => ({ ...user, color: '#123456' })) };
  const assigned = issue({ assigneeId: 'member-a', reporterId: 'member-a' });
  assert.equal(createIssueViewMatcher(result.filters, data, schema, 'member-a')(assigned), true);
  assert.equal(createIssueViewMatcher(result.filters, data, schema, 'member-b')(assigned), false);
  assert.equal(createIssueViewMatcher(result.filters, data, schema)(assigned), false);
  assert.deepEqual(translateJiraViewQuery('assignee = currentUser() AND assignee = CURRENTUSER() AND reporter = member-b', context).filters,
    { ...noFilters, assignee: { kind: 'current-user' }, reporter: { kind: 'member', memberId: 'member-b' } });

  const quoted = translateJiraViewQuery('assignee = "currentUser()"', { ...context, users: [{ ...context.users[0], name: 'currentUser()' }] });
  assert.deepEqual(quoted.filters, { ...noFilters, assigneeId: 'member-a' });
});

test('JQL status lists and status-only OR groups form exact unions and AND intersections', () => {
  const multi = 'project = OLD AND status IN (review, done, "In Review") AND labels = release';
  const equivalent = 'project = OLD AND (status = 완료 OR (status IN (review))) AND labels = release';
  const translated = translateJiraViewQuery(multi, context);
  assert.deepEqual(translated.filters, {
    ...noFilters, statusIds: ['done', 'review'], labels: { include: ['release'], match: 'all' },
  });
  assert.deepEqual(translateJiraViewQuery(equivalent, context), translated);
  assert.equal(translated.criteria.find(item => item.field === 'status')?.label, '상태 · 완료, In Review');
  const matches = match(equivalent);
  assert.equal(matches(issue({ status: 'done', labels: ['release'] })), true);
  assert.equal(matches(issue({ status: 'review', labels: ['release'] })), true);
  assert.equal(matches(issue({ status: 'todo', labels: ['release'] })), false);
  assert.equal(matches(issue({ status: 'review', labels: [] })), false);

  const wider = { ...context, statuses: [...context.statuses, { id: 'todo', label: 'To Do' }] };
  assert.deepEqual(translateJiraViewQuery('status IN (review, done) AND status IN (todo, "In Review")', wider).filters,
    { ...noFilters, status: 'review' });
  assert.deepEqual(translateJiraViewQuery('status = done OR status = review AND status = todo', wider).filters,
    { ...noFilters, status: 'done' });
  assert.throws(() => translateJiraViewQuery('status IN (review, done) AND status = todo', wider), JiraViewQueryError);
});

test('JQL status unions check every original alias before reducing to current states', () => {
  const checked: string[] = [];
  const sourceContext: JiraViewQueryContext = {
    ...context,
    prepareSourceAliases: fields => {
      assert.deepEqual(fields, ['status']);
      return (_field, value) => {
        checked.push(value);
        if (value === 'Legacy review') return { kind: 'mapped', sourceId: '14', targetId: 'review' };
        if (value === '13') return { kind: 'mapped', sourceId: '13', targetId: 'done' };
        if (value === 'unmapped') return { kind: 'unmapped' };
        if (value === 'ambiguous') return { kind: 'ambiguous' };
      };
    },
  };
  const result = translateJiraViewQuery('(status IN ("Legacy review", 13) OR status = review) AND status = "In Review"', sourceContext);
  assert.deepEqual(result.filters, { ...noFilters, status: 'review' });
  assert.deepEqual(checked, ['Legacy review', '13', 'review', 'In Review']);
  for (const value of ['unmapped', 'ambiguous']) {
    assert.throws(() => translateJiraViewQuery(`status IN ("Legacy review", ${value}) AND status = review`, sourceContext), JiraViewQueryError);
  }
});

test('JQL priority lists become canonical native filters and combine with status and labels', () => {
  const native = { ...context, sourceProjectAliases: undefined };
  const translated = translateJiraViewQuery(
    'project = TEAM AND priority IN (low, HIGH, 긴급) AND priority IN (높음, urgent) AND status = review AND labels = release', native,
  );
  assert.deepEqual(translated.filters, {
    ...noFilters, priorities: ['urgent', 'high'], status: 'review', labels: { include: ['release'], match: 'all' },
  });
  assert.deepEqual(translated.criteria[1], { field: 'priority', label: '우선순위 · 긴급, 높음' });
  const matches = createIssueViewMatcher(translated.filters, { users: [] }, schema);
  assert.equal(matches(issue({ priority: 'urgent', labels: ['release'] })), true);
  assert.equal(matches(issue({ priority: 'high', labels: ['release'] })), true);
  assert.equal(matches(issue({ priority: 'medium', labels: ['release'] })), false);
  assert.equal(matches(issue({ priority: 'high', labels: ['release'], status: 'done' })), false);
  assert.equal(matches(issue({ priority: 'high' })), false);
  assert.deepEqual(translateJiraViewQuery('PRIORITY = 높음', native).filters.priorities, ['high']);
  for (const jql of [
    'priority = Highest', 'priority = urgent AND priority = low', 'priority IN ()', 'priority IN (high,)',
    'priority NOT IN (high, low)', 'priority != high', 'priority IS EMPTY', 'priority = high OR priority = low',
    'priority = high OR status = review', 'priority = priorityOf(currentUser())',
  ]) assert.throws(() => translateJiraViewQuery(jql, native), JiraViewQueryError, jql);
});

test('JQL priority intersections require complete coverage of a collapsed original priority', () => {
  const highest = { kind: 'mapped', sourceId: '11', targetId: 'urgent', targetSourceIds: ['11', '12'] } as const;
  const blocker = { kind: 'mapped', sourceId: '12', targetId: 'urgent', targetSourceIds: ['12', '11'] } as const;
  const high = { kind: 'mapped', sourceId: '22', targetId: 'high' } as const;
  const evidence = new Map<string, JiraViewSourceAlias>([
    ['highest', highest], ['11', highest], ['blocker', blocker], ['12', blocker], ['legacy high', high], ['22', high],
    ['merged option', { kind: 'ambiguous' }], ['bad option', { kind: 'unmapped' }], ['high', highest],
  ]);
  const source: JiraViewQueryContext = {
    ...context,
    prepareSourceAliases(fields) {
      assert.deepEqual(fields, ['priority']);
      return (field, value) => field === 'priority' ? evidence.get(value.toLowerCase()) : undefined;
    },
  };
  const converted = translateJiraViewQuery(
    'project = OLD AND priority IN (Highest, Blocker, "Legacy High") AND priority IN (11, 12, 22)', source,
  );
  assert.deepEqual(converted.filters, { ...noFilters, priorities: ['urgent', 'high'] });
  assert.deepEqual(converted.criteria[1], { field: 'priority', label: '우선순위 · 긴급, 높음' });
  assert.deepEqual(translateJiraViewQuery('priority IN (Highest, 22) AND priority = 22', source).filters.priorities, ['high']);
  for (const jql of [
    'priority = Highest', 'priority IN (Highest, 22)', 'priority IN (Highest, Blocker) AND priority = Blocker',
    'priority = Highest AND priority = Blocker', 'priority = high', 'priority = urgent',
    'priority IN (Highest, Blocker, unknown) AND priority IN (Highest, Blocker)',
    'priority IN (Highest, Blocker, "merged option")', 'priority IN (Highest, Blocker, "bad option")',
  ]) assert.throws(() => translateJiraViewQuery(jql, source), JiraViewQueryError, jql);
  assert.throws(() => translateJiraViewQuery('priority = high', { ...context, sourceProjectAliases: [], blockedSourceProjectAliases: ['TEAM'] }), JiraViewQueryError);
});

test('JQL priority names can include label-only values while numeric aliases still select just their ID', () => {
  const labelOnlyId = 'label:highest';
  const targetSourceIds = ['11', '12', labelOnlyId];
  const highest = { kind: 'mapped', sourceId: '11', targetId: 'urgent', targetSourceIds } as const;
  const blocker = { kind: 'mapped', sourceId: '12', targetId: 'urgent', targetSourceIds } as const;
  const evidence = new Map<string, JiraViewSourceAlias>([
    ['highest', { ...highest, sameNameSourceIds: [labelOnlyId] }], ['11', highest], ['blocker', blocker], ['12', blocker],
    ['invalid', { ...highest, sameNameSourceIds: ['label:unexpected'] }],
  ]);
  const source: JiraViewQueryContext = {
    ...context,
    prepareSourceAliases: () => (field, value) => field === 'priority' ? evidence.get(value.toLowerCase()) : undefined,
  };
  assert.deepEqual(translateJiraViewQuery('priority IN (Highest, Blocker) AND priority IN (Highest, 12)', source).filters.priorities, ['urgent']);
  for (const jql of [
    'priority IN (11, 12)', 'priority IN (Highest, Blocker) AND priority IN (11, Blocker)', 'priority IN (invalid, 12)',
  ]) assert.throws(() => translateJiraViewQuery(jql, source), JiraViewQueryError, jql);
});

test('quoted literals preserve case and decode quotes and backslashes without evaluating the content', () => {
  const { filters } = translateJiraViewQuery(String.raw`"labels" = "qa\"review" and labels = 'dev\'s' AND labels = "a\\b" AND labels = "AND"`, context);
  assert.deepEqual(filters.labels, { include: ['AND', 'a\\b', "dev's", 'qa"review'], match: 'all' });
  assert.equal(match('labels = Release')(issue({ labels: ['release'] })), false);
  assert.equal(match('labels = Release')(issue({ labels: ['Release'] })), true);
  assert.equal(match('labels = "NULL"')(issue({ labels: ['NULL'] })), true);
  assert.throws(() => translateJiraViewQuery(String.raw`labels = "a\nb"`, context), JiraViewQueryError);
  assert.throws(() => translateJiraViewQuery('labels = "a\nb"', context), JiraViewQueryError);
});

test('label exclusions keep Jira null behavior and compose without broadening included groups', () => {
  const query = 'labels IN (release, candidate, backlog) AND labels IN (release, candidate) AND labels NOT IN (backlog, archived, Release)';
  const { filters } = translateJiraViewQuery(query, context);
  assert.deepEqual(filters.labels, { include: ['candidate', 'release'], exclude: ['Release', 'archived', 'backlog'], presence: 'set' });
  const nowMatches = match(query);
  for (const labels of [[], ['release'], ['candidate'], ['archived'], ['candidate', 'backlog'], ['candidate', 'Release'], ['other']]) {
    const jiraMatches = labels.some(label => label === 'release' || label === 'candidate')
      && !labels.some(label => ['backlog', 'archived', 'Release'].includes(label));
    assert.equal(nowMatches(issue({ labels })), jiraMatches, labels.join(', '));
  }
  assert.equal(match('labels != backlog')(issue({ labels: [] })), false);
  assert.equal(match('labels NOT IN (archived, backlog)')(issue({ labels: ['other'] })), true);
  assert.equal(match('labels IS NULL')(issue({ labels: [] })), true);
  assert.equal(match('labels IS NOT EMPTY')(issue({ labels: [] })), false);
  assert.equal(match('labels IS NOT NULL')(issue({ labels: ['other'] })), true);
  assert.deepEqual(translateJiraViewQuery('labels IN (a, b) AND labels = a AND labels = c', context).filters.labels,
    { include: ['a', 'c'], match: 'all' });
  assert.deepEqual(translateJiraViewQuery('labels IN (a, b) AND labels != a AND labels IN (b, c)', context).filters.labels,
    { include: ['b'], match: 'all', exclude: ['a'], presence: 'set' });
});

const componentField: JiraViewComponentField = {
  fieldId: 'jira-components',
  name: 'Jira 컴포넌트',
  hasCompleteCoverage: true,
  resolve: (value, quoted) => {
    if (value === 'duplicated') return { kind: 'ambiguous' };
    if (value === 'removed') return { kind: 'unmapped' };
    if (value === 'Web UI' || value === '20701' && !quoted) return { kind: 'mapped', targetId: 'web', label: 'Web Platform' };
    if (value === 'API') return { kind: 'mapped', targetId: 'api', label: 'API' };
    if (value === '20801' && quoted) return { kind: 'mapped', targetId: 'numeric-name', label: '20801' };
    if (/^option[0-9]$/.test(value)) return { kind: 'mapped', targetId: value, label: value };
  },
};
const componentContext: JiraViewQueryContext = { ...context, prepareComponentField: () => componentField };

test('Jira component comparisons use the native multiple-choice filter with current option labels', () => {
  const { fieldId, name } = componentField;
  const componentSchema = {
    ...schema,
    fields: [{
      id: fieldId, name, description: '', kind: 'multi_select' as const, required: false, issueTypes: [], archived: false,
      options: [
        { id: 'web', name: 'Web Platform', archived: false }, { id: 'api', name: 'API', archived: false },
        { id: 'numeric-name', name: '20801', archived: false },
      ],
    }],
  };
  const issues = [
    ['web'], ['api'], ['web', 'api'], ['numeric-name'], [],
  ].map((values, index) => issue({ id: String(index), customFields: { [fieldId]: values } }));
  const matchingIndexes = (jql: string) => {
    const { filters } = translateJiraViewQuery(jql, componentContext);
    return issues.filter(createIssueViewMatcher(filters, { users: [] }, componentSchema)).map(({ id }) => id);
  };
  const either = 'project = OLD AND (component = "Web UI" OR component IN (API, 20701)) AND status = review';
  const translated = translateJiraViewQuery(either, componentContext);
  assert.deepEqual(translated.filters.fieldFilter, { match: 'any', rules: [
    { fieldId, operator: 'includes', value: 'web' }, { fieldId, operator: 'includes', value: 'api' },
  ] });
  assert.deepEqual(translated.criteria.find(criterion => criterion.field === 'component'), {
    field: 'component', label: 'Jira 컴포넌트 · 포함 Web Platform 또는 포함 API',
  });
  assert.deepEqual(matchingIndexes(either), ['0', '1', '2']);
  assert.deepEqual(matchingIndexes('component = 20701 AND component = API'), ['2']);
  assert.deepEqual(matchingIndexes('component = "20801"'), ['3']);
  assert.deepEqual(matchingIndexes('component IN (20701, API) AND component != API'), ['0']);
  assert.deepEqual(matchingIndexes('component NOT IN (20701, API)'), ['3']);
  assert.deepEqual(matchingIndexes('component != 20701 OR component IS EMPTY'), ['1', '3', '4']);
  assert.deepEqual(matchingIndexes('component IS NULL'), ['4']);
  assert.deepEqual(matchingIndexes('component IS NOT EMPTY'), ['0', '1', '2', '3']);
});

test('Jira component translation rejects unverified values and Boolean combinations that need nested native filters', () => {
  assert.throws(() => translateJiraViewQuery('component = API', context), /이관한 Jira 컴포넌트 필드/);
  assert.throws(() => translateJiraViewQuery('component = duplicated', componentContext), { offset: 12 });
  assert.throws(() => translateJiraViewQuery('component = removed', componentContext), /현재 Jira 컴포넌트 값/);
  assert.throws(() => translateJiraViewQuery('component = absent', componentContext), /현재 Jira 컴포넌트 값/);
  for (const query of [
    'component = API AND component != API',
    'component = API AND component IS EMPTY',
    'component IN (20701, API) AND component != option0',
    'component = API OR (component = 20701 AND component = option0)',
    'component = API OR status = review',
    'component IN (componentsLeadByUser())',
    `component IN (${Array.from({ length: 9 }, (_, index) => `option${index}`).join(', ')})`,
  ]) assert.throws(() => translateJiraViewQuery(query, componentContext), JiraViewQueryError, query);
  const uncertain = {
    ...componentContext,
    prepareComponentField: () => ({ ...componentField, hasCompleteCoverage: false }),
  };
  assert.doesNotThrow(() => translateJiraViewQuery('component = API', uncertain));
  for (const query of ['component IS EMPTY', 'component IS NOT EMPTY', 'component != API', 'component NOT IN (API)']) {
    assert.throws(() => translateJiraViewQuery(query, uncertain), /이관 원본에서 컴포넌트/);
  }
});

test('empty assignees and explicitly empty reporters remain distinct from unknown reporters', () => {
  const absent = issue({});
  const unset = issue({ reporterId: null });
  const member = issue({ reporterId: 'member-a' });
  const assigned = issue({ assigneeId: 'member-a', reporterId: null });
  const examples = [absent, unset, member, assigned];
  assert.deepEqual(examples.filter(match('assignee IS EMPTY AND reporter IS NULL')), [unset]);
  assert.deepEqual(examples.filter(match('reporter = member-a')), [member]);
  assert.deepEqual(examples.filter(match('assignee IS NULL')), [absent, unset, member]);
});

test('literal Jira deadlines use only due dates and intersect exact inclusive calendar bounds', () => {
  const jql = 'project = OLD AND ("dueDate" > "2024/02/28" AND due < \'2024-03-02\') AND (status = review OR status = done)';
  const translated = translateJiraViewQuery(jql, {
    ...context, prepareSourceAliases: fields => { assert.deepEqual(fields, ['status']); return undefined; },
  });
  assert.deepEqual(translated.filters, {
    ...noFilters, statusIds: ['done', 'review'], planning: { dates: { mode: 'due', from: '2024-02-29', to: '2024-03-01' } },
  });
  assert.deepEqual(translated.criteria.find(item => item.field === 'due'), {
    field: 'due', label: '목표 마감일 · 2024-02-29 ~ 2024-03-01',
  });
  const matches = match(jql);
  assert.equal(matches(issue({ dueDate: '2024-02-29' })), true);
  assert.equal(matches(issue({ dueDate: '2024-03-01', status: 'done' })), true);
  assert.equal(matches(issue({ dueDate: '2024-02-28' })), false);
  assert.equal(matches(issue({ dueDate: '2024-03-02' })), false);
  assert.equal(matches(issue({ dueDate: '2024-03-01', status: 'todo' })), false);
  assert.equal(matches(issue({ startDate: '2024-02-29', endDate: '2024-03-01' })), false);

  for (const [input, expected] of [
    ['due = "2024-02-29" AND due <= "2024-12-31"', { from: '2024-02-29', to: '2024-02-29' }],
    ['due >= "2024-03-01" AND DUE >= "2024/02/29"', { from: '2024-03-01' }],
    ['due <= "2024-02-29" AND due <= "2024-03-01"', { to: '2024-02-29' }],
    ['due < "2024-03-01"', { to: '2024-02-29' }],
    ['due > "2024-12-31"', { from: '2025-01-01' }],
  ] as const) {
    assert.deepEqual(translateJiraViewQuery(input, context).filters.planning?.dates, { mode: 'due', ...expected });
  }
});

test('unrepresentable, ambiguous and impossible Jira deadline expressions fail with a JQL position', () => {
  for (const jql of [
    'due >= now()', 'due = "1d"', 'due IS EMPTY', 'due != "2024-02-29"', 'due IN ("2024-02-29")',
    'due = "2023-02-29"', 'due = "2024-02-29 12:00"', 'due = "2024/02-29"', 'due = 2024-02-29',
    'due >= "2024-03-01" AND due <= "2024-02-29"', 'due < "0000-01-01"', 'due > "9999-12-31"',
    'due < "2024-02-29" OR status = review', 'due = "2024-02-29" OR due = "2024-03-01"',
  ]) {
    assert.throws(() => translateJiraViewQuery(jql, context),
      error => error instanceof JiraViewQueryError && typeof error.offset === 'number', jql);
  }
});

test('JQL sort descriptors are parsed separately from the saved view filters', () => {
  const translated = translateJiraViewQuery('project = TEAM ORDER BY Rank ASC, "Epic Link" dEsC, cf[10001], updated', context);
  assert.deepEqual(translated.filters, noFilters);
  assert.deepEqual(translated.orderBy, [
    { field: 'Rank', direction: 'asc' }, { field: 'Epic Link', direction: 'desc' }, { field: 'cf[10001]' }, { field: 'updated' },
  ]);
  assert.equal(translated.requiresProjectOrderAcceptance, true);
  assert.equal(translated.sort, undefined);
  assert.deepEqual(translateJiraViewQuery('ORDER BY updated', context).orderBy, [{ field: 'updated' }]);
});

test('only complete explicit Jira date order maps to a saved sort', () => {
  const dated = translateJiraViewQuery('ORDER BY "dueDate" ASC, updatedDate dEsC, created asc', context);
  assert.deepEqual(dated.sort, [
    { field: 'dueDate', direction: 'asc' }, { field: 'updatedAt', direction: 'desc' }, { field: 'createdAt', direction: 'asc' },
  ]);
  assert.equal(dated.requiresProjectOrderAcceptance, undefined);
  for (const order of ['Rank ASC', 'Rank DESC', 'priority DESC', 'due', 'due ASC, rank ASC', 'due ASC, duedate DESC', 'created DESC, updated']) {
    const fallback = translateJiraViewQuery(`ORDER BY ${order}`, context);
    assert.equal(fallback.sort, undefined, order);
    assert.equal(fallback.requiresProjectOrderAcceptance, true, order);
  }
  const unsorted = translateJiraViewQuery('project = TEAM', context);
  assert.equal(unsorted.sort, undefined);
  assert.equal(unsorted.requiresProjectOrderAcceptance, undefined);
});

test('unsupported, contradictory and ambiguous JQL cannot silently become a broader saved view', () => {
  for (const jql of [
    'project = TEAM OR status = review', '(labels = a OR labels = b)', 'NOT labels = a',
    'project = TEAM AND status = review OR status = done', 'status = review OR status = done AND project = TEAM',
    'status = review OR (status = done AND labels = a)', 'status IN ()', 'status IN (review,)',
    'status IN (currentUser())', 'status IN (review, unknown)', 'issuetype IN (bug, task)',
    'status != done', 'status WAS "In Review"', 'status CHANGED', 'priority = High', 'text = foo', 'key = TEAM-5',
    'assignee = currentUser(member-a)', 'assignee = currentUser(', 'reporter = currentUser(currentUser())',
    'assignee = "currentUser"()', 'assignee = "currentUser()"', 'assignee != currentUser()', 'reporter IN (currentUser())',
    'project = currentUser()', 'status = currentUser()', 'labels = currentUser()', 'assignee = currentUser() OR reporter = currentUser()',
    'assignee = currentUser() AND assignee = member-a', 'reporter = currentUser() AND reporter IS EMPTY',
    'labels IN (membersOf("team"))', 'reporter = NULL', 'assignee IS NOT EMPTY',
    'status = review AND status = done', 'reporter IS EMPTY AND reporter = member-a', 'assignee = unknown',
    'status = " in review"', 'status = rev', 'type = Retired', 'labels = a AND labels != a',
    'labels IS EMPTY AND labels IS NOT EMPTY', 'labels IS EMPTY AND labels NOT IN (b)', 'labels IN (a, b) AND labels NOT IN (a, b)',
    'labels = a AND labels IN (b, c)', 'labels IN (a, b) AND labels IN (b, c)',
    'labels IN ()', 'labels IN (a,)', 'labels = a,b', 'labels = a.b', 'labels = ', 'labels = ""', '(labels = a',
    'project = TEAM AND', 'project = TEAM ORDER BY', 'project = TEAM ORDER BY Rank ASC,', 'project = TEAM ORDER BY Rank AND labels = a',
  ]) assert.throws(() => translateJiraViewQuery(jql, context), JiraViewQueryError, jql);

  const another = { id: 'other', name: '김 개발', email: 'other@example.test' };
  assert.throws(() => translateJiraViewQuery('assignee = "김 개발"', { ...context, users: [...context.users, another] }), JiraViewQueryError);
  assert.throws(() => translateJiraViewQuery('assignee = "Reserved sentinel"', {
    ...context, users: [{ id: 'none', name: 'Reserved sentinel', email: '' }],
  }), JiraViewQueryError);
  assert.throws(() => translateJiraViewQuery('status = "Reserved sentinel"', {
    ...context, statuses: [{ id: 'all', label: 'Reserved sentinel' }],
  }), JiraViewQueryError);
  assert.throws(() => translateJiraViewQuery('project = TEAM OR labels = a', context), { offset: 15 });
});

test('JQL parsing enforces text, list and nesting limits', () => {
  const list = Array.from({ length: 20 }, (_, i) => `label${i}`).join(', ');
  for (const input of [
    1, {}, null, '\t\r\n', 'x'.repeat(JIRA_SAVED_VIEW_QUERY_LIMIT + 1), 'labels = "\ud800"',
    `${'('.repeat(17)}labels = a${')'.repeat(17)}`,
    Array.from({ length: 41 }, () => 'labels = a').join(' AND '),
    Array.from({ length: 41 }, () => 'status = review').join(' OR '),
    `status IN (${Array.from({ length: ISSUE_VIEW_STATUS_LIMIT + 1 }, () => 'review').join(', ')})`,
    Array.from({ length: 15 }, () => `labels IN (${list})`).join(' AND '),
    `labels IN (${list}, extra)`,
    Array.from({ length: 21 }, (_, i) => `labels != label${i}`).join(' AND '),
    `labels = ${'x'.repeat(61)}`,
    `ORDER BY ${Array.from({ length: 11 }, () => 'Rank ASC').join(', ')}`,
  ]) assert.throws(() => translateJiraViewQuery(input, context), JiraViewQueryError);
});
