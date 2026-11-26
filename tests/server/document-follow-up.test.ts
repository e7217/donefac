import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../server/app.js';
import { DOCUMENT_CONTENT_SCHEMA_VERSION } from '../../shared/document-nodes.js';
import { documentNodes } from '../../shared/document-references.js';
import { documentChecklistItemSelection } from '../../shared/document-selection.js';
import { createEditorSchema } from '../../shared/editor-schema.js';
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { ApiKeyCreated, Comment, DecisionFollowUpDraftResult, DecisionFollowUpPage, DecisionFollowUpSource, DocPage, DocRevision, DocumentChecklistWork,
  DocumentCommentReplyResult, DocumentSelectionCommentResult, DocumentSourceSelection, Issue, Project, ResourceLink, RichContent,
  WorkspaceSnapshot } from '../../shared/types.js';

const projectId = 'project-neo';
const commonTarget = 'project-team';
const actorId = 'user-seo';
const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '합성 결정 원문' }] }] };
type Created = { issue: Issue; link: ResourceLink; duplicate: boolean };
type FollowUpInput = {
  requestId: string;
  expectedDocumentVersion: number;
  issue: { projectId: string; title: string; assigneeId?: string };
  sourceSelection?: { from: number; to: number; text: string };
  sourceComment?: { commentId: string; revisionId: string };
};
type Backup = WorkspaceSnapshot & {
  schemaVersion: number;
  trashEntries: { id: string; resourceId: string; resourceLinks: ResourceLink[] }[];
};
const pathFor = (documentId: string) => `/documents/${documentId}/follow-up-issues`;
const decisionPathFor = (documentId: string) => `/documents/${documentId}/decision-links`;

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-document-follow-up-'));
  async function start() {
    const runtime = createApp({ dataDir: directory, outboundWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { runtime, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
  }
  let service = await start();
  async function stop() {
    const { runtime, server } = service;
    try {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally { runtime.close(); }
  }
  t.after(async () => {
    try { await stop(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, status = 200, headers: Record<string, string> = {}) {
    const response = await fetch(service.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    return JSON.parse(text) as T;
  }
  async function restart() { await stop(); service = await start(); }
  async function key(projectIds: string[] | null, access: 'read' | 'write' = 'write', owner = actorId) {
    const { token } = await call<ApiKeyCreated>('/api-keys', 'POST', { name: '후속 업무 회귀 검사용 키', access, projectIds }, 201, { 'X-Actor-Id': owner });
    return { Authorization: `Bearer ${token}`, 'X-Actor-Id': 'user-jun' };
  }
  return { call, directory, restart, key, get base() { return service.base; } };
}

function followUp(document: DocPage, target: string, title: string): FollowUpInput {
  return { requestId: randomUUID(), expectedDocumentVersion: document.version, issue: { projectId: target, title } };
}

function decisionLink(document: DocPage, issue: Issue, sourceSelection: DocumentSourceSelection = {
  from: 1, to: document.plainText.length + 1, text: document.plainText,
}) {
  return { requestId: randomUUID(), expectedDocumentVersion: document.version, issueId: issue.id, sourceSelection };
}

function decisionRemovalQuery({ revisionId, from, to }: Omit<NonNullable<ResourceLink['documentSource']>, 'text'>) {
  return new URLSearchParams({ expectedDecisionRevisionId: revisionId, expectedDecisionFrom: String(from), expectedDecisionTo: String(to) });
}

function issueSummaryBody(project: string): RichContent {
  return { ...content, content: [...content.content, { type: 'issueSummary', attrs: {
    projectId: project, savedViewId: null, label: '다른 프로젝트의 업무 현황', groupBy: 'status',
  } }] };
}

async function sentenceComment(call: Awaited<ReturnType<typeof fixture>>['call'], document: DocPage) {
  const text = content.content[0].content[0].text;
  const { comment } = await call<DocumentSelectionCommentResult>(`/documents/${document.id}/selection-comments`, 'POST', {
    requestId: randomUUID(), expectedDocumentVersion: document.version,
    sourceSelection: { from: 1, to: text.length + 1, text }, body: '원래 설계에서 확인할 사항입니다.',
  }, 201);
  assert.ok(comment.documentSource);
  return { comment, source: comment.documentSource };
}

test('meeting draft selection contains only approved decisions from the exact report page', async t => {
  const { call } = await fixture(t);
  const query = '선택할 회의 안건';
  async function item(index: number) {
    const excerpt = `회의에서 검토할 결정 ${index}`;
    const source = await call<DocPage>('/documents', 'POST', { projectId, title: `회의 근거 문서 ${index}`, content: {
      type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: excerpt }] }],
    } }, 201);
    const issue = await call<Issue>('/issues', 'POST', { projectId, title: `${query} ${index}`, dueDate: `2030-11-0${index}` }, 201);
    const { link } = await call<Created>(decisionPathFor(source.id), 'POST', decisionLink(source, issue), 201);
    return { issue, source, link, excerpt };
  }
  const offPage = await item(1), first = await item(2), excluded = await item(3), last = await item(4);
  const path = `/projects/${projectId}/decision-follow-ups`;
  const draftPath = `${path}/meeting-draft`;
  const filters = { q: query, offset: 1 };
  const read = () => call<DecisionFollowUpPage>(`${path}?${new URLSearchParams({ q: query, offset: '1' })}`);
  const draftTitle = '고른 안건만 포함하는 회의록';
  const requestId = randomUUID();
  const original = await read();
  assert.equal(original.total, 4);
  assert.deepEqual(original.items.map(row => row.linkId), [first.link.id, excluded.link.id, last.link.id]);
  const body = { ...filters, requestId, revision: original.revision, title: draftTitle, destinationProjectId: projectId };
  for (const linkIds of [[], [null], [first.link.id, first.link.id], '/bad', ['/bad'], Array.from({ length: 21 }, () => randomUUID())]) {
    await call(draftPath, 'POST', { ...body, linkIds }, 400);
  }
  const unavailable = await call<{ error: string }>(draftPath, 'POST', { ...body, linkIds: [offPage.link.id] }, 422);
  assert.deepEqual(await call(draftPath, 'POST', { ...body, linkIds: [randomUUID()] }, 422), unavailable);

  const changed = await call<Issue>(`/issues/${first.issue.id}`, 'PATCH', { expectedVersion: first.issue.version, title: `${first.issue.title} 최신` });
  const stale = await call<{ details?: { reason?: string } }>(draftPath, 'POST', { ...body, linkIds: [offPage.link.id] }, 409);
  assert.equal(stale.details?.reason, 'stale_report');
  assert.ok(!(await call<WorkspaceSnapshot>('/workspace')).documents.some(document => document.title === draftTitle));

  const reviewed = await read();
  assert.notEqual(reviewed.revision, original.revision);
  const input = { ...body, revision: reviewed.revision, linkIds: [last.link.id, first.link.id] };
  const created = await call<DecisionFollowUpDraftResult>(draftPath, 'POST', input, 201);
  const { document } = created;
  const nodes = [...documentNodes(document.content)];
  assert.deepEqual(nodes.filter(node => node.type === 'blockquote').map(node => node.content?.[0]?.content?.[0]?.text), [first.excerpt, last.excerpt]);
  const pins = nodes.filter(node => node.type === 'documentRevisionInclude').map(node => node.attrs);
  assert.deepEqual(pins, [first, last].map(item => {
    assert.ok(item.link.documentSource);
    return { documentId: item.source.id, revisionId: item.link.documentSource.revisionId, label: item.source.title };
  }));
  assert.deepEqual(nodes.filter(node => node.type === 'documentReference').map(node => node.attrs?.documentId), [first.source.id, last.source.id]);
  assert.deepEqual(nodes.filter(node => node.type === 'issueReference').map(node => node.attrs?.issueId), [first.issue.id, last.issue.id]);
  assert.ok(document.plainText.includes(changed.title));
  for (const omitted of [offPage, excluded]) {
    assert.ok(!document.plainText.includes(omitted.excerpt));
    assert.ok(!document.plainText.includes(omitted.issue.title));
    assert.ok(!document.plainText.includes(omitted.source.title));
  }
  assert.match(document.plainText, /결정 근거 4건 중 현재 보고서 페이지에서 선택한 2건/u);
  const reportLink = nodes.flatMap(node => node.marks ?? []).find(mark => mark.type === 'link')?.attrs?.href;
  assert.equal(reportLink, `#/${projectId}/reports/decision-follow-ups?${new URLSearchParams({ q: query, offset: '1' })}`);
  const after = await call<WorkspaceSnapshot>('/workspace');
  const resultLinks = after.resourceLinks.filter(link => link.documentId === document.id);
  assert.deepEqual(new Set(resultLinks.map(link => link.issueId)), new Set([first.issue.id, last.issue.id]));
  assert.equal(resultLinks.length, 2);

  assert.deepEqual(await call<DecisionFollowUpDraftResult>(draftPath, 'POST', { ...input, linkIds: [first.link.id, last.link.id] }),
    { ...created, duplicate: true });
  const conflict = await call<{ details?: { reason?: string } }>(draftPath, 'POST', { ...input, linkIds: [first.link.id] }, 409);
  assert.equal(conflict.details?.reason, 'request_conflict');
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), after);

  assert.ok(first.link.documentSource);
  const fixedSourcePath = `/documents/${first.source.id}/include-revisions/${first.link.documentSource.revisionId}`;
  const fixed = await call<DocRevision>(fixedSourcePath);
  assert.equal(fixed.title, first.source.title);
  assert.equal(fixed.plainText, first.excerpt);
  await call(`/documents/${first.source.id}`, 'DELETE');
  assert.deepEqual(await call<DocRevision>(fixedSourcePath), fixed);
  assert.deepEqual(await call<DecisionFollowUpDraftResult>(draftPath, 'POST', input), { ...created, duplicate: true });

  const backup = await call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  await call('/import', 'POST', { data: backup });
  assert.deepEqual(await call<DocRevision>(fixedSourcePath), fixed);
  const restored = (await call<WorkspaceSnapshot>('/workspace')).documents.find(item => item.id === document.id);
  assert.deepEqual(restored?.content, document.content);
  const replaced = await call<{ details?: { reason?: string } }>(draftPath, 'POST', input, 409);
  assert.equal(replaced.details?.reason, 'result_unavailable');
});

test('checklist work reads exact item evidence across metadata revisions and skips partial and archived links', async t => {
  const { call, directory, key, base } = await fixture(t);
  const text = '같은 체크리스트 🔎';
  const paragraph = (value = text): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text: value }] });
  const item = (...children: RichContent[]): RichContent => ({
    type: 'taskItem', attrs: { checked: false }, content: [paragraph(), ...children],
  });
  const list = (...children: RichContent[]): RichContent => ({ type: 'taskList', content: children });
  const body: RichContent = { type: 'doc', content: [paragraph(), list(item(paragraph()), item(list(item())))] };
  const document = await call<DocPage>('/documents', 'POST', { projectId, title: '체크리스트 근거 검증', content: body }, 201);

  const ranges: DocumentSourceSelection[] = [];
  createEditorSchema().nodeFromJSON(document.content).descendants((node, pos) => {
    if (node.isText && node.text === text) ranges.push({ from: pos, to: pos + text.length, text });
  });
  const [regular, first, notes, second, nested] = ranges;
  assert.equal(ranges.length, 5);
  const path = (version: number) => `/documents/${document.id}/checklist-work?expectedDocumentVersion=${version}`;
  const currentPath = path(document.version);
  const pinned = async (selection: DocumentSourceSelection, title: string, doc = document) => call<Created>(pathFor(doc.id), 'POST', {
    ...followUp(doc, projectId, title), sourceSelection: selection,
  }, 201);
  const row = ({ issue, link }: Created, sourceSelection: DocumentSourceSelection) => ({
    linkId: link.id, issueId: issue.id, sourceSelection,
  });

  const child = await pinned(nested, '중첩 항목 업무');
  const sibling = await pinned(second, '같은 문구의 두 번째 항목 업무');
  const firstItem = await pinned(first, '같은 문구의 첫 번째 항목 업무');
  for (const [title, selection] of [['같은 문구의 일반 문단', regular], ['같은 문구의 항목 메모', notes],
    ['항목의 일부만 선택', { from: first.from, to: first.to - 3, text: text.slice(0, -3) }]] as const) {
    await pinned(selection, title);
  }
  await call(pathFor(document.id), 'POST', followUp(document, projectId, '문서 전체 후속 업무'), 201);
  const expected = [row(firstItem, first), row(sibling, second), row(child, nested)];
  const revisionsPath = `/documents/${document.id}/revisions`;
  const before = await call<DocRevision[]>(revisionsPath);
  const response = await fetch(base + currentPath);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { documentId: document.id, documentVersion: document.version, links: expected });
  assert.deepEqual(await call<DocRevision[]>(revisionsPath), before);

  const plainPath = currentPath.split('?')[0];
  for (const query of ['', '?expectedDocumentVersion=0', '?expectedDocumentVersion=1.0',
    '?expectedDocumentVersion=9007199254740992', '?expectedDocumentVersion=1&expectedDocumentVersion=1', '?other=1']) {
    await call(plainPath + query, 'GET', undefined, 400);
  }
  await call('/documents/missing/checklist-work?expectedDocumentVersion=1', 'GET', undefined, 404);
  await call(`/v1${currentPath}`, 'GET', undefined, 403, await key([projectId], 'read'));

  const revisionId = firstItem.link.documentSource?.revisionId;
  assert.ok(revisionId);
  const revision = before.find(value => value.id === revisionId);
  assert.ok(revision);
  const db = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  try {
    const update = db.prepare('UPDATE revisions SET json=? WHERE id=?');
    for (const mismatched of [{ ...revision, title: '다른 개정 제목' }, { ...revision, confluenceSourceVersion: 1 },
      { ...revision, content: { ...revision.content, content: [...(revision.content.content ?? []), paragraph('문서 끝의 변경')] } }]) {
      update.run(JSON.stringify(mismatched), revisionId);
      assert.deepEqual((await call<DocumentChecklistWork>(currentPath)).links, []);
    }
    update.run(JSON.stringify(revision), revisionId);
  } finally {
    db.close();
  }

  const archived = await call<{ trashEntryId: string }>(`/issues/${sibling.issue.id}`, 'DELETE');
  assert.deepEqual((await call<DocumentChecklistWork>(currentPath)).links, [expected[0], expected[2]]);
  await call(`/trash/${archived.trashEntryId}/restore`, 'POST', {});
  assert.deepEqual((await call<DocumentChecklistWork>(currentPath)).links, expected);

  const renamed = await call<DocPage>(`/documents/${document.id}`, 'PATCH', { expectedVersion: document.version, title: '임시 제목' });
  const latest = await call<DocPage>(`/documents/${document.id}`, 'PATCH', { expectedVersion: renamed.version, title: document.title });
  assert.deepEqual(latest.content, document.content);
  const stale = await call<{ details: { currentVersion: number } }>(currentPath, 'GET', undefined, 409);
  assert.equal(stale.details.currentVersion, latest.version);
  const historical = ([[firstItem, first], [sibling, second], [child, nested]] as const).map(([created, selection]) => ({
    ...row(created, selection), pinnedSource: created.link.documentSource,
  }));
  assert.deepEqual((await call<DocumentChecklistWork>(path(latest.version))).links, historical);
  const newItem = await pinned(second, '현재 버전에서 다시 고른 항목 업무', latest);
  const combined = [...historical, row(newItem, second)].sort((a, b) => a.sourceSelection.from - b.sourceSelection.from || a.linkId.localeCompare(b.linkId));
  assert.deepEqual((await call<DocumentChecklistWork>(path(latest.version))).links, combined);
});

const checklistParagraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const checklistItem = (text: string, id?: string, checked = false): RichContent => ({
  type: 'taskItem', attrs: { checked, ...(id ? { checklistItemId: id } : {}) }, content: [checklistParagraph(text)],
});
const checklistList = (...items: RichContent[]): RichContent => ({ type: 'taskList', content: items });
const checklistBody = (...children: RichContent[]): RichContent => ({ type: 'doc', content: children });
const checklistPath = (document: DocPage) => `/documents/${document.id}/checklist-work?expectedDocumentVersion=${document.version}`;

function checklistRanges(document: DocPage) {
  const parsed = createEditorSchema().nodeFromJSON(document.content);
  const ranges: DocumentSourceSelection[] = [];
  parsed.descendants((node, position) => {
    const selection = documentChecklistItemSelection(parsed, node, position);
    if (selection) ranges.push(selection);
  });
  return ranges;
}

test('stable checklist IDs follow saved rewording and reorder while the pinned evidence and scope remain unchanged', async t => {
  const { call, directory } = await fixture(t);
  const first = checklistItem('같은 항목', 'selected-item');
  const second = checklistItem('같은 항목', 'different-item');
  const original = await call<DocPage>('/documents', 'POST', {
    projectId, title: '식별자가 있는 체크리스트', content: checklistBody(checklistList(first, second)),
  }, 201);
  const [selected, other] = checklistRanges(original);
  const connect = (selection: DocumentSourceSelection, title: string) => call<Created>(pathFor(original.id), 'POST', {
    ...followUp(original, projectId, title), sourceSelection: selection,
  }, 201);
  const [one, two] = [await connect(selected, '처음 항목 업무'), await connect(other, '두 번째 항목 업무')];
  assert.deepEqual((await call<DocumentChecklistWork>(checklistPath(original))).links, [
    { linkId: one.link.id, issueId: one.issue.id, sourceSelection: selected },
    { linkId: two.link.id, issueId: two.issue.id, sourceSelection: other },
  ]);
  const changed = checklistItem('처음 항목의 새 설명과 이모지 📌', 'selected-item', true);
  const save = (document: DocPage, content: RichContent) => call<DocPage>(`/documents/${document.id}`, 'PATCH', {
    expectedVersion: document.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content,
  });
  const updated = await save(original, checklistBody(checklistParagraph('앞에 추가한 문단'), checklistList(second, changed)));
  const [secondRange, firstRange] = checklistRanges(updated);
  const expected = [
    { linkId: two.link.id, issueId: two.issue.id, sourceSelection: secondRange, pinnedSource: two.link.documentSource },
    { linkId: one.link.id, issueId: one.issue.id, sourceSelection: firstRange, pinnedSource: one.link.documentSource },
  ];
  const revisionPath = `/documents/${original.id}/revisions`;
  const beforeReading = await call<DocRevision[]>(revisionPath);
  assert.deepEqual((await call<DocumentChecklistWork>(checklistPath(updated))).links, expected);
  assert.deepEqual(await call<DocRevision[]>(revisionPath), beforeReading);
  await call(checklistPath(original), 'GET', undefined, 409);

  const revisionId = one.link.documentSource!.revisionId;
  const pin = beforeReading.find(revision => revision.id === revisionId)!;
  const observer = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  try {
    const writeDocument = observer.prepare('UPDATE documents SET json=? WHERE id=?');
    writeDocument.run(JSON.stringify({ ...updated, content: checklistBody(checklistList(second, changed, changed)) }), updated.id);
    const duplicateCurrent = (await call<DocumentChecklistWork>(checklistPath(updated))).links;
    assert.deepEqual(duplicateCurrent.map(link => link.linkId), [two.link.id]);
    writeDocument.run(JSON.stringify(updated), updated.id);

    const writePin = observer.prepare('UPDATE revisions SET json=? WHERE id=?');
    writePin.run(JSON.stringify({ ...pin, content: checklistBody(checklistList(first, second, first)) }), revisionId);
    assert.deepEqual((await call<DocumentChecklistWork>(checklistPath(updated))).links.map(link => link.linkId), [two.link.id]);
    writePin.run(JSON.stringify({ ...pin, confluenceSourceVersion: 1 }), revisionId);
    assert.deepEqual((await call<DocumentChecklistWork>(checklistPath(updated))).links, []);
    writePin.run(JSON.stringify(pin), revisionId);
  } finally { observer.close(); }

  const otherDocument = await call<DocPage>('/documents', 'POST', {
    projectId, title: '항목을 옮긴 다른 문서', content: checklistBody(checklistList(changed)),
  }, 201);
  const removed = await save(updated, checklistBody(checklistList(second)));
  assert.deepEqual((await call<DocumentChecklistWork>(checklistPath(removed))).links.map(link => link.linkId), [two.link.id]);
  assert.deepEqual((await call<DocumentChecklistWork>(checklistPath(otherDocument))).links, []);
  const workspace = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(workspace.resourceLinks.find(link => link.id === one.link.id), one.link);
});

