'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import { ISSUE_FIELD_BREAKDOWN_DIMENSIONS } from '../../shared/types';
import type {
  CustomFieldKind,
  FeatureProps,
  IssueFieldBreakdown,
  IssueFieldBreakdownBucket,
  IssueFieldBreakdownComparison,
  IssueFieldBreakdownDimension,
  IssueFieldBreakdownIssue,
  IssueFieldBreakdownPage,
  SavedView,
} from '../../shared/types';
import { projectIssueSchema } from '../../shared/issue-schema';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import './field-breakdown.css';

type Query = { savedViewId: string | null; comparisonBy?: IssueFieldBreakdownDimension } & (
  | { fieldId: string; groupBy?: never }
  | { groupBy: IssueFieldBreakdownDimension; fieldId?: never }
);
const GROUP_PAGE_SIZE = 25;
const ISSUE_PAGE_SIZE = 50;
const COMPARISON_PAGE_SIZE = 10;
const DIMENSION_LABELS: Record<IssueFieldBreakdownDimension, string> = {
  status: '상태', priority: '우선순위', assignee: '담당자', type: '유형',
};
const KIND_LABELS: Record<CustomFieldKind, string> = {
  text: '텍스트',
  number: '숫자',
  date: '날짜',
  select: '단일 선택',
  multi_select: '여러 선택',
  checkbox: '체크박스',
  user: '사용자',
  url: 'URL',
};
const sameQuery = (a: Query, b: Query) => a.fieldId === b.fieldId && a.groupBy === b.groupBy &&
  a.comparisonBy === b.comparisonBy && a.savedViewId === b.savedViewId;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '필드 집계를 불러오지 못했습니다.';
const numberLabel = (value: number | null) =>
  value === null ? '집계값 없음' : value.toLocaleString('ko-KR', { maximumSignificantDigits: 12 });
const bucketKind = (bucket: IssueFieldBreakdownBucket) =>
  bucket.kind === 'missing' ? '값 없음' : bucket.kind === 'not_applicable' ? '유형에 미적용' : '값';

export function FieldBreakdownReport(props: FeatureProps) {
  return <ProjectFieldBreakdown key={`${props.projectId}:${props.actorId}`} {...props} />;
}

