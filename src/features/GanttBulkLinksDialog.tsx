'use client';

import { useId, useState, type ReactNode, type RefObject } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { DEPENDENCY_LABELS, DEPENDENCY_TYPES, isDependencyType, MAX_DEPENDENCY_LAG_DAYS } from '../../shared/schedule-dependencies';
import type { DependencyType, Issue, ScheduleBulkLinkAction, ScheduleBulkLinkInput, WorkspaceSnapshot } from '../../shared/types';
import { issueSearchAliasLabel, searchIssueCandidates } from '../../shared/workspace-search';

type AnchorChoice = Pick<Issue, 'id' | 'key' | 'title'>;
export type BulkLinkOperation = NonNullable<ScheduleBulkLinkAction['operation']>;
export type BulkLinkRule = { type: DependencyType; lagDays: string };
export type BulkLinkRuleChanges = Record<keyof BulkLinkRule, boolean>;
export type BulkLinkDraft = BulkLinkRule & Pick<ScheduleBulkLinkInput, 'direction'> & { choice: AnchorChoice | null };
export const bulkLinkDateFields = ['startDate', 'endDate'] as const;
export type BulkLinkDateField = typeof bulkLinkDateFields[number];
export type BulkLinkDateChoice = 'saved' | 'draft';
export type BulkLinkDateRow = {
  issue: Issue;
  dates: { field: BulkLinkDateField; base: string | null; saved: string | null; draft: string | null; conflict: boolean; choice?: BulkLinkDateChoice }[];
};

type Props = {
  anchors: readonly Issue[];
  anchor?: Issue;
  issueAliases?: WorkspaceSnapshot['issueAliases'];
  searchRef: RefObject<HTMLInputElement | null>;
  query: string;
  value: BulkLinkDraft;
  onSearch: (query: string) => void;
  onChange: (draft: BulkLinkDraft) => void;
} & RuleOptions;

type RuleOptions = {
  operation: BulkLinkOperation;
  changes: BulkLinkRuleChanges;
  onChanges: (changes: BulkLinkRuleChanges) => void;
};

const PAGE_SIZE = 12;

