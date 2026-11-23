import assert from 'node:assert/strict';
import test from 'node:test';
import {
  documentMetadata,
  reconcileDocumentMetadata,
  reapplyDocumentMetadataEdits,
  sameMetadata,
  type DocumentMetadata,
} from '../../src/features/document-metadata-draft.js';

const base: DocumentMetadata = { title: '원본 문서', status: 'draft', parentId: null, labels: ['기존'] };

test('document metadata combines unrelated edits and accepts equivalent normalized edits', () => {
  const local = { ...base, title: '  내가 바꾼 제목  ', labels: [' Zeta ', 'Cafe\u0301', 'CAFÉ'] };
  const saved = { ...base, status: 'published' as const, parentId: 'new-parent', labels: ['Café', 'Zeta'] };
  assert.deepEqual(reconcileDocumentMetadata(base, local, saved), {
    metadata: { ...saved, title: local.title }, conflicts: [],
  });
  assert.ok(sameMetadata({ ...base, title: ' ' }, { ...base, title: '제목 없는 문서' }));
  assert.deepEqual(documentMetadata({ title: base.title, parentId: null, status: 'draft' }).labels, []);
});

test('document metadata shows only overlapping fields and applies explicit conflict choices', () => {
  const local = { ...base, title: '내 제목', labels: ['내 라벨'] };
  const saved = { ...base, title: '저장된 제목', labels: ['저장된 라벨'], status: 'published' as const };
  assert.deepEqual(reconcileDocumentMetadata(base, local, saved), {
    metadata: { ...local, status: saved.status }, conflicts: ['title', 'labels'],
  });
  assert.deepEqual(reconcileDocumentMetadata(base, local, saved, { choices: { title: 'local', labels: 'saved' } }), {
    metadata: { ...saved, title: local.title }, conflicts: [],
  });
});

test('document metadata requires a saved parent choice across a changed project context', () => {
  const local = { ...base, parentId: 'old-project-parent' };
  const saved = { ...base, labels: ['새 라벨'] };
  assert.deepEqual(reconcileDocumentMetadata(base, local, saved, { parentContextChanged: true, choices: { parentId: 'local' } }), {
    metadata: { ...saved, parentId: local.parentId }, conflicts: ['parentId'],
  });
  assert.deepEqual(reconcileDocumentMetadata(base, local, saved, { parentContextChanged: true, choices: { parentId: 'saved' } }), {
    metadata: saved, conflicts: [],
  });
  assert.deepEqual(reconcileDocumentMetadata(base, { ...local, parentId: 'already-saved' }, { ...saved, parentId: 'already-saved' }, { parentContextChanged: true }).conflicts, []);
});

test('document save receipts preserve only new edits while adopting normalized and concurrent fields', () => {
  const submitted = { ...base, title: ' 새 제목 ' };
  const current = { ...submitted, title: '새 제목', status: 'published' as const };
  const receipt = { ...base, title: '새 제목', labels: ['다른 사용자 라벨'], parentId: 'moved-parent' };
  assert.deepEqual(reapplyDocumentMetadataEdits(submitted, current, receipt), { ...receipt, status: current.status });
  assert.deepEqual(reapplyDocumentMetadataEdits(submitted, { ...current, title: base.title }, receipt), { ...receipt, status: current.status, title: base.title });
});
