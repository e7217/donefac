import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Attachment, DocPage } from '../../shared/types.js';
import { AttachmentAppend } from '../../server/attachment-append.js';
import { AttachmentFiles, hash } from '../../server/attachments.js';
import { DocumentContentService } from '../../server/document-content.js';
import { MarkdownArchiveImportError, MarkdownArchiveImportService } from '../../server/markdown-archive-import.js';
import { seed } from '../../server/seed.js';
import { Store } from '../../server/store.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const author = 'user-min';
const projectId = 'project-team';
const bytes = Buffer.from('ZIP 첨부파일 내용');
const archive = zip([
  { path: 'Root.md', bytes: Buffer.from('# Root\n\n[파일](Root/info.txt)\n') },
  { path: 'Root/Child.md', bytes: Buffer.from('# Child\n\n[상위 문서](../Root.md)\n') },
  { path: 'Root/info.txt', bytes },
]);

function expectFailure(status: number, reason: string) {
  return (cause: unknown) => cause instanceof MarkdownArchiveImportError && cause.status === status && cause.details.reason === reason;
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-markdown-archive-service-'));
  let store = new Store(directory);
  const files = new AttachmentFiles(directory);
  const appender = new AttachmentAppend(directory);
  let service = new MarkdownArchiveImportService(store, appender);
  seed(store);
  const parent = store.all<DocPage>('documents').find(document => document.projectId === projectId)!;
  assert.ok(parent);
  const scope = { projectId, parentId: parent.id };
  t.after(() => { store.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const hooks = {
    validateDocument(document: DocPage) {
      const normalized = new DocumentContentService(store).normalize(document.content);
      Object.assign(document, normalized);
    },
    validateBatch(documents: DocPage[]) {
      new DocumentContentService(store).validateBatch(documents.map(document => ({ id: document.id, content: document.content })));
    },
    record(document: DocPage) {
      store.put('revisions', { id: randomUUID(), documentId: document.id, version: document.version, content: document.content });
    },
  };
  return {
    get store() { return store; },
    get service() { return service; },
    restart() {
      store.db.close();
      store = new Store(directory);
      appender.recover(id => Boolean(store.get('documents', id)));
      service = new MarkdownArchiveImportService(store, appender);
    },
    scope, parent, files, directory, hooks,
  };
}

test('Markdown ZIP apply rolls back its documents, first revisions and files, then only one parallel retry commits', async t => {
  const app = fixture(t);
  const documentsBefore = app.store.all('documents');
  const revisionsBefore = app.store.all('revisions');
  const preview = await app.service.preview(app.scope, author, archive);
  assert.equal(preview.format, 'markdown');
  assert.deepEqual(preview.pages.map(({ path, parentPath }) => [path, parentPath]), [
    ['Root.md', null], ['Root/Child.md', 'Root.md'],
  ]);
  assert.equal(preview.attachmentCount, 1);
  assert.deepEqual(app.store.all('documents'), documentsBefore);
  await assert.rejects(app.service.apply(preview.id, 'user-seo', archive, app.hooks), expectFailure(404, 'preview_missing'));
  const changed = Buffer.from(archive);
  changed[0] ^= 1;
  await assert.rejects(app.service.apply(preview.id, author, changed, app.hooks), expectFailure(409, 'archive_changed'));
  await assert.rejects(app.service.apply(preview.id, author, archive, {
    ...app.hooks,
    record(document) {
      app.hooks.record(document);
      if (document.parentId !== app.scope.parentId) throw new Error('fixture revision failure');
    },
  }), /fixture revision failure/);
  assert.deepEqual(app.store.all('documents'), documentsBefore);
  assert.deepEqual(app.store.all('revisions'), revisionsBefore);
  assert.equal(app.store.all('attachments').length, 0);
  assert.deepEqual(readdirSync(app.files.root), []);
  assert.equal(readdirSync(app.directory).some(name => name.startsWith('.append-')), false);

  const results = await Promise.all([app.service.apply(preview.id, author, archive, app.hooks), app.service.apply(preview.id, author, archive, app.hooks)]);
  assert.deepEqual(results.map(result => result.duplicate).sort(), [false, true]);
  const result = results.find(response => !response.duplicate)!;
  const [rootId, childId] = result.documentIds;
  assert.deepEqual(result.rootIds, [rootId]);
  assert.equal(result.attachmentCount, 1);
  assert.equal(app.store.get<DocPage>('documents', rootId)?.parentId, app.scope.parentId);
  assert.equal(app.store.get<DocPage>('documents', childId)?.parentId, rootId);
  const [attachment] = app.store.all<Attachment>('attachments');
  assert.equal(attachment.resourceId, rootId);
  assert.equal(attachment.sha256, hash(bytes));
  assert.deepEqual(app.files.read(attachment), bytes);
  assert.equal(app.store.all('revisions').length, revisionsBefore.length + 2);

  app.restart();
  assert.deepEqual(await app.service.apply(preview.id, author, archive, app.hooks), { ...result, duplicate: true });
  assert.deepEqual(app.files.read(attachment), bytes);
  await assert.rejects(app.service.apply(preview.id, author, changed, app.hooks), expectFailure(409, 'archive_changed'));
});

test('Markdown ZIP preview and apply recheck the chosen parent after parsing and invalidate on reset', async t => {
  const app = fixture(t);
  const previewing = app.service.preview(app.scope, author, archive);
  const parent = { ...app.parent, version: app.parent.version + 1 };
  app.store.put('documents', parent);
  await assert.rejects(previewing, expectFailure(409, 'scope_changed'));

  const guarded = await app.service.preview(app.scope, author, archive);
  const applying = app.service.apply(guarded.id, author, archive, app.hooks);
  app.store.put('documents', { ...parent, version: parent.version + 1 });
  await assert.rejects(applying, expectFailure(409, 'scope_changed'));
  assert.equal(app.store.all('attachments').length, 0);

  const expired = await app.service.preview(app.scope, author, archive);
  app.store.db.prepare('UPDATE markdown_archive_imports SET expires_at=0 WHERE id=?').run(expired.id);
  await assert.rejects(app.service.apply(expired.id, author, archive, app.hooks), expectFailure(410, 'preview_expired'));

  const restored = await app.service.preview(app.scope, author, archive);
  app.store.transaction(() => app.service.reset());
  await assert.rejects(app.service.apply(restored.id, author, archive, app.hooks), expectFailure(404, 'preview_missing'));
});
