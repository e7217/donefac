'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, RefreshCw, X } from 'lucide-react';
import type { CycleCompletionIssue, CycleCompletionPreview, CycleCompletionResult, FeatureProps, PlanningItem } from '../../shared/types';
import { ApiError, api } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { errorMessage } from './schedule-utils';
import './cycle-completion.css';

const BACKLOG = 'backlog';
const BACKLOG_LABEL = '백로그 (사이클 미지정)';
const cycleOption = (id: string) => `cycle:${id}`;
const GROUPS = [
  ['carry', '이동할 업무'], ['done', '완료 상태 업무'], ['cancelled', '취소 상태 업무'],
] as const satisfies Array<readonly [CycleCompletionIssue['disposition'], string]>;

type Operation = 'preview' | 'apply' | 'latest' | 'refresh';
type Props = Pick<FeatureProps, 'actorId' | 'notify' | 'refresh'> & {
  cycle: PlanningItem;
  plans: readonly PlanningItem[];
  onClose: () => void;
  onSaved: (cycle: PlanningItem) => void;
  restoreFocus: () => void;
};

function discardMessage(unknown: boolean) {
  return unknown ? '완료 요청의 결과를 아직 확인하지 못했습니다. 완료 검토를 닫을까요?' : '이동 대상과 완료 미리보기를 버리고 닫을까요?';
}

function staleResponse(cause: unknown) {
  return cause instanceof ApiError && [404, 409, 410].includes(cause.status);
}

