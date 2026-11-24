import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import { contentMarkdown,contentText } from '../../src/features/document-utils.js';
import { contentReferences, documentContentSchemaVersion } from '../../shared/document-nodes.js';
import { DOCUMENT_LABEL_LIST_DEFAULTS, MAX_DOCUMENT_LABEL_LISTS, MAX_DOCUMENT_LABEL_LIST_LIMIT } from '../../shared/document-label-list.js';
import type { ApiKeyCreated,DocPage,DocRevision,DocumentPublicationView,DocumentTemplateSummary,RichContent,SavedView,WorkspaceSnapshot } from '../../shared/types.js';
import { COLLABORATION_SCHEMA, type CollaborationSession } from '../../shared/collaboration.js';

type Backup=WorkspaceSnapshot&{schemaVersion:number;collabStates:{documentId:string;schemaVersion:number;state:string}[]};
const p=(text:string):RichContent=>({type:'paragraph',content:[{type:'text',text}]});
const body=(...content:RichContent[]):RichContent=>({type:'doc',content});
const reference=(type:'issueReference'|'documentReference'|'documentInclude',id:string,label:string):RichContent=>({type,attrs:{[type==='issueReference'?'issueId':'documentId']:id,label}});
const pinnedInclude=(documentId:string,revisionId:string,label:string):RichContent=>({type:'documentRevisionInclude',attrs:{documentId,revisionId,label}});
const issueList = (projectId: string, savedViewId: string | null, label: string): RichContent => ({type:'issueList',attrs:{projectId,savedViewId,label}});
const issueSummary = (projectId: string, savedViewId: string | null, groupBy: string, label = '회의에서 볼 현황'): RichContent => ({
  type:'issueSummary', attrs:{projectId,savedViewId,groupBy,label},
});
const labelList = (attrs: Record<string, unknown> = {}): RichContent => ({ type: 'documentLabelList', attrs });
const details:RichContent={type:'details',content:[{type:'detailsSummary',content:[{type:'text',text:'검토 <기준>',marks:[{type:'bold'}]}]},{type:'detailsContent',content:[p('접혀 있어도 보존할 결정')]}]};
async function fixture(){const dir=mkdtempSync(join(tmpdir(),'teamspace-document-integration-'));const service=createApp({dataDir:dir});const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;return{
  base,
  async call<T=Record<string,unknown>>(path:string,method='GET',data?:unknown,token?:string,actorId='user-min'){const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{'X-Actor-Id':actorId})},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:response.status,data:await response.json() as T};},
  async close(){service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});},
};}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function make(f:Fixture,title:string,content=body(p('원본')),projectId:string|null='project-neo'){const result=await f.call<DocPage>('/documents','POST',{projectId,title,content});assert.equal(result.status,201,JSON.stringify(result.data));return result.data;}
const snapshot=async(f:Fixture)=>(await f.call<WorkspaceSnapshot>('/workspace')).data;

test('manual child lists require content schema 14 and at least workspace backup format 105', async () => {
  const f = await fixture();
  try {
    const childList = (sort: 'created' | 'manual') => body({ type: 'documentChildList', attrs: { sort } });
    const legacy = await make(f, '기존 하위 문서 목록', childList('created'));
    const manual = await make(f, '직접 정렬하는 하위 문서 목록', childList('manual'));
    assert.equal(documentContentSchemaVersion(legacy.content), 10);
    assert.equal(documentContentSchemaVersion(manual.content), 14);
    const path = `/documents/${manual.id}`;
    const oldWrite = await f.call<{ details: { contentSchemaVersion: number } }>(path, 'PATCH', {
      expectedVersion: manual.version, contentSchemaVersion: 13, content: childList('created'),
    });
    assert.equal(oldWrite.status, 409);
    assert.equal(oldWrite.data.details.contentSchemaVersion, 14);
    assert.deepEqual((await snapshot(f)).documents.find(doc => doc.id === manual.id)?.content, manual.content);
    assert.equal((await f.call(`/documents/${legacy.id}`, 'PATCH', {
      expectedVersion: legacy.version, contentSchemaVersion: 10, content: body(p('기존 형식의 새 본문'), ...childList('created').content!),
    })).status, 200);
    const live = await f.call<CollaborationSession>(`${path}/collaboration/enable`, 'POST', { expectedVersion: manual.version });
    assert.equal(live.status, 200);
    assert.equal(live.data.schemaVersion, COLLABORATION_SCHEMA);
    const activeBackup = (await f.call<Backup>('/export')).data;
    assert.equal(activeBackup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    const rejectDowngrade = async (backup: Backup) => {
      const rejected = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 104 } });
      assert.equal(rejected.status, 400);
      assert.match(rejected.data.error, /schemaVersion 105/u);
    };
    await rejectDowngrade(activeBackup);
    const staleState = { ...activeBackup, collabStates: activeBackup.collabStates.map(state =>
      state.documentId === manual.id ? { ...state, schemaVersion: 13 } : state) };
    assert.equal((await f.call('/import', 'POST', { data: staleState })).status, 422);
    assert.equal((await f.call<CollaborationSession>(`${path}/collaboration`)).data.epoch, live.data.epoch);

    const template = await f.call<DocumentTemplateSummary>('/document-templates', 'POST', {
      requestId: randomUUID(), sourceDocumentId: manual.id, expectedDocumentVersion: live.data.document.version, name: '직접 정렬 템플릿',
    });
    assert.equal(template.status, 201, JSON.stringify(template.data));
    const trashed = await f.call<{ trashEntryId: string }>(path, 'DELETE');
    assert.equal(trashed.status, 200);
    const archived = (await f.call<Backup & { documentTemplates: unknown[] }>('/export')).data;
    assert.ok(!archived.documents.some(doc => doc.id === manual.id));
    await rejectDowngrade(archived);
    const withoutTemplate = { ...archived, documentTemplates: [] };
    await rejectDowngrade(withoutTemplate);
    assert.equal((await f.call('/import', 'POST', { data: archived })).status, 200);
    assert.equal((await f.call(`/trash/${trashed.data.trashEntryId}/restore`, 'POST')).status, 200);
    const session = (await f.call<CollaborationSession>(`${path}/collaboration`)).data;
    assert.equal(session.schemaVersion, COLLABORATION_SCHEMA);
    assert.notEqual(session.epoch, live.data.epoch);
    assert.deepEqual(session.document.content, manual.content);
  } finally { await f.close(); }
});

test('identified checklist items survive edits, live startup, and workspace backup and restore', async () => {
  const f = await fixture();
  try {
    const checklist = (text: string, checklistItemId?: string) => body({
      type: 'taskList', content: [{ type: 'taskItem',
        attrs: { checked: false, ...(checklistItemId && { checklistItemId }) }, content: [p(text)] }],
    });
    const initial = checklist('빌드를 검토한다', 'review-build');
    const document = await make(f, '출시 점검', initial);
    const path = `/documents/${document.id}`;
    const oldWrite = await f.call<{ details: { contentSchemaVersion: number } }>(path, 'PATCH', {
      expectedVersion: document.version, contentSchemaVersion: 14, content: checklist('빌드를 다시 검토한다'),
    });
    assert.equal(oldWrite.status, 409);
    assert.equal(oldWrite.data.details.contentSchemaVersion, 15);
    const updatedContent = checklist('빌드를 다시 검토한다', 'review-build');
    const saved = await f.call<DocPage>(path, 'PATCH', {
      expectedVersion: document.version, contentSchemaVersion: 15, content: updatedContent,
    });
    assert.equal(saved.status, 200);
    const live = await f.call<CollaborationSession>(`${path}/collaboration/enable`, 'POST', { expectedVersion: saved.data.version });
    assert.equal(live.status, 200);
    assert.equal(live.data.schemaVersion, COLLABORATION_SCHEMA);
    assert.deepEqual(live.data.document.content, updatedContent);

    const backup = (await f.call<Backup>('/export')).data;
    assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    const downgraded = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 107 } });
    assert.equal(downgraded.status, 400);
    assert.match(downgraded.data.error, /schemaVersion 108/u);
    assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
    assert.deepEqual((await snapshot(f)).documents.find(candidate => candidate.id === document.id)?.content, updatedContent);
    const revisions = await f.call<DocRevision[]>(`${path}/revisions`);
    assert.deepEqual(revisions.data.find(revision => revision.version === document.version)?.content, initial);
    assert.deepEqual((await f.call<CollaborationSession>(`${path}/collaboration`)).data.document.content, updatedContent);
  } finally { await f.close(); }
});

