'use client';

import { useEffect, useMemo, useState } from 'react';
import type { DocPage, DocumentChecklistWork, ResourceLink } from '../../shared/types';
import { api } from '../lib/api';

function isChecklistWork(result: DocumentChecklistWork | undefined, documentId: string, documentVersion: number): result is DocumentChecklistWork {
  return Boolean(result && result.documentId === documentId && result.documentVersion === documentVersion &&
    Array.isArray(result.links) && result.links.every(link => link && typeof link.linkId === 'string' && typeof link.issueId === 'string' &&
      link.sourceSelection && Number.isSafeInteger(link.sourceSelection.from) && Number.isSafeInteger(link.sourceSelection.to) &&
      link.sourceSelection.from >= 0 && link.sourceSelection.to > link.sourceSelection.from && typeof link.sourceSelection.text === 'string'));
}

export function useDocumentChecklistWork(document: Pick<DocPage, 'id' | 'version'> | null,
  resourceLinks: readonly ResourceLink[], { actorId, restoreGeneration, reload }: { actorId: string; restoreGeneration?: string; reload: number }) {
  const documentId = document?.id;
  const documentVersion = document?.version;
  const pinnedLinks = useMemo(() => {
    if (!documentId) return null;
    const pins = resourceLinks.flatMap(link => {
      const source = link.documentSource;
      return link.documentId === documentId && source
        ? [JSON.stringify([link.id, link.issueId, source.revisionId, source.from, source.to, source.text])] : [];
    });
    return pins.length ? JSON.stringify(pins.sort()) : null;
  }, [documentId, resourceLinks]);
  const key = pinnedLinks ? JSON.stringify([documentId, documentVersion, actorId, restoreGeneration, reload, pinnedLinks]) : null;
  const [loaded, setLoaded] = useState<{ key: string; links?: DocumentChecklistWork['links'] } | null>(null);

  useEffect(() => {
    if (!key || !documentId || documentVersion === undefined) return;
    const controller = new AbortController();
    const path = `/documents/${encodeURIComponent(documentId)}/checklist-work?expectedDocumentVersion=${documentVersion}`;
    void api<DocumentChecklistWork | undefined>(path, { cache: 'no-store', signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setLoaded({ key, links: isChecklistWork(result, documentId, documentVersion) ? result.links : undefined });
    }).catch(() => {
      if (!controller.signal.aborted) setLoaded({ key });
    });
    return () => controller.abort();
  }, [key, documentId, documentVersion]);

  return { links: loaded?.key === key ? loaded.links : undefined, hasPinnedLinks: pinnedLinks !== null };
}
