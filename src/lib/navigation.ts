type NavigationPreservation = {
  preservedDocumentId?: string | null;
  preserveReport?: boolean;
  preserveTeamBoard?: boolean;
  preserveGantt?: true | 'dateDrafts' | 'issueOverlay';
  preserveDevelopment?: boolean;
};

export function dispatchWorkspaceNavigation(detail?: NavigationPreservation) {
  const event = detail
    ? new CustomEvent('teamspace:navigate', { cancelable: true, detail })
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

export function isGanttPreservedByNavigation(event: Event): boolean {
  return event instanceof CustomEvent && event.detail?.preserveGantt === true;
}

export function areGanttDateDraftsPreservedByNavigation(event: Event): boolean {
  return isGanttIssueOverlayNavigation(event) || event instanceof CustomEvent && event.detail?.preserveGantt === 'dateDrafts';
}

export function isGanttIssueOverlayNavigation(event: Event): boolean {
  return event instanceof CustomEvent && event.detail?.preserveGantt === 'issueOverlay';
}

export function isDevelopmentReviewNavigation(event: Event): boolean {
  return event instanceof CustomEvent && event.detail?.preserveDevelopment === true;
}

/** Other forms may still cancel the same synchronous navigation dispatch. */
export function afterAcceptedNavigation(event: Event, discard: () => void) {
  queueMicrotask(() => { if (!event.defaultPrevented) discard(); });
}
