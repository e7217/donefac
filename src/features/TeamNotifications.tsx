'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Bell, Check, RefreshCw, X } from 'lucide-react';
import type { TeamNotification, TeamNotificationFilter, TeamNotificationKind, TeamNotificationPage, User } from '../../shared/types';
import { api, relativeTime } from '../lib/api';
import './team-notifications.css';

interface TeamNotificationsProps {
  actorId: string;
  users: User[];
  onOpen: (notification: TeamNotification) => Promise<boolean>;
}

const EVENT_LABELS: Record<TeamNotificationKind, string> = {
  'issue-assigned': '업무 배정',
  'issue-comment': '업무 댓글',
  'issue-status-changed': '업무 상태 변경',
  'document-comment': '문서 댓글',
  'document-updated': '문서 변경',
  'document-review-requested': '검토 요청',
  'document-changes-requested': '수정 요청',
  'document-published': '문서 발행',
  'document-review-withdrawn': '검토 철회',
};

const FILTER_LABELS: Record<TeamNotificationFilter, string> = { all: '전체', unread: '읽지 않음' };
const FILTERS: TeamNotificationFilter[] = ['all', 'unread'];
type NotificationResults = Pick<TeamNotificationPage, 'items' | 'nextCursor'>;

export default function TeamNotifications(props: TeamNotificationsProps) {
  return <NotificationInbox key={props.actorId} {...props} />;
}

