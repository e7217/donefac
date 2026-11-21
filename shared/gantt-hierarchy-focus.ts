import { isCalendarDate } from './calendar.js';
import type { Issue, StatusCategory } from './types.js';

export interface GanttHierarchyFocus {
  anchor: Issue;
  issues: Issue[];
  depths: ReadonlyMap<string, number>;
  span: { startDate: string; endDate: string } | null;
  unscheduledCount: number;
  doneCount: number;
  canceledCount: number;
}

export function traceGanttHierarchy(
  anchorId: string,
  issues: readonly Issue[],
  categoryOf: (issue: Issue) => StatusCategory,
): GanttHierarchyFocus | null {
  const anchor = issues.find(issue => issue.id === anchorId);
  if (!anchor) return null;

  const childrenByParent = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (issue.projectId !== anchor.projectId || !issue.parentId || issue.id === issue.parentId) continue;
    const siblings = childrenByParent.get(issue.parentId);
    if (siblings) siblings.push(issue);
    else childrenByParent.set(issue.parentId, [issue]);
  }

  const stack = [{ issue: anchor, depth: 0 }];
  const depths = new Map<string, number>();
  const focusedIssues: Issue[] = [];
  let span: GanttHierarchyFocus['span'] = null;
  let unscheduledCount = 0;
  let doneCount = 0;
  let canceledCount = 0;

  while (stack.length > 0) {
    const { issue, depth } = stack.pop()!;
    if (depths.has(issue.id)) continue;
    depths.set(issue.id, depth);
    focusedIssues.push(issue);

    // Push siblings in reverse order so the next pop visits their first item.
    const children = childrenByParent.get(issue.id) ?? [];
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ issue: children[index], depth: depth + 1 });
    }
    if (depth === 0) continue;

    const category = categoryOf(issue);
    if (category === 'done') doneCount++;
    if (category === 'cancelled') canceledCount++;

    const { startDate, endDate } = issue;
    if (!isCalendarDate(startDate) || !isCalendarDate(endDate) || startDate > endDate) {
      unscheduledCount++;
      continue;
    }
    if (!span) span = { startDate, endDate };
    else {
      if (startDate < span.startDate) span.startDate = startDate;
      if (endDate > span.endDate) span.endDate = endDate;
    }
  }

  depths.delete(anchor.id);
  return { anchor, issues: focusedIssues, depths, span, unscheduledCount, doneCount, canceledCount };
}