test('anonymous checklist evidence follows only an unambiguous consecutive saved topology and can adopt an established ID', async t => {
  const { call, directory } = await fixture(t);
  const duplicate = checklistItem('구분할 수 없는 두 항목');
  const labeled = checklistItem('나중에 이름을 바꿀 항목');
  const duplicateRoot = checklistList(checklistItem('같은 별도 목록의 항목'));
  const parent = (nested: RichContent, checked = false): RichContent => ({
    ...checklistItem('상위 항목', undefined, checked), content: [checklistParagraph('상위 항목'), checklistList(nested)],
  });
  const original = await call<DocPage>('/documents', 'POST', {
    projectId, title: '식별자가 없는 체크리스트', content: checklistBody(checklistList(duplicate, duplicate, parent(labeled)), duplicateRoot, duplicateRoot),
  }, 201);
  const [ambiguous, , , nested, repeatedRoot] = checklistRanges(original);
  const connect = (selection: DocumentSourceSelection, title: string) => call<Created>(pathFor(original.id), 'POST', {
    ...followUp(original, projectId, title), sourceSelection: selection,
  }, 201);
  const uncertain = await connect(ambiguous, '중복 항목의 기존 업무');
  const preserved = await connect(nested, '중첩 항목의 기존 업무');
  const duplicatedRoot = await connect(repeatedRoot, '중복된 별도 목록의 업무');
  assert.deepEqual((await call<DocumentChecklistWork>(checklistPath(original))).links.map(link => link.linkId),
    [uncertain.link.id, preserved.link.id, duplicatedRoot.link.id]);
  const save = (document: DocPage, content: RichContent) => call<DocPage>(`/documents/${document.id}`, 'PATCH', {
    expectedVersion: document.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content,
  });
  const unchangedList = checklistList(duplicate, duplicate, parent(checklistItem(nested.text, undefined, true), true));
  const shifted = await save(original, checklistBody(checklistParagraph('체크리스트 앞의 새 문단'), unchangedList,
    duplicateRoot, checklistParagraph('같은 두 목록 사이에 추가한 내용'), duplicateRoot));
  const only = (sourceSelection: DocumentSourceSelection) => [{
    linkId: preserved.link.id, issueId: preserved.issue.id, pinnedSource: preserved.link.documentSource, sourceSelection,
  }];
  const shiftedNested = checklistRanges(shifted)[3];
  assert.notEqual(shiftedNested.from, nested.from);
  assert.deepEqual((await call<DocumentChecklistWork>(checklistPath(shifted))).links, only(shiftedNested));

  const identified = await save(shifted, checklistBody(checklistList(duplicate, duplicate, parent(checklistItem(nested.text, 'adopted-item'))),
    duplicateRoot, duplicateRoot));
  const updated = await save(identified, checklistBody(checklistList(checklistItem('식별 후 바뀐 새 이름', 'adopted-item'), duplicate)));
  assert.deepEqual((await call<DocumentChecklistWork>(checklistPath(updated))).links, only(checklistRanges(updated)[0]));

  const revisions = await call<DocRevision[]>(`/documents/${original.id}/revisions`);
  const observed = revisions.find(revision => revision.version === shifted.version)!;
  const observer = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  try {
    const writeDocument = observer.prepare('UPDATE documents SET json=? WHERE id=?');
    const later = { ...updated, version: updated.version + 40 };
    writeDocument.run(JSON.stringify(later), updated.id);
    assert.deepEqual((await call<DocumentChecklistWork>(checklistPath(later))).links, only(checklistRanges(later)[0]));
    writeDocument.run(JSON.stringify(updated), updated.id);
    const insert = observer.prepare('INSERT INTO revisions(id,document_id,json) VALUES(?,?,?)');
    const altered = { ...observed, id: randomUUID(), title: '같은 버전에 충돌하는 저장본' };
    insert.run(altered.id, altered.documentId, JSON.stringify(altered));
    assert.deepEqual((await call<DocumentChecklistWork>(checklistPath(updated))).links, []);
    const remove = observer.prepare('DELETE FROM revisions WHERE id=?');
    remove.run(altered.id);
    remove.run(observed.id);
    assert.deepEqual((await call<DocumentChecklistWork>(checklistPath(updated))).links, []);
  } finally { observer.close(); }
});

test('project documents enforce their project and common documents link to the explicit target without changing the document', async t => {
  const { call, key } = await fixture(t);
  const projectDocument = await call<DocPage>('/documents', 'POST', { projectId, title: '프로젝트 합성 결정', content }, 201);
  const commonDocument = await call<DocPage>('/documents', 'POST', { projectId: null, title: '공통 합성 결정', content }, 201);
  const projected = followUp(projectDocument, projectId, '프로젝트 문서의 합성 업무');
  projected.issue.assigneeId = 'user-jun';

  await call(pathFor('missing-document'), 'POST', projected, 404);
  await call(pathFor(projectDocument.id), 'POST', { ...projected, issue: { ...projected.issue, projectId: commonTarget } }, 400);
  await call(pathFor(commonDocument.id), 'POST', { ...projected, issue: { title: '프로젝트를 지정하지 않은 공통 문서 업무' } }, 400);
  await call(`/v1${pathFor(projectDocument.id)}`, 'POST', projected, 403, await key([projectId], 'read'));

  const created = await call<Created>(pathFor(projectDocument.id), 'POST', projected, 201);
  assert.equal(created.duplicate, false);
  assert.equal(created.issue.projectId, projectId);
  assert.equal(created.issue.title, projected.issue.title);
  assert.equal(created.issue.assigneeId, projected.issue.assigneeId);
  assert.deepEqual(created.link, { id: created.link.id, issueId: created.issue.id, documentId: projectDocument.id, kind: '후속 업무' });
  const common = followUp(commonDocument, commonTarget, '공통 문서의 합성 업무');
  const commonCreated = await call<Created>(pathFor(commonDocument.id), 'POST', common, 201);
  assert.equal(commonCreated.issue.projectId, commonTarget);
  assert.equal(commonCreated.link.documentId, commonDocument.id);
  assert.equal(commonCreated.link.issueId, commonCreated.issue.id);

  const workspace = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(workspace.documents.find(document => document.id === projectDocument.id), projectDocument);
  assert.deepEqual(workspace.documents.find(document => document.id === commonDocument.id), commonDocument);
  assert.deepEqual(workspace.resourceLinks.filter(link => link.documentId === projectDocument.id), [created.link]);
  assert.deepEqual(workspace.resourceLinks.filter(link => link.documentId === commonDocument.id), [commonCreated.link]);
  assert.ok(workspace.activities.some(activity => activity.resourceType === 'document' && activity.resourceId === projectDocument.id && activity.action === '후속 업무 생성' && activity.actorId === actorId));
  const ordinary = await call<Issue>('/issues', 'POST', { projectId, title: '기존 업무 생성 계약' }, 201);
  assert.equal(ordinary.title, '기존 업무 생성 계약');
  assert.equal(Object.hasOwn(ordinary, 'issue'), false);
  assert.equal((await call<WorkspaceSnapshot>('/workspace')).resourceLinks.some(link => link.issueId === ordinary.id), false);
});

