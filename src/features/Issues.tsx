'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, Bug, Circle, CircleDot, Columns3, Filter, Layers3, List, Plus, Search, X } from 'lucide-react';
import { ISSUE_TYPES, PRIORITY, STATUS, type FeatureProps, type Issue, type IssueStatus } from '../../shared/types';
import { dateLabel, patch, post } from '../lib/api';
import { errorMessage } from './schedule-utils';
import './issues.css';

const isAll = (id: string) => !id || id === 'all';
export function IssueTypeIcon({ type, size = 15 }: { type: string; size?: number }) {
  return type === '버그' ? <Bug size={size} color="#db705e" /> : type === '큰틀' ? <Layers3 size={size} color="#9173cd" /> : type === '개선' ? <ArrowUpRight size={size} color="#ca9e4a" /> : <CircleDot size={size} color="#578ca9" />;
}
export function StatusDot({ status }: { status: IssueStatus }) { return <span className="issue-status-dot" style={{ background: STATUS[status].color }} />; }
function PriorityIcon({ value }: { value: keyof typeof PRIORITY }) { return value === 'urgent' || value === 'high' ? <ArrowUp size={14} className={value === 'urgent' ? 'issue-priority-urgent' : 'issue-priority-high'} /> : value === 'low' ? <ArrowDown size={14} className="muted" /> : <span className="issue-priority-medium">=</span>; }

