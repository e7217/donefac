import { randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { documentLabelKey } from '../shared/document-labels.js';
import { isRelationId } from '../shared/issue-relations.js';
import type { IssueFieldBreakdownQuery, Project, SavedFieldBreakdown, SavedView } from '../shared/types.js';
import { parseFieldBreakdownQuery, resolveFieldBreakdownSources } from './field-breakdown-routes.js';
import { FieldBreakdownError } from './field-breakdown.js';
import type { IssueSchemaService } from './issue-schema.js';
import type { Store } from './store.js';

const restoreVersionFloor = 'savedFieldBreakdownRestoreVersion';
const queryFields = ['fieldId', 'groupBy', 'savedViewId', 'comparisonBy', 'comparisonFieldId'];
const backupFields = ['id', 'projectId', 'name', 'query', 'version', 'createdAt', 'updatedAt'];

function fail(status: number, message: string): never {
  throw new FieldBreakdownError(status, message);
}

function fields(value: unknown, allowed: readonly string[], message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    return fail(400, message);
  }
  return value as Record<string, unknown>;
}

function nameValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  const name = value.trim().normalize('NFC');
  return name && name.length <= 80 ? name : null;
}

function requireName(value: unknown): string {
  return nameValue(value) ?? fail(400, '필드 집계 이름을 확인해 주세요.');
}

function validId(value: unknown): value is string {
  return isRelationId(value) && value.isWellFormed() && value === value.trim();
}

function queryValue(value: unknown): IssueFieldBreakdownQuery {
  const query = parseFieldBreakdownQuery(fields(value, queryFields, '저장할 필드 집계 조건을 확인해 주세요.'));
  if ([query.fieldId, query.comparisonFieldId, query.savedViewId].some(id => id !== undefined && !validId(id))) {
    return fail(400, '필드 또는 저장된 보기의 ID를 확인해 주세요.');
  }
  return query;
}

