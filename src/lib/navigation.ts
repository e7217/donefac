/** Other forms may still cancel the same synchronous navigation dispatch. */
export function afterAcceptedNavigation(event: Event, discard: () => void) {
  queueMicrotask(() => { if (!event.defaultPrevented) discard(); });
}