test('label list options are canonical, bounded and protected in live and archived document backups', async () => {
  const f = await fixture();
  try {
    const options = { projectId: 'project-neo', labels: ['  Alpha ', 'ALPHA', '베타'], title: ' 배포 문서 ', limit: 75 };
    const document = await make(f, '팀 문서 인덱스', body(labelList(options)));
    const path = `/documents/${document.id}`;
    const canonical = body(labelList({ ...DOCUMENT_LABEL_LIST_DEFAULTS, ...options, labels: ['Alpha', '베타'], title: '배포 문서' }));
    assert.deepEqual(document.content, canonical);
    assert.equal(documentContentSchemaVersion(document.content), 9);
    assert.deepEqual(contentReferences(document.content), []);
    assert.match(document.plainText, /라벨별 문서.*배포 문서.*Alpha, 베타/u);

    for (const attrs of [
      { projectId: 'missing-project' }, { projectId: '' }, { labels: null }, { labels: ['유효\n하지 않음'] },
      { labels: Array.from({ length: 21 }, (_, index) => `label-${index}`) }, { title: '긴'.repeat(161) },
      { ascending: true }, { sort: 'random' }, { descending: 'true' }, { limit: 1.5 }, { limit: MAX_DOCUMENT_LABEL_LIST_LIMIT + 1 },
    ]) {
      const invalid = await f.call('/documents', 'POST', { projectId: options.projectId, title: '잘못된 목록', content: body(labelList(attrs)) });
      assert.equal(invalid.status, 422, JSON.stringify([attrs, invalid.data]));
    }
    const overLimit = body(...Array.from({ length: MAX_DOCUMENT_LABEL_LISTS + 1 }, () => labelList()));
    assert.equal((await f.call('/documents', 'POST', { title: '목록 블록 한도', content: overLimit })).status, 422);

    const oldWrite = await f.call<{ details: { contentSchemaVersion: number } }>(path, 'PATCH', {
      expectedVersion: document.version, contentSchemaVersion: 8, content: body(p('목록을 알 수 없는 편집기')),
    });
    assert.equal(oldWrite.status, 409);
    assert.equal(oldWrite.data.details.contentSchemaVersion, 9);
    const live = await f.call<CollaborationSession>(`${path}/collaboration/enable`, 'POST', { expectedVersion: document.version });
    assert.equal(live.status, 200);
    assert.equal(live.data.schemaVersion, COLLABORATION_SCHEMA);
    assert.deepEqual(live.data.document.content, canonical);

    const { data: backup } = await f.call<Backup>('/export');
    assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    const downgraded = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 58 } });
    assert.equal(downgraded.status, 400);
    assert.match(downgraded.data.error, /schemaVersion 59/u);
    const mislabeled = structuredClone(backup);
    mislabeled.collabStates.find(state => state.documentId === document.id)!.schemaVersion = 8;
    assert.equal((await f.call('/import', 'POST', { data: mislabeled })).status, 422);
    assert.equal((await f.call<CollaborationSession>(`${path}/collaboration`)).data.epoch, live.data.epoch);
    assert.equal((await f.call('/import', 'POST', { data: { ...backup, schemaVersion: 59 } })).status, 200);
    const restored = (await f.call<CollaborationSession>(`${path}/collaboration`)).data;
    assert.notEqual(restored.epoch, live.data.epoch);
    assert.deepEqual(restored.document.content, canonical);

    const archived = await f.call<{ trashEntryId: string }>(path, 'DELETE', { expectedVersion: restored.document.version });
    assert.equal(archived.status, 200);
    const { data: archivedBackup } = await f.call<Backup>('/export');
    const oldArchive = await f.call<{ error: string }>('/import', 'POST', { data: { ...archivedBackup, schemaVersion: 58 } });
    assert.equal(oldArchive.status, 400);
    assert.match(oldArchive.data.error, /schemaVersion 59/u);
    assert.equal((await f.call('/import', 'POST', { data: archivedBackup })).status, 200);
    assert.equal((await f.call(`/trash/${archived.data.trashEntryId}/restore`, 'POST', {})).status, 200);
    assert.deepEqual((await f.call<CollaborationSession>(`${path}/collaboration`)).data.document.content, canonical);
    const history = (await f.call<DocRevision[]>(`${path}/revisions`)).data;
    assert.ok(history.some(revision => documentContentSchemaVersion(revision.content) === 9));
  } finally { await f.close(); }
});

test('label list scope follows the whole document across writes, history, and scoped publication snapshots', async () => {
  const f = await fixture();
  try {
    const key = (await f.call<ApiKeyCreated>('/api-keys', 'POST', {
      name: '라벨 목록 범위 검증', access: 'write', projectIds: ['project-neo'], expiresAt: null,
    })).data;
    const nested = (projectId: string | null): RichContent => body({
      type: 'callout', attrs: { variant: 'info', title: '범위' }, content: [labelList({ projectId, labels: ['공유할 라벨'] })],
    });
    const permitted = await f.call<DocPage>('/v1/documents', 'POST', { projectId: 'project-neo', title: '범위 내부', content: nested('project-neo') }, key.token);
    assert.equal(permitted.status, 201, JSON.stringify(permitted.data));
    for (const scope of ['project-team', null]) {
      assert.equal((await f.call('/v1/documents', 'POST', { projectId: 'project-neo', title: '범위 외부', content: nested(scope) }, key.token)).status, 403);
      assert.equal((await f.call(`/v1/documents/${permitted.data.id}`, 'PATCH', {
        expectedVersion: permitted.data.version, contentSchemaVersion: 9, content: nested(scope),
      }, key.token)).status, 403);
      const document = await make(f, '폴더 안의 다른 범위', nested(scope));
      const path = `/documents/${document.id}`;
      assert.equal((await f.call(`/v1${path}`, 'GET', undefined, key.token)).status, 403);
      assert.equal((await f.call(`/v1${path}`, 'PATCH', { expectedVersion: document.version, title: '접근할 수 없는 제목 수정' }, key.token)).status, 403);
      const listed = await f.call<DocPage[]>('/v1/documents', 'GET', undefined, key.token);
      assert.ok(listed.data.some(row => row.id === permitted.data.id));
      assert.ok(listed.data.every(row => row.id !== document.id));
      assert.deepEqual((await f.call<DocRevision[]>(`/v1${path}/revisions`, 'GET', undefined, key.token)).data, []);

      const publication = `${path}/publication`;
      const initial = (await f.call<DocumentPublicationView>(publication)).data;
      const requested = await f.call<DocumentPublicationView>(publication, 'POST', {
        action: 'request', expectedVersion: initial.version, workspaceGeneration: initial.workspaceGeneration,
        expectedDocumentVersion: document.version, reviewerId: 'user-seo',
      });
      assert.equal(requested.status, 200, JSON.stringify(requested.data));
      assert.ok(requested.data.review);
      const frozen = `${publication}/snapshot?kind=review&revisionId=${requested.data.review.revisionId}`;
      assert.equal((await f.call(frozen)).status, 200);
      assert.equal((await f.call(`/v1${frozen}`, 'GET', undefined, key.token)).status, 403);
    }
  } finally { await f.close(); }
});

