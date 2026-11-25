import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import fileSystem from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { zip } from '../fixtures/legacy-export-zip.mjs';
import { historicalMigrationBackup } from '../fixtures/historical-migration-backup.js';
import type { IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import type { AtlassianLink, AtlassianLinkTarget } from '../../shared/atlassian-links.js';
import type { MigratedConfluenceDocumentTarget } from '../../shared/confluence-migration-address.js';
import { COLLABORATION_SCHEMA, type CollaborationServerMessage, type CollaborationSession } from '../../shared/collaboration.js';
import { MAX_DOCUMENT_LABEL_LENGTH, MAX_DOCUMENT_LABELS } from '../../shared/document-labels.js';
import { contentReferences, documentContentSchemaVersion } from '../../shared/document-nodes.js';
import { collectDocumentPropertyReport, documentPropertyReports } from '../../shared/document-properties.js';
import { documentSectionHash } from '../../shared/document-sections.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import { suggestSameSourceAccountMappings } from '../../shared/migration-identity-suggestions.js';
import { DEFAULT_WORKSPACE_SEARCH_FILTERS, searchWorkspace } from '../../shared/workspace-search.js';
import type { MigrationContentReviewDetail, MigrationContentReviewPage, ProjectWorkloadResult, SourceReconciliationResourceLinkFindingsPage } from '../../shared/types.js';
import type { ApiKeyCreated, Attachment, AttachmentHead, AttachmentVersion, AutomationRule, AutomationRun, Comment, CommentEditSnapshot, DocPage, DocRevision, GitlabSettings, GitlabSyncPreview, GitlabSyncResult, Issue, IssueCommentView, IssueWorklogPage, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationOptions, MigrationPreview, ProjectIssueSchema, ProjectWorkflow, ReportingLedgerData, RichContent, SourceImport, SourceImportIntegrityPackage, SourceReconciliationAudit, SourceReconciliationFileCheck, SourceReconciliationPage, SourceRecordArchive, SourceRecordPage, WebhookEndpointCreated, WorklogEntry, WorkspaceSnapshot } from '../../shared/types.js';
import { createApp } from '../../server/app.js';
import { AttachmentAppend, type AppendedFile } from '../../server/attachment-append.js';
import { hash } from '../../server/attachments.js';
import { normalizeDocumentContent, readDocumentSelection } from '../../server/document-content.js';
import { convertLegacyContent } from '../../server/migration-content.js';
import { confluencePageFieldDigest } from '../../server/migration-planner.js';
import { measureIncomingArchive } from '../../server/source-archive-integrity.js';

async function fixture(atlassianEnv?: NodeJS.ProcessEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-migration-integration-')), service = createApp({ dataDir: dir, outboundWorker: false, atlassianEnv }), server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}/api`, db = new DatabaseSync(join(dir, 'teamspace.sqlite')); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, actor = 'user-seo') { const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() as T }; }
  async function upload(bytes: Buffer, filename: string, product = 'auto', instanceKey = `synthetic-${randomUUID()}`) { const params = new URLSearchParams({ filename, product, instanceKey }); const response = await fetch(`${base}/legacy-import/packages?${params}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-seo' }, body: new Uint8Array(bytes) }); const data = await response.json() as LegacyPackageSummary; assert.equal(response.status, 201, JSON.stringify(data)); return data; }
  async function configuration(packages: LegacyPackageSummary | LegacyPackageSummary[], key = `MIG${randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()}`) {
    const params = new URLSearchParams((Array.isArray(packages) ? packages : [packages]).map(pkg => ['packageId', pkg.id]));
    const result = await call<MigrationOptions>(`/migrations/options?${params}`); assert.equal(result.status, 200);
    const config = result.data.defaultConfiguration; config.projects = config.projects.map(value => ({ ...value, key, name: 'Synthetic unified migration' })); config.datePolicy = 'import-time'; for (const identity of result.data.identities) config.users[identity.id] = 'user-jun'; return config;
  }
  async function preview(configuration: MigrationConfiguration) { const result = await call<MigrationPreview>('/migrations/preview', 'POST', { configuration }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data; }
  async function apply(plan: MigrationPreview, extra: Record<string, unknown> = {}, actor = 'user-seo') { return call<MigrationApplyResult>(`/migrations/previews/${plan.id}/apply`, 'POST', { expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements, ...extra }, actor); }
  return { dir, base, db, call, upload, configuration, preview, apply, attachCollaboration: () => service.attachWebSocket(server), async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); service.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const csv = Buffer.from('Issue id,Issue key,Project key,Summary,Description,Reporter,Created,Updated,Status,Issue Type,Comment\r\n100,OLD-1,OLD,Synthetic imported issue one,"h2. 원본 설명",original.author,2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task,"2020-01-03T00:00:00Z;original.author;보존한 댓글"\r\n200,OTHER-1,OTHER,Synthetic imported issue two,두번째 설명,original.author,2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task,\r\n');

function jiraGitlabCsv(rows: Array<[sourceId: string, originalKey: string, title: string, status: string]>): Buffer {
  const header = 'Issue id,Issue key,Project key,Summary,Created,Updated,Status,Issue Type';
  const lines = rows.map(([id, key, title, status]) => `${id},${key},${key.split('-')[0]},${title},2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,${status},Task`);
  return Buffer.from([header, ...lines].join('\r\n'));
}

type MigrationFixture = Awaited<ReturnType<typeof fixture>>;

test('reviewed Jira comment corrections preserve local edits and stable imported comment identities through retries and restore', async t => {
  const f = await fixture(), restored = await fixture();
  t.after(() => Promise.all([f.close(), restored.close()]));
  const instance = 'synthetic-jira-comment-corrections';
  const jiraBase = 'https://jira-comments.example.test/jira';
  const issueUrl = `${jiraBase}/browse/JCOMMENTS-17`;
  const oldLink = 'https://docs.example.test/releases/old', newLink = 'https://docs.example.test/releases/new';
  const legacyLink = 'https://docs.example.test/releases/legacy';
  const legacySourceBody = `[이전 렌더링 링크|${legacyLink}]`;
  const first = '2024-01-01T00:00:00.000Z', second = '2024-01-02T00:00:00.000Z', third = '2024-01-03T00:00:00.000Z';
  const author = { name: 'source.author', displayName: '원본 작성자' };
  const comment = (id: string, body: string, updated: string | null = first) => ({ id, body, author, created: first, updated });
  const upload = (name: string, entries: Array<ReturnType<typeof comment> & { visibility?: { type: string; value: string } }>) =>
    f.upload(Buffer.from(JSON.stringify({ issues: [{ id: '1420', key: 'JCOMMENTS-17', fields: {
      project: { id: '420', key: 'JCOMMENTS', name: 'Synthetic Jira comments' }, summary: 'Jira comment revisions',
      status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' }, created: first, updated: third, comment: { comments: entries },
    } }] })), `${name}.json`, 'jira', instance);
  const initial = await upload('initial-comments', [
    comment('301', `[이전 링크|${oldLink}]`), comment('302', '수정 충돌을 볼 댓글'), comment('303', '삭제할 댓글'),
    comment('304', '동일한 댓글'), comment('305', '수정 시각이 없는 댓글'), comment('306', '접근 제한이 바뀔 댓글'),
    comment('307', legacySourceBody),
  ]);
  const initialConfig = await f.configuration(initial, 'COMFIX');
  initialConfig.sourceBaseUrls[initial.id] = jiraBase;
  const initialApply = await f.apply(await f.preview(initialConfig));
  assert.equal(initialApply.status, 201, JSON.stringify(initialApply.data));
  type Backup = WorkspaceSnapshot & { schemaVersion: number; comments: Comment[]; sourceRecords: SourceRecordArchive[] };
  const { data: formerBackup } = await f.call<Backup>('/export');
  const legacyOriginal = formerBackup.sourceRecords.find(row => row.record.kind === 'comment' && row.record.sourceId === '307')!;
  const legacyNative = formerBackup.comments.find(row => row.id === legacyOriginal.targetId)!;
  const oldRendering = convertLegacyContent(legacyOriginal.record, { legacyAnnotations: true, resolveReference: () => null }).plainText;
  assert.equal(oldRendering, '이전 렌더링 링크');
  assert.ok(legacyNative.body.includes(legacyLink));
  legacyNative.body = oldRendering;
  const formerRestore = await f.call('/import', 'POST', { data: { ...formerBackup, schemaVersion: 120 } });
  assert.equal(formerRestore.status, 200, JSON.stringify(formerRestore.data));
  const [projectId] = initialApply.data.import.projectIds;
  const { data: workspace } = await f.call<WorkspaceSnapshot>('/workspace');
  const issue = workspace.issues.find(row => row.projectId === projectId)!;
  const commentsPath = `/comments?resourceType=issue&resourceId=${issue.id}`;
  const comments = async (target = f) => (await target.call<IssueCommentView[]>(commentsPath)).data;
  const original = await comments();
  const firstComment = original.find(row => row.body.includes(oldLink))!;
  const conflicting = original.find(row => row.body === '수정 충돌을 볼 댓글')!;
  const deleted = original.find(row => row.body === '삭제할 댓글')!;
  const confirmed = original.find(row => row.body === '동일한 댓글')!;
  const dateMissing = original.find(row => row.body === '수정 시각이 없는 댓글')!;
  const restricted = original.find(row => row.body === '접근 제한이 바뀔 댓글')!;
  assert.ok(firstComment && conflicting && deleted && confirmed && dateMissing && restricted);
  const resolve = async (sourceId: string, target = f) => {
    const url = `${issueUrl}?focusedCommentId=${sourceId}#comment-${sourceId}`;
    const result = await target.call<{ target: { issueId: string; commentId: string } | null }>(
      `/atlassian-links/resolve-migrated-jira-target?${new URLSearchParams({ url })}`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data.target;
  };
  assert.deepEqual(await resolve('301'), { issueId: issue.id, commentId: firstComment.id });
  assert.equal((await f.call(`/comments/${deleted.id}`, 'DELETE', undefined, deleted.authorId)).status, 200);
  const append = async (pkg: LegacyPackageSummary): Promise<MigrationConfiguration> => {
    const { data: options } = await f.call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`);
    const target = options.appendTarget!;
    assert.equal(target?.projectId, projectId);
    return { ...options.defaultConfiguration, sourceBaseUrls: { [pkg.id]: jiraBase },
      users: Object.fromEntries(options.identities.map(identity => [identity.id, firstComment.authorId])),
      appendTo: { projectId, refreshComments: true,
        statuses: Object.fromEntries(options.statuses.map(option => [option.id, target.statuses.find(status => status.label === option.label)!.id])),
        issueTypes: Object.fromEntries(options.issueTypes.map(option => [option.id, target.issueTypes.find(type => type.name === option.label)!.id])),
        fields: {},
      },
    };
  };
  const delta = await upload('revised-comments', [
    comment('301', `[새 링크|${newLink}]`, second), comment('302', 'Jira 수정 내용', second),
    comment('303', '삭제한 댓글의 새 Jira 내용', second), comment('304', '동일한 댓글', third),
    comment('305', '시각을 확인할 수 없는 Jira 수정', null),
    { ...comment('306', '제한된 Jira 본문', second), visibility: { type: 'role', value: 'Private' } },
    comment('307', legacySourceBody, second),
    comment('310', '추가 옵션을 끈 상태에서 보관할 새 원본', second),
  ]);
  const config = await append(delta);
  const stale = await f.preview(config);
  assert.equal(stale.canApply, true, JSON.stringify(stale.notices));
  const oldEdit = await f.call<CommentEditSnapshot>(`/comments/${firstComment.id}/edit`, 'GET', undefined, firstComment.authorId);
  const edit = async (id: string, editToken: string, body: string) =>
    f.call<CommentEditSnapshot>(`/comments/${id}`, 'PATCH', { editToken, body, requestId: randomUUID() }, firstComment.authorId);
  const conflictEdit = await f.call<CommentEditSnapshot>(`/comments/${conflicting.id}/edit`, 'GET', undefined, conflicting.authorId);
  const local = await edit(conflicting.id, conflictEdit.data.editToken, '팀에서 고친 댓글');
  assert.equal(local.status, 200, JSON.stringify(local.data));
  assert.equal((await f.apply(stale)).status, 409);
  const plan = await f.preview(config);
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  const decisions = new Map(plan.jiraCommentReview?.map(row => [row.sourceId, row]));
  for (const [id, decision] of [['301', 'apply'], ['302', 'local-conflict'], ['303', 'archive-only'], ['304', 'confirm'], ['305', 'archive-only']]) {
    assert.equal(decisions.get(id)?.decision, decision);
  }
  assert.deepEqual([decisions.get('307')?.decision, decisions.get('307')?.before, decisions.get('307')?.after],
    ['apply', oldRendering, `이전 렌더링 링크 <${legacyLink}>`]);
  assert.ok(plan.requiredAcknowledgements.includes('JIRA_COMMENT_CORRECTIONS'));
  assert.ok(!plan.jiraCommentReview?.some(row => row.before?.includes('제한된 Jira 본문') || row.after?.includes('제한된 Jira 본문')));
  assert.equal((await f.apply(plan, { acknowledgements: [] })).status, 400);
  const immediatelyBefore = await comments();
  f.db.exec(`CREATE TRIGGER fail_jira_comment_revision_receipt BEFORE INSERT ON source_imports
    BEGIN SELECT RAISE(ABORT, 'synthetic Jira comment revision receipt failure'); END;`);
  try { assert.equal((await f.apply(plan)).status, 500); }
  finally { f.db.exec('DROP TRIGGER fail_jira_comment_revision_receipt'); }
  assert.deepEqual(await comments(), immediatelyBefore);
  const applied = await f.apply(plan);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.equal((await f.apply(plan)).data.duplicate, true);
  assert.equal((await edit(firstComment.id, oldEdit.data.editToken, '검토 전에 열린 편집기')).status, 409);
  const current = await comments();
  const updated = current.find(row => row.id === firstComment.id)!;
  assert.equal(updated.authorId, firstComment.authorId);
  assert.equal(updated.createdAt, firstComment.createdAt);
  assert.equal(updated.editVersion, 1);
  assert.ok(updated.jiraCorrectionRecordId && updated.editedAt && updated.body.includes(newLink));
  assert.equal(updated.jiraOriginalLinksAvailable, true);
  assert.equal(current.find(row => row.id === confirmed.id)?.editVersion, undefined);
  assert.equal(current.find(row => row.id === confirmed.id)?.body, confirmed.body);
  assert.equal(current.find(row => row.id === conflicting.id)?.body, '팀에서 고친 댓글');
  assert.equal(current.find(row => row.id === dateMissing.id)?.body, dateMissing.body);
  assert.equal(current.find(row => row.id === restricted.id)?.body, restricted.body);
  assert.equal(current.find(row => row.id === legacyNative.id)?.body, `이전 렌더링 링크 <${legacyLink}>`);
  assert.ok(!current.some(row => row.id === deleted.id || row.body.includes('추가 옵션을 끈')));
  assert.deepEqual(await resolve('301'), { issueId: issue.id, commentId: firstComment.id });
  assert.equal(await resolve('303'), null);
  const latestLinks = (await f.call(`/comments/${firstComment.id}/jira-original-links`)).data;
  assert.deepEqual(latestLinks, { links: [{ label: '새 링크', href: newLink }], limited: false });
  const older = await upload('older-than-confirmed', [comment('304', '중간 날짜의 다른 댓글', second)]);
  const olderPlan = await f.preview(await append(older));
  assert.equal(olderPlan.jiraCommentReview?.[0].decision, 'archive-only');
  assert.equal(olderPlan.canApply, false);

  const { data: backup } = await f.call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const head = backup.sourceRecords.find(row => row.id === updated.jiraCorrectionRecordId)!;
  assert.equal(head.targetType, null);
  assert.equal(head.ownerId, issue.id);
  assert.equal(backup.sourceRecords.filter(row => row.targetType === 'comment' && row.targetId === firstComment.id).length, 1);
  const downgraded = await restored.call('/import', 'POST', { data: { ...backup, schemaVersion: 120 } });
  assert.equal(downgraded.status, 400);
  const incorrect = structuredClone(backup);
  incorrect.comments.find(row => row.id === firstComment.id)!.jiraCorrectionRecordId = head.jiraCommentCorrection!.originalRecordId;
  assert.equal((await restored.call('/import', 'POST', { data: incorrect })).status, 400);
  const copy = await restored.call('/import', 'POST', { data: backup });
  assert.equal(copy.status, 200, JSON.stringify(copy.data));
  assert.deepEqual(await comments(restored), current);
  assert.deepEqual(await resolve('301', restored), { issueId: issue.id, commentId: firstComment.id });
  assert.deepEqual((await restored.call(`/comments/${firstComment.id}/jira-original-links`)).data, latestLinks);
  const remove = () => restored.call<{ trashItemId: string }>(`/comments/${firstComment.id}`, 'DELETE', undefined, firstComment.authorId);
  const trash = await remove();
  assert.equal(trash.status, 200);
  assert.equal(await resolve('301', restored), null);
  const archivedBackup = (await restored.call<Backup>('/export')).data;
  const archivedRestore = await restored.call('/import', 'POST', { data: archivedBackup });
  assert.equal(archivedRestore.status, 200, JSON.stringify(archivedRestore.data));
  assert.equal(await resolve('301', restored), null);
  assert.equal((await restored.call(`/trash/items/${trash.data.trashItemId}/restore`, 'POST', undefined, firstComment.authorId)).status, 200);
  assert.deepEqual(await resolve('301', restored), { issueId: issue.id, commentId: firstComment.id });
  const trashedAgain = await remove();
  assert.equal(trashedAgain.status, 200);
  assert.equal((await restored.call(`/trash/items/${trashedAgain.data.trashItemId}`, 'DELETE', undefined, firstComment.authorId)).status, 200);
  const afterDeletion = (await restored.call<Backup>('/export')).data;
  assert.ok(afterDeletion.sourceRecords.some(row => row.id === head.id));
  const deletedRestore = await restored.call('/import', 'POST', { data: afterDeletion });
  assert.equal(deletedRestore.status, 200, JSON.stringify(deletedRestore.data));
  assert.equal(await resolve('301', restored), null);
});

test('migrated Confluence description destinations resolve unique source sections across separate imports and restore', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const origin = 'https://migration-wiki.example.test/confluence';
  const pageUrl = `${origin}/pages/viewpage.action?pageId=501`;
  const href = `${pageUrl}#ReleasePlan-SecondaryAnchor`;
  const section = (name: string) => `<ac:structured-macro ac:name="anchor"><ac:parameter>${name}</ac:parameter></ac:structured-macro>`;
  const wikiBody = `${section('FirstAnchor')}${section('SecondaryAnchor')}<h2>Release readiness</h2>
    <p>Synthetic release note</p><h3>Repeated heading</h3><h3>Repeated heading</h3>`;
  const wikiPack = (instance: string, title: string, { extra = '', space = 'TEAM' } = {}) => f.upload(zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    <object class="Space"><id name="id">60</id><property name="key">${space}</property><property name="name">Synthetic wiki</property></object>
    <object class="Page"><id name="id">501</id><property name="title">${title}</property>
      <property name="version">1</property><property name="space" class="Space"><id name="id">60</id></property></object>
    <object class="BodyContent"><id name="id">601</id><property name="bodyType">2</property>
      <property name="body"><![CDATA[${wikiBody}]]></property>
      <property name="content" class="Page"><id name="id">501</id></property></object>
    ${extra}
  </hibernate-generic>`) }]), 'sequential-confluence.zip', 'confluence', instance);
  const resolvePath = (url: string) => `/atlassian-links/resolve-migrated-document?${new URLSearchParams({ url })}`;
  const resolve = async (url: string) => {
    const { status, data } = await f.call<{ target: MigratedConfluenceDocumentTarget | null }>(resolvePath(url));
    assert.equal(status, 200, JSON.stringify(data));
    return data.target;
  };
  const loadWorkspace = () => f.call<WorkspaceSnapshot>('/workspace').then(result => result.data);

  const manualDocument = await f.call<DocPage>('/documents', 'POST', { title: 'Manually associated document',
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Manual content' }] }] } });
  assert.equal(manualDocument.status, 201);
  const manual = await f.call('/atlassian-links', 'POST', { targetType: 'document', targetId: manualDocument.data.id,
    product: 'confluence', url: pageUrl });
  assert.equal(manual.status, 201);
  assert.equal(await resolve(pageUrl), null);
  assert.equal((await loadWorkspace()).confluenceMigrationOrigins, undefined);

  const jira = await f.upload(Buffer.from(JSON.stringify({ id: '710', key: 'JDOC-1', fields: {
    project: { id: '61', key: 'JDOC', name: 'Synthetic Jira' }, summary: 'Jira release check',
    status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
    created: '2020-01-01T00:00:00Z', updated: '2020-01-01T00:00:00Z',
    description: { type: 'doc', version: 1, content: [{ type: 'paragraph',
      content: [{ type: 'text', text: 'Release protocol', marks: [{ type: 'link', attrs: { href } }] }] }] },
  } })), 'sequential-jira.json', 'jira', 'sequential-jira-first');
  const jiraImport = await f.apply(await f.preview(await f.configuration(jira, 'JIRAFIRST')));
  assert.equal(jiraImport.status, 201, JSON.stringify(jiraImport.data));
  const issue = (await loadWorkspace()).issues.find(value => value.title === 'Jira release check')!;
  assert.ok(issue.description.includes(href));
  assert.equal(await resolve(href), null);

  const wiki = await wikiPack('sequential-wiki', 'Release Plan');
  const configuration = await f.configuration(wiki, 'WIKILATER');
  configuration.sourceBaseUrls[wiki.id] = origin;
  assert.equal((await f.apply(await f.preview(configuration))).status, 201);
  const snapshot = await loadWorkspace();
  const doc = snapshot.documents.find(value => value.title === 'Release Plan')!;
  const heading = doc.content.content?.find(value => value.type === 'heading');
  const sectionId = heading?.attrs?.sectionId;
  assert.equal(typeof sectionId, 'string');
  const exact = { documentId: doc.id, sectionId };
  assert.deepEqual(snapshot.confluenceMigrationOrigins, [origin]);
  assert.deepEqual(await resolve(pageUrl), { documentId: doc.id });
  assert.deepEqual(await resolve(href), exact);
  assert.deepEqual(await resolve(`${origin}/display/TEAM/Release+Plan#SecondaryAnchor`), exact);
  assert.equal(await resolve(`${pageUrl}#Repeatedheading`), null);
  assert.equal(await resolve(`${pageUrl.replace('/confluence/', '/other/')}#SecondaryAnchor`), null);
  assert.equal(await resolve(`${pageUrl}#missing`), null);
  for (const bad of [`${pageUrl}&pageId=502`, `${pageUrl}&focusedCommentId=4`, `${pageUrl}&pageVersion=2`,
    `${pageUrl}#comment-4`, `${origin}/pages/../pages/501`, '/pages/501', `${origin}/browse/JDOC-1`]) {
    assert.equal((await f.call(resolvePath(bad))).status, 400, bad);
  }
  const response = await fetch(`${f.base}${resolvePath(href)}`);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  await response.arrayBuffer();

  const movePath = `/documents/${doc.id}`;
  const move = await f.call<{ token: string; projectId: string; parentId: string | null }>(`${movePath}/move-preview`, 'POST',
    { projectId: issue.projectId, parentId: null });
  assert.equal(move.status, 200, JSON.stringify(move.data));
  const { token, projectId, parentId } = move.data;
  assert.equal((await f.call(`${movePath}/move`, 'POST', { token, projectId, parentId })).status, 200);
  assert.deepEqual(await resolve(href), exact);
  assert.deepEqual((await loadWorkspace()).issues.find(value => value.id === issue.id), issue);

  const native = await f.call<WorkspaceSnapshot>('/export');
  assert.equal(native.data.confluenceMigrationOrigins, undefined);
  const restore = await f.call('/import', 'POST', { data: native.data });
  assert.equal(restore.status, 200, JSON.stringify(restore.data));
  assert.deepEqual((await loadWorkspace()).confluenceMigrationOrigins, [origin]);
  assert.deepEqual(await resolve(href), exact);

  const moved = (await loadWorkspace()).documents.find(value => value.id === doc.id)!;
  const edited = await f.call<DocPage>(movePath, 'PATCH', { expectedVersion: moved.version,
    contentSchemaVersion: documentContentSchemaVersion(moved.content),
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Local page edit removed the heading' }] }] },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(await resolve(href), null);
  assert.deepEqual(await resolve(pageUrl), { documentId: doc.id });

  const restricted = await wikiPack('sequential-restricted-wiki', 'Unbound restricted page at the same ID', { space: 'PRIVATE', extra: `
    <object class="Page"><id name="id">502</id><property name="title">Public sibling</property><property name="version">1</property>
      <property name="space" class="Space"><id name="id">60</id></property></object>
    <object class="ContentPermissionSet"><id name="id">80</id>
      <property name="owningContent" class="Page"><id name="id">501</id></property></object>` });
  const restrictedConfig = await f.configuration(restricted, 'WIKIRESTRICT');
  restrictedConfig.sourceBaseUrls[restricted.id] = origin;
  restrictedConfig.excludedRecords.push(`${restricted.id}/page:501`);
  const restrictedApply = await f.apply(await f.preview(restrictedConfig));
  assert.equal(restrictedApply.status, 201, JSON.stringify(restrictedApply.data));
  assert.equal(await resolve(pageUrl), null);
  assert.deepEqual(await resolve(`${origin}/display/TEAM/Release+Plan`), { documentId: doc.id });

  const ambiguous = await wikiPack('sequential-other-wiki', 'Second page at the same ID');
  const ambiguousConfig = await f.configuration(ambiguous, 'WIKIOTHER');
  ambiguousConfig.sourceBaseUrls[ambiguous.id] = origin;
  assert.equal((await f.apply(await f.preview(ambiguousConfig))).status, 201);
  assert.deepEqual((await loadWorkspace()).confluenceMigrationOrigins, [origin]);
  assert.equal(await resolve(pageUrl), null);
  assert.equal(await resolve(`${origin}/display/TEAM/Release+Plan`), null);
});

test('migration content review pages through the exact plan and keeps excluded and restricted content out', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const jira = await f.upload(jiraGitlabCsv(Array.from({ length: 12 }, (_, index) =>
    [String(index + 1), `OLD-${index + 1}`, `Synthetic ticket ${index + 1}`, 'Open'])), 'inspection-jira.csv', 'jira');
  const page = (id: number, title: string, body: string) => `<object class="Page"><id name="id">${id}</id>
    <property name="title">${title}</property><property name="version">1</property>
    <property name="space" class="Space"><id name="id">60</id></property></object>
    <object class="BodyContent"><id name="id">${id + 1000}</id><property name="body"><![CDATA[${body}]]></property>
    <property name="bodyType">2</property><property name="content" class="Page"><id name="id">${id}</id></property></object>`;
  const wiki = await f.upload(zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    <object class="Space"><id name="id">60</id><property name="key">WIKI</property><property name="name">Synthetic wiki</property></object>
    ${page(501, 'Synthetic CAFÉ', '<table><tbody><tr><th>Key</th><th>Value</th></tr><tr><td>Alpha</td><td>42</td></tr></tbody></table>')}
    ${page(502, 'Secret title', '<p>Secret body</p>')}
    <object class="ContentPermissionSet"><id name="id">75</id><property name="content" class="Page"><id name="id">502</id></property></object>
  </hibernate-generic>`) }]), 'inspection-wiki.zip', 'confluence');
  const config = await f.configuration([jira, wiki], 'INSPECT');
  config.sourceBaseUrls[wiki.id] = 'https://wiki.example.test/confluence';
  const previewPath = (preview: MigrationPreview) => `/migrations/previews/${preview.id}/content`;
  const detailPath = (preview: MigrationPreview, recordId: string) =>
    `${previewPath(preview)}/detail?${new URLSearchParams({ expectedVersion: String(preview.version), recordId })}`;
  const privateRecord = `${wiki.id}/page:502`;
  const blocked = await f.preview(config);
  assert.equal(blocked.canApply, false);
  assert.equal((await f.call<MigrationContentReviewPage>(`${previewPath(blocked)}?expectedVersion=1`)).data.total, 0);
  assert.equal((await f.call(detailPath(blocked, privateRecord))).status, 404);

  config.excludedRecords.push(privateRecord);
  const preview = await f.preview(config);
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  assert.equal(preview.samples.filter(item => item.targetType === 'document').length, 0);
  const path = previewPath(preview);
  const response = await fetch(`${f.base}${path}?expectedVersion=1&limit=12`, { headers: { 'X-Actor-Id': 'user-seo' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const first = await response.json() as MigrationContentReviewPage;
  assert.deepEqual([first.previewId, first.version, first.total, first.offset, first.limit], [preview.id, 1, 13, 0, 12]);
  assert.deepEqual(first.rows.map(item => item.recordId), Array.from({ length: 12 }, (_, index) => `${jira.id}/issue:${index + 1}`));
  const ticket = (await f.call<MigrationContentReviewDetail>(detailPath(preview, first.rows[0].recordId))).data;
  assert.equal(ticket.sourceKey, 'OLD-1');
  assert.equal(ticket.description, '');
  assert.equal(ticket.descriptionFormat, 'plain');
  const next = (await f.call<MigrationContentReviewPage>(`${path}?expectedVersion=1&offset=12&limit=12`)).data;
  const [wikiRow] = next.rows;
  assert.deepEqual(wikiRow, { recordId: `${wiki.id}/page:501`, packageId: wiki.id, sourceId: '501',
    targetType: 'document', title: 'Synthetic CAFÉ', change: 'new' });
  const query = new URLSearchParams({ expectedVersion: '1', packageId: wiki.id, q: 'café' });
  assert.deepEqual((await f.call<MigrationContentReviewPage>(`${path}?${query}`)).data.rows, [wikiRow]);
  assert.deepEqual((await f.call<MigrationContentReviewPage>(`${path}?expectedVersion=1&q=old-12`)).data.rows, [first.rows[11]]);
  const detail = await f.call<MigrationContentReviewDetail>(detailPath(preview, wikiRow.recordId));
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.sourceUrl, 'https://wiki.example.test/confluence/pages/viewpage.action?pageId=501');
  assert.equal(detail.data.content?.content?.[0].type, 'table');
  assert.equal(detail.data.description, undefined);
  assert.equal((await f.call(detailPath(preview, privateRecord))).status, 404);
  assert.equal((await f.call(detailPath(preview, `${jira.id}/page:501`))).status, 404);
  assert.equal((await f.call(detailPath(preview, `${randomUUID()}/page:501`))).status, 404);
  assert.equal((await f.call(`${path}?expectedVersion=1&packageId=${randomUUID()}`)).status, 404);
  assert.equal((await f.call(`${path}?expectedVersion=1&limit=51`)).status, 400);
  assert.equal((await f.call(`${path}?expectedVersion=2`)).status, 409);
  assert.equal((await f.call(detailPath(preview, wikiRow.recordId), 'GET', undefined, 'user-min')).status, 403);
  const previewHeader = f.db.prepare('SELECT json FROM migration_preview_content_header WHERE preview_id=?').get(preview.id) as { json: string };
  const changeHeader = f.db.prepare('UPDATE migration_preview_content_header SET json=? WHERE preview_id=?');
  changeHeader.run(JSON.stringify({ ...JSON.parse(previewHeader.json), conversionVersion: -1 }), preview.id);
  assert.equal((await f.call(`${path}?expectedVersion=1`)).status, 409);
  changeHeader.run(JSON.stringify({ ...JSON.parse(previewHeader.json), confluenceRestrictionHash: 'changed' }), preview.id);
  assert.equal((await f.call(detailPath(preview, wikiRow.recordId))).status, 409);
  changeHeader.run(previewHeader.json, preview.id);
  const previewRow = f.db.prepare('SELECT expires_at, generation FROM migration_previews WHERE id=?').get(preview.id) as { expires_at: string; generation: string };
  const changeRow = f.db.prepare('UPDATE migration_previews SET expires_at=?, generation=? WHERE id=?');
  changeRow.run(previewRow.expires_at, 'restored', preview.id);
  assert.equal((await f.call(`${path}?expectedVersion=1`)).status, 409);
  changeRow.run('2000-01-01T00:00:00.000Z', previewRow.generation, preview.id);
  assert.equal((await f.call(`${path}?expectedVersion=1`)).status, 408);
  changeRow.run(previewRow.expires_at, previewRow.generation, preview.id);
  const applied = await f.apply(preview);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const workspace = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const document = workspace.documents.find(item => item.title === wikiRow.title);
  assert.deepEqual(document?.content, detail.data.content);
  assert.equal(workspace.documents.some(item => item.title === 'Secret title'), false);
  assert.equal((await f.call(detailPath(preview, wikiRow.recordId))).status, 408);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM migration_preview_content WHERE preview_id=?').get(preview.id) as { count: number }).count, 0);
});

test('migration content review exposes accepted Jira and Confluence body changes and skips local conflicts or retained content', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const jiraPack = (day: number, descriptions: (string | null)[]) => f.upload(Buffer.from(JSON.stringify({
    issues: descriptions.map((description, index) => ({ id: String(index + 100), key: `SRC-${index + 1}`, fields: {
      project: { id: '60', key: 'SRC', name: 'Body source' }, summary: `Synthetic issue ${index + 1}`,
      status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
      created: '2020-01-01T00:00:00Z', updated: `2020-01-0${day}T00:00:00Z`, description,
    } })),
  })), `jira-body-${day}.json`, 'jira', 'synthetic-jira-body-review');
  const wikiPack = (version: number, bodies: string[]) => f.upload(zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    <object class="Space"><id name="id">70</id><property name="key">BODY</property><property name="name">Synthetic source wiki</property></object>
    ${bodies.map((body, index) => `<object class="Page"><id name="id">${index + 301}</id>
      <property name="title">Synthetic page ${index + 1}</property><property name="version">${version}</property>
      <property name="creationDate">2020-01-01T00:00:00Z</property><property name="lastModificationDate">2020-01-0${version + 1}T00:00:00Z</property>
      <property name="space" class="Space"><id name="id">70</id></property></object>
      <object class="BodyContent"><id name="id">${index + 401}</id><property name="body"><![CDATA[${body}]]></property>
      <property name="bodyType">2</property><property name="content" class="Page"><id name="id">${index + 301}</id></property></object>`).join('')}
  </hibernate-generic>`) }]), `wiki-body-${version}.zip`, 'confluence', 'synthetic-wiki-body-review');
  const contentPath = (preview: MigrationPreview, recordId?: string) => `/migrations/previews/${preview.id}/content${recordId ? '/detail' : ''}?${new URLSearchParams({
    expectedVersion: String(preview.version), ...(recordId ? { recordId } : {}),
  })}`;
  const initialJira = await jiraPack(2, ['Source one', 'Source two', 'Unchanged']);
  const initialWiki = await wikiPack(1, ['<p>Source one</p>', '<p>Source two</p>', '<p>Unchanged</p>']);
  const initial = await f.apply(await f.preview(await f.configuration([initialJira, initialWiki], 'BODYREVIEW')));
  assert.equal(initial.status, 201, JSON.stringify(initial.data));
  const [projectId] = initial.data.import.projectIds;
  const snapshot = () => f.call<WorkspaceSnapshot>('/workspace').then(result => result.data);
  const workspace = await snapshot();
  const issues = workspace.issues.filter(row => row.projectId === projectId);
  const pages = workspace.documents.filter(row => row.projectId === projectId);
  const localIssue = issues.find(row => row.title === 'Synthetic issue 2')!;
  const localPage = pages.find(row => row.title === 'Synthetic page 2')!;
  assert.equal((await f.call(`/issues/${localIssue.id}`, 'PATCH', {
    expectedVersion: localIssue.version, description: 'Team issue edit',
  })).status, 200);
  assert.equal((await f.call(`/documents/${localPage.id}`, 'PATCH', {
    expectedVersion: localPage.version, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Team page edit' }] }] },
  })).status, 200);

  const deltaJira = await jiraPack(3, [null, 'Incoming issue conflict', 'Unchanged']);
  const { data: jiraOptions } = await f.call<MigrationOptions>(`/migrations/options?packageId=${deltaJira.id}`);
  const target = jiraOptions.appendTarget;
  assert.ok(target);
  const jiraPreview = await f.preview({ ...await f.configuration(deltaJira), appendTo: {
    projectId, refreshExisting: true, fields: {},
    statuses: Object.fromEntries(jiraOptions.statuses.map(row => [row.id, target.statuses.find(status => status.label === row.label)!.id])),
    issueTypes: Object.fromEntries(jiraOptions.issueTypes.map(row => [row.id, target.issueTypes.find(type => type.name === row.label)!.id])),
  } });
  assert.equal(jiraPreview.canApply, true, JSON.stringify(jiraPreview.notices));
  const jiraRecord = `${deltaJira.id}/issue:100`;
  const { data: jiraList } = await f.call<MigrationContentReviewPage>(contentPath(jiraPreview));
  assert.deepEqual(jiraList.rows.map(row => [row.recordId, row.change]), [[jiraRecord, 'update']]);
  const { data: jiraDetail } = await f.call<MigrationContentReviewDetail>(contentPath(jiraPreview, jiraRecord));
  assert.equal(jiraDetail.description, '');
  assert.equal(jiraDetail.descriptionFormat, 'plain');
  for (const id of [101, 102]) assert.equal((await f.call(contentPath(jiraPreview, `${deltaJira.id}/issue:${id}`))).status, 404);
  assert.equal((await f.apply(jiraPreview)).status, 201);
  assert.equal((await snapshot()).issues.find(row => row.id === issues.find(item => item.title === 'Synthetic issue 1')?.id)?.description, jiraDetail.description);

  const deltaWiki = await wikiPack(2, ['<p>New <strong>body</strong></p>', '<p>Incoming page conflict</p>', '<p>Unchanged</p>']);
  const wikiPreview = await f.preview({ ...await f.configuration(deltaWiki), appendPagesTo: { projectId, refreshExisting: true } });
  assert.equal(wikiPreview.canApply, true, JSON.stringify(wikiPreview.notices));
  const wikiRecord = `${deltaWiki.id}/page:301`;
  const { data: wikiList } = await f.call<MigrationContentReviewPage>(contentPath(wikiPreview));
  assert.deepEqual(wikiList.rows.map(row => [row.recordId, row.change]), [[wikiRecord, 'update']]);
  const { data: wikiDetail } = await f.call<MigrationContentReviewDetail>(contentPath(wikiPreview, wikiRecord));
  assert.equal(wikiDetail.content?.content?.[0].content?.[1].marks?.[0].type, 'bold');
  for (const id of [302, 303]) assert.equal((await f.call(contentPath(wikiPreview, `${deltaWiki.id}/page:${id}`))).status, 404);
  assert.equal((await f.apply(wikiPreview)).status, 201);
  assert.deepEqual((await snapshot()).documents.find(row => row.id === pages.find(item => item.title === 'Synthetic page 1')?.id)?.content, wikiDetail.content);
});

test('Confluence user keys support reviewed author mapping across exported files', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const instance = 'synthetic-confluence-account-mapping';
  const userKey = 'source-wiki-user';
  const pack = (pageId: number, title: string, author: string) => zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    <object class="Space"><id name="id">60</id><property name="key">WIKI</property><property name="name">Synthetic knowledge</property></object>
    <object class="ConfluenceUserImpl" package="com.atlassian.confluence.user"><id name="key">${userKey}</id>
      <property name="displayName">${author}</property></object>
    <object class="Page"><id name="id">${pageId}</id><property name="title">${title}</property><property name="version">1</property>
      <property name="space" class="Space"><id name="id">60</id></property>
      <property name="creator" class="ConfluenceUserImpl"><id name="key">${userKey}</id></property>
      <property name="creationDate">2020-01-01T00:00:00Z</property><property name="lastModificationDate">2020-01-02T00:00:00Z</property></object>
    <object class="BodyContent"><id name="id">${1000 + pageId}</id><property name="body"><![CDATA[<p>테스트 본문</p>]]></property>
      <property name="bodyType">2</property><property name="content" class="Page"><id name="id">${pageId}</id></property></object>
  </hibernate-generic>`) }]);
  const first = await f.upload(pack(61, '첫 원본 문서', '이전 사용자 이름'), 'wiki-export-one.zip', 'confluence', instance);
  const second = await f.upload(pack(62, '두 번째 원본 문서', '변경된 사용자 이름'), 'wiki-export-two.zip', 'confluence', instance);
  const { data: options, status } = await f.call<MigrationOptions>(`/migrations/options?packageId=${first.id}&packageId=${second.id}`);
  assert.equal(status, 200);
  assert.equal(options.identities.length, 2);
  assert.ok(options.identities.every(identity => identity.email === null));
  assert.deepEqual(options.identities.map(identity => identity.accountEvidence), [
    { kind: 'confluence-user-key', key: userKey }, { kind: 'confluence-user-key', key: userKey },
  ]);
  const [assigned, pending] = options.identities;
  const config = options.defaultConfiguration;
  config.users[assigned.id] = 'user-jun';
  const { data: roster } = await f.call<WorkspaceSnapshot['users']>('/migrations/identity-roster');
  const suggestions = suggestSameSourceAccountMappings(options, roster, config.users);
  assert.deepEqual(suggestions, [{ identityId: pending.id, userId: 'user-jun', fromIdentityId: assigned.id }]);
  for (const { identityId, userId } of suggestions) config.users[identityId] = userId;
  const applied = await f.apply(await f.preview(config));
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const { data: workspace } = await f.call<WorkspaceSnapshot>('/workspace');
  assert.equal(workspace.documents.find(page => page.title === '첫 원본 문서')?.authorId, 'user-jun');
  assert.equal(workspace.documents.find(page => page.title === '두 번째 원본 문서')?.authorId, 'user-jun');
});

test('previous Jira packages can be reanalyzed in place without publishing Service Management internal comments or their named attachments', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const filename = 'synthetic-jira-service-desk.zip';
  const instanceKey = 'synthetic-jira-service-desk';
  const date = '2024-01-01T00:00:00Z';
  const archive = Buffer.from(`<entity-engine-xml>
    <Project id="10" pkey="OLD" name="Synthetic service desk"/>
    <Status id="1" pname="Open"/><IssueType id="3" pname="Task"/>
    <Issue id="100" project="10" number="1" summary="Synthetic support request" status="1" issuetype="3" created="${date}"/>
    <Issue id="101" project="10" number="2" summary="Synthetic unrelated request" status="1" issuetype="3" created="${date}"/>
    <Action id="200" issue="100" type="comment" author="source.author" created="${date}" body="Internal synthetic note !proof.png|thumbnail! [^secret.txt]"/>
    <Action id="201" issue="100" type="comment" author="source.author" created="${date}" body="Public synthetic note"/>
    <Action id="202" issue="100" type="comment" author="source.author" created="${date}" body="Malformed private synthetic note"/>
    <FileAttachment id="300" issue="100" filename="proof.png" filesize="5" mimetype="image/png" created="${date}" author="source.author"/>
    <FileAttachment id="301" issue="100" filename="secret.txt" filesize="5" mimetype="text/plain" created="${date}" author="source.author"/>
    <FileAttachment id="302" issue="101" filename="proof.png" filesize="5" mimetype="image/png" created="${date}" author="source.author"/>
    <EntityProperty id="401" entityName="sd.comment.property" entityId="200" propertyKey="sd.allow.public.comment" value="{&quot;allow&quot;:false}"/>
    <EntityProperty id="402" entityName="sd.comment.property" entityId="201" propertyKey="sd.public.comment"><value><![CDATA[{"internal":"false"}]]></value></EntityProperty>
    <EntityProperty id="403" entityName="sd.comment.property" entityId="202" propertyKey="sd.public.comment" value="unknown"/>
  </entity-engine-xml>`);
  const bytes = zip([{ path: 'entities.xml', bytes: archive }, ...[300, 301, 302].map(id => ({
    path: `attachments/OLD/OLD-${id === 302 ? 2 : 1}/${id}`, bytes: Buffer.from('bytes'),
  }))]);
  const packageSummary = await f.upload(bytes, filename, 'jira', instanceKey);
  const config = await f.configuration(packageSummary, 'SERVICEDESK');
  f.db.prepare(`UPDATE legacy_file_manifests SET json=json_set(json_remove(json,'$.sourceEvidenceChecked'),'$.unsupported',json(?))
    WHERE package_id=?`).run(JSON.stringify([{ type: 'EntityProperty', count: 3 }]), packageSummary.id);
  f.db.prepare(`UPDATE legacy_records SET json=json_remove(json,'$.metadata.jiraServiceDeskCommentProperties','$.metadata.restricted')
    WHERE package_id=?`).run(packageSummary.id);
  const stale = await f.preview(config);
  assert.ok(stale.notices.some(notice => notice.code === 'SOURCE_JIRA_SOURCE_EVIDENCE_REANALYSIS_REQUIRED' && notice.severity === 'error'));
  assert.equal(stale.canApply, false);
  assert.equal((await f.apply(stale)).status, 409);

  const params = new URLSearchParams({ filename, product: 'jira', instanceKey });
  const reupload = () => fetch(`${f.base}/legacy-import/packages?${params}`, { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-seo' }, body: new Uint8Array(bytes) });
  const renewed = await reupload();
  assert.equal(renewed.status, 200);
  const refreshed = await renewed.json() as LegacyPackageSummary;
  assert.deepEqual([refreshed.id, refreshed.sha256, refreshed.version], [packageSummary.id, packageSummary.sha256, packageSummary.version + 1]);
  const duplicate = await reupload();
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), refreshed);

  const blocked = await f.preview(config);
  const restricted = ['comment:200', 'comment:202', 'attachment:300', 'attachment:301'].map(value => `${packageSummary.id}/${value}`);
  assert.equal(blocked.canApply, false);
  assert.deepEqual(new Set(blocked.notices.filter(notice => notice.code === 'RESTRICTED_CONTENT').map(notice => notice.recordId)), new Set(restricted));
  assert.equal((await f.apply(blocked)).status, 409);
  const reviewedConfig = { ...config, excludedRecords: restricted };
  const preview = await f.preview(reviewedConfig);
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));

  // The previous analysis could recognize a comment property without preserving its exact owner reference.
  f.db.prepare(`UPDATE legacy_file_manifests SET json=json_remove(json,'$.jiraServiceDeskOwnerEvidenceChecked')
    WHERE package_id=?`).run(packageSummary.id);
  const oldNotice = {
    id: randomUUID(), severity: 'warning', code: 'JIRA_SERVICE_DESK_COMMENT_PROPERTY_UNVERIFIED',
    message: 'Synthetic older comment property diagnostic', recordId: null, path: 'entities.xml',
  };
  f.db.prepare('INSERT INTO legacy_diagnostics(package_id,id,severity,json) VALUES(?,?,?,?)')
    .run(packageSummary.id, oldNotice.id, oldNotice.severity, JSON.stringify(oldNotice));
  const outdated = await f.preview(reviewedConfig);
  assert.equal(outdated.canApply, false);
  assert.ok(outdated.notices.some(notice => notice.code === 'SOURCE_JIRA_SERVICE_DESK_OWNER_REANALYSIS_REQUIRED' && notice.severity === 'error'));
  const updatedResponse = await reupload();
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json() as LegacyPackageSummary;
  assert.deepEqual([updated.id, updated.sha256, updated.version], [refreshed.id, refreshed.sha256, refreshed.version + 1]);
  const staleReview = await f.apply(preview);
  assert.equal(staleReview.status, 409, JSON.stringify(staleReview.data));
  assert.match(JSON.stringify(staleReview.data), /분석 버전이 변경/);

  const currentPreview = await f.preview(reviewedConfig);
  assert.equal(currentPreview.canApply, true, JSON.stringify(currentPreview.notices));
  const applied = await f.apply(currentPreview);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const { data: exported } = await f.call<WorkspaceSnapshot & { comments: Comment[]; sourceRecords: SourceRecordArchive[] }>('/export');
  const comments = exported.comments.map(value => value.body);
  assert.ok(comments.includes('Public synthetic note'));
  assert.ok(comments.every(body => !/Internal synthetic note|Malformed private synthetic note/.test(body)));
  const preserved = exported.sourceRecords.filter(row => row.source.instanceKey === instanceKey);
  for (const recordId of ['comment:200', 'comment:202', 'attachment:300', 'attachment:301']) {
    const raw = preserved.find(row => row.record.id === recordId);
    assert.ok(raw, recordId);
    assert.equal(raw.targetId, null, recordId);
  }
  assert.ok(preserved.find(row => row.record.id === 'attachment:302')?.targetId);
});

test('reanalyzing the same Jira ZIP makes catalog-backed historical workflow states selectable', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const filename = 'synthetic-historical-workflow.zip', instanceKey = 'synthetic-historical-workflow';
  const date = '2024-01-02T00:00:00Z';
  const archive = zip([{ path: 'entities.xml', bytes: Buffer.from(`<entity-engine-xml>
    <Project id="10" pkey="OLD" name="Synthetic workflow"/>
    <Status id="1" pname="Open" statuscategory="2"/>
    <Status id="2" pname="Approval" statuscategory="4"/>
    <Status id="3" pname="Closed" statuscategory="3"/><IssueType id="8" pname="Task"/>
    <Issue id="100" project="10" number="1" summary="Synthetic historical request" status="3" issuetype="8" created="${date}"/>
    <Issue id="101" project="10" number="2" summary="Synthetic open request" status="1" issuetype="8" created="${date}"/>
    <ChangeGroup id="300" issue="100" created="${date}"/>
    <ChangeItem id="400" group="300" field="status" fieldtype="jira" oldvalue="1" newvalue="2"/>
    <ChangeGroup id="301" issue="100" created="${date}"/>
    <ChangeItem id="401" group="301" field="status" fieldtype="jira" oldvalue="2" newvalue="3"/>
  </entity-engine-xml>`) }]);
  const uploaded = await f.upload(archive, filename, 'jira', instanceKey);
  const config = await f.configuration(uploaded, 'WORKFLOW');
  f.db.prepare(`UPDATE legacy_file_manifests SET json=json_remove(json,'$.jiraHistoricalWorkflowEvidenceChecked') WHERE package_id=?`).run(uploaded.id);
  f.db.prepare(`UPDATE legacy_records SET json=json_remove(json,'$.metadata.jiraWorkflowStatusLabel','$.metadata.jiraWorkflowStatusChangePositions')
    WHERE package_id=?`).run(uploaded.id);
  const before = await f.preview(config);
  assert.equal(before.canApply, true, JSON.stringify(before.notices));
  assert.equal(before.jiraObservedWorkflows, undefined);

  const params = new URLSearchParams({ filename, product: 'jira', instanceKey });
  const reupload = () => fetch(`${f.base}/legacy-import/packages?${params}`, { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-seo' }, body: new Uint8Array(archive) });
  const result = await reupload();
  assert.equal(result.status, 200);
  const refreshed = await result.json() as LegacyPackageSummary;
  assert.deepEqual([refreshed.id, refreshed.sha256, refreshed.version], [uploaded.id, uploaded.sha256, uploaded.version + 1]);
  const duplicate = await reupload();
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), refreshed);
  assert.equal((await f.apply(before)).status, 409);

  const { data: options } = await f.call<MigrationOptions>(`/migrations/options?packageId=${refreshed.id}`);
  const approval = options.jiraWorkflowStatuses?.find(row => row.label === 'Approval');
  const open = options.jiraWorkflowStatuses?.find(row => row.label === 'Open');
  assert.ok(approval && open);
  const observed = await f.preview(config);
  assert.equal(observed.canApply, true, JSON.stringify(observed.notices));
  assert.ok(observed.jiraObservedWorkflows?.[0].transitions.some(edge => edge.from === open.id && edge.to === approval.id));
  config.jiraWorkflows = { WORKFLOW: { initialStatusId: open.id, transitions: [{ from: open.id, to: approval.id }] } };
  const saved = await f.call('/migrations/mapping/export', 'POST', { configuration: config });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const restored = await f.call<{ configuration: MigrationConfiguration }>('/migrations/mapping/import', 'POST', { mapping: saved.data });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.deepEqual(restored.data.configuration.jiraWorkflows, config.jiraWorkflows);
  const reviewed = await f.preview(restored.data.configuration);
  assert.equal(reviewed.canApply, true, JSON.stringify(reviewed.notices));
  const applied = await f.apply(reviewed);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const { data: workspace } = await f.call<WorkspaceSnapshot>('/workspace');
  const [projectId] = applied.data.import.projectIds;
  const graph = workspace.workflows?.find(row => row.projectId === projectId);
  assert.ok(graph);
  assert.ok(graph.statuses.some(row => row.id === approval.id && row.label === 'Approval'));
  assert.deepEqual(graph.transitions, [{ from: open.id, to: approval.id, issueTypes: [], requiredFields: [] }]);
  assert.ok(workspace.issues.every(row => row.projectId !== projectId || row.status !== approval.id));
});

test('previous Jira archive analyses and previews cannot bypass backup directory review', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const directory = 'synthetic-jira-backup';
  const instance = 'synthetic-jira-archive-review';
  const backup = Buffer.from(`<entity-engine-xml>
    <Project id="10" pkey="OLD" name="Synthetic Jira archive"/>
    <Status id="1" pname="Open"/><IssueType id="3" pname="Task"/>
    <Issue id="100" project="10" number="1" summary="Synthetic issue" status="1" issuetype="3"/>
  </entity-engine-xml>`);
  const bytes = zip([
    { path: `${directory}/entities.xml`, bytes: backup },
    { path: 'another-synthetic-backup/activeobjects.xml', bytes: Buffer.from('<backup/>') },
  ]);
  const upload = () => f.upload(bytes, 'synthetic-jira-archive-review.zip', 'jira', instance);
  const pkg = await upload();
  const config = await f.configuration(pkg, 'ARCHIVERC');
  const reviewed = await f.preview(config);
  assert.equal(reviewed.canApply, true, JSON.stringify(reviewed.notices));
  assert.ok(reviewed.requiredAcknowledgements.includes('SOURCE_JIRA_ACTIVEOBJECTS_OUTSIDE_BACKUP_ROOT'));

  // Reproduce what the previous parser and converter saved for this archive layout.
  f.db.prepare(`UPDATE migration_previews SET json=json_set(json,'$.conversionVersion',
    json_extract(json,'$.conversionVersion') - 1) WHERE id=?`).run(reviewed.id);
  const rejected = await f.apply(reviewed);
  assert.equal(rejected.status, 409);
  assert.match(JSON.stringify(rejected.data), /원본 변환 규칙/);
  f.db.prepare("UPDATE legacy_file_manifests SET json=json_remove(json, '$.jiraBackupLayoutChecked') WHERE package_id=?").run(pkg.id);
  assert.equal(f.db.prepare(`DELETE FROM legacy_diagnostics WHERE package_id=? AND
    json_extract(json,'$.code')='JIRA_ACTIVEOBJECTS_OUTSIDE_BACKUP_ROOT'`).run(pkg.id).changes, 1);

  const stale = await f.preview(config);
  assert.equal(stale.canApply, false);
  assert.ok(stale.notices.some(notice => notice.code === 'SOURCE_JIRA_ADMIN_BACKUP_REANALYSIS_REQUIRED' && notice.severity === 'error'));
  assert.equal((await f.apply(stale)).status, 409);

  assert.equal((await f.call(`/legacy-import/packages/${pkg.id}`, 'DELETE', { expectedVersion: pkg.version })).status, 200);
  const fresh = await f.preview(await f.configuration(await upload(), 'ARCHIVERC'));
  const applied = await f.apply(fresh);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.equal(fresh.counts.issues, 1);
});

test('Jira follow-up archives moved source rows while applying new tickets in the original project', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const instance = 'synthetic-jira-follow-up-move';
  const oldProject = { id: '42', key: 'OLD', name: '원래 Jira 프로젝트' };
  const anotherProject = { id: '84', key: 'OTHER', name: '다른 Jira 프로젝트' };
  const author = { key: 'jira-follow-up-author', name: 'jira-follow-up-author', displayName: 'Jira 작성자' };
  const later = '2020-02-03T00:00:00.000Z';
  function row(id: number, key: string, project: typeof oldProject, summary: string, withHistory = false) {
    return { id: String(id), key, fields: {
      project, summary, status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
      created: '2020-01-01T00:00:00.000Z', updated: withHistory ? later : '2020-02-01T00:00:00.000Z',
      ...(withHistory ? {
        comment: { comments: [{ id: '2901', body: '이동 후 원본 댓글', author, created: later }] },
        worklog: { worklogs: [{ id: '2902', issueId: String(id), author, comment: '이동 후 원본 작업 기록',
          created: later, started: later, timeSpentSeconds: 91 }] },
      } : {}),
    } };
  }
  const upload = (filename: string, issues: ReturnType<typeof row>[]) => f.upload(Buffer.from(JSON.stringify({ issues })), filename, 'jira', instance);
  const applyFirst = async (filename: string, rows: ReturnType<typeof row>[], key: string) => {
    const pkg = await upload(filename, rows);
    const applied = await f.apply(await f.preview(await f.configuration(pkg, key)));
    assert.equal(applied.status, 201, JSON.stringify(applied.data));
    return applied.data.import.projectIds[0];
  };
  const appendConfig = async (pkg: LegacyPackageSummary, projectId: string): Promise<MigrationConfiguration> => {
    const { data: options } = await f.call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`);
    const target = options.appendTarget;
    assert.equal(target?.projectId, projectId);
    const configuration = await f.configuration(pkg);
    return { ...configuration, appendTo: { projectId, refreshExisting: true, refreshHistory: true,
      statuses: Object.fromEntries(options.statuses.map(option => [option.id, target!.statuses.find(status => status.label === option.label)!.id])),
      issueTypes: Object.fromEntries(options.issueTypes.map(option => [option.id, target!.issueTypes.find(type => type.name === option.label)!.id])),
      fields: {},
    } };
  };
  const originalId = await applyFirst('initial-old.json', [row(100, 'OLD-1', oldProject, '이동할 원래 업무')], 'MOVEDOLD');
  const snapshot = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const issue = snapshot.issues.find(item => item.projectId === originalId)!;
  const destination = snapshot.issues.find(item => item.projectId !== originalId)!;
  const movePath = `/issues/${issue.id}/project-move`;
  const request = { expectedVersion: issue.version, projectId: destination.projectId, includeConnected: false,
    mappings: [{ issueId: issue.id, status: destination.status, type: destination.type }] };
  const { data: moving } = await f.call<IssueProjectMovePreview>(`${movePath}/preview`, 'POST', request);
  assert.ok(moving.token, JSON.stringify(moving.blockers));
  const applied = await f.call<IssueProjectMoveResult>(`${movePath}/apply`, 'POST', { ...request, token: moving.token });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  const edit = await f.call<Issue>(`/issues/${issue.id}`, 'PATCH', { expectedVersion: applied.data.issues[0].version, title: '현재 팀이 편집한 제목' });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));

  const followup = await upload('followup.json', [row(100, 'OLD-1', oldProject, '나중 Jira에서 바꾼 원본 제목', true),
    row(101, 'OLD-2', oldProject, '같은 원본의 새 업무')]);
  const review = await f.preview(await appendConfig(followup, originalId));
  assert.equal(review.canApply, true, JSON.stringify(review.notices));
  assert.ok(review.requiredAcknowledgements.includes('JIRA_MOVED_ISSUES_ARCHIVED'));
  assert.equal(review.counts.issues, 1);
  assert.equal(review.counts.newJiraComments, 0);
  assert.equal(review.counts.newJiraWorklogs, 0);
  assert.ok(!review.issueRefresh?.some(item => item.issueId === issue.id));
  const related = await f.apply(review);
  assert.equal(related.status, 201, JSON.stringify(related.data));
  const backup = (await f.call<WorkspaceSnapshot & { sourceRecords: SourceRecordArchive[] }>('/export')).data;
  assert.deepEqual(backup.issues.find(item => item.id === issue.id), edit.data);
  assert.deepEqual(backup.issues.filter(item => item.projectId === originalId).map(item => item.title), ['같은 원본의 새 업무']);
  const earlier = backup.sourceRecords.find(item => item.record.kind === 'issue' && item.targetId === issue.id);
  assert.equal(earlier?.targetProjectId, originalId);
  assert.equal(earlier?.record.title, issue.title);
  const retained = backup.sourceRecords.filter(item => item.sourceImportId === related.data.import.id && ['100', '2901', 'worklog:2902'].includes(item.record.sourceId));
  assert.equal(retained.length, 3, JSON.stringify(retained.map(item => item.record.id)));
  assert.ok(retained.every(item => item.targetId === null && item.targetProjectId === null && item.ownerId === null));

  assert.ok(earlier);
  const originalListPath = `/source-imports/${earlier.sourceImportId}/reconciliation`;
  const readOriginal = () => f.call<SourceReconciliationPage>(`${originalListPath}?kind=issue&q=OLD-1`);
  const moved = await readOriginal();
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.data.rows.map(row => [row.target?.id, row.target?.projectId, row.invalidPrimaryBinding]),
    [[issue.id, destination.projectId, undefined]]);
  const pointJiraKeyAtReceipt = f.db.prepare(`UPDATE source_bindings SET import_id=?
    WHERE product='jira' AND source_instance=? AND kind='issue' AND source_alias='OLD-1'`);
  assert.equal(pointJiraKeyAtReceipt.run(related.data.import.id, instance).changes, 1);
  assert.deepEqual((await readOriginal()).data.rows.map(row => [row.target?.id, row.invalidPrimaryBinding]), [[issue.id, true]],
    'a receipt that merely archives the same Jira key has no evidence for its live binding');
  assert.equal(pointJiraKeyAtReceipt.run(earlier.sourceImportId, instance).changes, 1);

  const unrelatedId = await applyFirst('another-project.json', [row(200, 'OTHER-1', anotherProject, '별도 Jira 업무')], 'UNRELATED');
  const conflict = await upload('incorrect-other.json', [row(100, 'OTHER-2', anotherProject, '다른 원본 프로젝트가 주장한 기존 ID')]);
  const blocked = await f.preview(await appendConfig(conflict, unrelatedId));
  assert.equal(blocked.canApply, false);
  assert.ok(blocked.notices.some(item => item.code === 'SOURCE_BINDING_CONFLICT'));
  assert.ok(!blocked.notices.some(item => item.code === 'JIRA_MOVED_ISSUES_ARCHIVED'));
});

test('Jira rich descriptions survive initial HTTP apply and an accepted plain source refresh clears the format', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const rich = { type: 'doc', version: 1, content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '장비 검증' }] },
    { type: 'paragraph', content: [
      { type: 'text', text: '필수 조건', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' · ' },
      { type: 'text', text: '사양', marks: [{ type: 'link', attrs: { href: 'https://docs.example.test/check?part=a&rev=2' } }] },
    ] },
  ] };
  const plain = '승인된 단일 평문 요약';
  const source = (description: unknown, updated: string) => Buffer.from(JSON.stringify({ issues: [{ id: '100', key: 'OLD-1', fields: {
    project: { id: '42', key: 'OLD', name: 'Jira 표현 테스트' }, summary: '가상 업무',
    issuetype: { id: '3', name: 'Task' }, status: { id: '1', name: 'Open' },
    created: '2020-01-01T00:00:00Z', updated, description,
  } }] }));
  const instance = 'synthetic-jira-rich-description';
  const original = await f.upload(source(rich, '2020-01-02T00:00:00Z'), 'original-rich.json', 'jira', instance);
  const first = await f.preview(await f.configuration(original, 'RICH'));
  assert.equal(first.canApply, true, JSON.stringify(first.notices));
  const applied = await f.apply(first);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const [projectId] = applied.data.import.projectIds;
  const readIssue = async () => (await f.call<WorkspaceSnapshot>('/workspace')).data.issues.find(issue => issue.projectId === projectId)!;
  const imported = await readIssue();
  assert.equal(imported.descriptionFormat, 'markdown');
  assert.equal(imported.description, '## 장비 검증\n\n**필수 조건** · [사양](https://docs.example.test/check?part=a&rev=2)');

  const incoming = await f.upload(source(plain, '2020-01-03T00:00:00Z'), 'newer-plain.json', 'jira', instance);
  const { data: options } = await f.call<MigrationOptions>(`/migrations/options?packageId=${incoming.id}`);
  const target = options.appendTarget;
  assert.ok(target);
  const update = await f.preview({ ...options.defaultConfiguration, appendTo: {
    projectId, refreshExisting: true,
    statuses: Object.fromEntries(options.statuses.map(item => [item.id, target.statuses.find(status => status.label === item.label)!.id])),
    issueTypes: Object.fromEntries(options.issueTypes.map(item => [item.id, target.issueTypes.find(type => type.name === item.label)!.id])),
    fields: {},
  } });
  assert.equal(update.canApply, true, JSON.stringify(update.notices));
  assert.deepEqual(update.issueRefresh?.[0].fields.map(({ field, decision }) => ({ field, decision })), [{ field: 'description', decision: 'apply' }]);
  const refreshed = await f.apply(update);
  assert.equal(refreshed.status, 201, JSON.stringify(refreshed.data));
  const current = await readIssue();
  assert.equal(current.id, imported.id);
  assert.equal(current.version, imported.version + 1);
  assert.equal(current.description, plain);
  assert.equal(Object.hasOwn(current, 'descriptionFormat'), false);
  const backup = await f.call<WorkspaceSnapshot & { sourceRecords: SourceRecordArchive[] }>('/export');
  assert.equal(backup.status, 200);
  assert.deepEqual(backup.data.sourceRecords.filter(row => row.targetId === imported.id).map(row => row.record.text).sort(),
    [JSON.stringify(rich), plain].sort());
  const firstReceipt = applied.data.import;
  const secondReceipt = refreshed.data.import;
  const bindingReceipts = f.db.prepare(`SELECT DISTINCT import_id FROM source_bindings WHERE product='jira' AND source_instance=?
    AND kind='issue' AND target_id=?`).all(instance, imported.id);
  assert.deepEqual(bindingReceipts.map(row => row.import_id), [firstReceipt.id]);
  for (const receipt of [firstReceipt, secondReceipt]) {
    const report = await f.call<SourceReconciliationAudit>(`/source-imports/${receipt.id}/reconciliation/audit?expectedVersion=${receipt.version}`);
    assert.equal(report.status, 200, JSON.stringify(report.data));
    assert.deepEqual(report.data.primaryRecords.map(row => [row.counts.linked, row.invalidTargets]), [[1, 0]],
      'both receipts prove the same active target even though the alias points at the first receipt');
  }
});

test('Jira HTTP migration projects only an explicit mapped reporter and updates it without overwriting local edits', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const instance = 'synthetic-jira-reporter';
  const actorMappings: Record<string, string> = { creator: 'user-min', first: 'user-yun', second: 'user-jun' };
  const rawActor = (accountId: string) => ({ accountId, displayName: `합성 ${accountId}` });
  function row(id: number, updated: string, reporter: string | null | undefined) {
    return { id: String(id), key: `OLD-${id}`, fields: {
      project: { id: '101', key: 'OLD', name: '가상 Jira 프로젝트' }, summary: `원래 업무 ${id}`,
      status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
      created: '2020-01-01T00:00:00Z', updated, creator: rawActor('creator'),
      ...(reporter !== undefined ? { reporter: reporter === null ? null : rawActor(reporter) } : {}),
    } };
  }
  const upload = (name: string, updated: string, reporters: (string | null | undefined)[]) => f.upload(
    Buffer.from(JSON.stringify({ issues: reporters.map((reporter, index) => row(index + 1, updated, reporter)) })), `${name}.json`, 'jira', instance);
  const readOptions = async (pkg: LegacyPackageSummary) => (await f.call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`)).data;
  function mapUsers(config: MigrationConfiguration, options: MigrationOptions) {
    config.users = Object.fromEntries(options.identities.map(identity => [identity.id, actorMappings[identity.sourceValue] ?? null]));
    return config;
  }
  const initial = await upload('original-reporters', '2020-01-02T00:00:00Z', ['first', undefined, 'first', undefined, 'first', 'first', null]);
  const config = mapUsers(await f.configuration(initial, 'REQ'), await readOptions(initial));
  const first = await f.apply(await f.preview(config));
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const [projectId] = first.data.import.projectIds;
  const read = async () => (await f.call<WorkspaceSnapshot>('/workspace')).data.issues.filter(issue => issue.projectId === projectId);
  const records = await read();
  const issue = (items: Issue[], id: number) => items.find(value => value.title === `원래 업무 ${id}`)!;
  assert.deepEqual(Array.from({ length: 7 }, (_, index) => issue(records, index + 1).reporterId),
    ['user-yun', undefined, 'user-yun', undefined, 'user-yun', 'user-yun', null]);
  type Backup = WorkspaceSnapshot & { schemaVersion: number; sourceRecords: SourceRecordArchive[] };
  const initialBackup = (await f.call<Backup>('/export')).data;
  const mappedArchive = initialBackup.sourceRecords.find(record => record.targetId === issue(records, 1).id);
  const creatorOnlyArchive = initialBackup.sourceRecords.find(record => record.targetId === issue(records, 2).id);
  const blankReporterArchive = initialBackup.sourceRecords.find(record => record.targetId === issue(records, 7).id);
  assert.equal(mappedArchive?.record.authorId, 'creator');
  assert.equal(mappedArchive?.record.metadata.jiraReporter, 'first');
  assert.ok(mappedArchive?.jiraIssueFieldHashes?.reporterId);
  assert.equal(creatorOnlyArchive?.jiraIssueFieldHashes?.reporterId, undefined);
  assert.ok(blankReporterArchive?.jiraIssueFieldHashes?.reporterId);
  assert.notEqual(blankReporterArchive.jiraIssueFieldHashes.reporterId, mappedArchive.jiraIssueFieldHashes.reporterId);

  for (const [index, reporterId] of [[3, 'user-min'], [4, null]] as const) {
    const current = issue(records, index);
    const edited = await f.call<Issue>(`/issues/${current.id}`, 'PATCH', { expectedVersion: current.version, reporterId });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.equal(edited.data.reporterId, reporterId);
  }
  const delta = await upload('new-reporters', '2020-01-03T00:00:00Z', ['second', 'second', 'second', 'second', null, 'unmapped', undefined]);
  const options = await readOptions(delta);
  const target = options.appendTarget;
  assert.ok(target);
  const appendConfig = mapUsers({ ...options.defaultConfiguration, appendTo: {
    projectId, refreshExisting: true,
    statuses: Object.fromEntries(options.statuses.map(item => [item.id, target.statuses.find(status => status.label === item.label)!.id])),
    issueTypes: Object.fromEntries(options.issueTypes.map(item => [item.id, target.issueTypes.find(type => type.name === item.label)!.id])),
    fields: {},
  } }, options);
  const review = await f.preview(appendConfig);
  assert.equal(review.canApply, true, JSON.stringify(review.notices));
  const decisions = Object.fromEntries(review.issueRefresh?.map(item => [item.sourceKey, item.fields.find(field => field.field === 'reporterId')?.decision]) ?? []);
  assert.deepEqual(decisions, { 'OLD-1': 'apply', 'OLD-2': 'apply', 'OLD-3': 'conflict', 'OLD-4': 'conflict', 'OLD-5': 'apply' });
  assert.ok(review.notices.some(item => item.code === 'JIRA_REFRESH_FIELD_UNAVAILABLE' && item.message.includes('요청자')));
  const applied = await f.apply(review);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const expected = ['user-jun', 'user-jun', 'user-min', null, null, 'user-yun', null];
  const after = await read();
  assert.deepEqual(Array.from({ length: 7 }, (_, index) => issue(after, index + 1).reporterId), expected);
  const backup = (await f.call<Backup>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const restored = await f.call('/import', 'POST', { data: backup });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  const afterRestore = await read();
  assert.deepEqual(Array.from({ length: 7 }, (_, index) => issue(afterRestore, index + 1).reporterId), expected);
});

test('Jira original estimates feed Gantt workload and reviewed refresh preserves local effort after restore', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const day = '2026-11-23';
  const instance = 'synthetic-original-estimate-workload';
  const project = { id: '41', key: 'OLD', name: '가상 일정 팀' };
  const assignee = { accountId: 'jira-estimate-owner', displayName: 'Jira 담당자' };
  const upload = (name: string, updated: string, fields: Record<string, unknown>[]) => f.upload(Buffer.from(JSON.stringify({
    issues: fields.map((values, index) => ({ id: String(100 + index), key: `OLD-${index + 1}`, fields: {
      project, summary: `이관 업무 ${index + 1}`, assignee, created: '2026-11-01T00:00:00Z', updated,
      status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' }, startDate: day, endDate: day, ...values,
    } })),
  })), `${name}.json`, 'jira', instance);
  const original = await upload('original-estimates', '2026-11-02T00:00:00Z', [
    { timeoriginalestimate: 5400, timetracking: { originalEstimateSeconds: 5400, remainingEstimateSeconds: 1200 }, timespent: 1800 },
    { timeoriginalestimate: 0 }, { timeoriginalestimate: 91 }, {}, {}, { timeoriginalestimate: 7200 },
  ]);
  const first = await f.preview(await f.configuration(original, 'EFFORT'));
  assert.equal(first.canApply, true, JSON.stringify(first.notices));
  assert.equal(first.counts.jiraPlannedEffortIssues, 3);
  assert.ok(first.requiredAcknowledgements.includes('JIRA_ORIGINAL_ESTIMATE_ARCHIVED'));
  const applied = await f.apply(first);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const [projectId] = applied.data.import.projectIds;
  const issues = async () => (await f.call<WorkspaceSnapshot>('/workspace')).data.issues.filter(issue => issue.projectId === projectId)
    .sort((left, right) => left.key.localeCompare(right.key));
  const workload = async () => (await f.call<ProjectWorkloadResult>(`/projects/${projectId}/workload?startDate=${day}&endDate=${day}`)).data;
  const initial = await issues();
  assert.deepEqual(initial.map(issue => issue.plannedEffortMinutes), [90, 0, undefined, undefined, undefined, 120]);
  assert.equal(initial[0].estimate, null);
  const load = await workload();
  assert.equal(load.totalScheduledMinutes, 210);
  assert.deepEqual(load.rows.find(row => row.userId === 'user-jun')?.days[0].allocations,
    [{ issueId: initial[0].id, minutes: 90 }, { issueId: initial[5].id, minutes: 120 }]);
  assert.ok(!load.incomplete.some(item => item.issueId === initial[1].id));
  assert.ok(load.incomplete.some(item => item.issueId === initial[2].id && item.reasons.includes('missing-effort')));

  type Backup = WorkspaceSnapshot & { schemaVersion: number; sourceRecords: SourceRecordArchive[] };
  const backup = (await f.call<Backup>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const firstArchive = backup.sourceRecords.find(row => row.targetId === initial[0].id && row.record.kind === 'issue');
  assert.equal(firstArchive?.record.metadata.jiraOriginalEstimateSeconds, 5400);
  assert.ok(firstArchive?.jiraIssueFieldHashes?.plannedEffortMinutes);
  assert.ok(firstArchive?.jiraIssueSourceFieldHashes?.plannedEffortMinutes);
  assert.equal(backup.sourceRecords.find(row => row.targetId === initial[2].id && row.record.kind === 'issue')?.record.metadata.jiraOriginalEstimateSeconds, 91);
  const downgraded = await f.call('/import', 'POST', { data: { ...backup, schemaVersion: 115 } });
  assert.equal(downgraded.status, 400);
  assert.match(JSON.stringify(downgraded.data), /schemaVersion 116/);
  const restored = await f.call('/import', 'POST', { data: backup });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal((await workload()).totalScheduledMinutes, 210);
  const restoredIssues = await issues();

  const local = await f.call<Issue>(`/issues/${restoredIssues[3].id}`, 'PATCH', { expectedVersion: restoredIssues[3].version, plannedEffortMinutes: 45 });
  assert.equal(local.status, 200, JSON.stringify(local.data));
  const points = await f.call<Issue>(`/issues/${restoredIssues[0].id}`, 'PATCH', { expectedVersion: restoredIssues[0].version, estimate: 8 });
  assert.equal(points.status, 200, JSON.stringify(points.data));
  const delta = await upload('newer-estimates', '2026-11-03T00:00:00Z', [
    { timetracking: { originalEstimateSeconds: 9000 } }, { timeoriginalestimate: null }, {},
    { timeoriginalestimate: 10800 }, { timeoriginalestimate: 3600 }, {},
  ]);
  const { data: options } = await f.call<MigrationOptions>(`/migrations/options?packageId=${delta.id}`);
  const target = options.appendTarget;
  assert.ok(target);
  assert.equal(target.projectId, projectId);
  const config = await f.configuration(delta);
  const preview = await f.preview({ ...config, appendTo: {
    projectId, refreshExisting: true,
    statuses: Object.fromEntries(options.statuses.map(option => [option.id, target.statuses.find(value => value.label === option.label)!.id])),
    issueTypes: Object.fromEntries(options.issueTypes.map(option => [option.id, target.issueTypes.find(value => value.name === option.label)!.id])),
    fields: {},
  } });
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  assert.deepEqual(Object.fromEntries((preview.issueRefresh ?? []).flatMap(issue => issue.fields
    .filter(change => change.field === 'plannedEffortMinutes').map(change => [issue.sourceKey, change.decision]))),
    { 'OLD-1': 'apply', 'OLD-2': 'apply', 'OLD-4': 'conflict', 'OLD-5': 'apply' });
  const refreshed = await f.apply(preview);
  assert.equal(refreshed.status, 201, JSON.stringify(refreshed.data));
  const final = await issues();
  assert.deepEqual(final.map(issue => issue.plannedEffortMinutes), [150, null, undefined, 45, 60, 120]);
  assert.equal(final[0].estimate, 8);
  assert.equal((await workload()).totalScheduledMinutes, 375);
});

test('Jira parent refresh restores format 99 safely across packages and uses the accepted parent after format 100 restore', async t => {
  const first = await fixture(), target = await fixture();
  t.after(() => Promise.all([first.close(), target.close()]));
  const instance = 'synthetic-jira-hierarchy-restore';
  type Row = [id: number, parent: number | null | undefined];
  const upload = (workspace: MigrationFixture, name: string, day: string, rows: Row[]) => workspace.upload(Buffer.from(JSON.stringify({
    issues: rows.map(([id, parent]) => ({ id: String(id), key: `OLD-${id}`, fields: {
      project: { id: '42', key: 'OLD', name: '원본 티켓 계층' }, summary: `계층 업무 ${id}`,
      status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
      created: '2020-01-01T00:00:00Z', updated: `2020-01-${day}T00:00:00Z`,
      ...(parent === undefined ? {} : { parent: parent === null ? null : { id: String(parent), key: `OLD-${parent}` } }),
    } })),
  })), `${name}.json`, 'jira', instance);
  const original = await upload(first, 'initial-hierarchy-issues', '02', [[10, null], [20, null], [30, 10], [31, 10], [32, 10], [33, 90]]);
  const separate = await upload(first, 'initial-hierarchy-other-issue', '02', [[90, null]]);
  const configured = await first.configuration([original, separate], 'JRTREE');
  const initialPlan = await first.preview(configured);
  assert.ok(initialPlan.notices.some(notice => notice.code === 'PARENT_NOT_IMPORTED' && notice.recordId === `${original.id}/issue:33`));
  const initial = await first.apply(initialPlan);
  assert.equal(initial.status, 201, JSON.stringify(initial.data));
  const [projectId] = initial.data.import.projectIds;
  type Backup = WorkspaceSnapshot & { schemaVersion: number; sourceImports: SourceImport[]; sourceRecords: SourceRecordArchive[] };
  const backup = (await first.call<Backup>('/export')).data;
  const issue = (data: WorkspaceSnapshot, id: number) => data.issues.find(item => item.projectId === projectId && item.title === `계층 업무 ${id}`)!;
  const originalParent = issue(backup, 10), newParent = issue(backup, 20), separateParent = issue(backup, 90);
  const child = issue(backup, 30), locallyMoved = issue(backup, 33);
  assert.equal(child.parentId, originalParent.id);
  assert.equal(locallyMoved.parentId, null);
  const older = historicalMigrationBackup(backup, 99);
  for (const receipt of older.sourceImports) delete receipt.integrity;
  for (const record of older.sourceRecords) {
    if (record.jiraIssueFieldHashes) delete record.jiraIssueFieldHashes.parentId;
    delete record.record.metadata.jiraParentSourceId;
    delete record.record.metadata.jiraParentSourceKey;
  }
  const restored = await target.call('/import', 'POST', { data: older });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal((await target.call(`/issues/${locallyMoved.id}`, 'PATCH', { expectedVersion: locallyMoved.version, parentId: separateParent.id })).status, 200);

  async function preview(name: string, day: string, rows: Row[]) {
    const staged = await upload(target, name, day, rows);
    const { data: options } = await target.call<MigrationOptions>(`/migrations/options?packageId=${staged.id}`);
    const scope = options.appendTarget;
    assert.ok(scope);
    return target.preview({ ...options.defaultConfiguration, appendTo: { projectId, refreshExisting: true,
      statuses: Object.fromEntries(options.statuses.map(value => [value.id, scope.statuses.find(status => status.label === value.label)!.id])),
      issueTypes: Object.fromEntries(options.issueTypes.map(value => [value.id, scope.issueTypes.find(type => type.name === value.label)!.id])),
      fields: {},
    } });
  }
  const followUp = await preview('edited-hierarchy-issues', '03', [[30, 20], [31, undefined], [32, 99], [33, 20]]);
  assert.equal(followUp.canApply, true, JSON.stringify(followUp.notices));
  assert.deepEqual(Object.fromEntries(followUp.issueRefresh?.map(row => [row.sourceKey, row.fields.find(field => field.field === 'parentId')?.decision]) ?? []),
    { 'OLD-30': 'apply', 'OLD-33': 'conflict' });
  assert.ok(followUp.notices.some(notice => notice.code === 'JIRA_REFRESH_PARENT_UNAVAILABLE'));
  assert.ok(followUp.notices.some(notice => notice.code === 'JIRA_REFRESH_PARENT_BASELINE_UNAVAILABLE'));
  assert.equal((await target.apply(followUp)).status, 201);
  const changed = (await target.call<Backup>('/export')).data;
  assert.deepEqual([30, 31, 32, 33].map(id => issue(changed, id).parentId), [newParent.id, originalParent.id, originalParent.id, separateParent.id]);
  assert.equal(changed.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal((await target.call('/import', 'POST', { data: changed })).status, 200);
  const next = await preview('later-hierarchy-issues', '04', [[30, null]]);
  assert.equal(next.issueRefresh?.[0].fields.find(field => field.field === 'parentId')?.decision, 'apply');
  assert.equal((await target.apply(next)).status, 201);
  assert.equal(issue((await target.call<WorkspaceSnapshot>('/workspace')).data, 30).parentId, null);
});

test('Jira refresh checks the final subtask states before applying a guarded parent transition', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const source = 'synthetic-jira-guarded-closure';
  const open = { id: '1', name: 'Open' }, done = { id: '2', name: 'Done' };
  const row = (id: number, updated: string, status: typeof open, parent?: number) => ({ id: String(id), key: `OLD-${id}`, fields: {
    project: { id: '42', key: 'OLD', name: 'Jira 원본 작업' }, summary: `이관한 업무 ${id}`, status, issuetype: { id: '3', name: 'Task' },
    created: '2020-01-01T00:00:00Z', updated: `2020-01-${updated}T00:00:00Z`,
    ...(parent === undefined ? {} : { parent: { id: String(parent), key: `OLD-${parent}` } }),
  } });
  const upload = (name: string, rows: ReturnType<typeof row>[]) => f.upload(Buffer.from(JSON.stringify({ issues: rows })), `${name}.json`, 'jira', source);
  const initial = await upload('initial-guarded-tickets', [row(10, '02', open), row(20, '02', open, 10), row(30, '02', done)]);
  const applied = await f.apply(await f.preview(await f.configuration(initial, 'SUBTASK')));
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const [projectId] = applied.data.import.projectIds;
  const projectIssues = async () => (await f.call<WorkspaceSnapshot>('/workspace')).data.issues.filter(issue => issue.projectId === projectId);
  const findIssue = (issues: Issue[], sourceId: number) => issues.find(issue => issue.title === `이관한 업무 ${sourceId}`)!;
  const before = await projectIssues();
  const parent = findIssue(before, 10), child = findIssue(before, 20);
  assert.equal(child.parentId, parent.id);
  assert.equal(child.status, parent.status);
  const doneStatusId = findIssue(before, 30).status;
  const path = `/projects/${projectId}/workflow`;
  const workflow = (await f.call<ProjectWorkflow>(path)).data;
  const guarded = (edge: ProjectWorkflow['transitions'][number]) => edge.from === parent.status && edge.to === doneStatusId;
  assert.ok(workflow.transitions.some(guarded));
  const saved = await f.call<ProjectWorkflow>(path, 'PATCH', { ...workflow, expectedVersion: workflow.version,
    transitions: workflow.transitions.map(edge => guarded(edge) ? { ...edge, requireClosedSubtasks: true } : edge) });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  async function review(name: string, rows: ReturnType<typeof row>[]) {
    const staged = await upload(name, rows);
    const { data: options } = await f.call<MigrationOptions>(`/migrations/options?packageId=${staged.id}`);
    const target = options.appendTarget;
    assert.ok(target);
    return f.preview({ ...options.defaultConfiguration, appendTo: { projectId, refreshExisting: true,
      statuses: Object.fromEntries(options.statuses.map(option => [option.id, target.statuses.find(status => status.label === option.label)!.id])),
      issueTypes: Object.fromEntries(options.issueTypes.map(option => [option.id, target.issueTypes.find(type => type.name === option.label)!.id])),
      fields: {},
    } });
  }
  const parentDone = row(10, '03', done);
  const blocked = await review('only-parent-done', [parentDone]);
  assert.equal(blocked.canApply, false, JSON.stringify(blocked.notices));
  assert.ok(blocked.notices.some(notice => notice.code === 'JIRA_REFRESH_VALIDATION' &&
    notice.message.includes(parent.key) && notice.message.includes('열린 하위 업무를 먼저 완료하거나 취소해 주세요.')));
  assert.equal((await f.apply(blocked)).status, 409);
  assert.deepEqual(await projectIssues(), before);

  const ready = await review('parent-and-child-done', [parentDone, row(20, '03', done, 10)]);
  assert.equal(ready.canApply, true, JSON.stringify(ready.notices));
  assert.equal(ready.counts.updatedIssues, 2);
  const updated = await f.apply(ready);
  assert.equal(updated.status, 201, JSON.stringify(updated.data));
  const after = await projectIssues();
  assert.deepEqual([findIssue(after, 10), findIssue(after, 20)].map(({ status, version, parentId }) => ({ status, version, parentId })), [
    { status: doneStatusId, version: parent.version + 1, parentId: parent.parentId },
    { status: doneStatusId, version: child.version + 1, parentId: parent.id },
  ]);
});

test('incremental Jira imports append only new issues to the bound project and reuse active source parents', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const instance = 'synthetic-continuing-jira';
  function original(id: string, key: string, summary: string, extra: Record<string, unknown> = {}) {
    return { id, key, fields: {
      project: { id: '10104', key: 'OLD', name: '팀 Jira 원본' }, summary,
      description: '원본 설명', created: '2020-01-01T00:00:00Z', updated: '2020-01-02T01:00:00Z',
      status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' }, ...extra,
    } };
  }
  const upload = (name: string, issues: ReturnType<typeof original>[], source = instance) =>
    f.upload(Buffer.from(JSON.stringify({ issues })),name,'jira',source);

  const initial = await upload('initial-jira.json', [original('100','OLD-1','기존 부모'), original('200','OLD-2','기존 보관 업무')]);
  const initialPlan = await f.preview(await f.configuration(initial,'CONT'));
  assert.equal(initialPlan.canApply,true,JSON.stringify(initialPlan.notices));
  const initialApply = await f.apply(initialPlan);
  assert.equal(initialApply.status,201,JSON.stringify(initialApply.data));
  const [projectId] = initialApply.data.import.projectIds;
  const initialData = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const first = initialData.issues.find(issue=>issue.key==='CONT-1')!;
  const second = initialData.issues.find(issue=>issue.key==='CONT-2')!;
  assert.ok(first && second);
  const updated = await f.call<typeof first>(`/issues/${first.id}`,'PATCH',{expectedVersion:first.version,title:'Teamspace에서 수정한 부모'});
  assert.equal(updated.status,200,JSON.stringify(updated.data));
  assert.equal((await f.call(`/issues/${second.id}`,'DELETE',{expectedVersion:second.version})).status,200);

  const rows = [original('200','OLD-2','최신 원본의 보관 업무',{
    comment:{comments:[{id:'301',body:'기존 업무의 새 원본 댓글',created:'2020-01-04T00:00:00Z'}]},
  }), original('300','OLD-3','처음 가져오는 하위 업무',{
    parent:{id:'100',key:'OLD-1'},
    comment:{comments:[{id:'302',body:'새 티켓의 원본 댓글',created:'2020-01-04T00:00:00Z'}]},
    issuelinks:[{id:'303',type:{id:'1',name:'Blocks'},outwardIssue:{id:'100',key:'OLD-1'}}],
  })];
  const delta = await upload('continuing-jira.json',rows);
  const options = (await f.call<MigrationOptions>(`/migrations/options?packageId=${delta.id}`)).data;
  const target = options.appendTarget;
  assert.equal(target?.projectId,projectId);
  assert.equal(target?.instanceKey,instance);
  assert.ok(target);
  const unrelated = await upload('unrelated-origin.json',rows,'synthetic-different-jira');
  assert.equal((await f.call<MigrationOptions>(`/migrations/options?packageId=${unrelated.id}`)).data.appendTarget,undefined);
  const config: MigrationConfiguration = {
    ...options.defaultConfiguration,
    appendTo: {
      projectId,
      statuses:Object.fromEntries(options.statuses.map(row=>[row.id,target.statuses.find(status=>status.label===row.label)!.id])),
      issueTypes:Object.fromEntries(options.issueTypes.map(row=>[row.id,target.issueTypes.find(type=>type.name===row.label)!.id])),
      fields:Object.fromEntries(options.fields.map(row=>[row.id,null])),
    },
  };
  const invalid = await f.call('/migrations/preview','POST',{configuration:{...config,appendTo:{...config.appendTo,projectId:'project-neo'}}});
  assert.ok([400,409].includes(invalid.status),JSON.stringify(invalid.data));
  const firstReview = await f.preview(config);
  assert.equal(firstReview.canApply,true,JSON.stringify(firstReview.notices));
  assert.equal(firstReview.counts.retainedIssues,1);
  assert.equal(firstReview.counts.issues,1);
  assert.equal(firstReview.projects[0]?.id,projectId);
  const local = await f.call<typeof first>('/issues','POST',{projectId,title:'미리보기 뒤 추가한 팀 업무'});
  assert.equal(local.status,201,JSON.stringify(local.data));
  assert.equal(local.data.key,'CONT-3');
  assert.equal((await f.apply(firstReview)).status,409);
  assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).data.issues.filter(issue=>issue.projectId===projectId).length,2);

  const review = await f.preview(config);
  assert.equal(review.canApply,true,JSON.stringify(review.notices));
  const applied = await f.apply(review);
  assert.equal(applied.status,201,JSON.stringify(applied.data));
  assert.deepEqual(applied.data.import.projectIds,[projectId]);
  assert.deepEqual(applied.data.import.configuration.appendTo,config.appendTo);
  assert.equal((await f.apply(review)).data.duplicate,true);
  const current = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const child = current.issues.find(issue=>issue.projectId===projectId&&issue.key==='CONT-4');
  assert.ok(child);
  assert.equal(child.parentId,first.id);
  assert.deepEqual(current.issues.find(issue=>issue.id===first.id),updated.data);
  assert.equal(current.issues.some(issue=>issue.id===second.id),false);
  assert.deepEqual(current.workflows?.find(value=>value.projectId===projectId),initialData.workflows?.find(value=>value.projectId===projectId));
  assert.deepEqual(current.issueSchemas?.find(value=>value.projectId===projectId),initialData.issueSchemas?.find(value=>value.projectId===projectId));
  const backup = await f.call<WorkspaceSnapshot & {schemaVersion:number;sourceImports:SourceImport[];comments:Comment[];issueRelations:{sourceIssueId:string;targetIssueId:string}[]}>('/export');
  assert.deepEqual(backup.data.comments.filter(comment=>comment.resourceId===child.id).map(comment=>comment.body),['새 티켓의 원본 댓글']);
  assert.equal(backup.data.comments.some(comment=>comment.body==='기존 업무의 새 원본 댓글'),false);
  assert.equal(backup.data.schemaVersion,NATIVE_BACKUP_SCHEMA_VERSION);
  assert.ok(backup.data.issueRelations.some(relation=>relation.sourceIssueId===child.id&&relation.targetIssueId===first.id));
  assert.equal((await f.call('/import','POST',{data:historicalMigrationBackup(backup.data, 36)})).status,400);
  assert.equal((await f.call('/import','POST',{data:backup.data})).status,200);
  const receipts = (await f.call<SourceImport[]>('/source-imports')).data;
  assert.deepEqual(receipts.find(value=>value.id===applied.data.import.id)?.configuration.appendTo,config.appendTo);
  const noChanges = await f.preview(config);
  assert.equal(noChanges.canApply,false,JSON.stringify(noChanges.notices));
  assert.equal(noChanges.counts.retainedIssues,2);
});

test('reviewed Jira deltas preserve conflicting team edits, honor workflow rules and survive native restore', async t => {
  const initial = await fixture(), f = await fixture();
  t.after(() => Promise.all([initial.close(), f.close()]));
  const source = 'synthetic-jira-refresh';
  const row = (id: string, key: string, updated: string, title: string, fields: Record<string, unknown>) => ({ id, key, fields: {
    project: { id: '10100', key: 'HIST', name: '팀 Jira' }, created: '2020-01-01T00:00:00Z', updated, summary: title,
    issuetype: { id: '3', name: 'Task' }, ...fields,
  } });
  const upload = (target: MigrationFixture, name: string, rows: ReturnType<typeof row>[]) =>
    target.upload(Buffer.from(JSON.stringify({ issues: rows })), `${name}.json`, 'jira', source);
  const open = { id: '1', name: 'Open' }, completed = { id: '2', name: 'Done' };
  const initialPack = await upload(initial, 'jira-old-baseline', [
    row('100', 'HIST-1', '2020-01-02T00:00:00Z', '원래 Jira 제목', {
      description: '원본 설명', status: open, priority: { name: 'Medium' }, labels: ['old'], duedate: '2020-01-15',
    }),
    row('200', 'HIST-2', '2020-01-02T00:00:00Z', '완료 상태의 원본 업무', { status: completed }),
  ]);
  const first = await initial.apply(await initial.preview(await initial.configuration(initialPack, 'SYNC')));
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const [projectId] = first.data.import.projectIds;
  type Backup = WorkspaceSnapshot & { schemaVersion: number; sourceRecords: SourceRecordArchive[]; sourceImports: SourceImport[]; reportingLedger: ReportingLedgerData };
  // Exercise a real upgrade with no refresh checkpoints or staging files available on the destination.
  const previous = historicalMigrationBackup((await initial.call<Backup>('/export')).data, 38);
  for (const receipt of previous.sourceImports) delete receipt.integrity;
  for (const record of previous.sourceRecords) delete record.jiraIssueFieldHashes;
  const oldTicket = previous.issues.find(issue => issue.key === 'SYNC-1');
  assert.ok(oldTicket);
  // Older REST imports retained duedate in the source archive and stored an empty canonical deadline.
  oldTicket.dueDate = null;
  const upgraded = await f.call('/import', 'POST', { data: previous });
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.data));
  const snapshot = () => f.call<WorkspaceSnapshot>('/workspace').then(result => result.data);
  const currentTicket = async (key: string) => (await snapshot()).issues.find(ticket => ticket.key === key)!;
  const ticket = await currentTicket('SYNC-1');
  assert.equal(ticket.dueDate, null);
  const local = await f.call<Issue>(`/issues/${ticket.id}`, 'PATCH', {
    expectedVersion: ticket.version, title: '팀이 수정한 제목', description: '팀이 수정한 본문',
  });
  assert.equal(local.status, 200, JSON.stringify(local.data));

  const delta = await upload(f, 'jira-delta', [row('100', 'HIST-1', '2020-01-03T00:00:00Z', 'Jira에서 변경한 제목', {
    status: completed, priority: { id: '4', name: 'High' }, labels: [], duedate: '2020-01-29',
  })]);
  async function reviewConfig(pkg: LegacyPackageSummary, workspace = f) {
    const options = (await workspace.call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`)).data;
    const target = options.appendTarget;
    assert.ok(target);
    return { ...options.defaultConfiguration, appendTo: {
      projectId, refreshExisting: true as const,
      statuses: Object.fromEntries(options.statuses.filter(option => option.sourceValue !== '__unspecified__')
        .map(option => [option.id, target.statuses.find(status => status.label === option.label)!.id])),
      issueTypes: Object.fromEntries(options.issueTypes.map(option => [option.id, target.issueTypes.find(type => type.name === option.label)!.id])),
      fields: {},
    } };
  }
  const config = await reviewConfig(delta);
  const appendOnly = structuredClone(config) as MigrationConfiguration;
  delete appendOnly.appendTo?.refreshExisting;
  assert.equal((await f.preview(appendOnly)).canApply, false);
  assert.equal((await f.call('/migrations/preview', 'POST', { configuration: { ...config, appendTo: { ...config.appendTo, refreshExisting: false } } })).status, 400);

  const path = `/projects/${projectId}/workflow`;
  const workflow = (await f.call<ProjectWorkflow>(path)).data;
  const doneId = workflow.statuses.find(status => status.category === 'done')!.id;
  const locked = await f.call<ProjectWorkflow>(path, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    transitions: workflow.transitions.filter(edge => edge.from !== ticket.status || edge.to !== doneId),
  });
  assert.equal(locked.status, 200, JSON.stringify(locked.data));
  const blocked = await f.preview(config);
  assert.equal(blocked.canApply, false, JSON.stringify(blocked.notices));
  assert.ok(blocked.notices.some(notice => notice.code === 'JIRA_REFRESH_VALIDATION' && notice.message.includes('SYNC-1')));
  assert.equal((await f.apply(blocked)).status, 409);
  assert.equal((await f.call(path, 'PATCH', { ...workflow, expectedVersion: locked.data.version })).status, 200);

  const earlier = await f.preview(config);
  assert.equal(earlier.canApply, true, JSON.stringify(earlier.notices));
  const reviewRow = earlier.issueRefresh?.find(item => item.issueId === ticket.id);
  assert.ok(reviewRow);
  assert.equal(reviewRow.sourceKey, 'HIST-1');
  assert.deepEqual(Object.fromEntries(reviewRow.fields.map(item => [item.field, item.decision])), {
    title: 'conflict', status: 'apply', priority: 'apply', labels: 'apply', dueDate: 'apply',
  });
  const freshEdit = await f.call<Issue>(`/issues/${ticket.id}`, 'PATCH', { expectedVersion: local.data.version, description: '검토 뒤 다시 편집한 본문' });
  assert.equal(freshEdit.status, 200);
  assert.equal((await f.apply(earlier)).status, 409);
  assert.equal((await currentTicket('SYNC-1')).priority, 'medium');
  const reviewed = await f.preview(config);
  assert.equal(reviewed.canApply, true, JSON.stringify(reviewed.notices));
  assert.equal(reviewed.counts.issues, 0);
  assert.equal(reviewed.counts.updatedIssues, 1);
  assert.equal(reviewed.counts.updatedFields, 4);
  assert.equal(reviewed.counts.conflictingFields, 1);
  f.db.exec(`CREATE TRIGGER fail_jira_refresh_receipt BEFORE INSERT ON source_imports
    BEGIN SELECT RAISE(ABORT, 'synthetic Jira refresh receipt failure'); END`);
  try { assert.equal((await f.apply(reviewed)).status, 500); }
  finally { f.db.exec('DROP TRIGGER fail_jira_refresh_receipt'); }
  assert.deepEqual(await currentTicket('SYNC-1'), freshEdit.data);
  const afterFailure = (await f.call<Backup>('/export')).data;
  assert.equal(afterFailure.reportingLedger.events.some(event => event.kind === 'changed' && event.origin === 'import' && event.issueId === ticket.id), false);
  const result = await f.apply(reviewed);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal((await f.apply(reviewed)).data.duplicate, true);
  const refreshed = await currentTicket('SYNC-1');
  assert.equal(refreshed.id, ticket.id);
  assert.equal(refreshed.version, freshEdit.data.version + 1);
  assert.equal(refreshed.title, '팀이 수정한 제목');
  assert.equal(refreshed.description, '검토 뒤 다시 편집한 본문');
  assert.equal(refreshed.priority, 'high');
  assert.equal(refreshed.status, doneId);
  assert.ok(refreshed.completedAt);
  assert.equal(refreshed.dueDate, '2020-01-29');
  assert.deepEqual(refreshed.labels, []);
  const backup = (await f.call<Backup>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.ok(backup.reportingLedger.events.some(event => event.origin === 'import' && event.kind === 'changed' && event.issueId === ticket.id && event.after?.statusId === doneId));
  const checkpoint = backup.sourceRecords.find(record => record.sourceImportId === result.data.import.id && record.targetId === ticket.id);
  assert.ok(checkpoint?.jiraIssueFieldHashes?.priority);
  assert.ok(checkpoint.jiraIssueFieldHashes.title);
  assert.ok(checkpoint.jiraIssueSourceFieldHashes?.title);
  assert.ok(checkpoint.jiraIssueSourceFieldHashes.status);
  assert.equal((await f.call('/import', 'POST', { data: historicalMigrationBackup(backup, 38) })).status, 400);
  assert.equal((await f.call('/import', 'POST', { data: historicalMigrationBackup(backup, 97) })).status, 400);
  const malformedCheckpoint = { ...checkpoint, jiraIssueSourceFieldHashes: { title: ['a'.repeat(64), 'b'.repeat(64)] } };
  const malformed = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup,
    sourceRecords: backup.sourceRecords.map(record => record.id === checkpoint.id ? malformedCheckpoint : record),
  } });
  assert.equal(malformed.status, 400);
  assert.match(malformed.data.error, /Jira 원본 필드 기준의 형식/);
  const restored = await f.call('/import', 'POST', { data: backup });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal((await f.preview(config)).canApply, false);

  const newerRows = [
    row('100', 'HIST-1', '2020-01-04T00:00:00Z', 'Jira에서 변경한 제목', { priority: { name: 'Low' } }),
    row('300', 'HIST-3', '2020-01-04T00:00:00Z', '함께 이관하는 새 Jira 업무', { status: open }),
  ];
  const legacy = historicalMigrationBackup(backup, 97);
  for (const record of legacy.sourceRecords) {
    delete record.jiraIssueSourceFieldHashes;
    if (record.jiraIssueFieldHashes) delete record.jiraIssueFieldHashes.parentId;
  }
  delete legacy.sourceImports.find(receipt => receipt.id === result.data.import.id)!.integrity;
  // Older administrator XML represented the priority as an option ID and stored its name in a separate record.
  const archivedFields = legacy.sourceRecords.find(record => record.id === checkpoint.id)!.record.metadata.fields;
  assert.ok(archivedFields && typeof archivedFields === 'object' && !Array.isArray(archivedFields));
  archivedFields.priority = '4';
  const legacyWorkspace = await fixture();
  t.after(() => legacyWorkspace.close());
  const restoredLegacy = await legacyWorkspace.call('/import', 'POST', { data: legacy });
  assert.equal(restoredLegacy.status, 200, JSON.stringify(restoredLegacy.data));
  const legacyDelta = await upload(legacyWorkspace, 'jira-legacy-follow-up', [
    row('100', 'HIST-1', '2020-01-04T00:00:00Z', 'Jira에서 변경한 제목', { priority: { id: '4', name: 'Low' } }), newerRows[1],
  ]);
  const legacyReview = await legacyWorkspace.preview(await reviewConfig(legacyDelta, legacyWorkspace));
  assert.deepEqual(legacyReview.issueRefresh?.find(item => item.issueId === ticket.id)?.fields.map(item => [item.field, item.decision]), [
    ['title', 'conflict'],
  ]);

  const newer = await upload(f, 'jira-follow-up', newerRows);
  const followUp = await f.preview(await reviewConfig(newer));
  assert.equal(followUp.canApply, true, JSON.stringify(followUp.notices));
  assert.equal(followUp.counts.issues, 1);
  assert.equal(followUp.counts.updatedFields, 1);
  assert.equal(followUp.counts.conflictingFields, 1);
  assert.deepEqual(followUp.issueRefresh?.find(item => item.issueId === ticket.id)?.fields.map(item => [item.field, item.decision]), [
    ['title', 'conflict'], ['priority', 'apply'],
  ]);
  const followUpReceipt = await f.apply(followUp);
  assert.equal(followUpReceipt.status, 201, JSON.stringify(followUpReceipt.data));
  const afterFollowUp = await currentTicket('SYNC-1');
  assert.equal(afterFollowUp.priority, 'low');
  assert.equal(afterFollowUp.title, '팀이 수정한 제목');
  assert.equal((await currentTicket('SYNC-3')).title, '함께 이관하는 새 Jira 업무');
  const followUpBackup = (await f.call<Backup>('/export')).data;
  const followUpCheckpoint = followUpBackup.sourceRecords.find(record => record.sourceImportId === followUpReceipt.data.import.id && record.targetId === ticket.id);
  assert.deepEqual(followUpCheckpoint?.jiraIssueSourceFieldHashes?.title, checkpoint.jiraIssueSourceFieldHashes.title);
  assert.deepEqual(followUpCheckpoint?.jiraIssueSourceFieldHashes?.status, checkpoint.jiraIssueSourceFieldHashes.status);
  assert.equal((await f.apply(followUp)).data.duplicate, true);
  const reverted = await f.call<Issue>(`/issues/${ticket.id}`, 'PATCH', { expectedVersion: afterFollowUp.version, title: '원래 Jira 제목' });
  assert.equal(reverted.status, 200, JSON.stringify(reverted.data));
  const repeated = await f.apply(followUp);
  assert.equal(repeated.data.duplicate, true);
  assert.equal(repeated.data.import.id, followUpReceipt.data.import.id);
  assert.equal((await currentTicket('SYNC-1')).title, '원래 Jira 제목');

  const newest = await upload(f, 'jira-title-conflict-resolved', [
    row('100', 'HIST-1', '2020-01-05T00:00:00Z', 'Jira에서 변경한 제목', { status: completed, priority: { name: 'Low' } }),
  ]);
  const newestConfig = await reviewConfig(newest);
  // A sparse intervening export omitted the status. Mapping the same raw Jira status differently still preserves its accepted value.
  newestConfig.appendTo.statuses = Object.fromEntries(Object.keys(newestConfig.appendTo.statuses).map(id => [id, ticket.status]));
  const resolved = await f.preview(newestConfig);
  assert.equal(resolved.canApply, true, JSON.stringify(resolved.notices));
  assert.deepEqual(resolved.issueRefresh?.find(item => item.issueId === ticket.id)?.fields.map(item => [item.field, item.decision]), [['title', 'apply']]);
  assert.equal((await f.apply(resolved)).status, 201);
  assert.equal((await currentTicket('SYNC-1')).title, 'Jira에서 변경한 제목');
  assert.equal((await currentTicket('SYNC-1')).status, doneId);
  assert.equal((await f.preview(config)).canApply, false);
  const next = await f.call<Issue>('/issues', 'POST', { projectId, title: '이관으로 번호가 소비되지 않는 팀 업무' });
  assert.equal(next.status, 201, JSON.stringify(next.data));
  assert.equal(next.data.key, 'SYNC-4');
});

test('Jira custom field refresh survives a legacy restore and advances independently of standard fields', async t => {
  const origin = await fixture(), target = await fixture();
  t.after(() => Promise.all([origin.close(), target.close()]));
  const names = { customfield_100: '리스크', customfield_101: '기존 점수', customfield_102: '승인', customfield_103: '누락할 메모', customfield_104: '승인 점수' };
  const kinds = { customfield_100: 'text', customfield_101: 'number', customfield_102: 'checkbox', customfield_103: 'text', customfield_104: 'number' } as const;
  const upload = (f: MigrationFixture, name: string, day: number, description: string, customFields: Record<string, unknown>) => {
    const issue = { id: '500', key: 'ORIG-1', fields: { project: { id: '10100', key: 'ORIG', name: '팀 Jira' },
      summary: '팀 티켓', description, created: '2020-07-01T00:00:00Z', updated: `2020-07-0${day}T00:00:00Z`,
      issuetype: { id: '3', name: 'Task' }, status: { id: '1', name: 'Open' }, ...customFields } };
    return f.upload(Buffer.from(JSON.stringify({ names, issues: [issue] })), `${name}.json`, 'jira', 'synthetic-jira-custom-refresh');
  };
  const baseline = await upload(origin, 'jira-custom-initial', 2, '최초 설명', {
    customfield_100: '중간', customfield_101: 3, customfield_102: false, customfield_103: '계속 유지', customfield_104: 9,
  });
  const initialConfig = await origin.configuration(baseline, 'CUST');
  const initialOptions = (await origin.call<MigrationOptions>(`/migrations/options?packageId=${baseline.id}`)).data;
  for (const field of initialOptions.fields) initialConfig.fields[field.id] = kinds[field.sourceValue as keyof typeof kinds];
  const first = await origin.apply(await origin.preview(initialConfig));
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const [projectId] = first.data.import.projectIds;
  type Backup = WorkspaceSnapshot & { schemaVersion: number; sourceRecords: SourceRecordArchive[]; sourceImports: SourceImport[] };
  const old = historicalMigrationBackup((await origin.call<Backup>('/export')).data, 42);
  const seeded = old.sourceRecords.find(row => row.record.kind === 'issue' && row.targetType === 'issue');
  assert.equal(Object.keys(seeded?.jiraCustomFieldHashes ?? {}).length, 5);
  for (const row of old.sourceRecords) {
    delete row.jiraCustomFieldHashes;
    if (row.jiraIssueFieldHashes) delete row.jiraIssueFieldHashes.parentId;
  }
  for (const receipt of old.sourceImports) delete receipt.integrity;
  assert.equal((await target.call('/import', 'POST', { data: old })).status, 200);

  const ticket = async () => (await target.call<WorkspaceSnapshot>('/workspace')).data.issues.find(row => row.projectId === projectId)!;
  const schemaPath = `/projects/${projectId}/issue-schema`;
  const schema = (await target.call<ProjectIssueSchema>(schemaPath)).data;
  const ids = Object.fromEntries(schema.fields.map(field => [field.name, field.id]));
  const [risk, score, approval, omitted, conditional] = Object.values(names).map(name => ids[name]);
  const changedSchema = await target.call(schemaPath, 'PATCH', { ...schema, expectedVersion: schema.version, fields: schema.fields.map(field =>
    field.id === conditional ? { ...field, visibleWhen: { statusIds: [], fieldMatch: { fieldId: approval, value: true } } } : field) });
  assert.equal(changedSchema.status, 200, JSON.stringify(changedSchema.data));
  const initial = await ticket();
  assert.deepEqual(initial.customFields, { [risk]: '중간', [score]: 3, [approval]: false, [omitted]: '계속 유지', [conditional]: 9 });
  const local = await target.call<Issue>(`/issues/${initial.id}`, 'PATCH', { expectedVersion: initial.version,
    customFields: { ...initial.customFields, [risk]: '팀에서 결정한 리스크' } });
  assert.equal(local.status, 200, JSON.stringify(local.data));
  const delta = await upload(target, 'jira-custom-delta', 3, '첫 변경 설명', {
    customfield_100: 'Jira에서 변경한 리스크', customfield_101: null, customfield_102: true, customfield_104: 0,
  });
  async function settings(pkg: LegacyPackageSummary, kind: 'standard' | 'custom'): Promise<MigrationConfiguration> {
    const options = (await target.call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`)).data;
    const append = options.appendTarget;
    assert.equal(append?.projectId, projectId);
    return { ...options.defaultConfiguration, appendTo: { projectId,
      ...(kind === 'standard' ? { refreshExisting: true } : { refreshCustomFields: true }),
      statuses: Object.fromEntries(options.statuses.map(option => [option.id, append!.statuses.find(status => status.label === option.label)!.id])),
      issueTypes: Object.fromEntries(options.issueTypes.map(option => [option.id, append!.issueTypes.find(type => type.name === option.label)!.id])),
      fields: Object.fromEntries(options.fields.map(option => [option.id, ids[option.label] ?? null])),
    } };
  }
  const standard = await target.preview(await settings(delta, 'standard'));
  assert.equal(standard.canApply, true, JSON.stringify(standard.notices));
  assert.equal((await target.apply(standard)).status, 201);
  assert.deepEqual((await ticket()).customFields, local.data.customFields);

  const customConfig = await settings(delta, 'custom');
  const invalid = await target.call('/migrations/preview', 'POST', { configuration: {
    ...customConfig, appendTo: { ...customConfig.appendTo, refreshCustomFields: false },
  } });
  assert.equal(invalid.status, 400);
  const review = await target.preview(customConfig);
  assert.equal(review.canApply, true, JSON.stringify(review.notices));
  assert.equal(review.counts.issues, 0);
  assert.equal(review.counts.updatedCustomFields, 3);
  assert.equal(review.counts.conflictingCustomFields, 1);
  assert.deepEqual(review.issueRefresh?.[0].fields, []);
  assert.deepEqual(Object.fromEntries(review.issueRefresh?.[0].customFields?.map(field => [field.fieldId, field.decision]) ?? []), {
    [risk]: 'conflict', [score]: 'apply', [approval]: 'apply', [conditional]: 'apply',
  });
  const afterStandard = await ticket();
  target.db.exec(`CREATE TRIGGER fail_jira_custom_receipt BEFORE INSERT ON source_imports
    BEGIN SELECT RAISE(ABORT, 'synthetic Jira custom receipt failure'); END;`);
  try { assert.equal((await target.apply(review)).status, 500); }
  finally { target.db.exec('DROP TRIGGER fail_jira_custom_receipt'); }
  assert.deepEqual(await ticket(), afterStandard);
  const stale = await target.preview(customConfig);
  const applied = await target.apply(review);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.equal((await target.apply(review)).data.duplicate, true);
  assert.equal((await target.apply(stale)).status, 409);
  assert.equal((await ticket()).description, '첫 변경 설명');
  assert.deepEqual((await ticket()).customFields, { [risk]: '팀에서 결정한 리스크', [score]: null, [approval]: true, [omitted]: '계속 유지', [conditional]: 0 });

  const backup = (await target.call<Backup>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const checkpoint = backup.sourceRecords.find(row => row.sourceImportId === applied.data.import.id && row.targetType === 'issue');
  assert.ok(checkpoint?.jiraCustomFieldHashes?.[score]);
  assert.equal(checkpoint.jiraIssueFieldHashes, undefined);
  assert.equal((await target.call('/import', 'POST', { data: historicalMigrationBackup(backup, 42) })).status, 400);
  assert.equal((await target.call('/import', 'POST', { data: backup })).status, 200);
  assert.equal((await target.preview(customConfig)).canApply, false);

  const newer = await upload(target, 'jira-custom-follow-up', 4, '두 번째 변경 설명', { customfield_101: 7 });
  const nextCustom = await target.preview(await settings(newer, 'custom'));
  assert.equal(nextCustom.canApply, true, JSON.stringify(nextCustom.notices));
  assert.equal(nextCustom.counts.updatedCustomFields, 1);
  assert.equal((await target.apply(nextCustom)).status, 201);
  assert.equal((await ticket()).customFields?.[score], 7);
  assert.equal((await ticket()).description, '첫 변경 설명');
  const nextStandard = await target.preview(await settings(newer, 'standard'));
  assert.equal(nextStandard.canApply, true, JSON.stringify(nextStandard.notices));
  assert.equal((await target.apply(nextStandard)).status, 201);
  assert.equal((await ticket()).description, '두 번째 변경 설명');
  assert.equal((await ticket()).customFields?.[score], 7);

  const latestSchema = (await target.call<ProjectIssueSchema>(schemaPath)).data;
  assert.equal((await target.call(schemaPath, 'PATCH', { ...latestSchema, expectedVersion: latestSchema.version,
    fields: latestSchema.fields.map(field => field.id === score ? { ...field, required: true } : field),
  })).status, 200);
  const missing = await upload(target, 'jira-required-field-clear', 5, '필수값 검증', { customfield_101: null });
  const blocked = await target.preview(await settings(missing, 'custom'));
  assert.equal(blocked.canApply, false);
  assert.ok(blocked.notices.some(notice => notice.code === 'JIRA_REFRESH_VALIDATION' && notice.message.includes(names.customfield_101)));
  assert.equal((await ticket()).customFields?.[score], 7);

  const both = await upload(target, 'jira-combined-refresh', 5, '함께 적용한 설명', { customfield_101: 8 });
  const bothConfig = await settings(both, 'custom');
  bothConfig.appendTo!.refreshExisting = true;
  const combined = await target.preview(bothConfig);
  const beforeCombined = await ticket();
  assert.equal(combined.canApply, true, JSON.stringify(combined.notices));
  assert.equal(combined.counts.updatedFields, 1);
  assert.equal(combined.counts.updatedCustomFields, 1);
  assert.equal((await target.apply(combined)).status, 201);
  const afterCombined = await ticket();
  assert.equal(afterCombined.version, beforeCombined.version + 1);
  assert.equal(afterCombined.description, '함께 적용한 설명');
  assert.equal(afterCombined.customFields?.[score], 8);
});

test('Jira history append preserves local and deleted records and restores exact source seconds from backup', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const source = 'synthetic-jira-history';
  const author = { accountId: 'source-author', displayName: 'Jira 원본 작성자' };
  const date = '2020-08-01T00:00:00Z';
  const comment = (id: string | undefined, body: string) => ({ id, body, author, created: date });
  const worklog = (id: string | undefined, note: string, seconds: number) => ({ id, comment: note, author, started: date, timeSpentSeconds: seconds });
  const upload = (name: string, summary: string, comments: object[], worklogs: object[]) => f.upload(Buffer.from(JSON.stringify({ issues: [{ id: '100', key: 'OLD-1', fields: {
    project: { id: '42', key: 'OLD', name: '이전 Jira' }, summary, created: date, updated: date,
    issuetype: { id: '3', name: 'Task' }, status: { id: '1', name: 'Open' }, comment: { comments }, worklog: { worklogs },
  } }] })), `${name}.json`, 'jira', source);
  const original = await upload('jira-history-initial', '최초 제목', [comment('300', '삭제할 원본 댓글'), comment('301', '계속 남길 원본 댓글')],
    [worklog('400', '삭제할 원본 시간', 61), worklog('401', '수정할 원본 시간', 73)]);
  const initial = await f.apply(await f.preview(await f.configuration(original, 'JHIST')));
  assert.equal(initial.status, 201, JSON.stringify(initial.data));
  const [projectId] = initial.data.import.projectIds;
  const ticket = async () => (await f.call<WorkspaceSnapshot>('/workspace')).data.issues.find(issue => issue.projectId === projectId)!;
  const { id, version } = await ticket();
  const worklogsPath = `/issues/${id}/worklogs`;
  const readWorklogs = () => f.call<IssueWorklogPage>(worklogsPath).then(result => result.data);
  const readComments = () => f.call<IssueCommentView[]>(`/comments?resourceType=issue&resourceId=${id}`).then(result => result.data);
  const removedComment = (await readComments()).find(row => row.body === '삭제할 원본 댓글')!;
  const removed = await f.call<{trashItemId: string}>(`/comments/${removedComment.id}`, 'DELETE', undefined, removedComment.authorId);
  assert.equal(removed.status, 200);
  assert.equal((await f.call(`/trash/items/${removed.data.trashItemId}`, 'DELETE', undefined, removedComment.authorId)).status, 200);
  const beforeWorklogs = (await readWorklogs()).entries;
  const removedWorklog = beforeWorklogs.find(row => row.note === '삭제할 원본 시간')!;
  const correctedWorklog = beforeWorklogs.find(row => row.note === '수정할 원본 시간')!;
  assert.equal((await f.call(`${worklogsPath}/${removedWorklog.id}`, 'DELETE', { expectedVersion: removedWorklog.version }, 'user-jun')).status, 200);
  const corrected = await f.call<WorklogEntry>(`${worklogsPath}/${correctedWorklog.id}`, 'PATCH', {
    expectedVersion: correctedWorklog.version, note: '팀에서 수정한 작업 메모',
  }, 'user-jun');
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  const localWorklog = await f.call<WorklogEntry>(worklogsPath, 'POST', { requestId: randomUUID(), workDate: '2020-08-02', minutes: 12, note: '팀 수동 작업 시간' });
  assert.equal(localWorklog.status, 201);
  const localComment = await f.call<Comment>('/comments', 'POST', { resourceType: 'issue', resourceId: id, body: '팀 수동 댓글' });
  assert.equal(localComment.status, 201);
  const expectedComments = await readComments();
  const expectedTimes = await readWorklogs();

  const addedLink = 'https://ci.example.test/project/jobs/310?artifact=report.';
  const addedSourceBody = `[추가할 원본 댓글|${addedLink}]`;
  const delta = await upload('jira-history-delta', 'Jira에서 바꾼 제목', [
    comment('300', '삭제된 원본 댓글'), comment('301', '기존 원본 댓글 변경'), comment('310', addedSourceBody),
    comment(undefined, '안정적인 ID가 없는 원본 댓글'), { ...comment('311', '팀 제한 원본 댓글'), visibility: {},
      properties: [{ key: 'sd.public.comment', value: { internal: true } }] },
    { ...comment('312', '작성자가 없는 원본 댓글'), author: null },
  ], [worklog('400', '삭제된 원본 시간', 111), worklog('401', '기존 원본 메모 변경', 121), worklog('410', '추가할 원본 작업 시간', 91),
    worklog(undefined, '안정적인 ID가 없는 원본 시간', 83), { ...worklog('411', '팀 제한 원본 시간', 71), groupLevel: 'private' }]);
  async function historySettings(pkg: LegacyPackageSummary): Promise<MigrationConfiguration> {
    const options = (await f.call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`)).data;
    const target = options.appendTarget;
    assert.equal(target?.projectId, projectId);
    return { ...options.defaultConfiguration,
      users: Object.fromEntries(options.identities.map(identity => [identity.id, 'user-jun'])),
      appendTo: { projectId, refreshHistory: true,
        statuses: Object.fromEntries(options.statuses.map(option => [option.id, target!.statuses.find(status => status.label === option.label)!.id])),
        issueTypes: Object.fromEntries(options.issueTypes.map(option => [option.id, target!.issueTypes.find(type => type.name === option.label)!.id])),
        fields: {},
      },
    };
  }
  const config = await historySettings(delta);
  const defaultOnly = structuredClone(config);
  delete defaultOnly.appendTo?.refreshHistory;
  assert.equal((await f.preview(defaultOnly)).canApply, false);
  const plan = await f.preview(config);
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.equal(plan.counts.issues, 0);
  assert.equal(plan.counts.newJiraComments, 1);
  assert.equal(plan.counts.newJiraWorklogs, 1);
  const stale = await f.preview(config);
  const edit = await f.call<Issue>(`/issues/${id}`, 'PATCH', { expectedVersion: version, title: '검토 중 팀에서 편집한 제목' });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  f.db.exec(`CREATE TRIGGER fail_jira_history_receipt BEFORE INSERT ON source_imports
    BEGIN SELECT RAISE(ABORT, 'synthetic Jira history receipt failure'); END;`);
  try { assert.equal((await f.apply(plan)).status, 500); }
  finally { f.db.exec('DROP TRIGGER fail_jira_history_receipt'); }
  assert.deepEqual(await readComments(), expectedComments);
  assert.deepEqual(await readWorklogs(), expectedTimes);
  const applied = await f.apply(plan);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.equal((await f.apply(plan)).data.duplicate, true);
  assert.equal((await f.apply(stale)).status, 409);
  assert.deepEqual(await ticket(), edit.data);
  const comments = await readComments();
  const addedComment = comments.find(row => row.body === `추가할 원본 댓글 <${addedLink}>`)!;
  assert.equal(addedComment.authorId, 'user-jun');
  assert.equal(addedComment.jiraOriginalLinksAvailable, true);
  assert.ok(comments.filter(row => row.id !== addedComment.id).every(row => !Object.hasOwn(row, 'jiraOriginalLinksAvailable')));
  assert.deepEqual(comments.filter(row => row.id !== addedComment.id), expectedComments);

  const originalLinks = async (commentId: string, status: number) => {
    const response = await fetch(`${f.base}/comments/${commentId}/jira-original-links`);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    if (status === 404) {
      assert.ok(body && typeof body === 'object');
      assert.deepEqual(Object.keys(body), ['error']);
    }
    return body;
  };
  const expectedLinks = { links: [{ label: '추가할 원본 댓글', href: addedLink }], limited: false };
  assert.deepEqual(await originalLinks(addedComment.id, 200), expectedLinks);
  for (const missingId of [randomUUID(), removedComment.id, localComment.data.id]) await originalLinks(missingId, 404);

  const { json: originalArchiveJson } = f.db.prepare(`SELECT json FROM source_records WHERE target_type='comment' AND target_id=?`)
    .get(addedComment.id) as { json: string };
  const sourceArchive = JSON.parse(originalArchiveJson) as SourceRecordArchive;
  const expectHiddenLinks = async () => {
    await originalLinks(addedComment.id, 404);
    assert.equal((await readComments()).find(row => row.id === addedComment.id)?.jiraOriginalLinksAvailable, undefined);
  };
  const duplicate = randomUUID();
  f.db.prepare(`INSERT INTO source_records(id,import_id,owner_type,owner_id,target_type,target_id,kind,source_instance,product,source_id,json)
    SELECT ?,import_id,owner_type,owner_id,target_type,target_id,kind,source_instance,product,source_id,json_set(json,'$.id',?)
    FROM source_records WHERE id=?`).run(duplicate, duplicate, sourceArchive.id);
  try { await expectHiddenLinks(); }
  finally { f.db.prepare('DELETE FROM source_records WHERE id=?').run(duplicate); }
  const foreign = (await f.call<WorkspaceSnapshot>('/workspace')).data.issues.find(issue => issue.id !== id)!;
  const updateArchived = f.db.prepare('UPDATE source_records SET json=? WHERE id=?');
  for (const invalid of [
    { ...sourceArchive, ownerId: foreign.id },
    { ...sourceArchive, record: { ...sourceArchive.record, containerId: '999', references: [{ kind: 'issue', sourceId: '999', relation: 'commentOn' }] } },
    { ...sourceArchive, record: { ...sourceArchive.record, metadata: { ...sourceArchive.record.metadata, roleLevel: 'private' } } },
  ]) {
    updateArchived.run(JSON.stringify(invalid), sourceArchive.id);
    try { await expectHiddenLinks(); }
    finally { updateArchived.run(originalArchiveJson, sourceArchive.id); }
  }
  const archivedComment = await f.call<{ trashItemId: string }>(`/comments/${addedComment.id}`, 'DELETE', undefined, addedComment.authorId);
  assert.equal(archivedComment.status, 200);
  await originalLinks(addedComment.id, 404);
  assert.equal((await readComments()).some(row => row.id === addedComment.id), false);
  assert.equal((await f.call(`/trash/items/${archivedComment.data.trashItemId}/restore`, 'POST', undefined, addedComment.authorId)).status, 200);
  assert.deepEqual(await originalLinks(addedComment.id, 200), expectedLinks);

  const times = await readWorklogs();
  const addedTime = times.entries.find(row => row.note === '추가할 원본 작업 시간')!;
  assert.equal(addedTime.authorId, 'user-jun');
  assert.equal(addedTime.durationSeconds, 91);
  assert.equal(addedTime.issueTitle, edit.data.title);
  assert.equal(times.totalMinutes, (12 * 60 + 73 + 91) / 60);
  assert.deepEqual(times.entries.filter(row => row.id !== addedTime.id), expectedTimes.entries);
  assert.equal((await f.preview(config)).canApply, false);

  type Backup = WorkspaceSnapshot & {schemaVersion: number; comments: Comment[]; sourceRecords: SourceRecordArchive[]};
  const backup = (await f.call<Backup>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(backup.sourceRecords.filter(row => row.jiraHistoryAppend).map(row => row.record.sourceId).sort(), ['310', 'worklog:410']);
  assert.equal(backup.sourceRecords.find(row => row.jiraHistoryAppend && row.targetId === addedComment.id)?.record.text, addedSourceBody);
  const storedComment = backup.comments.find(row => row.id === addedComment.id)!;
  assert.equal(storedComment.body, addedComment.body);
  assert.equal(Object.hasOwn(storedComment, 'jiraOriginalLinksAvailable'), false);
  assert.equal((await f.call('/import', 'POST', { data: historicalMigrationBackup(backup, 43) })).status, 400);
  assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
  assert.deepEqual(await readComments(), comments);
  assert.deepEqual(await originalLinks(addedComment.id, 200), expectedLinks);
  assert.deepEqual((await readWorklogs()).entries.map(row => row.id), times.entries.map(row => row.id));
  assert.equal((await f.preview(config)).canApply, false);

  const sparseLink = 'https://gitlab.example.test/team/repo/-/merge_requests/320';
  const sparseXml = '<entity-engine-xml><Action id="320" issue="100" author="source-author" type="comment" ' +
    `created="2020-08-03T00:00:00Z" body="[티켓 객체가 빠진 추가 댓글|${sparseLink}]"/>` +
    '<Worklog id="420" issue="100" author="source-author" startdate="2020-08-03T00:00:00Z" timeworked="97" body="티켓 객체가 빠진 작업 시간"/>' +
    '</entity-engine-xml>';
  const sparse = await f.upload(Buffer.from(sparseXml), 'jira-sparse-history.xml', 'jira', source);
  const sparsePlan = await f.preview(await historySettings(sparse));
  assert.equal(sparsePlan.canApply, true, JSON.stringify(sparsePlan.notices));
  assert.equal(sparsePlan.counts.newJiraComments, 1);
  assert.equal(sparsePlan.counts.newJiraWorklogs, 1);
  assert.equal((await f.apply(sparsePlan)).status, 201);
  const sparseComment = (await readComments()).find(row => row.body === `티켓 객체가 빠진 추가 댓글 <${sparseLink}>`)!;
  assert.equal(sparseComment.jiraOriginalLinksAvailable, true);
  assert.deepEqual(await originalLinks(sparseComment.id, 200), {
    links: [{ label: '티켓 객체가 빠진 추가 댓글', href: sparseLink }], limited: false,
  });
  assert.equal((await readWorklogs()).entries.find(row => row.note === '티켓 객체가 빠진 작업 시간')?.durationSeconds, 97);

});

test('Jira attachment append adds exact new source bytes while preserving team versions and deletion history', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const source = 'synthetic-jira-file-append';
  const date = '2020-09-01T00:00:00Z';
  const originalBytes = Buffer.from('Jira 최초 파일\x00\r\n');
  const removedBytes = Buffer.from('처음 옮겼다가 삭제한 파일');
  const newBytes = Buffer.from('같은 이름의 새 Jira 파일\x00🙂');
  const manualBytes = Buffer.from('팀에서 직접 올린 최신 버전');
  const movedBytes = Buffer.from('원본 ID는 같지만 다른 바이트');
  const attachment = (id: string, filename: string, size: number, extra = '') =>
    `<FileAttachment id="${id}" issue="100" filename="${filename}" filesize="${size}" author="old-author" created="${date}" ${extra}/>`;
  const primary = `<Project id="42" pkey="OLD" name="Jira 파일 프로젝트"/><Status id="1" pname="Open"/><IssueType id="3" pname="Task"/>` +
    `<Issue id="100" project="42" number="1" summary="원본 파일 티켓" status="1" issuetype="3" created="${date}" updated="${date}"/>`;
  const upload = (name: string, rows: string[], files: [string, Buffer][], includeIssue = true) => f.upload(zip([
    { path: 'entities.xml', bytes: Buffer.from(`<entity-engine-xml>${includeIssue ? primary : ''}${rows.join('')}</entity-engine-xml>`) },
    ...files.map(([id, bytes]) => ({ path: `attachments/OLD/OLD-1/${id}`, bytes })),
  ]), `${name}.zip`, 'jira', source);
  const initialPack = await upload('jira-files-initial', [attachment('700', 'report.bin', originalBytes.length), attachment('710', 'removed.bin', removedBytes.length)],
    [['700', originalBytes], ['710', removedBytes]]);
  const first = await f.apply(await f.preview(await f.configuration(initialPack, 'JAFT')));
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const [projectId] = first.data.import.projectIds;
  const ticket = async () => (await f.call<WorkspaceSnapshot>('/workspace')).data.issues.find(issue => issue.projectId === projectId)!;
  const issue = await ticket();
  const list = () => f.call<AttachmentHead[]>(`/attachments?resourceType=issue&resourceId=${issue.id}`).then(result => result.data);
  const initialFiles = await list();
  const anchor = initialFiles.find(file => file.filename === 'report.bin')!;
  const deleted = initialFiles.find(file => file.filename === 'removed.bin')!;
  const trashed = await f.call<{trashItemId: string}>(`/attachments/${deleted.id}?expectedVersionId=${deleted.currentVersionId}`, 'DELETE', undefined, deleted.authorId);
  assert.equal(trashed.status, 200);
  assert.equal((await f.call(`/trash/items/${trashed.data.trashItemId}`, 'DELETE', undefined, deleted.authorId)).status, 200);
  const local = await fetch(`${f.base}/attachments/${anchor.id}/versions?${new URLSearchParams({ filename: 'report.bin', expectedVersionId: anchor.id })}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-seo' }, body: new Uint8Array(manualBytes),
  });
  assert.equal(local.status, 201);
  const manualHead = await local.json() as AttachmentHead;
  const existingFiles = await list();
  const expectedBytes = async (id: string, bytes: Buffer) => {
    const response = await fetch(`${f.base}/attachment-versions/${id}/download`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  };
  async function settings(pkg: LegacyPackageSummary): Promise<MigrationConfiguration> {
    const options = (await f.call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`)).data;
    const target = options.appendTarget;
    assert.equal(target?.projectId, projectId);
    return { ...options.defaultConfiguration, appendTo: { projectId, refreshAttachments: true,
      statuses: Object.fromEntries(options.statuses.map(option => [option.id, target!.statuses.find(status => status.label === option.label)!.id])),
      issueTypes: Object.fromEntries(options.issueTypes.map(option => [option.id, target!.issueTypes.find(type => type.name === option.label)!.id])),
      fields: {},
    } };
  }
  const delta = await upload('jira-files-delta', [attachment('700', 'report.bin', movedBytes.length), attachment('701', 'report.bin', newBytes.length),
    attachment('710', 'removed.bin', removedBytes.length), attachment('711', 'missing.bin', 13),
    attachment('712', 'restricted.bin', movedBytes.length, 'grouplevel="private"'),
  ], [['700', movedBytes], ['701', newBytes], ['710', removedBytes], ['712', movedBytes]]);
  const config = await settings(delta);
  const disabled = structuredClone(config);
  delete disabled.appendTo?.refreshAttachments;
  assert.equal((await f.preview(disabled)).canApply, false);
  const plan = await f.preview(config);
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.equal(plan.counts.issues, 0);
  assert.equal(plan.counts.newJiraAttachments, 1);
  assert.equal(plan.counts.fileCopies, 1);
  const stale = await f.preview(config);
  const bundle = join(f.dir, 'legacy-imports', `${delta.id}.bundle`);
  const uploadedBytes = readFileSync(bundle);
  try {
    const changed = Buffer.from(uploadedBytes);
    changed[changed.length - 1] ^= 1;
    writeFileSync(bundle, changed);
    assert.equal((await f.apply(plan)).status, 409);
  } finally { writeFileSync(bundle, uploadedBytes); }

  const uploads = join(f.dir, 'uploads');
  const filesBefore = readdirSync(uploads).sort();
  f.db.exec(`CREATE TRIGGER fail_jira_attachment_receipt BEFORE INSERT ON source_imports
    BEGIN SELECT RAISE(ABORT, 'synthetic Jira attachment receipt failure'); END;`);
  try { assert.equal((await f.apply(plan)).status, 500); }
  finally { f.db.exec('DROP TRIGGER fail_jira_attachment_receipt'); }
  assert.deepEqual(await list(), existingFiles);
  assert.deepEqual(readdirSync(uploads).sort(), filesBefore);
  const result = await f.apply(plan);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal((await f.apply(plan)).data.duplicate, true);
  assert.equal((await f.apply(stale)).status, 409);
  assert.deepEqual(await ticket(), issue);
  const finalFiles = await list();
  const added = finalFiles.find(file => file.id !== anchor.id)!;
  assert.equal(finalFiles.length, 2);
  assert.equal(added.filename, 'report.bin');
  assert.equal(added.versionCount, 1);
  assert.equal(finalFiles.find(file => file.id === anchor.id)?.currentVersionId, manualHead.currentVersionId);
  await expectedBytes(anchor.id, originalBytes);
  await expectedBytes(manualHead.currentVersionId, manualBytes);
  await expectedBytes(added.id, newBytes);
  assert.equal((await f.preview(config)).canApply, false);

  const archived = await f.call<{trashItemId: string}>(`/attachments/${added.id}?expectedVersionId=${added.id}`, 'DELETE', undefined, added.authorId);
  assert.equal(archived.status, 200);
  type Backup = WorkspaceSnapshot & { schemaVersion: number; sourceRecords: SourceRecordArchive[] };
  const backup = (await f.call<Backup>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(backup.sourceRecords.filter(row => row.jiraAttachmentAppend).map(row => row.record.sourceId), ['701']);
  assert.equal((await f.call('/import', 'POST', { data: historicalMigrationBackup(backup, 44) })).status, 400);
  assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
  assert.equal((await f.preview(config)).canApply, false);
  assert.equal((await f.call(`/trash/items/${archived.data.trashItemId}/restore`, 'POST', undefined, added.authorId)).status, 200);
  await expectedBytes(added.id, newBytes);

  const sparseBytes = Buffer.from('업무 객체 없이 내보낸 파일');
  const sparse = await upload('jira-sparse-files', [attachment('730', 'sparse.bin', sparseBytes.length)], [['730', sparseBytes]], false);
  const sparsePlan = await f.preview(await settings(sparse));
  assert.equal(sparsePlan.canApply, true, JSON.stringify(sparsePlan.notices));
  assert.equal(sparsePlan.counts.newJiraAttachments, 1);
  assert.equal((await f.apply(sparsePlan)).status, 201);
  await expectedBytes((await list()).find(file => file.filename === 'sparse.bin')!.id, sparseBytes);

  const combined = await upload('jira-files-and-comments', [attachment('740', 'combined.bin', newBytes.length),
    `<Action id="840" issue="100" author="old-author" type="comment" created="${date}" body="새 파일과 함께 이관한 댓글"/>`,
  ], [['740', newBytes]], false);
  const combinedSettings = await settings(combined);
  combinedSettings.appendTo!.refreshHistory = true;
  for (const identity of Object.keys(combinedSettings.users)) combinedSettings.users[identity] = 'user-jun';
  const combinedPlan = await f.preview(combinedSettings);
  assert.equal(combinedPlan.canApply, true, JSON.stringify(combinedPlan.notices));
  assert.equal(combinedPlan.counts.newJiraAttachments, 1);
  assert.equal(combinedPlan.counts.newJiraComments, 1);
  const combinedResult = await f.apply(combinedPlan);
  assert.equal(combinedResult.status, 201, JSON.stringify(combinedResult.data));
  assert.ok((await f.call<Comment[]>(`/comments?resourceType=issue&resourceId=${issue.id}`)).data.some(row => row.body === '새 파일과 함께 이관한 댓글'));
  await expectedBytes((await list()).find(file => file.filename === 'combined.bin')!.id, newBytes);
});

const gitlabPath = '/integrations/gitlab';
const historicAt = '2020-01-02T00:00:00.000Z';
const syntheticSecret = 'migration-gitlab-synthetic-secret';
const historicalBranch = 'feature/repository-history';
const historicalHash = 'a'.repeat(40);

async function importJiraForGitlab(f: MigrationFixture, projectKey: string, rows: Parameters<typeof jiraGitlabCsv>[0]) {
  const original = await f.upload(jiraGitlabCsv(rows), `${projectKey}-history.csv`, 'jira');
  const preview = await f.preview(await f.configuration(original, projectKey));
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  const response = await f.apply(preview);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const [projectId] = response.data.import.projectIds;
  assert.ok(projectId);
  const current = await f.call<WorkspaceSnapshot>('/workspace');
  const issues = current.data.issues.filter(issue => issue.projectId === projectId).sort((left, right) => left.key.localeCompare(right.key));
  assert.equal(issues.length, rows.length);
  return { projectId, jiraInstanceKey: original.source.instanceKey, issues };
}

async function localGitlab(t: TestContext, respond: (path: string, base: string) => unknown) {
  let base = '';
  const reads: { path: string; method: string | undefined }[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', base).pathname;
    reads.push({ path, method: request.method });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(respond(path, base)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/forge`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { base, reads };
}

function gitlabMr(base: string, projectId: number, iid: number, title: string, branch = historicalBranch, sha = historicalHash, date = historicAt) {
  return { id: iid, iid, title, state: 'merged', source_project_id: projectId, target_project_id: projectId,
    source_branch: branch, last_commit: { id: sha }, updated_at: date, web_url: `${base}/team/repo-${projectId}/-/merge_requests/${iid}` };
}

async function gitlabHook(f: MigrationFixture, body: unknown, secret = syntheticSecret, id = randomUUID()) {
  const result = await fetch(`${f.base}${gitlabPath}/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gitlab-Token': secret, 'webhook-id': id }, body: JSON.stringify(body),
  });
  return { status: result.status, data: await result.json() as { linked: number; duplicate: boolean; runs: AutomationRun[] } };
}

async function enableMigrationGitlabRule(f: MigrationFixture, projectId: string, repositoryId: number, from: string, to: string) {
  const reply = await f.call<AutomationRule>('/automation-rules', 'POST', {
    projectId, name: `저장소 ${repositoryId} 병합 후 완료`, trigger: 'merge_request.merged', enabled: true,
    gitlabProjectIds: [repositoryId], branchPattern: 'feature/*', issueTypes: [], fromStatuses: [from], toStatusId: to,
    actorId: 'user-seo', priority: 100,
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.data));
  return reply.data;
}

test('explicit repository routes match imported Jira keys only for their selected source and preserve GitLab live event policy', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const baseline = await f.call<WorkspaceSnapshot & { schemaVersion: number }>('/export');
  assert.equal(baseline.status, 200);
  const originA = await importJiraForGitlab(f, 'MOVA', [
    ['RAWALI-9', 'OLD-1', '첫 번째 원본의 티켓', 'Open'], ['200', 'ALPHA-8', '첫 번째 원본의 완료 상태', 'Closed'],
  ]);
  const originB = await importJiraForGitlab(f, 'MOVB', [
    ['100', 'OLD-1', '두 번째 원본의 티켓', 'Open'], ['200', 'BETA-9', '다른 인스턴스에만 있는 티켓', 'Closed'],
  ]);
  const [targetA] = originA.issues;
  const [targetB] = originB.issues;
  assert.notEqual(targetA.key, 'OLD-1');
  assert.notEqual(targetB.key, 'OLD-1');
  assert.notEqual(originA.jiraInstanceKey, originB.jiraInstanceKey);
  const destinations = [originA, originB].map(({ projectId, jiraInstanceKey }) => ({ projectId, jiraInstanceKey }));
  const available = await f.call<typeof destinations>(`${gitlabPath}/jira-sources`);
  assert.equal(available.status, 200, JSON.stringify(available.data));
  assert.deepEqual(new Set(available.data.map(value => JSON.stringify([value.projectId, value.jiraInstanceKey]))),
    new Set(destinations.map(value => JSON.stringify([value.projectId, value.jiraInstanceKey]))));

  const namedBranch = 'feature/OLD-1-history';
  const commitHash = 'c'.repeat(40);
  let restBranchHash = historicalHash;
  const upstream = await localGitlab(t, (path, base) => {
    const [, repo, endpoint] = /^\/forge\/api\/v4\/projects\/(42|43)(?:\/(.*))?$/.exec(path) ?? [];
    const repoId = Number(repo);
    if (!endpoint) return { id: repoId, path_with_namespace: `team/repo-${repo}`, web_url: `${base}/team/repo-${repo}` };
    if (endpoint === 'merge_requests') return [
      gitlabMr(base, repoId, 101, 'OLD-1 원래 키로 연 MR'),
      ...(repoId === 42 ? [
        gitlabMr(base, repoId, 102, `OLD-1 ${targetA.key} 같은 티켓을 두 번 언급`, 'feature/dual-reference', 'd'.repeat(40)),
        gitlabMr(base, repoId, 103, 'NEO-1 범위 밖 현재 키', 'feature/outside', 'e'.repeat(40)),
        gitlabMr(base, repoId, 104, 'BETA-9 다른 원본 키', 'feature/other-origin', 'f'.repeat(40)),
        gitlabMr(base, repoId, 105, 'RAWALI-9 원본 키가 아닌 원본 객체 ID', 'feature/raw-id', 'b'.repeat(40)),
      ] : [gitlabMr(base, repoId, 201, 'NEO-1 매핑 없는 저장소의 현재 키', 'feature/current-ticket', 'd'.repeat(40))]),
    ];
    if (endpoint === 'pipelines') return [
      { id: 301, ref: historicalBranch, sha: historicalHash, status: 'success', updated_at: historicAt, web_url: `${base}/team/repo-${repo}/-/pipelines/301` },
      { id: 302, ref: historicalBranch, sha: '5'.repeat(40), status: 'success', updated_at: historicAt, web_url: `${base}/team/repo-${repo}/-/pipelines/302` },
    ];
    if (endpoint === 'repository/branches') return [{ name: namedBranch, commit: { id: restBranchHash } }];
    if (endpoint === 'repository/commits') return [{ id: commitHash, title: '이전 커밋', message: 'OLD-1 원본 Jira 참조', committed_date: historicAt }];
    return [];
  });

  const empty = await f.call<GitlabSettings>(gitlabPath);
  const config = await f.call<GitlabSettings>(gitlabPath, 'PATCH', {
    expectedVersion: empty.data.version, baseUrl: upstream.base, projectIds: [42, 43], webhookSecret: syntheticSecret,
  });
  assert.equal(config.status, 200, JSON.stringify(config.data));
  const selected = [{ repositoryId: 42, ...destinations[0] }];
  const wrongOrigin = [{ repositoryId: 42, projectId: originA.projectId, jiraInstanceKey: originB.jiraInstanceKey }];
  const denied = await f.call(gitlabPath, 'PATCH', { expectedVersion: config.data.version, jiraRoutes: wrongOrigin });
  assert.equal(denied.status, 400, JSON.stringify(denied.data));
  const unauthorized = await f.call(gitlabPath, 'PATCH', { expectedVersion: config.data.version, jiraRoutes: [{ ...selected[0], repositoryId: 99 }] });
  assert.equal(unauthorized.status, 400, JSON.stringify(unauthorized.data));
  assert.deepEqual((await f.call<GitlabSettings>(gitlabPath)).data, config.data);

  const before = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const previewRequest = { expectedVersion: config.data.version, includeHistory: true };
  const unmapped = await f.call<GitlabSyncPreview>(`${gitlabPath}/sync-preview`, 'POST', previewRequest);
  assert.equal(unmapped.status, 200, JSON.stringify(unmapped.data));
  assert.ok(!unmapped.data.candidates.some(item => item.kind === 'merge_request' && item.objectId === '101'));
  const preview = await f.call<GitlabSyncPreview>(`${gitlabPath}/sync-preview`, 'POST', { ...previewRequest, jiraRoutes: selected });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const candidates = preview.data.candidates;
  const mapped = candidates.filter(candidate => candidate.projectId === 42);
  assert.equal(mapped.length, 5);
  assert.ok(mapped.every(candidate => candidate.issueId === targetA.id && candidate.issueKey === targetA.key && candidate.action === 'create'));
  assert.deepEqual(mapped.map(({ kind }) => kind).sort(), ['branch', 'commit', 'merge_request', 'merge_request', 'pipeline']);
  assert.deepEqual(mapped.filter(item => item.kind === 'merge_request').map(item => item.objectId).sort(), ['101', '102']);
  assert.equal(mapped.find(item => item.kind === 'merge_request' && item.objectId === '101')?.originalJiraKey, 'OLD-1');
  assert.equal(mapped.find(item => item.kind === 'pipeline')?.objectId, '301');
  assert.equal(mapped.find(item => item.kind === 'pipeline')?.originalJiraKey, 'OLD-1');
  assert.deepEqual(candidates.filter(candidate => candidate.projectId === 43).map(item => [item.kind, item.issueKey]), [['merge_request', 'NEO-1']]);
  assert.deepEqual((await f.call<GitlabSettings>(gitlabPath)).data, config.data);
  assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, before);

  const saved = await f.call<GitlabSettings>(gitlabPath, 'PATCH', { expectedVersion: config.data.version, jiraRoutes: selected });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.jiraRoutes, selected);
  const workflow = (await f.call<ProjectWorkflow>(`/projects/${originA.projectId}/workflow`)).data;
  const completed = workflow.statuses.find(status => status.category === 'done');
  assert.ok(completed);
  const aliasAutomation = await enableMigrationGitlabRule(f, originA.projectId, 42, targetA.status, completed.id);
  const unrelated = await enableMigrationGitlabRule(f, 'project-neo', 43, 'in_progress', 'done');

  const sync = await f.call<GitlabSyncResult>(`${gitlabPath}/sync`, 'POST', { includeHistory: true });
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  assert.equal(sync.data.linked, candidates.length);
  const afterSync = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  assert.deepEqual(afterSync.issues, before.issues);
  assert.deepEqual((await f.call<AutomationRun[]>('/automation-runs')).data, []);
  assert.equal(afterSync.gitlabLinks.filter(link => link.projectId === 42 && link.issueId === targetA.id).length, 5);
  assert.ok(afterSync.gitlabLinks.filter(link => ['branch', 'commit', 'pipeline'].includes(link.kind)).every(link =>
    link.projectId === 42 && link.issueId === targetA.id && link.originalJiraKey === 'OLD-1'));
  assert.ok(upstream.reads.length > 0 && upstream.reads.every(request => request.method === 'GET'));

  function readIssue(id: string) { return f.call<WorkspaceSnapshot>('/workspace').then(snapshot => snapshot.data.issues.find(issue => issue.id === id)); }
  const liveBranch = 'feature/live-event';
  const liveHash = 'b'.repeat(40);
  const fresh = (projectId: number, iid: number) => ({
    object_kind: 'merge_request', project: { id: projectId },
    object_attributes: { ...gitlabMr(upstream.base, projectId, iid, 'OLD-1 인증 웹훅', liveBranch, liveHash, new Date().toISOString()), action: 'merge' },
  });
  assert.equal((await gitlabHook(f, fresh(42, 401), 'incorrect-token')).status, 401);
  assert.equal((await gitlabHook(f, fresh(99, 401))).status, 403);
  const wrongRepo = await gitlabHook(f, fresh(43, 401));
  assert.equal(wrongRepo.status, 200, JSON.stringify(wrongRepo.data));
  assert.equal(wrongRepo.data.linked, 0);
  assert.deepEqual(wrongRepo.data.runs, []);
  assert.deepEqual(await readIssue(targetA.id), targetA);
  const eventId = randomUUID();
  const event = fresh(42, 401);
  const live = await gitlabHook(f, event, syntheticSecret, eventId);
  assert.equal(live.status, 200, JSON.stringify(live.data));
  assert.equal(live.data.linked, 1);
  assert.deepEqual(live.data.runs.map(run => [run.issueId, run.ruleId, run.outcome]), [[targetA.id, aliasAutomation.id, 'changed']]);
  assert.equal((await readIssue(targetA.id))?.status, completed.id);
  assert.equal((await readIssue(targetA.id))?.version, targetA.version + 1);
  assert.deepEqual(await readIssue(targetB.id), targetB);
  assert.equal((await gitlabHook(f, event, syntheticSecret, eventId)).data.duplicate, true);

  const pipeline = (id: number, sha: string) => ({
    object_kind: 'pipeline', project: { id: 42, web_url: `${upstream.base}/team/repo-42` },
    object_attributes: { id, sha, ref: liveBranch, status: 'success', finished_at: new Date().toISOString() },
  });
  assert.equal((await gitlabHook(f, pipeline(501, '8'.repeat(40)))).data.linked, 0);
  assert.equal((await gitlabHook(f, pipeline(502, liveHash))).data.linked, 1);
  const push = (branch: string, before: string, after: string, commits: { id: string; title: string; message: string }[] = []) => gitlabHook(f, {
    object_kind: 'push', project: { id: 42, web_url: `${upstream.base}/team/repo-42`, path_with_namespace: 'team/repo-42' },
    ref: `refs/heads/${branch}`, before, after, commits,
  });
  const pushed = await push('feature/OLD-1-live', '0'.repeat(40), '1'.repeat(40), [
    { id: '1'.repeat(40), title: '일반 커밋', message: '브랜치의 원래 키를 물려받음' },
  ]);
  assert.equal(pushed.status, 200, JSON.stringify(pushed.data));
  assert.equal(pushed.data.linked, 2);
  assert.deepEqual(pushed.data.runs, []);
  const liveLinks = (await f.call<WorkspaceSnapshot>('/workspace')).data.gitlabLinks;
  assert.equal(liveLinks.find(link => link.iid === 502 && link.kind === 'pipeline' && link.issueId === targetA.id &&
    link.originalJiraKey === 'OLD-1')?.pipelineTicketEvidence, 'verified-merge-request');
  assert.equal(liveLinks.filter(link => link.sourceBranch === 'feature/OLD-1-live' && link.issueId === targetA.id && link.originalJiraKey === 'OLD-1').length, 2);
  const observed = await push(namedBranch, '0'.repeat(40), historicalHash);
  assert.equal(observed.status, 200, JSON.stringify(observed.data));
  assert.equal(observed.data.linked, 1);
  const earlierBranch = (await f.call<WorkspaceSnapshot>('/workspace')).data.gitlabLinks.find(link => link.kind === 'branch' && link.sourceBranch === namedBranch && link.issueId === targetA.id);
  assert.ok(earlierBranch?.sourceSha === historicalHash && earlierBranch.branchObservationSource === undefined);

  const otherRoute = [{ repositoryId: 42, ...destinations[1] }];
  const remapped = await f.call<GitlabSettings>(gitlabPath, 'PATCH', { expectedVersion: saved.data.version, jiraRoutes: otherRoute });
  assert.equal(remapped.status, 200, JSON.stringify(remapped.data));
  const rules = (await f.call<AutomationRule[]>('/automation-rules')).data;
  assert.equal(rules.find(rule => rule.id === aliasAutomation.id)?.enabled, false);
  assert.equal(rules.find(rule => rule.id === unrelated.id)?.enabled, true);
  const inheritedBeforeRemap = await gitlabHook(f, pipeline(503, liveHash));
  assert.equal(inheritedBeforeRemap.status, 200, JSON.stringify(inheritedBeforeRemap.data));
  assert.equal(inheritedBeforeRemap.data.linked, 0, 'A stored MR from the previous route cannot choose a target after remapping.');

  async function branchCandidates() {
    const reply = await f.call<GitlabSyncPreview>(`${gitlabPath}/sync-preview`, 'POST', { expectedVersion: remapped.data.version, includeHistory: true });
    assert.equal(reply.status, 200, JSON.stringify(reply.data));
    return reply.data.candidates.filter(link => link.kind === 'branch');
  }
  restBranchHash = '9'.repeat(40);
  assert.deepEqual(await branchCandidates(), [], 'A disconnected snapshot cannot override an authenticated branch observation.');
  restBranchHash = historicalHash;
  assert.deepEqual((await branchCandidates()).map(candidate => [candidate.issueId, candidate.originalJiraKey, candidate.action]), [[targetB.id, 'OLD-1', 'create']]);
  const reassociate = await f.call<GitlabSyncResult>(`${gitlabPath}/sync`, 'POST', { includeHistory: true });
  assert.equal(reassociate.status, 200, JSON.stringify(reassociate.data));
  const laterBranch = (await f.call<WorkspaceSnapshot>('/workspace')).data.gitlabLinks.find(link => link.kind === 'branch' && link.sourceBranch === namedBranch && link.issueId === targetB.id);
  assert.ok(laterBranch);
  assert.equal(laterBranch.sourceSha, earlierBranch.sourceSha);
  assert.equal(laterBranch.updatedAt, earlierBranch.updatedAt);
  assert.equal(laterBranch.webUrl, earlierBranch.webUrl);
  assert.equal(laterBranch.state, 'active');
  assert.equal(laterBranch.branchObservationSource, undefined);
  assert.equal(laterBranch.originalJiraKey, 'OLD-1');
  const deleted = await push(namedBranch, historicalHash, '0'.repeat(40));
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.deepEqual(await branchCandidates(), [], 'A deleted authenticated branch cannot be re-created from the old snapshot.');

  const newest = await gitlabHook(f, fresh(42, 601));
  assert.equal(newest.status, 200, JSON.stringify(newest.data));
  assert.equal(newest.data.linked, 1);
  assert.deepEqual(newest.data.runs, []);
  assert.deepEqual(await readIssue(targetB.id), targetB);

  const backup = await f.call<WorkspaceSnapshot & { schemaVersion: number; automationRuns?: AutomationRun[]; sourceRecords: SourceRecordArchive[]; sourceImports: SourceImport[] }>('/export');
  assert.equal(backup.status, 200);
  assert.equal(backup.data.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.ok(backup.data.gitlabLinks.some(link => link.iid === 601 && link.issueId === targetB.id && link.originalJiraKey === 'OLD-1'));
  assert.equal(Object.hasOwn(backup.data, 'jiraRoutes'), false, 'The mapping is local GitLab connection configuration.');
  const legacy = { ...historicalMigrationBackup(backup.data, 34), issueChangeHistory: undefined };
  delete legacy.automationRuns;
  for (const record of legacy.sourceRecords) if (record.jiraIssueFieldHashes) delete record.jiraIssueFieldHashes.parentId;
  for (const receipt of legacy.sourceImports) delete receipt.integrity;
  for (const link of legacy.gitlabLinks) {
    delete link.mergeRequestSourceProjectId;
    delete link.pipelineTicketEvidence;
  }
  assert.equal((await f.call('/import', 'POST', { data: legacy })).status, 400);
  assert.equal((await f.call('/import', 'POST', { data: backup.data })).status, 200);
  assert.deepEqual((await f.call<GitlabSettings>(gitlabPath)).data.jiraRoutes, otherRoute);
  const savedHistory = backup.data.automationRuns;
  assert.ok(savedHistory);
  assert.ok(savedHistory.some(run => run.issueId === targetA.id && run.context?.objectId === '401'));
  assert.deepEqual((await f.call<AutomationRun[]>('/automation-runs')).data, [...savedHistory].reverse());
  const restored = (await f.call<WorkspaceSnapshot>('/workspace')).data.gitlabLinks;
  assert.deepEqual(restored, backup.data.gitlabLinks);
  for (const link of legacy.gitlabLinks) delete link.originalJiraKey;
  const legacyWorkspace = await fixture();
  t.after(() => legacyWorkspace.close());
  const restoredLegacy = await legacyWorkspace.call('/import', 'POST', { data: legacy });
  assert.equal(restoredLegacy.status, 200, JSON.stringify(restoredLegacy.data));
  assert.deepEqual((await legacyWorkspace.call<WorkspaceSnapshot>('/workspace')).data.gitlabLinks, legacy.gitlabLinks);
  assert.deepEqual((await legacyWorkspace.call<AutomationRun[]>('/automation-runs')).data, []);

  assert.equal((await f.call('/import', 'POST', { data: baseline.data })).status, 200);
  const reset = (await f.call<GitlabSettings>(gitlabPath)).data;
  assert.deepEqual(reset.jiraRoutes ?? [], []);
  assert.deepEqual(reset.projectIds, [42, 43]);
  assert.equal(reset.webhookSecretConfigured, true);
});

test('repositories skip colliding Jira and current keys for distinct tickets while matching other unambiguous tokens', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const origin = await importJiraForGitlab(f, 'OLD', [
    ['200', 'OTHER-1', '현재 키가 충돌하는 티켓', 'Open'], ['100', 'OLD-1', '이전 키가 충돌하는 티켓', 'Open'],
  ]);
  const [current, renamed] = origin.issues;
  assert.equal(current.key, 'OLD-1');
  assert.equal(renamed.key, 'OLD-2');
  const upstream = await localGitlab(t, (path, base) => path.endsWith('/merge_requests') ? [
    gitlabMr(base, 42, 901, 'OLD-1 키 충돌'), gitlabMr(base, 42, 902, 'OLD-1 OLD-2 다른 키는 연결', 'feature/another-token', 'b'.repeat(40)),
  ] : []);
  const base = (await f.call<GitlabSettings>(gitlabPath)).data;
  const config = await f.call<GitlabSettings>(gitlabPath, 'PATCH', {
    expectedVersion: base.version, baseUrl: upstream.base, projectIds: [42], webhookSecret: syntheticSecret,
    jiraRoutes: [{ repositoryId: 42, projectId: origin.projectId, jiraInstanceKey: origin.jiraInstanceKey }],
  });
  assert.equal(config.status, 200, JSON.stringify(config.data));
  const preview = await f.call<GitlabSyncPreview>(`${gitlabPath}/sync-preview`, 'POST', { expectedVersion: config.data.version });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.data.repositories[0].ambiguousKeys, ['OLD-1']);
  assert.deepEqual(preview.data.candidates.map(candidate => [candidate.objectId, candidate.issueId, candidate.originalJiraKey]), [['902', renamed.id, undefined]]);
  const sync = await f.call<GitlabSyncResult>(`${gitlabPath}/sync`, 'POST', {});
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  assert.equal(sync.data.linked, 1);
  const live = await gitlabHook(f, { object_kind: 'merge_request', project: { id: 42 }, object_attributes: {
    ...gitlabMr(upstream.base, 42, 903, 'OLD-1 인증된 충돌', 'feature/collision', historicalHash, new Date().toISOString()), action: 'merge',
  } });
  assert.equal(live.status, 200, JSON.stringify(live.data));
  assert.equal(live.data.linked, 0);
  assert.deepEqual(live.data.runs, []);
  const links = (await f.call<WorkspaceSnapshot>('/workspace')).data.gitlabLinks;
  assert.deepEqual(links.map(link => [link.iid, link.issueId]), [[902, renamed.id]]);
});

test('Confluence imports only proven global document labels and preserves team labels during reviewed refresh', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const prop = (name: string, value: string) => `<property name="${name}">${value}</property>`;
  const ref = (name: string, kind: string, id: string) => `<property name="${name}" class="${kind}"><id name="id">${id}</id></property>`;
  const object = (kind: string, id: string, content: string) => `<object class="${kind}"><id name="id">${id}</id>${content}</object>`;
  const page = (id: string, title: string, version: number, extras = '', body = '원본 본문') =>
    object('Page', id, prop('title', title) + prop('version', String(version)) + ref('space', 'Space', '42') + extras) +
    object('BodyContent', `8${id}`, prop('body', `<![CDATA[<p>${body}</p>]]>`) + ref('content', 'Page', id));
  const label = (id: number, name: string, pageId: string, namespace?: string, owner = '') =>
    object('Label', String(id), prop('name', name) + (namespace ? prop('namespace', namespace) : '') + owner) +
    object('Labelling', `9${id}`, ref('content', 'Page', pageId) + ref('label', 'Label', String(id)));
  const upload = (filename: string, rows: string[]) => f.upload(zip([{
    path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>${object('Space', '42', prop('key', 'LABELS') + prop('name', '팀 문서'))}${rows.join('')}</hibernate-generic>`),
  }]), `${filename}.zip`, 'confluence', 'synthetic-confluence-labels');

  const privateName = 'Private-Synthetic-Label';
  const unknownName = 'Unknown-Synthetic-Label';
  const scopedName = 'Owned-Synthetic-Label';
  const extraLabels = Array.from({ length: MAX_DOCUMENT_LABELS - 1 }, (_, index) => `tag-${String(index + 1).padStart(2, '0')}`);
  const initial = await upload('labelled-page', [
    page('100', '원본 문서', 1),
    label(201, 'Release', '100', 'global', prop('owner', '')),
    label(202, ' release ', '100', 'global'),
    label(203, privateName, '100', 'my', prop('owner', 'synthetic-owner')),
    label(204, unknownName, '100'),
    label(205, scopedName, '100', 'global', ref('owner', 'ConfluenceUserImpl', 'synthetic-owner')),
    label(206, 'x'.repeat(MAX_DOCUMENT_LABEL_LENGTH + 1), '100', 'global'),
    label(207, 'Excluded-Association', '100', 'global'),
    label(208, 'Excluded-Option', '100', 'global'),
    ...extraLabels.map((name, index) => label(300 + index, name, '100', 'global')),
    label(401, 'Overflow-Synthetic-Label', '100', 'global'),
    page('120', '부분 내보내기 문서', 1), label(503, 'Keep-On-Partial', '120', 'global'),
  ]);
  const configuration = await f.configuration(initial, 'LABELS');
  configuration.excludedRecords = [`${initial.id}/relation:Labelling:9207`, `${initial.id}/option:208`];
  const preview = await f.preview(configuration);
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  assert.deepEqual(preview.notices.filter(notice => notice.code.startsWith('CONFLUENCE_LABEL_'))
    .map(notice => [notice.code, notice.requiresAcknowledgement]), [
    ['CONFLUENCE_LABEL_SCOPE_ARCHIVED', true], ['CONFLUENCE_LABEL_VALUE_ARCHIVED', true],
  ]);
  for (const name of [privateName, unknownName, scopedName]) assert.equal(JSON.stringify(preview).includes(name), false);
  const imported = await f.apply(preview);
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  const [projectId] = imported.data.import.projectIds;
  const snapshot = async () => (await f.call<WorkspaceSnapshot>('/workspace')).data.documents.filter(doc => doc.projectId === projectId);
  const original = (await snapshot()).find(doc => doc.title === '원본 문서')!;
  assert.deepEqual(original.labels, ['Release', ...extraLabels]);

  const archivePath = `/source-imports/${imported.data.import.id}/records`;
  const archives = (await f.call<SourceRecordPage>(archivePath)).data.records;
  const privateOption = archives.find(archive => archive.record.id === 'option:203');
  assert.ok(privateOption);
  const rawOption = (await f.call<SourceRecordArchive>(`${archivePath}/${privateOption.id}`)).data;
  assert.equal(rawOption.record.title, privateName);
  assert.equal(rawOption.record.metadata.namespace, 'my');
  const privateRelation = archives.find(archive => archive.record.id === 'relation:Labelling:9203');
  assert.ok(privateRelation);
  const rawRelation = (await f.call<SourceRecordArchive>(`${archivePath}/${privateRelation.id}`)).data;
  assert.deepEqual(rawRelation.record.references, [
    { kind: 'page', sourceId: '100', relation: 'content' }, { kind: 'option', sourceId: '203', relation: 'label' },
  ]);

  const teamEdit = await f.call<DocPage>(`/documents/${original.id}`, 'PATCH', { expectedVersion: original.version, labels: ['팀 라벨'] });
  assert.equal(teamEdit.status, 200, JSON.stringify(teamEdit.data));
  const delta = await upload('labelled-page-append', [
    page('100', '원본에서 바뀐 제목', 2), label(201, 'Release', '100', 'global'), label(501, 'Upstream-Only', '100', 'global'),
    page('110', '추가한 문서', 1), label(502, 'Runbook', '110', 'global'),
    page('120', '부분 내보내기 문서', 2), label(504, 'New-On-Partial', '120', 'global'),
    object('Label', '505', prop('name', 'Wrong-Owner') + prop('namespace', 'global')),
    object('Labelling', '9505', ref('content', 'Page', '120') + ref('contentEntity', 'Page', '110') + ref('label', 'Label', '505')),
  ]);
  const appendPreview = await f.preview({ ...await f.configuration(delta, 'LABELS'), appendPagesTo: { projectId, refreshExisting: true } });
  assert.equal(appendPreview.canApply, true, JSON.stringify(appendPreview.notices));
  assert.equal(appendPreview.counts.documents, 1);
  assert.equal(appendPreview.counts.updatedDocumentFields, 2);
  const field = appendPreview.documentRefresh?.find(row => row.sourceId === '100')?.fields.find(row => row.field === 'labels');
  assert.equal(field?.decision, 'conflict');
  assert.equal(field?.current, '팀 라벨');
  assert.ok(field?.incoming.includes('Upstream-Only'));
  const appended = await f.apply(appendPreview);
  assert.equal(appended.status, 201, JSON.stringify(appended.data));
  const documents = await snapshot();
  assert.deepEqual(documents.map(doc => [doc.title, doc.labels]).sort(), [
    ['부분 내보내기 문서', ['Keep-On-Partial', 'New-On-Partial']], ['원본에서 바뀐 제목', ['팀 라벨']], ['추가한 문서', ['Runbook']],
  ]);

  for (const [version, body] of [[1, '원본 본문'], [2, '같은 버전인데 본문이 다름']] as const) {
    const unproven = await upload(`unproven-label-removal-${version}`, [page('120', '부분 내보내기 문서', version, '<collection name="labels"/>', body)]);
    const rejected = await f.preview({ ...await f.configuration(unproven, 'LABELS'), appendPagesTo: { projectId, refreshExisting: true } });
    assert.equal(rejected.canApply, false);
    assert.equal(rejected.counts.updatedDocumentFields, 0);
    assert.ok(rejected.notices.some(notice => notice.code === 'CONFLUENCE_REFRESH_SOURCE_NOT_NEWER'));
  }
});

test('Confluence label-only refresh keeps active collaborators and restores the label comparison baseline', async t => {
  const f = await fixture(), copy = await fixture();
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await Promise.all([f.close(), copy.close()]);
  });
  f.attachCollaboration();
  async function upload(target: MigrationFixture, version: number, label: string | null) {
    const collection = label === null ? '<collection name="labels" class="java.util.HashSet"/>' :
      '<collection name="labels" class="java.util.HashSet"><element class="Label"><id name="id">201</id></element></collection>';
    const labelObject = label === null ? '' : `<object class="Label"><id name="id">201</id>
      <property name="name">${label}</property><property name="namespace">global</property></object>`;
    return target.upload(zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
      <object class="Space"><id name="id">42</id><property name="key">LIVE</property><property name="name">팀 문서</property></object>
      <object class="Page"><id name="id">100</id><property name="title">원본 문서</property><property name="version">${version}</property>
        <property name="space" class="Space"><id name="id">42</id></property>${collection}</object>
      <object class="BodyContent"><id name="id">101</id><property name="content" class="Page"><id name="id">100</id></property>
        <property name="body"><![CDATA[<p>변경하지 않은 원본 본문</p>]]></property></object>${labelObject}</hibernate-generic>`) }]),
    `labels-version-${version}.zip`, 'confluence', 'synthetic-confluence-live-labels');
  }
  const original = await upload(f, 1, 'original');
  const imported = await f.apply(await f.preview(await f.configuration(original, 'LIVE')));
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  const [projectId] = imported.data.import.projectIds;
  const document = (await f.call<WorkspaceSnapshot>('/workspace')).data.documents.find(value => value.projectId === projectId)!;
  assert.deepEqual(document.labels, ['original']);
  const path = `/documents/${document.id}`;
  const local = await f.call<DocPage>(path, 'PATCH', {
    expectedVersion: document.version,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '팀이 편집한 본문' }] }] },
  });
  assert.equal(local.status, 200, JSON.stringify(local.data));
  const enabled = await f.call<CollaborationSession>(`${path}/collaboration/enable`, 'POST', { expectedVersion: local.data.version });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  const socket = new WebSocket(`${f.base.replace('http:', 'ws:')}/collaboration?${new URLSearchParams({ documentId: document.id, actorId: 'user-min' })}`);
  sockets.add(socket);
  await once(socket, 'open', { signal: AbortSignal.timeout(6000) });
  const ready = once(socket, 'message', { signal: AbortSignal.timeout(6000) });
  socket.send(JSON.stringify({ type: 'hello', epoch: enabled.data.epoch, schemaVersion: COLLABORATION_SCHEMA }));
  assert.equal((JSON.parse(String((await ready)[0])) as CollaborationServerMessage).type, 'welcome');

  async function configuration(target: MigrationFixture, pack: LegacyPackageSummary) {
    return { ...await target.configuration(pack, 'LIVE'), appendPagesTo: { projectId, refreshExisting: true } } as const;
  }
  const config = await configuration(f, await upload(f, 2, 'updated'));
  const stale = await f.preview(config);
  assert.equal(stale.canApply, true, JSON.stringify(stale.notices));
  assert.deepEqual(stale.documentRefresh?.[0]?.fields.map(({ field, decision }) => [field, decision]), [['labels', 'apply']]);
  const edited = await f.call<DocPage>(path, 'PATCH', { expectedVersion: enabled.data.document.version, icon: 'book' });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal((await f.apply(stale)).status, 409);
  const preview = await f.preview(config);
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  const metadata = once(socket, 'message', { signal: AbortSignal.timeout(6000) });
  const [result, [bytes]] = await Promise.all([f.apply(preview), metadata]);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const message = JSON.parse(String(bytes)) as CollaborationServerMessage;
  assert.equal(message.type, 'update');
  assert.equal(message.epoch, enabled.data.epoch);
  assert.deepEqual(message.document.labels, ['updated']);
  assert.deepEqual(message.document.content, enabled.data.document.content);
  assert.equal(message.document.icon, edited.data.icon);
  assert.equal(message.document.version, edited.data.version + 1);
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.deepEqual((await f.call<CollaborationSession>(`${path}/collaboration`)).data.document, message.document);
  assert.equal((await f.apply(preview)).data.duplicate, true);

  type Backup = WorkspaceSnapshot & { schemaVersion: number; sourceRecords: SourceRecordArchive[]; revisions: DocRevision[] };
  const backup = (await f.call<Backup>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const archive = backup.sourceRecords.find(row => row.sourceImportId === result.data.import.id && row.targetId === document.id);
  assert.match(archive?.confluencePageFieldHashes?.labels ?? '', /^[a-f\d]{64}$/);
  const version = backup.revisions.find(item => item.documentId === document.id && item.version === message.document.version);
  assert.deepEqual(version?.content, enabled.data.document.content);
  const old = await copy.call<{ error: string }>('/import', 'POST', { data: historicalMigrationBackup(backup, 60) });
  assert.equal(old.status, 400);
  assert.match(old.data.error, /schemaVersion 61/);
  const restored = await copy.call('/import', 'POST', { data: backup });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.deepEqual((await copy.call<CollaborationSession>(`${path}/collaboration`)).data.document.labels, ['updated']);

  const empty = await copy.preview(await configuration(copy, await upload(copy, 3, null)));
  assert.equal(empty.canApply, true, JSON.stringify(empty.notices));
  assert.deepEqual(empty.documentRefresh?.[0]?.fields.map(({ field, decision }) => [field, decision]), [['labels', 'apply']]);
  const cleared = await copy.apply(empty);
  assert.equal(cleared.status, 201, JSON.stringify(cleared.data));
  const current = (await copy.call<CollaborationSession>(`${path}/collaboration`)).data.document;
  assert.equal(Object.hasOwn(current, 'labels'), false);
  assert.deepEqual(current.content, enabled.data.document.content);
});

test('incremental Confluence imports reuse live parents and references while preserving edited and deleted pages', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const instance = 'synthetic-continuing-confluence';
  const prop = (name: string, value: string) => `<property name="${name}">${value}</property>`;
  const ref = (name: string, kind: string, id: string) => `<property name="${name}" class="${kind}"><id name="id">${id}</id></property>`;
  const object = (kind: string, id: string, content: string) => `<object class="${kind}"><id name="id">${id}</id>${content}</object>`;
  const body = (id: string, kind: string, owner: string, storage: string) => object('BodyContent', id, prop('body', `<![CDATA[${storage}]]>`) + ref('content', kind, owner));
  const date = prop('creationDate', '2020-03-01T00:00:00Z');
  const page = (id: string, title: string, parent?: string, spaceId = '42', version = '1') =>
    object('Page', id, prop('title', title) + prop('version', version) + ref('space', 'Space', spaceId) + date + (parent ? ref('parent', 'Page', parent) : ''));
  const space = (id: string, key: string) => object('Space', id, prop('key', key) + prop('name', '원본 위키'));
  const file = Buffer.from('새 페이지의 원본 첨부\x00\r\n');
  const upload = (name: string, rows: string[], { origin = instance, withAttachment = false } = {}) => f.upload(zip([
    { path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>${rows.join('')}</hibernate-generic>`) },
    ...(withAttachment ? [{ path: 'attachments/400/701/1', bytes: file }] : []),
  ]), `${name}.zip`, 'confluence', origin);

  const initial = await upload('initial-pages', [
    space('42', 'WIKI'), page('100', '원본 상위 문서'), body('101', 'Page', '100', '<h2>Deployment Guide</h2>'),
    page('200', '원본 참조 문서'), page('300', '삭제한 원본 문서'),
  ]);
  const initialPlan = await f.preview(await f.configuration(initial, 'WIKI'));
  assert.equal(initialPlan.canApply, true, JSON.stringify(initialPlan.notices));
  const initialApply = await f.apply(initialPlan);
  assert.equal(initialApply.status, 201, JSON.stringify(initialApply.data));
  const [projectId] = initialApply.data.import.projectIds;
  const originals = (await f.call<WorkspaceSnapshot>('/workspace')).data.documents.filter(document => document.projectId === projectId);
  const parent = originals.find(document => document.title === '원본 상위 문서')!;
  const reference = originals.find(document => document.title === '원본 참조 문서')!;
  const removed = originals.find(document => document.title === '삭제한 원본 문서')!;
  assert.ok(parent && reference && removed);
  const archived = await f.call<{ trashEntryId: string }>(`/documents/${removed.id}`, 'DELETE', { expectedVersion: removed.version });
  assert.equal(archived.status, 200);
  assert.equal((await f.call(`/trash/${archived.data.trashEntryId}`, 'DELETE')).status, 200);

  const storage = [
    '<p><ac:link><ri:page ri:content-id="100"/><ac:link-body>식별자로 상위 문서</ac:link-body></ac:link></p>',
    '<p><ac:link ac:anchor="DeploymentGuide"><ri:page ri:content-id="100"/><ac:link-body>상위 문서의 배포 절</ac:link-body></ac:link></p>',
    '<ac:structured-macro ac:name="include"><ac:parameter ac:name=""><ri:page ri:space-key="WIKI" ri:content-title="원본 참조 문서"/></ac:parameter></ac:structured-macro>',
    '<ac:structured-macro ac:name="include"><ac:parameter ac:name="">WIKI:원본 참조 문서</ac:parameter></ac:structured-macro>',
    '<p><ac:link><ri:attachment ri:filename="new-report.bin"/><ac:link-body>새 보고서</ac:link-body></ac:link></p>',
  ].join('');
  const next = await upload('continuing-pages', [
    space('42', 'WIKI'), page('300', '다시 나타난 삭제 문서'), page('400', '추가 이관 하위 문서', '100', '42', '2'),
    body('401', 'Page', '400', storage),
    object('Page', '402', prop('title', '추가 이관 하위 문서의 이전 버전') + prop('version', '1') +
      prop('contentStatus', 'historical') + ref('originalVersion', 'Page', '400') + ref('space', 'Space', '42') + date),
    body('403', 'Page', '402', '<p>추가한 문서의 이전 본문</p>'),
    object('Comment', '600', ref('containerContent', 'Page', '300') + date),
    body('601', 'Comment', '600', '<p>기존 원본에만 남기는 댓글</p>'),
    object('Comment', '602', ref('containerContent', 'Page', '400') + date),
    body('603', 'Comment', '602', '<p>추가한 문서에 연결한 댓글</p>'),
    object('Attachment', '701', prop('title', 'new-report.bin') + prop('version', '1') + ref('containerContent', 'Page', '400') + date),
  ], { withAttachment: true });
  const optionsFor = async (...packages: LegacyPackageSummary[]) => (await f.call<MigrationOptions>(`/migrations/options?${new URLSearchParams(packages.map(pkg => ['packageId', pkg.id]))}`)).data;
  const options = await optionsFor(next);
  assert.deepEqual(options.appendPagesTarget, { projectId, key: 'WIKI', name: 'Synthetic unified migration', instanceKey: instance, sourceSpaceId: '42', sourceSpaceKey: 'WIKI' });
  assert.equal(options.appendTarget, undefined);
  const wrongSpace = await upload('different-space', [space('43', 'OTHER'), page('500', '다른 공간 문서', undefined, '43')]);
  const wrongSource = await upload('different-origin', [space('42', 'WIKI'), page('500', '다른 원본 문서')], { origin: 'synthetic-different-confluence' });
  assert.equal((await optionsFor(wrongSpace)).appendPagesTarget, undefined);
  assert.equal((await optionsFor(wrongSource)).appendPagesTarget, undefined);
  assert.equal((await optionsFor(next, wrongSpace)).appendPagesTarget, undefined);
  const config = { ...options.defaultConfiguration, appendPagesTo: { projectId } };
  assert.equal((await f.call('/migrations/preview', 'POST', { configuration: { ...config, appendPagesTo: { projectId: 'project-neo' } } })).status, 400);
  assert.equal((await f.call('/migrations/preview', 'POST', { configuration: { ...config, appendTo: { projectId, statuses: {}, issueTypes: {}, fields: {} } } })).status, 400);

  const stale = await f.preview(config);
  assert.equal(stale.canApply, true, JSON.stringify(stale.notices));
  assert.equal(stale.counts.documents, 1);
  assert.equal(stale.counts.retainedPages, 1);
  assert.equal(stale.counts.retainedRecords, 2);
  assert.equal(stale.counts.projects, 0);
  assert.equal(stale.counts.comments, 1);
  assert.equal(stale.counts.revisions, 2);
  const trashed = await f.call<{ trashEntryId: string }>(`/documents/${parent.id}`, 'DELETE', { expectedVersion: parent.version });
  assert.equal(trashed.status, 200);
  assert.equal((await f.apply(stale)).status, 409);
  assert.equal((await f.call(`/trash/${trashed.data.trashEntryId}/restore`, 'POST')).status, 200);

  const sectionPreview = await f.preview(config);
  const restoredParent = (await f.call<WorkspaceSnapshot>('/workspace')).data.documents.find(document => document.id === parent.id)!;
  const contentSchemaVersion = documentContentSchemaVersion(parent.content);
  const withoutSection = await f.call<DocPage>(`/documents/${parent.id}`, 'PATCH', {
    expectedVersion: restoredParent.version,
    contentSchemaVersion,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '임시 본문' }] }] },
  });
  assert.equal(withoutSection.status, 200, JSON.stringify(withoutSection.data));
  assert.equal((await f.apply(sectionPreview)).status, 409);
  assert.equal((await f.call<DocPage>(`/documents/${parent.id}`, 'PATCH', {
    expectedVersion: withoutSection.data.version, contentSchemaVersion, content: parent.content,
  })).status, 200);

  const review = await f.preview(config);
  assert.equal(review.canApply, true, JSON.stringify(review.notices));
  assert.deepEqual(review.projects.map(project => [project.id, project.documentCount]), [[projectId, 1]]);
  const edit = await f.call<DocPage>(`/documents/${reference.id}`, 'PATCH', {
    expectedVersion: reference.version, title: '팀에서 수정한 문서 제목',
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '팀에서 수정한 본문' }] }] },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  const applied = await f.apply(review);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.deepEqual(applied.data.import.configuration.appendPagesTo, { projectId });
  assert.equal((await f.apply(review)).data.duplicate, true);

  const workspace = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const child = workspace.documents.find(document => document.title === '추가 이관 하위 문서')!;
  assert.ok(child);
  assert.equal(child.projectId, projectId);
  assert.equal(child.parentId, parent.id);
  assert.equal(child.version, 2);
  assert.deepEqual(contentReferences(child.content).map(item => [item.kind, item.id]),
    [['reference', parent.id], ['include', reference.id], ['include', reference.id]]);
  const sectionId = parent.content.content?.[0].attrs?.sectionId;
  assert.equal(typeof sectionId, 'string');
  assert.ok(child.content.content?.some(block =>
    block.content?.some(node => node.marks?.some(mark =>
      mark.attrs?.href === documentSectionHash(parent.id, sectionId as string)))));
  assert.deepEqual(workspace.documents.find(document => document.id === reference.id), edit.data);
  assert.equal(workspace.documents.filter(document => document.projectId === projectId).length, 3);
  assert.equal(workspace.documents.some(document => document.id === removed.id), false);
  const recordsPath = `/source-imports/${applied.data.import.id}/records`;
  const sourceRecords = (await f.call<SourceRecordPage>(recordsPath)).data.records;
  for (const id of ['page:300', 'comment:600']) {
    const record = sourceRecords.find(row => row.record.id === id);
    assert.ok(record);
    assert.equal(record.excluded, undefined);
    assert.equal(record.targetId, null);
    assert.equal(record.ownerId, null);
  }
  const oldComment = sourceRecords.find(row => row.record.id === 'comment:600')!;
  assert.equal((await f.call<SourceRecordArchive>(`${recordsPath}/${oldComment.id}`)).data.record.text, '<p>기존 원본에만 남기는 댓글</p>');
  const importedRevision = sourceRecords.find(row => row.record.id === 'revision:402');
  const importedComment = sourceRecords.find(row => row.record.id === 'comment:602');
  assert.equal(importedRevision?.ownerId, child.id);
  assert.equal(importedRevision.targetType, 'revision');
  assert.equal(importedComment?.ownerId, child.id);
  assert.equal(importedComment.targetType, 'comment');
  const attachment = sourceRecords.find(row => row.record.id === 'attachment:701');
  assert.equal(attachment?.ownerId, child.id);
  assert.ok(attachment.targetId);
  const download = await fetch(`${f.base}/attachments/${attachment.targetId}/content`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), file);

  const backup = await f.call<WorkspaceSnapshot & { schemaVersion: number; sourceImports: SourceImport[] }>('/export');
  assert.equal(backup.data.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal((await f.call('/import', 'POST', { data: historicalMigrationBackup(backup.data, 37) })).status, 400);
  assert.equal((await f.call('/import', 'POST', { data: backup.data })).status, 200);
  const restored = (await f.call<WorkspaceSnapshot>('/workspace')).data.documents.find(document => document.id === child.id);
  assert.equal(restored?.parentId, parent.id);
  assert.deepEqual(restored?.content, child.content);
  const restoredFile = await fetch(`${f.base}/attachments/${attachment.targetId}/content`);
  assert.equal(restoredFile.status, 200);
  assert.deepEqual(Buffer.from(await restoredFile.arrayBuffer()), file);
  const repeated = await f.preview(config);
  assert.equal(repeated.canApply, false);
  assert.equal(repeated.counts.documents, 0);
  assert.equal(repeated.counts.retainedPages, 2);
  const receipts = (await f.call<SourceImport[]>('/source-imports')).data;
  assert.deepEqual(receipts.find(receipt => receipt.id === applied.data.import.id)?.configuration.appendPagesTo, { projectId });
});

test('Confluence parent refresh proves the original placement after format 98 restore and checks source freshness', async t => {
  const origin = await fixture(), target = await fixture();
  t.after(() => Promise.all([origin.close(), target.close()]));
  const page = (id: number, title: string, version: number, day: string, parent?: number) => `
    <object class="Page"><id name="id">${id}</id><property name="title">${title}</property><property name="version">${version}</property>
      <property name="creationDate">2020-01-01T00:00:00Z</property><property name="lastModificationDate">2020-01-${day}T00:00:00Z</property>
      <property name="space" class="Space"><id name="id">42</id></property>
      ${parent === undefined ? '' : `<property name="parent" class="Page"><id name="id">${parent}</id></property>`}
    </object>`;
  const upload = (workspace: MigrationFixture, name: string, pages: string[]) => workspace.upload(zip([{ path: 'entities.xml',
    bytes: Buffer.from(`<hibernate-generic><object class="Space"><id name="id">42</id><property name="key">TREE</property>
      <property name="name">이관 문서 트리</property></object>${pages.join('')}</hibernate-generic>`),
  }]), `${name}.zip`, 'confluence', 'synthetic-confluence-hierarchy-baseline');
  const staged = await upload(origin, 'initial-hierarchy', [page(10, '처음 상위', 1, '02'), page(20, '새 상위', 1, '02'),
    page(30, '위치를 이동할 문서', 5, '02', 10), page(31, '상위를 생략한 문서', 5, '02', 10),
    page(32, '상위를 찾지 못한 문서', 5, '02', 10), page(33, '팀에서 옮긴 문서', 5, '02', 40)]);
  const otherPackage = await upload(origin, 'initial-hierarchy-other', [page(40, '별도 패키지의 상위', 1, '02')]);
  const initialPreview = await origin.preview(await origin.configuration([staged, otherPackage], 'TREE'));
  assert.ok(initialPreview.notices.some(notice => notice.code === 'PARENT_NOT_IMPORTED' && notice.recordId === `${staged.id}/page:33`));
  const initial = await origin.apply(initialPreview);
  assert.equal(initial.status, 201, JSON.stringify(initial.data));
  const [projectId] = initial.data.import.projectIds;
  type Backup = WorkspaceSnapshot & { schemaVersion: number; sourceImports: SourceImport[]; sourceRecords: SourceRecordArchive[] };
  const backup = (await origin.call<Backup>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const initialDocuments = backup.documents.filter(document => document.projectId === projectId);
  const originalParent = initialDocuments.find(document => document.title === '처음 상위')!;
  const destination = initialDocuments.find(document => document.title === '새 상위')!;
  const subject = initialDocuments.find(document => document.title === '위치를 이동할 문서')!;
  const otherParent = initialDocuments.find(document => document.title === '별도 패키지의 상위')!;
  const locallyMoved = initialDocuments.find(document => document.title === '팀에서 옮긴 문서')!;
  assert.equal(subject.parentId, originalParent.id);
  assert.equal(locallyMoved.parentId, null);
  const old = historicalMigrationBackup(backup, 98);
  assert.equal((await target.call('/import', 'POST', { data: old })).status, 400);
  for (const receipt of old.sourceImports) delete receipt.integrity;
  for (const record of old.sourceRecords) if (record.confluencePageFieldHashes) delete record.confluencePageFieldHashes.parentId;
  const restored = await target.call('/import', 'POST', { data: old });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  const teamMove = await target.call<DocPage>(`/documents/${locallyMoved.id}`, 'PATCH', {
    expectedVersion: locallyMoved.version, parentId: otherParent.id,
  });
  assert.equal(teamMove.status, 200, JSON.stringify(teamMove.data));

  async function preview(packageSummary: LegacyPackageSummary) {
    return target.preview({ ...await target.configuration(packageSummary, 'TREE'), appendPagesTo: { projectId, refreshExisting: true } });
  }
  const followUp = await upload(target, 'newer-hierarchy', [page(30, subject.title, 5, '03', 20),
    page(31, '제목만 갱신한 문서', 6, '03'), page(32, '확인할 상위가 없는 문서', 6, '03', 999),
    page(33, locallyMoved.title, 6, '03', 20)]);
  const reviewed = await preview(followUp);
  assert.equal(reviewed.canApply, true, JSON.stringify(reviewed.notices));
  assert.ok(reviewed.notices.some(notice => notice.code === 'CONFLUENCE_REFRESH_PARENT_UNAVAILABLE'));
  assert.deepEqual(reviewed.documentRefresh?.find(row => row.sourceId === '30')?.fields,
    [{ field: 'parentId', current: originalParent.title, incoming: destination.title, decision: 'apply' }]);
  assert.deepEqual(reviewed.documentRefresh?.find(row => row.sourceId === '33')?.fields,
    [{ field: 'parentId', current: otherParent.title, incoming: destination.title, decision: 'conflict' }]);
  assert.ok(reviewed.notices.some(notice => notice.code === 'CONFLUENCE_REFRESH_PARENT_BASELINE_UNAVAILABLE' &&
    notice.recordId === `${followUp.id}/page:33`));
  for (const id of ['31', '32']) assert.deepEqual(reviewed.documentRefresh?.find(row => row.sourceId === id)?.fields.map(field => field.field), ['title']);
  const applied = await target.apply(reviewed);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const after = (await target.call<Backup>('/export')).data;
  assert.equal(after.documents.find(document => document.id === subject.id)?.parentId, destination.id);
  assert.equal(after.documents.find(document => document.id === locallyMoved.id)?.parentId, otherParent.id);
  assert.equal(after.documents.find(document => document.title === '제목만 갱신한 문서')?.parentId, originalParent.id);
  assert.equal(after.documents.find(document => document.title === '확인할 상위가 없는 문서')?.parentId, originalParent.id);
  assert.match(after.sourceRecords.find(row => row.sourceImportId === applied.data.import.id && row.targetId === subject.id)?.confluencePageFieldHashes?.parentId ?? '', /^[a-f0-9]{64}$/u);

  const equalTime = await upload(target, 'equal-time-hierarchy', [page(30, subject.title, 5, '03', 10)]);
  const unproven = await preview(equalTime);
  assert.equal(unproven.canApply, false);
  assert.deepEqual(unproven.documentRefresh, []);
  assert.equal((await target.call<WorkspaceSnapshot>('/workspace')).data.documents.find(document => document.id === subject.id)?.parentId, destination.id);

  const native = await fixture();
  t.after(() => native.close());
  const restoredCurrent = await native.call('/import', 'POST', { data: after });
  assert.equal(restoredCurrent.status, 200, JSON.stringify(restoredCurrent.data));
  const later = await upload(native, 'after-format-99-restore', [page(30, subject.title, 6, '04', 10)]);
  const reviewAfterRestore = await native.preview({ ...await native.configuration(later, 'TREE'), appendPagesTo: { projectId, refreshExisting: true } });
  assert.equal(reviewAfterRestore.canApply, true, JSON.stringify(reviewAfterRestore.notices));
  assert.deepEqual(reviewAfterRestore.documentRefresh?.[0].fields, [
    { field: 'parentId', current: destination.title, incoming: originalParent.title, decision: 'apply' },
  ]);
  assert.equal((await native.apply(reviewAfterRestore)).status, 201);
  assert.equal((await native.call<WorkspaceSnapshot>('/workspace')).data.documents.find(document => document.id === subject.id)?.parentId, originalParent.id);
});

test('reviewed Confluence deltas preserve local edits, guard collaborative sessions and restore the comparison baseline', async t => {
  const initial = await fixture(), f = await fixture();
  const sockets = new Set<WebSocket>();
  t.after(() => {
    for (const socket of sockets) socket.terminate();
    return Promise.all([initial.close(), f.close()]);
  });
  f.attachCollaboration();
  const source = 'synthetic-confluence-refresh';
  const prop = (name: string, value: string) => `<property name="${name}">${value}</property>`;
  const ref = (name: string, kind: string, id: string) => `<property name="${name}" class="${kind}"><id name="id">${id}</id></property>`;
  const object = (kind: string, id: string, content: string) => `<object class="${kind}"><id name="id">${id}</id>${content}</object>`;
  const page = (id: string, title: string, version: number, modified: string, storage?: string, parent?: string) => [
    object('Page', id, prop('title', title) + prop('version', String(version)) + ref('space', 'Space', '42') +
      prop('creationDate', '2020-03-01T00:00:00Z') + prop('lastModificationDate', modified) + (parent ? ref('parent', 'Page', parent) : '')),
    ...(storage === undefined ? [] : [object('BodyContent', `8${id}`, prop('body', `<![CDATA[${storage}]]>`) + ref('content', 'Page', id))]),
  ].join('');
  const upload = (target: MigrationFixture, name: string, rows: string[]) => target.upload(zip([{
    path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>${object('Space', '42', prop('key', 'WIKIREV') + prop('name', '팀 원본 문서'))}${rows.join('')}</hibernate-generic>`),
  }]), `${name}.zip`, 'confluence', source);
  const initialPack = await upload(initial, 'initial-pages', [
    page('100', '이전 원본 제목', 1, '2020-03-02T00:00:00Z', '<p>이전 본문</p>'),
    page('200', '지원 문서', 1, '2020-03-02T00:00:00Z', '<p>지원하는 기존 본문</p>'),
  ]);
  const first = await initial.apply(await initial.preview(await initial.configuration(initialPack, 'WREF')));
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const [projectId] = first.data.import.projectIds;
  type Backup = WorkspaceSnapshot & {schemaVersion: number; sourceImports: SourceImport[]; sourceRecords: SourceRecordArchive[]; revisions: DocRevision[]};
  const previous = historicalMigrationBackup((await initial.call<Backup>('/export')).data, 39);
  for (const receipt of previous.sourceImports) delete receipt.integrity;
  for (const record of previous.sourceRecords) {
    delete record.confluencePageFieldHashes;
    delete record.confluencePageBodySourceHash;
  }
  assert.equal((await f.call('/import', 'POST', { data: previous })).status, 200);
  const snapshot = () => f.call<WorkspaceSnapshot>('/workspace').then(result => result.data);
  const [document, supporting] = (await snapshot()).documents.filter(doc => doc.projectId === projectId);
  assert.equal(document.title, '이전 원본 제목');
  assert.equal(supporting.title, '지원 문서');
  const path = `/documents/${document.id}`;
  const edit = await f.call<DocPage>(path, 'PATCH', { expectedVersion: document.version, title: '팀이 수정한 문서 제목' });
  assert.equal(edit.status, 200);
  const enabled = await f.call<CollaborationSession>(`${path}/collaboration/enable`, 'POST', { expectedVersion: edit.data.version });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  const collaboration = async () => (await f.call<CollaborationSession>(`${path}/collaboration`)).data;

  const body = '<p>새 <strong>본문</strong> <ac:link><ri:page ri:content-id="200"/><ac:link-body>지원하는 문서</ac:link-body></ac:link></p>';
  const delta = await upload(f, 'newer-pages', [
    page('100', '원본에서 바뀐 제목', 2, '2020-03-03T00:00:00Z', body),
    page('200', '지원 문서 개정판', 2, '2020-03-03T00:00:00Z'),
  ]);
  async function configuration(pkg: LegacyPackageSummary): Promise<MigrationConfiguration> {
    const options = (await f.call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`)).data;
    assert.equal(options.appendPagesTarget?.projectId, projectId);
    return { ...options.defaultConfiguration, appendPagesTo: { projectId, refreshExisting: true } };
  }
  const config = await configuration(delta);
  assert.equal((await f.preview({ ...config, appendPagesTo: { projectId } })).canApply, false);
  assert.equal((await f.call('/migrations/preview', 'POST', { configuration: { ...config, appendPagesTo: { projectId, refreshExisting: false } } })).status, 400);
  const reviewed = await f.preview(config);
  assert.equal(reviewed.canApply, true, JSON.stringify(reviewed.notices));
  assert.equal(reviewed.counts.documents, 0);
  assert.equal(reviewed.counts.updatedDocuments, 2);
  assert.equal(reviewed.counts.updatedDocumentFields, 2);
  assert.equal(reviewed.counts.conflictingDocumentFields, 1);
  const comparison = reviewed.documentRefresh?.find(row => row.documentId === document.id);
  assert.ok(comparison);
  assert.deepEqual(Object.fromEntries(comparison.fields.map(field => [field.field, field.decision])), { title: 'conflict', content: 'apply' });

  async function connect(epoch: string | null, documentId = document.id) {
    const wsUrl = `${f.base.replace('http:', 'ws:')}/collaboration?${new URLSearchParams({ documentId, actorId: 'user-min' })}`;
    const socket = new WebSocket(wsUrl);
    sockets.add(socket);
    await once(socket, 'open');
    const incoming = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'hello', epoch, schemaVersion: COLLABORATION_SCHEMA }));
    const [bytes] = await incoming;
    return { socket, message: JSON.parse(String(bytes)) as CollaborationServerMessage };
  }
  const live = await connect(enabled.data.epoch);
  assert.equal(live.message.type, 'welcome');
  assert.equal((await f.apply(reviewed)).status, 409);
  const busy = await f.preview(config);
  assert.equal(busy.canApply, false);
  assert.ok(busy.notices.some(notice => notice.code === 'CONFLUENCE_REFRESH_VALIDATION' && notice.message.includes('공동 편집')));
  const closed = once(live.socket, 'close');
  live.socket.close();
  await closed;

  const beforeEdit = await f.preview(config);
  const lastEdit = await f.call<DocPage>(path, 'PATCH', { expectedVersion: enabled.data.document.version, title: '검토 후 다시 편집한 문서 제목' });
  assert.equal(lastEdit.status, 200);
  assert.equal((await f.apply(beforeEdit)).status, 409);
  const fresh = await f.preview(config);
  assert.equal(fresh.canApply, true, JSON.stringify(fresh.notices));
  f.db.exec(`CREATE TRIGGER fail_confluence_refresh_receipt BEFORE INSERT ON source_imports
    BEGIN SELECT RAISE(ABORT, 'synthetic Confluence refresh receipt failure'); END`);
  try { assert.equal((await f.apply(fresh)).status, 500); }
  finally { f.db.exec('DROP TRIGGER fail_confluence_refresh_receipt'); }
  assert.equal((await collaboration()).epoch, enabled.data.epoch);
  assert.deepEqual((await collaboration()).document, lastEdit.data);

  const result = await f.apply(fresh);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal((await f.apply(fresh)).data.duplicate, true);
  const applied = await collaboration();
  assert.notEqual(applied.epoch, enabled.data.epoch);
  assert.equal(applied.document.title, lastEdit.data.title);
  assert.equal(applied.document.version, lastEdit.data.version + 1);
  assert.match(applied.document.plainText, /새 본문/);
  assert.deepEqual(contentReferences(applied.document.content).map(reference => reference.id), [supporting.id]);
  const renamed = (await snapshot()).documents.find(doc => doc.id === supporting.id);
  assert.equal(renamed?.title, '지원 문서 개정판');
  assert.equal(renamed?.plainText, supporting.plainText);
  const offline = await connect(enabled.data.epoch);
  assert.equal(offline.message.type, 'reset');
  if (offline.message.type === 'reset') assert.equal(offline.message.epoch, applied.epoch);
  offline.socket.terminate();

  const backup = (await f.call<Backup>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const revisions = backup.revisions.filter(record => record.documentId === document.id);
  assert.ok(revisions.some(revision => revision.plainText === '이전 본문'));
  assert.equal(revisions.filter(revision => revision.version === applied.document.version).length, 1);
  assert.ok(backup.sourceRecords.find(record => record.sourceImportId === result.data.import.id && record.targetId === document.id)?.confluencePageFieldHashes?.content);
  assert.equal((await f.call('/import', 'POST', { data: historicalMigrationBackup(backup, 39) })).status, 400);
  assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
  assert.equal((await f.preview(config)).canApply, false);

  const outdated = await upload(f, 'older-source-version', [page('100', '이전 원본 제목', 1, '2020-03-07T00:00:00Z', '<p>덮어쓰면 안 되는 본문</p>')]);
  assert.equal((await f.preview(await configuration(outdated))).canApply, false);
  const withoutTitle = await upload(f, 'body-without-original-title', [
    page('200', '', 3, '2020-03-04T00:00:00Z', '<p>제목 없이 제출한 본문 변경</p>'),
  ]);
  const bodyOnly = await f.preview(await configuration(withoutTitle));
  assert.equal(bodyOnly.canApply, true, JSON.stringify(bodyOnly.notices));
  assert.equal((await f.apply(bodyOnly)).status, 201);
  const currentSupporting = (await snapshot()).documents.find(doc => doc.id === supporting.id)!;
  assert.equal(currentSupporting.title, '지원 문서 개정판');
  assert.equal(currentSupporting.plainText, '제목 없이 제출한 본문 변경');
  assert.equal((await f.call(`/documents/${supporting.id}`, 'PATCH', {
    expectedVersion: currentSupporting.version,
    content: { type: 'doc', content: [{ type: 'documentInclude', attrs: { documentId: document.id, label: '팀 문서' } }] },
  })).status, 200);
  const wouldCycle = await upload(f, 'cycle-with-existing-local-document', [
    page('100', '원본에서 바뀐 제목', 3, '2020-03-04T00:00:00Z',
      '<ac:structured-macro ac:name="include"><ac:parameter ac:name=""><ri:page ri:content-id="200"/></ac:parameter></ac:structured-macro>'),
  ]);
  const cyclic = await f.preview(await configuration(wouldCycle));
  assert.equal(cyclic.canApply, false);
  assert.ok(cyclic.notices.some(notice => notice.code === 'CONFLUENCE_REFRESH_VALIDATION' && notice.message.includes('순환')));
  const formatOnly = body.replace('<strong>본문</strong>', '<em>본문</em>');
  const mixedPack = await upload(f, 'format-and-new-page', [
    page('100', '원본에서 바뀐 제목', 3, '2020-03-04T00:00:00Z', formatOnly),
    page('300', '원본 제목 변경 뒤 추가한 하위 문서', 1, '2020-03-04T00:00:00Z',
      '<p><ac:link><ri:page ri:content-title="지원 문서 개정판"/></ac:link></p>', '100'),
  ]);
  const mixed = await f.preview(await configuration(mixedPack));
  assert.equal(mixed.canApply, true, JSON.stringify(mixed.notices));
  assert.equal(mixed.counts.documents, 1);
  assert.equal(mixed.counts.updatedDocuments, 1);
  assert.equal(mixed.documentRefresh?.[0]?.fields.find(field => field.field === 'content')?.formatOnly, true);
  assert.equal((await f.apply(mixed)).status, 201);
  const added = (await snapshot()).documents.find(doc => doc.title === '원본 제목 변경 뒤 추가한 하위 문서');
  assert.ok(added);
  assert.equal(added.parentId, document.id);
  assert.deepEqual(contentReferences(added.content).map(reference => reference.id), [supporting.id]);

  const supportingPath = `/documents/${supporting.id}/collaboration`;
  const latestSupporting = (await snapshot()).documents.find(doc => doc.id === supporting.id)!;
  const supportingSession = await f.call<CollaborationSession>(`${supportingPath}/enable`, 'POST', { expectedVersion: latestSupporting.version });
  assert.equal(supportingSession.status, 200);
  const metadataPeer = await connect(supportingSession.data.epoch, supporting.id);
  assert.equal(metadataPeer.message.type, 'welcome');
  const titlePack = await upload(f, 'collaborating-title-only', [page('200', '지원 문서 새 원본 제목', 4, '2020-03-05T00:00:00Z')]);
  const titleOnly = await f.preview(await configuration(titlePack));
  assert.equal(titleOnly.canApply, true, JSON.stringify(titleOnly.notices));
  const receivedMetadata = once(metadataPeer.socket, 'message', { signal: AbortSignal.timeout(6000) });
  const [titleApplied, [bytes]] = await Promise.all([f.apply(titleOnly), receivedMetadata]);
  assert.equal(titleApplied.status, 201);
  const metadata = JSON.parse(String(bytes)) as CollaborationServerMessage;
  assert.equal(metadata.type, 'update');
  if (metadata.type === 'update') {
    assert.equal(metadata.epoch, supportingSession.data.epoch);
    assert.equal(metadata.document.title, '지원 문서 새 원본 제목');
    assert.deepEqual(metadata.document.content, supportingSession.data.document.content);
  }
});

test('Confluence refresh replaces an exact legacy table of contents and preserves an independently edited body', async t => {
  const initial = await fixture(), f = await fixture();
  t.after(() => Promise.all([initial.close(), f.close()]));
  const source = 'confluence-legacy-toc';
  const macro = '<ac:structured-macro ac:name="toc"></ac:structured-macro>';
  const prop = (key: string, value: string) => `<property name="${key}">${value}</property>`;
  const object = (kind: string, id: string, value: string) => `<object class="${kind}"><id name="id">${id}</id>${value}</object>`;
  const link = (name: string, kind: string, id: string) => `<property name="${name}" class="${kind}"><id name="id">${id}</id></property>`;
  const title = (id: string) => `원본 ${id}`;
  const upload = (target: MigrationFixture, version: number, heading: string) => {
    const space = object('Space', '42', prop('key', 'TOC') + prop('name', '합성 원본 목차'));
    const pages = ['100', '200'].flatMap(id => [
      object('Page', id, prop('title', title(id)) + prop('version', String(version)) + link('space', 'Space', '42') +
        prop('creationDate', '2020-03-01T00:00:00Z') + prop('lastModificationDate', `2020-03-0${version + 1}T00:00:00Z`)),
      object('BodyContent', `8${id}`, prop('body', `<![CDATA[${macro}<h2>${heading}</h2>]]>`) + link('content', 'Page', id)),
    ]).join('');
    const bytes = Buffer.from(`<hibernate-generic>${space}${pages}</hibernate-generic>`);
    return target.upload(zip([{ path: 'entities.xml', bytes }]), `toc-v${version}.zip`, 'confluence', source);
  };
  const original = await upload(initial, 1, '이전 제목');
  const applied = await initial.apply(await initial.preview(await initial.configuration(original, 'OLDTC')));
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const [projectId] = applied.data.import.projectIds;
  type Backup = WorkspaceSnapshot & { schemaVersion: number; revisions: DocRevision[]; sourceImports: SourceImport[]; sourceRecords: SourceRecordArchive[] };
  const backup = historicalMigrationBackup((await initial.call<Backup>('/export')).data, 39);
  for (const receipt of backup.sourceImports) delete receipt.integrity;
  for (const record of backup.sourceRecords) {
    delete record.confluencePageFieldHashes;
    delete record.confluencePageBodySourceHash;
  }
  const oldContent = (heading: string) => normalizeDocumentContent({ type: 'doc', content: [
    { type: 'codeBlock', content: [{ type: 'text', text: macro }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: heading }] },
  ] });
  const documents = backup.documents.filter(document => document.projectId === projectId);
  const untouched = documents.find(document => document.title === title('100'))!;
  const edited = documents.find(document => document.title === title('200'))!;
  assert.ok(untouched && edited);
  Object.assign(untouched, oldContent('이전 제목'));
  Object.assign(edited, oldContent('팀에서 바꾼 제목'));
  for (const revision of backup.revisions.filter(revision => documents.some(document => document.id === revision.documentId))) {
    Object.assign(revision, oldContent('이전 제목'));
  }
  const restored = await f.call('/import', 'POST', { data: backup });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  const restoredEdited = (await f.call<WorkspaceSnapshot>('/workspace')).data.documents.find(document => document.id === edited.id);
  assert.match(restoredEdited?.plainText ?? '', /팀에서 바꾼 제목/);

  const next = await upload(f, 2, '새 원본 제목');
  const config = await f.configuration(next);
  const plan = await f.preview({ ...config, appendPagesTo: { projectId, refreshExisting: true } });
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.equal(plan.documentRefresh?.find(row => row.documentId === untouched.id)?.fields.find(field => field.field === 'content')?.decision, 'apply');
  assert.equal(plan.documentRefresh?.find(row => row.documentId === edited.id)?.fields.find(field => field.field === 'content')?.decision, 'conflict');
  assert.equal((await f.apply(plan)).status, 201);
  const result = (await f.call<WorkspaceSnapshot>('/workspace')).data.documents;
  const converted = result.find(document => document.id === untouched.id);
  assert.deepEqual(converted?.content.content?.[0], { type: 'documentToc', attrs: { minLevel: 1, maxLevel: 6, layout: 'list' } });
  assert.match(converted?.plainText ?? '', /새 원본 제목/);
  assert.deepEqual(result.find(document => document.id === edited.id)?.content, restoredEdited?.content);
});

type LabelListSourcePage = { id: string; title: string; version?: number; space?: string; kind?: 'Page' | 'BlogPost'; body?: string };
const confluenceListParameter = (name: string, value: string) => `<ac:parameter ac:name="${name}">${value}</ac:parameter>`;
const confluenceListMacro = (params: Record<string, string>) => `<ac:structured-macro ac:name="contentbylabel">${Object.entries(params)
  .map(([key, value]) => confluenceListParameter(key, value)).join('')}</ac:structured-macro>`;
const confluenceLegacyList = confluenceListMacro({ type: 'page', spaces: '@self', labels: 'release' });

function labelListExport(target: MigrationFixture, instance: string, name: string, pages: LabelListSourcePage[], spaces: string[] = ['42']) {
  const prop = (key: string, value: string) => `<property name="${key}">${value}</property>`;
  const object = (kind: string, id: string, value: string) => `<object class="${kind}"><id name="id">${id}</id>${value}</object>`;
  const link = (key: string, kind: string, id: string) => `<property name="${key}" class="${kind}"><id name="id">${id}</id></property>`;
  const root = spaces.map(id => object('Space', id, prop('key', `WIKI${id}`) + prop('name', `원본 공간 ${id}`))).join('');
  const records = pages.map(({ id, title, version = 1, space = '42', kind = 'Page', body }) =>
    object(kind, id, prop('title', title) + prop('version', String(version)) + link('space', 'Space', space) +
      prop('creationDate', '2020-03-01T00:00:00Z') + prop('lastModificationDate', `2020-03-0${version + 1}T00:00:00Z`)) +
    (body === undefined ? '' : object('BodyContent', `8${id}`, prop('body', `<![CDATA[${body}]]>`) + link('content', kind, id)))).join('');
  const bytes = Buffer.from(`<hibernate-generic>${root}${records}</hibernate-generic>`);
  return target.upload(zip([{ path: 'entities.xml', bytes }]), `${name}.zip`, 'confluence', instance);
}

test('Confluence recovers only proven old Jira anchors from the same page revision', async t => {
  const initial = await fixture(), restored = await fixture();
  t.after(() => Promise.all([initial.close(), restored.close()]));
  const instance = 'synthetic-confluence-jira-anchors';
  const origin = 'https://wiki.example.test/confluence';
  const href = 'https://jira.example.test/jira/browse/OPS-7?focusedCommentId=42#comment-42';
  const link = `<p>릴리스 <a href="${href}"><strong>원래 댓글</strong></a> 확인</p>`;
  const pages = [
    { id: '811', title: '원본 링크 그대로', body: link },
    { id: '812', title: '팀이 수정한 링크 문서', body: link },
    { id: '813', title: '확인할 수 없는 첨부', body: link + '<p><ac:link><ri:attachment ri:filename="missing.pdf" /></ac:link></p>' },
  ];
  const uploaded = await labelListExport(initial, instance, 'original-jira-anchors', pages);
  const config = await initial.configuration(uploaded, 'JIRAANCHOR');
  config.sourceBaseUrls[uploaded.id] = origin;
  const applied = await initial.apply(await initial.preview(config));
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const [projectId] = applied.data.import.projectIds;
  type Backup = WorkspaceSnapshot & { revisions: DocRevision[]; sourceImports: SourceImport[]; sourceRecords: SourceRecordArchive[] };
  const { data: backup } = await initial.call<Backup>('/export');
  const archives = backup.sourceRecords.filter(archive => archive.record.kind === 'page' && archive.targetId);
  assert.equal(archives.length, 3);
  const nativeBySource = new Map(archives.map(archive => [archive.record.sourceId, archive.targetId!]));
  const retainedLink = (document: Pick<DocPage, 'content'>) =>
    document.content.content?.[0].content?.find(node => node.text === '원래 댓글')?.marks;
  for (const archive of archives) {
    const document = backup.documents.find(item => item.id === archive.targetId)!;
    assert.ok(retainedLink(document)?.some(mark => mark.type === 'link' && mark.attrs?.href === href));
    assert.ok(retainedLink(document)?.some(mark => mark.type === 'bold'));
    const former = convertLegacyContent(archive.record, { resolveReference: () => null, legacyConfluenceJiraAnchorProjection: true });
    assert.ok(former.diagnostics.some(item => item.code === 'LEGACY_CONFLUENCE_JIRA_ANCHOR'));
    const oldBody = normalizeDocumentContent(former.content);
    assert.match(oldBody.plainText, /업무 참조/u);
    Object.assign(document, oldBody);
    for (const revision of backup.revisions.filter(revision => revision.documentId === document.id)) Object.assign(revision, oldBody);
    assert.ok(archive.confluencePageFieldHashes);
    archive.confluencePageFieldHashes.content = confluencePageFieldDigest('content', oldBody.content);
    delete archive.confluencePageBodySourceHash;
  }
  for (const receipt of backup.sourceImports) {
    if (receipt.integrity) {
      const records = backup.sourceRecords.filter(archive => archive.sourceImportId === receipt.id);
      receipt.integrity.packages = measureIncomingArchive(receipt, records).packages;
    }
  }
  const restoredResult = await restored.call('/import', 'POST', { data: backup });
  assert.equal(restoredResult.status, 200, JSON.stringify(restoredResult.data));
  const readDocs = async () => new Map((await restored.call<WorkspaceSnapshot>('/workspace')).data.documents.map(document => [document.id, document]));
  const original = await readDocs();
  const edited = original.get(nativeBySource.get('812')!)!;
  const save = await restored.call<DocPage>(`/documents/${edited.id}`, 'PATCH', {
    expectedVersion: edited.version, contentSchemaVersion: documentContentSchemaVersion(edited.content),
    content: { type: 'doc', content: [...edited.content.content!, { type: 'paragraph', content: [{ type: 'text', text: '팀이 쓴 새 문장' }] }] },
  });
  assert.equal(save.status, 200, JSON.stringify(save.data));

  const repeated = await labelListExport(restored, instance, 'review-jira-anchors', pages);
  const reviewConfig = await restored.configuration(repeated);
  reviewConfig.sourceBaseUrls[repeated.id] = origin;
  const review = await restored.preview({ ...reviewConfig, appendPagesTo: { projectId, refreshExisting: true } });
  assert.equal(review.canApply, true, JSON.stringify(review.notices));
  const decisions = new Map(review.documentRefresh?.map(row => [row.sourceId, row.fields.find(field => field.field === 'content')?.decision]));
  assert.equal(decisions.get('811'), 'apply');
  assert.equal(decisions.get('812'), 'conflict');
  assert.equal(decisions.get('813'), undefined);
  assert.equal(review.notices.filter(item => item.code === 'CONFLUENCE_REFRESH_JIRA_ANCHORS_RESTORED').length, 1);
  const result = await restored.apply(review);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const current = await readDocs();
  assert.ok(retainedLink(current.get(nativeBySource.get('811')!)!)?.some(mark => mark.attrs?.href === href));
  assert.deepEqual(current.get(edited.id)?.content, save.data.content);
  assert.deepEqual(current.get(nativeBySource.get('813')!)?.content, original.get(nativeBySource.get('813')!)?.content);
});

test('Confluence inline comment text survives actual import, version refresh, and restore with its raw anchor retained', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const instance = 'synthetic-confluence-inline-review';
  const marker = (word: string, id: string) => `<ac:inline-comment-marker ac:ref="${id}"><strong>${word}</strong></ac:inline-comment-marker>`;
  const pages = (version: number, outcome: string) => [100, 101].map(id => ({
    id: String(id), title: `원본 리뷰 ${id}`, version,
    body: `<h2>검토 결과</h2><p>배포 승인 ${marker(outcome, `selection-${id}`)} 뒤 확인</p>`,
  }));
  const v1 = pages(1, '이관할 핵심 문장');
  const initial = await labelListExport(f, instance, 'inline-comments-v1', v1);
  const plan = await f.preview(await f.configuration(initial, 'MARKER'));
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.ok(plan.notices.some(item => item.code === 'INLINE_COMMENT_ANCHOR_ARCHIVED'));
  const applied = await f.apply(plan);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const [projectId] = applied.data.import.projectIds;
  const readDocs = async () => (await f.call<WorkspaceSnapshot>('/workspace')).data.documents.filter(document => document.projectId === projectId);
  const original = await readDocs();
  assert.equal(original.length, 2);
  for (const document of original) {
    assert.match(document.plainText, /배포 승인 이관할 핵심 문장 뒤 확인/u);
    assert.doesNotMatch(document.plainText, /inline-comment-marker|selection-10/u);
    assert.equal(document.content.content?.[1].content?.[1].marks?.[0]?.type, 'bold');
  }
  const edited = original.find(document => document.title === v1[1].title)!;
  const editedBody = normalizeDocumentContent({ type: 'doc', content: [...(edited.content.content ?? []), {
    type: 'paragraph', content: [{ type: 'text', text: '팀에서 추가한 검토' }],
  }] });
  const saved = await f.call<DocPage>(`/documents/${edited.id}`, 'PATCH', {
    expectedVersion: edited.version, contentSchemaVersion: documentContentSchemaVersion(edited.content), content: editedBody.content,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const v2 = pages(2, '갱신한 승인 결과');
  const next = await labelListExport(f, instance, 'inline-comments-v2', v2);
  const refresh = await f.preview({ ...await f.configuration(next), appendPagesTo: { projectId, refreshExisting: true } });
  assert.equal(refresh.canApply, true, JSON.stringify(refresh.notices));
  const decisions = new Map(refresh.documentRefresh?.map(row => [row.sourceId, row.fields.find(field => field.field === 'content')?.decision]));
  assert.deepEqual([...decisions].sort(), [['100', 'apply'], ['101', 'conflict']]);
  const reapplied = await f.apply(refresh);
  assert.equal(reapplied.status, 201, JSON.stringify(reapplied.data));
  const refreshed = await readDocs();
  const updated = refreshed.find(document => document.title === v2[0].title)!;
  assert.match(updated.plainText, /배포 승인 갱신한 승인 결과 뒤 확인/u);
  assert.deepEqual(refreshed.find(document => document.id === edited.id)?.content, saved.data.content);

  const { data: backup } = await f.call<WorkspaceSnapshot & { sourceRecords: SourceRecordArchive[] }>('/export');
  for (const input of [...v1, ...v2]) {
    assert.ok(backup.sourceRecords.some(row => row.record.sourceId === input.id && row.record.text === input.body));
  }
  const restored = await f.call('/import', 'POST', { data: backup });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  const restoredDocuments = await readDocs();
  for (const document of refreshed) assert.deepEqual(restoredDocuments.find(row => row.id === document.id)?.content, document.content);

  const current = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const results = searchWorkspace(current, { ...DEFAULT_WORKSPACE_SEARCH_FILTERS, scope: `project:${projectId}`, query: '갱신한 승인 결과' });
  const sectionId = updated.content.content?.[0].attrs?.sectionId;
  assert.ok(sectionId);
  assert.deepEqual(results.items, [{ kind: 'document', document: current.documents.find(document => document.id === updated.id),
    parentTitles: [], excerpt: '배포 승인 갱신한 승인 결과 뒤 확인', sectionId }]);
});

test('Confluence inline comments use verified native revisions through history append, body refresh, and restore', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const prop = (name: string, value: string) => `<property name="${name}"><![CDATA[${value}]]></property>`;
  const ref = (name: string, kind: string, id: string) => `<property name="${name}" class="${kind}"><id name="id">${id}</id></property>`;
  const object = (kind: string, id: string, fields: string) => `<object class="${kind}"><id name="id">${id}</id>${fields}</object>`;
  const dates = (version: number) => prop('creationDate', '2020-03-01T00:00:00Z') +
    prop('lastModificationDate', `2020-03-0${version + 1}T00:00:00Z`);
  const body = (kind: string, id: string, storage: string) =>
    object('BodyContent', `${kind === 'Page' ? '1' : '2'}${id}`, prop('body', storage) + ref('content', kind, id));
  const page = (id: string, version: number, storage: string) => object('Page', id,
    prop('title', `이관 문서 ${id}`) + prop('version', String(version)) + ref('space', 'Space', '42') + dates(version)) + body('Page', id, storage);
  const marker = (id: string, selection: string) => `<p>확인 <ac:inline-comment-marker ac:ref="${id}"><em>${selection}</em></ac:inline-comment-marker> 결과</p>`;
  const comment = (id: string, owner: string, markerRef: string, text: string) => {
    const property = (prefix: string, name: string, value: string) =>
      object('ContentProperty', prefix + id, prop('name', name) + prop('stringValue', value) + ref('contentEntity', 'Comment', id));
    return object('Comment', id, ref('containerContent', 'Page', owner) + dates(1)) +
      property('3', 'inline-marker-ref', markerRef) +
      property('4', 'inline-original-selection', '댓글 작성 당시 저장한 원본 문구') + body('Comment', id, `<p>${text}</p>`);
  };
  const reply = (id: string, owner: string, parent: string, text: string) => object('Comment', id,
    ref('containerContent', 'Page', owner) + ref('parent', 'Comment', parent) + dates(1)) + body('Comment', id, `<p>${text}</p>`);
  const upload = (name: string, records: string) => f.upload(zip([{ path: 'entities.xml', bytes: Buffer.from(
    `<hibernate-generic>${object('Space', '42', prop('key', 'WIKI42') + prop('name', '원본 댓글 공간'))}${records}</hibernate-generic>`,
  ) }]), `${name}.zip`, 'confluence', 'synthetic-confluence-inline-thread');
  const original100 = `<p>선택 1의 위치</p>${marker('selection-1', '선택 1의 위치')}${marker('selection-2', '추가할 기존 위치')}`;
  const original101 = marker('selection-conflict', '팀 수정과 충돌할 위치');
  const first = await upload('original-inline', page('100', 1, original100) + page('101', 1, original101) +
    reply('306', '100', '300', '원본 답글') + reply('307', '100', '306', '원본의 두 단계 답글') +
    comment('300', '100', 'selection-1', '처음 이관한 문장 댓글'));
  const firstPreview = await f.preview(await f.configuration(first, 'INLINE'));
  assert.equal(firstPreview.canApply, true, JSON.stringify(firstPreview.notices));
  assert.equal(firstPreview.counts.confluenceInlineCommentsAnchored, 1);
  assert.equal(firstPreview.counts.confluenceInlineRepliesLinked, 1);
  assert.equal(firstPreview.counts.confluenceInlineRepliesUnresolved, 1);
  const initial = await f.apply(firstPreview);
  assert.equal(initial.status, 201, JSON.stringify(initial.data));
  const [projectId] = initial.data.import.projectIds;
  const readDocuments = async () => (await f.call<WorkspaceSnapshot>('/workspace')).data.documents.filter(document => document.projectId === projectId);
  const documents = await readDocuments();
  const main = documents.find(document => document.title === '이관 문서 100')!;
  const conflict = documents.find(document => document.title === '이관 문서 101')!;
  const comments = async (id: string) => (await f.call<Comment[]>(`/comments?resourceType=document&resourceId=${id}`)).data;
  const revisions = async (id: string) => (await f.call<DocRevision[]>(`/documents/${id}/revisions`)).data;
  const initialRevision = (await revisions(main.id)).find(revision => revision.version === main.version)!;
  const initialComments = await comments(main.id);
  const initialComment = initialComments.find(row => row.body === '처음 이관한 문장 댓글')!;
  const initialReply = initialComments.find(row => row.body === '원본 답글')!;
  const nestedSourceReply = initialComments.find(row => row.body === '원본의 두 단계 답글')!;
  assert.equal(initialReply.parentCommentId, initialComment.id);
  assert.equal(initialReply.documentSource, undefined);
  assert.equal(nestedSourceReply.parentCommentId, undefined);
  const initialPin = initialComment.documentSource;
  assert.ok(initialPin);
  assert.equal(initialPin.revisionId, initialRevision.id);
  assert.equal(initialPin.text, '선택 1의 위치');
  assert.equal(readDocumentSelection(initialRevision.content, initialPin.from, initialPin.to), initialPin.text);
  assert.ok(initialPin.from > initialRevision.content.content![0].content![0].text!.length);
  const resolved = await f.call<Comment>(`/documents/${main.id}/selection-comments/${initialComment.id}/resolution`, 'PATCH', {
    state: 'resolved', expectedVersion: 0,
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.data));

  const editedBody = (document: DocPage): RichContent => ({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '팀에서 먼저 수정한 내용' }] }, ...(document.content.content ?? []),
  ] });
  const edit = (document: DocPage, content: RichContent) => f.call<DocPage>(`/documents/${document.id}`, 'PATCH', {
    expectedVersion: document.version, contentSchemaVersion: documentContentSchemaVersion(content), content,
  });
  const localConflict = await edit(conflict, editedBody(conflict));
  assert.equal(localConflict.status, 200);
  const next = await upload('additional-inline-history', page('100', 1, original100) + page('101', 1, original101) +
    reply('308', '100', '300', '원본 상위 댓글 없이 들어온 과거 답글') +
    comment('301', '100', 'selection-2', '동일한 본문에 연결할 새 댓글') +
    comment('302', '101', 'selection-conflict', '현재 본문과 다른 원본의 댓글'));
  const historyPreview = await f.preview({ ...await f.configuration(next), appendPagesTo: { projectId, refreshHistory: true } });
  assert.equal(historyPreview.canApply, true, JSON.stringify(historyPreview.notices));
  assert.equal(historyPreview.counts.confluenceInlineCommentsAnchored, 1);
  assert.equal(historyPreview.counts.confluenceInlineCommentsUnresolved, 1);
  assert.equal(historyPreview.counts.confluenceInlineRepliesLinked, 1);
  assert.ok(historyPreview.notices.some(notice => notice.code === 'CONFLUENCE_INLINE_COMMENT_ANCHOR_UNRESOLVED' && notice.recordId === `${next.id}/comment:302`));
  const archived = await f.call<{ trashItemId: string }>(`/comments/${initialComment.id}`, 'DELETE');
  assert.equal(archived.status, 200, JSON.stringify(archived.data));
  const staleParent = await f.apply(historyPreview);
  assert.equal(staleParent.status, 409, JSON.stringify(staleParent.data));
  assert.match(JSON.stringify(staleParent.data), /답글을 추가할 문장 댓글/u);
  assert.deepEqual((await comments(main.id)).map(row => row.id), [nestedSourceReply.id]);
  assert.deepEqual(await comments(conflict.id), []);
  assert.equal((await f.call(`/trash/items/${archived.data.trashItemId}/restore`, 'POST')).status, 200);
  const localMain = await edit(main, editedBody(main));
  assert.equal(localMain.status, 200);
  const stale = await f.apply(historyPreview);
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.deepEqual((await comments(main.id)).map(row => row.id).sort(), initialComments.map(row => row.id).sort());
  assert.deepEqual(await comments(conflict.id), []);
  assert.equal((await edit(localMain.data, main.content)).status, 200);
  const recovered = await f.apply(historyPreview);
  assert.equal(recovered.status, 201, JSON.stringify(recovered.data));
  const extended = await comments(main.id);
  assert.equal(extended.find(row => row.body === '동일한 본문에 연결할 새 댓글')?.documentSource?.text, '추가할 기존 위치');
  const appendedReply = extended.find(row => row.body === '원본 상위 댓글 없이 들어온 과거 답글')!;
  assert.equal(appendedReply.parentCommentId, initialComment.id);
  assert.equal(extended.find(row => row.id === initialComment.id)?.resolution?.state, 'resolved');
  assert.equal((await comments(conflict.id))[0].documentSource, undefined);

  const updated = await upload('refreshed-and-new-inline', page('100', 2, marker('selection-3', '갱신해서 승인한 위치')) +
    page('101', 2, marker('selection-4', '갱신해도 적용되지 않을 위치')) + page('102', 1, marker('selection-5', '추가 문서 원문 위치')) +
    reply('309', '100', '300', '상위 댓글과 함께 다시 내보낸 과거 답글') +
    comment('300', '100', 'selection-1', '처음 이관한 문장 댓글') +
    comment('303', '100', 'selection-3', '새 본문 버전에 연결한 댓글') +
    comment('304', '101', 'selection-4', '편집 중인 문서로 일반 이관한 댓글') +
    comment('305', '102', 'selection-5', '새 페이지에 연결한 댓글'));
  const refreshPreview = await f.preview({ ...await f.configuration(updated),
    appendPagesTo: { projectId, refreshExisting: true, refreshHistory: true } });
  assert.equal(refreshPreview.canApply, true, JSON.stringify(refreshPreview.notices));
  assert.equal(refreshPreview.counts.confluenceInlineCommentsAnchored, 2);
  assert.equal(refreshPreview.counts.confluenceInlineCommentsUnresolved, 1);
  assert.equal(refreshPreview.counts.confluenceInlineRepliesLinked, 1);
  assert.equal(refreshPreview.documentRefresh?.find(row => row.documentId === main.id)?.fields.find(field => field.field === 'content')?.decision, 'apply');
  assert.equal(refreshPreview.documentRefresh?.find(row => row.documentId === conflict.id)?.fields.find(field => field.field === 'content')?.decision, 'conflict');
  const applied = await f.apply(refreshPreview);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const current = await readDocuments();
  const refreshedMain = current.find(document => document.id === main.id)!;
  const newPage = current.find(document => document.title === '이관 문서 102')!;
  const refreshedComment = (await comments(main.id)).find(row => row.body === '새 본문 버전에 연결한 댓글');
  const newPageComment = (await comments(newPage.id))[0];
  const refreshedRevision = (await revisions(main.id)).find(revision => revision.version === refreshedMain.version)!;
  assert.equal(refreshedComment?.documentSource?.text, '갱신해서 승인한 위치');
  assert.equal(refreshedComment?.documentSource?.revisionId, refreshedRevision.id);
  assert.equal(refreshedRevision.confluenceSourceVersion, undefined);
  assert.equal(newPageComment.documentSource?.text, '추가 문서 원문 위치');
  assert.deepEqual((await comments(main.id)).find(row => row.id === initialComment.id)?.documentSource, initialPin);
  assert.deepEqual(current.find(document => document.id === conflict.id)?.content, localConflict.data.content);
  assert.ok((await comments(conflict.id)).every(row => !row.documentSource));
  assert.equal((await f.apply(refreshPreview)).status, 200);
  const finalComments = await comments(main.id);
  assert.equal(finalComments.length, 7);
  assert.equal(finalComments.find(row => row.body === '상위 댓글과 함께 다시 내보낸 과거 답글')?.parentCommentId, initialComment.id);
  const backup = (await f.call<WorkspaceSnapshot & { sourceRecords: SourceRecordArchive[] }>('/export')).data;
  assert.equal(backup.sourceRecords.find(row => row.targetId === initialComment.id)?.record.metadata.confluenceInlineOriginalSelection, '댓글 작성 당시 저장한 원본 문구');
  const restored = await f.call('/import', 'POST', { data: backup });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.deepEqual((await comments(main.id)).find(row => row.id === refreshedComment?.id)?.documentSource, refreshedComment?.documentSource);
  assert.deepEqual((await comments(newPage.id))[0].documentSource, newPageComment.documentSource);
  assert.equal((await comments(main.id)).find(row => row.id === appendedReply.id)?.parentCommentId, initialComment.id);
});

test('Confluence retained title and body changes survive partial receipts and portable restore without remapping accepted raw content', async t => {
  const [source, restored, older] = await Promise.all([fixture(), fixture(), fixture()]);
  t.after(() => Promise.all([source.close(), restored.close(), older.close()]));
  const instance = 'synthetic-confluence-partial-refresh';
  const linkedBody = '<p><ac:link><ri:page ri:content-id="400"/></ac:link></p>';
  const initialPages = [
    { id: '100', title: '처음 제목 A', body: '<p>처음 본문 A</p>' },
    { id: '200', title: '처음 제목 B', body: '<p>처음 본문 B</p>' },
    { id: '300', title: '연결 문서', body: linkedBody },
    { id: '400', title: '이전 연결 대상', body: '<p>지원 문서</p>' },
  ];
  const original = await labelListExport(source, instance, 'partial-v1', initialPages);
  const first = await source.apply(await source.preview(await source.configuration(original, 'CFRT')));
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const [projectId] = first.data.import.projectIds;
  const workspace = async (target: MigrationFixture) => (await target.call<WorkspaceSnapshot>('/workspace')).data;
  const before = (await workspace(source)).documents;
  const [a, b, linked, other] = initialPages.map(row => before.find(document => document.title === row.title)!);
  const document = async (target: MigrationFixture, id: string) => (await workspace(target)).documents.find(doc => doc.id === id)!;
  const edit = async (target: MigrationFixture, doc: DocPage, values: Partial<Pick<DocPage, 'title' | 'content'>>) => {
    const result = await target.call<DocPage>(`/documents/${doc.id}`, 'PATCH', { expectedVersion: doc.version, ...values });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  const localBody = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const configuration = async (target: MigrationFixture, name: string, pages: LabelListSourcePage[]) => {
    const pkg = await labelListExport(target, instance, name, pages);
    const config = await target.configuration(pkg);
    return { ...config, appendPagesTo: { projectId, refreshExisting: true as const } };
  };
  const comparisons = (plan: MigrationPreview, doc: DocPage) => Object.fromEntries(
    (plan.documentRefresh?.find(row => row.documentId === doc.id)?.fields ?? []).map(({ field, decision }) => [field, decision]));
  await edit(source, a, { title: '팀 제목 A' });
  await edit(source, b, { content: localBody('팀 본문 B') });
  await edit(source, linked, { content: localBody('팀 메모') });
  const secondPages = [
    { id: '100', version: 2, title: '원본 새 제목 A', body: '<p>원본 새 본문 A</p>' },
    { id: '200', version: 2, title: '원본 새 제목 B', body: '<p>원본 새 본문 B</p>' },
    { id: '300', version: 2, title: '연결 문서 새 제목', body: '<p>원본의 아직 반영하지 않은 본문</p>' },
    { id: '400', version: 2, title: '이름을 바꾼 연결 대상' },
  ];
  const second = await source.preview(await configuration(source, 'partial-v2', secondPages));
  assert.equal(second.canApply, true, JSON.stringify(second.notices));
  assert.deepEqual(comparisons(second, a), { title: 'conflict', content: 'apply' });
  assert.deepEqual(comparisons(second, b), { title: 'apply', content: 'conflict' });
  assert.deepEqual(comparisons(second, linked), { title: 'apply', content: 'conflict' });
  const appliedSecond = await source.apply(second);
  assert.equal(appliedSecond.status, 201, JSON.stringify(appliedSecond.data));

  type Backup = WorkspaceSnapshot & { schemaVersion: number; sourceImports: SourceImport[]; sourceRecords: SourceRecordArchive[] };
  const backup = (await source.call<Backup>('/export')).data;
  const initialSource = (doc: DocPage) => backup.sourceRecords.find(row => row.sourceImportId === first.data.import.id && row.targetId === doc.id)!;
  const latestSource = (doc: DocPage) => backup.sourceRecords.find(row => row.sourceImportId === appliedSecond.data.import.id && row.targetId === doc.id)!;
  assert.equal(latestSource(a).confluencePageFieldHashes?.title, initialSource(a).confluencePageFieldHashes?.title);
  assert.match(initialSource(b).confluencePageBodySourceHash ?? '', /^[a-f0-9]{64}$/);
  assert.notEqual(latestSource(a).confluencePageBodySourceHash, initialSource(a).confluencePageBodySourceHash);
  assert.equal(latestSource(b).record.text, secondPages[1].body);
  assert.equal(latestSource(b).confluencePageBodySourceHash, initialSource(b).confluencePageBodySourceHash);
  assert.equal(latestSource(linked).confluencePageBodySourceHash, initialSource(linked).confluencePageBodySourceHash);
  assert.equal((await restored.call('/import', 'POST', { data: historicalMigrationBackup(backup, 97) })).status, 400);
  const restore = await restored.call('/import', 'POST', { data: backup });
  assert.equal(restore.status, 200, JSON.stringify(restore.data));
  const oldBackup = historicalMigrationBackup(backup, 97);
  for (const receipt of oldBackup.sourceImports) delete receipt.integrity;
  for (const row of oldBackup.sourceRecords) {
    delete row.confluencePageBodySourceHash;
    if (row.confluencePageFieldHashes) delete row.confluencePageFieldHashes.parentId;
  }
  const oldRestore = await older.call('/import', 'POST', { data: oldBackup });
  assert.equal(oldRestore.status, 200, JSON.stringify(oldRestore.data));

  const thirdPages = secondPages.slice(0, 2).map(row => ({ ...row, version: 3 }));
  const linkedThird = { ...secondPages[2], version: 3, title: '연결 문서의 세 번째 제목', body: linkedBody };
  for (const target of [restored, older]) {
    const modern = target === restored;
    const pages = modern ? [...thirdPages, linkedThird] : thirdPages;
    const config = await configuration(target, 'partial-v3', pages);
    const pending = await target.preview(config);
    assert.deepEqual(comparisons(pending, a), { title: 'conflict' });
    assert.deepEqual(comparisons(pending, b), { content: 'conflict' });
    if (modern) assert.deepEqual(comparisons(pending, linked), { title: 'apply' });
    const fixedA = await edit(target, await document(target, a.id), { title: a.title });
    const fixedB = await edit(target, await document(target, b.id), { content: b.content });
    if (modern) await edit(target, await document(target, linked.id), { content: linked.content });
    const reviewed = await target.preview(config);
    assert.equal(reviewed.canApply, true, JSON.stringify(reviewed.notices));
    assert.equal(reviewed.counts.conflictingDocumentFields, 0);
    assert.deepEqual(comparisons(reviewed, a), { title: 'apply' });
    assert.deepEqual(comparisons(reviewed, b), { content: 'apply' });
    if (modern) assert.deepEqual(comparisons(reviewed, linked), { title: 'apply' });
    const applied = await target.apply(reviewed);
    assert.equal(applied.status, 201, JSON.stringify(applied.data));
    assert.equal((await target.apply(reviewed)).data.duplicate, true);
    const savedA = await document(target, a.id), savedB = await document(target, b.id);
    assert.deepEqual([savedA.title, savedA.plainText, savedA.version], [thirdPages[0].title, '원본 새 본문 A', fixedA.version + 1]);
    assert.deepEqual([savedB.title, savedB.plainText, savedB.version], [thirdPages[1].title, '원본 새 본문 B', fixedB.version + 1]);
    if (modern) {
      const saved = await document(target, linked.id);
      assert.equal(saved.title, linkedThird.title);
      assert.deepEqual(saved.content, linked.content);
      assert.deepEqual(contentReferences(saved.content).map(({ id, label }) => [id, label]), [[other.id, other.title]]);
      assert.equal((await document(target, other.id)).title, secondPages[3].title);
    }
  }
});

test('Confluence layouts migrate through HTTP and upgrade exact former projections on a newer source revision', async t => {
  const initial = await fixture(), restored = await fixture();
  t.after(() => Promise.all([initial.close(), restored.close()]));
  const instance = 'synthetic-column-layout';
  const layout = '<ac:layout><ac:layout-section ac:type="two_left_sidebar"><ac:layout-cell><h2>설치</h2><p><strong>필수</strong> 도구</p></ac:layout-cell><ac:layout-cell><p><a href="#설치">설치 절 열기</a></p><p>오른쪽 본문</p></ac:layout-cell></ac:layout-section></ac:layout>';
  const excerpt = '<ac:structured-macro ac:name="excerpt"><ac:rich-text-body><p>저장된 요약</p></ac:rich-text-body></ac:structured-macro>';
  const rows = [
    { id: '100', title: '필드 해시가 있는 문서', body: layout },
    { id: '101', title: '당시 표시를 대조할 문서', body: layout + excerpt },
    { id: '102', title: '팀에서 변경한 문서', body: layout + excerpt },
  ];
  const source = await labelListExport(initial, instance, 'columns-v1', rows);
  const plan = await initial.preview(await initial.configuration(source, 'LAYOUT'));
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.ok(!plan.notices.some(item => item.code.includes('LAYOUT')));
  const applied = await initial.apply(plan);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const [projectId] = applied.data.import.projectIds;
  type Backup = WorkspaceSnapshot & { schemaVersion: number; revisions: DocRevision[]; sourceImports: SourceImport[]; sourceRecords: SourceRecordArchive[] };
  const exported = await initial.call<Backup>('/export');
  assert.equal(exported.status, 200);
  const backup = historicalMigrationBackup(exported.data, 78);
  const documents = rows.map(row => backup.documents.find(document => document.projectId === projectId && document.title === row.title)!);
  assert.equal(documents.length, 3);
  for (const document of documents) {
    assert.equal(documentContentSchemaVersion(document.content), 12);
    const [row] = document.content.content!;
    assert.equal(row.type, 'documentColumnLayout');
    assert.deepEqual({ ...row.attrs }, { weights: [3, 7], border: false });
    const left = row.content?.[0], right = row.content?.[1];
    const sectionId = left?.content?.[0]?.attrs?.sectionId;
    assert.equal(typeof sectionId, 'string');
    assert.equal(right?.content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.href, documentSectionHash(document.id, sectionId as string));
  }

  // Recreate the current backup format before native columns and both old comparison cases.
  const priorLiteral = { type: 'codeBlock', content: [{ type: 'text', text: `[XML ac:layout]\n${layout}` }] };
  const makePrior = (document: DocPage, edited: boolean) => normalizeDocumentContent({ type: 'doc', content: [priorLiteral,
    ...(document.content.content?.slice(1) ?? []),
    ...(edited ? [{ type: 'paragraph', content: [{ type: 'text', text: '팀에서 보탠 내용을 유지' }] }] : []),
  ] });
  const previous = new Map(documents.map(document => [document.id, makePrior(document, false)]));
  const edited = documents[2];
  const locallyChanged = makePrior(edited, true);
  for (const receipt of backup.sourceImports) delete receipt.integrity;
  for (const record of backup.sourceRecords) {
    delete record.confluencePageBodySourceHash;
    if (record.targetId === documents[0].id && record.confluencePageFieldHashes) {
      delete record.confluencePageFieldHashes.parentId;
      record.confluencePageFieldHashes.content = hash(Buffer.from(JSON.stringify(['content', JSON.stringify(previous.get(documents[0].id)!.content)])));
    } else if (record.targetId && previous.has(record.targetId)) delete record.confluencePageFieldHashes;
  }
  for (const document of documents) Object.assign(document, document.id === edited.id ? locallyChanged : previous.get(document.id)!);
  for (const revision of backup.revisions) if (previous.has(revision.documentId)) Object.assign(revision, previous.get(revision.documentId)!);
  const imported = await restored.call('/import', 'POST', { data: backup });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));

  const incoming = await labelListExport(restored, instance, 'columns-v2', rows.map(row => ({ ...row, version: 2 })));
  const preview = await restored.preview({ ...await restored.configuration(incoming), appendPagesTo: { projectId, refreshExisting: true } });
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  for (const document of documents) {
    const decision = preview.documentRefresh?.find(row => row.documentId === document.id)?.fields.find(field => field.field === 'content')?.decision;
    assert.equal(decision, document.id === edited.id ? 'conflict' : 'apply', document.title);
  }
  const refreshed = await restored.apply(preview);
  assert.equal(refreshed.status, 201, JSON.stringify(refreshed.data));
  const saved = (await restored.call<Backup>('/export')).data;
  assert.deepEqual(saved.documents.find(document => document.id === edited.id)?.content, JSON.parse(JSON.stringify(locallyChanged.content)));
  for (const document of documents.slice(0, 2)) {
    const current = saved.documents.find(candidate => candidate.id === document.id)!;
    assert.equal(documentContentSchemaVersion(current.content), 12);
    assert.ok(current.plainText.includes('오른쪽 본문'));
    const archived = saved.sourceRecords.filter(record => record.targetId === document.id && record.record.kind === 'page');
    assert.deepEqual(archived.map(record => record.record.text), [rows[documents.indexOf(document)].body, rows[documents.indexOf(document)].body]);
  }
});

test('Confluence excerpt migration upgrades verified older projections while preserving independently edited bodies', async t => {
  const initial = await fixture(), restored = await fixture();
  t.after(() => Promise.all([initial.close(), restored.close()]));
  const instance = 'synthetic-legacy-excerpt-checkpoint';
  const sourceTitle = '합성 재사용 원문';
  const excerpt = '<ac:structured-macro ac:name="excerpt"><ac:parameter ac:name="hidden">true</ac:parameter><ac:rich-text-body><p>공통 <strong>설치 절차</strong></p></ac:rich-text-body></ac:structured-macro>';
  const include = `<ac:macro ac:name="excerpt-include"><ac:default-parameter>${sourceTitle}</ac:default-parameter><ac:parameter ac:name="nopanel">true</ac:parameter></ac:macro>`;
  const rows = [
    { id: '100', title: sourceTitle, body: excerpt },
    { id: '101', title: '해시로 확인할 포함 문서', body: include },
    { id: '102', title: '본문으로 확인할 포함 문서', body: include },
    { id: '103', title: '팀에서 편집한 포함 문서', body: include },
  ];
  const first = await labelListExport(initial, instance, 'excerpts-v1', rows);
  const plan = await initial.preview(await initial.configuration(first, 'EXCERPT'));
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.ok(!plan.notices.some(({ code }) => code.includes('EXCERPT')));
  const applied = await initial.apply(plan);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const [projectId] = applied.data.import.projectIds;

  type Backup = WorkspaceSnapshot & { schemaVersion: number; revisions: DocRevision[]; sourceImports: SourceImport[]; sourceRecords: SourceRecordArchive[] };
  const currentBackup = (await initial.call<Backup>('/export')).data;
  assert.equal(currentBackup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const backup = historicalMigrationBackup(currentBackup, 68);
  const documents = backup.documents.filter(document => document.projectId === projectId);
  const source = documents.find(document => document.title === sourceTitle)!;
  assert.ok(source);
  assert.equal(source.content.content?.[0].type, 'documentExcerpt');
  assert.equal(source.content.content?.[0].attrs?.hidden, true);
  const consumers = documents.filter(document => document.id !== source.id);
  assert.equal(consumers.length, 3);
  for (const document of consumers) {
    assert.deepEqual(document.content.content?.map(node => node.type), ['documentExcerptInclude']);
    assert.deepEqual({ ...document.content.content?.[0].attrs }, { documentId: source.id, label: sourceTitle, noPanel: true });
  }
  assert.ok(backup.sourceRecords.find(record => record.record.sourceId === '101')?.record.references
    .some(reference => reference.kind === 'page' && reference.relation === 'include-macro' && reference.sourceId === '100'));

  const priorSource = normalizeDocumentContent({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '공통 ' }, { type: 'text', text: '설치 절차', marks: [{ type: 'bold' }] }] },
  ] });
  const priorInclude = normalizeDocumentContent({ type: 'doc', content: [
    { type: 'codeBlock', content: [{ type: 'text', text: include }] },
  ] });
  const edited = documents.find(document => document.title === rows[3].title)!;
  const editedBody = normalizeDocumentContent({ type: 'doc', content: [
    ...priorInclude.content.content!, { type: 'paragraph', content: [{ type: 'text', text: '팀에서 보탠 문단' }] },
  ] });
  const documentIds = new Set(documents.map(document => document.id));
  const stored = documents.find(document => document.title === rows[1].title)!;
  for (const receipt of backup.sourceImports) delete receipt.integrity;
  for (const record of backup.sourceRecords) {
    delete record.confluencePageBodySourceHash;
    if (record.targetId === stored.id && record.confluencePageFieldHashes) {
      delete record.confluencePageFieldHashes.parentId;
      record.confluencePageFieldHashes.content = hash(Buffer.from(JSON.stringify(['content', JSON.stringify(priorInclude.content)])));
    } else delete record.confluencePageFieldHashes;
  }
  for (const document of documents) {
    Object.assign(document, document.id === edited.id ? editedBody : document.id === source.id ? priorSource : priorInclude);
  }
  for (const revision of backup.revisions.filter(revision => documentIds.has(revision.documentId))) {
    Object.assign(revision, revision.documentId === source.id ? priorSource : priorInclude);
  }
  const restoredBackup = await restored.call('/import', 'POST', { data: backup });
  assert.equal(restoredBackup.status, 200, JSON.stringify(restoredBackup.data));

  const next = await labelListExport(restored, instance, 'excerpts-v2', rows.map(row => ({ ...row, version: 2 })));
  const config = await restored.configuration(next);
  const refresh = await restored.preview({ ...config, appendPagesTo: { projectId, refreshExisting: true } });
  assert.equal(refresh.canApply, true, JSON.stringify(refresh.notices));
  for (const document of documents) {
    const decision = refresh.documentRefresh?.find(row => row.documentId === document.id)?.fields.find(field => field.field === 'content')?.decision;
    assert.equal(decision, document.id === edited.id ? 'conflict' : 'apply', document.title);
  }
  const refreshed = await restored.apply(refresh);
  assert.equal(refreshed.status, 201, JSON.stringify(refreshed.data));
  const current = (await restored.call<WorkspaceSnapshot>('/workspace')).data.documents;
  assert.equal(current.find(document => document.id === source.id)?.content.content?.[0].type, 'documentExcerpt');
  for (const document of consumers.filter(document => document.id !== edited.id)) {
    const latest = current.find(value => value.id === document.id)!;
    assert.deepEqual(contentReferences(latest.content).map(reference => [reference.kind, reference.id]), [['include', source.id]]);
  }
  assert.deepEqual(current.find(document => document.id === edited.id)?.content, JSON.parse(JSON.stringify(editedBody.content)));
});

test('Confluence label-list XML migrates into a proven project and refreshes exact legacy code after restore', async t => {
  const initial = await fixture(), f = await fixture();
  t.after(() => Promise.all([initial.close(), f.close()]));
  const instance = 'synthetic-label-list-scope';
  const start = await labelListExport(initial, instance, 'label-list-first', [
    { id: '100', title: '원본 목록', body: confluenceLegacyList },
    { id: '200', title: '별도 편집한 목록', body: confluenceLegacyList },
  ]);
  const plan = await initial.preview(await initial.configuration(start, 'LISTS'));
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.ok(!plan.notices.some(notice => notice.code.startsWith('LABEL_LIST_')));
  const applied = await initial.apply(plan);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const [projectId] = applied.data.import.projectIds;
  type Backup = WorkspaceSnapshot & { schemaVersion: number; revisions: DocRevision[]; sourceImports: SourceImport[]; sourceRecords: SourceRecordArchive[] };
  const backup = historicalMigrationBackup((await initial.call<Backup>('/export')).data, 58);
  const docs = backup.documents.filter(doc => doc.projectId === projectId);
  assert.equal(docs.length, 2);
  for (const doc of docs) assert.deepEqual(doc.content.content?.[0].attrs, {
    projectId, labels: ['release'], match: 'any', sort: 'updated', descending: true, limit: 15, title: '',
    showLabels: true, showSpace: true, excludeCurrent: false,
  });
  assert.ok(backup.sourceRecords.some(archive => archive.record.sourceId === '100' && archive.record.text === confluenceLegacyList));

  // Reproduce a prior export in which the unsupported macro remained as an exact code block.
  for (const receipt of backup.sourceImports) delete receipt.integrity;
  for (const record of backup.sourceRecords) {
    delete record.confluencePageFieldHashes;
    delete record.confluencePageBodySourceHash;
  }
  const oldBody = normalizeDocumentContent({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: confluenceLegacyList }] }] });
  const original = docs.find(doc => doc.title === '원본 목록')!, edited = docs.find(doc => doc.title === '별도 편집한 목록')!;
  assert.ok(original && edited);
  Object.assign(original, oldBody);
  Object.assign(edited, normalizeDocumentContent({ type: 'doc', content: [
    ...oldBody.content.content!, { type: 'paragraph', content: [{ type: 'text', text: '팀 편집' }] },
  ] }));
  for (const revision of backup.revisions.filter(revision => docs.some(doc => doc.id === revision.documentId))) Object.assign(revision, oldBody);
  const restored = await f.call('/import', 'POST', { data: backup });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));

  const modern = confluenceListMacro({ cql: 'space = currentSpace() and label = release AND type = page', sort: 'creation', reverse: 'true' });
  const next = await labelListExport(f, instance, 'label-list-next', [
    { id: '100', title: '원본 목록', version: 2, body: modern },
    { id: '200', title: '별도 편집한 목록', version: 2, body: modern },
    { id: '300', title: '추가 목록', body: confluenceLegacyList },
  ]);
  const config: MigrationConfiguration = { ...await f.configuration(next, 'LISTS'), appendPagesTo: { projectId, refreshExisting: true } };
  const update = await f.preview(config);
  assert.equal(update.canApply, true, JSON.stringify(update.notices));
  assert.equal(update.documentRefresh?.find(row => row.documentId === original.id)?.fields.find(field => field.field === 'content')?.decision, 'apply');
  assert.equal(update.documentRefresh?.find(row => row.documentId === edited.id)?.fields.find(field => field.field === 'content')?.decision, 'conflict');

  const local = await f.call<DocPage>('/documents', 'POST', { projectId, title: '원본 범위 밖 팀 문서', labels: ['release'] });
  assert.equal(local.status, 201, JSON.stringify(local.data));
  const stale = await f.apply(update);
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  const unsafe = await f.preview(config);
  assert.ok(unsafe.notices.some(notice => notice.code === 'LABEL_LIST_SCOPE_UNRESOLVED'));
  assert.ok(unsafe.notices.some(notice => notice.code === 'CONFLUENCE_REFRESH_BODY_UNAVAILABLE'));
  assert.equal((await f.call(`/documents/${local.data.id}?expectedVersion=${local.data.version}`, 'DELETE')).status, 200);

  const safe = await f.preview(config);
  assert.equal(safe.canApply, true, JSON.stringify(safe.notices));
  const safeApplied = await f.apply(safe);
  assert.equal(safeApplied.status, 201, JSON.stringify(safeApplied.data));
  const current = (await f.call<WorkspaceSnapshot>('/workspace')).data.documents;
  assert.deepEqual(current.find(doc => doc.id === original.id)?.content.content?.[0].attrs, {
    projectId, labels: ['release'], match: 'all', sort: 'created', descending: false, limit: 15, title: '',
    showLabels: true, showSpace: true, excludeCurrent: false,
  });
  assert.equal(JSON.stringify(current.find(doc => doc.id === edited.id)?.content), JSON.stringify(edited.content));
  assert.equal(current.find(doc => doc.title === '추가 목록')?.content.content?.[0].type, 'documentLabelList');
});

test('Confluence multi-space property reports recover from the same archived source and fence retained-space drift', async t => {
  const f = await fixture(), restored = await fixture();
  t.after(() => Promise.all([f.close(), restored.close()]));
  const instance = 'synthetic-multi-space-report';
  const origin = 'https://report-spaces.example.test/wiki';
  const report = '<ac:structured-macro ac:name="detailssummary">' +
    confluenceListParameter('cql', 'type = page AND space IN (WIKI42, WIKI43) AND label = release ORDER BY title ASC') +
    confluenceListParameter('id', '배포') + '</ac:structured-macro>';
  const properties = (value: string) => '<ac:structured-macro ac:name="details">' + confluenceListParameter('id', '배포') +
    `<ac:rich-text-body><table><tr><th>결과</th><td>${value}</td></tr></table></ac:rich-text-body></ac:structured-macro>`;
  const docs = async (target = f) => (await target.call<WorkspaceSnapshot>('/workspace')).data.documents;
  const appendConfig = async (bundle: LegacyPackageSummary, projectId: string) => {
    const config = await f.configuration(bundle);
    config.sourceBaseUrls[bundle.id] = origin;
    return { ...config, appendPagesTo: { projectId, refreshExisting: true as const } };
  };
  const initial = await labelListExport(f, instance, 'original-property-report', [
    { id: '801', title: '원래 배포 보고서', body: report },
    { id: '802', title: '팀이 편집할 보고서', body: report },
    { id: '803', title: '개발 배포', body: properties('개발 승인') },
  ]);
  const initialConfig = await f.configuration(initial, 'PROPREPORT');
  initialConfig.sourceBaseUrls[initial.id] = origin;
  const initialPlan = await f.preview(initialConfig);
  assert.equal(initialPlan.canApply, true, JSON.stringify(initialPlan.notices));
  assert.ok(initialPlan.notices.some(notice => notice.code === 'DOCUMENT_PROPERTY_REPORT_SCOPE_UNRESOLVED'));
  const initialReceipt = await f.apply(initialPlan);
  assert.equal(initialReceipt.status, 201, JSON.stringify(initialReceipt.data));
  const [reportProjectId] = initialReceipt.data.import.projectIds;
  const originalDocs = await docs();
  const original = originalDocs.find(document => document.title === '원래 배포 보고서')!;
  const locallyEdited = originalDocs.find(document => document.title === '팀이 편집할 보고서')!;
  const firstProperty = originalDocs.find(document => document.title === '개발 배포')!;
  assert.ok(original && locallyEdited && firstProperty);
  assert.equal(original.content.content?.[0].type, 'codeBlock');
  assert.equal(original.content.content?.[0].content?.[0].text, report);
  const edited = await f.call<DocPage>(`/documents/${locallyEdited.id}`, 'PATCH', {
    expectedVersion: locallyEdited.version, contentSchemaVersion: 1, content: { type: 'doc', content: [
      ...locallyEdited.content.content!, { type: 'paragraph', content: [{ type: 'text', text: '팀에서 추가한 검토 내용' }] },
    ] },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));

  const second = await labelListExport(f, instance, 'other-property-space', [
    { id: '901', title: '운영 배포', body: properties('운영 승인'), space: '43' },
  ], ['43']);
  const secondConfig = await f.configuration(second, 'PROPOTHER');
  secondConfig.sourceBaseUrls[second.id] = origin;
  const secondReceipt = await f.apply(await f.preview(secondConfig));
  assert.equal(secondReceipt.status, 201, JSON.stringify(secondReceipt.data));
  const [secondProjectId] = secondReceipt.data.import.projectIds;
  const secondProperty = (await docs()).find(document => document.title === '운영 배포')!;
  for (const document of [firstProperty, secondProperty]) {
    const labeled = await f.call<DocPage>(`/documents/${document.id}`, 'PATCH', {
      expectedVersion: document.version, labels: ['release'],
    });
    assert.equal(labeled.status, 200, JSON.stringify(labeled.data));
  }

  const config = await appendConfig(initial, reportProjectId);
  const prospective = await f.preview(config);
  assert.equal(prospective.canApply, true, JSON.stringify(prospective.notices));
  const decision = (plan: MigrationPreview, documentId: string) =>
    plan.documentRefresh?.find(row => row.documentId === documentId)?.fields.find(field => field.field === 'content')?.decision;
  assert.equal(decision(prospective, original.id), 'apply');
  assert.equal(decision(prospective, locallyEdited.id), 'conflict');

  const outOfScope = await f.call<DocPage>('/documents', 'POST', {
    projectId: secondProjectId, title: '이관 범위에 없는 현지 문서', labels: ['release'],
  });
  assert.equal(outOfScope.status, 201, JSON.stringify(outOfScope.data));
  const stale = await f.apply(prospective);
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.match(JSON.stringify(stale.data), /속성 보고서의 원본 공간 연결/u);
  assert.equal((await docs()).find(document => document.id === original.id)?.content.content?.[0].type, 'codeBlock');
  const mixed = await f.preview(config);
  assert.equal(mixed.canApply, false, JSON.stringify(mixed.notices));
  assert.equal((await f.call(`/documents/${outOfScope.data.id}?expectedVersion=${outOfScope.data.version}`, 'DELETE')).status, 200);

  const fresh = await f.preview(config);
  assert.equal(fresh.canApply, true, JSON.stringify(fresh.notices));
  assert.equal(decision(fresh, locallyEdited.id), 'conflict');
  const applied = await f.apply(fresh);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const assertReport = (documents: DocPage[]) => {
    const live = documents.find(item => item.id === original.id)!;
    assert.equal(documentContentSchemaVersion(live.content), 17);
    const [options] = documentPropertyReports(live.content);
    assert.deepEqual(options.projectIds, [reportProjectId, secondProjectId]);
    assert.deepEqual(collectDocumentPropertyReport(documents, options).rows.map(row => [row.document.id, row.entries['결과']]),
      [[firstProperty.id, '개발 승인'], [secondProperty.id, '운영 승인']]);
    assert.deepEqual(documents.find(item => item.id === locallyEdited.id)?.content, edited.data.content);
  };
  assertReport(await docs());
  const native = (await f.call<WorkspaceSnapshot & { schemaVersion: number; sourceRecords: SourceRecordArchive[] }>('/export')).data;
  assert.equal(native.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal(native.sourceRecords.find(record => record.sourceImportId === initialReceipt.data.import.id && record.targetId === original.id)?.record.text, report);
  const imported = await restored.call('/import', 'POST', { data: native });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  assertReport(await docs(restored));
});

test('Confluence label-list scope does not broaden through merged space mapping or other projected content kinds', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const instance = 'synthetic-label-list-mixed-spaces';
  const init = await labelListExport(f, instance, 'mixed-scopes', [
    { id: '100', title: '공간을 합친 목록', body: confluenceLegacyList },
    { id: '200', title: '다른 공간의 페이지', space: '43' },
  ], ['42', '43']);
  const merged = await f.preview(await f.configuration(init, 'MERGED'));
  assert.equal(merged.canApply, true, JSON.stringify(merged.notices));
  assert.ok(merged.notices.some(notice => notice.code === 'LABEL_LIST_SCOPE_UNRESOLVED' && notice.requiresAcknowledgement));
  const applied = await f.apply(merged);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const [projectId] = applied.data.import.projectIds;
  const delta = await labelListExport(f, instance, 'existing-mixed-scope', [{ id: '300', title: '기존 혼합 프로젝트에 추가한 목록', body: confluenceLegacyList }]);
  const append = await f.preview({ ...await f.configuration(delta), appendPagesTo: { projectId } });
  assert.equal(append.canApply, true, JSON.stringify(append.notices));
  assert.ok(append.notices.some(notice => notice.code === 'LABEL_LIST_SCOPE_UNRESOLVED'));
  const appendApplied = await f.apply(append);
  assert.equal(appendApplied.status, 201, JSON.stringify(appendApplied.data));

  const blog = await labelListExport(f, instance, 'mixed-kinds', [
    { id: '400', title: '글도 포함된 공간의 목록', space: '44', body: confluenceLegacyList },
    { id: '500', title: '블로그 글', space: '44', kind: 'BlogPost' },
  ], ['44']);
  const mixedKinds = await f.preview(await f.configuration(blog, 'BLOGS'));
  assert.equal(mixedKinds.canApply, true, JSON.stringify(mixedKinds.notices));
  assert.ok(mixedKinds.notices.some(notice => notice.code === 'LABEL_LIST_SCOPE_UNRESOLVED'));
  assert.equal((await f.apply(mixedKinds)).status, 201);

  const content = (await f.call<WorkspaceSnapshot>('/workspace')).data.documents;
  for (const title of ['공간을 합친 목록', '기존 혼합 프로젝트에 추가한 목록', '글도 포함된 공간의 목록']) {
    assert.deepEqual(content.find(doc => doc.title === title)?.content.content?.[0],
      { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: confluenceLegacyList }] });
  }
});

test('Confluence attachment refresh reuses pinned bytes, adds immutable versions and preserves the manual head', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const source = 'synthetic-confluence-attachment-refresh';
  const sourceBase = 'https://wiki.example.test/confluence';
  const prop = (name: string, value: string) => `<property name="${name}">${value}</property>`;
  const ref = (name: string, kind: string, id: string) => `<property name="${name}" class="${kind}"><id name="id">${id}</id></property>`;
  const object = (kind: string, id: string, content: string) => `<object class="${kind}"><id name="id">${id}</id>${content}</object>`;
  const date = prop('creationDate', '2020-05-01T00:00:00Z');
  const page = (id: string, title: string, version: number, storage?: string) => [
    object('Page', id, prop('title', title) + prop('version', String(version)) + ref('space', 'Space', '42') + date +
      prop('lastModificationDate', `2020-05-0${version}T00:00:00Z`)),
    ...(storage === undefined ? [] : [object('BodyContent', `9${id}`, prop('body', `<![CDATA[${storage}]]>`) + ref('content', 'Page', id))]),
  ].join('');
  const attachment = (id: string, version: number, filename: string, current?: string) => object('Attachment', id,
    prop('title', filename) + prop('version', String(version)) + ref('containerContent', 'Page', '100') + date +
    (current ? ref('originalVersion', 'Attachment', current) : ''));
  const upload = (name: string, rows: string[], files: [string, Buffer][] = []) => f.upload(zip([
    { path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>${object('Space', '42', prop('key', 'WFILE') + prop('name', '팀 첨부 위키'))}${rows.join('')}</hibernate-generic>`) },
    ...files.map(([path, bytes]) => ({ path: `attachments/100/${path}`, bytes })),
  ]), `${name}.zip`, 'confluence', source);
  const firstBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+2TmcAAAAASUVORK5CYII=', 'base64');
  const secondBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNg+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const thirdBytes = Buffer.concat([firstBytes, Buffer.from('synthetic-third-version')]);
  const manualBytes = Buffer.from('팀에서 직접 올린 버전');
  const image = (attributes: string, owner = '') => `<ac:image><ri:attachment ${attributes}>${owner}</ri:attachment></ac:image>`;
  const sources = (content: RichContent): unknown[] => [
    ...(content.type === 'image' ? [content.attrs?.src] : []), ...(content.content ?? []).flatMap(sources),
  ];
  const imageUrl = (id: string) => `/api/attachments/${id}/content?inline=1`;
  const initialPack = await upload('first-attachment', [
    page('100', '원본 첨부 문서', 1, image('ri:filename="diagram.png"')),
    attachment('700', 1, 'diagram.png'),
  ], [['700/1', firstBytes]]);
  const initialConfig = await f.configuration(initialPack, 'WFIL');
  initialConfig.sourceBaseUrls[initialPack.id] = sourceBase;
  const initial = await f.apply(await f.preview(initialConfig));
  assert.equal(initial.status, 201, JSON.stringify(initial.data));
  const [projectId] = initial.data.import.projectIds;
  const workspace = () => f.call<WorkspaceSnapshot>('/workspace').then(result => result.data);
  const doc = (await workspace()).documents.find(page => page.projectId === projectId)!;
  const list = () => f.call<AttachmentHead[]>(`/attachments?resourceType=document&resourceId=${doc.id}`).then(result => result.data);
  const [anchor] = await list();
  assert.ok(anchor);
  assert.deepEqual(sources(doc.content), [imageUrl(anchor.id)]);
  const expectedBytes = async (id: string, bytes: Buffer) => {
    const response = await fetch(`${f.base}/attachments/${id}/content`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  };
  async function config(pkg: LegacyPackageSummary, refreshAttachments = false, refreshExisting = false): Promise<MigrationConfiguration> {
    const options = (await f.call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`)).data;
    assert.equal(options.appendPagesTarget?.projectId, projectId);
    return { ...options.defaultConfiguration, sourceBaseUrls: { [pkg.id]: sourceBase }, appendPagesTo: { projectId,
      ...(refreshAttachments ? { refreshAttachments: true } : {}), ...(refreshExisting ? { refreshExisting: true } : {}),
    } };
  }

  const referencePack = await upload('new-page-with-existing-image', [page('200', '기존 이미지를 참조한 새 문서', 1,
    image('ri:filename="diagram.png"', '<ri:page ri:content-id="100"/>') +
      '<img src="/confluence/download/attachments/100/diagram.png?version=1" alt="앞서 이관한 이미지"/>')]);
  const referenceConfig = await config(referencePack);
  const anchorFile = join(f.dir, 'uploads', anchor.id);
  try {
    writeFileSync(anchorFile, Buffer.from(firstBytes).fill(7));
    const damaged = await f.preview(referenceConfig);
    assert.equal(damaged.canApply, false, JSON.stringify(damaged.notices));
  } finally { writeFileSync(anchorFile, firstBytes); }
  const referencePlan = await f.preview(referenceConfig);
  assert.equal(referencePlan.canApply, true, JSON.stringify(referencePlan.notices));
  assert.equal(referencePlan.counts.reusedConfluenceAttachmentVersions, 1);
  assert.equal(referencePlan.counts.fileCopies, 0);
  try {
    writeFileSync(anchorFile, Buffer.from(firstBytes).fill(9));
    assert.equal((await f.apply(referencePlan)).status, 409);
  } finally { writeFileSync(anchorFile, firstBytes); }
  assert.equal((await f.apply(referencePlan)).status, 201);
  const referencing = (await workspace()).documents.find(page => page.title === '기존 이미지를 참조한 새 문서')!;
  assert.deepEqual(sources(referencing.content), [imageUrl(anchor.id), imageUrl(anchor.id)]);

  const reviewVersions = await upload('version-two-and-new-root', [
    page('100', '원본 첨부 문서', 2), attachment('700', 2, 'diagram.png'), attachment('701', 1, 'diagram.png', '700'),
    attachment('710', 1, 'report.txt'),
  ], [['700/1', firstBytes], ['700/2', secondBytes], ['710/1', Buffer.from('새 원본 보고서')]]);
  assert.equal((await f.preview(await config(reviewVersions))).canApply, false);
  const attachmentPlan = await f.preview(await config(reviewVersions, true));
  assert.equal(attachmentPlan.canApply, true, JSON.stringify(attachmentPlan.notices));
  assert.equal(attachmentPlan.counts.newConfluenceAttachments, 1);
  assert.equal(attachmentPlan.counts.newConfluenceAttachmentVersions, 1);
  assert.equal(attachmentPlan.counts.fileCopies, 2);
  const secondReceipt = await f.apply(attachmentPlan);
  assert.equal(secondReceipt.status, 201, JSON.stringify(secondReceipt.data));
  assert.equal((await f.apply(attachmentPlan)).data.duplicate, true);
  const secondHead = (await list()).find(file => file.id === anchor.id)!;
  assert.notEqual(secondHead.currentVersionId, anchor.id);
  assert.equal(secondHead.versionCount, 2);
  assert.equal((await workspace()).documents.find(page => page.id === doc.id)?.version, doc.version);
  await expectedBytes(anchor.id, firstBytes);
  await expectedBytes(secondHead.currentVersionId, secondBytes);

  const inconsistent = await upload('same-version-different-bytes', [page('100', '원본 첨부 문서', 2), attachment('700', 2, 'diagram.png')],
    [['700/2', Buffer.from('같은 원본 버전 번호의 다른 바이트')]]);
  const rejected = await f.preview(await config(inconsistent, true));
  assert.equal(rejected.canApply, false);
  assert.equal((await list()).find(file => file.id === anchor.id)?.currentVersionId, secondHead.currentVersionId);

  const thirdPack = await upload('version-three-and-body', [
    page('100', '원본 첨부 문서', 3, '<p>세 번째 버전과 당시 원본</p>' + image('ri:filename="diagram.png"') +
      image('ri:filename="diagram.png" ri:content-id="701"') +
      '<img src="download/attachments/100/diagram.png?version=2" alt="두 번째 원본 버전"/>' +
      '<img src="/confluence/download/attachments/100/diagram.png" alt="현재 원본 버전"/>'), attachment('700', 3, 'diagram.png'),
    attachment('701', 1, 'diagram.png', '700'), attachment('702', 2, 'diagram.png', '700'),
  ], [['700/1', firstBytes], ['700/2', secondBytes], ['700/3', thirdBytes]]);
  const thirdConfig = await config(thirdPack, true, true);
  const stale = await f.preview(thirdConfig);
  assert.equal(stale.canApply, true, JSON.stringify(stale.notices));
  const local = await fetch(`${f.base}/attachments/${anchor.id}/versions?${new URLSearchParams({ expectedVersionId: secondHead.currentVersionId, filename: 'manual.txt' })}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-seo' }, body: new Uint8Array(manualBytes),
  });
  assert.equal(local.status, 201);
  const manualHead = await local.json() as AttachmentHead;
  assert.equal((await f.apply(stale)).status, 409);
  const thirdPlan = await f.preview(thirdConfig);
  assert.equal(thirdPlan.canApply, true, JSON.stringify(thirdPlan.notices));
  assert.equal(thirdPlan.counts.newConfluenceAttachmentVersions, 1);
  assert.equal(thirdPlan.counts.updatedDocuments, 1);
  assert.ok(thirdPlan.counts.reusedConfluenceAttachmentVersions >= 1);
  const thirdReceipt = await f.apply(thirdPlan);
  assert.equal(thirdReceipt.status, 201, JSON.stringify(thirdReceipt.data));
  assert.equal((await list()).find(file => file.id === anchor.id)?.currentVersionId, manualHead.currentVersionId);
  const versionsPath = `/attachments/${anchor.id}/versions`;
  const versions = (await f.call<AttachmentVersion[]>(versionsPath)).data;
  const third = versions.find(version => version.sourceRevision === 3);
  assert.ok(third);
  assert.equal(versions.length, 4);
  const current = (await workspace()).documents.find(page => page.id === doc.id)!;
  assert.deepEqual(sources(current.content), [imageUrl(third.id), imageUrl(anchor.id), imageUrl(secondHead.currentVersionId), imageUrl(third.id)]);
  assert.deepEqual(sources((await workspace()).documents.find(page => page.id === referencing.id)!.content), [imageUrl(anchor.id), imageUrl(anchor.id)]);
  await expectedBytes(third.id, thirdBytes);
  await expectedBytes(manualHead.currentVersionId, manualBytes);
  assert.equal((await f.preview(thirdConfig)).canApply, false);

  const archived = await f.call<{trashItemId: string}>(`/attachments/${anchor.id}?expectedVersionId=${manualHead.currentVersionId}`, 'DELETE');
  assert.equal(archived.status, 200);
  const later = await upload('version-four-after-trash', [page('100', '원본 첨부 문서', 4), attachment('700', 4, 'diagram.png')],
    [['700/4', Buffer.from('휴지통에서 되살리면 안 되는 파일')]]);
  assert.equal((await f.preview(await config(later, true))).canApply, false);
  type Backup = WorkspaceSnapshot & {schemaVersion: number};
  const backup = (await f.call<Backup>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal((await f.call('/import', 'POST', { data: historicalMigrationBackup(backup, 40) })).status, 400);
  const restored = await f.call('/import', 'POST', { data: backup });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal((await f.call(`/trash/items/${archived.data.trashItemId}/restore`, 'POST')).status, 200);
  assert.equal((await list()).find(file => file.id === anchor.id)?.currentVersionId, manualHead.currentVersionId);
  await expectedBytes(anchor.id, firstBytes);
  await expectedBytes(third.id, thirdBytes);
});

test('Confluence history append preserves the current draft and deleted comments and survives a trash backup', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const prop = (name: string, value: string) => `<property name="${name}">${value}</property>`;
  const ref = (name: string, kind: string, id: string) => `<property name="${name}" class="${kind}"><id name="id">${id}</id></property>`;
  const object = (kind: string, id: string, content: string) => `<object class="${kind}"><id name="id">${id}</id>${content}</object>`;
  const date = prop('creationDate', '2020-06-01T00:00:00Z');
  const body = (kind: string, id: string, content: string) => object('BodyContent', `9${id}`,
    prop('body', `<![CDATA[<p>${content}</p>]]>`) + ref('content', kind, id));
  const page = (id: string, version: number, title: string, content: string, historical = false) => object('Page', id,
    prop('title', title) + prop('version', String(version)) + ref('space', 'Space', '42') + date +
    prop('lastModificationDate', `2020-06-0${version}T00:00:00Z`) +
    (historical ? prop('contentStatus', 'historical') + ref('originalVersion', 'Page', '100') : '')) + body('Page', id, content);
  const comment = (id: string, content: string) => object('Comment', id, ref('containerContent', 'Page', '100') + date) + body('Comment', id, content);
  const space = object('Space', '42', prop('key', 'WHIST') + prop('name', '이력 위키'));
  const upload = (name: string, rows: string[], withSpace = true) => f.upload(zip([{
    path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>${withSpace ? space : ''}${rows.join('')}</hibernate-generic>`),
  }]), `${name}.zip`, 'confluence', 'synthetic-confluence-history');

  const initialPack = await upload('initial-history', [page('100', 1, '최초 제목', '최초 본문'), comment('600', '처음 옮긴 댓글')]);
  const initial = await f.apply(await f.preview(await f.configuration(initialPack, 'HIST')));
  assert.equal(initial.status, 201, JSON.stringify(initial.data));
  const [projectId] = initial.data.import.projectIds;
  const workspace = () => f.call<WorkspaceSnapshot>('/workspace').then(result => result.data);
  const doc = (await workspace()).documents.find(value => value.projectId === projectId)!;
  const revisions = () => f.call<DocRevision[]>(`/documents/${doc.id}/revisions`).then(result => result.data);
  const comments = () => f.call<Comment[]>(`/comments?resourceType=document&resourceId=${doc.id}`).then(result => result.data);
  const initialRevisions = await revisions();
  const [importedComment] = await comments();
  assert.ok(doc && importedComment);
  const deleted = await f.call<{trashItemId: string}>(`/comments/${importedComment.id}`, 'DELETE');
  assert.equal(deleted.status, 200);
  assert.equal((await f.call(`/trash/items/${deleted.data.trashItemId}`, 'DELETE')).status, 200);
  const localComment = await f.call<Comment>('/comments', 'POST', { resourceType: 'document', resourceId: doc.id, body: '팀에서 작성한 댓글' });
  assert.equal(localComment.status, 201);

  const delta = await upload('history-delta', [page('100', 4, '바뀐 원본 제목', '현재 원본 본문'),
    page('101', 1, '최초 이력', '이미 최초 적용에 저장한 본문', true), page('102', 2, '원본 버전 2', '원본의 두 번째 본문', true),
    comment('600', '삭제 뒤 다시 나타난 댓글'), comment('601', '추가할 원본 댓글')]);
  const options = (await f.call<MigrationOptions>(`/migrations/options?packageId=${delta.id}`)).data;
  assert.equal(options.appendPagesTarget?.projectId, projectId);
  assert.equal((await f.preview({ ...options.defaultConfiguration, appendPagesTo: { projectId } })).canApply, false);
  const config: MigrationConfiguration = { ...options.defaultConfiguration, appendPagesTo: { projectId, refreshHistory: true } };
  const plan = await f.preview(config);
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.equal(plan.counts.documents, 0);
  assert.equal(plan.counts.newConfluenceComments, 1);
  assert.equal(plan.counts.newConfluenceRevisions, 1);
  const competingPlan = await f.preview(config);
  assert.equal(competingPlan.canApply, true, JSON.stringify(competingPlan.notices));
  const edit = await f.call<DocPage>(`/documents/${doc.id}`, 'PATCH', { expectedVersion: doc.version, title: '팀에서 편집한 제목' });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal(edit.data.version, 2);
  const [localRevision] = await revisions();

  f.db.exec(`CREATE TRIGGER fail_confluence_history_receipt BEFORE INSERT ON source_imports
    BEGIN SELECT RAISE(ABORT,'synthetic history receipt failure'); END;`);
  try {
    assert.equal((await f.apply(plan)).status, 500);
    assert.deepEqual(await comments(), [localComment.data]);
    assert.deepEqual(await revisions(), [localRevision, ...initialRevisions]);
  } finally { f.db.exec('DROP TRIGGER fail_confluence_history_receipt'); }

  const applied = await f.apply(plan);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.equal((await f.apply(plan)).data.duplicate, true);
  assert.equal((await f.apply(competingPlan)).status, 409);
  assert.equal((await f.preview(config)).canApply, false);
  assert.deepEqual((await workspace()).documents.find(value => value.id === doc.id), edit.data);
  const currentComments = await comments();
  assert.deepEqual(currentComments.map(value => value.body).sort(), ['추가할 원본 댓글', '팀에서 작성한 댓글'].sort());
  assert.deepEqual(currentComments.find(value => value.id === localComment.data.id), localComment.data);
  const saved = await revisions();
  assert.deepEqual(saved.slice(0, -1), [localRevision, ...initialRevisions]);
  const original = saved.at(-1)!;
  assert.equal(original.confluenceSourceVersion, 2);
  assert.equal(original.version, localRevision.version);
  assert.equal(original.plainText, '원본의 두 번째 본문');
  const pinned = await f.call<{items: DocRevision[]}>(`/documents/${doc.id}/include-revisions`);
  assert.equal(pinned.status, 200);
  assert.deepEqual(pinned.data.items.map(value => value.id), saved.map(value => value.id));
  assert.equal(pinned.data.items.at(-1)?.confluenceSourceVersion, 2);
  const liveBackup = (await f.call<{revisions: DocRevision[]}>('/export')).data;
  const changedSourceVersion = { ...liveBackup, revisions: liveBackup.revisions.map(revision => revision.id === original.id
    ? { ...revision, version: 9, confluenceSourceVersion: 9 } : revision) };
  assert.equal((await f.call('/import', 'POST', { data: changedSourceVersion })).status, 400);
  assert.deepEqual(await revisions(), saved);

  const archived = await f.call<{ trashEntryId: string }>(`/documents/${doc.id}`, 'DELETE');
  assert.equal(archived.status, 200);
  const backup = (await f.call<WorkspaceSnapshot & {schemaVersion: number}>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal((await f.call('/import', 'POST', { data: historicalMigrationBackup(backup, 41) })).status, 400);
  const restored = await f.call('/import', 'POST', { data: backup });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal((await f.call(`/trash/${archived.data.trashEntryId}/restore`, 'POST')).status, 200);
  assert.deepEqual(await comments(), currentComments);
  const [trashRestoreRevision, ...preserved] = await revisions();
  assert.equal(trashRestoreRevision.summary, '휴지통에서 복원');
  assert.deepEqual(preserved, saved);
  assert.equal((await f.preview(config)).canApply, false);

  const sparse = await upload('history-without-page-or-space', [comment('602', '페이지 없이 제출한 댓글')], false);
  const sparseOptions = (await f.call<MigrationOptions>(`/migrations/options?packageId=${sparse.id}`)).data;
  assert.equal(sparseOptions.appendPagesTarget?.projectId, projectId);
  const sparsePlan = await f.preview({ ...sparseOptions.defaultConfiguration, appendPagesTo: { projectId, refreshHistory: true } });
  assert.equal(sparsePlan.canApply, true, JSON.stringify(sparsePlan.notices));
  assert.equal(sparsePlan.counts.newConfluenceComments, 1);
  assert.equal((await f.apply(sparsePlan)).status, 201);
  assert.ok((await comments()).some(value => value.body === '페이지 없이 제출한 댓글'));

  const restoredDocument = (await workspace()).documents.find(value => value.id === doc.id)!;
  const recovered = await f.call<DocPage>(`/documents/${doc.id}/restore`, 'POST', { expectedVersion: restoredDocument.version, revisionId: original.id });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
  assert.equal(recovered.data.plainText, original.plainText);
  assert.equal(recovered.data.version, restoredDocument.version + 1);
  const [recoveredRevision] = await revisions();
  assert.equal(recoveredRevision.confluenceSourceVersion, undefined);
  assert.equal(recoveredRevision.summary, 'Confluence 원본 버전 2에서 복구');
});

function confluence(withAuditFixtures = false) {
  const first = Buffer.from('첫 버전\r\n\x00바이너리'), latest = Buffer.from('두 번째 버전😀\r\n원본');
  const prop = (name: string, text: string) => `<property name="${name}">${text}</property>`, ref = (name: string, type: string, id: string) => `<property name="${name}" class="${type}"><id name="id">${id}</id></property>`, object = (type: string, id: string, text: string) => `<object class="${type}"><id name="id">${id}</id>${text}</object>`;
  const historical = withAuditFixtures ? '<collection name="historicalVersions"><element class="Page"><id name="id">101</id></element></collection>' : '';
  const extra = withAuditFixtures ? [
    object('Page', '101', prop('title', 'Synthetic historical page') + prop('version', '1') + prop('contentStatus', 'historical') + ref('originalVersion', 'Page', '100') + ref('space', 'Space', '42')),
    object('BodyContent', '301', '<property name="body"><![CDATA[<p>보존한 이전 본문</p>]]></property>' + ref('content', 'Page', '101')),
    object('Comment', '400', ref('containerContent', 'Page', '100') + prop('creationDate', '2020-01-03T00:00:00Z')),
    object('BodyContent', '401', '<property name="body"><![CDATA[<p>보존한 원본 댓글</p>]]></property>' + ref('content', 'Comment', '400')),
    ...[['702', 'removed-before-trash.txt'], ['703', 'source-metadata-only.txt'], ['704', 'intentionally-excluded.txt']].map(([id, filename]) =>
      object('Attachment', id, prop('title', filename) + prop('version', '1') + ref('containerContent', 'Page', '100') + prop('creationDate', '2020-01-02T00:00:00Z'))),
  ].join('') : '';
  const xml = `<hibernate-generic>${object('Space', '42', prop('key', 'SYN') + prop('name', 'Synthetic archive'))}${object('Page', '100', prop('title', 'Synthetic versioned page') + prop('version', withAuditFixtures ? '2' : '1') + ref('space', 'Space', '42') + prop('creationDate', '2020-01-01T00:00:00Z') + prop('lastModificationDate', '2020-01-02T00:00:00Z') + historical)}${object('BodyContent', '300', '<property name="body"><![CDATA[<p>보존한 문서 본문</p>]]></property>' + ref('content', 'Page', '100'))}${object('Attachment', '700', prop('title', 'report.bin') + prop('version', '2') + ref('containerContent', 'Page', '100') + '<collection name="historicalVersions"><element class="Attachment"><id name="id">701</id></element></collection>' + prop('creationDate', '2020-01-02T00:00:00Z'))}${object('Attachment', '701', prop('title', 'report.bin') + prop('version', '1') + ref('containerContent', 'Page', '100') + ref('originalVersion', 'Attachment', '700') + prop('creationDate', '2020-01-01T00:00:00Z'))}${extra}</hibernate-generic>`;
  const entries = [{ path: 'entities.xml', bytes: Buffer.from(xml) }, { path: 'attachments/100/700/1', bytes: first }, { path: 'attachments/100/700/2', bytes: latest }];
  if (withAuditFixtures) entries.push(
    { path: 'attachments/100/702/1', bytes: Buffer.from('삭제 전 독립 첨부') },
    { path: 'attachments/100/704/1', bytes: Buffer.from('의도적으로 이관에서 제외한 바이너리') },
  );
  return { first, latest, bytes: zip(entries) };
}

test('Confluence panels and status badges survive import, collaborative snapshots and backup restore', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const storage = [
    '<ac:structured-macro ac:name="warning"><ac:parameter ac:name="title">배포 주의</ac:parameter>',
    '<ac:rich-text-body><p>고객 확인 후 반영</p><p>상태 <ac:structured-macro ac:name="status">',
    '<ac:parameter ac:name="title">검증 완료</ac:parameter><ac:parameter ac:name="colour">Green</ac:parameter>',
    '</ac:structured-macro></p></ac:rich-text-body></ac:structured-macro>',
  ].join('');
  const bundle = zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">PANELS</property><property name="name">문서 양식</property></object>
    <object class="Page"><id name="id">100</id><property name="title">배포 검토</property><property name="version">1</property>
      <property name="space" class="Space"><id name="id">42</id></property><property name="creationDate">2020-01-01T00:00:00Z</property></object>
    <object class="BodyContent"><id name="id">101</id><property name="body"><![CDATA[${storage}]]></property>
      <property name="content" class="Page"><id name="id">100</id></property></object>
    </hibernate-generic>`) }]);
  const pkg = await f.upload(bundle, 'panels.zip', 'confluence');
  const plan = await f.preview(await f.configuration(pkg, 'PANEL'));
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.ok(!plan.notices.some(({code}) => ['PANEL_FLATTENED', 'STATUS_FLATTENED'].includes(code)));
  const applied = await f.apply(plan);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const document = (await f.call<WorkspaceSnapshot>('/workspace')).data.documents.find(doc => doc.projectId === applied.data.import.projectIds[0]);
  assert.ok(document);
  const path = `/documents/${document.id}`;
  const callout = document.content.content?.[0];
  assert.equal(callout?.type, 'callout');
  assert.deepEqual(callout.attrs, { variant: 'warning', title: '배포 주의' });
  assert.deepEqual(callout.content?.[1]?.content?.[1], { type: 'statusBadge', attrs: { label: '검증 완료', tone: 'green' } });
  assert.equal(documentContentSchemaVersion(document.content), 6);
  assert.match(document.plainText, /배포 주의[\s\S]*고객 확인 후 반영[\s\S]*상태 검증 완료/u);

  const stripped = await f.call<{details: {contentSchemaVersion: number}}>(path, 'PATCH', {
    expectedVersion: document.version, contentSchemaVersion: 5, content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  assert.equal(stripped.status, 409);
  assert.equal(stripped.data.details.contentSchemaVersion, 6);
  const renamed = await f.call<DocPage>(path, 'PATCH', { expectedVersion: document.version, title: '배포 팀 검토' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.data.content, document.content);
  const live = await f.call<CollaborationSession>(`${path}/collaboration/enable`, 'POST', { expectedVersion: renamed.data.version });
  assert.equal(live.status, 200, JSON.stringify(live.data));
  assert.equal(live.data.schemaVersion, COLLABORATION_SCHEMA);
  assert.deepEqual(live.data.document.content, document.content);

  type Backup = WorkspaceSnapshot & { schemaVersion: number; collabStates: { documentId: string; schemaVersion: number }[] };
  const { data: backup, status: exported } = await f.call<Backup>('/export');
  assert.equal(exported, 200);
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const oldEnvelope = await f.call<{error: string}>('/import', 'POST', {data: historicalMigrationBackup(backup, 45)});
  assert.equal(oldEnvelope.status, 400);
  assert.match(oldEnvelope.data.error, /schemaVersion 46/u);
  const oldState = structuredClone(backup);
  const state = oldState.collabStates.find(value => value.documentId === document.id);
  assert.ok(state);
  state.schemaVersion = 5;
  assert.equal((await f.call('/import', 'POST', {data: oldState})).status, 422);
  assert.equal((await f.call<CollaborationSession>(`${path}/collaboration`)).data.epoch, live.data.epoch);

  assert.equal((await f.call('/import', 'POST', {data: backup})).status, 200);
  const restored = await f.call<CollaborationSession>(`${path}/collaboration`);
  assert.equal(restored.status, 200);
  assert.notEqual(restored.data.epoch, live.data.epoch);
  assert.deepEqual(restored.data.document.content, document.content);
  const history = await f.call<DocRevision[]>(`${path}/revisions`);
  assert.ok(history.data.some(revision => JSON.stringify(revision.content) === JSON.stringify(document.content)));

  const archived = await f.call<{trashEntryId: string}>(path, 'DELETE', {expectedVersion: restored.data.document.version});
  assert.equal(archived.status, 200);
  const {data: archivedBackup} = await f.call<Backup>('/export');
  assert.ok(!archivedBackup.documents.some(doc => doc.id === document.id));
  assert.equal((await f.call('/import', 'POST', {data: historicalMigrationBackup(archivedBackup, 45)})).status, 400);
  assert.equal((await f.call('/import', 'POST', {data: archivedBackup})).status, 200);
  assert.equal((await f.call(`/trash/${archived.data.trashEntryId}/restore`, 'POST', {})).status, 200);
  const restoredArchive = await f.call<CollaborationSession>(`${path}/collaboration`);
  assert.equal(restoredArchive.status, 200);
  assert.deepEqual(restoredArchive.data.document.content, document.content);
});

test('actual HTTP worker merges source containers into a new project, enforces review/actor/server IDs, rejects conflicts and suppresses outbound import events', async () => {
  const f = await fixture(); try {
    const endpoint = await f.call<WebhookEndpointCreated>('/webhook-endpoints', 'POST', { name: 'Synthetic no-network outbox', url: 'http://127.0.0.1:1/not-called', projectIds: null, eventTypes: ['issue.created', 'comment.created'] }); assert.equal(endpoint.status, 201); assert.equal((await f.call(`/webhook-endpoints/${endpoint.data.endpoint.id}`, 'PATCH', { expectedVersion: 1, enabled: true })).status, 200);
    const pkg = await f.upload(csv, 'migration.csv'), config = await f.configuration(pkg); assert.equal(config.projects.length, 2);
    assert.equal((await f.call('/migrations/preview', 'POST', { configuration: config }, 'missing-actor')).status, 400);
    const bad = structuredClone(config); bad.users[Object.keys(bad.users)[0]] = 'missing-user'; const blocked = await f.preview(bad); assert.equal(blocked.canApply, false); assert.equal((await f.apply(blocked)).status, 409);
    const plan = await f.preview(config); assert.equal(plan.canApply, true, JSON.stringify(plan.notices)); assert.equal(plan.projects.length, 1); assert.ok(plan.requiredAcknowledgements.length > 0);
    assert.equal((await f.apply(plan, {}, 'user-min')).status, 403); assert.equal((await f.apply(plan, { expectedVersion: 99 })).status, 409); assert.equal((await f.apply(plan, { acknowledgements: [] })).status, 400);
    const [destination] = plan.projects;
    assert.equal(destination.mergesSources, true);
    assert.equal(destination.sourceOriginCount, 2);
    assert.deepEqual(destination.sources?.map(source => [source.sourceProjectId, source.issueCount]).sort(), [['OLD', 1], ['OTHER', 1]]);
    const mergeCode = 'PROJECT_SOURCE_MERGE';
    assert.ok(plan.requiredAcknowledgements.includes(mergeCode));
    const allExceptMerge = plan.requiredAcknowledgements.filter(code => code !== mergeCode);
    const beforeMerge = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    assert.equal((await f.apply(plan, { acknowledgements: allExceptMerge })).status, 400);
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data.projects, beforeMerge.projects);
    const shiftConversion = f.db.prepare(`UPDATE migration_previews SET json=json_set(json,'$.conversionVersion',
      json_extract(json,'$.conversionVersion') + ?) WHERE id=?`);
    shiftConversion.run(-1, plan.id);
    const stale = await f.apply(plan);
    assert.equal(stale.status, 409);
    assert.match(JSON.stringify(stale.data), /원본 변환 규칙/);
    shiftConversion.run(1, plan.id);
    const conflictConfig = structuredClone(config); conflictConfig.projects = conflictConfig.projects.map(value => ({ ...value, key: 'CONFLICT' })); const conflict = await f.preview(conflictConfig); assert.equal(conflict.canApply, true);
    assert.equal((await f.call('/projects', 'POST', { key: 'CONFLICT', name: 'Synthetic competing project' })).status, 201); assert.equal((await f.apply(conflict)).status, 409);
    const before = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    // A stored preview from before original-link planning can still apply when no source bases were selected.
    f.db.prepare(`UPDATE migration_previews SET json=json_remove(json,'$.atlassianLinks',
      '$.preview.counts.atlassianLinks','$.preview.counts.unlinkedAtlassianRecords',
      '$.sourceImport.counts.atlassianLinks','$.sourceImport.counts.unlinkedAtlassianRecords') WHERE id=?`).run(plan.id);
    const applied = await f.apply(plan, { actorId: 'user-min', projects: [{ id: 'client-forged-project' }], issues: [{ id: 'client-forged-issue', title: 'forged' }] }); assert.equal(applied.status, 201, JSON.stringify(applied.data)); assert.equal(applied.data.duplicate, false); assert.equal(applied.data.import.actorId, 'user-seo'); assert.deepEqual(applied.data.import.notices, plan.notices);
    assert.equal(applied.data.import.counts.atlassianLinks, undefined);
    const after = (await f.call<WorkspaceSnapshot>('/workspace')).data, imported = after.issues.filter(value => applied.data.import.projectIds.includes(value.projectId)); assert.equal(after.projects.length, before.projects.length + 1); assert.equal(imported.length, 2); assert.ok(imported.every(value => /^[a-f\d-]{36}$/.test(value.id) && !value.id.startsWith('client-'))); assert.ok(!after.projects.some(value => value.id === 'client-forged-project'));
    const receipt = (await f.call<SourceImport[]>('/source-imports')).data[0]; assert.deepEqual(receipt.notices, plan.notices); const originals = (await f.call<SourceRecordPage>(`/source-imports/${plan.id}/records?kind=issue`)).data; assert.equal(originals.total, 2); assert.deepEqual(originals.records.map(value => value.record.sourceId).sort(), ['100', '200']);
    const duplicate = await f.apply(plan); assert.equal(duplicate.status, 200); assert.equal(duplicate.data.duplicate, true); assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).data.issues.length, after.issues.length);
    const repeatedConfig = structuredClone(config); repeatedConfig.projects = repeatedConfig.projects.map(value => ({ ...value, key: 'SECOND' })); const repeated = await f.preview(repeatedConfig); assert.equal(repeated.canApply, false); assert.ok(repeated.notices.some(value => value.code === 'SOURCE_ALREADY_IMPORTED' && value.severity === 'error')); assert.equal((await f.apply(repeated)).status, 409); assert.equal((await f.call<SourceImport[]>('/source-imports')).data.length, 1); assert.deepEqual((await f.call('/webhook-deliveries')).data, []);
    const backup = await f.call('/export');
    const restored = await f.call('/import', 'POST', { data: backup.data });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    const [restoredReceipt] = (await f.call<SourceImport[]>('/source-imports')).data;
    assert.deepEqual(restoredReceipt.notices?.find(notice => notice.code === mergeCode), plan.notices.find(notice => notice.code === mergeCode));
  } finally { await f.close(); }
});

test('mixed migration creates only reviewed original Jira and Confluence links without contacting their servers', async t => {
  const upstreamRequests: string[] = [];
  const upstream = createServer((request, response) => {
    upstreamRequests.push(`${request.method} ${request.url}`);
    response.writeHead(404).end();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  const sourceOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const jiraBase = `${sourceOrigin}/jira-app`;
  const wikiBase = `${sourceOrigin}/services/wiki`;
  const f = await fixture({ NODE_ENV: 'test', TEAMSPACE_JIRA_BASE_URL: jiraBase, TEAMSPACE_CONFLUENCE_BASE_URL: wikiBase });
  t.after(() => f.close());

  const headers = 'Issue id,Issue key,Project key,Summary,Created,Updated,Status,Issue Type';
  const issueRow = (id: string, key: string, title: string) =>
    `${id},${key},OLD,${title},2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task`;
  const issueTitle = 'Linked original issue';
  const missingKeyTitle = 'Unlinked issue with missing key';
  const missingBaseTitle = 'Unlinked issue with an unconfigured source';
  const excludedTitle = 'Excluded issue with valid origin';
  const pageTitle = 'Synthetic versioned page';
  const jira = await f.upload(Buffer.from([headers, issueRow('100', 'old-7', issueTitle),
    issueRow('101', '', missingKeyTitle), issueRow('102', 'OLD-9', excludedTitle)].join('\r\n')), 'linked-origin.csv', 'jira');
  const unconfigured = await f.upload(Buffer.from([headers, issueRow('100', 'old-7', missingBaseTitle)].join('\r\n')), 'unconfigured-origin.csv', 'jira');
  const confluenceArchive = await f.upload(confluence().bytes, 'linked-origin.zip', 'confluence');
  const config = await f.configuration([jira, unconfigured, confluenceArchive], 'ORIGINS');
  for (const type of Object.keys(config.issueTypes)) config.issueTypes[type] = '작업';
  config.sourceBaseUrls[jira.id] = `${jiraBase}/`;
  config.sourceBaseUrls[confluenceArchive.id] = wikiBase;
  config.excludedRecords = [`${jira.id}/issue:102`];

  const jiraUrl = `${jiraBase}/browse/OLD-7`;
  const wikiUrl = `${wikiBase}/pages/viewpage.action?pageId=100`;
  const readStoredLinks = async (targetType: AtlassianLinkTarget, targetId: string) => {
    const result = await f.call<AtlassianLink[]>(`/atlassian-links?${new URLSearchParams({ targetType, targetId })}`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  const countStoredLinks = () => f.db.prepare('SELECT COUNT(*) AS total FROM atlassian_links').get()?.total;

  const stale = await f.preview(config);
  assert.equal(stale.canApply, true, JSON.stringify(stale.notices));
  f.db.prepare(`UPDATE migration_previews SET json=json_remove(json,'$.atlassianLinks',
    '$.preview.counts.atlassianLinks','$.preview.counts.unlinkedAtlassianRecords',
    '$.sourceImport.counts.atlassianLinks','$.sourceImport.counts.unlinkedAtlassianRecords') WHERE id=?`).run(stale.id);
  const rejected = await f.apply(stale);
  assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
  assert.match(JSON.stringify(rejected.data), /미리보기/);
  assert.deepEqual((await f.call('/source-imports')).data, []);
  assert.equal(countStoredLinks(), 0);

  const plan = await f.preview(config);
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.equal(plan.counts.atlassianLinks, 2);
  assert.equal(plan.counts.unlinkedAtlassianRecords, 2);
  assert.ok(plan.notices.some(notice => notice.code === 'SOURCE_LINK_LOCATOR_UNAVAILABLE' && notice.recordId === `${jira.id}/issue:101`));
  assert.ok(plan.notices.some(notice => notice.code === 'SOURCE_LINK_BASE_MISSING' && notice.message.includes(unconfigured.filename)));
  assert.equal(plan.samples.find(sample => sample.title === issueTitle)?.sourceUrl, jiraUrl);
  assert.equal(plan.samples.find(sample => sample.title === pageTitle)?.sourceUrl, wikiUrl);
  assert.ok(!plan.samples.find(sample => sample.title === missingKeyTitle)?.sourceUrl);
  assert.ok(!plan.samples.find(sample => sample.title === missingBaseTitle)?.sourceUrl);
  assert.ok(!plan.samples.some(sample => sample.title === excludedTitle));
  assert.equal(countStoredLinks(), 0);
  assert.deepEqual(upstreamRequests, []);

  const applied = await f.apply(plan, { atlassianLinks: [{ url: `${sourceOrigin}/forged` }] });
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const receipt = applied.data.import;
  assert.equal(receipt.counts.atlassianLinks, 2);
  assert.equal(receipt.counts.unlinkedAtlassianRecords, 2);
  assert.deepEqual(receipt.notices, plan.notices);
  const current = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const issue = current.issues.find(item => item.title === issueTitle);
  const document = current.documents.find(item => item.title === pageTitle);
  const missingKey = current.issues.find(item => item.title === missingKeyTitle);
  const missingBase = current.issues.find(item => item.title === missingBaseTitle);
  assert.ok(issue && document && missingKey && missingBase);
  assert.notEqual(issue.key, 'OLD-7');
  assert.ok(!current.issues.some(item => item.title === excludedTitle));
  const excluded = (await f.call<SourceRecordPage>(`/source-imports/${receipt.id}/records?kind=issue`)).data.records.find(item => item.record.title === excludedTitle);
  assert.ok(excluded);
  assert.equal(excluded.targetId, null);
  const canonicalJira = await readStoredLinks('issue', issue.id);
  const canonicalWiki = await readStoredLinks('document', document.id);
  assert.deepEqual(canonicalJira.map(({ product, url }) => ({ product, url })), [{ product: 'jira', url: jiraUrl }]);
  assert.deepEqual(canonicalWiki.map(({ product, url }) => ({ product, url })), [{ product: 'confluence', url: wikiUrl }]);
  assert.deepEqual(await readStoredLinks('issue', missingKey.id), []);
  assert.deepEqual(await readStoredLinks('issue', missingBase.id), []);

  const repeated = await f.apply(plan);
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.data, { import: receipt, duplicate: true });
  assert.deepEqual(await readStoredLinks('issue', issue.id), canonicalJira);
  assert.deepEqual(await readStoredLinks('document', document.id), canonicalWiki);
  const backup = (await f.call<{ schemaVersion: number; atlassianLinks: AtlassianLink[] }>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal(backup.atlassianLinks.length, 2);
  assert.deepEqual(new Set(backup.atlassianLinks.map(link => link.url)), new Set([jiraUrl, wikiUrl]));
  assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
  assert.deepEqual(await readStoredLinks('issue', issue.id), canonicalJira);
  assert.deepEqual(await readStoredLinks('document', document.id), canonicalWiki);
  assert.deepEqual((await f.call<SourceImport[]>('/source-imports')).data[0].counts, receipt.counts);
  assert.deepEqual(upstreamRequests, []);
});

test('receipt verifies exact ticket-document links through same-count drift, trash, and portable restore', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const jira = await f.upload(Buffer.from([
    'Issue id,Issue key,Project key,Summary,Created,Updated,Status,Issue Type',
    '101,OLD-1,OLD,Original linked ticket,2020-01-01,2020-01-02,Open,Task',
    '102,OLD-2,OLD,Another live ticket,2020-01-01,2020-01-02,Open,Task',
  ].join('\r\n')), 'resource-links.csv', 'jira');
  const xml = `<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">SYN</property><property name="name">Synthetic space</property></object>
    <object class="Page"><id name="id">100</id><property name="title">Linked reference page</property><property name="version">1</property>
      <property name="space" class="Space"><id name="id">42</id></property></object>
    <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[<p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">OLD-1</ac:parameter></ac:structured-macro></p>]]></property>
      <property name="content" class="Page"><id name="id">100</id></property></object>
  </hibernate-generic>`;
  const wiki = await f.upload(zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]), 'resource-links.zip', 'confluence');
  const plan = await f.preview(await f.configuration([jira, wiki], 'LINKS'));
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.equal(plan.counts.resourceLinks, 1);
  const migrated = await f.apply(plan);
  assert.equal(migrated.status, 201, JSON.stringify(migrated.data));
  const receipt = migrated.data.import;
  const workspace = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const issue = workspace.issues.find(row => row.title === 'Original linked ticket')!;
  const other = workspace.issues.find(row => row.title === 'Another live ticket')!;
  const document = workspace.documents.find(row => row.title === 'Linked reference page')!;
  const [proof] = receipt.resourceLinkProof ?? [];
  assert.ok(proof);
  assert.deepEqual(proof, { id: proof.id, issueId: issue.id, documentId: document.id });
  const auditBase = `/source-imports/${receipt.id}/reconciliation`;
  const audit = async (version = receipt.version) => {
    const response = await f.call<SourceReconciliationAudit>(`${auditBase}/audit?expectedVersion=${version}`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const projection = response.data.resourceLinkProjection;
    assert.ok(projection);
    assert.equal(projection.expected, 1);
    return projection;
  };
  const findings = (finding: string, expectedSha256: string) => f.call<SourceReconciliationResourceLinkFindingsPage>(
    `${auditBase}/resource-link-findings?${new URLSearchParams({ finding, expectedSha256, expectedVersion: String(receipt.version), limit: '1' })}`);
  const clean = await audit();
  assert.deepEqual(clean.counts, { linked: 1, trashed: 0, missing: 0, mismatch: 0, unavailable: 0 });

  const retarget = f.db.prepare("UPDATE resource_links SET issue_id=?, json=json_set(json,'$.issueId',?) WHERE id=?");
  assert.equal(retarget.run(other.id, other.id, proof.id).changes, 1);
  assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).data.resourceLinks.filter(link => link.documentId === document.id).length, 1);
  const drift = await audit();
  assert.equal(drift.counts.mismatch, 1);
  assert.notEqual(drift.sha256, clean.sha256);
  assert.equal((await findings('mismatch', clean.sha256)).status, 409);
  const detail = await findings('mismatch', drift.sha256);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.total, 1);
  assert.deepEqual(detail.data.rows, [{ ...proof, issue: { id: issue.id, key: issue.key, title: issue.title },
    document: { id: document.id, title: document.title } }]);
  assert.equal(retarget.run(issue.id, issue.id, proof.id).changes, 1);
  assert.equal((await audit()).sha256, clean.sha256);

  const archived = await f.call<{ trashEntryId: string }>(`/documents/${document.id}`, 'DELETE');
  assert.equal(archived.status, 200, JSON.stringify(archived.data));
  const inTrash = await audit();
  assert.equal(inTrash.counts.trashed, 1);
  const backup = (await f.call<WorkspaceSnapshot & { schemaVersion: number; sourceImports: SourceImport[] }>('/export')).data;
  assert.deepEqual(backup.sourceImports.find(row => row.id === receipt.id)?.resourceLinkProof, [proof]);
  const invalidVersion = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 113 } });
  assert.equal(invalidVersion.status, 400);
  assert.match(invalidVersion.data.error, /schemaVersion 114/u);
  const malformed = structuredClone(backup);
  malformed.sourceImports.find(row => row.id === receipt.id)!.resourceLinkProof = [];
  assert.equal((await f.call('/import', 'POST', { data: malformed })).status, 400);
  assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
  const restored = (await f.call<SourceImport[]>('/source-imports')).data.find(row => row.id === receipt.id)!;
  assert.ok(restored.version > receipt.version);
  assert.deepEqual(restored.resourceLinkProof, [proof]);
  assert.equal((await audit(restored.version)).sha256, inTrash.sha256);
  assert.equal((await f.call(`/trash/${archived.data.trashEntryId}/restore`, 'POST')).status, 200);
  assert.deepEqual((await audit(restored.version)).counts, clean.counts);
  assert.equal((await f.call(`/resource-links/${proof.id}`, 'DELETE')).status, 200);
  assert.equal((await audit(restored.version)).counts.missing, 1);

  const legacy = await fixture();
  t.after(() => legacy.close());
  const oldBackup = { ...structuredClone(backup), schemaVersion: 113 };
  delete oldBackup.sourceImports.find(row => row.id === receipt.id)!.resourceLinkProof;
  assert.equal((await legacy.call('/import', 'POST', { data: oldBackup })).status, 200);
  const oldAudit = await legacy.call<SourceReconciliationAudit>(`${auditBase}/audit?expectedVersion=${receipt.version}`);
  assert.equal(oldAudit.status, 200, JSON.stringify(oldAudit.data));
  assert.equal(oldAudit.data.resourceLinkProjection?.expected, 1);
  assert.deepEqual(oldAudit.data.resourceLinkProjection?.counts, { linked: 0, trashed: 0, missing: 0, mismatch: 0, unavailable: 0 });
});

test('separate Jira REST and Confluence ZIP imports link exact remote targets in either order after cold restore', async t => {
  const requests: string[] = [];
  const upstream = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(404).end();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const jiraBase = `${origin}/jira-app`;
  const wikiBase = `${origin}/services/wiki`;
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', TEAMSPACE_JIRA_BASE_URL: jiraBase, TEAMSPACE_CONFLUENCE_BASE_URL: wikiBase };
  const issueTitle = 'Ticket with exact remote links';
  const pageTitle = 'Exact reference page';
  const excludedTitle = 'Intentionally excluded page';
  const issueProjectName = 'Jira REST project';
  const documentProjectName = 'Confluence ZIP project';
  const date = '2020-01-01T00:00:00Z';
  const wikiUrl = (pageId: number) => `${wikiBase}/pages/viewpage.action?pageId=${pageId}`;
  const jiraIssueSelf = `${jiraBase}/rest/api/2/issue/20`;
  const jiraBytes = (exactUrl: string) => Buffer.from(JSON.stringify({ issues: [{
    id: '20', key: 'OLD-1', self: jiraIssueSelf,
    fields: { summary: issueTitle, project: { id: '10', key: 'OLD', name: 'Synthetic Jira' },
      status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' }, created: date, updated: date },
    changelog: { histories: [] },
    remoteLinks: { status: 'complete', values: [[901, 100], [902, 101], [903, 102], [904, 103]].map(([id, pageId]) => ({
      id, self: `${jiraIssueSelf}/remotelink/${id}`, globalId: `appId=synthetic-wiki&pageId=${pageId}`,
      application: { type: 'com.atlassian.confluence', name: 'Synthetic Confluence' },
      object: { url: pageId === 100 ? exactUrl : wikiUrl(pageId), title: `Original reference ${pageId}` },
    })) },
  }] }));
  function wikiBytes(space: 'SYN' | 'ALT', pages: [number, string][]) {
    const xml = `<hibernate-generic>
      <object class="Space"><id name="id">42</id><property name="key">${space}</property><property name="name">Synthetic ${space}</property></object>
      ${pages.map(([id, title]) => `
        <object class="Page"><id name="id">${id}</id><property name="title">${title}</property><property name="version">1</property>
          <property name="creationDate">${date}</property><property name="lastModificationDate">${date}</property>
          <property name="space" class="Space"><id name="id">42</id></property></object>
        <object class="BodyContent"><id name="id">${id + 300}</id><property name="body"><![CDATA[<p>${title}</p>]]></property>
          <property name="content" class="Page"><id name="id">${id}</id></property></object>`).join('')}
    </hibernate-generic>`;
    return zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]);
  }

  async function stage(f: MigrationFixture, product: 'jira' | 'confluence', exactUrl: string) {
    if (product === 'jira') {
      const pkg = await f.upload(jiraBytes(exactUrl), 'remote-links.json', 'jira', 'synthetic-jira');
      const config = await f.configuration(pkg, 'JIRAREST');
      config.projects = config.projects.map(project => ({ ...project, name: issueProjectName }));
      config.sourceBaseUrls[pkg.id] = jiraBase;
      config.excludedRecords = [`${pkg.id}/relation:remote:904`];
      return config;
    }
    const wiki = await f.upload(wikiBytes('SYN', [[100, pageTitle], [101, 'Ambiguous page one'],
      [102, excludedTitle], [103, 'Target of excluded relation']]), 'remote-targets.zip', 'confluence', 'synthetic-wiki');
    const ambiguous = await f.upload(wikiBytes('ALT', [[101, 'Ambiguous page two']]), 'ambiguous-target.zip', 'confluence', 'synthetic-alternate-wiki');
    const config = await f.configuration([wiki, ambiguous], 'WIKIZIP');
    config.projects = config.projects.map(project => ({ ...project, name: documentProjectName }));
    config.sourceBaseUrls[wiki.id] = wikiBase;
    config.sourceBaseUrls[ambiguous.id] = wikiBase;
    config.excludedRecords = [`${wiki.id}/page:102`];
    return config;
  }

  for (const [first, second] of [['jira', 'confluence'], ['confluence', 'jira']] as const) {
    await t.test(`${first} before ${second}`, async sub => {
      const exactUrl = first === 'jira' ? wikiUrl(100) : `${wikiBase}/display/SYN/${encodeURIComponent(pageTitle)}`;
      const original = await fixture(env);
      sub.after(() => original.close());
      const firstPreview = await original.preview(await stage(original, first, exactUrl));
      assert.equal(firstPreview.canApply, true, JSON.stringify(firstPreview.notices));
      assert.equal(firstPreview.counts.resourceLinks, 0);
      const firstApply = await original.apply(firstPreview);
      assert.equal(firstApply.status, 201, JSON.stringify(firstApply.data));
      const firstReceipt = firstApply.data.import;
      const backup = await original.call<WorkspaceSnapshot>('/export');
      assert.equal(backup.status, 200);

      const f = await fixture(env);
      sub.after(() => f.close());
      assert.equal((await f.call('/import', 'POST', { data: backup.data })).status, 200);
      const firstProjectId = firstReceipt.projectIds[0];
      const before = (await f.call<WorkspaceSnapshot>('/workspace')).data;
      const firstTarget = first === 'jira' ? before.issues.find(issue => issue.title === issueTitle)
        : before.documents.find(doc => doc.title === pageTitle);
      assert.ok(firstTarget);
      assert.equal(firstTarget.projectId, firstProjectId);

      const config = await stage(f, second, exactUrl);
      const stale = await f.preview(config);
      assert.equal(stale.canApply, true, JSON.stringify(stale.notices));
      assert.equal(stale.counts.resourceLinks, 1, JSON.stringify(stale.notices));
      assert.equal(stale.counts.retainedResourceLinks, 1);
      const targetPath = `/${first === 'jira' ? 'issues' : 'documents'}/${firstTarget.id}`;
      const archived = await f.call<{ trashEntryId: string }>(targetPath, 'DELETE', { expectedVersion: firstTarget.version });
      assert.equal(archived.status, 200, JSON.stringify(archived.data));
      const beforeRejected = (await f.call<WorkspaceSnapshot>('/workspace')).data;
      const rejected = await f.apply(stale);
      assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
      assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, beforeRejected);
      assert.deepEqual((await f.call<SourceImport[]>('/source-imports')).data.map(row => row.id), [firstReceipt.id]);
      assert.equal((await f.call(`/trash/${archived.data.trashEntryId}/restore`, 'POST', {})).status, 200);

      const plan = await f.preview(config);
      assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
      assert.equal(plan.counts.resourceLinks, 1, JSON.stringify(plan.notices));
      assert.ok(plan.requiredAcknowledgements.includes('RETAINED_DOCUMENT_ISSUE_LINKS'));
      const applied = await f.apply(plan);
      assert.equal(applied.status, 201, JSON.stringify(applied.data));
      const receipt = applied.data.import;
      const current = (await f.call<WorkspaceSnapshot>('/workspace')).data;
      const issue = current.issues.find(row => row.title === issueTitle);
      const page = current.documents.find(row => row.title === pageTitle);
      assert.ok(issue && page);
      const jiraReceipt = first === 'jira' ? firstReceipt : receipt;
      const wikiReceipt = first === 'confluence' ? firstReceipt : receipt;
      assert.equal(issue.projectId, jiraReceipt.projectIds[0]);
      assert.equal(page.projectId, wikiReceipt.projectIds[0]);
      assert.notEqual(issue.projectId, page.projectId);
      assert.equal(plan.counts.retainedResourceLinks, 1);
      assert.deepEqual(plan.retainedResourceLinks, [{
        issueKey: issue.key, issueTitle, issueProjectName, documentTitle: pageTitle, documentProjectName,
      }]);
      assert.ok(!current.documents.some(row => row.title === excludedTitle));
      assert.equal(current.documents.filter(row => row.title.startsWith('Ambiguous page')).length, 2);
      assert.ok(current.documents.some(row => row.title === 'Target of excluded relation'));
      const baselineIds = new Set(before.resourceLinks.map(row => row.id));
      const newLinks = current.resourceLinks.filter(row => !baselineIds.has(row.id));
      assert.equal(newLinks.length, 1);
      const proof = { id: newLinks[0].id, issueId: issue.id, documentId: page.id };
      assert.deepEqual(newLinks, [{ ...proof, kind: 'related' }]);
      assert.deepEqual(receipt.resourceLinkProof, [proof]);
      assert.equal(receipt.counts.resourceLinks, 1);

      const remoteRecords = await f.call<SourceRecordPage>(`/source-imports/${jiraReceipt.id}/records?kind=relation`);
      assert.equal(remoteRecords.status, 200, JSON.stringify(remoteRecords.data));
      assert.deepEqual(remoteRecords.data.records.map(({ record, targetId, excluded }) => [record.id, targetId, excluded ?? false]).sort(),
        [[901, false], [902, false], [903, false], [904, true]].map(([id, excluded]) => [`relation:remote:${id}`, null, excluded]));
      const records = await f.call<SourceRecordPage>(`/source-imports/${wikiReceipt.id}/records?kind=page`);
      assert.equal(records.status, 200);
      const excluded = records.data.records.find(row => row.record.title === excludedTitle);
      assert.equal(excluded?.excluded, true);
      assert.equal(excluded?.targetId, null);

      const audit = await f.call<SourceReconciliationAudit>(`/source-imports/${receipt.id}/reconciliation/audit?expectedVersion=${receipt.version}`);
      assert.equal(audit.status, 200, JSON.stringify(audit.data));
      assert.equal(audit.data.resourceLinkProjection?.expected, 1);
      assert.deepEqual(audit.data.resourceLinkProjection?.counts, { linked: 1, trashed: 0, missing: 0, mismatch: 0, unavailable: 0 });
      const receipts = (await f.call<SourceImport[]>('/source-imports')).data;
      const earlier = receipts.find(row => row.id === firstReceipt.id);
      assert.equal(earlier?.counts.resourceLinks, 0);
      assert.deepEqual(earlier?.resourceLinkProof ?? [], []);
      const reapplied = await f.apply(plan);
      assert.equal(reapplied.status, 200);
      assert.deepEqual(reapplied.data, { import: receipt, duplicate: true });
      if (first === 'jira') {
        const competing = await f.upload(wikiBytes('ALT', [[100, 'Another exact page claim']]),
          'competing-target.zip', 'confluence', 'synthetic-third-wiki');
        const competingConfig = await f.configuration(competing, 'COMPETING');
        competingConfig.sourceBaseUrls[competing.id] = wikiBase;
        const competingPlan = await f.preview(competingConfig);
        assert.equal(competingPlan.canApply, true, JSON.stringify(competingPlan.notices));
        assert.equal(competingPlan.counts.resourceLinks, 0);
        assert.ok(competingPlan.notices.some(notice => notice.code === 'RETAINED_DOCUMENT_ISSUE_LINK_UNRESOLVED'));
      }
    });
  }
  assert.deepEqual(requests, []);
});

test('actual ZIP attachment versions survive native9 exact downloads and migration audit/save/install failures roll back database and files', async t => {
  const f = await fixture(), binary = confluence(); try {
    const pkg = await f.upload(binary.bytes, 'confluence.zip', 'confluence'), config = await f.configuration(pkg);
    config.sourceBaseUrls[pkg.id] = 'https://archive.example.test/wiki';
    const plan = await f.preview(config); assert.equal(plan.canApply, true, JSON.stringify(plan.notices)); assert.equal(plan.counts.attachmentVersions, 2); assert.equal(plan.counts.atlassianLinks, 1);
    const existingBytes = Buffer.from('unrelated existing fixture file'), upload = await fetch(`${f.base}/attachments?resourceType=issue&resourceId=issue-2&filename=existing.bin`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-seo' }, body: existingBytes }); assert.equal(upload.status, 201); const existing = await upload.json() as Attachment;
    const before = (await f.call<WorkspaceSnapshot>('/workspace')).data, names = readdirSync(join(f.dir, 'uploads')).sort();
    const unchanged = async () => { assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, before); assert.deepEqual((await f.call('/source-imports')).data, []); assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM atlassian_links').get()?.total, 0); assert.deepEqual(readdirSync(join(f.dir, 'uploads')).sort(), names); assert.deepEqual(readFileSync(join(f.dir, 'uploads', existing.id)), existingBytes); assert.ok(!readdirSync(f.dir).some(value => value.startsWith('.append-'))); };
    f.db.exec("CREATE TRIGGER synthetic_migration_audit BEFORE INSERT ON activities WHEN json_extract(NEW.json,'$.action')='원본 이관 적용' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
    assert.equal((await f.apply(plan)).status, 500); f.db.exec('DROP TRIGGER synthetic_migration_audit'); await unchanged();
    f.db.exec("CREATE TRIGGER synthetic_migration_save BEFORE INSERT ON documents WHEN json_extract(NEW.json,'$.title')='Synthetic versioned page' BEGIN SELECT RAISE(ABORT,'synthetic save failure'); END;");
    assert.equal((await f.apply(plan)).status, 500); f.db.exec('DROP TRIGGER synthetic_migration_save'); await unchanged();
    f.db.exec("CREATE TRIGGER synthetic_migration_link BEFORE INSERT ON atlassian_links BEGIN SELECT RAISE(ABORT,'synthetic link failure'); END;");
    assert.equal((await f.apply(plan)).status, 500); f.db.exec('DROP TRIGGER synthetic_migration_link'); await unchanged();
    const stage = AttachmentAppend.prototype.stage;
    const installedFailure = t.mock.method(AttachmentAppend.prototype, 'stage', function (this: AttachmentAppend, id: string, files: AppendedFile[]) { const result = stage.call(this, id, files); return { ...result, install() { result.install(); throw new Error('synthetic failure after install'); } }; });
    assert.equal((await f.apply(plan)).status, 500); installedFailure.mock.restore(); await unchanged();
    const applied = await f.apply(plan); assert.equal(applied.status, 201, JSON.stringify(applied.data));
    const workspace = (await f.call<WorkspaceSnapshot>('/workspace')).data, document = workspace.documents.find(value => applied.data.import.projectIds.includes(value.projectId || ''))!; assert.ok(document);
    const files = (await f.call<Attachment[]>(`/attachments?resourceType=document&resourceId=${document.id}`)).data; assert.equal(files.length, 1); const versions = (await f.call<AttachmentVersion[]>(`/attachments/${files[0].id}/versions`)).data; assert.equal(versions.length, 2);
    async function exactDownloads() { for (const version of versions) { const response = await fetch(`${f.base}/attachment-versions/${version.id}/download`); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), version.versionLabel === '1' ? binary.first : binary.latest); } }
    await exactDownloads();
    const backup = (await f.call<Record<string, unknown>>('/export')).data; assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION); assert.equal((backup.attachmentVersions as unknown[]).length, 2); assert.equal((backup.attachmentContents as unknown[]).length, 3);
    const invalidNotice = structuredClone(backup); (invalidNotice.sourceImports as SourceImport[])[0].notices = [{ severity: 'error', code: 'SYNTHETIC_BLOCKER', message: '완료된 영수증에 오류를 넣을 수 없음', recordId: null, requiresAcknowledgement: false }]; assert.equal((await f.call('/import', 'POST', { data: invalidNotice })).status, 400); await exactDownloads();
    const invalid = structuredClone(backup); (invalid.resourceLinks as { documentId: string }[])[0].documentId = 'synthetic-missing-document'; const snapshot = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    assert.equal((await f.call('/import', 'POST', { data: invalid })).status, 404); assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, snapshot); await exactDownloads();
    assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200); await exactDownloads();
    const after = (await f.call<SourceImport[]>('/source-imports')).data[0]; assert.equal(after.version, 2); assert.deepEqual(after.notices, plan.notices);
    const archives = (await f.call<SourceRecordPage>(`/source-imports/${plan.id}/records?kind=attachment`)).data; assert.equal(archives.total, 2); const archive = (await f.call<SourceRecordArchive>(`/source-imports/${plan.id}/records/${archives.records[0].id}`)).data; assert.equal(archive.record.kind, 'attachment');

    const root = files[0].id;
    const localBytes = Buffer.from('현지 팀에서 추가한 합성 버전');
    const localUpload = await fetch(`${f.base}/attachments/${root}/versions?${new URLSearchParams({ expectedVersionId: root, filename: 'updated.bin' })}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-min' }, body: new Uint8Array(localBytes),
    });
    const local = await localUpload.json() as AttachmentHead;
    assert.equal(localUpload.status, 201, JSON.stringify(local));
    assert.equal(local.id, root);
    assert.notEqual(local.currentVersionId, root);
    assert.equal(local.versionCount, 3);
    const historyWithLocal = (await f.call<AttachmentVersion[]>(`/attachments/${root}/versions`)).data;
    assert.equal(historyWithLocal[0].id, local.currentVersionId);
    assert.equal(historyWithLocal[0].localRevision, 2);
    assert.equal(historyWithLocal[0].sourceImportId, null);
    assert.deepEqual(historyWithLocal.slice(1), versions);
    const preservedRoot = await fetch(`${f.base}/attachments/${root}/content`);
    assert.equal(preservedRoot.status, 200);
    assert.deepEqual(Buffer.from(await preservedRoot.arrayBuffer()), binary.latest);
    await exactDownloads();

    const withLocal = (await f.call<Record<string, unknown>>('/export')).data;
    assert.equal((await f.call('/import', 'POST', { data: withLocal })).status, 200);
    assert.deepEqual((await f.call<AttachmentVersion[]>(`/attachments/${root}/versions`)).data, historyWithLocal);
    assert.deepEqual((await f.call<SourceRecordPage>(`/source-imports/${plan.id}/records?kind=attachment`)).data, archives);
    const localBytesAgain = await fetch(`${f.base}/attachments/${local.currentVersionId}/content`);
    assert.equal(localBytesAgain.status, 200);
    assert.deepEqual(Buffer.from(await localBytesAgain.arrayBuffer()), localBytes);
    await exactDownloads();
  } finally { await f.close(); }
});

test('Confluence XML worker imports remote page attachments by original owner and downloads exact linked bytes after native restore', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const prop = (name: string, value: string) => `<property name="${name}">${value}</property>`;
  const ref = (name: string, type: string, id: string) => `<property name="${name}" class="${type}"><id name="id">${id}</id></property>`;
  const object = (type: string, id: string, children: string) => `<object class="${type}"><id name="id">${id}</id>${children}</object>`;
  const date = prop('creationDate', '2020-01-02T00:00:00Z');
  const file = (id: string, owner: string, filename: string, version: string, history: string) =>
    object('Attachment', id, prop('title', filename) + prop('version', version) + ref('containerContent', 'Page', owner) + date + history);
  const projectPage = (id: string, space: string, version = '1', history = '') =>
    object('Page', id, prop('title', '원본 현황') + prop('version', version) + ref('space', 'Space', space) + date + history);
  const sourceBase = 'https://wiki.example.test/confluence';
  const reportDownload = '/confluence/download/attachments/200/report.bin';
  const historyMarkup = `<p><a href="${reportDownload}?version=1">과거 버전 명시</a></p>` +
    `<p><a href="${reportDownload}">과거 버전 미지정</a></p>`;
  const storage = [
    '<p>파일을 참조하는 원본</p>',
    '<ac:image ac:alt="원격 소유 PNG"><ri:attachment ri:filename="shared.png"><ri:page ri:space-key="QA" ri:content-title="원본 현황"/></ri:attachment></ac:image>',
    '<p><ac:link><ri:attachment ri:filename="report.bin" ri:content-id="721"><ri:content-entity ri:content-id="200"/></ri:attachment><ac:link-body>원격 예전 보고서</ac:link-body></ac:link></p>',
    '<ac:image ac:alt="누락된 소유 PNG"><ri:attachment ri:filename="shared.png"><ri:page ri:space-key="ABSENT" ri:content-title="원본 현황"/></ri:attachment></ac:image>',
    '<p><ac:link><ri:attachment ri:filename="report.bin" ri:content-id="701"><ri:content-entity ri:content-id="200"/></ri:attachment><ac:link-body>잘못된 소유 보고서</ac:link-body></ac:link></p>',
    '<img src="./download/attachments/200/shared.png" alt="상대 주소 이미지"/>',
    `<ac:image ac:alt="절대 주소 이미지"><ri:url ri:value="${sourceBase}/download/attachments/200/shared.png?version=1&amp;api=v2"/></ac:image>`,
    `<p><a href="${reportDownload}?version=1&amp;modificationDate=123456&amp;api=v2"><strong>원래 버전 다운로드</strong></a></p>`,
    '<p><a href="download/attachments/200/report.bin">현재 버전 다운로드</a></p>',
    `<p><a href="${reportDownload}?version=99">미확인 버전 원본 열기</a></p>`,
    `<p><a href="${reportDownload}?version=1&amp;version=2">중복 버전 원본 열기</a></p>`,
    `<p><a href="https://other.example.test${reportDownload}">외부 원본 열기</a></p>`,
    `<p><a href="${sourceBase}/download/attachments/200/a%2Freport.bin">다른 경로 원본 열기</a></p>`,
  ].join('');
  const xml = `<hibernate-generic>${[
    object('Space', '20', prop('key', 'OPS') + prop('name', '원본 업무 공간')),
    object('Space', '30', prop('key', 'QA') + prop('name', '원본 검증 공간')),
    projectPage('100', '20', '2'), projectPage('101', '20', '1', ref('originalVersion', 'Page', '100')), projectPage('200', '30'),
    object('BodyContent', '500', prop('body', `<![CDATA[${storage}]]>`) + ref('content', 'Page', '100')),
    object('BodyContent', '501', prop('body', `<![CDATA[${historyMarkup}]]>`) + ref('content', 'Page', '101')),
    file('700', '100', 'shared.png', '1', ''),
    file('701', '100', 'report.bin', '1', ''),
    file('710', '200', 'shared.png', '1', ''),
    file('720', '200', 'report.bin', '2', '<collection name="historicalVersions"><element class="Attachment"><id name="id">721</id></element></collection>'),
    file('721', '200', 'report.bin', '1', ref('originalVersion', 'Attachment', '720')),
  ].join('')}</hibernate-generic>`;
  const localPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+2TmcAAAAASUVORK5CYII=', 'base64');
  const remotePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGD4DwABBAEAMHhqrQAAAABJRU5ErkJggg==', 'base64');
  const oldReport = Buffer.from('원격 보고서의 예전 버전\x00\n');
  const pack = await f.upload(zip([
    { path: 'entities.xml', bytes: Buffer.from(xml) },
    { path: 'attachments/100/700/1', bytes: localPng },
    { path: 'attachments/100/701/1', bytes: Buffer.from('같은 이름의 로컬 보고서') },
    { path: 'attachments/200/710/1', bytes: remotePng },
    { path: 'attachments/200/720/1', bytes: oldReport },
    { path: 'attachments/200/720/2', bytes: Buffer.from('원격 보고서의 현재 버전') },
  ]), 'confluence-remote-owner.zip', 'confluence');
  const configuration = await f.configuration(pack);
  configuration.sourceBaseUrls[pack.id] = sourceBase;
  const previous = await f.preview(configuration);
  assert.equal(previous.canApply, true, JSON.stringify(previous.notices));
  f.db.prepare("UPDATE migration_previews SET json=json_set(json,'$.conversionVersion',12) WHERE id=?").run(previous.id);
  const oldReview = await f.call<{ error: string }>(`/migrations/previews/${previous.id}`);
  assert.equal(oldReview.status, 409);
  assert.match(oldReview.data.error, /새 미리보기/u);
  assert.equal((await f.apply(previous)).status, 409);
  f.db.prepare("UPDATE migration_previews SET json=json_remove(json,'$.conversionVersion') WHERE id=?").run(previous.id);
  assert.equal((await f.apply(previous)).status, 409);
  const preview = await f.preview(configuration);
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  assert.ok(preview.notices.some(notice => notice.code === 'UNRESOLVED_IMAGE' && notice.recordId === `${pack.id}/page:100`));
  assert.ok(preview.notices.some(notice => notice.code === 'UNRESOLVED_ATTACHMENT' && notice.recordId === `${pack.id}/page:100`));
  const applied = await f.apply(preview);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const receipt = applied.data.import;

  async function checkBindingsAndDownloads() {
    const recordsPath = `/source-imports/${receipt.id}/records`;
    const originals = await f.call<SourceRecordPage>(recordsPath);
    assert.equal(originals.status, 200);
    const archive = (id: string) => originals.data.records.find(row => row.record.id === id)!;
    const sourcePage = archive('page:100');
    const localFile = archive('attachment:700');
    const remoteFile = archive('attachment:710');
    const historicalReport = archive('attachment:721');
    const currentReport = archive('attachment:720');
    const remoteDocument = archive('page:200');
    assert.ok(sourcePage?.targetId && localFile?.targetId && remoteFile?.targetId && historicalReport?.targetId && currentReport?.targetId && remoteDocument?.targetId);
    assert.equal(localFile.ownerId, sourcePage.targetId);
    assert.equal(remoteFile.ownerId, remoteDocument.targetId);
    assert.equal(historicalReport.ownerId, remoteDocument.targetId);
    assert.notEqual(historicalReport.targetId, currentReport.targetId);

    const workspace = await f.call<WorkspaceSnapshot>('/workspace');
    assert.equal(workspace.status, 200);
    const source = workspace.data.documents.find(document => document.id === sourcePage.targetId)!;
    const images: Array<RichContent['attrs']> = [];
    const links = new Map<string, unknown>();
    const pending = [source.content];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === 'image') images.push(node.attrs);
      for (const mark of node.marks ?? []) if (node.text && mark.type === 'link') links.set(node.text, mark.attrs?.href);
      pending.push(...node.content ?? []);
    }
    const imageUrl = `/api/attachments/${remoteFile.targetId}/content?inline=1`;
    const versionUrl = `/api/attachments/${historicalReport.targetId}/content`;
    const currentUrl = `/api/attachments/${currentReport.targetId}/content`;
    assert.deepEqual(images.map(image => [image?.src, image?.alt]), [
      [imageUrl, '절대 주소 이미지'], [imageUrl, '상대 주소 이미지'], [imageUrl, '원격 소유 PNG'],
    ]);
    assert.deepEqual(links, new Map([
      ['다른 경로 원본 열기', `${sourceBase}/download/attachments/200/a%2Freport.bin`],
      ['외부 원본 열기', `https://other.example.test${reportDownload}`],
      ['중복 버전 원본 열기', `https://wiki.example.test${reportDownload}?version=1&version=2`],
      ['미확인 버전 원본 열기', `https://wiki.example.test${reportDownload}?version=99`],
      ['현재 버전 다운로드', currentUrl],
      ['원래 버전 다운로드', versionUrl],
      ['원격 예전 보고서', versionUrl],
    ]));
    assert.match(source.plainText, /\[이미지: 누락된 소유 PNG\]/);
    assert.match(source.plainText, /\[첨부: 잘못된 소유 보고서\]/);
    const original = await f.call<SourceRecordArchive>(`${recordsPath}/${sourcePage.id}`);
    assert.equal(original.status, 200);
    assert.equal(original.data.record.text, storage);

    const revisions = await f.call<DocRevision[]>(`/documents/${source.id}/revisions`);
    assert.equal(revisions.status, 200);
    const historical = revisions.data.find(revision => revision.plainText.includes('과거 버전 명시'));
    assert.ok(historical);
    const historicalHrefs = historical.content.content?.map(node => node.content?.[0]?.marks?.find(mark => mark.type === 'link')?.attrs?.href);
    assert.deepEqual(historicalHrefs, [versionUrl, `https://wiki.example.test${reportDownload}`]);

    const version = await fetch(new URL(versionUrl, f.base));
    assert.equal(version.status, 200);
    assert.match(version.headers.get('Content-Disposition') || '', /^attachment;/);
    assert.deepEqual(Buffer.from(await version.arrayBuffer()), oldReport);
    const current = await fetch(new URL(currentUrl, f.base));
    assert.equal(current.status, 200);
    assert.deepEqual(Buffer.from(await current.arrayBuffer()), Buffer.from('원격 보고서의 현재 버전'));
    const image = await fetch(new URL(imageUrl, f.base));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('Content-Type'), 'image/png');
    assert.match(image.headers.get('Content-Disposition') || '', /^inline;/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), remotePng);
    return source.content;
  }

  const before = await checkBindingsAndDownloads();
  const backup = await f.call('/export');
  assert.equal(backup.status, 200);
  assert.equal((await f.call('/import', 'POST', { data: backup.data })).status, 200);
  assert.deepEqual(await checkBindingsAndDownloads(), before);
});

test('reconciliation and the whole-receipt audit follow exact migrated attachment versions through corruption, trash, native restore, and deletion', async t => {
  const f = await fixture(), binary = confluence(true);
  try {
    const pkg = await f.upload(binary.bytes, 'reconciliation.zip', 'confluence');
    const config = await f.configuration(pkg);
    config.excludedRecords = [`${pkg.id}/attachment:704`];
    const plan = await f.preview(config);
    assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
    const applied = await f.apply(plan);
    assert.equal(applied.status, 201, JSON.stringify(applied.data));
    const receipt = applied.data.import;
    const auditPath = `/source-imports/${receipt.id}/reconciliation`;
    const fullPath = (version = receipt.version) => `${auditPath}/audit?expectedVersion=${version}`;
    async function audit(query = '') {
      const result = await f.call<SourceReconciliationPage>(auditPath + query);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.importId, receipt.id);
      return result.data;
    }
    async function fullAudit(version = receipt.version) {
      const result = await f.call<SourceReconciliationAudit>(fullPath(version));
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.importId, receipt.id);
      assert.equal(result.data.receiptVersion, version);
      assert.ok(Date.parse(result.data.startedAt) <= Date.parse(result.data.completedAt));
      assert.equal(result.data.attachments.length, Object.values(result.data.attachmentCounts).reduce((sum, count) => sum + count, 0));
      return result.data;
    }
    const initial = await audit();
    assert.equal(initial.receiptVersion, receipt.version);
    assert.equal(initial.total, receipt.counts.sourceRecords);
    assert.equal(initial.total, Object.values(initial.counts).reduce((sum, count) => sum + count, 0));
    assert.doesNotMatch(JSON.stringify(initial), /보존한 문서 본문|보존한 원본 댓글/);

    const document = initial.rows.find(row => row.kind === 'page');
    const related = initial.rows.filter(row => row.kind === 'revision' || row.kind === 'comment');
    const versionRows = initial.rows.filter(row => row.kind === 'attachment');
    const older = versionRows.find(row => row.sourceId === '701');
    const newer = versionRows.find(row => row.sourceId === '700');
    const removed = versionRows.find(row => row.sourceId === '702');
    const archiveOnly = versionRows.find(row => row.sourceId === '703');
    const excluded = versionRows.find(row => row.sourceId === '704');
    assert.ok(document?.target && older?.target && newer?.target && removed?.target && archiveOnly && excluded);
    const documentId = document.target.id;
    const archivedTogether = [document, older, newer, ...related];
    assert.deepEqual(related.map(row => row.kind).sort(), ['comment', 'revision']);
    assert.ok(archivedTogether.every(row => row.status === 'linked'));
    assert.ok([older, newer, removed, ...related].every(row => row.target?.owner?.id === documentId));
    assert.equal(archiveOnly.status, 'archive-only');
    assert.equal(archiveOnly.target, null);

    const checkFilePath = (sourceRecordId: string) => `/source-imports/${receipt.id}/records/${sourceRecordId}/check-file`;
    async function checkFile(sourceRecordId: string) {
      const checked = await f.call<SourceReconciliationFileCheck>(checkFilePath(sourceRecordId));
      assert.equal(checked.status, 200, JSON.stringify(checked.data));
      assert.equal(checked.data.sourceRecordId, sourceRecordId);
      return checked.data;
    }
    assert.equal((await f.call(checkFilePath(document.sourceRecordId))).status, 400);
    assert.equal((await checkFile(archiveOnly.sourceRecordId)).status, 'unbound');
    const expectedOlder = { sourceRecordId: older.sourceRecordId, status: 'verified', fileId: older.target.id, size: binary.first.length, sha256: hash(binary.first) };
    assert.deepEqual(await checkFile(older.sourceRecordId), expectedOlder);
    assert.equal((await checkFile(newer.sourceRecordId)).sha256, hash(binary.latest));

    assert.equal(excluded.status, 'excluded');
    const untouchedWorkspace = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const clean = await fullAudit();
    assert.equal(clean.jiraStatusHistory, null);
    assert.equal((await f.call(`${auditPath}/jira-status-findings?expectedVersion=${receipt.version}&finding=unavailable`)).status, 404);
    const cleanOlder = clean.attachments.find(row => row.sourceRecordId === older.sourceRecordId);
    assert.deepEqual(clean.recordCounts, initial.counts);
    assert.deepEqual(clean.attachmentCounts, { verified: 3, missing: 0, corrupt: 0, unbound: 1, excluded: 1, unreadable: 0 });
    assert.deepEqual(cleanOlder, {
      ...expectedOlder, sourceId: '701', title: 'report.bin', product: 'confluence', recordStatus: 'linked',
      sourceInstance: pkg.source.instanceKey, packageSha256: pkg.sha256,
    });
    assert.equal(clean.attachments.find(row => row.sourceRecordId === newer.sourceRecordId)?.sha256, hash(binary.latest));
    assert.equal(clean.attachments.find(row => row.sourceRecordId === excluded.sourceRecordId)?.status, 'excluded');
    assert.equal(clean.attachments.find(row => row.sourceRecordId === archiveOnly.sourceRecordId)?.status, 'unbound');
    assert.doesNotMatch(JSON.stringify(clean), /보존한 문서 본문|보존한 원본 댓글/);
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, untouchedWorkspace);
    assert.deepEqual((await f.call<SourceImport[]>('/source-imports')).data.find(value => value.id === receipt.id), receipt);

    const olderPath = join(f.dir, 'uploads', older.target.id);
    const corrupted = Buffer.from(binary.first);
    corrupted[0] ^= 1;
    try {
      writeFileSync(olderPath, corrupted);
      assert.deepEqual(await checkFile(older.sourceRecordId), { ...expectedOlder, status: 'corrupt' });
      const mixed = await fullAudit();
      assert.deepEqual(mixed.attachmentCounts, { ...clean.attachmentCounts, verified: 2, corrupt: 1 });
      assert.equal(mixed.attachments.find(row => row.sourceRecordId === older.sourceRecordId)?.recordStatus, 'linked');
      rmSync(olderPath);
      assert.deepEqual(await checkFile(older.sourceRecordId), { ...expectedOlder, status: 'missing' });
      assert.deepEqual((await fullAudit()).attachmentCounts, { ...clean.attachmentCounts, verified: 2, missing: 1 });
      assert.equal((await checkFile(newer.sourceRecordId)).status, 'verified');
      assert.equal((await audit()).rows.find(row => row.sourceRecordId === older.sourceRecordId)?.status, 'linked');
    } finally { writeFileSync(olderPath, binary.first); }

    const versionRow = f.db.prepare('SELECT json FROM attachment_versions WHERE id=?').get(older.target.id);
    assert.ok(versionRow && typeof versionRow.json === 'string');
    const updateVersion = f.db.prepare('UPDATE attachment_versions SET json=? WHERE id=?');
    try {
      writeFileSync(olderPath, corrupted);
      updateVersion.run(JSON.stringify({ ...(JSON.parse(versionRow.json) as AttachmentVersion), sha256: hash(corrupted) }), older.target.id);
      assert.equal((await checkFile(older.sourceRecordId)).status, 'verified');
      assert.equal((await fullAudit()).attachments.find(row => row.sourceRecordId === older.sourceRecordId)?.status, 'corrupt');
    } finally {
      updateVersion.run(versionRow.json, older.target.id);
      writeFileSync(olderPath, binary.first);
    }

    const open = fileSystem.open;
    const unreadable = t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof open>) => {
      if (String(args[0]) === olderPath) throw Object.assign(new Error('synthetic access failure'), { code: 'EACCES' });
      return open(...args);
    });
    try {
      const report = await fullAudit();
      assert.deepEqual(report.attachmentCounts, { ...clean.attachmentCounts, verified: 2, unreadable: 1 });
      assert.equal(report.attachments.find(row => row.sourceRecordId === older.sourceRecordId)?.status, 'unreadable');
      assert.doesNotMatch(JSON.stringify(report), /synthetic access failure/);
    } finally { unreadable.mock.restore(); }

    const allMatches = await audit('?kind=attachment&status=linked&q=report.bin');
    assert.equal(allMatches.total, 2);
    for (const offset of [0, 1]) {
      const page = await audit(`?kind=attachment&status=linked&q=report.bin&limit=1&offset=${offset}`);
      assert.equal(page.total, 2);
      assert.equal(page.offset, offset);
      assert.equal(page.limit, 1);
      assert.deepEqual(page.counts, initial.counts);
      assert.deepEqual(page.rows, [allMatches.rows[offset]]);
    }
    for (const invalid of ['?limit=0', '?limit=101', '?status=unknown', '?offset=1&offset=2', '?unexpected=true']) {
      assert.equal((await f.call(auditPath + invalid)).status, 400, invalid);
    }
    assert.equal((await f.call(`/source-imports/${randomUUID()}/reconciliation`)).status, 404);
    assert.equal((await f.call(`/source-imports/${randomUUID()}/reconciliation/audit?expectedVersion=1`)).status, 404);
    assert.equal((await f.call(`${auditPath}/audit`)).status, 400);
    assert.equal((await f.call(`${fullPath()}&expectedVersion=2`)).status, 400);
    assert.equal((await f.call(checkFilePath(randomUUID()))).status, 404);

    const key = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: 'Synthetic project read key', access: 'read', projectIds: receipt.projectIds, expiresAt: null });
    assert.equal(key.status, 201, JSON.stringify(key.data));
    for (const path of [auditPath, checkFilePath(older.sourceRecordId), fullPath()]) {
      const response = await fetch(`${f.base}/v1${path}`, { headers: { Authorization: `Bearer ${key.data.token}` } });
      assert.equal(response.status, 403, path);
      await response.body?.cancel();
    }

    const canonical = await f.call<WorkspaceSnapshot>('/workspace');
    const currentDoc = canonical.data.documents.find(value => value.id === documentId)!;
    const pause = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let intercepted = false;
    const mockedOpen = t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof open>) => {
      if (!intercepted && String(args[0]) === olderPath) {
        intercepted = true;
        pause.resolve();
        await release.promise;
      }
      return open(...args);
    });
    const pending = f.call(fullPath());
    let destination: DocPage;
    try {
      assert.equal(await Promise.race([pause.promise.then(() => true), pending.then(() => false)]), true, 'audit paused at the live attachment read');
      assert.equal((await f.call(fullPath())).status, 429);
      const moved = await f.call<DocPage>(`/documents/${documentId}`, 'PATCH', { projectId: 'project-neo', expectedVersion: currentDoc.version });
      assert.equal(moved.status, 200, JSON.stringify(moved.data));
      destination = moved.data;
      release.resolve();
      assert.equal((await pending).status, 409);
    } finally {
      release.resolve();
      mockedOpen.mock.restore();
      await pending;
    }
    const movedAudit = await audit();
    assert.equal(movedAudit.rows.find(row => row.sourceRecordId === document.sourceRecordId)?.target?.projectId, destination.projectId);
    assert.equal(movedAudit.rows.find(row => row.sourceRecordId === older.sourceRecordId)?.target?.owner?.projectId, destination.projectId);

    const versionArchive = await f.call<{ trashItemId: string }>(`/attachments/${newer.target.id}`, 'DELETE');
    assert.equal(versionArchive.status, 200, JSON.stringify(versionArchive.data));
    assert.deepEqual(new Set((await audit('?status=trashed')).rows.map(row => row.sourceRecordId)), new Set([older.sourceRecordId, newer.sourceRecordId]));
    assert.deepEqual(await checkFile(older.sourceRecordId), expectedOlder);
    const versionedFiles = new Set([older.target.id, newer.target.id]);
    const archivedVersions = (await fullAudit()).attachments.filter(row => row.fileId && versionedFiles.has(row.fileId));
    assert.equal(archivedVersions.length, 2);
    assert.ok(archivedVersions.every(row => row.recordStatus === 'trashed' && row.status === 'verified'));
    assert.equal((await f.call(`/trash/items/${versionArchive.data.trashItemId}/restore`, 'POST')).status, 200);
    assert.equal((await audit('?status=trashed')).total, 0);

    const commentSource = related.find(row => row.kind === 'comment')!;
    const commentsPath = `/comments?resourceType=document&resourceId=${documentId}`;
    const comment = (await f.call<Comment[]>(commentsPath)).data.find(row => row.id === commentSource.target?.id)!;
    assert.ok(comment);
    const commentArchive = await f.call<{ trashItemId: string }>(`/comments/${comment.id}`, 'DELETE', undefined, comment.authorId);
    const attachmentArchive = await f.call<{ trashItemId: string }>(`/attachments/${removed.target.id}`, 'DELETE');
    assert.equal(commentArchive.status, 200, JSON.stringify(commentArchive.data));
    assert.equal(attachmentArchive.status, 200, JSON.stringify(attachmentArchive.data));
    const individual = await audit('?status=trashed');
    assert.deepEqual(new Set(individual.rows.map(row => row.sourceRecordId)), new Set([commentSource.sourceRecordId, removed.sourceRecordId]));
    assert.ok(individual.rows.every(row => row.target?.owner?.projectId === destination.projectId));
    assert.equal((await checkFile(removed.sourceRecordId)).status, 'verified');
    const individualContent = (await fullAudit()).targetContent;
    assert.equal(individualContent.comments.count, 1);
    const archivedComment = f.db.prepare('SELECT json FROM trash_items WHERE id=?').get(commentArchive.data.trashItemId);
    assert.ok(archivedComment && typeof archivedComment.json === 'string');
    const archivedCommentMarker = '비공개 합성 휴지통 댓글 변경';
    f.db.prepare("UPDATE trash_items SET json=json_set(json,'$.item.body',?) WHERE id=?").run(archivedCommentMarker, commentArchive.data.trashItemId);
    const changedIndividual = await fullAudit();
    assert.equal(changedIndividual.targetContent.comments.count, individualContent.comments.count);
    assert.notEqual(changedIndividual.targetContent.comments.sha256, individualContent.comments.sha256);
    assert.ok(!JSON.stringify(changedIndividual).includes(archivedCommentMarker));
    f.db.prepare('UPDATE trash_items SET json=? WHERE id=?').run(archivedComment.json, commentArchive.data.trashItemId);

    const trashed = await f.call<{ trashEntryId: string }>(`/documents/${documentId}`, 'DELETE');
    assert.equal(trashed.status, 200, JSON.stringify(trashed.data));
    const trashAudit = await audit('?status=trashed');
    assert.deepEqual(new Set(trashAudit.rows.map(row => row.sourceRecordId)), new Set([...archivedTogether, removed].map(row => row.sourceRecordId)));
    assert.equal((await audit('?status=missing')).total, 0);
    assert.deepEqual(await checkFile(older.sourceRecordId), expectedOlder);
    const fullTrash = await fullAudit();
    assert.deepEqual(fullTrash.recordCounts, trashAudit.counts);
    assert.deepEqual(fullTrash.attachmentCounts, clean.attachmentCounts);
    assert.ok([older, newer, removed].every(value => fullTrash.attachments.some(row => row.sourceRecordId === value.sourceRecordId && row.recordStatus === 'trashed' && row.status === 'verified')));
    assert.equal(fullTrash.targetContent.revisions.count, individualContent.revisions.count);
    const archivedDocument = f.db.prepare('SELECT json FROM trash_entries WHERE id=?').get(trashed.data.trashEntryId);
    assert.ok(archivedDocument && typeof archivedDocument.json === 'string');
    const archivedRevisions = (JSON.parse(archivedDocument.json) as { revisions: DocRevision[] }).revisions;
    const generatedIndex = archivedRevisions.findIndex(row => row.summary === '원본 현재 문서 이관');
    assert.notEqual(generatedIndex, -1);
    const archivedRevisionMarker = '비공개 합성 휴지통 이력 변경';
    f.db.prepare('UPDATE trash_entries SET json=json_set(json,?,?) WHERE id=?')
      .run(`$.revisions[${generatedIndex}].plainText`, archivedRevisionMarker, trashed.data.trashEntryId);
    const changedArchive = await fullAudit();
    assert.deepEqual(changedArchive.recordCounts, fullTrash.recordCounts);
    assert.equal(changedArchive.targetContent.revisions.count, fullTrash.targetContent.revisions.count);
    assert.notEqual(changedArchive.targetContent.revisions.sha256, fullTrash.targetContent.revisions.sha256);
    assert.ok(!JSON.stringify(changedArchive).includes(archivedRevisionMarker));
    f.db.prepare('UPDATE trash_entries SET json=? WHERE id=?').run(archivedDocument.json, trashed.data.trashEntryId);

    const backup = await f.call('/export');
    assert.equal(backup.status, 200);
    assert.equal((await f.call('/import', 'POST', { data: backup.data })).status, 200);
    const sameArchived = await audit('?status=trashed');
    assert.equal(sameArchived.receiptVersion, receipt.version + 1);
    assert.deepEqual(sameArchived.rows, trashAudit.rows);
    assert.deepEqual(await checkFile(older.sourceRecordId), expectedOlder);
    assert.equal((await f.call(fullPath())).status, 409);
    assert.deepEqual((await fullAudit(sameArchived.receiptVersion)).attachments, fullTrash.attachments);

    assert.equal((await f.call(`/trash/${trashed.data.trashEntryId}/restore`, 'POST')).status, 200);
    const stillArchived = await audit('?status=trashed');
    assert.deepEqual(new Set(stillArchived.rows.map(row => row.sourceRecordId)), new Set([commentSource.sourceRecordId, removed.sourceRecordId]));
    assert.equal((await f.call(`/trash/items/${commentArchive.data.trashItemId}/restore`, 'POST')).status, 200);
    assert.equal((await f.call(`/trash/items/${attachmentArchive.data.trashItemId}`, 'DELETE')).status, 200);
    assert.equal((await audit('?status=trashed')).total, 0);
    const restored = await audit();
    assert.ok(archivedTogether.every(original => restored.rows.find(row => row.sourceRecordId === original.sourceRecordId)?.status === 'linked'));
    assert.deepEqual((await f.call<Comment[]>(commentsPath)).data.find(row => row.id === comment.id), comment);
    assert.equal((await checkFile(removed.sourceRecordId)).status, 'missing');
    const trashedAgain = await f.call<{ trashEntryId: string }>(`/documents/${documentId}`, 'DELETE');
    assert.equal(trashedAgain.status, 200);
    assert.equal((await f.call(`/trash/${trashedAgain.data.trashEntryId}`, 'DELETE')).status, 200);
    assert.deepEqual(new Set((await audit('?status=missing')).rows.map(row => row.sourceRecordId)), new Set([...archivedTogether, removed].map(row => row.sourceRecordId)));
    assert.equal((await checkFile(older.sourceRecordId)).status, 'missing');
    assert.equal((await checkFile(archiveOnly.sourceRecordId)).status, 'unbound');
    assert.deepEqual((await fullAudit(restored.receiptVersion)).attachmentCounts, { ...clean.attachmentCounts, verified: 0, missing: 3 });
  } finally { await f.close(); }
});

test('receipt compares the current Jira and Confluence primary fields with their latest applied checkpoints', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const jira = await f.upload(Buffer.from('Issue id,Issue key,Project key,Summary,Description,Created,Updated,Status,Issue Type\r\n100,DRIFT-1,DRIFT,원본 티켓,원본 설명,2024-01-01T00:00:00Z,2024-01-02T00:00:00Z,Open,Task\r\n'),
    'drift.csv', 'jira', 'primary-field-jira');
  const confluence = '<hibernate-generic>' +
    '<object class="Space"><id name="id">10</id><property name="key">FIELD</property><property name="name">필드 검증 위키</property></object>' +
    '<object class="Page"><id name="id">20</id><property name="title">원본 문서</property><property name="version">1</property>' +
    '<property name="creationDate">2024-01-01T00:00:00Z</property><property name="lastModificationDate">2024-01-02T00:00:00Z</property>' +
    '<property name="space" class="Space"><id name="id">10</id></property></object>' +
    '<object class="BodyContent"><id name="id">30</id><property name="body"><![CDATA[<p>원본 본문</p>]]></property>' +
    '<property name="content" class="Page"><id name="id">20</id></property></object></hibernate-generic>';
  const wiki = await f.upload(zip([{ path: 'entities.xml', bytes: Buffer.from(confluence) }]), 'drift-wiki.zip', 'confluence', 'primary-field-wiki');
  const initial = await f.apply(await f.preview(await f.configuration([jira, wiki], 'FIELDTEST')));
  assert.equal(initial.status, 201, JSON.stringify(initial.data));
  const receipt = initial.data.import;
  const [projectId] = receipt.projectIds;
  const snapshot = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const issue = snapshot.issues.find(item => item.projectId === projectId)!;
  const page = snapshot.documents.find(item => item.projectId === projectId)!;
  assert.equal(issue.title, '원본 티켓');
  assert.equal(page.title, '원본 문서');

  async function audit(current = receipt) {
    const response = await f.call<SourceReconciliationAudit>(`/source-imports/${current.id}/reconciliation/audit?expectedVersion=${current.version}`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  }
  function fields(report: SourceReconciliationAudit, pkg: LegacyPackageSummary) {
    const proof = report.primaryRecords.find(row => row.packageId === pkg.id)?.fields;
    assert.ok(proof);
    assert.match(proof.sha256, /^[a-f\d]{64}$/u);
    return proof;
  }
  const noFields = { matched: 0, changed: 0, unavailable: 0, invalid: 0 };
  const matched = { ...noFields, matched: 1 };
  const changed = { ...noFields, changed: 1 };
  const before = await audit();
  assert.equal(before.integrity.status, 'verified');
  assert.deepEqual(fields(before, jira).counts, {
    title: matched, description: matched, type: matched, status: matched, priority: matched, assigneeId: matched, reporterId: noFields,
    labels: matched, startDate: matched, endDate: matched, dueDate: matched, estimate: matched, plannedEffortMinutes: noFields,
  });
  assert.deepEqual(fields(before, wiki).counts, { title: matched, content: matched, labels: matched });

  const delta = await f.upload(Buffer.from('Issue id,Issue key,Project key,Summary,Created,Updated,Status,Issue Type\r\n100,DRIFT-1,DRIFT,새 원본 제목,2024-01-01T00:00:00Z,2024-02-02T00:00:00Z,Open,Task\r\n'),
    'drift-delta.csv', 'jira', 'primary-field-jira');
  const { data: options } = await f.call<MigrationOptions>(`/migrations/options?packageId=${delta.id}`);
  const target = options.appendTarget;
  assert.ok(target);
  assert.equal(target.projectId, projectId);
  const followUp = await f.apply(await f.preview({ ...options.defaultConfiguration,
    appendTo: { projectId, refreshExisting: true,
      statuses: Object.fromEntries(options.statuses.map(option => [option.id, target.statuses.find(status => status.label === option.label)!.id])),
      issueTypes: Object.fromEntries(options.issueTypes.map(option => [option.id, target.issueTypes.find(type => type.name === option.label)!.id])), fields: {},
    },
  }));
  assert.equal(followUp.status, 201, JSON.stringify(followUp.data));
  const updated = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const currentIssue = updated.issues.find(item => item.id === issue.id);
  assert.ok(currentIssue);
  assert.equal(currentIssue.title, '새 원본 제목');
  assert.equal(currentIssue.description, issue.description);
  const refreshed = await audit();
  assert.deepEqual(fields(refreshed, jira).counts.title, matched);
  assert.notEqual(fields(refreshed, jira).sha256, fields(before, jira).sha256);

  // A later historical checkpoint that omits an unchanged field still has the earlier proven value.
  const checkpoint = f.db.prepare(`UPDATE source_records SET json=json_remove(json,'$.jiraIssueFieldHashes.description')
    WHERE import_id=? AND target_id=? AND kind='issue' AND json_type(json,'$.jiraIssueFieldHashes.description')='text'`)
    .run(followUp.data.import.id, issue.id);
  assert.equal(checkpoint.changes, 1);
  assert.deepEqual(fields(await audit(), jira).counts.description, matched);

  const localIssue = await f.call<Issue>(`/issues/${issue.id}`, 'PATCH', {
    expectedVersion: currentIssue.version, description: '**팀 수정 설명**', descriptionFormat: 'markdown', plannedEffortMinutes: 45,
  });
  assert.equal(localIssue.status, 200, JSON.stringify(localIssue.data));
  const localPage = await f.call<DocPage>(`/documents/${page.id}`, 'PATCH', { expectedVersion: page.version,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '팀 수정 문서 본문' }] }] },
  });
  assert.equal(localPage.status, 200, JSON.stringify(localPage.data));
  const drift = await audit();
  assert.equal(drift.integrity.status, 'verified');
  assert.deepEqual(fields(drift, jira).counts.title, matched);
  assert.deepEqual(fields(drift, jira).counts.description, changed);
  assert.deepEqual(fields(drift, jira).counts.plannedEffortMinutes, { ...noFields, unavailable: 1 });
  assert.deepEqual(fields(drift, wiki).counts, { title: matched, content: changed, labels: matched });
  assert.doesNotMatch(JSON.stringify(drift.primaryRecords), /팀 수정|원본 문서|DRIFT-1/u);

  async function finding(pkg: LegacyPackageSummary, field: string, finding: string, status = 200) {
    const params = new URLSearchParams({ packageId: pkg.id, field, finding });
    const response = await f.call<SourceReconciliationPage>(`/source-imports/${receipt.id}/reconciliation?${params}`);
    assert.equal(response.status, status, JSON.stringify(response.data));
    return response.data;
  }
  const found = await finding(jira, 'description', 'changed-field');
  assert.equal(found.total, 1);
  assert.equal(found.rows[0].target?.id, issue.id);
  assert.deepEqual(found.rows[0].fieldComparison, { field: 'description', status: 'changed' });
  assert.equal((await finding(jira, 'plannedEffortMinutes', 'unavailable-field')).rows[0].target?.id, issue.id);
  assert.equal((await finding(jira, 'title', 'changed-field')).total, 0);
  await finding(jira, 'content', 'changed-field', 400);
  await finding(wiki, 'parentId', 'changed-field', 400);

  f.db.prepare("UPDATE issues SET json=json_set(json,'$.title',123) WHERE id=?").run(issue.id);
  assert.deepEqual(fields(await audit(), jira).counts.title, { ...noFields, invalid: 1 });
  assert.equal((await finding(jira, 'title', 'invalid-field')).rows[0].target?.id, issue.id);
  f.db.prepare("UPDATE issues SET json=json_set(json,'$.title',?) WHERE id=?").run(currentIssue.title, issue.id);

  const archived = await f.call(`/documents/${page.id}?expectedVersion=${localPage.data.version}`, 'DELETE');
  assert.equal(archived.status, 200, JSON.stringify(archived.data));
  assert.deepEqual(fields(await audit(), wiki).counts.content, changed);
  const archivedFinding = (await finding(wiki, 'content', 'changed-field')).rows[0];
  assert.deepEqual([archivedFinding.status, archivedFinding.target?.id, archivedFinding.fieldComparison?.status], ['trashed', page.id, 'changed']);
});

test('receipt audits the current Jira and Confluence hierarchy with the latest applied parent evidence', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const created = '2020-01-01T00:00:00Z';
  const original = '2020-01-02T00:00:00Z';
  const newer = '2020-01-03T00:00:00Z';
  const jiraRows = [[101, null], [102, null], [103, 101]] as const;
  const wikiRows = [[201, null], [202, null], [203, 201]] as const;
  type Placement = readonly [id: number, parent: number | null];
  const jiraTitle = (id: number) => `Imported Jira hierarchy ${id}`;
  const wikiTitle = (id: number) => `Imported Confluence hierarchy ${id}`;
  const uploadJira = (name: string, updated: string, rows: readonly Placement[]) => f.upload(Buffer.from(JSON.stringify({
    issues: rows.map(([id, parent]) => ({ id: String(id), key: `TREE-${id}`, changelog: { histories: [] }, fields: {
      project: { id: '42', key: 'TREE', name: 'Synthetic Jira hierarchy' }, summary: jiraTitle(id),
      created, updated, status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
      parent: parent === null ? null : { id: String(parent), key: `TREE-${parent}` },
    } })),
  })), `${name}.json`, 'jira', 'synthetic-hierarchy-jira');
  const uploadWiki = (name: string, updated: string, version: number, rows: readonly Placement[]) => {
    const xml = `<hibernate-generic>
      <object class="Space"><id name="id">55</id><property name="key">HTREE</property><property name="name">Synthetic Confluence hierarchy</property></object>
      ${rows.map(([id, parent]) => `
        <object class="Page"><id name="id">${id}</id><property name="title">${wikiTitle(id)}</property>
          <property name="version">${version}</property><property name="creationDate">${created}</property>
          <property name="lastModificationDate">${updated}</property><property name="space" class="Space"><id name="id">55</id></property>
          ${parent === null ? '' : `<property name="parent" class="Page"><id name="id">${parent}</id></property>`}</object>
        <object class="BodyContent"><id name="id">${id + 300}</id><property name="body"><![CDATA[<p>${wikiTitle(id)}</p>]]></property>
          <property name="content" class="Page"><id name="id">${id}</id></property></object>`).join('')}
    </hibernate-generic>`;
    return f.upload(zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]), `${name}.zip`, 'confluence', 'synthetic-hierarchy-confluence');
  };
  async function apply(configuration: MigrationConfiguration) {
    const preview = await f.preview(configuration);
    assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
    const response = await f.apply(preview);
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data.import;
  }

  const jira = await uploadJira('jira-hierarchy', original, jiraRows);
  const wiki = await uploadWiki('confluence-hierarchy', original, 1, wikiRows);
  const receipt = await apply(await f.configuration([jira, wiki], 'HIERAUD'));
  const [projectId] = receipt.projectIds;
  const initial = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const findTarget = (rows: (Issue | DocPage)[], title: string) => {
    const target = rows.find(row => row.projectId === projectId && row.title === title);
    assert.ok(target, title);
    return target;
  };
  const cases = [
    { pkg: jira, collection: 'issues', sourceId: '103', root: findTarget(initial.issues, jiraTitle(101)),
      other: findTarget(initial.issues, jiraTitle(102)), child: findTarget(initial.issues, jiraTitle(103)) },
    { pkg: wiki, collection: 'documents', sourceId: '203', root: findTarget(initial.documents, wikiTitle(201)),
      other: findTarget(initial.documents, wikiTitle(202)), child: findTarget(initial.documents, wikiTitle(203)) },
  ] as const;

  async function audit(current = receipt) {
    const result = await f.call<SourceReconciliationAudit>(`/source-imports/${current.id}/reconciliation/audit?expectedVersion=${current.version}`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  function hierarchy(report: SourceReconciliationAudit, pkg: LegacyPackageSummary, counts: { matched: number; changed: number; invalid: number }) {
    const row = report.primaryRecords.find(record => record.packageId === pkg.id);
    assert.ok(row?.hierarchy, pkg.filename);
    const { sha256, ...observed } = row.hierarchy;
    assert.match(sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(observed, { unavailable: 0, ...counts }, pkg.filename);
    return sha256;
  }
  async function finding(pkg: LegacyPackageSummary, kind: 'changed-parent' | 'invalid-parent', expected: string[]) {
    const query = new URLSearchParams({ packageId: pkg.id, finding: kind, limit: '1' });
    const result = await f.call<SourceReconciliationPage>(`/source-imports/${receipt.id}/reconciliation?${query}`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.total, expected.length);
    assert.deepEqual(result.data.rows.map(row => row.sourceId), expected);
    return result.data.rows[0];
  }

  const matched = { matched: 3, changed: 0, invalid: 0 };
  const clean = await audit();
  for (const { pkg, root, other, child } of cases) {
    assert.equal(root.parentId, null);
    assert.equal(other.parentId, null);
    assert.equal(child.parentId, root.id);
    hierarchy(clean, pkg, matched);
    await finding(pkg, 'changed-parent', []);
    await finding(pkg, 'invalid-parent', []);
  }
  const move = async ({ collection, child }: typeof cases[number], version: number, parentId: string) => {
    const result = await f.call<Issue | DocPage>(`/${collection}/${child.id}`, 'PATCH', { expectedVersion: version, parentId });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.parentId, parentId);
    return result.data;
  };
  const moved = [];
  for (const item of cases) moved.push(await move(item, item.child.version, item.other.id));
  const edited = await audit();
  assert.equal(edited.receiptVersion, receipt.version);
  assert.equal(edited.integrity.status, 'verified');
  assert.deepEqual(edited.recordCounts, clean.recordCounts);
  for (const [index, item] of cases.entries()) {
    const { pkg, sourceId, root, child } = item;
    assert.notEqual(hierarchy(edited, pkg, { matched: 2, changed: 1, invalid: 0 }), hierarchy(clean, pkg, matched));
    const changed = await finding(pkg, 'changed-parent', [sourceId]);
    assert.deepEqual([changed.status, changed.target?.id], ['linked', child.id]);
    await finding(pkg, 'invalid-parent', []);
    await move(item, moved[index].version, root.id);
  }

  const restored = await audit();
  for (const { pkg, collection, root, other, child, sourceId } of cases) {
    const changeColumn = f.db.prepare(`UPDATE ${collection} SET parent_id=? WHERE id=?`);
    assert.equal(changeColumn.run(other.id, child.id).changes, 1);
    const corrupt = await audit();
    assert.notEqual(hierarchy(corrupt, pkg, { matched: 2, changed: 0, invalid: 1 }), hierarchy(restored, pkg, matched));
    const invalid = await finding(pkg, 'invalid-parent', [sourceId]);
    assert.deepEqual([invalid.status, invalid.target?.id], ['linked', child.id]);
    await finding(pkg, 'changed-parent', []);
    assert.equal(changeColumn.run(root.id, child.id).changes, 1);
  }

  const jiraUpdate = await uploadJira('jira-hierarchy-update', newer, [[103, 102]]);
  const { status, data: options } = await f.call<MigrationOptions>(`/migrations/options?packageId=${jiraUpdate.id}`);
  assert.equal(status, 200);
  const target = options.appendTarget;
  assert.equal(target?.projectId, projectId);
  assert.ok(target);
  const jiraReceipt = await apply({ ...options.defaultConfiguration, appendTo: { projectId, refreshExisting: true,
    statuses: Object.fromEntries(options.statuses.map(value => [value.id, target.statuses.find(state => state.label === value.label)!.id])),
    issueTypes: Object.fromEntries(options.issueTypes.map(value => [value.id, target.issueTypes.find(type => type.name === value.label)!.id])),
    fields: {},
  } });
  const wikiUpdate = await uploadWiki('confluence-hierarchy-update', newer, 2, [[203, 202]]);
  const wikiReceipt = await apply({ ...await f.configuration(wikiUpdate), appendPagesTo: { projectId, refreshExisting: true } });
  const updated = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const superseded = await audit();
  for (const { pkg, collection, child, other } of cases) {
    assert.equal(updated[collection].find(row => row.id === child.id)?.parentId, other.id);
    hierarchy(superseded, pkg, matched);
    await finding(pkg, 'changed-parent', []);
  }
  hierarchy(await audit(jiraReceipt), jiraUpdate, { ...matched, matched: 1 });
  hierarchy(await audit(wikiReceipt), wikiUpdate, { ...matched, matched: 1 });
  const wikiChild = cases[1].child;
  const trashed = await f.call(`/documents/${wikiChild.id}`, 'DELETE');
  assert.equal(trashed.status, 200, JSON.stringify(trashed.data));
  hierarchy(await audit(), wiki, matched);
  hierarchy(await audit(wikiReceipt), wikiUpdate, { ...matched, matched: 1 });
  const wikiParent = updated.documents.find(document => document.id === cases[1].other.id)!;
  const destination = updated.projects.find(project => project.id !== projectId)!;
  const movedParent = await f.call<DocPage>(`/documents/${wikiParent.id}`, 'PATCH', {
    expectedVersion: wikiParent.version, projectId: destination.id,
  });
  assert.equal(movedParent.status, 200, JSON.stringify(movedParent.data));
  assert.equal(movedParent.data.projectId, destination.id);
  hierarchy(await audit(), wiki, matched);
  hierarchy(await audit(wikiReceipt), wikiUpdate, { ...matched, matched: 1 });
  await finding(wiki, 'invalid-parent', []);
});

test('whole-receipt audit detects changed migrated target data with identical counts and versions', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const date = '2020-08-01T00:00:00Z';
  const author = { accountId: 'receipt-test-author', displayName: '합성 작성자' };
  const issueFields = {
    project: { id: '42', key: 'OLD', name: '이전 Jira' }, created: date, updated: date,
    issuetype: { id: '3', name: 'Task' }, status: { id: '1', name: 'Open' },
  };
  const jira = await f.upload(Buffer.from(JSON.stringify({ issues: [
    { id: '101', key: 'OLD-1', fields: { ...issueFields, summary: '합성 검증 티켓',
      comment: { comments: [{ id: '310', body: '검증 대상 원본 댓글', author, created: date }] },
      worklog: { worklogs: [{ id: '410', comment: '검증 대상 원본 작업 시간', author, started: date, timeSpentSeconds: 91 }] },
      issuelinks: [{ id: '510', type: { id: '1', name: 'Blocks' }, outwardIssue: { id: '102', key: 'OLD-2' } }],
    } },
    { id: '102', key: 'OLD-2', fields: { ...issueFields, summary: '합성 연결 티켓' } },
  ] })), 'target-evidence-jira.json', 'jira');
  const wiki = await f.upload(confluence(true).bytes, 'target-evidence-wiki.zip', 'confluence');
  const configuration = await f.configuration([jira, wiki], 'AUDIT');
  configuration.excludedRecords = [`${wiki.id}/attachment:704`];
  const preview = await f.preview(configuration);
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  const applied = await f.apply(preview);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const receipt = applied.data.import;
  const reconciliation = `/source-imports/${receipt.id}/reconciliation`;
  const auditPath = `${reconciliation}/audit?expectedVersion=${receipt.version}`;
  async function audit() {
    const response = await f.call<SourceReconciliationAudit>(auditPath);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  }
  const rows = (await f.call<SourceReconciliationPage>(`${reconciliation}?limit=100`)).data.rows;
  const comment = rows.find(row => row.kind === 'comment' && row.product === 'jira')?.target;
  const revision = rows.find(row => row.kind === 'revision')?.target;
  const issueRow = rows.find(row => row.kind === 'issue' && row.sourceKey === 'OLD-1');
  const issue = issueRow?.target;
  const otherIssue = rows.find(row => row.kind === 'issue' && row.sourceKey === 'OLD-2')?.target;
  assert.ok(comment && revision?.owner && issueRow && issue && otherIssue);
  const worklogPath = `/issues/${issue.id}/worklogs`;
  const worklog = (await f.call<IssueWorklogPage>(worklogPath)).data.entries[0];
  assert.equal(worklog?.durationSeconds, 91);
  const relation = f.db.prepare('SELECT id FROM issue_relations WHERE source_issue_id=? AND target_issue_id=?').get(issue.id, otherIssue.id);
  assert.ok(relation && typeof relation.id === 'string');

  const clean = await audit();
  const primary = (report: SourceReconciliationAudit, pkg: LegacyPackageSummary) => {
    const result = report.primaryRecords.find(row => row.packageId === pkg.id);
    assert.ok(result);
    return result;
  };
  const originalIssueDisposition = primary(clean, jira);
  assert.deepEqual(originalIssueDisposition.counts, { linked: 2, trashed: 0, missing: 0, 'archive-only': 0, excluded: 0 });
  assert.equal(originalIssueDisposition.invalidTargets, 0);
  const updatePrimaryBinding = f.db.prepare('UPDATE source_records SET target_type=?,target_id=? WHERE id=?');
  const changeIssueBinding = (target: { type: string; id: string }) =>
    assert.equal(updatePrimaryBinding.run(target.type, target.id, issueRow.sourceRecordId).changes, 1);
  changeIssueBinding(otherIssue);
  const rebound = await audit();
  assert.deepEqual(primary(rebound, jira).counts, originalIssueDisposition.counts);
  assert.equal(rebound.integrity.status, 'mismatch');
  assert.equal(rebound.integrity.columnMismatches, clean.integrity.columnMismatches + 1);
  assert.equal(primary(rebound, jira).invalidTargets, 0);
  assert.notEqual(primary(rebound, jira).dispositionSha256, originalIssueDisposition.dispositionSha256);
  assert.deepEqual(primary(rebound, wiki), primary(clean, wiki));
  changeIssueBinding(revision.owner);
  const wrongType = primary(await audit(), jira);
  assert.deepEqual(wrongType.counts, originalIssueDisposition.counts);
  assert.equal(wrongType.invalidTargets, 1);
  assert.notEqual(wrongType.dispositionSha256, originalIssueDisposition.dispositionSha256);
  changeIssueBinding(issue);
  const originalDocumentScope = revision.owner.projectId;
  const otherScope = f.db.prepare('SELECT id FROM projects WHERE id<>? ORDER BY id LIMIT 1').get(originalDocumentScope);
  assert.ok(originalDocumentScope && typeof otherScope?.id === 'string');
  const changeDocumentScope = f.db.prepare('UPDATE documents SET project_id=? WHERE id=?');
  assert.equal(changeDocumentScope.run(otherScope.id, revision.owner.id).changes, 1);
  const movedDocument = await audit();
  assert.deepEqual(primary(movedDocument, wiki).counts, primary(clean, wiki).counts);
  assert.notEqual(primary(movedDocument, wiki).dispositionSha256, primary(clean, wiki).dispositionSha256);
  assert.deepEqual(primary(movedDocument, jira), primary(clean, jira));
  assert.equal(changeDocumentScope.run(originalDocumentScope, revision.owner.id).changes, 1);
  assert.deepEqual((await audit()).primaryRecords, clean.primaryRecords);

  assert.equal(clean.targetContent.version, 1);
  const sections = ['comments', 'revisions', 'worklogs', 'issueRelations'] as const;
  const expectedCounts = [2, 2, 1, 1];
  assert.deepEqual(sections.map(section => clean.targetContent[section].count), expectedCounts);
  for (const section of sections) assert.match(clean.targetContent[section].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual((await audit()).targetContent, clean.targetContent);
  assert.doesNotMatch(JSON.stringify(clean.targetContent), /검증 대상 원본 댓글|검증 대상 원본 작업 시간|보존한 원본 댓글|보존한 이전 본문|receipt-test-author/);

  const marker = 'API 응답에 포함하지 않는 합성 변경값';
  const revisionRow = f.db.prepare('SELECT json FROM revisions WHERE id=?').get(revision.id);
  assert.ok(revisionRow && typeof revisionRow.json === 'string');
  const revisionAuthor = (JSON.parse(revisionRow.json) as DocRevision).authorId;
  const alternativeAuthor = revisionAuthor === 'user-jun' ? 'user-seo' : 'user-jun';
  const generatedRevision = f.db.prepare('SELECT id FROM revisions WHERE document_id=? AND id<>?').get(revision.owner.id, revision.id);
  assert.ok(generatedRevision && typeof generatedRevision.id === 'string');
  const mutations = [
    ['comments', 'comments', comment.id, '$.body', marker],
    ['revisions', 'revisions', revision.id, '$.authorId', alternativeAuthor],
    ['revisions', 'revisions', generatedRevision.id, '$.plainText', marker],
    ['worklogs', 'worklogs', worklog.id, '$.durationSeconds', 92],
    ['issueRelations', 'issue_relations', relation.id, '$.type', 'duplicates'],
  ] as const;
  for (const [section, table, id, path, value] of mutations) {
    const original = f.db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id);
    assert.ok(original && typeof original.json === 'string');
    assert.equal(f.db.prepare(`UPDATE ${table} SET json=json_set(json,?,?) WHERE id=?`).run(path, value, id).changes, 1);
    const altered = await audit();
    assert.deepEqual(altered.recordCounts, clean.recordCounts);
    assert.deepEqual(altered.integrity, clean.integrity);
    assert.deepEqual(altered.attachmentCounts, clean.attachmentCounts);
    assert.deepEqual(sections.map(name => altered.targetContent[name].count), expectedCounts);
    assert.deepEqual(sections.filter(name => altered.targetContent[name].sha256 !== clean.targetContent[name].sha256), [section]);
    assert.ok(!JSON.stringify(altered).includes(marker));
    assert.equal(f.db.prepare(`UPDATE ${table} SET json=? WHERE id=?`).run(original.json, id).changes, 1);
  }
  assert.deepEqual((await audit()).targetContent, clean.targetContent);

  const open = fileSystem.open;
  let changedDuringFileScan = false;
  const concurrentChange = t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof open>) => {
    if (!changedDuringFileScan && String(args[0]).startsWith(join(f.dir, 'uploads'))) {
      changedDuringFileScan = true;
      assert.equal(f.db.prepare("UPDATE worklogs SET json=json_set(json,'$.durationSeconds',92) WHERE id=?").run(worklog.id).changes, 1);
    }
    return open(...args);
  });
  try {
    assert.equal((await f.call(auditPath)).status, 409);
    assert.equal(changedDuringFileScan, true);
  } finally { concurrentChange.mock.restore(); }

  assert.equal((await f.call(`${worklogPath}/${worklog.id}`, 'DELETE', { expectedVersion: worklog.version }, worklog.authorId)).status, 200);
  const deletedWorklog = await audit();
  assert.equal(deletedWorklog.targetContent.worklogs.count, 1, 'the deleted migrated worklog retains a stored record');
  assert.notEqual(deletedWorklog.targetContent.worklogs.sha256, clean.targetContent.worklogs.sha256);
  f.db.prepare("UPDATE worklogs SET json=json_set(json,'$.note',?) WHERE id=?").run(marker, worklog.id);
  const alteredDeletedWorklog = await audit();
  assert.equal(alteredDeletedWorklog.targetContent.worklogs.count, 1);
  assert.notEqual(alteredDeletedWorklog.targetContent.worklogs.sha256, deletedWorklog.targetContent.worklogs.sha256);
  assert.ok(!JSON.stringify(alteredDeletedWorklog).includes(marker));
});

test('retained source verification distinguishes archival loss from deleted live targets and intentional exclusions', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const jira = await f.upload(csv, 'integrity-jira.csv', 'jira');
  const wiki = await f.upload(confluence(true).bytes, 'integrity-confluence.zip', 'confluence');
  const linkedWiki = await f.upload(confluence().bytes, 'integrity-linked-confluence.zip', 'confluence');
  const additionalJira = await f.upload(jiraGitlabCsv([['311', 'AUXILIARY-1', 'Additional archived ticket', 'Open']]),
    jira.filename, 'jira', jira.source.instanceKey);
  const packages = [jira, wiki, linkedWiki, additionalJira];
  const config = await f.configuration(packages);
  config.excludedRecords = [`${wiki.id}/page:100`];
  const preview = await f.preview(config);
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  assert.equal(preview.counts.explicitExcludedRecords, 1);
  assert.ok(preview.counts.excludedDescendants > 0);
  const applied = await f.apply(preview);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const receipt = applied.data.import;
  const reconciliationPath = `/source-imports/${receipt.id}/reconciliation`;
  const manifest = receipt.integrity;
  assert.ok(manifest);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.packages.length, packages.length);

  async function audit(service = f) {
    const receipts = await service.call<SourceImport[]>('/source-imports');
    assert.equal(receipts.status, 200);
    const current = receipts.data.find(value => value.id === receipt.id);
    assert.ok(current);
    const response = await service.call<SourceReconciliationAudit>(`${reconciliationPath}/audit?expectedVersion=${current.version}`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.receiptVersion, current.version);
    return response.data;
  }
  function packageIntegrity(report: SourceReconciliationAudit, pkg: LegacyPackageSummary) {
    const inventory = report.integrity.packages.find(value => value.stagingId === pkg.id);
    assert.ok(inventory);
    assert.equal(inventory.filename, pkg.filename);
    return inventory;
  }
  async function scoped(pkg: LegacyPackageSummary, conditions: Record<string, string> = {}, service = f) {
    const params = new URLSearchParams({ packageId: pkg.id, ...conditions });
    const response = await service.call<SourceReconciliationPage>(`${reconciliationPath}?${params}`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  }

  const page = await f.call<SourceReconciliationPage>(`${reconciliationPath}?limit=100`);
  assert.equal(page.status, 200);
  const jiraIssue = page.data.rows.find(value => value.product === 'jira' && value.sourceKey === 'OLD-1');
  const identity = page.data.rows.find(value => value.product === 'jira' && value.kind === 'identity');
  assert.ok(jiraIssue?.target && identity);
  assert.equal(identity.status, 'archive-only');
  const confluenceRows = page.data.rows.filter(value => value.sourceInstance === wiki.source.instanceKey && value.kind !== 'project');
  assert.ok(confluenceRows.some(value => value.kind === 'revision'));
  assert.ok(confluenceRows.some(value => value.kind === 'comment'));
  assert.ok(confluenceRows.some(value => value.kind === 'attachment'));
  assert.equal(confluenceRows.length, preview.counts.excludedRecords);
  assert.ok(confluenceRows.every(value => value.status === 'excluded' && value.target === null));
  const clean = await audit();
  const primary = (report: SourceReconciliationAudit, pkg: LegacyPackageSummary) => {
    const result = report.primaryRecords.find(row => row.packageId === pkg.id);
    assert.ok(result);
    return result;
  };
  const noPrimaryRows = { linked: 0, trashed: 0, missing: 0, 'archive-only': 0, excluded: 0 };
  assert.deepEqual(clean.primaryRecords.map(({ packageId }) => packageId), packages.map(({ id }) => id));
  assert.deepEqual(primary(clean, jira).counts, { ...noPrimaryRows, linked: 2 });
  assert.deepEqual(primary(clean, wiki).counts, { ...noPrimaryRows, excluded: 1 });
  assert.deepEqual(primary(clean, linkedWiki).counts, { ...noPrimaryRows, linked: 1 });
  assert.deepEqual(primary(clean, additionalJira).counts, { ...noPrimaryRows, linked: 1 });
  assert.deepEqual(clean.primaryRecords.map(({ kind }) => kind), ['issue', 'page', 'page', 'issue']);
  assert.equal(jira.filename, additionalJira.filename);
  const firstIssuePage = await scoped(jira, { kind: 'issue', status: 'linked', limit: '1' });
  const secondIssuePage = await scoped(jira, { kind: 'issue', status: 'linked', offset: '1', limit: '1' });
  assert.equal(firstIssuePage.total, 2);
  assert.equal(secondIssuePage.total, 2);
  assert.deepEqual(new Set([...firstIssuePage.rows, ...secondIssuePage.rows].map(row => row.sourceKey)), new Set(['OLD-1', 'OTHER-1']));
  assert.equal(Object.values(firstIssuePage.counts).reduce((sum, value) => sum + value, 0), packageIntegrity(clean, jira).records.observed);
  assert.deepEqual((await scoped(additionalJira, { kind: 'issue', q: 'additional archived ticket' })).rows.map(row => row.sourceKey), ['AUXILIARY-1']);
  assert.equal((await scoped(additionalJira, { kind: 'issue', q: 'OLD-1' })).total, 0);
  assert.equal((await scoped(linkedWiki, { kind: 'page', status: 'excluded' })).total, 0);
  assert.equal((await scoped(wiki, { kind: 'page', status: 'excluded' })).total, 1);
  for (const [query, status] of [
    ['packageId=', 400], ['packageId=%00', 400], [`packageId=${jira.id}&packageId=${wiki.id}`, 400],
    [`packageId=${randomUUID()}`, 404], [`packageId=${jira.sha256}`, 404],
    ['finding=invalid-primary-target', 400], [`packageId=${jira.id}&finding=unknown`, 400],
  ] as const) assert.equal((await f.call(`${reconciliationPath}?${query}`)).status, status, query);
  for (const row of clean.primaryRecords) {
    assert.equal(row.invalidTargets, 0);
    assert.match(row.dispositionSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(row).sort(), ['counts', 'dispositionSha256', 'fields', 'hierarchy', 'invalidTargets', 'kind', 'packageId']);
    assert.ok(row.fields);
    assert.match(row.fields.sha256, /^[a-f0-9]{64}$/);
  }
  assert.doesNotMatch(JSON.stringify(clean.primaryRecords), /OLD-1|Synthetic versioned page|original\.author/);
  assert.deepEqual(clean.recordCounts, page.data.counts);
  assert.equal(clean.attachmentCounts.excluded, confluenceRows.filter(value => value.kind === 'attachment').length);
  assert.equal(clean.attachmentCounts.verified, 2);
  assert.equal(clean.attachmentCounts.unbound, 0);
  assert.equal(clean.recordCounts.missing, 0);
  assert.equal(clean.integrity.status, 'verified');
  assert.deepEqual(clean.integrity.records, { expected: receipt.counts.sourceRecords, observed: receipt.counts.sourceRecords });
  assert.deepEqual(clean.integrity.boundAttachments, { expected: 2, observed: 2 });
  assert.equal(clean.integrity.unmatchedRecords, 0);
  assert.equal(clean.integrity.columnMismatches, 0);
  for (const pkg of packages) {
    const expected: SourceImportIntegrityPackage | undefined = manifest.packages.find(value => value.stagingId === pkg.id);
    assert.ok(expected);
    assert.match(expected.recordsSha256, /^[a-f\d]{64}$/);
    const current = packageIntegrity(clean, pkg);
    assert.equal(current.status, 'verified');
    assert.deepEqual(current.recordsSha256, { expected: expected.recordsSha256, observed: expected.recordsSha256 });
    assert.deepEqual(current.records, { expected: expected.recordCount, observed: expected.recordCount });
    assert.deepEqual(current.boundAttachments, { expected: expected.boundAttachmentCount, observed: expected.boundAttachmentCount });
  }

  const additionalIssue = page.data.rows.find(row => row.sourceKey === 'AUXILIARY-1');
  assert.ok(additionalIssue);
  const changePackageSha = f.db.prepare("UPDATE source_records SET json=json_set(json,'$.packageSha256',?) WHERE id=?");
  assert.equal(changePackageSha.run('0'.repeat(64), additionalIssue.sourceRecordId).changes, 1);
  const unknownPackage = await audit();
  assert.equal(unknownPackage.integrity.status, 'mismatch');
  assert.equal(unknownPackage.integrity.unmatchedRecords, 1);
  assert.deepEqual(primary(unknownPackage, additionalJira).counts, noPrimaryRows);
  assert.equal((await scoped(additionalJira, { kind: 'issue' })).total, 0);
  assert.equal((await scoped(jira, { kind: 'issue' })).total, 2);
  assert.notEqual(primary(unknownPackage, additionalJira).dispositionSha256, primary(clean, additionalJira).dispositionSha256);
  assert.deepEqual(primary(unknownPackage, jira), primary(clean, jira));
  assert.equal(changePackageSha.run(additionalJira.sha256, additionalIssue.sourceRecordId).changes, 1);
  assert.deepEqual((await audit()).primaryRecords, clean.primaryRecords);

  const excludedPage = confluenceRows.find(row => row.kind === 'page');
  assert.ok(excludedPage);
  const changeExcludedBinding = f.db.prepare('UPDATE source_records SET target_type=?,target_id=? WHERE id=?');
  assert.equal(changeExcludedBinding.run('issue', jiraIssue.target.id, excludedPage.sourceRecordId).changes, 1);
  const invalidExcluded = primary(await audit(), wiki);
  assert.deepEqual(invalidExcluded.counts, primary(clean, wiki).counts);
  assert.equal(invalidExcluded.invalidTargets, 1);
  const flagged = await scoped(wiki, { finding: 'invalid-primary-target' });
  assert.deepEqual(flagged.rows.map(row => [row.sourceRecordId, row.status, row.invalidPrimaryTarget, row.target]),
    [[excludedPage.sourceRecordId, 'excluded', true, null]]);
  assert.equal((await scoped(linkedWiki, { finding: 'invalid-primary-target' })).total, 0);
  assert.equal((await scoped(wiki, { kind: 'attachment', finding: 'invalid-primary-target' })).total, 0);
  assert.notEqual(invalidExcluded.dispositionSha256, primary(clean, wiki).dispositionSha256);
  assert.equal(changeExcludedBinding.run(null, null, excludedPage.sourceRecordId).changes, 1);

  const trashed = await f.call<{ trashEntryId: string }>(`/issues/${jiraIssue.target.id}`, 'DELETE');
  assert.equal(trashed.status, 200, JSON.stringify(trashed.data));
  const whileTrashed = await audit();
  assert.equal(whileTrashed.recordCounts.trashed, clean.recordCounts.trashed + 2, 'The ticket and its migrated comment are both still available in trash.');
  assert.deepEqual(primary(whileTrashed, jira).counts, { ...noPrimaryRows, linked: 1, trashed: 1 });
  assert.equal(primary(whileTrashed, jira).invalidTargets, 0);
  assert.deepEqual((await scoped(jira, { kind: 'issue', status: 'trashed' })).rows.map(row => row.sourceRecordId), [jiraIssue.sourceRecordId]);
  assert.equal((await f.call(`/trash/${trashed.data.trashEntryId}`, 'DELETE')).status, 200);
  const afterPurge = await audit();
  assert.equal(afterPurge.recordCounts.missing, clean.recordCounts.missing + 2);
  assert.equal(afterPurge.recordCounts.excluded, clean.recordCounts.excluded);
  assert.deepEqual(afterPurge.integrity, clean.integrity);
  assert.deepEqual(primary(afterPurge, jira).counts, { ...noPrimaryRows, linked: 1, missing: 1 });
  assert.equal(primary(afterPurge, jira).invalidTargets, 0);
  assert.notEqual(primary(afterPurge, jira).dispositionSha256, primary(whileTrashed, jira).dispositionSha256);

  const backup = await f.call<WorkspaceSnapshot & { schemaVersion: number; sourceImports: SourceImport[]; sourceRecords: SourceRecordArchive[] }>('/export');
  assert.equal(backup.status, 200);
  assert.equal(backup.data.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const archivedIssueRecord = backup.data.sourceRecords.find(value => value.id === jiraIssue.sourceRecordId);
  assert.ok(archivedIssueRecord?.record.text);
  const updateColumn = f.db.prepare('UPDATE source_records SET source_id=? WHERE id=?');
  assert.equal(updateColumn.run('incorrect-index-value', archivedIssueRecord.id).changes, 1);
  const inconsistentIndex = await audit();
  assert.equal(inconsistentIndex.integrity.status, 'mismatch');
  assert.equal(inconsistentIndex.integrity.columnMismatches, 1);
  assert.deepEqual(packageIntegrity(inconsistentIndex, jira), packageIntegrity(clean, jira));
  assert.equal(updateColumn.run(archivedIssueRecord.record.sourceId, archivedIssueRecord.id).changes, 1);

  const privateMarker = '외부에 내보내지 않는 변형 원문';
  const updateBody = f.db.prepare("UPDATE source_records SET json=json_set(json,'$.record.text',?) WHERE id=?");
  const open = fileSystem.open;
  let changedDuringAudit = false;
  const mutateOnFileRead = t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof open>) => {
    if (!changedDuringAudit) {
      changedDuringAudit = true;
      assert.equal(updateBody.run(privateMarker, archivedIssueRecord.id).changes, 1);
    }
    return open(...args);
  });
  try {
    assert.equal((await f.call(`${reconciliationPath}/audit?expectedVersion=${receipt.version}`)).status, 409);
    assert.equal(changedDuringAudit, true);
  } finally { mutateOnFileRead.mock.restore(); }
  const sameCount = await audit();
  assert.deepEqual(sameCount.recordCounts, afterPurge.recordCounts, 'Changing an archived body has no effect on link and trash classifications.');
  assert.doesNotMatch(JSON.stringify(sameCount), new RegExp(privateMarker));
  assert.equal(sameCount.integrity.status, 'mismatch');
  assert.deepEqual(sameCount.integrity.records, clean.integrity.records);
  assert.deepEqual(sameCount.integrity.boundAttachments, clean.integrity.boundAttachments);
  assert.equal(sameCount.integrity.columnMismatches, 0);
  const jiraIntegrity = packageIntegrity(sameCount, jira);
  assert.equal(jiraIntegrity.status, 'mismatch');
  assert.notEqual(jiraIntegrity.recordsSha256.observed, jiraIntegrity.recordsSha256.expected);
  assert.deepEqual(packageIntegrity(sameCount, wiki), packageIntegrity(clean, wiki));
  assert.deepEqual(packageIntegrity(sameCount, linkedWiki), packageIntegrity(clean, linkedWiki));

  const removeIdentity = "DELETE FROM source_records WHERE import_id=? AND id=? AND kind='identity'";
  assert.equal(f.db.prepare(removeIdentity).run(receipt.id, identity.sourceRecordId).changes, 1);
  const incomplete = await audit();
  assert.equal(incomplete.recordCounts['archive-only'], afterPurge.recordCounts['archive-only'] - 1);
  assert.equal(incomplete.recordCounts.missing, afterPurge.recordCounts.missing, 'Canonical target loss and archival record loss have separate evidence.');
  assert.deepEqual(incomplete.attachmentCounts, afterPurge.attachmentCounts);
  assert.equal(incomplete.integrity.status, 'mismatch');
  assert.deepEqual(incomplete.integrity.records, { expected: receipt.counts.sourceRecords, observed: receipt.counts.sourceRecords - 1 });
  assert.deepEqual(incomplete.integrity.boundAttachments, clean.integrity.boundAttachments);

  const archivedFile = backup.data.sourceRecords.find(value => value.source.instanceKey === linkedWiki.source.instanceKey && value.record.id === 'attachment:701');
  assert.ok(archivedFile?.targetId);
  assert.equal(f.db.prepare('DELETE FROM source_records WHERE import_id=? AND id=?').run(receipt.id, archivedFile.id).changes, 1);
  const missingFileArchive = await audit();
  assert.equal(missingFileArchive.integrity.status, 'mismatch');
  assert.deepEqual(missingFileArchive.integrity.records, { expected: receipt.counts.sourceRecords, observed: receipt.counts.sourceRecords - 2 });
  assert.deepEqual(missingFileArchive.integrity.boundAttachments, { expected: 2, observed: 1 });
  assert.equal(packageIntegrity(missingFileArchive, linkedWiki).status, 'mismatch');
  assert.equal(missingFileArchive.attachmentCounts.missing, 0, 'The archival row is gone even though its attachment bytes still exist.');
  const download = await fetch(`${f.base}/attachment-versions/${archivedFile.targetId}/download`);
  assert.equal(download.status, 200);
  await download.arrayBuffer();

  const badBackups = [
    backup.data.sourceRecords.filter(value => value.id !== identity.sourceRecordId),
    backup.data.sourceRecords.map(value => value.id === archivedIssueRecord.id ? { ...value, record: { ...value.record, text: privateMarker } } : value),
    backup.data.sourceRecords.map(value => value.excluded === true ? { ...value, excluded: undefined } : value),
  ];
  for (const sourceRecords of badBackups) {
    const result = await f.call('/import', 'POST', { data: { ...backup.data, sourceRecords } });
    assert.equal(result.status, 400, JSON.stringify(result.data));
    assert.deepEqual((await audit()).integrity, missingFileArchive.integrity);
  }

  const corruptJson = f.db.prepare('UPDATE source_records SET json=? WHERE id=?');
  assert.equal(corruptJson.run('{', archivedIssueRecord.id).changes, 1);
  const malformedArchive = await audit();
  assert.equal(malformedArchive.integrity.status, 'mismatch');
  assert.equal(malformedArchive.integrity.unmatchedRecords, 1);
  assert.equal(malformedArchive.integrity.columnMismatches, 1);
  assert.deepEqual(malformedArchive.integrity.records, missingFileArchive.integrity.records);
  assert.deepEqual((await scoped(jira, { kind: 'issue' })).rows.map(row => row.sourceKey), ['OTHER-1']);

  const reordered = { ...backup.data, sourceRecords: [...backup.data.sourceRecords].reverse() };
  assert.equal((await f.call('/import', 'POST', { data: reordered })).status, 200);
  const restored = await audit();
  assert.equal(restored.receiptVersion, receipt.version + 1);
  assert.deepEqual(restored.recordCounts, afterPurge.recordCounts);
  assert.deepEqual(restored.attachmentCounts, afterPurge.attachmentCounts);
  assert.deepEqual(restored.integrity, clean.integrity);
  assert.deepEqual(restored.primaryRecords, afterPurge.primaryRecords);
  assert.deepEqual((await scoped(jira, { kind: 'issue', status: 'missing' })).rows.map(row => row.sourceRecordId), [jiraIssue.sourceRecordId]);

  const legacy = await fixture();
  t.after(() => legacy.close());
  const oldBackup = historicalMigrationBackup(backup.data, 32);
  for (const original of oldBackup.sourceImports) delete original.integrity;
  for (const original of oldBackup.sourceRecords) {
    delete original.excluded;
    delete original.confluencePageFieldHashes;
    delete original.confluencePageBodySourceHash;
    if (original.jiraIssueFieldHashes) delete original.jiraIssueFieldHashes.parentId;
  }
  const loadedOld = await legacy.call('/import', 'POST', { data: oldBackup });
  assert.equal(loadedOld.status, 200, JSON.stringify(loadedOld.data));
  const countsOnly = await audit(legacy);
  assert.deepEqual((await scoped(wiki, { kind: 'page', status: 'excluded' }, legacy)).rows.map(row => row.sourceRecordId), [excludedPage.sourceRecordId]);
  assert.equal(countsOnly.integrity.status, 'counts-only');
  assert.deepEqual(countsOnly.integrity.records, clean.integrity.records);
  assert.deepEqual(countsOnly.integrity.boundAttachments, clean.integrity.boundAttachments);
  assert.ok(countsOnly.integrity.packages.every(value => value.status === 'unavailable' && value.recordsSha256.expected === null));
  assert.equal(legacy.db.prepare(removeIdentity).run(receipt.id, identity.sourceRecordId).changes, 1);
  const oldIncomplete = await audit(legacy);
  assert.equal(oldIncomplete.integrity.status, 'mismatch');
  assert.deepEqual(oldIncomplete.integrity.records, incomplete.integrity.records);
  assert.ok(oldIncomplete.integrity.packages.every(value => value.status === 'unavailable'));
  const missingOldBackup = { ...oldBackup, sourceRecords: oldBackup.sourceRecords.filter(value => value.id !== identity.sourceRecordId) };
  assert.equal((await legacy.call('/import', 'POST', { data: missingOldBackup })).status, 200);
  assert.deepEqual((await audit(legacy)).integrity, oldIncomplete.integrity);
});

test('interrupted append recovery removes only uncommitted owned files and retains exact committed versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-migration-recovery-')), append = new AttachmentAppend(dir), file = (text: string): AppendedFile => { const bytes = Buffer.from(text); return { id: randomUUID(), bytes, size: bytes.length, sha256: hash(bytes) }; };
  try {
    const uploads = join(dir, 'uploads'), sentinel = join(uploads, 'operator-note.txt'); writeFileSync(sentinel, 'keep unrelated file');
    const uncommitted = randomUUID(), pending = [file('partially installed'), file('still staged')]; append.stage(uncommitted, pending);
    writeFileSync(join(dir, `.append-${uncommitted}.json`), JSON.stringify({ id: uncommitted, stage: `.append-stage-${uncommitted}`, files: pending.map(value => value.id) }), { mode: 0o600 }); renameSync(join(dir, `.append-stage-${uncommitted}`, pending[0].id), join(uploads, pending[0].id));
    new AttachmentAppend(dir).recover(() => false); for (const value of pending) assert.equal(existsSync(join(uploads, value.id)), false); assert.equal(existsSync(join(dir, `.append-stage-${uncommitted}`)), false);
    const committed = randomUUID(), durable = [file('committed first version'), file('committed latest version')], transaction = append.stage(committed, durable); transaction.install(); assert.equal(existsSync(join(dir, `.append-${committed}.json`)), true);
    new AttachmentAppend(dir).recover(id => id === committed); for (const value of durable) assert.deepEqual(readFileSync(join(uploads, value.id)), value.bytes); assert.equal(readFileSync(sentinel, 'utf8'), 'keep unrelated file'); assert.ok(!readdirSync(dir).some(value => value.startsWith('.append-')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