test('public follow-ups record the key owner and recheck the current issue and a later decision pin on replay', async t => {
  const { call, key } = await fixture(t);
  const narrow = await key([projectId]);
  const wide = await key([projectId, commonTarget]);
  const allProjects = await key(null);
  const doc = await call<DocPage>('/documents', 'POST', { projectId, title: 'API 후속 업무 원문', content }, 201);
  const common = await call<DocPage>('/documents', 'POST', { projectId: null, title: 'API 공통 문서', content }, 201);
  const outside = await call<Project>('/projects', 'POST', { key: 'APIOUT', name: '키 범위 밖 이동 대상' }, 201);
  const path = `/v1${pathFor(doc.id)}`;
  const input = { ...followUp(doc, projectId, 'API에서 한 번만 만들 업무'), actorId: 'user-jun' };
  const commonInput = followUp(common, commonTarget, '전체 범위 키로 만든 후속 업무');
  const original = await call<WorkspaceSnapshot>('/workspace');
  await call(`/v1${pathFor(common.id)}`, 'POST', commonInput, 403, wide);
  await call(path, 'POST', { ...input, issue: { ...input.issue, parentId: 'issue-10' } }, 403, narrow);
  await call(path, 'POST', { ...input, expectedDocumentVersion: doc.version + 1 }, 409, narrow);
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), original);

  const first = await call<Created>(path, 'POST', input, 201, narrow);
  assert.equal(first.duplicate, false);
  assert.equal(first.issue.reporterId, actorId);
  assert.equal(first.link.documentSource, undefined);
  const afterCreate = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(await call<Created>(path, 'POST', input, 200, narrow), { ...first, duplicate: true });
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), afterCreate);
  const creationLog = afterCreate.activities.filter(activity =>
    (activity.resourceId === first.issue.id && activity.action === '티켓 생성') ||
    (activity.resourceId === doc.id && activity.action === '후속 업무 생성'));
  assert.deepEqual(creationLog.map(activity => activity.actorId), [actorId, actorId]);
  const commonResult = await call<Created>(`/v1${pathFor(common.id)}`, 'POST', commonInput, 201, allProjects);
  assert.equal(commonResult.issue.projectId, commonTarget);
  assert.equal(commonResult.link.documentId, common.id);

  const richer = await call<DocPage>(`/documents/${doc.id}`, 'PATCH', { expectedVersion: doc.version, content: issueSummaryBody(commonTarget) });
  const selection = { from: 1, to: doc.plainText.length + 1, text: doc.plainText };
  const beforePin = await call<WorkspaceSnapshot>('/workspace');
  await call(path, 'POST', { ...followUp(richer, projectId, '범위를 벗어난 원문 업무'), sourceSelection: selection }, 403, narrow);
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), beforePin);
  const pinned = await call<Created>(`/v1${decisionPathFor(doc.id)}`, 'POST', decisionLink(richer, first.issue, selection), 201, wide);
  assert.equal(pinned.link.id, first.link.id);
  assert.equal(pinned.link.kind, '후속 업무');
  assert.equal(pinned.link.documentSource?.text, selection.text);
  const clean = await call<DocPage>(`/documents/${doc.id}`, 'PATCH', {
    expectedVersion: richer.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content,
  });
  const beforeReplay = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(await call<DocPage>(`/v1/documents/${doc.id}`, 'GET', undefined, 200, narrow), clean);
  await call(path, 'POST', input, 403, narrow);
  assert.deepEqual(await call<Created>(path, 'POST', input, 200, wide), { ...pinned, duplicate: true });
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), beforeReplay);

  const moveInput: IssueProjectMoveInput = { expectedVersion: first.issue.version, projectId: outside.id, includeConnected: false, mappings: [] };
  const move = `/issues/${first.issue.id}/project-move`;
  const preview = await call<IssueProjectMovePreview>(`${move}/preview`, 'POST', moveInput);
  assert.ok(preview.token, JSON.stringify(preview));
  const result = await call<IssueProjectMoveResult>(`${move}/apply`, 'POST', { ...moveInput, token: preview.token });
  const [moved] = result.issues;
  assert.equal(moved.id, first.issue.id);
  assert.equal(moved.projectId, outside.id);
  const afterMove = await call<WorkspaceSnapshot>('/workspace');
  await call(path, 'POST', input, 403, wide);
  assert.deepEqual(await call<Created>(path, 'POST', input, 200, allProjects), { issue: moved, link: pinned.link, duplicate: true });
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), afterMove);
});

test('public decision links require both projects and replay the exact readable pinned document body', async t => {
  const { call, key } = await fixture(t);
  const doc = await call<DocPage>('/documents', 'POST', { projectId, title: 'API 결정 원문', content }, 201);
  const issue = await call<Issue>('/issues', 'POST', { projectId: commonTarget, title: '다른 프로젝트의 API 결정 업무' }, 201);
  const outside = await call<Project>('/projects', 'POST', { key: 'APIBODY', name: '결정 본문 범위 밖 프로젝트' }, 201);
  const sourceKey = await key([projectId]);
  const targetKey = await key([commonTarget]);
  const both = await key([projectId, commonTarget]);
  const otherOwner = await key([projectId, commonTarget], 'write', 'user-min');
  const path = `/v1${decisionPathFor(doc.id)}`;
  const input = { ...decisionLink(doc, issue), actorId: 'user-jun' };
  const original = await call<WorkspaceSnapshot>('/workspace');
  const [revision] = await call<DocRevision[]>(`/documents/${doc.id}/revisions`);
  await call(path, 'POST', input, 403, sourceKey);
  await call(path, 'POST', input, 403, targetKey);
  await call(path, 'POST', { ...input, expectedDocumentVersion: doc.version + 1 }, 409, both);
  await call(path, 'POST', { ...input, sourceSelection: { ...input.sourceSelection, text: '선택이 바뀐 원문' } }, 409, both);
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), original);
  assert.deepEqual(await call<DocRevision[]>(`/documents/${doc.id}/revisions`), [revision]);

  const attached = await call<Created>(path, 'POST', input, 201, both);
  assert.deepEqual(attached.issue, issue);
  assert.deepEqual(attached.link.documentSource, { ...input.sourceSelection, revisionId: revision.id });
  assert.equal(attached.duplicate, false);
  const saved = await call<WorkspaceSnapshot>('/workspace');
  const beforeIds = new Set(original.activities.map(activity => activity.id));
  assert.deepEqual(saved.activities.filter(activity => !beforeIds.has(activity.id))
    .map(({ resourceId, actorId, action }) => ({ resourceId, actorId, action })),
  [{ resourceId: issue.id, actorId, action: '문서 결정 근거 연결' }]);
  assert.deepEqual(await call<Created>(path, 'POST', { ...input, requestId: randomUUID() }, 200, both), { ...attached, duplicate: true });
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), saved);

  const edited = await call<DocPage>(`/documents/${doc.id}`, 'PATCH', { expectedVersion: doc.version, content: issueSummaryBody(outside.id) });
  const unlinked = await call<Issue>('/issues', 'POST', { projectId: commonTarget, title: '범위 밖 본문 검증용 업무' }, 201);
  const beforeReplay = await call<WorkspaceSnapshot>('/workspace');
  await call(`/v1/documents/${doc.id}`, 'GET', undefined, 403, both);
  await call(path, 'POST', decisionLink(edited, unlinked, input.sourceSelection), 403, both);
  await call(path, 'POST', input, 409, otherOwner);
  assert.deepEqual(await call<Created>(path, 'POST', input, 200, both), { ...attached, duplicate: true });
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), beforeReplay);
});

test('follow-up links roll back with the issue number and retry safely across document edits and native restore', async t => {
  const { call, directory } = await fixture(t);
  const document = await call<DocPage>('/documents', 'POST', { projectId, title: '합성 재시도 결정', content }, 201);
  const input = followUp(document, projectId, '한 번만 만들 합성 후속 업무');
  const before = await call<WorkspaceSnapshot>('/workspace');
  const observer = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  try {
    const nextNumber = () => observer.prepare('SELECT next_number FROM issue_sequences WHERE project_id = ?').get(projectId)?.next_number;
    const number = nextNumber();
    observer.exec("CREATE TRIGGER fail_synthetic_follow_up BEFORE INSERT ON resource_links BEGIN SELECT RAISE(ABORT, 'synthetic follow-up link failure'); END");
    await call(pathFor(document.id), 'POST', input, 500);
    assert.equal(nextNumber(), number);
    const rolledBack = await call<WorkspaceSnapshot>('/workspace');
    assert.deepEqual(rolledBack.issues, before.issues);
    assert.deepEqual(rolledBack.resourceLinks, before.resourceLinks);
    assert.deepEqual(rolledBack.activities, before.activities);
  } finally {
    observer.exec('DROP TRIGGER IF EXISTS fail_synthetic_follow_up');
    observer.close();
  }

  const created = await call<Created>(pathFor(document.id), 'POST', input, 201);
  const edited = await call<DocPage>(`/documents/${document.id}`, 'PATCH', { expectedVersion: document.version, title: '다른 작업자가 변경한 합성 결정' });
  assert.ok(edited.version > document.version);
  const replay = await call<Created>(pathFor(document.id), 'POST', input, 200);
  assert.deepEqual(replay, { ...created, duplicate: true });
  await call(pathFor(document.id), 'POST', input, 409, { 'X-Actor-Id': 'user-min' });
  await call(pathFor(document.id), 'POST', { ...input, issue: { ...input.issue, title: '같은 요청의 다른 제목' } }, 409);
  await call(pathFor(document.id), 'POST', { ...input, requestId: randomUUID() }, 409);
  const saved = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(saved.issues.filter(issue => issue.title === input.issue.title), [created.issue]);
  assert.deepEqual(saved.resourceLinks.filter(link => link.documentId === document.id), [created.link]);
  assert.equal(saved.activities.filter(activity => activity.resourceType === 'issue' && activity.resourceId === created.issue.id && activity.action === '티켓 생성').length, 1);

  const beforeRestore = followUp(edited, projectId, '형식 복원 전의 같은 버전 업무');
  const beforeRestoreCreated = await call<Created>(pathFor(document.id), 'POST', beforeRestore, 201);
  const backup = await call<WorkspaceSnapshot>('/export');
  assert.deepEqual(backup.resourceLinks.find(link => link.id === created.link.id), created.link);
  await call('/import', 'POST', { data: backup });
  await call(pathFor(document.id), 'POST', beforeRestore, 409);
  const restored = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(restored.resourceLinks.filter(link => link.documentId === document.id), [created.link, beforeRestoreCreated.link]);
  assert.deepEqual(restored.issues.filter(issue => issue.title === input.issue.title).map(issue => issue.id), [created.issue.id]);
  const restoredDoc = restored.documents.find(page => page.id === document.id);
  assert.ok(restoredDoc && restoredDoc.version > edited.version);

  const forUnlink = followUp(restoredDoc, projectId, '연결 해제 후 중복 방지 업무');
  const unlinked = await call<Created>(pathFor(document.id), 'POST', forUnlink, 201);
  await call(`/resource-links/${unlinked.link.id}`, 'DELETE');
  await call(pathFor(document.id), 'POST', forUnlink, 409);
  const afterUnlink = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(afterUnlink.issues.filter(issue => issue.title === forUnlink.issue.title), [unlinked.issue]);
  assert.ok(!afterUnlink.resourceLinks.some(link => link.issueId === unlinked.issue.id));
});

