'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { MAX_TEAM_FOLLOW_UP_RELATIONS, type Issue, type Project, type TeamScheduleBlocker } from '../../shared/types';
import './gantt-team-blockers.css';

export type TeamFollowUpChoice = { relation: TeamScheduleBlocker; target: Issue };

type Props = {
  source: Pick<Issue, 'key' | 'title'>;
  choices: readonly TeamFollowUpChoice[];
  projects: readonly Pick<Project, 'id' | 'key' | 'name'>[];
  onChoose: (choices: readonly TeamFollowUpChoice[]) => void;
  onClose: () => void;
};

export function GanttTeamFollowUpChooser({ source, choices, projects, onChoose, onClose }: Props) {
  const heading = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const projectById = new Map(projects.map(project => [project.id, project]));
  const selected = choices.filter(({ relation }) => selectedIds.has(relation.id));
  const atLimit = selected.length >= MAX_TEAM_FOLLOW_UP_RELATIONS;

  function selectRelation(id: string, checked: boolean) {
    setSelectedIds(previous => {
      if (checked && previous.size >= MAX_TEAM_FOLLOW_UP_RELATIONS) return previous;
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    firstChoice.current?.focus({ preventScroll: true });
    return () => element.close();
  }, []);

  return <dialog ref={dialog} className="gantt-team-follow-up-chooser" aria-labelledby={heading} aria-describedby={`${heading}-source`}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2 id={heading}>후행 업무 선택</h2>
    <p id={`${heading}-source`}><strong>{source.key}</strong> · {source.title}</p>
    <p>함께 검토할 후행 업무를 선택하세요. 선행 날짜를 바꾸면 이 업무에서 이어지는 활성 Teamspace 차단 관계도 계산합니다.{choices.some(choice => choice.relation.origin === 'jira') &&
      ' Jira 이관 관계는 직접 선택한 연결을 포함합니다.'}</p>
    <div className="gantt-team-follow-up-select-all">
      <span role="status">{selected.length}개 선택{choices.length > MAX_TEAM_FOLLOW_UP_RELATIONS &&
        ` · 최대 ${MAX_TEAM_FOLLOW_UP_RELATIONS}개`}</span>
      {choices.length <= MAX_TEAM_FOLLOW_UP_RELATIONS && <button type="button" className="btn btn-ghost"
        disabled={selected.length === choices.length} onClick={() => setSelectedIds(new Set(choices.map(({ relation }) => relation.id)))}>
        모두 선택
      </button>}
    </div>
    <ul role="list" aria-label="차단되는 후행 업무">{choices.map((choice, index) => {
      const { relation, target } = choice;
      const project = projectById.get(target.projectId);
      const details = `${heading}-choice-${index}`;
      const checked = selectedIds.has(relation.id);
      return <li key={relation.id}>
        <label className="gantt-team-follow-up-checkbox">
          <input type="checkbox" aria-label={`${target.key} 함께 검토`} aria-describedby={details} checked={checked}
            disabled={!checked && atLimit} onChange={event => selectRelation(relation.id, event.currentTarget.checked)} />
        </label>
        <button ref={index === 0 ? firstChoice : undefined} type="button" className="btn" aria-label={`${target.key} 일정 검토`}
          aria-describedby={details} onClick={() => onChoose([choice])}>
          <strong>{target.key}</strong>
          <span id={details}>
            <span>{target.title}</span>
            <small>{project ? `${project.key} · ${project.name}` : '프로젝트 확인 불가'}{relation.origin === 'jira' && ' · Jira 이관 관계'}</small>
          </span>
        </button>
      </li>;
    })}</ul>
    <footer>
      <button type="button" className="btn btn-ghost" onClick={onClose}>취소</button>
      <button type="button" className="btn btn-primary" disabled={!selected.length}
        onClick={() => onChoose(selected)}>선택한 후행 일정 검토</button>
    </footer>
  </dialog>;
}
