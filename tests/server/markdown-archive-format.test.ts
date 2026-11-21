import assert from 'node:assert/strict';
import test from 'node:test';
import { hash } from '../../server/attachments.js';
import { readMarkdownArchive } from '../../server/markdown-archive-format.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

function archive(entries: Record<string, string | Buffer>) {
  return zip(Object.entries(entries).map(([path, bytes]) => ({ path, bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) })));
}

const nativeAttachment = Buffer.from([0, 255, 18, 89]);
const rootPath = 'documents/first-설계.md';
const childPath = 'documents/second-검토.md';
const nativeFilePath = 'attachments/exact.bin';
const nativeManifest = {
  format: 'teamspace-document-markdown', schemaVersion: 1,
  documents: [
    { id: 'child', parentId: 'root', path: childPath, title: '검토' },
    { id: 'root', parentId: null, path: rootPath, title: '설계' },
  ],
  attachments: [{ id: 'attachment-version', attachmentId: 'attachment', documentId: 'root',
    path: nativeFilePath, filename: '원본.bin', size: nativeAttachment.length, sha256: hash(nativeAttachment) }],
  diagnostics: [{ documentId: 'child', code: 'live_include', message: '포함 범위를 확인하세요.' }],
};

function nativeEntries(manifest: unknown = nativeManifest) {
  return {
    'manifest.json': JSON.stringify(manifest), 'README.md': '# Generated Table of Contents',
    [rootPath]: '# 설계\n\n[검토](second-%EA%B2%80%ED%86%A0.md)',
    [childPath]: '# 검토', [nativeFilePath]: nativeAttachment,
  };
}

test('Markdown ZIP reader validates native ownership, hashes, diagnostic scope and parent order', async () => {
  const source = await readMarkdownArchive(archive(nativeEntries()));
  assert.equal(source.format, 'teamspace');
  assert.deepEqual(source.pages, [
    { path: rootPath, parentPath: null, title: '설계', markdown: nativeEntries()[rootPath] },
    { path: childPath, parentPath: rootPath, title: '검토', markdown: '# 검토' },
  ]);
  assert.deepEqual([...source.files], [[nativeFilePath, { name: '원본.bin', bytes: nativeAttachment, ownerPath: rootPath }]]);
  assert.deepEqual(source.warnings, [{ path: childPath, message: '포함 범위를 확인하세요.' }]);
});

test('Markdown ZIP reader stops at broken native checksums, incomplete data, duplicate paths and parent cycles', async () => {
  const cyclic = { ...nativeManifest, documents: nativeManifest.documents.map(row => row.id === 'root' ? { ...row, parentId: 'child' } : row) };
  const duplicate = { ...nativeManifest, documents: nativeManifest.documents.map(row => ({ ...row, path: rootPath })) };
  const wrongOwner = { ...nativeManifest, attachments: [{ ...nativeManifest.attachments[0], documentId: 'other' }] };
  const missing = nativeEntries();
  delete (missing as Record<string, string | Buffer>)[childPath];
  for (const entries of [nativeEntries(cyclic), nativeEntries(duplicate), nativeEntries(wrongOwner), missing,
    { ...nativeEntries(), [nativeFilePath]: Buffer.from([0, 255, 1, 89]) }, { ...nativeEntries(), 'extra.md': '# unlisted' },
    { ...nativeEntries(), 'manifest.json': '{"format":"teamspace-document-markdown",' },
  ]) {
    await assert.rejects(readMarkdownArchive(archive(entries)), { status: 400 });
  }
});

