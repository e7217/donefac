'use client';

import { useId, useState, type RefObject } from 'react';
import { DEPENDENCY_LABELS, DEPENDENCY_TYPES, isDependencyType, MAX_DEPENDENCY_LAG_DAYS } from '../../shared/schedule-dependencies';
import type { Issue, ScheduleBulkLinkInput } from '../../shared/types';

type AnchorChoice = Pick<Issue, 'id' | 'key' | 'title'>;
export type BulkLinkDraft = Pick<ScheduleBulkLinkInput, 'direction' | 'type'> & { choice: AnchorChoice | null; lagDays: string };

type Props = {
  anchors: readonly Issue[];
  anchor?: Issue;
  searchRef: RefObject<HTMLInputElement | null>;
  query: string;
  value: BulkLinkDraft;
  onSearch: (query: string) => void;
  onChange: (draft: BulkLinkDraft) => void;
};

const PAGE_SIZE = 12;

export function GanttBulkLinkFields({ anchors, anchor, searchRef, query, value, onSearch, onChange }: Props) {
  const id = useId();
  const [visible, setVisible] = useState(PAGE_SIZE);
  const search = query.trim().toLocaleLowerCase();
  const terms = search.split(/\s+/).filter(Boolean);
  const results = anchors.filter(issue => {
    if (issue.id === anchor?.id) return false;
    const label = `${issue.key} ${issue.title}`.toLocaleLowerCase();
    return terms.every(term => label.includes(term));
  });
  const exact = results.findIndex(issue => issue.key.toLocaleLowerCase() === search);
  if (exact > 0) results.unshift(...results.splice(exact, 1));

  function choose(choice: AnchorChoice | null) {
    onSearch('');
    setVisible(PAGE_SIZE);
    onChange({ ...value, choice });
    searchRef.current?.focus();
  }

  const chosen = anchor ?? value.choice;
  return (
    <>
      <div className="schedule-bulk-link-anchor">
        <label htmlFor={`${id}-search`}>기준 업무 검색</label>
        <input ref={searchRef} id={`${id}-search`} className="field" value={query} autoComplete="off"
          placeholder="업무 키 또는 제목" onChange={event => {
            setVisible(PAGE_SIZE);
            onSearch(event.currentTarget.value);
          }} />
        {chosen && (
          <div className="schedule-bulk-link-chosen">
            <div role="status"><strong>선택한 기준 업무</strong><span>{chosen.key} {chosen.title}</span></div>
            <button type="button" className="btn btn-ghost" onClick={() => choose(null)}>선택 해제</button>
          </div>
        )}
        {chosen && !anchor && <p role="alert">기준 업무가 삭제되었거나 다른 프로젝트로 이동했습니다. 기준 업무를 다시 선택해 주세요.</p>}
        {(!anchor || search) && (
          <>
            {results.length ? (
              <ul className="schedule-bulk-link-results" aria-label="기준 업무 검색 결과">
                {results.slice(0, visible).map(issue => (
                  <li key={issue.id}>
                    <button type="button" onClick={() => choose(issue)}><strong>{issue.key}</strong> {issue.title}</button>
                  </li>
                ))}
              </ul>
            ) : <p role="status">선택할 수 있는 기준 업무가 없습니다.</p>}
            {results.length > visible && <button type="button" className="btn" onClick={() => setVisible(count => count + PAGE_SIZE)}>기준 업무 더 보기</button>}
          </>
        )}
      </div>
      <div className="schedule-bulk-date-fields">
        <div className="schedule-bulk-date-field">
          <label htmlFor={`${id}-direction`}>기준 업무 방향</label>
          <select id={`${id}-direction`} value={value.direction} className="field" onChange={event => {
            const direction = event.currentTarget.value;
            if (direction === 'predecessor' || direction === 'successor') onChange({ ...value, direction });
          }}>
            <option value="predecessor">기준 업무가 선행</option>
            <option value="successor">기준 업무가 후행</option>
          </select>
        </div>
        <div className="schedule-bulk-date-field">
          <label htmlFor={`${id}-type`}>연결 유형</label>
          <select id={`${id}-type`} value={value.type} className="field" onChange={event => {
            const type = event.currentTarget.value;
            if (isDependencyType(type)) onChange({ ...value, type });
          }}>
            {DEPENDENCY_TYPES.map(type => <option value={type} key={type}>{type} · {DEPENDENCY_LABELS[type]}</option>)}
          </select>
        </div>
        <div className="schedule-bulk-date-field schedule-bulk-link-lag">
          <label htmlFor={`${id}-lag`}>근무일 간격</label>
          <input id={`${id}-lag`} className="field" type="number" step={1} min={-MAX_DEPENDENCY_LAG_DAYS}
            max={MAX_DEPENDENCY_LAG_DAYS} value={value.lagDays} required onChange={event => onChange({ ...value, lagDays: event.currentTarget.value })} />
        </div>
      </div>
    </>
  );
}