test('sentence comment follow-ups pin the original revision and authorize its content across edits and replay', async t => {
  const { call, directory, key, restart } = await fixture(t);
  const narrow = await key([projectId], 'write', 'user-min');
  const wide = await key([projectId, commonTarget], 'write', 'user-min');
  const document = await call<DocPage>('/documents', 'POST', {
    projectId, title: '검토 당시의 설계', content: issueSummaryBody(commonTarget),
  }, 201);
  const { comment, source } = await sentenceComment(call, document);
  const revisionPath = `/documents/${document.id}/include-revisions/${source.revisionId}`;
  const original = await call<DocRevision>(revisionPath);
  assert.equal(original.version, document.version);

  const latest = await call<DocPage>(`/documents/${document.id}`, 'PATCH', {
    expectedVersion: document.version, title: '편집한 현재 설계', contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '현재 문서에는 원래 문장이 없습니다.' }] }] },
  });
  const path = `/v1${pathFor(document.id)}`;
  const input = {
    ...followUp(latest, projectId, '문장 댓글에서 연결한 후속 업무'),
    sourceComment: { commentId: comment.id, revisionId: source.revisionId },
  };
  const before = await call<WorkspaceSnapshot>('/workspace');
  await call(path, 'POST', { ...input, expectedDocumentVersion: document.version }, 409, wide);
  await call(path, 'POST', input, 403, narrow);
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), before);
  const revisionsPath = `/documents/${document.id}/revisions`;
  const revisions = await call<DocRevision[]>(revisionsPath);

  const observer = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  try {
    const sequence = () => observer.prepare('SELECT next_number FROM issue_sequences WHERE project_id=?').get(projectId);
    const number = sequence();
    observer.exec(`CREATE TRIGGER fail_sentence_follow_up BEFORE INSERT ON document_follow_up_requests
      BEGIN SELECT RAISE(ABORT, 'synthetic sentence follow-up receipt failure'); END`);
    await call(path, 'POST', input, 500, wide);
    assert.deepEqual(sequence(), number);
    assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), before);
    assert.deepEqual(await call<DocRevision[]>(revisionsPath), revisions);
  } finally {
    observer.exec('DROP TRIGGER IF EXISTS fail_sentence_follow_up');
    observer.close();
  }

  const created = await call<Created>(path, 'POST', input, 201, wide);
  assert.equal(created.duplicate, false);
  assert.equal(created.issue.reporterId, 'user-min');
  assert.deepEqual(created.link, {
    id: created.link.id, issueId: created.issue.id, documentId: document.id, kind: '후속 업무', documentSource: source,
  });
  assert.deepEqual(await call<DocRevision[]>(revisionsPath), revisions);
  const wideRevisions = await call<DocRevision[]>(`/v1${revisionsPath}`, 'GET', undefined, 200, wide);
  assert.deepEqual(wideRevisions.find(value => value.id === original.id), original);
  const narrowRevisions = await call<DocRevision[]>(`/v1${revisionsPath}`, 'GET', undefined, 200, narrow);
  assert.equal(narrowRevisions.some(value => value.id === original.id), false);
  const saved = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(saved.documents.find(value => value.id === document.id), latest);
  assert.deepEqual(saved.resourceLinks.filter(link => link.documentId === document.id), [created.link]);
  await restart();
  // A key with the same owner can recover an acknowledged request only if it can still read its pinned original.
  await call(path, 'POST', input, 403, narrow);
  assert.deepEqual(await call<Created>(path, 'POST', input, 200, wide), { ...created, duplicate: true });
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), saved);

  await call(`/comments/${comment.id}`, 'DELETE');
  const archived = await call<WorkspaceSnapshot>('/workspace');
  await call(path, 'POST', { ...input, requestId: randomUUID() }, 404, wide);
  assert.deepEqual(await call<Created>(path, 'POST', input, 200, wide), { ...created, duplicate: true });
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), archived);

  const backup = await call<WorkspaceSnapshot>('/export');
  await call('/import', 'POST', { data: backup });
  const restored = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(restored.resourceLinks.find(link => link.id === created.link.id), created.link);
  assert.deepEqual(await call<DocRevision>(revisionPath), original);
});

test('sentence comment follow-ups reject forged, unrelated and damaged original selections', async t => {
  const { call, directory } = await fixture(t);
  const document = await call<DocPage>('/documents', 'POST', { projectId, title: '검토 댓글의 실제 문서', content }, 201);
  const other = await call<DocPage>('/documents', 'POST', { projectId, title: '같은 원문이 있는 다른 문서', content }, 201);
  const { comment, source } = await sentenceComment(call, document);
  const foreign = await sentenceComment(call, other);
  const { comment: reply } = await call<DocumentCommentReplyResult>(`/documents/${document.id}/selection-comments/${comment.id}/replies`, 'POST', {
    requestId: randomUUID(), expectedResolutionVersion: 0, body: '검토에 대한 답글',
  }, 201);
  const ordinary = await call<Comment>('/comments', 'POST', {
    resourceType: 'document', resourceId: document.id, body: '문서 전체를 검토한 일반 댓글',
  }, 201);
  const latest = await call<DocPage>(`/documents/${document.id}`, 'PATCH', { expectedVersion: document.version, title: '현재 문서 제목' });
  const revisions = await call<DocRevision[]>(`/documents/${document.id}/revisions`);
  const latestRevision = revisions.find(revision => revision.version === latest.version);
  assert.ok(latestRevision && latestRevision.id !== source.revisionId);
  const path = pathFor(document.id);
  const sourceComment = { commentId: comment.id, revisionId: source.revisionId };
  const input = { ...followUp(latest, projectId, '검증이 필요한 댓글 업무'), sourceComment };
  const before = await call<WorkspaceSnapshot>('/workspace');

  await call(path, 'POST', { ...input, sourceSelection: { from: source.from, to: source.to, text: source.text } }, 400);
  await call(path, 'POST', { ...input, sourceComment: { ...sourceComment, text: '클라이언트가 보낸 원문' } }, 400);
  await call(path, 'POST', { ...input, sourceComment: { ...sourceComment, revisionId: latestRevision.id } }, 409);
  const forged = [
    { commentId: randomUUID(), revisionId: source.revisionId },
    { commentId: reply.id, revisionId: source.revisionId },
    { commentId: foreign.comment.id, revisionId: foreign.source.revisionId },
  ];
  for (const candidate of forged) await call(path, 'POST', { ...input, sourceComment: candidate }, 404);
  await call(path, 'POST', { ...input, sourceComment: { ...sourceComment, commentId: ordinary.id } }, 400);

  const observer = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  try {
    const update = observer.prepare('UPDATE revisions SET json=? WHERE id=?');
    const original = revisions.find(revision => revision.id === source.revisionId);
    assert.ok(original);
    const moveRevision = observer.prepare('UPDATE revisions SET id=? WHERE id=?');
    const missingId = randomUUID();
    assert.equal(moveRevision.run(missingId, original.id).changes, 1);
    await call(path, 'POST', input, 409);
    assert.equal(moveRevision.run(original.id, missingId).changes, 1);
    const plainText = '원래 발췌와 다른 문장';
    const damagedContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: plainText }] }] };
    update.run(JSON.stringify({ ...original, content: damagedContent, plainText }), original.id);
    await call(path, 'POST', input, 400);
    update.run(JSON.stringify(original), original.id);
  } finally { observer.close(); }
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), before);
  const created = await call<Created>(path, 'POST', input, 201);
  assert.deepEqual(created.link.documentSource, source);
  await call(path, 'POST', { ...input, sourceComment: { ...sourceComment, revisionId: latestRevision.id } }, 409);
  const saved = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(saved.issues.filter(issue => issue.title === input.issue.title), [created.issue]);
  assert.deepEqual(saved.resourceLinks.filter(link => link.documentId === document.id), [created.link]);
});

