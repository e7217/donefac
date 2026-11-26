type NavigationPreservation = {
  preservedDocumentId?: string | null;
  preserveReport?: boolean;
  preserveTeamBoard?: boolean;
  preserveGantt?: true | 'dateDrafts' | 'issueOverlay';
  preserveDevelopment?: boolean;
  /** Switching workspace settings sections keeps every section mounted, so drafts stay. */
  preserveSettingsDrafts?: boolean;
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

/**
 * A settings section switch: guards still block while a request is in flight or a
 * result needs the user's attention, but keep drafts without asking (the hidden
 * section stays mounted).
 */
export function isSettingsSectionNavigation(event: Event): boolean {
  return event instanceof CustomEvent && event.detail?.preserveSettingsDrafts === true;
}
