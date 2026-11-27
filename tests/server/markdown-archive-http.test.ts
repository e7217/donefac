import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { prepareMarkdownArchive } from '../../server/markdown-archive-content.js';
import { documentNodes } from '../../shared/document-references.js';
import { documentSectionHash } from '../../shared/document-sections.js';
import type { DocumentMarkdownArchivePreview, DocumentMarkdownArchiveResult } from '../../shared/document-markdown-archive.js';
import type { Attachment, DocPage, RichContent, WorkspaceSnapshot } from '../../shared/types.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

async function archiveServer(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-markdown-archive-http-'));
  const service = createApp({ dataDir, seed: true, outboundWorker: false, deadlineReminderWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    service.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

test('Docmost Markdown ZIP imports nested pages and routes links to new sections and exact local image bytes', async t => {
  const url = await archiveServer(t);
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
  assert.equal(remapped.format, 'donefac');
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

test('Donefac Markdown ZIP restores editable merged tables with rich cells and remaps their links and files', async t => {
  const url = await archiveServer(t);
  const actorId = 'user-min';
  const actorHeaders = { 'X-Actor-Id': actorId };
  const jsonHeaders = { ...actorHeaders, 'Content-Type': 'application/json' };
  const uploadHeaders = { ...actorHeaders, 'Content-Type': 'application/octet-stream' };
  const projectId = 'project-team';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xbs8AAAAASUVORK5CYII=', 'base64');
  const text = (value: string, marks?: RichContent['marks']): RichContent =>
    ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
  const paragraph = (...content: RichContent[]): RichContent => ({ type: 'paragraph', content });
  const row = (...content: RichContent[]): RichContent => ({ type: 'tableRow', content });
  const cell = (type: 'tableCell' | 'tableHeader', content: RichContent[], attrs?: RichContent['attrs']): RichContent =>
    ({ type, content, ...(attrs ? { attrs } : {}) });
  const doc = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
  async function read<T>(response: Response, status: number): Promise<T> {
    assert.equal(response.status, status, await response.clone().text());
    return await response.json() as T;
  }
  async function create(title: string, content: RichContent, parentId: string | null = null) {
    return read<DocPage>(await fetch(`${url}/documents`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title, content, projectId, parentId }),
    }), 201);
  }

  const source = await create('운영 가이드', doc(paragraph(text('초기 본문'))));
  const originalSectionId = 'install-guide';
  const originalCellSectionId = 'deployment-table';
  const child = await create('설치 안내', doc({
    type: 'heading', attrs: { level: 2, sectionId: originalSectionId }, content: [text('설치 순서')],
  }, paragraph(text('표 안의 절로 이동', [
    { type: 'link', attrs: { href: documentSectionHash(source.id, originalCellSectionId, projectId) } },
  ]))), source.id);
  const params = new URLSearchParams({ resourceType: 'document', resourceId: source.id, filename: '설치 화면.png' });
  const image = await read<Attachment>(await fetch(`${url}/attachments?${params}`, {
    method: 'POST', headers: uploadHeaders, body: new Uint8Array(png),
  }), 201);
  const content = doc(
    paragraph(text('표 앞 문장')),
    { type: 'table', content: [
      row(cell('tableHeader', [paragraph(text('병합 머리글'))], { colspan: 2, rowspan: 2, align: 'center' }),
        cell('tableCell', [paragraph(text('첫 행 일반 칸'))])),
      row(cell('tableCell', [
        { type: 'heading', attrs: { level: 3, sectionId: originalCellSectionId }, content: [text('표 안의 절')] },
        paragraph(text('강조 결정', [{ type: 'bold' }])),
        paragraph(text('둘째 문단', [{ type: 'italic' }]), text(' 태그 <장비> & 값')),
        { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('셀 안의 목록'))] }] },
        { type: 'image', attrs: { src: `/api/attachments/${image.id}/content?inline=1`, alt: '설치 화면' } },
      ])),
      row(cell('tableHeader', [paragraph(text('행 머리글'))]), cell('tableCell', [
        paragraph(text('다른 문서 절', [{ type: 'link', attrs: { href: documentSectionHash(child.id, originalSectionId, projectId) } }])),
      ], { colspan: 2, align: 'right' })),
    ] },
    paragraph(text('표 뒤 문장')),
  );
  await read<DocPage>(await fetch(`${url}/documents/${source.id}`, {
    method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ expectedVersion: source.version, content }),
  }), 200);
  const exported = await fetch(`${url}/document-exports/markdown.zip?${new URLSearchParams({
    scope: 'subtree', source: 'saved', documentId: source.id,
  })}`);
  assert.equal(exported.status, 200);
  const bundle = new Uint8Array(await exported.arrayBuffer());
  const upload = (path: string) => fetch(`${url}/document-markdown-import/${path}`, {
    method: 'POST', headers: uploadHeaders, body: bundle,
  });
  const preview = await read<DocumentMarkdownArchivePreview>(await upload('preview?projectId=&parentId='), 200);
  assert.equal(preview.format, 'donefac');
  assert.equal(preview.attachmentCount, 1);
  assert.deepEqual(preview.warnings, []);
  const result = await read<DocumentMarkdownArchiveResult>(await upload(`apply?previewId=${preview.id}`), 201);
  const [rootId, childId] = result.documentIds;
  const workspace = await read<WorkspaceSnapshot>(await fetch(`${url}/workspace`), 200);
  const root = workspace.documents.find(item => item.id === rootId);
  const importedChild = workspace.documents.find(item => item.id === childId);
  assert.ok(root);
  assert.ok(importedChild);
  assert.equal(importedChild.parentId, root.id);
  assert.notEqual(importedChild.id, child.id);
  assert.deepEqual(root.content.content?.map(node => node.type), ['paragraph', 'table', 'paragraph']);
  const table = root.content.content?.[1];
  const [firstRow, secondRow, thirdRow] = table?.content ?? [];
  assert.deepEqual(table?.content?.map(item => item.content?.map(node => node.type)), [
    ['tableHeader', 'tableCell'], ['tableCell'], ['tableHeader', 'tableCell'],
  ]);
  assert.equal(firstRow.content?.[0].attrs?.colspan, 2);
  assert.equal(firstRow.content?.[0].attrs?.rowspan, 2);
  assert.equal(firstRow.content?.[0].attrs?.align, 'center');
  assert.equal(thirdRow.content?.[1].attrs?.colspan, 2);
  assert.equal(thirdRow.content?.[1].attrs?.align, 'right');
  const richCell = secondRow.content![0];
  assert.deepEqual(richCell.content?.map(node => node.type), ['heading', 'paragraph', 'paragraph', 'bulletList', 'image']);
  assert.deepEqual(richCell.content?.[1].content?.[0].marks, [{ type: 'bold' }]);
  assert.deepEqual(richCell.content?.[2].content?.[0].marks, [{ type: 'italic' }]);
  const cellSection = richCell.content?.[0].attrs?.sectionId;
  assert.ok(cellSection);
  assert.ok([...documentNodes(importedChild.content)].flatMap(node => node.marks ?? []).some(mark =>
    mark.attrs?.href === documentSectionHash(rootId, String(cellSection))));
  const order = ['표 앞 문장', '병합 머리글', '첫 행 일반 칸', '표 안의 절', '강조 결정', '둘째 문단', '태그 <장비> & 값',
    '셀 안의 목록', '행 머리글', '다른 문서 절', '표 뒤 문장'];
  let previous = -1;
  for (const phrase of order) {
    const position = root.plainText.indexOf(phrase);
    assert.ok(position > previous, `${phrase}: ${root.plainText}`);
    previous = position;
  }
  const section = importedChild.content.content?.find(node => node.type === 'heading');
  assert.ok(section?.attrs?.sectionId);
  const link = thirdRow.content?.[1].content?.[0].content?.[0].marks?.find(mark => mark.type === 'link');
  assert.equal(link?.attrs?.href, documentSectionHash(childId, String(section.attrs.sectionId)));

  const [file] = await read<Attachment[]>(await fetch(`${url}/attachments?resourceType=document&resourceId=${rootId}`), 200);
  assert.notEqual(file.id, image.id);
  assert.equal(file.mimeType, 'image/png');
  const imageSrc = richCell.content?.at(-1)?.attrs?.src;
  assert.equal(imageSrc, `/api/attachments/${file.id}/content?inline=1`);
  const downloaded = await fetch(new URL(String(imageSrc), url));
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
});
