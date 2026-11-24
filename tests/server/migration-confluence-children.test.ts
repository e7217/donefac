import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { normalizeDocumentContent } from '../../server/document-content.js';
import { convertLegacyContent, type MigrationContentContext, type MigrationReferenceInput } from '../../server/migration-content.js';
import { measureIncomingArchive } from '../../server/source-archive-integrity.js';
import { DOCUMENT_CHILD_LIST_DEFAULTS, documentChildLists } from '../../shared/document-child-list.js';
import { contentReferences } from '../../shared/document-nodes.js';
import type {
  DocPage, DocRevision, LegacyPackageSummary, LegacyRecord, MigrationApplyResult, MigrationConfiguration, MigrationOptions,
  MigrationPreview, SourceImport, SourceRecordArchive, WorkspaceSnapshot,
} from '../../shared/types.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const macro = (options: Record<string, string> = {}) => `<ac:structured-macro ac:name="children">${Object.entries(options)
  .map(([name, value]) => `<ac:parameter ac:name="${name}">${value}</ac:parameter>`).join('')}</ac:structured-macro>`;
const legacyPage = (text: string): LegacyRecord => ({
  id: 'page:100', kind: 'page', sourceId: '100', title: '원본 문서', containerId: '42', parentId: null, authorId: null,
  createdAt: null, updatedAt: null, text, textFormat: 'confluence-storage', metadata: {}, references: [],
});
type Backup = WorkspaceSnapshot & { schemaVersion: number; revisions: DocRevision[]; sourceImports: SourceImport[]; sourceRecords: SourceRecordArchive[] };

test('Confluence children parameters preserve scope, hierarchy bounds, sibling order and heading style', () => {
  const references: MigrationReferenceInput[] = [], spaces: (string | null)[] = [];
  const context: MigrationContentContext = {
    resolveReference(input) { references.push(input); return { id: 'resolved-page', label: '이관된 부모' }; },
    resolveChildListSpaceProject(space) { spaces.push(space); return space === 'SUPPORT' ? 'support-project' : 'current-project'; },
  };
  const xml = [
    macro(), macro({ page: '<ac:link><ri:page ri:content-title="책임 문서" ri:space-key="SUPPORT"></ri:page></ac:link>',
      all: 'true', depth: '2', first: '99', sort: 'creation', reverse: 'true', style: 'h4', excerpt: 'none' }),
    macro({ page: '/', sort: 'modified', depth: '60' }), macro({ page: 'SUPPORT:', sort: 'title', first: '500' }),
    macro({ page: 'SUPPORT:다른 부모', sort: 'title' }), macro({ sort: ' ' }),
  ].join('');
  const result = convertLegacyContent(legacyPage(xml), context);
  assert.deepEqual(result.diagnostics.map(item => item.code), []);
  assert.deepEqual(documentChildLists(result.content), [
    { ...DOCUMENT_CHILD_LIST_DEFAULTS, sort: 'manual' },
    { ...DOCUMENT_CHILD_LIST_DEFAULTS, scope: 'document', documentId: 'resolved-page', depth: 'all', first: 99, sort: 'created', descending: true, style: 'h4' },
    { ...DOCUMENT_CHILD_LIST_DEFAULTS, scope: 'current-space', depth: 60, sort: 'updated' },
    { ...DOCUMENT_CHILD_LIST_DEFAULTS, scope: 'space', projectId: 'support-project', first: 500 },
    { ...DOCUMENT_CHILD_LIST_DEFAULTS, scope: 'document', documentId: 'resolved-page' },
    { ...DOCUMENT_CHILD_LIST_DEFAULTS, sort: 'manual' },
  ]);
  assert.deepEqual(references.map(({ title, spaceKey }) => [title, spaceKey]), [['책임 문서', 'SUPPORT'], ['다른 부모', 'SUPPORT']]);
  assert.deepEqual(spaces, [null, 'SUPPORT']);
  assert.ok(contentReferences(result.content).every(reference => reference.kind !== 'include'));
  assert.deepEqual(normalizeDocumentContent(result.content), { content: result.content, plainText: result.plainText });
  const former = convertLegacyContent(legacyPage(xml), { ...context, legacyChildListDefaultOrder: true });
  assert.deepEqual(former.diagnostics.map(item => item.code), ['CHILD_LIST_DEFAULT_ORDER_CONVERTED']);
  assert.deepEqual(documentChildLists(former.content).map(options => options.sort), ['title', 'created', 'updated', 'title', 'title', 'title']);
});

test('Confluence children preserves unknown settings, excerpt modes, unresolved scopes and former rendering as inert XML', () => {
  const unsupported = [
    macro({ excerpt: 'simple' }), macro({ excerpt: 'rich content' }), macro({ depth: '61' }), macro({ first: '501' }),
    macro({ sort: 'manual' }), macro({ all: 'maybe' }), macro({ reverse: '-1' }), macro({ style: 'h7' }),
    macro({ unsupported: '<script>literal</script>' }),
    macro({ page: '<ac:link ac:anchor="different"><ri:page ri:content-title="문서"></ri:page></ac:link>' }),
    macro({ page: '<ri:page ri:content-id="1" ri:page-id="2"></ri:page>' }),
    macro({ page: '없는 부모' }), macro({ page: 'MISSING:' }), macro({ page: '/' }),
    '<ac:structured-macro ac:name="children"><ac:parameter ac:name="first">2</ac:parameter><ac:parameter ac:name="first">3</ac:parameter></ac:structured-macro>',
    '<ac:structured-macro ac:name="children"><ac:rich-text-body><p>원문</p></ac:rich-text-body></ac:structured-macro>',
    '<ac:structured-macro ac:name="children" ac:unknown="true"></ac:structured-macro>',
  ];
  for (const [index, xml] of unsupported.entries()) {
    const { diagnostics, content } = convertLegacyContent(legacyPage(xml), { resolveReference: () => null });
    const expected = index <= 1 ? 'CHILD_LIST_EXCERPT_UNSUPPORTED'
      : index >= 11 && index <= 13 ? 'CHILD_LIST_SCOPE_UNRESOLVED' : 'CHILD_LIST_PARAMETERS_UNSUPPORTED';
    assert.deepEqual(diagnostics.map(item => item.code), [expected], xml);
    assert.equal(content.content?.[0].type, 'codeBlock');
    assert.equal(content.content?.[0].content?.[0].text, xml);
  }
  const old = macro({ sort: 'creation', depth: '2' });
  const prior = convertLegacyContent(legacyPage(old), { resolveReference: () => null, legacyDocumentChildList: true });
  assert.equal(prior.content.content?.[0].content?.[0].text, old);
  assert.equal(prior.diagnostics[0]?.code, 'LEGACY_CHILD_LIST_REPRESENTATION');
});

async function app(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-confluence-children-'));
  const service = createApp({ dataDir, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } finally { service.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  async function call<T = unknown>(path: string, method = 'GET', value?: unknown, expected = 200): Promise<T> {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-seo' },
      body: value === undefined ? undefined : JSON.stringify(value) });
    const data = await response.json() as T;
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  return {
    call,
    async upload(instanceKey: string, name: string, archive: Buffer) {
      const params = new URLSearchParams({ filename: `${name}.zip`, product: 'confluence', instanceKey });
      const response = await fetch(`${base}/legacy-import/packages?${params}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-seo' }, body: new Uint8Array(archive),
      });
      const data = await response.json() as LegacyPackageSummary;
      assert.equal(response.status, 201, JSON.stringify(data));
      return (await call<MigrationOptions>(`/migrations/options?packageId=${data.id}`)).defaultConfiguration;
    },
    preview: (configuration: MigrationConfiguration) => call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201),
    apply: (plan: MigrationPreview, status = 201) => call<MigrationApplyResult>(`/migrations/previews/${plan.id}/apply`, 'POST',
      { expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements }, status),
  };
}

