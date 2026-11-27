'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, Link2, Plus, RefreshCw, Unlink } from 'lucide-react';
import { MAX_ATLASSIAN_LINK_URL_LENGTH, type AtlassianLink, type AtlassianLinkPreview, type AtlassianLinkTarget, type AtlassianProduct } from '../../shared/atlassian-links';
import type { FeatureProps } from '../../shared/types';
import { api } from '../lib/api';
import { ATLASSIAN_LINKS_CHANGED } from '../lib/use-atlassian-search';
import './atlassian-links.css';

type Props = Pick<FeatureProps, 'actorId' | 'notify'> & { targetType: AtlassianLinkTarget; targetId: string; readOnly?: boolean };
type LinkList = { links: AtlassianLink[] } | { error: string };
type Preview = { result: AtlassianLinkPreview } | { error: string };

const productLabel: Record<AtlassianProduct, string> = { jira: 'Jira', confluence: 'Confluence' };
const messageOf = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const linkPath = (id: string) => `/atlassian-links/${encodeURIComponent(id)}`;

export function AtlassianLinks(props: Props) {
  const [workspaceRevision, reload] = useState(0);
  useEffect(() => {
    const imported = () => reload(value => value + 1);
    window.addEventListener('donefac:workspace-imported', imported);
    return () => window.removeEventListener('donefac:workspace-imported', imported);
  }, []);

  if (!props.actorId) return null;
  return <LinkPanel key={JSON.stringify([props.targetType, props.targetId, props.actorId, workspaceRevision])} {...props} />;
}

function LinkPanel({ targetType, targetId, actorId, notify, readOnly }: Props) {
  const panelId = useId();
  const headingId = `${panelId}-heading`;
  const productId = `${panelId}-product`;
  const urlId = `${panelId}-url`;
  const [list, setList] = useState<LinkList | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [product, setProduct] = useState<AtlassianProduct>(targetType === 'issue' ? 'jira' : 'confluence');
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState<'create' | `remove:${string}` | null>(null);
  const [addError, setAddError] = useState('');
  const mutation = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ targetType, targetId });
    void api<AtlassianLink[]>(`/atlassian-links?${query}`, {
      signal: controller.signal, headers: { 'X-Actor-Id': actorId },
    }).then(links => {
      if (!controller.signal.aborted) setList({ links });
    }, error => {
      if (!controller.signal.aborted) setList({ error: messageOf(error, '원본 링크를 불러오지 못했습니다.') });
    });
    return () => controller.abort();
  }, [targetType, targetId, actorId, attempt]);

  useEffect(() => () => mutation.current?.abort(), []);

  async function addLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!url.trim() || mutation.current || !list || !('links' in list)) return;
    const controller = new AbortController();
    mutation.current = controller;
    setPending('create');
    setAddError('');
    try {
      const link = await api<AtlassianLink>('/atlassian-links', {
        method: 'POST', signal: controller.signal, headers: { 'X-Actor-Id': actorId },
        body: JSON.stringify({ targetType, targetId, product, url: url.trim() }),
      });
      if (controller.signal.aborted) return;
      setList(current => current && 'links' in current && !current.links.some(item => item.id === link.id)
        ? { links: [...current.links, link] } : current);
      setUrl('');
      window.dispatchEvent(new Event(ATLASSIAN_LINKS_CHANGED));
      notify('원본 링크를 연결했습니다.');
    } catch (error) {
      if (!controller.signal.aborted) setAddError(messageOf(error, '원본 링크를 추가하지 못했습니다.'));
    } finally {
      if (!controller.signal.aborted) {
        mutation.current = null;
        setPending(null);
      }
    }
  }

  async function removeLink(id: string) {
    if (mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setPending(`remove:${id}`);
    try {
      await api(linkPath(id), { method: 'DELETE', signal: controller.signal, headers: { 'X-Actor-Id': actorId } });
      if (controller.signal.aborted) return;
      setList(current => current && 'links' in current ? { links: current.links.filter(link => link.id !== id) } : current);
      window.dispatchEvent(new Event(ATLASSIAN_LINKS_CHANGED));
      notify('원본 링크 연결을 해제했습니다.');
    } catch (error) {
      if (!controller.signal.aborted) notify(messageOf(error, '원본 링크 연결을 해제하지 못했습니다.'), 'error');
    } finally {
      if (!controller.signal.aborted) {
        mutation.current = null;
        setPending(null);
      }
    }
  }

  const links = list && 'links' in list ? list.links : null;
  const disabled = pending !== null || links === null;
  return <section className="atlassian-links" aria-labelledby={headingId}>
    <h3 id={headingId}><Link2 aria-hidden="true" size={16} />기존 도구 연결</h3>
    {!readOnly && <form className="atlassian-links-form" onSubmit={addLink}>
      <div>
        <label htmlFor={productId}>기존 도구</label>
        <select id={productId} className="field" value={product} disabled={disabled} onChange={event => setProduct(event.target.value as AtlassianProduct)}>
          <option value="jira">Jira</option>
          <option value="confluence">Confluence</option>
        </select>
      </div>
      <div>
        <label htmlFor={urlId}>원본 URL</label>
        <input id={urlId} className="field" type="url" value={url} maxLength={MAX_ATLASSIAN_LINK_URL_LENGTH}
          required disabled={disabled} onChange={event => { setUrl(event.target.value); if (addError) setAddError(''); }} />
      </div>
      <button className="btn btn-secondary" type="submit" disabled={disabled || !url.trim()}>
        <Plus aria-hidden="true" size={14} />{pending === 'create' ? '원본 링크 추가 중…' : '원본 링크 추가'}
      </button>
    </form>}
    {addError && <p className="atlassian-links-error" role="alert">{addError}</p>}
    {list === null && <p className="atlassian-links-note" role="status">원본 링크를 불러오는 중…</p>}
    {list && 'error' in list && <div className="atlassian-links-error">
      <p role="alert">{list.error}</p>
      <button className="btn" type="button" onClick={() => { setList(null); setAttempt(value => value + 1); }}>다시 불러오기</button>
    </div>}
    {links?.length === 0 && <p className="atlassian-links-note">연결된 Jira 티켓이나 Confluence 문서가 없습니다.</p>}
    {links && links.length > 0 && <ul className="atlassian-links-list">{links.map(link => <LinkRow key={link.id} link={link} actorId={actorId}
      mutationPending={pending !== null} removing={pending === `remove:${link.id}`} onRemove={readOnly ? undefined : () => void removeLink(link.id)} />)}</ul>}
  </section>;
}

