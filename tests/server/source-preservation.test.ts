import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import type { Attachment, AttachmentVersion, Comment, DocPage, DocRevision, Issue, IssueRelation, LegacyRecord, LegacySource, Project, SourceImport, SourceRecordArchive, SourceRecordPage, User } from '../../shared/types.js';
import { Store } from '../../server/store.js';
import type { PreparedMigration } from '../../server/migration-contracts.js';
import { migrationOptionId } from '../../server/migration-option-id.js';
import { AttachmentVersionsService } from '../../server/attachment-versions.js';
import { SourcePreservationError, SourcePreservationService, type SourcePreservationContext } from '../../server/source-preservation.js';
import { WorklogService } from '../../server/worklogs.js';

const now = '2026-11-19T00:00:00.000Z', old = '2020-01-02T03:04:05.000Z';
const isError = (status = 400) => (error: unknown) => error instanceof SourcePreservationError && error.status === status;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'donefac-source-preservation-')), store = new Store(dir), service = new SourcePreservationService(store);
  const users: User[] = [{ id: 'actor', name: '이관 작업자', email: 'actor@example.test', color: '#567899' }, { id: 'mapped', name: '현재 팀원', email: 'mapped@example.test', color: '#567899' }];
  const projects: Project[] = ['A', 'B'].map(letter => ({ id: `project-${letter}`, key: `SRC${letter}`, name: `합성 ${letter}`, description: '', color: '#567899', createdAt: now }));
  const issues: Issue[] = ['a', 'b'].map(letter => ({ id: `issue-${letter}`, key: `SRCA-${letter === 'a' ? 1 : 2}`, projectId: projects[0].id, title: `합성 업무 ${letter}`, description: '현재 본문', type: '작업', status: 'todo', priority: 'medium', assigneeId: null, collaboratorIds: [], parentId: null, labels: [], startDate: null, endDate: null, dueDate: null, estimate: null, cycle: null, module: null, release: null, version: 1, createdAt: now, updatedAt: now, completedAt: null }));
  const documents: DocPage[] = [{ id: 'doc-a', projectId: projects[1].id, parentId: null, title: '현재 문서', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '현재 본문' }] }] }, plainText: '현재 본문', icon: '📄', status: 'draft', version: 1, authorId: 'mapped', createdAt: now, updatedAt: now }];
  const comments: Comment[] = [{ id: 'comment-a', resourceType: 'issue', resourceId: issues[0].id, authorId: 'mapped', body: '이관 댓글', createdAt: old }];
  const revisions: DocRevision[] = [{ id: 'revision-a', documentId: documents[0].id, version: 1, title: '원본 버전', content: documents[0].content, plainText: '원본 버전 본문', authorId: 'mapped', createdAt: old, summary: '보존한 이력' }];
  const attachments: Attachment[] = [{ id: randomUUID(), resourceType: 'document', resourceId: documents[0].id, filename: 'current.txt', mimeType: 'application/octet-stream', size: 3, sha256: 'a'.repeat(64), authorId: 'mapped', createdAt: now }];
  for (const [table, rows] of [['users', users], ['projects', projects], ['issues', issues], ['documents', documents], ['comments', comments], ['revisions', revisions], ['attachments', attachments]] as const) for (const row of rows) store.put(table, row);
  const jira: LegacySource = { product: 'jira', format: 'jira-json', instanceKey: 'synthetic-jira', declaredVersion: '8.0', timezone: 'UTC' }, confluence: LegacySource = { product: 'confluence', format: 'confluence-xml', instanceKey: 'synthetic-confluence', declaredVersion: '6.9.1', timezone: 'UTC' };
  const packageIds = [randomUUID(), randomUUID()], sourceImport: SourceImport = { id: randomUUID(), version: 1, actorId: 'actor', createdAt: now, projectIds: projects.map(value => value.id), configuration: { packageIds, projects: projects.map((value, index) => ({ containerId: `container-${index}`, key: value.key, name: value.name })), users: { old: 'mapped' }, statuses: {}, issueTypes: {}, fields: {}, sourceBaseUrls: { [packageIds[0]]: null, [packageIds[1]]: null }, timezone: 'UTC', datePolicy: 'import-time', excludedRecords: [] }, packages: [{ stagingId: packageIds[0], filename: 'jira.json', sha256: 'b'.repeat(64), source: jira }, { stagingId: packageIds[1], filename: 'entities.xml', sha256: 'c'.repeat(64), source: confluence }], counts: { issues: 2, documents: 1 } };
  function archive(kind: LegacyRecord['kind'], id: string, partial: Partial<SourceRecordArchive>, format = jira): SourceRecordArchive {
    const record: LegacyRecord = { id: `${kind}:${id}`, kind, sourceId: id, title: `${kind} 원본`, containerId: null, parentId: null, authorId: 'old-user', createdAt: old, updatedAt: old, text: '', textFormat: 'plain', metadata: {}, references: [] };
    return { id: randomUUID(), sourceImportId: sourceImport.id, packageSha256: format.product === 'jira' ? 'b'.repeat(64) : 'c'.repeat(64), source: format, record, targetType: null, targetId: null, targetProjectId: null, ownerType: null, ownerId: null, ...partial };
  }
  const identity = archive('identity', 'old-user', {}); identity.record.title = '원래 홍길동'; identity.record.authorId = null;
  const originalIssue = archive('issue', '100', { targetType: 'issue', targetId: issues[0].id, targetProjectId: projects[0].id, ownerType: 'issue', ownerId: issues[0].id }); originalIssue.record.metadata.key = 'OLD-100'; originalIssue.record.metadata.privateOriginal = 'PRIVATE_METADATA_NEVER_IN_SUMMARY'; originalIssue.record.text = '보존 원문\r\n' + 'long-original-text-'.repeat(1000);
  const project = archive('project', 'P-1', { targetType: 'project', targetId: projects[0].id, targetProjectId: projects[0].id });
  const page = archive('page', '200', { targetType: 'document', targetId: documents[0].id, targetProjectId: projects[1].id, ownerType: 'document', ownerId: documents[0].id }, confluence);
  const history = archive('history', 'history-1', { ownerType: 'issue', ownerId: issues[0].id, targetProjectId: projects[0].id }); history.record.text = '원래 상태 변경 이력';
  const comment = archive('comment', 'old-comment', { targetType: 'comment', targetId: comments[0].id, targetProjectId: projects[0].id, ownerType: 'issue', ownerId: issues[0].id });
  const revision = archive('revision', 'old-revision', { targetType: 'revision', targetId: revisions[0].id, targetProjectId: projects[1].id, ownerType: 'document', ownerId: documents[0].id }, confluence);
  const oldFileId = randomUUID(), latestFile = archive('attachment', 'file-latest', { targetType: 'attachment', targetId: attachments[0].id, targetProjectId: projects[1].id, ownerType: 'document', ownerId: documents[0].id }, confluence), oldFile = archive('attachment', 'file-old', { targetType: 'attachment', targetId: oldFileId, targetProjectId: projects[1].id, ownerType: 'document', ownerId: documents[0].id }, confluence);
  const sourceRecords = [identity, project, originalIssue, page, history, comment, revision, latestFile, oldFile];
  const attachmentVersions: AttachmentVersion[] = [{ ...attachments[0], attachmentId: attachments[0].id, versionLabel: '2', sourceImportId: sourceImport.id, sourceRecordId: latestFile.id }, { ...attachments[0], id: oldFileId, attachmentId: attachments[0].id, filename: 'old.txt', sha256: 'd'.repeat(64), authorId: 'actor', createdAt: old, versionLabel: '1', sourceImportId: sourceImport.id, sourceRecordId: oldFile.id }];
  const issueRelations: IssueRelation[] = [{ id: randomUUID(), sourceIssueId: issues[0].id, targetIssueId: issues[1].id, type: 'relates', version: 1, createdAt: now }];
  const prepared: PreparedMigration = { sourceImport, sourceRecords, projects, issues, documents, comments, revisions, worklogs: [], attachments, attachmentVersions, issueRelations, workflows: [], issueSchemas: [], fileCopies: [], resourceLinks: [], atlassianLinks: [], preview: { id: sourceImport.id, version: 1, actorId: 'actor', createdAt: now, expiresAt: '2026-11-19T00:30:00.000Z', configuration: sourceImport.configuration, projects: [], counts: {}, notices: [], requiredAcknowledgements: [], canApply: true, samples: [] } };
  const context = (): SourcePreservationContext => ({ users: store.all<User>('users'), projects: store.all<Project>('projects'), issues: store.all<Issue>('issues'), documents: store.all<DocPage>('documents'), comments: store.all<Comment>('comments'), revisions: store.all<DocRevision>('revisions'), attachments: store.all<Attachment>('attachments') });
  return { dir, store, service, prepared, context, originalIssue, page, history, archive, close() { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const data = (f: ReturnType<typeof fixture>) => ({ imports: f.service.allImports(), records: f.service.allRecords(), versions: f.service.allVersions(), relations: f.service.allRelations() });
const persist = (f: ReturnType<typeof fixture>) => f.store.transaction(() => f.service.persistPrepared(f.prepared));

test('prepared preservation requires the caller transaction, rolls back with canonical/audit failure, and repeats idempotently', () => {
  const f = fixture(); try {
    assert.throws(() => f.service.persistPrepared(f.prepared), isError(500));
    const before = f.store.get<Issue>('issues', 'issue-a')!;
    assert.throws(() => f.store.transaction(() => { f.store.put('issues', { ...before, title: '감사 실패 변경' }); f.service.persistPrepared(f.prepared); throw new Error('audit failed'); }), /audit failed/);
    assert.equal(f.service.hasImport(f.prepared.sourceImport.id), false); assert.deepEqual(data(f), { imports: [], records: [], versions: [], relations: [] }); assert.deepEqual(f.store.get('issues', before.id), before);
    persist(f); persist(f); assert.equal(f.service.allImports().length, 1); assert.equal(f.service.allRecords().length, f.prepared.sourceRecords.length); assert.deepEqual(f.service.allVersions(), f.prepared.attachmentVersions); assert.deepEqual(f.service.allRelations(), f.prepared.issueRelations);
    const changed = structuredClone(f.prepared); changed.sourceRecords[2].record.text = '원문 변조'; assert.throws(() => f.store.transaction(() => f.service.persistPrepared(changed)), isError(409)); assert.equal(f.service.record(f.prepared.sourceImport.id, f.originalIssue.id).record.text, f.originalIssue.record.text);
  } finally { f.close(); }
});

test('archive author evidence is tied to package mappings, exact bindings and the applied author', () => {
  const f = fixture();
  try {
    const prepared = structuredClone(f.prepared);
    const receipt = prepared.sourceImport;
    receipt.authorAttributionVersion = 1;
    for (const { stagingId } of receipt.packages) {
      receipt.configuration.users[migrationOptionId(stagingId, 'identity', 'old-user')] = 'mapped';
    }
    const bound = prepared.sourceRecords.filter(record => record.targetType &&
      ['document', 'comment', 'revision', 'attachment'].includes(record.targetType));
    for (const record of bound) {
      const kind = record.targetType as 'document' | 'comment' | 'revision' | 'attachment';
      const olderFile = record.record.sourceId === 'file-old';
      if (olderFile) record.record.authorId = null;
      record.authorAttribution = { kind, targetId: record.targetId!, disposition: olderFile ? 'missing-fallback' : 'mapped',
        expectedAuthorId: olderFile ? 'actor' : 'mapped' };
    }
    const commit = (value: typeof prepared) => f.store.transaction(() => f.service.persistPrepared(value));
    for (const tamper of [
      (value: typeof prepared) => { delete value.sourceImport.authorAttributionVersion; },
      (value: typeof prepared) => { delete value.sourceRecords.find(row => row.id === f.page.id)!.authorAttribution; },
      (value: typeof prepared) => { value.sourceRecords.find(row => row.id === f.page.id)!.authorAttribution!.targetId = 'another-document'; },
      (value: typeof prepared) => { value.sourceRecords.find(row => row.id === f.page.id)!.authorAttribution!.disposition = 'retained'; },
      (value: typeof prepared) => { value.sourceRecords.find(row => row.id === f.page.id)!.authorAttribution!.expectedAuthorId = 'actor'; },
    ]) {
      const invalid = structuredClone(prepared);
      tamper(invalid);
      assert.throws(() => commit(invalid), isError());
      assert.equal(f.service.hasImport(receipt.id), false);
    }
    const document = f.store.get<DocPage>('documents', f.page.targetId!)!;
    f.store.transaction(() => f.store.put('documents', { ...document, authorId: 'actor' }));
    assert.throws(() => commit(prepared), /적용 대상의 작성자/u);
    f.store.transaction(() => f.store.put('documents', document));
    commit(prepared);
    assert.equal(f.service.allImports()[0].authorAttributionVersion, 1);
    const restored = f.service.validateImport(data(f), f.context());
    assert.equal(restored.records.filter(record => record.authorAttribution).length, bound.length);
    const modified = data(f);
    modified.records.find(record => record.id === f.page.id)!.record.title = 'altered source record';
    assert.throws(() => f.service.validateImport(modified, f.context()), isError());
  } finally { f.close(); }
});

test('source IDs and Jira key aliases cannot be rebound to another target, while identical aliases may share the same target', () => {
  const f = fixture(); try {
    persist(f);
    for (const alias of ['source-id', 'jira-key']) {
      const changed = structuredClone(f.prepared), id = randomUUID(); changed.sourceImport.id = id; changed.preview.id = id;
      const archive = structuredClone(f.originalIssue); archive.id = randomUUID(); archive.sourceImportId = id; archive.targetId = 'issue-b'; archive.ownerId = 'issue-b';
      if (alias === 'jira-key') archive.record.sourceId = 'different-source-id'; else archive.record.metadata.key = 'DIFFERENT-KEY'; archive.record.id = `issue:${archive.record.sourceId}`;
      changed.sourceRecords = [archive]; changed.attachmentVersions = []; changed.issueRelations = [];
      assert.throws(() => f.store.transaction(() => f.service.persistPrepared(changed)), isError(409)); assert.equal(f.service.hasImport(id), false);
    }
    const shared = structuredClone(f.prepared), id = randomUUID(); shared.sourceImport.id = id; shared.preview.id = id; shared.sourceRecords = [{ ...structuredClone(f.originalIssue), id: randomUUID(), sourceImportId: id }]; shared.attachmentVersions = []; shared.issueRelations = [];
    f.store.transaction(() => f.service.persistPrepared(shared)); assert.equal(f.service.allImports().length, 2); assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM source_bindings WHERE kind=?').get('issue') as { n: number }).n, 2);
  } finally { f.close(); }
});

test('summary APIs page without raw bodies/metadata, include archived-only history and original names, and detail returns exact originals', async () => {
  const f = fixture(), app = express(); persist(f); f.service.registerRoutes(app);
  const errors: ErrorRequestHandler = (error: unknown, _req, response, next) => { void next; response.status(error instanceof SourcePreservationError ? error.status : 500).json({ error: error instanceof Error ? error.message : 'error' }); }; app.use(errors);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}/api`;
  try {
    const response = await fetch(`${url}/resource-origins?resourceType=issue&resourceId=issue-a&kind=history&limit=1`); assert.equal(response.status, 200); const history = await response.json() as SourceRecordPage;
    assert.equal(history.total, 1); assert.equal(history.records[0].targetId, null); assert.equal(history.records[0].originalAuthorName, '원래 홍길동'); assert.equal(history.records[0].record.sourceId, 'history-1');
    const issueResponse = await fetch(`${url}/source-imports/${f.prepared.sourceImport.id}/records?kind=issue`), issues = await issueResponse.json() as SourceRecordPage; assert.equal(issues.records[0].record.textBytes, Buffer.byteLength(f.originalIssue.record.text)); assert.equal(issues.records[0].record.textPreview.length, 600);
    for (const field of ['text', 'metadata', 'references']) assert.equal(Object.hasOwn(issues.records[0].record, field), false); assert.equal(JSON.stringify(issues).includes('PRIVATE_METADATA_NEVER_IN_SUMMARY'), false);
    const full = await fetch(`${url}/source-imports/${f.prepared.sourceImport.id}/records/${f.originalIssue.id}`); assert.equal(full.status, 200); assert.deepEqual(await full.json(), f.originalIssue);
    const page = await (await fetch(`${url}/source-imports/${f.prepared.sourceImport.id}/records?offset=1&limit=2`)).json() as SourceRecordPage; assert.equal(page.total, f.prepared.sourceRecords.length); assert.deepEqual(page.records.map(value => value.id), f.prepared.sourceRecords.slice(1, 3).map(value => value.id));
    for (const path of ['/resource-origins?resourceType=issue&resourceId=issue-a&id=unsupported', '/resource-origins?resourceType=issue&resourceId=issue-a&limit=NaN', '/resource-origins?resourceType=issue&resourceId=issue-a&limit=1&limit=2', `/source-imports/${f.prepared.sourceImport.id}/records?kind=unsupported`, `/source-imports/${f.prepared.sourceImport.id}/records?offset[]=1`]) assert.equal((await fetch(url + path)).status, 400, path);
    assert.equal((await fetch(`${url}/source-imports/missing/records/${f.originalIssue.id}`)).status, 404);
    assert.equal((await fetch(`${url}/attachments/${f.prepared.attachments[0].id}/versions`)).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});

test('applied migration notices open only the exact archived record from their receipt and package', async () => {
  const f = fixture();
  const input = f.prepared.sourceImport;
  const [firstPackage] = input.packages;
  const secondPackage = { ...firstPackage, stagingId: randomUUID(), filename: 'later.json', sha256: '1'.repeat(64) };
  input.packages.push(secondPackage);
  input.configuration.packageIds.push(secondPackage.stagingId);
  input.configuration.sourceBaseUrls![secondPackage.stagingId] = null;
  const first = f.archive('history', 'project/changes/91', {});
  first.record.text = '첫 번째 패키지의 원래 변경';
  const second = f.archive('history', first.record.sourceId, { packageSha256: secondPackage.sha256 });
  second.record.text = '두 번째 패키지의 원래 변경';
  f.prepared.sourceRecords.push(first, second);
  const notice = (recordId: string | null) => ({ severity: 'warning' as const, code: 'REVIEW_SOURCE', message: '원본을 확인하세요.',
    recordId, requiresAcknowledgement: false });
  input.notices = [notice(null), notice(`${firstPackage.stagingId}/${first.record.id}`), notice(`${secondPackage.stagingId}/${second.record.id}`),
    notice(`${randomUUID()}/${first.record.id}`), notice(first.record.id)];
  persist(f);
  const other = structuredClone(f.prepared);
  other.sourceImport.id = randomUUID();
  other.sourceRecords = [{ ...first, id: randomUUID(), sourceImportId: other.sourceImport.id }];
  other.attachmentVersions = [];
  other.issueRelations = [];
  f.store.transaction(() => f.service.persistPrepared(other));

  const app = express();
  f.service.registerRoutes(app);
  const handleError: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    void next;
    response.status(error instanceof SourcePreservationError ? error.status : 500).json({ error: error instanceof Error ? error.message : 'error' });
  };
  app.use(handleError);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/source-imports`;
  const source = (index: number | string, query = 'expectedVersion=1', receiptId = input.id) =>
    fetch(`${base}/${receiptId}/notices/${index}/source${query ? `?${query}` : ''}`);
  async function expectSource(index: number, candidate: SourceRecordArchive, query?: string, receiptId?: string) {
    const response = await source(index, query, receiptId);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), candidate);
  }

  try {
    const before = data(f);
    await expectSource(1, first);
    await expectSource(2, second);
    await expectSource(1, other.sourceRecords[0], undefined, other.sourceImport.id);
    for (const index of [0, 3, 4, 5]) assert.equal((await source(index)).status, 404);
    for (const index of ['01', '-1', '1.0', '9007199254740992']) assert.equal((await source(index)).status, 400);
    for (const query of ['', 'expectedVersion=0', 'expectedVersion=9007199254740992', 'expectedVersion=1&expectedVersion=1', 'expectedVersion=1&recordId=other']) {
      assert.equal((await source(1, query)).status, 400);
    }
    assert.equal((await source(1, 'expectedVersion=2')).status, 409);
    assert.deepEqual(data(f), before);

    const restored = f.service.validateImport(before, f.context());
    f.store.transaction(() => f.service.replaceImported(restored, new Map(before.imports.map(row => [row.id, row.version]))));
    assert.equal((await source(1)).status, 409);
    await expectSource(1, first, 'expectedVersion=2');
    await expectSource(2, second, 'expectedVersion=2');

    const duplicate = { ...first, id: randomUUID() };
    f.store.db.prepare(`INSERT INTO source_records(id,import_id,owner_type,owner_id,target_type,target_id,kind,source_instance,product,source_id,json)
      SELECT ?,import_id,owner_type,owner_id,target_type,target_id,kind,source_instance,product,source_id,? FROM source_records WHERE id=?`)
      .run(duplicate.id, JSON.stringify(duplicate), first.id);
    assert.equal((await source(1, 'expectedVersion=2')).status, 404);
    f.store.db.prepare("UPDATE source_records SET json=json_set(json,'$.source.format','jira-csv') WHERE id=?").run(duplicate.id);
    await expectSource(1, first, 'expectedVersion=2');
    f.store.db.prepare('DELETE FROM source_records WHERE id=?').run(first.id);
    assert.equal((await source(1, 'expectedVersion=2')).status, 404);
    await expectSource(2, second, 'expectedVersion=2');
    await expectSource(1, other.sourceRecords[0], 'expectedVersion=2', other.sourceImport.id);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    f.close();
  }
});