test('the selected decision is bound to its exact stored source through edits, replay and native restore', async t => {
  const { call, restart } = await fixture(t);
  const prefix = '회의에서 ';
  const marked = '재현 조건';
  const ending = '을 고정하기로 했다.';
  const next = '변경 전에 실측한다.';
  const body: RichContent = { type: 'doc', content: [
    { type: 'paragraph', content: [
      { type: 'text', text: prefix },
      { type: 'text', text: marked, marks: [{ type: 'bold' }] },
      { type: 'text', text: ending },
    ] },
    { type: 'paragraph', content: [{ type: 'text', text: `${next} 담당자는 회의록에 기록한다.` }] },
  ] };
  const doc = await call<DocPage>('/documents', 'POST', { projectId, title: '결정 당시 설계', content: body }, 201);
  const other = await call<DocPage>('/documents', 'POST', { projectId, title: '같은 본문이 있는 별도 문서', content: body }, 201);
  const [original] = await call<DocRevision[]>(`/documents/${doc.id}/revisions`);
  const [wrongOwner] = await call<DocRevision[]>(`/documents/${other.id}/revisions`);
  assert.equal(original.version, doc.version);
  const sourceSelection = {
    from: 1 + prefix.length,
    to: prefix.length + marked.length + ending.length + 3 + next.length,
    text: `${marked}${ending}\n${next}`,
  };
  const input = { ...followUp(doc, projectId, '원문 결정에 연결된 업무'), sourceSelection };
  const before = await call<WorkspaceSnapshot>('/workspace');
  await call(pathFor(doc.id), 'POST', { ...input, sourceSelection: { ...sourceSelection, text: '다른 선택' } }, 409);
  await call(pathFor(doc.id), 'POST', { ...input, sourceSelection: { ...sourceSelection, from: sourceSelection.to } }, 400);
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), before);

  const created = await call<Created>(pathFor(doc.id), 'POST', input, 201);
  const storedContext = { ...sourceSelection, revisionId: original.id };
  assert.deepEqual(created.link.documentSource, storedContext);
  assert.equal(created.issue.description, '');
  assert.equal((await call<DocRevision[]>(`/documents/${doc.id}/revisions`)).length, 1);
  const latest = await call<DocPage>(`/documents/${doc.id}`, 'PATCH', {
    expectedVersion: doc.version, title: '다시 검토한 설계', content,
  });
  await call(pathFor(doc.id), 'POST', { ...input, requestId: randomUUID() }, 409);
  await call(pathFor(doc.id), 'POST', { ...input, sourceSelection: { ...sourceSelection, from: sourceSelection.from - 1 } }, 409);
  await restart();
  assert.deepEqual(await call<Created>(pathFor(doc.id), 'POST', input), { ...created, duplicate: true });
  const revisionPath = `/documents/${doc.id}/include-revisions/${original.id}`;
  assert.deepEqual(await call<DocRevision>(revisionPath), original);

  const activeBackup = await call<Backup>('/export');
  assert.equal(activeBackup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const storedLink = activeBackup.resourceLinks.find(link => link.id === created.link.id);
  assert.ok(storedLink?.documentSource);
  assert.deepEqual(storedLink.documentSource, storedContext);
  const liveState = await call<WorkspaceSnapshot>('/workspace');
  for (const replacement of [
    { ...storedContext, revisionId: wrongOwner.id },
    { ...storedContext, text: '백업에서 바뀐 인용' },
    { ...storedContext, from: storedContext.from - 1 },
  ]) {
    const invalidBackup = structuredClone(activeBackup);
    invalidBackup.resourceLinks.find(link => link.id === storedLink.id)!.documentSource = replacement;
    await call('/import', 'POST', { data: invalidBackup }, 400);
    assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), liveState);
  }
  await call('/import', 'POST', { data: { ...activeBackup, schemaVersion: 35 } }, 400);
  await call('/import', 'POST', { data: { ...activeBackup, schemaVersion: 47 } });
  assert.deepEqual((await call<WorkspaceSnapshot>('/workspace')).resourceLinks.find(link => link.id === storedLink.id), created.link);
  assert.deepEqual(await call<DocRevision>(revisionPath), original);

  const current = (await call<WorkspaceSnapshot>('/workspace')).documents.find(page => page.id === latest.id);
  assert.ok(current);
  const archived = await call<{ trashEntryId: string }>(`/documents/${doc.id}`, 'DELETE', { expectedVersion: current.version });
  const archivedBackup = await call<Backup>('/export');
  const archivedSource = archivedBackup.trashEntries.find(entry => entry.id === archived.trashEntryId);
  assert.equal(archivedSource?.resourceId, doc.id);
  assert.deepEqual(archivedSource?.resourceLinks, [created.link]);
  const invalidArchive = structuredClone(archivedBackup);
  invalidArchive.trashEntries.find(entry => entry.id === archived.trashEntryId)!.resourceLinks[0].documentSource = {
    ...storedContext, revisionId: wrongOwner.id,
  };
  await call('/import', 'POST', { data: invalidArchive }, 400);
  await call('/import', 'POST', { data: { ...archivedBackup, schemaVersion: 47 } });
  assert.deepEqual(await call<DocRevision>(revisionPath), original);
  await call(`/trash/${archived.trashEntryId}/restore`, 'POST', {});
  assert.deepEqual((await call<WorkspaceSnapshot>('/workspace')).resourceLinks.find(link => link.id === storedLink.id), created.link);

  const archivedIssue = await call<{ trashEntryId: string }>(`/issues/${created.issue.id}`, 'DELETE');
  const removedDocument = await call<{ trashEntryId: string }>(`/documents/${doc.id}`, 'DELETE');
  await call(`/trash/${removedDocument.trashEntryId}`, 'DELETE');
  const orphanBackup = await call<Backup>('/export');
  const orphanLink = orphanBackup.trashEntries.find(entry => entry.id === archivedIssue.trashEntryId)?.resourceLinks[0];
  assert.deepEqual(orphanLink?.documentSource, storedContext);
  await call('/import', 'POST', { data: orphanBackup });
  const restored = await call<{ warnings: string[] }>(`/trash/${archivedIssue.trashEntryId}/restore`, 'POST', {});
  assert.ok(restored.warnings.some(warning => warning.includes('업무·문서 연결')));
  assert.equal((await call<WorkspaceSnapshot>('/workspace')).resourceLinks.some(link => link.id === storedLink.id), false);
});

test('a missing source snapshot is recorded in the same transaction as its decision link', async t => {
  const { call, directory } = await fixture(t);
  const doc = await call<DocPage>('/documents', 'POST', { projectId, title: '저장본 연결 검증', content }, 201);
  const sourceSelection = { from: 1, to: doc.plainText.length + 1, text: doc.plainText };
  const input = { ...followUp(doc, projectId, '저장본과 함께 추가할 업무'), sourceSelection };
  const observer = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  try {
    // A saved body without an exact history row exercises the same insertion path as pre-checkpoint collaboration.
    observer.prepare('DELETE FROM revisions WHERE document_id=?').run(doc.id);
    const before = await call<WorkspaceSnapshot>('/workspace');
    const number = () => observer.prepare('SELECT next_number FROM issue_sequences WHERE project_id=?').get(projectId)?.next_number;
    const nextNumber = number();
    observer.exec("CREATE TRIGGER fail_decision_link BEFORE INSERT ON resource_links BEGIN SELECT RAISE(ABORT, 'synthetic decision link failure'); END");
    await call(pathFor(doc.id), 'POST', input, 500);
    assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), before);
    assert.deepEqual(await call<DocRevision[]>(`/documents/${doc.id}/revisions`), []);
    assert.equal(number(), nextNumber);
  } finally {
    observer.exec('DROP TRIGGER IF EXISTS fail_decision_link');
    observer.close();
  }
  const created = await call<Created>(pathFor(doc.id), 'POST', input, 201);
  const [stored] = await call<DocRevision[]>(`/documents/${doc.id}/revisions`);
  assert.equal(stored.version, doc.version);
  assert.deepEqual(stored.content, doc.content);
  assert.deepEqual(created.link.documentSource, { ...sourceSelection, revisionId: stored.id });
  assert.deepEqual((await call<WorkspaceSnapshot>('/workspace')).documents.find(page => page.id === doc.id), doc);
});

test('attaching a decision to an existing cross-project issue preserves the whole-document relation and the two resources', async t => {
  const { call } = await fixture(t);
  const doc = await call<DocPage>('/documents', 'POST', { projectId, title: '설계 결정 회의록', content }, 201);
  const issue = await call<Issue>('/issues', 'POST', { projectId: commonTarget, title: '이미 등록한 합성 업무', description: '기존 업무 설명' }, 201);
  const ordinary = await call<ResourceLink>('/resource-links', 'POST', { issueId: issue.id, documentId: doc.id, kind: '설계 참고' }, 201);
  const path = decisionPathFor(doc.id);
  const input = decisionLink(doc, issue, { from: 1, to: '합성 결정'.length + 1, text: '합성 결정' });
  const [initialRevision] = await call<DocRevision[]>(`/documents/${doc.id}/revisions`);
  const before = await call<WorkspaceSnapshot>('/workspace');

  await call(decisionPathFor('missing-document'), 'POST', input, 404);
  await call(path, 'POST', { ...input, issueId: 'missing-issue' }, 404);
  await call(path, 'POST', { ...input, requestId: 'invalid' }, 400);
  await call(path, 'POST', { ...input, expectedDocumentVersion: doc.version + 1 }, 409);
  await call(path, 'POST', { ...input, sourceSelection: { ...input.sourceSelection, text: '선택 내용 위조' } }, 409);
  await call(path, 'POST', { ...input, sourceSelection: { ...input.sourceSelection, from: input.sourceSelection.to } }, 400);
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), before);
  assert.deepEqual(await call<DocRevision[]>(`/documents/${doc.id}/revisions`), [initialRevision]);

  const attached = await call<Created>(path, 'POST', input, 201);
  assert.deepEqual(attached, {
    issue,
    link: { ...ordinary, documentSource: { ...input.sourceSelection, revisionId: initialRevision.id } },
    duplicate: false,
  });
  const saved = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(saved.issues, before.issues);
  assert.deepEqual(saved.documents, before.documents);
  assert.deepEqual(saved.resourceLinks.filter(link => link.documentId === doc.id), [attached.link]);
  const priorActivityIds = new Set(before.activities.map(activity => activity.id));
  const [entry, ...unexpected] = saved.activities.filter(activity => !priorActivityIds.has(activity.id));
  assert.ok(entry);
  assert.deepEqual(unexpected, []);
  assert.equal(entry.resourceId, issue.id);
  assert.equal(entry.resourceType, 'issue');
  assert.equal(entry.actorId, actorId);

  const repeat = await call<Created>(path, 'POST', { ...input, requestId: randomUUID() });
  assert.deepEqual(repeat, { ...attached, duplicate: true });
  await call(path, 'POST', decisionLink(doc, issue, { from: 1 + '합성 '.length, to: doc.plainText.length + 1, text: '결정 원문' }), 409);
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), saved);
  assert.deepEqual(await call<DocRevision[]>(`/documents/${doc.id}/revisions`), [initialRevision]);
});

