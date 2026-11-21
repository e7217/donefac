'use client';

import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { ArrowDown, ArrowDownUp, ArrowUp, ListTodo, Loader2, Search, X } from 'lucide-react';
import { orderProjectIssues } from '../../shared/issue-view';
import { PRIORITY, type CycleBoardMoveInput, type CycleBoardMoveResult, type FeatureProps, type Issue, type PlanningItem } from '../../shared/types';
import { statusMeta } from '../../shared/workflow-helpers';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import { errorMessage } from './schedule-utils';
import './cycle-board.css';

type Props = FeatureProps & {
  initialCycleId?: string | null;
  onChangeCycle: (id: string) => boolean;
  onOpenPlanning: (id: string) => void;
  onOpenIssues: () => void;
};
type CycleRef = CycleBoardMoveInput['sourceCycle'];
type MoveTarget = Pick<CycleBoardMoveInput, 'anchorId' | 'position'> & { cycleId: string | null };
type Attempt = { input: CycleBoardMoveInput; issueKey: string };
type Hold = { stage: 'conflict' } | { stage: 'uncertain' | 'confirmed'; attempt: Attempt };
type Feedback = { text: string; error?: boolean };
type DragSource = { issue: Issue; input: Pick<CycleBoardMoveInput,'sourceCycle'|'expectedVersion'> };
const BACKLOG = 'backlog';
const CYCLE_OPTION_PREFIX = 'cycle:';
const DRAG_TYPE = 'application/x-teamspace-cycle-board';
const cycleIdOf = (issue: Issue) => issue.cycleId ?? null;
const cycleRef = (cycle: PlanningItem): NonNullable<CycleRef> => ({ id: cycle.id, expectedVersion: cycle.version });
const nameOf = (issue: Issue) => `${issue.key} · ${issue.title}`;
const collator = new Intl.Collator('ko', { numeric: true });

function isDefiniteRejection(cause: unknown, replay: boolean) {
  return cause instanceof ApiError && cause.status >= 400 && cause.status < 500 &&
    ![408, 425, 429, 499].includes(cause.status) && (!replay || ![401, 403].includes(cause.status));
}

export function CycleBoard(props: Props) {
  return <ProjectCycleBoard key={JSON.stringify([props.projectId, props.actorId])} {...props} />;
}

