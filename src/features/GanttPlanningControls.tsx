'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CalendarDays, ChevronDown, ExternalLink, RefreshCw, Save, Search } from 'lucide-react';
import type { FeatureProps, PlanningItem, PlanningKind } from '../../shared/types';
import { PLANNING_META, PLANNING_STATUS_META, planningFields } from '../../shared/planning-helpers';
import { api, ApiError } from '../lib/api';
import './gantt-planning-items.css';

export type GanttPlanningControlsProps = FeatureProps & {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  selectedPlanningId: string | null;
  onSelectPlanning: (id: string | null) => void;
  onDraftChange: (id: string, dirty: boolean, pending?: boolean) => void;
  draftEpoch?: number;
  onOpenPlanning?: (id: string) => void;
};

type DateDraft = {
  startDate: string | null;
  endDate: string | null;
  targetDate: string | null;
};

const PAGE_SIZE = 30;
const KINDS: PlanningKind[] = ['cycle', 'module', 'release'];
const datesOf = (item?: PlanningItem): DateDraft => ({
  startDate: item?.startDate ?? null,
  endDate: item?.endDate ?? null,
  targetDate: item?.targetDate ?? null,
});
const sameDates = (left: DateDraft, right: DateDraft) =>
  left.startDate === right.startDate &&
  left.endDate === right.endDate &&
  left.targetDate === right.targetDate;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : '계획 일정을 처리하지 못했습니다.';
const sourceToken = (item?: PlanningItem) => (item ? `${item.version}:${item.updatedAt}` : 'missing');

/** The Gantt parent owns the single navigation guard and chart selection. */
export function GanttPlanningControls(props: GanttPlanningControlsProps) {
  return <ProjectPlanningControls key={`${props.projectId}:${props.actorId}`} {...props} />;
}

