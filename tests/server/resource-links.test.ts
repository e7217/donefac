import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { documentNodes } from '../../shared/document-references.js';
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import type { ApiKeyCreated, DecisionFollowUpDraftResult, DecisionFollowUpPage, DecisionFollowUpSource, DocPage, DocRevision,
  DocumentIssueLinkResult, Issue, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, ProjectWorkflow,
  ResourceLink, RichContent, WorkspaceSnapshot } from '../../shared/types.js';

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
  return { base, call, key, issue, document, connect, cite, directory };
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

  assert.ok(link.documentSource);
  const { revisionId, from, to } = link.documentSource;
  const reviewed = `${link.id}?${new URLSearchParams({ expectedDecisionRevisionId: revisionId, expectedDecisionFrom: String(from), expectedDecisionTo: String(to) })}`;
  await f.call(`${publicLinks}/${reviewed}`, 400, 'DELETE', undefined, writer);
  await f.call(`/resource-links/${reviewed}`, 200, 'DELETE');
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

test('decision follow-ups find original Jira and moved keys within scope and validate an alias-filtered draft', async t => {
  const f = await fixture(t);
  const sourceKey = 'HIST-17';
  const stageQuery = new URLSearchParams({ filename: 'decision-report.csv', product: 'jira', instanceKey: 'decision-report' });
  const stage = await fetch(`${f.base}/legacy-import/packages?${stageQuery}`, {
    method: 'POST', headers: { 'X-Actor-Id': spoofedActor, 'Content-Type': 'application/octet-stream' },
    body: ['Issue id,Issue key,Project key,Summary,Created,Updated,Status,Issue Type',
      `17,${sourceKey},HIST,이관 후 검토,2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task`].join('\r\n'),
  });
  const stagingResponse = await stage.text();
  assert.equal(stage.status, 201, stagingResponse);
  const pkg = JSON.parse(stagingResponse) as LegacyPackageSummary;
  const options = await f.call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`);
  const configuration = { ...options.defaultConfiguration, projects: options.defaultConfiguration.projects.map(value => ({
    ...value, key: 'ADOPT', name: '이관한 프로젝트',
  })) };
  const preview = await f.call<MigrationPreview>('/migrations/preview', 201, 'POST', { configuration });
  assert.ok(preview.canApply, JSON.stringify(preview.notices));
  const { import: { projectIds: [importedProject] } } = await f.call<MigrationApplyResult>(`/migrations/previews/${preview.id}/apply`, 201, 'POST', {
    expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements,
  });
  const snapshot = await f.call<WorkspaceSnapshot>('/workspace');
  const imported = snapshot.issues.find(value => value.projectId === importedProject && value.title === '이관 후 검토')!;
  assert.ok(imported);
  assert.notEqual(imported.key, sourceKey);
  const quote = '팀 검토에 반영할 결정';
  const allowedDocument = await f.document('팀 결정 문서', importedProject, paragraph(quote));
  const outsideDocument = await f.document('다른 프로젝트의 결정 문서', outsideProject, paragraph(quote));
  const selected = await f.cite(imported, allowedDocument, quote);
  const hidden = await f.cite(imported, outsideDocument, quote);
  const scoped = await f.key('read', [importedProject]);
  const team = '/decision-follow-ups';
  const projectReport = `/projects/${importedProject}/decision-follow-ups`;
  const query = new URLSearchParams({ q: ' ｈｉｓｔ－１７ ' });
  const projectPage = await f.call<DecisionFollowUpPage>(`${projectReport}?${query}`);
  assert.deepEqual(new Set(projectPage.items.map(item => item.linkId)), new Set([selected.id, hidden.id]));
  const scopedTeam = await f.call<DecisionFollowUpPage>(`/v1${team}?${query}`, 200, 'GET', undefined, scoped);
  assert.deepEqual([scopedTeam.total, scopedTeam.items.map(item => item.linkId)], [1, [selected.id]]);
  const scopedProject = await f.call<DecisionFollowUpPage>(`/v1${projectReport}?${query}`, 200, 'GET', undefined, scoped);
  assert.deepEqual(scopedProject.items, scopedTeam.items);
  const draft = await f.call<DecisionFollowUpDraftResult>(`${projectReport}/meeting-draft`, 201, 'POST', {
    requestId: randomUUID(), revision: projectPage.revision, q: 'ｈｉｓｔ－１７',
    title: '이전 업무 키로 검토할 회의 초안', destinationProjectId: importedProject,
  });
  assert.ok(draft.document.plainText.includes(quote));
  assert.ok(draft.document.plainText.includes(imported.key));

  const starting = await f.issue('프로젝트를 옮길 검토 업무');
  const movePath = `/issues/${starting.id}/project-move`;
  const move: IssueProjectMoveInput = { expectedVersion: starting.version, projectId: outsideProject, includeConnected: false, mappings: [] };
  const plan = await f.call<IssueProjectMovePreview>(`${movePath}/preview`, 200, 'POST', move);
  assert.ok(plan.token, JSON.stringify(plan.blockers));
  const { issues: [moved] } = await f.call<IssueProjectMoveResult>(`${movePath}/apply`, 200, 'POST', { ...move, token: plan.token });
  assert.notEqual(moved.key, starting.key);
  const movedLink = await f.cite(moved, outsideDocument, quote);
  const movedPage = await f.call<DecisionFollowUpPage>(`${team}?${new URLSearchParams({ q: starting.key.toLowerCase() })}`);
  assert.deepEqual(movedPage.items.map(item => [item.linkId, item.issue.key]), [[movedLink.id, moved.key]]);
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

test('team decision follow-ups aggregate actual project workflows and enforce both endpoint scopes', async t => {
  const f = await fixture(t);
  const statusId = 'shared_decision_review';
  for (const [projectId, label, category] of [
    [project, '첫 프로젝트 확인 중', 'review'], [outsideProject, '둘째 프로젝트 확인 완료', 'done'],
  ] as const) {
    const path = `/projects/${projectId}/workflow`;
    const current = await f.call<ProjectWorkflow>(path);
    await f.call(path, 200, 'PATCH', {
      ...current, expectedVersion: current.version, statuses: [...current.statuses, { id: statusId, label, category, color: '#4b8374' }],
    });
  }

  const text = '팀 보고서에 원문을 보내지 않는 합성 발췌';
  const query = 'Synthetic team decision';
  const first = await f.issue(`${query} first`, project, { status: statusId, endDate: '2027-03-06', assigneeId: owner });
  const second = await f.issue(`${query} second`, outsideProject, { status: statusId, dueDate: '2027-03-03', endDate: '2027-03-20', assigneeId: owner });
  const localSecond = await f.issue(`${query} local second`, outsideProject, { endDate: '2027-03-05', assigneeId: owner });
  const unassigned = await f.issue(`${query} unassigned`, outsideProject);
  const plain = await f.issue(`${query} ordinary link`);
  const ownDocument = await f.document('첫 프로젝트 회의록', project, paragraph(text));
  const crossDocument = await f.document('다른 프로젝트에 남긴 기존 근거', project, paragraph(text));
  const secondDocument = await f.document('둘째 프로젝트 회의록', outsideProject, paragraph(text));
  const commonDocument = await f.document('팀 공통 회의록', null, paragraph(text));
  const firstLink = await f.cite(first, ownDocument, text);
  const crossLink = await f.cite(second, crossDocument, text);
  const localLink = await f.cite(localSecond, secondDocument, text);
  const commonLink = await f.cite(unassigned, commonDocument, text);
  await f.connect(plain, ownDocument);
  const revised = await f.call<DocPage>(`/documents/${crossDocument.id}`, 200, 'PATCH', {
    expectedVersion: crossDocument.version, title: '변경된 원문 제목', content: paragraph('다시 편집한 현재 본문'),
  });

  const path = '/decision-follow-ups';
  const page = (filters: Record<string, string> = {}, token?: string) => f.call<DecisionFollowUpPage>(
    `${token ? '/v1' : ''}${path}?${new URLSearchParams({ q: query, status: 'all', ...filters })}`, 200, 'GET', undefined, token);
  const links = (result: DecisionFollowUpPage) => result.items.map(item => item.linkId);
  const all = await page();
  assert.equal(all.projectId, null);
  assert.equal(all.total, 4);
  assert.deepEqual(links(all), [crossLink.id, localLink.id, firstLink.id, commonLink.id]);
  assert.deepEqual(all.items.map(({ issue, document }) => [issue.projectId, issue.deadline, issue.deadlineSource, document.projectId]), [
    [outsideProject, '2027-03-03', 'dueDate', project], [outsideProject, '2027-03-05', 'endDate', outsideProject],
    [project, '2027-03-06', 'endDate', project], [outsideProject, null, null, null],
  ]);
  assert.equal(all.items[0].issue.statusLabel, '둘째 프로젝트 확인 완료');
  assert.equal(all.items[0].issue.statusCategory, 'done');
  assert.equal(all.items[2].issue.statusLabel, '첫 프로젝트 확인 중');
  assert.equal(all.items[2].issue.statusCategory, 'review');
  assert.equal(all.items[0].document.title, revised.title);
  assert.equal(all.items[0].source.title, crossDocument.title);
  assert.ok(!JSON.stringify(all).includes(text));
  assert.deepEqual(links(await page({ status: 'open' })), [localLink.id, firstLink.id, commonLink.id]);
  assert.deepEqual(links(await page({ status: 'closed' })), [crossLink.id]);
  assert.deepEqual(links(await page({ assigneeId: 'unassigned' })), [commonLink.id]);
  assert.deepEqual(links(await page({ assigneeId: owner, offset: '1' })), [localLink.id, firstLink.id]);
  const filtered = await page({ projectId: outsideProject, q: crossDocument.title });
  assert.equal(filtered.projectId, outsideProject);
  assert.deepEqual(links(filtered), [crossLink.id]);

  const firstScope = await f.key('read');
  const secondScope = await f.key('read', [outsideProject]);
  const both = await f.key('read', [project, outsideProject]);
  const unrestricted = await f.key('read', null);
  await f.call(`/v1${path}`, 401);
  assert.deepEqual(links(await page({}, firstScope)), [firstLink.id]);
  assert.deepEqual(links(await page({}, secondScope)), [localLink.id]);
  assert.deepEqual(links(await page({}, both)), [crossLink.id, localLink.id, firstLink.id]);
  const unrestrictedPage = await page({}, unrestricted);
  assert.ok(Number.isFinite(Date.parse(unrestrictedPage.generatedAt)));
  assert.deepEqual({ ...unrestrictedPage, generatedAt: all.generatedAt }, all);
  assert.deepEqual(links(await page({ projectId: outsideProject }, both)), [crossLink.id, localLink.id]);
  await f.call(`/v1${path}?projectId=${outsideProject}`, 403, 'GET', undefined, firstScope);
  await f.call(`${path}?projectId=absent-project`, 404);
  await f.call(`${path}?projectId=${project}&projectId=${outsideProject}`, 400);
  await f.call(`/projects/${project}${path}?projectId=${outsideProject}`, 400);
  const sourcePath = `/projects/${outsideProject}${path}/${crossLink.id}/source`;
  await f.call(`/v1${sourcePath}`, 403, 'GET', undefined, secondScope);
  assert.deepEqual(await f.call<DecisionFollowUpSource>(`/v1${sourcePath}`, 200, 'GET', undefined, both), {
    linkId: crossLink.id, documentId: crossDocument.id, source: crossLink.documentSource,
  });
});

type MeetingDraftResult = { document: DocPage; duplicate: boolean };
type DraftConflict = { details?: { reason?: string } };

function draftReportUrl(document: DocPage) {
  const href = [...documentNodes(document.content)].flatMap(node => node.marks ?? [])
    .find(mark => mark.type === 'link' && String(mark.attrs?.href).includes('/reports/decision-follow-ups'))?.attrs?.href;
  assert.equal(typeof href, 'string');
  return new URL(String(href).slice(1), 'http://teamspace.test');
}

test('project decision meeting draft preserves reviewed original excerpts and atomically records one ordinary backlink', async t => {
  const f = await fixture(t);
  const query = '프로젝트 초안 교차 확인 CHECK';
  const firstText = '편집 전에 고정한 결정 문장입니다.';
  const secondText = '같은 업무의 다른 결정 문장입니다.';
  const currentText = '고정 발췌와 별개로 작성한 현재 본문입니다.';
  const source = await f.document('최초 원문 제목', project, paragraph(firstText));
  const second = await f.document('추가 검토 원본', outsideProject, paragraph(secondText));
  const issue = await f.issue(`${query} 대상`, project, { assigneeId: owner, dueDate: '2030-01-04' });
  const other = await f.issue(`${query} 다른 프로젝트 업무`, outsideProject, { assigneeId: owner });
  const firstLink = await f.cite(issue, source, firstText);
  const secondLink = await f.cite(issue, second, secondText);
  await f.cite(other, source, firstText);
  await f.call(`/documents/${source.id}`, 200, 'PATCH', {
    expectedVersion: source.version, title: '현재 원문 제목', content: paragraph(currentText),
  });

  const path = `/projects/${project}/decision-follow-ups`;
  const draftPath = `${path}/meeting-draft`;
  const filters = { status: 'all', assigneeId: owner, q: query };
  const read = () => f.call<DecisionFollowUpPage>(`${path}?${new URLSearchParams(filters)}`);
  const prior = await read();
  assert.equal(prior.total, 2);
  assert.deepEqual(new Set(prior.items.map(item => item.linkId)), new Set([firstLink.id, secondLink.id]));
  assert.match(prior.revision, /^[a-f0-9]{64}$/u);
  assert.ok(Number.isFinite(Date.parse(prior.generatedAt)));
  assert.ok(!JSON.stringify(prior).includes(firstText));

  const input = { ...filters, requestId: randomUUID(), revision: prior.revision, title: '프로젝트 후속 검토 초안', destinationProjectId: outsideProject };
  const changed = await f.call<Issue>(`/issues/${issue.id}`, 200, 'PATCH', {
    expectedVersion: issue.version, dueDate: '2030-01-09',
  });
  const stale = await f.call<DraftConflict>(draftPath, 409, 'POST', input);
  assert.equal(stale.details?.reason, 'stale_report');
  assert.ok(!(await f.call<WorkspaceSnapshot>('/workspace')).documents.some(document => document.title === input.title));
  const reviewed = await read();
  assert.notEqual(reviewed.revision, prior.revision);
  const body = { ...input, revision: reviewed.revision };
  const searchChanged = await f.call<DraftConflict>(draftPath, 409, 'POST', { ...body, q: query.toLowerCase() });
  assert.equal(searchChanged.details?.reason, 'stale_report');
  const modeChanged = await f.call<DraftConflict>('/decision-follow-ups/meeting-draft', 409, 'POST', { ...body, projectId: project });
  assert.equal(modeChanged.details?.reason, 'stale_report');
  const unavailable = await f.call<DraftConflict>(draftPath, 422, 'POST', { ...body, destinationProjectId: 'missing-draft-project' });
  assert.equal(unavailable.details?.reason, 'destination_unavailable');

  const database = new DatabaseSync(join(f.directory, 'teamspace.sqlite'));
  try {
    const counts = () => ['documents', 'revisions', 'resource_links', 'activities', 'document_creation_requests']
      .map(table => database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count);
    const before = counts();
    database.exec("CREATE TRIGGER fail_decision_draft_receipt BEFORE INSERT ON document_creation_requests BEGIN SELECT RAISE(ABORT, 'synthetic decision draft receipt failure'); END");
    await f.call(draftPath, 500, 'POST', body);
    assert.deepEqual(counts(), before);
  } finally {
    database.exec('DROP TRIGGER IF EXISTS fail_decision_draft_receipt');
    database.close();
  }

  const created = await f.call<MeetingDraftResult>(draftPath, 201, 'POST', body);
  const { document } = created;
  assert.equal(created.duplicate, false);
  assert.equal(document.projectId, outsideProject);
  assert.equal(document.authorId, spoofedActor);
  assert.equal(document.status, 'draft');
  assert.equal(document.version, 1);
  const nodes = [...documentNodes(document.content)];
  assert.deepEqual(new Set(nodes.filter(node => node.type === 'blockquote')
    .map(node => node.content?.[0]?.content?.[0]?.text)), new Set([firstText, secondText]));
  assert.deepEqual(nodes.filter(node => node.type === 'issueReference').map(node => node.attrs?.issueId), [issue.id]);
  assert.deepEqual(new Set(nodes.filter(node => node.type === 'documentReference').map(node => node.attrs?.documentId)),
    new Set([source.id, second.id]));
  assert.ok(document.plainText.includes('최초 원문 제목'));
  assert.ok(document.plainText.includes('2030-01-09'));
  assert.ok(!document.plainText.includes(currentText));
  assert.ok(!document.plainText.includes(other.title));
  const backlink = draftReportUrl(document);
  assert.equal(backlink.pathname, `/${project}/reports/decision-follow-ups`);
  assert.deepEqual(Object.fromEntries(backlink.searchParams), filters);
  const [snapshot] = await f.call<DocRevision[]>(`/documents/${document.id}/revisions`);
  assert.deepEqual(snapshot.content, document.content);
  const state = await f.call<WorkspaceSnapshot>('/workspace');
  const links = state.resourceLinks.filter(link => link.documentId === document.id);
  assert.deepEqual(links.map(link => [link.issueId, link.documentSource]), [[issue.id, undefined]]);
  assert.deepEqual((await read()).items, reviewed.items);

  await f.call(`/issues/${issue.id}`, 200, 'PATCH', { expectedVersion: changed.version, dueDate: '2030-01-13' });
  assert.deepEqual(await f.call<MeetingDraftResult>(draftPath, 200, 'POST', body), { document, duplicate: true });
  assert.equal((await f.call<DraftConflict>(draftPath, 409, 'POST', { ...body, destinationProjectId: project })).details?.reason, 'request_conflict');
  await f.call(draftPath, 400, 'POST', { ...body, requestId: randomUUID(), projectId: outsideProject });
  const writeKey = await f.key('write', null);
  await f.call(`/v1${draftPath}`, 403, 'POST', { ...body, requestId: randomUUID() }, writeKey);
});

test('team decision meeting draft captures the reviewed offset and preserves valid evidence beside unavailable evidence', async t => {
  const f = await fixture(t);
  const query = '팀 회의 자료 페이지 검증';
  const available = '둘째 결정의 정상적인 고정 발췌입니다.';
  const broken = '셋째 결정의 원래 발췌입니다.';
  const corrupted = '다른 저장본에 없는 변조 텍스트입니다.';
  const first = await f.issue(`${query} 첫 페이지 이전 결정`, project, { dueDate: '2030-06-01' });
  const second = await f.issue(`${query} 정상 결정`, outsideProject, { dueDate: '2030-06-03' });
  const third = await f.issue(`${query} 확인 불가 결정`, project, { dueDate: '2030-06-05' });
  const firstDocument = await f.document('처음 결정 원문', project, paragraph(available));
  const secondDocument = await f.document('공통 공간 원문', null, paragraph(available));
  const thirdDocument = await f.document('누락 검증 원문', outsideProject, paragraph(broken));
  await f.cite(first, firstDocument, available);
  const secondLink = await f.cite(second, secondDocument, available);
  const thirdLink = await f.cite(third, thirdDocument, broken);

  const database = new DatabaseSync(join(f.directory, 'teamspace.sqlite'));
  try {
    database.prepare("UPDATE resource_links SET json=json_set(json,'$.documentSource.text',?) WHERE id=?")
      .run(corrupted, thirdLink.id);
  } finally { database.close(); }

  const path = '/decision-follow-ups';
  const draftPath = `${path}/meeting-draft`;
  const page = await f.call<DecisionFollowUpPage>(`${path}?${new URLSearchParams({ q: query, offset: '1' })}`);
  assert.equal(page.total, 3);
  assert.equal(page.offset, 1);
  assert.deepEqual(page.items.map(item => item.linkId), [secondLink.id, thirdLink.id]);
  const body = { requestId: randomUUID(), revision: page.revision, title: '팀 공통 결정 검토 초안', destinationProjectId: null, q: query, offset: 1 };
  const { document } = await f.call<MeetingDraftResult>(draftPath, 201, 'POST', body);
  assert.equal(document.projectId, null);
  assert.ok(document.plainText.includes(second.title));
  assert.ok(document.plainText.includes(third.title));
  assert.ok(!document.plainText.includes(first.title));
  assert.ok(document.plainText.includes(available));
  assert.ok(document.plainText.includes('저장된 결정 근거를 확인할 수 없습니다.'));
  assert.ok(!document.plainText.includes(corrupted));
  assert.ok(!document.plainText.includes(broken));
  const link = draftReportUrl(document);
  assert.match(link.pathname, /^\/[^/]+\/reports\/decision-follow-ups$/u);
  assert.deepEqual(Object.fromEntries(link.searchParams), { q: query, offset: '1', scope: 'team' });
  const state = await f.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(state.resourceLinks.filter(link => link.documentId === document.id).map(link => link.issueId), [second.id, third.id]);

  const empty = await f.call<DecisionFollowUpPage>(`${path}?${new URLSearchParams({ q: query, offset: '3' })}`);
  assert.equal(empty.items.length, 0);
  await f.call(draftPath, 422, 'POST', { ...body, requestId: randomUUID(), revision: empty.revision, offset: 3 });
  const scoped = await f.call<DecisionFollowUpPage>(`${path}?${new URLSearchParams({ q: query, projectId: outsideProject })}`);
  const { document: scopedDraft } = await f.call<MeetingDraftResult>(draftPath, 201, 'POST', {
    ...body, requestId: randomUUID(), revision: scoped.revision, title: '선택 프로젝트 결정 검토 초안', projectId: outsideProject, offset: 0,
    destinationProjectId: project,
  });
  assert.equal(scopedDraft.projectId, project);
  assert.deepEqual(Object.fromEntries(draftReportUrl(scopedDraft).searchParams), { q: query, scope: 'team', decisionProject: outsideProject });
  assert.deepEqual([...documentNodes(scopedDraft.content)].filter(node => node.type === 'issueReference').map(node => node.attrs?.issueId), [second.id]);
  const writeKey = await f.key('write', null);
  await f.call(`/v1${draftPath}`, 403, 'POST', { ...body, requestId: randomUUID() }, writeKey);
});