test('native source validation rejects membership, identity, author, owner, version-file and live relation mismatches without writes', () => {
  const f = fixture(); try {
    persist(f); const valid = data(f), before = structuredClone(valid);
    const edits: ((value: typeof valid) => void)[] = [
      value => { value.records[0].id = 'not-a-uuid'; }, value => { value.records[0].record.id = 'identity:different'; }, value => { value.records[0].sourceImportId = 'missing'; }, value => { value.records[0].packageSha256 = 'f'.repeat(64); }, value => { value.records[0].source.instanceKey = 'wrong-source'; },
      value => { value.records[0].record.metadata = { __proto__: null, constructor: 'bad' }; }, value => { value.imports[0].actorId = 'missing-user'; }, value => { value.imports[0].configuration.users.old = 'missing-user'; }, value => { value.imports[0].configuration.packageIds = []; }, value => { value.records[2].targetProjectId = 'not-in-receipt'; },
      value => { value.records[2].ownerId = 'issue-b'; }, value => { value.records[5].ownerType = 'document'; value.records[5].ownerId = 'doc-a'; }, value => { value.records[6].ownerId = 'wrong-parent'; }, value => { value.records[1].targetProjectId = 'project-B'; },
      value => { value.versions[0].sha256 = 'e'.repeat(64); }, value => { value.versions[1].sourceRecordId = value.versions[0].sourceRecordId; }, value => { value.versions[1].resourceId = 'wrong-parent'; }, value => { value.versions[1].authorId = 'missing-user'; }, value => { value.versions[1].attachmentId = 'missing'; }, value => { value.versions[1].filename = '../escape'; },
      value => { value.relations[0].targetIssueId = 'missing'; }, value => { value.relations[0].targetIssueId = value.relations[0].sourceIssueId; }, value => { value.records.push(structuredClone(value.records[0])); }, value => { value.versions.push(structuredClone(value.versions[0])); },
    ];
    for (const edit of edits) { const invalid = structuredClone(valid); edit(invalid); assert.throws(() => f.service.validateImport(invalid, f.context()), (error: unknown) => error instanceof SourcePreservationError); }
    assert.deepEqual(data(f), before); assert.deepEqual(f.service.validateImport(valid, f.context()), valid);
  } finally { f.close(); }
});

