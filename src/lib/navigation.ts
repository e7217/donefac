export function dispatchWorkspaceNavigation(preservedDocumentId?: string | null, preserveReport = false, preserveTeamBoard = false) {
  const event = preservedDocumentId || preserveReport || preserveTeamBoard
    ? new CustomEvent('teamspace:navigate', { cancelable: true, detail: { preservedDocumentId, preserveReport, preserveTeamBoard } })
    : new Event('teamspace:navigate', { cancelable: true });
  return window.dispatchEvent(event);
}

export function isDocumentPreservedByNavigation(event: Event, documentId?: string | null) {
  return Boolean(documentId && event instanceof CustomEvent && event.detail?.preservedDocumentId === documentId);
}

export function isReportPreservedByNavigation(event: Event): boolean {
  return event instanceof CustomEvent && event.detail?.preserveReport === true;
}

export function isTeamBoardPreservedByNavigation(event: Event): boolean {
  return event instanceof CustomEvent && event.detail?.preserveTeamBoard === true;
}

/** Other forms may still cancel the same synchronous navigation dispatch. */
export function afterAcceptedNavigation(event: Event, discard: () => void) {
  queueMicrotask(() => { if (!event.defaultPrevented) discard(); });
}