test('stable heading sections survive protected writes, live state, native backup and trash restore', async () => {
  const f = await fixture();
  try {
    const sectionId = 'validation-notes';
    const heading = (text: string, level: number): RichContent => ({ type: 'heading', attrs: { level, sectionId }, content: [{ type: 'text', text }] });
    const before = body(heading('검증 기준', 2), p('검토 본문'));
    const original = await make(f, '공유할 문서 절', before);
    const path = `/documents/${original.id}`;
    assert.deepEqual(original.content, before);
    const [firstRevision] = (await f.call<DocRevision[]>(`${path}/revisions`)).data;
    assert.equal(documentContentSchemaVersion(original.content), 7);
    assert.match(contentMarkdown(original.content), /<a id="validation-notes"><\/a>\n\n## 검증 기준/u);

    const oldClient = await f.call<{ details: { contentSchemaVersion: number } }>(path, 'PATCH', {
      expectedVersion: original.version, contentSchemaVersion: 6, content: body(p('절 정보 없이 덮어쓴 본문')),
    });
    assert.equal(oldClient.status, 409);
    assert.equal(oldClient.data.details.contentSchemaVersion, 7);
    const renamed = await f.call<DocPage>(path, 'PATCH', { expectedVersion: original.version, title: '새 문서 제목' });
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.data.content, before);
    const after = body(p('옮긴 절 앞의 본문'), heading('개정한 검증 기준', 3));
    const edit = await f.call<DocPage>(path, 'PATCH', { expectedVersion: renamed.data.version, contentSchemaVersion: 7, content: after });
    assert.equal(edit.status, 200);
    assert.deepEqual(edit.data.content, after);
    const live = await f.call<CollaborationSession>(`${path}/collaboration/enable`, 'POST', { expectedVersion: edit.data.version });
    assert.equal(live.status, 200);
    assert.equal(live.data.schemaVersion, COLLABORATION_SCHEMA);
    assert.deepEqual(live.data.document.content, after);

    const { data: backup } = await f.call<Backup>('/export');
    assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    const legacy = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 48 } });
    assert.equal(legacy.status, 400);
    assert.match(legacy.data.error, /schemaVersion 49/u);
    const mislabeled = structuredClone(backup);
    const state = mislabeled.collabStates.find(item => item.documentId === original.id);
    assert.ok(state);
    state.schemaVersion = 6;
    assert.equal((await f.call('/import', 'POST', { data: mislabeled })).status, 422);
    assert.equal((await f.call<CollaborationSession>(`${path}/collaboration`)).data.epoch, live.data.epoch);
    assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
    const restored = (await f.call<CollaborationSession>(`${path}/collaboration`)).data;
    assert.deepEqual(restored.document.content, after);

    const archived = await f.call<{ trashEntryId: string }>(path, 'DELETE', { expectedVersion: restored.document.version });
    assert.equal(archived.status, 200);
    const { data: archivedBackup } = await f.call<Backup>('/export');
    assert.equal(archivedBackup.documents.some(item => item.id === original.id), false);
    assert.equal((await f.call('/import', 'POST', { data: { ...archivedBackup, schemaVersion: 48 } })).status, 400);
    assert.equal((await f.call('/import', 'POST', { data: archivedBackup })).status, 200);
    assert.equal((await f.call(`/trash/${archived.data.trashEntryId}/restore`, 'POST', {})).status, 200);
    assert.deepEqual((await f.call<CollaborationSession>(`${path}/collaboration`)).data.document.content, after);
    const history = (await f.call<DocRevision[]>(`${path}/revisions`)).data;
    assert.deepEqual(history.find(revision => revision.id === firstRevision.id)?.content, before);
  } finally {
    await f.close();
  }
});

test('body contents navigation survives live state and active and archived version 54 backups', async () => {
  const f = await fixture();
  try {
    const section: RichContent = { type: 'heading', attrs: { level: 2, sectionId: 'toc-target' }, content: [{ type: 'text', text: '배포 전 확인' }] };
    const nav = (attrs: Record<string, unknown>): RichContent => ({ type: 'documentToc', attrs });
    const before = body(nav({ minLevel: 1, maxLevel: 3, layout: 'list' }), section);
    const document = await make(f, '본문 목차 문서', before);
    const path = `/documents/${document.id}`;
    assert.equal(documentContentSchemaVersion(document.content), 8);
    const [original] = (await f.call<DocRevision[]>(`${path}/revisions`)).data;
    const oldWrite = await f.call<{ details: { contentSchemaVersion: number } }>(path, 'PATCH', {
      expectedVersion: document.version, contentSchemaVersion: 7, content: body(section),
    });
    assert.equal(oldWrite.status, 409);
    assert.equal(oldWrite.data.details.contentSchemaVersion, 8);
    const after = body(nav({ minLevel: 2, maxLevel: 2, layout: 'flat' }), section);
    const edited = await f.call<DocPage>(path, 'PATCH', { expectedVersion: document.version, contentSchemaVersion: 8, content: after });
    assert.equal(edited.status, 200);
    const live = await f.call<CollaborationSession>(`${path}/collaboration/enable`, 'POST', { expectedVersion: edited.data.version });
    assert.equal(live.status, 200);
    assert.equal(live.data.schemaVersion, COLLABORATION_SCHEMA);
    assert.deepEqual(live.data.document.content, after);

    const { data: backup } = await f.call<Backup>('/export');
    assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    const downgraded = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 53 } });
    assert.equal(downgraded.status, 400);
    assert.match(downgraded.data.error, /schemaVersion 54/u);
    const mislabeled = structuredClone(backup);
    const state = mislabeled.collabStates.find(item => item.documentId === document.id);
    assert.ok(state);
    state.schemaVersion = 7;
    assert.equal((await f.call('/import', 'POST', { data: mislabeled })).status, 422);
    assert.equal((await f.call<CollaborationSession>(`${path}/collaboration`)).data.epoch, live.data.epoch);
    state.schemaVersion = 8;
    assert.equal((await f.call('/import', 'POST', { data: { ...mislabeled, schemaVersion: 54 } })).status, 200);
    const restored = (await f.call<CollaborationSession>(`${path}/collaboration`)).data;
    assert.equal(restored.schemaVersion, COLLABORATION_SCHEMA);
    assert.deepEqual(restored.document.content, after);

    const archived = await f.call<{ trashEntryId: string }>(path, 'DELETE', { expectedVersion: restored.document.version });
    assert.equal(archived.status, 200);
    const { data: archive } = await f.call<Backup>('/export');
    assert.equal(archive.documents.some(candidate => candidate.id === document.id), false);
    assert.equal((await f.call('/import', 'POST', { data: { ...archive, schemaVersion: 53 } })).status, 400);
    assert.equal((await f.call('/import', 'POST', { data: archive })).status, 200);
    assert.equal((await f.call(`/trash/${archived.data.trashEntryId}/restore`, 'POST', {})).status, 200);
    assert.deepEqual((await f.call<CollaborationSession>(`${path}/collaboration`)).data.document.content, after);
    const history = (await f.call<DocRevision[]>(`${path}/revisions`)).data;
    assert.deepEqual(history.find(revision => revision.id === original.id)?.content, before);
  } finally {
    await f.close();
  }
});

