'use client';

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, CalendarClock, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { FeatureProps, Issue, IssueTimeReservation, IssueTimeReservationEntry, User } from '../../shared/types';
import { isCalendarDate } from '../../shared/calendar';
import { DEFAULT_RESERVATION_TIME_ZONE, reservationDayRange, reservationInstant, reservationLocalDateTime } from '../../shared/time-reservations';
import { api, ApiError } from '../lib/api';
import { newRequestId } from '../lib/request-id';
import { errorMessage, moveDate } from './schedule-utils';
import './time-reservations.css';

type Ticket = Pick<Issue, 'id' | 'key' | 'title' | 'projectId' | 'assigneeId' | 'startDate'>;
type TrackDraft = (dirty: boolean, pending: boolean, discard: () => void) => void;
type Scope = { issue: Ticket; projectId?: never; issues?: never; initialIssue?: never; openIssue?: never }
  | { issue?: never; projectId: string; issues: Ticket[]; initialIssue?: Ticket; openIssue: FeatureProps['openIssue'] };
type Props = Scope & Pick<FeatureProps, 'actorId' | 'notify'> & {
  users: User[];
  restoreGeneration: FeatureProps['data']['restoreGeneration'];
  onDraftChange: TrackDraft;
  onChanged?: FeatureProps['refresh'];
  refreshVersion?: number;
};
type ReservationDraft = { issueId: string; userId: string; start: string; end: string };
type ReservationEditor = { draft: ReservationDraft; initial: ReservationDraft; original: IssueTimeReservationEntry | null; generation: Props['restoreGeneration'] };
type ReservationDeletion = { entry: IssueTimeReservationEntry; generation: Props['restoreGeneration'] };
type ReservationList = { key: string; entries: IssueTimeReservationEntry[]; error?: string };
type MutationAttempt = { fingerprint: string; requestId: string };
const MIN_DATE = '0001-01-01', MAX_DATE = '9999-12-30';
const CHANGE_EVENT = 'donefac:time-reservations-changed';

function issueReservationsPath(issueId: string) {
  return `/issues/${encodeURIComponent(issueId)}/time-reservations`;
}

function todayInTeamTimeZone() {
  return reservationLocalDateTime(`${new Date().toISOString().slice(0, 16)}:00.000Z`).slice(0, 10);
}

function formatRange(entry: Pick<IssueTimeReservation, 'startAt' | 'endAt'>) {
  const start = reservationLocalDateTime(entry.startAt).replace('T', ' ');
  const end = reservationLocalDateTime(entry.endAt).replace('T', ' ');
  return `${start} ~ ${start.slice(0, 10) === end.slice(0, 10) ? end.slice(11) : end}`;
}

function validListDate(date: string | null | undefined): date is string {
  return Boolean(date && date >= MIN_DATE && date <= MAX_DATE && isCalendarDate(date) && reservationDayRange(date));
}

function hasDraftChanges(draft: ReservationDraft, baseline: ReservationDraft) {
  return draft.issueId !== baseline.issueId || draft.userId !== baseline.userId || draft.start !== baseline.start || draft.end !== baseline.end;
}

function fromReservation(entry: IssueTimeReservation): ReservationDraft {
  return { issueId: entry.issueId, userId: entry.userId, start: reservationLocalDateTime(entry.startAt), end: reservationLocalDateTime(entry.endAt) };
}

function reservationError(cause: unknown) {
  const message = errorMessage(cause);
  if (!(cause instanceof ApiError) || cause.status !== 409) return message;
  const conflict = (cause.details as { conflict?: Partial<IssueTimeReservation> } | null)?.conflict;
  if (typeof conflict?.startAt !== 'string' || typeof conflict.endAt !== 'string') return message;
  return `${message} ${formatRange({ startAt: conflict.startAt, endAt: conflict.endAt })}`;
}

function resultUnknown(cause: unknown) {
  return !(cause instanceof ApiError) || cause.status >= 500;
}

