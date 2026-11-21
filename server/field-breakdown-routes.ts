import type { Express } from 'express';
import { ISSUE_FIELD_BREAKDOWN_DIMENSIONS, PRIORITY, type CustomFieldDefinition, type GitlabLink,
  type Issue, type IssueFieldBreakdownDimension, type IssueFieldBreakdownPage, type IssueFieldBreakdownSelection,
  type ProjectIssueSchema, type ProjectWorkflow, type SavedView, type User } from '../shared/types.js';
import { IssueFieldFilterError } from '../shared/issue-field-filter.js';
import { createIssueViewMatcher } from '../shared/issue-view.js';
import { buildIssueFieldBreakdown, FieldBreakdownError } from './field-breakdown.js';
import { IssueSchemaError, type IssueSchemaService } from './issue-schema.js';
import type { Store } from './store.js';

const issueLimit = 10_000;
const pageSize = 50;
const selectionFields = new Set(['fieldId', 'groupBy', 'savedViewId', 'comparisonBy', 'revision', 'bucketId', 'comparisonBucketId']);
type BreakdownQuery = Pick<IssueFieldBreakdownSelection, 'savedViewId' | 'comparisonBy'> &
  ({ fieldId: string; groupBy?: never } | { groupBy: IssueFieldBreakdownDimension; fieldId?: never });

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new FieldBreakdownError(400, `${label}을(를) 확인해 주세요.`);
  }
  return value;
}

const groupingNames = { status: '상태', priority: '우선순위', assignee: '담당자', type: '업무 유형' } satisfies Record<IssueFieldBreakdownDimension, string>;

function dimension(value: unknown): IssueFieldBreakdownDimension {
  if (typeof value !== 'string' || !(ISSUE_FIELD_BREAKDOWN_DIMENSIONS as readonly string[]).includes(value)) {
    throw new FieldBreakdownError(400, '지원하는 기본 집계 기준을 선택해 주세요.');
  }
  return value as IssueFieldBreakdownDimension;
}

function breakdownQuery(body: Record<string, unknown>): BreakdownQuery {
  if (Object.hasOwn(body, 'fieldId') === Object.hasOwn(body, 'groupBy')) {
    throw new FieldBreakdownError(400, '사용자 정의 필드 또는 기본 필드 중 하나를 선택해 주세요.');
  }
  const groupBy = Object.hasOwn(body, 'groupBy') ? dimension(body.groupBy) : undefined;
  const comparisonBy = body.comparisonBy == null ? undefined : dimension(body.comparisonBy);
  if (comparisonBy && groupBy === comparisonBy) throw new FieldBreakdownError(400, '행과 열에 서로 다른 기준을 선택해 주세요.');
  const savedViewId = body.savedViewId == null ? undefined : identifier(body.savedViewId, '저장된 보기');
  return { ...(groupBy ? { groupBy } : { fieldId: identifier(body.fieldId, '집계할 필드') }), comparisonBy, savedViewId };
}

function breakdownGroup(body: Record<string, unknown>) {
  const { revision } = body;
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
    throw new FieldBreakdownError(400, '조회한 집계의 버전이 필요합니다.');
  }
  const bucketId = identifier(body.bucketId, '집계 그룹');
  const comparisonBucketId = body.comparisonBucketId == null ? undefined : identifier(body.comparisonBucketId, '비교 그룹');
  return { revision, bucketId, comparisonBucketId };
}

export function parseFieldBreakdownSelection(raw: unknown): IssueFieldBreakdownSelection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !selectionFields.has(key))) {
    throw new FieldBreakdownError(400, '일괄 편집의 필드 집계 조건을 확인해 주세요.');
  }
  const body = raw as Record<string, unknown>;
  const group = breakdownGroup(body);
  const query = breakdownQuery(body);
  if (group.comparisonBucketId && !query.comparisonBy) {
    throw new FieldBreakdownError(400, '교차 집계 기준과 비교 그룹을 확인해 주세요.');
  }
  return { ...query, ...group };
}

function builtinField(by: IssueFieldBreakdownDimension, schema: ProjectIssueSchema, workflow: ProjectWorkflow | undefined): CustomFieldDefinition {
  const options: CustomFieldDefinition['options'] = by === 'status' ? workflow!.statuses.map(status => ({ id: status.id, name: status.label, archived: false }))
    : by === 'priority' ? Object.entries(PRIORITY).map(([id, name]) => ({ id, name, archived: false }))
    : by === 'type' ? schema.issueTypes.map(({ id, name, archived }) => ({ id, name, archived })) : [];
  return { id: `builtin:${by}`, name: groupingNames[by], kind: by === 'assignee' ? 'user' : 'select', archived: false,
    required: false, description: '', issueTypes: [], options };
}

