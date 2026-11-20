import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJira } from '../../server/legacy-import-jira.js';
import { LegacyImportError } from '../../server/legacy-import-model.js';
import type { LegacyDataset } from '../../shared/types.js';

const cloud = 'https://cloud.example.test/rest/api/3/issue';
const server = 'https://jira.example.test/jira/rest/api/2/issue';
const time = '2025-02-10T14:30:00.000+0900';
const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '원본 기록' }] }] };

function issue(api = cloud, id = '1000', key = 'OLD-7', fields: Record<string, unknown> = {}) {
  return { id, key, self: `${api}/${id}`, fields: { summary: `업무 ${key}`, ...fields } };
}

function parseJson(files: Record<string, unknown>): LegacyDataset {
  const input = new Map(Object.entries(files).map(([path, data]) => [path, Buffer.from(JSON.stringify(data))]));
  return parseJira(input, 'jira-activity-fixture');
}

function activity(data: LegacyDataset) {
  return data.records.filter(row => row.kind === 'comment' || row.kind === 'history' && row.metadata.kind === 'worklog')
    .sort((left, right) => left.id.localeCompare(right.id));
}

function pagesWithDiagnostic(data: LegacyDataset, code: string) {
  return data.diagnostics.filter(row => row.code === code).map(row => row.path).sort();
}

test('rootless Cloud REST pages associate with the packaged issue and preserve ADF, actors, and restrictions', () => {
  const comments = { startAt: 0, maxResults: 50, total: 1, comments: [{
    id: '3000', self: `${cloud}/OLD-7/comment/3000?token=NEVER_STORE_ACTIVITY_TOKEN`,
    body: adf, author: { accountId: 'cloud-author', displayName: '가상 작성자' }, created: time,
    visibility: { type: 'role', value: 'Developers', token: 'NEVER_STORE_ACTIVITY_TOKEN' },
    properties: [{ key: 'sd.public.comment', value: { internal: true } }],
  }] };
  const worklogs = { startAt: 0, maxResults: 50, total: 1, worklogs: [{
    id: '4000', self: `${cloud}/1000/worklog/4000`, issueId: '1000',
    comment: adf, author: { accountId: 'cloud-author' }, created: time, started: time, timeSpentSeconds: 237,
    visibility: { type: 'group', value: 'team-only' },
  }] };
  const files = { '00-comments.json': comments, '01-worklogs.json': worklogs, '99-issue.json': issue() };
  const data = parseJson(files);
  assert.equal(data.source.format, 'jira-json');
  const [comment, worklog] = activity(data);
  assert.equal(activity(data).length, 2);
  assert.equal(comment.id, 'comment:3000');
  assert.equal(comment.containerId, '1000');
  assert.equal(comment.authorId, 'cloud-author');
  assert.equal(comment.createdAt, time);
  assert.equal(comment.textFormat, 'adf');
  assert.deepEqual(JSON.parse(comment.text), adf);
  assert.deepEqual(comment.metadata.visibility, { type: 'role', value: 'Developers' });
  assert.deepEqual(comment.metadata.properties, [{ key: 'sd.public.comment', value: { internal: true } }]);
  assert.ok(comment.references.some(ref => ref.kind === 'issue' && ref.sourceId === '1000' && ref.relation === 'commentOn'));
  assert.equal(worklog.id, 'history:worklog:4000');
  assert.equal(worklog.containerId, '1000');
  assert.equal(worklog.authorId, 'cloud-author');
  assert.equal(worklog.textFormat, 'adf');
  assert.deepEqual(JSON.parse(worklog.text), adf);
  assert.equal(worklog.metadata.timeSpentSeconds, '237');
  assert.deepEqual(worklog.metadata.visibility, { type: 'group', value: 'team-only' });
  assert.ok(worklog.references.some(ref => ref.kind === 'issue' && ref.sourceId === '1000' && ref.relation === 'worklogOf'));
  assert.ok(!data.diagnostics.some(row => /^(COMMENTS_PARTIAL|WORKLOGS_PARTIAL|JIRA_ACTIVITY_PAGE_|JSON_DIALECT_UNSUPPORTED)/.test(row.code)));
  assert.ok(!JSON.stringify(data).includes('NEVER_STORE_ACTIVITY_TOKEN'));
  assert.deepEqual(activity(parseJson({ 'a-issue.json': issue(), 'b-worklogs.json': worklogs, 'c-comments.json': comments })), activity(data));
});