function ProjectFieldBreakdown(props: FeatureProps) {
  const { data, projectId, actorId } = props;
  const schema = projectIssueSchema(data, projectId);
  const firstFieldId = schema.fields.find((field) => !field.archived)?.id ?? schema.fields[0]?.id ?? '';
  const [query, setQuery] = useState<Query>(() => firstFieldId
    ? { fieldId: firstFieldId, savedViewId: null }
    : { groupBy: 'status', savedViewId: null });
  const [baseline, setBaseline] = useState<Query>(query);
  const [report, setReport] = useState<IssueFieldBreakdown | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [stale, setStale] = useState(false);
  const [page, setPage] = useState<IssueFieldBreakdownPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [groupsOffset, setGroupsOffset] = useState(0);
  const [reloadedViews, setReloadedViews] = useState<SavedView[] | null>(null);
  const [viewsLoading, setViewsLoading] = useState(false);
  const [viewsError, setViewsError] = useState('');
  const [openingIssue, setOpeningIssue] = useState<string | null>(null);
  const active = useRef(true);
  const dirtyRef = useRef(false);
  const queryRequest = useRef<AbortController | null>(null);
  const pageRequest = useRef<AbortController | null>(null);
  const viewsRequest = useRef<AbortController | null>(null);
  const openingRef = useRef(false);
  const drillHeading = useRef<HTMLHeadingElement>(null);
  const dirty = !sameQuery(query, baseline);
  const validProject = data.projects.some((project) => project.id === projectId);
  const views = (reloadedViews ?? data.savedViews ?? []).filter((view) => view.projectId === projectId);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const discard = useCallback(() => {
    setQuery({ ...baseline });
    setQueryError('');
    dirtyRef.current = false;
  }, [baseline]);
  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented || !dirtyRef.current) return;
      if (!window.confirm('조회하지 않은 필드 집계 조건을 버리고 이동할까요?')) event.preventDefault();
      else afterAcceptedNavigation(event, discard);
    };
    window.addEventListener('teamspace:navigate', guard);
    return () => window.removeEventListener('teamspace:navigate', guard);
  }, [discard]);

  const reloadViews = useCallback(async () => {
    viewsRequest.current?.abort();
    const controller = new AbortController();
    viewsRequest.current = controller;
    setViewsLoading(true);
    try {
      const result = await api<SavedView[]>(`/views?projectId=${encodeURIComponent(projectId)}`, {
        signal: controller.signal,
      });
      if (active.current && !controller.signal.aborted) {
        setReloadedViews(result);
        setViewsError('');
      }
    } catch (cause) {
      if (active.current && !controller.signal.aborted) setViewsError(errorMessage(cause));
    } finally {
      if (active.current && !controller.signal.aborted) setViewsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      queryRequest.current?.abort();
      pageRequest.current?.abort();
      viewsRequest.current?.abort();
    };
  }, []);

  const needsViews = data.savedViews === undefined;
  useEffect(() => {
    if (!validProject || !needsViews) return;
    const timer = setTimeout(() => void reloadViews(), 0);
    return () => clearTimeout(timer);
  }, [validProject, reloadViews, needsViews]);

  function update(next: Query) {
    setQuery(next);
    setQueryError('');
    dirtyRef.current = !sameQuery(next, baseline);
  }

  function choosePrimary(value: string) {
    const groupBy = ISSUE_FIELD_BREAKDOWN_DIMENSIONS.find(dimension => dimension === value);
    const { savedViewId, comparisonBy } = query;
    if (groupBy) update({ groupBy, savedViewId, comparisonBy: comparisonBy === groupBy ? undefined : comparisonBy });
    else if (value === 'custom' && firstFieldId) update({ fieldId: firstFieldId, savedViewId, comparisonBy });
  }

  async function requestReport(event: FormEvent) {
    event.preventDefault();
    if ((!query.fieldId && !query.groupBy) || !validProject) return;
    queryRequest.current?.abort();
    pageRequest.current?.abort();
    const controller = new AbortController();
    queryRequest.current = controller;
    setReportLoading(true);
    setPageLoading(false);
    setQueryError('');
    const submitted = { ...query };
    try {
      const result = await api<IssueFieldBreakdown>(
        `/projects/${encodeURIComponent(projectId)}/field-breakdown`,
        {
          method: 'POST',
          headers: { 'X-Actor-Id': actorId },
          signal: controller.signal,
          body: JSON.stringify(submitted),
        },
      );
      if (!active.current || controller.signal.aborted) return;
      setReport(result);
      setBaseline(submitted);
      dirtyRef.current = false;
      setPage(null);
      setPageError('');
      setGroupsOffset(0);
      setStale(false);
    } catch (cause) {
      if (active.current && !controller.signal.aborted) {
        if (cause instanceof ApiError && cause.status === 409) setStale(true);
        setQueryError(`${errorMessage(cause)} 입력과 이전 집계는 유지됩니다.`);
      }
    } finally {
      if (active.current && !controller.signal.aborted) setReportLoading(false);
    }
  }

  async function loadBucket(bucket: IssueFieldBreakdownBucket, offset: number, comparisonBucketId?: string, focusResult = false) {
    if (!report || stale || reportLoading || !bucket.count) return;
    pageRequest.current?.abort();
    const controller = new AbortController();
    pageRequest.current = controller;
    setPageLoading(true);
    setPageError('');
    try {
      const result = await api<IssueFieldBreakdownPage>(
        `/projects/${encodeURIComponent(projectId)}/field-breakdown/issues`,
        {
          method: 'POST',
          headers: { 'X-Actor-Id': actorId },
          signal: controller.signal,
          body: JSON.stringify({
            ...baseline,
            revision: report.revision,
            bucketId: bucket.id,
            offset,
            comparisonBucketId,
          }),
        },
      );
      if (active.current && !controller.signal.aborted) {
        setPage(result);
        if (focusResult) requestAnimationFrame(() => drillHeading.current?.focus());
      }
    } catch (cause) {
      if (active.current && !controller.signal.aborted) {
        if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404)) setStale(true);
        setPageError(`${errorMessage(cause)} 이전 집계와 업무 목록은 유지됩니다.`);
      }
    } finally {
      if (active.current && !controller.signal.aborted) setPageLoading(false);
    }
  }

  async function openRow(row: IssueFieldBreakdownIssue) {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpeningIssue(row.id);
    try {
      const cached = data.issues.find((issue) => issue.id === row.id);
      if (cached?.key !== row.key || cached.title !== row.title) await props.refresh();
      if (active.current) props.openIssue(row.id);
    } catch (cause) {
      if (active.current) props.notify(errorMessage(cause), 'error');
    } finally {
      openingRef.current = false;
      if (active.current) setOpeningIssue(null);
    }
  }

  if (!validProject)
    return (
      <section className="field-breakdown-feature">
        <h2>필드 집계</h2>
        <p>프로젝트를 선택하면 업무를 집계할 수 있습니다.</p>
      </section>
    );
  const groups = report?.comparison ? report.groups.filter(bucket => bucket.count > 0) : report?.groups ?? [];
  const start = Math.min(groupsOffset, Math.max(0, Math.floor((groups.length - 1) / GROUP_PAGE_SIZE) * GROUP_PAGE_SIZE));
  const selectedField = schema.fields.find((field) => field.id === query.fieldId);
  return (
    <section className="field-breakdown-feature" aria-label="업무 필드 집계">
      <form
        className="card field-breakdown-query"
        aria-label="필드 집계 조회 조건"
        onSubmit={requestReport}
      >
        <header>
          <h2>
            <BarChart3 size={19} />
            필드별 업무 현황
          </h2>
          <p>프로젝트 전체 업무나 저장된 보기의 업무를 한두 가지 기준으로 집계합니다.</p>
        </header>
        <fieldset disabled={reportLoading}>
          <div className="field-breakdown-query-grid">
            <label>
              집계 기준
              <select className="field" aria-label="집계 기준" value={query.groupBy ?? 'custom'}
                onChange={event => choosePrimary(event.currentTarget.value)}>
                {(firstFieldId || query.fieldId) && <option value="custom">사용자 정의 필드</option>}
                {ISSUE_FIELD_BREAKDOWN_DIMENSIONS.map(value => <option key={value} value={value}>{DIMENSION_LABELS[value]}</option>)}
              </select>
            </label>
            {!query.groupBy && <label>
              집계할 필드
              <select
                className="field"
                aria-label="집계할 사용자 정의 필드"
                value={query.fieldId}
                onChange={(event) => update({ fieldId: event.currentTarget.value, savedViewId: query.savedViewId, comparisonBy: query.comparisonBy })}
              >
                <option value="">필드 선택</option>
                {query.fieldId && !selectedField && (
                  <option value={query.fieldId}>{query.fieldId} · 현재 정의 없음</option>
                )}
                {schema.fields.map((field) => (
                  <option value={field.id} key={field.id}>
                    {field.name} · {KIND_LABELS[field.kind]}
                    {field.archived ? ' · 보관됨' : ''}
                  </option>
                ))}
              </select>
            </label>}
            <label>
              비교 기준
              <select className="field" aria-label="비교 기준" value={query.comparisonBy ?? ''}
                onChange={event => {
                  const value = event.currentTarget.value;
                  update({ ...query, comparisonBy: ISSUE_FIELD_BREAKDOWN_DIMENSIONS.find(dimension => dimension === value && dimension !== query.groupBy) });
                }}>
                <option value="">비교 안 함</option>
                {ISSUE_FIELD_BREAKDOWN_DIMENSIONS.filter(value => value !== query.groupBy)
                  .map(value => <option key={value} value={value}>{DIMENSION_LABELS[value]}</option>)}
              </select>
            </label>
            <label>
              조회 범위
              <select
                className="field"
                aria-label="필드 집계 저장된 보기"
                value={query.savedViewId ?? ''}
                onChange={(event) => update({ ...query, savedViewId: event.target.value || null })}
              >
                <option value="">프로젝트 전체 업무</option>
                {query.savedViewId && !views.some((view) => view.id === query.savedViewId) && (
                  <option value={query.savedViewId}>
                    {report?.savedView?.id === query.savedViewId
                      ? report.savedView.name
                      : query.savedViewId}{' '}
                    · 현재 목록 없음
                  </option>
                )}
                {views.map((view) => (
                  <option value={view.id} key={view.id}>
                    {view.name} · 버전 {view.version}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="field-breakdown-query-actions">
            <button
              className="btn btn-ghost"
              type="button"
              disabled={viewsLoading}
              onClick={() => void reloadViews()}
              aria-label="필드 집계 보기 목록 새로고침"
            >
              <RefreshCw size={15} />
              보기 목록 새로고침
            </button>
            <button className="btn btn-primary" type="submit" disabled={!query.fieldId && !query.groupBy}>
              <BarChart3 size={16} />
              {reportLoading ? '집계 중…' : '필드 집계 조회'}
            </button>
          </div>
        </fieldset>
        {dirty && report && (
          <p className="field-breakdown-info">
            조회 조건이 변경되었습니다. 아래에는 이전 조건의 집계가 표시됩니다.
          </p>
        )}
        {viewsError && (
          <p className="field-breakdown-error" role="alert">
            {viewsError} 기존 보기 선택은 유지됩니다.
          </p>
        )}
        {queryError && (
          <p className="field-breakdown-error" role="alert">
            {queryError}
          </p>
        )}
      </form>

      {report && (
        <div className="field-breakdown-result" aria-label="필드 집계 결과">
          <header className="field-breakdown-asof">
            <div>
              <h3>
                {report.field.name}{report.comparison && ` × ${DIMENSION_LABELS[report.comparison.by]}`}
                {report.field.archived && <span>보관된 필드</span>}
              </h3>
              <p>
                {!report.groupBy && `${KIND_LABELS[report.field.kind]} · `}
                {report.savedView
                  ? `${report.savedView.name} · 보기 버전 ${report.savedView.version}`
                  : '프로젝트 전체 업무'}
              </p>
            </div>
            <time dateTime={report.generatedAt}>
              {new Date(report.generatedAt).toLocaleString('ko-KR')} 기준
            </time>
          </header>
          {stale && (
            <p className="field-breakdown-stale" role="status">
              집계 이후 업무·보기·필드 설정이 변경되었습니다. 이전 결과를 표시하고 있습니다. 위의 ‘필드
              집계 조회’로 다시 조회해야 업무 목록을 열 수 있습니다.
            </p>
          )}
          <div className="field-breakdown-summary">
            <Metric label="조회 대상 업무" value={report.totalIssues} />
            {!report.groupBy && <>
              <Metric label="필드 적용 업무" value={report.applicableIssues} />
              <Metric label="값이 있는 업무" value={report.populatedIssues} />
              <Metric label="값이 없는 업무" value={report.missingIssues} />
              <Metric label="유형에 미적용" value={report.notApplicableIssues} />
            </>}
          </div>
          {report.numeric && (
            <section className="card field-breakdown-numeric" aria-label="숫자 필드 통계">
              <h3>입력된 숫자 통계</h3>
              <dl>
                <div>
                  <dt>최솟값</dt>
                  <dd>{numberLabel(report.numeric.min)}</dd>
                </div>
                <div>
                  <dt>최댓값</dt>
                  <dd>{numberLabel(report.numeric.max)}</dd>
                </div>
                <div>
                  <dt>평균</dt>
                  <dd>{numberLabel(report.numeric.average)}</dd>
                </div>
                <div>
                  <dt>합계</dt>
                  <dd>{numberLabel(report.numeric.sum)}</dd>
                </div>
              </dl>
            </section>
          )}
          <section className="card field-breakdown-groups" aria-label="필드 값별 분포">
            <header>
              <h3>{report.comparison ? '기준별 교차 집계' : '값별 업무 수'}</h3>
              <span>{groups.length.toLocaleString()}개 그룹</span>
            </header>
            {(!report.comparison || report.field.kind === 'multi_select') && <p>
              {!report.comparison && '막대는 조회 대상 전체 업무 대비 비율입니다.'}
              {report.field.kind === 'multi_select' &&
                ' 여러 선택 필드는 한 업무가 여러 값에 포함되므로 그룹 수량 합계가 전체 업무 수보다 클 수 있습니다.'}
            </p>}
            {report.comparison ? <FieldBreakdownMatrix key={`${report.revision}:${report.generatedAt}`}
              rowLabel={report.field.name} rows={groups.slice(start, start + GROUP_PAGE_SIZE)} comparison={report.comparison} total={report.totalIssues}
              page={page} disabled={stale || reportLoading || pageLoading}
              onOpen={(bucket, comparisonBucketId) => void loadBucket(bucket, 0, comparisonBucketId, true)} /> : <div className="field-breakdown-table-scroll">
              <table aria-label="필드 값별 집계 표">
                <thead>
                  <tr>
                    <th scope="col">값 또는 상태</th>
                    <th scope="col">업무 수</th>
                    <th scope="col">전체 대비</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.slice(start, start + GROUP_PAGE_SIZE).map((bucket) => {
                    const percent = report.totalIssues ? (bucket.count / report.totalIssues) * 100 : 0;
                    return (
                      <tr key={bucket.id} className={page?.bucket.id === bucket.id ? 'is-selected' : ''}>
                        <th scope="row">
                          <button
                            type="button"
                            className="field-breakdown-bucket"
                            aria-label={`그룹 ${bucket.label} 업무 보기`}
                            disabled={!bucket.count || stale || reportLoading || pageLoading}
                            onClick={() => void loadBucket(bucket, 0)}
                          >
                            <strong>{bucket.label}</strong>
                            <small>{bucketKind(bucket)}</small>
                          </button>
                        </th>
                        <td>{bucket.count.toLocaleString()}</td>
                        <td>
                          <div className="field-breakdown-bar" aria-hidden="true">
                            <span style={{ width: `${Math.min(100, percent)}%` }} />
                          </div>
                          <span className="field-breakdown-percent">
                            {percent.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>}
            {groups.length > GROUP_PAGE_SIZE && (
              <div className="field-breakdown-pagination">
                <span>
                  {start + 1}–{Math.min(start + GROUP_PAGE_SIZE, groups.length)} /{' '}
                  {groups.length}
                </span>
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={start === 0}
                  aria-label="필드 집계 그룹 이전 페이지"
                  onClick={() => setGroupsOffset(Math.max(0, start - GROUP_PAGE_SIZE))}
                >
                  이전
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={start + GROUP_PAGE_SIZE >= groups.length}
                  aria-label="필드 집계 그룹 다음 페이지"
                  onClick={() => setGroupsOffset(start + GROUP_PAGE_SIZE)}
                >
                  다음
                </button>
              </div>
            )}
          </section>
          {pageError && (
            <p className="field-breakdown-error" role="alert">
              {pageError}
            </p>
          )}
          {pageLoading && (
            <p className="field-breakdown-info" role="status">
              선택한 그룹의 업무를 불러오는 중…
            </p>
          )}
          {page ? (
            <section className="card field-breakdown-issues" aria-label="필드 집계 그룹 업무">
              <header>
                <h3 ref={drillHeading} tabIndex={-1}>{page.bucket.label}{page.comparisonBucket && ` × ${page.comparisonBucket.label}`}</h3>
                <span>업무 {page.total.toLocaleString()}개</span>
              </header>
              <ul>
                {page.issues.map((issue) => (
                  <li key={issue.id}>
                    <button
                      type="button"
                      className="field-breakdown-issue"
                      disabled={Boolean(openingIssue) || stale}
                      onClick={() => void openRow(issue)}
                    >
                      <strong>{issue.key}</strong>
                      <span>{issue.title}</span>
                      {openingIssue === issue.id && <small>업무를 여는 중…</small>}
                    </button>
                  </li>
                ))}
              </ul>
              {!page.issues.length && <p>이 페이지에 업무가 없습니다.</p>}
              <div className="field-breakdown-pagination">
                <span>
                  {page.total ? page.offset + 1 : 0}–
                  {Math.min(page.offset + ISSUE_PAGE_SIZE, page.total)} / {page.total}
                </span>
                <button
                  className="btn btn-ghost"
                  type="button"
                  aria-label="필드 집계 업무 이전 페이지"
                  disabled={stale || pageLoading || reportLoading || page.offset === 0}
                  onClick={() =>
                    void loadBucket(page.bucket, Math.max(0, page.offset - ISSUE_PAGE_SIZE), page.comparisonBucket?.id)
                  }
                >
                  이전
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  aria-label="필드 집계 업무 다음 페이지"
                  disabled={
                    stale || pageLoading || reportLoading || page.offset + ISSUE_PAGE_SIZE >= page.total
                  }
                  onClick={() => void loadBucket(page.bucket, page.offset + ISSUE_PAGE_SIZE, page.comparisonBucket?.id)}
                >
                  다음
                </button>
              </div>
            </section>
          ) : (
            !pageLoading && (
              <p className="field-breakdown-info">
                {report.comparison ? '교차표에서 업무 수를 누르면 해당 업무를 확인할 수 있습니다.' : '값별 업무 수에서 그룹을 선택하면 해당 업무를 확인할 수 있습니다.'}
              </p>
            )
          )}
          <details className="field-breakdown-revision">
            <summary>집계 기준 확인</summary>
            <code>{report.revision}</code>
          </details>
        </div>
      )}
      {!report && !reportLoading && (
        <div className="card field-breakdown-empty">
          <BarChart3 size={30} />
          <h3>업무 분포를 확인하세요</h3>
          <p>집계 기준과 조회 범위를 선택하고 집계를 조회하세요.</p>
        </div>
      )}
    </section>
  );
}

function FieldBreakdownMatrix({ rowLabel, rows, comparison, total, page, disabled, onOpen }: {
  rowLabel: string;
  rows: IssueFieldBreakdownBucket[];
  comparison: IssueFieldBreakdownComparison;
  total: number;
  page: IssueFieldBreakdownPage | null;
  disabled: boolean;
  onOpen: (bucket: IssueFieldBreakdownBucket, comparisonBucketId?: string) => void;
}) {
  const [offset, setOffset] = useState(0);
  const columnCount = comparison.columns.length;
  const columns = comparison.columns.slice(offset, offset + COMPARISON_PAGE_SIZE);
  return <>
    <div className="field-breakdown-table-scroll" role="region" aria-label="교차 집계 표 스크롤" tabIndex={0}>
      <table className="field-breakdown-matrix" aria-label="필드 교차 집계 표">
        <thead><tr>
          <th scope="col">{rowLabel}</th>
          <th scope="col">전체</th>
          {columns.map(column => <th scope="col" key={column.id}>{column.label}</th>)}
        </tr></thead>
        <tbody>{rows.map(bucket => <tr key={bucket.id}>
          <th scope="row">{bucket.label}</th>
          <td>{bucket.count ? <button type="button" className="field-breakdown-cell"
            aria-label={`그룹 ${bucket.label} 업무 보기`} aria-pressed={page?.bucket.id === bucket.id && !page.comparisonBucket}
            disabled={disabled} onClick={() => onOpen(bucket)}>{numberLabel(bucket.count)}</button> : 0}</td>
          {columns.map(column => {
            const count = comparison.counts[bucket.id]?.[column.id] ?? 0;
            const selected = page?.bucket.id === bucket.id && page.comparisonBucket?.id === column.id;
            return <td key={column.id}>{count ? <button type="button" className="field-breakdown-cell"
              aria-label={`${bucket.label} × ${column.label} 업무 보기 · ${numberLabel(count)}개`} aria-pressed={selected}
              disabled={disabled} onClick={() => onOpen(bucket, column.id)}>{numberLabel(count)}</button> : 0}</td>;
          })}
        </tr>)}</tbody>
        <tfoot><tr>
          <th scope="row">전체 조회 범위</th>
          <td>{numberLabel(total)}</td>
          {columns.map(column => <td key={column.id}>{numberLabel(column.count)}</td>)}
        </tr></tfoot>
      </table>
    </div>
    {!rows.length && <p className="field-breakdown-info">조건에 맞는 업무가 없습니다.</p>}
    {columnCount > COMPARISON_PAGE_SIZE && <div className="field-breakdown-pagination">
      <span aria-live="polite">비교 그룹 {offset + 1}–{Math.min(offset + COMPARISON_PAGE_SIZE, columnCount)} / {columnCount}</span>
      <button className="btn btn-ghost" type="button" aria-label="교차 집계 열 이전 페이지" disabled={offset === 0}
        onClick={() => setOffset(Math.max(0, offset - COMPARISON_PAGE_SIZE))}>이전 열</button>
      <button className="btn btn-ghost" type="button" aria-label="교차 집계 열 다음 페이지" disabled={offset + COMPARISON_PAGE_SIZE >= columnCount}
        onClick={() => setOffset(offset + COMPARISON_PAGE_SIZE)}>다음 열</button>
    </div>}
  </>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="card field-breakdown-metric" aria-label={label}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}
