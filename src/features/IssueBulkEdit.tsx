'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ListChecks, Plus, X } from 'lucide-react';
import { isCalendarDate } from '../../shared/calendar';
import { fieldValueLabel, hasCustomValue, projectIssueSchema } from '../../shared/issue-schema';
import { PLANNING_STATUS_META, planningAssignmentBlock, planningFields, planningMeta, projectPlanningItems } from '../../shared/planning-helpers';
import { projectWorkflow } from '../../shared/workflow-helpers';
import { issueSearchAliasLabel, searchIssueCandidates, WORKSPACE_SEARCH_QUERY_LIMIT } from '../../shared/workspace-search';
import {
  ISSUE_BULK_EDIT_LIMIT, ISSUE_BULK_LABEL_LIMIT, ISSUE_BULK_LABEL_MAX_LENGTH, PRIORITY, type CustomFieldDefinition, type CustomFieldValue, type FeatureProps, type Issue, type IssueBulkEditChanges, type IssueBulkEditPreview,
  type IssueBulkEditPreviewInput, type IssueBulkEditResult, type IssueBulkEditRow, type IssueBulkEditTarget, type IssueBulkEditValues, type IssueFieldBreakdownSelection,
  type PlanningItem, type PlanningKind, type Priority, type TeamIssueBulkEditPreviewInput, type WorkflowStatus,
} from '../../shared/types';
import { ApiError, api } from '../lib/api';
import { afterAcceptedNavigation, isReportPreservedByNavigation, isTeamBoardPreservedByNavigation } from '../lib/navigation';
import { CustomFieldInput } from './CustomFields';
import { errorMessage } from './schedule-utils';
import './issue-bulk-edit.css';

type BasicChanges = Pick<IssueBulkEditChanges, 'status' | 'priority' | 'assigneeId'>;
type DueDateMode = 'keep' | 'set' | 'clear';
type ParentMode = 'keep' | 'set' | 'clear';
type ParentIssue = Pick<Issue, 'id' | 'key' | 'title'>;
type PlanningChoice = Pick<PlanningItem, 'id' | 'name'>;
type PlanningDrafts = Partial<Record<PlanningKind, PlanningChoice | null>>;
type CustomFieldMode = 'set' | 'clear';
type CustomFieldDraft = Pick<CustomFieldDefinition, 'id' | 'name' | 'kind'> & { mode: CustomFieldMode; value: CustomFieldValue };

interface EditFields {
  changes: BasicChanges;
  teamStatuses: Record<string, string>;
  dueDateMode: DueDateMode;
  dueDate: string;
  parentMode: ParentMode;
  parentSelection: ParentIssue | null;
  planningDrafts: PlanningDrafts;
  addLabelsText: string;
  removeLabels: string[];
  customFieldDrafts: CustomFieldDraft[];
}

interface EditSession extends EditFields {
  scope: string;
  ids: Set<string>;
  preview: { result: IssueBulkEditPreview; input: string } | null;
  error: string;
  refreshRequired: boolean;
  applyUncertain: boolean;
}

const emptyFields: EditFields = { changes: {}, teamStatuses: {}, dueDateMode: 'keep', dueDate: '', parentMode: 'keep', parentSelection: null,
  planningDrafts: {}, addLabelsText: '', removeLabels: [], customFieldDrafts: [] };
const planningKinds = ['cycle', 'module', 'release'] as const;
const planningOptionPrefix = 'plan:';
const parentPageSize = 20;
const compareParentKeys = new Intl.Collator('ko', { numeric: true }).compare;
const parentIssueLabel = ({ key, title }: ParentIssue) => `${key} · ${title}`;
const uncertainApplyStatuses = new Set([408, 425, 429, 499]);

function initialSession(scope: string): EditSession {
  return { ...emptyFields, scope, ids: new Set(), preview: null, error: '', refreshRequired: false, applyUncertain: false };
}

function discardPrompt(uncertain: boolean) {
  return uncertain ? '적용 결과를 확인하지 않은 채 일괄 편집을 닫을까요?' : '작성 중인 일괄 편집을 버릴까요?';
}

type ReportSelection = {
  fieldBreakdown?: IssueFieldBreakdownSelection;
  pageTargets: readonly IssueBulkEditTarget[];
};
type BulkTarget = IssueBulkEditTarget & { projectId?: string };

function customFieldError(draft: CustomFieldDraft, field: CustomFieldDefinition | undefined, users: FeatureProps['data']['users']): string {
  if (!field || field.archived || field.kind !== draft.kind) return '필드 설정이 변경되었습니다. 이 변경을 제외한 뒤 필요한 필드를 다시 추가해 주세요.';
  if (draft.mode === 'clear') return '';
  const { value } = draft;
  if (!hasCustomValue(value)) return '값을 지정하거나 변경 방식을 ‘값 지우기’로 선택해 주세요.';
  if (field.kind === 'select' || field.kind === 'multi_select') {
    const optionIds = Array.isArray(value) ? value : [value];
    if (optionIds.some(id => !field.options.some(option => option.id === id && !option.archived))) return '사용할 수 있는 선택지를 지정해 주세요.';
  }
  if (field.kind === 'user' && !users.some(user => user.id === value)) return '현재 팀원을 선택해 주세요.';
  if (field.kind === 'date' && !isCalendarDate(value)) return '유효한 날짜를 지정해 주세요.';
  if (field.kind === 'url' && typeof value === 'string') {
    try {
      const url = new URL(value.trim());
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return '';
    } catch { /* Invalid URL text is kept for correction. */ }
    return '인증 정보가 없는 http(s) URL을 입력해 주세요.';
  }
  return '';
}

