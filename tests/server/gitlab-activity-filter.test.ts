import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendGitlabActivityFilters, DEFAULT_GITLAB_ACTIVITY_FILTERS, filterGitlabActivityLinks, gitlabActivityRepositories,
  readGitlabActivityFilters,
} from '../../shared/gitlab-activity-filter.js';
import type { GitlabActivityFilters } from '../../shared/gitlab-activity-filter.js';
import type { GitlabLink, Issue } from '../../shared/types.js';

const now = '2026-11-24T00:00:00.000Z';
const repository = 'https://git.example.test/team/service';
const issue: Issue = {
  id: 'first', projectId: 'team', key: 'TS-21', title: '로그인 상태', description: '', type: '작업', status: 'todo', priority: 'medium',
  assigneeId: null, collaboratorIds: [], parentId: null, labels: [], startDate: null, endDate: null, dueDate: null, estimate: null,
  cycle: null, module: null, release: null, createdAt: now, updatedAt: now, completedAt: null, version: 1,
};
const data = { issues: [issue], issueAliases: { first: [{ key: 'JIRA-21', source: 'jira' as const }] } };

function link(id: string, fields: Partial<GitlabLink> = {}): GitlabLink {
  return { id, issueId: issue.id, kind: 'merge_request', state: 'opened', title: '개발 변경', projectId: 42, iid: 21,
    webUrl: `${repository}/-/merge_requests/21`, updatedAt: now, ...fields };
}

function pipeline(objectId: number, state: string, fields: Partial<GitlabLink> = {}): GitlabLink {
  const issueId = fields.issueId ?? issue.id;
  return link(`gitlab:0123456789ab:42:pipeline:${objectId}:${issueId}`, {
    kind: 'pipeline', state, title: `pipeline ${objectId}`, iid: 35, webUrl: `${repository}/-/pipelines/${objectId}`,
    sourceBranch: 'feature/TS-21', pipelineSource: 'push', ...fields,
  });
}

test('GitLab activity routes persist only canonical object URLs and valid independent pages', () => {
  const pasted = 'https://user:private@git.example.test/team/service/merge_requests/21?token=secret#section';
  const params = new URLSearchParams({ lane: 'development', activityQ: pasted, activityScope: 'open_merge_requests',
    activityMrPage: '2', activityPipelinePage: '3', activityBranchPage: '01', activityCommitPage: '9999999999999999' });
  const expected: GitlabActivityFilters = { scope: 'open_merge_requests', query: `${repository}/-/merge_requests/21`,
    pages: { merge_request: 2, pipeline: 3 } };
  assert.deepEqual(readGitlabActivityFilters(params), expected);
  appendGitlabActivityFilters(params, { ...expected, query: pasted, pages: { ...expected.pages, branch: 1, commit: -2 } });
  assert.deepEqual(Object.fromEntries(params), { lane: 'development', activityQ: expected.query, activityScope: expected.scope,
    activityMrPage: '2', activityPipelinePage: '3' });
  for (const unsafe of ['text //user:private@git.example.test/group/repo', 'https://git.example.test/group/repo?secret=yes',
    'details https://user:private@git.example.test/group/repo/-/pipelines/8', 'ｈｔｔｐｓ：／／user:private@git.example.test/group/repo']) {
    appendGitlabActivityFilters(params, { ...DEFAULT_GITLAB_ACTIVITY_FILTERS, query: unsafe });
    assert.deepEqual(readGitlabActivityFilters(params), DEFAULT_GITLAB_ACTIVITY_FILTERS);
    assert.equal(params.has('activityQ'), false);
  }
  assert.deepEqual(Object.fromEntries(params), { lane: 'development' });
});

test('GitLab activity member selection round-trips alongside the existing route filters', () => {
  const params = new URLSearchParams({ view: 'development' });
  const withoutMember: GitlabActivityFilters = { scope: 'open_merge_requests', query: '!21', pages: { merge_request: 2 } };
  const filters = { ...withoutMember, memberId: 'user-test' };
  appendGitlabActivityFilters(params, filters);
  assert.deepEqual(Object.fromEntries(params), { view: 'development', activityScope: 'open_merge_requests', activityQ: '!21',
    activityMember: 'user-test', activityMrPage: '2' });
  assert.deepEqual(readGitlabActivityFilters(params), filters);

  for (const memberId of ['', '  ', 'member\nother', 'x'.repeat(201)]) {
    params.set('activityMember', memberId);
    assert.deepEqual(readGitlabActivityFilters(params), withoutMember);
    appendGitlabActivityFilters(params, { ...withoutMember, memberId });
    assert.equal(params.has('activityMember'), false);
  }
  params.set('activityMember', filters.memberId);
  appendGitlabActivityFilters(params, withoutMember);
  assert.deepEqual(readGitlabActivityFilters(params), withoutMember);
});

