'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

type RefreshMode = 'automatic' | 'manual';
type RefreshFeedback = 'updated' | 'skipped' | 'failed';
export type WorkspaceRefresh = (signal: AbortSignal, mode: RefreshMode, canApply: () => boolean) => Promise<'updated' | 'unchanged' | 'skipped'>;

const REFRESH_INTERVAL_MS = 15_000;
const REFRESH_REQUEST_TIMEOUT_MS = 12_000;
const MAX_AUTOMATIC_REFRESH_WAIT_MS = 60_000;

export function useWorkspaceRefresh(refresh: WorkspaceRefresh, paused: boolean, hasLocalInteraction: () => boolean) {
  const [requestMode, setRequestMode] = useState<RefreshMode | null>(null);
  const [feedback, setFeedback] = useState<RefreshFeedback | null>(null);
  const pausedRef = useRef(paused);
  const controls = useRef<{ reconsider: () => void; manual: () => void }>(null);

  useLayoutEffect(() => {
    pausedRef.current = paused;
    controls.current?.reconsider();
  }, [paused]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | null = null;
    let retryDelay = REFRESH_INTERVAL_MS;
    let resumeAfterAbort = false;
    const clearTimer = () => clearTimeout(timer);
    const visible = () => active && !pausedRef.current && document.visibilityState === 'visible';
    const available = () => visible() && !hasLocalInteraction() && !document.querySelector('dialog:modal, [role="dialog"][aria-modal="true"]');

    function schedule(delay: number) {
      clearTimer();
      if (visible()) timer = setTimeout(() => void check('automatic'), delay);
    }

    async function check(mode: RefreshMode) {
      if (inFlight || !available()) {
        if (mode === 'automatic' && !inFlight) schedule(retryDelay);
        return;
      }
      clearTimer();
      const controller = new AbortController();
      inFlight = controller;
      const canApply = () => !controller.signal.aborted && available();
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REFRESH_REQUEST_TIMEOUT_MS);
      setRequestMode(mode);
      if (mode === 'manual') setFeedback(null);
      try {
        const outcome = await refresh(controller.signal, mode, canApply);
        if (!canApply()) return;
        if (outcome !== 'skipped') retryDelay = REFRESH_INTERVAL_MS;
        if (mode === 'manual') setFeedback(outcome === 'skipped' ? 'skipped' : 'updated');
        else if (outcome !== 'skipped') setFeedback(previous => previous === 'failed' ? null : previous);
      } catch {
        if (!available() || (controller.signal.aborted && !timedOut)) return;
        if (mode === 'automatic') retryDelay = Math.min(retryDelay * 2, MAX_AUTOMATIC_REFRESH_WAIT_MS);
        setFeedback('failed');
      } finally {
        clearTimeout(deadline);
        inFlight = null;
        if (active) {
          setRequestMode(null);
          schedule(resumeAfterAbort ? 0 : retryDelay);
        }
        resumeAfterAbort = false;
      }
    }

    function reconsider() {
      clearTimer();
      if (!visible() || hasLocalInteraction()) {
        resumeAfterAbort = false;
        inFlight?.abort();
      } else if (inFlight) resumeAfterAbort = inFlight.signal.aborted;
      else schedule(0);
    }

    controls.current = { reconsider, manual: () => void check('manual') };
    document.addEventListener('visibilitychange', reconsider);
    reconsider();
    return () => {
      active = false;
      clearTimer();
      inFlight?.abort();
      controls.current = null;
      document.removeEventListener('visibilitychange', reconsider);
    };
  }, [refresh, hasLocalInteraction]);

  const reconsider = useCallback(() => controls.current?.reconsider(), []);
  return { requestMode, feedback, manualRefresh: () => controls.current?.manual(), reconsider };
}