export function useIssueBulkEdit({ data, projectId, actorId, refresh, notify }: Pick<FeatureProps, 'data' | 'projectId' | 'actorId' | 'refresh' | 'notify'>,
  visible: readonly BulkTarget[], report?: ReportSelection,
  options?: { team: true }) {
  const team = Boolean(options?.team);
  const selection = report?.fieldBreakdown;
  const scope = JSON.stringify([team ? 'team' : projectId, actorId, report ? [selection?.fieldId, selection?.groupBy, selection?.savedViewId,
    selection?.comparisonBy, selection?.comparisonFieldId, selection?.measure, selection?.bucketId, selection?.comparisonBucketId] : null]);
  const [session, setSession] = useState<EditSession | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const active = session?.scope === scope;
  const selected = active ? visible.filter(issue => session.ids.has(issue.id)) : [];
  const fields = active ? session : emptyFields;
  const { dueDateMode, dueDate, parentMode, parentSelection, planningDrafts, addLabelsText, removeLabels, customFieldDrafts } = fields;
  const selectingParent = active && !team && parentMode === 'set';
  const parentCandidates = useMemo(() => selectingParent
    ? data.issues.filter(issue => issue.projectId === projectId).sort((first, second) => compareParentKeys(first.key, second.key))
    : [], [data.issues, projectId, selectingParent]);
  const currentParent = parentSelection ? parentCandidates.find(issue => issue.id === parentSelection.id) : undefined;
  let parentError = '';
  if (selectingParent && parentSelection) {
    if (!currentParent) parentError = '선택한 상위 업무가 현재 프로젝트에 없습니다. 다른 업무를 선택해 주세요.';
    else if (session.ids.has(currentParent.id)) parentError = '일괄 변경할 업무는 상위 업무로 지정할 수 없습니다.';
  }
  const validParent = !selectingParent || Boolean(currentParent && !parentError);
  const { planningItems } = data;
  const planningOptions = useMemo(() => new Map(planningKinds.map(kind => [kind, active && !team
    ? projectPlanningItems({ planningItems }, projectId, kind).filter(item => !planningAssignmentBlock(item)) : []])), [active, planningItems, projectId, team]);
  const planningChanges: Pick<IssueBulkEditChanges, 'cycleId' | 'moduleId' | 'releaseId'> = {};
  const planningErrors = new Map<PlanningKind, string>();
  if (!team) for (const kind of planningKinds) {
    const choice = planningDrafts[kind];
    if (choice === undefined) continue;
    if (choice && !planningOptions.get(kind)?.some(item => item.id === choice.id)) {
      const item = planningItems?.find(item => item.id === choice.id && item.projectId === projectId && item.kind === kind);
      const block = item ? planningAssignmentBlock(item) : null;
      planningErrors.set(kind, block ? `${block === 'archived' ? '보관된' : '완료된'} ${planningMeta(kind).label}에는 연결할 수 없습니다. 다른 계획을 선택해 주세요.`
        : '현재 프로젝트에서 이 계획을 찾을 수 없습니다. 다른 계획을 선택해 주세요.');
      continue;
    }
    planningChanges[planningFields(kind).idField] = choice?.id ?? null;
  }
  const chosenProjectIds = new Set(team ? selected.map(issue => issue.projectId) : []);
  const teamProjects = team ? data.projects.filter(project => chosenProjectIds.has(project.id)) : [];
  const teamWorkflows = teamProjects.map(project => projectWorkflow(data, project.id));
  const teamProjectStatuses = new Map(teamWorkflows.map(({ projectId, statuses }) => [projectId, statuses]));
  const teamStatusEntries = Object.entries(fields.teamStatuses).filter(([id]) => teamProjectStatuses.has(id));
  const teamStatuses = Object.fromEntries(teamStatusEntries);
  const workflowVersions = Object.fromEntries(teamWorkflows.filter(({ projectId }) => Object.hasOwn(teamStatuses, projectId))
    .map(({ projectId, version }) => [projectId, version]));
  const customFieldDefinitions = team ? [] : projectIssueSchema(data, projectId).fields;
  const customFieldsById = new Map(customFieldDefinitions.map(field => [field.id, field]));
  const customFieldErrors = new Map<string, string>();
  for (const draft of customFieldDrafts) {
    const error = customFieldError(draft, customFieldsById.get(draft.id), data.users);
    if (error) customFieldErrors.set(draft.id, error);
  }
  const addLabels = [...new Set(addLabelsText.split(',').map(label => label.trim()).filter(Boolean))];
  const validDueDate = dueDateMode !== 'set' || isCalendarDate(dueDate);
  const { status, ...basicChanges } = fields.changes;
  const teamChanges: TeamIssueBulkEditPreviewInput['changes'] = {
    ...basicChanges,
    ...(dueDateMode === 'clear' ? { dueDate: null } : dueDateMode === 'set' && validDueDate ? { dueDate } : {}),
    ...(addLabels.length ? { addLabels } : {}),
    ...(removeLabels.length ? { removeLabels } : {}),
  };
  const changes: IssueBulkEditChanges = {
    ...teamChanges,
    ...planningChanges,
    ...(!team && status !== undefined ? { status } : {}),
    ...(!team && parentMode === 'clear' ? { parentId: null } : {}),
    ...(selectingParent && currentParent && !parentError ? { parentId: currentParent.id } : {}),
    ...(!team && customFieldDrafts.length && !customFieldErrors.size ? {
      customFields: Object.fromEntries(customFieldDrafts.map(({ id, mode, value }) => [id, mode === 'clear' ? null : value])),
    } : {}),
  };
  const removalOptions = [...new Set([...removeLabels, ...selected.flatMap(issue => issue.labels)])]
    .sort((first, second) => first.localeCompare(second, 'ko'));
  let labelsError = '';
  if (addLabels.length > ISSUE_BULK_LABEL_LIMIT || addLabels.some(label => label.length > ISSUE_BULK_LABEL_MAX_LENGTH || /\p{Cc}/u.test(label))) {
    labelsError = `추가할 라벨은 각 ${ISSUE_BULK_LABEL_MAX_LENGTH}자 이하로 최대 ${ISSUE_BULK_LABEL_LIMIT}개 입력해 주세요.`;
  } else if (addLabels.some(label => removeLabels.includes(label))) {
    labelsError = '같은 라벨은 추가와 제거 중 한 곳에서만 선택해 주세요.';
  }
  const statusCount = teamStatusEntries.length;
  const changeCount = Object.keys(changes).length + statusCount;
  const applyUncertain = active && session.applyUncertain;
  const dirty = active && (selected.length > 0 || changeCount > 0 || dueDateMode !== 'keep' || parentMode !== 'keep' ||
    Object.keys(planningDrafts).length > 0 || Boolean(addLabelsText) || customFieldDrafts.length > 0 || applyUncertain);
  const input = JSON.stringify(team ? {
    issues: selected.map(({ id, version, projectId }) => ({ id, expectedVersion: version, projectId: projectId ?? '' })),
    changes: teamChanges,
    ...(statusCount ? { statuses: teamStatuses, workflowVersions } : {}),
  } satisfies TeamIssueBulkEditPreviewInput : {
    issues: selected.map(({ id, version }) => ({ id, expectedVersion: version })), changes,
    ...(report?.fieldBreakdown ? { fieldBreakdown: report.fieldBreakdown } : {}),
  } satisfies IssueBulkEditPreviewInput);
  const stalePreview = active && !applyUncertain && Boolean(session.preview && session.preview.input !== input);
  const preview = active && !stalePreview ? session.preview?.result : undefined;
  const path = team ? '/team/issues' : `/projects/${encodeURIComponent(projectId)}/issues`;
  const reportScoped = Boolean(report);
  const pageTargets = report?.pageTargets ?? [];
  const pageSelectedCount = active ? pageTargets.filter(issue => session.ids.has(issue.id)).length : 0;
  const canTogglePage = active && !busy && !applyUncertain && pageTargets.length > 0 &&
    (pageSelectedCount === pageTargets.length || selected.length + pageTargets.length - pageSelectedCount <= ISSUE_BULK_EDIT_LIMIT);

  if (session && !active) {
    setSession(null);
  } else if (active && !applyUncertain && (session.ids.size !== selected.length || Object.keys(session.teamStatuses).length !== statusCount)) {
    // Dropped rows do not become selected again if a later filter makes them visible.
    setSession({ ...session, ids: new Set(selected.map(issue => issue.id)), teamStatuses, preview: null });
  }

  const reset = useCallback(() => {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setSession(null);
  }, []);

  useEffect(() => {
    window.addEventListener('teamspace:workspace-imported', reset);
    return () => {
      pending.current?.abort();
      pending.current = null;
      window.removeEventListener('teamspace:workspace-imported', reset);
    };
  }, [reset]);

  useEffect(() => {
    if (!active) return;
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pending.current) {
        event.preventDefault();
        notify('일괄 편집 요청이 끝난 뒤 이동해 주세요.', 'error');
      } else if ((reportScoped && isReportPreservedByNavigation(event)) ||
          (team && !applyUncertain && isTeamBoardPreservedByNavigation(event))) {
        return;
      } else if (!dirty || window.confirm(discardPrompt(applyUncertain))) {
        afterAcceptedNavigation(event, reset);
      } else {
        event.preventDefault();
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!pending.current && !dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [active, applyUncertain, dirty, notify, reportScoped, reset, team]);

  function close() {
    if (pending.current || (dirty && !window.confirm(discardPrompt(applyUncertain)))) return false;
    reset();
    return true;
  }

  function toggle(issue: IssueBulkEditTarget) {
    setSession(current => {
      if (!current || pending.current || current.applyUncertain) return current;
      const ids = new Set(current.ids);
      if (ids.has(issue.id)) ids.delete(issue.id);
      else if (ids.size < ISSUE_BULK_EDIT_LIMIT) ids.add(issue.id);
      return { ...current, ids, preview: null };
    });
  }

  function toggleVisible() {
    if (visible.length > ISSUE_BULK_EDIT_LIMIT || pending.current || applyUncertain) return;
    const ids = selected.length === visible.length ? new Set<string>() : new Set(visible.map(issue => issue.id));
    setSession(current => current && { ...current, ids, preview: null });
  }

  function togglePage() {
    if (!canTogglePage) return;
    setSession(current => {
      if (!current || pending.current || current.applyUncertain) return current;
      const ids = new Set(current.ids);
      if (pageTargets.every(target => ids.has(target.id))) {
        for (const target of pageTargets) ids.delete(target.id);
      } else {
        for (const target of pageTargets) ids.add(target.id);
        if (ids.size > ISSUE_BULK_EDIT_LIMIT) return current;
      }
      return { ...current, ids, preview: null };
    });
  }

  function clearSelection() {
    setSession(current => current && !current.applyUncertain ? { ...current, ids: new Set(), preview: null } : current);
  }

  function updateFields(update: (current: EditSession) => Partial<EditFields>) {
    setSession(current => {
      if (!current || pending.current || current.applyUncertain) return current;
      return { ...current, ...update(current), preview: null, error: current.refreshRequired ? current.error : '' };
    });
  }

  function setChange<N extends keyof BasicChanges>(name: N, value: BasicChanges[N]) {
    updateFields(current => {
      const patch = { ...current.changes, [name]: value };
      if (value === undefined) delete patch[name];
      return { changes: patch };
    });
  }

  function setTeamStatus(projectId: string, status: string) {
    if (!teamProjectStatuses.has(projectId)) return;
    updateFields(current => {
      const next = { ...current.teamStatuses };
      if (status) next[projectId] = status;
      else delete next[projectId];
      return { teamStatuses: next };
    });
  }

  function setPlanningChoice(kind: PlanningKind, value: string) {
    const choice = value.startsWith(planningOptionPrefix)
      ? planningOptions.get(kind)?.find(item => item.id === value.slice(planningOptionPrefix.length)) : undefined;
    if (team || (value && value !== 'clear' && !choice)) return;
    updateFields(current => {
      const next = { ...current.planningDrafts };
      if (choice) next[kind] = { id: choice.id, name: choice.name };
      else if (value === 'clear') next[kind] = null;
      else delete next[kind];
      return { planningDrafts: next };
    });
  }

  function toggleLabelRemoval(label: string) {
    updateFields(current => ({ removeLabels: current.removeLabels.includes(label)
      ? current.removeLabels.filter(value => value !== label)
      : current.removeLabels.length < ISSUE_BULK_LABEL_LIMIT ? [...current.removeLabels, label] : current.removeLabels }));
  }

  function addCustomField(field: CustomFieldDefinition) {
    updateFields(current => current.customFieldDrafts.some(draft => draft.id === field.id) ? {} : {
      customFieldDrafts: [...current.customFieldDrafts, { id: field.id, name: field.name, kind: field.kind, mode: 'set', value: null }],
    });
  }

  function updateCustomField(id: string, update: Partial<Pick<CustomFieldDraft, 'mode' | 'value'>>) {
    updateFields(current => ({ customFieldDrafts: current.customFieldDrafts.map(draft => draft.id === id ? { ...draft, ...update } : draft) }));
  }

  function removeCustomField(id: string) {
    updateFields(current => ({ customFieldDrafts: current.customFieldDrafts.filter(draft => draft.id !== id) }));
  }

  async function request(task: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setSession(current => current && { ...current, error: '' });
    try { await task(controller.signal); }
    finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function send<T>(action: 'bulk-preview' | 'bulk-apply', body: string, signal: AbortSignal) {
    return api<T>(`${path}/${action}`, { method: 'POST', body, signal, headers: { 'X-Actor-Id': actorId } });
  }

  const canPreview = active && selected.length > 0 && changeCount > 0 && validDueDate && validParent && !labelsError && !planningErrors.size && !customFieldErrors.size &&
    !session.refreshRequired && !applyUncertain && (!report || Boolean(report.fieldBreakdown)) &&
    (!team || chosenProjectIds.size === teamProjects.length);
  async function review() {
    if (!canPreview) return;
    await request(async signal => {
      setSession(current => current && { ...current, preview: null });
      try {
        const result = await send<IssueBulkEditPreview>('bulk-preview', input, signal);
        if (!signal.aborted) setSession(current => current && { ...current, preview: { result, input } });
      } catch (cause) {
        if (signal.aborted) return;
        const refreshRequired = cause instanceof ApiError && (cause.status === 409 || cause.status === 404);
        setSession(current => current && { ...current, error: errorMessage(cause), refreshRequired });
      }
    });
  }

  async function apply() {
    if (!preview?.previewId) return;
    await request(async signal => {
      const previewId = preview.previewId;
      let result: IssueBulkEditResult;
      try {
        result = await send<IssueBulkEditResult>('bulk-apply', JSON.stringify({ previewId }), signal);
      } catch (cause) {
        if (signal.aborted) return;
        const definiteRejection = cause instanceof ApiError && cause.status >= 400 && cause.status < 500 &&
          !uncertainApplyStatuses.has(cause.status) && !(applyUncertain && (cause.status === 401 || cause.status === 403));
        setSession(current => current && {
          ...current,
          preview: definiteRejection ? null : current.preview,
          error: definiteRejection ? errorMessage(cause) : '적용 결과를 확인하지 못했습니다. 같은 미리보기로 다시 확인할 수 있습니다.',
          refreshRequired: definiteRejection,
          applyUncertain: !definiteRejection,
        });
        return;
      }
      if (signal.aborted) return;
      setSession(initialSession(scope));
      notify(`${result.updated.length}개 업무를 변경했습니다.`);
      try { await refresh(); }
      catch {
        if (!signal.aborted) setSession(current => current && {
          ...current, error: '변경은 저장되었습니다. 최신 업무 목록을 불러오지 못했습니다.', refreshRequired: true,
        });
      }
    });
  }

  async function reload() {
    await request(async signal => {
      try {
        await refresh();
        if (!signal.aborted) setSession(current => current && { ...current, preview: null, refreshRequired: false });
      } catch (cause) {
        if (!signal.aborted) setSession(current => current && { ...current, error: errorMessage(cause) });
      }
    });
  }

  return {
    active, busy, locked: busy || applyUncertain, selectedIds: active ? session.ids : new Set<string>(), changes,
    team, teamProjects, teamProjectStatuses, teamStatuses, setTeamStatus,
    preview, stalePreview, canPreview, applyUncertain, error: active ? session.error : '', refreshRequired: active && session.refreshRequired,
    selectedCount: selected.length, visibleCount: visible.length, reportScoped,
    pageCount: pageTargets.length, pageSelectedCount, canTogglePage, togglePage, clearSelection,
    dueDateMode, dueDate, addLabelsText, removalOptions, removeLabels, labelsError, toggleLabelRemoval,
    parentMode, parentSelection: currentParent ?? parentSelection, parentCandidates, parentError, issueAliases: data.issueAliases,
    setParentMode: (value: ParentMode) => updateFields(() => ({ parentMode: value })),
    selectParent: ({ id, key, title }: ParentIssue) => updateFields(current => current.ids.has(id) ? {} : { parentSelection: { id, key, title } }),
    planningDrafts, planningOptions, planningErrors, setPlanningChoice,
    customFieldDefinitions, customFieldsById, customFieldDrafts, customFieldErrors, addCustomField, updateCustomField, removeCustomField,
    setDueDateMode: (value: DueDateMode) => updateFields(() => ({ dueDateMode: value })),
    setDueDate: (value: string) => updateFields(() => ({ dueDate: value })),
    setAddLabelsText: (value: string) => updateFields(() => ({ addLabelsText: value })),
    open: () => setSession(initialSession(scope)), close, toggle, toggleVisible, setChange, review, apply, reload,
  };
}

type BulkEditor = ReturnType<typeof useIssueBulkEdit>;

export function IssueBulkSelectVisible({ editor, label }: { editor: BulkEditor; label?: string }) {
  const checkbox = useRef<HTMLInputElement>(null);
  const allSelected = editor.visibleCount > 0 && editor.selectedCount === editor.visibleCount;
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = editor.selectedCount > 0 && !allSelected;
  }, [editor.selectedCount, allSelected]);
  return <label className={`issue-bulk-select-control${label ? ' issue-bulk-select-with-label' : ''}`}>
    <input ref={checkbox} type="checkbox" aria-label={label ?? '검색 결과 전체 선택'} checked={allSelected}
      disabled={editor.locked || editor.visibleCount === 0 || editor.visibleCount > ISSUE_BULK_EDIT_LIMIT}
      onChange={editor.toggleVisible} />
    {label && <span>{label}</span>}
  </label>;
}

