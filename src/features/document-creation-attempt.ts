import type { DocPage, DocumentTemplateSummary, RichContent } from '../../shared/types';
import type { MarkdownImportPreview } from './DocumentMarkdownImport';

type DocumentCreationInput = Pick<DocPage, 'title' | 'projectId' | 'parentId'> & {
  requestId: string;
  expectedRestoreGeneration: string;
} & (
  { templateId: string; expectedTemplateVersion: number; content?: never } |
  { content: RichContent; status: 'draft'; icon: string; templateId?: never; expectedTemplateVersion?: never }
);

export type DocumentCreationAttempt = {
  actorId: string;
  input: DocumentCreationInput;
  template: string;
  teamTemplate?: DocumentTemplateSummary;
  markdown?: Omit<MarkdownImportPreview, 'content'>;
  documentId?: string;
};

const cacheKey = (actorId: string, generation: string) => `donefac:document-create:${JSON.stringify([actorId, generation])}`;

export function readDocumentCreationAttempt(actorId: string, generation?: string) {
  if (!actorId || !generation) return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(cacheKey(actorId, generation)) ?? 'null') as DocumentCreationAttempt | null;
    const input = value?.input;
    if (!input || value.actorId !== actorId || input.expectedRestoreGeneration !== generation ||
        typeof input.requestId !== 'string' || typeof input.title !== 'string' ||
        (input.projectId !== null && typeof input.projectId !== 'string') ||
        (input.parentId !== null && typeof input.parentId !== 'string') || typeof value.template !== 'string' ||
        (value.documentId !== undefined && typeof value.documentId !== 'string')) return null;
    if (value.template === 'team' ? !value.teamTemplate || !input.templateId || value.teamTemplate.id !== input.templateId ||
        value.teamTemplate.version !== input.expectedTemplateVersion : input.content?.type !== 'doc') return null;
    if (value.template === 'markdown' && (!value.markdown || !Array.isArray(value.markdown.warnings))) return null;
    return value;
  } catch { return null; }
}

export function writeDocumentCreationAttempt(attempt: DocumentCreationAttempt, pending: boolean) {
  try {
    const key = cacheKey(attempt.actorId, attempt.input.expectedRestoreGeneration);
    if (pending) sessionStorage.setItem(key, JSON.stringify(attempt));
    else if (readDocumentCreationAttempt(attempt.actorId, attempt.input.expectedRestoreGeneration)?.input.requestId === attempt.input.requestId) {
      sessionStorage.removeItem(key);
    }
    return true;
  } catch { return false; }
}
