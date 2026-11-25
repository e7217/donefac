import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeliveryBlockers } from '../../server/delivery-blockers.js';
import { defaultWorkCalendar } from '../../shared/calendar.js';
import type { Dependency, GitlabLink, Issue, TeamScheduleBlocker } from '../../shared/types.js';
import { defaultWorkflow } from '../../shared/workflow-helpers.js';

const now = '2026-11-20T00:00:00.000Z';
const projectId = 'project';

function issue(key: string, fields: Partial<Issue> = {}): Issue {
  return {
    id: key, projectId, key, title: `업무 ${key}`, description: 'PRIVATE_DESCRIPTION', type: 'task',
    status: 'todo', priority: 'medium', assigneeId: null, collaboratorIds: [], parentId: null, labels: [],
    startDate: null, endDate: null, dueDate: null, estimate: null, cycle: null, module: null, release: null,
    createdAt: now, updatedAt: now, completedAt: null, version: 1,
    ...fields,
  };
}

function blocker(source: Issue, target: Issue, fields: Partial<TeamScheduleBlocker> = {}): TeamScheduleBlocker {
  return {
    id: `block:${source.id}:${target.id}`, sourceIssueId: source.id, targetIssueId: target.id,
    version: 1, ...fields,
  };
}

function dependency(source: Issue, target: Issue, fields: Partial<Dependency> = {}): Dependency {
  return {
    id: `dependency:${source.id}:${target.id}`, predecessorId: source.id, successorId: target.id,
    type: 'FS', lagDays: 0, ...fields,
  };
}

function link(issue: Issue, fields: Partial<GitlabLink> = {}): GitlabLink {
  return {
    id: `merge-request:${issue.id}`, issueId: issue.id, projectId: 42, iid: 1, kind: 'merge_request',
    title: 'PRIVATE_GITLAB_TITLE', state: 'opened', webUrl: 'https://git.example.invalid/private', updatedAt: now,
    mergeReadiness: { state: 'conflict', source: 'read', observedAt: now }, ...fields,
  };
}

function pipeline(issue: Issue, id: number, branch: string, state: string): GitlabLink {
  return link(issue, { id: `gitlab:0123456789ab:42:pipeline:${id}:${issue.id}`, kind: 'pipeline',
    sourceBranch: branch, state, mergeReadiness: undefined });
}

function input(overrides: Partial<Parameters<typeof buildDeliveryBlockers>[0]> = {}): Parameters<typeof buildDeliveryBlockers>[0] {
  return {
    targets: [], sources: [], blockers: [], dependencies: [], gitlabLinks: [], calendar: defaultWorkCalendar(projectId),
    data: { users: [], workflows: [], issueSchemas: [] },
    ...overrides,
  };
}

