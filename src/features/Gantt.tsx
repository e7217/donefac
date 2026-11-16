'use client';

import { useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from 'react';
import { AlertCircle, ArrowRight, CalendarDays, Check, Link2, MoveHorizontal, Plus, Search, Undo2, X } from 'lucide-react';
import { ISSUE_TYPES, STATUS, type FeatureProps, type Issue, type SchedulePreview, type User, type Project } from '../../shared/types';
import { post, remove } from '../lib/api';
import { IssueTypeIcon } from './Issues';
import { dayNumber, errorMessage, isoDay, moveDate, scheduleRange, todayDate } from './schedule-utils';
import './issues.css';

type ApplyResult = { undoId: string; updated: Issue[]; warnings?: string[] };
type DragMode = 'move' | 'start' | 'end';
type DragState = { issue: Issue; initialX: number; delta: number; mode: DragMode };
const LEFT_WIDTH = 538;
const ROW_HEIGHT = 56;
const HEADER_HEIGHT = 62;

export function Gantt(props: FeatureProps) {
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const projectIssues = useMemo(() => data.issues.filter(i => (!projectId || projectId === 'all' || i.projectId === projectId)), [data.issues, projectId]);
  const issues = projectIssues.filter(i => (!hideDone || (i.status !== 'done' && i.status !== 'cancelled')) && (!query || `${i.key} ${i.title}`.toLowerCase().includes(query.toLowerCase())));
  const range = useMemo(() => scheduleRange(projectIssues), [projectIssues]);
  const dayWidth = zoom === 'day' ? 32 : zoom === 'week' ? 15 : 6;
  const timelineWidth = range.days * dayWidth;
  const selectedIssues = issues.filter(i => selected.has(i.id));
  const dependencies = data.dependencies.filter(d => issues.some(i => i.id === d.predecessorId) && issues.some(i => i.id === d.successorId));
  const unscheduled = issues.filter(i => !i.startDate || !i.endDate);
  const ticks = useMemo(() => Array.from({ length: range.days }, (_, index) => { const day = range.start + index; const date = new Date(day * 86_400_000); return { day, date, iso: isoDay(day), index, weekday: date.getUTCDay() }; }), [range.start, range.days]);
  const rowIndex = new Map(issues.map((i, index) => [i.id, index]));
  const todayPosition = (dayNumber(todayDate()) - range.start) * dayWidth;

  function toggleSelected(id: string) { setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  async function requestPreview(ids: string[], offset: number, skipWeekends: boolean) {
    if (!ids.length) { notify('이동할 업무를 먼저 선택하세요.', 'error'); return; }
    if (!Number.isInteger(offset) || offset === 0) { notify('0이 아닌 정수 일수를 입력하세요.', 'error'); return; }
    setBusy(true);
    try { const result = await post<SchedulePreview>('/schedule/preview', { issueIds: ids, days: offset, workingDays: skipWeekends }); setPreview(result); setPreviewError(''); setShiftOpen(false); }
    catch (err) { notify(errorMessage(err), 'error'); } finally { setBusy(false); }
  }
  async function applyChanges(value: SchedulePreview) {
    if (!value.changes.length || busy) return; setBusy(true); setPreviewError('');
    try {
      const result = await post<ApplyResult>('/schedule/apply', { changes: value.changes.map(change => ({ id: change.id, expectedVersion: change.version, startDate: change.toStart, endDate: change.toEnd })) });
      setUndoId(result.undoId); setPreview(null); setScheduleWarnings(result.warnings || []); await refresh(); notify(`${value.changes.length}개 업무의 일정을 변경했습니다.${result.warnings?.length ? ' 의존성 경고를 확인하세요.' : ''}`);
    } catch (err) { if (preview) setPreviewError(errorMessage(err)); notify(errorMessage(err), 'error'); } finally { setBusy(false); }
  }
  async function saveDates(issue: Issue, startDate: string | null, endDate: string | null) {
    if (startDate === issue.startDate && endDate === issue.endDate) return;
    if (startDate && endDate && startDate > endDate) { notify('종료일은 시작일보다 빠를 수 없습니다.', 'error'); return; }
    if (busy) { notify('진행 중인 일정 변경이 끝난 뒤 다시 시도하세요.', 'error'); return; }
    await applyChanges({ changes: [{ id: issue.id, key: issue.key, title: issue.title, version: issue.version, fromStart: issue.startDate, fromEnd: issue.endDate, toStart: startDate, toEnd: endDate }], warnings: [] });
  }
  async function undo() {
    if (!undoId) return; setBusy(true);
    try { await post('/schedule/undo', { undoId }); setUndoId(null); setScheduleWarnings([]); await refresh(); notify('마지막 일정 변경을 되돌렸습니다.'); }
    catch (err) { notify(errorMessage(err), 'error'); } finally { setBusy(false); }
  }
  async function unlink(id: string) { setBusy(true); try { await remove(`/dependencies/${id}`); await refresh(); notify('선행·후행 연결을 해제했습니다.'); } catch (err) { notify(errorMessage(err), 'error'); } finally { setBusy(false); } }
  function goToToday() { if (scrollRef.current) scrollRef.current.scrollTo({ left: Math.max(0, todayPosition - 100), behavior: 'smooth' }); }
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
      if (predecessor?.endDate && successor?.startDate && successor.startDate < moveDate(predecessor.endDate, dependency.lagDays + 1)) warnings.push(`${predecessor.key} → ${successor.key}: 완료 후 시작 조건과 일정이 맞지 않습니다. 연결된 업무는 자동 이동하지 않습니다.`);
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
    <div className="feature-heading"><div><div className="feature-eyebrow">PLAN WITH CLARITY</div><h1>일정 · 간트</h1><p>업무와 일정이 하나로. 직접 입력하고, 연결하고, 함께 조정하세요.</p></div><div className="gantt-heading-actions"><button className="btn" onClick={() => setLinkOpen(true)}><Link2 size={16} /> 업무 연결</button><button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Plus size={16} /> 업무 추가</button></div></div>
    <div className="gantt-stats"><div><span className="gantt-stat-dot" /><strong>{projectIssues.filter(i => i.startDate && i.endDate).length}</strong><span>일정이 잡힌 업무</span></div><div><span className="gantt-stat-dot is-empty" /><strong>{projectIssues.filter(i => !i.startDate || !i.endDate).length}</strong><span>일정 미정</span></div><div><Link2 size={13} /><strong>{data.dependencies.filter(d => projectIssues.some(i => i.id === d.predecessorId) && projectIssues.some(i => i.id === d.successorId)).length}</strong><span>업무 연결</span></div><span className="gantt-manual-badge">수기 계획</span></div>
    <div className="issue-toolbar gantt-toolbar"><div className="issue-search"><Search size={15} /><input placeholder="업무 검색" aria-label="간트 업무 검색" value={query} onChange={e => setQuery(e.target.value)} /></div><label className="gantt-checkbox-label"><input type="checkbox" checked={hideDone} onChange={e => setHideDone(e.target.checked)} />완료 업무 숨기기</label><div className="gantt-toolbar-spacer" /><button className="btn" onClick={goToToday}><CalendarDays size={14} /> 오늘</button><div className="issue-view-switch gantt-zoom">{([['day', '일'], ['week', '주'], ['month', '월']] as const).map(([key, label]) => <button key={key} className={zoom === key ? 'active' : ''} onClick={() => setZoom(key)}>{label}</button>)}</div><button className="btn" onClick={() => setShiftOpen(!shiftOpen)} disabled={!selectedIssues.length || busy}><MoveHorizontal size={15} />{selectedIssues.length ? `${selectedIssues.length}개 ` : ''}일정 이동</button><button className="btn btn-ghost" onClick={undo} disabled={!undoId || busy} title="마지막 일정 변경 되돌리기"><Undo2 size={16} /><span className="gantt-undo-label">되돌리기</span></button></div>
    {shiftOpen && <form className="gantt-shift-form" onSubmit={e => { e.preventDefault(); void requestPreview(selectedIssues.map(i => i.id), days, workingDays); }}><span><strong>{selectedIssues.length}개</strong> 업무를</span><input className="field" aria-label="이동 일수" type="number" step="1" min="-3650" max="3650" value={days} onChange={e => setDays(Number(e.target.value))} required /><span>일 이동</span><label className="gantt-checkbox-label"><input type="checkbox" checked={workingDays} onChange={e => setWorkingDays(e.target.checked)} />주말 제외</label><small>음수는 앞당기기 · 공휴일은 포함됩니다</small><button className="btn btn-primary" type="submit" disabled={busy}>변경 미리보기</button><button className="issue-icon-button" type="button" onClick={() => setShiftOpen(false)} aria-label="일정 이동 닫기"><X size={16} /></button></form>}
    {createOpen && <InlineIssueForm key={projectId} projectId={projectId} projects={data.projects} users={data.users} onClose={() => setCreateOpen(false)} onCreated={async issue => { await refresh(); setCreateOpen(false); setQuery(''); setHideDone(false); notify(`${issue.key} 업무를 간트에 추가했습니다.`); }} />}
    <div className="gantt-hint" id="gantt-editing-help"><span><span className="gantt-mini-bar" />막대 가운데는 이동, 양 끝은 기간 조정 · 변경 후 미리보기</span><span>날짜 입력 후 Enter로 저장 · 조정 핸들은 ← → 키도 지원해요.</span></div>
    <div className="gantt-scroll" ref={scrollRef}><div className="gantt-canvas" style={{ width: LEFT_WIDTH + timelineWidth, '--gantt-day-width': `${dayWidth}px` } as CSSProperties}>
      <div className="gantt-chart-header"><div className="gantt-left gantt-left-header"><label><input type="checkbox" aria-label="표시된 업무 전체 선택" checked={issues.length > 0 && issues.every(i => selected.has(i.id))} onChange={e => setSelected(e.target.checked ? new Set(issues.map(i => i.id)) : new Set())} /></label><span>업무 <small>{issues.length}</small></span><span>시작일</span><span>종료일</span></div><div className="gantt-date-header" style={{ width: timelineWidth }}><div className="gantt-months">{months.map((tick, index) => <span key={tick.iso} style={{ left: tick.index * dayWidth, width: ((months[index + 1]?.index ?? range.days) - tick.index) * dayWidth }}>{tick.date.getUTCFullYear()}년 {tick.date.getUTCMonth() + 1}월</span>)}</div><div className="gantt-days">{ticks.map(tick => <span key={tick.iso} className={`${tick.weekday === 0 || tick.weekday === 6 ? 'weekend' : ''} ${tick.iso === todayDate() ? 'today' : ''}`} style={{ width: dayWidth }}>{zoom === 'day' ? <>{tick.date.getUTCDate()}<small>{['일', '월', '화', '수', '목', '금', '토'][tick.weekday]}</small></> : zoom === 'week' && (tick.weekday === 1 || tick.index === 0) ? tick.date.getUTCDate() : zoom === 'month' && tick.date.getUTCDate() === 15 ? '15' : ''}</span>)}</div></div></div>
      {ticks.filter(t => t.weekday === 6 || t.weekday === 0).map(tick => <div key={tick.iso} className="gantt-weekend-band" style={{ left: LEFT_WIDTH + tick.index * dayWidth, width: dayWidth, top: HEADER_HEIGHT, height: issues.length * ROW_HEIGHT }} />)}
      <div className="gantt-today-line" style={{ left: LEFT_WIDTH + todayPosition + dayWidth / 2, top: HEADER_HEIGHT, height: issues.length * ROW_HEIGHT }} />
      <svg className="gantt-dependency-lines" width={timelineWidth} height={issues.length * ROW_HEIGHT} style={{ left: LEFT_WIDTH, top: HEADER_HEIGHT }} aria-hidden="true"><defs><marker id="gantt-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7" fill="#8a9b9b" /></marker></defs>{dependencies.map(dependency => { const predecessor = issues.find(i => i.id === dependency.predecessorId); const successor = issues.find(i => i.id === dependency.successorId); if (!predecessor?.endDate || !successor?.startDate) return null; const x1 = (dayNumber(predecessor.endDate) - range.start + 1) * dayWidth; const x2 = (dayNumber(successor.startDate) - range.start) * dayWidth; const y1 = (rowIndex.get(predecessor.id)! + .5) * ROW_HEIGHT; const y2 = (rowIndex.get(successor.id)! + .5) * ROW_HEIGHT; const turn = Math.max(x1 + 12, x2 - 15); return <path key={dependency.id} d={`M${x1},${y1} H${turn} V${y2} H${x2 - 3}`} fill="none" stroke="#8a9b9b" strokeWidth="1.3" strokeDasharray="3 3" markerEnd="url(#gantt-arrow)" />; })}</svg>
      {issues.map(issue => {
        const user = data.users.find(u => u.id === issue.assigneeId); const start = issue.startDate ? dayNumber(issue.startDate) : null; const end = issue.endDate ? dayNumber(issue.endDate) : null; const dragging = drag?.issue.id === issue.id; const offset = dragging ? drag.delta : 0; const startOffset = dragging && drag.mode !== 'end' ? offset : 0; const endOffset = dragging && drag.mode !== 'start' ? offset : 0; const hasSchedule = start !== null && end !== null; const color = STATUS[issue.status].color;
        return <div data-issue-id={issue.id} className={`gantt-row ${selected.has(issue.id) ? 'is-selected' : ''}`} key={issue.id}><div className="gantt-left"><label><input type="checkbox" aria-label={`${issue.key} 선택`} checked={selected.has(issue.id)} onChange={() => toggleSelected(issue.id)} /></label><button className="gantt-issue-name" onClick={() => openIssue(issue.id)}><IssueTypeIcon type={issue.type} /><span><small>{issue.key}</small><strong title={issue.title}>{issue.title}</strong></span>{user && <span className="issue-avatar" style={{ background: user.color }} title={user.name}>{user.name.slice(0, 1)}</span>}</button><DateCells key={`${issue.id}:${issue.version}`} issue={issue} disabled={busy} onSave={(startDate, endDate) => saveDates(issue, startDate, endDate)} /></div><div className="gantt-row-timeline" style={{ width: timelineWidth }}>
          {hasSchedule ? <div className={`gantt-task-range ${dragging ? 'is-dragging' : ''}`} style={{ left: (start! - range.start + startOffset) * dayWidth + 2, width: Math.max(dayWidth - 4, (end! - start! + 1 + endOffset - startOffset) * dayWidth - 4), '--bar-color': color } as CSSProperties}>
            <button className={`gantt-bar ${dragging ? 'is-dragging' : ''} ${issue.status === 'done' ? 'is-done' : ''}`} disabled={busy} aria-label={`${issue.key} 일정 이동`} aria-describedby="gantt-editing-help" title={`${issue.key}: ${issue.startDate} ~ ${issue.endDate} · 끌어서 이동, 선택해서 상세 보기`} onPointerDown={event => beginDrag(event, issue, 'move')} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={() => setDrag(null)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openIssue(issue.id); } }}><span>{zoom !== 'month' && issue.title}</span></button>
            {(['start', 'end'] as const).map(edge => <button key={edge} type="button" className={`gantt-resize-handle is-${edge}`} aria-label={`${issue.key} ${edge === 'start' ? '시작일' : '종료일'} 조정`} aria-describedby="gantt-editing-help" title={`${edge === 'start' ? '시작일' : '종료일'} 조정 · 드래그 또는 좌우 방향키 · Enter로 날짜 입력`} disabled={busy} onPointerDown={event => beginDrag(event, issue, edge)} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={() => setDrag(null)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); previewResize(issue, edge, event.key === 'ArrowRight' ? 1 : -1); } }} onClick={event => { if (event.detail === 0) focusDate(issue, edge); }}><span /></button>)}
            {dragging && offset !== 0 && <small className="gantt-drag-label">{drag.mode === 'move' ? `${offset > 0 ? '+' : ''}${offset}일` : `${moveDate(issue.startDate!, startOffset)} ~ ${moveDate(issue.endDate!, endOffset)}`}</small>}
          </div> : <button className="gantt-no-schedule" onClick={() => openIssue(issue.id)}><Plus size={12} /> 날짜를 입력해 일정을 잡으세요</button>}
        </div></div>;
      })}
      <button className="gantt-add-inline-row" style={{ width: LEFT_WIDTH }} onClick={() => setCreateOpen(true)}><Plus size={14} /> 이 간트에 업무 추가</button>
      {issues.length === 0 && <div className="gantt-no-issues" style={{ width: LEFT_WIDTH }}><CalendarDays size={28} /><strong>표시할 업무가 없습니다</strong><span>업무를 만들거나 검색 조건을 변경하세요.</span></div>}
    </div></div>
    {scheduleWarnings.length > 0 && <div className="gantt-current-warnings" role="status"><AlertCircle size={16} /><div><strong>일정 의존성 확인</strong>{scheduleWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div><button className="issue-icon-button" onClick={() => setScheduleWarnings([])} aria-label="경고 닫기"><X size={14} /></button></div>}
    <div className="gantt-legend"><span><span className="gantt-mini-bar" />계획 일정</span><span><span className="gantt-legend-line" />선행 → 후행</span><span><span className="gantt-legend-today" />오늘</span><span className="muted">수기 계획에서는 의존성을 연결해도 날짜가 자동으로 바뀌지 않습니다.</span></div>
    <div className="gantt-bottom-grid"><section className="gantt-bottom-card"><div className="gantt-bottom-heading"><h3><CalendarDays size={16} />일정 미정 <span>{unscheduled.length}</span></h3><span className="muted">시작일과 종료일을 정해주세요</span></div>{unscheduled.length ? unscheduled.map(issue => <div key={issue.id} className="gantt-unscheduled-row"><button onClick={() => openIssue(issue.id)}><IssueTypeIcon type={issue.type} /><span className="issue-key">{issue.key}</span><strong>{issue.title}</strong></button><button className="btn btn-ghost" disabled={busy} onClick={() => saveDates(issue, issue.startDate || (issue.endDate ? moveDate(issue.endDate, -2) : todayDate()), issue.endDate || (issue.startDate ? moveDate(issue.startDate, 2) : moveDate(todayDate(), 2)))}><Plus size={13} />{issue.startDate || issue.endDate ? '일정 완성' : '오늘부터 3일'}</button></div>) : <div className="gantt-bottom-empty"><Check size={17} />모든 업무에 일정이 잡혀 있습니다.</div>}</section><section className="gantt-bottom-card"><div className="gantt-bottom-heading"><h3><Link2 size={16} />업무 연결 <span>{dependencies.length}</span></h3><button className="btn btn-ghost" onClick={() => setLinkOpen(true)}><Plus size={13} /> 연결 추가</button></div>{dependencies.length ? dependencies.map(dependency => { const predecessor = data.issues.find(i => i.id === dependency.predecessorId)!; const successor = data.issues.find(i => i.id === dependency.successorId)!; return <div key={dependency.id} className="gantt-dependency-row"><button title={predecessor.title} onClick={() => openIssue(predecessor.id)}>{predecessor.key}</button><ArrowRight size={13} /><button title={successor.title} onClick={() => openIssue(successor.id)}>{successor.key}</button><span>완료 후 시작{dependency.lagDays ? ` · +${dependency.lagDays}일` : ''}</span><button className="issue-icon-button" onClick={() => unlink(dependency.id)} disabled={busy} aria-label={`${predecessor.key}와 ${successor.key} 연결 해제`}><X size={14} /></button></div>; }) : <div className="gantt-bottom-empty">선행 업무를 연결해 일정의 흐름을 확인하세요.</div>}</section></div>
    {preview && <div className="issue-modal-overlay"><section className="gantt-preview-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-preview-title"><header><div><span className="feature-eyebrow">REVIEW CHANGES</span><h2 id="schedule-preview-title">일정 변경 미리보기</h2><p>{preview.changes.length}개 업무의 변경 내용을 확인하세요.</p></div><button className="issue-icon-button" onClick={() => setPreview(null)} disabled={busy} aria-label="미리보기 닫기"><X size={20} /></button></header>{preview.warnings.length > 0 && <div className="gantt-preview-warnings"><AlertCircle size={17} /><div><strong>적용 전에 확인하세요</strong>{preview.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}{previewError && <div className="issue-form-error gantt-preview-error" role="alert">{previewError}<br />미리보기와 입력 내용은 유지됩니다. 취소 후 최신 일정을 확인하고 다시 조정하세요.</div>}<div className="gantt-preview-table"><table><thead><tr><th>업무</th><th>현재 일정</th><th /><th>변경할 일정</th></tr></thead><tbody>{preview.changes.map(change => <tr key={change.id}><td><span className="issue-key">{change.key}</span><strong>{change.title}</strong></td><td>{change.fromStart || '미정'}<br />{change.fromEnd || '미정'}</td><td><ArrowRight size={16} /></td><td className="gantt-new-dates">{change.toStart || '미정'}<br />{change.toEnd || '미정'}</td></tr>)}</tbody></table>{preview.changes.length === 0 && <div className="issue-empty">이동할 일정이 없습니다. 날짜를 먼저 입력하세요.</div>}</div><footer><span className="muted">적용 후 마지막 변경을 되돌릴 수 있습니다.</span><button className="btn btn-ghost" onClick={() => setPreview(null)} disabled={busy}>취소</button><button className="btn btn-primary" disabled={busy || !preview.changes.length} onClick={() => applyChanges(preview)}><Check size={16} />{busy ? '적용 중…' : '변경 적용'}</button></footer></section></div>}
    {linkOpen && <DependencyModal issues={projectIssues} busy={busy} onClose={() => setLinkOpen(false)} onSubmit={async (predecessorId, successorId, lagDays) => { setBusy(true); try { await post('/dependencies', { predecessorId, successorId, lagDays }); await refresh(); setLinkOpen(false); notify('선행·후행 업무를 연결했습니다.'); } catch (err) { throw err; } finally { setBusy(false); } }} />}
  </div>;
}

function InlineIssueForm({ projectId, projects, users, onClose, onCreated }: { projectId: string; projects: Project[]; users: User[]; onClose: () => void; onCreated: (issue: Issue) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState('작업');
  const [assigneeId, setAssigneeId] = useState('');
  const [selectedProject, setSelectedProject] = useState(projects.some(project => project.id === projectId) ? projectId : projects[0]?.id || '');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (startDate && endDate && startDate > endDate) { setError('종료일은 시작일보다 빠를 수 없습니다. 입력한 날짜를 확인하세요.'); return; }
    if (!title.trim()) { setError('업무 제목을 입력하세요.'); return; }
    setSaving(true);
    try { const issue = await post<Issue>('/issues', { projectId: selectedProject, title: title.trim(), type, status: 'todo', assigneeId: assigneeId || null, startDate: startDate || null, endDate: endDate || null }); await onCreated(issue); }
    catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  }
  return <form className="gantt-inline-create" aria-label="간트에서 업무 만들기" onSubmit={submit}>
    <div className="gantt-inline-create-heading"><div><strong><Plus size={15} /> 간트에 업무 추가</strong><span>날짜는 나중에 정해도 괜찮아요. 저장하면 같은 간트에 표시됩니다.</span></div><button className="issue-icon-button" type="button" onClick={onClose} disabled={saving} aria-label="간트 업무 추가 닫기"><X size={17} /></button></div>
    <div className="gantt-create-fields"><label className="issue-form-label gantt-create-title">업무 제목<input autoFocus aria-label="추가할 업무 제목" className="field" placeholder="해야 할 일을 입력하세요" value={title} onChange={event => setTitle(event.target.value)} required maxLength={300} disabled={saving} /></label><label className="issue-form-label">유형<select aria-label="추가할 업무 유형" className="field" value={type} onChange={event => setType(event.target.value)} disabled={saving}>{ISSUE_TYPES.map(value => <option key={value}>{value}</option>)}</select></label><label className="issue-form-label">담당자<select aria-label="추가할 업무 담당자" className="field" value={assigneeId} onChange={event => setAssigneeId(event.target.value)} disabled={saving}><option value="">미지정</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label><label className="issue-form-label">시작일<input aria-label="추가할 업무 시작일" className="field" type="date" value={startDate} onChange={event => setStartDate(event.target.value)} disabled={saving} /></label><label className="issue-form-label">종료일<input aria-label="추가할 업무 종료일" className="field" type="date" value={endDate} onChange={event => setEndDate(event.target.value)} disabled={saving} /></label>{(!projectId || projectId === 'all') && <label className="issue-form-label">프로젝트<select aria-label="추가할 업무 프로젝트" className="field" value={selectedProject} onChange={event => setSelectedProject(event.target.value)} disabled={saving} required>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}</div>
    {error && <div className="issue-form-error" role="alert">{error}</div>}
    <div className="gantt-inline-create-footer"><small>시작일·종료일은 선택 사항입니다.</small><button className="btn btn-ghost" type="button" onClick={onClose} disabled={saving}>취소</button><button className="btn btn-primary" type="submit" disabled={saving || !selectedProject}><Plus size={14} />{saving ? '추가 중…' : '간트에 추가'}</button></div>
  </form>;
}

function DateCells({ issue, onSave, disabled }: { issue: Issue; onSave: (start: string | null, end: string | null) => Promise<void>; disabled: boolean }) {
  const [start, setStart] = useState(issue.startDate || ''); const [end, setEnd] = useState(issue.endDate || '');
  function commit(nextFocus: EventTarget | null) { if (nextFocus instanceof HTMLElement && nextFocus.dataset.scheduleOwner === issue.id) return; if (start !== (issue.startDate || '') || end !== (issue.endDate || '')) void onSave(start || null, end || null); }
  return <><input className="gantt-inline-date" title="날짜 입력 후 Enter 또는 다른 영역을 선택해 저장" aria-describedby="gantt-editing-help" type="date" data-schedule-owner={issue.id} aria-label={`${issue.key} 시작일`} value={start} onChange={e => setStart(e.target.value)} disabled={disabled} onBlur={e => commit(e.relatedTarget)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /><input className="gantt-inline-date" title="날짜 입력 후 Enter 또는 다른 영역을 선택해 저장" aria-describedby="gantt-editing-help" type="date" data-schedule-owner={issue.id} aria-label={`${issue.key} 종료일`} value={end} onChange={e => setEnd(e.target.value)} disabled={disabled} onBlur={e => commit(e.relatedTarget)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></>;
}

function DependencyModal({ issues, onClose, onSubmit, busy }: { issues: Issue[]; onClose: () => void; onSubmit: (predecessor: string, successor: string, lag: number) => Promise<void>; busy: boolean }) {
  const [predecessor, setPredecessor] = useState(''); const [successor, setSuccessor] = useState(''); const [lag, setLag] = useState(0); const [error, setError] = useState('');
  async function submit(e: FormEvent) { e.preventDefault(); setError(''); try { await onSubmit(predecessor, successor, lag); } catch (err) { setError(errorMessage(err)); } }
  return <div className="issue-modal-overlay"><section className="gantt-link-modal" role="dialog" aria-modal="true" aria-labelledby="dependency-title"><form onSubmit={submit}><header><div><span className="feature-eyebrow">CONNECT THE WORK</span><h2 id="dependency-title">선행·후행 업무 연결</h2></div><button className="issue-icon-button" onClick={onClose} type="button" disabled={busy} aria-label="업무 연결 닫기"><X size={20} /></button></header><div className="gantt-link-fields"><label className="issue-form-label">먼저 완료할 업무<select className="field" value={predecessor} onChange={e => setPredecessor(e.target.value)} required><option value="">선행 업무 선택</option>{issues.filter(i => i.id !== successor).map(i => <option key={i.id} value={i.id}>{i.key} · {i.title}</option>)}</select></label><div className="gantt-link-arrow"><ArrowRight size={18} /><span>완료 후 시작 (FS)</span></div><label className="issue-form-label">이어서 시작할 업무<select className="field" value={successor} onChange={e => setSuccessor(e.target.value)} required><option value="">후행 업무 선택</option>{issues.filter(i => i.id !== predecessor).map(i => <option key={i.id} value={i.id}>{i.key} · {i.title}</option>)}</select></label><label className="issue-form-label">추가 간격 (일)<input className="field" type="number" value={lag} onChange={e => setLag(Number(e.target.value))} min="0" max="3650" required step="1" /></label><p className="issue-section-empty">업무 연결은 순서를 나타냅니다. 계획 날짜는 자동으로 이동하지 않습니다.</p>{error && <div className="issue-form-error" role="alert">{error}</div>}</div><footer><button className="btn btn-ghost" type="button" disabled={busy} onClick={onClose}>취소</button><button className="btn btn-primary" type="submit" disabled={busy || !predecessor || !successor}><Link2 size={15} />{busy ? '연결 중…' : '업무 연결'}</button></footer></form></section></div>;
}
