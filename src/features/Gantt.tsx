'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from 'react';
import { AlertCircle, ArrowRight, CalendarDays, Check, ClipboardPaste, Diamond, Link2, MoveHorizontal, Plus, Search, Sparkles, Undo2, X } from 'lucide-react';
import { type CustomFieldValue, type FeatureProps, type Issue, type SchedulePreview, type User, type Project } from '../../shared/types';
import { isTerminalStatus, projectWorkflow, requiredFieldsFor, REQUIRED_FIELD_LABELS, statusMeta } from '../../shared/workflow-helpers';
import { createCalendarMath, defaultWorkCalendar, shiftWorkingDate } from '../../shared/calendar';
import { afterAcceptedNavigation } from '../lib/navigation';
import { post, remove } from '../lib/api';
import { issueSearchText, requiredFieldLabels } from '../../shared/issue-schema';
import { CustomFields, initialIssueType, IssueTypeName, IssueTypeSelect } from './CustomFields';
import { PlanningSelect, PLAN_LABELS } from './PlanningSelectors';
import { IssueTypeIcon } from './Issues';
import { dayNumber, errorMessage, isoDay, moveDate, todayDate } from './schedule-utils';
import { AutomaticScheduleDialog } from './AutomaticScheduleDialog';
import { SchedulePlanningPanel } from './SchedulePlanningPanel';
import { SchedulePasteDialog } from './SchedulePasteDialog';
import './issues.css';
import './gantt.css';

type ApplyResult = { undoId: string; updated: Issue[]; warnings?: string[] };
type DragMode = 'move' | 'start' | 'end';
type DragState = { issue: Issue; initialX: number; delta: number; mode: DragMode };
type TrackDraft = (id: string, dirty: boolean, pending?: boolean) => void;
const LEFT_WIDTH = 538;
const ROW_HEIGHT = 56;
const HEADER_HEIGHT = 62;
const MAX_TIMELINE_DAYS = 180;
const MIN_TIMELINE_DAY = dayNumber('0000-01-01'), MAX_TIMELINE_DAY = dayNumber('9999-12-31');

export function Gantt(props: FeatureProps) { return <ProjectGantt key={`${props.projectId}:${props.actorId}`} {...props} />; }

