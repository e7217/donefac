'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertCircle, ArrowRight, Check, RefreshCw } from 'lucide-react';
import type { AutomaticSchedulePreview, Issue, Project, ScheduleAnchorChange, TeamScheduleBlocker } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import type { ScheduleApplyResult } from './AutomaticScheduleDialog';
import { errorMessage } from './schedule-utils';

export type CascadeAnchorChange = ScheduleAnchorChange;

type SourceDates = Pick<Issue, 'startDate' | 'endDate'>;
type SourceSchedule = SourceDates & Pick<Issue, 'version'>;

export type TeamFollowUpSelection = {
  relation: TeamScheduleBlocker;
  source: Pick<Issue, 'id' | 'key'> & SourceSchedule;
  target: Pick<Issue, 'id' | 'key'>;
  initialChange?: ScheduleAnchorChange;
};

type Props = {
  onClose: () => void;
  onApplied: (result: ScheduleApplyResult, unchangedSource?: SourceSchedule) => Promise<void> | void;
  onBusyChange: (value: boolean) => void;
} & (
  | { projectId: string; anchorChange: CascadeAnchorChange; teamFollowUp?: never; projects?: never }
  | { teamFollowUp: TeamFollowUpSelection; projects: readonly Project[]; projectId?: never; anchorChange?: never }
);

type Operation = 'preview' | 'apply' | 'recover' | 'refresh';

function isApplyResult(value: ScheduleApplyResult | { applied: false }): value is ScheduleApplyResult {
  return Boolean(value && 'undoId' in value && typeof value.undoId === 'string' && Array.isArray(value.updated));
}

function datesMatch(left: SourceDates, right: SourceDates) {
  return left.startDate === right.startDate && left.endDate === right.endDate;
}

function dateValues({ startDate, endDate }: SourceDates): SourceDates {
  return { startDate, endDate };
}

function rebaseDates(dates: SourceDates, previous: SourceDates, latest: SourceDates): SourceDates {
  return {
    startDate: dates.startDate === previous.startDate ? latest.startDate : dates.startDate,
    endDate: dates.endDate === previous.endDate ? latest.endDate : dates.endDate,
  };
}

function currentSourceSchedule(cause: unknown): SourceSchedule | null {
  if (!(cause instanceof ApiError) || cause.status !== 409 || !cause.details || typeof cause.details !== 'object') return null;
  const { reason, currentVersion, startDate, endDate } = cause.details as Record<string, unknown>;
  if (reason !== 'stale_team_follow_up_source' || typeof currentVersion !== 'number' || !Number.isSafeInteger(currentVersion) ||
      (startDate !== null && typeof startDate !== 'string') || (endDate !== null && typeof endDate !== 'string')) return null;
  return { version: currentVersion, startDate, endDate };
}

