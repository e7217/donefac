import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareMarkdownArchive } from '../../server/markdown-archive-content.js';
import { previewMarkdownImport } from '../../shared/document-markdown-import.js';
import { documentNodes } from '../../shared/document-references.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

test('malformed and unsafe HTML tables in a Teamspace archive remain literal and produce a review warning', async () => {
  const documents = [
    {
      id: 'bad-grid', title: '범위가 잘못된 표', path: 'documents/bad-grid.md',
      table: '<table>\n<tbody>\n<tr><td rowspan="2"><p>표의 범위를 벗어난 셀</p></td><td><p>일반 셀</p></td></tr>\n</tbody>\n</table>',
    },
    {
      id: 'unsafe-table', title: '속성이 잘못된 표', path: 'documents/unsafe-table.md',
      table: '<table>\n<tbody>\n<tr><td onpointerover="alert(1)"><p>허용되지 않은 속성</p><p><a href="javascript:alert(1)">잘못된 주소</a></p></td></tr>\n</tbody>\n</table>',
    },
  ];
  const archive = zip([
    { path: 'manifest.json', bytes: Buffer.from(JSON.stringify({
      format: 'teamspace-document-markdown', schemaVersion: 1, source: 'saved', attachments: [],
      documents: documents.map(({ id, title, path }) => ({ id, title, path, parentId: null })),
    })) },
    ...documents.map(({ title, path, table }) => ({ path, bytes: Buffer.from(`# ${title}\n\n표 앞 문장\n\n${table}\n\n표 뒤 문장\n`) })),
  ]);
  const plan = await prepareMarkdownArchive(archive, {
    actorId: 'user-min', projectId: null, parentId: null, timestamp: '2026-11-23T00:00:00.000Z',
  });
  assert.equal(plan.format, 'teamspace');
  assert.equal(plan.documents.length, 2);
  assert.deepEqual(plan.attachments, []);
  for (const { path, title, table } of documents) {
    const document = plan.documents.find(item => item.title === title);
    assert.ok(document);
    const nodes = [...documentNodes(document.content)];
    assert.ok(nodes.every(node => node.type !== 'table' && node.type !== 'image' &&
      !node.marks?.some(mark => mark.type === 'link')));
    const literalText = nodes.flatMap(node => node.text ?? []);
    assert.ok(literalText.includes('표 앞 문장'));
    assert.ok(literalText.includes('표 뒤 문장'));
    for (const line of table.split('\n')) assert.ok(literalText.includes(line), line);
    assert.ok(plan.warnings.some(warning => warning.path === path && /HTML|표/.test(warning.message)));
  }
});

test('a single Markdown draft keeps HTML tables literal outside archive import', () => {
  const { content, warnings } = previewMarkdownImport('<table><tr><th colspan="2"><p>머리글</p></th></tr></table>');
  assert.ok(![...documentNodes(content)].some(node => node.type === 'table'));
  assert.ok([...documentNodes(content)].some(node => node.text?.includes('<table>')));
  assert.deepEqual(warnings.map(({ code }) => code), ['html']);
});
