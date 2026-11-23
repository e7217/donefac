'use client';

import { useId, useLayoutEffect, useRef } from 'react';
import type { Issue, Project, TeamScheduleBlocker } from '../../shared/types';
import './gantt-team-blockers.css';

export type TeamFollowUpChoice = { relation: TeamScheduleBlocker; target: Issue };

type Props = {
  source: Pick<Issue, 'key' | 'title'>;
  choices: readonly TeamFollowUpChoice[];
  projects: readonly Pick<Project, 'id' | 'key' | 'name'>[];
  onChoose: (choice: TeamFollowUpChoice) => void;
  onClose: () => void;
};

export function GanttTeamFollowUpChooser({ source, choices, projects, onChoose, onClose }: Props) {
  const heading = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const projectById = new Map(projects.map(project => [project.id, project]));

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
    <p>Teamspace에 연결된 후행 업무를 함께 검토합니다.{choices.some(choice => choice.relation.origin === 'jira') &&
      ' Jira 이관 관계는 선택한 연결을 검토합니다.'}</p>
    <ul role="list" aria-label="차단되는 후행 업무">{choices.map((choice, index) => {
      const { relation, target } = choice;
      const project = projectById.get(target.projectId);
      const details = `${heading}-choice-${index}`;
      return <li key={relation.id}>
        <button ref={index === 0 ? firstChoice : undefined} type="button" className="btn" aria-label={`${target.key} 일정 검토`}
          aria-describedby={details} onClick={() => onChoose(choice)}>
          <strong>{target.key}</strong>
          <span id={details}>
            <span>{target.title}</span>
            <small>{project ? `${project.key} · ${project.name}` : '프로젝트 확인 불가'}{relation.origin === 'jira' && ' · Jira 이관 관계'}</small>
          </span>
        </button>
      </li>;
    })}</ul>
    <footer><button type="button" className="btn btn-ghost" onClick={onClose}>취소</button></footer>
  </dialog>;
}
