import { isDonefacIssueRelation } from '../shared/issue-relations.js';
import type { Issue, IssueRelation, ProjectWorkflow } from '../shared/types.js';
import { isTerminalStatus } from '../shared/workflow-helpers.js';
import { MAX_NOTIFICATION_DETAIL_LENGTH } from './notifications.js';
import type { Store } from './store.js';

type BlockerNotificationKind = 'issue-block-added' | 'issue-block-resolved';
type Notify = (issue: Issue, actorId: string, kind: BlockerNotificationKind, createdAt: string, detail: string) => void;

function canonicalBlock(relation: IssueRelation | undefined): IssueRelation | undefined {
  if (relation && isDonefacIssueRelation(relation) && relation.type === 'blocks' && relation.sourceIssueId !== relation.targetIssueId) {
    return relation;
  }
}

function sourceLabel(issue: Issue, prefix = ''): string {
  const title = issue.title.replace(/\p{Cc}+/gu, ' ').trim();
  const key = issue.key.replace(/\p{Cc}+/gu, ' ').trim();
  // Older native backups did not limit the issue key length.
  const keyLimit = MAX_NOTIFICATION_DETAIL_LENGTH - prefix.length - title.length - 1;
  const displayKey = key.length > keyLimit ? `${key.slice(0, keyLimit - 1).toWellFormed()}…` : key;
  const label = [displayKey, title].filter(Boolean).join(' ') || '원인 업무';
  return `${prefix}${label}`;
}

/** Emit notifications on a change to one blocking cause inside the caller's transaction. */
export class IssueBlockerNotifications {
  constructor(
    private readonly store: Store,
    private readonly getWorkflow: (projectId: string) => ProjectWorkflow,
    private readonly notify: Notify,
  ) {}

  relationChanged(before: IssueRelation | undefined, after: IssueRelation | undefined, actorId: string, createdAt: string): void {
    const previous = canonicalBlock(before);
    const current = canonicalBlock(after);
    if (previous && current && previous.sourceIssueId === current.sourceIssueId && previous.targetIssueId === current.targetIssueId) return;
    if (previous) this.notifyRelation(previous, actorId, 'issue-block-resolved', createdAt);
    if (current) this.notifyRelation(current, actorId, 'issue-block-added', createdAt);
  }

  sourceStatusChanged(before: Issue, after: Issue, actorId: string, createdAt: string): void {
    if (before.id !== after.id || (before.projectId === after.projectId && before.status === after.status)) return;
    const terminal = this.terminal(after);
    if (this.terminal(before) === terminal) return;

    const targets = this.store.db.prepare(`
      SELECT DISTINCT target_issue_id AS id FROM issue_relations
      WHERE source_issue_id=? AND target_issue_id<>source_issue_id
        AND json_extract(json,'$.origin')='donefac' AND json_extract(json,'$.type')='blocks'
      ORDER BY target_issue_id
    `).all(after.id) as { id: string }[];
    const kind = terminal ? 'issue-block-resolved' : 'issue-block-added';
    const event = terminal ? '원인 업무 종료' : '원인 업무 재개';
    for (const { id } of targets) {
      const target = this.store.get<Issue>('issues', id);
      if (target && !this.terminal(target)) {
        this.notify(target, actorId, kind, createdAt, sourceLabel(after, `${event} · `));
      }
    }
  }

  private terminal(issue: Issue): boolean {
    return isTerminalStatus({ workflows: [this.getWorkflow(issue.projectId)] }, issue.projectId, issue.status);
  }

  private notifyRelation(relation: IssueRelation, actorId: string, kind: BlockerNotificationKind, createdAt: string): void {
    const source = this.store.get<Issue>('issues', relation.sourceIssueId);
    const target = this.store.get<Issue>('issues', relation.targetIssueId);
    if (source && target && !this.terminal(source) && !this.terminal(target)) {
      this.notify(target, actorId, kind, createdAt, sourceLabel(source));
    }
  }
}