test('GitLab activity routes retain exact repository identity and drop malformed keys', () => {
  const filters: GitlabActivityFilters = { scope: 'running_pipelines', query: 'TS-21', memberId: 'user-test', pages: { pipeline: 2 } };
  const repo = { ...filters, repositoryKey: 'abcdef012345:42' };
  const params = new URLSearchParams();
  appendGitlabActivityFilters(params, repo);
  assert.equal(params.get('activityRepo'), repo.repositoryKey);
  assert.deepEqual(readGitlabActivityFilters(params), repo);
  for (const repositoryKey of ['42', 'abcdef012345:042', 'abcdef012345:0', 'abcdef012345:9007199254740992', 'abcdef012345:42\n', repository]) {
    params.set('activityRepo', repositoryKey);
    assert.deepEqual(readGitlabActivityFilters(params), filters);
    appendGitlabActivityFilters(params, { ...filters, repositoryKey });
    assert.equal(params.has('activityRepo'), false);
  }
});

test('GitLab repository review is exact across similarly named repositories and historical instances', () => {
  const first = link('gitlab:0123456789ab:42:merge_request:108:first');
  const renamed = link('gitlab:0123456789ab:42:merge_request:109:first', { webUrl: `${repository}-renamed/-/merge_requests/21`,
    updatedAt: '2026-11-25T00:00:00.000Z' });
  const similar = link('gitlab:0123456789ab:43:merge_request:108:first', { projectId: 43, webUrl: `${repository}-legacy/-/merge_requests/21` });
  const historical = link('gitlab:abcdef012345:42:merge_request:108:first', {
    webUrl: 'https://user:private@git-old.example.test/team/service/-/merge_requests/21?secret=token',
  });
  const uncertain = link('old-snapshot-id');
  const wrong = link('gitlab:0123456789ab:42:merge_request:110:first', { projectId: 43 });
  const links = [first, renamed, similar, historical, uncertain, wrong];
  const find = (repositoryKey: string | undefined, query = '') =>
    filterGitlabActivityLinks(data, links, { ...DEFAULT_GITLAB_ACTIVITY_FILTERS, repositoryKey, query });
  assert.deepEqual(find('0123456789ab:42'), [first, renamed]);
  assert.deepEqual(find('0123456789ab:43', first.webUrl), []);
  assert.deepEqual(find('0123456789ab:43', 'service'), [similar]);
  assert.deepEqual(find('abcdef012345:42'), [historical]);
  assert.deepEqual(find('unknown'), []);
  assert.deepEqual(find(undefined), links);
  assert.deepEqual(gitlabActivityRepositories(links).sort((a, b) => a.key.localeCompare(b.key)), [
    { key: '0123456789ab:42', label: 'git.example.test/team/service-renamed (#42)' },
    { key: '0123456789ab:43', label: 'git.example.test/team/service-legacy (#43)' },
    { key: 'abcdef012345:42', label: 'git-old.example.test/team/service (#42)' },
  ]);
});

test('GitLab activity search uses ticket aliases, safe object addresses and displayed numbers within the caller links', () => {
  const first = link('first', { title: 'MR 검토', sourceBranch: 'feature/TS-21' });
  const second = link('second', { iid: 213, webUrl: `${repository}/-/merge_requests/213` });
  const blocked = link('blocked', { mergeReadiness: { state: 'conflict', observedAt: now, source: 'read' } });
  const closed = link('closed', { state: 'closed', mergeReadiness: blocked.mergeReadiness });
  const run = pipeline(800, 'failed', { iid: 17, webUrl: 'https://user:private@git.example.test/team/service/-/pipelines/800?secret=token' });
  const links = [first, second, blocked, closed, run, pipeline(801, 'success', { iid: 170 })];
  const find = (query: string, scope: GitlabActivityFilters['scope'] = 'all') =>
    filterGitlabActivityLinks(data, links, { scope, query, pages: {} }).map(row => row.id);
  assert.deepEqual(find('  jira-21　team/service 로그인  검토'), ['first']);
  assert.deepEqual(find('TS-21 refs/heads/feature/TS-21', 'open_merge_requests'), ['first']);
  assert.deepEqual(find('!21'), ['first', 'blocked', 'closed']);
  assert.deepEqual(find('!21', 'blocked_merge_requests'), ['blocked']);
  assert.deepEqual(find('#17'), [run.id]);
  assert.deepEqual(find('#42'), []);
  assert.deepEqual(find('private'), []);
  assert.deepEqual(find('token'), []);
  assert.deepEqual(find(`${repository}/-/pipelines/800?token=ignored#ignored`), [run.id]);
  assert.deepEqual(find(`${repository}/-/pipelines/17`), []);
  assert.deepEqual(filterGitlabActivityLinks(data, [second], { ...DEFAULT_GITLAB_ACTIVITY_FILTERS, query: '!21' }), []);
});

