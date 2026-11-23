'use client';

import { useId, useState, type ReactNode, type RefObject } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { DEPENDENCY_LABELS, DEPENDENCY_TYPES, isDependencyType, MAX_DEPENDENCY_LAG_DAYS } from '../../shared/schedule-dependencies';
import type { Issue, ScheduleBulkLinkInput, WorkspaceSnapshot } from '../../shared/types';
import { issueSearchAliasLabel, searchIssueCandidates } from '../../shared/workspace-search';

type AnchorChoice = Pick<Issue, 'id' | 'key' | 'title'>;
export type BulkLinkRule = Pick<ScheduleBulkLinkInput, 'type'> & { lagDays: string };
export type BulkLinkDraft = BulkLinkRule & Pick<ScheduleBulkLinkInput, 'direction'> & { choice: AnchorChoice | null };

type Props = {
  anchors: readonly Issue[];
  anchor?: Issue;
  issueAliases?: WorkspaceSnapshot['issueAliases'];
  searchRef: RefObject<HTMLInputElement | null>;
  query: string;
  value: BulkLinkDraft;
  onSearch: (query: string) => void;
  onChange: (draft: BulkLinkDraft) => void;
};

const PAGE_SIZE = 12;

export function GanttBulkLinkFields({ anchors, anchor, issueAliases, searchRef, query, value, onSearch, onChange }: Props) {
  const id = useId();
  const [visible, setVisible] = useState(PAGE_SIZE);
  const results = searchIssueCandidates({ issueAliases }, anchors.filter(issue => issue.id !== anchor?.id), query);

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
          placeholder="업무 키, 이전 키 또는 제목" onChange={event => {
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
        {(!anchor || query.trim()) && (
          <>
            {results.length ? (
              <ul className="schedule-bulk-link-results" aria-label="기준 업무 검색 결과">
                {results.slice(0, visible).map(({ issue, matchedAliases }) => (
                  <li key={issue.id}>
                    <button type="button" onClick={() => choose(issue)}><strong>{issue.key}</strong> {issue.title}
                      {matchedAliases.length > 0 && <small className="gantt-candidate-alias">{matchedAliases.map(issueSearchAliasLabel).join(' · ')}</small>}
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p role="status">선택할 수 있는 기준 업무가 없습니다.</p>}
            {results.length > visible && <button type="button" className="btn" onClick={() => setVisible(count => count + PAGE_SIZE)}>기준 업무 더 보기</button>}
          </>
        )}
      </div>
      <BulkLinkRuleFields value={value} onChange={rule => onChange({ ...value, ...rule })}>
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
      </BulkLinkRuleFields>
    </>
  );
}

export function GanttBulkChainFields({ issues, value, onChange, onMove }: {
  issues: readonly AnchorChoice[];
  value: BulkLinkRule;
  onChange: (rule: BulkLinkRule) => void;
  onMove: (from: number, to: number) => void;
}) {
  const [announcement, setAnnouncement] = useState('');

  function move(from: number, to: number, button: HTMLButtonElement) {
    const row = button.closest('li');
    onMove(from, to);
    setAnnouncement(`${issues[from].key} 업무를 ${to + 1}번째로 이동했습니다.`);
    requestAnimationFrame(() => {
      if (!row?.isConnected) return;
      const active = document.activeElement;
      if (active !== document.body && !row.contains(active)) return;
      (button.disabled ? row.querySelector<HTMLButtonElement>('button:not(:disabled)') : button)?.focus({ preventScroll: true });
    });
  }

  return <>
    <ol className="schedule-bulk-chain" aria-label="선후행 연결 순서">
      {issues.map((issue, index) => <li key={issue.id}>
        <div className="schedule-bulk-chain-row">
          <span><strong>{issue.key}</strong> {issue.title}</span>
          <div className="schedule-bulk-chain-controls">
            <button type="button" className="btn" aria-label={`${issue.key} 위로 이동`} title="위로 이동" disabled={index === 0}
              onClick={event => move(index, index - 1, event.currentTarget)}><ArrowUp size={16} aria-hidden="true" /></button>
            <button type="button" className="btn" aria-label={`${issue.key} 아래로 이동`} title="아래로 이동" disabled={index === issues.length - 1}
              onClick={event => move(index, index + 1, event.currentTarget)}><ArrowDown size={16} aria-hidden="true" /></button>
          </div>
        </div>
      </li>)}
    </ol>
    <p className="sr-only" role="status">{announcement}</p>
    <BulkLinkRuleFields value={value} onChange={onChange} />
  </>;
}

function BulkLinkRuleFields({ value, onChange, children }: {
  value: BulkLinkRule;
  onChange: (rule: BulkLinkRule) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return <div className="schedule-bulk-date-fields">
    {children}
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
  </div>;
}
