'use client';

import { useId, useRef, useState } from 'react';
import { ArrowDown, ArrowDownUp, ArrowUp, Plus, X } from 'lucide-react';
import { ISSUE_VIEW_SORT_FIELDS, ISSUE_VIEW_SORT_LABELS, ISSUE_VIEW_SORT_LIMIT } from '../../shared/issue-view';
import type { IssueViewSortRule } from '../../shared/types';
import './issue-view-sort.css';

const directionLabels = { asc: '오름차순', desc: '내림차순' } as const;

export function issueViewSortLabels(sort?: readonly IssueViewSortRule[]): string[] {
  return (sort ?? []).map(({ field, direction }) => `${ISSUE_VIEW_SORT_LABELS[field]} ${directionLabels[direction]}`);
}

export function IssueViewSort({ value, disabled, onChange }: {
  value: readonly IssueViewSortRule[] | undefined;
  disabled: boolean;
  onChange: (sort: IssueViewSortRule[] | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const rules = value ?? [];
  const unused = ISSUE_VIEW_SORT_FIELDS.filter(field => !rules.some(rule => rule.field === field));
  const labels = issueViewSortLabels(value);

  function focusRule(field: IssueViewSortRule['field'], control?: 'up' | 'down') {
    requestAnimationFrame(() => {
      const row = panel.current?.querySelector(`[data-sort-field="${field}"]`);
      const button = control && row?.querySelector<HTMLButtonElement>(`[data-sort-move="${control}"]`);
      const fieldControl = row?.querySelector<HTMLElement>('select');
      const fallback = addButton.current && !addButton.current.disabled ? addButton.current : trigger.current;
      (button && !button.disabled ? button : fieldControl ?? fallback)?.focus({ preventScroll: true });
    });
  }

  function moveRule(index: number, direction: 'up' | 'down') {
    const next = [...rules];
    const target = direction === 'up' ? index - 1 : index + 1;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    focusRule(rules[index].field, direction);
  }

  return <div className="issue-view-sort">
    <div className="issue-view-sort-bar">
      <button ref={trigger} className="btn btn-ghost" type="button" aria-expanded={open} aria-controls={id}
        disabled={disabled} onClick={() => setOpen(!open)}><ArrowDownUp size={15} aria-hidden="true" />업무 정렬</button>
      {labels.length > 0 && <span aria-label="적용된 업무 정렬">{labels.join(' → ')}</span>}
    </div>
    <section ref={panel} id={id} className="issue-view-sort-panel" aria-label="업무 정렬 기준" hidden={!open}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus({ preventScroll: true });
      }}>
      {rules.length > 0 && <ol>
        {rules.map((rule, index) => <li key={rule.field} data-sort-field={rule.field}>
          <div className="issue-view-sort-rule">
            <select className="field" aria-label={`정렬 기준 ${index + 1}`} value={rule.field} disabled={disabled}
              onChange={event => {
                const field = event.currentTarget.value as IssueViewSortRule['field'];
                onChange(rules.map((item, position) => position === index ? { ...item, field } : item));
                focusRule(field);
              }}>
              {ISSUE_VIEW_SORT_FIELDS.filter(field => field === rule.field || unused.includes(field))
                .map(field => <option key={field} value={field}>{ISSUE_VIEW_SORT_LABELS[field]}</option>)}
            </select>
            <select className="field" aria-label={`정렬 방향 ${index + 1}`} value={rule.direction} disabled={disabled}
              onChange={event => {
                const direction = event.currentTarget.value as IssueViewSortRule['direction'];
                onChange(rules.map((item, position) => position === index ? { ...item, direction } : item));
              }}>
              {Object.entries(directionLabels).map(([direction, label]) => <option key={direction} value={direction}>{label}</option>)}
            </select>
            <div className="issue-view-sort-actions">
              <button type="button" className="btn btn-ghost" data-sort-move="up" disabled={disabled || index === 0}
                aria-label={`${index + 1}번째 정렬 기준 위로 이동`} onClick={() => moveRule(index, 'up')}><ArrowUp size={14} aria-hidden="true" /></button>
              <button type="button" className="btn btn-ghost" data-sort-move="down" disabled={disabled || index === rules.length - 1}
                aria-label={`${index + 1}번째 정렬 기준 아래로 이동`} onClick={() => moveRule(index, 'down')}><ArrowDown size={14} aria-hidden="true" /></button>
              <button type="button" className="btn btn-ghost" disabled={disabled} aria-label={`${index + 1}번째 정렬 기준 제거`} onClick={() => {
                const next = rules.filter((_, position) => position !== index);
                onChange(next.length ? next : undefined);
                const nearby = next[index] ?? next[index - 1];
                if (nearby) focusRule(nearby.field);
                else requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true }));
              }}><X size={14} aria-hidden="true" /></button>
            </div>
          </div>
        </li>)}
      </ol>}
      <div className="issue-view-sort-actions">
        <button ref={addButton} type="button" className="btn" disabled={disabled || rules.length === ISSUE_VIEW_SORT_LIMIT} onClick={() => {
          const field = unused[0];
          if (!field) return;
          onChange([...rules, { field, direction: 'asc' }]);
          focusRule(field);
        }}><Plus size={14} aria-hidden="true" />정렬 기준 추가</button>
        {rules.length > 0 && <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => {
          onChange(undefined);
          requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true }));
        }}>프로젝트 순서 사용</button>}
      </div>
    </section>
  </div>;
}