export function GanttCascadeDialog({ projectId, anchorChange, teamFollowUp, projects, onClose, onApplied, onBusyChange }: Props) {
  const headingId = useId();
  const sourceDateErrorId = useId();
  const dialog = useRef<HTMLElement>(null);
  const request = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<AutomaticSchedulePreview | null>(null);
  const [pending, setPending] = useState<Operation | null>('preview');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [freshPreviewNeeded, setFreshPreviewNeeded] = useState(false);
  const [applied, setApplied] = useState<ScheduleApplyResult | null>(null);
  const initialChange = teamFollowUp?.initialChange;
  const [sourceBaseline, setSourceBaseline] = useState<SourceSchedule | null>(teamFollowUp?.source ?? null);
  const [sourceDates, setSourceDates] = useState<SourceDates>(() => teamFollowUp
    ? dateValues(initialChange ?? teamFollowUp.source) : { startDate: null, endDate: null });
  const [handoffDates, setHandoffDates] = useState<SourceDates | null>(() => initialChange ? dateValues(initialChange) : null);
  const [reviewedSourceDates, setReviewedSourceDates] = useState<SourceDates | null>(null);
  const [staleSource, setStaleSource] = useState<SourceSchedule | null>(null);
  const route = teamFollowUp ? '/schedule/team-follow-up' : '/schedule/auto';
  const sourceDatesDirty = sourceBaseline !== null && !datesMatch(sourceDates, sourceBaseline);
  const sourceDateOrderInvalid = Boolean(sourceDates.startDate && sourceDates.endDate && sourceDates.startDate > sourceDates.endDate);
  const sourceDatesNeedPreview = reviewedSourceDates !== null && !datesMatch(sourceDates, reviewedSourceDates);
  const needsPreview = freshPreviewNeeded || sourceDatesNeedPreview || staleSource !== null;

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

  const load = useCallback(async (change?: ScheduleAnchorChange, reviewedDates?: SourceDates) => {
    const controller = begin('preview');
    if (!controller) return;
    setFreshPreviewNeeded(true);
    try {
      const input = teamFollowUp ? { relationId: teamFollowUp.relation.id, expectedVersion: teamFollowUp.relation.version,
        ...(change ? { anchorChange: change } : {}) } : { projectId, anchorChange };
      const result = await api<AutomaticSchedulePreview>(`${route}-preview`, {
        method: 'POST', signal: controller.signal, body: JSON.stringify(input),
      });
      if (controller.signal.aborted) return;
      setPreview(result);
      if (teamFollowUp) {
        const savedSource = change ? undefined : result.teamFollowUp?.sourceSchedule;
        if (savedSource) {
          const dates = dateValues(savedSource);
          setSourceBaseline(savedSource);
          setSourceDates(dates);
          setReviewedSourceDates(dates);
        } else setReviewedSourceDates(reviewedDates ?? dateValues(teamFollowUp.source));
      }
      setFreshPreviewNeeded(false);
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (teamFollowUp) setStaleSource(currentSourceSchedule(cause));
        setError(errorMessage(cause));
      }
    } finally { finish(controller); }
  }, [anchorChange, begin, finish, projectId, route, teamFollowUp]);

  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!dialog.current?.contains(active) || active?.matches(':disabled')) dialog.current?.focus({ preventScroll: true });
  }, [pending, outcomeUnknown, needsPreview, sourceDatesDirty, staleSource, applied]);
  useEffect(() => {
    const scheduled = window.setTimeout(() => void load(initialChange, initialChange), 0);
    return () => {
      window.clearTimeout(scheduled);
      const active = request.current;
      if (active) {
        active.abort();
        request.current = null;
        onBusyChange(false);
      }
    };
  }, [load, onBusyChange, initialChange]);

  function reloadPreview() {
    if (staleSource || sourceDateOrderInvalid) return;
    const change = teamFollowUp && sourceBaseline && (sourceDatesDirty || initialChange)
      ? { id: teamFollowUp.source.id, expectedVersion: sourceBaseline.version, ...sourceDates }
      : undefined;
    void load(change, teamFollowUp ? sourceDates : undefined);
  }

  function rebaseSource() {
    if (!staleSource || !sourceBaseline) return;
    setSourceDates(rebaseDates(sourceDates, sourceBaseline, staleSource));
    if (handoffDates) setHandoffDates(rebaseDates(handoffDates, sourceBaseline, staleSource));
    setSourceBaseline(staleSource);
    setStaleSource(null);
    setError('');
    setFreshPreviewNeeded(true);
  }

  async function reflect(result: ScheduleApplyResult) {
    setApplied(result);
    try { await onApplied(result, preview?.teamFollowUp?.sourceSchedule); }
    catch { setError('일정이 저장되었습니다. 간트 화면을 다시 불러와 주세요.'); }
  }

  async function apply(recovering: boolean) {
    if (!preview || applied || preview.blocking.length || !preview.changes.length) return;
    if (!recovering && (needsPreview || outcomeUnknown || Date.parse(preview.expiresAt) <= Date.now())) {
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
      if (!ambiguous) {
        if (teamFollowUp) setStaleSource(currentSourceSchedule(cause));
        setFreshPreviewNeeded(true);
      }
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
    const returnTarget = initialChange ? '이전 일정 화면으로' : teamFollowUp ? '차단 관계 목록으로' : '입력으로';
    const editedHere = handoffDates ? !datesMatch(sourceDates, handoffDates) : sourceDatesDirty;
    if (outcomeUnknown) {
      if (!window.confirm(`일정 적용 여부를 확인하지 못했습니다. ${returnTarget} 돌아갈까요?`)) return;
    } else if (editedHere && !applied && !window.confirm(`여기서 수정한 선행 업무 일정을 버리고 ${returnTarget} 돌아갈까요?`)) return;
    onClose();
  }

  function handleKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? []);
      const active = document.activeElement;
      if (!controls.length || !dialog.current?.contains(active) || active === dialog.current ||
          (!event.shiftKey && active === controls.at(-1)) || (event.shiftKey && active === controls[0])) {
        event.preventDefault();
        (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
      }
    }
  }

  const canApply = preview && preview.changes.length > 0 && !preview.blocking.length && !needsPreview;
  const anchorId = teamFollowUp?.source.id ?? anchorChange?.id;
  const anchorListed = preview?.changes.some(change => change.id === anchorId);
  const projectNames = new Map(projects?.map(project => [project.id, project.name]));
  return <div className="issue-modal-overlay"><section className={`gantt-preview-modal${teamFollowUp ? ' gantt-team-follow-up-modal' : ''}`} role="dialog" aria-modal="true"
      aria-labelledby={headingId} tabIndex={-1} ref={dialog} onKeyDown={handleKey}>
    <header><div><h2 id={headingId}>{teamFollowUp ? '프로젝트 간 후행 일정 검토' : '후행 일정 미리보기'}</h2>
      {teamFollowUp ? <>
        <p><strong>{teamFollowUp.source.key} → {teamFollowUp.target.key}</strong></p>
        {teamFollowUp.relation.origin === 'jira' && <p>Jira 이관 관계</p>}
        {preview?.teamFollowUp && <p>기준 업무 종료일 <strong>{preview.teamFollowUp.sourceEndDate ?? '미정'}</strong></p>}
        <p>선행 업무의 일정으로 후행 업무가 각 프로젝트 달력에서 얼마나 밀리는지 확인합니다.</p>
      </> : <>
        <p>선후행 조건을 맞추는 데 필요한 만큼 후행 일정을 미룹니다.</p>
        {!anchorListed && anchorChange && <p>입력한 일정 {anchorChange.startDate ?? '미정'} ~ {anchorChange.endDate ?? '미정'}</p>}
      </>}</div></header>
    {teamFollowUp && sourceBaseline && <fieldset className="gantt-team-follow-up-dates" disabled={Boolean(pending || outcomeUnknown || applied)}>
      <legend>선행 업무 일정</legend>
      <label>선행 업무 시작일<input className="field" type="date" min="0000-01-01" max="9999-12-31"
        aria-invalid={sourceDateOrderInvalid || undefined} aria-describedby={sourceDateOrderInvalid ? sourceDateErrorId : undefined}
        value={sourceDates.startDate ?? ''} onChange={event => setSourceDates({ ...sourceDates, startDate: event.target.value || null })} /></label>
      <label>선행 업무 종료일<input className="field" type="date" min="0000-01-01" max="9999-12-31"
        aria-invalid={sourceDateOrderInvalid || undefined} aria-describedby={sourceDateOrderInvalid ? sourceDateErrorId : undefined}
        value={sourceDates.endDate ?? ''} onChange={event => setSourceDates({ ...sourceDates, endDate: event.target.value || null })} /></label>
      <button className="btn btn-ghost" type="button" disabled={!sourceDatesDirty} onClick={() => setSourceDates(dateValues(sourceBaseline))}>저장된 날짜로 되돌리기</button>
      {sourceDateOrderInvalid && <p id={sourceDateErrorId} className="issue-form-error" role="alert">시작일과 같거나 그 이후의 종료일을 입력해 주세요.</p>}
    </fieldset>}
    {staleSource && <div className="gantt-team-follow-up-stale">
      <p>최신 선행 업무 일정 <strong>{staleSource.startDate ?? '미정'} ~ {staleSource.endDate ?? '미정'}</strong></p>
      <button className="btn" type="button" onClick={rebaseSource}>최신 일정 기준으로 다시 검토</button>
    </div>}
    {sourceDatesNeedPreview && !pending && !staleSource && <p className="gantt-team-follow-up-notice muted" role="status">입력한 날짜로 미리보기를 다시 계산해 주세요.</p>}
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
          <small>{change.id === anchorId ? (teamFollowUp ? '선행 업무' : '입력한 업무') : change.id === teamFollowUp?.target.id ? '차단되는 업무' : '후행 업무'}</small></td>
        <td>{change.fromStart ?? '미정'}<br />{change.fromEnd ?? '미정'}</td><td><ArrowRight aria-hidden="true" size={16} /></td>
        <td className="gantt-new-dates">{change.toStart ?? '미정'}<br />{change.toEnd ?? '미정'}</td>
      </tr>)}</tbody></table>
      {!preview.changes.length && <p className="issue-empty">적용할 일정 변경이 없습니다.</p>}
    </div>}
    <footer><span className="muted">함께 적용한 날짜는 간트에서 한 번에 되돌릴 수 있습니다.</span>
      <button className="btn btn-ghost" type="button" disabled={Boolean(pending)} onClick={close}>돌아가기</button>
      {applied ? <button className="btn btn-primary" type="button" disabled={Boolean(pending)} onClick={() => void refreshApplied()}><RefreshCw size={15} />간트 다시 불러오기</button>
        : outcomeUnknown ? <button className="btn btn-primary" type="button" disabled={Boolean(pending)} onClick={() => void apply(true)}><RefreshCw size={15} />적용 결과 다시 확인</button>
        : <>
          {needsPreview && !pending && !staleSource && <button className="btn" type="button" disabled={sourceDateOrderInvalid}
            onClick={reloadPreview}><RefreshCw size={15} />미리보기 다시 계산</button>}
          {preview && (teamFollowUp || !needsPreview || pending) && <button className="btn btn-primary" type="button" disabled={Boolean(pending) || !canApply}
            onClick={() => void apply(false)}><Check size={16} />{pending === 'apply' ? '적용 중…' : '함께 적용'}</button>}
        </>}
    </footer>
  </section></div>;
}
