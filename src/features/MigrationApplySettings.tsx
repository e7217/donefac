'use client';

import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { ArchiveRestore, CheckCircle2, Download, FileCheck2, FileSearch, Loader2, RefreshCw, X } from 'lucide-react';
import { suggestMigrationIdentityMappings } from '../../shared/migration-identity-suggestions';
import { buildMigrationPreflightReport } from '../../shared/migration-preflight';
import { ISSUE_TYPES, MIGRATION_MAPPING_FILE_MAX_BYTES, type ConfluenceMigrationDocumentField, type ConfluenceMigrationDocumentReview, type CustomFieldKind, type FeatureProps, type JiraMigrationIssueField, type JiraMigrationIssueReview, type LegacyPackageSummary, type LegacyRecord, type LegacyRecordPage, type MigrationApplyResult, type MigrationConfiguration, type MigrationFieldOption, type MigrationIdentityOption, type MigrationJiraPlanningChoice, type MigrationMappingFile, type MigrationMappingRestore, type MigrationNotice, type MigrationOptions, type MigrationPreview, type MigrationValueOption, type SourceImport, type SourceRecordArchive, type StatusCategory, type User } from '../../shared/types';
import { api, post } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { LegacyRecordDetail } from './LegacyRecordDetail';
import { MigrationAuthorPreview } from './MigrationAuthorReview';
import { ConfluenceSourceReview } from './MigrationConfluenceReview';
import { MigrationJiraObservedWorkflowReview, MigrationJiraWorkflowEditor, MigrationJiraWorkflowPreview } from './MigrationJiraWorkflow';
import { MigrationReconciliation } from './MigrationReconciliation';
import { SourceArchiveDetail, SourceImportRecords } from './SourceOrigins';
import { downloadDocument } from './document-utils';
import './migration-apply.css';

const PAGE_SIZE = 50;
const reviewExclusionKinds = new Set(['issue', 'page', 'comment', 'revision', 'history', 'attachment', 'relation']);
const categoryLabels: Record<StatusCategory, string> = { backlog: '백로그', todo: '할 일', in_progress: '진행 중', review: '검토', done: '완료', cancelled: '취소' };
const fieldLabels: Record<CustomFieldKind | 'archive', string> = { archive: '원본 보관만', text: '텍스트', number: '숫자', date: '날짜', select: '단일 선택', multi_select: '여러 선택', checkbox: '체크박스', user: '사용자', url: 'URL' };
const sourceLinkCountLabels = { atlassianLinks: '원본 링크 생성', unlinkedAtlassianRecords: '원본 링크 미생성' };
const jiraPlanningCountLabels = {
  jiraReleases: '새 Jira 릴리스', jiraReleaseLinks: '릴리스에 연결된 업무', jiraReleaseUnassigned: '릴리스에 미연결된 업무',
  jiraSprints: '새 Jira 사이클', jiraSprintLinks: '사이클에 연결된 업무', jiraSprintUnassigned: '사이클에 미연결된 업무',
  jiraSprintHistoryOnly: '과거 스프린트 이력만 있는 업무',
};
const jiraPlanningReviews = [
  { choices: 'jiraReleaseChoices', selections: 'jiraReleaseSelections', label: '릴리스', original: '모든 Jira 수정 버전' },
  { choices: 'jiraSprintChoices', selections: 'jiraSprintSelections', label: '사이클', original: 'Jira 스프린트 이력' },
] as const;
const noPlanningChoice = '__none__';
const noObservedChoices: ReadonlySet<string> = new Set();
type JiraPlanningSelection = typeof jiraPlanningReviews[number]['selections'];
type JiraPlanningSelections = Pick<MigrationConfiguration, JiraPlanningSelection>;
type PlanningChoiceMap = Record<string, string | null>;
const jiraRefreshCountLabels = {
  updatedIssues: '변경 업무', updatedFields: '기본 필드 반영', conflictingFields: '현재 값을 유지할 기본 필드', skippedIssueUpdates: '변경을 건너뛴 업무',
  updatedCustomFields: '사용자 정의 속성 반영', conflictingCustomFields: '현재 값을 유지할 사용자 정의 속성',
  newJiraComments: '기존 업무의 새 댓글', newJiraWorklogs: '기존 업무의 새 작업 시간 기록',
  newJiraAttachments: '기존 업무의 새 첨부파일', newJiraRelations: '기존 업무 사이의 새 Jira 관계',
  skippedJiraRelations: 'Jira 관계 원본 보관',
};
const confluenceInlineCommentCountLabels = {
  confluenceInlineCommentsAnchored: '원문 위치를 연결한 문장 댓글',
  confluenceInlineCommentsUnresolved: '일반 댓글로 옮긴 위치 미확인 댓글',
  confluenceInlineRepliesLinked: '문장 댓글에 연결한 답글',
  confluenceInlineRepliesUnresolved: '일반 댓글로 옮긴 답글',
};
const confluenceRefreshCountLabels = {
  updatedDocuments: '변경 문서', updatedDocumentFields: '반영 필드', conflictingDocumentFields: '현재 값을 유지할 필드', skippedDocumentUpdates: '변경을 건너뛴 문서',
  newConfluenceAttachments: '기존 문서의 새 첨부', newConfluenceAttachmentVersions: '기존 첨부의 새 버전',
  reusedConfluenceAttachmentVersions: '재사용한 첨부 버전', skippedConfluenceAttachments: '변경을 건너뛴 첨부',
  newConfluenceComments: '기존 문서의 새 댓글', newConfluenceRevisions: '기존 문서의 새 원본 버전',
  ...confluenceInlineCommentCountLabels,
};
const documentOrderCountLabels = {
  confluenceOrderedSiblingGroups: '원본 순서를 적용할 문서 그룹',
  confluenceUnresolvedSiblingGroups: '기본 순서를 사용할 문서 그룹',
};
const jiraRefreshFieldLabels: Record<JiraMigrationIssueField, string> = {
  title: '제목', description: '설명', status: '상태', type: '업무 유형', priority: '우선순위', assigneeId: '담당자', reporterId: '요청자', labels: '라벨',
  startDate: '시작일', endDate: '종료일', dueDate: '마감일', estimate: '예상 작업량', parentId: '상위 업무',
};
function sourceMappingDetail(option: MigrationValueOption & Pick<MigrationFieldOption, 'projectedDate'>) {
  return option.projectedDate ? `${option.sourceValue} · 업무 일정 ${jiraRefreshFieldLabels[option.projectedDate]}에 반영` : option.sourceValue;
}
const confluenceRefreshFieldLabels: Record<ConfluenceMigrationDocumentField, string> = { title: '제목', content: '본문', labels: '라벨', parentId: '상위 문서' };
const countLabels: Record<string, string> = { projects: '프로젝트', issues: '업무', retainedIssues: '이미 이관한 업무', retainedPages: '이미 이관한 문서', retainedRecords: '기존 업무의 원본 기록', documents: '문서', comments: '댓글', worklogs: '적용할 작업 시간', archivedWorklogs: '원본에만 보관할 작업 시간', revisions: '문서 버전', attachments: '첨부', attachmentVersions: '첨부 버전', sourceRecords: '보존 원본', archivedRecords: '보존 원본', excludedRecords: '제외한 원본 합계', explicitExcludedRecords: '직접 제외한 원본', excludedDescendants: '함께 제외된 하위 기록', resourceLinks: '문서·업무 연결', issueRelations: '업무 관계', ...sourceLinkCountLabels, ...jiraPlanningCountLabels, ...jiraRefreshCountLabels, ...confluenceRefreshCountLabels, ...documentOrderCountLabels };
const appendLabels = {
  append: {
    item: '업무', counts: ['issues', 'retainedIssues', 'retainedRecords', ...Object.keys(jiraRefreshCountLabels), ...Object.keys(jiraPlanningCountLabels)],
    confirm: '검토한 Jira 업무를 기존 프로젝트에 추가할까요? 적용 결과는 이관 영수증으로 보관됩니다.',
    success: '새 업무를 기존 프로젝트에 추가했습니다. 이관 영수증에서 원본 기록을 확인하세요.',
  },
  'append-pages': {
    item: '문서', counts: ['documents', 'retainedPages', 'retainedRecords', ...Object.keys(confluenceRefreshCountLabels), ...Object.keys(documentOrderCountLabels)],
    confirm: '검토한 Confluence 문서를 기존 프로젝트에 추가할까요? 적용 결과는 이관 영수증으로 보관됩니다.',
    success: '새 문서를 기존 프로젝트에 추가했습니다. 이관 영수증에서 원본 기록을 확인하세요.',
  },
};
type DestinationMode = 'new' | keyof typeof appendLabels;
const destinationMode = (configuration: MigrationConfiguration | null | undefined): DestinationMode =>
  configuration?.appendTo ? 'append' : configuration?.appendPagesTo ? 'append-pages' : 'new';
type RefreshProduct = 'Jira' | 'Confluence';
function refreshProduct(configuration: MigrationConfiguration | null | undefined): RefreshProduct | undefined {
  const issues = configuration?.appendTo;
  if (issues?.refreshExisting || issues?.refreshCustomFields || issues?.refreshHistory || issues?.refreshAttachments || issues?.refreshRelations) return 'Jira';
  const pages = configuration?.appendPagesTo;
  if (pages?.refreshExisting || pages?.refreshAttachments || pages?.refreshHistory) return 'Confluence';
}
const refreshNoChanges: Record<RefreshProduct, string> = { Jira: 'JIRA_REFRESH_NO_CHANGES', Confluence: 'CONFLUENCE_REFRESH_NO_CHANGES' };
const errorText = (error: unknown) => error instanceof Error ? error.message : '요청을 완료하지 못했습니다.';
const timestamp = (value: string) => new Date(value).toLocaleString('ko-KR');
const sameIds = (a: string[], b: string[]) => [...a].sort().join('\n') === [...b].sort().join('\n');

function refreshSummary(product: RefreshProduct, counts: MigrationPreview['counts']) {
  const [item, added, updated] = product === 'Jira' ? ['업무', counts.issues, counts.updatedIssues] as const : ['문서', counts.documents, counts.updatedDocuments] as const;
  const actions: string[] = [];
  if (added) actions.push(`새 ${item} ${added.toLocaleString()}건 추가`);
  if (updated) actions.push(`기존 ${item} ${updated.toLocaleString()}건 변경`);
  if (product === 'Jira') {
    const { updatedCustomFields, newJiraComments, newJiraWorklogs, newJiraAttachments, newJiraRelations } = counts;
    if (updatedCustomFields) actions.push(`사용자 정의 속성 ${updatedCustomFields.toLocaleString()}건 반영`);
    if (newJiraComments) actions.push(`기존 업무에 새 댓글 ${newJiraComments.toLocaleString()}건 추가`);
    if (newJiraWorklogs) actions.push(`기존 업무에 새 작업 시간 기록 ${newJiraWorklogs.toLocaleString()}건 추가`);
    if (newJiraAttachments) actions.push(`기존 업무에 새 첨부파일 ${newJiraAttachments.toLocaleString()}건 추가`);
    if (newJiraRelations) actions.push(`기존 업무 사이의 새 Jira 관계 ${newJiraRelations.toLocaleString()}건 추가`);
  } else {
    const { newConfluenceAttachments, newConfluenceAttachmentVersions, newConfluenceComments, newConfluenceRevisions } = counts;
    if (newConfluenceAttachments) actions.push(`기존 문서에 새 첨부 ${newConfluenceAttachments.toLocaleString()}건 추가`);
    if (newConfluenceAttachmentVersions) actions.push(`기존 첨부에 새 버전 ${newConfluenceAttachmentVersions.toLocaleString()}건 추가`);
    if (newConfluenceComments) actions.push(`기존 문서에 새 댓글 ${newConfluenceComments.toLocaleString()}건 추가`);
    if (newConfluenceRevisions) actions.push(`기존 문서에 새 원본 버전 ${newConfluenceRevisions.toLocaleString()}건 추가`);
  }
  return actions.join(' · ');
}