function ProjectPlanningControls(props: GanttPlanningControlsProps) {
  const { data, projectId, expanded, selectedPlanningId } = props;
  const [kind, setKind] = useState<PlanningKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [offset, setOffset] = useState(0);
  const items = (data.planningItems ?? []).filter((item) => item.projectId === projectId);
  const selected = items.find((item) => item.id === selectedPlanningId);
  const visible = items
    .filter(
      (item) =>
        (kind === 'all' || item.kind === kind) &&
        (includeArchived || item.status !== 'archived' || item.id === selectedPlanningId) &&
        (!query || item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
    )
    .sort(
      (left, right) => left.name.localeCompare(right.name, 'ko-KR') || left.id.localeCompare(right.id),
    );
  const start = Math.min(offset, Math.max(0, Math.floor((visible.length - 1) / PAGE_SIZE) * PAGE_SIZE));
  const isProject = data.projects.some((project) => project.id === projectId);

  function mayNavigate() {
    return window.dispatchEvent(new Event('donefac:navigate', { cancelable: true }));
  }

  function toggleExpanded() {
    if (expanded && !mayNavigate()) return;
    props.onExpandedChange(!expanded);
  }

  function select(id: string | null) {
    if (selectedPlanningId === id || !mayNavigate()) return;
    props.onSelectPlanning(id);
  }

  return (
    <section className="gantt-planning-controls">
      <div className="gantt-planning-toggle-row">
        <button
          type="button"
          className="btn btn-ghost gantt-planning-toggle"
          aria-expanded={expanded}
          aria-controls="gantt-planning-panel"
          disabled={!isProject}
          onClick={toggleExpanded}
        >
          <CalendarDays size={16} aria-hidden="true" />
          계획 일정
          <ChevronDown size={15} className={expanded ? 'is-expanded' : ''} aria-hidden="true" />
        </button>
        {!isProject ? (
          <span>프로젝트를 선택하면 계획 일정을 수정할 수 있습니다.</span>
        ) : (
          <span>사이클 · 모듈 · 릴리스 {items.length}개</span>
        )}
      </div>

      {expanded && isProject && (
        <div
          id="gantt-planning-panel"
          className="gantt-planning-panel"
          role="region"
          aria-label="간트 계획 일정"
        >
          <header className="gantt-planning-heading">
            <div>
              <h3>계획 기간과 목표일</h3>
              <p>시작일과 종료일을 포함한 기간입니다. 업무 일정은 각 업무에서 수정하세요.</p>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => select(null)}
              disabled={!selectedPlanningId}
            >
              전체 계획 업무 보기
            </button>
          </header>

          <div className="gantt-planning-layout">
            <div className="gantt-planning-list-panel">
              <div className="gantt-planning-filters">
                <label>
                  계획 종류
                  <select
                    className="field"
                    aria-label="간트 계획 종류"
                    value={kind}
                    onChange={(event) => {
                      setKind(event.target.value as PlanningKind | 'all');
                      setOffset(0);
                    }}
                  >
                    <option value="all">모든 종류</option>
                    {KINDS.map((value) => (
                      <option key={value} value={value}>
                        {PLANNING_META[value].label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  이름 검색
                  <span className="gantt-planning-search">
                    <Search size={14} aria-hidden="true" />
                    <input
                      className="field"
                      aria-label="간트 계획 검색"
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setOffset(0);
                      }}
                      placeholder="계획 이름"
                    />
                  </span>
                </label>
              </div>
              <label className="gantt-planning-archive">
                <input
                  type="checkbox"
                  checked={includeArchived}
                  onChange={(event) => {
                    setIncludeArchived(event.target.checked);
                    setOffset(0);
                  }}
                />
                보관된 계획 포함
              </label>
              <ul className="gantt-planning-list" aria-label="간트 계획 항목">
                {visible.slice(start, start + PAGE_SIZE).map((item) => {
                  const linkedCount = data.issues.filter(
                    (issue) =>
                      issue.projectId === projectId &&
                      issue[planningFields(item.kind).idField] === item.id,
                  ).length;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`gantt-planning-item ${item.id === selectedPlanningId ? 'is-selected' : ''}`}
                        aria-label={`${PLANNING_META[item.kind].label} ${item.name} 간트 선택`}
                        aria-pressed={item.id === selectedPlanningId}
                        onClick={() => select(item.id)}
                      >
                        <span className="gantt-planning-item-meta">
                          {PLANNING_META[item.kind].label} · {PLANNING_STATUS_META[item.status].label}
                          <span>업무 {linkedCount}개</span>
                        </span>
                        <strong>{item.name}</strong>
                        <span>
                          {item.startDate ?? '시작 미정'} — {item.endDate ?? '종료 미정'}
                        </span>
                        {item.targetDate && <small>목표 {item.targetDate}</small>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {!visible.length && (
                <p className="gantt-planning-empty">
                  {items.length
                    ? '조건에 맞는 계획이 없습니다.'
                    : '등록된 계획이 없습니다. 사이클·모듈·릴리스 화면에서 계획을 만드세요.'}
                </p>
              )}
              {visible.length > PAGE_SIZE && (
                <div className="gantt-planning-pagination">
                  <span>
                    {start + 1}–{Math.min(start + PAGE_SIZE, visible.length)} / {visible.length}
                  </span>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    disabled={start === 0}
                    onClick={() => setOffset(Math.max(0, start - PAGE_SIZE))}
                    aria-label="간트 계획 이전 페이지"
                  >
                    이전
                  </button>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    disabled={start + PAGE_SIZE >= visible.length}
                    onClick={() => setOffset(start + PAGE_SIZE)}
                    aria-label="간트 계획 다음 페이지"
                  >
                    다음
                  </button>
                </div>
              )}
            </div>

            {selectedPlanningId ? (
              <PlanningDatesEditor
                key={`${selectedPlanningId}:${props.draftEpoch ?? 0}`}
                {...props}
                item={selected}
                itemId={selectedPlanningId}
              />
            ) : (
              <div className="gantt-planning-editor-empty">
                <CalendarDays size={24} aria-hidden="true" />
                <p>계획을 선택하면 기간과 목표일을 수정할 수 있습니다.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function PlanningDatesEditor({
  item,
  itemId,
  ...props
}: GanttPlanningControlsProps & { item?: PlanningItem; itemId: string }) {
  const { onDraftChange } = props;
  const [draft, setDraft] = useState(() => datesOf(item));
  const [baseline, setBaseline] = useState(() => datesOf(item));
  const [version, setVersion] = useState(item?.version ?? 0);
  const [observedToken, setObservedToken] = useState(() => sourceToken(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const pending = useRef(false);
  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  const dirty = !sameDates(draft, baseline);
  const dirtyRef = useRef(dirty);
  const draftKey = `planning:${itemId}`;
  const changedRemotely = Boolean(item && item.version > version);

  // Clean forms follow refreshed snapshots. Dirty forms retain their original CAS version.
  if (sourceToken(item) !== observedToken && !busy) {
    setObservedToken(sourceToken(item));
    if (item && !dirty && item.version >= version) {
      setDraft(datesOf(item));
      setBaseline(datesOf(item));
      setVersion(item.version);
      setError('');
      setConflict(false);
    }
  }

  useEffect(() => {
    dirtyRef.current = dirty;
    onDraftChange(draftKey, dirty, busy);
  }, [dirty, busy, draftKey, onDraftChange]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
      onDraftChange(draftKey, false, false);
    };
  }, [draftKey, onDraftChange]);

  function update(field: keyof DateDraft, value: string) {
    const next = { ...draft, [field]: value || null };
    setDraft(next);
    dirtyRef.current = !sameDates(next, baseline);
    props.onDraftChange(draftKey, dirtyRef.current, false);
    setError('');
  }

  function setPending(value: boolean) {
    pending.current = value;
    setBusy(value);
    props.onDraftChange(draftKey, dirtyRef.current, value);
  }

  function accept(latest: PlanningItem) {
    setDraft(datesOf(latest));
    setBaseline(datesOf(latest));
    setVersion(latest.version);
    dirtyRef.current = false;
    props.onDraftChange(draftKey, false, pending.current);
    setError('');
    setConflict(false);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !dirty || !version) return;
    if (draft.startDate && draft.endDate && draft.endDate < draft.startDate) {
      setError('종료일은 시작일보다 빠를 수 없습니다.');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError('');
    let saved = false;
    try {
      const latest = await api<PlanningItem>(`/planning-items/${encodeURIComponent(itemId)}`, {
        method: 'PATCH',
        headers: { 'X-Actor-Id': props.actorId },
        signal: controller.signal,
        body: JSON.stringify({ expectedVersion: version, ...draft }),
      });
      if (!active.current || controller.signal.aborted) return;
      accept(latest);
      saved = true;
      await props.refresh();
      if (active.current) props.notify('계획 일정을 저장했습니다.');
    } catch (cause) {
      if (!active.current || controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
      setError(
        saved
          ? `계획 일정은 저장했지만 화면을 갱신하지 못했습니다. ${messageOf(cause)}`
          : `${messageOf(cause)} 작성한 날짜는 유지됩니다.`,
      );
    } finally {
      if (active.current && !controller.signal.aborted) setPending(false);
    }
  }

  async function reload() {
    if (
      pending.current ||
      (dirtyRef.current && !window.confirm('작성 중인 날짜 변경을 버리고 최신 계획 일정을 불러올까요?'))
    )
      return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    try {
      const latest = await api<PlanningItem>(`/planning-items/${encodeURIComponent(itemId)}`, {
        signal: controller.signal,
        headers: { 'X-Actor-Id': props.actorId },
      });
      if (!active.current || controller.signal.aborted) return;
      accept(latest);
      await props.refresh();
    } catch (cause) {
      if (active.current && !controller.signal.aborted)
        setError(`${messageOf(cause)} 현재 입력은 유지됩니다.`);
    } finally {
      if (active.current && !controller.signal.aborted) setPending(false);
    }
  }

  return (
    <form className="gantt-planning-editor" aria-label="선택한 계획 일정 편집" onSubmit={save}>
      <header>
        <div>
          <span>
            {item ? PLANNING_META[item.kind].label : '계획'} · 버전 {version || '미확인'}
          </span>
          <h4>{item?.name ?? '현재 목록에 없는 계획'}</h4>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void reload()}
          disabled={busy}
          aria-label="계획 일정 최신 정보"
        >
          <RefreshCw size={14} aria-hidden="true" />
          최신 정보
        </button>
      </header>
      {!item && (
        <p className="gantt-planning-warning" role="status">
          이 계획이 현재 작업공간에 없습니다. 작성한 날짜는 유지됩니다. 최신 정보를 확인하세요.
        </p>
      )}
      {((changedRemotely && dirty) || conflict) && (
        <p className="gantt-planning-warning" role="status">
          다른 변경이 있습니다. 입력은 버전 {version} 기준으로 유지됩니다. 최신 정보를 불러온 뒤 다시
          수정하세요.
        </p>
      )}
      <fieldset disabled={busy || !version}>
        <div className="gantt-planning-date-fields">
          <label>
            시작일
            <input
              className="field"
              type="date"
              aria-label="계획 간트 시작일"
              value={draft.startDate ?? ''}
              onChange={(event) => update('startDate', event.target.value)}
            />
          </label>
          <label>
            종료일
            <input
              className="field"
              type="date"
              aria-label="계획 간트 종료일"
              value={draft.endDate ?? ''}
              onChange={(event) => update('endDate', event.target.value)}
            />
          </label>
          <label>
            목표일
            <input
              className="field"
              type="date"
              aria-label="계획 간트 목표일"
              value={draft.targetDate ?? ''}
              onChange={(event) => update('targetDate', event.target.value)}
            />
          </label>
        </div>
        <p className="gantt-planning-date-help">
          빈 날짜는 미정으로 저장합니다. 시작일과 종료일은 모두 기간에 포함됩니다.
        </p>
        {error && (
          <p className="gantt-planning-error" role="alert">
            {error}
          </p>
        )}
        <div className="gantt-planning-editor-actions">
          {props.onOpenPlanning ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => props.onOpenPlanning?.(itemId)}
            >
              <ExternalLink size={14} aria-hidden="true" />
              계획 상세 열기
            </button>
          ) : (
            <a className="btn btn-ghost" href={`#/${encodeURIComponent(props.projectId)}/planning`}>
              <ExternalLink size={14} aria-hidden="true" />
              계획 상세 열기
            </a>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
            <Save size={14} aria-hidden="true" />
            {busy ? '저장 중…' : '계획 일정 저장'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