function NotificationInbox({ actorId, users, onOpen }: TeamNotificationsProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<TeamNotificationFilter>('all');
  const [page, setPage] = useState<NotificationResults | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const readRequest = useRef<AbortController | null>(null);
  const writeRequest = useRef<AbortController | null>(null);
  const paged = useRef(false);
  const panelId = useId();

  const load = useCallback(async (requestedFilter: TeamNotificationFilter | null, before?: string) => {
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    const options = { headers: { 'X-Actor-Id': actorId }, signal: controller.signal };
    try {
      if (requestedFilter === null) {
        const result = await api<{ unreadCount: number }>('/notifications/count', options);
        if (!controller.signal.aborted) setCount(result.unreadCount);
        return;
      }
      const params = new URLSearchParams({ filter: requestedFilter });
      if (before) params.set('before', before);
      const result = await api<TeamNotificationPage>(`/notifications?${params}`, options);
      if (controller.signal.aborted) return;
      if (before) paged.current = true;
      setPage(previous => ({
        nextCursor: result.nextCursor,
        items: before && previous ? [...previous.items, ...result.items] : result.items,
      }));
      setCount(result.unreadCount);
      setError('');
    } catch (cause) {
      if (!controller.signal.aborted && requestedFilter !== null) {
        setError(cause instanceof Error ? cause.message : '알림을 불러오지 못했습니다.');
      }
    } finally {
      if (readRequest.current === controller) {
        readRequest.current = null;
        if (before && !controller.signal.aborted) setLoadingMore(false);
      }
    }
  }, [actorId]);

  useEffect(() => {
    if (!actorId) return;
    const refresh = () => {
      if (document.visibilityState === 'visible' && !writeRequest.current && !readRequest.current) {
        void load(open && !paged.current ? filter : null);
      }
    };
    const imported = () => {
      writeRequest.current?.abort();
      writeRequest.current = null;
      paged.current = false;
      setBusy(false);
      setPage(null);
      setCount(null);
      setError('');
      setLoadingMore(false);
      void load(open ? filter : null);
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    window.addEventListener('teamspace:workspace-imported', imported);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      readRequest.current?.abort();
      readRequest.current = null;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('teamspace:workspace-imported', imported);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [actorId, filter, load, open]);

  useEffect(() => () => writeRequest.current?.abort(), []);

  const dismiss = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) dismiss(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [dismiss, open]);

  function resetList() {
    paged.current = false;
    setPage(null);
    setError('');
    setLoadingMore(false);
  }

  async function markRead(item?: TeamNotification, navigate = false) {
    const throughId = page?.items[0]?.id;
    if ((!item && !throughId) || writeRequest.current) return;
    readRequest.current?.abort();
    readRequest.current = null;
    setLoadingMore(false);
    setError('');
    const controller = new AbortController();
    writeRequest.current = controller;
    setBusy(true);
    try {
      if (navigate && item) {
        if (!(await onOpen(item)) || controller.signal.aborted) return;
        dismiss(wrapper.current?.contains(document.activeElement) ?? false);
      }
      if (item?.readAt) return;
      const path = item ? `/notifications/${encodeURIComponent(item.id)}/read` : '/notifications/read-all';
      const result = await api<{ unreadCount: number }>(path, {
        method: 'PATCH', headers: { 'X-Actor-Id': actorId }, signal: controller.signal,
        body: item ? undefined : JSON.stringify({ throughId }),
      });
      if (controller.signal.aborted) return;
      const readAt = new Date().toISOString();
      setCount(result.unreadCount);
      setPage(previous => previous && {
        nextCursor: !item && filter === 'unread' ? null : previous.nextCursor,
        items: previous.items
          .map(row => (!item || row.id === item.id) && !row.readAt ? { ...row, readAt } : row)
          .filter(row => filter === 'all' || !row.readAt),
      });
      if (!navigate) closeButton.current?.focus();
      if (!item && result.unreadCount > 0 && closeButton.current) {
        paged.current = false;
        void load(filter);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '알림을 처리하지 못했습니다.');
    } finally {
      if (writeRequest.current === controller) {
        writeRequest.current = null;
        setBusy(false);
      }
    }
  }

  function reload() {
    resetList();
    void load(filter);
  }

  const items = page?.items ?? [];
  const titleId = `${panelId}-title`;
  const countId = `${panelId}-count`;
  const unreadId = `${panelId}-unread`;
  return (
    <div className="team-notifications" ref={wrapper} onBlur={event => {
      if (open && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) dismiss(false);
    }}>
      <button ref={trigger} className="icon-btn team-notifications-trigger" type="button" title="알림" aria-label="알림"
        aria-describedby={count === null ? undefined : countId} aria-haspopup="dialog"
        aria-expanded={open} aria-controls={open ? panelId : undefined} disabled={!actorId}
        onClick={() => {
          if (open) return dismiss(true);
          if (busy) return;
          resetList();
          setFilter('all');
          setOpen(true);
        }}>
        <Bell size={18} aria-hidden="true" />
        {count !== null && count > 0 && <span className="team-notifications-badge" aria-hidden="true">{count > 99 ? '99+' : count}</span>}
      </button>
      {count !== null && <span id={countId} className="sr-only">읽지 않은 알림 {count}개</span>}
      {open && <section className="team-notifications-panel" id={panelId} role="dialog" aria-labelledby={titleId}>
        <span id={unreadId} hidden>읽지 않음</span>
        <header className="team-notifications-header">
          <h2 id={titleId}>팀 알림</h2>
          <button className="icon-btn" type="button" onClick={reload} aria-label="알림 새로고침" disabled={busy}>
            <RefreshCw size={16} aria-hidden="true" />
          </button>
          <button ref={closeButton} className="icon-btn" type="button" onClick={() => dismiss(true)} aria-label="알림함 닫기">
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="team-notifications-controls">
          <div className="team-notifications-filters" role="group" aria-label="알림 필터">
            {FILTERS.map(value => <button key={value} className="team-notifications-filter" type="button" aria-pressed={value === filter}
              disabled={busy} onClick={() => {
                if (value === filter) return;
                readRequest.current?.abort();
                resetList();
                setFilter(value);
              }}>{FILTER_LABELS[value]}</button>)}
          </div>
          <button className="team-notifications-mark-all" type="button" disabled={busy || !items.length || !count}
            onClick={() => void markRead()}>모두 읽음</button>
        </div>
        <div className="team-notifications-results" aria-busy={busy || (page === null && !error)}>
          {error && <p className="team-notifications-error" role="alert">{error}</p>}
          {!page && !error && <p className="team-notifications-empty" role="status">알림을 불러오는 중입니다.</p>}
          {page && !items.length && !error && !page.nextCursor && <p className="team-notifications-empty">
            {filter === 'unread' ? '읽지 않은 알림이 없습니다.' : '아직 받은 알림이 없습니다.'}
          </p>}
          {!!items.length && <ul className="team-notifications-list">
            {items.map(item => <li key={item.id} className={item.readAt ? undefined : 'is-unread'}>
              <button className="team-notifications-target" type="button" aria-disabled={busy} onClick={() => void markRead(item, true)}
                aria-describedby={item.readAt ? undefined : unreadId}>
                <strong>{item.targetLabel}</strong>
                <span>{EVENT_LABELS[item.kind]} · {users.find(user => user.id === item.actorId)?.name ?? '팀원'}</span>
                <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString('ko-KR')}>{relativeTime(item.createdAt)}</time>
              </button>
              {!item.readAt && <button className="icon-btn team-notifications-mark" type="button" title="읽음 처리" aria-label={`${item.targetLabel} 읽음 처리`}
                disabled={busy} onClick={() => void markRead(item)}><Check size={16} aria-hidden="true" /></button>}
            </li>)}
          </ul>}
          {page?.nextCursor && <button className="btn team-notifications-more" type="button" disabled={busy || loadingMore}
            onClick={() => {
              setLoadingMore(true);
              void load(filter, page.nextCursor ?? undefined);
            }}>{loadingMore ? '불러오는 중…' : '이전 알림 더 보기'}</button>}
        </div>
      </section>}
    </div>
  );
}
