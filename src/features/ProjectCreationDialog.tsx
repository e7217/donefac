'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import type { FeatureProps, Project } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import './project-creation-dialog.css';

type Recovery = { kind: 'request'; actorId: string; body: string } | { kind: 'created'; projectId: string } | { kind: 'workspace' };
type Props = Pick<FeatureProps, 'actorId' | 'refresh' | 'notify'> & {
  restoreGeneration?: string;
  onClose: () => void;
  onOpenProject: (id: string) => boolean;
};

function reasonOf(cause: ApiError) {
  return cause.details && typeof cause.details === 'object' && 'reason' in cause.details ? cause.details.reason : undefined;
}

export function ProjectCreationDialog({ actorId, restoreGeneration, refresh, notify, onClose, onOpenProject }: Props) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const opening = useRef(false);
  const titleId = useId();
  const hintId = useId();
  const dirty = Boolean(name || key || description);

  useEffect(() => {
    const current = dialog.current;
    if (!current) return;
    current.showModal();
    nameInput.current?.focus();
    return () => { if (current.open) current.close(); };
  }, []);

  useEffect(() => {
    if (!busy && recovery) submitButton.current?.focus();
  }, [busy, recovery]);

  function confirmLeave(action: '닫을까요?' | '이동할까요?') {
    if (recovery?.kind === 'created' || recovery?.kind === 'request') {
      const status = recovery.kind === 'created' ? '프로젝트를 만들었습니다.' : '프로젝트가 이미 만들어졌을 수 있습니다.';
      return window.confirm(`${status} 프로젝트 목록에서 결과를 확인할 수 있습니다. ${action}`);
    }
    return !dirty || window.confirm(`작성 중인 프로젝트 입력을 버리고 ${action}`);
  }

  function dismiss() {
    if (recovery?.kind === 'created' || recovery?.kind === 'request') {
      void refresh().catch(() => notify('프로젝트 목록을 불러오지 못했습니다. 새로고침한 뒤 확인해 주세요.', 'error'));
    }
    onClose();
  }

  useEffect(() => {
    function navigate(event: Event) {
      if (event.defaultPrevented || opening.current) return;
      if (pending.current || !confirmLeave('이동할까요?')) { event.preventDefault(); return; }
      afterAcceptedNavigation(event, dismiss);
    }
    function unload(event: BeforeUnloadEvent) {
      if (pending.current || dirty) { event.preventDefault(); event.returnValue = ''; }
    }
    window.addEventListener('teamspace:navigate', navigate);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', navigate);
      window.removeEventListener('beforeunload', unload);
    };
  });

  function close() {
    if (pending.current || !confirmLeave('닫을까요?')) return;
    dismiss();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !actorId) return;
    pending.current = true;
    setBusy(true);
    setError('');
    let stage = recovery;
    try {
      if (stage?.kind === 'workspace') {
        await refresh();
        setRecovery(null);
        return;
      }
      if (stage === null) {
        const body = JSON.stringify({ name, key, description, color: '#177c72', requestId: newRequestId(), restoreGeneration });
        stage = { kind: 'request', actorId, body };
      }
      if (stage.kind === 'request') {
        const project = await api<Project>('/projects', { method: 'POST', headers: { 'X-Actor-Id': stage.actorId }, body: stage.body });
        if (typeof project?.id !== 'string' || !project.id || project.key !== key) throw new Error('프로젝트 생성 응답을 읽을 수 없습니다.');
        stage = { kind: 'created', projectId: project.id };
        setRecovery(stage);
      }
      await refresh();
      opening.current = true;
      if (onOpenProject(stage.projectId)) {
        notify(recovery ? '만든 프로젝트를 열었습니다.' : '프로젝트를 만들었습니다.');
        onClose();
      } else {
        setError('프로젝트는 저장되었습니다. 다시 열거나 현재 프로젝트 목록을 확인해 주세요.');
      }
    } catch (cause) {
      if (stage?.kind === 'created') {
        setError('프로젝트는 저장되었습니다. 목록을 다시 불러와 프로젝트를 열어 주세요.');
      } else if (stage?.kind === 'workspace') {
        setError('프로젝트 목록을 불러오지 못했습니다. 다시 시도해 주세요.');
      } else if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 &&
          ![408, 425, 429, 499].includes(cause.status) && !(recovery && [401, 403].includes(cause.status))) {
        setRecovery(['workspace_changed', 'result_unavailable', 'request_conflict'].includes(String(reasonOf(cause))) ? { kind: 'workspace' } : null);
        setError(cause.message);
      } else {
        setRecovery(stage);
        setError('프로젝트 생성 결과를 확인할 수 없습니다. 같은 요청으로 다시 확인해 주세요.');
      }
    } finally {
      pending.current = false;
      opening.current = false;
      setBusy(false);
    }
  }

  const action = recovery?.kind === 'request' ? '생성 결과 다시 확인' : recovery?.kind === 'created' ? '저장한 프로젝트 열기'
    : recovery?.kind === 'workspace' ? '프로젝트 목록 새로고침' : '프로젝트 만들기';

  return <dialog ref={dialog} className="modal-card project-creation-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={submit}>
      <div className="card-heading"><h2 id={titleId}>새 프로젝트</h2>
        <button type="button" className="icon-btn" onClick={close} disabled={busy} aria-label="닫기"><X size={19}/></button>
      </div>
      <fieldset disabled={busy || Boolean(recovery)}>
        <label className="form-label">프로젝트 이름<input ref={nameInput} className="field" required maxLength={100} value={name}
          onChange={event => setName(event.target.value)} placeholder="예: 제품 개발"/></label>
        <div className="form-label"><label htmlFor={`${hintId}-key`}>티켓 접두어</label>
          <input id={`${hintId}-key`} className="field" required value={key} onChange={event => setKey(event.target.value.toUpperCase())}
            placeholder="예: DEV" pattern="[A-Z][A-Z0-9]{1,11}" minLength={2} maxLength={12} aria-describedby={hintId}/>
          <span id={hintId} className="help-text">영문 대문자로 시작하는 영문·숫자 2~12자 · DEV-1처럼 사용합니다.</span>
        </div>
        <label className="form-label">프로젝트 소개<textarea className="field" value={description}
          onChange={event => setDescription(event.target.value)} rows={3}/></label>
      </fieldset>
      {!actorId && <p className="project-creation-message">워크스페이스 설정에서 팀원을 먼저 등록해 주세요.</p>}
      {error && <p className="project-creation-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="btn" disabled={busy} onClick={close}>취소</button>
        <button ref={submitButton} type="submit" className="btn btn-primary" disabled={busy || !actorId || !name.trim()}>
          {busy ? '처리 중…' : action}
        </button>
      </div>
    </form>
  </dialog>;
}
