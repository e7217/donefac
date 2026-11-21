import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import { prepareMarkdownArchive } from '../../server/markdown-archive-content.js';
import { documentNodes } from '../../shared/document-references.js';
import { documentSectionHash } from '../../shared/document-sections.js';
import type { DocumentMarkdownArchivePreview, DocumentMarkdownArchiveResult } from '../../shared/document-markdown-archive.js';
import type { Attachment, DocPage, WorkspaceSnapshot } from '../../shared/types.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

test('Docmost Markdown ZIP imports nested pages and routes links to new sections and exact local image bytes', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-markdown-archive-http-'));
  const service = createApp({ dataDir, seed: true, outboundWorker: false, deadlineReminderWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    service.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const actorId = 'user-min';
  const state = async () => (await fetch(`${url}/workspace`)).json() as Promise<WorkspaceSnapshot>;
  const { documents: before } = await state();
  const owner = 'bef3e8ca-879a-4ad4-a895-f165b6e71183';
  const prefix = encodeURIComponent('팀 문서');
  const pageMetadata = {
    source: 'docmost', version: '0.98.0',
    pages: {
      [`${prefix}.md`]: { parentPath: null, position: 'a0', icon: '🛠️' },
      [`${prefix}/${encodeURIComponent('설정 %')}.md`]: { parentPath: `${prefix}.md`, position: 'a0', icon: null },
    },
  };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xbs8AAAAASUVORK5CYII=', 'base64');
  const bundle = zip([
    { path: '팀 문서.md', bytes: Buffer.from(`# 팀 문서\n\n[새 문서 절](${prefix}/${encodeURIComponent('설정 %')}.md#${encodeURIComponent('설치')})`) },
    { path: '팀 문서/설정 %.md', bytes: Buffer.from(`# 설정 %\n\n## 설치\n\n[상위 문서](../${prefix}.md)\n\n![장비](files/${owner}/장비.png)`) },
    { path: '팀 문서//files/' + owner + '/장비.png', bytes: png },
    { path: 'unrelated.txt', bytes: Buffer.from('not referenced') },
    { path: 'docmost-metadata.json', bytes: Buffer.from(JSON.stringify(pageMetadata)) },
  ]);
  const upload = (path: string, actor = actorId) => fetch(`${url}/document-markdown-import/${path}`, {
    method: 'POST', headers: { 'X-Actor-Id': actor, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bundle),
  });

  const previewResponse = await upload('preview?projectId=&parentId=');
  assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json() as DocumentMarkdownArchivePreview;
  assert.equal(preview.format, 'docmost');
  assert.deepEqual(preview.pages, [
    { path: '팀 문서.md', parentPath: null, title: '팀 문서', attachmentCount: 0 },
    { path: '팀 문서/설정 %.md', parentPath: '팀 문서.md', title: '설정 %', attachmentCount: 1 },
  ]);
  assert.equal(preview.attachmentCount, 1);
  assert.ok(preview.warnings.some(warning => warning.path === 'unrelated.txt'));
  assert.deepEqual((await state()).documents, before);

  const applyPath = `apply?previewId=${preview.id}`;
  assert.equal((await upload(applyPath, 'user-seo')).status, 404);
  const applied = await upload(applyPath);
  assert.equal(applied.status, 201, await applied.clone().text());
  const result = await applied.json() as DocumentMarkdownArchiveResult;
  assert.equal(result.duplicate, false);
  assert.equal(result.attachmentCount, 1);
  const [rootId, childId] = result.documentIds;
  assert.deepEqual(result.rootIds, [rootId]);
  const retry = await upload(applyPath);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { ...result, duplicate: true });

  async function check(imported: DocPage[]) {
    const root = imported.find(document => document.id === rootId)!;
    const child = imported.find(document => document.id === childId)!;
    assert.equal(root.projectId, null);
    assert.equal(root.parentId, null);
    assert.equal(root.icon, '🛠️');
    assert.equal(child.parentId, root.id);
    for (const document of [root, child]) {
      assert.equal(document.authorId, actorId);
      assert.equal(document.status, 'draft');
    }
    const [attachment] = await (await fetch(`${url}/attachments?resourceType=document&resourceId=${childId}`)).json() as Attachment[];
    assert.equal(attachment.filename, '장비.png');
    assert.equal(attachment.mimeType, 'image/png');
    const imageSrc = `/api/attachments/${attachment.id}/content?inline=1`;
    const downloaded = await fetch(new URL(imageSrc, url));
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
    const childNodes = [...documentNodes(child.content)];
    const section = childNodes.find(node => node.type === 'heading' && node.content?.[0]?.text === '설치');
    assert.ok(section?.attrs?.sectionId);
    assert.ok(childNodes.some(node => node.type === 'image' && node.attrs?.src === imageSrc));
    assert.ok(childNodes.flatMap(node => node.marks ?? []).some(mark => mark.attrs?.href === `#/all/documents/${rootId}`));
    const rootLinks = [...documentNodes(root.content)].flatMap(node => node.marks ?? []);
    assert.ok(rootLinks.some(mark => mark.attrs?.href === documentSectionHash(childId, String(section.attrs!.sectionId))));
  }

  await check((await state()).documents);
  const revisions = await (await fetch(`${url}/documents/${childId}/revisions`)).json() as { version: number; summary: string }[];
  assert.ok(revisions.some(row => row.version === 1 && row.summary === 'Markdown ZIP 가져오기'));
  const nativeZip = await fetch(`${url}/document-exports/markdown.zip?scope=subtree&source=saved&documentId=${rootId}`);
  assert.equal(nativeZip.status, 200);
  const remapped = await prepareMarkdownArchive(Buffer.from(await nativeZip.arrayBuffer()), {
    actorId, projectId: 'project-team', parentId: null, timestamp: new Date().toISOString(),
  });
  const [nextRoot, nextChild] = remapped.documents;
  assert.equal(remapped.format, 'teamspace');
  assert.notEqual(nextChild.id, childId);
  assert.equal(nextChild.parentId, nextRoot.id);
  const nextSection = [...documentNodes(nextChild.content)].find(node => node.type === 'heading' && node.content?.[0]?.text === '설치');
  assert.ok(nextSection?.attrs?.sectionId);
  assert.ok([...documentNodes(nextRoot.content)].flatMap(node => node.marks ?? []).some(mark =>
    mark.attrs?.href === documentSectionHash(nextChild.id, String(nextSection.attrs!.sectionId), 'project-team')));
  assert.equal(remapped.attachments.length, 1);
  assert.deepEqual(remapped.attachments[0].bytes, png);
  assert.ok(!nextChild.plainText.includes('첨부파일'));
  const exported = await fetch(`${url}/export`);
  assert.equal(exported.status, 200, await exported.clone().text());
  const data = await exported.json();
  const restored = await fetch(`${url}/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
  });
  assert.equal(restored.status, 200, await restored.text());
  await check((await state()).documents);
  assert.equal((await upload(applyPath)).status, 404);
});