type ArchivePage = { id: string; title: string; body?: string; parentId?: string; spaceId?: string; version?: number };
function archive(pages: ArchivePage[], spaces: Record<string, string> = { '42': 'WIKI' }) {
  const prop = (name: string, value: string) => `<property name="${name}">${value}</property>`;
  const object = (kind: string, id: string, children: string) => `<object class="${kind}"><id name="id">${id}</id>${children}</object>`;
  const link = (name: string, kind: string, id: string) => `<property name="${name}" class="${kind}"><id name="id">${id}</id></property>`;
  const spaceRows = Object.entries(spaces).map(([id, key]) => object('Space', id, prop('key', key) + prop('name', `원본 ${key}`)));
  const records = pages.flatMap(({ id, title, parentId, body, spaceId = '42', version = 1 }) => [
    object('Page', id, prop('title', title) + prop('version', String(version)) + link('space', 'Space', spaceId) +
      (parentId ? link('parent', 'Page', parentId) : '') + prop('creationDate', '2020-05-01T00:00:00Z') +
      prop('lastModificationDate', `2020-05-0${version}T00:00:00Z`)),
    object('BodyContent', `9${id}`, prop('body', `<![CDATA[${body ?? '<p>원문</p>'}]]>`) + link('content', 'Page', id)),
  ]);
  return zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>${[...spaceRows, ...records].join('')}</hibernate-generic>`) }]);
}

test('initial Confluence children import resolves named parents and isolated spaces without broadening merged projects', async t => {
  const runtime = await app(t);
  const root = macro({ page: '/', sort: 'title' }), foreign = macro({ page: 'DOCS:', sort: 'title' });
  const named = macro({ page: '<ac:link><ri:page ri:content-title="설계" ri:space-key="DOCS"></ri:page></ac:link>', depth: '2', sort: 'title' });
  const rows = [
    { id: '100', title: '색인', body: root + foreign + named }, { id: '200', title: '설계', spaceId: '43' },
    { id: '300', title: '상세 설계', spaceId: '43', parentId: '200' },
  ];
  const options = await runtime.upload('synthetic-children-separated', 'separate', archive(rows, { '42': 'WIKI', '43': 'DOCS' }));
  const plan = await runtime.preview(options);
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.ok(!plan.notices.some(item => item.code.startsWith('CHILD_LIST_')));
  await runtime.apply(plan);
  const snapshot = await runtime.call<WorkspaceSnapshot>('/workspace');
  const parent = snapshot.documents.find(doc => doc.title === '설계')!;
  const index = snapshot.documents.find(doc => doc.title === '색인')!;
  assert.deepEqual(documentChildLists(index.content).map(({ scope, projectId, documentId }) => [scope, projectId, documentId]), [
    ['current-space', null, null], ['space', parent.projectId, null], ['document', null, parent.id],
  ]);
  assert.equal(snapshot.documents.find(doc => doc.title === '상세 설계')?.parentId, parent.id);
  assert.deepEqual(contentReferences(index.content).map(({ id, kind }) => [id, kind]), [[parent.id, 'reference']]);

  const mixed = await runtime.upload('synthetic-children-merged', 'mixed', archive(rows, { '42': 'WIKI', '43': 'DOCS' }));
  mixed.projects = mixed.projects.map(project => ({ ...project, key: 'MERGED', name: '합친 원본 공간' }));
  const merged = await runtime.preview(mixed);
  assert.equal(merged.canApply, true, JSON.stringify(merged.notices));
  assert.ok(merged.notices.some(item => item.code === 'CHILD_LIST_SCOPE_UNRESOLVED' && item.requiresAcknowledgement));
  const receipt = await runtime.apply(merged);
  const after = await runtime.call<WorkspaceSnapshot>('/workspace');
  const mergedIndex = after.documents.find(doc => doc.title === '색인' && doc.projectId === receipt.import.projectIds[0])!;
  assert.deepEqual(mergedIndex.content.content?.map(node => node.type), ['codeBlock', 'codeBlock', 'documentChildList']);
});

test('Confluence children refresh reconstructs exact older XML and keeps edited bodies and changed scope safe', async t => {
  const initial = await app(t), restored = await app(t);
  const instance = 'synthetic-children-old-checkpoint';
  const legacy = macro({ page: '/', sort: 'title' });
  const formerDefault = macro();
  const pages = [
    { id: '100', title: '기존 색인', body: legacy }, { id: '200', title: '별도 편집한 색인', body: legacy },
    { id: '250', title: '이전 기본 정렬 색인', body: formerDefault },
  ];
  const first = await initial.upload(instance, 'old', archive(pages));
  const receipt = await initial.apply(await initial.preview(first));
  const [projectId] = receipt.import.projectIds;
  const backup = await initial.call<Backup>('/export');
  backup.schemaVersion = 67;
  for (const value of backup.sourceImports) delete value.integrity;
  for (const value of backup.sourceRecords) {
    delete value.confluencePageFieldHashes;
    delete value.confluencePageBodySourceHash;
  }
  const oldBody = normalizeDocumentContent({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: legacy }] }] });
  const original = backup.documents.find(doc => doc.title === '기존 색인')!;
  const edited = backup.documents.find(doc => doc.title === '별도 편집한 색인')!;
  const former = backup.documents.find(doc => doc.title === '이전 기본 정렬 색인')!;
  const { content, plainText } = convertLegacyContent(legacyPage(formerDefault), { resolveReference: () => null, legacyChildListDefaultOrder: true });
  Object.assign(former, { content, plainText });
  Object.assign(original, oldBody);
  Object.assign(edited, normalizeDocumentContent({ type: 'doc', content: [
    ...oldBody.content.content!, { type: 'paragraph', content: [{ type: 'text', text: '팀 편집' }] },
  ] }));
  for (const value of backup.revisions.filter(revision => revision.documentId === original.id || revision.documentId === edited.id)) Object.assign(value, oldBody);
  for (const value of backup.revisions.filter(revision => revision.documentId === former.id)) Object.assign(value, { content, plainText });
  await restored.call('/import', 'POST', { data: backup });

  const fresh = macro({ page: '/', depth: '3', sort: 'modified', reverse: 'true' });
  const newer = await restored.upload(instance, 'new', archive([
    ...pages.map(page => ({ ...page, body: fresh, version: 2 })), { id: '300', title: '새 지원 문서' },
  ]));
  const configuration = { ...newer, appendPagesTo: { projectId, refreshExisting: true as const } };
  const plan = await restored.preview(configuration);
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  function contentDecision(documentId: string) {
    return plan.documentRefresh?.find(item => item.documentId === documentId)?.fields.find(field => field.field === 'content')?.decision;
  }
  assert.equal(contentDecision(original.id), 'apply');
  assert.equal(contentDecision(edited.id), 'conflict');
  assert.equal(contentDecision(former.id), 'apply');
  const local = await restored.call<DocPage>('/documents', 'POST', { projectId, title: '이관 밖 팀 문서' }, 201);
  await restored.apply(plan, 409);
  const mixed = await restored.preview(configuration);
  assert.ok(mixed.notices.some(item => item.code === 'CHILD_LIST_SCOPE_UNRESOLVED'));
  assert.ok(mixed.notices.some(item => item.code === 'CONFLUENCE_REFRESH_BODY_UNAVAILABLE'));
  await restored.call(`/documents/${local.id}?expectedVersion=${local.version}`, 'DELETE');
  await restored.apply(await restored.preview(configuration));
  const snapshot = await restored.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(documentChildLists(snapshot.documents.find(doc => doc.id === original.id)!.content), [
    { ...DOCUMENT_CHILD_LIST_DEFAULTS, scope: 'current-space', depth: 3, sort: 'updated', descending: true },
  ]);
  assert.equal(JSON.stringify(snapshot.documents.find(doc => doc.id === edited.id)?.content), JSON.stringify(edited.content));
});

test('same-version Confluence refresh upgrades only the proven former default sort', async t => {
  const initial = await app(t), restored = await app(t);
  const instance = 'synthetic-children-former-default';
  const formerDefault = macro({ page: '/', reverse: 'true' }), explicit = macro({ sort: 'title' });
  const pages = [
    { id: '100', title: '기본 정렬', body: formerDefault + explicit },
    { id: '200', title: '정렬과 본문 편집', body: formerDefault },
    { id: '300', title: '명시적 제목순', body: explicit },
    { id: '400', title: '본문 비교 기준이 없는 이전 이관', body: formerDefault },
    { id: '500', title: '다른 원본 본문을 반영한 이관', body: formerDefault },
  ];
  const first = await initial.upload(instance, 'initial-default', archive(pages));
  const receipt = await initial.apply(await initial.preview(first));
  const [projectId] = receipt.import.projectIds;
  const backup = await initial.call<Backup>('/export');
  const previousBodies = new Map<string, DocPage['content']>();
  for (const source of backup.sourceRecords.filter(record => record.targetType === 'document')) {
    const { content, plainText } = convertLegacyContent(source.record, {
      resolveReference: () => null, resolveChildListSpaceProject: () => projectId, legacyChildListDefaultOrder: true,
    });
    const document = backup.documents.find(doc => doc.id === source.targetId)!;
    if (source.record.sourceId === '400') {
      delete source.confluencePageFieldHashes;
      delete source.confluencePageBodySourceHash;
    } else {
      source.confluencePageFieldHashes!.content = createHash('sha256').update(JSON.stringify(['content', JSON.stringify(content)])).digest('hex');
    }
    if (source.record.sourceId === '500') source.confluencePageBodySourceHash = 'b'.repeat(64);
    const body = source.record.sourceId === '200' ? normalizeDocumentContent({ type: 'doc', content: [
      ...content.content!, { type: 'paragraph', content: [{ type: 'text', text: '팀에서 작성한 문단' }] },
    ] }) : { content, plainText };
    Object.assign(document, body);
    previousBodies.set(source.record.sourceId, body.content);
    for (const revision of backup.revisions.filter(value => value.documentId === document.id)) Object.assign(revision, { content, plainText });
  }
  for (const item of backup.sourceImports) {
    item.integrity = { version: 1, packages: measureIncomingArchive(item, backup.sourceRecords).packages };
  }
  await restored.call('/import', 'POST', { data: backup });

  const refreshed = await restored.upload(instance, 'same-version', archive([...pages].reverse()));
  const configuration = { ...refreshed, appendPagesTo: { projectId, refreshExisting: true as const } };
  const local = await restored.call<DocPage>('/documents', 'POST', { projectId, title: '이관 밖 팀 문서' }, 201);
  assert.ok(!(await restored.preview(configuration)).documentRefresh?.some(value => value.fields.some(field => field.field === 'content')));
  await restored.call(`/documents/${local.id}?expectedVersion=${local.version}`, 'DELETE');
  const plan = await restored.preview(configuration);
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.deepEqual(plan.documentRefresh?.map(row => [row.sourceId, row.fields.map(field => [field.field, field.decision])]), [
    ['400', [['content', 'apply']]],
    ['100', [['content', 'apply']]],
  ]);
  assert.ok(plan.notices.some(item => item.code === 'CONFLUENCE_REFRESH_CHILD_LIST_ORDER_RESTORED'));
  await restored.apply(plan);
  const snapshot = await restored.call<WorkspaceSnapshot>('/workspace');
  const current = (sourceId: string) => snapshot.documents.find(document => document.title === pages.find(page => page.id === sourceId)!.title)!.content;
  assert.deepEqual(documentChildLists(current('100')).map(options => [options.sort, options.descending]), [['manual', true], ['title', false]]);
  assert.deepEqual(documentChildLists(current('400')).map(options => options.sort), ['manual']);
  for (const sourceId of ['200', '300', '500']) assert.deepEqual(current(sourceId), previousBodies.get(sourceId));

  const repeat = await restored.upload(instance, 'same-version-repeat', archive([pages[1], pages[0], ...pages.slice(2)]));
  const repeatedPlan = await restored.preview({ ...repeat, appendPagesTo: configuration.appendPagesTo });
  assert.ok(!repeatedPlan.documentRefresh?.some(row => row.fields.some(field => field.field === 'content')));
});
