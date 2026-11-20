'use client';

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronRight, Clock3, FileText, GitMerge, Link2, MessageSquare, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { PRIORITY, type Comment, type Dependency, type FeatureProps, type Issue, type ResourceLink, type WorkspaceSnapshot } from '../../shared/types';
import { api, ApiError, patch, post, relativeTime, remove } from '../lib/api';
import { allowedNextStatuses, requiredFieldsFor, statusMeta } from '../../shared/workflow-helpers';
import { IssueTypeIcon } from './Issues';
import { PlanningSelect } from './PlanningSelectors';
import { issueTypeMeta, requiredFieldLabels } from '../../shared/issue-schema';
import { MAX_PLANNED_EFFORT_MINUTES } from '../../shared/project-workload';
import { CustomFields, IssueTypeSelect } from './CustomFields';
import { NewIssueModal } from './NewIssueModal';
import { SourceOrigins } from './SourceOrigins';
import { IssueRelations } from './IssueRelations';
import { Attachments } from './Attachments';
import { COMMENT_LIST_CHANGED, CommentTrashButton } from './CommentTrashButton';
import { IssueWorklogs } from './IssueWorklogs';
import { TimeReservations } from './TimeReservations';
import { GitlabActivityList, GitlabActivityRefresh } from './GitlabActivity';
import { NotificationSubscriptionButton } from './NotificationSubscriptionButton';
import { AtlassianLinks } from './AtlassianLinks';
import { afterAcceptedNavigation } from '../lib/navigation';
import { dependencyLabel, errorMessage } from './schedule-utils';
import { GanttDependencyModal, type DependencyInput, type RelatedIssueDirection } from './GanttDependencyModal';
import './issues.css';
import './issue-decision-source.css';

const DocumentDecisionRevision = lazy(() => import('./DocumentBlocks').then(module => ({ default: module.DocumentDecisionRevision })));
type IssueDependencyEditor = { otherRole: RelatedIssueDirection; dependency?: Dependency };

function editableIssue(issue: Issue, labels: string) {
  return { title: issue.title.trim(), description: issue.description, type: issue.type, status: issue.status, priority: issue.priority, assigneeId: issue.assigneeId, collaboratorIds: issue.collaboratorIds, parentId: issue.parentId, labels: [...new Set(labels.split(',').map(value => value.trim()).filter(Boolean))], startDate: issue.startDate, endDate: issue.endDate, dueDate: issue.dueDate, estimate: issue.estimate, plannedEffortMinutes: issue.plannedEffortMinutes ?? null, cycleId: issue.cycleId ?? null, moduleId: issue.moduleId ?? null, releaseId: issue.releaseId ?? null, customFields: issue.customFields || {} };
}

export function IssuePanel(props: FeatureProps & { issueId: string; onClose: () => void }) {
  return <IssuePanelContent key={`${props.issueId}:${props.actorId}`} {...props} />;
}