test('Jira custom field checkpoints round-trip and require a linked Jira issue and explicit refresh for existing issues', () => {
  const f = fixture(); try {
    const hashes = { project_code: { sourceFieldId: 'customfield_10010', hash: 'a'.repeat(64) } };
    f.originalIssue.jiraCustomFieldHashes = hashes;
    persist(f);
    const saved = data(f);
    const read = () => f.service.record(f.prepared.sourceImport.id, f.originalIssue.id);
    assert.deepEqual(read().jiraCustomFieldHashes, hashes);
    assert.deepEqual(f.service.validateImport(saved, f.context()).records.find(row => row.id === f.originalIssue.id)?.jiraCustomFieldHashes, hashes);

    for (const bad of [[], {}, { project_code: { sourceFieldId: '', hash: 'a'.repeat(64) } },
      { project_code: { sourceFieldId: 'customfield_10010', hash: 'invalid' } },
      { project_code: { ...hashes.project_code, extra: 'value' } }, { constructor: hashes.project_code }]) {
      const invalid = structuredClone(saved);
      delete invalid.imports[0].integrity;
      Object.assign(invalid.records.find(row => row.id === f.originalIssue.id)!, { jiraCustomFieldHashes: bad });
      assert.throws(() => f.service.validateImport(invalid, f.context()), isError());
    }
    const wrongOwner = structuredClone(saved);
    delete wrongOwner.imports[0].integrity;
    wrongOwner.records.find(row => row.id === f.page.id)!.jiraCustomFieldHashes = hashes;
    assert.throws(() => f.service.validateImport(wrongOwner, f.context()), isError());

    const [pkg] = f.prepared.sourceImport.packages;
    const newer = structuredClone(f.prepared), id = randomUUID();
    newer.sourceImport = { ...newer.sourceImport, id, projectIds: [f.originalIssue.targetProjectId!], packages: [pkg], counts: {},
      configuration: { ...newer.sourceImport.configuration, projects: [], packageIds: [pkg.stagingId],
        appendTo: { projectId: f.originalIssue.targetProjectId!, statuses: {}, issueTypes: {}, fields: {} } } };
    newer.issues = [];
    newer.sourceRecords = [{ ...structuredClone(f.originalIssue), id: randomUUID(), sourceImportId: id,
      jiraCustomFieldHashes: { project_code: { ...hashes.project_code, hash: 'b'.repeat(64) } } }];
    newer.attachmentVersions = [];
    newer.issueRelations = [];
    assert.throws(() => f.store.transaction(() => f.service.persistPrepared(newer)), isError());
    assert.equal(f.service.hasImport(id), false);
    Object.assign(newer.sourceImport.configuration.appendTo!, { refreshCustomFields: false });
    assert.throws(() => f.store.transaction(() => f.service.persistPrepared(newer)), isError());
    Object.assign(newer.sourceImport.configuration.appendTo!, { refreshCustomFields: true });
    const receipt = f.store.transaction(() => f.service.persistPrepared(newer));
    assert.equal(receipt.configuration.appendTo?.refreshCustomFields, true);
    assert.deepEqual(f.service.record(id, newer.sourceRecords[0].id).jiraCustomFieldHashes, newer.sourceRecords[0].jiraCustomFieldHashes);
    assert.deepEqual(read().jiraCustomFieldHashes, hashes);
  } finally { f.close(); }
});

