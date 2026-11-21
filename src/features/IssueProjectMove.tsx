'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import type { IssueProjectMoveInput, IssueProjectMoveMapping, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move';
import type { FeatureProps, Issue, PlanningKind, WorkspaceSnapshot } from '../../shared/types';
import { issueTypeMeta } from '../../shared/issue-schema';
import { projectStatuses, requiredFieldsFor, statusMeta } from '../../shared/workflow-helpers';
import { api, ApiError } from '../lib/api';
import { CustomFields, IssueTypeSelect } from './CustomFields';
import { PLAN_ID_FIELDS, PLAN_LABELS, PlanningSelect } from './PlanningSelectors';
import './issue-project-move.css';

type Props = {
  data: WorkspaceSnapshot;
  issue: Issue;
  draftMessage: string | null;
  beforeApply: () => string | null;
  onDraftChange: (dirty: boolean, pending: boolean, uncertain?: boolean) => void;
  onClose: () => void;
  refresh: FeatureProps['refresh'];
};
type Review = { input: IssueProjectMoveInput; preview: IssueProjectMovePreview };
type ApplyAttempt = { body: string };
const PLAN_KINDS: PlanningKind[] = ['cycle', 'module', 'release'];

function IssueMoveRow({ data, row, projectId, overrides, expanded, update }: {
  data: WorkspaceSnapshot;
  row: IssueProjectMovePreview['issues'][number];
  projectId: string;
  overrides?: IssueProjectMoveMapping;
  expanded: boolean;
  update: (changes: Partial<IssueProjectMoveMapping>) => void;
}) {
  const [open, setOpen] = useState(expanded);
  const mapping = { ...row.mapping, ...overrides };
  const statuses = projectStatuses(data, projectId);
  const type = mapping.type ?? '';
  const status = mapping.status ?? '';
  const required = requiredFieldsFor(data, projectId, type, status);
  return <li className="issue-move-row" data-move-issue-id={row.id}>
    <div className="issue-move-row-title">
      <span className="issue-key">{row.key}</span><ArrowRight size={13} aria-hidden="true" />
      <strong className="issue-move-target-key">{row.targetKey}</strong><span>{row.title}</span>
    </div>
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{row.key} 매핑 편집
        {type && status && <small>{issueTypeMeta(data, projectId, type).name} · {statusMeta(data, projectId, status).label}</small>}
      </summary>
      {open && <div className="issue-move-mapping">
        <div className="issue-move-fields">
          <label>대상 유형<IssueTypeSelect data={data} projectId={projectId} value={type}
            ariaLabel={`${row.key} 대상 유형`} onChange={next => update({ type: next })} /></label>
          <label>대상 상태<select className="field" aria-label={`${row.key} 대상 상태`} value={status}
            onChange={event => update({ status: event.currentTarget.value })}>
            {!statuses.some(option => option.id === status) && <option value={status} disabled>상태 선택</option>}
            {statuses.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select></label>
          {PLAN_KINDS.map(kind => <label key={kind}>{PLAN_LABELS[kind]}
            <PlanningSelect data={data} projectId={projectId} kind={kind} value={mapping[PLAN_ID_FIELDS[kind]] ?? null}
              ariaLabel={`${row.key} 대상 ${PLAN_LABELS[kind]}`} required={required.includes(kind)}
              onChange={value => update({ [PLAN_ID_FIELDS[kind]]: value })} />
          </label>)}
        </div>
        {type && status && <CustomFields data={data} projectId={projectId} issueType={type} status={status}
          values={mapping.customFields ?? {}} requiredFields={required} labelPrefix={`${row.key} `}
          onChange={customFields => update({ customFields })} />}
      </div>}
    </details>
  </li>;
}

export function IssueProjectMove({ data, issue, draftMessage, beforeApply, onDraftChange, onClose, refresh }: Props) {
  const [source] = useState(issue);
  const [projectId, setProjectId] = useState('');
  const [includeConnected, setIncludeConnected] = useState(false);
  const [edits, setEdits] = useState<Record<string, IssueProjectMoveMapping>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [requiresReview, setRequiresReview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [attempt, setAttempt] = useState<ApplyAttempt | null>(null);
  const [receipt, setReceipt] = useState<IssueProjectMoveResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const destination = useRef<HTMLSelectElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const receiptHeading = useRef<HTMLHeadingElement>(null);
  const pending = useRef<AbortController | null>(null);
  const titleId = useId();
  const confirmId = useId();
  const projects = data.projects.filter(project => project.id !== source.projectId);
  const destinationProject = projects.find(project => project.id === projectId);
  const sourceMoved = issue.projectId !== source.projectId;
  const dirty = !receipt && Boolean(projectId || includeConnected || attempt);
  const canApply = Boolean(review?.preview.token && !review.preview.blockers.length && !requiresReview && !sourceMoved &&
    review.input.expectedVersion === issue.version && destinationProject && !draftMessage);
  const path = `/issues/${encodeURIComponent(source.id)}/project-move`;

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    destination.current?.focus({ preventScroll: true });
    return () => { pending.current?.abort(); element?.close(); };
  }, []);
  useLayoutEffect(() => { onDraftChange(dirty, Boolean(busy), Boolean(attempt)); }, [dirty, busy, attempt, onDraftChange]);
  useLayoutEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  useLayoutEffect(() => { if (confirming) confirmButton.current?.focus(); }, [confirming]);
  useLayoutEffect(() => { if (receipt) receiptHeading.current?.focus(); }, [receipt]);

  function close() {
    if (pending.current || refreshing) return;
    if (dirty && !window.confirm(attempt ? '이동 결과를 아직 확인하지 못했습니다. 창을 닫을까요?' : '작성 중인 프로젝트 이동 설정을 버릴까요?')) return;
    onClose();
  }

  function setNeedsReview() {
    setRequiresReview(true);
    setError('');
    setConfirming(false);
  }

  async function syncDrawer() {
    setRefreshing(true);
    setRefreshFailed(false);
    try { await refresh(); }
    catch { setRefreshFailed(true); }
    finally { setRefreshing(false); }
  }

  async function preview() {
    if (pending.current || refreshing || !destinationProject || sourceMoved || attempt) return;
    const request = new AbortController();
    pending.current = request;
    onDraftChange(true, true);
    setBusy('preview');
    setError('');
    setConfirming(false);
    const input: IssueProjectMoveInput = { expectedVersion: issue.version, projectId, includeConnected, mappings: Object.values(edits) };
    let reload = false;
    try {
      const result = await api<IssueProjectMovePreview>(`${path}/preview`, { method: 'POST', signal: request.signal, body: JSON.stringify(input) });
      if (!request.signal.aborted) {
        const reviewedIds = new Set(result.issues.map(row => row.id));
        const relevantEdits = input.mappings.filter(mapping => reviewedIds.has(mapping.issueId));
        const scopeChanged = relevantEdits.length !== input.mappings.length;
        if (scopeChanged) setEdits(Object.fromEntries(relevantEdits.map(mapping => [mapping.issueId, mapping])));
        setReview({ input, preview: result });
        setRequiresReview(scopeChanged);
      }
    } catch (cause) {
      if (!request.signal.aborted) {
        setRequiresReview(true);
        setError(cause instanceof Error ? cause.message : '이동 미리보기를 불러오지 못했습니다.');
        reload = cause instanceof ApiError && (cause.status === 409 || cause.status === 404);
      }
    } finally {
      pending.current = null;
      if (!request.signal.aborted) { onDraftChange(true, false); setBusy(null); }
    }
    if (reload) await syncDrawer();
  }

  async function apply() {
    if (pending.current || refreshing) return;
    const reason = beforeApply();
    if (reason) { setError(reason); return; }
    let submitted = attempt;
    if (!submitted) {
      if (!review?.preview.token || !canApply || !confirming) return;
      submitted = { body: JSON.stringify({ ...review.input, token: review.preview.token }) };
    }
    const request = new AbortController();
    pending.current = request;
    onDraftChange(true, true);
    setBusy('apply');
    setError('');
    let result: IssueProjectMoveResult | undefined;
    let reload = false;
    try {
      const response = await api<IssueProjectMoveResult>(`${path}/apply`, { method: 'POST', signal: request.signal, body: submitted.body });
      if (request.signal.aborted) return;
      if (!response?.issues.some(moved => moved.id === source.id && moved.projectId === projectId)) throw new Error('이동 업무를 확인하지 못했습니다.');
      result = response;
      setReceipt(result);
      setAttempt(null);
      reload = true;
    } catch (cause) {
      if (!request.signal.aborted) {
        if (!(cause instanceof ApiError) || cause.status === 408 || cause.status >= 500) {
          setAttempt(submitted);
          setError('이동 결과를 확인하지 못했습니다. 같은 요청으로 저장 여부를 확인할 수 있습니다.');
        } else {
          setAttempt(null);
          setRequiresReview(true);
          setError(cause.message);
          reload = cause.status === 409 || cause.status === 404;
        }
      }
    } finally {
      pending.current = null;
      if (!request.signal.aborted) {
        onDraftChange(!result, false);
        setBusy(null);
        setConfirming(false);
      }
    }
    if (reload) await syncDrawer();
  }

  const rows = review?.preview.issues ?? [];
  const sourceKeys = new Map(rows.map(row => [row.id, row.key]));
  const blockers = review?.preview.blockers ?? [];
  const warnings = review?.preview.warnings ?? [];

  return <dialog ref={dialog} className="issue-move-dialog" aria-labelledby={titleId} aria-busy={Boolean(busy || refreshing)}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className="issue-move-header">
      <h2 id={titleId}>프로젝트 이동</h2>
      <button className="issue-icon-button" type="button" aria-label="프로젝트 이동 닫기" disabled={Boolean(busy || refreshing)} onClick={close}>
        <X size={19} aria-hidden="true" />
      </button>
    </header>
    <div className="issue-move-content">
      {receipt ? <section className="issue-move-receipt" aria-labelledby={`${titleId}-receipt`}>
        <h3 ref={receiptHeading} id={`${titleId}-receipt`} tabIndex={-1}>프로젝트 이동 완료</h3>
        <ul>{receipt.issues.map(moved => <li key={moved.id}><strong>{moved.key}</strong> {moved.title}</li>)}</ul>
      </section> : <>
        <p className="issue-move-source"><strong>{source.key}</strong> {source.title}</p>
        <fieldset className="issue-move-settings" disabled={Boolean(busy || refreshing || attempt || confirming || sourceMoved)}>
          <label>대상 프로젝트<select ref={destination} className="field" value={projectId} onChange={event => {
            setProjectId(event.currentTarget.value); setEdits({}); setReview(null); setNeedsReview();
          }}>
            <option value="">프로젝트 선택</option>
            {projectId && !destinationProject && <option value={projectId} disabled>선택한 프로젝트를 찾을 수 없음</option>}
            {projects.map(project => <option key={project.id} value={project.id}>{project.name} ({project.key})</option>)}
          </select></label>
          <label className="issue-move-connected"><input type="checkbox" checked={includeConnected} onChange={event => {
            setIncludeConnected(event.currentTarget.checked);
            if (!event.currentTarget.checked) setEdits(previous => previous[source.id] ? { [source.id]: previous[source.id] } : {});
            setReview(null); setNeedsReview();
          }} />연결된 업무 함께 이동</label>
        </fieldset>
        {draftMessage && <p role="status" className="issue-move-notice">{draftMessage}</p>}
        {sourceMoved && !attempt && <p role="status" className="issue-move-notice">업무의 프로젝트가 바뀌었습니다. 창을 닫고 현재 프로젝트에서 다시 확인해 주세요.</p>}
        {review && <section aria-label="이동 대상 업무">
          <h3 ref={reviewHeading} tabIndex={-1}>이동 대상 업무 <small>{rows.length}개</small></h3>
          {(requiresReview || review.input.expectedVersion !== issue.version) && !attempt &&
            <p role="status" className="issue-move-notice">이동 미리보기를 다시 실행해 변경 내용을 확인해 주세요.</p>}
          {blockers.length > 0 && <section className="issue-move-notice is-blocking" aria-label="이동을 막는 항목">
            <h4>이동을 막는 항목</h4><ul>{blockers.map((notice, index) => <li key={`${notice.code}:${index}`}>
              {notice.issueId && sourceKeys.has(notice.issueId) && <strong>{sourceKeys.get(notice.issueId)} </strong>}{notice.message}</li>)}</ul>
          </section>}
          {warnings.length > 0 && <section className="issue-move-notice" aria-label="이동 시 바뀌는 항목">
            <h4>이동 시 바뀌는 항목</h4><ul>{warnings.map((notice, index) => <li key={`${notice.code}:${index}`}>
              {notice.issueId && sourceKeys.has(notice.issueId) && <strong>{sourceKeys.get(notice.issueId)} </strong>}{notice.message}</li>)}</ul>
          </section>}
          <fieldset className="issue-move-review" disabled={Boolean(busy || refreshing || attempt || confirming || sourceMoved)}>
            <ul>{rows.map(row => <IssueMoveRow key={row.id} row={row} data={data} projectId={projectId} overrides={edits[row.id]}
              expanded={row.id === source.id || blockers.some(notice => notice.issueId === row.id)}
              update={changes => {
                setEdits(previous => ({ ...previous, [row.id]: { ...previous[row.id], ...changes, issueId: row.id } })); setNeedsReview();
              }} />)}</ul>
          </fieldset>
        </section>}
        {confirming && <section className="issue-move-confirm" aria-labelledby={confirmId}>
          <h3 id={confirmId}>{destinationProject?.name} 프로젝트에 업무 {rows.length}개를 이동할까요?</h3>
          <p>목록에 표시된 키와 대상 프로젝트 설정을 적용합니다.</p>
        </section>}
      </>}
      {error && <p className="issue-form-error" role="alert">{error}</p>}
      {refreshFailed && <p className="issue-form-error" role="alert">최신 업무를 불러오지 못했습니다. 업무 화면을 새로고침해 주세요.</p>}
    </div>
    <footer className="issue-move-footer">
      {refreshFailed && <button type="button" className="btn" disabled={refreshing} onClick={() => void syncDrawer()}>업무 화면 새로고침</button>}
      {receipt ? <button type="button" className="btn btn-primary" disabled={refreshing} onClick={close}>이동한 업무 보기</button>
        : attempt ? <button type="button" className="btn btn-primary" disabled={Boolean(busy || refreshing)} onClick={() => void apply()}>같은 요청 다시 확인</button>
        : confirming ? <>
          <button type="button" className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => {
            setConfirming(false); requestAnimationFrame(() => applyButton.current?.focus());
          }}>미리보기로 돌아가기</button>
          <button ref={confirmButton} type="button" className="btn btn-primary" disabled={Boolean(busy) || !canApply}
            aria-describedby={confirmId} onClick={() => void apply()}>이동 확정</button>
        </> : <>
          <button type="button" className="btn" disabled={Boolean(busy || refreshing || sourceMoved) || !destinationProject}
            onClick={() => void preview()}>{busy === 'preview' ? '미리보기 불러오는 중' : '이동 미리보기'}</button>
          {review && <button ref={applyButton} type="button" className="btn btn-primary" disabled={Boolean(busy || refreshing) || !canApply}
            onClick={() => setConfirming(true)}>이동 적용</button>}
        </>}
    </footer>
  </dialog>;
}
