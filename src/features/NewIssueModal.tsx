'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { PRIORITY, type CustomFieldValue, type DocPage, type DocumentFollowUpResult, type DocumentSourceSelection, type FeatureProps, type Issue, type IssueChildCreationResult, type IssueStatus, type WorkspaceSnapshot } from '../../shared/types';
import { projectStatuses, projectWorkflow, requiredFieldsFor, REQUIRED_FIELD_LABELS } from '../../shared/workflow-helpers';
import { requiredFieldLabels } from '../../shared/issue-schema';
import { MAX_PLANNED_EFFORT_MINUTES } from '../../shared/project-workload';
import { api, ApiError } from '../lib/api';
import { createIssueAttempt, isDefiniteIssueCreationFailure, requestIssueCreation, type IssueCreationAttempt } from '../lib/issue-creation';
import { afterAcceptedNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import { CustomFields, initialIssueType, IssueTypeSelect } from './CustomFields';
import { PlanningSelect } from './PlanningSelectors';
import { errorMessage } from './schedule-utils';
import './issues.css';

export type FollowUpSource = Pick<DocPage, 'id' | 'title' | 'version' | 'projectId'> & { sourceSelection?: DocumentSourceSelection };
type ParentIssue = Pick<Issue, 'id' | 'key' | 'title' | 'projectId' | 'version'>;
type Props = Pick<FeatureProps, 'data' | 'projectId' | 'actorId' | 'refresh' | 'notify' | 'openIssue'> & {
  initialStatus?: IssueStatus;
  onClose: () => void;
} & ({ sourceDocument?: FollowUpSource; parentIssue?: never } | { sourceDocument?: never; parentIssue: ParentIssue });
type ParentReview = { state: 'available'; issue: ParentIssue } | { state: 'missing' | 'moved' | 'failed' };

export function NewIssueModal({ data, projectId, actorId, initialStatus, sourceDocument, parentIssue, onClose, refresh, notify, openIssue }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedProject, setSelectedProject] = useState(() => {
    if (parentIssue) return parentIssue.projectId;
    if (sourceDocument) return sourceDocument.projectId ?? '';
    return !projectId || projectId === 'all' ? data.projects[0]?.id || '' : projectId;
  });
  const [selectedType, setSelectedType] = useState(() => initialIssueType(data, selectedProject));
  const [selectedStatus, setSelectedStatus] = useState(() => initialStatus && projectStatuses(data, selectedProject).some(status => status.id === initialStatus)
    ? initialStatus : projectWorkflow(data, selectedProject).initialStatusId);
  const [valuesByProject, setValuesByProject] = useState<Record<string, Record<string, CustomFieldValue>>>({});
  const [sourceVersion, setSourceVersion] = useState(sourceDocument?.version);
  const [sourceSelection, setSourceSelection] = useState(sourceDocument?.sourceSelection);
  const [reviewedParent, setReviewedParent] = useState(parentIssue);
  const [parentReview, setParentReview] = useState<ParentReview | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [replayRejected, setReplayRejected] = useState(false);
  const [versionConflict, setVersionConflict] = useState(false);
  const attempt = useRef<IssueCreationAttempt | null>(null);
  const dirtyRef = useRef(false);
  const pendingRef = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const values = valuesByProject[selectedProject] || {};
  const states = projectStatuses(data, selectedProject);
  const required = requiredFieldsFor(data, selectedProject, selectedType, selectedStatus);
  const currentDocument = sourceDocument && data.documents.find(page => page.id === sourceDocument.id);
  const canReviewVersion = versionConflict && currentDocument && (Boolean(sourceSelection) || currentDocument.version !== sourceVersion);
  const needsSourceReview = Boolean(canReviewVersion || (versionConflict && sourceSelection));
  const childMode = Boolean(parentIssue);
  const linkedPath = reviewedParent ? `/issues/${encodeURIComponent(reviewedParent.id)}/children`
    : sourceDocument ? `/documents/${encodeURIComponent(sourceDocument.id)}/follow-up-issues` : undefined;
  const linkedCreation = Boolean(linkedPath);
  const currentParent = reviewedParent && data.issues.find(issue => issue.id === reviewedParent.id);
  const parentUnavailable = reviewedParent && (!currentParent || currentParent.projectId !== reviewedParent.projectId);
  const needsParentReview = Boolean(parentReview || parentUnavailable);
  const linkedError = error || (parentUnavailable ? '현재 프로젝트에서 상위 업무를 찾을 수 없습니다.' : '');
  const confirmationLocation = childMode ? '상위 업무의 하위 목록' : sourceDocument ? '문서의 연결 목록' : '업무 목록';
  const fieldsLocked = busy || recovering || (!linkedCreation && replayRejected);
  const refreshAfterClose = useCallback(() => {
    void refresh().catch(() => notify(childMode
      ? '하위 업무 목록을 불러오지 못했습니다. 상위 업무를 다시 열어 확인해 주세요.'
      : sourceDocument ? '연결 목록을 불러오지 못했습니다. 문서를 다시 열어 확인해 주세요.'
      : '업무 목록을 불러오지 못했습니다. 목록을 다시 열어 확인해 주세요.', 'error'));
  }, [childMode, sourceDocument, refresh, notify]);

  function close() {
    if (pendingRef.current) return;
    const uncertain = Boolean(attempt.current);
    if (uncertain) {
      if (!window.confirm(`업무가 이미 생성됐을 수 있습니다. ${confirmationLocation}에서 결과를 확인할 수 있습니다. 창을 닫을까요?`)) return;
    } else if (dirtyRef.current && !window.confirm('작성 중인 새 업무를 버리고 닫을까요?')) return;
    attempt.current = null;
    dirtyRef.current = false;
    onClose();
    if (uncertain) refreshAfterClose();
  }

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pendingRef.current) {
        event.preventDefault();
        notify('업무 생성이 끝난 뒤 이동해 주세요.', 'error');
        return;
      }
      const uncertain = Boolean(attempt.current);
      const confirmation = uncertain
        ? `업무가 이미 생성됐을 수 있습니다. 돌아와서 ${confirmationLocation}을 확인할 수 있습니다. 이동할까요?`
        : dirtyRef.current ? '작성 중인 새 업무를 버리고 이동할까요?' : '';
      if (confirmation && !window.confirm(confirmation)) event.preventDefault();
      else afterAcceptedNavigation(event, () => {
        attempt.current = null;
        dirtyRef.current = false;
        onClose();
        if (uncertain && !linkedCreation) refreshAfterClose();
      });
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current || pendingRef.current || attempt.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('teamspace:navigate', guard, childMode);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard, childMode);
      window.removeEventListener('beforeunload', unload);
    };
  }, [childMode, confirmationLocation, linkedCreation, notify, onClose, refreshAfterClose]);

  useEffect(() => {
    if (childMode && busy) dialog.current?.focus({ preventScroll: true });
  }, [busy, childMode]);

  function issuePayload(form: FormData) {
    return {
      projectId: selectedProject, title: String(form.get('title') || '').trim(), description: form.get('description'),
      type: selectedType, status: selectedStatus, priority: form.get('priority'), assigneeId: form.get('assigneeId') || null,
      startDate: form.get('startDate') || null, endDate: form.get('endDate') || null, dueDate: form.get('dueDate') || null,
      estimate: form.get('estimate') ? Number(form.get('estimate')) : null,
      plannedEffortMinutes: form.get('plannedEffortMinutes') ? Number(form.get('plannedEffortMinutes')) : null,
      labels: String(form.get('labels') || '').split(',').map(value => value.trim()).filter(Boolean),
      parentId: reviewedParent?.id ?? (form.get('parentId') || null), collaboratorIds: form.getAll('collaboratorIds'),
      cycleId: form.get('cycleId') || null, moduleId: form.get('moduleId') || null, releaseId: form.get('releaseId') || null,
      customFields: values,
    };
  }

  async function readParentReview(parent: ParentIssue) {
    try {
      const snapshot = await api<WorkspaceSnapshot>('/workspace', { cache: 'no-store' });
      const latest = snapshot.issues.find(issue => issue.id === parent.id);
      if (!latest) {
        setParentReview({ state: 'missing' });
        setError('상위 업무를 찾을 수 없습니다.');
      } else if (latest.projectId !== parent.projectId) {
        setParentReview({ state: 'moved' });
        setError('상위 업무가 다른 프로젝트로 이동했습니다.');
      } else if (latest.version !== parent.version) {
        setParentReview({ state: 'available', issue: latest });
        setError('상위 업무가 변경됐습니다. 최신 상위 업무를 확인해 주세요.');
      } else {
        throw new Error('상위 업무 버전이 갱신되지 않았습니다.');
      }
    } catch {
      setParentReview({ state: 'failed' });
      setError('최신 상위 업무를 불러오지 못했습니다.');
    }
  }

  async function reloadParentReview() {
    if (!reviewedParent || pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    try { await readParentReview(reviewedParent); }
    finally { pendingRef.current = false; setBusy(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current || !selectedProject || needsSourceReview || needsParentReview || replayRejected) return;
    const replay = Boolean(attempt.current);
    const form = event.currentTarget;
    pendingRef.current = true;
    setBusy(true);
    setError('');
    let confirmed = false;
    try {
      if (linkedPath) {
        const request = attempt.current ?? {
          actorId,
          body: JSON.stringify({
            requestId: newRequestId(),
            ...(reviewedParent ? { expectedParentVersion: reviewedParent.version } : { expectedDocumentVersion: sourceVersion, sourceSelection }),
            issue: issuePayload(new FormData(form)),
          }),
        };
        attempt.current = request;
        const result = await api<DocumentFollowUpResult | IssueChildCreationResult>(linkedPath, {
          method: 'POST', headers: { 'X-Actor-Id': request.actorId }, body: request.body,
        });
        if (!result?.issue?.id ||
          (reviewedParent && (result.issue.parentId !== reviewedParent.id || result.issue.projectId !== reviewedParent.projectId)) ||
          (sourceDocument && (!('link' in result) || result.link?.issueId !== result.issue.id || result.link?.documentId !== sourceDocument.id))) {
          throw new Error('업무 생성 응답을 읽을 수 없습니다.');
        }
        confirmed = true;
        await refresh();
        attempt.current = null;
        setRecovering(false);
        notify(reviewedParent ? `${result.issue.key} 하위 업무를 만들었습니다.` : `${result.issue.key} 후속 업무를 문서에 연결했습니다.`);
        dirtyRef.current = false;
        onClose();
      } else {
        const request = attempt.current ?? createIssueAttempt(actorId, issuePayload(new FormData(form)));
        attempt.current = request;
        const issue = await requestIssueCreation(request, selectedProject);
        confirmed = true;
        await refresh();
        attempt.current = null;
        dirtyRef.current = false;
        notify('새 업무를 만들었습니다.');
        pendingRef.current = false;
        onClose();
        openIssue(issue.id);
      }
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : null;
      const details = cause instanceof ApiError ? cause.details as { currentVersion?: unknown; reason?: unknown } | undefined : undefined;
      const definiteFailure = !confirmed && (linkedCreation
        ? status !== null && status >= 400 && status < 500 && (!childMode || (status !== 408 && status !== 429))
        : isDefiniteIssueCreationFailure(cause, replay));
      if (attempt.current && !definiteFailure) {
        setRecovering(true);
        if (confirmed) {
          setError(childMode ? '하위 업무를 만들었습니다. 목록을 다시 불러와 결과를 확인해 주세요.'
            : sourceDocument ? '업무를 만들었습니다. 목록을 다시 불러와 연결 결과를 확인해 주세요.'
            : '업무를 만들었습니다. 목록을 다시 불러와 결과를 확인해 주세요.');
        } else {
          setError(!linkedCreation && replay && (status === 401 || status === 403)
            ? '팀 접속을 확인한 뒤 같은 요청으로 결과를 다시 확인해 주세요.'
            : '업무 생성 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.');
        }
        requestAnimationFrame(() => submitButton.current?.focus());
      } else {
        if (!replay || linkedCreation) attempt.current = null;
        setRecovering(false);
        if (replay) {
          setReplayRejected(true);
          setError(linkedCreation ? `${errorMessage(cause)} ${confirmationLocation}을 확인해 주세요.` : errorMessage(cause));
          if (!linkedCreation) requestAnimationFrame(() => closeButton.current?.focus({ preventScroll: true }));
        } else if (reviewedParent && status === 404 && details?.reason === 'parent_missing') {
          setParentReview({ state: 'missing' });
          setError(errorMessage(cause));
        } else if (reviewedParent && status === 409 && Number.isSafeInteger(details?.currentVersion)) {
          await readParentReview(reviewedParent);
        } else if (sourceDocument && status === 409) {
          await refresh().catch(() => {});
          setVersionConflict(true);
          setError(errorMessage(cause));
        } else {
          setError(errorMessage(cause));
          if (!linkedCreation) requestAnimationFrame(() => submitButton.current?.focus());
        }
      }
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  }

  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (!linkedCreation) return;
    if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') close();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary') ?? [])
      .filter(element => element.getClientRects().length > 0);
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0], last = controls[controls.length - 1];
    if (document.activeElement === dialog.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <div className="issue-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialog} tabIndex={childMode ? -1 : undefined} onKeyDown={keyboard} className="issue-create-modal" role="dialog" aria-modal="true" aria-labelledby="new-issue-title">
      <form onSubmit={submit} onChange={() => { dirtyRef.current = true; }}>
        <header><div>
          {!linkedCreation && <span className="feature-eyebrow">NEW ISSUE</span>}
          <h2 id="new-issue-title">{childMode ? '하위 업무 만들기' : sourceDocument ? '후속 업무 만들기' : '새 업무 만들기'}</h2>
          {sourceDocument && <p className="issue-follow-up-source">연결할 문서 · <strong>{sourceDocument.title}</strong></p>}
          {reviewedParent && <p className="issue-follow-up-source">상위 업무 · <strong>{reviewedParent.key} {reviewedParent.title}</strong></p>}
        </div><button ref={closeButton} className="issue-icon-button" type="button" disabled={busy} onClick={close} aria-label="닫기"><X size={19} /></button></header>
        {sourceSelection && <section className="issue-follow-up-passage" aria-label="선택한 본문">
          <strong>선택한 본문</strong>
          <blockquote>{sourceSelection.text}</blockquote>
        </section>}
        <fieldset disabled={fieldsLocked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="issue-create-fields">
            <label className="issue-form-label">프로젝트
              <select name="projectId" className="field" value={selectedProject} disabled={childMode || Boolean(sourceDocument?.projectId)} onChange={event => {
                const next = event.target.value;
                setSelectedProject(next);
                setSelectedType(initialIssueType(data, next));
                setSelectedStatus(projectWorkflow(data, next).initialStatusId);
              }} required>
                {sourceDocument && !sourceDocument.projectId && <option value="" disabled>프로젝트를 선택하세요</option>}
                {data.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
              </select>
            </label>
            <label className="issue-form-label">업무 제목<input ref={titleInput} autoFocus className="field issue-title-input" name="title" placeholder="무엇을 해야 하나요?" maxLength={300} required /></label>
            <label className="issue-form-label">설명<textarea className="field" name="description" placeholder="배경, 목표, 완료 조건을 적어주세요." rows={4} /></label>
            <div className="issue-form-grid">
              <label className="issue-form-label">유형<IssueTypeSelect data={data} projectId={selectedProject} value={selectedType} onChange={setSelectedType} name="type" /></label>
              <label className="issue-form-label">상태<select name="status" aria-label="새 업무 상태" className="field" value={selectedStatus} onChange={event => setSelectedStatus(event.target.value)}>{states.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
              <label className="issue-form-label">우선순위<select name="priority" className="field" defaultValue="medium">{Object.entries(PRIORITY).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
              <label className="issue-form-label">담당자<select className="field" name="assigneeId"><option value="">미지정</option>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
              <label className="issue-form-label">시작일<input type="date" name="startDate" className="field" /></label>
              <label className="issue-form-label">종료일<input type="date" name="endDate" className="field" /></label>
            </div>
            <CustomFields data={data} projectId={selectedProject} issueType={selectedType} status={selectedStatus} values={values} onChange={next => {
              dirtyRef.current = true;
              setValuesByProject(previous => ({ ...previous, [selectedProject]: next }));
            }} disabled={fieldsLocked} requiredFields={required} />
            {required.length > 0 && <p className="issue-section-empty">필수 속성: {requiredFieldLabels(data, selectedProject, required).join(', ')}</p>}
            <details open={required.some(field => ['dueDate', 'estimate', 'labels', 'collaboratorIds', 'cycle', 'module', 'release'].includes(field) || (field === 'parentId' && !childMode))}>
              <summary className="issue-section-caption">추가 속성</summary>
              <div className="issue-form-grid">
                <label className="issue-form-label">목표 마감일<input className="field" type="date" name="dueDate" /></label>
                <label className="issue-form-label">예상 소요 (포인트)<input className="field" type="number" name="estimate" min="0" step="0.5" /></label>
                <label className="issue-form-label">계획 작업 시간 (분)<input className="field" type="number" name="plannedEffortMinutes" min={0} max={MAX_PLANNED_EFFORT_MINUTES} step={1} /></label>
                <label className="issue-form-label">라벨<input className="field" name="labels" placeholder="쉼표로 구분" /></label>
                {!childMode && <label className="issue-form-label">상위 업무<select className="field" name="parentId" key={selectedProject}><option value="">없음</option>{data.issues.filter(issue => issue.projectId === selectedProject).map(issue => <option key={issue.id} value={issue.id}>{issue.key} · {issue.title}</option>)}</select></label>}
                {(['cycle', 'module', 'release'] as const).map(field => <label className="issue-form-label" key={field}>{REQUIRED_FIELD_LABELS[field]}<PlanningSelect data={data} projectId={selectedProject} kind={field} name={`${field}Id`} /></label>)}
                <label className="issue-form-label">참여자<select className="field" name="collaboratorIds" multiple>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
              </div>
            </details>
            {!linkedCreation && error && <div className="issue-form-error" role="alert">{error}</div>}
          </div>
        </fieldset>
        {linkedCreation && linkedError && <div className="issue-follow-up-error">
          <div className="issue-form-error" role="alert">{linkedError}</div>
          {canReviewVersion && <button type="button" className="btn" disabled={busy} onClick={() => {
            setSourceVersion(currentDocument.version);
            setSourceSelection(undefined);
            setVersionConflict(false);
            setError('');
          }}>{sourceSelection ? '인용 없이 최신 문서 사용' : `최신 문서 버전 ${currentDocument.version} 사용`}</button>}
          {parentReview?.state === 'available' && <>
            <span className="issue-follow-up-source">{parentReview.issue.key} {parentReview.issue.title} · 버전 {parentReview.issue.version}</span>
            <button type="button" className="btn" disabled={busy} onClick={() => {
              setReviewedParent(parentReview.issue);
              setParentReview(null);
              setError('');
              titleInput.current?.focus({ preventScroll: true });
            }}>최신 상위 업무 사용</button>
          </>}
          {parentReview?.state === 'failed' && <button type="button" className="btn" disabled={busy} onClick={() => void reloadParentReview()}>상위 업무 다시 불러오기</button>}
        </div>}
        <footer>
          <span className="muted">{sourceDocument ? '생성한 업무는 문서의 연결 목록에서 열 수 있어요.' : childMode ? '생성한 업무는 상위 업무의 하위 목록에서 열 수 있어요.' : '상세 속성은 생성 후에도 수정할 수 있어요.'}</span>
          <button className="btn btn-ghost" type="button" disabled={busy} onClick={close}>취소</button>
          <button ref={submitButton} className="btn btn-primary" type="submit" disabled={busy || !selectedProject || !selectedType || needsSourceReview || needsParentReview || replayRejected}>
            {busy ? '만드는 중…' : recovering ? '업무 생성 결과 다시 확인' : <><Plus size={16} /> {sourceDocument ? '업무 만들고 연결' : childMode ? '하위 업무 만들기' : '업무 만들기'}</>}
          </button>
        </footer>
      </form>
    </section>
  </div>;
}