test('unlinking a document requires the exact pinned revision and excerpt the browser reviewed', async t => {
  const { call } = await fixture(t);
  const doc = await call<DocPage>('/documents', 'POST', { projectId, title: '동시 변경으로 확인할 결정', content }, 201);
  const issue = await call<Issue>('/issues', 'POST', { projectId: commonTarget, title: '기존 문서 연결을 제거할 업무' }, 201);
  const ordinary = await call<ResourceLink>('/resource-links', 'POST', { issueId: issue.id, documentId: doc.id }, 201);
  const deletePath = `/resource-links/${ordinary.id}`;
  const input = decisionLink(doc, issue);
  const { from, to } = input.sourceSelection;
  const withRevision = (revisionId: string, range = { from, to }) => `${deletePath}?${decisionRemovalQuery({ revisionId, ...range })}`;
  const conflict = { reason: 'decision_source_changed' };
  const checkConflict = async (path: string, body?: unknown) => {
    const response = await call<{ details: unknown }>(path, 'DELETE', body, 409);
    assert.deepEqual(response.details, conflict);
  };
  await checkConflict(withRevision('previously-reviewed-revision'));

  const { link } = await call<Created>(decisionPathFor(doc.id), 'POST', input, 201, { 'X-Actor-Id': 'user-jun' });
  assert.equal(link.id, ordinary.id);
  assert.ok(link.documentSource);
  const previousRevisionId = link.documentSource.revisionId;
  const before = await call<WorkspaceSnapshot>('/workspace');
  await checkConflict(deletePath);
  await checkConflict(deletePath, { expectedDecisionRevisionId: previousRevisionId, expectedDecisionFrom: from, expectedDecisionTo: to });
  await checkConflict(withRevision('x'.repeat(200)));
  await checkConflict(withRevision(previousRevisionId, { from: from + 1, to }));
  await checkConflict(withRevision(previousRevisionId, { from, to: to - 1 }));
  await checkConflict(withRevision(previousRevisionId, { from: 0, to }));
  for (const malformed of ['', ' ', 'x'.repeat(201), 'revision\u0000id']) {
    await call(withRevision(malformed), 'DELETE', undefined, 400);
  }
  await call(`${withRevision(previousRevisionId)}&expectedDecisionRevisionId=duplicate`, 'DELETE', undefined, 400);
  await call(`${deletePath}?expectedDecisionRevisionId=${previousRevisionId}`, 'DELETE', undefined, 400);
  await call(`${deletePath}?expectedDecisionFrom=1&expectedDecisionTo=2`, 'DELETE', undefined, 400);
  for (const range of [{ from: -1, to }, { from: 1.25, to }, { from, to: from }, { from, to: Number.MAX_SAFE_INTEGER + 1 }]) {
    await call(withRevision(previousRevisionId, range), 'DELETE', undefined, 400);
  }
  await call(`${withRevision(previousRevisionId)}&expectedDecisionFrom=1`, 'DELETE', undefined, 400);
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), before);

  const backup = await call<Backup & { revisions: DocRevision[] }>('/export');
  const alternateText = '합성 결정';
  const alternate = { from, to: from + alternateText.length, text: alternateText };
  const linksWithPin = (revisionId: string) => backup.resourceLinks.map(existing => existing.id === link.id
    ? { ...existing, documentSource: { ...alternate, revisionId } } : existing);
  await call('/import', 'POST', { data: { ...backup, resourceLinks: linksWithPin(previousRevisionId) } });
  const sameRevision = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(sameRevision.resourceLinks.find(existing => existing.id === link.id)?.documentSource, { ...alternate, revisionId: previousRevisionId });
  await checkConflict(withRevision(previousRevisionId));
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), sameRevision);

  const legacyRevisionId = '결정-저장본-legacy-17';
  await call('/import', 'POST', { data: {
    ...backup,
    revisions: backup.revisions.map(revision => revision.id === previousRevisionId ? { ...revision, id: legacyRevisionId } : revision),
    resourceLinks: linksWithPin(legacyRevisionId),
  } });
  const restored = await call<WorkspaceSnapshot>('/workspace');
  await checkConflict(withRevision(previousRevisionId, alternate));
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), restored);

  await call(withRevision(legacyRevisionId, alternate), 'DELETE');
  await call(withRevision(legacyRevisionId, alternate), 'DELETE', undefined, 404);
  const after = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(after.resourceLinks, restored.resourceLinks.filter(existing => existing.id !== link.id));
  const activities = after.activities.filter(entry => !restored.activities.some(prior => prior.id === entry.id));
  assert.deepEqual(activities.map(({ action, actorId, resourceId }) => ({ action, actorId, resourceId })),
    [{ action: '문서 연결 해제', actorId, resourceId: issue.id }]);
  assert.ok((await call<DocRevision[]>(`/documents/${doc.id}/revisions`)).some(revision => revision.id === legacyRevisionId));
});

test('an existing-issue decision receipt survives document edits and restart and cannot resurrect an unlinked relation', async t => {
  const { call, restart } = await fixture(t);
  const doc = await call<DocPage>('/documents', 'POST', { projectId, title: '결정 연결 재시도', content }, 201);
  const otherDoc = await call<DocPage>('/documents', 'POST', { projectId, title: '같은 선택이 있는 다른 문서', content }, 201);
  const issue = await call<Issue>('/issues', 'POST', { projectId, title: '결정 내용을 연결할 업무' }, 201);
  const otherIssue = await call<Issue>('/issues', 'POST', { projectId, title: '다른 업무' }, 201);
  const input = decisionLink(doc, issue);
  const path = decisionPathFor(doc.id);
  const attached = await call<Created>(path, 'POST', input, 201);
  assert.equal(attached.duplicate, false);
  assert.equal(attached.link.issueId, issue.id);
  assert.equal(attached.link.documentId, doc.id);
  assert.ok(attached.link.documentSource);

  const edited = await call<DocPage>(`/documents/${doc.id}`, 'PATCH', { expectedVersion: doc.version, title: '문서 수정 후 재시도' });
  await restart();
  assert.deepEqual(await call<Created>(path, 'POST', input), { ...attached, duplicate: true });
  await call(path, 'POST', input, 409, { 'X-Actor-Id': 'user-min' });
  await call(decisionPathFor(otherDoc.id), 'POST', input, 409);
  await call(path, 'POST', { ...input, issueId: otherIssue.id }, 409);
  await call(path, 'POST', { ...input, expectedDocumentVersion: edited.version }, 409);
  await call(path, 'POST', { ...input, requestId: randomUUID() }, 409);

  await call(`/resource-links/${attached.link.id}?${decisionRemovalQuery(attached.link.documentSource)}`, 'DELETE');
  await call(path, 'POST', input, 409);
  assert.equal((await call<WorkspaceSnapshot>('/workspace')).resourceLinks.some(link => link.documentId === doc.id), false);
  const reattached = await call<Created>(path, 'POST', decisionLink(edited, issue), 201);
  assert.notEqual(reattached.link.id, attached.link.id);
  await call(path, 'POST', input, 409);
  assert.deepEqual((await call<WorkspaceSnapshot>('/workspace')).resourceLinks.filter(link => link.documentId === doc.id), [reattached.link]);
});

test('attaching a sentence comment to an existing issue preserves its original evidence through edits, conflicts and replay', async t => {
  const { call, directory, key, restart } = await fixture(t);
  const narrow = await key([projectId], 'write', 'user-min');
  const wide = await key([projectId, commonTarget], 'write', 'user-min');
  const document = await call<DocPage>('/documents', 'POST', {
    projectId, title: '댓글을 남긴 설계', content: issueSummaryBody(commonTarget),
  }, 201);
  const { comment, source } = await sentenceComment(call, document);
  const otherText = '합성 결정';
  const otherSelection = { from: 1, to: 1 + otherText.length, text: otherText };
  const { comment: other } = await call<DocumentSelectionCommentResult>(`/documents/${document.id}/selection-comments`, 'POST', {
    requestId: randomUUID(), expectedDocumentVersion: document.version, sourceSelection: otherSelection, body: '같은 저장본의 다른 발췌',
  }, 201);
  assert.equal(other.documentSource?.revisionId, source.revisionId);
  const issue = await call<Issue>('/issues', 'POST', { projectId, title: '이미 계획한 기존 업무', description: '기존 업무 설명' }, 201);
  const ordinary = await call<ResourceLink>('/resource-links', 'POST', { issueId: issue.id, documentId: document.id, kind: '설계 참고' }, 201);
  const latest = await call<DocPage>(`/documents/${document.id}`, 'PATCH', {
    expectedVersion: document.version, title: '편집한 현재 설계', contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '원래 문장을 교체했다.' }] }] },
  });
  const path = `/v1${decisionPathFor(document.id)}`;
  const base = { requestId: randomUUID(), expectedDocumentVersion: latest.version, issueId: issue.id };
  const input = { ...base, sourceComment: { commentId: comment.id, revisionId: source.revisionId } };
  const before = await call<WorkspaceSnapshot>('/workspace');
  const revisionsPath = `/documents/${document.id}/revisions`;
  const revisions = await call<DocRevision[]>(revisionsPath);
  const currentRevision = revisions.find(revision => revision.version === latest.version);
  assert.ok(currentRevision && currentRevision.id !== source.revisionId);

  await call(path, 'POST', base, 400, wide);
  await call(path, 'POST', { ...input, sourceSelection: otherSelection }, 400, wide);
  await call(path, 'POST', { ...input, sourceComment: { ...input.sourceComment, text: '위조한 원문' } }, 400, wide);
  const stale = await call<{ details: { currentVersion: number } }>(path, 'POST', { ...input, expectedDocumentVersion: document.version }, 409, wide);
  assert.equal(stale.details.currentVersion, latest.version);
  const wrongRevision = await call<{ details: { reason: string } }>(path, 'POST', {
    ...input, sourceComment: { ...input.sourceComment, revisionId: currentRevision.id },
  }, 409, wide);
  assert.equal(wrongRevision.details.reason, 'comment_source_unavailable');
  await call(path, 'POST', input, 403, narrow);
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), before);

  const observer = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  try {
    observer.exec(`CREATE TRIGGER fail_comment_decision_link_receipt BEFORE INSERT ON document_decision_link_requests
      BEGIN SELECT RAISE(ABORT, 'synthetic comment decision link receipt failure'); END`);
    await call(path, 'POST', input, 500, wide);
    assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), before);
  } finally {
    observer.exec('DROP TRIGGER IF EXISTS fail_comment_decision_link_receipt');
    observer.close();
  }

  const attached = await call<Created>(path, 'POST', input, 201, wide);
  assert.deepEqual(attached, { issue, link: { ...ordinary, documentSource: source }, duplicate: false });
  const after = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(after.documents, before.documents);
  assert.deepEqual(after.issues, before.issues);
  assert.deepEqual(after.resourceLinks.filter(link => link.documentId === document.id), [attached.link]);
  const entries = after.activities.filter(activity => !before.activities.some(previous => previous.id === activity.id));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, '문서 결정 근거 연결');
  assert.equal(entries[0].actorId, 'user-min');
  assert.deepEqual(await call<DocRevision[]>(revisionsPath), revisions);

  const reportPath = `/projects/${projectId}/decision-follow-ups`;
  const report = await call<DecisionFollowUpPage>(`${reportPath}?q=${encodeURIComponent(issue.key)}`);
  assert.equal(report.total, 1);
  assert.equal(report.items[0].document.title, latest.title);
  assert.equal(report.items[0].source.title, document.title);
  assert.equal(report.items[0].source.version, document.version);
  assert.deepEqual(await call<DecisionFollowUpSource>(`${reportPath}/${attached.link.id}/source`), {
    linkId: attached.link.id, documentId: document.id, source,
  });

  const changedComment = { ...input, sourceComment: { ...input.sourceComment, commentId: other.id } };
  await call(path, 'POST', changedComment, 409, wide);
  const conflict = await call<{ details: { reason: string } }>(path, 'POST', { ...changedComment, requestId: randomUUID() }, 409, wide);
  assert.equal(conflict.details.reason, 'decision_source_exists');
  assert.deepEqual(await call<Created>(path, 'POST', { ...input, requestId: randomUUID() }, 200, wide), { ...attached, duplicate: true });
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), after);

  await call(`/comments/${comment.id}`, 'DELETE');
  const archived = await call<WorkspaceSnapshot>('/workspace');
  await restart();
  const unavailable = await call<{ details: { reason: string } }>(path, 'POST', { ...input, requestId: randomUUID() }, 404, wide);
  assert.equal(unavailable.details.reason, 'comment_source_unavailable');
  await call(path, 'POST', input, 403, narrow);
  assert.deepEqual(await call<Created>(path, 'POST', input, 200, wide), { ...attached, duplicate: true });
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), archived);
});