test('Jira supplemental history validates immutable source anchors and finds deleted linked records', () => {
  const f = fixture(); try {
    const issue = f.prepared.issues[0], [pkg] = f.prepared.sourceImport.packages;
    const owner = { ownerType: 'issue', ownerId: issue.id, targetProjectId: issue.projectId } as const;
    f.originalIssue.record.containerId = 'P-1';
    const oldWorklog = f.archive('history', 'worklog:701', owner);
    oldWorklog.record.containerId = '100';
    oldWorklog.record.metadata.kind = 'worklog';
    oldWorklog.record.references = [{ kind: 'issue', sourceId: 'OLD-100', relation: 'worklogOf' }];
    f.prepared.sourceRecords.push(oldWorklog);
    persist(f);
    const worklogs = new WorklogService(f.store);
    const migrated = { id: randomUUID(), issueId: issue.id, projectId: issue.projectId, issueKey: issue.key, issueTitle: issue.title,
      authorId: 'mapped', workDate: '2020-01-02', minutes: 2, durationSeconds: 120, note: '', version: 1, createdAt: old, updatedAt: old };
    worklogs.persistMigrated([{ ...migrated, sourceRecordId: oldWorklog.id }], f.prepared.sourceRecords);
    f.store.db.prepare('UPDATE worklogs SET deleted_at=? WHERE id=?').run(now, migrated.id);
    f.store.db.prepare('DELETE FROM comments WHERE id=?').run('comment-a');
    const instance = pkg.source.instanceKey;
    assert.deepEqual(f.service.jiraIssueOrigins(instance, ['OLD-100'], 'alias').map(row => ({ ...row })), [
      { alias: 'OLD-100', issueId: issue.id, projectId: issue.projectId, sourceProjectId: 'P-1', archiveId: f.originalIssue.id },
    ]);
    assert.deepEqual(f.service.jiraKnownHistory(instance, { comment: ['old-comment'], worklog: ['worklog:701'] }).map(value => value.sourceId),
      ['old-comment', 'worklog:701']);

    const next = structuredClone(f.prepared);
    const id = randomUUID(), commentId = randomUUID();
    const sourceImport = next.sourceImport;
    next.sourceImport = { ...sourceImport, id, counts: {}, projectIds: [issue.projectId], packages: [pkg],
      configuration: { ...sourceImport.configuration, projects: [], packageIds: [pkg.stagingId], sourceBaseUrls: {},
        appendTo: { projectId: issue.projectId, statuses: {}, issueTypes: {}, fields: {}, refreshHistory: true } } };
    next.issues = [];
    next.attachmentVersions = [];
    next.issueRelations = [];
    next.jiraHistoryOwners = [issue.id];
    const comment = f.archive('comment', '702', { ...owner, sourceImportId: id, targetType: 'comment', targetId: commentId, jiraHistoryAppend: true });
    comment.record.containerId = '100';
    comment.record.references = [{ kind: 'issue', sourceId: 'OLD-100', relation: 'commentOn' }];
    const worklog = f.archive('history', 'worklog:703', { ...owner, sourceImportId: id, jiraHistoryAppend: true });
    worklog.record.containerId = '100';
    worklog.record.metadata.kind = 'worklog';
    worklog.record.references = [{ kind: 'issue', sourceId: 'OLD-100', relation: 'worklogOf' }];
    next.sourceRecords = [comment, worklog];
    next.comments = [{ id: commentId, resourceType: 'issue', resourceId: issue.id, authorId: 'mapped', body: '다음 원본 댓글', createdAt: old }];
    next.worklogs = [{ ...migrated, id: randomUUID(), sourceRecordId: worklog.id }];
    f.store.put('comments', next.comments[0]);
    const wrong = structuredClone(next);
    wrong.sourceRecords[0].record.references[0].sourceId = 'unknown-issue';
    assert.throws(() => f.store.transaction(() => f.service.persistPrepared(wrong)), isError());
    assert.equal(f.service.hasImport(id), false);
    f.store.transaction(() => { worklogs.persistMigrated(next.worklogs, next.sourceRecords); f.service.persistPrepared(next); });
    f.store.transaction(() => f.service.persistPrepared(next));
    const saved = data(f);
    assert.deepEqual(f.service.validateImport(saved, f.context()), saved);
    f.store.db.prepare('DELETE FROM worklogs WHERE id=?').run(next.worklogs[0].id);
    assert.deepEqual(f.service.jiraKnownHistory(instance, { comment: [], worklog: ['worklog:703'] }).map(value => value.archiveId), [worklog.id]);

    const change = (edit: (value: typeof saved) => void) => {
      const forged = structuredClone(saved);
      for (const receipt of forged.imports) delete receipt.integrity;
      edit(forged);
      assert.throws(() => f.service.validateImport(forged, f.context()), isError());
    };
    const changedComment = (value: typeof saved) => value.records.find(record => record.id === comment.id)!;
    change(value => { delete value.imports.find(receipt => receipt.id === id)!.configuration.appendTo?.refreshHistory; });
    change(value => { changedComment(value).record.metadata.visibility = { type: 'role', value: 'Secret' }; });
    change(value => { const row = changedComment(value); row.record.id = 'comment:old-comment'; row.record.sourceId = 'old-comment'; });
    change(value => { value.records.find(record => record.id === f.originalIssue.id)!.record.containerId = 'different-project'; });
    change(value => { changedComment(value).record.references[0].sourceId = 'unknown-issue'; });
  } finally { f.close(); }
});

