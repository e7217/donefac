import type { Store } from './store.js';

const watchedTables = {
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
const updateRevision = 'UPDATE team_board_revision SET token=lower(hex(randomblob(16))) WHERE id=1';

export class TeamBoardRevision {
  private readonly findRevision;

  constructor(private readonly store: Store) {
    // Watch committed database changes, including raw SQL and foreign-key cascades.
    // A trigger's token write rolls back with the operation that changed it.
    const triggers = Object.entries(watchedTables).flatMap(([table, columns]) => {
      const changed = columns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ');
      return ['insert', 'update', 'delete'].map(event => `CREATE TRIGGER IF NOT EXISTS team_board_${table}_${event}
        AFTER ${event} ON ${table}${event === 'update' ? ` WHEN ${changed}` : ''}
        BEGIN ${updateRevision}; END;`);
    });
    store.transaction(() => store.db.exec(`CREATE TABLE IF NOT EXISTS team_board_revision (
      id INTEGER PRIMARY KEY CHECK(id=1),
      token TEXT NOT NULL
    );
    INSERT OR IGNORE INTO team_board_revision(id,token) VALUES(1,lower(hex(randomblob(16))));
    ${triggers.join('\n')}`));
    this.findRevision = store.db.prepare('SELECT token FROM team_board_revision WHERE id=1');
  }

  read<T>(since: string | undefined, snapshot: () => T): { revision: string; data: T | null } {
    const own = !this.store.db.isTransaction;
    if (own) this.store.db.exec('BEGIN');
    try {
      const { token } = this.findRevision.get() as { token: string };
      const data = since === token ? null : snapshot();
      if (own) this.store.db.exec('COMMIT');
      return { revision: token, data };
    } catch (error) {
      if (own) this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
}
