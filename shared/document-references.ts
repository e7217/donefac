import type { DocPage, RichContent } from './types.js';

export function* documentNodes(content: RichContent): Generator<RichContent> {
  const pending = [content];
  while (pending.length) {
    const node = pending.pop()!;
    yield node;
    for (let index = (node.content?.length || 0) - 1; index >= 0; index--) pending.push(node.content![index]);
  }
}

export interface IssueDocumentReference {
  document: DocPage;
  count: number;
}

export function countIssueDocumentReferences(content: RichContent, issueId: string): number {
  if (!issueId) return 0;
  let count = 0;
  for (const node of documentNodes(content)) {
    if (node.type === 'issueReference' && node.attrs?.issueId === issueId) count++;
  }
  return count;
}

/** The caller supplies the current active document snapshots. */
export function findIssueDocumentReferences(documents: readonly DocPage[], issueId: string): IssueDocumentReference[] {
  const references: IssueDocumentReference[] = [];
  for (const document of documents) {
    const count = countIssueDocumentReferences(document.content, issueId);
    if (count) references.push({ document, count });
  }
  return references.sort((left, right) =>
    right.document.updatedAt.localeCompare(left.document.updatedAt) ||
    left.document.title.localeCompare(right.document.title, 'ko') ||
    left.document.id.localeCompare(right.document.id));
}
