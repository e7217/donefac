import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import { teamWorkloadCapacitySettingKey } from './team-workload-capacity.js';

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
      const { board: boardRevision, gantt } = this.findRevisions.get() as { board: string; gantt: string };
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
