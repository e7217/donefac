'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { isCalendarDate, MAX_CALENDAR_DATE, MIN_CALENDAR_DATE } from '../../shared/calendar';
import { PRIORITY, type CustomFieldDefinition, type CustomFieldValue, type FeatureProps, type Issue,
  type IssueStatusChangeRequest, type IssueStatusChangeResult, type User, type WorkflowStatus, type WorkspaceSnapshot } from '../../shared/types';
import { fieldApplies, fieldValueLabel, hasCustomValue, projectIssueSchema, visibleIssueFieldIds } from '../../shared/issue-schema';
import { allowedNextStatuses, projectWorkflow, requiredFieldsFor, statusMeta } from '../../shared/workflow-helpers';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import { CommentMentionInput, commentDraftPayload, emptyCommentDraft } from './CommentMentions';
import { CustomFieldInput } from './CustomFields';
import { errorMessage } from './schedule-utils';
import './issue-status-dialog.css';

export type IssueStatusEdit = { issue: Issue; current: WorkflowStatus; choices: WorkflowStatus[]; workflowVersion: number };
type Recovery = 'conflict' | 'verify' | 'refresh';
type StatusChangeAttempt = { actorId: string; input: IssueStatusChangeRequest };
type PropertyDraft<Value> = { base: Value; value: Value };
type CustomDraft = PropertyDraft<CustomFieldValue> & { label: string; kind: CustomFieldDefinition['kind'] };
type DueDateDraft = { base: Issue['dueDate']; mode: 'set' | 'clear'; date: string };

const STALE = '업무, 워크플로 또는 업무 양식이 변경되었습니다. 최신 상태를 불러온 뒤 다시 선택해 주세요.';
const REFRESH = '변경 사항을 저장했습니다. 화면에 반영하려면 최신 업무를 불러와 주세요.';
const UNKNOWN_HANDOFF = '상태 변경과 인수인계 댓글의 저장 결과를 확인하지 못했습니다.';
const UNASSIGNED = 'unassigned';
const USER_OPTION = 'user:';

function confirmedStatusChange(result: IssueStatusChangeResult, edit: IssueStatusEdit, input: IssueStatusChangeRequest): boolean {
  const { issue, receipt, duplicate } = result ?? {};
  return Boolean(receipt && issue && typeof duplicate === 'boolean' && receipt.requestId === input.requestId &&
    receipt.issueId === edit.issue.id && receipt.projectId === edit.issue.projectId && receipt.appliedVersion === input.expectedVersion + 1 &&
    receipt.status === input.status && (receipt.assigneeId === null || typeof receipt.assigneeId === 'string') &&
    (input.assigneeId === undefined || receipt.assigneeId === input.assigneeId) && receipt.priority === input.priority && receipt.dueDate === input.dueDate &&
    (input.comment ? typeof receipt.commentId === 'string' && receipt.commentId.length > 0 : receipt.commentId === null) &&
    issue.id === receipt.issueId && issue.projectId === receipt.projectId && Number.isSafeInteger(issue.version) &&
    (issue.version === receipt.appliedVersion ? issue.status === receipt.status && issue.assigneeId === receipt.assigneeId &&
      (receipt.priority === undefined || issue.priority === receipt.priority) && (receipt.dueDate === undefined || issue.dueDate === receipt.dueDate) :
      duplicate && issue.version > receipt.appliedVersion));
}

function definiteStatusError(cause: unknown): cause is ApiError {
  return cause instanceof ApiError && cause.status < 500 && ![408, 425, 429, 499].includes(cause.status);
}

function sameProperty(left: CustomFieldValue, right: CustomFieldValue): boolean {
  return left === right || Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every(value => right.includes(value));
}

function propertyConflict<Value extends CustomFieldValue>(draft: PropertyDraft<Value> | undefined, saved: Value): boolean {
  return Boolean(draft && !sameProperty(draft.base, saved) && !sameProperty(draft.value, saved));
}

function PropertyConflict({ label, saved, onUseSaved, onUseInput }: {
  label: string; saved: string; onUseSaved: () => void; onUseInput: () => void;
}) {
  return <div className="issue-status-property-conflict">
    <p>동료가 저장한 {label}</p>
    <blockquote>{saved || '미지정'}</blockquote>
    <div>
      <button className="btn btn-ghost" type="button" aria-label={`${label} 저장값 사용`} onClick={onUseSaved}>저장값 사용</button>
      <button className="btn" type="button" aria-label={`${label} 입력값 사용`} onClick={onUseInput}>입력값 사용</button>
    </div>
  </div>;
}