export function Issues(props: FeatureProps) {
  const { data, projectId, refresh, notify, openIssue } = props;
  const [view, setView] = useState<'list' | 'board'>('list');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [assignee, setAssignee] = useState('all');
  const [type, setType] = useState('all');
  const [creating, setCreating] = useState(false);
  const [createStatus, setCreateStatus] = useState<IssueStatus>('todo');
  const [busy, setBusy] = useState<string | null>(null);
  const [dropStatus, setDropStatus] = useState<string | null>(null);
  const projectIssues = useMemo(() => data.issues.filter(i => isAll(projectId) || i.projectId === projectId), [data.issues, projectId]);
  const issues = projectIssues.filter(i => (!query || `${i.key} ${i.title} ${i.labels.join(' ')}`.toLowerCase().includes(query.toLowerCase())) && (status === 'all' || i.status === status) && (assignee === 'all' || (assignee === 'none' ? !i.assigneeId : i.assigneeId === assignee)) && (type === 'all' || i.type === type));
  const activeFilters = status !== 'all' || assignee !== 'all' || type !== 'all' || query !== '';
  async function changeStatus(issue: Issue, next: IssueStatus) {
    if (issue.status === next || busy) return;
    setBusy(issue.id);
    try { await patch(`/issues/${issue.id}`, { expectedVersion: issue.version, status: next }); await refresh(); notify(`${issue.key} · ${STATUS[next].label}(으)로 변경했습니다.`); }
    catch (error) { notify(errorMessage(error), 'error'); } finally { setBusy(null); }
  }
  return <div className="issues-feature">
    <div className="feature-heading"><div><div className="feature-eyebrow">WORK MANAGEMENT</div><h1>업무</h1><p>해야 할 일을 명확하게, 진행 상황을 한눈에.</p></div><button className="btn btn-primary" onClick={() => { setCreateStatus(status in STATUS ? status as IssueStatus : 'todo'); setCreating(true); }}><Plus size={16} /> 업무 만들기</button></div>
    <div className="issue-toolbar">
      <div className="issue-view-switch" aria-label="업무 보기"><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><List size={16} /> 목록</button><button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}><Columns3 size={16} /> 보드</button></div>
      <div className="issue-search"><Search size={15} /><input aria-label="업무 검색" placeholder="제목, 번호, 라벨 검색" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <div className="issue-filter-select"><Filter size={14} /><select aria-label="상태 필터" value={status} onChange={e => setStatus(e.target.value)}><option value="all">모든 상태</option>{Object.entries(STATUS).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}</select></div>
      <select className="issue-filter" aria-label="담당자 필터" value={assignee} onChange={e => setAssignee(e.target.value)}><option value="all">모든 담당자</option><option value="none">미지정</option>{data.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
      <select className="issue-filter" aria-label="유형 필터" value={type} onChange={e => setType(e.target.value)}><option value="all">모든 유형</option>{ISSUE_TYPES.map(t => <option key={t}>{t}</option>)}</select>
      {activeFilters && <button className="btn btn-ghost issue-clear-filter" onClick={() => { setQuery(''); setStatus('all'); setAssignee('all'); setType('all'); }}><X size={14} /> 초기화</button>}
    </div>
    <div className="issue-results"><span>{activeFilters ? `${projectIssues.length}개 중 ` : ''}<strong>{issues.length}</strong>개의 업무</span><span className="muted">{view === 'board' ? '카드를 끌어 상태 변경 · 카드에서 업무 상세 확인' : '업무를 선택해 상세 내용을 확인하세요'}</span></div>
    {view === 'list' ? <div className="issue-table-scroll"><table className="issue-table"><thead><tr><th className="issue-title-column">업무</th><th>상태</th><th>우선순위</th><th>담당자</th><th>종료일</th><th>라벨</th></tr></thead><tbody>{issues.map(issue => {
      const user = data.users.find(u => u.id === issue.assigneeId);
      return <tr key={issue.id}><td><button className="issue-title-button" onClick={() => openIssue(issue.id)}><IssueTypeIcon type={issue.type} /><span className="issue-key">{issue.key}</span><span className="issue-title-text">{issue.title}</span>{issue.parentId && <span className="issue-child-mark">하위</span>}</button></td><td><span className="issue-status-select"><StatusDot status={issue.status} /><select aria-label={`${issue.key} 상태`} value={issue.status} disabled={busy === issue.id} onChange={e => changeStatus(issue, e.target.value as IssueStatus)}>{Object.entries(STATUS).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}</select></span></td><td><span className="issue-priority"><PriorityIcon value={issue.priority} />{PRIORITY[issue.priority]}</span></td><td>{user ? <span className="issue-assignee"><span className="issue-avatar" style={{ background: user.color }}>{user.name.slice(0, 1)}</span>{user.name}</span> : <span className="muted">미지정</span>}</td><td className="issue-date-cell">{dateLabel(issue.endDate || issue.dueDate)}</td><td><div className="issue-labels">{issue.labels.slice(0, 2).map(l => <span className="issue-label" key={l}>{l}</span>)}{issue.labels.length > 2 && <span className="muted">+{issue.labels.length - 2}</span>}</div></td></tr>;
    })}</tbody></table>{issues.length === 0 && <div className="issue-empty"><Circle size={28} /><h3>{activeFilters ? '조건에 맞는 업무가 없습니다' : '첫 업무를 만들어 보세요'}</h3><p>{activeFilters ? '검색어나 필터를 변경해 보세요.' : '계획과 실행의 시작을 이곳에 기록하세요.'}</p><button className="btn btn-primary" onClick={() => { setCreateStatus(status in STATUS ? status as IssueStatus : 'todo'); setCreating(true); }}><Plus size={15} /> 업무 만들기</button></div>}</div> : <div className="issue-board">{(Object.keys(STATUS) as IssueStatus[]).map(key => {
      const column = issues.filter(i => i.status === key);
      return <section key={key} className={`issue-board-column ${dropStatus === key ? 'is-drag-over' : ''}`} onDragOver={event => { event.preventDefault(); setDropStatus(key); }} onDragLeave={() => setDropStatus(null)} onDrop={event => { event.preventDefault(); setDropStatus(null); const issue = data.issues.find(i => i.id === event.dataTransfer.getData('text/issue-id')); if (issue) void changeStatus(issue, key); }}><div className="issue-board-heading"><StatusDot status={key} /><strong>{STATUS[key].label}</strong><span>{column.length}</span><button title={`${STATUS[key].label} 업무 추가`} aria-label={`${STATUS[key].label} 업무 추가`} onClick={() => { setCreateStatus(key); setCreating(true); }}><Plus size={15} /></button></div>{column.map(issue => {
        const user = data.users.find(u => u.id === issue.assigneeId);
        return <button className={`issue-board-card ${busy === issue.id ? 'is-saving' : ''}`} key={issue.id} draggable onDragStart={event => { event.dataTransfer.setData('text/issue-id', issue.id); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDropStatus(null)} onClick={() => openIssue(issue.id)}><span className="issue-card-key"><IssueTypeIcon type={issue.type} />{issue.key}</span><strong>{issue.title}</strong><span className="issue-labels">{issue.labels.slice(0, 2).map(l => <span className="issue-label" key={l}>{l}</span>)}</span><span className="issue-card-footer"><span className="issue-priority"><PriorityIcon value={issue.priority} /><span>{dateLabel(issue.endDate)}</span></span>{user && <span className="issue-avatar" title={user.name} style={{ background: user.color }}>{user.name.slice(0, 1)}</span>}</span></button>;
      })}{column.length === 0 && <div className="issue-column-empty">이 상태의 업무가 없습니다</div>}</section>;
    })}</div>}
    {creating && <NewIssueModal {...props} initialStatus={createStatus} onClose={() => setCreating(false)} />}
  </div>;
}

function NewIssueModal({ data, projectId, initialStatus, onClose, refresh, notify, openIssue }: FeatureProps & { initialStatus: IssueStatus; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); setError('');
    try {
      const issue = await post<Issue>('/issues', { projectId: form.get('projectId'), title: String(form.get('title') || '').trim(), description: form.get('description'), type: form.get('type'), status: form.get('status'), priority: form.get('priority'), assigneeId: form.get('assigneeId') || null, startDate: form.get('startDate') || null, endDate: form.get('endDate') || null });
      await refresh(); notify('새 업무를 만들었습니다.'); onClose(); openIssue(issue.id);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <div className="issue-modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}><section className="issue-create-modal" role="dialog" aria-modal="true" aria-labelledby="new-issue-title"><form onSubmit={submit}><header><div><span className="feature-eyebrow">NEW ISSUE</span><h2 id="new-issue-title">새 업무 만들기</h2></div><button className="issue-icon-button" type="button" onClick={onClose} aria-label="닫기"><X size={19} /></button></header><div className="issue-create-fields"><label className="issue-form-label">프로젝트<select name="projectId" className="field" defaultValue={isAll(projectId) ? data.projects[0]?.id : projectId} required>{data.projects.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label><label className="issue-form-label">업무 제목<input autoFocus className="field issue-title-input" name="title" placeholder="무엇을 해야 하나요?" maxLength={300} required /></label><label className="issue-form-label">설명<textarea className="field" name="description" placeholder="배경, 목표, 완료 조건을 적어주세요." rows={4} /></label><div className="issue-form-grid"><label className="issue-form-label">유형<select name="type" className="field" defaultValue="작업">{ISSUE_TYPES.map(t => <option key={t}>{t}</option>)}</select></label><label className="issue-form-label">상태<select name="status" className="field" defaultValue={initialStatus}>{Object.entries(STATUS).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}</select></label><label className="issue-form-label">우선순위<select name="priority" className="field" defaultValue="medium">{Object.entries(PRIORITY).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label><label className="issue-form-label">담당자<select className="field" name="assigneeId"><option value="">미지정</option>{data.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label><label className="issue-form-label">시작일<input type="date" name="startDate" className="field" /></label><label className="issue-form-label">종료일<input type="date" name="endDate" className="field" /></label></div>{error && <div className="issue-form-error" role="alert">{error}</div>}</div><footer><span className="muted">상세 속성은 생성 후에도 수정할 수 있어요.</span><button className="btn btn-ghost" type="button" disabled={busy} onClick={onClose}>취소</button><button className="btn btn-primary" type="submit" disabled={busy || !data.projects.length}>{busy ? '만드는 중…' : <><Plus size={16} /> 업무 만들기</>}</button></footer></form></section></div>;
}