export function GanttBulkLinkFields({ anchors, anchor, issueAliases, searchRef, query, value, onSearch, onChange, ...ruleOptions }: Props) {
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
      <BulkLinkRuleFields value={value} onChange={rule => onChange({ ...value, ...rule })} {...ruleOptions}>
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

export function GanttBulkChainFields({ issues, value, onChange, onMove, ...ruleOptions }: {
  issues: readonly AnchorChoice[];
  value: BulkLinkRule;
  onChange: (rule: BulkLinkRule) => void;
  onMove: (from: number, to: number) => void;
} & RuleOptions) {
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
    <BulkLinkRuleFields value={value} onChange={onChange} {...ruleOptions} />
  </>;
}

export function GanttBulkLinkDateFields({ rows, excluded, onInclude, onChoose, projectNames,
  description = '함께 저장할 날짜를 선택하세요. 제외한 초안은 간트에 남습니다.' }: {
  rows: readonly BulkLinkDateRow[];
  excluded: ReadonlySet<string>;
  onInclude: (id: string, include: boolean) => void;
  onChoose: (id: string, field: BulkLinkDateField, saved: string | null, choice: BulkLinkDateChoice) => void;
  projectNames?: ReadonlyMap<string, string>;
  description?: string;
}) {
  const title = useId();
  return <section className="schedule-bulk-link-dates" aria-labelledby={title}>
    <h3 id={title}>간트 날짜 초안</h3>
    <p>{description}</p>
    <ul>
      {rows.map(({ issue, dates }) => {
        const included = !excluded.has(issue.id);
        const projectName = projectNames?.get(issue.projectId);
        return <li key={issue.id}>
          <label>
            <input type="checkbox" checked={included} aria-label={`${issue.key} 날짜 초안 포함`}
              onChange={event => onInclude(issue.id, event.currentTarget.checked)} />
            <span><strong>{issue.key}</strong> {issue.title}
              {projectName && <small className="schedule-bulk-project" data-schedule-project={issue.projectId}>{projectName}</small>}
            </span>
          </label>
          <ul>
            {dates.map(({ field, base, saved, draft, conflict, choice }) => {
              const label = field === 'startDate' ? '시작일' : '종료일';
              const group = `${title}-${issue.id}-${field}`;
              return <li key={field}>
                <strong>{label}</strong>{' '}
                {saved === draft ? `${saved ?? '미정'} · 저장됨` : `저장된 값 ${saved ?? '미정'} → 초안 ${draft ?? '미정'}`}
                {conflict && <span className="schedule-bulk-link-date-conflict">초안 작성 전 {base ?? '미정'}</span>}
                {conflict && included && <fieldset className="schedule-bulk-link-date-choices" aria-describedby={`${group}-help`}>
                  <legend className="sr-only">{issue.key} {label} 선택</legend>
                  <span id={`${group}-help`} className="sr-only">저장된 값 {saved ?? '미정'}, 간트 입력 {draft ?? '미정'}</span>
                  <label><input type="radio" name={group} checked={choice === 'saved'} aria-label={`${issue.key} ${label} 저장값 사용`}
                    onChange={() => onChoose(issue.id, field, saved, 'saved')} />저장값 사용</label>
                  <label><input type="radio" name={group} checked={choice === 'draft'} aria-label={`${issue.key} ${label} 간트 입력 사용`}
                    onChange={() => onChoose(issue.id, field, saved, 'draft')} />간트 입력 사용</label>
                </fieldset>}
              </li>;
            })}
          </ul>
          {included && dates.some(date => date.conflict && !date.choice) &&
            <p className="schedule-paste-error">작성 중에 저장된 날짜가 바뀌었습니다. 반영할 값을 고르세요.</p>}
        </li>;
      })}
    </ul>
  </section>;
}

function BulkLinkRuleFields({ value, onChange, children, operation, changes, onChanges }: {
  value: BulkLinkRule;
  onChange: (rule: BulkLinkRule) => void;
  children?: ReactNode;
} & RuleOptions) {
  const id = useId();
  if (operation === 'remove') return children ? <div className="schedule-bulk-date-fields">{children}</div> : null;
  const updating = operation === 'update';
  return <div className="schedule-bulk-date-fields">
    {children}
    <div className="schedule-bulk-date-field">
      {updating && <label className="schedule-bulk-link-change">
        <input type="checkbox" checked={changes.type} onChange={event => onChanges({ ...changes, type: event.currentTarget.checked })} />
        연결 유형 변경
      </label>}
      <label htmlFor={`${id}-type`}>연결 유형</label>
      <select id={`${id}-type`} value={value.type} className="field" disabled={updating && !changes.type} onChange={event => {
        const type = event.currentTarget.value;
        if (isDependencyType(type)) onChange({ ...value, type });
      }}>
        {DEPENDENCY_TYPES.map(type => <option value={type} key={type}>{type} · {DEPENDENCY_LABELS[type]}</option>)}
      </select>
    </div>
    <div className="schedule-bulk-date-field schedule-bulk-link-lag">
      {updating && <label className="schedule-bulk-link-change">
        <input type="checkbox" checked={changes.lagDays} onChange={event => onChanges({ ...changes, lagDays: event.currentTarget.checked })} />
        근무일 간격 변경
      </label>}
      <label htmlFor={`${id}-lag`}>근무일 간격</label>
      <input id={`${id}-lag`} className="field" type="number" step={1} min={-MAX_DEPENDENCY_LAG_DAYS}
        max={MAX_DEPENDENCY_LAG_DAYS} value={value.lagDays} disabled={updating && !changes.lagDays} required
        onChange={event => onChange({ ...value, lagDays: event.currentTarget.value })} />
    </div>
  </div>;
}
