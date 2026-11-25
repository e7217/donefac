import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import { documentNodes } from '../../shared/document-references.js';
import type { LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, SourceRecordArchive, SourceRecordPage, WorkspaceSnapshot } from '../../shared/types.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const property = (name: string, value: string) => `<property name="${name}">${value}</property>`;
const reference = (name: string, type: string, id: string) => `<property name="${name}" class="${type}"><id name="id">${id}</id></property>`;
const entity = (type: string, id: string, body: string) => `<object class="${type}"><id name="id">${id}</id>${body}</object>`;
const created = property('creationDate', '2020-04-01T00:00:00Z');
const page = (id: string, name: string) => entity('Page', id, property('title', name) + property('version', '1') +
  reference('space', 'Space', '42') + created + property('lastModificationDate', '2020-04-02T00:00:00Z'));
const file = (id: string, owner: string, version: string, history = '') => entity('Attachment', id,
  property('title', 'guide.pdf') + property('version', version) + reference('containerContent', 'Page', owner) + created + history);
const previewMacro = (filename: string, id?: string, owner?: string) => `<ac:structured-macro ac:name="viewpdf"><ac:parameter ac:name="name">` +
  `<ri:attachment ri:filename="${filename}"${id ? ` ri:content-id="${id}"` : ''}>${owner ? `<ri:content-entity ri:content-id="${owner}"/>` : ''}</ri:attachment>` +
  '</ac:parameter></ac:structured-macro>';