test('failure at an existing-issue receipt rolls back its source snapshot, relation upgrade and activity', async t => {
  const { call, directory } = await fixture(t);
  const doc = await call<DocPage>('/documents', 'POST', { projectId, title: '결정 저장 합성 문서', content }, 201);
  const issue = await call<Issue>('/issues', 'POST', { projectId, title: '이미 연결한 업무' }, 201);
  const ordinary = await call<ResourceLink>('/resource-links', 'POST', { issueId: issue.id, documentId: doc.id, kind: '기존 참고' }, 201);
  const input = decisionLink(doc, issue);
  const path = decisionPathFor(doc.id);
  const revisionsPath = `/documents/${doc.id}/revisions`;
  const before = await call<WorkspaceSnapshot>('/workspace');
  const observer = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  try {
    // A saved collaboration version may exist before its corresponding checkpoint.
    observer.prepare('DELETE FROM revisions WHERE document_id=?').run(doc.id);
    observer.exec("CREATE TRIGGER fail_decision_link_receipt BEFORE INSERT ON document_decision_link_requests BEGIN SELECT RAISE(ABORT, 'synthetic decision receipt failure'); END");
    await call(path, 'POST', input, 500);
    assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), before);
    assert.deepEqual(await call<DocRevision[]>(revisionsPath), []);
  } finally {
    observer.exec('DROP TRIGGER IF EXISTS fail_decision_link_receipt');
    observer.close();
  }

  const attached = await call<Created>(path, 'POST', input, 201);
  const [revision] = await call<DocRevision[]>(revisionsPath);
  assert.equal(revision.version, doc.version);
  assert.deepEqual(revision.content, doc.content);
  assert.deepEqual(attached.issue, issue);
  assert.deepEqual(attached.link, { ...ordinary, documentSource: { ...input.sourceSelection, revisionId: revision.id } });
  const saved = await call<WorkspaceSnapshot>('/workspace');
  assert.equal(saved.activities.filter(activity => !before.activities.some(old => old.id === activity.id)).length, 1);
});

test('decision link confirmation survives restart and an earlier request cannot attach to a restored matching document', async t => {
  const { call, restart } = await fixture(t);
  const document = await call<DocPage>('/documents', 'POST', { projectId, title: '복원 세대를 검사할 결정', content }, 201);
  const issue = await call<Issue>('/issues', 'POST', { projectId, title: '복원 뒤 결정 근거를 다시 볼 업무' }, 201);
  const { restoreGeneration } = await call<WorkspaceSnapshot>('/workspace');
  const before = await call<Backup>('/export');
  assert.ok(restoreGeneration);
  const path = decisionPathFor(document.id);
  const input = { ...decisionLink(document, issue), expectedRestoreGeneration: restoreGeneration };
  const first = await call<Created>(path, 'POST', input, 201);
  await restart();
  assert.deepEqual(await call<Created>(path, 'POST', input), { ...first, duplicate: true });
  await call(path, 'POST', { ...input, expectedRestoreGeneration: null }, 400);
  await call(path, 'POST', input, 409, { 'X-Actor-Id': 'user-min' });

  const { trashEntryId } = await call<{ trashEntryId: string }>(`/documents/${document.id}`, 'DELETE');
  await call(`/trash/${trashEntryId}`, 'DELETE');
  await call('/import', 'POST', { data: before });
  const restored = await call<WorkspaceSnapshot>('/workspace');
  assert.notEqual(restored.restoreGeneration, input.expectedRestoreGeneration);
  assert.equal(restored.documents.find(item => item.id === document.id)?.version, input.expectedDocumentVersion);
  const blocked = await call<{ details?: { reason: string } }>(path, 'POST', input, 409);
  assert.equal(blocked.details?.reason, 'workspace_restored');
  assert.equal((await call<WorkspaceSnapshot>('/workspace')).resourceLinks.some(link => link.documentId === document.id), false);
  const relinked = await call<Created>(path, 'POST', { ...decisionLink(document, issue), expectedRestoreGeneration: restored.restoreGeneration }, 201);
  assert.equal(relinked.link.documentSource?.text, input.sourceSelection.text);
});

test('an existing-issue decision link preserves its exact source in live and trashed native backups', async t => {
  const { call } = await fixture(t);
  const doc = await call<DocPage>('/documents', 'POST', { projectId, title: '결정 당시 원문', content }, 201);
  const issue = await call<Issue>('/issues', 'POST', { projectId, title: '결정 근거를 보관할 기존 업무' }, 201);
  const otherIssue = await call<Issue>('/issues', 'POST', { projectId, title: '결정 근거에 새로 연결할 업무' }, 201);
  const ordinary = await call<ResourceLink>('/resource-links', 'POST', { issueId: issue.id, documentId: doc.id, kind: '설계 참고' }, 201);
  const input = decisionLink(doc, issue);
  const path = decisionPathFor(doc.id);
  const attached = await call<Created>(path, 'POST', input, 201);
  assert.equal(attached.link.id, ordinary.id);
  const fresh = await call<Created>(path, 'POST', decisionLink(doc, otherIssue), 201);
  const links = [attached.link, fresh.link];
  const revisionPath = `/documents/${doc.id}/include-revisions/${attached.link.documentSource!.revisionId}`;
  const original = await call<DocRevision>(revisionPath);
  assert.equal(original.title, doc.title);
  assert.equal(original.plainText, input.sourceSelection.text);
  await call<DocPage>(`/documents/${doc.id}`, 'PATCH', {
    expectedVersion: doc.version, title: '새로 정리한 문서', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '갱신한 결정 내용' }] }] },
  });

  const liveBackup = await call<Backup>('/export');
  assert.equal(liveBackup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(liveBackup.resourceLinks.filter(link => link.documentId === doc.id), links);
  const oldLive = await call<{ error: string }>('/import', 'POST', { data: { ...liveBackup, schemaVersion: 47 } }, 400);
  assert.match(oldLive.error, /schemaVersion 48/);
  await call('/import', 'POST', { data: liveBackup });
  await call(path, 'POST', input, 409);
  const restored = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(restored.resourceLinks.filter(link => link.documentId === doc.id), links);
  assert.deepEqual(await call<DocRevision>(revisionPath), original);
  const current = restored.documents.find(document => document.id === doc.id);
  assert.ok(current);

  const trash = await call<{ trashEntryId: string }>(`/documents/${doc.id}`, 'DELETE', { expectedVersion: current.version });
  const trashedBackup = await call<Backup>('/export');
  assert.equal(trashedBackup.resourceLinks.some(link => link.documentId === doc.id), false);
  assert.deepEqual(trashedBackup.trashEntries.find(entry => entry.id === trash.trashEntryId)?.resourceLinks, links);
  const oldTrash = await call<{ error: string }>('/import', 'POST', { data: { ...trashedBackup, schemaVersion: 47 } }, 400);
  assert.match(oldTrash.error, /schemaVersion 48/);
  await call('/import', 'POST', { data: trashedBackup });
  assert.deepEqual(await call<DocRevision>(revisionPath), original);
  await call(`/trash/${trash.trashEntryId}/restore`, 'POST', {});
  assert.deepEqual((await call<WorkspaceSnapshot>('/workspace')).resourceLinks.filter(link => link.documentId === doc.id), links);
  assert.deepEqual(await call<DocRevision>(revisionPath), original);
});