function ProjectCycleBoard({ data, projectId, actorId, openIssue, refresh, notify,
  initialCycleId, onChangeCycle, onOpenPlanning, onOpenIssues, }: Props) {
  const uid = useId();
  const [search, setSearch] = useState('');
  const [moveIssue, setMoveIssue] = useState<Issue | null>(null);
  const [pending, setPending] = useState(false);
  const [hold, setHold] = useState<Hold | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [drop, setDrop] = useState<MoveTarget | null>(null);
  const request = useRef<AbortController | null>(null);
  const draft = useRef(false);
  const held = useRef<Hold | null>(null);
  const moveOpener = useRef<HTMLButtonElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const rowOpeners = useRef(new Map<string, HTMLButtonElement>());
  const dragSource = useRef<DragSource | null>(null);
  const focusTarget = useRef<string | null>(null);

  const project = data.projects.find(item => item.id === projectId);
  const order = data.issueOrders?.find(item => item.projectId === projectId);
  const issues = useMemo(() => orderProjectIssues(data.issues.filter(issue => issue.projectId === projectId), order), [data.issues, order, projectId]);
  const users = useMemo(() => new Map(data.users.map(item => [item.id, item])), [data.users]);
  const cycles = useMemo(() => (data.planningItems ?? []).filter(item => item.projectId === projectId &&
    item.kind === 'cycle' && (item.status === 'active' || item.status === 'planned'))
    .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') ||
      (left.startDate ?? '9999-99-99').localeCompare(right.startDate ?? '9999-99-99') || collator.compare(left.name, right.name)),
    [data.planningItems, projectId]);
  const cycle = cycles.find(item => item.id === initialCycleId) ?? cycles[0];
  const cycleId = cycle?.id;
  const backlog = issues.filter(issue => cycleIdOf(issue) === null);
  const members = cycleId ? issues.filter(issue => cycleIdOf(issue) === cycleId) : [];
  const writable = Boolean(order && actorId && !pending && !hold);
  const terms = search.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  const matchesSearch = (issue: Issue) => terms.every(term => nameOf(issue).toLocaleLowerCase().includes(term));

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (request.current) {
        event.preventDefault();
        notify('업무 이동이 끝난 뒤 이동해 주세요.', 'error');
        return;
      }
      const uncertain = held.current?.stage === 'uncertain';
      if (!draft.current && !uncertain) return;
      if (!window.confirm(uncertain
        ? '업무가 이미 이동했을 수 있습니다. 이동 결과 확인을 닫고 나갈까요?'
        : '입력한 사이클 이동을 버리고 나갈까요?')) {
        event.preventDefault();
        return;
      }
      afterAcceptedNavigation(event, () => {
        draft.current = false;
        held.current = null;
        setMoveIssue(null);
        setHold(null);
        setFeedback(null);
      });
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (request.current || draft.current || held.current?.stage === 'uncertain') {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [notify]);

  useEffect(() => () => { request.current?.abort(); }, []);

  useEffect(() => {
    const target = focusTarget.current;
    if (!target || pending) return;
    const issue = issues.find(item => item.id === target);
    const destination = issue?.cycleId;
    if (destination && destination !== cycleId && cycles.some(item => item.id === destination) && onChangeCycle(destination)) return;
    focusTarget.current = null;
    const row = rowOpeners.current.get(target);
    (row ?? searchInput.current)?.focus({ preventScroll: !row });
  }, [cycleId, cycles, issues, onChangeCycle, pending]);

  function keep(value: Hold | null) {
    held.current = value;
    setHold(value);
  }

  function closeMove(restoreFocus: boolean) {
    const opener = moveOpener.current;
    moveOpener.current = null;
    draft.current = false;
    setMoveIssue(null);
    if (restoreFocus) requestAnimationFrame(() => {
      (opener?.isConnected ? opener : searchInput.current)?.focus({ preventScroll: true });
    });
  }

  function begin() {
    if (request.current) return null;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    return controller;
  }

  function finish(controller: AbortController) {
    if (request.current !== controller || controller.signal.aborted) return;
    request.current = null;
    setPending(false);
  }

  async function reflect(attempt: Attempt, controller: AbortController) {
    try {
      await refresh();
      if (controller.signal.aborted) return;
      keep(null);
      setFeedback({ text: `${attempt.issueKey} 업무 이동을 확인했습니다.` });
      focusTarget.current = attempt.input.issueId;
    } catch {
      if (controller.signal.aborted) return;
      setFeedback({ text: `${attempt.issueKey} 업무는 이동했습니다. 최신 화면을 불러오지 못했습니다.`, error: true });
    }
  }

  async function submit(attempt: Attempt, replay = false) {
    const controller = begin();
    if (!controller) return;
    setFeedback({ text: replay ? '이전 이동 요청의 결과를 확인하는 중입니다.' : `${attempt.issueKey} 업무를 이동하는 중입니다.` });
    try {
      const result = await api<CycleBoardMoveResult>(`/projects/${encodeURIComponent(projectId)}/cycle-board/move`, {
        method: 'POST', headers: { 'X-Actor-Id': actorId }, signal: controller.signal, body: JSON.stringify(attempt.input),
      });
      if (controller.signal.aborted) return;
      if (!result?.order || result.order.projectId !== projectId || typeof result.duplicate !== 'boolean' ||
        result.issue?.id !== attempt.input.issueId || result.issue.projectId !== projectId ||
        (!result.duplicate && cycleIdOf(result.issue) !== (attempt.input.targetCycle?.id ?? null))) {
        throw new Error('이동 응답을 확인할 수 없습니다.');
      }
      keep({ stage: 'confirmed', attempt });
      await reflect(attempt, controller);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (!isDefiniteRejection(cause, replay)) {
        keep({ stage: 'uncertain', attempt });
        setFeedback({ text: '업무 이동 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.', error: true });
      } else if (cause instanceof ApiError && [404, 409].includes(cause.status)) {
        keep({ stage: 'conflict' });
        setFeedback({ text: `${cause.message} 최신 업무를 불러온 뒤 이동을 다시 선택해 주세요.`, error: true });
      } else {
        keep(null);
        setFeedback({ text: errorMessage(cause), error: true });
      }
    } finally { finish(controller); }
  }

  async function retryRefresh() {
    if (!hold || hold.stage === 'uncertain') return;
    const controller = begin();
    if (!controller) return;
    try {
      if (hold.stage === 'confirmed') {
        await reflect(hold.attempt, controller);
      } else {
        await refresh();
        if (controller.signal.aborted) return;
        keep(null);
        setFeedback({ text: '최신 업무와 사이클을 불러왔습니다. 이동을 다시 선택하세요.' });
        requestAnimationFrame(() => searchInput.current?.focus({ preventScroll: true }));
      }
    } catch {
      if (!controller.signal.aborted) setFeedback({ text: '최신 업무를 불러오지 못했습니다. 다시 시도해 주세요.', error: true });
    } finally { finish(controller); }
  }

  function move(issue: Issue, target: MoveTarget, captured?: DragSource['input']) {
    if (!writable || request.current || !order || target.anchorId === issue.id) return;
    const source = cycles.find(item => item.id === cycleIdOf(issue));
    const destination = cycles.find(item => item.id === target.cycleId);
    if ((cycleIdOf(issue) !== null && !source) || (target.cycleId !== null && !destination)) {
      closeMove(true);
      keep({ stage: 'conflict' });
      setFeedback({ text: '업무 또는 사이클이 바뀌었습니다. 최신 업무를 불러와 주세요.', error: true });
      return;
    }
    const input: CycleBoardMoveInput = {
      requestId: newRequestId(), issueId: issue.id, expectedVersion: captured?.expectedVersion ?? order.version,
      expectedIssueVersion: issue.version,
      sourceCycle: captured ? captured.sourceCycle : source ? cycleRef(source) : null,
      targetCycle: destination ? cycleRef(destination) : null, anchorId: target.anchorId, position: target.position,
    };
    closeMove(false);
    void submit({ input, issueKey: issue.key });
  }

  function clearDrag() {
    dragSource.current = null;
    setDrop(null);
  }

  function dragStart(event: DragEvent<HTMLElement>, issue: Issue) {
    if (!writable || !order) { event.preventDefault(); return; }
    const source = cycles.find(item => item.id === cycleIdOf(issue));
    dragSource.current = { issue, input: { sourceCycle: source ? cycleRef(source) : null, expectedVersion: order.version } };
    event.dataTransfer.setData(DRAG_TYPE, issue.id);
    event.dataTransfer.effectAllowed = 'move';
  }

  function placement(event: DragEvent<HTMLElement>, targetCycleId: string | null): MoveTarget {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-cycle-board-card]') : null;
    const anchorId = row?.dataset.cycleBoardCard;
    if (!row || !anchorId) return { cycleId: targetCycleId, anchorId: null, position: 'after' };
    const rect = row.getBoundingClientRect();
    return { cycleId: targetCycleId, anchorId, position: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after' };
  }

  function dragOver(event: DragEvent<HTMLElement>, targetCycleId: string | null) {
    if (!writable || !dragSource.current || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const target = placement(event, targetCycleId);
    setDrop(previous => previous?.anchorId === target.anchorId && previous.position === target.position &&
      previous.cycleId === target.cycleId ? previous : target);
  }

  function dropOn(event: DragEvent<HTMLElement>, targetCycleId: string | null) {
    const source = dragSource.current;
    if (!writable || !source || event.dataTransfer.getData(DRAG_TYPE) !== source.issue.id) return;
    event.preventDefault();
    const target = placement(event, targetCycleId);
    clearDrag();
    move(source.issue, target, source.input);
  }


  if (!project) return <section className="cycle-board"><h1>백로그 · 사이클</h1><p>프로젝트를 선택해 주세요.</p></section>;
  return <section className="cycle-board" aria-labelledby={`${uid}-title`}>
    <header className="cycle-board-heading">
      <div><h1 id={`${uid}-title`}>백로그 · 사이클</h1><p>{project.name}</p></div>
      <button type="button" className="btn" onClick={onOpenIssues}><ListTodo size={16} aria-hidden="true" /> 업무 목록</button>
    </header>
    <div className="cycle-board-toolbar">
      <div>
        <label htmlFor={`${uid}-search`}>업무 검색</label>
        <div className="cycle-board-search"><Search size={16} aria-hidden="true" />
          <input id={`${uid}-search`} className="field" type="text" ref={searchInput} value={search}
            placeholder="업무 키 또는 제목" onChange={event => setSearch(event.currentTarget.value)} /></div>
      </div>
      <div>
        <label htmlFor={`${uid}-cycle`}>보고 있는 사이클</label>
        <select id={`${uid}-cycle`} className="field" value={cycleId ?? ''} disabled={pending || !cycles.length}
          onChange={event => { if (event.currentTarget.value) onChangeCycle(event.currentTarget.value); }}>
          {!cycles.length && <option value="">선택할 사이클 없음</option>}
          {cycles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status === 'active' ? '진행 중' : '계획'}</option>)}
        </select>
      </div>
    </div>
    {(feedback || hold) && <div className="cycle-board-feedback" data-error={feedback?.error || undefined}>
      {feedback && <p role={feedback.error ? 'alert' : 'status'}>{pending && <Loader2 size={15} className="spin" aria-hidden="true" />}{feedback.text}</p>}
      {hold?.stage === 'uncertain' ? <button className="btn btn-primary" type="button" disabled={pending}
        onClick={() => void submit(hold.attempt, true)}>이동 결과 다시 확인</button> : hold && <button className="btn btn-primary" type="button" disabled={pending}
        onClick={() => void retryRefresh()}>{hold.stage === 'conflict' ? '최신 업무 불러오기' : '화면에 다시 반영'}</button>}
    </div>}
    <div className="cycle-board-lanes">
      {[{ items: backlog, targetCycle: undefined }, ...(cycle ? [{ items: members, targetCycle: cycle }] : [])]
        .map(({ items, targetCycle }) => {
          const targetId = targetCycle?.id ?? null;
          const visible = items.filter(matchesSearch);
          const done = items.filter(item => statusMeta(data, projectId, item.status).category === 'done').length;
          const dateRange = targetCycle && [targetCycle.startDate, targetCycle.endDate].some(Boolean)
            ? `${targetCycle.startDate ?? '시작일 미정'} ~ ${targetCycle.endDate ?? '종료일 미정'}` : '일정 미정';
          return <section className="cycle-board-lane" key={targetCycle ? `cycle:${targetCycle.id}` : BACKLOG}
            aria-label={targetCycle ? '선택한 사이클' : '백로그'}
            data-cycle-id={targetId ?? ''} data-drop-lane={drop?.cycleId === targetId || undefined}
            onDragOver={event => dragOver(event, targetId)} onDrop={event => dropOn(event, targetId)}
            onDragLeave={event => {
              if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDrop(null);
            }}>
            <div className="cycle-board-lane-header">
              <div>
                <h2>{targetCycle ? targetCycle.name : '백로그'}</h2>
                <p>{targetCycle ? <>{targetCycle.status === 'active' ? '진행 중' : '계획'} · {dateRange}</> : '사이클 미지정'}
                  {' · '}{terms.length ? `${visible.length}/${items.length}` : items.length}개{targetCycle && ` · 완료 ${done}개`}</p>
              </div>
              {targetCycle && <button className="btn btn-ghost" type="button" onClick={() => onOpenPlanning(targetCycle.id)}>사이클 상세</button>}
            </div>
            {visible.length ? <ol className="cycle-board-rows">{visible.map((issue, index) => {
              const status = statusMeta(data, projectId, issue.status);
              const owner = issue.assigneeId ? users.get(issue.assigneeId) : null;
              const before = visible[index - 1];
              const after = visible[index + 1];
              const inDrop = drop?.anchorId === issue.id && drop.cycleId === targetId ? drop.position : undefined;
              return <li key={issue.id} className="cycle-board-row" data-issue-id={issue.id} data-cycle-board-card={issue.id}
                data-drop-position={inDrop} draggable={writable}
                onDragStart={event => dragStart(event, issue)} onDragEnd={clearDrag}>
                <div className="cycle-board-row-copy">
                  <button ref={button => { if (button) rowOpeners.current.set(issue.id, button); else rowOpeners.current.delete(issue.id); }}
                    type="button" className="cycle-board-issue" aria-label={nameOf(issue)} onClick={() => openIssue(issue.id)}>
                    <span>{issue.key}</span><span aria-hidden="true">·</span><strong>{issue.title}</strong>
                  </button>
                  <div className="cycle-board-row-meta">
                    <span><i aria-hidden="true" style={{ background: status.color }} />{status.label}</span>
                    <span>우선순위 {PRIORITY[issue.priority]}</span>
                    <span>{owner?.name ?? (issue.assigneeId ? '담당자 확인 불가' : '담당자 미지정')}</span>
                  </div>
                </div>
                <div className="cycle-board-row-actions">
                  <button className="btn btn-ghost" type="button" aria-label={`${issue.key} 위로 이동`} title="위로 이동"
                    aria-disabled={!writable || !before} onClick={() => { if (before) move(issue, { cycleId: targetId, anchorId: before.id, position: 'before' }); }}>
                    <ArrowUp size={15} aria-hidden="true" />
                  </button>
                  <button className="btn btn-ghost" type="button" aria-label={`${issue.key} 아래로 이동`} title="아래로 이동"
                    aria-disabled={!writable || !after} onClick={() => { if (after) move(issue, { cycleId: targetId, anchorId: after.id, position: 'after' }); }}>
                    <ArrowDown size={15} aria-hidden="true" />
                  </button>
                  <button className="btn" type="button" disabled={!writable || (targetId === null && !cycles.length)}
                    aria-label={`${issue.key} 사이클 이동`} onClick={event => {
                      moveOpener.current = event.currentTarget;
                      setMoveIssue(issue);
                    }}>사이클 이동</button>
                </div>
              </li>;
            })}</ol> : <p className="cycle-board-empty">{terms.length ? '검색에 맞는 업무가 없습니다.' : '아직 배정된 업무가 없습니다.'}</p>}
          </section>;
        })}
      {!cycle && <section className="cycle-board-lane" aria-label="선택한 사이클">
        <div className="cycle-board-lane-header"><h2>사이클</h2></div>
        <p className="cycle-board-empty">계획 또는 진행 중인 사이클이 없습니다.</p>
      </section>}
    </div>
    {moveIssue && <CycleAssignmentDialog issue={moveIssue} cycles={cycles} onClose={() => closeMove(true)}
      onDraft={value => { draft.current = value; }}
      onMove={id => move(moveIssue, { cycleId: id, anchorId: null, position: 'after' })} />}
  </section>;
}