test('Jira supplemental attachments keep tombstones and require the original issue and exact base version', () => {
  const f = fixture(); try {
    const issue = f.prepared.issues[0], [pkg] = f.prepared.sourceImport.packages;
    const owner = { ownerType: 'issue', ownerId: issue.id, targetProjectId: issue.projectId } as const;
    f.originalIssue.record.containerId = 'P-1';
    const sourceFile = (sourceId: string, sourceImportId: string, sha256: string) => {
      const attachment: Attachment = { id: randomUUID(), resourceType: 'issue', resourceId: issue.id, filename: 'report.bin',
        mimeType: 'application/octet-stream', size: 3, sha256, authorId: 'mapped', createdAt: old };
      const archive = f.archive('attachment', sourceId, { ...owner, sourceImportId, targetType: 'attachment', targetId: attachment.id });
      archive.record.containerId = '100';
      archive.record.references = [{ kind: 'issue', sourceId: 'OLD-100', relation: 'attachedTo' }];
      archive.record.metadata = { path: `attachments/OLD-100/${sourceId}`, bytesPresent: true, actualSize: attachment.size, sha256 };
      const version: AttachmentVersion = { ...attachment, attachmentId: attachment.id, versionLabel: '원본', sourceImportId, sourceRecordId: archive.id };
      return { attachment, archive, version };
    };
    const former = sourceFile('701', f.prepared.sourceImport.id, 'e'.repeat(64));
    f.prepared.attachments.push(former.attachment);
    f.prepared.attachmentVersions.push(former.version);
    f.prepared.sourceRecords.push(former.archive);
    f.store.put('attachments', former.attachment);
    persist(f);
    f.store.db.prepare('DELETE FROM attachments WHERE id=?').run(former.attachment.id);
    assert.deepEqual(f.service.jiraKnownAttachments(pkg.source.instanceKey, ['701', '702']).map(row => ({ ...row })), [
      { sourceId: '701', issueId: issue.id, archiveId: former.archive.id },
    ]);
    assert.deepEqual(f.service.jiraKnownAttachments('unrelated-instance', ['701']), []);

    const id = randomUUID(), next = structuredClone(f.prepared), added = sourceFile('702', id, 'd'.repeat(64));
    added.archive.jiraAttachmentAppend = true;
    next.sourceImport = { ...next.sourceImport, id, projectIds: [issue.projectId], packages: [pkg], counts: {},
      configuration: { ...next.sourceImport.configuration, projects: [], packageIds: [pkg.stagingId], sourceBaseUrls: {},
        appendTo: { projectId: issue.projectId, statuses: {}, issueTypes: {}, fields: {}, refreshAttachments: true } } };
    next.issues = [];
    next.comments = [];
    next.jiraAttachmentOwners = [issue.id];
    next.attachments = [added.attachment];
    next.attachmentVersions = [added.version];
    next.sourceRecords = [added.archive];
    next.issueRelations = [];
    f.store.put('attachments', added.attachment);
    const wrong = structuredClone(next);
    wrong.sourceRecords[0].record.sourceId = '701';
    wrong.sourceRecords[0].record.id = 'attachment:701';
    assert.throws(() => f.store.transaction(() => f.service.persistPrepared(wrong)), isError());
    assert.equal(f.service.hasImport(id), false);
    f.store.transaction(() => f.service.persistPrepared(next));
    const backup = data(f);
    assert.deepEqual(f.service.validateImport(backup, f.context()), backup);

    const changed = (modify: (value: typeof backup, context: SourcePreservationContext) => void) => {
      const forged = structuredClone(backup);
      for (const receipt of forged.imports) delete receipt.integrity;
      const context = f.context();
      modify(forged, context);
      assert.throws(() => f.service.validateImport(forged, context), isError());
    };
    changed(value => { delete value.imports.find(row => row.id === id)!.configuration.appendTo?.refreshAttachments; });
    changed(value => { value.records.find(row => row.id === added.archive.id)!.record.references[0].sourceId = 'unknown-issue'; });
    changed(value => { value.versions = value.versions.filter(row => row.id !== added.version.id); });
    changed((value, context) => {
      value.versions.find(row => row.id === added.version.id)!.sha256 = 'f'.repeat(64);
      context.attachments.find(row => row.id === added.attachment.id)!.sha256 = 'f'.repeat(64);
    });
    f.store.db.prepare('DELETE FROM attachments WHERE id=?').run(added.attachment.id);
    assert.equal(f.service.jiraKnownAttachments(pkg.source.instanceKey, ['702'])[0]?.archiveId, added.archive.id);
    assert.doesNotThrow(() => f.service.validateImport(data(f), f.context()));
  } finally { f.close(); }
});