test('heading levels 4 through 6 require content schema 16 and backup format 110', async () => {
  const f = await fixture();
  try {
    const heading = (level: number, sectionId: string, text: string): RichContent => ({
      type: 'heading', attrs: { level, sectionId }, content: [{ type: 'text', text }],
    });
    const toc = (minLevel: number, maxLevel: number): RichContent => ({
      type: 'documentToc', attrs: { minLevel, maxLevel, layout: 'flat' },
    });
    const shallow = body(toc(1, 3), heading(3, 'summary', '요약'));
    const deep = body(toc(4, 6), heading(4, 'procedure', '운영 절차'), heading(5, 'bounds', '입출력'), heading(6, 'check', '저장 확인'));
    for (const node of deep.content!) assert.equal(documentContentSchemaVersion(body(node)), 16);
    assert.equal(documentContentSchemaVersion(shallow), 8);
    const shallowDoc = await make(f, '기존 제목 문서', shallow);
    const { data: shallowBackup } = await f.call<Backup>('/export');
    const oldBackup = await f.call('/import', 'POST', { data: { ...shallowBackup, schemaVersion: 109 } });
    assert.equal(oldBackup.status, 200, JSON.stringify(oldBackup.data));
    assert.deepEqual((await snapshot(f)).documents.find(doc => doc.id === shallowDoc.id)?.content, shallow);

    const original = await make(f, '4~6단계 제목', deep);
    const path = `/documents/${original.id}`;
    assert.deepEqual(original.content, deep);
    const [firstRevision] = (await f.call<DocRevision[]>(`${path}/revisions`)).data;
    const oldClient = await f.call<{ details: { contentSchemaVersion: number } }>(path, 'PATCH', {
      expectedVersion: original.version, contentSchemaVersion: 15, content: shallow,
    });
    assert.equal(oldClient.status, 409);
    assert.equal(oldClient.data.details.contentSchemaVersion, 16);
    assert.deepEqual((await snapshot(f)).documents.find(doc => doc.id === original.id)?.content, deep);

    const rejectOldBackup = async (backup: Backup, pattern = /schemaVersion 110/u) => {
      const denied = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 109 } });
      assert.equal(denied.status, 400, JSON.stringify(denied.data));
      assert.match(denied.data.error, pattern);
    };
    const { data: activeBackup } = await f.call<Backup>('/export');
    assert.equal(activeBackup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    await rejectOldBackup(activeBackup);
    const edited = await f.call<DocPage>(path, 'PATCH', {
      expectedVersion: original.version, contentSchemaVersion: 16, content: shallow,
    });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.data.content, shallow);
    const { data: historyBackup } = await f.call<Backup>('/export');
    await rejectOldBackup(historyBackup);

    const reapplied = await f.call<DocPage>(path, 'PATCH', {
      expectedVersion: edited.data.version, contentSchemaVersion: 16, content: deep,
    });
    assert.equal(reapplied.status, 200);
    const live = await f.call<CollaborationSession>(`${path}/collaboration/enable`, 'POST', { expectedVersion: reapplied.data.version });
    assert.equal(live.status, 200);
    assert.equal(live.data.schemaVersion, 16);
    assert.deepEqual(live.data.document.content, deep);
    const { data: liveBackup } = await f.call<Backup>('/export');
    const wrongSchema = structuredClone(liveBackup);
    const state = wrongSchema.collabStates.find(item => item.documentId === original.id);
    assert.ok(state);
    state.schemaVersion = 15;
    assert.equal((await f.call('/import', 'POST', { data: wrongSchema })).status, 422);
    assert.equal((await f.call<CollaborationSession>(`${path}/collaboration`)).data.epoch, live.data.epoch);
    assert.equal((await f.call('/import', 'POST', { data: liveBackup })).status, 200);
    const restored = (await f.call<CollaborationSession>(`${path}/collaboration`)).data;
    assert.notEqual(restored.epoch, live.data.epoch);
    assert.equal(restored.schemaVersion, 16);
    assert.deepEqual(restored.document.content, deep);

    const template = await f.call<DocumentTemplateSummary>('/document-templates', 'POST', {
      requestId: randomUUID(), sourceDocumentId: original.id, expectedDocumentVersion: restored.document.version, name: '제목 4~6 템플릿',
    });
    assert.equal(template.status, 201, JSON.stringify(template.data));
    const archived = await f.call<{ trashEntryId: string }>(path, 'DELETE', { expectedVersion: restored.document.version });
    assert.equal(archived.status, 200);
    const { data: archivedBackup } = await f.call<Backup & { documentTemplates: unknown[] }>('/export');
    assert.equal(archivedBackup.documents.some(doc => doc.id === original.id), false);
    const withoutTemplate = { ...archivedBackup, documentTemplates: [] };
    await rejectOldBackup(withoutTemplate);
    assert.equal((await f.call('/import', 'POST', { data: archivedBackup })).status, 200);
    assert.equal((await f.call(`/trash/${archived.data.trashEntryId}/restore`, 'POST', {})).status, 200);
    const restoredArchive = (await f.call<CollaborationSession>(`${path}/collaboration`)).data;
    assert.deepEqual(restoredArchive.document.content, deep);
    const history = (await f.call<DocRevision[]>(`${path}/revisions`)).data;
    assert.deepEqual(history.find(revision => revision.id === firstRevision.id)?.content, deep);

    const discarded = await f.call<{ trashEntryId: string }>(path, 'DELETE', { expectedVersion: restoredArchive.document.version });
    assert.equal(discarded.status, 200);
    assert.equal((await f.call(`/trash/${discarded.data.trashEntryId}`, 'DELETE')).status, 200);
    const { data: templateBackup } = await f.call<Backup>('/export');
    await rejectOldBackup(templateBackup, /템플릿.+schemaVersion 110/u);
    assert.equal((await f.call('/import', 'POST', { data: templateBackup })).status, 200);
  } finally {
    await f.close();
  }
});

test('manual writes, cycles and live historical restore preserve reference IDs and folded content atomically',async()=>{
  const f=await fixture();try{
    const target=await make(f,'포함할 원본');
    const content=body(p('설계 맥락'),reference('issueReference','issue-1','검증 업무'),reference('documentInclude',target.id,'검토 원문'),details);
    const source=await make(f,'통합 설계',content);assert.deepEqual(source.content,content);assert.match(source.plainText,/접혀 있어도 보존할 결정/);assert.match(source.plainText,/검증 업무/);
    const revisions=(await f.call<DocRevision[]>(`/documents/${source.id}/revisions`)).data;const original=revisions[0];
    const without=await f.call<DocPage>(`/documents/${source.id}`,'PATCH',{expectedVersion:source.version,content:body(p('포함 관계 변경'))});assert.equal(without.status,200);
    const live=(await f.call<CollaborationSession>(`/documents/${source.id}/collaboration/enable`,'POST',{expectedVersion:without.data.version})).data;
    const linked=await f.call(`/documents/${target.id}`,'PATCH',{expectedVersion:target.version,content:body(reference('documentInclude',source.id,'역방향 원문'))});assert.equal(linked.status,200);
    const before=await snapshot(f);assert.equal((await f.call(`/documents/${source.id}/restore`,'POST',{revisionId:original.id,expectedVersion:live.document.version})).status,422);assert.deepEqual(await snapshot(f),before);
    assert.equal((await f.call(`/documents/${target.id}?expectedVersion=2`,'DELETE')).status,200);
    const restored=await f.call<DocPage>(`/documents/${source.id}/restore`,'POST',{revisionId:original.id,expectedVersion:live.document.version});assert.equal(restored.status,200,JSON.stringify(restored.data));assert.deepEqual(restored.data.content,content);
    const session=(await f.call<CollaborationSession>(`/documents/${source.id}/collaboration`)).data;assert.notEqual(session.epoch,live.epoch);assert.equal(session.schemaVersion,COLLABORATION_SCHEMA);assert.equal(session.document.plainText,restored.data.plainText);
    assert.equal((await f.call('/documents','POST',{projectId:'project-neo',title:'새 누락 참조',content})).status,422);
    const saved=(await f.call<DocRevision[]>(`/documents/${source.id}/revisions`)).data;assert.ok(saved.some(revision=>revision.version===restored.data.version&&revision.summary.includes('복구')));
  }finally{await f.close();}
});

