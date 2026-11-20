import type { DocPage } from './types.js';

export const MAX_DOCUMENT_LABELS = 20;
export const MAX_DOCUMENT_LABEL_LENGTH = 60;

function trimmedDocumentLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  return value.trim().normalize('NFC') || null;
}

export function normalizeDocumentLabel(value: unknown): string | null {
  const label = trimmedDocumentLabel(value);
  return label && label.length <= MAX_DOCUMENT_LABEL_LENGTH ? label : null;
}

export function documentLabelKey(value: string): string {
  return value.normalize('NFC').toLowerCase().normalize('NFC');
}

export function normalizeDocumentLabelKey(value: unknown): string | null {
  const label = trimmedDocumentLabel(value);
  if (!label || label.length > MAX_DOCUMENT_LABEL_LENGTH * 2) return null;
  const key = documentLabelKey(label);
  return key.length <= MAX_DOCUMENT_LABEL_LENGTH * 2 ? key : null;
}

export function normalizeDocumentLabels(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_DOCUMENT_LABELS) return null;
  const labels = new Map<string, string>();
  for (const entry of value) {
    const label = normalizeDocumentLabel(entry);
    if (label === null) return null;
    const key = documentLabelKey(label);
    if (!labels.has(key)) labels.set(key, label);
  }
  return [...labels.keys()].sort().map(key => labels.get(key)!);
}

export function documentSearchText(document: Pick<DocPage, 'title' | 'plainText' | 'labels'>): string {
  return documentLabelKey([document.title, document.plainText, ...(document.labels ?? [])].join(' '));
}
