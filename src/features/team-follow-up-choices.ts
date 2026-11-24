import type { FeatureProps, Project } from '../../shared/types';
import { isTerminalStatus } from '../../shared/workflow-helpers';
import type { TeamFollowUpChoice } from './GanttTeamFollowUpChooser';

export function findTeamBlockerChoices(data: FeatureProps['data'], projects: ReadonlyMap<string, Project>) {
  const choices = new Map<string, TeamFollowUpChoice[]>();
  if (!data.teamScheduleBlockers?.length) return choices;
  const byId = new Map(data.issues.map(issue => [issue.id, issue]));
  for (const relation of data.teamScheduleBlockers) {
    const source = byId.get(relation.sourceIssueId), target = byId.get(relation.targetIssueId);
    if (!source || !target || source.projectId === target.projectId ||
        !projects.has(source.projectId) || !projects.has(target.projectId) ||
        isTerminalStatus(data, source.projectId, source.status) || isTerminalStatus(data, target.projectId, target.status)) continue;
    const current = choices.get(source.id);
    if (current) current.push({ relation, target });
    else choices.set(source.id, [{ relation, target }]);
  }
  for (const options of choices.values()) options.sort((a, b) => a.target.key.localeCompare(b.target.key, 'ko', { numeric: true }));
  return choices;
}