function sameQuery(left: IssueFieldBreakdownQuery, right: IssueFieldBreakdownQuery): boolean {
  return left.fieldId === right.fieldId && left.groupBy === right.groupBy &&
    left.savedViewId === right.savedViewId && left.comparisonBy === right.comparisonBy && left.comparisonFieldId === right.comparisonFieldId;
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function nextVersion(version: number): number {
  if (version >= Number.MAX_SAFE_INTEGER) return fail(409, '필드 집계의 수정 버전 범위를 초과했습니다.');
  return version + 1;
}

function expectVersion(value: unknown, preset: SavedFieldBreakdown): void {
  if (!isVersion(value)) return fail(400, '필드 집계의 expectedVersion이 필요합니다.');
  if (value !== preset.version) return fail(409, '다른 작업자가 필드 집계를 변경했습니다. 목록을 다시 불러와 주세요.');
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export class SavedFieldBreakdownService {
  constructor(private readonly store: Store, private readonly schemas: IssueSchemaService) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS saved_field_breakdowns (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name_key TEXT NOT NULL,
      json TEXT NOT NULL,
      UNIQUE(project_id, name_key)
    )`);
  }

  all(): SavedFieldBreakdown[] {
    const rows = this.store.db.prepare('SELECT json FROM saved_field_breakdowns ORDER BY id').all() as { json: string }[];
    return rows.map(row => JSON.parse(row.json) as SavedFieldBreakdown);
  }

  versions(): Map<string, number> {
    return new Map(this.all().map(preset => [preset.id, preset.version]));
  }

  validateImport(values: unknown, projects: readonly Project[], savedViews: readonly SavedView[]): SavedFieldBreakdown[] {
    const message = '백업의 저장된 필드 집계를 확인해 주세요.';
    if (!Array.isArray(values)) return fail(400, message);
    const projectIds = new Set(projects.map(project => project.id));
    const views = new Map(savedViews.map(view => [view.id, view]));
    const ids = new Set<string>();
    const names = new Set<string>();
    return values.map(raw => {
      const row = fields(raw, backupFields, message);
      const { id, projectId, version, createdAt, updatedAt } = row;
      const name = nameValue(row.name);
      if (!validId(id) || ids.has(id) || !validId(projectId) || !projectIds.has(projectId) || !name || name !== row.name ||
        !isVersion(version) || !isoTimestamp(createdAt) || !isoTimestamp(updatedAt) || createdAt > updatedAt) {
        return fail(400, message);
      }
      const key = JSON.stringify([projectId, documentLabelKey(name)]);
      if (names.has(key)) return fail(400, '백업에 같은 프로젝트에서 이름이 겹치는 필드 집계가 있습니다.');
      const query = queryValue(row.query);
      const view = query.savedViewId ? views.get(query.savedViewId) : undefined;
      if (view && view.projectId !== projectId) return fail(400, '백업의 필드 집계에 다른 프로젝트의 보기가 연결되어 있습니다.');
      ids.add(id);
      names.add(key);
      return { id, projectId, name, query, version, createdAt, updatedAt };
    });
  }

  replaceImported(values: readonly SavedFieldBreakdown[], previousVersions: ReadonlyMap<string, number>): void {
    if (!this.store.db.isTransaction) throw new Error('Saved field breakdown restoration requires a transaction.');
    const oldFloor = this.floor();
    this.store.db.exec('DELETE FROM saved_field_breakdowns');
    for (const value of values) {
      const previous = Math.max(oldFloor, previousVersions.get(value.id) ?? 0);
      this.put({ ...value, version: previous ? nextVersion(Math.max(value.version, previous)) : value.version });
    }
    const restoredIds = new Set(values.map(value => value.id));
    let removedFloor = oldFloor;
    for (const [id, version] of previousVersions) if (!restoredIds.has(id)) removedFloor = Math.max(removedFloor, version);
    if (removedFloor > oldFloor) this.store.setSetting(restoreVersionFloor, removedFloor);
  }

  private floor(): number {
    const floor: unknown = this.store.setting(restoreVersionFloor);
    return isVersion(floor) ? floor : 0;
  }

  private put(preset: SavedFieldBreakdown): void {
    this.store.db.prepare(`INSERT INTO saved_field_breakdowns(id, project_id, name_key, json) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name_key=excluded.name_key, json=excluded.json`)
      .run(preset.id, preset.projectId, documentLabelKey(preset.name), JSON.stringify(preset));
  }

  private get(projectId: string, presetId: string): SavedFieldBreakdown {
    const preset = this.store.get<SavedFieldBreakdown>('saved_field_breakdowns', presetId);
    if (!preset || preset.projectId !== projectId) return fail(404, '이 프로젝트에서 저장된 필드 집계를 찾을 수 없습니다.');
    return preset;
  }

  private findByName(projectId: string, name: string): SavedFieldBreakdown | undefined {
    const row = this.store.db.prepare('SELECT json FROM saved_field_breakdowns WHERE project_id=? AND name_key=?')
      .get(projectId, documentLabelKey(name)) as { json: string } | undefined;
    return row && JSON.parse(row.json) as SavedFieldBreakdown;
  }

  registerRoutes(app: Express, hooks: {
    actor: (request: Request) => string;
    activity: (request: Request, resourceType: string, resourceId: string, action: string, detail?: string) => unknown;
  }): void {
    const path = '/api/projects/:id/field-breakdown-presets';
    app.get(path, (req, res) => {
      this.schemas.get(req.params.id);
      const rows = this.store.db.prepare('SELECT json FROM saved_field_breakdowns WHERE project_id=? ORDER BY name_key, id')
        .all(req.params.id) as { json: string }[];
      res.set('Cache-Control', 'no-store').json(rows.map(row => JSON.parse(row.json) as SavedFieldBreakdown));
    });
    app.post(path, (req, res) => {
      const body = fields(req.body, ['name', 'query'], '필드 집계 저장 요청을 확인해 주세요.');
      const name = requireName(body.name);
      const query = queryValue(body.query);
      const { id: projectId } = req.params;
      const result = this.store.transaction(() => {
        hooks.actor(req);
        const schema = this.schemas.get(projectId);
        const previous = this.findByName(projectId, name);
        if (previous) {
          if (!sameQuery(previous.query, query)) return fail(409, '이 프로젝트에 같은 이름의 필드 집계가 있습니다.');
          return { preset: previous, created: false };
        }
        resolveFieldBreakdownSources(this.store, schema, query);
        const now = new Date().toISOString();
        const preset: SavedFieldBreakdown = { id: randomUUID(), projectId, name, query, version: 1, createdAt: now, updatedAt: now };
        this.put(preset);
        hooks.activity(req, 'project', projectId, '필드 집계 저장', name);
        return { preset, created: true };
      });
      res.status(result.created ? 201 : 200).json(result.preset);
    });
    app.patch(`${path}/:presetId`, (req, res) => {
      const body = fields(req.body, ['expectedVersion', 'name', 'query'], '필드 집계 수정 요청을 확인해 주세요.');
      const rename = Object.hasOwn(body, 'name');
      const replaceQuery = Object.hasOwn(body, 'query');
      if (!rename && !replaceQuery) return fail(400, '변경할 필드 집계 이름이나 조건을 확인해 주세요.');
      const { id: projectId, presetId } = req.params;
      const preset = this.store.transaction(() => {
        hooks.actor(req);
        const previous = this.get(projectId, presetId);
        expectVersion(body.expectedVersion, previous);
        const name = rename ? requireName(body.name) : previous.name;
        const query = replaceQuery ? queryValue(body.query) : previous.query;
        if (replaceQuery) resolveFieldBreakdownSources(this.store, this.schemas.get(projectId), query);
        if (name === previous.name && sameQuery(query, previous.query)) return previous;
        const matchingName = this.findByName(projectId, name);
        if (matchingName && matchingName.id !== previous.id) return fail(409, '이 프로젝트에 같은 이름의 필드 집계가 있습니다.');
        const updated = { ...previous, name, query, version: nextVersion(previous.version), updatedAt: new Date().toISOString() };
        this.put(updated);
        hooks.activity(req, 'project', projectId, '필드 집계 변경', name);
        return updated;
      });
      res.json(preset);
    });
    app.delete(`${path}/:presetId`, (req, res) => {
      const { expectedVersion: raw } = fields(req.query, ['expectedVersion'], '필드 집계 삭제 요청을 확인해 주세요.');
      const expectedVersion = typeof raw === 'string' && /^[1-9]\d*$/u.test(raw) ? Number(raw) : NaN;
      const { id: projectId, presetId } = req.params;
      this.store.transaction(() => {
        hooks.actor(req);
        const preset = this.get(projectId, presetId);
        expectVersion(expectedVersion, preset);
        this.store.remove('saved_field_breakdowns', presetId);
        if (preset.version > this.floor()) this.store.setSetting(restoreVersionFloor, preset.version);
        hooks.activity(req, 'project', projectId, '필드 집계 삭제', preset.name);
      });
      res.json({ ok: true });
    });
  }
}
