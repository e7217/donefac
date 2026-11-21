import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { ApiKeyCreated, DecisionFollowUpPage, DecisionFollowUpSource, DocPage, DocumentIssueLinkResult, Issue, ResourceLink, RichContent, WorkspaceSnapshot } from '../../shared/types.js';

const project = 'project-neo';
const outsideProject = 'project-team';
const owner = 'user-min';
const spoofedActor = 'user-seo';
const publicLinks = '/v1/resource-links';
const issueLinks = (issue: Issue) => `/v1/issues/${issue.id}/resource-links`;
const documentLinks = (document: DocPage) => `/v1/documents/${document.id}/resource-links`;
const pair = (issue: Issue, document: DocPage) => ({ issueId: issue.id, documentId: document.id });
const paragraph = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-resource-links-'));
  const runtime = createApp({ dataDir: directory, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    try {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  async function call<T = unknown>(path: string, status = 200, method = 'GET', body?: unknown, token?: string) {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': spoofedActor, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json() as T;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  async function key(access: 'read' | 'write', projectIds: string[] | null = [project]) {
    const response = await fetch(`${base}/api-keys`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': owner },
      body: JSON.stringify({ name: '업무 문서 연결 검증', access, projectIds }) });
    assert.equal(response.status, 201);
    return (await response.json() as ApiKeyCreated).token;
  }
  const issue = (title: string, projectId = project, values?: Partial<Issue>) => call<Issue>('/issues', 201, 'POST', { ...values, title, projectId });
  const document = (title: string, projectId: string | null = project, content?: RichContent) =>
    call<DocPage>('/documents', 201, 'POST', { title, projectId, content });
  const connect = (source: Issue, target: DocPage) => call<ResourceLink>('/resource-links', 201, 'POST', pair(source, target));
  async function cite(issue: Issue, document: DocPage, text: string) {
    const { link } = await call<DocumentIssueLinkResult>(`/documents/${document.id}/decision-links`, 201, 'POST', {
      requestId: randomUUID(), expectedDocumentVersion: document.version, issueId: issue.id,
      sourceSelection: { from: 1, to: text.length + 1, text },
    });
    return link;
  }
  return { call, key, issue, document, connect, cite };
}

test('resource-link reads expose only active pairs whose endpoints are both allowed', async t => {
  const f = await fixture(t);
  const issue = await f.issue('범위 안 업무');
  const otherIssue = await f.issue('범위 밖 업무', outsideProject);
  const document = await f.document('범위 안 문서');
  const otherDocument = await f.document('범위 밖 문서', outsideProject);
  const commonDocument = await f.document('공통 문서', null);
  const own = await f.connect(issue, document);
  const crossDocument = await f.connect(issue, otherDocument);
  const crossIssue = await f.connect(otherIssue, document);
  const common = await f.connect(issue, commonDocument);
  const scoped = await f.key('read');
  const both = await f.key('read', [project, outsideProject]);
  const unrestricted = await f.key('read', null);

  await f.call(issueLinks(issue), 401);
  await f.call(documentLinks(document), 401);
  await f.call(issueLinks(otherIssue), 403, 'GET', undefined, scoped);
  await f.call(documentLinks(otherDocument), 403, 'GET', undefined, scoped);
  await f.call(documentLinks(commonDocument), 403, 'GET', undefined, both);
  await f.call(`${issueLinks(issue)}?projectId=${outsideProject}`, 400, 'GET', undefined, scoped);
  assert.deepEqual(await f.call(issueLinks(issue), 200, 'GET', undefined, scoped), [own]);
  assert.deepEqual(await f.call(documentLinks(document), 200, 'GET', undefined, scoped), [own]);
  assert.deepEqual(new Set(await f.call<ResourceLink[]>(issueLinks(issue), 200, 'GET', undefined, both)), new Set([own, crossDocument]));
  assert.deepEqual(new Set(await f.call<ResourceLink[]>(documentLinks(document), 200, 'GET', undefined, both)), new Set([own, crossIssue]));
  assert.deepEqual(new Set(await f.call<ResourceLink[]>(issueLinks(issue), 200, 'GET', undefined, unrestricted)), new Set([own, crossDocument, common]));
  assert.deepEqual(await f.call(documentLinks(commonDocument), 200, 'GET', undefined, unrestricted), [common]);

  await f.call(`/documents/${otherDocument.id}`, 200, 'DELETE');
  await f.call(documentLinks(otherDocument), 404, 'GET', undefined, unrestricted);
  await f.call(`/issues/${otherIssue.id}`, 200, 'DELETE');
  await f.call(issueLinks(otherIssue), 404, 'GET', undefined, unrestricted);
  assert.deepEqual(await f.call(issueLinks(issue), 200, 'GET', undefined, both), [own]);
  assert.deepEqual(await f.call(documentLinks(document), 200, 'GET', undefined, both), [own]);
});

test('resource-link writes authorize the stored pair, replay without changes, and record the key owner', async t => {
  const f = await fixture(t);
  const issue = await f.issue('자동화 연결 업무');
  const outsideIssue = await f.issue('다른 프로젝트 업무', outsideProject);
  const document = await f.document('자동화 연결 문서');
  const outsideDocument = await f.document('다른 프로젝트 문서', outsideProject);
  const commonDocument = await f.document('전체 키 공통 문서', null);
  const outside = await f.connect(outsideIssue, document);
  const reader = await f.key('read');
  const writer = await f.key('write');
  const unrestricted = await f.key('write', null);
  const fields = pair(issue, document);

  await f.call(publicLinks, 401, 'POST', fields);
  await f.call(`${publicLinks}/${outside.id}`, 401, 'DELETE');
  await f.call(publicLinks, 403, 'POST', fields, reader);
  for (const invalid of [pair(outsideIssue, document), pair(issue, outsideDocument), pair(issue, commonDocument)]) {
    await f.call(publicLinks, 403, 'POST', invalid, writer);
  }
  await f.call(publicLinks, 400, 'POST', { issueId: issue.id }, writer);
  await f.call(publicLinks, 404, 'POST', { ...fields, documentId: 'missing-document' }, writer);
  await f.call(`${publicLinks}/${outside.id}`, 403, 'DELETE', fields, writer);
  const common = await f.call<ResourceLink>(publicLinks, 201, 'POST', pair(issue, commonDocument), unrestricted);
  await f.call(`${publicLinks}/${common.id}`, 403, 'DELETE', undefined, writer);
  await f.call(`${publicLinks}/${common.id}`, 200, 'DELETE', undefined, unrestricted);

  const before = await f.call<WorkspaceSnapshot>('/workspace');
  const link = await f.call<ResourceLink>(publicLinks, 201, 'POST', { ...fields, kind: '자동화 참조', actorId: spoofedActor }, writer);
  assert.deepEqual(link, { id: link.id, ...fields, kind: '자동화 참조' });
  assert.deepEqual(await f.call(publicLinks, 200, 'POST', { ...fields, kind: '재시도 입력' }, writer), link);
  await f.call(`${publicLinks}/${link.id}`, 403, 'DELETE', undefined, reader);
  await f.call(`${publicLinks}/${link.id}?issueId=${issue.id}`, 400, 'DELETE', undefined, writer);
  await f.call(`${publicLinks}/${link.id}`, 200, 'DELETE', { actorId: spoofedActor }, writer);
  await f.call(`${publicLinks}/${link.id}`, 404, 'DELETE', undefined, writer);

  const after = await f.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(after.resourceLinks, before.resourceLinks);
  const actions = after.activities.filter(value => !before.activities.some(prior => prior.id === value.id));
  assert.deepEqual(actions.map(({ resourceId, actorId, action }) => ({ resourceId, actorId, action }))
    .sort((first, second) => first.action.localeCompare(second.action)), [
    { resourceId: issue.id, actorId: owner, action: '문서 연결' },
    { resourceId: issue.id, actorId: owner, action: '문서 연결 해제' },
  ]);
});

test('public reads and replay hide pinned decision text, and public deletion preserves it', async t => {
  const f = await fixture(t);
  const issue = await f.issue('결정 근거 업무');
  const text = '자동화 목록에서 제외할 결정 원문';
  const document = await f.document('결정 근거 문서', project, {
    type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const { link } = await f.call<DocumentIssueLinkResult>(`/documents/${document.id}/decision-links`, 201, 'POST', {
    requestId: randomUUID(), expectedDocumentVersion: document.version, issueId: issue.id,
    sourceSelection: { from: 1, to: text.length + 1, text },
  });
  assert.equal(link.documentSource?.text, text);
  const reader = await f.key('read');
  const writer = await f.key('write', null);
  const summary = { id: link.id, ...pair(issue, document), kind: link.kind };
  assert.deepEqual(await f.call(issueLinks(issue), 200, 'GET', undefined, reader), [summary]);
  assert.deepEqual(await f.call(documentLinks(document), 200, 'GET', undefined, writer), [summary]);
  const before = await f.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(await f.call(publicLinks, 200, 'POST', { ...pair(issue, document), kind: '일반 관련 문서' }, writer), summary);
  await f.call(`${publicLinks}/${link.id}`, 409, 'DELETE', { documentSource: null }, writer);
  const after = await f.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(after.resourceLinks.find(value => value.id === link.id), link);
  assert.deepEqual(after.activities, before.activities);

  await f.call(`/resource-links/${link.id}`, 200, 'DELETE');
  assert.deepEqual(await f.call(documentLinks(document), 200, 'GET', undefined, reader), []);
});

test('project decision follow-ups read the frozen source with current ticket metadata and scope both endpoints', async t => {
  const f = await fixture(t);
  const sourceText = '정확한 승인 근거만 보존한다.';
  const own = await f.document('Frozen Source %_ Original', project, paragraph(sourceText));
  const cross = await f.document('Other Project Decision', outsideProject, paragraph(sourceText));
  const common = await f.document('Common Decision', null, paragraph(sourceText));
  const ordinary = await f.document('Ordinary Document', project, paragraph(sourceText));
  const ticket = await f.issue('Verification ticket Title', project, { assigneeId: owner, dueDate: '2027-03-04', endDate: '2027-03-10' });
  const otherTicket = await f.issue('Outside verification ticket', outsideProject);
  const oldRelation = await f.connect(ticket, own);
  const ownLink = await f.cite(ticket, own, sourceText);
  const crossLink = await f.cite(ticket, cross, sourceText);
  const commonLink = await f.cite(ticket, common, sourceText);
  const otherLink = await f.cite(otherTicket, own, sourceText);
  await f.connect(ticket, ordinary);
  assert.equal(ownLink.id, oldRelation.id);
  assert.equal(ownLink.kind, oldRelation.kind);

  const path = `/projects/${project}/decision-follow-ups`;
  const sourcePath = (link: ResourceLink) => `${path}/${link.id}/source`;
  const page = (query: Record<string, string> = {}, token?: string) =>
    f.call<DecisionFollowUpPage>(`${token ? '/v1' : ''}${path}?${new URLSearchParams(query)}`, 200, 'GET', undefined, token);
  const ids = (result: DecisionFollowUpPage) => new Set(result.items.map(row => row.linkId));
  const exact = await page({ q: 'fRoZeN SoUrCe %_' });
  assert.equal(exact.total, 1);
  assert.deepEqual(ids(exact), new Set([ownLink.id]));
  assert.equal((await page({ q: sourceText })).total, 0);
  assert.equal((await page({ q: ticket.key.toLowerCase(), assigneeId: owner })).total, 3);
  assert.equal((await page({ assigneeId: 'unassigned' })).total, 0);
  assert.equal((await page({ status: 'closed' })).total, 0);

  const revised = await f.call<DocPage>(`/documents/${own.id}`, 200, 'PATCH', {
    expectedVersion: own.version, title: 'Renamed current document', content: paragraph('나중에 다시 작성한 현재 본문.'),
  });
  const expectedSource = ownLink.documentSource!;
  const current = (await page({ q: revised.title })).items[0];
  assert.deepEqual(current.document, { id: own.id, projectId: project, title: revised.title });
  assert.deepEqual({ ...current.source, createdAt: undefined }, {
    revisionId: expectedSource.revisionId, version: own.version, title: own.title, from: 1, to: sourceText.length + 1, createdAt: undefined,
  });
  assert.ok(Number.isFinite(Date.parse(current.source.createdAt)));
  assert.ok(!JSON.stringify(current).includes(sourceText));
  assert.deepEqual(await f.call<DecisionFollowUpSource>(sourcePath(ownLink)), { linkId: ownLink.id, documentId: own.id, source: expectedSource });
  assert.deepEqual(ids(await page()), new Set([ownLink.id, crossLink.id, commonLink.id]));
  await f.call(sourcePath(otherLink), 404);
  await f.call(`${path}?q=x&q=y`, 400);
  await f.call(`${path}?offset=-1`, 400);
  await f.call(`${path}?status=done`, 400);

  const scoped = await f.key('read');
  const both = await f.key('read', [project, outsideProject]);
  const workspace = await f.key('read', null);
  const outside = await f.key('read', [outsideProject]);
  await f.call(`/v1${path}`, 401);
  await f.call(`/v1${path}`, 403, 'GET', undefined, outside);
  assert.deepEqual(ids(await page({}, scoped)), new Set([ownLink.id]));
  assert.equal((await page({ q: cross.title }, scoped)).total, 0);
  assert.deepEqual(ids(await page({}, both)), new Set([ownLink.id, crossLink.id]));
  assert.deepEqual(ids(await page({}, workspace)), new Set([ownLink.id, crossLink.id, commonLink.id]));
  await f.call(`/v1${sourcePath(crossLink)}`, 403, 'GET', undefined, scoped);
  await f.call(`/v1${sourcePath(commonLink)}`, 403, 'GET', undefined, both);
  assert.deepEqual(await f.call<DecisionFollowUpSource>(`/v1${sourcePath(crossLink)}`, 200, 'GET', undefined, both), {
    linkId: crossLink.id, documentId: cross.id, source: crossLink.documentSource,
  });

  const changed = await f.call<Issue>(`/issues/${ticket.id}`, 200, 'PATCH', {
    expectedVersion: ticket.version, status: 'done', assigneeId: null, dueDate: null,
  });
  assert.equal((await page()).total, 0);
  const closed = await page({ status: 'closed', assigneeId: 'unassigned' });
  assert.equal(closed.total, 3);
  assert.ok(closed.items.every(row => row.issue.statusCategory === 'done' && row.issue.deadline === '2027-03-10' && row.issue.deadlineSource === 'endDate'));
  const deletedDoc = await f.call<{ trashEntryId: string }>(`/documents/${own.id}`, 200, 'DELETE', { expectedVersion: revised.version });
  await f.call(sourcePath(ownLink), 404);
  assert.equal((await page({ status: 'all' })).total, 2);
  await f.call(`/trash/${deletedDoc.trashEntryId}/restore`, 200, 'POST');
  assert.equal((await page({ status: 'all' })).total, 3);
  const deletedIssue = await f.call<{ trashEntryId: string }>(`/issues/${ticket.id}`, 200, 'DELETE', { expectedVersion: changed.version });
  await f.call(sourcePath(ownLink), 404);
  assert.equal((await page({ status: 'all' })).total, 0);
  await f.call(`/trash/${deletedIssue.trashEntryId}/restore`, 200, 'POST');
  assert.deepEqual(await f.call<DecisionFollowUpSource>(sourcePath(ownLink)), { linkId: ownLink.id, documentId: own.id, source: expectedSource });
  assert.equal((await page({ status: 'all' })).total, 3);
});

test('decision follow-up pages use deadline priority and stable link ordering at the page boundary', async t => {
  const f = await fixture(t);
  const sourceText = '페이지 순서 검증에 쓰는 문장';
  const source = await f.document('Paging Decision', project, paragraph(sourceText));
  const first = await f.issue('Decision paging first', project, { dueDate: '2027-01-01', endDate: '2027-02-05' });
  const last = await f.issue('Decision paging undated', project);
  const firstId = (await f.cite(first, source, sourceText)).id;
  const lastId = (await f.cite(last, source, sourceText)).id;
  const ids: string[] = [];
  for (let index = 0; index < 20; index++) {
    const issue = await f.issue(`Decision paging tie ${index}`, project, { endDate: '2027-01-03' });
    ids.push((await f.cite(issue, source, sourceText)).id);
  }
  const route = `/projects/${project}/decision-follow-ups?q=Decision+paging`;
  const page = await f.call<DecisionFollowUpPage>(route);
  const next = await f.call<DecisionFollowUpPage>(`${route}&offset=20`);
  assert.deepEqual([page.limit, page.offset, page.total, next.offset, next.total], [20, 0, 22, 20, 22]);
  assert.deepEqual([...page.items, ...next.items].map(row => row.linkId), [firstId, ...ids.sort(), lastId]);
  assert.deepEqual((await f.call<DecisionFollowUpPage>(route)).items, page.items);
});
