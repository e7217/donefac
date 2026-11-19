'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Clock3, Pencil, RefreshCw, Save, Trash2, X } from 'lucide-react';
import type { FeatureProps, IssueWorklogPage, User, WorklogEntry } from '../../shared/types';
import { isCalendarDate } from '../../shared/calendar';
import { api, ApiError } from '../lib/api';
import { todayDate } from './schedule-utils';
import { formatWorklogMinutes, newWorklogRequestId } from '../lib/worklogs';
import './worklogs.css';

export interface IssueWorklogsProps {
  issueId: string;
  actorId: string;
  users: User[];
  notify: FeatureProps['notify'];
  onChanged: () => Promise<void>;
  onDraftChange: (dirty: boolean, pending: boolean, onDiscard: () => void) => void;
}

type Draft = { workDate: string; hours: string; minutes: string; note: string };
type Payload = { workDate: string; minutes: number; note: string };
type Attempt = { requestId: string; payload: Payload };
const PAGE_SIZE = 50;
const freshDraft = (): Draft => ({ workDate: todayDate(), hours: '', minutes: '', note: '' });
function entryDraft(entry: WorklogEntry): Draft {
  const editableMinutes = Number.isInteger(entry.minutes) && entry.minutes <= 1440;
  return {
    workDate:entry.workDate,
    hours:editableMinutes ? String(Math.floor(entry.minutes / 60)) : '',
    minutes:editableMinutes ? String(entry.minutes % 60) : '',
    note:entry.note,
  };
}
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '작업 기록 요청을 완료하지 못했습니다.';
const sameDraft = (left: Draft, right: Draft) => JSON.stringify(left) === JSON.stringify(right);
function validate(draft: Draft, keepImportedDuration: boolean): string {
  if (!isCalendarDate(draft.workDate)) return '작업한 날짜를 선택하세요.';
  if (draft.note.length > 2000) return '작업 내용은 2,000자 이하여야 합니다. 입력은 그대로 유지됩니다.';
  if (keepImportedDuration) return '';
  if (![draft.hours, draft.minutes].every((value) => !value.trim() || /^\d+$/.test(value.trim())))
    return '시간과 분은 소수점 없는 정수로 입력하세요.';
  const hours = Number(draft.hours || 0),
    minutes = Number(draft.minutes || 0),
    total = hours * 60 + minutes;
  if (
    !Number.isSafeInteger(hours) ||
    !Number.isSafeInteger(minutes) ||
    hours > 24 ||
    minutes > 59 ||
    total < 1 ||
    total > 1440
  )
    return '한 기록은 1분~24시간입니다. 분 입력은 0~59로 지정하세요.';
  return '';
}

export function IssueWorklogs(props: IssueWorklogsProps) {
  return <Worklogs key={`${props.issueId}:${props.actorId}`} {...props} />;
}