function CycleAssignmentDialog({ issue, cycles, onClose, onDraft, onMove }: {
  issue: Issue;
  cycles: readonly PlanningItem[];
  onClose: () => void;
  onDraft: (value: boolean) => void;
  onMove: (id: string | null) => void;
}) {
  const uid = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const [destination, setDestination] = useState('');
  const source = cycleIdOf(issue);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    select.current?.focus({ preventScroll: true });
    return () => element.close();
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (destination) onMove(destination === BACKLOG ? null : destination.slice(CYCLE_OPTION_PREFIX.length));
  }

  return <dialog className="cycle-board-dialog" ref={dialog} aria-labelledby={`${uid}-title`} aria-describedby={`${uid}-issue`}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="cycle-board-dialog-header">
      <div><h2 id={`${uid}-title`}>사이클 이동</h2><p id={`${uid}-issue`}>{nameOf(issue)}</p></div>
      <button type="button" className="btn btn-ghost" aria-label="사이클 이동 닫기" onClick={onClose}><X size={18} aria-hidden="true" /></button>
    </div>
    <form onSubmit={submit}>
      <label htmlFor={`${uid}-destination`}>이동할 사이클</label>
      <select id={`${uid}-destination`} className="field" ref={select} value={destination}
        onChange={event => { setDestination(event.currentTarget.value); onDraft(Boolean(event.currentTarget.value)); }}>
        <option value="">이동할 곳 선택</option>
        {source !== null && <option value={BACKLOG}>백로그</option>}
        {cycles.filter(cycle => cycle.id !== source).map(cycle => <option key={cycle.id} value={`${CYCLE_OPTION_PREFIX}${cycle.id}`}>{cycle.name}</option>)}
      </select>
      <div className="cycle-board-dialog-actions">
        <button type="submit" className="btn btn-primary" disabled={!destination}><ArrowDownUp size={15} aria-hidden="true" /> 이동 적용</button>
      </div>
    </form>
  </dialog>;
}
