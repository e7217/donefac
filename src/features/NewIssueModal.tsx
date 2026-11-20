'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { PRIORITY, type CustomFieldValue, type DocPage, type DocumentFollowUpResult, type FeatureProps, type Issue, type IssueStatus } from '../../shared/types';
import { projectStatuses, projectWorkflow, requiredFieldsFor, REQUIRED_FIELD_LABELS } from '../../shared/workflow-helpers';
import { requiredFieldLabels } from '../../shared/issue-schema';
import { MAX_PLANNED_EFFORT_MINUTES } from '../../shared/project-workload';
import { api, ApiError, post } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import { CustomFields, initialIssueType, IssueTypeSelect } from './CustomFields';
import { PlanningSelect } from './PlanningSelectors';
import { errorMessage } from './schedule-utils';
import './issues.css';

export type FollowUpSource = Pick<DocPage, 'id' | 'title' | 'version' | 'projectId'>;
type Props = Pick<FeatureProps, 'data' | 'projectId' | 'actorId' | 'refresh' | 'notify' | 'openIssue'> & {
  initialStatus?: IssueStatus;
  sourceDocument?: FollowUpSource;
  onClose: () => void;
};
type FollowUpAttempt = { actorId: string; body: string };
const uncertainCloseMessage = '업무가 이미 생성됐을 수 있습니다. 문서의 연결 목록에서 결과를 확인할 수 있습니다. 창을 닫을까요?';
const uncertainLeaveMessage = '업무가 이미 생성됐을 수 있습니다. 돌아와서 문서의 연결 목록을 확인할 수 있습니다. 이동할까요?';

