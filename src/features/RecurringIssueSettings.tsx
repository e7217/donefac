'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { CalendarClock, Plus, RefreshCw } from 'lucide-react';
import type { FeatureProps, IssueTemplate, RecurringIssueConfig, RecurringIssueRule, RecurringIssueRun } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation, isSettingsSectionNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import './recurring-issue-settings.css';

const WEEKDAYS = ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'];
const EMPTY_CONFIG: RecurringIssueConfig = {
  name: '', templateId: '', weekday: 1, time: '09:00', assigneeId: null, enabled: true,
};
const SEOUL_DATE_TIME = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

type Editor =
  | { mode: 'create'; draft: RecurringIssueConfig; requestId: string; uncertain?: boolean }
  | { mode: 'edit'; draft: RecurringIssueConfig; base: RecurringIssueRule };
type Inventory = { rules: RecurringIssueRule[]; templates: IssueTemplate[] };

function configOf({ name, templateId, weekday, time, assigneeId, enabled }: RecurringIssueRule): RecurringIssueConfig {
  return { name, templateId, weekday, time, assigneeId, enabled };
}

function changesFrom(base: RecurringIssueConfig, draft: RecurringIssueConfig): Partial<RecurringIssueConfig> {
  const fields = Object.keys(base) as (keyof RecurringIssueConfig)[];
  return Object.fromEntries(fields.filter(field => base[field] !== draft[field]).map(field => [field, draft[field]]));
}

function compareRules(left: RecurringIssueRule, right: RecurringIssueRule) {
  return Number(left.archived) - Number(right.archived) || left.name.localeCompare(right.name, 'ko') || left.id.localeCompare(right.id);
}

export function RecurringIssueSettings(props: FeatureProps) {
  if (!props.data.projects.some(project => project.id === props.projectId)) return null;
  return <ProjectRecurringIssues key={`${props.projectId}:${props.actorId}`} {...props} />;
}

