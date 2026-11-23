'use client';

import { useId, useRef, useState } from 'react';
import { Filter } from 'lucide-react';
import { ISSUE_VIEW_STATUS_LIMIT, issueViewStatusIds } from '../../shared/issue-view';
import type { SavedViewState, WorkflowStatus } from '../../shared/types';
import './issue-status-filter.css';

type StatusOption = Pick<WorkflowStatus, 'id' | 'label'>;

const multipleStatuses = '__multiple_statuses__';

function statusLabel(id: string, options: readonly StatusOption[]): string {
  const current = options.find(option => option.id === id);
  if (!current) return `${id} (저장된 조건)`;
  return options.some(option => option.id !== id && option.label === current.label) ? `${current.label} (${id})` : current.label;
}

export function issueStatusFilterLabel(filters: Pick<SavedViewState['filters'], 'status' | 'statusIds'>, options: readonly StatusOption[]) {
  const selected = issueViewStatusIds(filters);
  return selected.length ? `상태 · ${selected.map(id => statusLabel(id, options)).join(', ')}` : undefined;
}

export function IssueStatusFilter({ selected, options, allowMultiple, disabled, onChange }: {
  selected: readonly string[];
  options: readonly StatusOption[];
  allowMultiple: boolean;
  disabled: boolean;
  onChange: (ids: readonly string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const multiple = selected.length > 1;
  const single = selected.length === 1 ? selected[0] : undefined;
  const choices = [...new Set([...options.map(option => option.id), ...selected])]
    .filter(id => id !== 'all').map(id => ({ id, label: statusLabel(id, options) }));
  const expanded = allowMultiple && open;
  const limitReached = selected.length >= ISSUE_VIEW_STATUS_LIMIT;

  return <div className={`issue-status-filters${expanded ? ' is-expanded' : ''}`} onKeyDown={event => {
    if (!expanded || event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    toggle.current?.focus({ preventScroll: true });
  }}>
    <div className="issue-filter-select"><Filter size={14} aria-hidden="true" />
      <select aria-label="상태 필터" value={multiple ? multipleStatuses : single ?? 'all'} disabled={disabled}
        onChange={event => onChange(event.target.value === 'all' ? [] : [event.target.value])}>
        <option value="all">모든 상태</option>
        {multiple && <option value={multipleStatuses} disabled>상태 {selected.length}개 선택됨</option>}
        {choices.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </div>
    {allowMultiple && <>
      <button ref={toggle} type="button" className="btn btn-ghost" disabled={disabled} aria-expanded={expanded}
        aria-controls={panelId} onClick={() => setOpen(value => !value)}>여러 상태 선택</button>
      <fieldset id={panelId} className="issue-status-choices" hidden={!expanded} disabled={disabled}>
        <legend>선택할 상태</legend>
        <p>{limitReached ? `상태를 최대 ${ISSUE_VIEW_STATUS_LIMIT}개까지 고를 수 있습니다.` : '고른 상태 중 하나에 해당하는 업무를 표시합니다.'}</p>
        <div>{choices.map(({ id, label }) => <label key={id}>
          <input type="checkbox" checked={selected.includes(id)} disabled={limitReached && !selected.includes(id)} onChange={event => {
            onChange(event.target.checked ? [...selected, id] : selected.filter(value => value !== id));
          }} />{label}
        </label>)}</div>
      </fieldset>
    </>}
  </div>;
}
