'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertCircle, ArrowRight, Check, RefreshCw } from 'lucide-react';
import type { AutomaticSchedulePreview, Issue, Project, TeamScheduleBlocker } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import type { ScheduleApplyResult } from './AutomaticScheduleDialog';
import { errorMessage } from './schedule-utils';

export type CascadeAnchorChange = {
  id: string;
  expectedVersion: number;
  startDate: string | null;
  endDate: string | null;
};

export type TeamFollowUpSelection = {
  relation: TeamScheduleBlocker;
  source: Pick<Issue, 'id' | 'key'>;
  target: Pick<Issue, 'id' | 'key'>;
};

type Props = {
  onClose: () => void;
  onApplied: (result: ScheduleApplyResult) => Promise<void> | void;
  onBusyChange: (value: boolean) => void;
} & (
  | { projectId: string; anchorChange: CascadeAnchorChange; teamFollowUp?: never; projects?: never }
  | { teamFollowUp: TeamFollowUpSelection; projects: readonly Project[]; projectId?: never; anchorChange?: never }
);

type Operation = 'preview' | 'apply' | 'recover' | 'refresh';

function isApplyResult(value: ScheduleApplyResult | { applied: false }): value is ScheduleApplyResult {
  return Boolean(value && 'undoId' in value && typeof value.undoId === 'string' && Array.isArray(value.updated));
}