function ProjectRecurringIssues({ actorId, data, projectId, notify, refresh, openIssue }: FeatureProps) {
  const headingId = useId();
  const editorHeadingId = useId();
  const path = `/projects/${encodeURIComponent(projectId)}/recurring-issues`;
  const templatesPath = `/projects/${encodeURIComponent(projectId)}/issue-templates`;
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [load, setLoad] = useState({ version: 0, refreshWorkspace: false });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const focusEditor = useRef(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  const edited = editor?.mode === 'edit' ? editor.base : null;
  const draftChanges = editor
    ? changesFrom(edited ? configOf(edited) : EMPTY_CONFIG, editor.draft)
    : {};
  const uncertain = Boolean(editor?.mode === 'create' && editor.uncertain);
  const dirty = uncertain || Object.keys(draftChanges).length > 0;
  const remote = edited && inventory?.rules.find(rule => rule.id === edited.id);
  const stale = Boolean(edited && (conflict || inventory && (!remote || remote.version !== edited.version)));
  const liveIssueIds = new Set(data.issues.map(issue => issue.id));

  const reload = useCallback((refreshWorkspace = false) => {
    setLoading(true);
    setLoadError('');
    setLoad(previous => ({ version: previous.version + 1, refreshWorkspace }));
  }, []);

  const resetEditor = useCallback(() => {
    setEditor(null);
    setError('');
    setConflict(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal, cache: 'no-store' as const };
    void Promise.all([
      api<RecurringIssueRule[]>(`${path}?includeArchived=1`, options),
      api<IssueTemplate[]>(`${templatesPath}?includeArchived=1`, options),
      load.refreshWorkspace ? refresh() : undefined,
    ]).then(([rules, templates]) => {
      if (!controller.signal.aborted) setInventory({ rules: rules.sort(compareRules), templates });
    }).catch(cause => {
      if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : '반복 업무를 불러오지 못했습니다.');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [load, path, refresh, templatesPath]);

  useEffect(() => {
    const imported = () => {
      operation.current?.abort();
      operation.current = null;
      opener.current = null;
      focusEditor.current = false;
      restoreFocus.current = false;
      setSaving(false);
      setInventory(null);
      resetEditor();
      reload();
    };
    window.addEventListener('teamspace:workspace-imported', imported);
    return () => {
      operation.current?.abort();
      operation.current = null;
      window.removeEventListener('teamspace:workspace-imported', imported);
    };
  }, [reload, resetEditor]);

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (operation.current) {
        event.preventDefault();
        notify('반복 업무 저장이 끝난 뒤 이동해 주세요.', 'error');
      } else if (isSettingsSectionNavigation(event)) {
        return;
      } else if (dirty) {
        const question = uncertain ? '반복 업무 저장 결과를 확인하지 않고 이동할까요?'
          : '저장하지 않은 반복 업무 입력을 버리고 이동할까요?';
        if (!window.confirm(question)) event.preventDefault();
        else afterAcceptedNavigation(event, resetEditor);
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!dirty && !operation.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [dirty, notify, resetEditor, uncertain]);

  const editorActive = editor !== null;
  const editorIdentity = editor?.mode === 'create' ? editor.requestId : edited?.id;
  useLayoutEffect(() => {
    if (loading || saving) return;
    if (editorActive && focusEditor.current) {
      focusEditor.current = false;
      nameField.current?.focus();
    }
    if (!editorActive && restoreFocus.current) {
      restoreFocus.current = false;
      opener.current?.focus({ preventScroll: true });
      opener.current = null;
    }
  }, [editorActive, editorIdentity, loading, saving]);

  function confirmDiscard() {
    if (operation.current) return false;
    if (!dirty) return true;
    return window.confirm(uncertain ? '반복 업무 저장 결과를 확인하지 않고 닫을까요?'
      : '저장하지 않은 반복 업무 입력을 버릴까요?');
  }

  function openEditor(button: HTMLButtonElement, rule?: RecurringIssueRule) {
    const alreadyOpen = rule ? rule.id === edited?.id : editor?.mode === 'create';
    if (alreadyOpen) {
      nameField.current?.focus();
      return;
    }
    if (loading || !confirmDiscard()) return;
    opener.current = button;
    focusEditor.current = true;
    setError('');
    setConflict(false);
    setEditor(rule ? { mode: 'edit', draft: configOf(rule), base: rule }
      : { mode: 'create', draft: EMPTY_CONFIG, requestId: newRequestId() });
    reload();
  }

  function closeEditor() {
    if (!confirmDiscard()) return;
    focusEditor.current = false;
    restoreFocus.current = true;
    resetEditor();
    if (uncertain) reload();
  }

  function editDraft(changes: Partial<RecurringIssueConfig>) {
    setEditor(previous => previous ? { ...previous, draft: { ...previous.draft, ...changes } } : previous);
    setError('');
  }

  async function persist(id: string, changes: object, message: string, close: boolean, creation?: Extract<Editor, { mode: 'create' }>) {
    if (!actorId || loading || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setSaving(true);
    setError('');
    let reloadAfter = false;
    try {
      const saved = await api<RecurringIssueRule>(creation ? path : `${path}/${encodeURIComponent(id)}`, {
        method: creation ? 'POST' : 'PATCH', body: JSON.stringify(changes), signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (saved?.id !== id || saved.projectId !== projectId) throw new Error('반복 업무 저장 결과를 읽을 수 없습니다.');
      setInventory(previous => previous && {
        ...previous, rules: [...previous.rules.filter(rule => rule.id !== saved.id), saved].sort(compareRules),
      });
      if (close) {
        restoreFocus.current = true;
        resetEditor();
      }
      notify(message);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const definitive = cause instanceof ApiError && [400, 401, 403, 404, 409, 422].includes(cause.status);
      if (!definitive && creation) {
        setEditor({ ...creation, uncertain: true });
        setError('저장 결과를 받지 못했습니다. 같은 요청으로 다시 확인할 수 있습니다.');
      } else if (!definitive) {
        setError('변경 결과를 확인하지 못했습니다. 새로고침한 규칙을 확인해 주세요.');
        reloadAfter = true;
      } else {
        setError(cause.message);
        if (cause.status === 409 || cause.status === 404) {
          const details = cause.details;
          const reason = details && typeof details === 'object' && 'reason' in details ? details.reason : undefined;
          if (close && edited?.id === id && (reason === 'recurring-issue-version-conflict' || reason === 'recurring-issue-not-found')) {
            setConflict(true);
          }
          reloadAfter = true;
        }
      }
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setSaving(false);
        if (reloadAfter) reload();
      }
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || stale || !editor.draft.name.trim() || !editor.draft.templateId) return;
    const draft = { ...editor.draft, name: editor.draft.name.trim().normalize('NFC') };
    if (editor.mode === 'create') {
      void persist(editor.requestId, { ...draft, requestId: editor.requestId }, '반복 업무를 등록했습니다.', true, editor);
    } else {
      const changes = changesFrom(configOf(editor.base), draft);
      if (!Object.keys(changes).length) return;
      void persist(editor.base.id, { ...changes, expectedVersion: editor.base.version }, '반복 업무를 저장했습니다.', true);
    }
  }

  function changeRule(rule: RecurringIssueRule, action: 'pause' | 'resume' | 'archive' | 'restore') {
    const closesEditor = edited?.id === rule.id;
    if (closesEditor && !confirmDiscard()) return;
    const changes = {
      pause: { enabled: false },
      resume: { enabled: true },
      archive: { archived: true },
      restore: { archived: false },
    }[action];
    const message = {
      pause: '반복 업무를 일시 중지했습니다.',
      resume: '반복 업무를 다시 시작했습니다.',
      archive: '반복 업무를 보관했습니다.',
      restore: '반복 업무를 복원했습니다.',
    }[action];
    void persist(rule.id, { ...changes, expectedVersion: rule.version }, message, closesEditor);
  }

  function useLatest() {
    if (editor?.mode !== 'edit' || !remote || remote.archived) return;
    setEditor({ mode: 'edit', base: remote, draft: { ...configOf(remote), ...draftChanges } });
    setConflict(false);
    setError('');
  }

  const busy = loading || saving;
  const templates = inventory?.templates ?? [];
  const activeTemplates = templates.filter(template => !template.archived);
  const draft = editor?.draft;
  const draftTemplate = templates.find(template => template.id === draft?.templateId);

  return <section className="card settings-card recurring-issue-settings" aria-labelledby={headingId}>
    <div className="card-heading">
      <h2 id={headingId}><CalendarClock size={19} aria-hidden="true" />반복 업무</h2>
    </div>
    <p className="muted">서울 시간 기준으로 매주 지정한 요일과 시간에 업무를 만듭니다. 실행할 때 현재 템플릿과 업무 생성 규칙을 적용합니다.</p>
    <div className="recurring-issue-actions">
      <button type="button" className="btn" disabled={busy || !inventory || !actorId}
        onClick={event => openEditor(event.currentTarget)}><Plus size={15} aria-hidden="true" />반복 업무 추가</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => reload(true)}>
        <RefreshCw size={15} aria-hidden="true" />반복 업무 새로고침
      </button>
    </div>
    {loading && <p role="status">반복 업무를 불러오는 중입니다.</p>}
    {loadError && <p className="issue-form-error" role="alert">{loadError}</p>}
    {!editor && error && <p className="issue-form-error" role="alert">{error}</p>}
    {inventory?.rules.length === 0 && <p className="muted">등록된 반복 업무가 없습니다.</p>}
    {Boolean(inventory?.rules.length) && <ul className="recurring-issue-list" aria-label="프로젝트 반복 업무">
      {inventory?.rules.map(rule => {
        const template = templates.find(item => item.id === rule.templateId);
        const assignee = data.users.find(user => user.id === rule.assigneeId);
        const [latest, ...earlierRuns] = rule.recentRuns;
        return <li key={rule.id} aria-label={rule.name}>
          <div className="recurring-issue-rule">
            <div className="recurring-issue-info">
              <h3>{rule.name} <span className="badge">{rule.archived ? '보관됨' : rule.enabled ? '활성' : '일시 중지됨'}</span></h3>
              <p>{WEEKDAYS[rule.weekday - 1]} {rule.time} · {template?.name ?? '템플릿을 찾을 수 없음'}{template?.archived ? ' (보관됨)' : ''}
                {' · '}{assignee?.name ?? '미배정'}</p>
              {rule.nextRunAt && <p>다음 실행 <time dateTime={rule.nextRunAt}>{SEOUL_DATE_TIME.format(new Date(rule.nextRunAt))}</time></p>}
            </div>
            <div className="recurring-issue-actions">
              {rule.archived ? <button type="button" className="btn btn-ghost" disabled={busy || !actorId}
                onClick={() => changeRule(rule, 'restore')}>복원</button> : <>
                <button type="button" className="btn btn-ghost" disabled={busy || !actorId}
                  onClick={event => openEditor(event.currentTarget, rule)}>편집</button>
                <button type="button" className="btn btn-ghost" disabled={busy || !actorId}
                  onClick={() => changeRule(rule, rule.enabled ? 'pause' : 'resume')}>{rule.enabled ? '일시 중지' : '다시 시작'}</button>
                <button type="button" className="btn btn-ghost" disabled={busy || !actorId}
                  onClick={() => changeRule(rule, 'archive')}>보관</button>
              </>}
            </div>
          </div>
          {latest ? <div className="recurring-issue-history">
            <p className="muted">최근 실행</p>
            <RunSummary run={latest} live={latest.outcome === 'created' && liveIssueIds.has(latest.issueId)} openIssue={openIssue} disabled={saving} />
            {earlierRuns.length > 0 && <details>
              <summary>이전 실행 기록</summary>
              <ol>
                {earlierRuns.map(run => <li key={run.scheduledAt}>
                  <RunSummary run={run} live={run.outcome === 'created' && liveIssueIds.has(run.issueId)} openIssue={openIssue} disabled={saving} />
                </li>)}
              </ol>
            </details>}
          </div> : <p className="muted">실행 기록이 없습니다.</p>}
        </li>;
      })}
    </ul>}
    {editor && draft && <form className="recurring-issue-editor" aria-labelledby={editorHeadingId} aria-busy={busy} onSubmit={save}>
      <h3 id={editorHeadingId}>{edited ? '반복 업무 편집' : '새 반복 업무'}</h3>
      <fieldset className="recurring-issue-fields" disabled={busy || uncertain}>
        <label className="issue-form-label recurring-issue-name">반복 업무 이름
          <input ref={nameField} className="field" value={draft.name} maxLength={100} required onChange={event => editDraft({ name: event.target.value })} />
        </label>
        <label className="issue-form-label recurring-issue-name">업무 템플릿
          <select className="field" value={draft.templateId} required onChange={event => editDraft({ templateId: event.target.value })}>
            <option value="">템플릿 선택</option>
            {draft.templateId && (!draftTemplate || draftTemplate.archived) && <option value={draft.templateId}>
              {draftTemplate ? `${draftTemplate.name} (보관됨)` : '템플릿을 찾을 수 없음'}
            </option>}
            {activeTemplates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select>
        </label>
        <label className="issue-form-label">요일
          <select className="field" value={draft.weekday} onChange={event => editDraft({ weekday: Number(event.target.value) })}>
            {WEEKDAYS.map((weekday, index) => <option value={index + 1} key={weekday}>{weekday}</option>)}
          </select>
        </label>
        <label className="issue-form-label">시간
          <input className="field" type="time" required value={draft.time} onChange={event => editDraft({ time: event.target.value })} />
        </label>
        <label className="issue-form-label">담당자
          <select className="field" value={draft.assigneeId ?? ''} onChange={event => editDraft({ assigneeId: event.target.value || null })}>
            <option value="">미배정</option>
            {data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </label>
        <label className="recurring-issue-toggle">
          <input type="checkbox" checked={draft.enabled} onChange={event => editDraft({ enabled: event.target.checked })} />예약 활성화
        </label>
      </fieldset>
      {!loading && !activeTemplates.length && !draftTemplate && <p className="muted">업무 템플릿을 먼저 등록해 주세요.</p>}
      {stale && <div className="recurring-issue-conflict">
        <p role="status">현재 입력을 유지했습니다. {remote ? '서버의 반복 업무 설정이 변경됐습니다.' : '최신 목록에서 이 규칙을 찾을 수 없습니다.'}</p>
        {remote && <p>현재 설정 · {remote.name} · {WEEKDAYS[remote.weekday - 1]} {remote.time} · {remote.archived ? '보관됨' : remote.enabled ? '활성' : '일시 중지됨'}</p>}
        {remote && !remote.archived && <button className="btn" type="button" disabled={busy} onClick={useLatest}>최신 규칙에 입력 이어서 편집</button>}
      </div>}
      {error && <p className="issue-form-error" role="alert">{error}</p>}
      <div className="recurring-issue-actions recurring-issue-editor-actions">
        <button type="button" className="btn btn-ghost" disabled={saving} onClick={closeEditor}>취소</button>
        <button className="btn btn-primary" type="submit"
          disabled={busy || stale || !actorId || !draft.name.trim() || !draft.templateId || !draft.time || Boolean(edited && !dirty)}>
          {saving ? '저장 중…' : uncertain ? '저장 결과 확인' : '반복 업무 저장'}
        </button>
      </div>
    </form>}
  </section>;
}

function RunSummary({ run, live, disabled, openIssue }: {
  run: RecurringIssueRun; live: boolean; disabled: boolean; openIssue: FeatureProps['openIssue'];
}) {
  return <div className="recurring-issue-run">
    <time dateTime={run.scheduledAt} title={`처리 시각 ${SEOUL_DATE_TIME.format(new Date(run.processedAt))}`}>
      {SEOUL_DATE_TIME.format(new Date(run.scheduledAt))}
    </time>
    {run.outcome === 'created' ? <>
      <span>생성됨</span>
      {live ? <button type="button" className="text-link" disabled={disabled} onClick={() => openIssue(run.issueId)}>{run.issueKey}</button>
        : <strong>{run.issueKey}</strong>}
    </> : <span className="recurring-issue-blocked">실행 보류 · {run.reason}</span>}
  </div>;
}