test('Confluence attachment extensions retain a validated source root and yield to manually added versions', () => {
  const f = fixture(); try {
    const anchor = f.prepared.attachments[0];
    const links = f.prepared.sourceRecords.filter(row => row.record.kind === 'attachment');
    const oldPage = f.prepared.sourceRecords.find(row => row.record.kind === 'revision')!.record;
    oldPage.metadata.currentVersionId = '200';
    oldPage.references = [{ kind: 'page', sourceId: '200', relation: 'current-version' }];
    for (const [index, link] of links.entries()) {
      link.record.containerId = '200';
      link.record.references = [{ kind: 'page', sourceId: '200', relation: 'container-content' }];
      link.record.metadata.attachmentVersion = index === 0 ? '2' : '1';
      if (index > 0) link.record.metadata.currentVersionId = links[0].record.sourceId;
    }
    links[1].record.containerId = oldPage.sourceId;
    links[1].record.references = [{ kind: 'revision', sourceId: oldPage.sourceId, relation: 'container-content' }];
    persist(f);
    const extension = structuredClone(f.prepared);
    const pkg = extension.sourceImport.packages[1], root = structuredClone(links[0]);
    const id = randomUUID(), projectId = f.prepared.documents[0].projectId!;
    extension.sourceImport = { ...extension.sourceImport, id, packages: [pkg], projectIds: [projectId], counts: { attachmentVersions: 1 },
      configuration: { ...extension.sourceImport.configuration, packageIds: [pkg.stagingId], projects: [], appendPagesTo: { projectId, refreshAttachments: true } } };
    root.id = randomUUID();
    root.sourceImportId = id;
    root.targetId = randomUUID();
    root.record.metadata = { attachmentVersion: '3', size: 4, sha256: 'e'.repeat(64) };
    extension.sourceRecords = [root];
    extension.attachmentVersions = [{ ...extension.attachmentVersions[0], id: root.targetId, size: 4, sha256: 'e'.repeat(64),
      sourceImportId: id, sourceRecordId: root.id, sourceRevision: 3, versionLabel: '3' }];
    extension.issueRelations = [];

    const corrupt = structuredClone(extension);
    corrupt.sourceRecords[0].record.id = 'attachment:different-slot';
    corrupt.sourceRecords[0].record.sourceId = 'different-slot';
    assert.throws(() => f.store.transaction(() => f.service.persistPrepared(corrupt)), /원본 연결과 새 버전/);
    const unreviewed = structuredClone(extension);
    delete unreviewed.sourceImport.configuration.appendPagesTo?.refreshAttachments;
    assert.throws(() => f.store.transaction(() => f.service.persistPrepared(unreviewed)), /첨부 버전의 출처/);

    const versions = new AttachmentVersionsService(f.store, f.dir);
    f.store.transaction(() => f.service.persistPrepared(extension));
    f.store.transaction(() => f.service.persistPrepared(extension));
    assert.equal(f.service.attachmentVersions(anchor.id).at(0)?.id, root.targetId);
    assert.equal(versions.head(anchor).currentVersionId, root.targetId);
    assert.deepEqual(f.store.get('attachments', anchor.id), anchor);

    const manual = versions.append(anchor.id, root.targetId, { filename: 'manual.txt', bytes: Buffer.from('manual'), authorId: 'actor' }, () => {});
    assert.equal(versions.head(anchor).currentVersionId, manual.currentVersionId);
    assert.deepEqual(f.service.attachmentVersions(anchor.id).slice(0, 2).map(row => row.id), [manual.currentVersionId, root.targetId]);
    const backup = data(f);
    assert.deepEqual(f.service.validateImport(backup, f.context()), backup);
    const wrongAnchor = structuredClone(backup);
    const old = wrongAnchor.records.find(row => row.id === links[1].id)!;
    old.record.metadata.attachmentVersion = '5';
    for (const receipt of wrongAnchor.imports) delete receipt.integrity;
    assert.throws(() => f.service.validateImport(wrongAnchor, f.context()), /원본 연결과 새 버전/);
  } finally { f.close(); }
});

