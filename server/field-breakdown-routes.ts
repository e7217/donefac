import type { Express } from 'express';
import type { Issue, IssueFieldBreakdownPage, SavedView, User } from '../shared/types.js';
import { createIssueViewMatcher } from '../shared/issue-view.js';
import { buildIssueFieldBreakdown, FieldBreakdownError } from './field-breakdown.js';
import type { IssueSchemaService } from './issue-schema.js';
import type { Store } from './store.js';

const issueLimit = 10_000;
const pageSize = 50;

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new FieldBreakdownError(400, `${label}을(를) 확인해 주세요.`);
  }
  return value;
}

export function registerFieldBreakdownRoutes(app: Express, store: Store, schemas: IssueSchemaService) {
  function breakdown(projectId: string, body: Record<string,unknown>) {
    const schema = schemas.get(projectId);
    const fieldId = identifier(body.fieldId,'집계할 필드');
    const field = schema.fields.find(item => item.id === fieldId);
    if (!field) throw new FieldBreakdownError(404, '이 프로젝트에서 집계할 필드를 찾을 수 없습니다.');
    let view: SavedView | null = null;
    if (body.savedViewId != null) {
      const id = identifier(body.savedViewId,'저장된 보기');
      const selected = store.get<SavedView>('saved_views',id);
      if (!selected || selected.projectId !== projectId) {
        throw new FieldBreakdownError(404, '이 프로젝트에서 저장된 보기를 찾을 수 없습니다.');
      }
      view = selected;
    }
    const users = store.all<User>('users');
    const match = view ? createIssueViewMatcher(view.filters,{issueSchemas:[schema],users},schema) : undefined;
    const issues: Issue[] = [];
    for (const row of store.db.prepare('SELECT json FROM issues WHERE project_id=?').iterate(projectId)) {
      const issue = JSON.parse(String(row.json)) as Issue;
      if (match && !match(issue)) continue;
      if (issues.length === issueLimit) {
        throw new FieldBreakdownError(413, '한 번에 업무 10,000개까지 집계할 수 있습니다. 저장된 보기로 대상을 좁혀 주세요.');
      }
      issues.push(issue);
    }
    return buildIssueFieldBreakdown({
      projectId,field,issues,users,schemaVersion:schema.version,generatedAt:new Date().toISOString(),
      savedView:view ? {id:view.id,name:view.name,version:view.version} : null,
    });
  }

  const path = '/api/projects/:id/field-breakdown';
  app.post(path,(req,res)=>{
    const report = store.transaction(() => breakdown(req.params.id,req.body).report);
    res.json(report);
  });
  app.post(`${path}/issues`,(req,res)=>{
    const {revision} = req.body;
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
      throw new FieldBreakdownError(400, '조회한 집계의 버전이 필요합니다.');
    }
    const bucketId = identifier(req.body.bucketId,'집계 그룹');
    const offset = req.body.offset === undefined ? 0 : req.body.offset;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new FieldBreakdownError(400,'업무 목록의 시작 위치를 확인해 주세요.');
    }
    const page = store.transaction((): IssueFieldBreakdownPage => {
      const {report,issuesByBucket} = breakdown(req.params.id,req.body);
      if (report.revision !== revision) {
        throw new FieldBreakdownError(409,'집계 이후 업무·보기·속성이 변경되었습니다. 필드 집계를 다시 조회해 주세요.');
      }
      const bucket = report.groups.find(group => group.id === bucketId);
      if (!bucket) throw new FieldBreakdownError(404,'조회한 집계에서 그룹을 찾을 수 없습니다.');
      const issues = issuesByBucket.get(bucketId) ?? [];
      return {bucket,total:issues.length,offset,issues:issues.slice(offset,offset+pageSize)};
    });
    res.json(page);
  });
}
