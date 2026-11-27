import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AtlassianLinkError, AtlassianLinksService } from '../../server/atlassian-links.js';
import { Store } from '../../server/store.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-atlassian-links-'));
  const store = new Store(directory);
  t.after(() => {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const issue = { id: 'shared-target', projectId: 'project', parentId: null, assigneeId: null };
  const document = { id: 'shared-target', projectId: null, parentId: null, authorId: 'actor' };
  store.transaction(() => {
    store.put('users', { id: 'actor', email: 'actor@example.test' });
    store.put('projects', { id: 'project', key: 'TEST' });
    store.put('issues', issue);
    store.put('documents', document);
  });
  return { store, issue, document, links: new AtlassianLinksService(store) };
}

const jira = { targetType: 'issue', targetId: 'shared-target', product: 'jira', url: 'https://jira.example.test/jira/browse/TEST-37' };
const confluence = { targetType: 'document', targetId: 'shared-target', product: 'confluence', url: 'https://wiki.example.test/wiki/pages/viewpage.action?pageId=501' };
const status = (expected: number) => (error: unknown) => error instanceof AtlassianLinkError && error.status === expected;

test('external links normalize duplicate requests, distinguish target types, and follow purge lifecycle', t => {
  const { store, issue, links } = fixture(t);
  const saved = links.create(jira);
  assert.deepEqual(links.create({ ...jira, url: 'https://JIRA.example.test/jira/browse/test-37?focusedCommentId=89#comment' }), saved);
  const page = links.create(confluence);
  assert.deepEqual(links.create({ ...confluence, url: 'https://wiki.example.test/wiki/x/9QE?tracking=ignored#heading' }), page);
  assert.deepEqual(links.list('issue', issue.id), [saved]);
  assert.deepEqual(links.list('document', issue.id), [page]);
  assert.deepEqual(new AtlassianLinksService(store).get(saved.id), saved);
  assert.throws(() => links.create({ ...jira, actor: 'external' }), status(400));
  assert.throws(() => links.create({ ...jira, url: 'javascript:alert(1)' }), status(400));
  assert.throws(() => links.list('unknown', issue.id), status(400));
  assert.throws(() => links.list('issue', 'missing-target'), status(404));

  store.remove('issues', issue.id);
  assert.throws(() => links.list('issue', issue.id), status(404));
  assert.throws(() => links.create(jira), status(404));
  assert.throws(() => links.get(saved.id), status(404));
  assert.throws(() => links.remove(saved.id), status(404));
  assert.deepEqual(links.all(), [page, saved]);
  store.put('issues', issue);
  assert.deepEqual(links.get(saved.id), saved);
  store.transaction(() => {
    store.remove('issues', issue.id);
    links.removeTarget('issue', issue.id);
  });
  assert.deepEqual(links.all(), [page]);
  links.remove(page.id);
  assert.deepEqual(links.all(), []);
});

test('external link restore validates complete replacements and preserves dormant backup targets', t => {
  const { store, issue, document, links } = fixture(t);
  const saved = store.transaction(() => links.create(jira));
  const page = links.create(confluence);
  const refs = { issueIds: new Set([issue.id]), documentIds: new Set([document.id]) };
  const backup = links.all();
  for (const invalid of [
    null,
    [page, { ...saved, credentials: 'not part of a link' }],
    [page, { ...saved, id: page.id }],
    [page, saved, { ...saved, id: 'different-id', url: `${saved.url}#entry` }],
    [page, { ...saved, targetId: 'unknown-target' }],
    [page, { ...saved, createdAt: '2026-11-20' }],
  ]) {
    assert.throws(() => store.transaction(() => links.restore(invalid, refs)), status(400));
    assert.deepEqual(links.all(), backup);
  }

  store.remove('issues', issue.id);
  store.transaction(() => links.restore([saved], refs));
  assert.deepEqual(links.all(), [saved]);
  assert.deepEqual(links.list('document', document.id), []);
  assert.throws(() => links.get(saved.id), status(404));
  store.put('issues', issue);
  assert.deepEqual(links.list('issue', issue.id), [saved]);
  store.transaction(() => links.restore([], refs));
  assert.deepEqual(links.all(), []);
});