function LinkRow({ link, actorId, mutationPending, removing, onRemove }: {
  link: AtlassianLink; actorId: string; mutationPending: boolean; removing: boolean; onRemove?: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reading, setReading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function readPreview() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setReading(true);
    setPreview(null);
    try {
      const result = await api<AtlassianLinkPreview>(`${linkPath(link.id)}/preview`, {
        signal: controller.signal, headers: { 'X-Actor-Id': actorId },
      });
      if (!controller.signal.aborted) setPreview({ result });
    } catch (error) {
      if (!controller.signal.aborted) setPreview({ error: messageOf(error, '원본 정보를 조회하지 못했습니다.') });
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setReading(false);
      }
    }
  }

  const result = preview && 'result' in preview ? preview.result : null;
  const updatedAt = result?.updatedAt ? new Date(result.updatedAt) : null;
  return <li className="atlassian-link-row">
    <strong>{productLabel[link.product]}</strong>
    <p className="atlassian-link-url">{link.url}</p>
    <div className="atlassian-link-actions">
      <a className="btn" href={link.url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" size={14} />원본 열기</a>
      <button className="btn" type="button" disabled={reading || removing} onClick={() => void readPreview()}>
        <RefreshCw aria-hidden="true" size={14} />원본 정보 조회
      </button>
      {onRemove && <button className="btn btn-ghost" type="button" disabled={mutationPending} onClick={onRemove}>
        <Unlink aria-hidden="true" size={14} />{removing ? '연결 해제 중…' : '연결 해제'}
      </button>}
    </div>
    {reading && <p className="atlassian-links-note" role="status">원본 정보를 불러오는 중…</p>}
    {preview && 'error' in preview && <p className="atlassian-links-error" role="alert">{preview.error}</p>}
    {result && <div className="atlassian-link-preview" aria-live="polite">
      <strong>{result.title}</strong>
      <dl>
        <div><dt>원본 ID</dt><dd>{result.locator}</dd></div>
        {result.status && <div><dt>상태</dt><dd>{result.status}</dd></div>}
        {updatedAt && Number.isFinite(updatedAt.getTime()) && <div><dt>원본 수정</dt><dd>
          <time dateTime={updatedAt.toISOString()}>{updatedAt.toLocaleString('ko-KR')}</time>
        </dd></div>}
      </dl>
    </div>}
  </li>;
}
