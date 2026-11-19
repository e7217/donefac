'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, BellRing, RefreshCw } from 'lucide-react';
import type { FeatureProps, NotificationSubscriptionState, NotificationSubscriptionTarget } from '../../shared/types';
import { api } from '../lib/api';
import './notification-subscription.css';

type Props = Pick<FeatureProps, 'actorId' | 'notify'> & {
  targetType: NotificationSubscriptionTarget;
  targetId: string;
};

export function NotificationSubscriptionButton(props: Props) {
  if (!props.actorId) return null;
  return <SubscriptionButton key={JSON.stringify([props.actorId, props.targetType, props.targetId])} {...props} />;
}

function SubscriptionButton({ actorId, targetType, targetId, notify }: Props) {
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [writing, setWriting] = useState(false);
  const request = useRef<AbortController | null>(null);
  const path = `/notifications/subscriptions/${targetType}/${encodeURIComponent(targetId)}`;

  const load = useCallback(() => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    void api<NotificationSubscriptionState>(path, {
      headers: { 'X-Actor-Id': actorId },
      signal: controller.signal,
    }).then(result => {
      if (!controller.signal.aborted) {
        setSubscribed(result.subscribed);
        setLoadFailed(false);
      }
    }, () => {
      if (!controller.signal.aborted) {
        setSubscribed(null);
        setLoadFailed(true);
      }
    }).finally(() => {
      if (request.current === controller) request.current = null;
    });
  }, [actorId, path]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') load(); };
    const imported = () => {
      request.current?.abort();
      request.current = null;
      setSubscribed(null);
      setLoadFailed(false);
      setWriting(false);
      load();
    };
    load();
    window.addEventListener('focus', refresh);
    window.addEventListener('teamspace:workspace-imported', imported);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      request.current?.abort();
      request.current = null;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('teamspace:workspace-imported', imported);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  async function toggle() {
    if (loadFailed) {
      setLoadFailed(false);
      load();
      return;
    }
    if (subscribed === null || writing) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setWriting(true);
    let refresh = false;
    try {
      const result = await api<NotificationSubscriptionState>(path, {
        method: 'PUT',
        headers: { 'X-Actor-Id': actorId },
        body: JSON.stringify({ subscribed: !subscribed }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setSubscribed(result.subscribed);
    } catch (error) {
      if (!controller.signal.aborted) {
        setSubscribed(null);
        refresh = true;
        notify(error instanceof Error ? error.message : '구독 상태를 변경하지 못했습니다.', 'error');
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setWriting(false);
        if (refresh) load();
      }
    }
  }

  const targetName = targetType === 'issue' ? '업무' : '문서';
  const label = `${targetName} 구독${loadFailed ? ' 다시 불러오기' : subscribed ? ' 해제' : ''}`;
  const Icon = loadFailed ? RefreshCw : subscribed ? BellRing : Bell;
  const busy = writing || (subscribed === null && !loadFailed);
  return <button type="button" className={`btn btn-ghost notification-subscription-button${subscribed ? ' is-subscribed' : ''}`}
    disabled={busy} aria-busy={busy} onClick={() => void toggle()}>
    <Icon size={14} aria-hidden="true" /> {label}
  </button>;
}
