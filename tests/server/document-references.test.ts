import assert from 'node:assert/strict';
import test from 'node:test';
import { countIssueDocumentReferences, findIssueDocumentReferences } from '../../shared/document-references.js';
import type { DocPage, RichContent } from '../../shared/types.js';

const baseline = '2026-11-19T00:00:00.000Z';
const issueId = 'issue-one';

function issueReference(id: string, label = '저장한 업무 제목'): RichContent {
  return { type: 'issueReference', attrs: { issueId: id, label } };
}

function page(id: string, content: RichContent[], overrides: Partial<DocPage> = {}): DocPage {
  return {
    id, projectId: 'project-one', parentId: null, title: id, content: { type: 'doc', content }, plainText: '',
    icon: '📄', status: 'draft', version: 1, authorId: 'member-one', createdAt: baseline, updatedAt: baseline, ...overrides,
  };
}

test('find issue document references counts exact IDs in the current saved body, including nested blocks', () => {
  const original = page('original', [
    issueReference(issueId),
    { type: 'callout', attrs: { variant: 'note' }, content: [
      { type: 'details', content: [
        { type: 'detailsSummary', content: [{ type: 'text', text: '접힌 절' }] },
        { type: 'detailsContent', content: [issueReference(issueId, '이전 제목')] },
      ] },
    ] },
    issueReference('issue-other', issueId),
    { type: 'issueReference' },
    issueReference(''),
  ], { projectId: null });
  const includes = page('included-only', [
    { type: 'documentInclude', attrs: { documentId: original.id, label: issueId } },
    { type: 'documentRevisionInclude', attrs: { documentId: original.id, revisionId: 'version-one' } },
    { type: 'documentReference', attrs: { documentId: issueId } },
    { type: 'issueList', attrs: { projectId: 'project-one', savedViewId: 'view-one' } },
    { type: 'issueSummary', attrs: { projectId: 'project-one', savedViewId: 'view-one', groupBy: 'priority' } },
    { type: 'paragraph', content: [{ type: 'text', text: issueId }] },
  ]);

  assert.equal(countIssueDocumentReferences(original.content, issueId), 2);
  assert.equal(countIssueDocumentReferences(original.content, ''), 0);
  assert.equal(countIssueDocumentReferences(includes.content, issueId), 0);
  assert.deepEqual(findIssueDocumentReferences([includes, original], issueId), [{ document: original, count: 2 }]);
  assert.deepEqual(findIssueDocumentReferences([includes, original], 'missing'), []);
});

test('find issue document references sorts tied results without reordering the input', () => {
  const older = page('older', [issueReference(issueId)], { title: '가' });
  const recent = '2026-11-20T00:00:00.000Z';
  const secondByTitle = page('first-id', [issueReference(issueId)], { title: '나', updatedAt: recent });
  const firstById = page('second-id', [issueReference(issueId)], { title: '가', updatedAt: recent });
  const secondById = page('third-id', [issueReference(issueId)], { title: '가', updatedAt: recent, projectId: 'project-two' });
  const documents = [older, secondById, secondByTitle, firstById];

  assert.deepEqual(findIssueDocumentReferences(documents, issueId).map(({ document }) => document.id),
    [firstById.id, secondById.id, secondByTitle.id, older.id]);
  assert.deepEqual(documents.map(document => document.id), [older.id, secondById.id, secondByTitle.id, firstById.id]);
});
