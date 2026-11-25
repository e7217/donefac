'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScheduleUndoInfo, ScheduleUndoResult, ScheduleUndoScope } from '../../shared/types';
import { api, ApiError } from '../lib/api';

const REQUEST_TIMEOUT = 20_000;
const undoIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const undoRequestKey = (key: string) => `teamspace:schedule-undo:${key}`;

function pendingUndoId(key: string) {
  try {
    const id = sessionStorage.getItem(undoRequestKey(key));
    return id && undoIdPattern.test(id) ? id : null;
  } catch { return null; }
}

function forgetPendingUndo(key: string, id: string) {
  try {
    const storageKey = undoRequestKey(key);
    if (sessionStorage.getItem(storageKey) === id) sessionStorage.removeItem(storageKey);
  } catch { /* Result handling still works without tab storage. */ }
}

export function scheduleUndoHeaders(scope?: ScheduleUndoScope | null, actorId?: string): Record<string, string> {
  return {
    ...(actorId ? { 'X-Actor-Id': actorId } : {}),
    ...(scope ? { 'X-Teamspace-Schedule-Undo-Scope': scope.kind === 'team' ? 'team' : `${scope.kind}:${encodeURIComponent(scope.id)}` } : {}),
  };
}

export function isUncertainScheduleResponse(cause: unknown): boolean {
  return !(cause instanceof ApiError) || cause.status >= 500 || [408, 425, 429, 499].includes(cause.status);
}

type UndoSession = {
  key: string;
  id: string | null;
  retry: boolean;
  lookup: AbortController | null;
  request: AbortController | null;
  load: () => Promise<void> | undefined;
};

export function useScheduleUndo(scope: ScheduleUndoScope | null, actorId: string, restoreGeneration: string | null | undefined) {
  const kind = scope?.kind;
  const scopeId = scope && 'id' in scope ? scope.id : '';
  const key = kind && actorId ? JSON.stringify([actorId, restoreGeneration ?? null, kind, scopeId]) : null;
  const session = useRef<UndoSession | null>(null);
  const [selection, setSelection] = useState<{ key: string; undoId: string | null; recovering: boolean } | null>(null);

  useEffect(() => {
    if (!key || !kind) return;
    const pendingId = pendingUndoId(key);
    const active: UndoSession = { key, id: pendingId, retry: pendingId !== null, lookup: null, request: null, load };
    session.current = active;
    const params = new URLSearchParams({ scope: kind });
    if (scopeId) params.set('id', scopeId);

    function load() {
      if (active.request || active.retry) return;
      active.lookup?.abort();
      const lookup = new AbortController();
      active.lookup = lookup;
      return api<{ undo: ScheduleUndoInfo | null }>(`/schedule/undo/latest?${params}`, {
        headers: scheduleUndoHeaders(null, actorId), cache: 'no-store',
        signal: AbortSignal.any([lookup.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
      }).then(({ undo }) => {
        if (lookup.signal.aborted || session.current !== active) return;
        if (undo !== null && typeof undo?.undoId !== 'string') return;
        active.id = undo?.undoId ?? null;
        setSelection({ key: active.key, undoId: active.id, recovering: false });
      }).catch(() => {
        // A failed lookup does not discard a receipt already held by this screen.
      }).finally(() => { if (active.lookup === lookup) active.lookup = null; });
    }

    if (pendingId) queueMicrotask(() => {
      if (session.current === active && active.retry) setSelection({ key, undoId: pendingId, recovering: true });
    });
    else void load();
    window.addEventListener('focus', load);
    return () => {
      window.removeEventListener('focus', load);
      active.lookup?.abort();
      active.request?.abort();
      if (session.current === active) session.current = null;
    };
  }, [actorId, key, kind, scopeId]);

  const reload = useCallback(async () => {
    const active = session.current;
    if (active && active.key === key) await active.load();
  }, [key]);

  const remember = useCallback((undoId: string) => {
    const active = session.current;
    if (!active || active.key !== key || active.retry || active.request) return;
    active.lookup?.abort();
    active.id = undoId;
    active.retry = false;
    setSelection({ key: active.key, undoId, recovering: false });
  }, [key]);

  const undo = useCallback(async (): Promise<ScheduleUndoResult | null> => {
    const active = session.current;
    if (!active || active.key !== key || !kind || !active.id || active.request) return null;
    const undoId = active.id;
    const request = new AbortController();
    active.lookup?.abort();
    active.request = request;
    try { sessionStorage.setItem(undoRequestKey(active.key), undoId); }
    catch { /* The exact request remains available in memory. */ }
    const headers = scheduleUndoHeaders(kind === 'team' ? { kind } : { kind, id: scopeId }, actorId);
    let reload = false;
    async function send(retry: boolean) {
      const result = await api<ScheduleUndoResult>(retry ? '/schedule/undo?retry=true' : '/schedule/undo', {
        method: 'POST', body: JSON.stringify({ undoId }), headers,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
      });
      if (!result || !Array.isArray(result.updated) || !Array.isArray(result.warnings)) throw new Error('되돌리기 응답을 확인할 수 없습니다.');
      return result;
    }
    try {
      let result: ScheduleUndoResult;
      try {
        result = await send(active.retry);
      } catch (cause) {
        if (request.signal.aborted || active.retry || !isUncertainScheduleResponse(cause)) throw cause;
        active.retry = true;
        setSelection({ key: active.key, undoId, recovering: true });
        result = await send(true);
      }
      if (session.current !== active || request.signal.aborted) return null;
      if (active.id === undoId) {
        forgetPendingUndo(active.key, undoId);
        reload = active.retry;
        active.retry = false;
        active.id = null;
        setSelection({ key: active.key, undoId: null, recovering: false });
      }
      return result;
    } catch (cause) {
      if (session.current !== active || request.signal.aborted) return null;
      if (!isUncertainScheduleResponse(cause)) {
        forgetPendingUndo(active.key, undoId);
        active.retry = false;
        reload = cause instanceof ApiError && [404, 409].includes(cause.status);
        if (reload) active.id = null;
        setSelection({ key: active.key, undoId: active.id, recovering: false });
        throw cause;
      }
      throw new Error('되돌리기 결과를 확인하지 못했습니다. 되돌리기를 다시 누르면 같은 작업을 확인합니다.');
    } finally {
      active.request = null;
      if (reload) void active.load();
    }
  }, [actorId, key, kind, scopeId]);

  const current = selection?.key === key ? selection : null;
  return { undoId: current?.undoId ?? null, recovering: current?.recovering ?? false, remember, reload, undo };
}
