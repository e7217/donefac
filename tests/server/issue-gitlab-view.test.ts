import assert from 'node:assert/strict';
import test from 'node:test';
import { isRestorableGitlabLink } from '../../shared/gitlab-links.js';
import { parseGitlabMergeReadiness } from '../../shared/gitlab-merge-readiness.js';
import { gitlabPipelineSource, gitlabPipelineSourceLabel } from '../../shared/gitlab-pipeline-source.js';
import { summarizeIssueGitlabLinks } from '../../shared/issue-gitlab-view.js';
import { defaultIssueSchema } from '../../shared/issue-schema.js';
import { createIssueViewMatcher, IssueViewGitlabFilterError, parseIssueViewGitlabFilter } from '../../shared/issue-view.js';
import type { GitlabLink, Issue, SavedViewState } from '../../shared/types.js';

const now = '2026-11-20T00:00:00.000Z';
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

test('GitLab view filter validates the exact criteria and an omitted filter', () => {
  assert.equal(parseIssueViewGitlabFilter(undefined), undefined);
  for (const criterion of ['open_merge_request', 'merge_blocked', 'failed_pipeline', 'running_pipeline', 'no_activity']) {
    assert.equal(parseIssueViewGitlabFilter(criterion), criterion);
  }
  for (const invalid of [null, false, 0, [], {}, '', 'all', ' failed_pipeline', ['failed_pipeline']]) {
    assert.throws(() => parseIssueViewGitlabFilter(invalid), IssueViewGitlabFilterError);
  }
});

test('GitLab readiness normalizes trustworthy merge status and positive legacy flags', () => {
  const normalize = (fields: Record<string, unknown>) => parseGitlabMergeReadiness(fields, now, 'read');
  for (const [detailed_merge_status, state] of Object.entries({
    mergeable: 'ready', not_approved: 'approval_required', requested_changes: 'changes_requested',
    ci_must_pass: 'ci_required', ci_still_running: 'ci_running', discussions_not_resolved: 'discussions_unresolved',
    approvals_syncing: 'checking', need_rebase: 'rebase_required', merge_request_blocked: 'dependency',
    security_policy_violations: 'policy', commits_status: 'blocked',
  })) assert.deepEqual(normalize({ detailed_merge_status }), { state, observedAt: now, source: 'read' });
  assert.equal(normalize({ draft: true, detailed_merge_status: 'mergeable' })?.state, 'draft');
  assert.equal(normalize({ work_in_progress: true })?.state, 'draft');
  assert.deepEqual(parseGitlabMergeReadiness({ draft: true }, now, 'webhook'), { state: 'draft', observedAt: now, source: 'webhook' });
  assert.equal(normalize({ has_conflicts: true, merge_status: 'can_be_merged' })?.state, 'conflict');
  assert.equal(normalize({ merge_status: 'cannot_be_merged' })?.state, 'blocked');
  assert.equal(normalize({ merge_status: 'cannot_be_merged_recheck' })?.state, 'checking');
  for (const fields of [
    {}, { draft: false, has_conflicts: false, blocking_discussions_resolved: false }, { merge_status: 'can_be_merged' },
    { detailed_merge_status: 'constructor', merge_status: 'cannot_be_merged' }, { detailed_merge_status: 'not_open' },
    { draft: 'true', has_conflicts: 'true' },
  ]) assert.equal(normalize(fields), undefined);
});

test('only open MRs with canonical normalized readiness can be restored', () => {
  const mr = link('first', 'merge_request', 'opened');
  const observation = { state: 'unknown', observedAt: now, source: 'webhook' };
  assert.ok(isRestorableGitlabLink(mr));
  assert.ok(isRestorableGitlabLink({ ...mr, mergeReadiness: observation }));
  for (const value of [null, {}, { ...observation, source: 'pipeline' }, { ...observation, state: 'mergeable' },
    { ...observation, observedAt: '2026-02-31T00:00:00.000Z' }, { ...observation, observedAt: '2026-11-20T00:00:00Z' },
    { ...observation, raw: 'unexpected' }]) {
    assert.equal(isRestorableGitlabLink({ ...mr, mergeReadiness: value }), false);
  }
  assert.equal(isRestorableGitlabLink({ ...mr, state: 'merged', mergeReadiness: observation }), false);
  assert.equal(isRestorableGitlabLink({ ...mr, kind: 'pipeline', mergeReadiness: observation }), false);
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
    assert.deepEqual(summaries.get('first'), { activityCount: 11, openMergeRequests: 1, blockedMergeRequests: 0, failedPipelines: 2, runningPipelines: 1 });
    assert.deepEqual(summaries.get('second'), { activityCount: 1, openMergeRequests: 0, blockedMergeRequests: 0, failedPipelines: 1, runningPipelines: 0 });
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
  assert.deepEqual(summary, { activityCount: 12, openMergeRequests: 0, blockedMergeRequests: 0, failedPipelines: 2, runningPipelines: 5 });
});