test('scoped automation validates embedded targets and allows unchanged missing historical references',async()=>{
  const f=await fixture();try{
    const own=await make(f,'같은 프로젝트 참조'),other=await make(f,'다른 프로젝트 원문',body(p('다른 프로젝트 본문')),'project-team');
    const key=(await f.call<ApiKeyCreated>('/api-keys','POST',{name:'문서 자동화 검증',access:'write',projectIds:['project-neo'],expiresAt:null})).data;
    for(const type of ['documentReference','documentInclude'] as const)assert.equal((await f.call('/v1/documents','POST',{projectId:'project-neo',title:'범위 우회',content:body(reference(type,other.id,'타 프로젝트'))},key.token)).status,403);
    assert.equal((await f.call('/v1/documents','POST',{projectId:'project-neo',title:'업무 범위 우회',content:body(reference('issueReference','issue-10','다른 프로젝트 업무'))},key.token)).status,403);
    const content=body(reference('documentReference',own.id,'원문 스냅샷 이름'),details);
    const made=await f.call<DocPage>('/v1/documents','POST',{projectId:'project-neo',title:'자동화 문서',content},key.token);assert.equal(made.status,201,JSON.stringify(made.data));
    assert.equal((await f.call(`/documents/${own.id}?expectedVersion=1`,'DELETE')).status,200);
    const changed=await f.call<DocPage>(`/v1/documents/${made.data.id}`,'PATCH',{expectedVersion:made.data.version,content:body(p('기존 누락 링크 유지'),...content.content!)},key.token);assert.equal(changed.status,200,JSON.stringify(changed.data));assert.equal(contentReferences(changed.data.content)[0].id,own.id);
    const before=await snapshot(f);assert.equal((await f.call(`/v1/documents/${made.data.id}`,'PATCH',{expectedVersion:changed.data.version,content:body(reference('documentReference','new-missing','새 누락'))},key.token)).status,404);assert.deepEqual(await snapshot(f),before);
  }finally{await f.close();}
});

test('native schema7 restores macro JSON and CRDT state with missing targets; invalid cycles and downgraded headers leave data unchanged',async()=>{
  const f=await fixture();try{
    const legacy=(await f.call<Backup>('/export')).data;legacy.schemaVersion=6;
    const target=await make(f,'사라질 원문'),source=await make(f,'포함 기록',body(reference('documentInclude',target.id,'보관할 제목'),details));
    const enabled=(await f.call<CollaborationSession>(`/documents/${source.id}/collaboration/enable`,'POST',{expectedVersion:source.version})).data;
    await f.call(`/documents/${target.id}?expectedVersion=1`,'DELETE');
    const backup=(await f.call<Backup>('/export')).data;assert.equal(backup.schemaVersion,NATIVE_BACKUP_SCHEMA_VERSION);assert.equal(backup.collabStates.find(state=>state.documentId===source.id)!.schemaVersion,COLLABORATION_SCHEMA);
    const current=await snapshot(f),bad=structuredClone(backup);bad.documents.find(document=>document.id===source.id)!.content=body(reference('documentInclude',source.id,'순환'));
    assert.equal((await f.call('/import','POST',{data:bad})).status,422);assert.deepEqual(await snapshot(f),current);
    const downgraded={...backup,schemaVersion:6};assert.equal((await f.call('/import','POST',{data:downgraded})).status,400);assert.deepEqual(await snapshot(f),current);
    assert.equal((await f.call('/import','POST',{data:backup})).status,200);const restored=(await f.call<CollaborationSession>(`/documents/${source.id}/collaboration`)).data;assert.deepEqual(restored.document.content,enabled.document.content);assert.notEqual(restored.epoch,enabled.epoch);assert.ok(restored.document.version>enabled.document.version);
    assert.equal((await f.call('/import','POST',{data:legacy})).status,200);assert.equal((await snapshot(f)).documents.length,legacy.documents.length);
  }finally{await f.close();}
});

test('pinned includes keep one saved revision through live edits and trash, then keep a missing reference after purge',async()=>{
  const f=await fixture();
  try {
    const source=await make(f,'설계 승인 당시 제목',body(p('승인한 설계 본문')));
    const foreign=await make(f,'다른 프로젝트 문서',body(p('다른 문서 본문')),'project-team');
    const originals=(await f.call<DocRevision[]>(`/documents/${source.id}/revisions`)).data;
    const [approved]=originals;
    const [foreignRevision]=(await f.call<DocRevision[]>(`/documents/${foreign.id}/revisions`)).data;
    const definition=pinnedInclude(source.id,approved.id,approved.title);
    const hosted=await make(f,'설계 결정 기록',body(p('결정의 근거'),definition));
    assert.equal(documentContentSchemaVersion(hosted.content),5);
    assert.deepEqual(contentReferences(hosted.content),[{type:'document',kind:'include',id:source.id,revisionId:approved.id,label:approved.title}]);
    assert.match(hosted.plainText,new RegExp(approved.id));
    const detailPath=`/documents/${source.id}/include-revisions/${approved.id}`;

    for(const invalid of [pinnedInclude(source.id,foreignRevision.id,'다른 문서 버전'),pinnedInclude(source.id,'missing-revision','없는 버전')]){
      assert.equal((await f.call('/documents','POST',{projectId:'project-neo',title:'저장할 수 없는 문서',content:body(invalid)})).status,422);
    }
    const key=(await f.call<ApiKeyCreated>('/api-keys','POST',{name:'고정 버전 자동화 검증',access:'write',projectIds:['project-neo']})).data;
    assert.equal((await f.call('/v1'+detailPath,'GET',undefined,key.token)).status,403);
    assert.equal((await f.call('/v1/documents','POST',{projectId:'project-neo',title:'범위 밖 고정',content:body(pinnedInclude(foreign.id,foreignRevision.id,'외부'))},key.token)).status,403);
    assert.equal((await f.call(`/documents/${hosted.id}`,'PATCH',{expectedVersion:hosted.version,contentSchemaVersion:4,content:body(p('구형 편집기'))})).status,409);

    // A live inclusion may point back to the host. The pin displays a saved body instead of expanding a live cycle.
    const changed=await f.call<DocPage>(`/documents/${source.id}`,'PATCH',{
      expectedVersion:source.version,title:'수정한 제목',content:body(p('바뀐 본문'),reference('documentInclude',hosted.id,'결정 근거'),definition),
    });
    assert.equal(changed.status,200,JSON.stringify(changed.data));
    assert.deepEqual((await f.call<DocRevision>(detailPath)).data,approved);
    const deleted=await f.call<{trashEntryId:string}>(`/documents/${source.id}`,'DELETE',{expectedVersion:changed.data.version});
    assert.equal(deleted.status,200);
    assert.equal((await f.call(`/documents/${source.id}/include-revisions`)).status,404);
    assert.deepEqual((await f.call<DocRevision>(detailPath)).data,approved);
    assert.equal((await f.call(`/trash/${deleted.data.trashEntryId}`,'DELETE')).status,200);
    assert.equal((await f.call(detailPath)).status,404);
    const edit=await f.call<DocPage>(`/documents/${hosted.id}`,'PATCH',{
      expectedVersion:hosted.version,contentSchemaVersion:5,content:body(p('보관 기록에 추가'),definition),
    });
    assert.equal(edit.status,200,JSON.stringify(edit.data));
    assert.deepEqual(edit.data.content.content?.at(-1),definition);
    assert.equal((await f.call(`/documents/${hosted.id}`,'PATCH',{
      expectedVersion:edit.data.version,contentSchemaVersion:5,content:body(reference('documentInclude',source.id,'삭제된 실시간 원문')),
    })).status,422);
  } finally{await f.close();}
});

