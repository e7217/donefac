'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, BarChart3, Link2, ListChecks, RefreshCw } from 'lucide-react';
import { ISSUE_BULK_EDIT_LIMIT, ISSUE_FIELD_BREAKDOWN_DIMENSIONS, ISSUE_FIELD_BREAKDOWN_MEASURE_LABELS } from '../../shared/types';
import type {
  CustomFieldKind,
  FeatureProps,
  IssueBulkEditTarget,
  IssueFieldBreakdown,
  IssueFieldBreakdownBucket,
  IssueFieldBreakdownComparison,
  IssueFieldBreakdownDimension,
  IssueFieldBreakdownIssue,
  IssueFieldBreakdownMeasure,
  IssueFieldBreakdownMeasureResult,
  IssueFieldBreakdownMeasureTotal,
  IssueFieldBreakdownPage,
  IssueFieldBreakdownQuery,
  IssueFieldBreakdownSelection,
  SavedFieldBreakdown,
  SavedView,
} from '../../shared/types';
import { projectIssueSchema } from '../../shared/issue-schema';
import { projectStatuses } from '../../shared/workflow-helpers';
import { api, ApiError } from '../lib/api';
import {
  fieldBreakdownHash, fieldBreakdownMeasureParameter, readFieldBreakdownMeasure, sameFieldBreakdownScope, type FieldBreakdownScope,
} from '../lib/field-breakdown-route';
import { afterAcceptedNavigation, isReportPreservedByNavigation } from '../lib/navigation';
import { IssueBulkEdit, useIssueBulkEdit } from './IssueBulkEdit';
import { FieldBreakdownPresets } from './FieldBreakdownPresets';
import './field-breakdown.css';

type ComparisonQuery = { comparisonBy?: IssueFieldBreakdownDimension; comparisonFieldId?: never }
  | { comparisonBy?: never; comparisonFieldId: string };