function ProjectGantt(props: FeatureProps) {
  const { data, projectId, refresh, notify, openIssue } = props;
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState<'day' | 'week' | 'month'>('day');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scheduleWarnings, setScheduleWarnings] = useState<string[]>([]);
  const [undoId, setUndoId] = useState<string | null>(null);
  const [days, setDays] = useState(5);
  const [workingDays, setWorkingDays] = useState(true);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hideDone, setHideDone] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [selectedBaselineId, setSelectedBaselineId] = useState<string | null>(null);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [windowStart, setWindowStart] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false), previewRef = useRef<SchedulePreview | null>(null);
  const draftsRef = useRef(new Map<string, { dirty: boolean; pending: boolean }>());
  useEffect(() => { previewRef.current = preview; }, [preview]);
  const trackDraft = useCallback((id: string, dirty: boolean, pending = false) => { if (dirty || pending) draftsRef.current.set(id, { dirty, pending }); else draftsRef.current.delete(id); }, []);
  function markBusy(value: boolean) { busyRef.current = value; setBusy(value); }
  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (busyRef.current || [...draftsRef.current.values()].some(value => value.pending)) { event.preventDefault(); notify('일정 변경이 끝난 뒤 이동해 주세요.', 'error'); }
      else if (previewRef.current || [...draftsRef.current.values()].some(value => value.dirty)) {
        if (!window.confirm('저장하지 않은 간트 입력과 미리보기를 버리고 이동할까요?')) event.preventDefault();
        else {
          const discardPaste = draftsRef.current.has('schedule-paste');
          afterAcceptedNavigation(event, () => {
            previewRef.current = null;
            draftsRef.current.clear();
            setPreview(null); setPreviewError(''); setCreateOpen(false); setLinkOpen(false); setShiftOpen(false); setDrag(null);
            if (discardPaste) setPasteOpen(false);
            setDraftEpoch(value => value + 1);
          });
        }
      }
    };
    const unload = (event: BeforeUnloadEvent) => { if (busyRef.current || previewRef.current || draftsRef.current.size) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('teamspace:navigate', guard); window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('teamspace:navigate', guard); window.removeEventListener('beforeunload', unload); };
  }, [notify]);
  function canLeave() { return window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })); }
  const projectIssues = useMemo(() => data.issues.filter(i => (!projectId || projectId === 'all' || i.projectId === projectId)), [data.issues, projectId]);
  const issues = projectIssues.filter(i => (!hideDone || !isTerminalStatus(data,i.projectId,i.status)) && (!query || issueSearchText(data, i).toLowerCase().includes(query.toLowerCase())));
  const baseline = data.baselines?.find(value => value.id === selectedBaselineId && value.projectId === projectId);
  const milestones = useMemo(() => (data.milestones || []).filter(value => value.projectId === projectId), [data.milestones, projectId]);
  const historicalIssues = baseline?.issues.filter(value => !projectIssues.some(issue => issue.id === value.issueId)) || [];
  const historicalMilestones = baseline?.milestones.filter(value => !milestones.some(milestone => milestone.id === value.milestoneId)) || [];
  const calendar = data.calendars?.find(value => value.projectId === projectId) || defaultWorkCalendar(projectId);
  const calendarMath = createCalendarMath(calendar);
  const extent = (() => {
    const today = dayNumber(todayDate());
    const dates = [...projectIssues.flatMap(value => [value.startDate, value.endDate]), ...milestones.map(value => value.date), ...(baseline?.issues.flatMap(value => [value.startDate, value.endDate]) || []), ...(baseline?.milestones.map(value => value.date) || [])].filter((value): value is string => Boolean(value)).map(dayNumber).filter(Number.isFinite);
    const start = Math.min(today - 7, ...dates) - 2, end = Math.max(today + 35, ...dates) + 3;
    return { start, end, days: end - start + 1 };
  })();
  const requestedStart = windowStart ? dayNumber(windowStart) : extent.days <= MAX_TIMELINE_DAYS ? extent.start : dayNumber(todayDate()) - 9;
  const rangeStart = Math.max(MIN_TIMELINE_DAY, Math.min(MAX_TIMELINE_DAY - MAX_TIMELINE_DAYS + 1, Number.isFinite(requestedStart) ? requestedStart : dayNumber(todayDate()) - 9));
  const rangeDays = windowStart || extent.days > MAX_TIMELINE_DAYS ? MAX_TIMELINE_DAYS : Math.min(MAX_TIMELINE_DAYS, extent.days);
  const range = { start: rangeStart, end: rangeStart + rangeDays - 1, days: rangeDays };
  const dayWidth = zoom === 'day' ? 32 : zoom === 'week' ? 15 : 6;
  const timelineWidth = range.days * dayWidth;
  const selectedIssues = issues.filter(i => selected.has(i.id));
  const dependencies = data.dependencies.filter(d => issues.some(i => i.id === d.predecessorId) && issues.some(i => i.id === d.successorId));
  const unscheduled = issues.filter(i => !i.startDate || !i.endDate);
  const ticks = useMemo(() => Array.from({ length: range.days }, (_, index) => { const day = range.start + index; const date = new Date(day * 86_400_000); return { day, date, iso: isoDay(day), index, weekday: date.getUTCDay() }; }), [range.start, range.days]);
  const rowIndex = new Map(issues.map((i, index) => [i.id, index]));
  const todayPosition = (dayNumber(todayDate()) - range.start) * dayWidth;
  const chartRowCount = issues.length + historicalIssues.length + milestones.length + historicalMilestones.length;
  function changeVisibility(nextQuery: string, nextHideDone: boolean) { const visibleIds = new Set(projectIssues.filter(issue => (!nextHideDone || !isTerminalStatus(data, issue.projectId, issue.status)) && (!nextQuery || `${issue.key} ${issue.title}`.toLowerCase().includes(nextQuery.toLowerCase()))).map(issue => issue.id)); if ([...draftsRef.current.entries()].some(([id, value]) => id.startsWith('dates:') && (value.dirty || value.pending) && !visibleIds.has(id.slice(6))) && !canLeave()) return; setQuery(nextQuery); setHideDone(nextHideDone); }
  function showDate(date: string) { setWindowStart(isoDay(Math.max(MIN_TIMELINE_DAY, Math.min(MAX_TIMELINE_DAY - MAX_TIMELINE_DAYS + 1, dayNumber(date) - 7)))); }
  function outside(date: string) { const day = dayNumber(date); return day < range.start || day > range.end; }
  function capturedStyle(startDate: string, endDate: string): CSSProperties { const start = Math.max(range.start, dayNumber(startDate)), end = Math.min(range.end, dayNumber(endDate)); return end < start ? { display: 'none' } : { left: (start - range.start) * dayWidth + 2, width: Math.max(3, (end - start + 1) * dayWidth - 4) }; }

  function toggleSelected(id: string) { setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  async function requestPreview(ids: string[], offset: number, skipWeekends: boolean) {
    if (!ids.length) { notify('이동할 업무를 먼저 선택하세요.', 'error'); return; }
    if (!Number.isInteger(offset) || offset === 0) { notify('0이 아닌 정수 일수를 입력하세요.', 'error'); return; }
    markBusy(true);
    try { const result = await post<SchedulePreview>('/schedule/preview', { issueIds: ids, days: offset, workingDays: skipWeekends }); setPreview(result); setPreviewError(''); setShiftOpen(false); }
    catch (err) { notify(errorMessage(err), 'error'); } finally { markBusy(false); }
  }
  async function applyChanges(value: SchedulePreview) {
    if (!value.changes.length || busyRef.current) return null; markBusy(true); setPreviewError('');
    try {
      const result = await post<ApplyResult>('/schedule/apply', { changes: value.changes.map(change => ({ id: change.id, expectedVersion: change.version, startDate: change.toStart, endDate: change.toEnd })), ...(value.calendarVersions ? { calendarVersions: value.calendarVersions } : {}) });
      setUndoId(result.undoId); setPreview(null); setScheduleWarnings(result.warnings || []); await refresh(); notify(`${value.changes.length}개 업무의 일정을 변경했습니다.${result.warnings?.length ? ' 의존성 경고를 확인하세요.' : ''}`);
      return result;
    } catch (err) { if (preview) setPreviewError(errorMessage(err)); notify(errorMessage(err), 'error'); return null; } finally { markBusy(false); }
  }
  async function saveDates(issue: Issue, startDate: string | null, endDate: string | null) {
    if (startDate === issue.startDate && endDate === issue.endDate) return issue;
    if (startDate && endDate && startDate > endDate) { notify('종료일은 시작일보다 빠를 수 없습니다.', 'error'); return null; }
    if (busyRef.current) { notify('진행 중인 일정 변경이 끝난 뒤 다시 시도하세요.', 'error'); return null; }
    const result = await applyChanges({ changes: [{ id: issue.id, key: issue.key, title: issue.title, version: issue.version, fromStart: issue.startDate, fromEnd: issue.endDate, toStart: startDate, toEnd: endDate }], warnings: [] });
    return result?.updated.find(value => value.id === issue.id) || null;
  }
  async function undo() {
    if (!undoId) return; markBusy(true);
    try { const result = await post<{ updated: Issue[]; warnings?: string[] }>('/schedule/undo', { undoId }); setUndoId(null); setScheduleWarnings(result.warnings || []); await refresh(); notify('마지막 일정 변경을 되돌렸습니다.'); }
    catch (err) { notify(errorMessage(err), 'error'); } finally { markBusy(false); }
  }
  async function unlink(id: string) { markBusy(true); try { await remove(`/dependencies/${id}`); await refresh(); notify('선행·후행 연결을 해제했습니다.'); } catch (err) { notify(errorMessage(err), 'error'); } finally { markBusy(false); } }
  function goToToday() { const today = dayNumber(todayDate()); if (today < range.start || today > range.end) { setWindowStart(isoDay(Math.max(MIN_TIMELINE_DAY, today - 9))); requestAnimationFrame(() => scrollRef.current?.scrollTo({ left: Math.max(0, 9 * dayWidth - 100), behavior: 'smooth' })); } else scrollRef.current?.scrollTo({ left: Math.max(0, todayPosition - 100), behavior: 'smooth' }); }
  function previewResize(issue: Issue, edge: 'start' | 'end', delta: number) {
    if (!issue.startDate || !issue.endDate || !delta) return;
    const toStart = edge === 'start' ? moveDate(issue.startDate, delta) : issue.startDate;
    const toEnd = edge === 'end' ? moveDate(issue.endDate, delta) : issue.endDate;
    if (toStart > toEnd) { notify('종료일은 시작일보다 빠를 수 없습니다.', 'error'); return; }
    const warnings: string[] = [];
    const changed = { ...issue, startDate: toStart, endDate: toEnd };
    for (const dependency of data.dependencies.filter(value => value.predecessorId === issue.id || value.successorId === issue.id)) {
      const predecessor = dependency.predecessorId === issue.id ? changed : data.issues.find(value => value.id === dependency.predecessorId);
      const successor = dependency.successorId === issue.id ? changed : data.issues.find(value => value.id === dependency.successorId);
      if (predecessor?.endDate && successor?.startDate) { try { if (successor.startDate < shiftWorkingDate(calendar, predecessor.endDate, dependency.lagDays + 1)) warnings.push(`${predecessor.key} → ${successor.key}: 완료 후 시작 조건과 일정이 맞지 않습니다. 연결된 업무는 자동 이동하지 않습니다.`); } catch (err) { warnings.push(`${predecessor.key} → ${successor.key}: ${errorMessage(err)}`); } }
    }
    setPreview({ changes: [{ id: issue.id, key: issue.key, title: issue.title, version: issue.version, fromStart: issue.startDate, fromEnd: issue.endDate, toStart, toEnd }], warnings }); setPreviewError('');
  }
  function beginDrag(event: PointerEvent<HTMLButtonElement>, issue: Issue, mode: DragMode) {
    if (event.button !== 0 || busy) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ issue, initialX: event.clientX, delta: 0, mode });
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    let delta = Math.round((event.clientX - drag.initialX) / dayWidth);
    const duration = dayNumber(drag.issue.endDate!) - dayNumber(drag.issue.startDate!);
    if (drag.mode === 'start') delta = Math.min(delta, duration);
    if (drag.mode === 'end') delta = Math.max(delta, -duration);
    setDrag({ ...drag, delta });
  }
  function focusDate(issue: Issue, edge: 'start' | 'end') { document.querySelector<HTMLInputElement>(`input[aria-label="${issue.key} ${edge === 'start' ? '시작일' : '종료일'}"]`)?.focus(); }
  function finishDrag() {
    if (!drag) return; const current = drag; setDrag(null);
    if (current.delta) { if (current.mode === 'move') void requestPreview([current.issue.id], current.delta, false); else previewResize(current.issue, current.mode, current.delta); }
    else if (current.mode === 'move') openIssue(current.issue.id);
    else focusDate(current.issue, current.mode);
  }
  const months = ticks.filter(t => t.date.getUTCDate() === 1 || t.index === 0);

  return <div className="gantt-feature">
    <div className="feature-heading"><div><div className="feature-eyebrow">PLAN WITH CLARITY</div><h1>일정 · 간트</h1><p>업무와 일정이 하나로. 직접 입력하고, 연결하고, 함께 조정하세요.</p></div><div className="gantt-heading-actions"><button className="btn" disabled={busy || !data.projects.some(project => project.id === projectId)} onClick={() => { if (canLeave()) setPasteOpen(true); }}><ClipboardPaste size={15} />일정 붙여넣기</button><button className="btn" disabled={busy} onClick={() => { if (canLeave()) setAutoOpen(true); }}><Sparkles size={15} />자동 일정</button><button className="btn" onClick={() => { if (canLeave()) setLinkOpen(true); }}><Link2 size={16} /> 업무 연결</button><button className="btn btn-primary" onClick={() => { if (canLeave()) setCreateOpen(true); }}><Plus size={16} /> 업무 추가</button></div></div>
    <div className="gantt-stats"><div><span className="gantt-stat-dot" /><strong>{projectIssues.filter(i => i.startDate && i.endDate).length}</strong><span>일정이 잡힌 업무</span></div><div><span className="gantt-stat-dot is-empty" /><strong>{projectIssues.filter(i => !i.startDate || !i.endDate).length}</strong><span>일정 미정</span></div><div><Link2 size={13} /><strong>{data.dependencies.filter(d => projectIssues.some(i => i.id === d.predecessorId) && projectIssues.some(i => i.id === d.successorId)).length}</strong><span>업무 연결</span></div><span className="gantt-manual-badge">직접 계획 · 자동 제안</span></div>
    <div className="issue-toolbar gantt-toolbar"><div className="issue-search"><Search size={15} /><input placeholder="업무 검색" aria-label="간트 업무 검색" value={query} disabled={busy} onChange={e => changeVisibility(e.target.value, hideDone)} /></div><label className="gantt-checkbox-label"><input type="checkbox" checked={hideDone} disabled={busy} onChange={e => changeVisibility(query, e.target.checked)} />완료 업무 숨기기</label><div className="gantt-toolbar-spacer" /><button className="btn" onClick={goToToday}><CalendarDays size={14} /> 오늘</button><div className="issue-view-switch gantt-zoom">{([['day', '일'], ['week', '주'], ['month', '월']] as const).map(([key, label]) => <button key={key} className={zoom === key ? 'active' : ''} onClick={() => setZoom(key)}>{label}</button>)}</div><button className="btn" onClick={() => { if (shiftOpen || canLeave()) setShiftOpen(!shiftOpen); }} disabled={!selectedIssues.length || busy}><MoveHorizontal size={15} />{selectedIssues.length ? `${selectedIssues.length}개 ` : ''}일정 이동</button><button className="btn btn-ghost" onClick={undo} disabled={!undoId || busy} title="마지막 일정 변경 되돌리기"><Undo2 size={16} /><span className="gantt-undo-label">되돌리기</span></button></div>
    {shiftOpen && <form className="gantt-shift-form" onSubmit={e => { e.preventDefault(); void requestPreview(selectedIssues.map(i => i.id), days, workingDays); }}><span><strong>{selectedIssues.length}개</strong> 업무를</span><input className="field" aria-label="이동 일수" type="number" step="1" min="-3650" max="3650" value={days} onChange={e => setDays(Number(e.target.value))} required /><span>일 이동</span><label className="gantt-checkbox-label"><input type="checkbox" checked={workingDays} onChange={e => setWorkingDays(e.target.checked)} />근무일 기준</label><small>음수는 앞당기기 · 프로젝트 달력의 근무 요일·예외 적용</small><button className="btn btn-primary" type="submit" disabled={busy}>변경 미리보기</button><button className="issue-icon-button" type="button" onClick={() => setShiftOpen(false)} aria-label="일정 이동 닫기"><X size={16} /></button></form>}
    {createOpen && <InlineIssueForm key={`${projectId}:${draftEpoch}`} data={data} projectId={projectId} projects={data.projects} users={data.users} onDraftChange={trackDraft} onClose={() => { if (canLeave()) setCreateOpen(false); }} onCreated={async issue => { await refresh(); setCreateOpen(false); setQuery(''); setHideDone(false); notify(`${issue.key} 업무를 간트에 추가했습니다.`); }} />}
    <SchedulePlanningPanel {...props} selectedBaselineId={selectedBaselineId} onSelectBaseline={setSelectedBaselineId} />
    {baseline && <div className="gantt-baseline-caption"><span className="gantt-baseline-key" />비교 기준선 <strong>{baseline.name}</strong><span>회색은 캡처된 계획 · 종료 차이는 달력일 · 삭제된 업무와 마일스톤 기록도 보존됩니다.</span></div>}
    <div className="gantt-hint" id="gantt-editing-help"><span><span className="gantt-mini-bar" />막대 가운데는 이동, 양 끝은 기간 조정 · 변경 후 미리보기</span><span>날짜 입력 후 Enter로 저장 · Esc로 최신 날짜 · 핸들은 ← → 키도 지원해요.</span></div>
    <div className="gantt-window-controls"><span>표시 범위</span><button className="btn btn-ghost" aria-label="간트 이전 60일" onClick={() => setWindowStart(isoDay(Math.max(MIN_TIMELINE_DAY, range.start - 60)))}>←</button><input className="field" type="date" aria-label="간트 표시 시작일" min="0000-01-01" max="9999-12-31" value={isoDay(range.start)} onChange={event => { if (event.target.value) setWindowStart(event.target.value); }} /><span>— {isoDay(range.end)}</span><button className="btn btn-ghost" aria-label="간트 다음 60일" onClick={() => setWindowStart(isoDay(Math.min(MAX_TIMELINE_DAY - MAX_TIMELINE_DAYS + 1, range.start + 60)))}>→</button><button className="btn btn-ghost" onClick={() => { setWindowStart(null); goToToday(); }}>오늘 중심</button><small>최대 {MAX_TIMELINE_DAYS}일 표시 · 범위 밖 기록은 행의 날짜로 이동하세요.</small></div>
    <div className="gantt-scroll" ref={scrollRef}><div className="gantt-canvas" style={{ width: LEFT_WIDTH + timelineWidth, '--gantt-day-width': `${dayWidth}px` } as CSSProperties}>
      <div className="gantt-chart-header"><div className="gantt-left gantt-left-header"><label><input type="checkbox" aria-label="표시된 업무 전체 선택" checked={issues.length > 0 && issues.every(i => selected.has(i.id))} onChange={e => setSelected(e.target.checked ? new Set(issues.map(i => i.id)) : new Set())} /></label><span>업무 <small>{issues.length}</small></span><span>시작일</span><span>종료일</span></div><div className="gantt-date-header" style={{ width: timelineWidth }}><div className="gantt-months">{months.map((tick, index) => <span key={tick.iso} style={{ left: tick.index * dayWidth, width: ((months[index + 1]?.index ?? range.days) - tick.index) * dayWidth }}>{tick.date.getUTCFullYear()}년 {tick.date.getUTCMonth() + 1}월</span>)}</div><div className="gantt-days">{ticks.map(tick => <span key={tick.iso} data-date={tick.iso} className={`${!calendarMath.isWorking(tick.iso) ? 'weekend' : ''} ${tick.iso === todayDate() ? 'today' : ''}`} style={{ width: dayWidth }}>{zoom === 'day' ? <>{tick.date.getUTCDate()}<small>{['일', '월', '화', '수', '목', '금', '토'][tick.weekday]}</small></> : zoom === 'week' && (tick.weekday === 1 || tick.index === 0) ? tick.date.getUTCDate() : zoom === 'month' && tick.date.getUTCDate() === 15 ? '15' : ''}</span>)}</div></div></div>
      {ticks.filter(t => !calendarMath.isWorking(t.iso)).map(tick => <div key={tick.iso} className="gantt-weekend-band" style={{ left: LEFT_WIDTH + tick.index * dayWidth, width: dayWidth, top: HEADER_HEIGHT, height: chartRowCount * ROW_HEIGHT }} />)}
      {todayPosition >= 0 && todayPosition < timelineWidth && <div className="gantt-today-line" style={{ left: LEFT_WIDTH + todayPosition + dayWidth / 2, top: HEADER_HEIGHT, height: chartRowCount * ROW_HEIGHT }} />}
      <svg className="gantt-dependency-lines" width={timelineWidth} height={issues.length * ROW_HEIGHT} style={{ left: LEFT_WIDTH, top: HEADER_HEIGHT }} aria-hidden="true"><defs><marker id="gantt-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7" fill="#8a9b9b" /></marker></defs>{dependencies.map(dependency => { const predecessor = issues.find(i => i.id === dependency.predecessorId); const successor = issues.find(i => i.id === dependency.successorId); if (!predecessor?.endDate || !successor?.startDate) return null; const x1 = (dayNumber(predecessor.endDate) - range.start + 1) * dayWidth; const x2 = (dayNumber(successor.startDate) - range.start) * dayWidth; const y1 = (rowIndex.get(predecessor.id)! + .5) * ROW_HEIGHT; const y2 = (rowIndex.get(successor.id)! + .5) * ROW_HEIGHT; const turn = Math.max(x1 + 12, x2 - 15); return <path key={dependency.id} d={`M${x1},${y1} H${turn} V${y2} H${x2 - 3}`} fill="none" stroke="#8a9b9b" strokeWidth="1.3" strokeDasharray="3 3" markerEnd="url(#gantt-arrow)" />; })}</svg>
      {issues.map(issue => {
        const user = data.users.find(u => u.id === issue.assigneeId); const start = issue.startDate ? dayNumber(issue.startDate) : null; const end = issue.endDate ? dayNumber(issue.endDate) : null; const dragging = drag?.issue.id === issue.id; const offset = dragging ? drag.delta : 0; const startOffset = dragging && drag.mode !== 'end' ? offset : 0; const endOffset = dragging && drag.mode !== 'start' ? offset : 0; const hasSchedule = start !== null && end !== null; const visibleStart = hasSchedule ? Math.max(range.start, start! + startOffset) : 0; const visibleEnd = hasSchedule ? Math.min(range.end, end! + endOffset) : -1; const visibleSchedule = hasSchedule && visibleStart <= visibleEnd; const color = statusMeta(data,issue.projectId,issue.status).color; const captured = baseline?.issues.find(value => value.issueId === issue.id); const endDelta = captured?.endDate && issue.endDate ? dayNumber(issue.endDate) - dayNumber(captured.endDate) : null;
        return <div data-issue-id={issue.id} className={`gantt-row ${selected.has(issue.id) ? 'is-selected' : ''}`} key={issue.id}><div className="gantt-left"><label><input type="checkbox" aria-label={`${issue.key} 선택`} checked={selected.has(issue.id)} onChange={() => toggleSelected(issue.id)} /></label><button className="gantt-issue-name" onClick={() => openIssue(issue.id)}><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} /><span><small>{issue.key} · <IssueTypeName data={data} issue={issue} /></small><strong title={issue.title}>{issue.title}</strong>{endDelta !== null && <small className="gantt-baseline-delta" title="현재 계획 종료일 − 기준선 종료일 (달력일)">종료 {endDelta > 0 ? '+' : ''}{endDelta}일 · 달력일</small>}</span>{user && <span className="issue-avatar" style={{ background: user.color }} title={user.name}>{user.name.slice(0, 1)}</span>}</button><DateCells key={`${issue.id}:${draftEpoch}`} issue={issue} onDraftChange={trackDraft} disabled={busy} onSave={(source, startDate, endDate) => saveDates(source, startDate, endDate)} /></div><div className="gantt-row-timeline" style={{ width: timelineWidth }}>
          {captured?.startDate && captured.endDate && <div className="gantt-baseline-bar" role="img" aria-label={`${captured.key} 기준선 ${captured.startDate} ~ ${captured.endDate}`} title={`${baseline!.name}: ${captured.title} · ${captured.startDate} ~ ${captured.endDate}`} style={capturedStyle(captured.startDate, captured.endDate)} />}
          {visibleSchedule ? <div className={`gantt-task-range ${dragging ? 'is-dragging' : ''}`} style={{ left: (visibleStart - range.start) * dayWidth + 2, width: Math.max(dayWidth - 4, (visibleEnd - visibleStart + 1) * dayWidth - 4), '--bar-color': color } as CSSProperties}>
            <button className={`gantt-bar ${dragging ? 'is-dragging' : ''} ${statusMeta(data,issue.projectId,issue.status).category === 'done' ? 'is-done' : ''}`} disabled={busy} aria-label={`${issue.key} 일정 이동`} aria-describedby="gantt-editing-help" title={`${issue.key}: ${issue.startDate} ~ ${issue.endDate} · 끌어서 이동, 선택해서 상세 보기`} onPointerDown={event => beginDrag(event, issue, 'move')} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={() => setDrag(null)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openIssue(issue.id); } }}><span>{zoom !== 'month' && issue.title}</span></button>
            {(['start', 'end'] as const).filter(edge => edge === 'start' ? !outside(isoDay(start! + startOffset)) : !outside(isoDay(end! + endOffset))).map(edge => <button key={edge} type="button" className={`gantt-resize-handle is-${edge}`} aria-label={`${issue.key} ${edge === 'start' ? '시작일' : '종료일'} 조정`} aria-describedby="gantt-editing-help" title={`${edge === 'start' ? '시작일' : '종료일'} 조정 · 드래그 또는 좌우 방향키 · Enter로 날짜 입력`} disabled={busy} onPointerDown={event => beginDrag(event, issue, edge)} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={() => setDrag(null)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); previewResize(issue, edge, event.key === 'ArrowRight' ? 1 : -1); } }} onClick={event => { if (event.detail === 0) focusDate(issue, edge); }}><span /></button>)}
            {dragging && offset !== 0 && <small className="gantt-drag-label">{drag.mode === 'move' ? `${offset > 0 ? '+' : ''}${offset}일` : `${moveDate(issue.startDate!, startOffset)} ~ ${moveDate(issue.endDate!, endOffset)}`}</small>}
          </div> : hasSchedule ? <button className="gantt-jump-date" onClick={() => showDate(issue.startDate!)}>{issue.startDate} — {issue.endDate} · 일정으로 이동 →</button> : <button className="gantt-no-schedule" onClick={() => openIssue(issue.id)}><Plus size={12} /> 날짜를 입력해 일정을 잡으세요</button>}
        </div></div>;
      })}
      {historicalIssues.map(captured => <div key={`historical:${captured.issueId}`} className="gantt-row gantt-history-row" data-baseline-issue-id={captured.issueId}><div className="gantt-left"><span /><div className="gantt-history-name"><small>{captured.key} · 삭제된 업무 기록</small><strong>{captured.title}</strong></div><button className="gantt-history-date" disabled={!captured.startDate} onClick={() => captured.startDate && showDate(captured.startDate)}>{captured.startDate || '미정'}</button><button className="gantt-history-date" disabled={!captured.endDate} onClick={() => captured.endDate && showDate(captured.endDate)}>{captured.endDate || '미정'}</button></div><div className="gantt-row-timeline" style={{ width: timelineWidth }}>{captured.startDate && captured.endDate && <div className="gantt-baseline-bar is-historical" role="img" aria-label={`${captured.key} 삭제된 업무 기준선 ${captured.startDate} ~ ${captured.endDate}`} style={capturedStyle(captured.startDate, captured.endDate)} />}</div></div>)}
      {milestones.map(milestone => { const captured = baseline?.milestones.find(value => value.milestoneId === milestone.id); const delta = captured ? dayNumber(milestone.date) - dayNumber(captured.date) : null; return <div key={milestone.id} className="gantt-row gantt-milestone-row" data-milestone-id={milestone.id}><div className="gantt-left"><Diamond size={13} /><div className="gantt-milestone-name"><small>{milestone.status === 'reached' ? '달성' : '예정'} · 마일스톤</small><strong>{milestone.title}</strong>{delta !== null && <small>기준선 대비 {delta > 0 ? '+' : ''}{delta}일 · 달력일</small>}</div><button className="gantt-history-date" onClick={() => showDate(milestone.date)}>{milestone.date}</button>{captured ? <button className="gantt-history-date" onClick={() => showDate(captured.date)}>기준 {captured.date}</button> : <span />}</div><div className="gantt-row-timeline" style={{ width: timelineWidth }}>{captured && !outside(captured.date) && <span className="gantt-milestone-diamond is-baseline" role="img" aria-label={`${captured.title} 마일스톤 기준선 ${captured.date}`} title={`기준선: ${captured.title} · ${captured.date}`} style={{ left: (dayNumber(captured.date) - range.start + .5) * dayWidth }} />}{!outside(milestone.date) ? <span className={`gantt-milestone-diamond ${milestone.status === 'reached' ? 'is-reached' : ''}`} role="img" aria-label={`${milestone.title} 마일스톤 ${milestone.date}`} title={`${milestone.title} · ${milestone.date}`} style={{ left: (dayNumber(milestone.date) - range.start + .5) * dayWidth }}><span>{milestone.title}</span></span> : <button className="gantt-jump-date" onClick={() => showDate(milestone.date)}>{milestone.date} · 마일스톤으로 이동 →</button>}</div></div>; })}
      {historicalMilestones.map(captured => <div key={`historical-milestone:${captured.milestoneId}`} className="gantt-row gantt-history-row"><div className="gantt-left"><Diamond size={12} /><div className="gantt-history-name"><small>삭제된 마일스톤 기록</small><strong>{captured.title}</strong></div><button className="gantt-history-date" onClick={() => showDate(captured.date)}>{captured.date}</button><span /></div><div className="gantt-row-timeline" style={{ width: timelineWidth }}>{!outside(captured.date) ? <span className="gantt-milestone-diamond is-baseline is-historical" role="img" aria-label={`${captured.title} 삭제된 마일스톤 기준선 ${captured.date}`} style={{ left: (dayNumber(captured.date) - range.start + .5) * dayWidth }} /> : <button className="gantt-jump-date" onClick={() => showDate(captured.date)}>{captured.date} · 기준선 기록으로 이동 →</button>}</div></div>)}
      <button className="gantt-add-inline-row" style={{ width: LEFT_WIDTH }} onClick={() => { if (canLeave()) setCreateOpen(true); }}><Plus size={14} /> 이 간트에 업무 추가</button>
      {issues.length === 0 && <div className="gantt-no-issues" style={{ width: LEFT_WIDTH }}><CalendarDays size={28} /><strong>표시할 업무가 없습니다</strong><span>업무를 만들거나 검색 조건을 변경하세요.</span></div>}
    </div></div>
    {baseline && <details className="gantt-baseline-records"><summary>기준선 업무 기록 {baseline.issues.length}개 · 캡처된 이름과 날짜 확인</summary><div><table><thead><tr><th>기준선 업무</th><th>시작일</th><th>종료일</th><th>현재 상태</th></tr></thead><tbody>{baseline.issues.map(captured => <tr key={captured.issueId}><td><small>{captured.key}</small><strong>{captured.title}</strong></td><td><button disabled={!captured.startDate} onClick={() => captured.startDate && showDate(captured.startDate)}>{captured.startDate || '미정'}</button></td><td><button disabled={!captured.endDate} onClick={() => captured.endDate && showDate(captured.endDate)}>{captured.endDate || '미정'}</button></td><td>{projectIssues.some(issue => issue.id === captured.issueId) ? '현재 업무 있음' : '삭제된 업무 기록'}</td></tr>)}</tbody></table></div></details>}
    {scheduleWarnings.length > 0 && <div className="gantt-current-warnings" role="status"><AlertCircle size={16} /><div><strong>일정 의존성 확인</strong>{scheduleWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div><button className="issue-icon-button" onClick={() => setScheduleWarnings([])} aria-label="경고 닫기"><X size={14} /></button></div>}
    <div className="gantt-legend"><span><span className="gantt-mini-bar" />계획 일정</span><span><span className="gantt-legend-line" />선행 → 후행</span><span><span className="gantt-legend-today" />오늘</span><span><Diamond size={12} />마일스톤</span><span><span className="gantt-nonworking-key" />비근무일</span>{baseline && <span><span className="gantt-baseline-key" />기준선</span>}<span className="muted">수기 계획에서는 의존성을 연결해도 날짜가 자동으로 바뀌지 않습니다.</span></div>
    <div className="gantt-bottom-grid"><section className="gantt-bottom-card"><div className="gantt-bottom-heading"><h3><CalendarDays size={16} />일정 미정 <span>{unscheduled.length}</span></h3><span className="muted">시작일과 종료일을 정해주세요</span></div>{unscheduled.length ? unscheduled.map(issue => <div key={issue.id} className="gantt-unscheduled-row"><button onClick={() => openIssue(issue.id)}><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} /><span className="issue-key">{issue.key}</span><strong>{issue.title}</strong></button><button className="btn btn-ghost" disabled={busy} onClick={() => saveDates(issue, issue.startDate || (issue.endDate ? moveDate(issue.endDate, -2) : todayDate()), issue.endDate || (issue.startDate ? moveDate(issue.startDate, 2) : moveDate(todayDate(), 2)))}><Plus size={13} />{issue.startDate || issue.endDate ? '일정 완성' : '오늘부터 3일'}</button></div>) : <div className="gantt-bottom-empty"><Check size={17} />모든 업무에 일정이 잡혀 있습니다.</div>}</section><section className="gantt-bottom-card"><div className="gantt-bottom-heading"><h3><Link2 size={16} />업무 연결 <span>{dependencies.length}</span></h3><button className="btn btn-ghost" onClick={() => { if (canLeave()) setLinkOpen(true); }}><Plus size={13} /> 연결 추가</button></div>{dependencies.length ? dependencies.map(dependency => { const predecessor = data.issues.find(i => i.id === dependency.predecessorId)!; const successor = data.issues.find(i => i.id === dependency.successorId)!; return <div key={dependency.id} className="gantt-dependency-row"><button title={predecessor.title} onClick={() => openIssue(predecessor.id)}>{predecessor.key}</button><ArrowRight size={13} /><button title={successor.title} onClick={() => openIssue(successor.id)}>{successor.key}</button><span>완료 후 시작{dependency.lagDays ? ` · +${dependency.lagDays}근무일` : ''}</span><button className="issue-icon-button" onClick={() => unlink(dependency.id)} disabled={busy} aria-label={`${predecessor.key}와 ${successor.key} 연결 해제`}><X size={14} /></button></div>; }) : <div className="gantt-bottom-empty">선행 업무를 연결해 일정의 흐름을 확인하세요.</div>}</section></div>
    {preview && <div className="issue-modal-overlay"><section className="gantt-preview-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-preview-title"><header><div><span className="feature-eyebrow">REVIEW CHANGES</span><h2 id="schedule-preview-title">일정 변경 미리보기</h2><p>{preview.changes.length}개 업무의 변경 내용을 확인하세요.</p></div><button className="issue-icon-button" onClick={() => setPreview(null)} disabled={busy} aria-label="미리보기 닫기"><X size={20} /></button></header>{preview.warnings.length > 0 && <div className="gantt-preview-warnings"><AlertCircle size={17} /><div><strong>적용 전에 확인하세요</strong>{preview.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}{previewError && <div className="issue-form-error gantt-preview-error" role="alert">{previewError}<br />미리보기와 입력 내용은 유지됩니다. 취소 후 최신 일정을 확인하고 다시 조정하세요.</div>}<div className="gantt-preview-table"><table><thead><tr><th>업무</th><th>현재 일정</th><th /><th>변경할 일정</th></tr></thead><tbody>{preview.changes.map(change => <tr key={change.id}><td><span className="issue-key">{change.key}</span><strong>{change.title}</strong></td><td>{change.fromStart || '미정'}<br />{change.fromEnd || '미정'}</td><td><ArrowRight size={16} /></td><td className="gantt-new-dates">{change.toStart || '미정'}<br />{change.toEnd || '미정'}</td></tr>)}</tbody></table>{preview.changes.length === 0 && <div className="issue-empty">이동할 일정이 없습니다. 날짜를 먼저 입력하세요.</div>}</div><footer><span className="muted">적용 후 마지막 변경을 되돌릴 수 있습니다.</span><button className="btn btn-ghost" onClick={() => setPreview(null)} disabled={busy}>취소</button><button className="btn btn-primary" disabled={busy || !preview.changes.length} onClick={() => applyChanges(preview)}><Check size={16} />{busy ? '적용 중…' : '변경 적용'}</button></footer></section></div>}
    {autoOpen && <AutomaticScheduleDialog {...props} selectedIssueIds={selectedIssues.map(issue => issue.id)} onClose={() => setAutoOpen(false)} onApplied={async result => { setUndoId(result.undoId); setScheduleWarnings(result.warnings || []); await refresh(); setAutoOpen(false); notify(`${result.updated.length}개 업무에 자동 일정 제안을 적용했습니다.`); }} />}
    {pasteOpen && <SchedulePasteDialog
      projectId={projectId} notify={notify} onDraftChange={trackDraft} onClose={() => setPasteOpen(false)}
      onApplied={async result => {
        setUndoId(result.undoId);
        setScheduleWarnings(result.warnings);
        await refresh();
        setPasteOpen(false);
        notify(`${result.updated.length}개 업무의 일정을 변경했습니다.`);
      }}
    />}
    {linkOpen && <DependencyModal key={draftEpoch} issues={projectIssues} busy={busy} onDraftChange={trackDraft} onClose={() => { if (canLeave()) setLinkOpen(false); }} onSubmit={async (predecessorId, successorId, lagDays) => { markBusy(true); try { await post('/dependencies', { predecessorId, successorId, lagDays }); await refresh(); setLinkOpen(false); notify('선행·후행 업무를 연결했습니다.'); } catch (err) { throw err; } finally { markBusy(false); } }} />}
  </div>;
}