export function IssueStatusDialog({ edit: originalEdit, actorId, latest, refresh, notify, onClose, onOpenDetails }: {
  edit: IssueStatusEdit;
  actorId: string;
  latest: WorkspaceSnapshot;
  refresh: FeatureProps['refresh'];
  notify: FeatureProps['notify'];
  onClose: () => void;
  onOpenDetails: () => void;
}) {
  const [review, setReview] = useState(() => ({ edit: originalEdit, restoreGeneration: latest.restoreGeneration,
    schemaVersion: projectIssueSchema(latest, originalEdit.issue.projectId).version }));
  const { edit, restoreGeneration, schemaVersion } = review;
  const heading = useId();
  const errorId = useId();
  const dueDateHintId = useId();
  const commentId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const statusField = useRef<HTMLSelectElement>(null);
  const assigneeField = useRef<HTMLSelectElement>(null);
  const recoverButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const changeAttempt = useRef<StatusChangeAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(edit.choices.length === 1 ? edit.choices[0].id : '');
  const [assigneeId, setAssigneeId] = useState<Issue['assigneeId'] | undefined>();
  const [priority, setPriority] = useState<PropertyDraft<Issue['priority']>>();
  const [dueDate, setDueDate] = useState<DueDateDraft>();
  const [description, setDescription] = useState<PropertyDraft<string>>();
  const [customFields, setCustomFields] = useState<Record<string, CustomDraft>>({});
  const [reportedRequired, setReportedRequired] = useState<string[]>([]);
  const [comment, setComment] = useState(emptyCommentDraft);
  const [commentSaved, setCommentSaved] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [assigneeRequired, setAssigneeRequired] = useState(false);
  const current = latest.issues.find(issue => issue.id === edit.issue.id);
  const schema = projectIssueSchema(latest, edit.issue.projectId);
  const stale = latest.restoreGeneration !== restoreGeneration || !current || current.version !== edit.issue.version || current.projectId !== edit.issue.projectId ||
    projectWorkflow(latest, edit.issue.projectId).version !== edit.workflowVersion || schema.version !== schemaVersion;
  const fieldsDisabled = busy || stale || Boolean(recovery);
  const draftCustom = Object.fromEntries(Object.entries(customFields).map(([id, field]) => [id, field.value]));
  const required = new Set<string>(selected ? [...reportedRequired,
    ...requiredFieldsFor(latest, edit.issue.projectId, edit.issue.type, selected, edit.issue.status)] : []);
  const visibleFields = visibleIssueFieldIds(schema, { type: edit.issue.type, status: selected || edit.issue.status,
    customFields: { ...edit.issue.customFields, ...draftCustom } });
  const applicable = schema.fields.filter(field => !field.archived && fieldApplies(field, edit.issue.type));
  const unavailable = Object.entries(customFields).filter(([id, draft]) => !applicable.some(field => field.id === id && field.kind === draft.kind));
  const customRequired = (field: CustomFieldDefinition) => required.has(`custom:${field.id}`) || field.required && visibleFields.has(field.id);
  const storedCustom = (id: string) => edit.issue.customFields?.[id] ?? null;
  const customValue = (field: CustomFieldDefinition) => customFields[field.id]?.kind === field.kind
    ? customFields[field.id].value : storedCustom(field.id);
  const propertyFields = applicable.filter(field => customFields[field.id]?.kind === field.kind ||
    customRequired(field) && !hasCustomValue(storedCustom(field.id)));
  const descriptionValue = description?.value ?? edit.issue.description;
  const missingDescription = required.has('description') && !descriptionValue.trim();
  const descriptionConflict = propertyConflict(description, edit.issue.description);
  const priorityValue = priority?.value ?? edit.issue.priority;
  const priorityConflict = propertyConflict(priority, edit.issue.priority);
  const savedDueDate = edit.issue.dueDate;
  const dueDateValue = dueDate ? (dueDate.mode === 'set' ? dueDate.date : null) : savedDueDate;
  const automaticDueDays = !dueDate && savedDueDate === null ? edit.choices.find(status => status.id === selected)?.defaultDueWorkdays : null;
  const missingDueDate = required.has('dueDate') && !dueDateValue && automaticDueDays == null;
  const invalidDueDate = dueDate?.mode === 'set' && !isCalendarDate(dueDate.date);
  const dueDateConflict = propertyConflict(dueDate && { base: dueDate.base, value: dueDateValue }, savedDueDate);
  const dueDateHint = missingDueDate ? '이 상태는 목표 마감일이 필요합니다.' :
    automaticDueDays != null ? `프로젝트 달력으로 ${automaticDueDays}근무일 뒤의 날짜를 지정합니다.` :
      dueDate ? `현재 목표 마감일 ${savedDueDate ?? '미지정'}` : '';
  const incompleteProperties = missingDescription || missingDueDate || invalidDueDate ||
    propertyFields.some(field => customRequired(field) && !hasCustomValue(customValue(field)));
  const unresolvedProperties = descriptionConflict || priorityConflict || dueDateConflict || unavailable.length > 0 ||
    propertyFields.some(field => propertyConflict(customFields[field.id], storedCustom(field.id)));
  const hasPropertiesDraft = Boolean(priority || dueDate || description || Object.keys(customFields).length);
  const assigneeUnavailable = typeof assigneeId === 'string' && !latest.users.some(user => user.id === assigneeId);
  const assigneeOption = assigneeId === undefined ? '' : assigneeId === null ? UNASSIGNED : `${USER_OPTION}${assigneeId}`;
  const unknownResult = comment.body.trim() ? UNKNOWN_HANDOFF : (priority || dueDate) ? '상태와 업무 속성의 변경 결과를 확인하지 못했습니다.' :
    `${assigneeId === undefined ? '상태' : '상태와 담당자'} 변경 결과를 확인하지 못했습니다.`;
  const discardPrompt = recovery === 'verify' ? `${unknownResult} 닫을까요?` :
    hasPropertiesDraft ? '작성 중인 업무 내용과 인수인계 입력을 버리고 닫을까요?' :
      comment.body.trim() ? '작성 중인 인수인계 댓글을 버리고 닫을까요?' : null;
  const canSubmit = Boolean(selected && !assigneeUnavailable && !incompleteProperties && !unresolvedProperties && !fieldsDisabled);
  const nameCounts = new Map<string, number>();
  for (const user of latest.users) nameCounts.set(user.name, (nameCounts.get(user.name) ?? 0) + 1);

  function assigneeLabel(user: User) {
    return (nameCounts.get(user.name) ?? 0) > 1 ? `${user.name} · ${user.email}` : user.name;
  }

  function assigneeName(id: Issue['assigneeId']) {
    if (id === null) return '미지정';
    const user = latest.users.find(person => person.id === id);
    return user ? assigneeLabel(user) : '팀원 확인 불가';
  }

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    statusField.current?.focus({ preventScroll: true });
    return () => element?.close();
  }, []);

  useEffect(() => {
    if (!busy && assigneeRequired) assigneeField.current?.focus();
  }, [assigneeRequired, busy]);

  useEffect(() => {
    if (!busy && recovery === 'verify') recoverButton.current?.focus();
  }, [busy, recovery]);

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pending.current) { event.preventDefault(); return; }
      if (discardPrompt && !window.confirm(discardPrompt)) { event.preventDefault(); return; }
      afterAcceptedNavigation(event, onClose);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!pending.current && !discardPrompt) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [onClose, discardPrompt]);

  function close() {
    if (!pending.current && (!discardPrompt || window.confirm(discardPrompt))) onClose();
  }

  function clearValidation() {
    setError('');
    setShowDetails(false);
    setAssigneeRequired(false);
  }

  function changeDescription(value: string, useLatest = false) {
    setDescription(value === edit.issue.description ? undefined : { base: useLatest ? edit.issue.description : description?.base ?? edit.issue.description, value });
    clearValidation();
  }

  function changePriority(value: Issue['priority'], useLatest = false) {
    setPriority(value === edit.issue.priority ? undefined : { base: useLatest ? edit.issue.priority : priority?.base ?? edit.issue.priority, value });
    clearValidation();
  }

  function changeDueDate(mode: DueDateDraft['mode'] | '', date = dueDate?.date ?? savedDueDate ?? '', useLatest = false) {
    setDueDate(mode ? { base: useLatest || !dueDate ? savedDueDate : dueDate.base, mode, date } : undefined);
    clearValidation();
  }

  function changeCustom(field: CustomFieldDefinition, value: CustomFieldValue, useLatest = false) {
    const saved = storedCustom(field.id);
    if (sameProperty(value, saved)) return forgetCustom(field.id);
    setCustomFields(previous => ({ ...previous, [field.id]: { label: field.name, kind: field.kind,
      base: useLatest || !previous[field.id] ? saved : previous[field.id].base, value } }));
    clearValidation();
  }

  function forgetCustom(id: string) {
    setCustomFields(previous => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    clearValidation();
  }

  async function committed(withComment = commentSaved) {
    setRecovery('refresh');
    try {
      await refresh();
      const label = edit.choices.find(status => status.id === selected)?.label ?? selected;
      const details = assigneeId === undefined ? '' : ` · 담당자 ${assigneeName(assigneeId)}`;
      notify(withComment ? `${edit.issue.key} · 상태 ${label}${details} · 인수인계 댓글 저장 완료` :
        assigneeId === undefined ? `${edit.issue.key} · ${label}(으)로 변경했습니다.` : `${edit.issue.key} · 상태 ${label}${details} 저장 완료`);
      onClose();
    } catch { setError(REFRESH); }
  }

  function reportStatusError(cause: ApiError) {
    setError(errorMessage(cause));
    if (cause.status === 409 || cause.status === 404) {
      setRecovery('conflict');
      return;
    }
    setRecovery(null);
    const details = cause.details;
    const requiredFields = typeof details === 'object' && details !== null && 'requiredFields' in details &&
      Array.isArray(details.requiredFields) ? details.requiredFields.filter((field): field is string => typeof field === 'string') : [];
    const missingAssignee = cause.status === 422 && requiredFields.includes('assigneeId');
    setAssigneeRequired(missingAssignee);
    if (cause.status === 422) setReportedRequired(requiredFields);
    setShowDetails(cause.status === 422 && (!requiredFields.length || requiredFields.some(field =>
      !['assigneeId', 'description', 'dueDate'].includes(field) && !applicable.some(definition => field === `custom:${definition.id}`))));
  }

  async function applyStatusChange(attempt: StatusChangeAttempt) {
    if (attempt.actorId !== actorId) {
      setError('변경을 요청한 작업자로 전환한 뒤 저장 결과를 다시 확인해 주세요.');
      return;
    }
    const withComment = Boolean(attempt.input.comment);
    try {
      const result = await api<IssueStatusChangeResult>(`/issues/${encodeURIComponent(edit.issue.id)}/status-change`, {
        method: 'POST', headers: { 'X-Actor-Id': attempt.actorId }, body: JSON.stringify(attempt.input),
      });
      if (!confirmedStatusChange(result, edit, attempt.input)) throw new Error(unknownResult);
      changeAttempt.current = null;
      setComment(emptyCommentDraft());
      setPriority(undefined);
      setDueDate(undefined);
      setDescription(undefined);
      setCustomFields({});
      setCommentSaved(withComment);
      await committed(withComment);
    } catch (cause) {
      if (definiteStatusError(cause)) {
        if (recovery === 'verify' && (cause.status === 401 || cause.status === 403)) {
          setError(`${unknownResult} 접속을 확인한 뒤 같은 요청으로 다시 확인해 주세요.`);
          return;
        }
        changeAttempt.current = null;
        reportStatusError(cause);
      } else {
        setRecovery('verify');
        setError(`${unknownResult} 같은 요청으로 다시 확인해 주세요.`);
      }
    }
  }

  async function reviewLatestWithDraft() {
    const snapshot = await api<WorkspaceSnapshot>('/workspace', { cache: 'no-store' });
    if (typeof snapshot?.restoreGeneration !== 'string' || !Array.isArray(snapshot?.issues)) {
      throw new Error('최신 업무 정보를 불러오지 못했습니다.');
    }
    const issue = snapshot.issues.find(issue => issue.id === edit.issue.id && issue.projectId === edit.issue.projectId);
    if (!issue) {
      setError('현재 프로젝트에서 업무를 찾을 수 없습니다. 작성한 입력을 확인해 주세요.');
      return;
    }
    const choices = allowedNextStatuses(snapshot, issue).filter(status => status.id !== issue.status);
    await refresh();
    setReview({ restoreGeneration: snapshot.restoreGeneration, schemaVersion: projectIssueSchema(snapshot, issue.projectId).version, edit: { issue, choices,
      current: statusMeta(snapshot, issue.projectId, issue.status), workflowVersion: projectWorkflow(snapshot, issue.projectId).version } });
    clearValidation();
    setRecovery(null);
    setSelected('');
    setReportedRequired([]);
    if (!choices.length) {
      setError('현재 업무에서 변경할 수 있는 상태가 없습니다. 작성한 입력을 확인해 주세요.');
      setShowDetails(true);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || pending.current) return;
    if (!restoreGeneration) {
      setRecovery('conflict');
      setError('현재 작업 공간을 확인하려면 최신 업무를 불러와 주세요.');
      return;
    }
    const note = commentDraftPayload(comment);
    pending.current = true;
    setBusy(true);
    clearValidation();
    try {
      const changes = Object.fromEntries(Object.entries(draftCustom).filter(([id, value]) => !sameProperty(value, storedCustom(id))));
      const attempt = { actorId, input: { requestId: newRequestId(), restoreGeneration, expectedVersion: edit.issue.version,
        expectedWorkflowVersion: edit.workflowVersion, status: selected, ...(assigneeId === undefined ? {} : { assigneeId }),
        ...(priority && priorityValue !== edit.issue.priority ? { priority: priorityValue } : {}),
        ...(dueDate ? { dueDate: dueDateValue } : {}),
        ...(description && descriptionValue !== edit.issue.description ? { description: descriptionValue } : {}),
        ...(Object.keys(changes).length ? { customFields: changes, expectedIssueSchemaVersion: schemaVersion } : {}),
        ...(note.body ? { comment: note } : {}) } };
      changeAttempt.current = attempt;
      await applyStatusChange(attempt);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { pending.current = false; setBusy(false); }
  }

  async function recover() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      if (recovery === 'verify' && changeAttempt.current) await applyStatusChange(changeAttempt.current);
      else if (recovery === 'refresh') await committed();
      else if (comment.body.trim() || hasPropertiesDraft) await reviewLatestWithDraft();
      else { await refresh(); onClose(); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { pending.current = false; setBusy(false); }
  }

  return <dialog ref={dialog} className="issue-status-dialog" aria-labelledby={heading} aria-busy={busy}
    onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={event => void submit(event)}>
      <header><h2 id={heading}>업무 상태 변경</h2>
        <button className="btn btn-ghost issue-icon-button" type="button" aria-label="상태 변경 닫기" disabled={busy} onClick={close}><X size={17} aria-hidden="true" /></button>
      </header>
      <div className="issue-status-dialog-body">
        <p><strong>{edit.issue.key}</strong> · {edit.issue.title}</p>
        <p>현재 상태 <span aria-hidden="true" className="issue-status-dot" style={{ background: edit.current.color }} />{edit.current.label}</p>
        <p>현재 담당자 {assigneeName(edit.issue.assigneeId)}</p>
        <label>변경할 상태
          <select ref={statusField} className="field" value={selected} required disabled={fieldsDisabled}
            onChange={event => { setSelected(event.currentTarget.value); setReportedRequired([]); clearValidation(); }}>
            <option value="" disabled>상태 선택</option>
            {edit.choices.map(status => <option key={status.id} value={status.id}>{status.label}</option>)}
          </select>
        </label>
        <label>담당자
          <select ref={assigneeField} className="field" value={assigneeOption} disabled={fieldsDisabled}
            aria-invalid={assigneeRequired || assigneeUnavailable || undefined}
            aria-describedby={assigneeRequired || assigneeUnavailable ? errorId : undefined}
            onChange={event => {
              const value = event.currentTarget.value;
              setAssigneeId(value === '' ? undefined : value === UNASSIGNED ? null : value.slice(USER_OPTION.length));
              clearValidation();
            }}>
            <option value="">자동 배정 규칙 따르기</option>
            <option value={UNASSIGNED}>미지정</option>
            {latest.users.map(user => <option key={user.id} value={`${USER_OPTION}${user.id}`}>{assigneeLabel(user)}</option>)}
            {assigneeUnavailable && <option value={assigneeOption} disabled>팀원 확인 불가</option>}
          </select>
        </label>
        <fieldset className="issue-status-properties" disabled={fieldsDisabled}>
          <legend>우선순위와 목표 마감일</legend>
          <label>우선순위
            <select className="field" value={priorityValue} onChange={event => changePriority(event.currentTarget.value as Issue['priority'])}>
              {Object.entries(PRIORITY).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          {priorityConflict && <PropertyConflict label="우선순위" saved={PRIORITY[edit.issue.priority]}
            onUseSaved={() => changePriority(edit.issue.priority)} onUseInput={() => changePriority(priorityValue, true)} />}
          <label>목표 마감일 처리
            <select className="field" value={dueDate?.mode ?? ''}
              aria-invalid={missingDueDate || undefined} aria-describedby={dueDateHint ? dueDateHintId : undefined}
              onChange={event => changeDueDate(event.currentTarget.value as DueDateDraft['mode'] | '')}>
              <option value="">{savedDueDate ? `${savedDueDate} 유지` : '현재 값과 자동 지정 규칙 적용'}</option>
              <option value="set">날짜 지정</option>
              <option value="clear">마감일 비우기</option>
            </select>
          </label>
          {dueDate?.mode === 'set' && <label>목표 마감일
            <input className="field" type="date" min={MIN_CALENDAR_DATE} max={MAX_CALENDAR_DATE} required value={dueDate.date}
              onChange={event => changeDueDate('set', event.currentTarget.value)} />
          </label>}
          {dueDateHint && <p id={dueDateHintId} role="status">{dueDateHint}</p>}
          {dueDateConflict && <PropertyConflict label="목표 마감일" saved={savedDueDate ?? '미지정'}
            onUseSaved={() => changeDueDate('')} onUseInput={() => { if (dueDate) changeDueDate(dueDate.mode, dueDate.date, true); }} />}
        </fieldset>
        {(description || missingDescription || propertyFields.length > 0 || unavailable.length > 0) &&
          <fieldset className="issue-status-properties" disabled={fieldsDisabled}>
            <legend>상태와 함께 저장할 속성</legend>
            {(description || missingDescription) && <>
              <label>업무 설명
                <textarea className="field" rows={3} maxLength={200000} required={required.has('description')} value={descriptionValue}
                  onChange={event => changeDescription(event.currentTarget.value)} />
              </label>
              {descriptionConflict && <PropertyConflict label="업무 설명" saved={edit.issue.description}
                onUseSaved={() => changeDescription(edit.issue.description)} onUseInput={() => changeDescription(descriptionValue, true)} />}
            </>}
            {propertyFields.map(field => {
              const draft = customFields[field.id];
              const saved = storedCustom(field.id);
              const compatible = draft?.kind === field.kind;
              return <div className="issue-status-property" key={field.id}>
                <span>{field.name}{customRequired(field) && <span aria-hidden="true"> *</span>}</span>
                <CustomFieldInput field={field} label={field.name} users={latest.users} value={customValue(field)}
                  required={customRequired(field)} onChange={value => changeCustom(field, value)} />
                {compatible && propertyConflict(draft, saved) && <PropertyConflict label={field.name} saved={fieldValueLabel(field, saved, latest.users)}
                  onUseSaved={() => forgetCustom(field.id)} onUseInput={() => changeCustom(field, draft.value, true)} />}
              </div>;
            })}
            {unavailable.map(([id, draft]) => <div className="issue-status-property-conflict" key={id}>
              <p>{draft.label}의 적용 조건 또는 형식이 바뀌었습니다.</p>
              <blockquote>{String(draft.value ?? '미지정')}</blockquote>
              <button className="btn btn-ghost" type="button" onClick={() => forgetCustom(id)}>{draft.label} 입력 지우기</button>
            </div>)}
          </fieldset>}
        <div className="issue-status-handoff">
          <label htmlFor={commentId}>인수인계 댓글 <span aria-hidden="true">(선택)</span></label>
          <CommentMentionInput id={commentId} className="field" rows={3} draft={comment} users={latest.users}
            readOnly={busy || recovery === 'verify' || recovery === 'refresh'} onChange={next => {
              setComment(next);
              if (!recovery) clearValidation();
            }} />
        </div>
        {(error || stale && !busy || assigneeUnavailable) && <p id={errorId} className="issue-form-error" role="alert">
          {error || (stale ? STALE : '선택한 팀원을 찾을 수 없습니다. 담당자를 다시 선택해 주세요.')}
        </p>}
        {showDetails && !busy && <button className="btn btn-ghost issue-status-dialog-details" type="button" onClick={onOpenDetails}>업무 상세에서 확인</button>}
      </div>
      <footer>
        <button className="btn btn-ghost" type="button" onClick={close} disabled={busy}>취소</button>
        {recovery || stale ? <button ref={recoverButton} className="btn btn-primary" type="button" disabled={busy} onClick={() => void recover()}>
          {recovery === 'verify' ? '저장 결과 다시 확인' : '최신 업무 불러오기'}
        </button> : <button className="btn btn-primary" type="submit" disabled={!canSubmit}>상태 변경 적용</button>}
      </footer>
    </form>
  </dialog>;
}