export function TimeReservations(props: Props) {
  const { issue, initialIssue, issues = [], actorId, users, notify, onDraftChange, onChanged, refreshVersion, restoreGeneration } = props;
  const [date, setDate] = useState(() => validListDate(initialIssue?.startDate) ? initialIssue.startDate : todayInTeamTimeZone());
  const [userFilter, setUserFilter] = useState('');
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<ReservationList | null>(null);
  const [editor, setEditor] = useState<ReservationEditor | null>(null);
  const [deleting, setDeleting] = useState<ReservationDeletion | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<IssueTimeReservation | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const request = useRef<MutationAttempt | null>(null);
  const acceptedRefresh = useRef(refreshVersion);
  const pendingRef = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  const range = useMemo(() => reservationDayRange(date), [date]);
  const teamQuery = range ? new URLSearchParams({ ...range, ...(userFilter ? { userId: userFilter } : {}) }) : null;
  const listPath = issue ? issueReservationsPath(issue.id) : teamQuery ? `/time-reservations?${teamQuery}` : null;
  const key = `${listPath}:${revision}`;
  const list = loaded?.key === key ? loaded : null;
  const dirty = Boolean(uncertain || editor && hasDraftChanges(editor.draft, editor.initial));

  useEffect(() => () => onDraftChange(false, false, () => {}), [onDraftChange]);
  useEffect(() => {
    if (!listPath) return;
    const controller = new AbortController();
    const options = { signal: controller.signal, headers: { 'X-Actor-Id': actorId } };
    void api<IssueTimeReservationEntry[]>(listPath, options).then(entries => {
        if (!controller.signal.aborted) setLoaded({ key, entries });
      }, cause => {
        if (!controller.signal.aborted) setLoaded({ key, entries: [], error: errorMessage(cause) });
      });
    return () => controller.abort();
  }, [listPath, key, actorId]);
  useEffect(() => {
    const reload = () => setRevision(value => value + 1);
    const events = [CHANGE_EVENT, 'donefac:trash-changed', 'donefac:workspace-imported', 'focus'];
    for (const event of events) window.addEventListener(event, reload);
    return () => { for (const event of events) window.removeEventListener(event, reload); };
  }, []);

  useEffect(() => {
    if (refreshVersion === undefined || refreshVersion === acceptedRefresh.current || editor || deleting || pending) return;
    const timer = setTimeout(() => {
      acceptedRefresh.current = refreshVersion;
      setRevision(value => value + 1);
    }, 0);
    return () => clearTimeout(timer);
  }, [refreshVersion, editor, deleting, pending]);

  function discard() {
    if (pendingRef.current) return;
    setEditor(null);
    setDeleting(null);
    setError('');
    setConflict(false);
    setLatest(null);
    setUncertain(false);
    request.current = null;
    onDraftChange(false, false, discard);
  }

  function mayReplaceEditor() {
    if (pendingRef.current) return false;
    if (!dirty) return true;
    return window.confirm(uncertain
      ? '시간 배정 변경이 완료됐을 수 있습니다. 결과 확인을 중단할까요?'
      : '저장하지 않은 시간 배정 입력을 버릴까요?');
  }

  function changeFilter(action: () => void) {
    if (!mayReplaceEditor()) return;
    discard();
    action();
  }

  function openEditor(original: IssueTimeReservationEntry | null) {
    if (!mayReplaceEditor()) return;
    discard();
    const selected = issue || initialIssue;
    const bookingDate = validListDate(issue?.startDate) ? issue.startDate : date;
    const userId = userFilter || selected?.assigneeId || (users.some(user => user.id === actorId) ? actorId : '');
    const draft = original ? fromReservation(original)
      : { issueId: selected?.id ?? '', userId, start: `${bookingDate}T09:00`, end: `${bookingDate}T10:00` };
    setEditor({ draft, initial: draft, original, generation: restoreGeneration });
    requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('select, input')?.focus());
  }

  function editField<K extends keyof ReservationDraft>(field: K, value: ReservationDraft[K]) {
    if (!editor || pendingRef.current || uncertain) return;
    const draft = { ...editor.draft, [field]: value };
    setEditor({ ...editor, draft });
    setError('');
    onDraftChange(hasDraftChanges(draft, editor.initial), false, discard);
  }

  function cancelEditor() {
    if (!mayReplaceEditor()) return;
    discard();
    requestAnimationFrame(() => addButton.current?.focus());
  }

  function startMutation() {
    pendingRef.current = true;
    setPending(true);
    setError('');
    onDraftChange(dirty, true, discard);
  }

  function endMutation(remainsDirty: boolean) {
    pendingRef.current = false;
    setPending(false);
    onDraftChange(remainsDirty, false, discard);
  }

  function reportChanged(message: string) {
    window.dispatchEvent(new Event(CHANGE_EVENT));
    notify(message);
    void onChanged?.().catch(() => undefined);
    requestAnimationFrame(() => addButton.current?.focus());
  }

  function requestIdFor(fingerprint: string) {
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, requestId: newRequestId() };
    return request.current.requestId;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || pendingRef.current || conflict) return;
    const { draft, original } = editor;
    const target = issue ?? issues.find(candidate => candidate.id === draft.issueId);
    const startAt = reservationInstant(draft.start), endAt = reservationInstant(draft.end);
    if (!target || !users.some(user => user.id === draft.userId)) {
      setError('예약 업무와 배정 팀원을 선택하세요.');
      return;
    }
    if (!startAt || !endAt || startAt >= endAt || Date.parse(endAt) - Date.parse(startAt) > 86_400_000) {
      setError('시작 시각과 종료 시각을 확인하세요. 한 번에 최대 24시간을 배정할 수 있습니다.');
      return;
    }
    const payload = { userId: draft.userId, startAt, endAt };
    const path = issueReservationsPath(target.id);
    const edit = original ? { expectedVersion: original.version, expectedRestoreGeneration: editor.generation } : {};
    const requestId = requestIdFor(JSON.stringify([target.id, original?.id, payload, edit]));
    startMutation();
    let remainsDirty = dirty, changed = false;
    try {
      const saved = await api<IssueTimeReservation>(original ? `${path}/${encodeURIComponent(original.id)}` : path, {
        method: original ? 'PATCH' : 'POST', headers: { 'X-Actor-Id': actorId }, signal: AbortSignal.timeout(12_000),
        body: JSON.stringify({ ...payload, ...edit, requestId }),
      });
      pendingRef.current = false;
      discard();
      remainsDirty = false;
      if (!issue) {
        const bookedDate = reservationLocalDateTime(saved.startAt).slice(0, 10);
        if (validListDate(bookedDate)) setDate(bookedDate);
        if (userFilter && userFilter !== saved.userId) setUserFilter(saved.userId);
      }
      changed = true;
    } catch (cause) {
      if (resultUnknown(cause)) {
        setUncertain(true);
        remainsDirty = true;
        setError('저장 응답을 확인하지 못했습니다. 같은 요청으로 결과를 확인할 수 있습니다.');
      } else {
        setError(reservationError(cause));
        setUncertain(false);
        remainsDirty = hasDraftChanges(draft, editor.initial);
      }
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404)) {
        setRevision(value => value + 1);
        if (original) {
          const current = await api<IssueTimeReservation[]>(path, { headers: { 'X-Actor-Id': actorId }, signal: AbortSignal.timeout(12_000) })
            .then(values => values.find(value => value.id === original.id)).catch(() => undefined);
          if (current && current.version !== original.version) {
            setLatest(current);
            setConflict(true);
          }
        }
      }
    } finally { endMutation(remainsDirty); }
    if (changed) reportChanged('시간 배정을 저장했습니다.');
  }

  function adoptLatest() {
    if (!latest || !editor?.original) return;
    const original = { ...editor.original, ...latest };
    const initial = fromReservation(latest);
    const draft = {
      issueId: initial.issueId,
      userId: editor.draft.userId === editor.initial.userId ? initial.userId : editor.draft.userId,
      start: editor.draft.start === editor.initial.start ? initial.start : editor.draft.start,
      end: editor.draft.end === editor.initial.end ? initial.end : editor.draft.end,
    };
    setEditor({ ...editor, draft, initial, original });
    setLatest(null);
    setConflict(false);
    setError('');
    onDraftChange(hasDraftChanges(draft, initial), false, discard);
  }

  async function deleteReservation() {
    if (!deleting || pendingRef.current) return;
    const { entry, generation } = deleting;
    const query = new URLSearchParams({ expectedVersion: String(entry.version), expectedRestoreGeneration: generation ?? '',
      requestId: requestIdFor(JSON.stringify(['delete', entry.id, entry.version, generation])) });
    startMutation();
    let remainsDirty = false, changed = false;
    try {
      await api(`${issueReservationsPath(entry.issueId)}/${encodeURIComponent(entry.id)}?${query}`, {
        method: 'DELETE', headers: { 'X-Actor-Id': actorId }, signal: AbortSignal.timeout(12_000),
      });
      pendingRef.current = false;
      discard();
      changed = true;
    } catch (cause) {
      if (resultUnknown(cause)) {
        setUncertain(true);
        remainsDirty = true;
        setError('삭제 응답을 확인하지 못했습니다. 같은 요청으로 결과를 확인할 수 있습니다.');
      } else {
        setUncertain(false);
        setError(errorMessage(cause));
        setDeleting(null);
        setRevision(value => value + 1);
      }
    } finally { endMutation(remainsDirty); }
    if (changed) reportChanged('시간 배정을 삭제했습니다.');
  }

  function askDelete(entry: IssueTimeReservationEntry) {
    if (!mayReplaceEditor()) return;
    discard();
    setDeleting({ entry, generation: restoreGeneration });
    requestAnimationFrame(() => deleteCancel.current?.focus());
  }

  const rows = list?.entries ?? [];
  const team = new Map(users.map(user => [user.id, user.name]));
  const availableTickets = issue ? [issue] : issues;
  const zone = DEFAULT_RESERVATION_TIME_ZONE;
  const renderRow = (entry: IssueTimeReservationEntry) => {
    const canChange = Boolean(issue || entry.projectId === props.projectId);
    return <li key={entry.id}>
      <div className="time-reservation-row-main">
        <strong>{formatRange(entry)}</strong>
        {issue ? <span>{team.get(entry.userId) ?? '팀원'}</span>
          : <><span>{team.get(entry.userId) ?? '팀원'}</span><button type="button" className="time-reservation-ticket"
            onClick={() => props.openIssue?.(entry.issueId)}><span>{entry.issueKey}</span> {entry.issueTitle}</button></>}
        {entry.state === 'needs-review' && <span className="time-reservation-review">재검토 필요</span>}
      </div>
      {canChange && <div className="time-reservation-actions">
        <button className="btn btn-ghost" type="button" disabled={pending} onClick={() => openEditor(entry)}><Pencil size={13} aria-hidden="true" />배정 수정</button>
        <button className="btn btn-ghost" type="button" disabled={pending} onClick={() => askDelete(entry)}><Trash2 size={13} aria-hidden="true" />배정 삭제</button>
      </div>}
    </li>;
  };

  return <section className={`time-reservations${issue ? ' time-reservations-ticket' : ' card'}`} aria-labelledby={`${id}-heading`}>
    <header className="time-reservation-header">
      <div><h3 id={`${id}-heading`}><CalendarClock size={17} aria-hidden="true" />{issue ? '업무 시간 배정' : '팀원 시간 배정'}</h3>
        <p>시간대 {zone}</p></div>
      <button ref={addButton} type="button" className="btn btn-primary" disabled={pending || !users.length || !availableTickets.length}
        onClick={() => openEditor(null)}><Plus size={15} aria-hidden="true" />시간 배정 추가</button>
    </header>
    {!issue && <div className="time-reservation-filters">
      <div className="time-reservation-date-picker">
        <button className="btn btn-ghost" type="button" aria-label="배정 이전 날짜" disabled={pending || date <= MIN_DATE}
          onClick={() => changeFilter(() => setDate(moveDate(date, -1)))}><ArrowLeft size={15} aria-hidden="true" /></button>
        <label className="issue-form-label">배정 조회 날짜<input className="field" type="date" value={date} disabled={pending}
          min={MIN_DATE} max={MAX_DATE} onChange={event => {
            const next = event.target.value;
            if (validListDate(next) && next !== date) changeFilter(() => setDate(next));
          }} /></label>
        <button className="btn btn-ghost" type="button" aria-label="배정 다음 날짜" disabled={pending || date >= MAX_DATE}
          onClick={() => changeFilter(() => setDate(moveDate(date, 1)))}><ArrowRight size={15} aria-hidden="true" /></button>
      </div>
      <label className="issue-form-label">팀원 필터<select className="field" aria-label="팀원 필터" value={userFilter} disabled={pending}
        onChange={event => { const next = event.target.value; changeFilter(() => setUserFilter(next)); }}>
        <option value="">모든 팀원</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
      </select></label>
    </div>}
    {editor && <form ref={form} className="time-reservation-form" aria-label="시간 배정 편집" aria-busy={pending}
      onSubmit={save} onKeyDown={event => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.stopPropagation(); cancelEditor();
        }
      }}>
      <fieldset disabled={pending || uncertain}>
        {!issue && !editor.original && <label className="issue-form-label time-reservation-work-field">예약 업무<select className="field" aria-label="예약 업무"
          value={editor.draft.issueId} onChange={event => editField('issueId', event.target.value)} required>
          <option value="">업무를 선택하세요</option>{availableTickets.map(ticket => <option key={ticket.id} value={ticket.id}>{ticket.key} · {ticket.title}</option>)}
        </select></label>}
        {!issue && editor.original && <p className="time-reservation-edit-title">{editor.original.issueKey} · {editor.original.issueTitle}</p>}
        <label className="issue-form-label">배정 팀원<select className="field" aria-label="배정 팀원" value={editor.draft.userId} onChange={event => editField('userId', event.target.value)} required>
          <option value="">팀원을 선택하세요</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
        </select></label>
        <label className="issue-form-label">시작 시각<input className="field" type="datetime-local" value={editor.draft.start}
          onChange={event => editField('start', event.target.value)} required /></label>
        <label className="issue-form-label">종료 시각<input className="field" type="datetime-local" value={editor.draft.end}
          onChange={event => editField('end', event.target.value)} required /></label>
      </fieldset>
      {error && <p className="issue-form-error" role="alert">{error}</p>}
      {latest && <div className="time-reservation-latest">
        <span>최신 배정 {team.get(latest.userId) ?? '팀원'} · {formatRange(latest)}</span>
        <button type="button" className="btn" onClick={adoptLatest}>최신 버전으로 계속 편집</button>
      </div>}
      <div className="time-reservation-actions"><button type="button" className="btn btn-ghost" disabled={pending} onClick={cancelEditor}>배정 취소</button>
        <button className="btn btn-primary" type="submit" disabled={pending || conflict}>{pending ? '저장 중…' : uncertain ? '배정 저장 결과 확인' : '배정 저장'}</button></div>
    </form>}
    {deleting && <div className="time-reservation-delete" role="group" aria-label="배정 삭제 확인">
      <p>{deleting.entry.issueKey} · {formatRange(deleting.entry)} 배정을 삭제할까요?</p>
      <div className="time-reservation-actions"><button ref={deleteCancel} type="button" className="btn btn-ghost" disabled={pending} onClick={cancelEditor}>취소</button>
        <button type="button" className="btn issue-btn-danger" disabled={pending} onClick={() => void deleteReservation()}>{uncertain ? '배정 삭제 결과 확인' : '삭제 확인'}</button></div>
    </div>}
    {!editor && error && <p className="issue-form-error" role="alert">{error}</p>}
    {listPath && !list && <p role="status" className="time-reservation-empty">시간 배정을 불러오는 중입니다.</p>}
    {!listPath && <p role="alert" className="issue-form-error">조회 날짜를 확인하세요.</p>}
    {list?.error && <div className="time-reservation-latest"><p className="issue-form-error" role="alert">{list.error}</p>
      <button type="button" className="btn" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />다시 불러오기</button></div>}
    {list && !list.error && (rows.length ? <ul className="time-reservation-list" aria-label="시간 배정 목록">{rows.map(renderRow)}</ul>
      : <p className="time-reservation-empty">{issue ? '이 업무에 배정된 시간이 없습니다.' : '조회 날짜에 배정된 시간이 없습니다.'}</p>)}
  </section>;
}