function InlineIssueForm({ data, projectId, projects, users, onClose, onCreated, onDraftChange }: { data:FeatureProps['data']; projectId: string; projects: Project[]; users: User[]; onClose: () => void; onCreated: (issue: Issue) => Promise<void>; onDraftChange: TrackDraft }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState(() => initialIssueType(data, projects.some(project => project.id === projectId) ? projectId : projects[0]?.id || ''));
  const [valuesByProject, setValuesByProject] = useState<Record<string, Record<string, CustomFieldValue>>>({});
  const [assigneeId, setAssigneeId] = useState('');
  const [selectedProject, setSelectedProject] = useState(projects.some(project => project.id === projectId) ? projectId : projects[0]?.id || '');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  useEffect(() => { onDraftChange('create', touched, saving); return () => onDraftChange('create', false); }, [onDraftChange, touched, saving]);
  const customFields = valuesByProject[selectedProject] || {};
  const initialStatus = projectWorkflow(data,selectedProject).initialStatusId;
  const required = requiredFieldsFor(data,selectedProject,type,initialStatus);
  const extraFields = required.filter(field => !field.startsWith('custom:') && !['title','assigneeId','startDate','endDate','cycle','module','release'].includes(field));
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget as HTMLFormElement);
    if (startDate && endDate && startDate > endDate) { setError('종료일은 시작일보다 빠를 수 없습니다. 입력한 날짜를 확인하세요.'); return; }
    if (!title.trim()) { setError('업무 제목을 입력하세요.'); return; }
    setSaving(true);
    try { const issue = await post<Issue>('/issues', { projectId: selectedProject, title: title.trim(), type, status: initialStatus, assigneeId: assigneeId || null, startDate: startDate || null, endDate: endDate || null, description:form.get('description') || '',collaboratorIds:form.getAll('collaboratorIds'),dueDate:form.get('dueDate')||null,estimate:form.get('estimate') ? Number(form.get('estimate')) : null,labels:String(form.get('labels')||'').split(',').map(value=>value.trim()).filter(Boolean),parentId:form.get('parentId')||null,cycleId:form.get('cycleId')||null,moduleId:form.get('moduleId')||null,releaseId:form.get('releaseId')||null, customFields }); await onCreated(issue); }
    catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  }
  return <form className="gantt-inline-create" aria-label="간트에서 업무 만들기" onSubmit={submit} onChange={() => setTouched(true)}>
    <div className="gantt-inline-create-heading"><div><strong><Plus size={15} /> 간트에 업무 추가</strong><span>날짜는 나중에 정해도 괜찮아요. 저장하면 같은 간트에 표시됩니다.</span></div><button className="issue-icon-button" type="button" onClick={onClose} disabled={saving} aria-label="간트 업무 추가 닫기"><X size={17} /></button></div>
    <div className="gantt-create-fields"><label className="issue-form-label gantt-create-title">업무 제목<input autoFocus aria-label="추가할 업무 제목" className="field" placeholder="해야 할 일을 입력하세요" value={title} onChange={event => setTitle(event.target.value)} required maxLength={300} disabled={saving} /></label><label className="issue-form-label">유형<IssueTypeSelect data={data} projectId={selectedProject} value={type} onChange={setType} disabled={saving} ariaLabel="추가할 업무 유형" /></label><label className="issue-form-label">담당자<select aria-label="추가할 업무 담당자" className="field" value={assigneeId} onChange={event => setAssigneeId(event.target.value)} disabled={saving}><option value="">미지정</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label><label className="issue-form-label">시작일<input aria-label="추가할 업무 시작일" className="field" type="date" value={startDate} onChange={event => setStartDate(event.target.value)} disabled={saving} /></label><label className="issue-form-label">종료일<input aria-label="추가할 업무 종료일" className="field" type="date" value={endDate} onChange={event => setEndDate(event.target.value)} disabled={saving} /></label>{(!projectId || projectId === 'all') && <label className="issue-form-label">프로젝트<select aria-label="추가할 업무 프로젝트" className="field" value={selectedProject} onChange={event => { setSelectedProject(event.target.value); setType(initialIssueType(data, event.target.value)); }} disabled={saving} required>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}</div>
    <div className="issue-form-grid">{(['cycle','module','release'] as const).map(kind=><label key={kind} className="issue-form-label">{PLAN_LABELS[kind]}<PlanningSelect data={data} projectId={selectedProject} kind={kind} ariaLabel={`추가할 업무 ${PLAN_LABELS[kind]}`} disabled={saving}/></label>)}</div>
    <CustomFields data={data} projectId={selectedProject} issueType={type} values={customFields} onChange={next => { setTouched(true); setValuesByProject(previous => ({ ...previous, [selectedProject]: next })); }} disabled={saving} requiredFields={required} labelPrefix="추가할 업무 " />
    {required.length > 0 && <p className="issue-section-empty">기본 상태의 필수 속성: {requiredFieldLabels(data, selectedProject, required).join(', ')}</p>}
    {extraFields.length > 0 && <div className="issue-form-grid">{extraFields.map(field=><label key={field} className="issue-form-label">{REQUIRED_FIELD_LABELS[field]}{field === 'description' ? <textarea className="field" name={field} aria-label={`추가할 업무 ${REQUIRED_FIELD_LABELS[field]}`} disabled={saving} rows={3}/> : field === 'parentId' ? <select className="field" name={field} aria-label="추가할 업무 상위 업무" disabled={saving}><option value="">없음</option>{data.issues.filter(issue=>issue.projectId===selectedProject).map(issue=><option key={issue.id} value={issue.id}>{issue.key} · {issue.title}</option>)}</select> : field === 'collaboratorIds' ? <select className="field" name={field} aria-label="추가할 업무 참여자" multiple disabled={saving}>{users.map(user=><option key={user.id} value={user.id}>{user.name}</option>)}</select> : <input className="field" name={field} aria-label={`추가할 업무 ${REQUIRED_FIELD_LABELS[field]}`} disabled={saving} type={field === 'dueDate'?'date':field==='estimate'?'number':'text'} min={field==='estimate'?0:undefined} step={field==='estimate'?'0.5':undefined} placeholder={field==='labels'?'쉼표로 구분':undefined}/>}</label>)}</div>}
    {error && <div className="issue-form-error" role="alert">{error}</div>}
    <div className="gantt-inline-create-footer"><small>시작일·종료일은 선택 사항입니다.</small><button className="btn btn-ghost" type="button" onClick={onClose} disabled={saving}>취소</button><button className="btn btn-primary" type="submit" disabled={saving || !selectedProject}><Plus size={14} />{saving ? '추가 중…' : '간트에 추가'}</button></div>
  </form>;
}