test('native schema 26 preserves pinned revisions and archived sources and rejects mismatched owners before replacing data',async()=>{
  const f=await fixture();
  try {
    const source=await make(f,'보관할 승인 문서',body(p('보관할 원문 내용')));
    const alternate=await make(f,'다른 원문');
    const originalImage=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8v8AAAAASUVORK5CYII=','base64');
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
    const upload=await fetch(f.base+`/attachments?resourceType=document&resourceId=${source.id}&filename=approved.png`,{
      method:'POST',headers:{'Content-Type':'application/octet-stream','X-Actor-Id':'user-min'},body:new Uint8Array(originalImage),
    });
    assert.equal(upload.status,201);
    const {id:attachmentRoot}=await upload.json() as {id:string};
    const appended=await fetch(f.base+`/attachments/${attachmentRoot}/versions?expectedVersionId=${attachmentRoot}&filename=approved-v2.png`,{
      method:'POST',headers:{'Content-Type':'application/octet-stream','X-Actor-Id':'user-min'},body:new Uint8Array(png),
    });
    assert.equal(appended.status,201);
    const {currentVersionId:attachmentId}=await appended.json() as {currentVersionId:string};
    assert.notEqual(attachmentId,attachmentRoot);
    const imageNode:RichContent={type:'image',attrs:{src:`/api/attachments/${attachmentId}/content?inline=1`,alt:'승인용 그림'}};
    const saved=await f.call<DocPage>(`/documents/${source.id}`,'PATCH',{
      expectedVersion:source.version,content:body(p('보관할 원문과 그림'),imageNode),
    });
    assert.equal(saved.status,200);
    assert.equal((await f.call(`/documents/${alternate.id}`,'PATCH',{expectedVersion:alternate.version,content:body(imageNode)})).status,200);
    const [wrong]=(await f.call<DocRevision[]>(`/documents/${alternate.id}/revisions`)).data;
    const [revision,earlier]=(await f.call<DocRevision[]>(`/documents/${source.id}/revisions`)).data;
    const imageRoute=(id:string,fileId=attachmentId)=>f.base+`/documents/${source.id}/include-revisions/${id}/images/${fileId}`;
    const checkImage=async()=>{
      const image=await fetch(imageRoute(revision.id));
      assert.equal(image.status,200);
      assert.equal(image.headers.get('Content-Type'),'image/png');
      assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
    };
    for(const path of [imageRoute(earlier.id),imageRoute(revision.id,attachmentRoot)]){
      const unreferenced=await fetch(path);
      assert.equal(unreferenced.status,404);
      await unreferenced.arrayBuffer();
    }
    await checkImage();
    const archiveImage=await f.call<{trashItemId:string}>(`/attachments/${attachmentRoot}?expectedVersionId=${attachmentId}`,'DELETE');
    assert.equal(archiveImage.status,200);
    assert.equal((await fetch(`${f.base}/attachments/${attachmentId}/content?inline=1`)).status,404);
    assert.equal((await fetch(imageRoute(earlier.id))).status,404);
    assert.equal((await fetch(`${f.base}/documents/${alternate.id}/include-revisions/${wrong.id}/images/${attachmentId}`)).status,404);
    await checkImage();
    assert.equal((await f.call(`/trash/items/${archiveImage.data.trashItemId}/restore`,'POST',{})).status,200);
    const direct=await fetch(`${f.base}/attachments/${attachmentId}/content?inline=1`);
    assert.equal(direct.status,200);
    assert.deepEqual(Buffer.from(await direct.arrayBuffer()),png);
    const content=body(pinnedInclude(source.id,revision.id,revision.title));
    const host=await make(f,'참조 버전이 고정된 문서',content);
    const enabled=await f.call<CollaborationSession>(`/documents/${host.id}/collaboration/enable`,'POST',{expectedVersion:host.version});
    assert.equal(enabled.status,200);
    const archival=await f.call<{trashEntryId:string}>(`/documents/${source.id}`,'DELETE',{expectedVersion:saved.data.version});
    assert.equal(archival.status,200);
    await checkImage();
    const backup=(await f.call<Backup & {revisions:DocRevision[]}>('/export')).data;
    assert.equal(backup.schemaVersion,NATIVE_BACKUP_SCHEMA_VERSION);
    const before=await snapshot(f);
    const damaged=structuredClone(backup);
    damaged.revisions.find(value=>value.documentId===host.id)!.content=body(pinnedInclude(source.id,wrong.id,'소유자가 다른 저장본'));
    const rejected=await f.call<{error:string}>('/import','POST',{data:damaged});
    assert.equal(rejected.status,422);
    assert.match(rejected.data.error,/해당 문서/u);
    const downgrade=await f.call<{error:string}>('/import','POST',{data:{...backup,schemaVersion:25}});
    assert.equal(downgrade.status,400);
    assert.match(downgrade.data.error,/schemaVersion 26/u);
    assert.deepEqual(await snapshot(f),before);

    assert.equal((await f.call('/import','POST',{data:backup})).status,200);
    const restored=(await f.call<CollaborationSession>(`/documents/${host.id}/collaboration`)).data;
    assert.equal(restored.schemaVersion,COLLABORATION_SCHEMA);
    assert.notEqual(restored.epoch,enabled.data.epoch);
    assert.deepEqual(restored.document.content,content);
    assert.deepEqual((await f.call<DocRevision>(`/documents/${source.id}/include-revisions/${revision.id}`)).data,revision);
    await checkImage();
    assert.equal((await f.call(`/trash/${archival.data.trashEntryId}/restore`,'POST')).status,200);
    assert.deepEqual((await f.call<DocRevision>(`/documents/${source.id}/include-revisions/${revision.id}`)).data,revision);
    const purgable=await f.call<{trashItemId:string}>(`/attachments/${attachmentRoot}`,'DELETE');
    assert.equal(purgable.status,200);
    await checkImage();
    assert.equal((await f.call(`/trash/items/${purgable.data.trashItemId}`,'DELETE')).status,200);
    assert.equal((await fetch(imageRoute(revision.id))).status,404);
  } finally{await f.close();}
});