test('Data Center page endpoints prove owner for empty pages and rows without self and combine with embedded offsets', () => {
  const first = { id: '4100', author: { key: 'server-author' }, comment: '첫 작업 시간', started: time, timeSpentSeconds: 200 };
  const second = { id: '4101', author: { key: 'server-author' }, issueId: '1100', comment: '두 번째 작업 시간', started: time, timeSpentSeconds: 300 };
  const third = { id: '4102', author: { key: 'server-author' }, comment: '세 번째 작업 시간', started: time, timeSpentSeconds: 400 };
  const data = parseJson({
    'standalone-comments.json': { self: `${server}/DC-8/comment`, startAt: 0, total: 0, comments: [] },
    'worklog-page.json': { self: `${server}/1100/worklog?startAt=0`, startAt: 0, total: 3, worklogs: [first, second] },
    'issue.json': issue(server, '1100', 'DC-8', { worklog: { startAt: 1, maxResults: 2, total: 3, worklogs: [second, third] } }),
  });
  assert.deepEqual(activity(data).map(row => [row.id, row.containerId, row.authorId, row.text, row.textFormat]), [
    ['history:worklog:4100', '1100', 'server-author', '첫 작업 시간', 'plain'],
    ['history:worklog:4101', '1100', 'server-author', '두 번째 작업 시간', 'plain'],
    ['history:worklog:4102', '1100', 'server-author', '세 번째 작업 시간', 'plain'],
  ]);
  assert.ok(!data.diagnostics.some(row => /^(COMMENTS_PARTIAL|WORKLOGS_PARTIAL|JIRA_ACTIVITY_PAGE_)/.test(row.code)));
});

test('missing offsets, incompatible overlaps and different totals report partial accepted Jira activity', () => {
  const comment = (id: string, issueId: string) => ({ id, self: `${cloud}/${issueId}/comment/${id}`, body: `댓글 ${id}` });
  const worklog = (id: string, issueId: string) => ({ id, self: `${cloud}/${issueId}/worklog/${id}`, issueId, timeSpentSeconds: 90 });
  const data = parseJson({
    'issue-gap.json': issue(cloud, '1001', 'OLD-8'),
    'missing-first.json': { startAt: 1, total: 2, comments: [comment('3100', '1001')] },
    'issue-overlap.json': issue(cloud, '1002', 'OLD-9', { comment: { startAt: 0, total: 2, comments: [comment('3200', '1002')] } }),
    'overlap.json': { startAt: 0, total: 2, comments: [comment('3201', '1002'), comment('3202', '1002')] },
    'issue-repeated-position.json': issue(cloud, '1003', 'OLD-10'),
    'same-comment-at-zero.json': { startAt: 0, total: 2, comments: [comment('3300', '1003')] },
    'same-comment-at-one.json': { startAt: 1, total: 2, comments: [comment('3300', '1003')] },
    'issue-totals.json': issue(cloud, '1004', 'OLD-11', { worklog: { startAt: 0, total: 2, worklogs: [worklog('4200', '1004')] } }),
    'different-total.json': { startAt: 1, total: 3, worklogs: [worklog('4201', '1004'), worklog('4202', '1004')] },
  });
  assert.deepEqual(data.diagnostics.filter(row => row.code === 'COMMENTS_PARTIAL').map(row => row.recordId).sort(),
    ['issue:1001', 'issue:1002', 'issue:1003']);
  assert.deepEqual(data.diagnostics.filter(row => row.code === 'WORKLOGS_PARTIAL').map(row => row.recordId), ['issue:1004']);
  assert.deepEqual(activity(data).map(row => row.id), [
    'comment:3100', 'comment:3200', 'comment:3201', 'comment:3202', 'comment:3300',
    'history:worklog:4200', 'history:worklog:4201', 'history:worklog:4202',
  ]);
});

