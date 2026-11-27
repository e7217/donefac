'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, Tag, X } from 'lucide-react';
import { PRIORITY, type Issue, type Priority, type SavedViewState } from '../../shared/types';
import {
  ISSUE_VIEW_LABEL_FILTER_LIMIT, ISSUE_VIEW_LABEL_MAX_LENGTH, issuePriorityLabelFilterLabels, issueViewLabelName,
  parseIssueViewLabelFilter, parseIssueViewPriorities,
} from '../../shared/issue-view';
import { afterAcceptedNavigation } from '../lib/navigation';
import './issue-priority-label-filters.css';

type Filters = Pick<SavedViewState['filters'], 'priorities' | 'labels'>;
type Draft = {
  priorities: Priority[];
  include: string[];
  exclude: string[];
  match: 'any' | 'all';
  presence: '' | 'set' | 'empty';
};

const priorities = Object.keys(PRIORITY) as Priority[];

function fromFilter(value: Filters): Draft {
  return {
    priorities: value.priorities ?? [],
    include: value.labels?.include ?? [],
    exclude: value.labels?.exclude ?? [],
    match: value.labels?.match ?? 'any',
    presence: value.labels?.presence ?? '',
  };
}

function toFilter(draft: Draft): Filters {
  return {
    priorities: parseIssueViewPriorities(draft.priorities),
    labels: parseIssueViewLabelFilter({
      include: draft.include, exclude: draft.exclude, match: draft.match,
      ...(draft.presence ? { presence: draft.presence } : {}),
    }),
  };
}

function LabelChoices({ title, available, selected, onChange }: {
  title: string;
  available: ReadonlySet<string>;
  selected: string[];
  onChange: (labels: string[]) => void;
}) {
  const [candidate, setCandidate] = useState('');
  const input = useRef<HTMLSelectElement>(null);
  const inputId = useId();
  const options = [...available].filter(label => !selected.includes(label));
  if (candidate && !options.includes(candidate)) options.unshift(candidate);
  const limitReached = selected.length >= ISSUE_VIEW_LABEL_FILTER_LIMIT;

  function addLabel() {
    if (!candidate || limitReached || selected.includes(candidate)) return;
    setCandidate('');
    onChange([...selected, candidate]);
    input.current?.focus();
  }

  return <div className="issue-label-choices">
    <label htmlFor={inputId}>{title}</label>
    <div className="issue-label-choice-controls">
      <select ref={input} id={inputId} className="field" value={candidate}
        disabled={limitReached} onChange={event => setCandidate(event.target.value)}>
        <option value="">{limitReached ? `최대 ${ISSUE_VIEW_LABEL_FILTER_LIMIT}개 선택됨` : '라벨 선택'}</option>
        {options.map(label => <option key={label} value={label}>{issueViewLabelName(label)}</option>)}
      </select>
      <button className="btn" type="button" aria-label={`${title} 추가`} disabled={!candidate || limitReached}
        onClick={addLabel}>추가</button>
    </div>
    {selected.length > 0 && <ul className="issue-label-choice-selection" aria-label={`선택한 ${title}`}>
      {selected.map(label => <li key={label}>
        <button type="button" className="btn" aria-label={`${title} 제거: ${issueViewLabelName(label)}`}
          onClick={() => {
            onChange(selected.filter(value => value !== label));
            requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
          }}>
          <span>{issueViewLabelName(label)}{available.has(label) ? '' : ' (현재 사용 안 함)'}</span>
          <X size={14} aria-hidden="true" />
        </button>
      </li>)}
    </ul>}
  </div>;
}

export function IssuePriorityLabelFilters({ issues, value, onApply }: {
  issues: readonly Issue[];
  value: Filters;
  onApply: (filters: Filters) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => fromFilter(value));
  const [error, setError] = useState('');
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const dirty = useRef(false);
  const summary = issuePriorityLabelFilterLabels(value);
  const available = useMemo(() => new Set(issues.flatMap(issue => issue.labels)
    .filter(label => label.length > 0 && label.length <= ISSUE_VIEW_LABEL_MAX_LENGTH).sort()), [issues]);

  const discard = useCallback(() => {
    dirty.current = false;
    setError('');
    setOpen(false);
  }, []);

  useEffect(() => {
    function guard(event: Event) {
      if (event.defaultPrevented || !dirty.current) return;
      if (!window.confirm('적용하지 않은 우선순위·라벨 조건을 버리고 이동할까요?')) event.preventDefault();
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
    dirty.current = JSON.stringify(toFilter(next)) !== JSON.stringify(value);
    setDraft(next);
    setError('');
  }

  function close() {
    discard();
    toggle.current?.focus({ preventScroll: true });
  }

  function cancel() {
    if (!dirty.current || window.confirm('적용하지 않은 우선순위·라벨 조건을 버리고 닫을까요?')) close();
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      onApply(toFilter(draft));
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '우선순위·라벨 조건을 확인하세요.');
    }
  }

  return <div className="issue-priority-label-filters">
    <div className="issue-priority-label-bar">
      <button ref={toggle} className={`btn ${summary.length ? 'is-filtered' : 'btn-ghost'}`} type="button"
        aria-expanded={open} aria-controls={panelId} onClick={() => {
          if (open) cancel();
          else { setDraft(fromFilter(value)); setOpen(true); }
        }}><Tag size={16} aria-hidden="true" />우선순위·라벨 필터</button>
      {summary.length > 0 && <ul className="issue-priority-label-summary" aria-label="적용된 우선순위·라벨 조건">
        {summary.map(label => <li key={label}>{label}</li>)}
      </ul>}
    </div>
    <section id={panelId} className="issue-priority-label-panel" aria-label="우선순위·라벨 필터" hidden={!open}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}>
      {open && <form onSubmit={apply}>
        <fieldset className="issue-priority-choices">
          <legend>우선순위</legend>
          {priorities.map(priority => <label key={priority}>
            <input type="checkbox" checked={draft.priorities.includes(priority)} onChange={event => update({
              priorities: event.target.checked
                ? [...draft.priorities, priority]
                : draft.priorities.filter(value => value !== priority),
            })} />{PRIORITY[priority]}
          </label>)}
        </fieldset>
        <div className="issue-priority-label-grid">
          <LabelChoices title="포함 라벨" available={available} selected={draft.include}
            onChange={include => update({ include, ...(include.length ? {} : { match: 'any' }) })} />
          <LabelChoices title="제외 라벨" available={available} selected={draft.exclude}
            onChange={exclude => update({ exclude })} />
          <label>포함 조건
            <select className="field" value={draft.match} disabled={draft.include.length === 0}
              onChange={event => update({ match: event.target.value as Draft['match'] })}>
              <option value="any">하나 이상</option>
              <option value="all">모두</option>
            </select>
          </label>
          <label>라벨 유무
            <select className="field" value={draft.presence}
              onChange={event => update({ presence: event.target.value as Draft['presence'] })}>
              <option value="">전체</option>
              <option value="set">라벨 있음</option>
              <option value="empty">라벨 없음</option>
            </select>
          </label>
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        <footer>
          <button className="btn btn-ghost" type="button" onClick={cancel}>편집 취소</button>
          <button className="btn btn-ghost" type="button"
            onClick={() => { onApply({ priorities: undefined, labels: undefined }); close(); }}>우선순위·라벨 초기화</button>
          <button className="btn btn-primary" type="submit"><Check size={16} aria-hidden="true" />적용</button>
        </footer>
      </form>}
    </section>
  </div>;
}