test('native saved archives remove only their generated attachment footer including multiple versions', async () => {
  const latestPath = 'attachments/latest (v2).bin';
  const otherPath = 'attachments/binary.pdf';
  const manifest = {
    ...nativeManifest, source: 'saved', attachments: [
      { ...nativeManifest.attachments[0], id: 'latest-version', path: latestPath, filename: '최신 (v2).bin' },
      { ...nativeManifest.attachments[0], id: 'different-file', attachmentId: 'attachment-other', path: otherPath, filename: '배포.pdf' },
      nativeManifest.attachments[0],
    ],
  };
  const rows = '- [최신 \\(v2\\)\\.bin](../attachments/latest%20%28v2%29.bin)\n- [배포\\.pdf](../attachments/binary.pdf)\n';
  const footer = `\n## 첨부파일\n\n${rows}`;
  const authored = '# 설계\n\n본문입니다.\n\n<a id="same-title" name="same-title"></a>\n\n## 첨부파일\n\n' + rows;
  const entries = { ...nativeEntries(manifest), [latestPath]: nativeAttachment, [otherPath]: nativeAttachment };
  const source = await readMarkdownArchive(archive({ ...entries, [rootPath]: `${authored}${footer}` }));
  assert.equal(source.pages[0].markdown, authored);
  assert.deepEqual([...source.files.keys()], [latestPath, otherPath, nativeFilePath]);
  for (const unmatched of [authored, `${authored}${footer.replace('%28v2%29', '%28v3%29')}`,
    `${authored}\n## 첨부파일\n\n${rows.trim().split('\n').reverse().join('\n')}\n`,
  ]) {
    const preserved = await readMarkdownArchive(archive({ ...entries, [rootPath]: unmatched }));
    assert.equal(preserved.pages[0].markdown, unmatched);
  }
  const suffix = `${authored}${footer}`;
  const published = await readMarkdownArchive(archive({ ...entries, [rootPath]: suffix,
    'manifest.json': JSON.stringify({ ...manifest, source: 'published' }),
  }));
  assert.equal(published.pages[0].markdown, suffix);
  const conflictingOwner = await readMarkdownArchive(archive({ ...entries, [rootPath]: suffix,
    'manifest.json': JSON.stringify({ ...manifest, attachments: manifest.attachments.map(row =>
      row.id === 'attachment-version' ? { ...row, documentId: 'child' } : row) }),
  }));
  assert.equal(conflictingOwner.pages[0].markdown, suffix);
});

const docmostId = '010d2064-4228-4000-8b00-f4f98ba25801';
const docmostParent = '개발 100%';
const docmostParentPath = `${docmostParent}.md`;
const docmostChildPath = `${docmostParent}/배포 일정.md`;
const archivePath = (...parts: string[]) => parts.map(encodeURIComponent).join('/');
const docmostPages = {
  [archivePath(docmostParent, '배포 일정.md')]: { pageId: 'child', parentPath: archivePath(docmostParentPath), icon: '📦', position: 'a1' },
  'second.md': { pageId: 'second', parentPath: null, position: 'a9' },
  [archivePath(docmostParentPath)]: { pageId: 'parent', parentPath: null, position: 'a0' },
};

test('Docmost ZIP reader bridges percent paths and scoped JSZip attachment separators', async () => {
  const bytes = Buffer.from('release checklist');
  const entries = {
    'docmost-metadata.json': JSON.stringify({ source: 'docmost', version: '0.90.0', pages: docmostPages }),
    [docmostParentPath]: '# 개발 100%', [docmostChildPath]: '# 배포 일정', 'second.md': '# Second',
    [`/files/${docmostId}/근거.bin`]: nativeAttachment,
    [`${docmostParent}//files/${docmostId}/checklist.md`]: bytes,
  };
  const source = await readMarkdownArchive(archive(entries));
  assert.equal(source.format, 'docmost');
  assert.deepEqual(source.pages, [
    { path: docmostParentPath, parentPath: null, markdown: '# 개발 100%' },
    { path: docmostChildPath, parentPath: docmostParentPath, markdown: '# 배포 일정', icon: '📦' },
    { path: 'second.md', parentPath: null, markdown: '# Second' },
  ]);
  assert.deepEqual([...source.files], [
    [`files/${docmostId}/근거.bin`, { name: '근거.bin', bytes: nativeAttachment }],
    [`${docmostParent}/files/${docmostId}/checklist.md`, { name: 'checklist.md', bytes }],
  ]);
  await assert.rejects(readMarkdownArchive(archive({ ...entries, [`files/${docmostId}/근거.bin`]: nativeAttachment })), { status: 400 });
  await assert.rejects(readMarkdownArchive(archive({ ...entries, [`${docmostParent}//files/${docmostId}/../bad.bin`]: nativeAttachment })), { status: 400 });
  await assert.rejects(readMarkdownArchive(archive({ ...entries,
    'docmost-metadata.json': JSON.stringify({ source: 'docmost', pages: { '%2fsecret.md': { parentPath: null } } }),
  })), { status: 400 });
});