test('delivery blockers aggregate only active targets and authorize sources independently of the saved view', () => {
  const target = issue('TEAM-7', { status: 'team_review', assigneeId: 'member', startDate: '2026-11-23', endDate: '2026-11-26' });
  const clear = issue('TEAM-8');
  const closed = issue('TEAM-9', { status: 'released', endDate: '2026-11-20' });
  const cancelled = issue('TEAM-10', { status: 'cancelled' });
  const external = issue('OTHER-1', { projectId: 'authorized-other', endDate: '2026-11-20' });
  const hidden = issue('SECRET-1', { projectId: 'unavailable' });
  const legacy = issue('TEAM-1');
  const missingDate = issue('TEAM-2');
  const acceptedSource = issue('TEAM-3', { startDate: '2026-11-19' });
  const invalidSchedule = issue('TEAM-4', { endDate: '2026-11-20' });
  const configuration = input({
    targets: [target, closed, cancelled, clear, target, external],
    sources: [external, legacy, missingDate, acceptedSource, invalidSchedule],
    blockers: [
      blocker(external, target, { origin: 'jira' }), blocker(hidden, target, { origin: 'jira' }),
      blocker(target, legacy), blocker(closed, target),
      blocker(legacy, closed), blocker(legacy, cancelled), blocker(target, target),
    ],
    dependencies: [
      dependency(closed, target), dependency(external, target), dependency(hidden, target), dependency(missingDate, target),
      dependency(acceptedSource, target, { type: 'SS' }), dependency(invalidSchedule, target, { lagDays: 99_999 }),
    ],
    gitlabLinks: [
      link(target), link(target, { id: 'second-mr', mergeReadiness: { state: 'approval_required', source: 'webhook', observedAt: now } }),
      link(target, { id: 'merged-mr', state: 'merged' }), link(closed), link(cancelled), link(hidden),
      pipeline(target, 10, 'feature/TEAM-7', 'failed'), pipeline(target, 11, 'feature/TEAM-7', 'success'),
      pipeline(target, 15, 'release', 'failed'), pipeline(target, 20, 'pending', 'running'),
      pipeline(target, 21, 'manual', 'manual'), pipeline(target, 22, 'manual', 'manual'),
      pipeline(clear, 10, 'feature/TEAM-8', 'failed'), pipeline(clear, 11, 'feature/TEAM-8', 'success'),
    ],
    calendar: { ...defaultWorkCalendar(projectId), exceptions: [{ date: '2026-11-23', isWorking: false, label: '휴무' }] },
    data: {
      users: [{ id: 'member', name: '팀 담당자', email: 'private@example.invalid', color: '#3858be' }],
      issueSchemas: [],
      workflows: [{
        ...defaultWorkflow(projectId), statuses: [
          ...defaultWorkflow(projectId).statuses,
          { id: 'released', label: '배포 완료', category: 'done', color: '#47835c' },
          { id: 'team_review', label: '팀 검토', category: 'review', color: '#58a4bd' },
        ],
      }],
    },
  });
  const before = structuredClone(configuration);
  const result = buildDeliveryBlockers(configuration);
  assert.deepEqual(configuration, before);
  assert.deepEqual(result.counts, { open: 2, affected: 1, reasons: { issue_block: 1, schedule_conflict: 1, gitlab: 1 } });
  assert.equal(result.rows.length, 1);
  const [row] = result.rows;
  assert.deepEqual(row.issue, {
    id: target.id, projectId, key: target.key, title: target.title, status: 'team_review',
    statusLabel: '팀 검토', assigneeId: 'member', assigneeName: '팀 담당자', version: target.version,
  });
  assert.deepEqual(row.blockers.items.map(value => [value.key, value.projectId, value.origin]), [['OTHER-1', 'authorized-other', 'jira']]);
  assert.equal(row.blockers.total, 1);
  assert.deepEqual(row.scheduleConflicts, {
    total: 1,
    items: [{
      predecessor: { id: closed.id, projectId, key: closed.key, title: closed.title, status: 'released',
        statusLabel: '배포 완료', assigneeId: null, assigneeName: null, version: closed.version },
      type: 'FS', lagDays: 0, endpoint: 'startDate', scheduledDate: '2026-11-23', requiredDate: '2026-11-24',
    }],
  });
  assert.deepEqual(row.gitlab, { blockedMergeRequests: 2, failedPipelines: 1, manualPipelines: 1 });
  assert.deepEqual(row.gitlabEvidence?.map(evidence => [evidence.kind, evidence.state, evidence.number]), [
    ['merge_request', 'conflict', 1], ['merge_request', 'approval_required', 1], ['pipeline', 'failed', 15], ['pipeline', 'manual', 22],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|private@example|SECRET-1|https:\/\//);
});

test('GitLab blocker evidence is per category and publishes only exact credential-free object links', () => {
  const target = issue('TEAM-44');
  const repo = 'https://git.example.test:8443/install/team/release';
  const mrs = Array.from({ length: 6 }, (_, index) => link(target, {
    id: `merge-request:${index}`,
    iid: index + 1,
    webUrl: index === 1 ? 'https://someone:private@git.example.test/install/team/release/-/merge_requests/2'
      : `${repo}/-/merge_requests/${index + 1}?private_token=unpublished#private-anchor`,
  }));
  const failed = (id: number, href: string) => ({
    ...pipeline(target, id, `branch/${id}`, 'failed'), webUrl: href, pipelineSource: 'push',
  });
  const manual = { ...pipeline(target, 202, 'release', 'manual'), webUrl: `${repo}/-/pipelines/202?secret=remove`,
    pipelineSource: 'schedule', pipelineTag: true };
  const links = [...mrs, failed(103, `${repo}/-/pipelines/999`), failed(104, `${repo}/-/pipelines/104?private_token=unpublished`), manual];
  const [result] = buildDeliveryBlockers(input({ targets: [target], gitlabLinks: links })).rows;
  assert.deepEqual(result, buildDeliveryBlockers(input({ targets: [target], gitlabLinks: [...links].reverse() })).rows[0]);
  assert.deepEqual(result.gitlab, { blockedMergeRequests: 6, failedPipelines: 2, manualPipelines: 1 });
  assert.ok(result.gitlabEvidence);
  const evidence = (number: number) => result.gitlabEvidence?.find(value => value.number === number);
  assert.equal(result.gitlabEvidence.filter(value => value.kind === 'merge_request').length, 5);
  assert.deepEqual(evidence(1), {
    id: 'merge-request:0', kind: 'merge_request', repositoryId: 42, state: 'conflict', number: 1,
    repository: 'git.example.test:8443/install/team/release', href: `${repo}/-/merge_requests/1`,
  });
  assert.equal(evidence(2)?.href, undefined);
  assert.equal(evidence(103)?.href, undefined);
  assert.equal(evidence(104)?.href, `${repo}/-/pipelines/104`);
  assert.deepEqual(evidence(202), {
    id: manual.id, kind: 'pipeline', repositoryId: 42, state: 'manual', number: 202, source: 'schedule', tag: true,
    repository: 'git.example.test:8443/install/team/release', href: `${repo}/-/pipelines/202`,
  });
  assert.doesNotMatch(JSON.stringify(result), /private_token|private-anchor|unpublished|someone|\?secret|\/pipelines\/999|PRIVATE_GITLAB_TITLE/u);
});

test('delivery blockers caps ordered examples while preserving distinct counts', () => {
  const target = issue('TEAM-100', { startDate: '2026-11-20' });
  const sources = Array.from({ length: 24 }, (_, index) => issue(`TEAM-${index + 1}`, { endDate: '2026-11-20' }));
  const blockers = sources.map(source => blocker(source, target));
  const dependencies = sources.map(source => dependency(source, target));
  blockers.push({ ...blockers[0], id: 'duplicate-relation' });
  dependencies.push({ ...dependencies[0] });
  const result = buildDeliveryBlockers(input({ targets: [target], sources, blockers, dependencies }));
  assert.deepEqual(result, buildDeliveryBlockers(input({
    targets: [target], sources: [...sources].reverse(), blockers: [...blockers].reverse(), dependencies: [...dependencies].reverse(),
  })));
  assert.deepEqual(result.counts, { open: 1, affected: 1, reasons: { issue_block: 1, schedule_conflict: 1, gitlab: 0 } });
  const [row] = result.rows;
  assert.deepEqual([row.blockers.total, row.scheduleConflicts.total], [24, 24]);
  const expected = sources.slice(0, 20).map(source => source.key);
  assert.deepEqual(row.blockers.items.map(blocker => blocker.key), expected);
  assert.deepEqual(row.scheduleConflicts.items.map(conflict => conflict.predecessor.key), expected);
});

test('delivery blockers sorts by goal date or planned end, priority then numeric issue key', () => {
  const targets = [
    issue('TEAM-1', { dueDate: '2026-11-25', endDate: '2026-11-19', priority: 'urgent' }),
    issue('TEAM-4', { endDate: '2026-11-21', priority: 'low' }),
    issue('TEAM-10', { endDate: '2026-11-22', priority: 'high' }),
    issue('TEAM-9', { dueDate: '2026-11-22', priority: 'high' }),
    issue('TEAM-11', { dueDate: '2026-11-22', priority: 'urgent' }),
    issue('TEAM-2', { priority: 'medium' }),
    issue('TEAM-3', { priority: 'urgent' }),
  ];
  const result = buildDeliveryBlockers(input({ targets, gitlabLinks: targets.map(value => link(value)) }));
  assert.deepEqual(result.rows.map(row => [row.issue.key, row.deadline?.source ?? null]), [
    ['TEAM-4', 'endDate'], ['TEAM-11', 'dueDate'], ['TEAM-9', 'dueDate'], ['TEAM-10', 'endDate'],
    ['TEAM-1', 'dueDate'], ['TEAM-3', null], ['TEAM-2', null],
  ]);
  assert.deepEqual(result.counts, { open: 7, affected: 7, reasons: { issue_block: 0, schedule_conflict: 0, gitlab: 7 } });
});

test('delivery blockers clears reasons when saved state resolves the blockers', () => {
  const source = issue('TEAM-1', { endDate: '2026-11-20' });
  const target = issue('TEAM-2', { startDate: '2026-11-20' });
  const configuration = input({
    targets: [target], sources: [source], blockers: [blocker(source, target)], dependencies: [dependency(source, target)],
    gitlabLinks: [link(target), pipeline(target, 100, 'feature/TEAM-2', 'failed')],
  });
  assert.deepEqual(buildDeliveryBlockers(configuration).counts.reasons, { issue_block: 1, schedule_conflict: 1, gitlab: 1 });
  const resolved = buildDeliveryBlockers({
    ...configuration, sources: [{ ...source, status: 'done' }], targets: [{ ...target, startDate: '2026-11-23' }],
    gitlabLinks: [
      link(target, { state: 'closed' }), pipeline(target, 100, 'feature/TEAM-2', 'failed'), pipeline(target, 101, 'feature/TEAM-2', 'success'),
    ],
  });
  assert.deepEqual(resolved, { rows: [], counts: { open: 1, affected: 0, reasons: { issue_block: 0, schedule_conflict: 0, gitlab: 0 } } });
});
