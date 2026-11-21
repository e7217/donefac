'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Favorite, FavoriteResourceType, FeatureProps } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { FavoriteButton, FavoritesView } from './Favorites';

const FAVORITES_CHANGED = 'teamspace:favorites-changed';

type Session = { actorId: string; pending: Set<string>; reader: AbortController | null };
type ListState = { session: Session; favorites: Favorite[]; pending: Set<string>; ready: boolean; loading: boolean; error: string };
type FavoriteState = {
  favorites: Favorite[];
  ready: boolean;
  loading: boolean;
  error: string;
  isPending: (type: FavoriteResourceType, id: string) => boolean;
  toggle: (type: FavoriteResourceType, id: string) => void;
  reload: () => void;
};

const FavoriteContext = createContext<FavoriteState | null>(null);
const favoriteKey = (type: FavoriteResourceType, id: string) => `${type}:${id}`;

export function FavoritesProvider({ actorId, notify, children }: Pick<FeatureProps, 'actorId' | 'notify'> & { children: ReactNode }) {
  const [state, setState] = useState<ListState | null>(null);
  const activeSession = useRef<Session | null>(null);

  const load = useCallback(async (session: Session) => {
    if (activeSession.current !== session || session.pending.size) return;
    session.reader?.abort();
    const reader = new AbortController();
    session.reader = reader;
    setState(previous => previous?.session === session ? { ...previous, loading: true } :
      { session, favorites: [], pending: new Set(), ready: false, loading: true, error: '' });
    try {
      const favorites = await api<Favorite[]>('/favorites', {
        headers: { 'X-Actor-Id': session.actorId }, signal: reader.signal, cache: 'no-store',
      });
      if (activeSession.current === session && !reader.signal.aborted) {
        setState(previous => previous?.session === session ? { ...previous, favorites, loading: false, ready: true, error: '' } : previous);
      }
    } catch (cause) {
      if (activeSession.current === session && !reader.signal.aborted) {
        const error = cause instanceof ApiError ? cause.message : '즐겨찾기를 불러오지 못했습니다.';
        setState(previous => previous?.session === session ? { ...previous, loading: false, error } : previous);
      }
    } finally {
      if (session.reader === reader) session.reader = null;
    }
  }, []);

  useEffect(() => {
    if (!actorId) return;
    const session: Session = { actorId, pending: new Set(), reader: null };
    activeSession.current = session;
    const refresh = () => { void load(session); };
    const change = (event: Event) => {
      if ((event as CustomEvent<string>).detail === actorId) refresh();
    };
    const timer = window.setTimeout(refresh, 0);
    window.addEventListener('focus', refresh);
    window.addEventListener('teamspace:trash-changed', refresh);
    window.addEventListener('teamspace:workspace-imported', refresh);
    window.addEventListener(FAVORITES_CHANGED, change);
    return () => {
      clearTimeout(timer);
      activeSession.current = null;
      session.reader?.abort();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('teamspace:trash-changed', refresh);
      window.removeEventListener('teamspace:workspace-imported', refresh);
      window.removeEventListener(FAVORITES_CHANGED, change);
    };
  }, [actorId, load]);

  const reload = useCallback(() => {
    const session = activeSession.current;
    if (session) void load(session);
  }, [load]);
  const visible = state?.session.actorId === actorId ? state : null;

  async function toggle(type: FavoriteResourceType, id: string) {
    const session = activeSession.current;
    const key = favoriteKey(type, id);
    if (!session || !visible?.ready || visible.session !== session || session.pending.has(key)) return;
    const matches = (row: Favorite) => row.resourceType === type && row.resourceId === id;
    const remove = visible.favorites.some(matches);
    session.pending.add(key);
    session.reader?.abort();
    const pending = new Set(session.pending);
    setState(previous => previous?.session === session ? { ...previous, pending, loading: false } : previous);
    try {
      const path = `/favorites/${type}/${encodeURIComponent(id)}`;
      const options = { headers: { 'X-Actor-Id': session.actorId } };
      let row: Favorite | null = null;
      if (remove) await api(path, { ...options, method: 'DELETE' });
      else row = await api<Favorite>(path, { ...options, method: 'PUT' });
      if (activeSession.current === session) {
        setState(previous => {
          if (previous?.session !== session) return previous;
          const favorites = previous.favorites.filter(item => !matches(item));
          return { ...previous, favorites: row ? [row, ...favorites] : favorites };
        });
      }
    } catch (cause) {
      if (activeSession.current === session) notify(cause instanceof ApiError ? cause.message : '즐겨찾기 변경 결과를 확인하지 못했습니다.', 'error');
    } finally {
      session.pending.delete(key);
      if (activeSession.current === session) {
        const pending = new Set(session.pending);
        setState(previous => previous?.session === session ? { ...previous, pending } : previous);
        void load(session);
      } else {
        // An actor may have been selected again while a write sent by an older session was pending.
        window.dispatchEvent(new CustomEvent(FAVORITES_CHANGED, { detail: session.actorId }));
      }
    }
  }

  return <FavoriteContext.Provider value={{
    favorites: visible?.favorites ?? [], ready: visible?.ready ?? false,
    loading: Boolean(actorId) && (visible?.loading ?? true), error: visible?.error ?? '',
    isPending: (type, id) => visible?.pending.has(favoriteKey(type, id)) ?? false,
    toggle: (type, id) => { void toggle(type, id); }, reload,
  }}>{children}</FavoriteContext.Provider>;
}

export function FavoriteAction({ type, id }: { type: FavoriteResourceType; id: string }) {
  const state = useContext(FavoriteContext);
  if (!state) return null;
  return <FavoriteButton favorite={state.favorites.some(row => row.resourceType === type && row.resourceId === id)}
    disabled={!state.ready} pending={state.isPending(type, id)} onToggle={() => state.toggle(type, id)} />;
}

export function FavoritesPage({ data, openIssue, openDocument, refresh }: Pick<FeatureProps, 'data' | 'openIssue' | 'openDocument' | 'refresh'>) {
  const state = useContext(FavoriteContext);
  const reload = state?.reload;
  useEffect(() => {
    reload?.();
    void refresh().catch(() => undefined);
  }, [reload, refresh]);
  return state && <FavoritesView data={data} favorites={state.favorites} loading={state.loading} error={state.error}
    isPending={state.isPending} openIssue={openIssue} openDocument={openDocument} toggle={state.toggle} retry={state.reload} />;
}
