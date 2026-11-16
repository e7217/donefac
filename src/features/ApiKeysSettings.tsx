'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { ApiKeyCreated, ApiKeyRecord, FeatureProps, Project } from '../../shared/types';
import { api } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import './api-keys.css';

export interface ApiKeysSettingsProps { actorId: string; projects: Project[]; notify: FeatureProps['notify'] }
const timestamp = (value: string | null) => value ? new Date(value).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '없음';

export function ApiKeysSettings(props: ApiKeysSettingsProps) {
  return <ActorApiKeysSettings key={props.actorId} {...props} />;
}
function ActorApiKeysSettings({ actorId, projects, notify }: ApiKeysSettingsProps) {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [access, setAccess] = useState<'read' | 'write'>('read');
  const [scope, setScope] = useState<'selected' | 'all'>('selected');
  const [projectIds, setProjectIds] = useState<string[]>(projects[0] ? [projects[0].id] : []);
  const [expiry, setExpiry] = useState('90');
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const createdRef = useRef<ApiKeyCreated | null>(null);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const secretInput = useRef<HTMLInputElement>(null);
  const ownerRef = useRef(actorId);
  const activeRef = useRef(true);
  const loadSequence = useRef(0);
  const selectedProjects = projectIds.filter(id => projects.some(project => project.id === id));

  const load = useCallback(async () => {
    if (!activeRef.current || ownerRef.current !== actorId) return;
    const sequence = ++loadSequence.current;
    try {
      const result = await api<ApiKeyRecord[]>('/api-keys', { headers: { 'X-Actor-Id': actorId } });
      if (activeRef.current && ownerRef.current === actorId && sequence === loadSequence.current) { setKeys(result); setClock(Date.now()); setError(''); }
    } catch (cause) { if (activeRef.current && ownerRef.current === actorId && sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : 'API 키를 불러오지 못했습니다.'); }
    finally { if (activeRef.current && ownerRef.current === actorId && sequence === loadSequence.current) setLoading(false); }
  }, [actorId]);

  useEffect(() => {
    ownerRef.current = actorId;
    activeRef.current = true;
    const sequence = ++loadSequence.current;
    void api<ApiKeyRecord[]>('/api-keys', { headers: { 'X-Actor-Id': actorId } })
      .then(result => { if (activeRef.current && sequence === loadSequence.current) { setKeys(result); setClock(Date.now()); setError(''); } })
      .catch(cause => { if (activeRef.current && sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : 'API 키를 불러오지 못했습니다.'); })
      .finally(() => { if (activeRef.current && sequence === loadSequence.current) setLoading(false); });
    return () => { activeRef.current = false; };
  }, [actorId]);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 60_000); return () => clearInterval(timer); }, []);

  function clearSecret() { createdRef.current = null; setCreated(null); setCopied(false); }
  function dismissSecret() {
    if (!window.confirm('이 창을 닫으면 API 키 전체 값을 다시 확인할 수 없습니다. 필요한 곳에 복사했나요?')) return;
    clearSecret();
  }
  useEffect(() => {
    const navigate = (event: Event) => {
      if (event.defaultPrevented) return;
      if (creatingRef.current) { event.preventDefault(); notify('API 키 발급이 끝난 후 이동해주세요.', 'error'); return; }
      if (createdRef.current) {
        if (!window.confirm('발급한 API 키를 복사했나요? 이동하면 전체 값을 다시 확인할 수 없습니다.')) event.preventDefault();
        else afterAcceptedNavigation(event, () => { createdRef.current = null; setCreated(null); setCopied(false); });
      }
    };
    const unload = (event: BeforeUnloadEvent) => { if (createdRef.current || creatingRef.current) { event.preventDefault(); event.returnValue = ''; } };
    const imported = () => { createdRef.current = null; setCreated(null); setCopied(false); void load(); };
    window.addEventListener('teamspace:navigate', navigate);
    window.addEventListener('beforeunload', unload);
    window.addEventListener('teamspace:workspace-imported', imported);
    return () => { window.removeEventListener('teamspace:navigate', navigate); window.removeEventListener('beforeunload', unload); window.removeEventListener('teamspace:workspace-imported', imported); };
  }, [load, notify]);

  async function createKey(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || creatingRef.current || (scope === 'selected' && !selectedProjects.length)) return;
    creatingRef.current = true; setCreating(true); setError('');
    const owner = actorId;
    try {
      const result = await api<ApiKeyCreated>('/api-keys', { method: 'POST', headers: { 'X-Actor-Id': owner }, body: JSON.stringify({ name: name.trim(), access, projectIds: scope === 'all' ? null : selectedProjects, expiresAt: expiry === 'never' ? null : new Date(Date.now() + Number(expiry) * 86_400_000).toISOString() }) });
      if (ownerRef.current === owner) { createdRef.current = result; setCreated(result); setCopied(false); setName(''); }
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'API 키를 발급하지 못했습니다.'); }
    finally { creatingRef.current = false; setCreating(false); }
  }

  async function copyToken() {
    if (!createdRef.current) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(createdRef.current.token);
      else {
        secretInput.current?.select();
        if (!document.execCommand('copy')) throw new Error('복사 기능을 사용할 수 없습니다. 키 값을 직접 선택해 복사해주세요.');
      }
      setCopied(true);
    } catch { secretInput.current?.select(); notify('키 값을 직접 선택해 복사해주세요.', 'error'); }
  }

  async function revokeKey(key: ApiKeyRecord) {
    if (revoking || !window.confirm(`“${key.name}” API 키를 폐기할까요? 이 키를 사용하는 자동화는 즉시 접근할 수 없게 됩니다.`)) return;
    setRevoking(key.id);
    try {
      await api(`/api-keys/${encodeURIComponent(key.id)}/revoke`, { method: 'POST', headers: { 'X-Actor-Id': actorId }, body: JSON.stringify({ expectedVersion: key.version }) });
      if (!activeRef.current || ownerRef.current !== actorId) return;
      await load(); notify('API 키를 폐기했습니다.', 'success');
    } catch (cause) { await load(); setError(cause instanceof Error ? cause.message : 'API 키를 폐기하지 못했습니다.'); }
    finally { setRevoking(null); }
  }

  return <section className="card settings-card api-keys-settings" aria-labelledby="api-keys-title">
    <div className="card-heading"><h2 id="api-keys-title"><KeyRound size={17} /> 개인 API 키</h2><button className="icon-btn" aria-label="API 키 목록 새로고침" disabled={loading} onClick={() => { setLoading(true); setError(''); void load(); }}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button></div>
    <p className="muted">현재 선택한 작업자의 자동화 키입니다. 외부 자동화는 <code>/api/v1</code> 주소와 Bearer 키를 사용합니다.</p>
    <form className="api-key-form" onSubmit={createKey}>
      <label>키 이름<input className="field" aria-label="API 키 이름" value={name} maxLength={120} onChange={event => setName(event.target.value)} placeholder="예: 주간 보고 자동화" required disabled={creating} /></label>
      <div className="api-key-form-row"><label>권한<select className="field" aria-label="API 키 권한" value={access} disabled={creating} onChange={event => setAccess(event.target.value as 'read' | 'write')}><option value="read">읽기 전용</option><option value="write">읽기·쓰기</option></select></label><label>만료<select className="field" aria-label="API 키 만료" value={expiry} disabled={creating} onChange={event => setExpiry(event.target.value)}><option value="30">30일 후</option><option value="90">90일 후</option><option value="365">365일 후</option><option value="never">만료 없음</option></select></label></div>
      <label>프로젝트 범위<select className="field" aria-label="API 키 프로젝트 범위" value={scope} disabled={creating} onChange={event => setScope(event.target.value as 'selected' | 'all')}><option value="selected">선택한 프로젝트</option><option value="all">전체 워크스페이스 · 공통 문서 포함</option></select></label>
      {scope === 'selected' && <fieldset className="api-key-projects"><legend>허용할 프로젝트</legend>{projects.map(project => <label key={project.id}><input type="checkbox" aria-label={`${project.name} API 접근 허용`} checked={projectIds.includes(project.id)} disabled={creating} onChange={event => setProjectIds(previous => event.target.checked ? [...previous, project.id] : previous.filter(id => id !== project.id))} /><span>{project.name}</span></label>)}</fieldset>}
      <div className="api-key-create-action"><span><ShieldCheck size={13} /> 키는 선택한 작업자의 이름으로 동작합니다.</span><button type="submit" className="btn btn-primary" disabled={creating || !name.trim() || (scope === 'selected' && !selectedProjects.length)}>{creating ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} API 키 발급</button></div>
    </form>
    {error && <p className="api-key-error" role="alert">{error}</p>}
    <div className="api-key-list" aria-label="발급한 API 키 목록">{loading && !keys.length ? <p className="muted">API 키를 불러오는 중…</p> : !keys.length ? <div className="api-key-empty"><KeyRound size={24} /><p>아직 발급한 API 키가 없습니다.</p></div> : keys.map(key => {
      const expired = key.expiresAt !== null && Date.parse(key.expiresAt) <= clock;
      return <article className="api-key-row" key={key.id}><div className="api-key-row-main"><strong>{key.name}</strong><span className={`api-key-state ${key.revokedAt || expired ? 'is-inactive' : ''}`}>{key.revokedAt ? '폐기됨' : expired ? '만료됨' : '사용 가능'}</span><code>{key.prefix}…</code><span className="api-key-access">{key.access === 'read' ? '읽기 전용' : '읽기·쓰기'}</span></div><p className="api-key-scope">{key.projectIds === null ? '전체 워크스페이스' : key.projectIds.map(id => projects.find(project => project.id === id)?.name || '삭제된 프로젝트').join(', ')}</p><div className="api-key-dates"><span>발급 {timestamp(key.createdAt)}</span><span>만료 {timestamp(key.expiresAt)}</span><span>최근 사용 {key.lastUsedAt ? timestamp(key.lastUsedAt) : '사용 기록 없음'}</span></div>{!key.revokedAt && <button className="btn btn-ghost api-key-revoke" aria-label={`${key.name} API 키 폐기`} disabled={Boolean(revoking)} onClick={() => void revokeKey(key)}>{revoking === key.id ? <Loader2 size={12} className="spin" /> : '폐기'}</button>}</article>;
    })}</div>
    {created && <div className="modal-backdrop api-key-secret-backdrop"><div className="modal-card api-key-secret-dialog" role="dialog" aria-modal="true" aria-labelledby="api-key-secret-title"><div className="card-heading"><h2 id="api-key-secret-title">API 키를 복사해주세요</h2><button className="icon-btn" aria-label="발급한 API 키 창 닫기" onClick={dismissSecret}><X size={18} /></button></div><p>전체 키는 지금 한 번만 표시됩니다. 창을 닫으면 다시 확인할 수 없습니다.</p><label>발급한 API 키<input ref={secretInput} className="field api-key-secret" aria-label="발급한 API 키" readOnly value={created.token} onFocus={event => event.target.select()} autoComplete="off" spellCheck={false} /></label><div className="api-key-secret-actions"><button className="btn" onClick={() => void copyToken()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '복사됨' : '키 복사'}</button><button className="btn btn-primary" onClick={dismissSecret}>확인하고 닫기</button></div></div></div>}
  </section>;
}