type QueryScope = { savedViewId: string | null; measure?: IssueFieldBreakdownMeasure } & ComparisonQuery;
type ConfirmedQuery = QueryScope & (
  | { fieldId: string; groupBy?: never }
  | { groupBy: IssueFieldBreakdownDimension; fieldId?: never }
);
type Query = ConfirmedQuery | (QueryScope & { fieldId?: never; groupBy?: never });
type Props = FeatureProps & {
  linkedScope: FieldBreakdownScope | null;
  onPublishScope: (scope: FieldBreakdownScope) => boolean;
  onOpenScope: (scope: FieldBreakdownScope) => boolean;
  onOpenSavedIssueView?: (id: string) => void;
};
type CohortPosition = { bucketId: string; comparisonBucketId?: string; offset: number };
type CohortRefresh = { page: IssueFieldBreakdownPage; revision: string; selectedIds: ReadonlySet<string> };
const pagePosition = (page: IssueFieldBreakdownPage): CohortPosition => ({
  bucketId: page.bucket.id, comparisonBucketId: page.comparisonBucket?.id, offset: page.offset,
});
const GROUP_PAGE_SIZE = 25;
const ISSUE_PAGE_SIZE = 50;
const COMPARISON_PAGE_SIZE = 10;
const CUSTOM_COMPARISON_PREFIX = 'custom:';
const DIMENSION_LABELS: Record<IssueFieldBreakdownDimension, string> = {
  status: '상태', priority: '우선순위', assignee: '담당자', reporter: '요청자', type: '유형',
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
  a.comparisonBy === b.comparisonBy && a.comparisonFieldId === b.comparisonFieldId && a.savedViewId === b.savedViewId &&
  fieldBreakdownMeasureParameter(a.measure) === fieldBreakdownMeasureParameter(b.measure);
const comparisonQuery = (comparisonBy?: IssueFieldBreakdownDimension, comparisonFieldId?: string): ComparisonQuery =>
  comparisonFieldId ? { comparisonFieldId } : { comparisonBy };

function linkedSelection(scope: FieldBreakdownScope | null, firstFieldId: string): { query: Query; automatic: boolean } {
  const valid = scope?.invalid ? null : scope;
  const savedViewId = valid?.savedViewId ?? null;
  const filters = { savedViewId, measure: valid?.measure, ...comparisonQuery(valid?.comparisonBy, valid?.comparisonFieldId) };
  if (valid?.fieldId) return { query: { fieldId: valid.fieldId, ...filters }, automatic: true };
  if (valid?.groupBy) return { query: { groupBy: valid.groupBy, ...filters }, automatic: true };
  if (savedViewId || scope?.invalid) return { query: { savedViewId }, automatic: false };
  return { query: firstFieldId ? { fieldId: firstFieldId, savedViewId } : { groupBy: 'status', savedViewId }, automatic: false };
}

function scopeOf(query: Query): FieldBreakdownScope {
  return { fieldId: query.fieldId, groupBy: query.groupBy, savedViewId: query.savedViewId ?? undefined,
    comparisonBy: query.comparisonBy, comparisonFieldId: query.comparisonFieldId, measure: query.measure };
}

function reportQuery(report: IssueFieldBreakdown): ConfirmedQuery {
  const filters = { savedViewId: report.savedView?.id ?? null, ...(report.measure ? { measure: report.measure.source } : {}),
    ...comparisonQuery(report.comparison?.by, report.comparison?.field?.id) };
  return report.groupBy ? { groupBy: report.groupBy, ...filters } : { fieldId: report.field.id, ...filters };
}

function presetQuery(report: IssueFieldBreakdown): IssueFieldBreakdownQuery {
  const { savedViewId, ...query } = reportQuery(report);
  return { ...query, ...(savedViewId ? { savedViewId } : {}) };
}

function collectTargets(previous: readonly IssueBulkEditTarget[], current: readonly IssueBulkEditTarget[], selectedIds: ReadonlySet<string>) {
  const targets = new Map(previous.filter(target => selectedIds.has(target.id)).map(target => [target.id, target]));
  for (const target of current) targets.set(target.id, target);
  return [...targets.values()];
}
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '필드 집계를 불러오지 못했습니다.';
const numberLabel = (value: number | null) =>
  value === null ? '집계값 없음' : value.toLocaleString('ko-KR', { maximumSignificantDigits: 12 });
const measureTotalLabel = (total: IssueFieldBreakdownMeasureTotal | undefined) =>
  !total?.valueCount ? '값 없음' : total.sum === null ? '합계값 범위 초과' : numberLabel(total.sum);
const bucketKind = (bucket: IssueFieldBreakdownBucket) =>
  bucket.kind === 'missing' ? '값 없음' : bucket.kind === 'not_applicable' ? '유형에 미적용' : '값';

export function FieldBreakdownReport(props: Props) {
  return <ProjectFieldBreakdown key={`${props.projectId}:${props.actorId}`} {...props} />;
}

function ProjectFieldBreakdown(props: Props) {
  const { data, projectId, actorId, linkedScope, onPublishScope, onOpenScope, onOpenSavedIssueView } = props;
  const schema = projectIssueSchema(data, projectId);
  const firstFieldId = schema.fields.find((field) => !field.archived)?.id ?? schema.fields[0]?.id ?? '';
  const [origin, setOrigin] = useState(() => ({ scope: linkedScope, selection: linkedSelection(linkedScope, firstFieldId) }));
  const [echoScope, setEchoScope] = useState<FieldBreakdownScope | null>(null);
  const [query, setQuery] = useState<Query>(origin.selection.query);
  const [baseline, setBaseline] = useState<Query>(query);
  const [report, setReport] = useState<IssueFieldBreakdown | null>(null);
  const [reportLoading, setReportLoading] = useState(origin.selection.automatic);
  const [queryError, setQueryError] = useState('');
  const [stale, setStale] = useState(false);
  const [page, setPage] = useState<IssueFieldBreakdownPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [cohortNotice, setCohortNotice] = useState('');
  const [verifiedTargets, setVerifiedTargets] = useState<IssueBulkEditTarget[]>([]);
  const [groupsOffset, setGroupsOffset] = useState(0);
  const [reloadedViews, setReloadedViews] = useState<SavedView[] | null>(null);
  const [viewsLoading, setViewsLoading] = useState(false);
  const [viewsError, setViewsError] = useState('');
  const [openingIssue, setOpeningIssue] = useState<string | null>(null);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const active = useRef(true);
  const dirtyRef = useRef(false);
  const queryRequest = useRef<AbortController | null>(null);
  const pageRequest = useRef<AbortController | null>(null);
  const viewsRequest = useRef<AbortController | null>(null);
  const openingRef = useRef<symbol | null>(null);
  const copyAttempt = useRef<symbol | null>(null);
  const copyInput = useRef<HTMLInputElement>(null);
  const activeSelection = useRef(origin.selection);
  const publishScope = useRef(onPublishScope);
  const drillHeading = useRef<HTMLHeadingElement>(null);
  const focusDrillPage = useRef<IssueFieldBreakdownPage | null>(null);
  const reportHeading = useRef<HTMLHeadingElement>(null);
  const queryAlert = useRef<HTMLParagraphElement>(null);
  const focusPresetScope = useRef<FieldBreakdownScope | null>(null);
  const bulkToggle = useRef<HTMLButtonElement>(null);
  const bulkPanel = useRef<HTMLDivElement>(null);
  const dirty = !sameQuery(query, baseline);
  const validProject = data.projects.some((project) => project.id === projectId);
  const views = (reloadedViews ?? data.savedViews ?? []).filter((view) => view.projectId === projectId);
  const fieldBreakdown: IssueFieldBreakdownSelection | undefined = report && page?.editTargets ? {
    ...reportQuery(report), revision: report.revision,
    bucketId: page.bucket.id, comparisonBucketId: page.comparisonBucket?.id,
  } : undefined;
  const bulk = useIssueBulkEdit({ ...props, refresh: refreshBulkCohort }, verifiedTargets, { fieldBreakdown, pageTargets: page?.editTargets ?? [] });

  if (!sameFieldBreakdownScope(origin.scope, linkedScope)) {
    if (echoScope && sameFieldBreakdownScope(echoScope, linkedScope)) setOrigin({ ...origin, scope: linkedScope });
    else {
      const selection = linkedSelection(linkedScope, firstFieldId);
      setOrigin({ scope: linkedScope, selection });
      setQuery(selection.query);
      setBaseline(selection.query);
      setReport(null);
      setReportLoading(selection.automatic);
      setQueryError('');
      setStale(false);
      setPage(null);
      setPageLoading(false);
      setPageError('');
      setCohortNotice('');
      setVerifiedTargets([]);
      setGroupsOffset(0);
      setOpeningIssue(null);
      setCopyFallback(null);
    }
    setEchoScope(null);
  }

  useLayoutEffect(() => {
    activeSelection.current = origin.selection;
    queryRequest.current?.abort();
    pageRequest.current?.abort();
    openingRef.current = null;
    copyAttempt.current = null;
    focusDrillPage.current = null;
  }, [origin.selection]);
  useLayoutEffect(() => { publishScope.current = onPublishScope; }, [onPublishScope]);
  useLayoutEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useLayoutEffect(() => {
    if (!copyFallback) return;
    copyInput.current?.focus();
    copyInput.current?.select();
  }, [copyFallback]);
  useLayoutEffect(() => {
    if (!page || focusDrillPage.current !== page) return;
    focusDrillPage.current = null;
    drillHeading.current?.focus();
  }, [page]);
  const discard = useCallback(() => {
    if (activeSelection.current !== origin.selection) return;
    setQuery({ ...baseline });
    setQueryError('');
    dirtyRef.current = false;
  }, [baseline, origin.selection]);
  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented || !dirtyRef.current || isReportPreservedByNavigation(event)) return;
      if (!window.confirm('조회하지 않은 필드 집계 조건을 버리고 이동할까요?')) event.preventDefault();
      else afterAcceptedNavigation(event, discard);
    };
    window.addEventListener('donefac:navigate', guard);
    return () => window.removeEventListener('donefac:navigate', guard);
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
    const { savedViewId, comparisonBy, comparisonFieldId, measure } = query;
    if (groupBy) update({ groupBy, savedViewId, measure, ...comparisonQuery(comparisonBy === groupBy ? undefined : comparisonBy, comparisonFieldId) });
    else if (value === 'custom' && firstFieldId) chooseCustomField(firstFieldId);
  }

  function chooseCustomField(fieldId: string) {
    const { savedViewId, comparisonBy, comparisonFieldId, measure } = query;
    update({ fieldId, savedViewId, measure, ...comparisonQuery(comparisonBy, comparisonFieldId === fieldId ? undefined : comparisonFieldId) });
  }

  function chooseComparison(value: string) {
    const comparisonFieldId = value.startsWith(CUSTOM_COMPARISON_PREFIX) ? value.slice(CUSTOM_COMPARISON_PREFIX.length) : undefined;
    const comparisonBy = ISSUE_FIELD_BREAKDOWN_DIMENSIONS.find(dimension => dimension === value && dimension !== query.groupBy);
    update({ ...query, comparisonBy: undefined, comparisonFieldId: undefined,
      ...comparisonQuery(comparisonBy, comparisonFieldId === query.fieldId ? undefined : comparisonFieldId) });
  }

  const readBucket = useCallback((submitted: Query, revision: string, position: CohortPosition, signal: AbortSignal) =>
    api<IssueFieldBreakdownPage>(`/projects/${encodeURIComponent(projectId)}/field-breakdown/issues`, {
      method: 'POST', headers: { 'X-Actor-Id': actorId }, signal,
      body: JSON.stringify({ ...submitted, revision, ...position, ...(actorId ? { includeEditTargets: true } : {}) }),
    }), [actorId, projectId]);

  const loadReport = useCallback(async (submitted: Query, publish: boolean, cohort?: CohortRefresh) => {
    if ((!submitted.fieldId && !submitted.groupBy) || !validProject) return;
    queryRequest.current?.abort();
    pageRequest.current?.abort();
    const controller = new AbortController();
    queryRequest.current = controller;
    setReportLoading(true);
    setPageLoading(false);
    setQueryError('');
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
      const confirmed = reportQuery(result);
      if (!sameQuery(confirmed, submitted)) throw new Error('조회한 결과의 조건이 요청한 필드 집계 조건과 일치하지 않습니다.');

      let nextPage: IssueFieldBreakdownPage | null = null;
      if (cohort) {
        const position = pagePosition(cohort.page);
        const bucket = result.groups.find(item => item.id === position.bucketId);
        const count = position.comparisonBucketId
          ? result.comparison?.counts[position.bucketId]?.[position.comparisonBucketId] ?? 0
          : bucket?.count ?? 0;
        if (bucket && count > 0) {
          const offset = Math.min(position.offset, Math.floor((count - 1) / ISSUE_PAGE_SIZE) * ISSUE_PAGE_SIZE);
          nextPage = await readBucket(confirmed, result.revision, { ...position, offset }, controller.signal);
          if (!active.current || controller.signal.aborted) return;
        }
      }

      setReport(result);
      setBaseline(confirmed);
      if (!cohort) dirtyRef.current = false;
      copyAttempt.current = null;
      setCopyFallback(null);
      setPage(nextPage);
      setVerifiedTargets(previous => cohort?.revision === result.revision && nextPage
        ? collectTargets(previous, nextPage.editTargets ?? [], cohort.selectedIds)
        : nextPage?.editTargets ?? []);
      setCohortNotice(cohort && !nextPage ? '이 그룹에 남은 업무가 없습니다. 최신 집계를 표시합니다.' : '');
      setPageError('');
      if (!cohort || (result.comparison?.field && cohort.revision !== result.revision)) setGroupsOffset(0);
      setStale(false);
      if (publish) {
        const scope = scopeOf(confirmed);
        setEchoScope(scope);
        if (!publishScope.current(scope)) setEchoScope(null);
      }
      return { revision: result.revision, page: nextPage };
    } catch (cause) {
      if (active.current && !controller.signal.aborted) {
        const unavailable = cause instanceof ApiError && cause.status === 404;
        if (cohort || unavailable || cause instanceof ApiError && cause.status === 409) setStale(true);
        const message = `${errorMessage(cause)}${unavailable ? ' 조회 범위나 필드를 다시 선택해 주세요.' : ''}`;
        setQueryError(publish ? `${message} 입력과 이전 집계는 유지됩니다.` : message);
      }
    } finally {
      if (active.current && !controller.signal.aborted) setReportLoading(false);
    }
  }, [actorId, projectId, readBucket, validProject]);

  useEffect(() => {
    const { automatic, query: selected } = origin.selection;
    if (!automatic || !validProject) return;
    const timer = setTimeout(() => void loadReport(selected, false), 0);
    return () => clearTimeout(timer);
  }, [loadReport, origin.selection, validProject]);

  useEffect(() => {
    if (reportLoading || !focusPresetScope.current || !sameFieldBreakdownScope(linkedScope, focusPresetScope.current)) return;
    focusPresetScope.current = null;
    (queryError ? queryAlert.current : reportHeading.current)?.focus();
  }, [linkedScope, queryError, reportLoading]);

  function requestReport(event: FormEvent) {
    event.preventDefault();
    if (bulk.active && !bulk.close()) return;
    void loadReport(query, true);
  }

  function openPreset(preset: SavedFieldBreakdown) {
    const { savedViewId, comparisonBy, comparisonFieldId, ...primary } = preset.query;
    const submitted: ConfirmedQuery = { ...primary, savedViewId: savedViewId ?? null, ...comparisonQuery(comparisonBy, comparisonFieldId) };
    const scope = scopeOf(submitted);
    if (!sameFieldBreakdownScope(linkedScope, scope)) {
      if (onOpenScope(scope)) focusPresetScope.current = scope;
      return;
    }
    if (dirtyRef.current && !window.confirm('조회하지 않은 필드 집계 조건을 버리고 이동할까요?')) return;
    if (bulk.active && !bulk.close()) return;
    setQuery(submitted);
    setBaseline(submitted);
    dirtyRef.current = false;
    focusPresetScope.current = scope;
    void loadReport(submitted, false);
  }

  async function refreshBulkCohort(): Promise<void> {
    if (!report || !page) throw new Error('현재 집계에서 편집 대상을 찾을 수 없습니다.');
    await props.refresh();
    if (!active.current) return;
    const restored = await loadReport(baseline, false, { page, revision: report.revision, selectedIds: bulk.selectedIds });
    if (!restored) throw new Error('최신 업무 목록을 불러오지 못했습니다.');
    if (restored.revision !== report.revision || !restored.page) bulk.clearSelection();
  }

  async function loadBucket(bucket: IssueFieldBreakdownBucket, offset: number, comparisonBucketId?: string, focusResult = false) {
    if (!report || stale || reportLoading || bulk.locked || !bucket.count) return;
    const sameCohort = page?.bucket.id === bucket.id && page.comparisonBucket?.id === comparisonBucketId;
    if (!sameCohort && bulk.active && !bulk.close()) return;
    pageRequest.current?.abort();
    const controller = new AbortController();
    pageRequest.current = controller;
    setPageLoading(true);
    setPageError('');
    try {
      const result = await readBucket(baseline, report.revision, { bucketId: bucket.id, offset, comparisonBucketId }, controller.signal);
      if (active.current && !controller.signal.aborted) {
        if (focusResult) focusDrillPage.current = result;
        setPage(result);
        setCohortNotice('');
        setVerifiedTargets(previous => sameCohort ? collectTargets(previous, result.editTargets ?? [], bulk.selectedIds) : result.editTargets ?? []);
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

  function openBulk() {
    if (!fieldBreakdown || stale || pageLoading || reportLoading || !bulk.pageCount) return;
    bulk.open();
    requestAnimationFrame(() => bulkPanel.current?.querySelector('select')?.focus());
  }

  function closeBulk() {
    if (bulk.close()) requestAnimationFrame(() => bulkToggle.current?.focus({ preventScroll: true }));
  }

  async function openRow(row: IssueFieldBreakdownIssue) {
    if (openingRef.current) return;
    const token = Symbol();
    openingRef.current = token;
    setOpeningIssue(row.id);
    try {
      const cached = data.issues.find((issue) => issue.id === row.id);
      if (cached?.key !== row.key || cached.title !== row.title) await props.refresh();
      if (active.current && openingRef.current === token) props.openIssue(row.id);
    } catch (cause) {
      if (active.current && openingRef.current === token) props.notify(errorMessage(cause), 'error');
    } finally {
      if (openingRef.current === token) {
        openingRef.current = null;
        if (active.current) setOpeningIssue(null);
      }
    }
  }

  async function copyLink() {
    if (!report) return;
    const token = Symbol();
    copyAttempt.current = token;
    setCopyFallback(null);
    const url = new URL(fieldBreakdownHash(projectId, scopeOf(baseline)), window.location.href).href;
    try {
      await navigator.clipboard.writeText(url);
      if (active.current && copyAttempt.current === token) props.notify('필드 집계 링크를 복사했습니다.');
    } catch {
      if (active.current && copyAttempt.current === token) setCopyFallback(url);
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
  const selectedComparisonField = schema.fields.find(field => field.id === query.comparisonFieldId);
  const comparisonFields = schema.fields.filter(field => field.id !== query.fieldId);
  const measureFields = schema.fields.filter(field => field.kind === 'number');
  const selectedMeasureFieldId = query.measure?.kind === 'custom' ? query.measure.fieldId : undefined;
  const comparisonLabel = report?.comparison?.by ? DIMENSION_LABELS[report.comparison.by] : report?.comparison?.field?.name;
  const overlaps = report?.field.kind === 'multi_select' || report?.comparison?.field?.kind === 'multi_select';
  const drillBusy = pageLoading || reportLoading;
  const saveableQuery = report && !dirty && !drillBusy && !bulk.locked && !stale && !queryError ? presetQuery(report) : null;
  const describePresetQuery = (value: IssueFieldBreakdownQuery) => {
    const primary = value.groupBy ? DIMENSION_LABELS[value.groupBy]
      : schema.fields.find(field => field.id === value.fieldId)?.name ?? `${value.fieldId} · 현재 정의 없음`;
    const comparisonName = value.comparisonBy ? DIMENSION_LABELS[value.comparisonBy]
      : value.comparisonFieldId ? schema.fields.find(field => field.id === value.comparisonFieldId)?.name ??
        `${value.comparisonFieldId} · 현재 정의 없음` : undefined;
    const comparison = comparisonName ? ` × ${comparisonName}` : '';
    const view = value.savedViewId ? views.find(item => item.id === value.savedViewId)?.name ?? '저장된 보기 · 현재 목록 없음' : '프로젝트 전체 업무';
    const source = value.measure;
    const measure = source?.kind === 'custom'
      ? measureFields.find(field => field.id === source.fieldId)?.name ?? `${source.fieldId} · 현재 숫자 필드 없음`
      : source ? ISSUE_FIELD_BREAKDOWN_MEASURE_LABELS[source.kind] : undefined;
    return `${primary}${comparison} · ${view}${measure ? ` · ${measure} 합계` : ''}`;
  };
  const bulkEditor = {
    ...bulk,
    locked: bulk.locked || drillBusy,
    busy: bulk.busy || drillBusy,
    canPreview: bulk.canPreview && !stale,
    preview: stale && !bulk.applyUncertain ? undefined : bulk.preview,
    refreshRequired: bulk.refreshRequired || stale && !bulk.applyUncertain,
  };
  const editTargets = new Map(page?.editTargets?.map(target => [target.id, target]));
  const pageFullySelected = bulk.pageCount > 0 && bulk.pageSelectedCount === bulk.pageCount;
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
        <fieldset disabled={drillBusy || bulk.locked}>
          <div className="field-breakdown-query-grid">
            <label>
              집계 기준
              <select className="field" aria-label="집계 기준" value={query.groupBy ?? (query.fieldId === undefined ? '' : 'custom')}
                onChange={event => choosePrimary(event.currentTarget.value)}>
                <option value="" disabled>집계 기준 선택</option>
                {(firstFieldId || query.fieldId) && <option value="custom">사용자 정의 필드</option>}
                {ISSUE_FIELD_BREAKDOWN_DIMENSIONS.map(value => <option key={value} value={value}>{DIMENSION_LABELS[value]}</option>)}
              </select>
            </label>
            {query.fieldId !== undefined && <label>
              집계할 필드
              <select
                className="field"
                aria-label="집계할 사용자 정의 필드"
                value={query.fieldId}
                onChange={event => chooseCustomField(event.currentTarget.value)}
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
              <select className="field" aria-label="비교 기준"
                value={query.comparisonFieldId ? `${CUSTOM_COMPARISON_PREFIX}${query.comparisonFieldId}` : query.comparisonBy ?? ''}
                onChange={event => chooseComparison(event.currentTarget.value)}>
                <option value="">비교 안 함</option>
                {ISSUE_FIELD_BREAKDOWN_DIMENSIONS.filter(value => value !== query.groupBy)
                  .map(value => <option key={value} value={value}>{DIMENSION_LABELS[value]}</option>)}
                {query.comparisonFieldId && !selectedComparisonField && <option value={`${CUSTOM_COMPARISON_PREFIX}${query.comparisonFieldId}`}>
                  {query.comparisonFieldId} · 현재 정의 없음
                </option>}
                {comparisonFields.length > 0 && <optgroup label="사용자 정의 필드">
                  {comparisonFields.map(field => <option key={field.id} value={`${CUSTOM_COMPARISON_PREFIX}${field.id}`}>
                    {field.name} · {KIND_LABELS[field.kind]}{field.archived ? ' · 보관됨' : ''}
                  </option>)}
                </optgroup>}
              </select>
            </label>
            <label>
              합계 항목
              <select className="field" aria-label="합계 항목" value={fieldBreakdownMeasureParameter(query.measure) ?? ''}
                onChange={event => update({ ...query, measure: readFieldBreakdownMeasure(event.currentTarget.value) })}>
                <option value="">업무 수</option>
                {Object.entries(ISSUE_FIELD_BREAKDOWN_MEASURE_LABELS).map(([kind, label]) =>
                  <option key={kind} value={kind}>{label}</option>)}
                {selectedMeasureFieldId && !measureFields.some(field => field.id === selectedMeasureFieldId) &&
                  <option value={fieldBreakdownMeasureParameter(query.measure)}>{selectedMeasureFieldId} · 현재 숫자 필드 없음</option>}
                {measureFields.length > 0 && <optgroup label="사용자 정의 숫자 필드">
                  {measureFields.map(field => <option key={field.id}
                    value={fieldBreakdownMeasureParameter({ kind: 'custom', fieldId: field.id })}>
                    {field.name}{field.archived ? ' · 보관됨' : ''}
                  </option>)}
                </optgroup>}
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
        {linkedScope?.invalid && <p className="field-breakdown-error" role="alert">
          이 링크의 필드 집계 조건을 확인할 수 없습니다. 조건을 선택한 뒤 다시 조회해 주세요.
        </p>}
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
          <p ref={queryAlert} className="field-breakdown-error" role="alert" tabIndex={-1}>
            {queryError}
          </p>
        )}
      </form>

      <FieldBreakdownPresets projectId={projectId} actorId={actorId} currentQuery={saveableQuery}
        reportBusy={drillBusy || bulk.locked} describeQuery={describePresetQuery} onOpen={openPreset} notify={props.notify} />

      {report && (
        <div className="field-breakdown-result" aria-label="필드 집계 결과">
          <header className="field-breakdown-asof">
            <div>
              <h3 ref={reportHeading} tabIndex={-1}>
                {report.field.name}{comparisonLabel && ` × ${comparisonLabel}`}
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
          <div className="field-breakdown-link-actions">
            <button type="button" className="btn" onClick={() => void copyLink()}>
              <Link2 size={15} aria-hidden="true" />필드 집계 링크 복사
            </button>
            {report.savedView && onOpenSavedIssueView && <button type="button" className="btn"
              onClick={() => { if (report.savedView) onOpenSavedIssueView(report.savedView.id); }}>
              <ArrowUpRight size={15} aria-hidden="true" />저장한 업무 보기 열기
            </button>}
          </div>
          {copyFallback && <label className="field-breakdown-link-fallback">필드 집계 링크 주소
            <input ref={copyInput} className="field" readOnly value={copyFallback} onFocus={event => event.currentTarget.select()} />
          </label>}
          {stale && (
            <p className="field-breakdown-stale" role="status">
              집계 이후 업무·보기·필드 설정이 변경되었습니다. 이전 결과를 표시하고 있습니다. {bulk.active
                ? '일괄 편집의 ‘최신 업무 불러오기’로 현재 그룹을 갱신할 수 있습니다.'
                : '위의 ‘필드 집계 조회’로 다시 조회해야 업무 목록을 열 수 있습니다.'}
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
          {report.measure && <section className="card field-breakdown-numeric" aria-label="합계 항목 결과">
            <h3>{report.measure.label} 합계</h3>
            <dl>
              <div><dt>전체 합계</dt><dd>{measureTotalLabel(report.measure.total)}</dd></div>
              <div><dt>합계에 포함된 업무</dt><dd>{numberLabel(report.measure.total.valueCount)}개</dd></div>
              <div><dt>합계 값이 없는 업무</dt><dd>{numberLabel(report.totalIssues - report.measure.total.valueCount)}개</dd></div>
            </dl>
          </section>}
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
              <h3>{report.comparison ? '기준별 교차 집계' : report.measure ? '값별 업무 수와 합계' : '값별 업무 수'}</h3>
              <span>{groups.length.toLocaleString()}개 그룹</span>
            </header>
            {(!report.comparison || overlaps) && <p>
              {!report.comparison && '막대는 조회 대상 전체 업무 대비 비율입니다.'}
              {overlaps && ' 여러 선택 필드는 값을 선택한 만큼 행이나 열에 포함됩니다. 조회 대상 전체 업무 수에는 각 업무를 한 번만 셉니다.'}
              {overlaps && report.measure && ' 전체 합계에는 각 업무의 숫자 값을 한 번만 더합니다.'}
            </p>}
            {report.comparison ? <FieldBreakdownMatrix key={report.comparison.field ? report.revision : `${report.revision}:${report.generatedAt}`}
              rowLabel={report.field.name} rows={groups.slice(start, start + GROUP_PAGE_SIZE)} comparison={report.comparison} total={report.totalIssues}
              measure={report.measure} page={page} disabled={stale || drillBusy || bulk.locked}
              onOpen={(bucket, comparisonBucketId) => void loadBucket(bucket, 0, comparisonBucketId, true)} /> : <div className="field-breakdown-table-scroll"
              role={report.measure ? 'region' : undefined} aria-label={report.measure ? '필드 값별 집계 표 스크롤' : undefined}
              tabIndex={report.measure ? 0 : undefined}>
              <table className={report.measure ? 'field-breakdown-measured-groups' : undefined} aria-label="필드 값별 집계 표">
                <thead>
                  <tr>
                    <th scope="col">값 또는 상태</th>
                    <th scope="col">업무 수</th>
                    {report.measure && <th scope="col">합계</th>}
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
                            disabled={!bucket.count || stale || drillBusy || bulk.locked}
                            onClick={() => void loadBucket(bucket, 0)}
                          >
                            <strong>{bucket.label}</strong>
                            <small>{bucketKind(bucket)}</small>
                          </button>
                        </th>
                        <td>{bucket.count.toLocaleString()}</td>
                        {report.measure && <td>{measureTotalLabel(report.measure.rows[bucket.id])}</td>}
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
          {cohortNotice && <p className="field-breakdown-info" role="status">{cohortNotice}</p>}
          {page ? (
            <section className="card field-breakdown-issues" aria-label="필드 집계 그룹 업무">
              <header>
                <h3 ref={drillHeading} tabIndex={-1}>{page.bucket.label}{page.comparisonBucket && ` × ${page.comparisonBucket.label}`}</h3>
                <span>업무 {page.total.toLocaleString()}개</span>
              </header>
              {fieldBreakdown && !bulk.active && <button type="button" ref={bulkToggle} className="btn field-breakdown-bulk-open"
                disabled={stale || drillBusy || !bulk.pageCount} onClick={openBulk}>
                <ListChecks size={16} aria-hidden="true" />집계 업무 일괄 편집
              </button>}
              {bulk.active && <>
                <div className="field-breakdown-bulk" ref={bulkPanel}>
                  <IssueBulkEdit editor={bulkEditor} statuses={projectStatuses(data, projectId)} users={data.users} onClose={closeBulk} />
                </div>
                <label className="field-breakdown-page-selection">
                  <input type="checkbox" checked={pageFullySelected} disabled={!bulk.canTogglePage || drillBusy || stale}
                    ref={element => { if (element) element.indeterminate = bulk.pageSelectedCount > 0 && !pageFullySelected; }}
                    onChange={bulk.togglePage} />
                  <span>이 페이지의 업무 전체 선택</span>
                </label>
              </>}
              <ul>
                {page.issues.map((issue) => {
                  const target = editTargets.get(issue.id);
                  const selected = bulk.selectedIds.has(issue.id);
                  return <li key={issue.id} className={bulk.active ? 'field-breakdown-selectable-issue' : undefined}>
                    {bulk.active && <label className="field-breakdown-issue-selection"><input type="checkbox"
                      aria-label={`${issue.key} 선택`} checked={selected}
                      disabled={!target || stale || drillBusy || bulk.locked || !selected && bulk.selectedCount >= ISSUE_BULK_EDIT_LIMIT}
                      onChange={() => { if (target) bulk.toggle(target); }} /></label>}
                    <button
                      type="button"
                      className="field-breakdown-issue"
                      disabled={Boolean(openingIssue) || stale || bulk.busy}
                      onClick={() => void openRow(issue)}
                    >
                      <strong>{issue.key}</strong>
                      <span>{issue.title}</span>
                      {report.measure && <small>{report.measure.label} · {issue.measureValue == null ? '값 없음' : numberLabel(issue.measureValue)}</small>}
                      {openingIssue === issue.id && <small>업무를 여는 중…</small>}
                    </button>
                  </li>;
                })}
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
                  disabled={stale || drillBusy || bulk.locked || page.offset === 0}
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
                    stale || drillBusy || bulk.locked || page.offset + ISSUE_PAGE_SIZE >= page.total
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

function FieldBreakdownMatrix({ rowLabel, rows, comparison, total, measure, page, disabled, onOpen }: {
  rowLabel: string;
  rows: IssueFieldBreakdownBucket[];
  comparison: IssueFieldBreakdownComparison;
  total: number;
  measure?: IssueFieldBreakdownMeasureResult;
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
          <td>
            {bucket.count ? <button type="button" className="field-breakdown-cell"
              aria-label={`그룹 ${bucket.label} 업무 보기`} aria-pressed={page?.bucket.id === bucket.id && !page.comparisonBucket}
              disabled={disabled} onClick={() => onOpen(bucket)}>{numberLabel(bucket.count)}</button> : 0}
            {measure && <MeasureCell total={measure.rows[bucket.id]} />}
          </td>
          {columns.map(column => {
            const count = comparison.counts[bucket.id]?.[column.id] ?? 0;
            const selected = page?.bucket.id === bucket.id && page.comparisonBucket?.id === column.id;
            return <td key={column.id}>
              {count ? <button type="button" className="field-breakdown-cell"
                aria-label={`${bucket.label} × ${column.label} 업무 보기 · ${numberLabel(count)}개`} aria-pressed={selected}
                disabled={disabled} onClick={() => onOpen(bucket, column.id)}>{numberLabel(count)}</button> : 0}
              {measure && count > 0 && <MeasureCell total={measure.cells?.[bucket.id]?.[column.id]} />}
            </td>;
          })}
        </tr>)}</tbody>
        <tfoot><tr>
          <th scope="row">전체 조회 범위</th>
          <td>{numberLabel(total)}{measure && <MeasureCell total={measure.total} />}</td>
          {columns.map(column => <td key={column.id}>
            {numberLabel(column.count)}{measure && <MeasureCell total={measure.columns?.[column.id]} />}
          </td>)}
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

function MeasureCell({ total }: { total: IssueFieldBreakdownMeasureTotal | undefined }) {
  return <small className="field-breakdown-measure-cell">합계 {measureTotalLabel(total)}</small>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="card field-breakdown-metric" aria-label={label}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}