function DateCells({ issue, onSave, disabled, onDraftChange }: { issue: Issue; onSave: (source: Issue, start: string | null, end: string | null) => Promise<Issue | null>; disabled: boolean; onDraftChange: TrackDraft }) {
  const [source, setSource] = useState(issue);
  const [start, setStart] = useState(issue.startDate || '');
  const [end, setEnd] = useState(issue.endDate || '');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const dirty = start !== (source.startDate || '') || end !== (source.endDate || '');
  const conflict = issue.version !== source.version && dirty;
  if (issue.version !== source.version && !dirty && !pending) { setSource(issue); setStart(issue.startDate || ''); setEnd(issue.endDate || ''); }
  useEffect(() => { onDraftChange(`dates:${issue.id}`, dirty, pending); return () => onDraftChange(`dates:${issue.id}`, false); }, [onDraftChange, issue.id, dirty, pending]);
  function reset() { if (pendingRef.current) return; setSource(issue); setStart(issue.startDate || ''); setEnd(issue.endDate || ''); }
  async function commit(nextFocus: EventTarget | null) {
    if (pendingRef.current || !dirty || (nextFocus instanceof HTMLElement && nextFocus.dataset.scheduleOwner === issue.id)) return;
    pendingRef.current = true; setPending(true); onDraftChange(`dates:${issue.id}`, dirty, true);
    try { const saved = await onSave(source, start || null, end || null); if (saved) { setSource(saved); setStart(saved.startDate || ''); setEnd(saved.endDate || ''); } }
    finally { pendingRef.current = false; setPending(false); }
  }
  const title = conflict ? '다른 변경이 있습니다. 입력은 보존됩니다. Esc로 최신 날짜 불러오기' : 'Enter로 저장 · Esc로 최신 날짜 불러오기';
  return <>{(['start', 'end'] as const).map(edge => <input key={edge} className={`gantt-inline-date ${conflict ? 'has-conflict' : ''}`} title={title} aria-describedby="gantt-editing-help" type="date" data-schedule-owner={issue.id} aria-label={`${issue.key} ${edge === 'start' ? '시작일' : '종료일'}`} aria-invalid={conflict || undefined} value={edge === 'start' ? start : end} onChange={event => edge === 'start' ? setStart(event.target.value) : setEnd(event.target.value)} disabled={disabled || pending} onBlur={event => void commit(event.relatedTarget)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); reset(); } else if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />)}</>;
}