export type PrepareMigration = (packages: LegacyPackageSummary[]) => boolean;
type MigrationApplyProps = FeatureProps & {
  packageInventoryVersion: number;
  prepareMigrationRef: Ref<PrepareMigration>;
};

export function MigrationApplySettings(props: MigrationApplyProps) {
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  useEffect(() => {
    const restore = () => setWorkspaceRevision(previous => previous + 1);
    window.addEventListener('teamspace:workspace-imported', restore);
    return () => window.removeEventListener('teamspace:workspace-imported', restore);
  }, []);
  return <ActorMigration key={`${props.actorId}:${workspaceRevision}`} {...props} />;
}
function ActorMigration(props: MigrationApplyProps) {
  const { actorId, data, notify, packageInventoryVersion, prepareMigrationRef } = props;
  const [packages, setPackages] = useState<LegacyPackageSummary[]>([]), [imports, setImports] = useState<SourceImport[]>([]);
  const [selected, setSelected] = useState<string[]>([]), [options, setOptions] = useState<MigrationOptions | null>(null), [configuration, setConfiguration] = useState<MigrationConfiguration | null>(null);
  const [preview, setPreview] = useState<MigrationPreview | null>(null), [acknowledgements, setAcknowledgements] = useState<string[]>([]), [selectedImport, setSelectedImport] = useState<string | null>(null);
  const [planningDraft, setPlanningDraft] = useState<{ key: string; selections: JiraPlanningSelections } | null>(null);
  const [observedDraft, setObservedDraft] = useState<{ key: string; selected: ReadonlySet<string> } | null>(null);
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(''), [error, setError] = useState(''), [listError, setListError] = useState(''), [clock, setClock] = useState(() => Date.now());
  const [mappingNotice, setMappingNotice] = useState('');
  const [identityNotice, setIdentityNotice] = useState('');
  const [identityRoster, setIdentityRoster] = useState<{ snapshot: User[]; users: User[] } | null>(null);
  const [emailReview, setEmailReview] = useState<{ opener: HTMLButtonElement; rows: IdentitySuggestionRow[] } | null>(null);
  const teamUsers = identityRoster?.snapshot === data.users ? identityRoster.users : data.users;
  const mappingFileHelp = useId();
  const active = useRef(true), busyRef = useRef(false), dirtyRef = useRef(false), loadSequence = useRef(0);
  const migrationHeading = useRef<HTMLHeadingElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const receiptHeading = useRef<HTMLHeadingElement>(null);
  const receiptToFocus = useRef<string | null>(null);
  const savedDestinationDraft = useRef<{ issues?: AppendMapping; pages?: PageAppendMapping; workflows?: MigrationConfiguration['jiraWorkflows'] }>({});
  useEffect(() => { dirtyRef.current = selected.length > 0 || Boolean(configuration || preview); }, [selected, configuration, preview]);
  const reset = useCallback(() => { setSelected([]); setOptions(null); setConfiguration(null); setPreview(null); setAcknowledgements([]); setPlanningDraft(null); setObservedDraft(null); setError(''); setMappingNotice(''); setIdentityNotice(''); setEmailReview(null); savedDestinationDraft.current = {}; dirtyRef.current = false; }, []);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const [nextPackages, nextImports] = await Promise.all([
        api<LegacyPackageSummary[]>('/legacy-import/packages', { cache: 'no-store' }),
        api<SourceImport[]>('/source-imports', { cache: 'no-store' }),
      ]);
      if (active.current && sequence === loadSequence.current) { setPackages(nextPackages); setImports(nextImports); setListError(''); }
    }
    catch (cause) { if (active.current && sequence === loadSequence.current) setListError(errorText(cause)); }
    finally { if (active.current && sequence === loadSequence.current) setLoading(false); }
  }, []);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load, packageInventoryVersion]);
  useImperativeHandle(prepareMigrationRef, () => incoming => {
    if (busyRef.current) {
      notify('진행 중인 이관 요청이 끝난 뒤 다시 선택해 주세요.', 'error');
      return false;
    }
    const confirmed = new Map(incoming.map(item => [item.id, item]));
    const ids = [...confirmed.keys()];
    if (!ids.length) return false;
    const replace = !sameIds(ids, selected) || Boolean(configuration && !sameIds(ids, configuration.packageIds));
    if (replace && (selected.length || configuration || preview) &&
        !window.confirm('현재 이관 패키지 선택과 매핑 및 미리보기를 새 패키지 선택으로 바꿀까요?')) return false;
    if (replace) {
      reset();
      setSelected(ids);
      dirtyRef.current = true;
    }
    setPackages(previous => [...confirmed.values(), ...previous.filter(item => !confirmed.has(item.id))]);
    requestAnimationFrame(() => migrationHeading.current?.focus());
    return true;
  });
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 10_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const guard = (event: Event) => { if (event.defaultPrevented) return; if (busyRef.current) { event.preventDefault(); notify('이관 요청 결과를 확인한 뒤 이동해 주세요.', 'error'); return; } if (dirtyRef.current) { if (!window.confirm('이관 매핑과 검토 중인 미리보기를 버리고 이동할까요?')) event.preventDefault(); else afterAcceptedNavigation(event, reset); } };
    const unload = (event: BeforeUnloadEvent) => { if (busyRef.current || dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('teamspace:navigate', guard); window.addEventListener('beforeunload', unload); return () => { window.removeEventListener('teamspace:navigate', guard); window.removeEventListener('beforeunload', unload); };
  }, [notify, reset]);
  async function execute(label: string, action: () => Promise<void>) { if (busyRef.current) return; busyRef.current = true; setPending(label); setError(''); setMappingNotice(''); try { await action(); } catch (cause) { if (active.current) setError(`${errorText(cause)} 입력과 기존 미리보기는 유지됩니다.`); } finally { busyRef.current = false; if (active.current) setPending(''); } }
  function change(next: MigrationConfiguration) { setConfiguration(next); setPreview(null); setAcknowledgements([]); setPlanningDraft(null); setObservedDraft(null); setError(''); setMappingNotice(''); setIdentityNotice(''); }
  function mapValue<K extends 'users' | 'statuses' | 'issueTypes' | 'fields' | 'sourceBaseUrls'>(key: K, id: string, value: MigrationConfiguration[K][string]) { if (configuration) change({ ...configuration, [key]: { ...configuration[key], [id]: value } }); }
  function chooseDestination(mode: string) {
    if (!configuration || !options) return;
    const next = { ...configuration };
    if (next.appendTo) savedDestinationDraft.current.issues = next.appendTo;
    else if (next.appendPagesTo) savedDestinationDraft.current.pages = next.appendPagesTo;
    else savedDestinationDraft.current.workflows = next.jiraWorkflows;
    delete next.appendTo;
    delete next.appendPagesTo;
    delete next.jiraWorkflows;
    for (const { selections } of jiraPlanningReviews) delete next[selections];
    if (mode === 'append' && options.appendTarget) {
      const target = options.appendTarget;
      const draft = savedDestinationDraft.current.issues;
      next.appendTo = draft?.projectId === target.projectId ? draft : defaultAppendMapping(options, target);
    } else if (mode === 'append-pages' && options.appendPagesTarget) {
      const { projectId } = options.appendPagesTarget;
      const draft = savedDestinationDraft.current.pages;
      next.appendPagesTo = draft?.projectId === projectId ? draft : { projectId };
    } else if (mode === 'new') {
      if (savedDestinationDraft.current.workflows) next.jiraWorkflows = savedDestinationDraft.current.workflows;
    } else {
      return;
    }
    change(next);
  }
  function changeJiraWorkflows(jiraWorkflows: NonNullable<MigrationConfiguration['jiraWorkflows']>) {
    if (!configuration) return;
    const next = { ...configuration };
    if (Object.keys(jiraWorkflows).length) next.jiraWorkflows = jiraWorkflows;
    else delete next.jiraWorkflows;
    change(next);
  }
  async function loadOptions() {
    if (configuration && !window.confirm('기존 이관 매핑과 미리보기를 선택한 패키지의 기본값으로 바꿀까요? 요청에 실패하면 현재 입력은 유지됩니다.')) return;
    await execute('매핑 불러오는 중…', async () => {
      const params = new URLSearchParams();
      selected.forEach(id => params.append('packageId', id));
      const result = await api<MigrationOptions>(`/migrations/options?${params}`, { headers: { 'X-Actor-Id': actorId } });
      if (active.current) {
        savedDestinationDraft.current = {};
        setOptions(result);
        change(structuredClone(result.defaultConfiguration));
      }
    });
  }
  const mode = destinationMode(configuration), reviewMode = destinationMode(preview?.configuration);
  const reviewProduct = refreshProduct(preview?.configuration);
  const noRefreshChanges = reviewProduct && preview?.notices.some(notice => notice.code === refreshNoChanges[reviewProduct]);
  const preservedEdits = (preview?.counts.conflictingFields ?? 0) + (preview?.counts.conflictingCustomFields ?? 0) +
    (preview?.counts.conflictingDocumentFields ?? 0);
  const reviewHeading = preview?.canApply ? '검토 후 적용할 수 있습니다'
    : noRefreshChanges ? preservedEdits > 0 ? '보존할 팀 편집이 있습니다' : `적용할 ${reviewProduct} 변경이 없습니다`
    : '적용을 막는 항목을 해결하세요';
  const appendTo = configuration?.appendTo, appendPagesTo = configuration?.appendPagesTo;
  const appendTarget = options?.appendTarget, appendPagesTarget = options?.appendPagesTarget;
  const issueDestination = appendTo && appendTo.projectId === appendTarget?.projectId ? appendTarget : undefined;
  const pageDestination = appendPagesTo && appendPagesTo.projectId === appendPagesTarget?.projectId ? appendPagesTarget : undefined;
  const existingDestination = issueDestination ?? pageDestination;
  const matching = Boolean(configuration && sameIds(selected, configuration.packageIds)), expired = Boolean(preview && Date.parse(preview.expiresAt) <= clock);
  const confluenceSourceReview = matching && options?.confluenceReviews?.length ? <ConfluenceSourceReview
    reviews={options.confluenceReviews} coverage={options.confluenceReviewCoverage}
    packages={packages.filter(item => selected.includes(item.id))} /> : null;
  const destinationReady = mode === 'new' ? Boolean(configuration?.projects.length) : Boolean(existingDestination);
  const previewDraftKey = preview ? `${preview.id}:${preview.version}` : null;
  const planningChanges = planningDraft?.key === previewDraftKey ? planningDraft.selections : undefined;
  const changedReviews = jiraPlanningReviews.filter(({ selections }) => planningChanges?.[selections]);
  const hasPlanningChanges = changedReviews.length > 0;
  const observedChoices = observedDraft?.key === previewDraftKey ? observedDraft.selected : noObservedChoices;
  const hasObservedChanges = observedChoices.size > 0;
  const hasReviewChanges = hasPlanningChanges || hasObservedChanges;
  const combinedPlanningChanges = changedReviews.length > 1;
  const canApply = Boolean(preview?.canApply && matching && !expired && !hasReviewChanges && !preview.notices.some(item => item.severity === 'error') && preview.requiredAcknowledgements.every(code => acknowledgements.includes(code)));
  async function readIdentityRoster(signal?: AbortSignal) {
    const users = await api<User[]>('/migrations/identity-roster', { signal, headers: { 'X-Actor-Id': actorId } });
    if (active.current && !signal?.aborted) setIdentityRoster({ snapshot: data.users, users });
    return users;
  }
  async function openEmailReview(opener: HTMLButtonElement) {
    if (!configuration || !options || !matching || hasReviewChanges) return;
    setIdentityNotice('');
    await execute('일치하는 팀원 이메일 확인 중…', async () => {
      const users = await readIdentityRoster();
      if (active.current) setEmailReview({ opener, rows: identitySuggestionRows(options, users, configuration.users) });
    });
    requestAnimationFrame(() => { if (document.activeElement === document.body && opener.isConnected) opener.focus({ preventScroll: true }); });
  }
  function applyEmailMatches(matches: readonly IdentitySuggestionRow[]) {
    if (!configuration || !matching || !matches.length) return;
    const users = { ...configuration.users };
    for (const { identity, user } of matches) users[identity.id] = user.id;
    change({ ...configuration, users });
    setEmailReview(null);
    setIdentityNotice(`이메일이 일치하는 사용자 매핑 ${matches.length.toLocaleString()}건을 반영했습니다. 새 미리보기를 만들어 주세요.`);
  }
  function choosePlan(field: JiraPlanningSelection, recordId: string, selection: string | null | undefined) {
    if (!preview || !previewDraftKey || hasObservedChanges || busyRef.current) return;
    const reviewed = preview.configuration[field]?.[recordId];
    setPlanningDraft(previous => {
      const selections = { ...(previous?.key === previewDraftKey ? previous.selections : undefined) };
      const draft = { ...selections[field] };
      if (selection === undefined || selection === reviewed) delete draft[recordId];
      else draft[recordId] = selection;
      if (Object.keys(draft).length) selections[field] = draft;
      else delete selections[field];
      return { key: previewDraftKey, selections };
    });
  }
  function stagePlanningChoices() {
    if (!configuration || !matching || !hasPlanningChanges || hasObservedChanges || busyRef.current) return;
    const next = { ...configuration };
    for (const { selections } of changedReviews) next[selections] = { ...next[selections], ...planningChanges?.[selections] };
    change(next);
    requestAnimationFrame(() => previewButton.current?.focus());
  }
  function chooseObservedTransition(id: string, checked: boolean) {
    if (!previewDraftKey || !matching || expired || hasPlanningChanges || busyRef.current) return;
    setObservedDraft(previous => {
      const selected = new Set(previous?.key === previewDraftKey ? previous.selected : undefined);
      if (checked) selected.add(id);
      else selected.delete(id);
      return selected.size ? { key: previewDraftKey, selected } : null;
    });
  }
  function stageObservedWorkflows(workflows: NonNullable<MigrationConfiguration['jiraWorkflows']>, count: number) {
    if (!preview || !matching || mode !== 'new' || reviewMode !== 'new' || hasPlanningChanges || busyRef.current ||
        Date.parse(preview.expiresAt) <= Date.now()) return;
    changeJiraWorkflows(workflows);
    requestAnimationFrame(() => previewButton.current?.focus());
    notify(`전이 ${count.toLocaleString()}개를 매핑에 추가했습니다. 적용 전 미리보기를 다시 만들어 주세요.`);
  }
  async function createPreview() {
    if (!configuration || !matching || !destinationReady || hasReviewChanges) return;
    await execute('미리보기 생성 중…', async () => {
      const result = await post<MigrationPreview>('/migrations/preview', { configuration });
      if (!active.current) return;
      setIdentityNotice('');
      setPreview(result);
      if (result.canApply) {
        const reviewed = structuredClone(result.configuration);
        setConfiguration(destinationMode(reviewed) !== 'new' ? {
          ...reviewed, projects: configuration.projects, statuses: configuration.statuses,
          issueTypes: configuration.issueTypes, fields: configuration.fields,
        } : reviewed);
      }
      setAcknowledgements([]);
      setClock(Date.now());
    });
  }
  function changeExclusions(excludedRecords: string[]) {
    if (!configuration) return;
    const next = { ...configuration, excludedRecords };
    const excluded = new Set(excludedRecords);
    for (const { selections } of jiraPlanningReviews) {
      const current = next[selections];
      if (!current) continue;
      const remaining = Object.entries(current).filter(([recordId]) => !excluded.has(recordId));
      if (remaining.length) next[selections] = Object.fromEntries(remaining);
      else delete next[selections];
    }
    change(next);
  }
  function stageExclusions(recordIds: readonly string[]) {
    if (!preview || !configuration || !matching || hasReviewChanges || busyRef.current) return;
    const excludedRecords = [...new Set([...configuration.excludedRecords, ...recordIds])];
    const added = excludedRecords.length - configuration.excludedRecords.length;
    if (added <= 0) return;
    if (excludedRecords.length > 100_000) {
      notify('한 이관에서 제외할 원본은 최대 100,000개입니다.', 'error');
      return;
    }
    changeExclusions(excludedRecords);
    previewButton.current?.focus();
    notify(`원본 ${added.toLocaleString()}개를 제외로 지정했습니다. 적용 전 미리보기를 다시 만드세요.`);
  }
  function downloadPreflight() {
    if (!preview || hasReviewChanges || busyRef.current) return;
    const report = buildMigrationPreflightReport(preview, options?.packages ?? packages);
    downloadDocument(`migration-preflight-${preview.id}.json`, JSON.stringify(report, null, 2), 'application/json;charset=utf-8');
  }
  async function exportMapping(opener: HTMLButtonElement) {
    if (!configuration || !matching || hasReviewChanges || busyRef.current) return;
    await execute('이관 매핑 파일 준비 중…', async () => {
      const file = await post<MigrationMappingFile>('/migrations/mapping/export', { configuration });
      if (!active.current) return;
      downloadDocument('teamspace-migration-mapping.json', JSON.stringify(file), 'application/json;charset=utf-8');
      setMappingNotice('이관 매핑 JSON을 내려받았습니다.');
    });
    requestAnimationFrame(() => { if (opener.isConnected && document.activeElement === document.body) opener.focus({ preventScroll: true }); });
  }
  async function importMapping(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file || hasReviewChanges || busyRef.current) return;
    await execute('이관 매핑 파일 확인 중…', async () => {
      if (file.size > MIGRATION_MAPPING_FILE_MAX_BYTES) {
        throw new Error(`이관 매핑 파일은 ${MIGRATION_MAPPING_FILE_MAX_BYTES / (1024 * 1024)}MiB 이하로 선택해 주세요.`);
      }
      let mapping: unknown;
      try { mapping = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())); }
      catch { throw new Error('이관 매핑 JSON 파일을 읽을 수 없습니다.'); }
      if (!active.current) return;
      const result = await post<MigrationMappingRestore>('/migrations/mapping/import', { mapping });
      if (!active.current) return;
      const restored = result.configuration;
      const defaults = result.options.defaultConfiguration;
      const packageIds = [...restored.packageIds];
      const verified = new Map(result.options.packages.map(item => [item.id, item]));
      const next = destinationMode(restored) === 'new' ? restored : {
        ...restored,
        projects: restored.projects.length ? restored.projects : defaults.projects,
        statuses: Object.keys(restored.statuses).length ? restored.statuses : defaults.statuses,
        issueTypes: Object.keys(restored.issueTypes).length ? restored.issueTypes : defaults.issueTypes,
        fields: Object.keys(restored.fields).length ? restored.fields : defaults.fields,
      };
      if ((selected.length || configuration || preview) &&
        !window.confirm('현재 패키지 선택과 이관 매핑 및 미리보기를 파일의 매핑으로 바꿀까요?')) return;
      setPackages(previous => [...verified.values(), ...previous.filter(item => !verified.has(item.id))]);
      setSelected(packageIds);
      setOptions(result.options);
      savedDestinationDraft.current = {};
      change(next);
      dirtyRef.current = true;
      setMappingNotice('이관 매핑을 불러왔습니다. 적용 전 미리보기를 새로 만들어 주세요.');
      void load();
    });
    requestAnimationFrame(() => { if (input.isConnected && document.activeElement === document.body) input.focus({ preventScroll: true }); });
  }
  async function apply() {
    if (!preview || !canApply || busyRef.current) return;
    const confirmation = reviewProduct
      ? `검토한 ${reviewProduct} 이관을 적용할까요? ${refreshSummary(reviewProduct, preview.counts)}`
      : reviewMode === 'new' ? '검토한 미리보기대로 새 프로젝트와 업무·문서를 실제 생성할까요? 적용 결과는 이관 영수증으로 보관됩니다.' : appendLabels[reviewMode].confirm;
    if (!window.confirm(confirmation)) return;
    await execute('실제 이관 적용 중…', async () => {
      const result = await post<MigrationApplyResult>(`/migrations/previews/${encodeURIComponent(preview.id)}/apply`, { expectedVersion: preview.version, acknowledgements });
      if (!active.current) return;
      ++loadSequence.current;
      receiptToFocus.current = result.import.id;
      setImports(previous => [result.import, ...previous.filter(item => item.id !== result.import.id)]);
      setSelectedImport(result.import.id);
      reset();
      const success = reviewProduct ? `${reviewProduct} 이관을 적용했습니다. ${refreshSummary(reviewProduct, result.import.counts)}`
        : reviewMode === 'new' ? '이관을 완료했습니다. 새 프로젝트와 원본 기록을 확인하세요.' : appendLabels[reviewMode].success;
      notify(result.duplicate ? '이미 완료한 이관 영수증을 열었습니다.' : success);
      try { await props.refresh(); } catch { notify('이관은 완료했습니다. 프로젝트 목록 새로고침을 다시 시도하세요.', 'error'); }
      await load();
    });
  }
  const receipt = imports.find(item => item.id === selectedImport);
  useEffect(() => {
    if (receipt?.id !== receiptToFocus.current || !receiptHeading.current) return;
    receiptToFocus.current = null;
    receiptHeading.current.focus();
  }, [receipt]);
  function selectReceipt(id: string) {
    if (id === selectedImport) {
      receiptHeading.current?.focus();
      return;
    }
    receiptToFocus.current = id;
    setSelectedImport(id);
  }
  const receiptMode = destinationMode(receipt?.configuration);
  const receiptProduct = refreshProduct(receipt?.configuration);
  const receiptLinkCounts = receipt ? Object.entries(receipt.counts).filter(([key]) => Object.hasOwn(sourceLinkCountLabels, key)) : [];
  const receiptDetailCounts = receiptMode === 'new' && receipt ? Object.entries(receipt.counts).filter(([key]) =>
    Object.hasOwn(jiraPlanningCountLabels, key) || Object.hasOwn(documentOrderCountLabels, key) || Object.hasOwn(confluenceInlineCommentCountLabels, key)) : [];
  return <section className="card migration-apply" aria-label="실제 데이터 이관">
    <header className="migration-heading"><div><h2 ref={migrationHeading} tabIndex={-1}><ArchiveRestore size={21} />실제 데이터 이관</h2><p>분석한 Jira·Confluence 패키지를 매핑하고 적용할 대상을 미리 확인합니다.</p></div><button className="btn btn-ghost" disabled={loading || Boolean(pending)} onClick={() => void load()} aria-label="이관 원본·영수증 새로고침"><RefreshCw size={16} />새로고침</button></header>
    <p className="migration-info">원본 작성자·키·시각·변경 이력은 별도 원본 기록으로 보존하고, 현재 서비스의 작성자는 지정한 사용자 또는 이관 실행자를 사용합니다.</p>
    {listError && <p className="migration-error" role="alert">{listError} 현재 매핑과 미리보기는 유지됩니다.</p>}{error && <p className="migration-error" role="alert">{error}</p>}{pending && <p role="status" className="migration-pending"><Loader2 className="spin" size={17} />{pending}</p>}
    <fieldset className="migration-fieldset migration-mapping-files" aria-label="이관 매핑 파일" disabled={Boolean(pending) || hasReviewChanges}>
      <div className="migration-mapping-file-actions">
        <label>이관 매핑 파일 불러오기
          <input type="file" className="field" accept=".json,application/json" aria-describedby={mappingFileHelp}
            onChange={event => void importMapping(event.currentTarget)} />
        </label>
        <button type="button" className="btn" disabled={!configuration || !matching}
          onClick={event => void exportMapping(event.currentTarget)}><Download size={16} aria-hidden="true" />이관 매핑 JSON 내보내기</button>
      </div>
      <small id={mappingFileHelp}>같은 원본 패키지를 분석한 뒤 매핑을 불러와 새 미리보기를 만드세요.</small>
      {hasPlanningChanges && <small>계획 선택을 반영하거나 취소한 뒤 매핑 파일을 사용할 수 있습니다.</small>}
    </fieldset>
    {mappingNotice && <p role="status" className="migration-mapping-file-notice">{mappingNotice}</p>}
    <fieldset disabled={Boolean(pending) || hasReviewChanges} className="migration-fieldset"><h3>가져올 원본</h3>
      <Paged title="이관 패키지" items={packages} label={item => `${item.filename} ${item.source.instanceKey}`} render={item => <label className="migration-package"><input type="checkbox" aria-label={`이관 패키지 ${item.filename}`} checked={selected.includes(item.id)} onChange={event => { setSelected(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id)); setPreview(null); setAcknowledgements([]); setMappingNotice(''); setIdentityNotice(''); }} /><span><strong>{item.filename}</strong><small>{item.source.product} · {item.source.instanceKey} · 분석 오류 {item.errors}, 경고 {item.warnings}</small></span></label>} />
      {!loading && !packages.length && <p>먼저 위의 원본 분석에서 내보내기 파일을 등록하세요.</p>}
      {selected.some(id => !packages.some(item => item.id === id)) && <p className="migration-error" role="alert">선택한 패키지 일부가 최신 목록에 없습니다. 현재 입력을 유지했으므로 원본 목록을 다시 확인하세요.</p>}
      {selected.length > 0 && <p role="status">이관 패키지 {selected.length.toLocaleString()}개 선택</p>}
      <button className="btn" disabled={!selected.length} onClick={() => void loadOptions()}>선택 패키지 매핑 불러오기</button>
      {configuration && options && <div className="migration-mappings" aria-label="이관 매핑">
        {!matching && <p className="migration-error" role="alert">패키지 선택이 변경되었습니다. 매핑을 다시 불러와야 미리보기를 만들 수 있습니다.</p>}
        {(appendTarget || appendPagesTarget) && <label className="migration-destination-mode">이관 방식
          <select className="field" aria-label="이관 방식" value={mode} onChange={event => chooseDestination(event.target.value)}>
            <option value="new">새 프로젝트 생성</option>
            {appendTarget && <option value="append">기존 프로젝트에 새 Jira 업무 추가</option>}
            {appendPagesTarget && <option value="append-pages">기존 프로젝트에 새 Confluence 문서 추가</option>}
          </select>
        </label>}
        {existingDestination && <section className="migration-append-project" aria-label="추가할 기존 프로젝트">
          <h3>추가할 기존 프로젝트</h3>
          <p><strong>{existingDestination.key} · {existingDestination.name}</strong>
            {issueDestination && <small>Jira {issueDestination.instanceKey} · 원본 프로젝트 {issueDestination.sourceProjectId}</small>}
            {pageDestination && <small>Confluence {pageDestination.instanceKey} · 원본 공간 {pageDestination.sourceSpaceKey || pageDestination.sourceSpaceId}</small>}
          </p>
          {issueDestination && <p>현재 프로젝트의 상태·유형·속성에 새 업무를 연결합니다. 이미 이관한 업무가 겹치면 미리보기에 표시합니다.</p>}
          {appendTo && issueDestination && <RefreshOption value={appendTo} onChange={next => change({ ...configuration, appendTo: next })} label="기존 Jira 업무 변경분 반영">
            제목, 상태, 담당자 등 기본 필드의 원본 변경을 검토합니다. 팀에서 편집한 값과 이전 값을 확인할 수 없는 필드는 유지합니다.
          </RefreshOption>}
          {appendTo && issueDestination && options.fields.length > 0 && <RefreshOption value={appendTo} option="refreshCustomFields" onChange={next => change({ ...configuration, appendTo: next })} label="기존 Jira 업무의 사용자 정의 속성 변경분 반영">
            아래 속성 매핑에 따라 변경된 원본 값을 비교합니다. 팀에서 편집한 값과 이전 값을 확인할 수 없는 속성은 유지합니다.
          </RefreshOption>}
          {appendTo && issueDestination && <RefreshOption value={appendTo} option="refreshHistory" onChange={next => change({ ...configuration, appendTo: next })} label="기존 Jira 업무에 댓글과 작업 시간 기록 추가">
            사용자 매핑에서 지정한 팀원을 작성자로 연결합니다. 작성자를 확인하기 어려운 기록은 원본에 보관합니다.
          </RefreshOption>}
          {appendTo && issueDestination && <RefreshOption value={appendTo} option="refreshAttachments" onChange={next => change({ ...configuration, appendTo: next })} label="기존 Jira 업무에 첨부파일 추가">
            원본 ID와 파일 내용을 확인해 첨부파일을 추가합니다. 패키지에 파일이 누락된 경우 원본 정보가 보존됩니다.
          </RefreshOption>}
          {appendTo && issueDestination && <RefreshOption value={appendTo} option="refreshRelations" onChange={next => change({ ...configuration, appendTo: next })} label="기존 Jira 업무 사이의 새 관계 추가">
            같은 Jira 인스턴스에서 이관한 업무의 원본 관계를 검토합니다. 별도로 이관한 프로젝트 간 관계도 포함됩니다.
          </RefreshOption>}
          {appendPagesTo && pageDestination && <RefreshOption value={appendPagesTo} onChange={next => change({ ...configuration, appendPagesTo: next })} label="기존 Confluence 문서 변경분 반영">
            최신 원본의 제목·본문·라벨·상위 문서를 현재 문서와 비교합니다. 팀에서 바꾼 값은 유지하고, 원본 전체 목록을 확인한 경우에만 라벨을 삭제할 수 있습니다.
          </RefreshOption>}
          {appendPagesTo && pageDestination && <RefreshOption value={appendPagesTo} option="refreshAttachments" onChange={next => change({ ...configuration, appendPagesTo: next })} label="기존 Confluence 문서에 첨부와 버전 추가">
            새 첨부와 원본 파일의 새 버전을 검토합니다. 팀이 올린 버전은 현재 파일로 유지합니다.
          </RefreshOption>}
          {appendPagesTo && pageDestination && <RefreshOption value={appendPagesTo} option="refreshHistory" onChange={next => change({ ...configuration, appendPagesTo: next })} label="기존 Confluence 문서에 댓글과 변경 이력 추가">
            새 댓글을 추가하고 과거 원본 버전을 문서 변경 이력에 보관합니다.
          </RefreshOption>}
        </section>}
        {mode === 'new' && <><h3>새 프로젝트</h3><p>프로젝트 키와 이름을 지정하세요. 여러 원본 컨테이너에 같은 키·이름을 지정하면 하나로 합칩니다.</p>
        <Paged title="프로젝트 매핑" items={options.containers} label={item => `${item.name} ${item.proposedKey}`} render={item => { const project = configuration.projects.find(value => value.containerId === item.id); if (!project) return <p className="migration-error">기본 매핑에 없는 컨테이너입니다: {item.name}</p>; return <div className="migration-project-row"><div><strong>{item.name}</strong><small>업무 {item.issueCount} · 문서 {item.documentCount}</small></div><label>새 프로젝트 키<input className="field" aria-label={`새 프로젝트 키 ${item.name}`} value={project.key} maxLength={12} onChange={event => change({ ...configuration, projects: configuration.projects.map(value => value.containerId === item.id ? { ...value, key: event.target.value } : value) })} /></label><label>새 프로젝트 이름<input className="field" aria-label={`새 프로젝트 이름 ${item.name}`} value={project.name} maxLength={100} onChange={event => change({ ...configuration, projects: configuration.projects.map(value => value.containerId === item.id ? { ...value, name: event.target.value } : value) })} /></label></div>; }} />
        </>}
        <div className="migration-date-grid"><label>원본 시간대<input className="field" aria-label="이관 원본 시간대" value={configuration.timezone} list="migration-timezones" onChange={event => change({ ...configuration, timezone: event.target.value })} maxLength={100} /><datalist id="migration-timezones"><option value="Asia/Seoul" /><option value="UTC" /></datalist></label><label>날짜가 없거나 해석할 수 없을 때<select className="field" aria-label="이관 날짜 처리" value={configuration.datePolicy} onChange={event => change({ ...configuration, datePolicy: event.target.value as MigrationConfiguration['datePolicy'] })}><option value="block">적용 차단 후 검토</option><option value="import-time">현재 항목에는 이관 시각 사용 · 원본 값 별도 보존</option></select></label></div>
        <MappingSection title="사용자 매핑">
          <p>원본 신원만 보존하면 현재 항목의 작성자는 이관 실행자로 지정됩니다.{mode !== 'append-pages' && ' Jira 작업 시간은 매핑된 작성자에게 집계합니다. 작성자를 매핑하지 않은 작업 시간은 원본 기록에 보관합니다.'}</p>
          {options.identities.length > 0 && <button className="btn" type="button" disabled={!matching}
            onClick={event => void openEmailReview(event.currentTarget)}>이메일 일치 후보 검토</button>}
          {identityNotice && <p role="status" className="migration-mapping-file-notice">{identityNotice}</p>}
          <Paged title="사용자 매핑" items={options.identities} label={item => `${item.label} ${item.email ?? item.emailEvidence?.email ?? ''}`} render={item => {
            const userId = configuration.users[item.id] ?? '';
            return <MappingRow label={item.label} detail={item.email ?? item.emailEvidence?.email ?? item.sourceValue}>
              <select className="field" aria-label={`사용자 매핑 ${item.label}`} value={userId}
                onChange={event => mapValue('users', item.id, event.target.value || null)}>
                <option value="">원본 신원만 보존 · 실행자 사용</option>
                {userId && !teamUsers.some(user => user.id === userId) && <option value={userId}>현재 사용자 목록에 없음 · {userId}</option>}
                {teamUsers.map(user => <option value={user.id} key={user.id}>{user.name} · {user.email}</option>)}
              </select>
            </MappingRow>;
          }} />
        </MappingSection>
        {appendTo && issueDestination && <AppendMappings options={options} target={issueDestination} value={appendTo} onChange={next => change({ ...configuration, appendTo: next })} />}
        {mode === 'new' && <>
        <MappingSection title="상태 매핑"><Paged title="상태 매핑" items={options.statuses} label={item => item.label} render={item => <MappingRow label={item.label} detail={item.sourceValue}><select className="field" aria-label={`상태 매핑 ${item.label}`} value={configuration.statuses[item.id] || 'todo'} onChange={event => mapValue('statuses', item.id, event.target.value as StatusCategory)}>{Object.entries(categoryLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></MappingRow>} /></MappingSection>
        {Boolean(options.jiraWorkflowStatuses?.length || configuration.jiraWorkflows) && <MappingSection title="Jira 워크플로 매핑">
          <MigrationJiraWorkflowEditor options={options} configuration={configuration} onChange={changeJiraWorkflows} />
        </MappingSection>}
        <MappingSection title="업무 유형 매핑"><Paged title="업무 유형 매핑" items={options.issueTypes} label={item => item.label} render={item => <MappingRow label={item.label} detail={item.sourceValue}><select className="field" aria-label={`유형 매핑 ${item.label}`} value={configuration.issueTypes[item.id] ?? ''} onChange={event => mapValue('issueTypes', item.id, event.target.value || null)}><option value="">원본 유형을 새 유형으로 생성</option>{ISSUE_TYPES.map(type => <option value={type} key={type}>{type}</option>)}</select></MappingRow>} /></MappingSection>
        <MappingSection title="사용자 정의 속성 매핑"><p>선택한 원본 속성을 업무 양식에 추가할 수 있습니다. 변환할 값이 선택한 종류와 맞지 않으면 미리보기에서 알립니다.</p><Paged title="속성 매핑" items={options.fields} label={item => item.label} render={item => <MappingRow label={item.label} detail={sourceMappingDetail(item)}><select className="field" aria-label={`속성 매핑 ${item.label}`} value={configuration.fields[item.id] || 'archive'} onChange={event => mapValue('fields', item.id, event.target.value as CustomFieldKind | 'archive')}>{Object.entries(fieldLabels).filter(([id]) => !item.requiredKind || id === item.requiredKind || id === 'archive').map(([id, label]) => <option key={id} value={id}>{id === 'archive' && item.projectedDate ? '일정과 원본 기록에 반영' : label}</option>)}</select></MappingRow>} /></MappingSection>
        </>}
        <MappingSection title="원본 주소와 제외 항목">
          <p>패키지별 원본 사이트 주소를 입력할 수 있습니다. 별도 설치 경로가 있는 서버는 그 경로까지 입력하세요.</p>
          <p>Jira의 원본 업무 키와 Confluence의 현재 페이지 ID를 사용합니다. 생성된 링크는 이관한 업무와 문서의 <strong>기존 도구 연결</strong>에서 확인할 수 있습니다. 이 주소는 문서 본문 링크의 출처를 확인할 때도 사용합니다.</p>
          <Paged title="원본 주소" items={options.packages} label={item => item.filename} render={item => <MappingRow label={item.filename} detail={item.source.instanceKey}>
            <label>원본 사이트 주소 (선택)
              <input className="field" aria-label={`원본 주소 ${item.filename}`} type="url" spellCheck={false}
                placeholder={item.source.product === 'jira' ? 'https://jira.example.test/jira' : 'https://wiki.example.test/confluence'}
                value={configuration.sourceBaseUrls[item.id] || ''} maxLength={4000} onChange={event => mapValue('sourceBaseUrls', item.id, event.target.value || null)} />
            </label>
          </MappingRow>} />
          <Exclusions key={configuration.packageIds.join('|')} packageIds={configuration.packageIds} packages={options.packages} excluded={configuration.excludedRecords} onChange={changeExclusions} />
        </MappingSection>
        {!preview && confluenceSourceReview}
        <button ref={previewButton} className="btn btn-primary" disabled={!matching || !destinationReady} onClick={() => void createPreview()}><FileCheck2 size={17} />적용 전 미리보기 만들기</button>
      </div>}
    </fieldset>
    {emailReview && options && configuration && <MigrationEmailReview
      {...emailReview} options={options} mappings={configuration.users} readRoster={readIdentityRoster}
      onApply={applyEmailMatches} onClose={() => setEmailReview(null)} />}
    {preview && <section className="migration-review" aria-label="이관 적용 미리보기">
      <header>
        <div><h3>{reviewHeading}</h3><p>만료 {timestamp(preview.expiresAt)} · 버전 {preview.version} · 생성 당시 고정된 결과</p></div>
        <div className="migration-review-actions">
          <button type="button" className="btn btn-ghost" disabled={Boolean(pending) || hasReviewChanges} onClick={() => void execute('미리보기 확인 중…', async () => { const latest = await api<MigrationPreview>(`/migrations/previews/${encodeURIComponent(preview.id)}`); if (active.current) { setPreview(latest); setClock(Date.now()); } })}>검토 결과 다시 확인</button>
          <button type="button" className="btn btn-ghost" disabled={Boolean(pending) || hasReviewChanges} onClick={downloadPreflight}><Download size={16} aria-hidden="true" />이관 사전 검토 JSON 내보내기</button>
        </div>
      </header>
      {confluenceSourceReview}
      <MigrationCounts entries={Object.entries(preview.counts)} mode={reviewMode} />
      <Paged title={reviewProduct ? `${reviewProduct} 이관을 적용할 프로젝트` : reviewMode === 'new' ? '생성할 프로젝트' : `${appendLabels[reviewMode].item}를 추가할 프로젝트`} items={preview.projects} label={item => `${item.key} ${item.name}`} render={item => <p><strong>{item.key} · {item.name}</strong> · {reviewProduct ? refreshSummary(reviewProduct, preview.counts) || '적용할 변경 없음' : reviewMode === 'append' ? `새 업무 ${item.issueCount}` : reviewMode === 'append-pages' ? `새 문서 ${item.documentCount}` : `업무 ${item.issueCount} · 문서 ${item.documentCount}`}</p>} />
      {Boolean(preview.jiraWorkflows?.length) && <MigrationJiraWorkflowPreview workflows={preview.jiraWorkflows ?? []} />}
      {mode === 'new' && reviewMode === 'new' && preview.jiraObservedWorkflows?.length ? <MigrationJiraObservedWorkflowReview
        key={`observed:${preview.id}:${preview.version}`} workflows={preview.jiraObservedWorkflows} drafts={configuration?.jiraWorkflows}
        disabled={Boolean(pending) || !matching || expired || hasPlanningChanges} selected={observedChoices} onChoose={chooseObservedTransition}
        onClear={() => setObservedDraft(null)} onAdopt={stageObservedWorkflows} /> : null}
      {jiraPlanningReviews.map(({ choices, selections, label, original }) => {
        const rows = preview[choices];
        if (!rows?.length) return null;
        return <JiraPlanningReview key={`${preview.id}:${preview.version}:${choices}`} rows={rows} label={label} original={original}
          disabled={Boolean(pending) || !matching || hasObservedChanges}
          reviewed={preview.configuration[selections]} changes={planningChanges?.[selections]}
          onChoose={(recordId, choice) => choosePlan(selections, recordId, choice)}
          actions={!combinedPlanningChanges ? <>
            <div className="migration-review-actions">
              <button type="button" className="btn" disabled={!planningChanges?.[selections]} onClick={stagePlanningChoices}>{`선택한 ${label}로 다시 검토`}</button>
              {planningChanges?.[selections] && <button type="button" className="btn btn-ghost" onClick={() => setPlanningDraft(null)}>{`${label} 선택 변경 취소`}</button>}
            </div>
            {planningChanges?.[selections] && <small role="status">{`새 미리보기에서 바꾼 ${label} 연결을 확인한 후 적용하세요.`}</small>}
          </> : undefined} />;
      })}
      {combinedPlanningChanges && <fieldset className="migration-fieldset migration-review-diagnostics" disabled={Boolean(pending) || !matching || hasObservedChanges}>
        <legend>사이클·릴리스 연결 변경</legend>
        <div className="migration-review-actions">
          <button type="button" className="btn" onClick={stagePlanningChoices}>선택한 사이클·릴리스로 다시 검토</button>
          <button type="button" className="btn btn-ghost" onClick={() => setPlanningDraft(null)}>사이클·릴리스 선택 변경 취소</button>
        </div>
        <small role="status">새 미리보기에서 사이클과 릴리스 연결을 함께 확인한 후 적용하세요.</small>
      </fieldset>}
      {preview.authorAttribution && preview.authorAttribution.length > 0 && <MigrationAuthorPreview groups={preview.authorAttribution} packages={options?.packages ?? packages} />}
      <MigrationReviewDetails key={`${preview.id}:${preview.version}`} preview={preview} packages={options?.packages ?? packages} actorId={actorId} busy={Boolean(pending) || hasReviewChanges} onExclude={stageExclusions} />
      <MappingSection title="변환된 내용 견본"><Paged title="이관 내용 견본" items={preview.samples} label={item => item.title} render={item => <div className="migration-sample">
        <strong>{item.targetType === 'issue' ? '업무' : '문서'} · {item.title}</strong>
        {item.schedule && <p>일정 · {item.schedule.startDate ?? '시작일 미정'} ~ {item.schedule.endDate ?? '종료일 미정'}</p>}
        {item.sourceUrl && <p className="migration-sample-source"><small>연결할 원본 주소</small><code>{item.sourceUrl}</code></p>}
        <pre>{item.plainText.slice(0, 2000)}</pre>{item.plainText.length > 2000 && <small>견본은 2,000자까지 표시합니다. 원본 기록에는 전체 원문을 보존합니다.</small>}
      </div>} /></MappingSection>
      {expired && <p className="migration-error" role="alert">이 미리보기가 만료되었습니다. 매핑을 유지한 채 새 미리보기를 만드세요.</p>}
      <fieldset disabled={Boolean(pending)} className="migration-fieldset"><div className="migration-acknowledgements" aria-label="이관 필수 확인">{preview.requiredAcknowledgements.map(code => <label key={code}><input type="checkbox" aria-label={`이관 확인 ${code}`} checked={acknowledgements.includes(code)} onChange={event => setAcknowledgements(previous => event.target.checked ? [...previous, code] : previous.filter(value => value !== code))} /><span>{preview.notices.find(item => item.code === code)?.message || code}<small>{code}</small></span></label>)}</div><button className="btn btn-primary" disabled={!canApply} onClick={() => void apply()}><CheckCircle2 size={17} />검토한 이관 실제 적용</button></fieldset>
    </section>}
    <section className="migration-receipts" aria-label="완료한 이관 영수증"><h3>완료한 이관</h3><Paged title="이관 영수증" items={imports} label={item => `${item.id} ${item.packages.map(value => value.filename).join(' ')}`} render={item => <button type="button" className={`migration-receipt ${selectedImport === item.id ? 'is-selected' : ''}`} aria-pressed={selectedImport === item.id} onClick={() => selectReceipt(item.id)}><strong>{item.packages.map(value => value.filename).join(' + ')}</strong><span>{timestamp(item.createdAt)} · {item.projectIds.length}개 프로젝트</span><small>{item.id}</small></button>} />{!imports.length && !loading && <p>아직 적용을 완료한 이관이 없습니다.</p>}
      {receipt && <div aria-label="이관 영수증 상세">
        <h4 ref={receiptHeading} tabIndex={-1} className="migration-receipt-heading">{receiptProduct ? `기존 프로젝트의 ${receiptProduct} 이관 결과` : receiptMode === 'new' ? '원본 기록과 생성 프로젝트' : `원본 기록과 ${appendLabels[receiptMode].item}를 추가한 프로젝트`}</h4>
        <p>이관 실행자 {data.users.find(user => user.id === receipt.actorId)?.name || receipt.actorId}</p>
        <MigrationReceiptFindings key={`findings:${receipt.id}:${receipt.version}`} receipt={receipt} />
        {receiptMode !== 'new' && <MigrationCounts entries={Object.entries(receipt.counts).filter(([key]) => appendLabels[receiptMode].counts.includes(key))} mode={receiptMode} />}
        {receiptDetailCounts.length > 0 && <MigrationCounts entries={receiptDetailCounts} />}
        {receiptLinkCounts.length > 0 && <section className="migration-origin-summary" aria-label="이관 당시 원본 링크 집계">
          <MigrationCounts entries={receiptLinkCounts} />
          <small>이관 완료 시점의 집계입니다. 현재 링크는 업무와 문서의 기존 도구 연결에서 확인할 수 있습니다.</small>
        </section>}
        <Paged title={receiptProduct ? '기존 프로젝트 열기' : receiptMode === 'new' ? '생성한 프로젝트 열기' : `${appendLabels[receiptMode].item}를 추가한 프로젝트 열기`} items={receipt.projectIds} label={id => data.projects.find(item => item.id === id)?.name || id} render={id => <a className="btn migration-project-link" href={`#/${encodeURIComponent(id)}/overview`} aria-disabled={Boolean(pending)} onClick={event => { if (busyRef.current) event.preventDefault(); }}>{data.projects.find(item => item.id === id)?.name || id} 프로젝트 열기</a>} />
        <MigrationReconciliation key={`reconciliation:${receipt.id}:${receipt.version}`} sourceImportId={receipt.id} packages={receipt.packages} {...props} />
        <SourceImportRecords sourceImportId={receipt.id} />
      </div>}
    </section>
  </section>;
}

const receiptNoticeLabels: Record<MigrationNotice['severity'], string> = { warning: '경고', error: '오류', info: '안내' };
type ReceiptFinding = 'warning' | 'error';
type ReceiptNoticeSource = { index: number; opener: HTMLButtonElement };

function MigrationReceiptFindings({ receipt }: { receipt: SourceImport }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<{ severity: ReceiptFinding | ''; revision: number }>({ severity: '', revision: 0 });
  const [selectedSource, setSelectedSource] = useState<ReceiptNoticeSource | null>(null);
  const scopeHeading = useRef<HTMLHeadingElement>(null);
  const focusScope = useRef(false);
  const summaryId = useId();
  const diagnosticsId = useId();
  const notices = receipt.notices;
  const warningCount = notices?.filter(notice => notice.severity === 'warning').length ?? 0;
  const errorCount = notices?.filter(notice => notice.severity === 'error').length ?? 0;
  const explicit = receipt.counts.explicitExcludedRecords ?? receipt.configuration.excludedRecords.length;
  const excluded = receipt.counts.excludedRecords ?? explicit;
  const descendants = receipt.counts.excludedDescendants ?? Math.max(0, excluded - explicit);
  const scopedNotices = notices?.map((notice, index) => ({ notice, index }))
    .filter(({ notice }) => !scope.severity || notice.severity === scope.severity);
  const packageIds = new Set(receipt.packages.map(item => item.stagingId));

  function showDiagnostics(severity: ReceiptFinding | '') {
    focusScope.current = true;
    setScope(previous => ({ severity, revision: previous.revision + 1 }));
    setOpen(true);
  }
  useEffect(() => {
    if (!open || !focusScope.current || !scopeHeading.current) return;
    focusScope.current = false;
    scopeHeading.current.focus();
  }, [open, scope]);

  return <>
    <section className="migration-receipt-summary" aria-labelledby={summaryId}>
      <h5 id={summaryId}>이관 후속 확인</h5>
      <ul className="migration-receipt-findings">
        <li>제외한 원본 {excluded.toLocaleString()}건</li>
        {notices && <li>경고 {warningCount.toLocaleString()}건</li>}
        {errorCount > 0 && <li>오류 {errorCount.toLocaleString()}건</li>}
      </ul>
      {descendants > 0 && <small>직접 제외한 원본 {explicit.toLocaleString()}건 · 함께 제외된 하위 기록 {descendants.toLocaleString()}건</small>}
      {!notices && <p>적용 당시 진단이 저장되지 않았습니다.</p>}
      {notices && <small>이관 적용 시점의 기록입니다.</small>}
      {warningCount + errorCount > 0 && <div className="migration-review-actions">
        {warningCount > 0 && <button type="button" className="btn" aria-controls={diagnosticsId} onClick={() => showDiagnostics('warning')}>적용 당시 경고 보기</button>}
        {errorCount > 0 && <button type="button" className="btn" aria-controls={diagnosticsId} onClick={() => showDiagnostics('error')}>적용 당시 오류 보기</button>}
      </div>}
    </section>
    <details id={diagnosticsId} className="migration-advanced" open={open} onToggle={event => {
      const visible = event.currentTarget.open;
      setOpen(visible);
      if (!visible) setScope(previous => ({ severity: '', revision: previous.revision + 1 }));
    }}>
      <summary>검토한 이관 진단</summary>
      {open && <div>{scopedNotices ? <>
        <h5 className="migration-receipt-heading" ref={scopeHeading} tabIndex={-1}>
          {scope.severity ? `적용 당시 ${receiptNoticeLabels[scope.severity]}` : '적용 당시 진단'}
        </h5>
        <p>{scopedNotices.length.toLocaleString()}건</p>
        {scope.severity && <button type="button" className="btn btn-ghost" onClick={() => showDiagnostics('')}>전체 진단 보기</button>}
        <Paged key={scope.revision} title="영수증 이관 진단" items={scopedNotices} label={({ notice }) => `${notice.code} ${notice.message}`}
          render={({ notice, index }) => {
            const { recordId } = notice;
            const slash = recordId?.indexOf('/') ?? -1;
            const scopedSource = recordId && slash > 0 && slash < recordId.length - 1 && packageIds.has(recordId.slice(0, slash));
            return <div className={`migration-notice is-${notice.severity}`}>
              <strong>{receiptNoticeLabels[notice.severity]} · {notice.code}</strong>
              <p>{notice.message}</p>
              {recordId && <small>원본 항목 {recordId}</small>}
              {scopedSource && <button type="button" className="btn migration-source-button" aria-haspopup="dialog"
                onClick={event => setSelectedSource({ index, opener: event.currentTarget })}>
                <FileSearch size={15} aria-hidden="true" />보존 원본 보기
              </button>}
            </div>;
          }} />
        {!scopedNotices.length && <p>저장된 진단이 없습니다.</p>}
      </> : <p>이전 버전에서 만든 영수증이라 검토 진단이 별도로 저장되지 않았습니다. 원본 기록과 이관 설정을 확인하세요.</p>}</div>}
    </details>
    {selectedSource && <ReceiptNoticeSourceDialog key={selectedSource.index} receiptId={receipt.id} receiptVersion={receipt.version}
      {...selectedSource} onClose={() => setSelectedSource(null)} />}
  </>;
}

function ReceiptNoticeSourceDialog({ receiptId, receiptVersion, index, opener, onClose }:
  ReceiptNoticeSource & { receiptId: string; receiptVersion: number; onClose: () => void }) {
  const titleId = useId();
  const element = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ archive: SourceRecordArchive } | { error: string } | null>(null);

  useLayoutEffect(() => {
    const dialog = element.current;
    if (!dialog) return;
    dialog.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  useLayoutEffect(() => {
    if (response && 'archive' in response && !element.current?.contains(document.activeElement)) {
      heading.current?.focus({ preventScroll: true });
    }
  }, [response]);

  useEffect(() => {
    const request = new AbortController();
    const path = `/source-imports/${encodeURIComponent(receiptId)}/notices/${index}/source?expectedVersion=${receiptVersion}`;
    void api<SourceRecordArchive>(path, { cache: 'no-store', signal: request.signal })
      .then(archive => { if (!request.signal.aborted) setResponse({ archive }); })
      .catch(cause => { if (!request.signal.aborted) setResponse({ error: errorText(cause) }); });
    return () => request.abort();
  }, [attempt, index, receiptId, receiptVersion]);

  return <dialog ref={element} className="migration-original-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="migration-original-heading">
      <h3 id={titleId} ref={heading} tabIndex={-1}>이관 진단의 보존 원본</h3>
      {(!response || 'error' in response) && <button type="button" className="btn btn-ghost" onClick={onClose}>
        <X size={16} aria-hidden="true" />닫기
      </button>}
    </header>
    {!response && <p role="status">보존 원본을 불러오는 중…</p>}
    {response && 'error' in response && <div>
      <p className="migration-error" role="alert">{response.error}</p>
      <button type="button" className="btn" onClick={() => {
        heading.current?.focus({ preventScroll: true });
        setResponse(null);
        setAttempt(current => current + 1);
      }}>다시 불러오기</button>
    </div>}
    {response && 'archive' in response && <SourceArchiveDetail archive={response.archive} originalAuthorName={null} onClose={onClose} />}
  </dialog>;
}

function JiraPlanningReview({ rows, label, original, disabled, reviewed, changes, onChoose, actions }: {
  rows: MigrationJiraPlanningChoice[];
  label: string;
  original: string;
  disabled: boolean;
  reviewed?: PlanningChoiceMap;
  changes?: PlanningChoiceMap;
  onChoose: (recordId: string, choice: string | null | undefined) => void;
  actions?: ReactNode;
}) {
  return <fieldset className="migration-fieldset migration-review-diagnostics" disabled={disabled}>
    <legend>{`Jira 대표 ${label} 선택`}</legend>
    <p>{`업무별 ${label} 하나를 선택하세요. ${original}은 원본 기록에서 확인할 수 있습니다.`}</p>
    <Paged title={`Jira 대표 ${label}`} items={rows}
      label={row => `${row.sourceKey} ${row.title} ${row.candidates.map(candidate => candidate.name).join(' ')}`}
      render={row => {
        const confirmed = reviewed?.[row.recordId];
        const selected = changes && Object.hasOwn(changes, row.recordId) ? changes[row.recordId] : confirmed;
        return <MappingRow label={row.title} detail={row.sourceKey}>
          <select className="field" aria-label={`대표 ${label} ${row.sourceKey}`} value={selected === null ? noPlanningChoice : selected ?? ''}
            onChange={event => onChoose(row.recordId, event.target.value === noPlanningChoice ? null : event.target.value || undefined)}>
            <option value="" disabled={confirmed !== undefined}>미선택</option>
            <option value={noPlanningChoice}>연결하지 않음</option>
            {row.candidates.map(candidate => <option key={candidate.sourceId} value={candidate.sourceId}>{candidate.name}</option>)}
          </select>
        </MappingRow>;
      }} />
    {actions}
  </fieldset>;
}

const originalLabels = {
  diagnostic: { title: '이관 진단 원본 기록', open: '원본 상세 보기', close: '이관 진단 원본 닫기' },
  document: { title: 'Confluence 변경 원본 기록', open: 'Confluence 원본 보기', close: 'Confluence 원본 닫기' },
  relation: { title: 'Jira 관계 원본 기록', open: 'Jira 관계 원본 보기', close: 'Jira 관계 원본 닫기' },
};
type PreviewOriginalKind = keyof typeof originalLabels;
type PreviewOriginal = { source: LegacyPackageSummary; recordId: string; opener: HTMLButtonElement; kind: PreviewOriginalKind };

function MigrationReviewDetails({ preview, packages, actorId, busy, onExclude }: {
  preview: MigrationPreview; packages: LegacyPackageSummary[]; actorId: string; busy: boolean; onExclude: (ids: readonly string[]) => void;
}) {
  const [original, setOriginal] = useState<PreviewOriginal | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const sources = new Map(packages.filter(item => preview.configuration.packageIds.includes(item.id)).map(item => [item.id, item]));
  function resolveOriginal(qualifiedId: string | null) {
    if (!qualifiedId) return null;
    const separator = qualifiedId.indexOf('/');
    const source = separator > 0 ? sources.get(qualifiedId.slice(0, separator)) : undefined;
    const recordId = qualifiedId.slice(separator + 1);
    return source && recordId ? { source, recordId } : null;
  }
  function originalButton(qualifiedId: string | null, kind: PreviewOriginalKind = 'diagnostic') {
    const target = resolveOriginal(qualifiedId);
    return target ? <button className="btn btn-ghost migration-source-button" type="button"
      onClick={event => setOriginal({ ...target, opener: event.currentTarget, kind })}>
      <FileSearch size={16} aria-hidden="true" />{originalLabels[kind].open}
    </button> : null;
  }
  const alreadyExcluded = new Set(preview.configuration.excludedRecords);
  const candidates = new Set<string>();
  for (const { severity, recordId } of preview.notices) {
    if (severity !== 'error' || !recordId || recordId.length > 1200 || alreadyExcluded.has(recordId)) continue;
    const target = resolveOriginal(recordId);
    const kind = target?.recordId.split(':', 1)[0];
    if (kind && reviewExclusionKinds.has(kind)) candidates.add(recordId);
  }
  const selected = [...chosen].filter(id => candidates.has(id));
  function toggleExclusion(id: string, checked: boolean) {
    setChosen(previous => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  return <>
    {preview.issueRefresh && preview.issueRefresh.length > 0 && <JiraRefreshReview rows={preview.issueRefresh} />}
    {preview.jiraRelationRefresh && preview.jiraRelationRefresh.length > 0 && <JiraRelationReview rows={preview.jiraRelationRefresh} total={preview.counts.newJiraRelations} renderOriginal={recordId => originalButton(recordId, 'relation')} />}
    {preview.documentRefresh && preview.documentRefresh.length > 0 && <ConfluenceRefreshReview rows={preview.documentRefresh} renderOriginal={recordId => originalButton(recordId, 'document')} />}
    <fieldset className="migration-fieldset migration-review-diagnostics" disabled={busy}>
      <legend>이관 검토 진단</legend>
      {candidates.size > 0 && <div className="migration-review-exclusions">
        <div className="migration-review-actions">
          <button type="button" className="btn" disabled={!selected.length} onClick={() => onExclude(selected)}>선택한 원본 제외로 지정</button>
          <span aria-live="polite">{selected.length.toLocaleString()}개 선택</span>
        </div>
        <small>하위 기록도 함께 제외될 수 있습니다. 새 미리보기에서 제외 범위를 확인하세요.</small>
      </div>}
      <Paged title="이관 검토 진단" items={preview.notices} label={item => `${item.code} ${item.message} ${item.recordId ?? ''}`} render={item => {
        const id = item.recordId;
        return <div className={`migration-notice is-${item.severity}`}>
          <strong>{item.severity === 'error' ? '오류' : item.severity === 'warning' ? '경고' : '안내'} · {item.code}</strong>
          <p>{item.message}</p>
          {id && <small>원본 항목 {id}</small>}
          <div className="migration-review-actions">
            {originalButton(id)}
            {item.severity === 'error' && id && candidates.has(id) && <label className="migration-review-choice">
              <input type="checkbox" aria-label={`이관에서 제외할 원본으로 선택 ${id}`} checked={chosen.has(id)} onChange={event => toggleExclusion(id, event.target.checked)} />이관에서 제외할 원본으로 선택
            </label>}
          </div>
        </div>;
      }} />
    </fieldset>
    {original && <MigrationOriginalDialog {...original} actorId={actorId} onClose={() => setOriginal(null)} />}
  </>;
}

function MigrationOriginalDialog({ source, recordId, opener, kind, actorId, onClose }: PreviewOriginal & { actorId: string; onClose: () => void }) {
  const titleId = useId();
  const element = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ record: LegacyRecord } | { error: string } | null>(null);

  useEffect(() => {
    const dialog = element.current;
    if (!dialog) return;
    dialog.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  useEffect(() => {
    const request = new AbortController();
    const path = `/legacy-import/packages/${encodeURIComponent(source.id)}/records/${encodeURIComponent(recordId)}`;
    void api<LegacyRecord>(path, { cache: 'no-store', signal: request.signal, headers: { 'X-Actor-Id': actorId } })
      .then(record => { if (!request.signal.aborted) setResponse({ record }); })
      .catch(cause => { if (!request.signal.aborted) setResponse({ error: errorText(cause) }); });
    return () => request.abort();
  }, [actorId, attempt, recordId, source.id]);

  return <dialog className="migration-original-dialog" ref={element} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="migration-original-heading">
      <div><h3 id={titleId}>{originalLabels[kind].title}</h3><p>{source.filename} · {source.source.instanceKey}</p></div>
      <button ref={closeButton} className="btn btn-ghost" type="button" aria-label={originalLabels[kind].close} onClick={onClose}><X size={16} aria-hidden="true" />닫기</button>
    </header>
    {!response && <p role="status">원본 객체를 불러오는 중…</p>}
    {response && 'error' in response && <div>
      <p className="migration-error" role="alert">{response.error}</p>
      <button type="button" className="btn" onClick={() => {
        closeButton.current?.focus({ preventScroll: true });
        setResponse(null);
        setAttempt(current => current + 1);
      }}>원본 다시 불러오기</button>
    </div>}
    {response && 'record' in response && <LegacyRecordDetail record={response.record} />}
  </dialog>;
}

type AppendTarget = NonNullable<MigrationOptions['appendTarget']>;
type AppendMapping = NonNullable<MigrationConfiguration['appendTo']>;
type PageAppendMapping = NonNullable<MigrationConfiguration['appendPagesTo']>;
type MappingChoice = { id: string; label: string; detail?: string };

type RefreshFlag = 'refreshExisting' | 'refreshCustomFields' | 'refreshAttachments' | 'refreshHistory' | 'refreshRelations';
function RefreshOption<Mapping extends Partial<Record<RefreshFlag, true>>>({ value, option = 'refreshExisting', onChange, label, children }: {
  value: Mapping; option?: RefreshFlag; onChange: (next: Mapping) => void; label: string; children: ReactNode;
}) {
  const labelId = useId();
  const helpId = useId();
  return <label className="migration-refresh-option">
    <input type="checkbox" checked={value[option] === true} aria-labelledby={labelId} aria-describedby={helpId} onChange={event => {
      const next = { ...value };
      if (event.target.checked) next[option] = true;
      else delete next[option];
      onChange(next);
    }} />
    <span id={labelId}>{label}</span>
    <small id={helpId}>{children}</small>
  </label>;
}

function JiraRefreshReview({ rows }: { rows: JiraMigrationIssueReview[] }) {
  const titleId = useId();
  return <section className="migration-refresh-review" aria-labelledby={titleId}>
    <h4 id={titleId}>기존 Jira 업무 변경 검토</h4>
    <Paged title="기존 Jira 업무" items={rows} label={row => `${row.key} ${row.sourceKey}`} render={row => <div className="migration-refresh-entry">
      <h5>{row.key} <small>Jira {row.sourceKey}</small></h5>
      <RefreshFields label={`${row.key} 필드 변경`} product="Jira" fields={[
        ...row.fields.map(change => ({ ...change, id: `standard:${change.field}`, label: jiraRefreshFieldLabels[change.field] })),
        ...(row.customFields ?? []).map(change => ({ ...change, id: `custom:${change.fieldId}` })),
      ]} />
    </div>} />
  </section>;
}

function JiraRelationReview({ rows, total, renderOriginal }: { rows: NonNullable<MigrationPreview['jiraRelationRefresh']>; total: number; renderOriginal: (recordId: string) => ReactNode }) {
  const titleId = useId();
  return <section className="migration-refresh-review" aria-labelledby={titleId}>
    <h4 id={titleId}>추가할 Jira 관계</h4>
    {total > rows.length && <p>총 {total.toLocaleString()}건 중 {rows.length.toLocaleString()}건을 표시합니다.</p>}
    <ul className="migration-relation-review-list">
      {rows.map(row => <li className="migration-refresh-entry" key={row.recordId}>
        <h5>{row.sourceKey} → {row.targetKey}</h5>
        <small>{row.type}</small>
        {row.sourceProjectName && row.targetProjectName && <small>프로젝트 간 관계 · {row.sourceProjectName} → {row.targetProjectName}</small>}
        {renderOriginal(row.recordId)}
      </li>)}
    </ul>
  </section>;
}

function ConfluenceRefreshReview({ rows, renderOriginal }: { rows: ConfluenceMigrationDocumentReview[]; renderOriginal: (recordId: string) => ReactNode }) {
  const titleId = useId();
  return <section className="migration-refresh-review" aria-labelledby={titleId}>
    <h4 id={titleId}>기존 Confluence 문서 변경 검토</h4>
    <Paged title="기존 Confluence 문서" items={rows} label={row => `${row.title} ${row.sourceId}`} render={row => <article className="migration-refresh-entry" aria-label={row.title}>
      <h5>{row.title} <small>원본 페이지 {row.sourceId}</small></h5>
      <RefreshFields label={`${row.title} 필드 변경`} product="Confluence" fields={row.fields.map(change => ({
        ...change, id: change.field, label: confluenceRefreshFieldLabels[change.field],
        ...(change.field === 'labels' && { incomingLabel: change.decision === 'apply' ? '반영할 라벨' : 'Confluence 라벨' }),
        ...(change.field === 'parentId' && { currentLabel: '현재 위치', incomingLabel: '이관 제안 위치' }),
      }))} />
      {renderOriginal(row.recordId)}
    </article>} />
  </section>;
}

function RefreshFields({ label, product, fields }: {
  label: string; product: RefreshProduct;
  fields: { id: string; label: string; current: string; incoming: string; decision: 'apply' | 'conflict'; formatOnly?: true; currentLabel?: string; incomingLabel?: string }[];
}) {
  return <ul aria-label={label}>
    {fields.map(change => <li key={change.id} aria-label={change.label}>
      <div className="migration-refresh-field-heading">
        <strong>{change.label}</strong>
        <span className={change.decision === 'apply' ? 'is-apply' : 'is-conflict'}>{change.decision === 'apply' ? `${product} 값 반영` : '현재 값 유지'}</span>
      </div>
      {change.formatOnly && <small className="migration-refresh-format">본문 서식 또는 구조가 변경되었습니다.</small>}
      <dl><div><dt>{change.currentLabel ?? '현재 값'}</dt><dd>{change.current || '비어 있음'}</dd></div><div><dt>{change.incomingLabel ?? `${product} 원본 값`}</dt><dd>{change.incoming || '비어 있음'}</dd></div></dl>
    </li>)}
  </ul>;
}

function uniqueMapping(option: MigrationValueOption, choices: MappingChoice[]): string | null {
  const exactId = choices.find(choice => choice.id === option.sourceValue);
  if (exactId) return exactId.id;
  const matching = choices.filter(choice => choice.label === option.label);
  return matching.length === 1 ? matching[0].id : null;
}

function issueTypeChoices(target: AppendTarget): MappingChoice[] {
  return target.issueTypes.filter(type => !type.archived).map(type => ({ id: type.id, label: type.name }));
}

function fieldChoices(target: AppendTarget): MappingChoice[] {
  return target.fields.filter(field => !field.archived).map(field => ({ id: field.id, label: field.name, detail: fieldLabels[field.kind] }));
}

function defaultAppendMapping(options: MigrationOptions, target: AppendTarget): AppendMapping {
  const statuses: Record<string, string> = {}, issueTypes: Record<string, string> = {};
  const types = issueTypeChoices(target);
  for (const option of options.statuses) {
    const id = uniqueMapping(option, target.statuses);
    if (id) statuses[option.id] = id;
  }
  for (const option of options.issueTypes) {
    const id = uniqueMapping(option, types);
    if (id) issueTypes[option.id] = id;
  }
  const fields = fieldChoices(target);
  return {
    projectId: target.projectId, statuses, issueTypes,
    fields: Object.fromEntries(options.fields.map(option => [option.id, uniqueMapping(option,
      fields.filter(choice => choice.detail === fieldLabels[option.suggestedKind]))])),
  };
}

function AppendMappings({ options, target, value, onChange }: {
  options: MigrationOptions; target: AppendTarget; value: AppendMapping; onChange: (next: AppendMapping) => void;
}) {
  function changeSelection(key: 'statuses' | 'issueTypes', optionId: string, targetId: string) {
    const choices = { ...value[key] };
    if (targetId) choices[optionId] = targetId;
    else delete choices[optionId];
    onChange({ ...value, [key]: choices });
  }
  return <>
    <AppendMappingSection title="상태 매핑" label="상태 매핑" options={options.statuses} value={value.statuses}
      choices={target.statuses.map(status => ({ id: status.id, label: status.label, detail: `${categoryLabels[status.category]} · ${status.id}` }))}
      emptyLabel="현재 프로젝트의 상태 선택" onChange={(optionId, id) => changeSelection('statuses', optionId, id)} />
    <AppendMappingSection title="업무 유형 매핑" label="유형 매핑" options={options.issueTypes} value={value.issueTypes}
      choices={issueTypeChoices(target)} emptyLabel="현재 프로젝트의 유형 선택" onChange={(optionId, id) => changeSelection('issueTypes', optionId, id)} />
    <AppendMappingSection title="사용자 정의 속성 매핑" label="속성 매핑" options={options.fields} value={value.fields}
      choices={fieldChoices(target)} emptyLabel="원본 보관만" onChange={(optionId, id) => onChange({ ...value, fields: { ...value.fields, [optionId]: id || null } })} />
  </>;
}

function AppendMappingSection({ title, label, options, choices, value, emptyLabel, onChange }: {
  title: string; label: string; options: (MigrationValueOption & Pick<MigrationFieldOption, 'projectedDate' | 'requiredKind'>)[]; choices: MappingChoice[]; value: Record<string, string | null>;
  emptyLabel: string; onChange: (optionId: string, targetId: string) => void;
}) {
  if (!options.length) return null;
  return <MappingSection title={title}><Paged title={label} items={options} label={option => `${option.label} ${option.sourceValue}`} render={option =>
    <MappingRow label={option.label} detail={sourceMappingDetail(option)}>
      <select className="field" aria-label={`${label} ${option.label}`} value={value[option.id] || ''} onChange={event => onChange(option.id, event.target.value)}>
        <option value="">{option.projectedDate ? '일정과 원본 기록에 반영' : emptyLabel}</option>
        {choices.filter(choice => !option.requiredKind || choice.detail === fieldLabels[option.requiredKind])
          .map(choice => <option value={choice.id} key={choice.id}>{choice.label}{choice.detail ? ` · ${choice.detail}` : ''}</option>)}
      </select>
    </MappingRow>} /></MappingSection>;
}

function MigrationCounts({ entries, mode = 'new' }: { entries: [string, number][]; mode?: DestinationMode }) {
  const visible = entries.filter(([name]) => mode === 'new' || !['projects', mode === 'append' ? 'documents' : 'issues'].includes(name));
  const labels = mode === 'append-pages' ? { ...countLabels, documents: '새로 추가할 문서', retainedRecords: '기존 문서의 원본 기록' }
    : mode === 'append' ? { ...countLabels, issues: '새로 추가할 업무' } : countLabels;
  return <div className="migration-counts">{visible.map(([name, count]) => <span key={name}>{labels[name] || name} <strong>{count.toLocaleString()}</strong></span>)}</div>;
}
function MappingRow({ label, detail, children }: { label: string; detail: string; children: ReactNode }) { return <div className="migration-mapping-row"><div><strong>{label}</strong><small>{detail}</small></div>{children}</div>; }
type IdentitySuggestionRow = { identity: MigrationIdentityOption; user: User; source: string };

function identitySuggestionRows(options: MigrationOptions, users: User[], mappings: MigrationConfiguration['users']) {
  const identities = new Map(options.identities.map(identity => [identity.id, identity]));
  const usersById = new Map(users.map(user => [user.id, user]));
  const packages = new Map(options.packages.map(item => [item.id, item]));
  return suggestMigrationIdentityMappings(options, users, mappings).flatMap(({ identityId, userId }) => {
    const identity = identities.get(identityId);
    const user = usersById.get(userId);
    const pkg = identity && packages.get(identity.packageId);
    if (!identity || !user || !pkg) return [];
    const product = pkg.source.product === 'jira' ? 'Jira' : 'Confluence';
    return [{ identity, user, source: `${product} · ${pkg.source.instanceKey} · ${identity.sourceValue} · ${pkg.filename}` }];
  });
}

function MigrationEmailReview({ opener, rows, options, mappings, readRoster, onApply, onClose }: {
  opener: HTMLButtonElement;
  rows: IdentitySuggestionRow[];
  options: MigrationOptions;
  mappings: MigrationConfiguration['users'];
  readRoster: (signal: AbortSignal) => Promise<User[]>;
  onApply: (matches: readonly IdentitySuggestionRow[]) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const element = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const [candidates, setCandidates] = useState(rows);
  const [selected, setSelected] = useState(() => new Set(rows.map(({ identity }) => identity.id)));
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = element.current;
    if (!dialog) return;
    dialog.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => {
      activeRequest.current?.abort();
      dialog.close();
      if (opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  function cancel() {
    activeRequest.current?.abort();
    onClose();
  }

  async function confirm() {
    if (!selected.size || activeRequest.current) return;
    const request = new AbortController();
    activeRequest.current = request;
    setChecking(true);
    setError('');
    try {
      const users = await readRoster(request.signal);
      if (request.signal.aborted) return;
      const current = identitySuggestionRows(options, users, mappings);
      const currentById = new Map(current.map(row => [row.identity.id, row]));
      const confirmed = candidates.filter(row => selected.has(row.identity.id) && currentById.get(row.identity.id)?.user.id === row.user.id);
      if (confirmed.length !== selected.size) {
        setCandidates(current);
        setSelected(new Set(confirmed.map(({ identity }) => identity.id)));
        setError('팀원 정보가 바뀌었습니다. 최신 후보를 확인한 뒤 다시 선택해 주세요.');
        heading.current?.focus({ preventScroll: true });
        return;
      }
      onApply(confirmed);
    } catch (cause) {
      if (!request.signal.aborted) {
        setError(errorText(cause));
        heading.current?.focus({ preventScroll: true });
      }
    } finally {
      activeRequest.current = null;
      if (!request.signal.aborted) setChecking(false);
    }
  }

  return <dialog className="migration-original-dialog migration-email-review" ref={element} aria-labelledby={titleId}
    aria-busy={checking} onCancel={event => { event.preventDefault(); cancel(); }}>
    <header className="migration-original-heading"><div>
      <h3 ref={heading} id={titleId} tabIndex={-1}>이메일 일치 후보 검토</h3>
      <p>아직 매핑되지 않은 원본과 이메일이 일치하는 팀원을 확인해 주세요.</p>
    </div></header>
    {error && <p className="migration-error" role="alert">{error}</p>}
    {!candidates.length && <p>현재 팀원 이메일과 일치하는 후보가 없습니다.</p>}
    {candidates.length > 0 && <Paged title="이메일 일치 후보" items={candidates}
      label={({ identity, user, source }) => `${identity.label} ${source} ${user.name} ${user.email}`}
      render={({ identity, user, source }) => <label className="migration-email-choice">
        <input type="checkbox" aria-label={`매핑 선택 ${identity.label}`} disabled={checking} checked={selected.has(identity.id)}
          onChange={event => {
            const checked = event.currentTarget.checked;
            setSelected(previous => {
              const next = new Set(previous);
              if (checked) next.add(identity.id);
              else next.delete(identity.id);
              return next;
            });
          }} />
        <span><strong>{identity.label}</strong><small>{source}</small><small>{identity.emailEvidence?.email}</small></span>
        <span className="migration-email-target"><strong>{user.name}</strong><small>{user.email}</small></span>
      </label>} />}
    <footer className="migration-email-actions">
      <span role="status">{checking ? '현재 팀원 정보를 다시 확인하는 중…' : `후보 ${candidates.length.toLocaleString()}건 중 ${selected.size.toLocaleString()}건 선택`}</span>
      <button type="button" className="btn btn-ghost" onClick={cancel}>취소</button>
      <button type="button" className="btn btn-primary" disabled={!selected.size || checking}
        onClick={() => void confirm()}>선택한 매핑 반영</button>
    </footer>
  </dialog>;
}

function MappingSection({ title, children }: { title: string; children: ReactNode }) { const [open, setOpen] = useState(false); return <details className="migration-advanced" onToggle={event => setOpen(event.currentTarget.open)}><summary>{title}</summary>{open && <div>{children}</div>}</details>; }
function Paged<T>({ title, items, label, render }: { title: string; items: T[]; label: (item: T) => string; render: (item: T) => ReactNode }) {
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0);
  const filtered = items.filter(item => label(item).toLocaleLowerCase().includes(query.toLocaleLowerCase())), start = Math.min(offset, Math.max(0, Math.floor((filtered.length - 1) / PAGE_SIZE) * PAGE_SIZE));
  return <div className="migration-paged" aria-label={title}>{items.length > PAGE_SIZE && <label className="migration-search">{title} 검색<input className="field" aria-label={`${title} 검색`} value={query} onChange={event => { setQuery(event.target.value); setOffset(0); }} maxLength={300} /></label>}<div>{filtered.slice(start, start + PAGE_SIZE).map((item, index) => <div key={start + index}>{render(item)}</div>)}</div>{filtered.length > PAGE_SIZE && <div className="migration-pagination"><span>{start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} / {filtered.length}</span><button className="btn btn-ghost" disabled={!start} onClick={() => setOffset(Math.max(0, start - PAGE_SIZE))} aria-label={`${title} 이전 페이지`}>이전</button><button className="btn btn-ghost" disabled={start + PAGE_SIZE >= filtered.length} onClick={() => setOffset(start + PAGE_SIZE)} aria-label={`${title} 다음 페이지`}>다음</button></div>}</div>;
}
function Exclusions({ packageIds, packages, excluded, onChange }: { packageIds: string[]; packages: LegacyPackageSummary[]; excluded: string[]; onChange: (value: string[]) => void }) {
  const [packageId, setPackageId] = useState(packageIds[0] || ''), [kind, setKind] = useState(''), [query, setQuery] = useState(''), [appliedQuery, setAppliedQuery] = useState(''), [offset, setOffset] = useState(0), [result, setResult] = useState<LegacyRecordPage | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  useEffect(() => { if (!packageId) return; const abort = new AbortController(), params = new URLSearchParams({ offset: String(offset), limit: '50' }); if (kind) params.set('kind', kind); if (appliedQuery) params.set('q', appliedQuery); const timer = setTimeout(() => { setLoading(true); void api<LegacyRecordPage>(`/legacy-import/packages/${encodeURIComponent(packageId)}/records?${params}`, { signal: abort.signal }).then(value => { if (!abort.signal.aborted) { setResult(value); setError(''); } }).catch(cause => { if (!abort.signal.aborted) setError(errorText(cause)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); }); }, 0); return () => { clearTimeout(timer); abort.abort(); }; }, [packageId, offset, kind, appliedQuery]);
  return <section className="migration-exclusions" aria-label="이관 제외 항목"><h4>명시적으로 제외할 원본 · {excluded.length}개 선택</h4><div className="migration-date-grid"><label>제외 항목 패키지<select className="field" aria-label="제외 항목 패키지" value={packageId} onChange={event => { setPackageId(event.target.value); setOffset(0); setResult(null); }}>{packageIds.map(id => <option value={id} key={id}>{packages.find(item => item.id === id)?.filename || id}</option>)}</select></label><label>제외 항목 종류<select className="field" aria-label="제외 항목 종류" value={kind} onChange={event => { setKind(event.target.value); setOffset(0); setResult(null); }}><option value="">전체</option>{['issue', 'page', 'comment', 'revision', 'history', 'attachment', 'relation'].map(value => <option key={value}>{value}</option>)}</select></label></div><div className="migration-search"><input className="field" aria-label="제외 항목 검색" value={query} onChange={event => setQuery(event.target.value)} placeholder="제목·원본 ID 검색" maxLength={300} /><button className="btn" onClick={() => { setAppliedQuery(query.trim()); setOffset(0); }}>검색</button></div>{error && <p role="alert" className="migration-error">{error}</p>}{loading && <p>제외할 원본을 불러오는 중…</p>}{result && <><div className="migration-exclusion-list">{result.records.map(item => { const id = `${packageId}/${item.id}`; return <label key={item.id}><input type="checkbox" aria-label={`이관 제외 ${item.title || item.sourceId}`} checked={excluded.includes(id)} onChange={event => onChange(event.target.checked ? [...excluded, id] : excluded.filter(value => value !== id))} /><span>{item.title || item.sourceId}<small>{item.kind} · {item.sourceId}</small></span></label>; })}</div><div className="migration-pagination"><span>{result.total ? offset + 1 : 0}–{Math.min(offset + 50, result.total)} / {result.total}</span><button className="btn btn-ghost" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>제외 항목 이전</button><button className="btn btn-ghost" disabled={loading || offset + 50 >= result.total} onClick={() => setOffset(offset + 50)}>제외 항목 다음</button></div></>}</section>;
}
