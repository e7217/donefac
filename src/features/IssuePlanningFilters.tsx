'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CalendarRange, Check } from 'lucide-react';
import { ISSUE_VIEW_RELEASE_LIMIT, parseIssueViewPlanningFilter } from '../../shared/issue-view';
import type { IssueViewPlanningFilter, PlanningItem } from '../../shared/types';
import { afterAcceptedNavigation } from '../lib/navigation';
import { ISSUE_FILTER_DATE_LABELS, ISSUE_FILTER_PLAN_KINDS, issuePlanningFilterLabels, planningFilterItemLabel } from './issue-planning-filter-labels';
import { PLAN_ID_FIELDS, PLAN_LABELS } from './PlanningSelectors';
import './issue-planning-filters.css';

type Selections = Pick<IssueViewPlanningFilter, 'cycleId' | 'moduleId' | 'releaseId' | 'releaseFilter'>;
type DateMode = keyof typeof ISSUE_FILTER_DATE_LABELS;
type Draft = Selections & { mode: DateMode; from: string; to: string; fromDays: string; toDays: string };

const hasDateRange = (mode: DateMode) => mode === 'overlap' || mode === 'due';
const choice = (id: string | null | undefined) => id === undefined ? 'all' : id === null ? 'none' : `plan:${id}`;

function fromFilter(value: IssueViewPlanningFilter | undefined): Draft {
  const dates = value?.dates;
  const relative = dates?.mode === 'due_relative' ? dates : undefined;
  const range = dates?.mode === 'overlap' || dates?.mode === 'due' ? dates : relative;
  return {
    cycleId: value?.cycleId, moduleId: value?.moduleId, releaseId: value?.releaseId, releaseFilter: value?.releaseFilter,
    mode: dates?.mode ?? 'all', from: range?.from ?? '', to: range?.to ?? '',
    fromDays: relative?.fromDays?.toString() ?? '', toDays: relative?.toDays?.toString() ?? '',
  };
}

function equalDraft(a: Draft, b: Draft): boolean {
  if (a.cycleId !== b.cycleId || a.moduleId !== b.moduleId || a.releaseId !== b.releaseId || a.mode !== b.mode) return false;
  if (a.releaseFilter?.kind !== b.releaseFilter?.kind) return false;
  if (a.releaseFilter?.kind === 'any' && b.releaseFilter?.kind === 'any') {
    const ids = b.releaseFilter.ids;
    if (a.releaseFilter.ids.length !== ids.length || !a.releaseFilter.ids.every(id => ids.includes(id))) return false;
  }
  const equalRange = a.from === b.from && a.to === b.to;
  if (a.mode === 'due_relative') return equalRange && a.fromDays === b.fromDays && a.toDays === b.toDays;
  return !hasDateRange(a.mode) || equalRange;
}

function dayOffset(value: string): number | undefined {
  const offset = value.trim();
  if (!offset) return undefined;
  if (!/^[+-]?\d+$/u.test(offset)) throw new Error('오늘 기준 일수는 정수로 입력하세요.');
  return Number(offset);
}

function datesFromDraft({ mode, from, to, fromDays, toDays }: Draft) {
  if (mode === 'all') return undefined;
  const range = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  if (mode === 'due_relative') {
    const start = dayOffset(fromDays);
    const end = dayOffset(toDays);
    return { mode, ...range, ...(start === undefined ? {} : { fromDays: start }), ...(end === undefined ? {} : { toDays: end }) };
  }
  return hasDateRange(mode) ? { mode, ...range } : { mode };
}

