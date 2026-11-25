'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export const ISSUE_SUBSCRIPTIONS_CHANGED = 'teamspace:issue-subscriptions-changed';

const emptyIds: ReadonlySet<string> = new Set();
type SubscriptionSnapshot = { actorId: string; ids?: ReadonlySet<string>; failed: boolean };

export function useIssueSubscriptions(actorId: string) {
  const [snapshot, setSnapshot] = useState<SubscriptionSnapshot | null>(null);
  const request = useRef<AbortController | null>(null);
  const reload = useCallback(() => {
    if (!actorId) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    void api<{ issueIds: string[] }>('/notifications/subscriptions/issues', {
      headers: { 'X-Actor-Id': actorId }, cache: 'no-store', signal: controller.signal,
    }).then(({ issueIds }) => {
      if (!controller.signal.aborted) setSnapshot({ actorId, ids: new Set(issueIds), failed: false });
    }, () => {
      if (!controller.signal.aborted) {
        setSnapshot(previous => ({ actorId, ids: previous?.actorId === actorId ? previous.ids : undefined, failed: true }));
      }
    }).finally(() => {
      if (request.current === controller) request.current = null;
    });
  }, [actorId]);

  useEffect(() => {
    if (!actorId) return;
    const refreshOnFocus = () => {
      if (document.visibilityState === 'visible' && !request.current) reload();
    };
    const imported = () => {
      setSnapshot(null);
      reload();
    };
    reload();
    window.addEventListener(ISSUE_SUBSCRIPTIONS_CHANGED, reload);
    window.addEventListener('teamspace:trash-changed', reload);
    window.addEventListener('teamspace:workspace-imported', imported);
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnFocus);
    return () => {
      request.current?.abort();
      request.current = null;
      window.removeEventListener(ISSUE_SUBSCRIPTIONS_CHANGED, reload);
      window.removeEventListener('teamspace:trash-changed', reload);
      window.removeEventListener('teamspace:workspace-imported', imported);
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnFocus);
    };
  }, [actorId, reload]);

  const current = snapshot?.actorId === actorId ? snapshot : null;
  return { ids: current?.ids ?? emptyIds, ready: Boolean(current?.ids) || !actorId, failed: current?.failed ?? false, reload };
}