test('a Jira activity page with contradictory or insufficient ownership evidence cannot add any activity', () => {
  const row = (id: string, self?: string) => ({ id, self, body: 'NEVER_PROJECT_UNRESOLVED_ACTIVITY' });
  const comments = (...items: ReturnType<typeof row>[]) => ({ startAt: 0, total: items.length, comments: items });
  const data = parseJson({
    'issue.json': issue(server),
    'other-issue.json': issue(server, '1001', 'OLD-8'),
    'no-issue-endpoint.json': { ...issue(server, '1002', 'OLD-9'), self: undefined },
    'wrong-issue-endpoint.json': { ...issue(server, '1003', 'OLD-10'), self: `${server}/1002` },
    'issue-ambiguous-a.json': issue(server, '1004', 'OLD-11'),
    'issue-ambiguous-b.json': issue(server, '1005', 'OLD-11'),
    'OLD-7-comments.json': comments(row('3000')),
    'cross-host.json': comments(row('3001', 'https://other.example.test/jira/rest/api/2/issue/1000/comment/3001')),
    'cross-context.json': comments(row('3002', 'https://jira.example.test/other/rest/api/2/issue/1000/comment/3002')),
    'child-mismatch.json': comments(row('3003', `${server}/1000/comment/9999`)),
    'kind-mismatch.json': comments(row('3004', `${server}/1000/worklog/3004`)),
    'mixed-rows.json': comments(row('3005', `${server}/1000/comment/3005`), row('3006', `${server}/1001/comment/3006`)),
    'root-entry-conflict.json': { self: `${server}/OLD-7/comment`, ...comments(row('3007'), row('3008', `${server}/1001/comment/3008`)) },
    'empty-rootless.json': comments(),
    'root-issueId-conflict.json': { self: `${server}/OLD-7/comment`, issueId: '1001', ...comments() },
    'no-issue-proof.json': comments(row('3009', `${server}/1002/comment/3009`)),
    'mismatched-issue-self.json': comments(row('3010', `${server}/1003/comment/3010`)),
    'ambiguous-key.json': comments(row('3011', `${server}/OLD-11/comment/3011`)),
    'other-issueId.json': { self: `${server}/OLD-7/worklog`, startAt: 0, total: 1, worklogs: [{
      id: '4001', issueId: '1001', comment: 'NEVER_PROJECT_UNRESOLVED_ACTIVITY', self: `${server}/1000/worklog/4001`,
    }] },
  });
  assert.equal(activity(data).length, 0);
  assert.deepEqual(pagesWithDiagnostic(data, 'JIRA_ACTIVITY_PAGE_OWNER_UNRESOLVED'), [
    'OLD-7-comments.json', 'ambiguous-key.json', 'child-mismatch.json', 'cross-context.json', 'cross-host.json',
    'empty-rootless.json', 'kind-mismatch.json', 'mismatched-issue-self.json', 'mixed-rows.json', 'no-issue-proof.json',
    'other-issueId.json', 'root-entry-conflict.json', 'root-issueId-conflict.json',
  ]);
  assert.ok(!JSON.stringify(data).includes('NEVER_PROJECT_UNRESOLVED_ACTIVITY'));
});

test('unprovable pagination shapes are diagnosed without projecting activity', () => {
  const row = { id: '3000', self: `${cloud}/1000/comment/3000`, body: 'NEVER_PROJECT_INVALID_PAGE' };
  const data = parseJson({
    'issue.json': issue(),
    'mixed-arrays.json': { self: `${cloud}/1000/comment`, startAt: 0, total: 1, comments: [row], worklogs: [] },
    'negative-start.json': { startAt: -1, total: 1, comments: [row] },
    'string-start.json': { startAt: '0', total: 1, comments: [row] },
    'beyond-total.json': { startAt: 1, total: 1, comments: [row] },
    'max-smaller-than-page.json': { startAt: 0, total: 1, maxResults: 0, comments: [row] },
    'missing-total.json': { startAt: 0, comments: [row] },
  });
  assert.equal(activity(data).length, 0);
  assert.deepEqual(pagesWithDiagnostic(data, 'JIRA_ACTIVITY_PAGE_INVALID'), [
    'beyond-total.json', 'max-smaller-than-page.json', 'missing-total.json', 'mixed-arrays.json', 'negative-start.json', 'string-start.json',
  ]);
  assert.ok(!JSON.stringify(data).includes('NEVER_PROJECT_INVALID_PAGE'));
});

test('conflicting copies of stable Jira comment and worklog IDs reject the package', () => {
  const embeddedComment = { id: '3000', body: '원래 댓글', created: time, author: { accountId: 'author' } };
  const embeddedWorklog = { id: '4000', comment: '원래 작업 시간', started: time, author: { accountId: 'author' }, timeSpentSeconds: 60 };
  const packagedIssue = issue(cloud, '1000', 'OLD-7', {
    comment: { startAt: 0, total: 1, comments: [embeddedComment] },
    worklog: { startAt: 0, total: 1, worklogs: [embeddedWorklog] },
  });
  const conflicts = [
    { comments: [{ ...embeddedComment, self: `${cloud}/1000/comment/3000`, body: '다른 내용' }] },
    { comments: [{ ...embeddedComment, self: `${cloud}/1000/comment/3000`, visibility: { type: 'group', value: 'restricted' } }] },
    { comments: [{ ...embeddedComment, self: `${cloud}/1001/comment/3000` }] },
    { worklogs: [{ ...embeddedWorklog, self: `${cloud}/1000/worklog/4000`, timeSpentSeconds: 120 }] },
    { worklogs: [{ ...embeddedWorklog, self: `${cloud}/1000/worklog/4000`, visibility: { type: 'role', value: 'restricted' } }] },
  ];
  for (const page of conflicts) {
    assert.throws(() => parseJson({
      'page.json': { startAt: 0, total: 1, ...page },
      'issue.json': packagedIssue,
      'other-issue.json': issue(cloud, '1001', 'OLD-8'),
    }), error => error instanceof LegacyImportError && error.status === 400, JSON.stringify(page));
  }
});