test('document Markdown preserves reference destinations and folded content without expanding live includes',()=>{
  const content=body(reference('issueReference','ticket/a?b','업무 [검토]'),reference('documentReference','doc/a','원문'),reference('documentInclude','included','실시간 원문'),details);
  const markdown=contentMarkdown(content);assert.ok(markdown.includes('#/all/issues?issue=ticket%2Fa%3Fb'));assert.ok(markdown.includes('#/all/documents/doc%2Fa'));assert.ok(markdown.includes('문서 포함:'));assert.ok(markdown.includes('<details>'));assert.ok(markdown.includes('<summary><strong>검토 &lt;기준&gt;</strong></summary>'));assert.ok(markdown.includes('접혀 있어도 보존할 결정'));assert.equal(contentReferences(content).length,3);assert.ok(contentText(content).includes('included'));
  assert.equal(contentText(body(p('마지막 공백  '))),'마지막 공백  ');assert.equal(contentText(body(p('원문'),{type:'paragraph'})),'원문\n');
  const heading = (level: number, value: string, sectionId?: string): RichContent => ({
    type: 'heading', attrs: { level, ...(sectionId ? { sectionId } : {}) }, content: [{ type: 'text', text: value }],
  });
  const navigation = body({ type: 'documentToc', attrs: { minLevel: 2, maxLevel: 2, layout: 'flat' } },
    heading(1, '범위 밖', 'teamspace-toc-1'), heading(2, '검토 [대상]'), heading(2, '검토 [대상]', 'existing-id'));
  const exported = contentMarkdown(navigation);
  assert.ok(exported.includes('[검토 \\[대상\\]](#teamspace-toc-2) · [검토 \\[대상\\]](#existing-id)'));
  assert.ok(exported.includes('<a id="teamspace-toc-2"></a>'));
  assert.ok(exported.includes('<a id="existing-id"></a>'));
  assert.ok(!exported.includes('[범위 밖]'));
});

test('document issue lists retain stable project and view identifiers and enforce automation project scope', async () => {
  const f = await fixture();
  try {
    const createView = async (projectId: string) => {
      const result = await f.call<SavedView>('/views', 'POST', {
        projectId, name:'합성 저장 보기', layout:'list', filters:{query:'계획',status:'all',assigneeId:'all',type:'all'},
      });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      return result.data;
    };
    const own = await createView('project-neo');
    const foreign = await createView('project-team');
    const key = (await f.call<ApiKeyCreated>('/api-keys', 'POST', {
      name:'업무 목록 범위 검증',access:'write',projectIds:[own.projectId],expiresAt:null,
    })).data;
    const definition = issueList(own.projectId, own.id, '저장한 목록 이름');
    const valid = await f.call<DocPage>('/v1/documents', 'POST', {
      projectId:own.projectId,title:'업무 목록 자동화 문서',content:body(definition),
    }, key.token);
    assert.equal(valid.status, 201, JSON.stringify(valid.data));
    assert.deepEqual(valid.data.content, body(definition));
    assert.match(valid.data.plainText, /저장한 목록 이름/);
    assert.match(contentMarkdown(valid.data.content), /저장한 목록 이름/);
    assert.deepEqual(contentReferences(valid.data.content), []);

    const before = await snapshot(f);
    for (const invalid of [issueList(own.projectId, foreign.id, '다른 프로젝트 보기'), issueList(own.projectId, 'missing-view', '없는 보기'), issueList('missing-project', null, '없는 프로젝트')]) {
      assert.equal((await f.call('/documents', 'POST', {projectId:own.projectId,title:'잘못된 업무 목록',content:body(invalid)})).status, 422);
    }
    for (const scoped of [issueList(foreign.projectId, foreign.id, '다른 프로젝트'), issueList(foreign.projectId, null, '다른 프로젝트 전체')]) {
      assert.equal((await f.call('/v1/documents', 'POST', {projectId:own.projectId,title:'범위 밖 업무 목록',content:body(scoped)}, key.token)).status, 403);
    }
    assert.deepEqual(await snapshot(f), before);
    assert.equal((await f.call(`/views/${own.id}?expectedVersion=${own.version}`, 'DELETE')).status, 200);
    const changed = await f.call<DocPage>(`/v1/documents/${valid.data.id}`, 'PATCH', {
      expectedVersion:valid.data.version, content:body(p('문서 설명 추가'), definition),
    }, key.token);
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    assert.deepEqual(changed.data.content.content?.at(-1), definition);
    assert.equal((await f.call('/documents', 'POST', {projectId:own.projectId,title:'새로 추가한 삭제된 보기',content:body(definition)})).status, 422);
    assert.equal((await f.call(`/v1/documents/${valid.data.id}`, 'PATCH', {
      expectedVersion:changed.data.version,content:body(p('이전 편집기가 목록을 누락한 본문')),
    }, key.token)).status, 409);
    const metadata = await f.call<DocPage>(`/documents/${valid.data.id}`, 'PATCH', {expectedVersion:changed.data.version,title:'속성만 수정'});
    assert.equal(metadata.status, 200);
    assert.deepEqual(metadata.data.content, changed.data.content);
  } finally { await f.close(); }
});

