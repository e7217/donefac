export function dispatchWorkspaceNavigation(preservedDocumentId?: string | null) {
  const event = preservedDocumentId
    ? new CustomEvent('teamspace:navigate', { cancelable: true, detail: { preservedDocumentId } })
    : new Event('teamspace:navigate', { cancelable: true });
  return window.dispatchEvent(event);
}

export function isDocumentPreservedByNavigation(event: Event, documentId?: string | null) {
  return Boolean(documentId && event instanceof CustomEvent && event.detail?.preservedDocumentId === documentId);
}

/** Other forms may still cancel the same synchronous navigation dispatch. */
export function afterAcceptedNavigation(event: Event, discard: () => void) {
  queueMicrotask(() => { if (!event.defaultPrevented) discard(); });
}
