'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { FeatureProps, User, UserEmailChangeResult, WorkspaceSnapshot } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import './workspace-member-email.css';

type Props = Pick<FeatureProps, 'actorId' | 'refresh' | 'notify'> & {
  user: User;
  restoreGeneration?: string;
  onClose: () => void;
};
type Recovery = { kind: 'request'; actorId: string; body: string } | { kind: 'refresh' } | { kind: 'review'; currentEmail?: string };
const reviewReasons = new Set(['member_changed', 'workspace_changed', 'request_conflict', 'member_unavailable']);

export function WorkspaceMemberEmailDialog({ user, restoreGeneration, actorId, refresh, notify, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const actionButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const titleId = useId();
  const [base, setBase] = useState({ user, restoreGeneration });
  const [email, setEmail] = useState(user.email);
  const [recovery, setRecovery] = useState<Recovery | null>(restoreGeneration ? null : { kind: 'review' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = email.trim().toLowerCase() !== base.user.email;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);

  useEffect(() => {
    if (!busy) (recovery ? actionButton : emailInput).current?.focus();
  }, [busy, recovery]);

  function canDismiss() {
    if (pending.current) return false;
    if (recovery?.kind === 'request') {
      return window.confirm('이메일이 이미 변경되었을 수 있습니다. 팀원 목록에서 확인할 수 있습니다. 편집을 닫을까요?');
    }
    return recovery?.kind === 'refresh' || !dirty || window.confirm('입력한 이메일을 버리고 편집을 닫을까요?');
  }

  function dismiss() {
    if (recovery?.kind === 'request' || recovery?.kind === 'refresh') {
      void refresh().catch(() => notify('팀원 목록을 불러오지 못했습니다. 다시 열어 확인해 주세요.', 'error'));
    }
    onClose();
  }

  useEffect(() => {
    function navigate(event: Event) {
      if (event.defaultPrevented) return;
      if (canDismiss()) afterAcceptedNavigation(event, dismiss);
      else event.preventDefault();
    }
    function unload(event: BeforeUnloadEvent) {
      if (pending.current || recovery?.kind === 'request' || (dirty && recovery?.kind !== 'refresh')) {
        event.preventDefault();
        event.returnValue = '';
      }
    }
    window.addEventListener('teamspace:navigate', navigate);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', navigate);
      window.removeEventListener('beforeunload', unload);
    };
  });

  function close() {
    if (canDismiss()) dismiss();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !actorId) return;
    if (!recovery && (!dirty || !base.restoreGeneration)) return;
    pending.current = true;
    setBusy(true);
    setError('');
    let stage = recovery;
    try {
      if (stage?.kind === 'review') {
        const latest = await api<WorkspaceSnapshot>('/workspace', { cache: 'no-store', headers: { 'X-Actor-Id': actorId } });
        const member = latest.users.find(candidate => candidate.id === user.id);
        if (!member) {
          setError('현재 팀원 목록에 이 팀원이 없습니다.');
          return;
        }
        if (!latest.restoreGeneration) throw new Error('작업 공간 버전을 읽지 못했습니다.');
        setBase({ user: member, restoreGeneration: latest.restoreGeneration });
        setRecovery(null);
        return;
      }
      if (!stage) {
        const body = JSON.stringify({ email, expectedVersion: base.user.version ?? 1,
          restoreGeneration: base.restoreGeneration, requestId: newRequestId() });
        stage = { kind: 'request', actorId, body };
      }
      if (stage.kind === 'request') {
        const result = await api<UserEmailChangeResult>(`/users/${user.id}`, {
          method: 'PATCH', headers: { 'X-Actor-Id': stage.actorId }, body: stage.body,
        });
        if (result?.user?.id !== user.id || !Number.isSafeInteger(result.appliedVersion) || result.appliedVersion < 1 ||
            typeof result.duplicate !== 'boolean') {
          throw new Error('이메일 변경 응답을 읽을 수 없습니다.');
        }
        stage = { kind: 'refresh' };
        setRecovery(stage);
      }
      await refresh();
      notify(recovery ? '이메일 변경 결과를 확인했습니다.' : '이메일 주소를 변경했습니다.');
      onClose();
    } catch (cause) {
      if (stage?.kind === 'refresh') {
        setError('이메일 변경은 저장되었습니다. 팀원 목록을 다시 불러와 주세요.');
      } else if (stage?.kind === 'review') {
        setError('현재 팀원 정보를 불러오지 못했습니다. 다시 시도해 주세요.');
      } else if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 &&
          ![408, 425, 429, 499].includes(cause.status) && !(recovery && [401, 403].includes(cause.status))) {
        const details = cause.details as { reason?: string; currentUser?: User } | undefined;
        setRecovery(reviewReasons.has(details?.reason ?? '') ? { kind: 'review', currentEmail: details?.currentUser?.email } : null);
        setError(cause.message);
      } else {
        setRecovery(stage);
        setError('이메일 변경 결과를 확인할 수 없습니다. 같은 요청으로 다시 확인해 주세요.');
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const action = recovery?.kind === 'request' ? '변경 결과 다시 확인' : recovery?.kind === 'refresh' ? '팀원 목록 다시 불러오기'
    : recovery?.kind === 'review' ? '현재 팀원 정보 다시 확인' : '이메일 저장';
  const currentEmail = recovery?.kind === 'review' ? recovery.currentEmail : base.user.email;
  return <dialog ref={dialog} className="modal-card workspace-member-email-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={submit}>
      <h2 id={titleId}>팀원 이메일 변경</h2>
      <p><strong>{base.user.name}</strong>{currentEmail && <> · 현재 이메일 <span>{currentEmail}</span></>}</p>
      <label className="form-label">새 이메일<input ref={emailInput} type="email" className="field" maxLength={254} required
        value={email} disabled={busy || Boolean(recovery)} onChange={event => setEmail(event.target.value)}/></label>
      {error && <p className="workspace-member-email-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={close} disabled={busy}>취소</button>
        <button ref={actionButton} type="submit" className="btn btn-primary" disabled={busy || !actorId || (!recovery && !dirty)}>
          {busy ? '처리 중…' : action}
        </button>
      </div>
    </form>
  </dialog>;
}
