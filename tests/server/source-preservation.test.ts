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
import { AttachmentVersionsService } from '../../server/attachment-versions.js';
import { SourcePreservationError, SourcePreservationService, type SourcePreservationContext } from '../../server/source-preservation.js';

const now = '2026-11-19T00:00:00.000Z', old = '2020-01-02T03:04:05.000Z';
const isError = (status = 400) => (error: unknown) => error instanceof SourcePreservationError && error.status === status;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-source-preservation-')), store = new Store(dir), service = new SourcePreservationService(store);
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
