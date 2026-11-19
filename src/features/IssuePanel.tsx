'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronRight, Clock3, ExternalLink, FileText, GitMerge, Link2, MessageSquare, Plus, Save, Trash2, X } from 'lucide-react';
import { PRIORITY, type Comment, type FeatureProps, type Issue, type ResourceLink, type WorkspaceSnapshot } from '../../shared/types';
import { api, ApiError, patch, post, relativeTime, remove } from '../lib/api';
import { allowedNextStatuses, requiredFieldsFor, statusMeta } from '../../shared/workflow-helpers';
import { IssueTypeIcon } from './Issues';
import { PlanningSelect } from './PlanningSelectors';
import { issueTypeMeta, requiredFieldLabels } from '../../shared/issue-schema';
import { CustomFields, IssueTypeSelect } from './CustomFields';
import { SourceOrigins } from './SourceOrigins';
import { IssueRelations } from './IssueRelations';
import { Attachments } from './Attachments';
import { IssueWorklogs } from './IssueWorklogs';
import { afterAcceptedNavigation } from '../lib/navigation';
import { errorMessage } from './schedule-utils';
import './issues.css';

function editableIssue(issue: Issue, labels: string) {
  return { title: issue.title.trim(), description: issue.description, type: issue.type, status: issue.status, priority: issue.priority, assigneeId: issue.assigneeId, collaboratorIds: issue.collaboratorIds, parentId: issue.parentId, labels: [...new Set(labels.split(',').map(value => value.trim()).filter(Boolean))], startDate: issue.startDate, endDate: issue.endDate, dueDate: issue.dueDate, estimate: issue.estimate, cycleId: issue.cycleId ?? null, moduleId: issue.moduleId ?? null, releaseId: issue.releaseId ?? null, customFields: issue.customFields || {} };
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
  const [tab, setTab] = useState<'details' | 'activity' | 'source' | 'worklogs'>('details');
  const [documentId, setDocumentId] = useState('');
  const [linking, setLinking] = useState(false);
  const [loadedVersion, setLoadedVersion] = useState(issue?.version);
  const dirty = Boolean(draft && baseDraft && JSON.stringify(editableIssue(draft, labels)) !== JSON.stringify(editableIssue(baseDraft, baseDraft.labels.join(', '))));
  const dirtyRef = useRef(false);
  const worklogDraft = useRef<{dirty:boolean;pending:boolean;discard:()=>void} | null>(null);
  const trackWorklogDraft = useCallback((dirty: boolean, pending: boolean, discard: () => void) => {
    worklogDraft.current = dirty || pending ? {dirty,pending,discard} : null;
  }, []);
  function switchTab(next: typeof tab) {
    if (next === tab) return;
    if (worklogDraft.current?.pending) { notify('작업 시간 저장이 끝난 뒤 이동해 주세요.', 'error'); return; }
    if (worklogDraft.current?.dirty && !window.confirm('작성 중인 작업 시간 기록을 버리고 이동할까요?')) return;
    worklogDraft.current?.discard();
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
      const worklog = worklogDraft.current;
      if (savingRef.current || worklog?.pending) {
        event.preventDefault();
        notify('저장이 끝난 후 이동해주세요.', 'error');
      } else if (dirtyRef.current || worklog?.dirty) {
        const message = worklog?.dirty ? '저장하지 않은 업무·댓글·작업 시간 기록을 버리고 이동할까요?'
          : '저장하지 않은 업무 변경사항이나 작성 중인 댓글이 있습니다. 내용을 버리고 이동할까요?';
        if (!window.confirm(message)) event.preventDefault();
        else afterAcceptedNavigation(event, () => {
          worklog?.discard();
          dirtyRef.current = false;
          setDraft(issue); setBaseDraft(issue); setLabels(issue?.labels.join(', ') || '');
          setCommentBody(''); setError(''); setConflict(false);
        });
      }
    };
    const leave = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !savingRef.current && !worklogDraft.current) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('teamspace:navigate', navigate); window.addEventListener('beforeunload', leave);
    return () => { window.removeEventListener('teamspace:navigate', navigate); window.removeEventListener('beforeunload', leave); };
  }, [issue, notify]);
  useEffect(() => {
    let active = true;
    api<Comment[]>(`/comments?resourceType=issue&resourceId=${encodeURIComponent(issueId)}`).then(value => { if (active) setComments(value); }).catch(err => { if (active) setCommentError(errorMessage(err)); }).finally(() => { if (active) setLoadingComments(false); });
    return () => { active = false; };
  }, [issueId]);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) closePanel(); }; document.addEventListener('keydown', handler); return () => document.removeEventListener('keydown', handler); }, [closePanel, saving]);
  if (!issue || !draft) return <div className="issue-panel-backdrop"><aside className="issue-detail-panel"><button className="issue-icon-button" onClick={closePanel} aria-label="닫기"><X /></button><div className="issue-empty">업무를 찾을 수 없습니다.</div></aside></div>;
  const linkedDocuments = data.resourceLinks.filter(l => l.issueId === issueId);
  const availableDocuments = data.documents.filter(d => !linkedDocuments.some(l => l.documentId === d.id));
  const gitlabLinks = data.gitlabLinks.filter(l => l.issueId === issueId);
  const activities = data.activities.filter(a => a.resourceId === issueId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const children = data.issues.filter(i => i.parentId === issueId);
  const nextStatuses = allowedNextStatuses(data, {projectId:draft.projectId,status:baseDraft?.status || draft.status,type:draft.type});
  const requiredFields = requiredFieldsFor(data,draft.projectId,draft.type,draft.status,baseDraft?.status);
  const dependencies = data.dependencies.filter(d => d.predecessorId === issueId || d.successorId === issueId);
  function update<K extends keyof Issue>(key: K, value: Issue[K]) { setDraft(previous => previous ? { ...previous, [key]: value } : previous); }
  function updatePlanning(kind: 'cycle' | 'module' | 'release', id: string | null) { setDraft(previous => previous ? { ...previous, [`${kind}Id`]: id, [kind]: data.planningItems?.find(item => item.id === id)?.name || null } : previous); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || !issue || savingRef.current) return; savingRef.current = true; setSaving(true); setError('');
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
    if (!issue || savingRef.current || commenting) return;
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
    try { const value = await post<Comment>('/comments', { resourceType: 'issue', resourceId: issueId, body: commentBody.trim() }); setComments(previous => [...previous, value]); setCommentBody(''); await refresh(); }
    catch (err) { setCommentError(errorMessage(err)); } finally { setCommenting(false); }
  }
  async function linkDocument() {
    if (!documentId) return; setLinking(true);
    try { await post<ResourceLink>('/resource-links', { issueId, documentId, kind: 'related' }); setDocumentId(''); await refresh(); notify('문서를 연결했습니다.'); }
    catch (err) { notify(errorMessage(err), 'error'); } finally { setLinking(false); }
  }
  async function unlinkDocument(id: string) { try { await remove(`/resource-links/${id}`); await refresh(); notify('문서 연결을 해제했습니다.'); } catch (err) { notify(errorMessage(err), 'error'); } }
  const parent = data.issues.find(i => i.id === issue.parentId);
  return <div className="issue-panel-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) closePanel(); }}><aside className="issue-detail-panel" role="dialog" aria-modal="true" aria-labelledby="issue-panel-heading">
    <header className="issue-panel-header"><div className="issue-panel-breadcrumb"><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} /><span>{data.projects.find(p => p.id === issue.projectId)?.name}</span><ChevronRight size={13} /><strong>{issue.key}</strong></div><button className="issue-icon-button" onClick={closePanel} disabled={saving} aria-label="업무 상세 닫기"><X size={20} /></button></header>
    <div className="issue-panel-title"><span className="issue-type-label"><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} />{issueTypeMeta(data, issue.projectId, issue.type).name}</span><h2 id="issue-panel-heading">{issue.title}</h2>{parent && <button className="issue-parent-link" onClick={() => navigateIssue(parent.id)}>상위 업무 · {parent.key} {parent.title}<ArrowRight size={13} /></button>}<div className="issue-panel-tabs"><button className={tab === 'details' ? 'active' : ''} onClick={() => switchTab('details')}>상세 정보</button><button className={tab === 'activity' ? 'active' : ''} onClick={() => switchTab('activity')}><Clock3 size={14} /> 변경 이력 <span>{activities.length}</span></button><button className={tab === 'worklogs' ? 'active' : ''} onClick={() => switchTab('worklogs')}>작업 시간</button><button className={tab === 'source' ? 'active' : ''} onClick={() => switchTab('source')}>원본 기록</button></div></div>
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
          <label className="issue-form-label issue-grid-wide">상위 업무<select aria-label="상위 업무" className="field" value={draft.parentId || ''} onChange={e => update('parentId', e.target.value || null)}><option value="">없음</option>{data.issues.filter(i => i.projectId === draft.projectId && i.id !== issueId).map(i => <option key={i.id} value={i.id}>{i.key} · {i.title}</option>)}</select></label>
          <label className="issue-form-label">사이클<PlanningSelect data={data} projectId={draft.projectId} kind="cycle" value={draft.cycleId ?? null} legacyLabel={draft.cycle} onChange={id => updatePlanning('cycle', id)} /></label>
          <label className="issue-form-label">모듈<PlanningSelect data={data} projectId={draft.projectId} kind="module" value={draft.moduleId ?? null} legacyLabel={draft.module} onChange={id => updatePlanning('module', id)} /></label>
          <label className="issue-form-label">릴리스<PlanningSelect data={data} projectId={draft.projectId} kind="release" value={draft.releaseId ?? null} legacyLabel={draft.release} onChange={id => updatePlanning('release', id)} /></label>
          <label className="issue-form-label">라벨<input aria-label="라벨" className="field" placeholder="쉼표로 구분" value={labels} onChange={e => setLabels(e.target.value)} /></label>
          <label className="issue-form-label issue-grid-wide">참여자<select multiple className="field issue-collaborator-select" aria-label="참여자 선택 (Ctrl 또는 Cmd로 여러 명 선택)" value={draft.collaboratorIds} onChange={e => update('collaboratorIds', Array.from(e.target.selectedOptions).map(o => o.value))}>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select><small className="muted">Ctrl 또는 ⌘를 누르고 여러 명을 선택하세요.</small></label>
        </div></div>
        <CustomFields data={data} projectId={draft.projectId} issueType={draft.type} values={draft.customFields || {}} existingValues={baseDraft?.customFields || {}} onChange={value => update('customFields', value)} disabled={saving} requiredFields={requiredFields} />
        {requiredFields.length > 0 && <p className="issue-section-empty">이 유형·상태의 필수 속성: {requiredFieldLabels(data, draft.projectId, requiredFields).join(', ')}</p>}
        {error && <div className="issue-form-error" role="alert">{error}</div>}
        <div className="issue-save-row"><span className="muted">편집 버전 {draft.version}{dirty ? ' · 저장하지 않은 변경사항' : ` · ${relativeTime(issue.updatedAt)} 수정`}</span><button className="btn btn-primary" type="submit" disabled={saving || !dirty}><Save size={15} />{saving ? '저장 중…' : '변경사항 저장'}</button></div>
      </fieldset></form>
      {children.length > 0 && <section className="issue-related-section"><h3><LayersIcon />하위 업무 <span>{children.length}</span></h3>{children.map(child => <button className="issue-related-row" key={child.id} onClick={() => navigateIssue(child.id)}><IssueTypeIcon type={child.type} data={data} projectId={child.projectId} /><span className="issue-key">{child.key}</span><span>{child.title}</span><span className="issue-related-status" style={{ color: statusMeta(data,child.projectId,child.status).color }}>{statusMeta(data,child.projectId,child.status).label}</span><ChevronRight size={14} /></button>)}</section>}
      <IssueRelations issueId={issue.id} data={data} openIssue={navigateIssue} />
      <section className="issue-related-section"><h3><FileText size={16} /> 연결된 문서 <span>{linkedDocuments.length}</span></h3>{linkedDocuments.map(link => { const doc = data.documents.find(d => d.id === link.documentId); return doc && <div className="issue-related-row" key={link.id}><FileText size={15} /><button onClick={() => navigateDocument(doc.id)} className="issue-document-link">{doc.title}</button><button className="issue-icon-button" onClick={() => unlinkDocument(link.id)} aria-label={`${doc.title} 연결 해제`} title="연결 해제"><X size={14} /></button></div>; })}<div className="issue-link-control"><select className="field" value={documentId} onChange={e => setDocumentId(e.target.value)} aria-label="연결할 문서"><option value="">문서를 선택하세요</option>{availableDocuments.map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select><button className="btn" disabled={!documentId || linking} onClick={linkDocument}><Link2 size={14} /> 연결</button></div></section>
      <section className="issue-related-section"><h3><GitMerge size={16} /> GitLab <span>{gitlabLinks.length}</span></h3>{gitlabLinks.length ? gitlabLinks.map(link => <a className="issue-related-row issue-gitlab-row" key={link.id} href={/^https?:\/\//.test(link.webUrl) ? link.webUrl : '#'} target="_blank" rel="noreferrer"><GitMerge size={15} /><div><strong>{link.kind === 'merge_request' ? `!${link.iid}` : `#${link.iid}`} {link.title}</strong><small>{link.kind} · {link.state}</small></div><ExternalLink size={14} /></a>) : <p className="issue-section-empty">연결된 개발 기록이 없습니다. GitLab 설정 후 업무 번호로 연결할 수 있습니다.</p>}</section>
      {dependencies.length > 0 && <section className="issue-related-section"><h3><Link2 size={16} /> 업무 의존성 <span>{dependencies.length}</span></h3>{dependencies.map(dep => { const isPredecessor = dep.predecessorId === issueId; const related = data.issues.find(i => i.id === (isPredecessor ? dep.successorId : dep.predecessorId)); return related && <button key={dep.id} className="issue-related-row" onClick={() => navigateIssue(related.id)}><span className="muted">{isPredecessor ? '후행' : '선행'}</span><span className="issue-key">{related.key}</span><span>{related.title}</span><ChevronRight size={14} /></button>; })}</section>}
      <section className="issue-related-section"><Attachments resourceType="issue" resourceId={issueId} actorId={props.actorId} notify={notify} onChanged={refresh}/></section>
      <section className="issue-related-section issue-comments"><h3><MessageSquare size={16} /> 댓글 <span>{comments.length}</span></h3>{loadingComments ? <p className="issue-section-empty">댓글을 불러오는 중…</p> : comments.length === 0 ? <p className="issue-section-empty">논의와 결정사항을 남겨주세요.</p> : comments.map(comment => { const user = data.users.find(u => u.id === comment.authorId); return <article key={comment.id} className="issue-comment"><span className="issue-avatar" style={{ background: user?.color || '#8996a4' }}>{user?.name.slice(0, 1) || '?'}</span><div><header><strong>{user?.name || '알 수 없는 사용자'}</strong><time title={comment.createdAt}>{relativeTime(comment.createdAt)}</time></header><p>{comment.body}</p></div></article>; })}{commentError && <div className="issue-form-error" role="alert">{commentError}</div>}<form onSubmit={addComment}><textarea className="field" placeholder="댓글을 작성하세요…" aria-label="댓글 내용" value={commentBody} onChange={e => setCommentBody(e.target.value)} rows={3} required maxLength={10000} /><div className="issue-comment-submit"><button className="btn" disabled={!commentBody.trim() || commenting} type="submit"><Plus size={14} />{commenting ? '등록 중…' : '댓글 등록'}</button></div></form></section>
      <section className="issue-danger-zone">{deleteConfirm ? <><p><strong>{issue.key} 업무를 휴지통으로 옮길까요?</strong><br /><span>휴지통에서 업무를 복원할 수 있습니다. 이미 기록한 작업 시간은 프로젝트 보고서에 남습니다.{(dirty || commentBody.trim()) && ' 저장하지 않은 편집과 보내지 않은 댓글은 사라집니다.'}</span></p><div><button className="btn btn-ghost" onClick={() => setDeleteConfirm(false)} disabled={saving}>취소</button><button className="btn issue-btn-danger" onClick={deleteIssue} disabled={saving || commenting}>휴지통으로 이동</button></div></> : <button className="btn btn-ghost" onClick={() => setDeleteConfirm(true)}><Trash2 size={14} /> 업무 삭제</button>}</section>
    </> : tab === 'worklogs' ? <IssueWorklogs issueId={issue.id} actorId={props.actorId} users={data.users}
      notify={notify} onChanged={refresh} onDraftChange={trackWorklogDraft}/>
    : tab === "source" ? <SourceOrigins resourceType="issue" resourceId={issue.id}/> : <div className="issue-activity-list">{activities.length ? activities.map(activity => { const user = data.users.find(u => u.id === activity.actorId); return <article key={activity.id}><span className="issue-activity-dot"><Check size={12} /></span><div><p><strong>{user?.name || '시스템'}</strong> · {activity.detail || activity.action}</p><time>{new Date(activity.createdAt).toLocaleString('ko-KR')}</time></div></article>; }) : <div className="issue-empty"><Clock3 size={28} /><p>아직 변경 이력이 없습니다.</p></div>}</div>}</div>
  </aside></div>;
}

function LayersIcon() { return <span className="issue-subtask-icon">↳</span>; }
