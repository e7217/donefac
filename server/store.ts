import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export class Store {
  db: DatabaseSync;
  key: Buffer;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const keyPath = join(dataDir, '.credential-key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    this.key = readFileSync(keyPath);
    this.db = new DatabaseSync(join(dataDir, 'teamspace.sqlite'));
    chmodSync(join(dataDir, 'teamspace.sqlite'), 0o600);
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
      CREATE TABLE IF NOT EXISTS issue_sequences(project_id TEXT PRIMARY KEY REFERENCES projects(id),next_number INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS issues_project ON issues(project_id);
      CREATE INDEX IF NOT EXISTS documents_parent ON documents(parent_id);
      CREATE INDEX IF NOT EXISTS comments_resource ON comments(resource_type,resource_id);
      CREATE INDEX IF NOT EXISTS attachments_resource ON attachments(resource_type,resource_id);
    `);
  }
  all<T = any>(table: string): T[] { return (this.db.prepare(`SELECT json FROM ${table}`).all() as {json: string}[]).map(r => JSON.parse(r.json)); }
  get<T = any>(table: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id) as {json: string} | undefined;
    return row && JSON.parse(row.json);
  }
  put(table: string, value: any) {
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
    this.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${keys.slice(1).map(k => `${k}=excluded.${k}`).join(',')}`).run(value.id, ...Object.values(extra), JSON.stringify(value));
  }
  remove(table: string, id: string) { this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
    const [iv, tag, content] = value.split('.').map(v => Buffer.from(v, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(content), decipher.final()]).toString('utf8');
  }
}