test('a real Confluence ZIP keeps exact file-preview download bytes and rejects conflicting owner and name evidence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-confluence-file-preview-'));
  const runtime = createApp({ dataDir: directory, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const actor = { 'X-Actor-Id': 'user-seo' };
  async function request<T>(path: string, status = 200, method = 'GET', body?: unknown) {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { ...actor, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${data}`);
    return JSON.parse(data) as T;
  }

  const sourceTitle = '파일을 연결한 원본';
  const storage = `<p>가이드 앞의 문장</p>${previewMacro('guide.pdf')}${previewMacro('guide.pdf', '721', '200')}` +
    previewMacro('guide.pdf', '700', '200') + previewMacro('other.pdf', '720', '200') + '<p>가이드 뒤의 문장</p>';
  const xml = `<hibernate-generic>${[
    entity('Space', '42', property('key', 'FILES') + property('name', '배포 자료')),
    page('100', sourceTitle), page('200', '다른 소유 문서'),
    entity('ContentPermissionSet', '900', property('type', 'Edit') + reference('owningContent', 'Page', '100')),
    entity('BodyContent', '500', property('body', `<![CDATA[${storage}]]>`) + reference('content', 'Page', '100')),
    file('700', '100', '1'),
    file('720', '200', '2', '<collection name="historicalVersions"><element class="Attachment"><id name="id">721</id></element></collection>'),
    file('721', '200', '1', reference('originalVersion', 'Attachment', '720')),
  ].join('')}</hibernate-generic>`;
  const local = Buffer.from('%PDF-1.4\n%Local\0\n'), remoteOld = Buffer.from('%PDF-1.4\n%Old\0\n'), remoteNew = Buffer.from('%PDF-1.4\n%New\0\n');
  const archive = zip([
    { path: 'entities.xml', bytes: Buffer.from(xml) }, { path: 'attachments/100/700/1', bytes: local },
    { path: 'attachments/200/720/1', bytes: remoteOld }, { path: 'attachments/200/720/2', bytes: remoteNew },
  ]);
  const query = new URLSearchParams({ filename: 'preview-attachments.zip', product: 'confluence', instanceKey: 'confluence-preview-test' });
  const upload = await fetch(`${origin}/api/legacy-import/packages?${query}`, { method: 'POST', body: new Uint8Array(archive),
    headers: { ...actor, 'Content-Type': 'application/octet-stream' } });
  assert.equal(upload.status, 201);
  const { id } = await upload.json() as LegacyPackageSummary;
  const { defaultConfiguration: configuration } = await request<MigrationOptions>(`/migrations/options?packageId=${id}`);
  const preview = await request<MigrationPreview>('/migrations/preview', 201, 'POST', { configuration });
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  for (const code of ['CONFLUENCE_FILE_PREVIEW_LINKED', 'UNRESOLVED_CONFLUENCE_FILE_PREVIEW']) {
    assert.ok(preview.notices.some(notice => notice.code === code && notice.recordId === `${id}/page:100`), code);
  }
  const editRestriction = 'SOURCE_CONFLUENCE_EDIT_RESTRICTION_REVIEW';
  assert.ok(preview.notices.some(notice => notice.code === editRestriction && notice.recordId === `${id}/page:100` &&
    notice.severity === 'warning' && notice.requiresAcknowledgement));
  assert.ok(preview.requiredAcknowledgements.includes(editRestriction));
  await request(`/migrations/previews/${preview.id}/apply`, 400, 'POST', { expectedVersion: preview.version,
    acknowledgements: preview.requiredAcknowledgements.filter(code => code !== editRestriction) });
  const { import: receipt } = await request<MigrationApplyResult>(`/migrations/previews/${preview.id}/apply`, 201, 'POST', {
    expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements,
  });
  const { records } = await request<SourceRecordPage>(`/source-imports/${receipt.id}/records`);
  const original = records.find(row => row.record.id === 'page:100');
  const otherPage = records.find(row => row.record.id === 'page:200');
  const localFile = records.find(row => row.record.id === 'attachment:700');
  const oldFile = records.find(row => row.record.id === 'attachment:721');
  const latestFile = records.find(row => row.record.id === 'attachment:720');
  assert.ok(original?.targetId && otherPage?.targetId && localFile?.targetId && oldFile?.targetId && latestFile?.targetId);
  const permission = records.find(row => row.record.id === 'relation:ContentPermissionSet:900');
  assert.ok(permission);
  const archived = (recordId: string) => request<SourceRecordArchive>(`/source-imports/${receipt.id}/records/${recordId}`);
  assert.deepEqual((await archived(original.id)).record.metadata.editPermissionSetIds, ['900']);
  assert.equal((await archived(permission.id)).record.metadata.type, 'Edit');
  assert.equal(localFile.ownerId, original.targetId);
  assert.equal(oldFile.ownerId, otherPage.targetId);
  assert.notEqual(oldFile.targetId, latestFile.targetId);
  const { documents } = await request<WorkspaceSnapshot>('/workspace');
  const document = documents.find(item => item.id === original.targetId);
  assert.equal(document?.title, sourceTitle);
  assert.ok(document?.projectId && receipt.projectIds.includes(document.projectId));
  const nodes = [...documentNodes(document.content)];
  const marks = nodes.flatMap(node => (node.marks ?? []).filter(mark => mark.type === 'link').map(mark => [node.text, mark.attrs?.href]));
  const filePath = (targetId: string) => `/api/attachments/${targetId}/content`;
  assert.deepEqual(marks, [['guide.pdf', filePath(localFile.targetId)], ['guide.pdf', filePath(oldFile.targetId)]]);
  const fallbacks = nodes.filter(node => node.type === 'codeBlock').map(node => node.content?.[0]?.text ?? '');
  assert.equal(fallbacks.length, 2);
  assert.match(fallbacks[0], /ri:content-id="700".*ri:content-id="200"/u);
  assert.match(fallbacks[1], /ri:filename="other\.pdf".*ri:content-id="720"/u);
  assert.equal(document.content.content?.[0].content?.[0].text, '가이드 앞의 문장');
  assert.equal(document.content.content?.at(-1)?.content?.[0].text, '가이드 뒤의 문장');
  for (const [targetId, bytes] of [[localFile.targetId, local], [oldFile.targetId, remoteOld]] as const) {
    const fileResponse = await fetch(origin + filePath(targetId));
    assert.equal(fileResponse.status, 200);
    assert.match(fileResponse.headers.get('content-disposition') ?? '', /^attachment; /u);
    assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()), bytes);
  }
});
