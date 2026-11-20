import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeIssueGitlabLinks } from '../../shared/issue-gitlab-view.js';
import { defaultIssueSchema } from '../../shared/issue-schema.js';
import { createIssueViewMatcher, IssueViewGitlabFilterError, parseIssueViewGitlabFilter } from '../../shared/issue-view.js';
import type { GitlabLink, Issue, SavedViewState } from '../../shared/types.js';

const now = '2026-11-20T00:00:00Z';
const schema = defaultIssueSchema('team');
const filters = { query: '', status: 'all', assigneeId: 'all', type: 'all' };

function issue(id: string): Issue {
  return {
    id, projectId: 'team', key: 'TS-1', title: 'Compare results', description: '', type: '작업', status: 'todo', priority: 'medium',
    assigneeId: null, collaboratorIds: [], parentId: null, labels: [], startDate: null, endDate: null, dueDate: null, estimate: null,
    cycle: null, module: null, release: null, createdAt: now, updatedAt: now, completedAt: null, version: 1,
  };
}

function link(issueId: string, kind: GitlabLink['kind'], state: string, extra: Partial<GitlabLink> = {}): GitlabLink {
  return { id: `${issueId}:${kind}:${state}`, issueId, kind, state, projectId: 42, iid: 1, title: kind,
    webUrl: 'https://git.example.test/team/project', updatedAt: now, ...extra };
}

function pipeline(
  objectId: number, state: string, { issueId = 'first', instance = '0123456789ab', repository = 42, branch = 'feature/TS-1', iid = 101 } = {},
): GitlabLink {
  return link(issueId, 'pipeline', state, {
    id: `gitlab:${instance}:${repository}:pipeline:${objectId}:${issueId}`,
    projectId: repository, sourceBranch: branch, iid,
  });
}

test('GitLab view filter validates the four exact criteria and an omitted filter', () => {
  assert.equal(parseIssueViewGitlabFilter(undefined), undefined);
  for (const criterion of ['open_merge_request', 'failed_pipeline', 'running_pipeline', 'no_activity']) {
    assert.equal(parseIssueViewGitlabFilter(criterion), criterion);
  }
  for (const invalid of [null, false, 0, [], {}, '', 'all', ' failed_pipeline', ['failed_pipeline']]) {
    assert.throws(() => parseIssueViewGitlabFilter(invalid), IssueViewGitlabFilterError);
  }
});

test('GitLab summaries use the newest pipeline object per linked ticket, instance, repository and branch', () => {
  const links = [
    { ...pipeline(100, 'failed', { iid: 200 }), updatedAt: '2026-11-20T02:00:00Z' },
    pipeline(101, 'success', { iid: 100 }),
    pipeline(200, 'pending', { repository: 7 }),
    pipeline(201, 'failed', { instance: 'abcdef012345' }),
    pipeline(301, 'failed', { branch: 'other' }),
    pipeline(401, 'pending', { branch: 'release' }),
    pipeline(402, 'canceled', { branch: 'release' }),
    pipeline(102, 'failed', { issueId: 'second' }),
    link('first', 'merge_request', 'opened'),
    link('first', 'merge_request', 'merged'),
    link('first', 'branch', 'deleted'),
    link('first', 'commit', 'committed'),
  ];
  for (const ordered of [links, [...links].reverse()]) {
    const summaries = summarizeIssueGitlabLinks(ordered);
    assert.deepEqual(summaries.get('first'), { activityCount: 11, openMergeRequests: 1, failedPipelines: 2, runningPipelines: 1 });
    assert.deepEqual(summaries.get('second'), { activityCount: 1, openMergeRequests: 0, failedPipelines: 1, runningPipelines: 0 });
    assert.equal(summaries.has('missing'), false);
  }
});

test('GitLab summaries retain independent legacy pipelines and distinguish queued and inactive states', () => {
  const states = ['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'manual', 'scheduled', 'skipped', 'unknown'];
  const links = [
    ...states.map(state => link('first', 'pipeline', state, { sourceBranch: 'feature/TS-1' })),
    pipeline(100, 'success'),
    { ...pipeline(101, 'failed'), sourceBranch: undefined },
    { ...pipeline(102, 'failed'), projectId: 77 },
  ];
  const summary = summarizeIssueGitlabLinks(links).get('first');
  assert.deepEqual(summary, { activityCount: 12, openMergeRequests: 0, failedPipelines: 2, runningPipelines: 5 });
});

test('GitLab criteria compose with ticket fields and do not treat branch or commit history as unlinked', () => {
  const gitlabLinks = [
    link('mr', 'merge_request', 'opened'), link('history', 'commit', 'committed'), link('closed', 'merge_request', 'closed'),
    pipeline(110, 'failed', { issueId: 'ci' }), pipeline(111, 'success', { issueId: 'ci' }),
    pipeline(1, 'failed', { issueId: 'broken' }), pipeline(4, 'running', { issueId: 'active' }),
  ];
  const tickets = ['mr', 'history', 'closed', 'ci', 'broken', 'active', 'unlinked'].map(issue);
  function result(criteria: Partial<SavedViewState['filters']>) {
    const match = createIssueViewMatcher({ ...filters, ...criteria }, { users: [], gitlabLinks }, schema);
    return tickets.filter(match).map(ticket => ticket.id);
  }
  assert.deepEqual(result({ gitlab: 'open_merge_request', query: 'compare', status: 'todo' }), ['mr']);
  assert.deepEqual(result({ gitlab: 'open_merge_request', query: 'different' }), []);
  assert.deepEqual(result({ gitlab: 'failed_pipeline' }), ['broken']);
  assert.deepEqual(result({ gitlab: 'running_pipeline' }), ['active']);
  assert.deepEqual(result({ gitlab: 'no_activity' }), ['unlinked']);
  assert.deepEqual(result({}), tickets.map(ticket => ticket.id));
  assert.equal(createIssueViewMatcher(filters, { users: [] }, schema)(issue('legacy')), true);
});
