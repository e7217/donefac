'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ListChecks, X } from 'lucide-react';
import {
  ISSUE_BULK_EDIT_LIMIT, PRIORITY, type FeatureProps, type Issue, type IssueBulkEditChanges, type IssueBulkEditPreview,
  type IssueBulkEditPreviewInput, type IssueBulkEditResult, type IssueBulkEditValues, type Priority, type WorkflowStatus,
} from '../../shared/types';
import { ApiError, api } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { errorMessage } from './schedule-utils';
import './issue-bulk-edit.css';

interface EditSession {
  scope: string;
  ids: Set<string>;
  changes: IssueBulkEditChanges;
  preview: { result: IssueBulkEditPreview; input: string } | null;
  error: string;
  refreshRequired: boolean;
  applyUncertain: boolean;
}

function initialSession(scope: string): EditSession {
  return { scope, ids: new Set(), changes: {}, preview: null, error: '', refreshRequired: false, applyUncertain: false };
}

function discardPrompt(uncertain: boolean) {
  return uncertain ? '적용 결과를 확인하지 않은 채 일괄 편집을 닫을까요?' : '작성 중인 일괄 편집을 버릴까요?';
}

export function useIssueBulkEdit({ projectId, actorId, refresh, notify }: FeatureProps, visible: Issue[]) {
  const scope = JSON.stringify([projectId, actorId]);
  const [session, setSession] = useState<EditSession | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const active = session?.scope === scope;
  const selected = active ? visible.filter(issue => session.ids.has(issue.id)) : [];
  const changes = active ? session.changes : {};
  const changeCount = Object.keys(changes).length;
  const applyUncertain = active && session.applyUncertain;
  const dirty = active && (selected.length > 0 || changeCount > 0 || applyUncertain);
  const input = JSON.stringify({
    issues: selected.map(({ id, version }) => ({ id, expectedVersion: version })), changes,
  } satisfies IssueBulkEditPreviewInput);
  const stalePreview = active && !applyUncertain && Boolean(session.preview && session.preview.input !== input);
  const preview = active && !stalePreview ? session.preview?.result : undefined;
  const path = `/projects/${encodeURIComponent(projectId)}/issues`;

  if (session && !active) {
    setSession(null);
  } else if (active && !applyUncertain && session.ids.size !== selected.length) {
    // Dropped rows do not become selected again if a later filter makes them visible.
    setSession({ ...session, ids: new Set(selected.map(issue => issue.id)), preview: null });
  }

  const reset = useCallback(() => {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setSession(null);
  }, []);

  useEffect(() => {
    window.addEventListener('teamspace:workspace-imported', reset);
    return () => {
      pending.current?.abort();
      pending.current = null;
      window.removeEventListener('teamspace:workspace-imported', reset);
    };
  }, [reset]);

  useEffect(() => {
    if (!active) return;
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pending.current) {
        event.preventDefault();
        notify('일괄 편집 요청이 끝난 뒤 이동해 주세요.', 'error');
      } else if (!dirty || window.confirm(discardPrompt(applyUncertain))) {
        afterAcceptedNavigation(event, reset);
      } else {
        event.preventDefault();
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!pending.current && !dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [active, applyUncertain, dirty, notify, reset]);

  function close() {
    if (pending.current || (dirty && !window.confirm(discardPrompt(applyUncertain)))) return false;
    reset();
    return true;
  }

  function toggle(issue: Issue) {
    setSession(current => {
      if (!current || pending.current || current.applyUncertain) return current;
      const ids = new Set(current.ids);
      if (ids.has(issue.id)) ids.delete(issue.id);
      else if (ids.size < ISSUE_BULK_EDIT_LIMIT) ids.add(issue.id);
      return { ...current, ids, preview: null };
    });
  }

  function toggleVisible() {
    if (visible.length > ISSUE_BULK_EDIT_LIMIT || pending.current || applyUncertain) return;
    const ids = selected.length === visible.length ? new Set<string>() : new Set(visible.map(issue => issue.id));
    setSession(current => current && { ...current, ids, preview: null });
  }

  function setChange<N extends keyof IssueBulkEditChanges>(name: N, value: IssueBulkEditChanges[N]) {
    setSession(current => {
      if (!current || pending.current || current.applyUncertain) return current;
      const patch = { ...current.changes, [name]: value };
      if (value === undefined) delete patch[name];
      return { ...current, changes: patch, preview: null, error: current.refreshRequired ? current.error : '' };
    });
  }

  async function request(task: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setSession(current => current && { ...current, error: '' });
    try { await task(controller.signal); }
    finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function send<T>(action: 'bulk-preview' | 'bulk-apply', body: string, signal: AbortSignal) {
    return api<T>(`${path}/${action}`, { method: 'POST', body, signal, headers: { 'X-Actor-Id': actorId } });
  }

  const canPreview = active && selected.length > 0 && changeCount > 0 && !session.refreshRequired && !applyUncertain;
  async function review() {
    if (!canPreview) return;
    await request(async signal => {
      setSession(current => current && { ...current, preview: null });
      try {
        const result = await send<IssueBulkEditPreview>('bulk-preview', input, signal);
        if (!signal.aborted) setSession(current => current && { ...current, preview: { result, input } });
      } catch (cause) {
        if (signal.aborted) return;
        const refreshRequired = cause instanceof ApiError && (cause.status === 409 || cause.status === 404);
        setSession(current => current && { ...current, error: errorMessage(cause), refreshRequired });
      }
    });
  }

  async function apply() {
    if (!preview?.previewId) return;
    await request(async signal => {
      const previewId = preview.previewId;
      let result: IssueBulkEditResult;
      try {
        result = await send<IssueBulkEditResult>('bulk-apply', JSON.stringify({ previewId }), signal);
      } catch (cause) {
        if (signal.aborted) return;
        const definiteRejection = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
        setSession(current => current && {
          ...current,
          preview: definiteRejection ? null : current.preview,
          error: definiteRejection ? errorMessage(cause) : '적용 결과를 확인하지 못했습니다. 같은 미리보기로 다시 확인할 수 있습니다.',
          refreshRequired: definiteRejection,
          applyUncertain: !definiteRejection,
        });
        return;
      }
      if (signal.aborted) return;
      setSession(initialSession(scope));
      notify(`${result.updated.length}개 업무를 변경했습니다.`);
      try { await refresh(); }
      catch {
        if (!signal.aborted) setSession(current => current && {
          ...current, error: '변경은 저장되었습니다. 최신 업무 목록을 불러오지 못했습니다.', refreshRequired: true,
        });
      }
    });
  }

  async function reload() {
    await request(async signal => {
      try {
        await refresh();
        if (!signal.aborted) setSession(current => current && { ...current, preview: null, refreshRequired: false });
      } catch (cause) {
        if (!signal.aborted) setSession(current => current && { ...current, error: errorMessage(cause) });
      }
    });
  }

  return {
    active, busy, locked: busy || applyUncertain, selectedIds: active ? session.ids : new Set<string>(), changes,
    preview, stalePreview, canPreview, applyUncertain, error: active ? session.error : '', refreshRequired: active && session.refreshRequired,
    selectedCount: selected.length, visibleCount: visible.length,
    open: () => setSession(initialSession(scope)), close, toggle, toggleVisible, setChange, review, apply, reload,
  };
}

type BulkEditor = ReturnType<typeof useIssueBulkEdit>;

export function IssueBulkSelectVisible({ editor }: { editor: BulkEditor }) {
  const checkbox = useRef<HTMLInputElement>(null);
  const allSelected = editor.visibleCount > 0 && editor.selectedCount === editor.visibleCount;
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = editor.selectedCount > 0 && !allSelected;
  }, [editor.selectedCount, allSelected]);
  return <label className="issue-bulk-select-control">
    <input ref={checkbox} type="checkbox" aria-label="검색 결과 전체 선택" checked={allSelected}
      disabled={editor.locked || editor.visibleCount === 0 || editor.visibleCount > ISSUE_BULK_EDIT_LIMIT}
      onChange={editor.toggleVisible} />
  </label>;
}

