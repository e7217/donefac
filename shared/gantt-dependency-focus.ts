import type { Dependency, Issue } from './types.js';

export interface GanttDependencyFocus {
  anchor: Issue;
  issues: Issue[];
  predecessorDepths: ReadonlyMap<string, number>;
  successorDepths: ReadonlyMap<string, number>;
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
export function traceGanttDependencies(anchorId: string, issues: readonly Issue[], dependencies: readonly Dependency[]): GanttDependencyFocus | null {
  const anchor = issues.find(issue => issue.id === anchorId);
  if (!anchor) return null;

  const projectIssues = issues.filter(issue => issue.projectId === anchor.projectId);
  const projectIssueIds = new Set(projectIssues.map(issue => issue.id));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const { predecessorId, successorId } of dependencies) {
    if (predecessorId === successorId || !projectIssueIds.has(predecessorId) || !projectIssueIds.has(successorId)) continue;
    addNeighbor(incoming, successorId, predecessorId);
    addNeighbor(outgoing, predecessorId, successorId);
  }

  const predecessorDepths = dependencyDepths(anchorId, incoming);
  const successorDepths = dependencyDepths(anchorId, outgoing);
  return {
    anchor,
    issues: projectIssues.filter(issue => issue.id === anchorId || predecessorDepths.has(issue.id) || successorDepths.has(issue.id)),
    predecessorDepths,
    successorDepths,
  };
}