export function NewIssueModal({ data, projectId, actorId, initialStatus, sourceDocument, onClose, refresh, notify, openIssue }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedProject, setSelectedProject] = useState(() => sourceDocument
    ? sourceDocument.projectId ?? ''
    : !projectId || projectId === 'all' ? data.projects[0]?.id || '' : projectId);
  const [selectedType, setSelectedType] = useState(() => initialIssueType(data, selectedProject));
  const [selectedStatus, setSelectedStatus] = useState(() => initialStatus && projectStatuses(data, selectedProject).some(status => status.id === initialStatus)
    ? initialStatus : projectWorkflow(data, selectedProject).initialStatusId);
  const [valuesByProject, setValuesByProject] = useState<Record<string, Record<string, CustomFieldValue>>>({});
  const [sourceVersion, setSourceVersion] = useState(sourceDocument?.version);
  const [recovering, setRecovering] = useState(false);
  const [replayRejected, setReplayRejected] = useState(false);
  const [versionConflict, setVersionConflict] = useState(false);
  const attempt = useRef<FollowUpAttempt | null>(null);
  const dirtyRef = useRef(false);
  const pendingRef = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const values = valuesByProject[selectedProject] || {};
  const states = projectStatuses(data, selectedProject);
  const required = requiredFieldsFor(data, selectedProject, selectedType, selectedStatus);
  const currentDocument = sourceDocument && data.documents.find(page => page.id === sourceDocument.id);
  const canReviewVersion = versionConflict && currentDocument && currentDocument.version !== sourceVersion;

  function close() {
    if (pendingRef.current) return;
    const uncertain = Boolean(attempt.current);
    if (uncertain) {
      if (!window.confirm(uncertainCloseMessage)) return;
    } else if (dirtyRef.current && !window.confirm('작성 중인 새 업무를 버리고 닫을까요?')) return;
    attempt.current = null;
    dirtyRef.current = false;
    onClose();
    if (uncertain) void refresh().catch(() => notify('연결 목록을 불러오지 못했습니다. 문서를 다시 열어 확인해 주세요.', 'error'));
  }

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pendingRef.current) {
        event.preventDefault();
        notify('업무 생성이 끝난 뒤 이동해 주세요.', 'error');
        return;
      }
      const confirmation = attempt.current ? uncertainLeaveMessage : dirtyRef.current ? '작성 중인 새 업무를 버리고 이동할까요?' : '';
      if (confirmation && !window.confirm(confirmation)) event.preventDefault();
      else afterAcceptedNavigation(event, () => { attempt.current = null; dirtyRef.current = false; onClose(); });
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current || pendingRef.current || attempt.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [notify, onClose]);

  function issuePayload(form: FormData) {
    return {
      projectId: selectedProject, title: String(form.get('title') || '').trim(), description: form.get('description'),
      type: selectedType, status: selectedStatus, priority: form.get('priority'), assigneeId: form.get('assigneeId') || null,
      startDate: form.get('startDate') || null, endDate: form.get('endDate') || null, dueDate: form.get('dueDate') || null,
      estimate: form.get('estimate') ? Number(form.get('estimate')) : null,
      plannedEffortMinutes: form.get('plannedEffortMinutes') ? Number(form.get('plannedEffortMinutes')) : null,
      labels: String(form.get('labels') || '').split(',').map(value => value.trim()).filter(Boolean),
      parentId: form.get('parentId') || null, collaboratorIds: form.getAll('collaboratorIds'),
      cycleId: form.get('cycleId') || null, moduleId: form.get('moduleId') || null, releaseId: form.get('releaseId') || null,
      customFields: values,
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current || !selectedProject || canReviewVersion || replayRejected) return;
    const replay = Boolean(attempt.current);
    const form = event.currentTarget;
    pendingRef.current = true;
    setBusy(true);
    setError('');
    let confirmed = false;
    try {
      if (sourceDocument) {
        const request = attempt.current ?? {
          actorId,
          body: JSON.stringify({ requestId: newRequestId(), expectedDocumentVersion: sourceVersion, issue: issuePayload(new FormData(form)) }),
        };
        attempt.current = request;
        const result = await api<DocumentFollowUpResult>(`/documents/${encodeURIComponent(sourceDocument.id)}/follow-up-issues`, {
          method: 'POST', headers: { 'X-Actor-Id': request.actorId }, body: request.body,
        });
        if (!result?.issue?.id || result.link?.issueId !== result.issue.id || result.link?.documentId !== sourceDocument.id) {
          throw new Error('업무 생성 응답을 읽을 수 없습니다.');
        }
        confirmed = true;
        await refresh();
        attempt.current = null;
        setRecovering(false);
        notify(`${result.issue.key} 후속 업무를 문서에 연결했습니다.`);
        dirtyRef.current = false;
        onClose();
      } else {
        const issue = await post<Issue>('/issues', issuePayload(new FormData(form)));
        dirtyRef.current = false;
        await refresh();
        notify('새 업무를 만들었습니다.');
        pendingRef.current = false;
        onClose();
        openIssue(issue.id);
      }
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : null;
      const definiteFailure = !confirmed && status !== null && status >= 400 && status < 500;
      if (attempt.current && !definiteFailure) {
        setRecovering(true);
        setError(confirmed ? '업무를 만들었습니다. 목록을 다시 불러와 연결 결과를 확인해 주세요.' : '업무 생성 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.');
        requestAnimationFrame(() => submitButton.current?.focus());
      } else {
        attempt.current = null;
        setRecovering(false);
        if (replay) {
          setReplayRejected(true);
          setError(`${errorMessage(cause)} 문서의 연결 목록을 확인해 주세요.`);
        } else if (sourceDocument && status === 409) {
          await refresh().catch(() => {});
          setVersionConflict(true);
          setError(errorMessage(cause));
        } else {
          setError(errorMessage(cause));
        }
      }
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  }

  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (!sourceDocument) return;
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
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <div className="issue-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialog} onKeyDown={keyboard} className="issue-create-modal" role="dialog" aria-modal="true" aria-labelledby="new-issue-title">
      <form onSubmit={submit} onChange={() => { dirtyRef.current = true; }}>
        <header><div>
          {!sourceDocument && <span className="feature-eyebrow">NEW ISSUE</span>}
          <h2 id="new-issue-title">{sourceDocument ? '후속 업무 만들기' : '새 업무 만들기'}</h2>
          {sourceDocument && <p className="issue-follow-up-source">연결할 문서 · <strong>{sourceDocument.title}</strong></p>}
        </div><button className="issue-icon-button" type="button" disabled={busy} onClick={close} aria-label="닫기"><X size={19} /></button></header>
        <fieldset disabled={busy || recovering} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="issue-create-fields">
            <label className="issue-form-label">프로젝트
              <select name="projectId" className="field" value={selectedProject} disabled={Boolean(sourceDocument?.projectId)} onChange={event => {
                const next = event.target.value;
                setSelectedProject(next);
                setSelectedType(initialIssueType(data, next));
                setSelectedStatus(projectWorkflow(data, next).initialStatusId);
              }} required>
                {sourceDocument && !sourceDocument.projectId && <option value="" disabled>프로젝트를 선택하세요</option>}
                {data.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
              </select>
            </label>
            <label className="issue-form-label">업무 제목<input autoFocus className="field issue-title-input" name="title" placeholder="무엇을 해야 하나요?" maxLength={300} required /></label>
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
            }} disabled={busy || recovering} requiredFields={required} />
            {required.length > 0 && <p className="issue-section-empty">필수 속성: {requiredFieldLabels(data, selectedProject, required).join(', ')}</p>}
            <details open={required.some(field => ['dueDate', 'estimate', 'labels', 'parentId', 'collaboratorIds', 'cycle', 'module', 'release'].includes(field))}>
              <summary className="issue-section-caption">추가 속성</summary>
              <div className="issue-form-grid">
                <label className="issue-form-label">목표 마감일<input className="field" type="date" name="dueDate" /></label>
                <label className="issue-form-label">예상 소요 (포인트)<input className="field" type="number" name="estimate" min="0" step="0.5" /></label>
                <label className="issue-form-label">계획 작업 시간 (분)<input className="field" type="number" name="plannedEffortMinutes" min={0} max={MAX_PLANNED_EFFORT_MINUTES} step={1} /></label>
                <label className="issue-form-label">라벨<input className="field" name="labels" placeholder="쉼표로 구분" /></label>
                <label className="issue-form-label">상위 업무<select className="field" name="parentId" key={selectedProject}><option value="">없음</option>{data.issues.filter(issue => issue.projectId === selectedProject).map(issue => <option key={issue.id} value={issue.id}>{issue.key} · {issue.title}</option>)}</select></label>
                {(['cycle', 'module', 'release'] as const).map(field => <label className="issue-form-label" key={field}>{REQUIRED_FIELD_LABELS[field]}<PlanningSelect data={data} projectId={selectedProject} kind={field} name={`${field}Id`} /></label>)}
                <label className="issue-form-label">참여자<select className="field" name="collaboratorIds" multiple>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
              </div>
            </details>
            {!sourceDocument && error && <div className="issue-form-error" role="alert">{error}</div>}
          </div>
        </fieldset>
        {sourceDocument && error && <div className="issue-follow-up-error">
          <div className="issue-form-error" role="alert">{error}</div>
          {canReviewVersion && <button type="button" className="btn" disabled={busy} onClick={() => {
            setSourceVersion(currentDocument.version);
            setVersionConflict(false);
            setError('');
          }}>최신 문서 버전 {currentDocument.version} 사용</button>}
        </div>}
        <footer>
          <span className="muted">{sourceDocument ? '생성한 업무는 문서의 연결 목록에서 열 수 있어요.' : '상세 속성은 생성 후에도 수정할 수 있어요.'}</span>
          <button className="btn btn-ghost" type="button" disabled={busy} onClick={close}>취소</button>
          <button ref={submitButton} className="btn btn-primary" type="submit" disabled={busy || !selectedProject || !selectedType || Boolean(canReviewVersion) || replayRejected}>
            {busy ? '만드는 중…' : recovering ? '업무 생성 결과 다시 확인' : <><Plus size={16} /> {sourceDocument ? '업무 만들고 연결' : '업무 만들기'}</>}
          </button>
        </footer>
      </form>
    </section>
  </div>;
}