function Worklogs({ issueId, actorId, users, notify, onChanged, onDraftChange }: IssueWorklogsProps) {
  const [draft, setDraft] = useState<Draft>(freshDraft);
  const [baseline, setBaseline] = useState<Draft>(draft);
  const [editing, setEditing] = useState<WorklogEntry | null>(null);
  const [page, setPage] = useState<IssueWorklogPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<'save' | 'recover' | 'delete' | null>(null);
  const [uncertain, setUncertain] = useState<Attempt | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const active = useRef(true);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const listRequest = useRef<AbortController | null>(null);
  const mutationRequest = useRef<AbortController | null>(null);
  const draftCallback = useRef(onDraftChange);
  const dirty = !sameDraft(draft, baseline) || Boolean(uncertain);
  const keepImportedDuration = Boolean(
    editing?.sourceRecordId && draft.hours === baseline.hours && draft.minutes === baseline.minutes,
  );
  useEffect(() => {
    draftCallback.current = onDraftChange;
  }, [onDraftChange]);

  const discard = useCallback(function discardDraft() {
    if (busyRef.current) return;
    const fresh = freshDraft();
    setDraft(fresh);
    setBaseline(fresh);
    setEditing(null);
    setUncertain(null);
    setConflict(false);
    setError('');
    attempt.current = null;
    dirtyRef.current = false;
    draftCallback.current(false, false, discardDraft);
  }, []);

  useEffect(() => {
    dirtyRef.current = dirty;
    onDraftChange(dirty, Boolean(pending), discard);
  }, [dirty, pending, onDraftChange, discard]);

  const loadPage = useCallback(
    async (requestedOffset: number) => {
      listRequest.current?.abort();
      const controller = new AbortController();
      listRequest.current = controller;
      setLoading(true);
      try {
        const read = (value: number) =>
          api<IssueWorklogPage>(`/issues/${encodeURIComponent(issueId)}/worklogs?offset=${value}`, {
            signal: controller.signal,
            headers: { 'X-Actor-Id': actorId },
          });
        let nextOffset = requestedOffset;
        let result = await read(nextOffset);
        if (!result.entries.length && nextOffset > 0 && nextOffset >= result.totalEntries) {
          nextOffset = Math.max(0, Math.floor((result.totalEntries - 1) / PAGE_SIZE) * PAGE_SIZE);
          result = await read(nextOffset);
        }
        if (active.current && !controller.signal.aborted) {
          setPage(result);
          setOffset(nextOffset);
          setLoadError('');
        }
      } catch (cause) {
        if (active.current && !controller.signal.aborted) setLoadError(errorMessage(cause));
      } finally {
        if (active.current && !controller.signal.aborted) setLoading(false);
      }
    },
    [issueId, actorId],
  );

  useEffect(() => {
    active.current = true;
    const timer = setTimeout(() => void loadPage(0), 0);
    return () => {
      clearTimeout(timer);
      active.current = false;
      listRequest.current?.abort();
      mutationRequest.current?.abort();
      draftCallback.current(false, false, () => {});
    };
  }, [loadPage]);

  function confirmDiscard() {
    if (busyRef.current) return false;
    if (!dirtyRef.current) return true;
    return window.confirm(
      uncertain
        ? '이전 요청이 이미 저장됐을 수 있습니다. 결과 재확인 대신 입력을 버릴까요? 새 기록을 다시 만들기 전에 목록을 확인하세요.'
        : '작성 중인 작업 기록 변경을 버릴까요?',
    );
  }

  function chooseEdit(entry: WorklogEntry) {
    if (entry.authorId !== actorId || !confirmDiscard()) return;
    const next = entryDraft(entry);
    setEditing(entry);
    setDraft(next);
    setBaseline(next);
    setUncertain(null);
    setError('');
    setConflict(false);
    attempt.current = null;
    dirtyRef.current = false;
    onDraftChange(false, false, discard);
  }

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    if (busyRef.current || uncertain) return;
    const next = { ...draft, [key]: value };
    setDraft(next);
    setError('');
    dirtyRef.current = !sameDraft(next, baseline);
    onDraftChange(dirtyRef.current, false, discard);
  }

  function begin(kind: NonNullable<typeof pending>) {
    if (busyRef.current) return null;
    busyRef.current = true;
    setPending(kind);
    setError('');
    onDraftChange(dirtyRef.current, true, discard);
    const controller = new AbortController();
    mutationRequest.current = controller;
    return controller;
  }

  function finish(controller: AbortController) {
    busyRef.current = false;
    if (active.current && !controller.signal.aborted) {
      setPending(null);
      onDraftChange(dirtyRef.current, false, discard);
    }
  }

  async function refreshAfterSave(nextOffset: number) {
    await loadPage(nextOffset);
    try {
      await onChanged();
    } catch {
      if (active.current)
        notify('작업 기록 변경은 완료했습니다. 업무 화면 새로고침을 다시 시도하세요.', 'error');
    }
  }

  async function submit(event?: FormEvent, recovery?: Attempt) {
    event?.preventDefault();
    if (busyRef.current || (conflict && editing)) return;
    if (editing && !dirtyRef.current) return;
    if (!recovery) {
      const validation = validate(draft, keepImportedDuration);
      if (validation) {
        setError(validation);
        return;
      }
    }
    const payload: Payload = recovery?.payload ?? {
      workDate: draft.workDate,
      minutes: Number(draft.hours || 0) * 60 + Number(draft.minutes || 0),
      note: draft.note,
    };
    const create = !editing;
    const currentAttempt = create
      ? (recovery ?? attempt.current ?? { requestId: newWorklogRequestId(), payload })
      : null;
    if (currentAttempt) attempt.current = currentAttempt;
    const controller = begin(recovery ? 'recover' : 'save');
    if (!controller) return;
    try {
      const saved = await api<WorklogEntry>(
        `/issues/${encodeURIComponent(issueId)}/worklogs${editing ? `/${encodeURIComponent(editing.id)}` : ''}`,
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'X-Actor-Id': actorId },
          signal: controller.signal,
          body: JSON.stringify(
            editing
              ? {
                  expectedVersion:editing.version,workDate:payload.workDate,note:payload.note,
                  ...(keepImportedDuration ? {} : {minutes:payload.minutes}),
                }
              : { requestId: currentAttempt!.requestId, ...currentAttempt!.payload },
          ),
        },
      );
      if (!active.current || controller.signal.aborted) return;
      if (
        !saved ||
        typeof saved.id !== 'string' ||
        !Number.isInteger(saved.version) ||
        !Number.isFinite(saved.minutes) ||
        saved.minutes <= 0
      )
        throw new Error('저장 응답 형식을 확인하지 못했습니다.');
      setUncertain(null);
      attempt.current = null;
      setConflict(false);
      if (editing) {
        const next = entryDraft(saved);
        setEditing(saved);
        setDraft(next);
        setBaseline(next);
      } else {
        const next = freshDraft();
        setDraft(next);
        setBaseline(next);
      }
      dirtyRef.current = false;
      onDraftChange(false, true, discard);
      notify(`${formatWorklogMinutes(saved.minutes)} 작업 기록을 ${editing ? '수정' : '저장'}했습니다.`);
      await refreshAfterSave(create ? 0 : offset);
    } catch (cause) {
      if (!active.current || controller.signal.aborted) return;
      const definite = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      if (create && !definite && currentAttempt) {
        setUncertain(currentAttempt);
        dirtyRef.current = true;
        setError(
          `${errorMessage(cause)} 저장 여부를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인하세요.`,
        );
      } else {
        if (create) {
          attempt.current = null;
          setUncertain(null);
        }
        if (cause instanceof ApiError && cause.status === 409 && editing) setConflict(true);
        setError(
          `${errorMessage(cause)} 입력과 편집 버전은 유지됩니다.${editing ? ' 목록을 새로고침한 뒤 최신 기록을 다시 선택하세요.' : ''}`,
        );
      }
    } finally {
      finish(controller);
    }
  }

  async function deleteEntry(entry: WorklogEntry) {
    if (busyRef.current || uncertain || entry.authorId !== actorId) return;
    if (
      !window.confirm(
        `${entry.workDate} · ${formatWorklogMinutes(entry.minutes)} 작업 기록을 삭제할까요?${editing?.id === entry.id && dirtyRef.current ? ' 이 기록의 작성 중인 변경도 사라집니다.' : ''}`,
      )
    )
      return;
    const controller = begin('delete');
    if (!controller) return;
    setDeletingId(entry.id);
    try {
      await api(`/issues/${encodeURIComponent(issueId)}/worklogs/${encodeURIComponent(entry.id)}`, {
        method: 'DELETE',
        headers: { 'X-Actor-Id': actorId },
        body: JSON.stringify({ expectedVersion: entry.version }),
        signal: controller.signal,
      });
      if (!active.current || controller.signal.aborted) return;
      if (editing?.id === entry.id) {
        const next = freshDraft();
        setEditing(null);
        setDraft(next);
        setBaseline(next);
        setConflict(false);
        dirtyRef.current = false;
      }
      notify('작업 기록을 삭제했습니다.');
      await refreshAfterSave(offset);
    } catch (cause) {
      if (active.current && !controller.signal.aborted)
        setError(
          `${errorMessage(cause)} 입력은 유지됩니다. 목록을 새로고침해 삭제 여부와 최신 버전을 확인하세요.`,
        );
    } finally {
      if (active.current && !controller.signal.aborted) setDeletingId(null);
      finish(controller);
    }
  }

  const payloadMinutes = validate(draft, keepImportedDuration)
    ? null
    : Number(draft.hours || 0) * 60 + Number(draft.minutes || 0);
  return (
    <section className="issue-worklogs" aria-label="업무 작업 기록">
      <header className="issue-worklogs-heading">
        <div>
          <h3>
            <Clock3 size={18} />
            작업 기록
          </h3>
          {page && (
            <p>
              <strong aria-label="업무 총 작업 시간">{formatWorklogMinutes(page.totalMinutes)}</strong>
              <span>전체 {page.totalEntries.toLocaleString()}개 기록</span>
            </p>
          )}
        </div>
        <button
          className="btn btn-ghost"
          type="button"
          aria-label="작업 기록 새로고침"
          disabled={Boolean(pending) || loading}
          onClick={() => void loadPage(offset)}
        >
          <RefreshCw size={16} />
          새로고침
        </button>
      </header>
      <form
        className="issue-worklog-form"
        aria-label={editing ? '작업 기록 수정' : '새 작업 기록'}
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <div className="issue-worklog-form-heading">
          <h4>{editing ? '작업 기록 수정' : '새 기록 남기기'}</h4>
          {editing && <span>편집 버전 {editing.version}</span>}
        </div>
        <fieldset disabled={Boolean(pending || uncertain)}>
          <div className="issue-worklog-inputs">
            <label>
              작업한 날짜
              <input
                className="field"
                type="date"
                aria-label="작업 기록 날짜"
                value={draft.workDate}
                onChange={(event) => update('workDate', event.target.value)}
              />
            </label>
            <label>
              시간
              <input
                className="field"
                type="text"
                inputMode="numeric"
                aria-label="작업 기록 시간"
                placeholder="0"
                value={draft.hours}
                onChange={(event) => update('hours', event.target.value)}
              />
            </label>
            <label>
              분
              <input
                className="field"
                type="text"
                inputMode="numeric"
                aria-label="작업 기록 분"
                placeholder="0"
                value={draft.minutes}
                onChange={(event) => update('minutes', event.target.value)}
              />
            </label>
          </div>
          <p className="issue-worklog-help">
            {keepImportedDuration && editing
              ? `이관 작업 시간은 ${formatWorklogMinutes(editing.minutes)}입니다. 새 시간과 분을 입력해 변경할 수 있습니다.`
              : <>입력 가능한 시간은 1분~24시간입니다. {payloadMinutes !== null && `입력한 시간 ${formatWorklogMinutes(payloadMinutes)}`}</>}
          </p>
          <label>
            작업 내용
            <textarea
              className="field"
              aria-label="작업 기록 내용"
              aria-describedby="worklog-note-length"
              rows={3}
              value={draft.note}
              onChange={(event) => update('note', event.target.value)}
              placeholder="어떤 작업을 했나요?"
            />
          </label>
          <p id="worklog-note-length" className="issue-worklog-help">
            {draft.note.length.toLocaleString()} / 2,000자
          </p>
        </fieldset>
        <p className="issue-worklog-author">
          작성자 {users.find((user) => user.id === actorId)?.name || actorId} · 작성자 본인만 수정·삭제할
          수 있습니다.
        </p>
        {error && (
          <p className="issue-worklog-error" role="alert">
            {error}
          </p>
        )}
        {conflict && (
          <p className="issue-worklog-warning">
            다른 변경과 충돌했습니다. 기존 버전으로 덮어쓰지 않습니다. 목록을 새로고침하고 최신 기록의
            수정을 다시 선택하세요.
          </p>
        )}
        {uncertain && (
          <p className="issue-worklog-warning">
            기록이 이미 저장됐을 수 있어 입력을 잠갔습니다. 결과 재확인은 같은 요청 ID와 입력으로
            진행합니다.
          </p>
        )}
        <div className="issue-worklog-actions">
          <button
            className="btn btn-ghost"
            type="button"
            disabled={Boolean(pending)}
            onClick={() => {
              if (confirmDiscard()) discard();
            }}
          >
            <X size={15} />
            {editing ? '새 기록 작성' : '입력 초기화'}
          </button>
          {uncertain ? (
            <button
              className="btn btn-primary"
              type="button"
              disabled={Boolean(pending)}
              onClick={() => void submit(undefined, uncertain)}
            >
              기록 결과 다시 확인
            </button>
          ) : (
            <button
              className="btn btn-primary"
              type="submit"
              disabled={Boolean(pending) || Boolean(editing && (!dirty || conflict))}
            >
              <Save size={16} />
              {pending === 'save' ? '저장 중…' : editing ? '기록 수정 저장' : '작업 기록 저장'}
            </button>
          )}
        </div>
      </form>
      {loadError && (
        <p className="issue-worklog-error" role="alert">
          {loadError} 기존 목록과 입력은 유지됩니다.
        </p>
      )}
      {loading && !page && <p role="status">작업 기록을 불러오는 중…</p>}
      {page && (
        <>
          <ul className="issue-worklog-list" aria-label="작업 기록 목록">
            {page.entries.map((entry) => (
              <li key={entry.id} className={editing?.id === entry.id ? 'is-editing' : ''}>
                <div className="issue-worklog-row-heading">
                  <div>
                    <strong>{formatWorklogMinutes(entry.minutes)}</strong>
                    <time dateTime={entry.workDate}>{entry.workDate}</time>
                  </div>
                  {entry.authorId === actorId && (
                    <div className="issue-worklog-row-actions">
                      <button
                        className="btn btn-ghost"
                        type="button"
                        aria-label={`${entry.workDate} 작업 기록 수정`}
                        disabled={Boolean(pending)}
                        onClick={() => chooseEdit(entry)}
                      >
                        <Pencil size={15} />
                        수정
                      </button>
                      <button
                        className="btn btn-ghost"
                        type="button"
                        aria-label={`${entry.workDate} 작업 기록 삭제`}
                        disabled={Boolean(pending) || Boolean(uncertain)}
                        onClick={() => void deleteEntry(entry)}
                      >
                        <Trash2 size={15} />
                        {deletingId === entry.id ? '삭제 중…' : '삭제'}
                      </button>
                    </div>
                  )}
                </div>
                <span className="issue-worklog-row-author">
                  {users.find((user) => user.id === entry.authorId)?.name || entry.authorId}
                  {entry.sourceRecordId && ' · Jira 이관'}
                </span>
                {entry.note && <p>{entry.note}</p>}
                <small>
                  버전 {entry.version} · {new Date(entry.updatedAt).toLocaleString('ko-KR')} 수정
                </small>
              </li>
            ))}
          </ul>
          {!page.entries.length && <p className="issue-worklog-empty">아직 작업 기록이 없습니다.</p>}
          <div className="issue-worklog-pagination">
            <span>
              {page.totalEntries ? offset + 1 : 0}–{Math.min(offset + PAGE_SIZE, page.totalEntries)} /{' '}
              {page.totalEntries.toLocaleString()}
            </span>
            <button
              className="btn btn-ghost"
              type="button"
              aria-label="작업 기록 이전 페이지"
              disabled={loading || Boolean(pending) || offset === 0}
              onClick={() => void loadPage(Math.max(0, offset - PAGE_SIZE))}
            >
              이전
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              aria-label="작업 기록 다음 페이지"
              disabled={loading || Boolean(pending) || offset + PAGE_SIZE >= page.totalEntries}
              onClick={() => void loadPage(offset + PAGE_SIZE)}
            >
              다음
            </button>
          </div>
        </>
      )}
    </section>
  );
}
