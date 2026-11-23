import { normalizeDocumentLabels } from '../../shared/document-labels';
import type { DocPage } from '../../shared/types';

export type DocumentMetadata = Pick<DocPage, 'title' | 'status' | 'parentId'> & { labels: string[] };
export type DocumentMetadataField = keyof DocumentMetadata;
export type DocumentMetadataChoices = Partial<Record<DocumentMetadataField, 'local' | 'saved'>>;

const fields: DocumentMetadataField[] = ['title', 'status', 'parentId', 'labels'];

export function documentTitleForSave(title: string): string {
  return title.trim() || '제목 없는 문서';
}

export function documentMetadata(page: Pick<DocPage, 'title' | 'status' | 'parentId' | 'labels'>): DocumentMetadata {
  return {
    title: page.title,
    status: page.status,
    parentId: page.parentId,
    labels: normalizeDocumentLabels(page.labels) ?? page.labels ?? [],
  };
}

export function sameLabels(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = normalizeDocumentLabels(left) ?? left;
  const normalizedRight = normalizeDocumentLabels(right) ?? right;
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((label, index) => label === normalizedRight[index]);
}

function sameField(field: DocumentMetadataField, left: DocumentMetadata, right: DocumentMetadata): boolean {
  if (field === 'title') return documentTitleForSave(left.title) === documentTitleForSave(right.title);
  if (field === 'labels') return sameLabels(left.labels, right.labels);
  return left[field] === right[field];
}

export function sameMetadata(left: DocumentMetadata, right: DocumentMetadata): boolean {
  return fields.every(field => sameField(field, left, right));
}

export function reconcileDocumentMetadata(
  base: DocumentMetadata,
  local: DocumentMetadata,
  saved: DocumentMetadata,
  { choices, parentContextChanged = false }: { choices?: DocumentMetadataChoices; parentContextChanged?: boolean } = {},
): { metadata: DocumentMetadata; conflicts: DocumentMetadataField[] } {
  const conflicts: DocumentMetadataField[] = [];
  function sourceFor(field: DocumentMetadataField): DocumentMetadata {
    if (sameField(field, local, base) || sameField(field, local, saved)) return saved;
    const invalidLocalParent = field === 'parentId' && parentContextChanged;
    if (!invalidLocalParent && sameField(field, saved, base)) return local;
    if (choices?.[field] === 'saved') return saved;
    if (!invalidLocalParent && choices?.[field] === 'local') return local;
    conflicts.push(field);
    return local;
  }

  const metadata = documentMetadata({
    title: sourceFor('title').title,
    status: sourceFor('status').status,
    parentId: sourceFor('parentId').parentId,
    labels: sourceFor('labels').labels,
  });
  return { metadata, conflicts };
}

export function reapplyDocumentMetadataEdits(captured: DocumentMetadata, current: DocumentMetadata, saved: DocumentMetadata): DocumentMetadata {
  const sourceFor = (field: DocumentMetadataField) => sameField(field, captured, current) ? saved : current;
  return documentMetadata({
    title: sourceFor('title').title,
    status: sourceFor('status').status,
    parentId: sourceFor('parentId').parentId,
    labels: sourceFor('labels').labels,
  });
}
