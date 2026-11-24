'use client';

import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react';
import type { AtlassianSearchTarget } from '../../shared/atlassian-search';
import type { FeatureProps } from '../../shared/types';
import { workspaceAtlassianSearchAddress, type OriginalAddressMatches } from '../../shared/workspace-search';
import { api } from './api';

export const ATLASSIAN_LINKS_CHANGED = 'teamspace:atlassian-links-changed';

type RequestKey = { url: string; attempt: number };
type Lookup = { request: RequestKey; matches: OriginalAddressMatches | null };

export function useAtlassianSearch(query: string, data: FeatureProps['data'], refresh: FeatureProps['refresh'], delay = 0) {
  const address = useMemo(() => workspaceAtlassianSearchAddress(query), [query]);
  const url = address?.url;
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const request = useMemo(() => url ? { url, attempt } : null, [url, attempt]);
  const [lookup, setLookup] = useState<Lookup>();
  const current = lookup?.request === request ? lookup : undefined;
  const ensureTargetsLoaded = useEffectEvent(async (targets: readonly AtlassianSearchTarget[]) => {
    if (targets.some(({ targetType, targetId, commentId }) => {
      const items = targetType === 'issue' ? data.issues : data.documents;
      return commentId || !items.some(item => item.id === targetId);
    })) await refresh();
  });

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    async function resolve(url: string) {
      const parameters = new URLSearchParams({ url });
      const { targets } = await api<{ targets: AtlassianSearchTarget[] }>(`/atlassian-links/resolve?${parameters}`, {
        signal: controller.signal, cache: 'no-store',
      });
      if (controller.signal.aborted) return;
      await ensureTargetsLoaded(targets);
      if (controller.signal.aborted) return;
      const issueIds = new Set<string>(), documentIds = new Set<string>();
      const issueCommentIds = new Map<string, string>(), documentCommentIds = new Map<string, string>();
      for (const { targetType, targetId, commentId } of targets) {
        if (targetType === 'issue') {
          if (commentId) issueCommentIds.set(targetId, commentId);
          else issueIds.add(targetId);
        } else if (commentId) documentCommentIds.set(targetId, commentId);
        else documentIds.add(targetId);
      }
      return { issueIds, documentIds, issueCommentIds, documentCommentIds };
    }
    const timer = window.setTimeout(() => {
      void resolve(request.url).then(matches => {
        if (matches) setLookup({ request, matches });
      }, () => {
        if (!controller.signal.aborted) setLookup({ request, matches: null });
      });
    }, delay);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [request, delay]);

  useEffect(() => {
    if (!url) return;
    const events = ['focus', ATLASSIAN_LINKS_CHANGED, 'teamspace:workspace-imported', 'teamspace:trash-changed'];
    for (const event of events) window.addEventListener(event, retry);
    return () => { for (const event of events) window.removeEventListener(event, retry); };
  }, [url, retry]);

  const product = address?.product === 'jira' ? 'Jira' : 'Confluence';
  return {
    label: address ? `${product} ${address.commentId ? '댓글' : '원본'} 주소` : null,
    matches: current?.matches ?? undefined,
    pending: Boolean(request && !current),
    failed: current?.matches === null,
    retry,
  };
}
