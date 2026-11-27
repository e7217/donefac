'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { commentWebUrl } from '../../shared/comment-web-links';
import type { JiraOriginalCommentLinksResult } from '../../shared/types';
import { api } from '../lib/api';
import './jira-original-comment-links.css';

type LinkPanel = { kind: 'closed' | 'loading' | 'error' } | { kind: 'ready'; result: JiraOriginalCommentLinksResult };

function safeResult(result: JiraOriginalCommentLinksResult): JiraOriginalCommentLinksResult {
  if (!result || !Array.isArray(result.links) || typeof result.limited !== 'boolean') throw new Error('원본 링크 응답이 올바르지 않습니다.');
  const links = result.links.filter(link => link && typeof link.href === 'string' && commentWebUrl(link.href) === link.href &&
    typeof link.label === 'string');
  return { links, limited: result.limited };
}

export function JiraOriginalCommentLinks({ commentId, actorId }: { commentId: string; actorId: string }) {
  const contentId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const [state, setState] = useState<LinkPanel>({ kind: 'closed' });
  const open = state.kind !== 'closed';

  useEffect(() => {
    function discard() {
      request.current?.abort();
      request.current = null;
      setState({ kind: 'closed' });
    }
    window.addEventListener('donefac:workspace-imported', discard);
    return () => {
      window.removeEventListener('donefac:workspace-imported', discard);
      request.current?.abort();
      request.current = null;
    };
  }, []);

  function read() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setState({ kind: 'loading' });
    void api<JiraOriginalCommentLinksResult>(`/comments/${encodeURIComponent(commentId)}/jira-original-links`, {
      cache: 'no-store', signal: controller.signal, headers: { 'X-Actor-Id': actorId },
    }).then(safeResult).then(result => {
      if (request.current === controller) setState({ kind: 'ready', result });
    }).catch(() => {
      if (request.current === controller) setState({ kind: 'error' });
    }).finally(() => {
      if (request.current === controller) request.current = null;
    });
  }

  function toggle() {
    if (!open) return read();
    request.current?.abort();
    request.current = null;
    setState({ kind: 'closed' });
  }

  return <div className="jira-original-comment-links">
    <button ref={button} type="button" className="btn btn-ghost" aria-expanded={open} aria-controls={contentId} onClick={toggle}>
      {open ? 'Jira 원본 링크 닫기' : 'Jira 원본 링크 확인'}
    </button>
    <div id={contentId} className="jira-original-comment-link-panel" hidden={!open}>
      {state.kind === 'loading' && <p role="status">Jira 원본 링크를 확인하는 중입니다.</p>}
      {state.kind === 'error' && <>
        <p role="alert">Jira 원본 링크를 불러오지 못했습니다.</p>
        <button type="button" className="btn btn-ghost" onClick={() => { button.current?.focus({ preventScroll: true }); read(); }}>다시 확인</button>
      </>}
      {state.kind === 'ready' && <>
        {state.result.links.length ? <>
          <p className="sr-only" role="status">Jira 원본 링크 {state.result.links.length}개를 확인했습니다.</p>
          <ul aria-label="Jira 원본 링크">
            {state.result.links.map(({ label, href }, index) => {
              const caption = label.trim() || href;
              return <li key={`${href}:${index}`}>
                <a className="comment-web-link" href={href} target="_blank" rel="noopener noreferrer">{caption}</a>
                {caption !== href && <span className="jira-original-comment-link-address">{href}</span>}
              </li>;
            })}
          </ul>
        </> : <p role="status">표시할 수 있는 Jira 원본 링크가 없습니다.</p>}
        {state.result.limited && <p role="status">조회 한도까지 확인했습니다. 원본에 링크가 더 있을 수 있습니다.</p>}
      </>}
    </div>
  </div>;
}
