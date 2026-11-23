import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDocumentLinkedWork } from '../../shared/document-linked-work.js';
import type { DocPage, Issue, ResourceLink, RichContent, WorkflowStatus } from '../../shared/types.js';
import { defaultWorkflow } from '../../shared/workflow-helpers.js';

const documentId = 'meeting';
const createdAt = '2026-11-01T00:00:00Z';
const project = { id: 'team', key: 'TEAM', name: '팀 프로젝트', description: '', color: '#326455', createdAt };
const assignee = { id: 'member', name: '담당 팀원', email: 'member@example.test', color: '#326455' };
const statuses: WorkflowStatus[] = [
  { id: 'checking', label: '검증 중', category: 'review', color: '#326455' },
  { id: 'released', label: '배포됨', category: 'done', color: '#326455' },
  { id: 'dropped', label: '철회됨', category: 'cancelled', color: '#326455' },
];
const workflows = [{ ...defaultWorkflow(project.id), statuses }];
const pinnedSource = { revisionId: 'decision-revision', from: 1, to: 3, text: '결정' };

function issue(key: string, extra: Partial<Issue> = {}): Issue {
  return {
    id: `issue-${key}`, key, projectId: project.id, title: key, description: '', type: '작업', status: 'checking',
    priority: 'medium', assigneeId: assignee.id, collaboratorIds: [], parentId: null, labels: [], startDate: null,
    endDate: null, dueDate: null, estimate: null, cycle: null, module: null, release: null, version: 1,
    createdAt, updatedAt: createdAt, completedAt: null, ...extra,
  };
}

function link(issueId: string, fields: Partial<ResourceLink> = {}): ResourceLink {
  return { id: `link-${issueId}`, documentId, issueId, kind: '연관 업무', ...fields };
}

function page(id: string, content: RichContent[]): DocPage {
  return {
    id, projectId: null, parentId: null, title: id, content: { type: 'doc', content }, plainText: '', icon: '📄',
    authorId: assignee.id, status: 'draft', version: 1, createdAt, updatedAt: createdAt,
  };
}

test('keeps only active work linked to the document and reads evidence independently of link kind', () => {
  const open = issue('TEAM-1', { dueDate: '2026-11-29', endDate: '2026-11-18' });
  const done = issue('TEAM-2', { status: 'released', assigneeId: null });
  const cancelled = issue('TEAM-3', { status: 'dropped', assigneeId: 'deleted-member', endDate: '2026-11-19' });
  const other = issue('TEAM-4');
  const followUp = link(open.id, { kind: '후속 업무' });
  const existing = link(done.id, { documentSource: pinnedSource });
  const cancelledLink = link(cancelled.id, { kind: '후속 업무', documentSource: pinnedSource });
  const data = {
    documents: [page(documentId, [])], issues: [done, other, cancelled, open], projects: [project], users: [assignee], workflows,
    resourceLinks: [existing, link(other.id, { documentId: 'another-document', documentSource: pinnedSource }),
      link('deleted-issue', { documentSource: pinnedSource }), followUp, cancelledLink],
  };
  const result = buildDocumentLinkedWork(data, documentId);
  assert.deepEqual(result.counts, { open: 1, closed: 2, evidence: 2 });
  assert.deepEqual(result.rows.map(row => row.link), [followUp, cancelledLink, existing]);
  assert.deepEqual(result.rows.map(row => [row.issue.id, row.closed, row.status.label, row.assigneeName, row.deadline]), [
    [open.id, false, '검증 중', assignee.name, { value: '2026-11-29', source: 'dueDate' }],
    [cancelled.id, true, '철회됨', null, { value: '2026-11-19', source: 'endDate' }],
    [done.id, true, '배포됨', null, null],
  ]);
  assert.ok(result.rows.every(row => row.projectName === project.name));
  assert.deepEqual(buildDocumentLinkedWork(data, 'unlinked-page'), { rows: [], counts: { open: 0, closed: 0, evidence: 0 } });
});

test('orders open work before closed work and breaks deadline ties by natural key and issue ID', () => {
  const tied = '2026-12-02';
  const issues = [
    issue('TEAM-1', { projectId: 'missing-project', status: 'unlisted', assigneeId: 'missing-member' }),
    issue('TEAM-10', { dueDate: tied }),
    issue('TEAM-2', { id: 'issue-z', dueDate: tied }),
    issue('TEAM-2', { id: 'issue-a', endDate: tied }),
    issue('TEAM-8', { dueDate: '2026-12-01' }),
    issue('TEAM-9', { dueDate: '2026-11-01', status: 'released' }),
  ];
  const data = { documents: [page(documentId, [])], issues, projects: [project], users: [assignee], workflows,
    resourceLinks: issues.map(item => link(item.id)) };
  const original = structuredClone(data);
  const expected = ['issue-TEAM-8', 'issue-a', 'issue-z', 'issue-TEAM-10', 'issue-TEAM-1', 'issue-TEAM-9'];
  const forward = buildDocumentLinkedWork(data, documentId);
  assert.deepEqual(forward.rows.map(row => row.issue.id), expected);
  assert.deepEqual(buildDocumentLinkedWork({ ...data, resourceLinks: data.resourceLinks.toReversed() }, documentId), forward);
  assert.equal(forward.rows[4].status.label, 'unlisted');
  assert.equal(forward.rows[4].projectName, null);
  assert.equal(forward.rows[4].assigneeName, null);
  assert.deepEqual(data, original);
});

test('merges only direct saved body references with real links and counts each active issue once', () => {
  const linked = issue('TEAM-1', { dueDate: '2026-11-28' });
  const referenced = issue('TEAM-2', { endDate: '2026-11-27' });
  const closed = issue('TEAM-3', { status: 'released' });
  const included = issue('TEAM-4');
  const reference = (issueId: string): RichContent => ({ type: 'issueReference', attrs: { issueId, label: '이전 제목' } });
  const nestedReference = { type: 'blockquote', content: [reference(linked.id)] };
  const realLink = link(linked.id, { documentSource: pinnedSource });
  const data = {
    documents: [page(documentId, [
      reference(linked.id), nestedReference, reference(referenced.id), reference(closed.id), reference('missing'),
      { type: 'documentInclude', attrs: { documentId: 'other' } },
      { type: 'documentRevisionInclude', attrs: { documentId: 'other', revisionId: 'older-revision' } },
      { type: 'issueList', attrs: { projectId: project.id, savedViewId: 'selected' } },
    ]), page('other', [reference(included.id)])],
    issues: [linked, referenced, closed, included], projects: [project], users: [assignee], workflows,
    resourceLinks: [realLink, link(included.id, { documentId: 'other' })],
  };
  const result = buildDocumentLinkedWork(data, documentId);
  assert.deepEqual(result.counts, { open: 2, closed: 1, evidence: 1 });
  assert.deepEqual(result.rows.map(({ issue, referenceCount, link }) => [issue.id, referenceCount, link]),
    [[referenced.id, 1, undefined], [linked.id, 2, realLink], [closed.id, 1, undefined]]);
  assert.equal(result.rows[0].assigneeName, assignee.name);
  assert.deepEqual(result.rows[0].deadline, { value: referenced.endDate, source: 'endDate' });
});
