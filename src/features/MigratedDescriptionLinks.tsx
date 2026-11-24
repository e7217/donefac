'use client';

import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isDocumentSectionId } from '../../shared/document-sections';
import { isRelationId } from '../../shared/issue-relations';
import {
  confluenceMigratedDocumentAddress, type MigratedConfluenceDocumentTarget,
} from '../../shared/confluence-migration-address';
import { api } from '../lib/api';

export type OpenMigratedDocument = (target: MigratedConfluenceDocumentTarget, signal: AbortSignal) => void | Promise<void>;
export type MigratedDocumentLinks = { origins: readonly string[]; open: OpenMigratedDocument };
type LinkState = { id: string; status: 'pending' | 'missing' | 'failed' };
const LinkContext = createContext<{
  origins: ReadonlySet<string>;
  state: LinkState | null;
  resolve: (id: string, href: string, expectsSection: boolean) => void;
} | null>(null);

export function MigratedDescriptionLinks({ origins, open, children }: MigratedDocumentLinks & { children: ReactNode }) {
  const [state, setState] = useState<LinkState | null>(null);
  const request = useRef<{ id: string; controller: AbortController } | null>(null);
  const knownOrigins = useMemo(() => new Set(origins), [origins]);

  useLayoutEffect(() => () => request.current?.controller.abort(), []);

  async function resolve(id: string, href: string, expectsSection: boolean) {
    if (request.current?.id === id) return;
    request.current?.controller.abort();
    const controller = new AbortController();
    const { signal } = controller;
    request.current = { id, controller };
    setState({ id, status: 'pending' });
    try {
      const query = new URLSearchParams({ url: href });
      const { target } = await api<{ target: MigratedConfluenceDocumentTarget | null }>(`/atlassian-links/resolve-migrated-document?${query}`, {
        signal, cache: 'no-store',
      });
      if (signal.aborted) return;
      if (!target || !isRelationId(target.documentId) || (expectsSection ? !isDocumentSectionId(target.sectionId) : target.sectionId !== undefined)) {
        setState({ id, status: 'missing' });
        return;
      }
      await open(target, signal);
      if (!signal.aborted) setState(null);
    } catch {
      if (!signal.aborted) setState({ id, status: 'failed' });
    } finally {
      if (request.current?.controller === controller) request.current = null;
    }
  }

  return <LinkContext.Provider value={{ origins: knownOrigins, state, resolve }}>{children}</LinkContext.Provider>;
}

export function MigratedDescriptionLink({ href, title, children }: { href: string; title?: string; children: ReactNode }) {
  const id = useId();
  const links = useContext(LinkContext);
  const address = links && confluenceMigratedDocumentAddress(href);
  const status = links?.state?.id === id ? links.state.status : undefined;

  if (!links || !address || !links.origins.has(`${address.origin}${address.contextPath}`)) {
    return <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>;
  }

  return <span className="issue-description-migrated-link">
    <a href={href} title={title} target="_blank" rel="noopener noreferrer" aria-busy={status === 'pending' || undefined}
      onClick={event => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        links.resolve(id, href, Boolean(address.fragment));
      }}>{children}</a>
    {status && <span className="issue-description-link-status" role="status">
      {status === 'pending' ? '이관된 문서를 확인하는 중…' : status === 'missing'
        ? '이관된 문서를 확인할 수 없습니다.' : '이관된 문서를 조회하지 못했습니다.'}
      {status !== 'pending' && <> <a href={href} target="_blank" rel="noopener noreferrer">원본 열기</a></>}
    </span>}
  </span>;
}