test('a successful push pipeline does not hide a failed MR pipeline until that source succeeds', () => {
  const mrFailure = { ...pipeline(100, 'failed'), pipelineSource: 'merge_request_event' };
  const pushSuccess = { ...pipeline(101, 'success'), pipelineSource: 'push' };
  const mrRetry = { ...pipeline(102, 'success'), pipelineSource: 'merge_request_event' };
  const matchesFailed = (gitlabLinks: GitlabLink[]) => createIssueViewMatcher({ ...filters, gitlab: 'failed_pipeline' },
    { users: [], gitlabLinks }, schema)(issue('first'));
  assert.equal(matchesFailed([pushSuccess, mrFailure]), true);
  assert.equal(matchesFailed([mrRetry, pushSuccess, mrFailure]), false);
});

test('tag and branch runs with the same source and ref have independent newest states', () => {
  const tagFailure = { ...pipeline(100, 'failed'), pipelineSource: 'push', pipelineTag: true };
  const branchFailure = { ...pipeline(101, 'failed'), pipelineSource: 'push', pipelineTag: false };
  const branchPending = { ...pipeline(102, 'pending'), pipelineSource: 'push' };
  const tagRetry = { ...pipeline(103, 'success'), pipelineSource: 'push', pipelineTag: true };
  assert.deepEqual(summarizeIssueGitlabLinks([branchPending, branchFailure, tagFailure]).get('first'), {
    activityCount: 3, openMergeRequests: 0, blockedMergeRequests: 0, failedPipelines: 1, runningPipelines: 1,
  });
  assert.equal(summarizeIssueGitlabLinks([tagRetry, branchPending, branchFailure, tagFailure]).get('first')?.failedPipelines, 0);
});

test('invalid and legacy sources stay out of the verified pipeline source groups', () => {
  const knownFailure = { ...pipeline(100, 'failed'), pipelineSource: 'push' };
  const legacyFailure = pipeline(101, 'failed');
  const invalidSource = { ...pipeline(102, 'success'), pipelineSource: 'push\n' };
  const unknownFutureSource = { ...pipeline(103, 'pending'), pipelineSource: 'new_gitlab_source' };
  assert.equal(summarizeIssueGitlabLinks([knownFailure, legacyFailure]).get('first')?.failedPipelines, 2);
  assert.deepEqual(summarizeIssueGitlabLinks([knownFailure, legacyFailure, invalidSource, unknownFutureSource]).get('first'), {
    activityCount: 4, openMergeRequests: 0, blockedMergeRequests: 0, failedPipelines: 1, runningPipelines: 1,
  });
});

test('pipeline source labels distinguish verified triggers, tags, and unavailable evidence', () => {
  for (const value of ['merge_request_event', 'push', 'a'.repeat(64), 'future_source_7']) {
    assert.equal(gitlabPipelineSource(value), value);
  }
  for (const value of [undefined, null, 3, [], '', ' push', 'PUSH', 'push\n', '9push', 'git-lab', 'a'.repeat(65)]) {
    assert.equal(gitlabPipelineSource(value), undefined);
    assert.equal(gitlabPipelineSourceLabel(value), '실행 유형 미확인');
  }
  assert.equal(gitlabPipelineSourceLabel('merge_request_event', false), 'MR');
  assert.equal(gitlabPipelineSourceLabel('schedule'), '예약');
  assert.equal(gitlabPipelineSourceLabel('push', true), '태그 · 푸시');
  assert.equal(gitlabPipelineSourceLabel('constructor'), '기타 실행 유형');
});

test('merge-blocked views count actionable readiness only for open merge requests', () => {
  const readiness = (state: NonNullable<GitlabLink['mergeReadiness']>['state']) => ({ state, observedAt: now, source: 'read' as const });
  const gitlabLinks = [
    link('review', 'merge_request', 'opened', { mergeReadiness: readiness('approval_required') }),
    link('review', 'merge_request', 'opened', { id: 'another-mr', mergeReadiness: readiness('changes_requested') }),
    link('pipeline', 'merge_request', 'opened', { mergeReadiness: readiness('ci_running') }),
    link('merged', 'merge_request', 'merged', { mergeReadiness: readiness('conflict') }),
    link('checking', 'merge_request', 'opened', { mergeReadiness: readiness('checking') }),
    link('ready', 'merge_request', 'opened', { mergeReadiness: readiness('ready') }),
    link('unknown', 'merge_request', 'opened', { mergeReadiness: readiness('unknown') }),
    link('legacy', 'merge_request', 'opened'),
  ];
  const match = createIssueViewMatcher({ ...filters, gitlab: 'merge_blocked' }, { users: [], gitlabLinks }, schema);
  const tickets = [...new Set(gitlabLinks.map(value => value.issueId))].map(issue);
  assert.deepEqual(tickets.filter(match).map(value => value.id), ['review', 'pipeline']);
  assert.equal(summarizeIssueGitlabLinks(gitlabLinks).get('review')?.blockedMergeRequests, 2);
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