type BulkBasicField = Exclude<keyof IssueBulkEditValues, 'customFields'>;
const fieldLabels = { status: '상태', priority: '우선순위', assigneeId: '담당자', dueDate: '마감일', labels: '라벨', parentId: '상위 업무',
  cycleId: planningMeta('cycle').label, moduleId: planningMeta('module').label, releaseId: planningMeta('release').label,
} satisfies Record<BulkBasicField, string>;
const outcomes = { changed: '변경 예정', unchanged: '변경 없음', blocked: '변경 불가' };
const memberPrefix = 'team-member:';
const displayLabel = (label: string) => !label || label.trim() !== label || /[",\p{Cc}]/u.test(label) ? JSON.stringify(label) : label;

export function IssueBulkEdit({ editor, statuses, users, onClose, selectionNote }: {
  editor: BulkEditor;
  statuses: WorkflowStatus[];
  users: FeatureProps['data']['users'];
  onClose: () => void;
  selectionNote?: string;
}) {
  const { changes, preview } = editor;
  const teamProjects = new Map(editor.teamProjects.map(project => [project.id, project]));
  const hasAutomaticDueDate = editor.team
    ? Object.entries(editor.teamStatuses).some(([id, statusId]) =>
      editor.teamProjectStatuses.get(id)?.find(status => status.id === statusId)?.defaultDueWorkdays != null)
    : statuses.find(status => status.id === changes.status)?.defaultDueWorkdays != null;
  function valueLabel(field: BulkBasicField, values: IssueBulkEditValues, row: IssueBulkEditRow) {
    const side = values === row.before ? 'before' : 'after';
    if (field === 'status') {
      const projectStatuses = row.projectId ? editor.teamProjectStatuses.get(row.projectId) : statuses;
      return projectStatuses?.find(status => status.id === values.status)?.label ?? values.status;
    }
    if (field === 'priority') return PRIORITY[values.priority];
    if (field === 'dueDate') return values.dueDate ?? '미지정';
    if (field === 'labels') return values.labels?.length ? values.labels.map(displayLabel).join(', ') : '없음';
    if (field === 'parentId') {
      const parent = row.parents?.[side];
      if (!values.parentId) return '상위 업무 없음';
      return parent?.id === values.parentId ? parentIssueLabel(parent) : '확인할 수 없는 상위 업무';
    }
    const kind = planningKinds.find(kind => planningFields(kind).idField === field);
    if (kind) {
      const id = values[planningFields(kind).idField];
      const item = row.plans?.[kind]?.[side];
      if (!id) return `${planningMeta(kind).label} 없음`;
      return item?.id === id ? item.name : `확인할 수 없는 ${planningMeta(kind).label}`;
    }
    return values.assigneeId ? users.find(user => user.id === values.assigneeId)?.name ?? values.assigneeId : '미지정';
  }

  function customValueLabel(id: string, value: CustomFieldValue | undefined) {
    if (!hasCustomValue(value)) return '미지정';
    const field = editor.customFieldsById.get(id);
    return field ? fieldValueLabel(field, value, users) : String(value);
  }

  return <section className="issue-bulk-editor" aria-label="업무 일괄 편집">
    <header>
      <div>
        <h2><ListChecks size={18} aria-hidden="true" />업무 일괄 편집</h2>
        <p role="status">{editor.selectedCount}개 선택 · 최대 {ISSUE_BULK_EDIT_LIMIT}개</p>
      </div>
      <button type="button" className="btn btn-ghost" aria-label="일괄 편집 닫기" disabled={editor.busy} onClick={onClose}><X size={16} aria-hidden="true" />닫기</button>
    </header>
    <form onSubmit={event => { event.preventDefault(); void editor.review(); }}>
      <fieldset disabled={editor.locked} className="issue-bulk-fields">
        {editor.team ? editor.teamProjects.length > 0 && <div className="issue-bulk-project-statuses">
          {editor.teamProjects.map(project => {
            const statuses = editor.teamProjectStatuses.get(project.id) ?? [];
            const statusId = editor.teamStatuses[project.id] ?? '';
            return <label key={project.id}>{project.key} · {project.name} 상태
              <select className="field" aria-label={`일괄 상태 ${project.name}`} value={statusId}
                onChange={event => editor.setTeamStatus(project.id, event.currentTarget.value)}>
                <option value="">현재 상태 유지</option>
                {statusId && !statuses.some(status => status.id === statusId) && <option value={statusId} disabled>{statusId} (선택 불가)</option>}
                {statuses.map(status => <option value={status.id} key={status.id}>{status.label}</option>)}
              </select>
            </label>;
          })}
        </div> : <label>상태<select className="field" aria-label="일괄 변경 상태" value={changes.status ?? ''}
          onChange={event => editor.setChange('status', event.currentTarget.value || undefined)}>
          <option value="">현재 상태 유지</option>
          {changes.status && !statuses.some(status => status.id === changes.status) && <option value={changes.status} disabled>{changes.status} (선택 불가)</option>}
          {statuses.map(status => <option value={status.id} key={status.id}>{status.label}</option>)}
        </select></label>}
        <label>우선순위<select className="field" aria-label="일괄 변경 우선순위" value={changes.priority ?? ''}
          onChange={event => editor.setChange('priority', event.currentTarget.value ? event.currentTarget.value as Priority : undefined)}>
          <option value="">현재 우선순위 유지</option>
          {Object.entries(PRIORITY).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
        </select></label>
        <label>담당자<select className="field" aria-label="일괄 변경 담당자"
          value={changes.assigneeId === null ? 'none' : changes.assigneeId ? `${memberPrefix}${changes.assigneeId}` : ''}
          onChange={event => {
            const value = event.currentTarget.value;
            editor.setChange('assigneeId', value === 'none' ? null : value ? value.slice(memberPrefix.length) : undefined);
          }}>
          <option value="">직접 지정하지 않음</option><option value="none">담당자 해제</option>
          {users.map(user => <option value={`${memberPrefix}${user.id}`} key={user.id}>{user.name}</option>)}
        </select></label>
        <div className="issue-bulk-date-fields">
          <label>마감일<select className="field" aria-label="일괄 변경 마감일" value={editor.dueDateMode}
            onChange={event => editor.setDueDateMode(event.currentTarget.value as DueDateMode)}>
            <option value="keep">{hasAutomaticDueDate ? '기존 날짜 또는 자동 지정' : '현재 마감일 유지'}</option>
            <option value="set">날짜 지정</option><option value="clear">마감일 지우기</option>
          </select></label>
          {editor.dueDateMode === 'set' && <label>지정할 마감일<input type="date" className="field" required
            value={editor.dueDate} onChange={event => editor.setDueDate(event.currentTarget.value)} /></label>}
        </div>
        <label>추가할 라벨<input className="field" placeholder="쉼표로 구분" value={editor.addLabelsText}
          aria-invalid={Boolean(editor.labelsError) || undefined}
          onChange={event => editor.setAddLabelsText(event.currentTarget.value)} /></label>
        <details className="issue-bulk-label-removal">
          <summary>제거할 라벨 선택</summary>
          <div className="issue-bulk-removal-options">
            {editor.removalOptions.length ? editor.removalOptions.map(label => {
              const checked = editor.removeLabels.includes(label);
              return <label key={label} className="issue-bulk-removal-option">
                <input type="checkbox" aria-label={`${displayLabel(label)} 라벨 제거`} checked={checked}
                  disabled={!checked && editor.removeLabels.length >= ISSUE_BULK_LABEL_LIMIT} onChange={() => editor.toggleLabelRemoval(label)} />
                <span>{displayLabel(label)}</span>
              </label>;
            }) : <p>선택한 업무에 제거할 라벨이 없습니다.</p>}
          </div>
          {editor.removeLabels.length > 0 && <p role="status">{editor.removeLabels.length}개 선택 · 최대 {ISSUE_BULK_LABEL_LIMIT}개</p>}
        </details>
        {!editor.team && <BulkParentField editor={editor} />}
        {!editor.team && <BulkPlanningFields editor={editor} />}
        {!editor.team && <BulkCustomFields editor={editor} users={users} />}
      </fieldset>
      {editor.labelsError && <p className="issue-bulk-error" role="alert">{editor.labelsError}</p>}
      <p className="issue-bulk-note">{selectionNote ?? (editor.team ? '보드에 표시된 업무를 선택할 수 있습니다.' : editor.reportScoped
        ? '같은 집계 그룹의 여러 페이지에서 업무를 선택할 수 있습니다.' : '현재 목록의 업무만 선택할 수 있습니다.')} 담당자를 직접 지정하지 않으면 상태 변경 시 자동 배정 규칙을 적용합니다.</p>
      {!editor.reportScoped && editor.visibleCount > ISSUE_BULK_EDIT_LIMIT && <p className="issue-bulk-note">전체 선택은 검색 결과가 {ISSUE_BULK_EDIT_LIMIT}개 이하일 때 가능합니다.</p>}
      <button type="submit" className="btn" disabled={editor.busy || !editor.canPreview}>변경 미리보기</button>
    </form>
    {editor.error && <p className="issue-bulk-error" role="alert">{editor.error}</p>}
    {editor.stalePreview && !editor.error && <p role="status">선택한 업무가 갱신되었습니다. 미리보기를 다시 확인하세요.</p>}
    {editor.refreshRequired && <button type="button" className="btn" disabled={editor.busy} onClick={() => void editor.reload()}>최신 업무 불러오기</button>}
    {preview && <section className="issue-bulk-preview" aria-label="일괄 변경 미리보기">
      <h3>일괄 변경 미리보기</h3>
      <p>변경 {preview.changed}개 · 유지 {preview.unchanged}개 · 차단 {preview.blocked}개</p>
      {preview.blocked > 0 && <p className="issue-bulk-error">변경할 수 없는 업무가 있습니다. 선택이나 입력을 수정한 뒤 다시 확인하세요.</p>}
      <ul className="issue-bulk-preview-list" aria-label="업무 변경 항목" tabIndex={0}>
        {preview.rows.map(row => {
          const project = row.projectId ? teamProjects.get(row.projectId) : undefined;
          return <li key={row.id}>
            <div className="issue-bulk-preview-heading"><strong>{row.key} {row.title}</strong><span>{outcomes[row.outcome]}</span></div>
            {project && <p>{project.key} · {project.name}</p>}
            {row.reason && <p className="issue-bulk-row-reason">{row.reason}</p>}
            {row.after && transitionLabels(row.before, row.after, (field, values) => valueLabel(field, values, row),
              editor.customFieldsById, customValueLabel)}
          </li>;
        })}
      </ul>
      {preview.previewId && <button type="button" className="btn btn-primary" disabled={editor.busy}
        onClick={() => void editor.apply()}>{editor.applyUncertain ? '적용 결과 다시 확인' : '일괄 적용'}</button>}
    </section>}
  </section>;
}

function BulkParentField({ editor }: { editor: BulkEditor }) {
  const headingId = useId();
  const firstCandidate = useRef<HTMLButtonElement>(null);
  const resultList = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const { parentMode, parentSelection, parentCandidates, parentError, issueAliases, selectedIds } = editor;
  const matches = useMemo(() => searchIssueCandidates({ issueAliases }, parentCandidates, query), [issueAliases, parentCandidates, query]);
  const lastPage = Math.max(0, Math.ceil(matches.length / parentPageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const offset = currentPage * parentPageSize;
  const visible = matches.slice(offset, offset + parentPageSize);
  const firstCandidateId = visible.find(({ issue }) => !selectedIds.has(issue.id))?.issue.id;

  function showPage(next: number) {
    setPage(next);
    if (resultList.current) resultList.current.scrollTop = 0;
  }

  return <section className="issue-bulk-parent-fields" aria-labelledby={headingId}>
    <h3 id={headingId}>상위 업무</h3>
    <label>변경 방식
      <select className="field" aria-label="일괄 변경 상위 업무" value={parentMode}
        onChange={event => editor.setParentMode(event.currentTarget.value as ParentMode)}>
        <option value="keep">현재 상위 업무 유지</option>
        <option value="set">상위 업무 지정</option>
        <option value="clear">상위 업무 해제</option>
      </select>
    </label>
    {parentMode === 'set' && <>
      <label>상위 업무 검색
        <input type="search" className="field" placeholder="업무 키, 이전 키 또는 제목" value={query} maxLength={WORKSPACE_SEARCH_QUERY_LIMIT}
          onChange={event => { setQuery(event.currentTarget.value); showPage(0); }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            firstCandidate.current?.focus();
          }} />
      </label>
      {parentSelection && <p>선택한 상위 업무 <strong>{parentIssueLabel(parentSelection)}</strong></p>}
      {parentError && <p className="issue-bulk-error" role="alert">{parentError}</p>}
      {visible.length > 0 ? <ul className="issue-bulk-parent-results" role="list" aria-label="상위 업무 후보" ref={resultList}>
        {visible.map(({ issue, matchedAliases }, index) => {
          const disabled = selectedIds.has(issue.id);
          const chosen = parentSelection?.id === issue.id;
          const description = [...matchedAliases.map(issueSearchAliasLabel), ...(disabled ? ['일괄 변경할 업무'] : [])].join(' · ');
          const descriptionId = description ? `${headingId}-candidate-${index}` : undefined;
          const label = parentIssueLabel(issue);
          return <li key={issue.id}>
            <button type="button" className="btn btn-ghost" aria-label={label} aria-describedby={descriptionId} aria-pressed={chosen}
              disabled={disabled} ref={issue.id === firstCandidateId ? firstCandidate : undefined}
              onClick={() => { if (!chosen) editor.selectParent(issue); }}>
              <strong>{label}</strong>
              {description && <small id={descriptionId}>{description}</small>}
            </button>
          </li>;
        })}
      </ul> : <p role="status">조건에 맞는 상위 업무가 없습니다.</p>}
      {lastPage > 0 && <nav className="issue-bulk-parent-pages" aria-label="상위 업무 후보 페이지">
        <button type="button" className="btn btn-ghost" aria-label="상위 업무 후보 이전 페이지" disabled={currentPage === 0}
          onClick={() => showPage(currentPage - 1)}>이전</button>
        <span role="status">{offset + 1}–{offset + visible.length} / {matches.length.toLocaleString('ko-KR')}개</span>
        <button type="button" className="btn btn-ghost" aria-label="상위 업무 후보 다음 페이지" disabled={currentPage === lastPage}
          onClick={() => showPage(currentPage + 1)}>다음</button>
      </nav>}
    </>}
  </section>;
}

function BulkPlanningFields({ editor }: { editor: BulkEditor }) {
  const id = useId();
  return <section className="issue-bulk-planning-fields" aria-label="계획 연결 일괄 변경">
    <h3>계획 연결</h3>
    <div className="issue-bulk-planning-controls">
      {planningKinds.map(kind => {
        const { label } = planningMeta(kind);
        const choice = editor.planningDrafts[kind];
        const options = editor.planningOptions.get(kind) ?? [];
        const error = editor.planningErrors.get(kind);
        const errorId = error ? `${id}-${kind}-error` : undefined;
        const value = choice ? `${planningOptionPrefix}${choice.id}` : choice === null ? 'clear' : '';
        return <div key={kind}>
          <label>{label}
            <select className="field" aria-label={`일괄 변경 ${label}`} aria-invalid={Boolean(error) || undefined} aria-describedby={errorId}
              value={value} onChange={event => editor.setPlanningChoice(kind, event.currentTarget.value)}>
              <option value="">현재 {label} 유지</option>
              <option value="clear">{label} 연결 해제</option>
              {error && choice && <option value={value} disabled>{choice.name} · 선택 불가</option>}
              {options.map(item => <option key={item.id} value={`${planningOptionPrefix}${item.id}`}>
                {item.name} · {PLANNING_STATUS_META[item.status]?.label ?? item.status}
              </option>)}
            </select>
          </label>
          {error && <p id={errorId} className="issue-bulk-error" role="alert">{error}</p>}
        </div>;
      })}
    </div>
  </section>;
}

function BulkCustomFields({ editor, users }: { editor: BulkEditor; users: FeatureProps['data']['users'] }) {
  const idPrefix = useId();
  const fieldPicker = useRef<HTMLSelectElement>(null);
  const [fieldId, setFieldId] = useState('');
  const addedIds = new Set(editor.customFieldDrafts.map(draft => draft.id));
  const available = editor.customFieldDefinitions.filter(field => !field.archived && !addedIds.has(field.id));
  const pickedField = available.find(field => field.id === fieldId);
  if (!available.length && !editor.customFieldDrafts.length) return null;

  function addField() {
    if (!pickedField) return;
    editor.addCustomField(pickedField);
    setFieldId('');
    requestAnimationFrame(() => document.getElementById(`${idPrefix}-${pickedField.id}-mode`)?.focus());
  }

  function removeField(id: string) {
    editor.removeCustomField(id);
    requestAnimationFrame(() => fieldPicker.current?.focus());
  }

  return <section className="issue-bulk-custom-fields" aria-label="사용자 정의 필드 일괄 변경">
    <h3>사용자 정의 필드</h3>
    {available.length > 0 && <div className="issue-bulk-custom-picker">
      <select ref={fieldPicker} className="field" aria-label="변경할 사용자 정의 필드" value={pickedField?.id ?? ''}
        onChange={event => setFieldId(event.currentTarget.value)}>
        <option value="">필드 선택</option>
        {available.map(field => <option value={field.id} key={field.id}>{field.name}</option>)}
      </select>
      <button className="btn" type="button" disabled={!pickedField} onClick={addField}>
        <Plus size={14} aria-hidden="true" />필드 변경 추가
      </button>
    </div>}
    {editor.customFieldDrafts.map(draft => {
      const definition = editor.customFieldsById.get(draft.id);
      const name = definition?.name ?? draft.name;
      const error = editor.customFieldErrors.get(draft.id);
      const errorId = error ? `${idPrefix}-${draft.id}-error` : undefined;
      const editable = definition && !definition.archived && definition.kind === draft.kind;
      return <div className="issue-bulk-custom-row" key={draft.id}>
        <div className="issue-bulk-custom-row-heading">
          <strong>{name}</strong>
          <button type="button" className="btn btn-ghost" aria-label={`${name} 변경 제외`} onClick={() => removeField(draft.id)}>제외</button>
        </div>
        {editable && <div className="issue-bulk-custom-controls">
          <label>변경 방식<select id={`${idPrefix}-${draft.id}-mode`} className="field" aria-label={`${name} 변경 방식`}
            value={draft.mode} onChange={event => editor.updateCustomField(draft.id, { mode: event.currentTarget.value === 'clear' ? 'clear' : 'set' })}>
            <option value="set">값 지정</option>
            <option value="clear">값 지우기</option>
          </select></label>
          {draft.mode === 'set' && <div className="issue-bulk-custom-value">
            <span aria-hidden="true">변경할 값</span>
            <CustomFieldInput field={definition} value={draft.value} label={`${name} 일괄 변경 값`} users={users}
              multipleControl="checkboxes" errorId={errorId} onChange={value => editor.updateCustomField(draft.id, { value })} />
          </div>}
        </div>}
        {error && <p className="issue-bulk-error" id={errorId}>{error}</p>}
      </div>;
    })}
  </section>;
}

function transitionLabels(before: IssueBulkEditValues, after: IssueBulkEditValues,
  label: (field: BulkBasicField, values: IssueBulkEditValues) => string,
  customFields: ReadonlyMap<string, CustomFieldDefinition>, customLabel: (id: string, value: CustomFieldValue | undefined) => string) {
  const fields = (Object.keys(fieldLabels) as BulkBasicField[]).filter(field => {
    if (field !== 'labels') return before[field] !== after[field];
    const previous = before.labels ?? [], next = after.labels ?? [];
    return previous.length !== next.length || previous.some((value, index) => value !== next[index]);
  });
  const customFieldIds = new Set([...Object.keys(before.customFields ?? {}), ...Object.keys(after.customFields ?? {})]);
  const customChanges = [...customFieldIds].flatMap(id => {
    const previous = before.customFields?.[id] ?? null;
    const next = after.customFields?.[id] ?? null;
    const same = Array.isArray(previous) && Array.isArray(next)
      ? previous.length === next.length && previous.every(value => next.includes(value))
      : previous === next;
    return same ? [] : [{ id, previous, next }];
  });
  if (!fields.length && !customChanges.length) return null;
  return <dl className="issue-bulk-changes">
    {fields.map(field => <div key={field}>
      <dt>{fieldLabels[field]}</dt><dd>{label(field, before)} → {label(field, after)}</dd>
    </div>)}
    {customChanges.map(({ id, previous, next }) => <div key={`custom:${id}`}>
      <dt>{customFields.get(id)?.name ?? id}</dt><dd>{customLabel(id, previous)} → {customLabel(id, next)}</dd>
    </div>)}
  </dl>;
}
