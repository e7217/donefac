'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, Check, Link2, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { FeatureProps, Issue, PlanningItem, WorkspaceSnapshot } from '../../shared/types';
import { planningAssignmentBlock, planningFields, PLANNING_META } from '../../shared/planning-helpers';
import { api } from '../lib/api';
import { errorMessage } from './schedule-utils';

export interface GanttPlanAssignmentProps {
  data: FeatureProps['data'];
  item: PlanningItem;
  issues: Issue[];
  actorId: string;
  refresh: FeatureProps['refresh'];
  onDraftChange: (id: string, dirty: boolean, pending?: boolean) => void;
  onClose: () => void;
  onApplied: (updated: Issue[]) => void;
}

type Mode = 'assign' | 'remove';
interface Review {
  item: PlanningItem;
  issues: Issue[];
  actorId: string;
  labels: Record<string, string>;
  missingIssues: string[];
  missingItem: boolean;
}
interface Result { item: PlanningItem; updated: Issue[] }
function capture(data: FeatureProps['data'], item: PlanningItem, issues: Issue[], actorId: string): Review {
  return {
    item: { ...item }, issues: [...new Map(issues.map(issue => [issue.id, { ...issue }])).values()], actorId,
    labels: Object.fromEntries((data.planningItems ?? []).map(plan => [plan.id, plan.name])), missingIssues: [], missingItem: false,
  };
}
function defaultMode(review: Review): Mode {
  const { idField } = planningFields(review.item.kind);
  return planningAssignmentBlock(review.item) || review.issues.length > 0 && review.issues.every(issue => issue[idField] === review.item.id) ? 'remove' : 'assign';
}
function eligible(review: Review, issue: Issue, mode: Mode): boolean {
  if (review.missingItem || review.missingIssues.includes(issue.id) || issue.projectId !== review.item.projectId) return false;
  const { idField } = planningFields(review.item.kind);
  return mode === 'assign' ? !planningAssignmentBlock(review.item) && issue[idField] !== review.item.id : issue[idField] === review.item.id;
}

