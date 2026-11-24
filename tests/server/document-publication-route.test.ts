import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendDocumentPublicationCriteria, defaultDocumentPublicationCriteria, normalizeDocumentPublicationQuery,
  readDocumentPublicationCriteria, sameDocumentPublicationCriteria,
} from '../../shared/document-publication-route.js';

test('publication list routes keep the tab defaults and round-trip a different project with filters', () => {
  assert.deepEqual(readDocumentPublicationCriteria(new URLSearchParams(), 'assigned', 'context'), {
    scope: 'workspace', projectId: 'context', query: '', offset: 0,
  });
  assert.deepEqual(readDocumentPublicationCriteria(new URLSearchParams(), 'published', 'context'), {
    scope: 'project', projectId: 'context', query: '', offset: 0,
  });
  for (const tab of ['assigned', 'requested', 'published'] as const) {
    const params = new URLSearchParams();
    appendDocumentPublicationCriteria(params, defaultDocumentPublicationCriteria(tab, 'context'), tab, 'context');
    assert.equal(params.toString(), '');
  }
  const criteria = { scope: 'project', projectId: 'other', query: '검토 A+B', offset: 60 } as const;
  const params = new URLSearchParams();
  appendDocumentPublicationCriteria(params, criteria, 'assigned', 'context');
  assert.deepEqual(Object.fromEntries(params), { scope: 'project', projectId: 'other', q: '검토 A+B', offset: '60' });
  assert.deepEqual(readDocumentPublicationCriteria(params, 'assigned', 'context'), criteria);
  assert.equal(sameDocumentPublicationCriteria({ ...criteria }, criteria), true);
  assert.equal(sameDocumentPublicationCriteria({ ...criteria, offset: 30 }, criteria), false);
  assert.equal(sameDocumentPublicationCriteria(undefined, criteria), false);
});

test('publication list deep links normalize query and paging without widening a missing project', () => {
  const params = new URLSearchParams({ scope: 'project', projectId: 'removed', q: '  Cafe\u0301\u0000 🔭 ', offset: '37' });
  const criteria = readDocumentPublicationCriteria(params, 'requested', 'context');
  assert.deepEqual(criteria, { scope: 'project', projectId: 'removed', query: 'Café 🔭', offset: 30 });

  const invalid = new URLSearchParams({ scope: 'invalid', projectId: '\u0000', offset: '1000001' });
  assert.deepEqual(readDocumentPublicationCriteria(invalid, 'published', 'context'), defaultDocumentPublicationCriteria('published', 'context'));
  for (const raw of ['-30', '30.1', '0x1e', '3e1', '00000300']) {
    assert.equal(readDocumentPublicationCriteria(new URLSearchParams({ offset: raw }), 'assigned', 'context').offset, 0);
  }
  const query = `${'문'.repeat(199)}🔭`;
  assert.equal(normalizeDocumentPublicationQuery(query), '문'.repeat(199));
  const canonical = new URLSearchParams();
  appendDocumentPublicationCriteria(canonical, { ...criteria, scope: 'common', offset: 0 }, 'published', 'context');
  assert.deepEqual(Object.fromEntries(canonical), { scope: 'common', projectId: 'removed', q: 'Café 🔭' });
});
