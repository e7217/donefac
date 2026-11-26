'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Bell, RefreshCw, Save } from 'lucide-react';
import type { DeadlineReminderPreferences, FeatureProps } from '../../shared/types';
import { MAX_DEADLINE_REMINDER_DAYS } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation, isSettingsSectionNavigation } from '../lib/navigation';
import './deadline-reminder-settings.css';

type ReminderDraft = Omit<DeadlineReminderPreferences, 'version'>;
type ReminderForm = { saved: DeadlineReminderPreferences; draft: ReminderDraft };

const path = '/notifications/deadline-reminders';
const leadTimes = Array.from({ length: MAX_DEADLINE_REMINDER_DAYS + 1 }, (_, days) => days);

function draftFor({ daysBefore, onDueDate, overdue }: DeadlineReminderPreferences): ReminderDraft {
  return { daysBefore, onDueDate, overdue };
}

function changesIn({ saved, draft }: ReminderForm): Partial<ReminderDraft> {
  const changes: Partial<ReminderDraft> = {};
  if (draft.daysBefore !== saved.daysBefore) changes.daysBefore = draft.daysBefore;
  if (draft.onDueDate !== saved.onDueDate) changes.onDueDate = draft.onDueDate;
  if (draft.overdue !== saved.overdue) changes.overdue = draft.overdue;
  return changes;
}

export function DeadlineReminderSettings({ actorId, actorName, notify }: {
  actorId: string;
  actorName: string;
  notify: FeatureProps['notify'];
}) {
  const headingId = useId();
  const descriptionId = useId();
  const [form, setForm] = useState<ReminderForm | null>(null);
  const [pending, setPending] = useState<'load' | 'save' | null>('load');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const request = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const dirty = useRef(false);

  const load = useCallback((changes: Partial<ReminderDraft> = {}) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    return api<DeadlineReminderPreferences>(path, {
      headers: { 'X-Actor-Id': actorId }, signal: controller.signal,
    }).then(saved => {
      if (controller.signal.aborted) return;
      const next = { saved, draft: { ...draftFor(saved), ...changes } };
      dirty.current = Object.keys(changesIn(next)).length > 0;
      setForm(next);
      setConflict(false);
    }).catch(cause => {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : '마감 알림 설정을 불러오지 못했습니다.');
      }
    }).finally(() => {
      if (request.current === controller) {
        request.current = null;
        setPending(null);
      }
    });
  }, [actorId]);

  useEffect(() => {
    const imported = () => {
      saving.current = false;
      dirty.current = false;
      setForm(null);
      setConflict(false);
      setError('');
      setPending('load');
      void load();
    };
    void load();
    window.addEventListener('teamspace:workspace-imported', imported);
    return () => {
      request.current?.abort();
      request.current = null;
      window.removeEventListener('teamspace:workspace-imported', imported);
    };
  }, [load]);

  const saved = form?.saved;
  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (saving.current) {
        event.preventDefault();
        notify('마감 알림 설정 저장이 끝난 뒤 이동해 주세요.', 'error');
      } else if (isSettingsSectionNavigation(event)) {
        return;
      } else if (dirty.current) {
        if (!window.confirm('저장하지 않은 마감 알림 설정을 버리고 이동할까요?')) {
          event.preventDefault();
          return;
        }
        afterAcceptedNavigation(event, () => {
          request.current?.abort();
          request.current = null;
          dirty.current = false;
          if (saved) setForm({ saved, draft: draftFor(saved) });
          setPending(null);
          setError('');
        });
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty.current || saving.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [notify, saved]);

  function reload() {
    if (request.current) return;
    setPending('load');
    setError('');
    void load(form ? changesIn(form) : {});
  }

  function changeDraft(changes: Partial<ReminderDraft>) {
    if (!form || request.current) return;
    const next = { ...form, draft: { ...form.draft, ...changes } };
    dirty.current = Object.keys(changesIn(next)).length > 0;
    setForm(next);
    setError('');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form || !dirty.current || request.current || conflict) return;
    const controller = new AbortController();
    request.current = controller;
    saving.current = true;
    setPending('save');
    setError('');
    try {
      const saved = await api<DeadlineReminderPreferences>(path, {
        method: 'PUT',
        headers: { 'X-Actor-Id': actorId },
        signal: controller.signal,
        body: JSON.stringify({ ...form.draft, expectedVersion: form.saved.version }),
      });
      if (controller.signal.aborted) return;
      setForm({ saved, draft: draftFor(saved) });
      dirty.current = false;
      notify('마감 알림 설정을 저장했습니다.');
      window.dispatchEvent(new Event('teamspace:notifications-updated'));
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
      else setError(cause instanceof Error ? cause.message : '마감 알림 설정을 저장하지 못했습니다.');
    } finally {
      if (request.current === controller) {
        request.current = null;
        saving.current = false;
        setPending(null);
      }
    }
  }

  return <section className="card settings-card deadline-reminder-settings" aria-labelledby={headingId} aria-describedby={descriptionId}>
    <div className="card-heading">
      <h2 id={headingId}><Bell size={19} aria-hidden="true" />업무 마감 알림</h2>
    </div>
    <p id={descriptionId}>
      <strong>{actorName}</strong>님이 맡은 열린 업무의 마감을 서울 시간 기준으로 알립니다.
      목표 마감일이 비어 있으면 계획 종료일을 사용하며, 마감일과 알림 유형마다 한 번 알립니다.
    </p>
    {pending === 'load' && <p role="status">마감 알림 설정을 불러오는 중입니다.</p>}
    {conflict && <p className="error-text" role="alert">
      다른 화면에서 설정이 바뀌었습니다. 최신 설정을 불러오면 변경한 항목을 유지한 채 다시 저장할 수 있습니다.
    </p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <form onSubmit={save}>
      {form && <fieldset disabled={pending !== null} className="deadline-reminder-fields">
        <label className="deadline-reminder-lead-time">마감 전 알림
          <select className="field" value={form.draft.daysBefore} onChange={event => changeDraft({ daysBefore: Number(event.target.value) })}>
            {leadTimes.map(days => <option key={days} value={days}>{days ? `${days}일 전` : '사용 안 함'}</option>)}
          </select>
        </label>
        <label className="deadline-reminder-toggle">
          <input type="checkbox" checked={form.draft.onDueDate} onChange={event => changeDraft({ onDueDate: event.target.checked })} />
          마감 당일
        </label>
        <label className="deadline-reminder-toggle">
          <input type="checkbox" checked={form.draft.overdue} onChange={event => changeDraft({ overdue: event.target.checked })} />
          마감 초과
        </label>
      </fieldset>}
      <div className="deadline-reminder-actions">
        {form && <button className="btn btn-primary" type="submit" disabled={pending !== null || conflict || !Object.keys(changesIn(form)).length}>
          <Save size={15} aria-hidden="true" />{pending === 'save' ? '저장 중…' : '마감 알림 설정 저장'}
        </button>}
        {(conflict || (!form && error)) && <button className="btn" type="button" disabled={pending !== null} onClick={reload}>
          <RefreshCw size={15} aria-hidden="true" />최신 마감 알림 설정 불러오기
        </button>}
      </div>
    </form>
  </section>;
}