export function GanttPlanAssignment({ data, item, issues, actorId, refresh, onDraftChange, onClose, onApplied }: GanttPlanAssignmentProps) {
  const [review, setReview] = useState(() => capture(data, item, issues, actorId));
  const [mode, setMode] = useState<Mode>(() => defaultMode(review));
  const [selected, setSelected] = useState(() => new Set(review.issues.filter(issue => eligible(review, issue, defaultMode(review))).map(issue => issue.id)));
  const [pending, setPending] = useState<'apply' | 'reload' | 'refresh' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [committed, setCommitted] = useState<Result | null>(null);
  const mounted = useRef(true), busyRef = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const draftId = `gantt-plan-assignment:${review.item.id}`;
  const idField = planningFields(review.item.kind).idField;
  const labelField = planningFields(review.item.kind).labelField;
  const assignmentBlock = planningAssignmentBlock(review.item);
  const blockingPlanLabel = assignmentBlock === 'archived' ? '보관된 계획' : '완료된 사이클';
  const candidates = review.issues.filter(issue => eligible(review, issue, mode));
  const changes = candidates.filter(issue => selected.has(issue.id));
  const dirty = !committed && changes.length > 0;
  const actorChanged = actorId !== review.actorId;
  const currentItem = data.planningItems?.find(plan => plan.id === review.item.id);
  const remoteChanged = !committed && Boolean(currentItem && currentItem.version > review.item.version || review.issues.some(issue => {
    const current = data.issues.find(value => value.id === issue.id);
    return current && current.version > issue.version;
  }));

  useEffect(() => { onDraftChange(draftId, dirty, Boolean(pending)); }, [draftId, dirty, pending, onDraftChange]);
  useEffect(() => () => onDraftChange(draftId, false, false), [draftId, onDraftChange]);
  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])')?.focus({ preventScroll: true });
    return () => { mounted.current = false; if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, []);

  const close = useCallback(() => { if (!busyRef.current) onClose(); }, [onClose]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const elements = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')).filter(element => element.getClientRects().length > 0);
      const first = elements[0], last = elements.at(-1);
      if (!first) { event.preventDefault(); dialog.current.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [close]);

  function selectMode(next: Mode) {
    if (busyRef.current || committed || next === mode) return;
    const nextSelected = new Set(review.issues.filter(issue => eligible(review, issue, next)).map(issue => issue.id));
    setMode(next); setSelected(nextSelected); setError(''); setNotice('');
    onDraftChange(draftId, nextSelected.size > 0, false);
  }
  function toggle(id: string, checked: boolean) {
    if (busyRef.current || committed) return;
    const next = new Set(selected); if (checked) next.add(id); else next.delete(id);
    setSelected(next); onDraftChange(draftId, candidates.some(issue => next.has(issue.id)), false);
  }
  function begin(kind: NonNullable<typeof pending>) {
    if (busyRef.current) return false;
    busyRef.current = true; setPending(kind); setError(''); onDraftChange(draftId, dirty, true); return true;
  }
  function finish(isDirty: boolean) {
    busyRef.current = false;
    if (mounted.current) { setPending(null); onDraftChange(draftId, isDirty, false); }
  }
  async function reload() {
    if (!begin('reload')) return;
    let nextDirty = dirty;
    try {
      const latest = await api<WorkspaceSnapshot>('/workspace', { headers: { 'X-Actor-Id': actorId } });
      if (!mounted.current) return;
      const latestItem = latest.planningItems?.find(plan => plan.id === review.item.id);
      const latestById = new Map(latest.issues.map(issue => [issue.id, issue]));
      const next: Review = {
        ...capture(latest, latestItem ?? review.item, review.issues.map(issue => latestById.get(issue.id) ?? issue), actorId),
        missingIssues: review.issues.filter(issue => !latestById.has(issue.id)).map(issue => issue.id), missingItem: !latestItem,
      };
      const nextSelected = new Set([...selected].filter(id => next.issues.some(issue => issue.id === id && eligible(next, issue, mode))));
      setReview(next); setSelected(nextSelected); nextDirty = nextSelected.size > 0;
      setNotice(latestItem ? '최신 계획과 업무 버전으로 갱신했습니다. 연결 대상과 기존 계획을 다시 확인한 뒤 적용하세요.' : '계획 항목이 삭제되었습니다. 선택한 업무는 유지했으며 이 항목에는 적용할 수 없습니다.');
      if (next.missingIssues.length) setError(`삭제된 업무 ${next.missingIssues.length}개는 변경 대상에서 제외했습니다.`);
    } catch (cause) { if (mounted.current) setError(`${errorMessage(cause)} 선택과 검토 내용은 유지했습니다.`); }
    finally { finish(nextDirty); }
  }
  async function refreshCommitted() {
    if (!committed || !begin('refresh')) return;
    try { await refresh(); if (mounted.current) setNotice('계획 연결이 적용되었으며 화면도 최신 상태입니다.'); }
    catch (cause) { if (mounted.current) setError(`계획 연결은 이미 적용되었습니다. ${errorMessage(cause)} 화면 불러오기를 다시 시도하세요.`); }
    finally { finish(false); }
  }
  async function apply(event: FormEvent) {
    event.preventDefault();
    if (committed || actorChanged || review.missingItem || !changes.length || changes.length > 1000 || !begin('apply')) return;
    let saved = false;
    try {
      const result = await api<Result>(`/planning-items/${review.item.id}/issues`, {
        method: 'POST', headers: { 'X-Actor-Id': review.actorId },
        body: JSON.stringify({ expectedVersion: review.item.version, assignments: changes.map(issue => ({ issueId: issue.id, expectedVersion: issue.version, assigned: mode === 'assign' })) }),
      });
      saved = true;
      if (!mounted.current) return;
      setCommitted(result); setSelected(new Set());
      const updated = new Map(result.updated.map(issue => [issue.id, issue]));
      setReview(previous => ({ ...previous, item: result.item, issues: previous.issues.map(issue => updated.get(issue.id) ?? issue) }));
      onDraftChange(draftId, false, true);
      setNotice(`${result.updated.length}개 업무의 계획 연결을 ${mode === 'assign' ? '적용' : '해제'}했습니다.`);
      try { onApplied(result.updated); await refresh(); }
      catch (cause) { if (mounted.current) setError(`계획 연결은 이미 적용되었습니다. ${errorMessage(cause)} 화면 불러오기를 다시 시도하세요.`); }
    } catch (cause) { if (mounted.current) setError(`${errorMessage(cause)} 선택을 유지했습니다. 최신 상태를 불러와 검토한 뒤 다시 적용하세요.`); }
    finally { finish(!saved && dirty); }
  }

  function currentLabel(issue: Issue) {
    const current = issue[idField];
    return current ? review.labels[current] || issue[labelField] || '이름을 확인할 수 없는 계획' : '미지정';
  }
  function reason(issue: Issue) {
    if (review.missingIssues.includes(issue.id)) return '삭제된 업무 · 변경 제외';
    if (issue.projectId !== review.item.projectId) return '다른 프로젝트 · 변경 제외';
    if (mode === 'assign' && assignmentBlock) return `${blockingPlanLabel} · 새 연결 불가`;
    if (!eligible(review, issue, mode)) return mode === 'assign' ? '이미 연결됨 · 변경 없음' : '이 계획의 업무가 아님 · 변경 없음';
    if (!selected.has(issue.id)) return '선택하지 않음';
    return mode === 'assign' && issue[idField] ? '기존 같은 종류 계획을 대체' : mode === 'assign' ? '이 계획에 연결' : '이 계획에서 해제';
  }

  return <div className="issue-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="gantt-preview-modal" role="dialog" aria-modal="true" aria-labelledby="gantt-plan-assignment-title" ref={dialog} tabIndex={-1}>
      <header><div><span className="feature-eyebrow">{PLANNING_META[review.item.kind].label} · {review.item.name}</span><h2 id="gantt-plan-assignment-title">계획 업무 연결</h2><p>선택한 업무의 연결만 바꿉니다. 업무 날짜와 상태는 그대로 유지됩니다.</p></div><button type="button" className="issue-icon-button" aria-label="계획 업무 연결 닫기" disabled={Boolean(pending)} onClick={close}><X size={20} /></button></header>
      <form onSubmit={apply}>
        <div className="issue-create-fields">
          <fieldset disabled={Boolean(pending) || Boolean(committed)}><legend>연결 방식</legend><label className="gantt-checkbox-label"><input type="radio" name="gantt-plan-assignment-mode" checked={mode === 'assign'} disabled={Boolean(assignmentBlock)} onChange={() => selectMode('assign')} />이 계획에 연결</label><label className="gantt-checkbox-label"><input type="radio" name="gantt-plan-assignment-mode" checked={mode === 'remove'} onChange={() => selectMode('remove')} />이 계획에서 해제</label></fieldset>
          {assignmentBlock && <p className="issue-section-empty">{blockingPlanLabel}에는 새 업무를 연결할 수 없습니다. 기존 연결은 해제할 수 있습니다.</p>}
          <p className="issue-section-empty">선택 업무 {review.issues.length}개 · 변경 대상 {changes.length}개. 같은 종류의 다른 계획이 있으면 선택한 계획으로 대체합니다.</p>
          {!committed && (remoteChanged || actorChanged) && <div className="issue-form-error" role="status"><AlertCircle size={14} />{actorChanged ? '작업자가 변경되었습니다. 최신 상태를 불러온 뒤 검토하세요.' : '검토 이후 다른 변경이 있습니다. 입력은 유지되며 적용할 때 버전을 확인합니다.'}</div>}
          {!committed && !candidates.length && <p className="issue-section-empty">이 방식으로 변경할 업무가 없습니다. 이미 같은 연결인 업무는 다시 저장하지 않습니다.</p>}
          {changes.length > 1000 && <div className="issue-form-error" role="alert">한 번에 최대 1,000개 업무까지 연결할 수 있습니다. 선택을 줄여 주세요.</div>}
          {notice && <p className="issue-section-empty" role="status">{notice}</p>}
          {error && <div className="issue-form-error" role="alert">{error}</div>}
        </div>
        <div className="gantt-preview-table"><table><thead><tr><th>업무</th><th>현재 {PLANNING_META[review.item.kind].label}</th><th>변경 내용</th></tr></thead><tbody>{review.issues.map(issue => <tr key={issue.id}><td><label><input type="checkbox" aria-label={`${issue.key} 계획 변경 선택`} checked={eligible(review, issue, mode) && selected.has(issue.id)} disabled={Boolean(pending) || Boolean(committed) || !eligible(review, issue, mode)} onChange={event => toggle(issue.id, event.target.checked)} /><span className="issue-key"> {issue.key}</span><strong title={issue.title}>{issue.title}</strong></label></td><td>{currentLabel(issue)}</td><td>{reason(issue)}</td></tr>)}</tbody></table></div>
        <footer><span>{committed ? '저장된 연결은 다시 적용하지 않습니다.' : '계획과 각 업무의 검토 버전을 함께 확인합니다.'}</span><button className="btn btn-ghost" type="button" disabled={Boolean(pending)} onClick={close}>닫기</button>{committed ? <button className="btn" type="button" disabled={Boolean(pending)} onClick={() => void refreshCommitted()}><RefreshCw size={14} />{pending === 'refresh' ? '불러오는 중…' : '화면 다시 불러오기'}</button> : <><button className="btn" type="button" disabled={Boolean(pending)} onClick={() => void reload()}><RefreshCw size={14} />{pending === 'reload' ? '불러오는 중…' : '최신 상태 불러오기'}</button><button className="btn btn-primary" type="submit" disabled={Boolean(pending) || actorChanged || review.missingItem || !changes.length || changes.length > 1000}>{pending === 'apply' ? <LoaderCircle size={14} className="spin" /> : mode === 'assign' ? <Link2 size={14} /> : <Check size={14} />}{pending === 'apply' ? '적용 중…' : mode === 'assign' ? '계획 연결 적용' : '계획 연결 해제'}</button></>}</footer>
      </form>
    </section>
  </div>;
}