export function CycleCompletionPanel({ cycle, plans, actorId, notify, refresh, onClose, onSaved, restoreFocus }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const destinationInput = useRef<HTMLSelectElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const outcome = useRef<HTMLParagraphElement>(null);
  const request = useRef<AbortController | null>(null);
  const [current, setCurrent] = useState(cycle);
  const [destination, setDestination] = useState('');
  const [preview, setPreview] = useState<CycleCompletionPreview | null>(null);
  const [result, setResult] = useState<CycleCompletionResult | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [needsLatest, setNeedsLatest] = useState(false);
  const [missingCycle, setMissingCycle] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [error, setError] = useState('');
  const choices = plans.filter(plan => plan.id !== current.id && plan.projectId === current.projectId &&
    plan.kind === 'cycle' && (plan.status === 'planned' || plan.status === 'active'));
  const chosenCycle = choices.find(plan => cycleOption(plan.id) === destination);
  const invalidDestination = Boolean(destination && destination !== BACKLOG && !chosenCycle);
  const inactive = missingCycle || current.status !== 'active';
  const dirty = !result && Boolean(destination || preview || unknown);
  const path = `/planning-items/${encodeURIComponent(current.id)}`;
  const headers = { 'X-Actor-Id': actorId };

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    destinationInput.current?.focus({ preventScroll: true });
    return () => {
      request.current?.abort();
      request.current = null;
      element.close();
      restoreFocus();
    };
  }, [restoreFocus]);

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (request.current) {
        event.preventDefault();
        notify('사이클 완료 요청이 끝난 뒤 이동해 주세요.', 'error');
      } else if (dirty && !window.confirm(discardMessage(unknown))) event.preventDefault();
      else afterAcceptedNavigation(event, onClose);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!request.current && !dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    window.addEventListener('teamspace:workspace-imported', onClose);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('teamspace:workspace-imported', onClose);
    };
  }, [dirty, notify, onClose, unknown]);

  useEffect(() => {
    if (result) outcome.current?.focus();
    else if (preview) previewHeading.current?.focus();
  }, [preview, result]);

  function close() {
    if (!request.current && (!dirty || window.confirm(discardMessage(unknown)))) onClose();
  }

  async function run(kind: Operation, action: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(kind);
    setError('');
    try { await action(controller.signal); }
    catch (cause) { if (!controller.signal.aborted) setError(errorMessage(cause)); }
    finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(null);
      }
    }
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!destination || invalidDestination || needsLatest || inactive || unknown || result) return;
    void run('preview', async signal => {
      setPreview(null);
      try {
        const checked = await api<CycleCompletionPreview>(`${path}/complete/preview`, {
          method: 'POST', signal, headers,
          body: JSON.stringify({ expectedVersion: current.version, destinationId: chosenCycle?.id ?? null }),
        });
        if (!signal.aborted) setPreview(checked);
      } catch (cause) {
        if (!signal.aborted && (staleResponse(cause) || (cause instanceof ApiError && cause.status === 422))) setNeedsLatest(true);
        throw cause;
      }
    });
  }

  async function refreshWorkspace(signal: AbortSignal) {
    try {
      await refresh();
      if (!signal.aborted) setRefreshFailed(false);
    } catch { if (!signal.aborted) setRefreshFailed(true); }
  }

  function apply() {
    if (!preview?.previewId || preview.counts.blocked > 0 || result || needsLatest) return;
    const { previewId } = preview;
    void run('apply', async signal => {
      let saved: CycleCompletionResult;
      try {
        saved = await api<CycleCompletionResult>(`${path}/complete`, {
          method: 'POST', signal, headers, body: JSON.stringify({ previewId }),
        });
        if (saved?.cycle?.id !== current.id || saved.cycle.status !== 'completed' || !saved.counts) throw new Error('완료 응답을 확인하지 못했습니다.');
      } catch (cause) {
        if (signal.aborted) return;
        if (staleResponse(cause)) {
          setNeedsLatest(true);
          setUnknown(false);
          setPreview(null);
          throw cause;
        }
        if (!unknown && cause instanceof ApiError && [400, 401, 403, 422].includes(cause.status)) {
          setPreview(null);
          throw cause;
        }
        setUnknown(true);
        throw new Error('완료 요청의 결과를 확인하지 못했습니다. 같은 요청의 결과를 다시 확인할 수 있습니다.');
      }
      if (signal.aborted) return;
      setResult(saved);
      setUnknown(false);
      onSaved(saved.cycle);
      notify(`${saved.cycle.name} 사이클을 완료했습니다.`);
      await refreshWorkspace(signal);
    });
  }

  function loadLatest() {
    void run('latest', async signal => {
      try {
        const [latest] = await Promise.all([api<PlanningItem>(path, { signal, headers }), refresh()]);
        if (signal.aborted) return;
        setCurrent(latest);
        onSaved(latest);
        setMissingCycle(false);
        setNeedsLatest(false);
        setPreview(null);
        destinationInput.current?.focus({ preventScroll: true });
      } catch (cause) {
        if (!signal.aborted && cause instanceof ApiError && cause.status === 404) setMissingCycle(true);
        throw cause;
      }
    });
  }

  return <dialog ref={dialog} className="cycle-completion-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header>
      <h2 id={titleId}>사이클 완료</h2>
      <button className="btn btn-ghost" type="button" aria-label="사이클 완료 닫기" disabled={Boolean(busy)} onClick={close}><X size={19} /></button>
    </header>
    <div className="cycle-completion-body" aria-busy={Boolean(busy)}>
      <p id={descriptionId}><strong>{current.name}</strong> 사이클의 미완료 업무 이동을 검토합니다. 완료·취소 상태의 업무는 현재 사이클에 남습니다.</p>
      {result ? <>
        <div className="cycle-completion-result">
          <p ref={outcome} tabIndex={-1} role="status">사이클을 완료했습니다.</p>
          <p>{result.counts.carry}건 이동 · 완료 {result.counts.done}건 유지 · 취소 {result.counts.cancelled}건 유지</p>
          {result.counts.carry > 0 && <p>이동 대상 {result.destination?.name ?? BACKLOG_LABEL}</p>}
        </div>
        {refreshFailed && <div className="cycle-completion-feedback">
          <p role="alert">완료 결과를 저장했습니다. 계획 목록의 최신 업무를 불러오지 못했습니다.</p>
          <button className="btn btn-ghost" type="button" disabled={Boolean(busy)} onClick={() => void run('refresh', refreshWorkspace)}><RefreshCw size={14} />최신 업무 불러오기</button>
        </div>}
      </> : <>
        <form className="cycle-completion-form" onSubmit={review}>
          <label>
            미완료 업무 이동 대상
            <select className="field" ref={destinationInput} value={destination} required disabled={Boolean(busy || unknown || inactive)}
              onChange={event => { setDestination(event.target.value); setPreview(null); setError(''); }}>
              <option value="">이동 대상 선택</option>
              <option value={BACKLOG}>{BACKLOG_LABEL}</option>
              {invalidDestination && <option value={destination} disabled>이전 선택을 사용할 수 없습니다</option>}
              {choices.map(plan => <option value={cycleOption(plan.id)} key={plan.id}>{plan.name} ({plan.status === 'planned' ? '계획' : '진행 중'})</option>)}
            </select>
          </label>
          <button type="submit" className="btn" disabled={!destination || invalidDestination || inactive || needsLatest || Boolean(busy || unknown)}>
            {busy === 'preview' ? '업무 확인 중…' : '완료 미리보기'}
          </button>
        </form>
        {inactive && <p className="issue-form-error" role="alert">{missingCycle ? '사이클을 찾을 수 없습니다.' : '사이클 상태가 변경되었습니다. 진행 중인 사이클에서 완료를 시작할 수 있습니다.'}</p>}
        {error && <p className="issue-form-error" role="alert">{error}</p>}
        {needsLatest && !missingCycle && <button type="button" className="btn btn-ghost" disabled={Boolean(busy)} onClick={loadLatest}><RefreshCw size={14} />최신 사이클 확인</button>}
        {preview && <div className="cycle-completion-preview">
          <h3 ref={previewHeading} tabIndex={-1}>사이클 완료 미리보기</h3>
          <p>이동 대상 {preview.destination?.name ?? BACKLOG_LABEL}</p>
          {preview.counts.blocked > 0 && <p className="cycle-completion-blocked" role="alert">업무 {preview.counts.blocked}건을 이동할 수 없습니다. 아래 사유를 확인해 주세요.</p>}
          {GROUPS.map(([key, label]) => <section className="cycle-completion-group" key={key}>
            <h4>{label} {preview.counts[key]}건</h4>
            {preview.issues.some(issue => issue.disposition === key) && <ul>
              {preview.issues.filter(issue => issue.disposition === key).map(issue => <li key={issue.id}>
                <span className="cycle-completion-issue"><span className="issue-key">{issue.key}</span> <strong>{issue.title}</strong></span>
                <span>{issue.statusLabel}</span>
                {issue.blockedReason && <p className="cycle-completion-blocked">{issue.blockedReason}</p>}
              </li>)}
            </ul>}
          </section>)}
        </div>}
      </>}
    </div>
    <footer>
      <button className="btn btn-ghost" type="button" disabled={Boolean(busy)} onClick={close}>닫기</button>
      {!result && preview && <button className="btn btn-primary" type="button" disabled={Boolean(busy || needsLatest || !preview.previewId || preview.counts.blocked)} onClick={apply}>
        {unknown ? <RefreshCw size={15} /> : <Check size={15} />}{unknown ? '같은 완료 요청 다시 확인' : '사이클 완료 적용'}
      </button>}
    </footer>
  </dialog>;
}