test('native backup protects document issue lists in history and trash and restores their definitions', async () => {
  const f = await fixture();
  try {
    const definition = issueList('project-neo', null, '버전에 고정한 목록');
    const source = await make(f, '목록이 남은 역사', body(p('목록 설명'), definition));
    const changed = await f.call<DocPage>(`/documents/${source.id}`, 'PATCH', {expectedVersion:source.version,contentSchemaVersion:3,content:body(p('최근 본문'))});
    assert.equal(changed.status, 200);
    const before = await snapshot(f);
    const live = (await f.call<Backup>('/export')).data;
    assert.equal(live.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    assert.equal((await f.call('/import', 'POST', {data:{...live,schemaVersion:19}})).status, 400);
    assert.deepEqual(await snapshot(f), before);

    const removed = await f.call<{trashEntryId:string}>(`/documents/${source.id}?expectedVersion=${changed.data.version}`, 'DELETE');
    assert.equal(removed.status, 200);
    const archived = (await f.call<Backup>('/export')).data;
    assert.equal((await f.call('/import', 'POST', {data:{...archived,schemaVersion:19}})).status, 400);
    assert.equal((await f.call('/import', 'POST', {data:archived})).status, 200);
    assert.equal((await f.call(`/trash/${removed.data.trashEntryId}/restore`, 'POST', {})).status, 200);
    const current = (await snapshot(f)).documents.find(value => value.id === source.id)!;
    assert.equal(current.plainText, '최근 본문');
    const revisions = (await f.call<DocRevision[]>(`/documents/${current.id}/revisions`)).data;
    const revision = revisions.find(value => value.content.content?.some(node => node.type === 'issueList'));
    assert.ok(revision);
    const restored = await f.call<DocPage>(`/documents/${current.id}/restore`, 'POST', {revisionId:revision.id,expectedVersion:current.version});
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.deepEqual(restored.data.content, source.content);
  } finally { await f.close(); }
});

test('issue summaries enforce grouping, saved view membership and automation scope without losing historical definitions', async () => {
  const f = await fixture();
  try {
    async function makeView(projectId: string) {
      const result = await f.call<SavedView>('/views', 'POST', {
        projectId, name:'문서 현황용 보기', layout:'list', filters:{query:'현황',status:'all',assigneeId:'all',type:'all'},
      });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      return result.data;
    }
    const own = await makeView('project-neo');
    const other = await makeView('project-team');
    const key = (await f.call<ApiKeyCreated>('/api-keys', 'POST', {
      name:'업무 현황 범위 검증', access:'write', projectIds:[own.projectId], expiresAt:null,
    })).data;
    const definition = issueSummary(own.projectId, own.id, 'assignee');
    const list = issueList(own.projectId, own.id, '동일 보기를 사용하는 업무 목록');
    const source = await make(f, '팀 회의록', body(definition));
    const listSource = await make(f, '목록만 있던 문서', body(list));
    assert.deepEqual(source.content, body(definition));
    assert.equal(documentContentSchemaVersion(source.content), 4);
    assert.equal(documentContentSchemaVersion(listSource.content), 3);
    assert.deepEqual(contentReferences(source.content), []);
    assert.match(source.plainText, /회의에서 볼 현황/);
    assert.match(contentMarkdown(source.content), /회의에서 볼 현황/);

    const before = await snapshot(f);
    for (const invalid of [
      issueSummary(own.projectId, other.id, 'status'),
      issueSummary(own.projectId, 'missing-view', 'status'),
      issueSummary('missing-project', null, 'status'),
      issueSummary(own.projectId, own.id, 'unsupported'),
    ]) {
      const response = await f.call('/documents', 'POST', {projectId:own.projectId,title:'잘못된 업무 현황',content:body(invalid)});
      assert.equal(response.status, 422, JSON.stringify(response.data));
    }
    const tooMany = body(...Array.from({length:30}, () => list), definition);
    assert.equal((await f.call('/documents', 'POST', {projectId:own.projectId,title:'혼합 블록 한도',content:tooMany})).status, 422);
    const outside = issueSummary(other.projectId, other.id, 'priority');
    assert.equal((await f.call('/v1/documents', 'POST', {projectId:own.projectId,title:'키 범위 밖 집계',content:body(outside)}, key.token)).status, 403);
    const replace = {expectedVersion:source.version,content:body(p('이전 편집기가 집계를 누락한 본문')),contentSchemaVersion:3};
    assert.equal((await f.call(`/v1/documents/${source.id}`, 'PATCH', replace, key.token)).status, 409);
    assert.deepEqual(await snapshot(f), before);

    const mixedScope = await make(f, '다른 프로젝트의 집계를 담은 문서', body(outside));
    const visible = (await f.call<DocPage[]>('/v1/documents', 'GET', undefined, key.token)).data;
    assert.ok(visible.some(document => document.id === source.id));
    assert.ok(visible.every(document => document.id !== mixedScope.id));
    assert.equal((await f.call(`/v1/documents/${mixedScope.id}`, 'GET', undefined, key.token)).status, 403);
    assert.equal((await f.call(`/v1/documents/${mixedScope.id}`, 'PATCH', {
      expectedVersion:mixedScope.version,title:'외부 키가 수정할 수 없는 문서',
    }, key.token)).status, 403);
    const publication = `/documents/${mixedScope.id}/publication`;
    const initial = (await f.call<DocumentPublicationView>(publication)).data;
    const submitted = await f.call<DocumentPublicationView>(publication, 'POST', {
      action:'request', expectedVersion:initial.version, workspaceGeneration:initial.workspaceGeneration,
      expectedDocumentVersion:mixedScope.version, reviewerId:'user-seo',
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
    assert.ok(submitted.data.review);
    assert.equal((await f.call(`/documents/${mixedScope.id}`, 'PATCH', {
      expectedVersion:mixedScope.version,contentSchemaVersion:4,content:body(p('같은 프로젝트에서 조회할 본문')),
    })).status, 200);
    const visibleHistory = (await f.call<DocRevision[]>(`/v1/documents/${mixedScope.id}/revisions`, 'GET', undefined, key.token)).data;
    assert.equal(visibleHistory.length, 1);
    assert.equal(visibleHistory[0].plainText, '같은 프로젝트에서 조회할 본문');
    const reviewerKey = (await f.call<ApiKeyCreated>('/api-keys', 'POST', {
      name:'다른 프로젝트 집계 검토 키', access:'write', projectIds:[own.projectId], expiresAt:null,
    }, undefined, 'user-seo')).data;
    const frozen = `${publication}/snapshot?kind=review&revisionId=${submitted.data.review.revisionId}`;
    assert.equal((await f.call(frozen)).status, 200);
    assert.equal((await f.call(`/v1${frozen}`, 'GET', undefined, reviewerKey.token)).status, 403);
    assert.equal((await f.call(`/v1${publication}`, 'POST', {
      action:'publish', expectedVersion:submitted.data.version, workspaceGeneration:submitted.data.workspaceGeneration,
    }, reviewerKey.token)).status, 403);
    assert.ok((await f.call<DocumentPublicationView>(publication)).data.review);

    assert.equal((await f.call(`/views/${own.id}?expectedVersion=${own.version}`, 'DELETE')).status, 200);
    const existing = await f.call<DocPage>(`/v1/documents/${source.id}`, 'PATCH', {
      expectedVersion:source.version, contentSchemaVersion:4, content:body(p('다음 회의 준비'), definition),
    }, key.token);
    assert.equal(existing.status, 200, JSON.stringify(existing.data));
    assert.deepEqual(existing.data.content.content?.at(-1), definition);
    assert.equal((await f.call(`/documents/${listSource.id}`, 'PATCH', {
      expectedVersion:listSource.version, contentSchemaVersion:4, content:body(list, definition),
    })).status, 422);
    const intentional = await f.call<DocPage>(`/documents/${source.id}`, 'PATCH', {
      ...replace, expectedVersion:existing.data.version, contentSchemaVersion:4, content:body(p('집계를 제거한 회의록')),
    });
    assert.equal(intentional.status, 200, JSON.stringify(intentional.data));
    assert.equal(intentional.data.plainText, '집계를 제거한 회의록');
  } finally { await f.close(); }
});

test('native schema22 preserves issue summaries in active bodies, revisions and trash and rejects misleading legacy headers', async () => {
  const f = await fixture();
  try {
    const legacy = {...(await f.call<Backup>('/export')).data,schemaVersion:21};
    assert.equal((await f.call('/import', 'POST', {data:legacy})).status, 200);
    const definition = issueSummary('project-neo', null, 'priority');
    const source = await make(f, '현황을 기록한 회의록', body(p('검토할 범위'), definition));
    const active = (await f.call<Backup>('/export')).data;
    assert.equal(active.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    assert.equal((await f.call('/import', 'POST', {data:{...active,schemaVersion:21}})).status, 400);

    const changed = await f.call<DocPage>(`/documents/${source.id}`, 'PATCH', {
      expectedVersion:source.version, contentSchemaVersion:4, content:body(p('현황을 정리한 회의록')),
    });
    assert.equal(changed.status, 200);
    const revisionsOnly = (await f.call<Backup>('/export')).data;
    assert.equal((await f.call('/import', 'POST', {data:{...revisionsOnly,schemaVersion:21}})).status, 400);

    const deleted = await f.call<{trashEntryId:string}>(`/documents/${source.id}?expectedVersion=${changed.data.version}`, 'DELETE');
    assert.equal(deleted.status, 200);
    const trashOnly = (await f.call<Backup>('/export')).data;
    const before = await snapshot(f);
    assert.equal((await f.call('/import', 'POST', {data:{...trashOnly,schemaVersion:21}})).status, 400);
    assert.deepEqual(await snapshot(f), before);
    assert.equal((await f.call('/import', 'POST', {data:trashOnly})).status, 200);
    assert.equal((await f.call(`/trash/${deleted.data.trashEntryId}/restore`, 'POST', {})).status, 200);
    const current = (await snapshot(f)).documents.find(document => document.id === source.id)!;
    const revisions = (await f.call<DocRevision[]>(`/documents/${current.id}/revisions`)).data;
    const revision = revisions.find(value => value.content.content?.some(node => node.type === 'issueSummary'));
    assert.ok(revision);
    const restored = await f.call<DocPage>(`/documents/${current.id}/restore`, 'POST', {
      revisionId:revision.id, expectedVersion:current.version,
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.deepEqual(restored.data.content, source.content);
  } finally { await f.close(); }
});