test('a migrated document can move to another project or common documents and native9 preserves the immutable original receipt', () => {
  const f = fixture(); try {
    persist(f); const original = data(f);
    for (const projectId of ['project-A', null]) {
      const current = f.store.get<DocPage>('documents', 'doc-a')!; f.store.put('documents', { ...current, projectId, version: current.version + 1 });
      const previous = new Map(f.service.allImports().map(value => [value.id, value.version])), parsed = f.service.validateImport(data(f), f.context()); f.store.transaction(() => f.service.replaceImported(parsed, previous));
      assert.equal(f.service.record(f.prepared.sourceImport.id, f.page.id).targetProjectId, 'project-B'); assert.equal(f.store.get<DocPage>('documents', 'doc-a')!.projectId, projectId); assert.equal(f.service.origins({ resourceType: 'document', resourceId: 'doc-a' }).total, 4);
    }
    assert.equal(f.service.allImports()[0].version, 3); assert.deepEqual(f.service.allRecords(), original.records);
  } finally { f.close(); }
});

test('native Confluence source-version markers require one compatible original page and opted-in archive', () => {
  const f = fixture(); try {
    const projectId = f.page.targetProjectId!, documentId = f.page.targetId!;
    const source = f.page.source;
    f.page.record.containerId = 'space-1';
    f.page.record.metadata = { sourceClass: 'Page', version: '1' };
    f.prepared.sourceRecords.push(f.archive('project', 'space-1', { targetType: 'project', targetId: projectId, targetProjectId: projectId }, source));
    persist(f);

    const backup = data(f), pkg = f.prepared.sourceImport.packages[1], receiptId = randomUUID(), revisionId = randomUUID();
    backup.imports.push({ ...structuredClone(f.prepared.sourceImport), id: receiptId, projectIds: [projectId], packages: [pkg],
      configuration: { ...f.prepared.sourceImport.configuration, packageIds: [pkg.stagingId], projects: [], appendPagesTo: { projectId, refreshHistory: true } } });
    const revision = f.archive('revision', '201', {
      sourceImportId: receiptId, targetType: 'revision', targetId: revisionId, targetProjectId: projectId, ownerType: 'document', ownerId: documentId,
    }, source);
    revision.record.metadata = { sourceClass: 'Page', version: '2', currentVersionId: '200' };
    revision.record.references = [{ kind: 'page', sourceId: '200', relation: 'current-version' }];
    backup.records.push(revision);
    const context = f.context();
    context.revisions.push({ ...context.revisions[0], id: revisionId, version: 2, confluenceSourceVersion: 2 });
    assert.deepEqual(f.service.validateImport(backup, context), backup);

    const changedOwner = structuredClone(backup);
    changedOwner.records.at(-1)!.record.metadata.currentVersionId = 'different-page';
    changedOwner.records.at(-1)!.record.references[0].sourceId = 'different-page';
    assert.throws(() => f.service.validateImport(changedOwner, context), /같은 공간 문서/);
    const unreviewed = structuredClone(backup);
    delete unreviewed.imports.at(-1)!.configuration.appendPagesTo!.refreshHistory;
    assert.throws(() => f.service.validateImport(unreviewed, context), /확인된 원본 보관 객체/);
    const unmarked = structuredClone(context);
    delete unmarked.revisions.at(-1)!.confluenceSourceVersion;
    assert.throws(() => f.service.validateImport(backup, unmarked), /보존 원본의 문서·버전/);
    const duplicate = structuredClone(context);
    duplicate.revisions.push({ ...duplicate.revisions.at(-1)!, id: randomUUID() });
    assert.throws(() => f.service.validateImport(backup, duplicate), /원본 버전 번호가 잘못되었거나 중복/);
  } finally { f.close(); }
});