test('failed and manual GitLab triage selects current pipeline representatives before text and address search', () => {
  const oldFailure = pipeline(800, 'failed', { title: 'Unique older failure', iid: 75, updatedAt: '2026-11-24T02:00:00.000Z' });
  const newestSuccess = pipeline(801, 'success', { iid: 74 });
  const latestGate = pipeline(802, 'manual', { pipelineSource: 'merge_request_event' });
  const oldGate = pipeline(799, 'manual', { pipelineSource: 'merge_request_event', title: 'Unique older gate' });
  const taggedFailure = pipeline(803, 'failed', { pipelineTag: true });
  const otherTicket = pipeline(805, 'failed', { issueId: 'second', title: 'Different ticket' });
  const links = [oldFailure, newestSuccess, latestGate, oldGate, taggedFailure, otherTicket];
  const find = (scope: GitlabActivityFilters['scope'], query = '') => filterGitlabActivityLinks(data, links, { scope, query, pages: {} });
  assert.deepEqual(find('failed_pipelines'), [taggedFailure, otherTicket]);
  assert.deepEqual(find('failed_pipelines', 'older failure'), []);
  assert.deepEqual(find('failed_pipelines', oldFailure.webUrl), []);
  assert.deepEqual(find('pipeline', 'older failure'), [oldFailure]);
  assert.deepEqual(find('manual_pipelines'), [latestGate]);
  assert.deepEqual(find('manual_pipelines', 'older gate'), []);
});

test('running GitLab triage follows board status and selects current runs before searching', () => {
  const oldRunning = pipeline(800, 'running', { title: 'Unique older run', updatedAt: '2026-11-24T02:00:00.000Z' });
  const newerSuccess = pipeline(801, 'success');
  const running = pipeline(802, 'running', { pipelineSource: 'merge_request_event' });
  const pendingTag = pipeline(803, 'pending', { pipelineTag: true });
  const created = pipeline(804, 'created', { sourceBranch: 'created' });
  const preparing = pipeline(805, 'preparing', { sourceBranch: 'preparing' });
  const waiting = pipeline(806, 'waiting_for_resource', { sourceBranch: 'waiting' });
  const manual = pipeline(807, 'manual', { sourceBranch: 'manual' });
  const links = [oldRunning, newerSuccess, running, pendingTag, created, preparing, waiting, manual];
  const find = (query = '') => filterGitlabActivityLinks(data, links, { scope: 'running_pipelines', query, pages: {} });
  assert.deepEqual(find(), [running, pendingTag, created, preparing, waiting]);
  assert.deepEqual(find('older run'), []);
  assert.deepEqual(find(oldRunning.webUrl), []);
  assert.deepEqual(find(running.webUrl), [running]);
});

test('GitLab activity member filtering includes assigned and collaborating tickets with the same scope and search rules', () => {
  const memberId = 'user-test';
  const assigned = { ...issue, assigneeId: memberId };
  const collaborating = { ...issue, id: 'collaborating', status: 'done', collaboratorIds: [memberId], reporterId: memberId };
  const reported = { ...issue, id: 'reported', reporterId: memberId };
  const other = { ...issue, id: 'other', assigneeId: 'other-user' };
  const workspace = { ...data, issues: [assigned, collaborating, reported, other] };
  const assignedMr = link('assigned', { issueId: assigned.id });
  const collaboratingMr = link('collaborating', { issueId: collaborating.id });
  const latestFailure = pipeline(800, 'failed', { issueId: collaborating.id });
  const links = [assignedMr, collaboratingMr, link('reported', { issueId: reported.id }), link('other', { issueId: other.id }),
    link('orphan', { issueId: 'missing' }), pipeline(799, 'failed', { issueId: assigned.id }), pipeline(801, 'success', { issueId: assigned.id }),
    latestFailure, pipeline(802, 'failed', { issueId: reported.id })];
  const find = (scope: GitlabActivityFilters['scope'], query: string) =>
    filterGitlabActivityLinks(workspace, links, { scope, query, memberId, pages: {} });

  assert.deepEqual(find('open_merge_requests', '!21'), [assignedMr, collaboratingMr]);
  assert.deepEqual(find('open_merge_requests', assignedMr.webUrl), [assignedMr, collaboratingMr]);
  assert.deepEqual(find('open_merge_requests', 'JIRA-21'), [assignedMr]);
  assert.deepEqual(find('failed_pipelines', ''), [latestFailure]);
  assert.deepEqual(filterGitlabActivityLinks(workspace, links, DEFAULT_GITLAB_ACTIVITY_FILTERS), links);
});