export function registerFieldBreakdownRoutes(app: Express, store: Store, schemas: IssueSchemaService,
  lookupWorkflow: (projectId: string) => ProjectWorkflow) {
  function breakdown(projectId: string, body: Record<string,unknown>) {
    const schema = schemas.get(projectId);
    const { groupBy, comparisonBy, fieldId, savedViewId } = breakdownQuery(body);
    const workflow = groupBy === 'status' || comparisonBy === 'status' ? lookupWorkflow(projectId) : undefined;
    const field = groupBy ? builtinField(groupBy, schema, workflow) : schema.fields.find(item => item.id === fieldId);
    if (!field) throw new FieldBreakdownError(404, '이 프로젝트에서 집계할 필드를 찾을 수 없습니다.');
    let view: SavedView | null = null;
    if (savedViewId) {
      const selected = store.get<SavedView>('saved_views', savedViewId);
      if (!selected || selected.projectId !== projectId) {
        throw new FieldBreakdownError(404, '이 프로젝트에서 저장된 보기를 찾을 수 없습니다.');
      }
      view = selected;
    }
    const users = store.all<User>('users');
    const gitlabLinks = view?.filters.gitlab
      ? store.db.prepare(`SELECT link.json FROM gitlab_links AS link
          JOIN issues AS issue ON issue.id = link.issue_id WHERE issue.project_id = ?`)
        .all(projectId).map(row => JSON.parse(String(row.json)) as GitlabLink)
      : [];
    const match = view ? createIssueViewMatcher(view.filters,{issueSchemas:[schema],users,gitlabLinks},schema) : undefined;
    const issues: Issue[] = [];
    for (const row of store.db.prepare('SELECT json FROM issues WHERE project_id=?').iterate(projectId)) {
      const issue = JSON.parse(String(row.json)) as Issue;
      if (match && !match(issue)) continue;
      if (issues.length === issueLimit) {
        throw new FieldBreakdownError(413, '한 번에 업무 10,000개까지 집계할 수 있습니다. 저장된 보기로 대상을 좁혀 주세요.');
      }
      issues.push(issue);
    }
    const result = buildIssueFieldBreakdown({
      projectId,field,issues,users,schemaVersion:schema.version,generatedAt:new Date().toISOString(),
      savedView:view ? {id:view.id,name:view.name,version:view.version} : null,
      groupBy,
      ...(comparisonBy ? { comparison: { by: comparisonBy, field: builtinField(comparisonBy, schema, workflow) } } : {}),
      ...(groupBy || comparisonBy ? { configuration: { workflowVersion: workflow?.version, importGeneration: store.setting('attachmentImportGeneration') } } : {}),
    });
    return { ...result, matchedIssues: issues };
  }

  function cohort(projectId: string, body: Record<string, unknown>,
    { revision, bucketId, comparisonBucketId }: Pick<IssueFieldBreakdownSelection, 'revision' | 'bucketId' | 'comparisonBucketId'>) {
    const { report, issuesByBucket, columnByIssue, matchedIssues } = breakdown(projectId, body);
    if (report.revision !== revision) {
      throw new FieldBreakdownError(409, '집계 이후 업무·보기·속성이 변경되었습니다. 필드 집계를 다시 조회해 주세요.');
    }
    const bucket = report.groups.find(group => group.id === bucketId);
    if (!bucket) throw new FieldBreakdownError(404, '조회한 집계에서 그룹을 찾을 수 없습니다.');
    const comparisonBucket = comparisonBucketId ? report.comparison?.columns.find(column => column.id === comparisonBucketId) : undefined;
    if (comparisonBucketId && !comparisonBucket) throw new FieldBreakdownError(404, '조회한 집계에서 비교 그룹을 찾을 수 없습니다.');
    const rowIssues = issuesByBucket.get(bucketId) ?? [];
    const issues = comparisonBucketId ? rowIssues.filter(issue => columnByIssue.get(issue.id) === comparisonBucketId) : rowIssues;
    return { bucket, comparisonBucket, issues, matchedIssues };
  }

  const path = '/api/projects/:id/field-breakdown';
  app.post(path,(req,res)=>{
    const report = store.transaction(() => breakdown(req.params.id,req.body).report);
    res.json(report);
  });
  app.post(`${path}/issues`,(req,res)=>{
    const group = breakdownGroup(req.body);
    const offset = req.body.offset === undefined ? 0 : req.body.offset;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new FieldBreakdownError(400,'업무 목록의 시작 위치를 확인해 주세요.');
    }
    const { includeEditTargets } = req.body;
    if (includeEditTargets !== undefined && typeof includeEditTargets !== 'boolean') {
      throw new FieldBreakdownError(400, '일괄 편집 대상 정보를 포함할지 확인해 주세요.');
    }
    const page = store.transaction((): IssueFieldBreakdownPage => {
      const { bucket, comparisonBucket, issues, matchedIssues } = cohort(req.params.id, req.body, group);
      const visible = issues.slice(offset, offset + pageSize);
      const result = { bucket, ...(comparisonBucket ? { comparisonBucket } : {}), total: issues.length, offset, issues: visible };
      if (!includeEditTargets) return result;
      const issuesById = new Map(matchedIssues.map(issue => [issue.id, issue]));
      return { ...result, editTargets: visible.map(({ id }) => {
        const { version, labels } = issuesById.get(id)!;
        return { id, version, labels };
      }) };
    });
    res.json(page);
  });

  return (projectId: string, selection: IssueFieldBreakdownSelection, selectedIds: readonly string[]): boolean => {
    try {
      const { issues } = cohort(projectId, { ...selection }, selection);
      const memberIds = new Set(issues.map(issue => issue.id));
      return selectedIds.every(id => memberIds.has(id));
    } catch (error) {
      if (error instanceof FieldBreakdownError || error instanceof IssueSchemaError || error instanceof IssueFieldFilterError) {
        if (error.status >= 400 && error.status < 500) return false;
      }
      throw error;
    }
  };
}
