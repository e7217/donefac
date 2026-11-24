import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendGitlabActivityFilters, DEFAULT_GITLAB_ACTIVITY_FILTERS, filterGitlabActivityLinks, readGitlabActivityFilters,
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
