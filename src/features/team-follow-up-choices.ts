import type { FeatureProps, Issue, Project, TeamScheduleBlocker } from '../../shared/types';
import { isTerminalStatus } from '../../shared/workflow-helpers';
import type { TeamFollowUpChoice } from './GanttTeamFollowUpChooser';

export type TeamIncomingBlocker = { relation: TeamScheduleBlocker; source: Issue };

export function groupActiveTeamBlockers(data: FeatureProps['data'], projects: ReadonlyMap<string, Project>) {
  const outgoing = new Map<string, TeamFollowUpChoice[]>();
  const incoming = new Map<string, TeamIncomingBlocker[]>();
  if (!data.teamScheduleBlockers?.length) return { outgoing, incoming };
  const byId = new Map(data.issues.map(issue => [issue.id, issue]));
  for (const relation of data.teamScheduleBlockers) {
    const source = byId.get(relation.sourceIssueId), target = byId.get(relation.targetIssueId);
    if (!source || !target || source.projectId === target.projectId ||
        !projects.has(source.projectId) || !projects.has(target.projectId) ||
        isTerminalStatus(data, source.projectId, source.status) || isTerminalStatus(data, target.projectId, target.status)) continue;
    const successors = outgoing.get(source.id);
    if (successors) successors.push({ relation, target });
    else outgoing.set(source.id, [{ relation, target }]);
    const predecessors = incoming.get(target.id);
    if (predecessors) predecessors.push({ relation, source });
    else incoming.set(target.id, [{ relation, source }]);
  }
  for (const options of outgoing.values()) options.sort((a, b) => a.target.key.localeCompare(b.target.key, 'ko', { numeric: true }));
  for (const options of incoming.values()) options.sort((a, b) => a.source.key.localeCompare(b.source.key, 'ko', { numeric: true }));
  return { outgoing, incoming };
}
