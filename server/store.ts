import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Comment, MutationOrigin } from '../shared/types.js';
import { assertWorkspaceCredentials, CREDENTIAL_KEY_FILE, decryptWorkspaceCredential, readWorkspaceCredentialKey } from './workspace-credentials.mjs';

export interface MutationContext { actorId: string | null; origin: MutationOrigin; sourceEventId?: string | null }
export interface StoreChange { table: string; before: unknown; after: unknown; context: MutationContext }

export class Store {
  db: DatabaseSync;
  key: Buffer;
  private transactionActive = false;
  private changeListeners = new Map<(change: StoreChange) => void, Set<string> | null>();
  private mutationContexts = new AsyncLocalStorage<MutationContext>();
  withMutationContext<T>(context: MutationContext, action: () => T): T { return this.mutationContexts.run(context, action); }
  onChange(listener: (change: StoreChange) => void, tables?: string[]): () => void { this.changeListeners.set(listener,tables ? new Set(tables) : null); return () => { this.changeListeners.delete(listener); }; }
  private observed(table: string) { return [...this.changeListeners.values()].some(tables=>!tables||tables.has(table)); }
  private changed(table: string, before: unknown, after: unknown) {
    const change: StoreChange={table,before,after,context:this.mutationContexts.getStore()||{actorId:null,origin:'system',sourceEventId:null}};
    for(const [listener,tables] of this.changeListeners)if(!tables||tables.has(table))listener(change);
  }
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const dbPath = join(dataDir, 'teamspace.sqlite');
    const keyPath = join(dataDir, CREDENTIAL_KEY_FILE);
    let key = readWorkspaceCredentialKey(dataDir);
    if (existsSync(dbPath)) {
      const existing = new DatabaseSync(dbPath, { readOnly: true });
      try { assertWorkspaceCredentials(existing, key); }
      finally { existing.close(); }
    }
    if (!key) {
      try { writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600, flush: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      key = readWorkspaceCredentialKey(dataDir);
      if (!key) throw new Error('.credential-key 파일을 만들 수 없습니다.');
    }
    chmodSync(keyPath, 0o600);
    this.key = key;
    this.db = new DatabaseSync(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE COLLATE NOCASE,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,key TEXT NOT NULL UNIQUE,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issues(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),parent_id TEXT REFERENCES issues(id) DEFERRABLE INITIALLY DEFERRED,assignee_id TEXT REFERENCES users(id),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),parent_id TEXT REFERENCES documents(id) DEFERRABLE INITIALLY DEFERRED,author_id TEXT NOT NULL REFERENCES users(id),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dependencies(id TEXT PRIMARY KEY,predecessor_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,successor_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,json TEXT NOT NULL,UNIQUE(predecessor_id,successor_id));
      CREATE TABLE IF NOT EXISTS resource_links(id TEXT PRIMARY KEY,issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,json TEXT NOT NULL,UNIQUE(issue_id,document_id));
      CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,resource_type TEXT NOT NULL,resource_id TEXT NOT NULL,author_id TEXT NOT NULL REFERENCES users(id),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,resource_type TEXT NOT NULL,resource_id TEXT NOT NULL,author_id TEXT NOT NULL REFERENCES users(id),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activities(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gitlab_links(id TEXT PRIMARY KEY,issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_inbox(id TEXT PRIMARY KEY,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_undos(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS schedule_undos_by_actor_scope ON schedule_undos(json_extract(json,'$.actorId'),json_extract(json,'$.scope'));
      CREATE TABLE IF NOT EXISTS schedule_undo_results(
        undo_id TEXT PRIMARY KEY REFERENCES schedule_undos(id) ON DELETE CASCADE,
        completed_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedule_undo_results_by_completion ON schedule_undo_results(completed_at);
      CREATE TABLE IF NOT EXISTS schedule_dependency_removals(
        predecessor_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        successor_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        undo_id TEXT NOT NULL REFERENCES schedule_undos(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        PRIMARY KEY(predecessor_id, successor_id)
      );
      CREATE INDEX IF NOT EXISTS schedule_dependency_removals_by_successor ON schedule_dependency_removals(successor_id);
      CREATE INDEX IF NOT EXISTS schedule_dependency_removals_by_undo ON schedule_dependency_removals(undo_id);
      -- Recreating a pair invalidates its earlier removal even if the new link is later deleted.
      CREATE TRIGGER IF NOT EXISTS clear_schedule_dependency_removal_on_insert AFTER INSERT ON dependencies
      BEGIN
        DELETE FROM schedule_dependency_removals WHERE predecessor_id=NEW.predecessor_id AND successor_id=NEW.successor_id;
      END;
      CREATE TRIGGER IF NOT EXISTS clear_schedule_dependency_removal_on_direction_change
      AFTER UPDATE OF predecessor_id, successor_id ON dependencies
      WHEN OLD.predecessor_id<>NEW.predecessor_id OR OLD.successor_id<>NEW.successor_id
      BEGIN
        DELETE FROM schedule_dependency_removals WHERE predecessor_id=NEW.predecessor_id AND successor_id=NEW.successor_id;
      END;
      CREATE TABLE IF NOT EXISTS issue_sequences(project_id TEXT PRIMARY KEY REFERENCES projects(id),next_number INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS issues_project ON issues(project_id);
      CREATE INDEX IF NOT EXISTS documents_parent ON documents(parent_id);
      CREATE INDEX IF NOT EXISTS comments_resource ON comments(resource_type,resource_id);
      CREATE INDEX IF NOT EXISTS attachments_resource ON attachments(resource_type,resource_id);
      CREATE INDEX IF NOT EXISTS gitlab_links_issue ON gitlab_links(issue_id);
    `);
  }
  all<T = any>(table: string): T[] { return (this.db.prepare(`SELECT json FROM ${table}`).all() as {json: string}[]).map(r => JSON.parse(r.json)); }
  commentsForResource(type: Comment['resourceType'], id: string): Comment[] {
    const rows = this.db.prepare(`SELECT json FROM comments WHERE resource_type=? AND resource_id=?
      ORDER BY julianday(json_extract(json,'$.createdAt')),rowid`).all(type, id) as {json:string}[];
    return rows.map(row => JSON.parse(row.json) as Comment);
  }
  get<T = any>(table: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id) as {json: string} | undefined;
    return row && JSON.parse(row.json);
  }
  put(table: string, value: any): void {
    const observed=this.observed(table);
    if(observed&&!this.transactionActive)return this.transaction(()=>this.put(table,value));
    const before=observed?this.get(table,value.id):undefined;
    const cols: Record<string, Record<string, any>> = {
      users: { email: value.email }, projects: { key: value.key },
      issues: { project_id: value.projectId, parent_id: value.parentId, assignee_id: value.assigneeId },
      documents: { project_id: value.projectId, parent_id: value.parentId, author_id: value.authorId },
      dependencies: { predecessor_id: value.predecessorId, successor_id: value.successorId },
      resource_links: { issue_id: value.issueId, document_id: value.documentId },
      revisions: { document_id: value.documentId },
      comments: { resource_type: value.resourceType, resource_id: value.resourceId, author_id: value.authorId },
      attachments: { resource_type: value.resourceType, resource_id: value.resourceId, author_id: value.authorId },
      gitlab_links: { issue_id: value.issueId },
    };
    const extra = cols[table] || {};
    const keys = ['id', ...Object.keys(extra), 'json'];
    const serialized=JSON.stringify(value);
    this.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${keys.slice(1).map(k => `${k}=excluded.${k}`).join(',')}`).run(value.id, ...Object.values(extra), serialized);
    if(observed)this.changed(table,before,JSON.parse(serialized));
  }
  remove(table: string, id: string): void {
    const observed=this.observed(table);
    if(observed&&!this.transactionActive)return this.transaction(()=>this.remove(table,id));
    const before=observed?this.get(table,id):undefined;
    this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
    if(observed&&before)this.changed(table,before,undefined);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionActive=true;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionActive=false; }
  }
  setting(key: string): any {
    const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    return r ? JSON.parse(r.value) : null;
  }
  setSetting(key: string, value: any) { this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  seal(value: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map(b => b.toString('base64')).join('.');
  }
  unseal(value: string) {
    return decryptWorkspaceCredential(this.key, value).toString('utf8');
  }
}
