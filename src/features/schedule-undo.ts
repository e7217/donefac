'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScheduleUndoInfo, ScheduleUndoResult, ScheduleUndoScope } from '../../shared/types';
import { api, ApiError } from '../lib/api';

const REQUEST_TIMEOUT = 20_000;

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
  load: () => void;
};

export function useScheduleUndo(scope: ScheduleUndoScope | null, actorId: string, restoreGeneration: string | null | undefined) {
  const kind = scope?.kind;
  const scopeId = scope && 'id' in scope ? scope.id : '';
  const key = kind && actorId ? JSON.stringify([actorId, restoreGeneration ?? null, kind, scopeId]) : null;
  const session = useRef<UndoSession | null>(null);
  const [selection, setSelection] = useState<{ key: string; undoId: string | null } | null>(null);

  useEffect(() => {
    if (!key || !kind) return;
    const active: UndoSession = { key, id: null, retry: false, lookup: null, request: null, load };
    session.current = active;
    const params = new URLSearchParams({ scope: kind });
    if (scopeId) params.set('id', scopeId);

    function load() {
      if (active.request || active.retry) return;
      active.lookup?.abort();
      const lookup = new AbortController();
      active.lookup = lookup;
      void api<{ undo: ScheduleUndoInfo | null }>(`/schedule/undo/latest?${params}`, {
        headers: scheduleUndoHeaders(null, actorId), cache: 'no-store',
        signal: AbortSignal.any([lookup.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
      }).then(({ undo }) => {
        if (lookup.signal.aborted || session.current !== active) return;
        if (undo !== null && typeof undo?.undoId !== 'string') return;
        active.id = undo?.undoId ?? null;
        setSelection({ key: active.key, undoId: active.id });
      }).catch(() => {
        // A failed lookup does not discard a receipt already held by this screen.
      }).finally(() => { if (active.lookup === lookup) active.lookup = null; });
    }

    load();
    window.addEventListener('focus', load);
    return () => {
      window.removeEventListener('focus', load);
      active.lookup?.abort();
      active.request?.abort();
      if (session.current === active) session.current = null;
    };
  }, [actorId, key, kind, scopeId]);

  const remember = useCallback((undoId: string) => {
    const active = session.current;
    if (!active || active.key !== key) return;
    active.lookup?.abort();
    active.id = undoId;
    active.retry = false;
    setSelection({ key: active.key, undoId });
  }, [key]);

  const undo = useCallback(async (): Promise<ScheduleUndoResult | null> => {
    const active = session.current;
    if (!active || active.key !== key || !kind || !active.id || active.request) return null;
    const undoId = active.id;
    const request = new AbortController();
    active.lookup?.abort();
    active.request = request;
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
        result = await send(true);
      }
      if (session.current !== active || request.signal.aborted) return null;
      if (active.id === undoId) {
        active.retry = false;
        active.id = null;
        setSelection({ key: active.key, undoId: null });
      }
      return result;
    } catch (cause) {
      if (session.current !== active || request.signal.aborted) return null;
      if (!isUncertainScheduleResponse(cause)) {
        active.retry = false;
        reload = cause instanceof ApiError && [404, 409].includes(cause.status);
        throw cause;
      }
      throw new Error('되돌리기 결과를 확인하지 못했습니다. 되돌리기를 다시 누르면 같은 작업을 확인합니다.');
    } finally {
      active.request = null;
      if (reload) active.load();
    }
  }, [actorId, key, kind, scopeId]);

  return { undoId: selection?.key === key ? selection.undoId : null, remember, undo };
}