const fieldLabels = { status: '상태', priority: '우선순위', assigneeId: '담당자' } satisfies Record<keyof IssueBulkEditValues, string>;
const outcomes = { changed: '변경 예정', unchanged: '변경 없음', blocked: '변경 불가' };
const memberPrefix = 'team-member:';

export function IssueBulkEdit({ editor, statuses, users, onClose }: {
  editor: BulkEditor;
  statuses: WorkflowStatus[];
  users: FeatureProps['data']['users'];
  onClose: () => void;
}) {
  const { changes, preview } = editor;
  function valueLabel(field: keyof IssueBulkEditValues, values: IssueBulkEditValues) {
    if (field === 'status') return statuses.find(status => status.id === values.status)?.label ?? values.status;
    if (field === 'priority') return PRIORITY[values.priority];
    return values.assigneeId ? users.find(user => user.id === values.assigneeId)?.name ?? values.assigneeId : '미지정';
  }

  return <section className="issue-bulk-editor" aria-label="업무 일괄 편집">
    <header>
      <div>
        <h2><ListChecks size={18} aria-hidden="true" />업무 일괄 편집</h2>
        <p role="status">{editor.selectedCount}개 선택 · 최대 {ISSUE_BULK_EDIT_LIMIT}개</p>
      </div>
      <button type="button" className="btn btn-ghost" aria-label="일괄 편집 닫기" disabled={editor.busy} onClick={onClose}><X size={16} aria-hidden="true" />닫기</button>
    </header>
    <form onSubmit={event => { event.preventDefault(); void editor.review(); }}>
      <fieldset disabled={editor.locked} className="issue-bulk-fields">
        <label>상태<select className="field" aria-label="일괄 변경 상태" value={changes.status ?? ''}
          onChange={event => editor.setChange('status', event.currentTarget.value || undefined)}>
          <option value="">현재 상태 유지</option>
          {changes.status && !statuses.some(status => status.id === changes.status) && <option value={changes.status} disabled>{changes.status} (선택 불가)</option>}
          {statuses.map(status => <option value={status.id} key={status.id}>{status.label}</option>)}
        </select></label>
        <label>우선순위<select className="field" aria-label="일괄 변경 우선순위" value={changes.priority ?? ''}
          onChange={event => editor.setChange('priority', event.currentTarget.value ? event.currentTarget.value as Priority : undefined)}>
          <option value="">현재 우선순위 유지</option>
          {Object.entries(PRIORITY).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
        </select></label>
        <label>담당자<select className="field" aria-label="일괄 변경 담당자"
          value={changes.assigneeId === null ? 'none' : changes.assigneeId ? `${memberPrefix}${changes.assigneeId}` : ''}
          onChange={event => {
            const value = event.currentTarget.value;
            editor.setChange('assigneeId', value === 'none' ? null : value ? value.slice(memberPrefix.length) : undefined);
          }}>
          <option value="">직접 지정하지 않음</option><option value="none">담당자 해제</option>
          {users.map(user => <option value={`${memberPrefix}${user.id}`} key={user.id}>{user.name}</option>)}
        </select></label>
      </fieldset>
      <p className="issue-bulk-note">현재 목록의 업무만 선택할 수 있습니다. 담당자를 직접 지정하지 않으면 상태 변경 시 자동 배정 규칙을 적용합니다.</p>
      {editor.visibleCount > ISSUE_BULK_EDIT_LIMIT && <p className="issue-bulk-note">전체 선택은 검색 결과가 {ISSUE_BULK_EDIT_LIMIT}개 이하일 때 가능합니다.</p>}
      <button type="submit" className="btn" disabled={editor.busy || !editor.canPreview}>변경 미리보기</button>
    </form>
    {editor.error && <p className="issue-bulk-error" role="alert">{editor.error}</p>}
    {editor.stalePreview && !editor.error && <p role="status">선택한 업무가 갱신되었습니다. 미리보기를 다시 확인하세요.</p>}
    {editor.refreshRequired && <button type="button" className="btn" disabled={editor.busy} onClick={() => void editor.reload()}>최신 업무 불러오기</button>}
    {preview && <section className="issue-bulk-preview" aria-label="일괄 변경 미리보기">
      <h3>일괄 변경 미리보기</h3>
      <p>변경 {preview.changed}개 · 유지 {preview.unchanged}개 · 차단 {preview.blocked}개</p>
      {preview.blocked > 0 && <p className="issue-bulk-error">변경할 수 없는 업무가 있습니다. 선택이나 입력을 수정한 뒤 다시 확인하세요.</p>}
      <ul className="issue-bulk-preview-list" aria-label="업무 변경 항목" tabIndex={0}>
        {preview.rows.map(row => <li key={row.id}>
          <div className="issue-bulk-preview-heading"><strong>{row.key} {row.title}</strong><span>{outcomes[row.outcome]}</span></div>
          {row.reason && <p className="issue-bulk-row-reason">{row.reason}</p>}
          {row.after && transitionLabels(row.before, row.after, valueLabel)}
        </li>)}
      </ul>
      {preview.previewId && <button type="button" className="btn btn-primary" disabled={editor.busy}
        onClick={() => void editor.apply()}>{editor.applyUncertain ? '적용 결과 다시 확인' : '일괄 적용'}</button>}
    </section>}
  </section>;
}

function transitionLabels(before: IssueBulkEditValues, after: IssueBulkEditValues,
  label: (field: keyof IssueBulkEditValues, values: IssueBulkEditValues) => string) {
  const fields = (Object.keys(fieldLabels) as (keyof IssueBulkEditValues)[]).filter(field => before[field] !== after[field]);
  if (!fields.length) return null;
  return <dl className="issue-bulk-changes">{fields.map(field => <div key={field}>
    <dt>{fieldLabels[field]}</dt><dd>{label(field, before)} → {label(field, after)}</dd>
  </div>)}</dl>;
}