export function IssuePlanningFilters({ projectId, planningItems, value, onApply }: {
  projectId: string;
  planningItems: readonly PlanningItem[];
  value: IssueViewPlanningFilter | undefined;
  onApply: (filter: IssueViewPlanningFilter | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => fromFilter(value));
  const [error, setError] = useState('');
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const dirty = useRef(false);
  const labels = issuePlanningFilterLabels(value, planningItems);
  const releases = planningItems.filter(item => item.projectId === projectId && item.kind === 'release');
  const releaseIds = draft.releaseFilter?.kind === 'any' ? draft.releaseFilter.ids : undefined;
  const releaseChoices = releaseIds ? [
    ...releases.map(item => ({ id: item.id, label: planningFilterItemLabel(item) })),
    ...releaseIds.filter(id => !releases.some(item => item.id === id)).map(id => ({ id, label: planningFilterItemLabel() })),
  ] : [];

  const discard = useCallback(() => {
    dirty.current = false;
    setError('');
    setOpen(false);
  }, []);

  useEffect(() => {
    function guard(event: Event) {
      if (event.defaultPrevented || !dirty.current) return;
      if (!window.confirm('적용하지 않은 계획·일정 조건을 버리고 이동할까요?')) event.preventDefault();
      else afterAcceptedNavigation(event, discard);
    }
    function unload(event: BeforeUnloadEvent) {
      if (!dirty.current) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('donefac:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('donefac:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [discard]);

  function update(change: Partial<Draft>) {
    const next = { ...draft, ...change };
    dirty.current = !equalDraft(next, fromFilter(value));
    setDraft(next);
    setError('');
  }

  function selectPlan(kind: typeof ISSUE_FILTER_PLAN_KINDS[number], choice: string) {
    if (kind === 'release' && (choice === 'assigned' || choice === 'any')) {
      const releaseFilter = choice === 'assigned' ? { kind: 'assigned' as const }
        : { kind: 'any' as const, ids: draft.releaseId ? [draft.releaseId] : [] };
      update({ releaseId: undefined, releaseFilter });
      return;
    }
    const id = choice === 'all' ? undefined : choice === 'none' ? null : choice.slice('plan:'.length);
    update({ [PLAN_ID_FIELDS[kind]]: id, ...(kind === 'release' ? { releaseFilter: undefined } : {}) });
  }

  function close() {
    discard();
    toggle.current?.focus({ preventScroll: true });
  }

  function cancel() {
    if (!dirty.current || window.confirm('적용하지 않은 계획·일정 조건을 버리고 닫을까요?')) close();
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selections: Selections = {};
    for (const kind of ISSUE_FILTER_PLAN_KINDS) {
      const field = PLAN_ID_FIELDS[kind];
      if (draft[field] !== undefined) selections[field] = draft[field];
    }
    try {
      if (releaseIds?.length === 0) throw new Error('릴리스를 하나 이상 선택하세요.');
      if (releaseIds?.length === 1) selections.releaseId = releaseIds[0];
      else if (draft.releaseFilter) selections.releaseFilter = draft.releaseFilter;
      const dates = datesFromDraft(draft);
      onApply(parseIssueViewPlanningFilter({ ...selections, ...(dates ? { dates } : {}) }, projectId, planningItems));
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '계획·일정 조건을 확인하세요.');
    }
  }

  return <div className="issue-planning-filters">
    <div className="issue-planning-filters-bar">
      <button ref={toggle} className={`btn ${labels.length ? 'is-filtered' : 'btn-ghost'}`} type="button"
        aria-expanded={open} aria-controls={panelId} onClick={() => {
          if (open) cancel();
          else { setDraft(fromFilter(value)); setOpen(true); }
        }}><CalendarRange size={16} aria-hidden="true" />계획·일정 필터</button>
      {labels.length > 0 && <ul className="issue-planning-filter-labels" aria-label="적용된 계획·일정 조건">
        {labels.map(label => <li key={label}>{label}</li>)}
      </ul>}
    </div>
    <section id={panelId} className="issue-planning-filter-panel" aria-label="계획·일정 필터" hidden={!open}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}>
      {open && <form noValidate onSubmit={apply}>
        <div className="issue-planning-filter-grid">
          {ISSUE_FILTER_PLAN_KINDS.map(kind => {
            const field = PLAN_ID_FIELDS[kind];
            const selectedId = draft[field];
            const options = kind === 'release' ? releases : planningItems.filter(item => item.projectId === projectId && item.kind === kind);
            return <label key={kind}>{PLAN_LABELS[kind]}
              <select className="field" aria-label={`${PLAN_LABELS[kind]} 필터`}
                value={kind === 'release' && draft.releaseFilter ? draft.releaseFilter.kind : choice(selectedId)}
                onChange={event => selectPlan(kind, event.target.value)}>
                <option value="all">전체</option>
                <option value="none">미지정</option>
                {kind === 'release' && <>
                  <option value="assigned">지정됨</option>
                  <option value="any">여러 릴리스</option>
                </>}
                {selectedId && !options.some(item => item.id === selectedId) && <option value={choice(selectedId)}>현재 항목 없음</option>}
                {options.map(item => <option key={item.id} value={choice(item.id)}>{planningFilterItemLabel(item)}</option>)}
              </select>
            </label>;
          })}
          {releaseIds && <fieldset className="issue-planning-release-choices">
            <legend>선택할 릴리스</legend>
            <div className="issue-planning-release-options">
              {releaseChoices.map(({ id, label }) => {
                const checked = releaseIds.includes(id);
                return <label key={id}>
                  <input type="checkbox" checked={checked} disabled={!checked && releaseIds.length >= ISSUE_VIEW_RELEASE_LIMIT}
                    onChange={event => update({ releaseFilter: { kind: 'any', ids: event.target.checked
                      ? [...releaseIds, id] : releaseIds.filter(entry => entry !== id) } })} />
                  <span>{label}</span>
                </label>;
              })}
            </div>
            {releaseChoices.length === 0 && <p className="issue-planning-filter-hint">선택할 릴리스가 없습니다.</p>}
            {releaseIds.length >= ISSUE_VIEW_RELEASE_LIMIT && <p className="issue-planning-filter-hint" role="status">최대 {ISSUE_VIEW_RELEASE_LIMIT}개를 선택했습니다.</p>}
          </fieldset>}
          <label>일정 조건
            <select className="field" aria-label="일정 조건" value={draft.mode} onChange={event => update({ mode: event.target.value as DateMode })}>
              {Object.entries(ISSUE_FILTER_DATE_LABELS).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
            </select>
          </label>
          {hasDateRange(draft.mode) && <>
            <label>조회 시작일<input type="date" className="field" value={draft.from} aria-describedby={`${panelId}-range`}
              onChange={event => update({ from: event.target.value })} /></label>
            <label>조회 종료일<input type="date" className="field" value={draft.to} aria-describedby={`${panelId}-range`}
              onChange={event => update({ to: event.target.value })} /></label>
          </>}
          {draft.mode === 'due_relative' && <>
            <label>오늘 기준 시작 일수<input className="field" value={draft.fromDays} aria-describedby={`${panelId}-relative`}
              onChange={event => update({ fromDays: event.target.value })} /></label>
            <label>오늘 기준 종료 일수<input className="field" value={draft.toDays} aria-describedby={`${panelId}-relative`}
              onChange={event => update({ toDays: event.target.value })} /></label>
            <label>고정 시작일<input type="date" className="field" value={draft.from}
              onChange={event => update({ from: event.target.value })} /></label>
            <label>고정 종료일<input type="date" className="field" value={draft.to}
              onChange={event => update({ to: event.target.value })} /></label>
          </>}
        </div>
        {hasDateRange(draft.mode) && <p id={`${panelId}-range`} className="issue-planning-filter-hint">날짜는 하나 이상 입력하세요. 입력한 날짜도 범위에 포함합니다.</p>}
        {draft.mode === 'due_relative' && <p id={`${panelId}-relative`} className="issue-planning-filter-hint">
          서울 기준으로 0은 오늘, 음수는 이전, 양수는 이후입니다. 일수를 하나 이상 입력하세요. 고정 날짜를 입력하면 두 범위에 모두 해당하는 업무를 표시합니다.
        </p>}
        {draft.mode === 'needs_dates' && <p className="issue-planning-filter-hint">계획 시작일과 종료일을 확인해야 하는 업무를 표시합니다.</p>}
        {error && <p className="issue-planning-filter-error" role="alert">{error}</p>}
        <footer>
          <button className="btn btn-ghost" type="button" onClick={cancel}>편집 취소</button>
          <button className="btn btn-ghost" type="button" onClick={() => { onApply(undefined); close(); }}>조건 지우기</button>
          <button className="btn btn-primary" type="submit"><Check size={16} aria-hidden="true" />적용</button>
        </footer>
      </form>}
    </section>
  </div>;
}
