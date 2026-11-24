import type { IssueReportEvent } from '../shared/types.js';
import type { Store } from './store.js';

export interface IssueProjectTransfer {
  fromProjectId: string;
  toProjectId: string;
  occurredAt: string;
}

export type IssueProjectHistory = ReadonlyMap<string, readonly IssueProjectTransfer[]>;

function appendTransfer(history: Map<string, IssueProjectTransfer[]>, from: IssueReportEvent, to: IssueReportEvent | undefined) {
  if (from.kind !== 'moved_out' || to?.kind !== 'moved_in' || from.origin !== 'user' || to.origin !== 'user' ||
      !from.before || !to.after || from.after !== null || to.before !== null ||
      from.issueId !== to.issueId || from.before.issueId !== from.issueId || to.after.issueId !== to.issueId ||
      from.before.projectId !== from.projectId || to.after.projectId !== to.projectId ||
      from.projectId === to.projectId || from.before.key === to.after.key || from.sequence + 1 !== to.sequence ||
      from.occurredAt !== to.occurredAt || from.coverageId !== to.coverageId || from.actorId !== to.actorId) return;
  const moves = history.get(from.issueId) ?? [];
  moves.push({ fromProjectId: from.projectId, toProjectId: to.projectId, occurredAt: from.occurredAt });
  history.set(from.issueId, moves);
}

/** Extract transfers from the ledger already validated during native restore. */
export function issueProjectHistoryFromEvents(events: readonly IssueReportEvent[]): IssueProjectHistory {
  const history = new Map<string, IssueProjectTransfer[]>();
  for (let index = 0; index < events.length; index++) appendTransfer(history, events[index], events[index + 1]);
  return history;
}

export function readIssueProjectHistory(store: Store, issueIds?: readonly string[]): IssueProjectHistory {
  const history = new Map<string, IssueProjectTransfer[]>();
  if (issueIds?.length === 0) return history;
  const selected = issueIds ? "AND json_extract(source.json,'$.issueId') IN (SELECT value FROM json_each(?))" : '';
  const rows = store.db.prepare(`SELECT source.json AS source, destination.json AS destination
    FROM reporting_events AS source JOIN reporting_events AS destination ON destination.sequence=source.sequence+1
    WHERE json_extract(source.json,'$.kind')='moved_out' ${selected} ORDER BY source.sequence`)
    .iterate(...(issueIds ? [JSON.stringify(issueIds)] : [])) as Iterable<{ source: string; destination: string }>;
  for (const row of rows) appendTransfer(history, JSON.parse(row.source), JSON.parse(row.destination));
  return history;
}

/** Rewind transfers strictly after a receipt time, requiring a continuous path from the current project. */
export function issueProjectAt(history: IssueProjectHistory, issueId: string, currentProjectId: string, at: string): string | null {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) return null;
  const moves = history.get(issueId) ?? [];
  let projectId = currentProjectId;
  for (let index = moves.length - 1; index >= 0 && Date.parse(moves[index].occurredAt) > timestamp; index--) {
    const move = moves[index];
    if (move.toProjectId !== projectId) return null;
    projectId = move.fromProjectId;
  }
  return projectId;
}

export function hasIssueProjectMove(history: IssueProjectHistory, issueId: string, sourceProjectId: string, currentProjectId: string, since?: string): boolean {
  const timestamp = since === undefined ? -Infinity : Date.parse(since);
  if (Number.isNaN(timestamp)) return false;
  const moves = history.get(issueId) ?? [];
  let projectId = currentProjectId;
  for (let index = moves.length - 1; index >= 0 && Date.parse(moves[index].occurredAt) >= timestamp; index--) {
    const move = moves[index];
    if (move.toProjectId !== projectId) return false;
    if (move.fromProjectId === sourceProjectId) return true;
    projectId = move.fromProjectId;
  }
  return false;
}
