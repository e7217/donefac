import type { Dependency, Issue, TeamScheduleBlocker } from './types.js';

export interface GanttDependencyFocus {
  anchor: Issue;
  issues: Issue[];
  predecessorDepths: ReadonlyMap<string, number>;
  successorDepths: ReadonlyMap<string, number>;
}

export interface GanttTeamDependencyFocus extends GanttDependencyFocus {
  dependencyIds: ReadonlySet<string>;
  teamBlockerIds: ReadonlySet<string>;
}

function addNeighbor(adjacency: Map<string, string[]>, from: string, to: string) {
  const neighbors = adjacency.get(from);
  if (neighbors) neighbors.push(to);
  else adjacency.set(from, [to]);
}

function dependencyDepths(anchorId: string, adjacency: ReadonlyMap<string, string[]>): Map<string, number> {
  const depths = new Map([[anchorId, 0]]);
  const queue = [anchorId];
  for (let current = 0; current < queue.length; current++) {
    const issueId = queue[current];
    const nextDepth = depths.get(issueId)! + 1;
    for (const neighbor of adjacency.get(issueId) ?? []) {
      if (depths.has(neighbor)) continue;
      depths.set(neighbor, nextDepth);
      queue.push(neighbor);
    }
  }
  depths.delete(anchorId);
  return depths;
}

/** Walk directly toward the anchor or away from it to keep collateral branches out of the chart. */
export function traceGanttDependencies(anchorId: string, issues: readonly Issue[], dependencies: readonly Dependency[]): GanttDependencyFocus | null;
export function traceGanttDependencies(anchorId: string, issues: readonly Issue[], dependencies: readonly Dependency[],
  teamBlockers: readonly TeamScheduleBlocker[]): GanttTeamDependencyFocus | null;
export function traceGanttDependencies(anchorId: string, issues: readonly Issue[], dependencies: readonly Dependency[],
  teamBlockers?: readonly TeamScheduleBlocker[]): GanttDependencyFocus | GanttTeamDependencyFocus | null {
  const anchor = issues.find(issue => issue.id === anchorId);
  if (!anchor) return null;

  const candidates = teamBlockers ? issues : issues.filter(issue => issue.projectId === anchor.projectId);
  const projectByIssue = new Map(candidates.map(issue => [issue.id, issue.projectId]));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  function addLink(predecessorId: string, successorId: string, crossProject: boolean) {
    const sourceProject = projectByIssue.get(predecessorId), targetProject = projectByIssue.get(successorId);
    if (predecessorId === successorId || sourceProject === undefined || targetProject === undefined ||
        (sourceProject !== targetProject) !== crossProject) return false;
    addNeighbor(incoming, successorId, predecessorId);
    addNeighbor(outgoing, predecessorId, successorId);
    return true;
  }
  const localLinks: Dependency[] = [];
  const crossLinks: TeamScheduleBlocker[] = [];
  for (const link of dependencies) {
    if (addLink(link.predecessorId, link.successorId, false) && teamBlockers) localLinks.push(link);
  }
  for (const link of teamBlockers ?? []) {
    if (addLink(link.sourceIssueId, link.targetIssueId, true)) crossLinks.push(link);
  }

  const predecessorDepths = dependencyDepths(anchorId, incoming);
  const successorDepths = dependencyDepths(anchorId, outgoing);
  const result = {
    anchor,
    issues: candidates.filter(issue => issue.id === anchorId || predecessorDepths.has(issue.id) || successorDepths.has(issue.id)),
    predecessorDepths,
    successorDepths,
  };
  if (!teamBlockers) return result;

  function traversed(sourceId: string, targetId: string) {
    // A link between two displayed rows can still bypass the anchor entirely.
    return ((sourceId === anchorId || predecessorDepths.has(sourceId)) && (targetId === anchorId || predecessorDepths.has(targetId))) ||
      ((sourceId === anchorId || successorDepths.has(sourceId)) && (targetId === anchorId || successorDepths.has(targetId)));
  }
  return {
    ...result,
    dependencyIds: new Set(localLinks.filter(({ predecessorId, successorId }) => traversed(predecessorId, successorId)).map(link => link.id)),
    teamBlockerIds: new Set(crossLinks.filter(({ sourceIssueId, targetIssueId }) => traversed(sourceIssueId, targetIssueId)).map(link => link.id)),
  };
}