function DependencyModal({ issues, onClose, onSubmit, busy, onDraftChange }: { issues: Issue[]; onClose: () => void; onSubmit: (predecessor: string, successor: string, lag: number) => Promise<void>; busy: boolean; onDraftChange: TrackDraft }) {
  const [predecessor, setPredecessor] = useState(''); const [successor, setSuccessor] = useState(''); const [lag, setLag] = useState(0); const [error, setError] = useState('');
  const dirty = Boolean(predecessor || successor || lag);
  useEffect(() => { onDraftChange('dependency', dirty, busy); return () => onDraftChange('dependency', false); }, [onDraftChange, dirty, busy]);
  async function submit(e: FormEvent) { e.preventDefault(); setError(''); try { await onSubmit(predecessor, successor, lag); } catch (err) { setError(errorMessage(err)); } }
  return <div className="issue-modal-overlay"><section className="gantt-link-modal" role="dialog" aria-modal="true" aria-labelledby="dependency-title"><form onSubmit={submit}><header><div><span className="feature-eyebrow">CONNECT THE WORK</span><h2 id="dependency-title">선행·후행 업무 연결</h2></div><button className="issue-icon-button" onClick={onClose} type="button" disabled={busy} aria-label="업무 연결 닫기"><X size={20} /></button></header><div className="gantt-link-fields"><label className="issue-form-label">먼저 완료할 업무<select className="field" aria-label="먼저 완료할 업무" disabled={busy} value={predecessor} onChange={e => setPredecessor(e.target.value)} required><option value="">선행 업무 선택</option>{issues.filter(i => i.id !== successor).map(i => <option key={i.id} value={i.id}>{i.key} · {i.title}</option>)}</select></label><div className="gantt-link-arrow"><ArrowRight size={18} /><span>완료 후 시작 (FS)</span></div><label className="issue-form-label">이어서 시작할 업무<select className="field" aria-label="이어서 시작할 업무" disabled={busy} value={successor} onChange={e => setSuccessor(e.target.value)} required><option value="">후행 업무 선택</option>{issues.filter(i => i.id !== predecessor).map(i => <option key={i.id} value={i.id}>{i.key} · {i.title}</option>)}</select></label><label className="issue-form-label">추가 간격 (근무일)<input className="field" aria-label="추가 간격 근무일" disabled={busy} type="number" value={lag} onChange={e => setLag(Number(e.target.value))} min="0" max="3650" required step="1" /></label><p className="issue-section-empty">업무 연결은 순서를 나타냅니다. 계획 날짜는 자동으로 이동하지 않습니다.</p>{error && <div className="issue-form-error" role="alert">{error}</div>}</div><footer><button className="btn btn-ghost" type="button" disabled={busy} onClick={onClose}>취소</button><button className="btn btn-primary" type="submit" disabled={busy || !predecessor || !successor}><Link2 size={15} />{busy ? '연결 중…' : '업무 연결'}</button></footer></form></section></div>;
}