export function GanttCascadeDialog({ projectId, anchorChange, teamFollowUp, projects, onClose, onApplied, onBusyChange }: Props) {
  const headingId = useId();
  const dialog = useRef<HTMLElement>(null);
  const request = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<AutomaticSchedulePreview | null>(null);
  const [pending, setPending] = useState<Operation | null>('preview');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [freshPreviewNeeded, setFreshPreviewNeeded] = useState(false);
  const [applied, setApplied] = useState<ScheduleApplyResult | null>(null);
  const route = teamFollowUp ? '/schedule/team-follow-up' : '/schedule/auto';

  const begin = useCallback((operation: Operation) => {
    if (request.current) return null;
    const controller = new AbortController();
    request.current = controller;
    setPending(operation);
    setError('');
    setStatus('');
    onBusyChange(true);
    return controller;
  }, [onBusyChange]);

  const finish = useCallback((controller: AbortController) => {
    if (request.current !== controller) return;
    request.current = null;
    setPending(null);
    onBusyChange(false);
  }, [onBusyChange]);

  const load = useCallback(async () => {
    const controller = begin('preview');
    if (!controller) return;
    setFreshPreviewNeeded(true);
    try {
      const input = teamFollowUp ? { relationId: teamFollowUp.relation.id, expectedVersion: teamFollowUp.relation.version } : { projectId, anchorChange };
      const result = await api<AutomaticSchedulePreview>(`${route}-preview`, {
        method: 'POST', signal: controller.signal, body: JSON.stringify(input),
      });
      if (controller.signal.aborted) return;
      setPreview(result);
      setFreshPreviewNeeded(false);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally { finish(controller); }
  }, [anchorChange, begin, finish, projectId, route, teamFollowUp]);

  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!dialog.current?.contains(active) || active?.matches(':disabled')) dialog.current?.focus({ preventScroll: true });
  }, [pending, outcomeUnknown, freshPreviewNeeded, applied]);
  useEffect(() => {
    const scheduled = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(scheduled);
      const active = request.current;
      if (active) {
        active.abort();
        request.current = null;
        onBusyChange(false);
      }
    };
  }, [load, onBusyChange]);

  async function reflect(result: ScheduleApplyResult) {
    setApplied(result);
    try { await onApplied(result); }
    catch { setError('일정이 저장되었습니다. 간트 화면을 다시 불러와 주세요.'); }
  }

  async function apply(recovering: boolean) {
    if (!preview || applied || preview.blocking.length || !preview.changes.length) return;
    if (!recovering && (freshPreviewNeeded || outcomeUnknown || Date.parse(preview.expiresAt) <= Date.now())) {
      setFreshPreviewNeeded(true);
      setError('미리보기를 다시 계산한 뒤 적용해 주세요.');
      return;
    }
    const controller = begin(recovering ? 'recover' : 'apply');
    if (!controller) return;
    try {
      const result = recovering
        ? await api<ScheduleApplyResult | { applied: false }>(`${route}-result/${encodeURIComponent(preview.previewId)}`, { signal: controller.signal, cache: 'no-store' })
        : await api<ScheduleApplyResult>(`${route}-apply`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ previewId: preview.previewId }) });
      if (controller.signal.aborted) return;
      if (!isApplyResult(result)) {
        if (!recovering || result?.applied !== false) throw new Error('적용 결과를 확인하지 못했습니다.');
        setOutcomeUnknown(false);
        setStatus('아직 저장된 결과가 없습니다. 같은 제안을 다시 적용할 수 있습니다.');
        return;
      }
      setOutcomeUnknown(false);
      await reflect(result);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const ambiguous = recovering || !(cause instanceof ApiError) || cause.status >= 500 || cause.status === 408;
      setOutcomeUnknown(ambiguous);
      if (!ambiguous) setFreshPreviewNeeded(true);
      setError(ambiguous ? '적용 여부를 확인하지 못했습니다. 같은 제안의 적용 결과를 다시 확인해 주세요.' : errorMessage(cause));
    } finally { finish(controller); }
  }

  async function refreshApplied() {
    if (!applied) return;
    const controller = begin('refresh');
    if (!controller) return;
    try { await reflect(applied); }
    finally { finish(controller); }
  }

  function close() {
    if (request.current) return;
    const returnTarget = teamFollowUp ? '차단 관계 목록' : '입력';
    if (outcomeUnknown && !window.confirm(`일정 적용 여부를 확인하지 못했습니다. ${returnTarget}으로 돌아갈까요?`)) return;
    onClose();
  }

  function handleKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const active = document.activeElement;
      if (!buttons.length || !dialog.current?.contains(active) || active === dialog.current ||
          (!event.shiftKey && active === buttons.at(-1)) || (event.shiftKey && active === buttons[0])) {
        event.preventDefault();
        (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus();
      }
    }
  }

  const canApply = preview && preview.changes.length > 0 && !preview.blocking.length && !freshPreviewNeeded;
  const anchorListed = preview?.changes.some(change => change.id === anchorChange?.id);
  const projectNames = new Map(projects?.map(project => [project.id, project.name]));
  return <div className="issue-modal-overlay"><section className={`gantt-preview-modal${teamFollowUp ? ' gantt-team-follow-up-modal' : ''}`} role="dialog" aria-modal="true"
      aria-labelledby={headingId} tabIndex={-1} ref={dialog} onKeyDown={handleKey}>
    <header><div><h2 id={headingId}>{teamFollowUp ? '프로젝트 간 후행 일정 검토' : '후행 일정 미리보기'}</h2>
      {teamFollowUp ? <>
        <p><strong>{teamFollowUp.source.key} → {teamFollowUp.target.key}</strong></p>
        {teamFollowUp.relation.origin === 'jira' && <p>Jira 이관 관계</p>}
        {preview?.teamFollowUp && <p>기준 업무 종료일 <strong>{preview.teamFollowUp.sourceEndDate ?? '미정'}</strong></p>}
        <p>차단하는 업무의 날짜를 유지하고, 후행 업무의 프로젝트 달력에 맞춰 필요한 만큼 일정을 미룹니다.</p>
      </> : <>
        <p>선후행 조건을 맞추는 데 필요한 만큼 후행 일정을 미룹니다.</p>
        {!anchorListed && anchorChange && <p>입력한 일정 {anchorChange.startDate ?? '미정'} ~ {anchorChange.endDate ?? '미정'}</p>}
      </>}</div></header>
    {pending === 'preview' && <p className="muted" role="status">선후행 일정을 계산하는 중입니다.</p>}
    {preview?.blocking.length ? <div className="gantt-preview-warnings" role="alert"><AlertCircle size={17} aria-hidden="true" />
      <div><strong>함께 적용하기 전에 해결할 항목</strong>{preview.blocking.map(text => <p key={text}>{text}</p>)}</div></div> : null}
    {preview?.warnings.length ? <div className="gantt-preview-warnings"><AlertCircle size={17} aria-hidden="true" />
      <div><strong>검토할 일정</strong>{preview.warnings.map(text => <p key={text}>{text}</p>)}</div></div> : null}
    {error && <p className="issue-form-error gantt-preview-error" role="alert">{error}</p>}
    {status && <p className="muted" role="status">{status}</p>}
    {preview && <div className="gantt-preview-table"><table aria-label="검토할 업무 일정">
      <thead><tr><th scope="col">업무</th><th scope="col">이전 일정</th><th aria-hidden="true" /><th scope="col">검토 일정</th></tr></thead>
      <tbody>{preview.changes.map(change => <tr key={change.id}>
        <td><span className="issue-key">{change.key}</span><strong>{change.title}</strong>
          {teamFollowUp && change.projectId && <small data-schedule-project={change.projectId}>{projectNames.get(change.projectId) ?? '프로젝트 정보 없음'}</small>}
          <small>{change.id === anchorChange?.id ? '입력한 업무' : change.id === teamFollowUp?.target.id ? '차단되는 업무' : '후행 업무'}</small></td>
        <td>{change.fromStart ?? '미정'}<br />{change.fromEnd ?? '미정'}</td><td><ArrowRight aria-hidden="true" size={16} /></td>
        <td className="gantt-new-dates">{change.toStart ?? '미정'}<br />{change.toEnd ?? '미정'}</td>
      </tr>)}</tbody></table>
      {!preview.changes.length && <p className="issue-empty">적용할 일정 변경이 없습니다.</p>}
    </div>}
    <footer><span className="muted">함께 적용한 날짜는 간트에서 한 번에 되돌릴 수 있습니다.</span>
      <button className="btn btn-ghost" type="button" disabled={Boolean(pending)} onClick={close}>돌아가기</button>
      {applied ? <button className="btn btn-primary" type="button" disabled={Boolean(pending)} onClick={() => void refreshApplied()}><RefreshCw size={15} />간트 다시 불러오기</button>
        : outcomeUnknown ? <button className="btn btn-primary" type="button" disabled={Boolean(pending)} onClick={() => void apply(true)}><RefreshCw size={15} />적용 결과 다시 확인</button>
        : freshPreviewNeeded && !pending ? <button className="btn" type="button" onClick={() => void load()}><RefreshCw size={15} />미리보기 다시 계산</button>
        : preview && <button className="btn btn-primary" type="button" disabled={Boolean(pending) || !canApply} onClick={() => void apply(false)}><Check size={16} />{pending === 'apply' ? '적용 중…' : '함께 적용'}</button>}
    </footer>
  </section></div>;
}
