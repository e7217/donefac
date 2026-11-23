import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import { teamWorkloadCapacitySettingKey } from './team-workload-capacity.js';

export function workspaceRestoreGeneration(store: Store): string {
  return store.setting('attachmentImportGeneration') ?? 'initial';
}

const boardTables = {
  issues: ['id', 'project_id', 'parent_id', 'assignee_id', 'json'],
  projects: ['id', 'key', 'json'],
  users: ['id', 'email', 'json'],
  workflows: ['id', 'json'],
  issue_schemas: ['id', 'json'],
  project_issue_orders: ['project_id', 'issue_ids', 'revision'],
  gitlab_links: ['id', 'issue_id', 'json'],
  dependencies: ['id', 'predecessor_id', 'successor_id', 'json'],
  resource_links: ['id', 'issue_id', 'document_id', 'json'],
  source_bindings: ['product', 'kind', 'source_instance', 'source_alias', 'target_type', 'target_id'],
  source_records: ['product', 'kind', 'source_instance', 'target_type', 'target_id', 'json'],
} as const;

const ganttTables = {
  project_calendars: ['id', 'json'],
  planning_items: ['id', 'project_id', 'kind', 'name', 'json'],
  saved_views: ['id', 'project_id', 'name', 'json'],
  milestones: ['id', 'project_id', 'owner_id', 'json'],
  baselines: ['id', 'project_id', 'author_id', 'json'],
  project_workload_capacities: ['id', 'json'],
  issue_relations: ['id', 'source_issue_id', 'target_issue_id', 'json'],
  issue_time_reservations: ['id', 'issue_id', 'user_id', 'start_at', 'end_at', 'state', 'deleted_at', 'json'],
  settings: ['key', 'value'],
} as const;

const ganttSettingPredicates = {
  insert: `NEW.key='${teamWorkloadCapacitySettingKey}'`,
  update: `(OLD.key='${teamWorkloadCapacitySettingKey}' OR NEW.key='${teamWorkloadCapacitySettingKey}')`,
  delete: `OLD.key='${teamWorkloadCapacitySettingKey}'`,
};

const jiraIssueSource = (row: 'OLD' | 'NEW') => `${row}.product='jira' AND ${row}.kind='issue' AND ${row}.target_type='issue'`;
const workspaceAliasPredicates = {
  insert: jiraIssueSource('NEW'),
  update: `((${jiraIssueSource('OLD')}) OR (${jiraIssueSource('NEW')}))`,
  delete: jiraIssueSource('OLD'),
};

function revisionSchema(
  prefix: 'team_board' | 'gantt', tables: Record<string, readonly string[]>,
): string {
  const revisionTable = `${prefix}_revision`;
  const triggers = Object.entries(tables).flatMap(([table, columns]) => {
    const changed = columns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ');
    return (['insert', 'update', 'delete'] as const).map(event => {
      const predicates: string[] = [];
      if (event === 'update') predicates.push(`(${changed})`);
      if (table === 'settings') predicates.push(ganttSettingPredicates[event]);
      if (table === 'source_bindings' || table === 'source_records') predicates.push(workspaceAliasPredicates[event]);
      const when = predicates.length ? ` WHEN ${predicates.join(' AND ')}` : '';
      return `CREATE TRIGGER IF NOT EXISTS ${prefix}_${table}_${event}
        AFTER ${event} ON ${table}${when}
        BEGIN UPDATE ${revisionTable} SET token=lower(hex(randomblob(16))) WHERE id=1; END;`;
    });
  });
  return `CREATE TABLE IF NOT EXISTS ${revisionTable} (
    id INTEGER PRIMARY KEY CHECK(id=1),
    token TEXT NOT NULL
  );
  INSERT OR IGNORE INTO ${revisionTable}(id,token) VALUES(1,lower(hex(randomblob(16))));
  ${triggers.join('\n')}`;
}

export class WorkspaceRevisions {
  private readonly findRevisions;

  constructor(private readonly store: Store) {
    // Watch committed database changes, including raw SQL and foreign-key cascades.
    // A trigger's token write rolls back with the operation that changed it.
    store.transaction(() => store.db.exec(`${revisionSchema('team_board', boardTables)}\n${revisionSchema('gantt', ganttTables)}`));
    this.findRevisions = store.db.prepare(`SELECT board.token AS board, gantt.token AS gantt
      FROM team_board_revision AS board CROSS JOIN gantt_revision AS gantt WHERE board.id=1 AND gantt.id=1`);
  }

  read<T>(since: { teamBoardSince?: string; ganttSince?: string }, snapshot: () => T): {
    boardRevision: string; ganttRevision: string; data: T | null;
  } {
    const own = !this.store.db.isTransaction;
    if (own) this.store.db.exec('BEGIN');
    try {
      const { board, gantt } = this.findRevisions.get() as { board: string; gantt: string };
      // A restore invalidates local drafts even when the watched records match.
      const boardRevision = createHash('sha256').update(board).update(workspaceRestoreGeneration(this.store)).digest('hex').slice(0, 32);
      const ganttRevision = createHash('sha256').update(boardRevision).update(gantt).digest('hex').slice(0, 32);
      const unchanged = since.teamBoardSince === boardRevision || since.ganttSince === ganttRevision;
      const data = unchanged ? null : snapshot();
      if (own) this.store.db.exec('COMMIT');
      return { boardRevision, ganttRevision, data };
    } catch (error) {
      if (own) this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
}