test('native replacement increments receipt versions, rebuilds bindings, refuses UUID mutation and rolls back completely on late failure', () => {
  const f = fixture(); try {
    persist(f); const original = data(f), previous = new Map([[f.prepared.sourceImport.id, 7]]);
    const invalid = structuredClone(original);
    invalid.records[2].record.sourceId = 'changed-original';
    invalid.records[2].record.id = 'issue:changed-original';
    assert.throws(() => f.service.validateImport(invalid, f.context()), isError(400));
    assert.deepEqual(data(f), original);

    const legacyReceipt = structuredClone(original.imports[0]);
    delete legacyReceipt.integrity;
    f.store.put('source_imports', legacyReceipt);
    delete invalid.imports[0].integrity;
    const legacy = f.service.validateImport(invalid, f.context());
    assert.throws(() => f.store.transaction(() => f.service.replaceImported(legacy, previous)), isError(409));
    assert.deepEqual(f.service.allRecords(), original.records);
    f.store.put('source_imports', original.imports[0]);

    assert.throws(() => f.store.transaction(() => { f.service.replaceImported(original, previous); throw new Error('late audit failure'); }), /late audit/); assert.deepEqual(data(f), original);
    f.store.transaction(() => f.service.replaceImported(original, previous)); assert.equal(f.service.allImports()[0].version, 8); assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM source_bindings WHERE kind=?').get('issue') as { n: number }).n, 2);
  } finally { f.close(); }
});

test('canonical attachment/issue deletion cascades file versions and relations while keeping source archives, and ordinary uploads expose a dynamic latest version', () => {
  const f = fixture(); try {
    persist(f); const id = f.prepared.attachments[0].id; assert.equal(f.service.versionsForAttachments([id, id]).length, 2); assert.equal(f.service.attachmentVersions(id).length, 2);
    const ordinary = { ...f.prepared.attachments[0], id: randomUUID(), filename: 'ordinary.txt' }; f.store.put('attachments', ordinary); assert.deepEqual(f.service.attachmentVersions(ordinary.id), [{ ...ordinary, attachmentId: ordinary.id, versionLabel: '현재 파일', sourceImportId: null, sourceRecordId: null }]);
    f.store.remove('attachments', id); f.store.remove('issues', 'issue-b'); assert.equal(f.service.allVersions().length, 0); assert.equal(f.service.allRelations().length, 0); assert.equal(f.service.allRecords().length, f.prepared.sourceRecords.length);
    assert.doesNotThrow(() => f.service.validateImport(data(f), f.context())); assert.throws(() => f.service.attachmentVersions(id), isError(404));
  } finally { f.close(); }
});

test('original author names prefer the same export package when multiple snapshots of the same source user were imported', () => {
  const f = fixture(); try {
    const stagingId = randomUUID(), otherSha = 'e'.repeat(64), pkg = { ...structuredClone(f.prepared.sourceImport.packages[0]), stagingId, sha256: otherSha };
    f.prepared.sourceImport.packages.push(pkg); f.prepared.sourceImport.configuration.packageIds.push(stagingId);
    const other = structuredClone(f.prepared.sourceRecords[0]); other.id = randomUUID(); other.packageSha256 = otherSha; other.record.title = '다른 내보내기의 이름'; f.prepared.sourceRecords.unshift(other);
    persist(f); const row = f.service.records(f.prepared.sourceImport.id, { kind: 'issue' }).records[0]; assert.equal(row.originalAuthorName, '원래 홍길동');
  } finally { f.close(); }
});