test('regular Markdown ZIP reader retains landing page hierarchy and blank pages', async () => {
  const ordinaryJson = '{"origin":"manual"}';
  const source = await readMarkdownArchive(archive({
    'README.md': '# Heading', '설계.md': '# 설계', '설계/하위/상세.md': '# 상세',
    'notes/index.md': '# Notes', 'notes/README.md': '# local README', 'notes/empty.md': '',
    'notes/index/nested.md': '# Nested', 'resources/photo.jpg': nativeAttachment, 'manifest.json': ordinaryJson,
  }));
  assert.equal(source.format, 'markdown');
  const paths = new Map(source.pages.map(page => [page.path, page.parentPath]));
  assert.deepEqual(paths, new Map([
    ['README.md', null], ['notes/index.md', null], ['notes/README.md', 'notes/index.md'],
    ['notes/empty.md', 'notes/index.md'], ['notes/index/nested.md', 'notes/index.md'],
    ['설계.md', null], ['설계/하위/상세.md', '설계.md'],
  ]));
  assert.equal(source.pages.find(page => page.path === 'notes/empty.md')?.markdown, '');
  assert.deepEqual(source.files.get('manifest.json')?.bytes, Buffer.from(ordinaryJson));
  assert.deepEqual(source.files.get('resources/photo.jpg')?.bytes, nativeAttachment);
});

test('Markdown ZIP reader enforces UTF-8, document limits and strict generic archive paths', async () => {
  const entries = Array.from({ length: 501 }, (_, index) => ({ path: `page-${index}.md`, bytes: Buffer.from('content') }));
  await assert.rejects(readMarkdownArchive(zip(entries)), { status: 413 });
  await assert.rejects(readMarkdownArchive(archive({ 'too-large.md': Buffer.alloc(512 * 1024 + 1, 65) })), { status: 413 });
  await assert.rejects(readMarkdownArchive(archive({ 'text.md': Buffer.from([0xc3, 0x28]) })), { status: 400 });
  for (const path of ['../outside.md', '/arbitrary.bin', `/files/${docmostId}/native-only.bin`, 'files//ordinary.bin', 'C:/escape.bin']) {
    await assert.rejects(readMarkdownArchive(archive({ 'page.md': '# Public', [path]: nativeAttachment })), { status: 400 }, path);
  }
});

test('Markdown ZIP reader enforces attachment counts and declared expansion budgets', async () => {
  const entries = [{ path: 'doc.md', bytes: Buffer.from('# Guide') }];
  for (let index = 0; index < 1501; index++) entries.push({ path: `assets/${index}.bin`, bytes: nativeAttachment });
  await assert.rejects(readMarkdownArchive(zip(entries)), { status: 413, message: /1,?500개/ });

  function declaredSizes(...sizes: number[]) {
    const bytes = archive(Object.fromEntries(sizes.map((_, index) => [`file-${index}.bin`, nativeAttachment])));
    let offset = bytes.readUInt32LE(bytes.length - 22 + 16);
    for (const size of sizes) {
      bytes.writeUInt32LE(size, offset + 24);
      offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    }
    return bytes;
  }

  const mib = 1024 * 1024;
  await assert.rejects(readMarkdownArchive(declaredSizes(20 * mib + 1)), { status: 413, message: /20 MiB/ });
  await assert.rejects(readMarkdownArchive(declaredSizes(17 * mib, 17 * mib, 17 * mib, 17 * mib)),
    { status: 413, message: /64 MiB/ });
});