function IssuePanelContent(props: FeatureProps & { issueId: string; onClose: () => void }) {
  const { data, issueId, onClose, refresh, notify, openIssue, openDocument } = props;
  const issue = data.issues.find(i => i.id === issueId);
  const [draft, setDraft] = useState<Issue | undefined>(issue);
  const [baseDraft, setBaseDraft] = useState<Issue | undefined>(issue);
  const [labels, setLabels] = useState(issue?.labels.join(', ') || '');
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentBody, setCommentBody] = useState('');
  const [loadingComments, setLoadingComments] = useState(true);
  const [commentError, setCommentError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [commenting, setCommenting] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [childCreation, setChildCreation] = useState<Pick<Issue, 'id' | 'key' | 'title' | 'projectId' | 'version'> | null>(null);
  const childCreationTrigger = useRef<HTMLButtonElement>(null);
  const closeChildCreation = useCallback(() => {
    setChildCreation(null);
    requestAnimationFrame(() => childCreationTrigger.current?.focus({ preventScroll: true }));
  }, []);
  const [dependencyEditor, setDependencyEditor] = useState<IssueDependencyEditor | null>(null);
  const [dependencyBusy, setDependencyBusy] = useState(false);
  const dependencyBusyRef = useRef(false);
  const dependencyDraftRef = useRef(false);
  const dependencyOpener = useRef<HTMLButtonElement | null>(null);
  const addPredecessorButton = useRef<HTMLButtonElement>(null);
  const trackDependencyDraft = useCallback((_id: string, dirty: boolean) => { dependencyDraftRef.current = dirty; }, []);
  const closeDependencyEditor = useCallback(() => {
    const opener = dependencyOpener.current;
    setDependencyEditor(null);
    requestAnimationFrame(() => (opener?.isConnected ? opener : addPredecessorButton.current)?.focus({ preventScroll: true }));
  }, []);
  const [tab, setTab] = useState<'details' | 'activity' | 'source' | 'worklogs' | 'reservations'>('details');
  const [documentId, setDocumentId] = useState('');
  const [linking, setLinking] = useState(false);
  const [loadedVersion, setLoadedVersion] = useState(issue?.version);
  const dirty = Boolean(draft && baseDraft && JSON.stringify(editableIssue(draft, labels)) !== JSON.stringify(editableIssue(baseDraft, baseDraft.labels.join(', '))));
  const dirtyRef = useRef(false);
  const childDraft = useRef<{dirty:boolean;pending:boolean;discard:()=>void;label?:string} | null>(null);
  const trackChildDraft = useCallback((dirty: boolean, pending: boolean, discard: () => void) => {
    childDraft.current = dirty || pending ? {dirty,pending,discard} : null;
  }, []);
  const trackRelationDraft = useCallback((dirty: boolean, pending: boolean, discard: () => void) => {
    childDraft.current = dirty || pending ? { dirty, pending, discard, label: '업무 관계 입력' } : null;
  }, []);
  function switchTab(next: typeof tab) {
    if (next === tab) return;
    const editingReservations = tab === 'reservations';
    const label = childDraft.current?.label;
    if (childDraft.current?.pending) { notify(label ? '업무 관계 저장이 끝난 뒤 이동해 주세요.' : editingReservations ? '시간 배정 저장이 끝난 뒤 이동해 주세요.' : '작업 시간 저장이 끝난 뒤 이동해 주세요.', 'error'); return; }
    if (childDraft.current?.dirty && !window.confirm(`작성 중인 ${label ?? (editingReservations ? '시간 배정 입력' : '작업 시간 기록')}을 버리고 이동할까요?`)) return;
    childDraft.current?.discard();
    setTab(next);
  }
  useEffect(() => { dirtyRef.current = dirty || Boolean(commentBody.trim()); }, [dirty, commentBody]);
  if (loadedVersion !== issue?.version) {
    setLoadedVersion(issue?.version);
    if (!dirty) { setDraft(issue); setBaseDraft(issue); setLabels(issue?.labels.join(', ') || ''); setError(''); setConflict(false); setDeleteConfirm(false); }
  }
  const confirmDiscard = useCallback(() => {
    if (savingRef.current) { notify('저장이 끝난 후 이동해주세요.', 'error'); return false; }
    if (!dirtyRef.current) return true;
    if (!window.confirm('저장하지 않은 업무 변경사항이나 작성 중인 댓글이 있습니다. 내용을 버리고 이동할까요?')) return false;
    dirtyRef.current = false;
    return true;
  }, [notify]);
  const closePanel = useCallback(() => { onClose(); }, [onClose]);
  const navigateIssue = (id: string) => { if (id !== issueId) openIssue(id); };
  const navigateDocument = (id: string) => { openDocument(id); };
  useEffect(() => {
    const navigate = (event: Event) => {
      if (event.defaultPrevented) return;
      const activeDraft = childDraft.current;
      if (savingRef.current || activeDraft?.pending || dependencyBusyRef.current) {
        event.preventDefault();
        notify('저장이 끝난 후 이동해주세요.', 'error');
      } else if (dirtyRef.current || activeDraft?.dirty || dependencyDraftRef.current) {
        const childName = dependencyDraftRef.current ? '업무 연결 입력' : activeDraft?.label ?? (tab === 'reservations' ? '시간 배정 입력' : '작업 시간 기록');
        const message = activeDraft?.dirty || dependencyDraftRef.current ? `저장하지 않은 업무·댓글·${childName}을 버리고 이동할까요?`
          : '저장하지 않은 업무 변경사항이나 작성 중인 댓글이 있습니다. 내용을 버리고 이동할까요?';
        if (!window.confirm(message)) event.preventDefault();
        else afterAcceptedNavigation(event, () => {
          activeDraft?.discard();
          setDependencyEditor(null);
          dirtyRef.current = false;
          setDraft(issue); setBaseDraft(issue); setLabels(issue?.labels.join(', ') || '');
          setCommentBody(''); setError(''); setConflict(false);
        });
      }
    };
    const leave = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !savingRef.current && !childDraft.current && !dependencyDraftRef.current && !dependencyBusyRef.current) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('teamspace:navigate', navigate); window.addEventListener('beforeunload', leave);
    return () => { window.removeEventListener('teamspace:navigate', navigate); window.removeEventListener('beforeunload', leave); };
  }, [issue, notify, tab]);
  useEffect(() => {
    let activeRequest: AbortController | undefined;
    const loadComments = () => {
      activeRequest?.abort();
      const request = new AbortController();
      activeRequest = request;
      void api<Comment[]>(`/comments?resourceType=issue&resourceId=${encodeURIComponent(issueId)}`, {
        signal: request.signal, headers: { 'X-Actor-Id': props.actorId },
      }).then(value => { if (!request.signal.aborted) { setComments(value); setCommentError(''); } })
        .catch(err => { if (!request.signal.aborted) setCommentError(errorMessage(err)); })
        .finally(() => { if (!request.signal.aborted) setLoadingComments(false); });
    };
    loadComments();
    window.addEventListener(COMMENT_LIST_CHANGED, loadComments);
    window.addEventListener('teamspace:trash-changed', loadComments);
    window.addEventListener('teamspace:workspace-imported', loadComments);
    return () => {
      activeRequest?.abort();
      window.removeEventListener(COMMENT_LIST_CHANGED, loadComments);
      window.removeEventListener('teamspace:trash-changed', loadComments);
      window.removeEventListener('teamspace:workspace-imported', loadComments);
    };
  }, [issueId, props.actorId]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !saving && !childCreation && !dependencyEditor && !dependencyBusyRef.current) closePanel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [closePanel, saving, childCreation, dependencyEditor]);
  if (!issue || !draft) return <div className="issue-panel-backdrop"><aside className="issue-detail-panel"><button className="issue-icon-button" onClick={closePanel} aria-label="닫기"><X /></button><div className="issue-empty">업무를 찾을 수 없습니다.</div></aside></div>;
  const linkedDocuments = data.resourceLinks.filter(l => l.issueId === issueId);
  const availableDocuments = data.documents.filter(d => !linkedDocuments.some(l => l.documentId === d.id));
  const gitlabLinks = data.gitlabLinks.filter(l => l.issueId === issueId);
  const activities = data.activities.filter(a => a.resourceId === issueId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const children = data.issues.filter(i => i.parentId === issueId).map(child => ({
    child, status: statusMeta(data, child.projectId, child.status),
  }));
  const completedChildren = children.filter(({ status }) => status.category === 'done').length;
  const nextStatuses = allowedNextStatuses(data, {projectId:draft.projectId,status:baseDraft?.status || draft.status,type:draft.type});
  const requiredFields = requiredFieldsFor(data,draft.projectId,draft.type,draft.status,baseDraft?.status);
  const dependencies = data.dependencies.filter(d => d.predecessorId === issueId || d.successorId === issueId);
  const hasOtherIssueInProject = data.issues.some(value => value.projectId === issue.projectId && value.id !== issueId);
  const editingDependency = dependencyEditor?.dependency;
  const latestDependency = editingDependency && dependencies.find(value => value.id === editingDependency.id);
  const staleDependencyMessage = editingDependency && (!latestDependency
    ? '이 연결이 더 이상 존재하지 않습니다. 편집을 닫고 현재 목록을 확인하세요.'
    : (latestDependency.version ?? 1) !== (editingDependency.version ?? 1)
      ? '다른 작업자가 이 연결을 변경했습니다. 편집을 닫고 다시 열어 최신 연결을 확인하세요.' : undefined);
  function update<K extends keyof Issue>(key: K, value: Issue[K]) { setDraft(previous => previous ? { ...previous, [key]: value } : previous); }
  function updatePlanning(kind: 'cycle' | 'module' | 'release', id: string | null) { setDraft(previous => previous ? { ...previous, [`${kind}Id`]: id, [kind]: data.planningItems?.find(item => item.id === id)?.name || null } : previous); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || !issue || savingRef.current || dependencyBusyRef.current || childDraft.current?.pending) return; savingRef.current = true; setSaving(true); setError('');
    try {
      const updated = await patch<Issue>(`/issues/${issueId}`, { expectedVersion: draft.version, ...editableIssue(draft, labels) });
      setDraft(updated); setBaseDraft(updated); setLabels(updated.labels.join(', ')); setConflict(false); dirtyRef.current = false;
      await refresh(); notify(`${issue.key} 변경사항을 저장했습니다.`);
    } catch (err) { setError(errorMessage(err)); if (err instanceof ApiError && err.status === 409) { setConflict(true); await refresh().catch(() => undefined); } } finally { savingRef.current = false; setSaving(false); }
  }
  async function reloadLatest() {
    const hadUnsaved = dirtyRef.current;
    if (!confirmDiscard()) return;
    savingRef.current = true; setSaving(true);
    try { const snapshot = await api<WorkspaceSnapshot>('/workspace'); const latest = snapshot.issues.find(value => value.id === issueId); if (!latest) throw new Error('업무가 삭제되었거나 더 이상 존재하지 않습니다.'); setDraft(latest); setBaseDraft(latest); setLabels(latest.labels.join(', ')); setCommentBody(''); setConflict(false); setError(''); dirtyRef.current = false; await refresh(); }
    catch (err) { dirtyRef.current = hadUnsaved; setError(errorMessage(err)); } finally { savingRef.current = false; setSaving(false); }
  }
  async function deleteIssue() {
    if (!issue || savingRef.current || commenting || dependencyBusyRef.current || childDraft.current?.pending) return;
    savingRef.current = true; setSaving(true); setError('');
    try {
      await remove(`/issues/${issueId}?expectedVersion=${draft?.version ?? issue.version}`);
      window.dispatchEvent(new Event('teamspace:trash-changed'));
      dirtyRef.current = false;
      try {
        await refresh();
        notify(`${issue.key} 업무를 휴지통으로 옮겼습니다.`);
      } catch {
        notify(`${issue.key} 업무를 휴지통으로 옮겼습니다. 업무 목록을 불러오지 못했습니다.`, 'error');
      }
      savingRef.current = false;
      onClose();
    } catch (err) { setError(errorMessage(err)); }
    finally { savingRef.current = false; setSaving(false); }
  }
  async function addComment(event: FormEvent) {
    event.preventDefault(); if (!commentBody.trim()) return; setCommenting(true); setCommentError('');
    try {
      const value = await post<Comment>('/comments', { resourceType: 'issue', resourceId: issueId, body: commentBody.trim() });
      setComments(previous => previous.some(item => item.id === value.id) ? previous : [...previous, value]);
      setCommentBody('');
      window.dispatchEvent(new Event(COMMENT_LIST_CHANGED));
      await refresh();
    }
    catch (err) { setCommentError(errorMessage(err)); } finally { setCommenting(false); }
  }
  async function linkDocument() {
    if (!documentId) return; setLinking(true);
    try { await post<ResourceLink>('/resource-links', { issueId, documentId, kind: 'related' }); setDocumentId(''); await refresh(); notify('문서를 연결했습니다.'); }
    catch (err) { notify(errorMessage(err), 'error'); } finally { setLinking(false); }
  }
  async function unlinkDocument(id: string) { try { await remove(`/resource-links/${id}`); await refresh(); notify('문서 연결을 해제했습니다.'); } catch (err) { notify(errorMessage(err), 'error'); } }
  function openDependencyEditor(opener: HTMLButtonElement, otherRole: RelatedIssueDirection, dependency?: Dependency) {
    if (savingRef.current || dependencyBusyRef.current) return;
    dependencyOpener.current = opener;
    setDependencyEditor({ otherRole, dependency });
  }
  async function changeDependency(change: () => Promise<unknown>, message: string) {
    if (dependencyBusyRef.current || savingRef.current) return false;
    dependencyBusyRef.current = true;
    setDependencyBusy(true);
    try {
      await change();
      try {
        await refresh();
        notify(message);
      } catch (err) {
        notify(`${message} 최신 목록을 불러오지 못했습니다. ${errorMessage(err)}`, 'error');
      }
      return true;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) await refresh().catch(() => undefined);
      throw err;
    } finally {
      dependencyBusyRef.current = false;
      setDependencyBusy(false);
    }
  }
  async function saveDependency(input: DependencyInput) {
    const changed = await changeDependency(() => {
      if (!editingDependency) return post('/dependencies', input);
      const { type, lagDays } = input;
      const reverse = input.predecessorId !== editingDependency.predecessorId;
      return patch(`/dependencies/${encodeURIComponent(editingDependency.id)}`, {
        expectedVersion: editingDependency.version ?? 1, type, lagDays, ...(reverse ? { reverse: true } : {}),
      });
    }, editingDependency ? '업무 연결을 수정했습니다.' : '선행·후행 업무를 연결했습니다.');
    if (changed) closeDependencyEditor();
  }
  async function unlinkDependency(dependency: Dependency, opener: HTMLButtonElement) {
    try {
      await changeDependency(() => remove(`/dependencies/${encodeURIComponent(dependency.id)}?expectedVersion=${dependency.version ?? 1}`),
        '선행·후행 연결을 해제했습니다.');
    } catch (err) { notify(errorMessage(err), 'error'); }
    requestAnimationFrame(() => (opener.isConnected ? opener : addPredecessorButton.current)?.focus({ preventScroll: true }));
  }
  const parent = data.issues.find(i => i.id === issue.parentId);
  return <>
    <div className="issue-panel-backdrop" inert={Boolean(childCreation || dependencyEditor)} onMouseDown={event => {
      if (event.target === event.currentTarget && !saving && !childCreation && !dependencyEditor && !dependencyBusyRef.current) closePanel();
    }}><aside className="issue-detail-panel" role="dialog" aria-modal="true" aria-labelledby="issue-panel-heading">
    <header className="issue-panel-header">
      <div className="issue-panel-breadcrumb"><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} /><span>{data.projects.find(p => p.id === issue.projectId)?.name}</span><ChevronRight size={13} /><strong>{issue.key}</strong></div>
      <div className="issue-panel-header-actions">
        <NotificationSubscriptionButton actorId={props.actorId} targetType="issue" targetId={issue.id} notify={notify} />
        <button className="issue-icon-button" onClick={closePanel} disabled={saving || dependencyBusy} aria-label="업무 상세 닫기"><X size={20} /></button>
      </div>
    </header>
    <div className="issue-panel-title"><span className="issue-type-label"><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} />{issueTypeMeta(data, issue.projectId, issue.type).name}</span><h2 id="issue-panel-heading">{issue.title}</h2>{parent && <button className="issue-parent-link" onClick={() => navigateIssue(parent.id)}>상위 업무 · {parent.key} {parent.title}<ArrowRight size={13} /></button>}<div className="issue-panel-tabs"><button className={tab === 'details' ? 'active' : ''} onClick={() => switchTab('details')}>상세 정보</button><button className={tab === 'activity' ? 'active' : ''} onClick={() => switchTab('activity')}><Clock3 size={14} /> 변경 이력 <span>{activities.length}</span></button><button className={tab === 'worklogs' ? 'active' : ''} onClick={() => switchTab('worklogs')}>작업 시간</button><button className={tab === 'reservations' ? 'active' : ''} onClick={() => switchTab('reservations')}>시간 배정</button><button className={tab === 'source' ? 'active' : ''} onClick={() => switchTab('source')}>원본 기록</button></div></div>
    <div className="issue-panel-content">{tab === 'details' ? <>
      {(conflict || issue.version > draft.version) && <div className="issue-conflict-banner" role="alert"><div><strong>다른 변경사항이 있습니다</strong><p>작성 중인 내용은 유지됩니다. 편집 시작 버전은 {draft.version}, 현재 버전은 {issue.version}입니다. 최신 내용을 확인한 뒤 다시 편집하세요.</p></div><button className="btn" onClick={reloadLatest} disabled={saving}>최신 버전 불러오기</button></div>}
      <form className="issue-detail-form" onSubmit={save} aria-busy={saving}><fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <label className="issue-form-label">제목<input aria-label="제목" className="field issue-title-input" value={draft.title} onChange={e => update('title', e.target.value)} maxLength={300} required /></label>
        <label className="issue-form-label">설명<textarea aria-label="설명" className="field issue-description-input" value={draft.description} onChange={e => update('description', e.target.value)} placeholder="배경, 목표, 완료 조건을 적어주세요." rows={5} /></label>
        <div className="issue-properties"><div className="issue-section-caption">속성</div><div className="issue-form-grid">
          <label className="issue-form-label">상태<select aria-label="상태" className="field" value={draft.status} onChange={e => update('status', e.target.value as Issue['status'])}>{!nextStatuses.some(status => status.id === draft.status) && <option value={draft.status} disabled>{statusMeta(data,draft.projectId,draft.status).label} (현재 허용되지 않음)</option>}{nextStatuses.map(status => <option key={status.id} value={status.id}>{status.label}</option>)}</select></label>
          <label className="issue-form-label">유형<IssueTypeSelect data={data} projectId={draft.projectId} value={draft.type} existingType={baseDraft?.type} onChange={value => update('type', value)} /></label>
          <label className="issue-form-label">우선순위<select aria-label="우선순위" className="field" value={draft.priority} onChange={e => update('priority', e.target.value as Issue['priority'])}>{Object.entries(PRIORITY).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
          <label className="issue-form-label">담당자<select aria-label="담당자" className="field" value={draft.assigneeId || ''} onChange={e => update('assigneeId', e.target.value || null)}><option value="">미지정</option>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
          <label className="issue-form-label">시작일<input aria-label="시작일" type="date" className="field" value={draft.startDate || ''} onChange={e => update('startDate', e.target.value || null)} /></label>
          <label className="issue-form-label">종료일<input aria-label="종료일" type="date" className="field" value={draft.endDate || ''} onChange={e => update('endDate', e.target.value || null)} /></label>
          <label className="issue-form-label">목표 마감일<input aria-label="목표 마감일" type="date" className="field" value={draft.dueDate || ''} onChange={e => update('dueDate', e.target.value || null)} /></label>
          <label className="issue-form-label">예상 소요 (포인트)<input aria-label="예상 소요 (포인트)" className="field" type="number" min="0" step="0.5" placeholder="미정" value={draft.estimate ?? ''} onChange={e => update('estimate', e.target.value === '' ? null : Number(e.target.value))} /></label>
          <label className="issue-form-label">계획 작업 시간 (분)<input aria-label="계획 작업 시간 (분)" className="field" type="number" min={0} max={MAX_PLANNED_EFFORT_MINUTES} step={1} placeholder="미정" value={draft.plannedEffortMinutes ?? ''} onChange={e => update('plannedEffortMinutes', e.target.value === '' ? null : Number(e.target.value))} /></label>
          <label className="issue-form-label issue-grid-wide">상위 업무<select aria-label="상위 업무" className="field" value={draft.parentId || ''} onChange={e => update('parentId', e.target.value || null)}><option value="">없음</option>{data.issues.filter(i => i.projectId === draft.projectId && i.id !== issueId).map(i => <option key={i.id} value={i.id}>{i.key} · {i.title}</option>)}</select></label>
          <label className="issue-form-label">사이클<PlanningSelect data={data} projectId={draft.projectId} kind="cycle" value={draft.cycleId ?? null} legacyLabel={draft.cycle} onChange={id => updatePlanning('cycle', id)} /></label>
          <label className="issue-form-label">모듈<PlanningSelect data={data} projectId={draft.projectId} kind="module" value={draft.moduleId ?? null} legacyLabel={draft.module} onChange={id => updatePlanning('module', id)} /></label>
          <label className="issue-form-label">릴리스<PlanningSelect data={data} projectId={draft.projectId} kind="release" value={draft.releaseId ?? null} legacyLabel={draft.release} onChange={id => updatePlanning('release', id)} /></label>
          <label className="issue-form-label">라벨<input aria-label="라벨" className="field" placeholder="쉼표로 구분" value={labels} onChange={e => setLabels(e.target.value)} /></label>
          <label className="issue-form-label issue-grid-wide">참여자<select multiple className="field issue-collaborator-select" aria-label="참여자 선택 (Ctrl 또는 Cmd로 여러 명 선택)" value={draft.collaboratorIds} onChange={e => update('collaboratorIds', Array.from(e.target.selectedOptions).map(o => o.value))}>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select><small className="muted">Ctrl 또는 ⌘를 누르고 여러 명을 선택하세요.</small></label>
        </div></div>
        <CustomFields data={data} projectId={draft.projectId} issueType={draft.type} status={draft.status} values={draft.customFields || {}} existingValues={baseDraft?.customFields || {}} onChange={value => update('customFields', value)} disabled={saving} requiredFields={requiredFields} />
        {requiredFields.length > 0 && <p className="issue-section-empty">이 유형·상태의 필수 속성: {requiredFieldLabels(data, draft.projectId, requiredFields).join(', ')}</p>}
        {error && <div className="issue-form-error" role="alert">{error}</div>}
        <div className="issue-save-row"><span className="muted">편집 버전 {draft.version}{dirty ? ' · 저장하지 않은 변경사항' : ` · ${relativeTime(issue.updatedAt)} 수정`}</span><button className="btn btn-primary" type="submit" disabled={saving || dependencyBusy || !dirty}><Save size={15} />{saving ? '저장 중…' : '변경사항 저장'}</button></div>
      </fieldset></form>
      <section className="issue-related-section" aria-label="업무 의존성">
        <div className="issue-schedule-heading">
          <h3><Link2 size={16} aria-hidden="true" />업무 의존성 <span>{dependencies.length}</span></h3>
          <div className="issue-schedule-actions">
            <button ref={addPredecessorButton} className="btn" type="button" disabled={!hasOtherIssueInProject || saving || dependencyBusy}
              onClick={event => openDependencyEditor(event.currentTarget, 'predecessor')}><Plus size={14} aria-hidden="true" />선행 업무 추가</button>
            <button className="btn" type="button" disabled={!hasOtherIssueInProject || saving || dependencyBusy}
              onClick={event => openDependencyEditor(event.currentTarget, 'successor')}><Plus size={14} aria-hidden="true" />후행 업무 추가</button>
          </div>
        </div>
        {!dependencies.length && <p className="issue-section-empty">{hasOtherIssueInProject ? '연결된 선행·후행 업무가 없습니다.' : '같은 프로젝트에 업무를 추가하면 연결할 수 있습니다.'}</p>}
        {dependencies.map(dependency => {
          const otherIsSuccessor = dependency.predecessorId === issueId;
          const related = data.issues.find(value => value.id === (otherIsSuccessor ? dependency.successorId : dependency.predecessorId));
          if (!related) return null;
          return <div className="issue-schedule-relation" key={dependency.id}>
            <button type="button" className="issue-related-row" onClick={() => navigateIssue(related.id)}>
              <span className="muted">{otherIsSuccessor ? '후행' : '선행'}</span>
              <span className="issue-key">{related.key}</span>
              <span className="issue-dependency-description"><span>{related.title}</span><small>{dependencyLabel(dependency)}</small></span>
              <ChevronRight size={14} aria-hidden="true" />
            </button>
            <div className="issue-schedule-row-actions">
              <button type="button" className="issue-icon-button" aria-label={`${related.key} 연결 수정`} title="연결 수정" disabled={saving || dependencyBusy}
                onClick={event => openDependencyEditor(event.currentTarget, otherIsSuccessor ? 'successor' : 'predecessor', dependency)}><Pencil size={15} aria-hidden="true" /></button>
              <button type="button" className="issue-icon-button" aria-label={`${related.key} 연결 해제`} title="연결 해제" disabled={saving || dependencyBusy}
                onClick={event => void unlinkDependency(dependency, event.currentTarget)}><X size={15} aria-hidden="true" /></button>
            </div>
          </div>;
        })}
      </section>
      <section className="issue-related-section" aria-label="하위 업무">
        <div className="issue-children-heading">
          <h3><LayersIcon />하위 업무 <span>{children.length}</span></h3>
          {children.length > 0 && <span className="issue-children-completed">완료 {completedChildren}개</span>}
          <button ref={childCreationTrigger} className="btn" type="button" disabled={saving} onClick={() => setChildCreation(issue)}>
            <Plus size={14} aria-hidden="true" />하위 업무 추가
          </button>
        </div>
        {children.map(({ child, status }) => <button type="button" className="issue-related-row" key={child.id} onClick={() => navigateIssue(child.id)}>
          <IssueTypeIcon type={child.type} data={data} projectId={child.projectId} /><span className="issue-key">{child.key}</span><span>{child.title}</span>
          <span className="issue-related-status" style={{ color: status.color }}>{status.label}</span><ChevronRight size={14} aria-hidden="true" />
        </button>)}
      </section>
      <IssueRelations issueId={issue.id} data={data} openIssue={navigateIssue} refresh={refresh} notify={notify}
        disabled={saving || dependencyBusy} onDraftChange={trackRelationDraft} />
      <section className="issue-related-section">
        <h3><FileText size={16} /> 연결된 문서 <span>{linkedDocuments.length}</span></h3>
        {linkedDocuments.map(link => {
          const doc = data.documents.find(d => d.id === link.documentId);
          if (!doc) return null;
          const source = link.documentSource;
          return <div key={link.id}>
            <div className="issue-related-row">
              <FileText size={15} />
              <button type="button" onClick={() => navigateDocument(doc.id)} className="issue-document-link">{doc.title}</button>
              <button type="button" className="issue-icon-button" onClick={() => unlinkDocument(link.id)} aria-label={`${doc.title} 연결 해제`} title="연결 해제"><X size={14} /></button>
            </div>
            {source && <section className="issue-decision-source" aria-label="결정 근거">
              <h4>결정 근거</h4>
              <blockquote>{source.text}</blockquote>
              <Suspense fallback={<p className="issue-section-empty" role="status">원문 저장본 열기를 준비하는 중…</p>}>
                <DocumentDecisionRevision key={source.revisionId} data={data} documentId={doc.id} revisionId={source.revisionId} label={doc.title} />
              </Suspense>
            </section>}
          </div>;
        })}
        <div className="issue-link-control"><select className="field" value={documentId} onChange={e => setDocumentId(e.target.value)} aria-label="연결할 문서"><option value="">문서를 선택하세요</option>{availableDocuments.map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select><button className="btn" disabled={!documentId || linking} onClick={linkDocument}><Link2 size={14} /> 연결</button></div>
      </section>
      <AtlassianLinks targetType="issue" targetId={issue.id} actorId={props.actorId} notify={notify} />
      <section className="issue-related-section" aria-label="GitLab">
        <div className="gitlab-activity-header"><h3><GitMerge aria-hidden="true" size={16} />GitLab <span>{gitlabLinks.length}</span></h3><GitlabActivityRefresh refresh={refresh} notify={notify} /></div>
        {gitlabLinks.length ? <GitlabActivityList links={gitlabLinks} /> : <p className="issue-section-empty">연결된 개발 기록이 없습니다. GitLab을 연결한 뒤 브랜치 이름이나 커밋 메시지에 {issue.key}를 넣어 푸시하세요.</p>}
      </section>
      <section className="issue-related-section"><Attachments resourceType="issue" resourceId={issueId} actorId={props.actorId} notify={notify} onChanged={refresh}/></section>
      <section className="issue-related-section issue-comments">
        <h3><MessageSquare size={16} /> 댓글 <span>{comments.length}</span></h3>
        {loadingComments ? <p className="issue-section-empty">댓글을 불러오는 중…</p> : comments.length === 0 ? <p className="issue-section-empty">논의와 결정사항을 남겨주세요.</p> : comments.map(comment => {
          const user = data.users.find(value => value.id === comment.authorId);
          return <article key={comment.id} className="issue-comment">
            <span className="issue-avatar" style={{ background: user?.color || '#8996a4' }}>{user?.name.slice(0, 1) || '?'}</span>
            <div>
              <header><strong>{user?.name || '알 수 없는 사용자'}</strong><time title={comment.createdAt}>{relativeTime(comment.createdAt)}</time>
                <CommentTrashButton comment={comment} actorId={props.actorId} notify={notify} refresh={refresh} disabled={commenting || saving}
                  onArchived={removed => setComments(previous => previous.filter(value => value.id !== removed.id))} />
              </header>
              <p>{comment.body}</p>
            </div>
          </article>;
        })}
        {commentError && <div className="issue-form-error" role="alert">{commentError}</div>}
        <form onSubmit={addComment}><textarea className="field" placeholder="댓글을 작성하세요…" aria-label="댓글 내용" value={commentBody} onChange={e => setCommentBody(e.target.value)} rows={3} required maxLength={10000} /><div className="issue-comment-submit"><button className="btn" disabled={!commentBody.trim() || commenting} type="submit"><Plus size={14} />{commenting ? '등록 중…' : '댓글 등록'}</button></div></form>
      </section>
      <section className="issue-danger-zone">{deleteConfirm ? <><p><strong>{issue.key} 업무를 휴지통으로 옮길까요?</strong><br /><span>휴지통에서 업무를 복원할 수 있습니다. 이미 기록한 작업 시간은 프로젝트 보고서에 남습니다.{(dirty || commentBody.trim()) && ' 저장하지 않은 편집과 보내지 않은 댓글은 사라집니다.'}</span></p><div><button className="btn btn-ghost" onClick={() => setDeleteConfirm(false)} disabled={saving}>취소</button><button className="btn issue-btn-danger" onClick={deleteIssue} disabled={saving || commenting}>휴지통으로 이동</button></div></> : <button className="btn btn-ghost" onClick={() => setDeleteConfirm(true)}><Trash2 size={14} /> 업무 삭제</button>}</section>
    </> : tab === 'worklogs' ? <IssueWorklogs issueId={issue.id} actorId={props.actorId} users={data.users}
      notify={notify} onChanged={refresh} onDraftChange={trackChildDraft}/>
    : tab === 'reservations' ? <TimeReservations issue={issue} actorId={props.actorId} users={data.users} notify={notify} onDraftChange={trackChildDraft} onChanged={refresh} />
    : tab === "source" ? <SourceOrigins resourceType="issue" resourceId={issue.id}/> : <div className="issue-activity-list">{activities.length ? activities.map(activity => { const user = data.users.find(u => u.id === activity.actorId); return <article key={activity.id}><span className="issue-activity-dot"><Check size={12} /></span><div><p><strong>{user?.name || '시스템'}</strong> · {activity.detail || activity.action}</p><time>{new Date(activity.createdAt).toLocaleString('ko-KR')}</time></div></article>; }) : <div className="issue-empty"><Clock3 size={28} /><p>아직 변경 이력이 없습니다.</p></div>}</div>}</div>
    </aside></div>
    {childCreation && <NewIssueModal {...props} parentIssue={childCreation} onClose={closeChildCreation} />}
    {dependencyEditor && <GanttDependencyModal issues={data.issues} dependency={editingDependency}
      anchor={{ issueId, otherRole: dependencyEditor.otherRole }} staleMessage={staleDependencyMessage} busy={dependencyBusy}
      onClose={closeDependencyEditor} onSubmit={saveDependency} onDraftChange={trackDependencyDraft} />}
  </>;
}

function LayersIcon() { return <span className="issue-subtask-icon">↳</span>; }
