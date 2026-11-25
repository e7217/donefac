'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { NodeSelection, type Transaction } from '@tiptap/pm/state';
import {
  ArrowDownToLine, Bold, ChartBar, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight,
  Code2, Columns2, Columns3, Copy, CornerDownRight, FileCheck2, FileClock, FileInput, FilePlus2, FileStack, Files, FileText, FolderInput, History, ImageIcon, Info, Italic, Link2, List,
  ListChecks, ListFilter, ListOrdered, ListTree, Loader2, MessageSquare, PanelRightClose,
  PanelRightOpen, Paperclip, Plus, Quote, RefreshCw, Save, Scissors, Search, Send, Strikethrough,
  RotateCcw, Table2, TableOfContents, TableProperties, Tag, Trash2, Unlink, X,
} from 'lucide-react';
import { createEditorExtensions } from '../../shared/editor-schema';
import { parseConfluenceJiraList } from '../../shared/confluence-jira-list';
import { documentLabelKey, normalizeDocumentLabels } from '../../shared/document-labels';
import { MAX_DOCUMENT_LABEL_LISTS } from '../../shared/document-label-list';
import { MAX_DOCUMENT_CHILD_LISTS } from '../../shared/document-child-list';
import { MAX_DOCUMENT_PROPERTY_BLOCKS } from '../../shared/document-properties';
import { DOCUMENT_CONTENT_SCHEMA_VERSION, DOCUMENT_HEADING_LEVELS, contentReferences, documentContentSchemaVersion, documentPlainText, findDocumentExcerpt, isDocumentHeadingLevel } from '../../shared/document-nodes';
import { documentPanelBacklinks, documentPanelReferenceKey, documentPanelReferences, savedDocumentSectionTitle } from '../../shared/document-panel-references';
import { isDocumentSectionId } from '../../shared/document-sections';
import { isRelationId } from '../../shared/issue-relations';
import { inlineAttachmentIdFromUrl } from '../../shared/inline-attachment';
import { jiraMigratedTargetAddress, type MigratedJiraTarget } from '../../shared/jira-migration-address';
import { DocumentBlocksProvider, DocumentDecisionRevision, ReferenceChooser, decorateDocumentExtensions, insertDetails, insertDocumentExcerpt, unfoldDetails, unwrapDetails, type ReferenceKind, type ReferenceSelection } from './DocumentBlocks';
import { DocumentAnnotationDialog, DocumentAnnotationProvider, type DocumentAnnotationKind, type DocumentAnnotationSelection, type OpenDocumentAnnotation } from './DocumentAnnotations';
import { IssueBlockChooser, type IssueBlockSelection, type OpenIssueBlock } from './DocumentIssueList';
import { SourceOrigins } from './SourceOrigins';
import { useDocumentChecklistWork } from './document-checklist-work';
import { AtlassianLinks } from './AtlassianLinks';
import { DocumentHistory } from './DocumentHistory';
import { DocumentLabels } from './DocumentLabels';
import { DocumentMetadataReview } from './DocumentMetadataReview';
import { documentMetadata, documentTitleForSave, reconcileDocumentMetadata, reapplyDocumentMetadataEdits, sameLabels, sameMetadata, type DocumentMetadata, type DocumentMetadataChoices, type DocumentMetadataField } from './document-metadata-draft';
import { DocumentMarkdownImport, type MarkdownImportPreview } from './DocumentMarkdownImport';
import { confirmMarkdownArchiveClose, DocumentMarkdownArchiveImport, type ArchiveImportNavigation } from './DocumentMarkdownArchiveImport';
import { DocumentOfflineExport, type DocumentOfflineExportScope } from './DocumentOfflineExport';
import { DocumentTemplatePicker, DocumentTemplatesManager, isDefiniteTemplateFailure, templateErrorReason, useDocumentTemplates } from './DocumentTemplates';
import { DocumentTreeMove } from './DocumentTreeMove';
import { DocumentTreeCopy } from './DocumentTreeCopy';
import { DocumentSiblingOrderDialog } from './DocumentSiblingOrderDialog';
import { DocumentPublication } from './DocumentPublication';
import { DocumentEditorOutline } from './DocumentEditorOutline';
import { DocumentFindPanel } from './DocumentFindPanel';
import { documentFindExtension } from './document-find';
import { clipboardImageFiles, trackClipboardImagePosition } from './document-clipboard-image';
import { captureDocumentSlashAnchor, type DocumentSlashAnchor, type DocumentSlashRange } from './document-slash-insertion';
import { insertDocumentToc } from './DocumentToc';
import { DocumentSelectionActions } from './DocumentSelectionActions';
import { DocumentTableTools } from './DocumentTableTools';
import { exitDocumentColumnLayout, insertDocumentColumnLayout, unwrapDocumentColumnLayout } from './document-column-layout';
import { DocumentSelectionCommentDialog, type SelectionCommentSource } from './DocumentSelectionCommentDialog';
import { DocumentDecisionLinkDialog, type DecisionLinkSource } from './DocumentDecisionLinkDialog';
import { DocumentLinkedWork } from './DocumentLinkedWork';
import { ResourceLinkPicker } from './ResourceLinkPicker';
import { NewIssueModal, type FollowUpSource } from './NewIssueModal';
import { documentNotificationSpaceId, type AttachmentHead, type Comment, type DocPage, type DocRevision, type DocumentPublicationTarget, type DocumentSiblingOrder, type DocumentSourceSelection, type DocumentTemplateSummary, type FeatureProps, type RichContent } from '../../shared/types';
import { ApiError, api, post, relativeTime, remove } from '../lib/api';
import { afterAcceptedNavigation, isDocumentPreservedByNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import { DOCUMENT_TEMPLATES, templateContent } from './document-built-in-templates';
import { contentMarkdown, contentText, documentRevisionLabel, downloadDocument } from './document-utils';
import { Attachments, attachmentFileUrl, isInlineAttachmentImage, MAX_ATTACHMENT_BYTES, type AttachmentsProps } from './Attachments';
import { CommentEditBody, CommentEditButton, CommentEditedMark, useCommentEditing } from './CommentEdit';
import { COMMENT_LIST_CHANGED, CommentTrashButton } from './CommentTrashButton';
import { CommentMentionInput, commentDraftPayload, decodeCommentDraft, emptyCommentDraft, encodeCommentDraft, sameCommentDraft, type CommentDraft } from './CommentMentions';
import { DocumentReplyComposer, DocumentReplyList, useDocumentCommentReply } from './DocumentCommentReplies';
import { NotificationSubscriptionButton } from './NotificationSubscriptionButton';
import { FavoriteAction } from './FavoritesState';
import { CollaborativeEditor } from './CollaborativeEditor';
import type { CollaborationSession } from '../../shared/collaboration';
import { hasPendingCollaboration, type CollaborationView } from '../lib/collaboration-client';
import type { OpenIssueForReview } from '../lib/issue-review';
import './documents.css';
import './document-comment-review.css';

type Props = FeatureProps & {
  selectedDocumentId: string | null;
  onSelectDocument: (id: string) => void;
  openDocument: (id: string, sectionId?: string) => void;
  documentLabel?: string | null;
  onChangeDocumentLabel?: (label: string | null) => void;
  sectionId?: string | null;
  publicationLink?: DocumentPublicationTarget | null;
  onClosePublicationLink?: (documentId: string, target: DocumentPublicationTarget) => void;
  issueDrawerOpen?: boolean;
  onOpenIssueForReview?: OpenIssueForReview;
  onOpenIssueSchedule?: (id: string) => boolean;
  onOpenMigratedIssue?: (issueId: string, commentId?: string, opener?: HTMLAnchorElement, signal?: AbortSignal) => Promise<boolean>;
  commentFocus?: { commentId: string; activation: number };
  onCopyCommentLink?: (commentId: string) => void;
};
type DocumentAction = { kind: 'create'; source: FollowUpSource } | { kind: 'link'; source: DecisionLinkSource }
  | { kind: 'comment'; source: SelectionCommentSource; initialDraft: CommentDraft };
type Draft = DocumentMetadata & {
  id: string; content: RichContent; plainText: string;
  expectedVersion: number;
  dirty: boolean; editSequence: number;
  bodyDirty?: boolean;
  baseMetadata?: DocumentMetadata;
  baseProjectId?: string | null;
};
type DocumentConflict = 'generic' | { document: DocPage; fields: DocumentMetadataField[]; parentContextChanged: boolean } | null;
type ObservedDocument = { document: DocPage; live: boolean };
type DocumentSave = { actorId: string; documentId: string; observed?: ObservedDocument };
type ClipboardImageScope = { editor: Editor; documentId: string; actorId: string; liveEpoch: string | null };
type SideTab = 'comments' | 'history' | 'links' | 'attachments' | 'source';
type MigratedIssueLinkState = { href: string; status: 'pending' | 'missing' | 'failed'; expectsComment: boolean };
type CommentFilter = 'all' | 'open' | 'resolved';
const COMMENT_FILTER_LABELS = { all: '전체', open: '미해결', resolved: '해결됨' } satisfies Record<CommentFilter, string>;
const COMMENT_FILTERS: CommentFilter[] = ['all', 'open', 'resolved'];

function selectedCodeBlock(editor: Editor | null) {
  if (!editor || editor.isDestroyed || !editor.isEditable) return null;
  const selection = editor.state.selection;
  if (selection instanceof NodeSelection) {
    return selection.node.type.name === 'codeBlock' ? { pos: selection.from, node: selection.node } : null;
  }
  const { $from, $to } = selection;
  return $from.depth && $from.sameParent($to) && $from.parent.type.name === 'codeBlock'
    ? { pos: $from.before(), node: $from.parent }
    : null;
}

function orderedTreePages(pages: DocPage[], orders: readonly DocumentSiblingOrder[] | undefined) {
  if (!orders?.length) return pages;
  const byId = new Map(pages.map((page, index) => [page.id, { page, index }]));
  const sorted = [...pages];
  for (const { projectId, parentId, documentIds } of orders) {
    const members = documentIds.flatMap(id => {
      const entry = byId.get(id);
      return entry?.page.projectId === projectId && entry.page.parentId === parentId ? [entry] : [];
    });
    const slots = members.map(({ index }) => index).sort((first, second) => first - second);
    members.forEach(({ page }, index) => { sorted[slots[index]] = page; });
  }
  return sorted;
}
const commentFilterFor = (comment: Comment): CommentFilter => comment.documentSource ? comment.resolution?.state ?? 'open' : 'all';
const cacheKey = (actorId: string, id: string) => `teamspace:document-draft:${actorId}:${id}`;
const commentCacheKey = (actorId: string, id: string) => `teamspace:document-comment-draft:${actorId}:${id}`;
const selectionCommentCacheKey = (actorId: string, id: string) => `teamspace:document-selection-comment-draft:${actorId}:${id}`;
type CommentContext = { actorId: string; documentId: string };
type MarkdownCreation = { actorId: string; body: string; documentId?: string };
type TeamTemplateCreation = MarkdownCreation & { projectId: string | null };
type TemplateManagerContext = { projectId: string | null; source?: Pick<DocPage, 'id' | 'title' | 'version' | 'projectId'> };
const draftFromPage = (page: DocPage): Draft => {
  const metadata = documentMetadata(page);
  return {
    id: page.id, content: page.content, plainText: page.plainText, expectedVersion: page.version,
    dirty: false, editSequence: 0, bodyDirty: false, ...metadata, baseMetadata: metadata, baseProjectId: page.projectId,
  };
};
const sameBody = (left: RichContent, right: RichContent) => left === right || JSON.stringify(left) === JSON.stringify(right);
function draftAfterSave(captured: Draft, current: Draft, saved: DocPage, live: boolean): Draft {
  const next = draftFromPage(saved);
  const savedMetadata = documentMetadata(saved);
  const metadata = reapplyDocumentMetadataEdits(captured, current, savedMetadata);
  const bodyDirty = !live && Boolean(current.bodyDirty) && !sameBody(captured.content, current.content);
  return {
    ...next, ...metadata, editSequence: current.editSequence, bodyDirty,
    ...(live || bodyDirty ? { content: current.content, plainText: current.plainText } : {}),
    dirty: bodyDirty || !sameMetadata(metadata, savedMetadata),
  };
}
function metadataReviewKey(draft: Draft, review: Exclude<DocumentConflict, string | null>) {
  const saved = documentMetadata(review.document);
  return JSON.stringify([draft.id, review.document.projectId, review.parentContextChanged,
    review.fields.map(field => [field, draft[field], saved[field]])]);
}
const METADATA_FIELD_LABELS = { title: '제목', status: '작성 상태', parentId: '상위 문서', labels: '라벨' } satisfies Record<DocumentMetadataField, string>;
const when = (value: string) => new Date(value).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const LIST_DRAFT_DISCARD_MESSAGE = '적용하지 않은 문서 목록 설정 또는 문서 속성 편집을 버리고 이동할까요? 다른 편집과 댓글 초안은 임시로 보관합니다.';
const COMMENT_EDIT_DISCARD_MESSAGE = '작성 중인 댓글 수정 내용을 버리고 이동할까요? 다른 편집과 새 댓글 초안은 임시로 보관합니다.';
const LIST_AND_COMMENT_EDIT_DISCARD_MESSAGE = '적용하지 않은 문서 목록 설정, 문서 속성 편집, 댓글 수정 내용을 버리고 이동할까요? 다른 편집과 새 댓글 초안은 임시로 보관합니다.';

function mergeCommentUpdate(current: Comment, updated: Comment): Comment {
  if (current.id !== updated.id) return current;
  const latestBody = (current.editVersion ?? 0) > (updated.editVersion ?? 0) ? current : updated;
  const latestResolution = (current.resolution?.version ?? 0) > (updated.resolution?.version ?? 0) ? current : updated;
  return { ...latestBody, resolution: latestResolution.resolution };
}

export function Documents({ data, projectId, actorId, refresh, notify, openIssue, openDocument, selectedDocumentId, onSelectDocument,
  documentLabel, onChangeDocumentLabel, sectionId, publicationLink, onClosePublicationLink, issueDrawerOpen = false,
  commentFocus, onCopyCommentLink, onOpenIssueForReview, onOpenIssueSchedule, onOpenMigratedIssue }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [findScope, setFindScope] = useState<string | null>(null);
  const findOpener = useRef<HTMLButtonElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const documentScope = JSON.stringify([actorId, selectedDocumentId]);
  if (findScope !== null && findScope !== documentScope) setFindScope(null);
  const [migratedIssueLink, setMigratedIssueLink] = useState<MigratedIssueLinkState | null>(null);
  const migratedIssueRequest = useRef<{ anchor: HTMLAnchorElement; controller: AbortController } | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const listDrafts = useRef(new Set<string>());
  const trackListDraft = useCallback((id: string, dirty: boolean) => {
    if (dirty) listDrafts.current.add(id);
    else listDrafts.current.delete(id);
  }, []);
  const actorRef = useRef(actorId);
  const activeActorRef = useRef(actorId);
  activeActorRef.current = actorId;
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const savingRef = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const [conflict, setConflictState] = useState<DocumentConflict>(null);
  const conflictRef = useRef<DocumentConflict>(null);
  const setConflict = useCallback((value: DocumentConflict) => {
    conflictRef.current = value;
    setConflictState(value);
    if (!value) setShowLatest(false);
  }, []);
  const documentSave = useRef<DocumentSave | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const manualEditorRef = useRef<Editor | null>(null);
  const [publicationDocumentId, setPublicationDocumentId] = useState<string | null>(null);
  const [moveDocumentId, setMoveDocumentId] = useState<string | null>(null);
  const closeMove = useCallback(() => setMoveDocumentId(null), []);
  const [copyDocumentId, setCopyDocumentId] = useState<string | null>(null);
  const closeCopy = useCallback(() => setCopyDocumentId(null), []);
  const [orderDocumentId, setOrderDocumentId] = useState<string | null>(null);
  const closeOrder = useCallback(() => setOrderDocumentId(null), []);
  const publicationOpener = useRef<HTMLButtonElement>(null);
  const closePublication = useCallback(() => {
    setPublicationDocumentId(null);
    if (selectedDocumentId && publicationLink) onClosePublicationLink?.(selectedDocumentId,publicationLink);
    requestAnimationFrame(() => publicationOpener.current?.focus());
  }, [onClosePublicationLink,publicationLink,selectedDocumentId]);
  const [storageProblem, setStorageProblem] = useState(false);
  const reportReplyStorageProblem = useCallback(() => setStorageProblem(true), []);
  const reply = useDocumentCommentReply(actorId, draft?.id, reportReplyStorageProblem);
  const { isSending: isReplySending, hasDraft: hasReplyDraft, clearDocument: clearReplyDrafts } = reply;
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sideTab, setSideTab] = useState<SideTab>('comments');
  const linksTab = useRef<HTMLButtonElement>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const commentEditing = useCommentEditing({ actorId, resourceId: draft?.id, notify, refresh, onSaved: saved => {
    setComments(previous => previous.map(item => mergeCommentUpdate(item, saved)));
  } });
  const { discard: discardCommentEdit, hasDraft: hasCommentEditDraft, isPending: isCommentEditPending } = commentEditing;
  const confirmCommentEditExit = useCallback(() => {
    if (isCommentEditPending()) {
      notify('저장이 끝난 후 이동해주세요.', 'error');
      return false;
    }
    return !hasCommentEditDraft() || window.confirm(COMMENT_EDIT_DISCARD_MESSAGE);
  }, [hasCommentEditDraft, isCommentEditPending, notify]);
  const [commentFilter, setCommentFilter] = useState<CommentFilter>('all');
  const activeCommentFilter = useRef<HTMLButtonElement>(null);
  const [resolvingCommentId, setResolvingCommentId] = useState<string | null>(null);
  const [resolutionError, setResolutionError] = useState('');
  const resolutionRequest = useRef<CommentContext | null>(null);
  const [commentDraft, setCommentDraft] = useState(emptyCommentDraft);
  const commentDraftRef = useRef(commentDraft);
  const commentContextRef = useRef<CommentContext | null>(null);
  const reselectedCommentDraft = useRef<(CommentContext & { draft: CommentDraft }) | null>(null);
  const focusCommentId = useRef<string | null>(null);
  const [loadedCommentActivation, setLoadedCommentActivation] = useState<number>();
  const handledCommentActivation = useRef<number>(undefined);
  const commentsHeading = useRef<HTMLHeadingElement>(null);
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentError, setCommentError] = useState('');
  const [revisions, setRevisions] = useState<DocRevision[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [newParent, setNewParent] = useState('');
  const [newProject, setNewProject] = useState(projectId === 'all' ? '' : projectId);
  const [newTitle, setNewTitle] = useState('');
  const [newTemplate, setNewTemplate] = useState('blank');
  const [creating, setCreating] = useState(false);
  const creatingRequest = useRef(false);
  const newTitleCustomized = useRef(false);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownImportPreview | null>(null);
  const [markdownCreation, setMarkdownCreation] = useState<MarkdownCreation | null>(null);
  const [markdownCreateError, setMarkdownCreateError] = useState('');
  const importingMarkdown = newTemplate === 'markdown';
  const [teamTemplate, setTeamTemplate] = useState<DocumentTemplateSummary | null>(null);
  const [teamTemplateConflict, setTeamTemplateConflict] = useState(false);
  const [teamCreation, setTeamCreation] = useState<TeamTemplateCreation | null>(null);
  const [teamCreationError, setTeamCreationError] = useState('');
  const [teamCreationRejected, setTeamCreationRejected] = useState(false);
  const [templateManager, setTemplateManager] = useState<TemplateManagerContext | null>(null);
  const templateManagerOpener = useRef<HTMLButtonElement>(null);
  const templateFormOpen = useRef(false);
  const templateDraftDirty = useRef(false);
  const templateCreateAttempt = useRef<TeamTemplateCreation | null>(null);
  const createOpener = useRef<HTMLElement>(null);
  const createSubmit = useRef<HTMLButtonElement>(null);
  const createTitle = useRef<HTMLInputElement>(null);
  const { catalog: teamCatalog, reload: reloadTeamTemplates } = useDocumentTemplates(newProject || null, newOpen && !importingMarkdown);
  const currentTeamTemplate = teamCatalog?.state === 'ready' ? teamCatalog.templates.find(item => item.id === teamTemplate?.id) : undefined;
  const teamTemplateChanged = Boolean(teamTemplate && !teamCreation && (teamTemplateConflict ||
    teamCatalog?.state === 'ready' && currentTeamTemplate?.version !== teamTemplate.version));
  const createAttempt = teamCreation ?? markdownCreation;
  const createLocked = creating || Boolean(createAttempt) || teamCreationRejected;
  templateFormOpen.current = newOpen && Boolean(teamTemplate);
  templateDraftDirty.current = templateFormOpen.current && (newTitleCustomized.current || teamTemplateChanged);
  const recordTeamAttempt = useCallback((value: TeamTemplateCreation | null) => {
    templateCreateAttempt.current = value;
    setTeamCreation(value);
  }, []);
  const closeCreateDocument = useCallback(() => {
    templateFormOpen.current = false;
    templateDraftDirty.current = false;
    setNewOpen(false);
    setMarkdownPreview(null);
    setMarkdownCreation(null);
    setMarkdownCreateError('');
    setTeamTemplate(null);
    setTeamTemplateConflict(false);
    recordTeamAttempt(null);
    setTeamCreationError('');
    setTeamCreationRejected(false);
  }, [recordTeamAttempt]);
  const confirmTemplateDraftDiscard = useCallback(() => {
    if (templateCreateAttempt.current) return window.confirm('문서가 저장됐을 수 있습니다. 목록에서 확인할 수 있습니다. 계속할까요?');
    return !templateDraftDirty.current || window.confirm('팀 템플릿으로 작성 중인 새 문서의 입력을 버릴까요?');
  }, []);
  const closeTemplateManager = useCallback(() => {
    setTemplateManager(null);
    requestAnimationFrame(() => templateManagerOpener.current?.focus({ preventScroll: true }));
  }, []);
  const [exportOpen, setExportOpen] = useState(false);
  const exportMenuTrigger = useRef<HTMLButtonElement>(null);
  const offlineExportOpener = useRef<HTMLButtonElement>(null);
  const [offlineExport, setOfflineExport] = useState<DocumentOfflineExportScope | null>(null);
  function openOfflineExport(scope: DocumentOfflineExportScope, opener: HTMLButtonElement | null) {
    offlineExportOpener.current = opener;
    setExportOpen(false);
    setOfflineExport(scope);
  }
  function closeOfflineExport() {
    const opener = offlineExportOpener.current;
    setOfflineExport(null);
    requestAnimationFrame(() => { if (opener?.isConnected) opener.focus({ preventScroll: true }); });
  }
  const archiveImportOpener = useRef<HTMLButtonElement>(null);
  const archiveImportNavigation = useRef<ArchiveImportNavigation>('ready');
  const [archiveImport, setArchiveImport] = useState(false);
  const recordArchiveImportNavigation = useCallback((state: ArchiveImportNavigation) => {
    archiveImportNavigation.current = state;
  }, []);
  function closeArchiveImport() {
    setArchiveImport(false);
    requestAnimationFrame(() => archiveImportOpener.current?.focus({ preventScroll: true }));
  }
  const [insertKind, setInsertKind] = useState<'link' | 'image' | null>(null);
  const [insertUrl, setInsertUrl] = useState('');
  const clipboardImageScope = useRef<ClipboardImageScope | null>(null);
  const clipboardImageGeneration = useRef(0);
  const [clipboardImageUploads, setClipboardImageUploads] = useState<Record<string, number>>({});
  const [clipboardAttachment, setClipboardAttachment] = useState<{ documentId: string; versionId: string } | null>(null);
  const [referenceSelection, setReferenceSelection] = useState<ReferenceSelection | null>(null);
  const closeReference = useCallback(() => setReferenceSelection(null), []);
  const [issueBlockSelection, setIssueBlockSelection] = useState<IssueBlockSelection | null>(null);
  const closeIssueBlock = useCallback(() => setIssueBlockSelection(null), []);
  const [annotationSelection, setAnnotationSelection] = useState<DocumentAnnotationSelection | null>(null);
  const closeAnnotation = useCallback(() => setAnnotationSelection(null), []);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashTop, setSlashTop] = useState(40);
  const [slashIndex, setSlashIndex] = useState(0);
  const editorWrap = useRef<HTMLDivElement>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const linkBusyRef = useRef(false);
  const [documentAction, setDocumentAction] = useState<DocumentAction | null>(null);
  const [checklistReselecting, setChecklistReselecting] = useState(false);
  const documentActionOpener = useRef<HTMLButtonElement>(null);
  const closeDocumentAction = useCallback((restoreFocus = true) => {
    const opener = documentActionOpener.current;
    setDocumentAction(null);
    setChecklistReselecting(false);
    documentActionOpener.current = null;
    if (restoreFocus && opener) requestAnimationFrame(() => {
      const target = opener.isConnected && !opener.disabled ? opener : editorWrap.current?.querySelector<HTMLElement>('.docs-prose');
      target?.focus({ preventScroll: true });
    });
  }, []);
  const [referencesRefreshing, setReferencesRefreshing] = useState(false);
  const [checklistReload, setChecklistReload] = useState(0);
  const [, forceToolbar] = useState(0);
  const [session, setSession] = useState<CollaborationSession | null>(null);
  const sessionRef = useRef<CollaborationSession | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [manualRecovery, setManualRecovery] = useState(false);
  const manualRecoveryRef = useRef(false);
  const [liveEditor, setLiveEditor] = useState<Editor | null>(null);
  const [liveState, setLiveState] = useState<CollaborationView | null>(null);
  const liveStateRef = useRef<CollaborationView | null>(null);
  const [liveReload, setLiveReload] = useState(0);
  const [archivedLiveRecovery, setArchivedLiveRecovery] = useState(false);
  const archivedLiveRecoveryRef = useRef(false);

  const selectedPage = data.documents.find(page => page.id === selectedDocumentId);
  const selectedPageId = selectedPage?.id;
  const publicationOpen = Boolean(selectedPage && (publicationLink || selectedPage.id === publicationDocumentId));

  useLayoutEffect(() => {
    setMigratedIssueLink(null);
    return () => {
      migratedIssueRequest.current?.controller.abort();
      migratedIssueRequest.current = null;
    };
  }, [documentScope, sectionId, issueDrawerOpen, publicationOpen, checklistReselecting]);

  async function resolveMigratedIssue(anchor: HTMLAnchorElement, href: string, expectsComment: boolean) {
    if (!onOpenMigratedIssue || migratedIssueRequest.current?.anchor === anchor) return;
    migratedIssueRequest.current?.controller.abort();
    const controller = new AbortController();
    const { signal } = controller;
    const route = location.hash;
    const stillOnLink = () => location.hash === route && anchor.isConnected && anchor.getAttribute('href') === href;
    // Let the issue drawer restore focus to an anchor inside the editable body.
    if (anchor.isContentEditable && !anchor.hasAttribute('tabindex')) anchor.tabIndex = -1;
    migratedIssueRequest.current = { anchor, controller };
    setMigratedIssueLink({ href, status: 'pending', expectsComment });
    try {
      const query = new URLSearchParams({ url: href });
      const { target } = await api<{ target: MigratedJiraTarget | null }>(`/atlassian-links/resolve-migrated-jira-target?${query}`, { signal, cache: 'no-store' });
      if (signal.aborted) return;
      if (!stillOnLink()) {
        setMigratedIssueLink(null);
        return;
      }
      const verified = target && isRelationId(target.issueId) &&
        (expectsComment ? isRelationId(target.commentId) : target.commentId === undefined);
      const opened = verified && await onOpenMigratedIssue(target.issueId, target.commentId, anchor, signal);
      if (!signal.aborted) setMigratedIssueLink(opened || !stillOnLink() ? null : { href, status: 'missing', expectsComment });
    } catch {
      if (!signal.aborted) setMigratedIssueLink(stillOnLink() ? { href, status: 'failed', expectsComment } : null);
    } finally {
      if (migratedIssueRequest.current?.controller === controller) migratedIssueRequest.current = null;
    }
  }

  function openMigratedIssueLink(element: Element) {
    const anchor = element.closest<HTMLAnchorElement>('a[href]');
    if (!anchor || !onOpenMigratedIssue || !data.jiraMigrationOrigins?.length || publicationOpen || issueDrawerOpen ||
        anchor.closest('[data-static-document-content]')) return false;
    const href = anchor.getAttribute('href');
    const address = href && jiraMigratedTargetAddress(href);
    if (!href || !address || !data.jiraMigrationOrigins.includes(`${address.origin}${address.contextPath}`)) return false;
    void resolveMigratedIssue(anchor, href, Boolean(address.commentId));
    return true;
  }
  const moveOpen = Boolean(selectedPage && selectedPage.id === moveDocumentId);
  const copyOpen = Boolean(selectedPage && selectedPage.id === copyDocumentId);
  const orderOpen = Boolean(selectedPage && selectedPage.id === orderDocumentId);
  const currentProject = data.projects.find(project => project.id === projectId);
  const scoped = useMemo(() => data.documents.filter(page => projectId === 'all' || page.projectId === projectId || page.projectId === null), [data.documents, projectId]);
  const activeSession = session?.document.id === selectedPage?.id ? session : null;
  const manualSession = activeSession?.enabled === false;
  const liveMode = Boolean(activeSession && (activeSession.enabled || archivedLiveRecovery) && !manualRecovery);
  const liveDocument = liveState?.document;
  const remoteDocument = liveMode ? liveDocument : activeSession?.document;
  const latestPage = selectedPage && remoteDocument?.id === selectedPage.id && remoteDocument.version > selectedPage.version ? remoteDocument : selectedPage;
  const liveLocationChanged = latestPage !== selectedPage &&
    (latestPage?.projectId !== selectedPage?.projectId || latestPage?.parentId !== selectedPage?.parentId);
  const filterPages = useMemo(() => scoped.map(page => page.id === latestPage?.id && latestPage.version > page.version ? latestPage : page), [scoped, latestPage]);
  const searchKey = documentLabelKey(search.trim());
  const filtersActive = Boolean(searchKey || documentLabel);
  const visible = useMemo(() => filterPages.filter(page => {
    const labelKeys = page.labels?.map(documentLabelKey) ?? [];
    return (!documentLabel || labelKeys.includes(documentLabel))
      && (documentLabelKey(page.title).includes(searchKey) || labelKeys.some(key => key.includes(searchKey)));
  }), [filterPages, searchKey, documentLabel]);
  const treePages = useMemo(() => filtersActive ? visible : orderedTreePages(visible, data.documentOrders), [visible, filtersActive, data.documentOrders]);
  const labelOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const page of filterPages) {
      for (const label of page.labels ?? []) {
        const key = documentLabelKey(label);
        if (!options.has(key)) options.set(key, label);
      }
    }
    return new Map([...options].sort((a, b) => a[1].localeCompare(b[1], 'ko')));
  }, [filterPages]);
  const activeLabel = documentLabel && (labelOptions.get(documentLabel)
    || draft?.labels.find(label => documentLabelKey(label) === documentLabel) || documentLabel);

  useEffect(() => { if (window.matchMedia('(max-width: 1180px)').matches) setSidebarOpen(false); }, []);
  useEffect(() => {
    if (liveLocationChanged) void refresh().catch(() => {});
  }, [liveLocationChanged, liveDocument?.id, liveDocument?.projectId, liveDocument?.parentId, refresh]);

  const rememberDraft = useCallback((value: Draft | null, owner = actorRef.current) => {
    if (!value || typeof window === 'undefined') return;
    try {
      if (value.dirty) localStorage.setItem(cacheKey(owner, value.id), JSON.stringify(value));
      else localStorage.removeItem(cacheKey(owner, value.id));
      setStorageProblem(false);
    } catch { setStorageProblem(true); }
  }, []);

  const rememberComment = useCallback((value = commentDraftRef.current, context = commentContextRef.current) => {
    if (!context || typeof window === 'undefined') return;
    try {
      const key = commentCacheKey(context.actorId, context.documentId);
      if (value.body) localStorage.setItem(key, encodeCommentDraft(value));
      else localStorage.removeItem(key);
    } catch { setStorageProblem(true); }
  }, []);

  const updateCommentDraft = useCallback((value: CommentDraft) => {
    commentDraftRef.current = value;
    setCommentDraft(value);
    rememberComment(value);
  }, [rememberComment]);

  const storeDraft = useCallback((next: Draft, syncManualBody = false) => {
    const old = draftRef.current;
    draftRef.current = next;
    setDraft(next);
    rememberDraft(next);
    if (syncManualBody && old && !sameBody(old.content, next.content)) {
      manualEditorRef.current?.commands.setContent(next.content, { emitUpdate: false });
    }
  }, [rememberDraft]);

  const reconcileDraft = useCallback(({ document, live }: ObservedDocument, choices?: DocumentMetadataChoices) => {
    const current = draftRef.current;
    if (!current || current.id !== document.id || actorRef.current !== activeActorRef.current || current.expectedVersion >= document.version) return;
    const reviewed = conflictRef.current;
    if (typeof reviewed === 'object' && reviewed && reviewed.document.version > document.version) return;
    if (current.bodyDirty || (current.dirty && !current.baseMetadata)) {
      setConflict('generic');
      return;
    }
    const saved = documentMetadata(document);
    const parentContextChanged = current.baseProjectId !== document.projectId;
    const { metadata, conflicts } = current.dirty && current.baseMetadata
      ? reconcileDocumentMetadata(current.baseMetadata, current, saved, { choices, parentContextChanged })
      : { metadata: saved, conflicts: [] };
    if (conflicts.length) {
      setConflict({ document, fields: conflicts, parentContextChanged });
      return;
    }
    const next = {
      ...draftFromPage(document), ...metadata, editSequence: current.editSequence,
      ...(live ? { content: current.content, plainText: current.plainText } : {}),
      dirty: !sameMetadata(metadata, saved),
    };
    storeDraft(next, !live);
    setConflict(null);
  }, [setConflict, storeDraft]);

  const observeDocument = useCallback((observed: ObservedDocument) => {
    const { document, live } = observed;
    if (actorRef.current !== activeActorRef.current || draftRef.current?.id !== document.id || (!live && listDrafts.current.size)) return;
    const pending = documentSave.current;
    if (pending?.documentId === document.id && pending.actorId === actorRef.current) {
      // Process the HTTP receipt before treating a broadcast as a peer edit.
      if (!pending.observed || pending.observed.document.version < document.version) pending.observed = observed;
      return;
    }
    reconcileDraft(observed);
  }, [reconcileDraft]);

  const updateDraft = useCallback((changes: Partial<Draft>) => {
    const previous = draftRef.current;
    if (!previous) return;
    const next = { ...previous, ...changes, dirty: true, bodyDirty: previous.bodyDirty || 'content' in changes, editSequence: previous.editSequence + 1 };
    storeDraft(next);
    const review = conflictRef.current;
    if (review && review !== 'generic') {
      observeDocument({ document: review.document, live: Boolean(sessionRef.current?.enabled) });
    }
  }, [observeDocument, storeDraft]);

  const receiveLiveEditor = useCallback((instance: Editor | null) => setLiveEditor(instance), []);
  const receiveLiveState = useCallback((state: CollaborationView | null) => {
    const previous = liveStateRef.current;
    if (previous?.phase === 'connected' && (state?.phase !== 'connected' || state.epoch !== previous.epoch ||
        state.document.id !== previous.document.id)) {
      clipboardImageGeneration.current++;
    }
    liveStateRef.current = state;
    setLiveState(state);
  }, []);
  const receiveLiveContent = useCallback((content: RichContent, plainText: string) => {
    const current = draftRef.current;
    if (!current) return;
    const next = { ...current, content, plainText, bodyDirty: false };
    draftRef.current = next; setDraft(next);
    if (next.dirty) rememberDraft(next);
  }, [rememberDraft]);
  const receiveLiveDocument = useCallback((document: DocPage) => {
    observeDocument({ document, live: true });
  }, [observeDocument]);

  const updateSlash = useCallback((instance: Editor) => {
    const { $from, empty } = instance.state.selection;
    const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc');
    const match = instance.isFocused && empty && !$from.parent.type.spec.code && before.match(/^\/([^\s/]*)$/);
    setSlashQuery(match ? match[1] : null);
    setSlashIndex(0);
    if (match && editorWrap.current) {
      const coordinates = instance.view.coordsAtPos($from.pos);
      setSlashTop(coordinates.bottom - editorWrap.current.getBoundingClientRect().top + 7);
    }
  }, []);
  const updateEditorSelection = useCallback(() => { forceToolbar(value => value + 1); setSlashQuery(null); }, []);
  const manualEditor = useEditor({
    immediatelyRender: false,
    extensions: [
      ...decorateDocumentExtensions(createEditorExtensions()),
      documentFindExtension,
      Placeholder.configure({ placeholder: '내용을 작성하세요. / 를 입력해 블록을 추가할 수 있어요.' }),
    ],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    editorProps: { attributes: { class: 'docs-prose', 'aria-label': '문서 본문' } },
    onUpdate: ({ editor: instance }) => {
      updateDraft({ content: instance.getJSON() as RichContent, plainText: documentPlainText(instance.getJSON() as RichContent) });
      updateSlash(instance);
    },
    onSelectionUpdate: updateEditorSelection,
  });
  manualEditorRef.current = manualEditor;
  const editor = liveMode ? liveEditor : manualEditor;
  const canFind = Boolean(editor && !editor.isDestroyed && draft?.id && draft.id === selectedPage?.id && (!liveMode || liveState?.ready));
  const findOpen = canFind && findScope === documentScope;
  const bodyReadOnly = restoring || manualRecovery || !activeSession || (liveMode && (!liveState?.ready || liveState.phase === 'recovery' || liveState.phase === 'error'));
  const clipboardLiveEpoch = liveMode && liveState?.phase === 'connected' && liveState.document.id === selectedPageId ? liveState.epoch : null;
  const clipboardWritable = !bodyReadOnly && !archivedLiveRecovery && !publicationOpen && !checklistReselecting &&
    !issueDrawerOpen && draft?.id === selectedPageId && (!liveMode || clipboardLiveEpoch !== null);
  useLayoutEffect(() => {
    if (!editor || !selectedPageId || !clipboardWritable) return;
    const scope = { editor, documentId: selectedPageId, actorId, liveEpoch: clipboardLiveEpoch };
    clipboardImageScope.current = scope;
    const invalidate = () => { clipboardImageGeneration.current++; };
    window.addEventListener('offline', invalidate);
    return () => {
      clipboardImageScope.current = null;
      window.removeEventListener('offline', invalidate);
    };
  }, [actorId, editor, selectedPageId, clipboardWritable, clipboardLiveEpoch, liveReload]);
  const referenceDialog = !bodyReadOnly && referenceSelection?.editor === editor && referenceSelection.documentId === draft?.id ? referenceSelection : null;
  const issueBlockDialog = !bodyReadOnly && issueBlockSelection?.editor === editor && issueBlockSelection.documentId === draft?.id ? issueBlockSelection : null;
  const jiraCode = bodyReadOnly ? undefined : selectedCodeBlock(editor)?.node.textContent;
  const jiraMacro = useMemo(() => jiraCode ? parseConfluenceJiraList(jiraCode) : undefined, [jiraCode]);
  const annotationDialog = !bodyReadOnly && !publicationOpen && annotationSelection?.editor === editor && annotationSelection.documentId === selectedPage?.id ? annotationSelection : null;
  useEffect(() => {
    if (issueBlockSelection?.kind === 'restoreJira' && !issueBlockDialog) closeIssueBlock();
  }, [issueBlockSelection, issueBlockDialog, closeIssueBlock]);
  useEffect(() => {
    if (!liveMode || !liveEditor) return;
    const update = ({ editor: instance, transaction }: { editor: Editor; transaction: Transaction }) => {
      if (transaction.getMeta(ySyncPluginKey)) setSlashQuery(null);
      else updateSlash(instance);
    };
    liveEditor.on('update', update);
    liveEditor.on('selectionUpdate', updateEditorSelection);
    return () => {
      liveEditor.off('update', update);
      liveEditor.off('selectionUpdate', updateEditorSelection);
      setSlashQuery(null);
    };
  }, [liveEditor, liveMode, updateEditorSelection, updateSlash]);
  const openIssueBlock = useCallback<OpenIssueBlock>((instance, nodeType, target, slash) => {
    const current = draftRef.current;
    if (!current || instance !== editor || instance.isDestroyed || !instance.isEditable) return;
    const opener = !slash && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const context = { editor: instance, documentId: current.id, opener, nodeType };
    setIssueBlockSelection(target ? { ...context, kind: 'edit', target }
      : { ...context, kind: 'insert', bookmark: instance.state.selection.getBookmark(), slash });
    setSlashQuery(null); setInsertKind(null); setReferenceSelection(null); closeAnnotation();
  }, [editor, closeAnnotation]);

  function restoreJiraIssueList(opener: HTMLElement) {
    const current = draftRef.current;
    const target = selectedCodeBlock(editor);
    if (bodyReadOnly || !editor || !current || current.id !== selectedPage?.id || !target) return;
    const macro = parseConfluenceJiraList(target.node.textContent);
    if (!macro) return;
    setIssueBlockSelection({ editor, documentId: current.id, nodeType: 'issueList', opener, kind: 'restoreJira', target: { ...target, macro } });
    setSlashQuery(null); setInsertKind(null); setReferenceSelection(null); closeAnnotation();
  }
  const openAnnotation = useCallback<OpenDocumentAnnotation>((instance, kind, opener, target) => {
    const current = draftRef.current;
    if (!current || instance !== editor || instance.isDestroyed || !instance.isEditable) return;
    const annotation = { editor: instance, documentId: current.id, kind, opener };
    setAnnotationSelection(target ? { ...annotation, mode: 'edit', target } : { ...annotation, mode: 'insert', bookmark: instance.state.selection.getBookmark() });
    setSlashQuery(null); setInsertKind(null); setIssueBlockSelection(null); setReferenceSelection(null);
  }, [editor]);
  const receiveDisabledSession = useCallback((current: CollaborationSession) => {
    const previous = draftRef.current;
    if (!previous || previous.id !== current.document.id) return;
    // A replaced collaborative document has no comparable metadata baseline.
    const next = { ...draftFromPage(current.document), ...(previous.dirty ? {
      ...documentMetadata(previous),
      expectedVersion: previous.expectedVersion, baseMetadata: undefined, baseProjectId: undefined,
      editSequence: previous.editSequence, dirty: true,
    } : {}) };
    draftRef.current = next; setDraft(next); rememberDraft(next);
    manualEditor?.commands.setContent(next.content, { emitUpdate: false });
    sessionRef.current = current; setSession(current);
    archivedLiveRecoveryRef.current = false; setArchivedLiveRecovery(false);
    manualRecoveryRef.current = false; setManualRecovery(false);
    setConflict(next.dirty ? 'generic' : null);
    void refresh().catch(() => {});
  }, [manualEditor, rememberDraft, refresh, setConflict]);

  useEffect(() => {
    if (!selectedPageId) return;
    let active = true;
    sessionRef.current = null; setSession(null); setSessionError('');
    manualRecoveryRef.current = false; setManualRecovery(false);
    archivedLiveRecoveryRef.current = false; setArchivedLiveRecovery(false);
    const check = async () => {
      try {
        const current = await api<CollaborationSession>(`/documents/${selectedPageId}/collaboration`);
        if (!active) return;
        if (sessionRef.current?.enabled && !current.enabled) return;
        if (sessionRef.current?.document.id === current.document.id && sessionRef.current.document.version > current.document.version) return;
        sessionRef.current = current; setSession(current); setSessionError('');
        const archive = !current.enabled && hasPendingCollaboration(actorId, current.document.id);
        archivedLiveRecoveryRef.current = archive; setArchivedLiveRecovery(archive);
        const cached = draftRef.current;
        if (current.enabled && cached?.id === selectedPageId && cached.bodyDirty) {
          manualRecoveryRef.current = true; setManualRecovery(true);
        }
        if (!current.enabled && !archive) observeDocument({ document: current.document, live: false });
      } catch (cause) { if (active) setSessionError(cause instanceof Error ? cause.message : '공동 편집 상태를 확인하지 못했습니다.'); }
    };
    void check();
    // Discover another opener enabling collaboration; this polls capability,
    // never document writes. Once live, the WebSocket owns synchronization.
    const timer = setInterval(() => { if (!sessionRef.current?.enabled) void check(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [selectedPageId, actorId, observeDocument]);

  useEffect(() => { manualEditor?.setEditable(manualSession && !manualRecovery && !archivedLiveRecovery, false); }, [manualEditor, manualSession, manualRecovery, archivedLiveRecovery]);
  useEffect(() => { if (activeSession?.enabled && draft?.bodyDirty) { manualRecoveryRef.current = true; setManualRecovery(true); } }, [activeSession?.enabled, draft?.id, draft?.bodyDirty]);

  useEffect(() => {
    if (!manualEditor) return;
    const old = draftRef.current;
    if (!selectedPage) {
      if (old) {
        rememberDraft(old);
        draftRef.current = null;
        setDraft(null);
        setConflict(null);
      }
      return;
    }
    const sameActor = actorRef.current === actorId;
    if (old?.id === selectedPage.id && sameActor) {
      if (manualSession && !archivedLiveRecovery) observeDocument({ document: selectedPage, live: false });
      return;
    }
    if (old && (old.id !== selectedPage.id || !sameActor)) rememberDraft(old);
    actorRef.current = actorId;
    let next = draftFromPage(selectedPage);
    try {
      const cached = localStorage.getItem(cacheKey(actorId, selectedPage.id));
      if (cached) {
        const candidate = JSON.parse(cached) as Draft;
        if (candidate.id === selectedPage.id && candidate.dirty && candidate.content?.type === 'doc' && Number.isInteger(candidate.expectedVersion)) {
          const labels = normalizeDocumentLabels(candidate.labels) ?? next.labels;
          const baseMetadata = candidate.baseMetadata && {
            ...candidate.baseMetadata, labels: normalizeDocumentLabels(candidate.baseMetadata.labels) ?? next.labels,
          };
          next = {
            ...candidate, labels, baseMetadata: baseMetadata ?? (candidate.expectedVersion === selectedPage.version ? next.baseMetadata : undefined),
            baseProjectId: candidate.baseProjectId === undefined && candidate.expectedVersion === selectedPage.version ? selectedPage.projectId : candidate.baseProjectId,
            bodyDirty: candidate.bodyDirty ?? !sameBody(candidate.content, selectedPage.content),
          };
        }
      }
    } catch { /* A malformed local draft must not prevent opening a saved document. */ }
    draftRef.current = next;
    setDraft(next);
    manualEditor.commands.setContent(next.content, { emitUpdate: false });
    setConflict(next.dirty && next.expectedVersion !== selectedPage.version ? 'generic' : null);
    setShowLatest(false);
    setReferenceSelection(null);
    setIssueBlockSelection(null);
    closeAnnotation();
    setSlashQuery(null);
    setInsertKind(null);
  }, [selectedPage, actorId, manualEditor, rememberDraft, manualSession, archivedLiveRecovery, observeDocument, setConflict, closeAnnotation]);

  useEffect(() => {
    if (!archiveImport && !selectedDocumentId && visible.length) onSelectDocument(visible[0].id);
  }, [archiveImport, selectedDocumentId, visible, onSelectDocument]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (archiveImportNavigation.current !== 'ready' || creatingRequest.current || templateCreateAttempt.current || templateDraftDirty.current || draftRef.current?.dirty
        || listDrafts.current.size || commentDraftRef.current.body.trim() || liveStateRef.current?.pending
        || isReplySending() || hasReplyDraft(actorRef.current, draftRef.current?.id) || isCommentEditPending() || hasCommentEditDraft()) {
        rememberDraft(draftRef.current); rememberComment(); event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => { window.removeEventListener('beforeunload', handler); rememberDraft(draftRef.current); rememberComment(); };
  }, [rememberDraft, rememberComment, isReplySending, hasReplyDraft, isCommentEditPending, hasCommentEditDraft]);

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (offlineExport) afterAcceptedNavigation(event, () => setOfflineExport(null));
      if (archiveImport) {
        if (archiveImportNavigation.current === 'busy') {
          event.preventDefault();
          notify('ZIP 가져오기 요청이 끝난 뒤 이동해 주세요.', 'error');
          return;
        }
        if (!confirmMarkdownArchiveClose(archiveImportNavigation.current)) {
          event.preventDefault();
          return;
        }
        afterAcceptedNavigation(event, () => setArchiveImport(false));
      }
      if (isDocumentPreservedByNavigation(event, selectedDocumentId)) {
        if (annotationDialog) {
          event.preventDefault();
          notify('문서 서식 편집을 마친 뒤 업무를 열어 주세요.', 'error');
        }
        return;
      }
      if (savingRef.current || creatingRequest.current || isReplySending() || isCommentEditPending()) {
        event.preventDefault();
        notify('저장이 끝난 후 이동해주세요.', 'error');
        return;
      }
      if (templateFormOpen.current && !confirmTemplateDraftDiscard()) {
        event.preventDefault();
        return;
      }
      const commentEditDirty = hasCommentEditDraft();
      if (commentEditDirty || draftRef.current?.dirty || listDrafts.current.size || commentDraftRef.current.body.trim() || liveStateRef.current?.pending
        || hasReplyDraft(actorRef.current, draftRef.current?.id)) {
        const message = listDrafts.current.size && commentEditDirty ? LIST_AND_COMMENT_EDIT_DISCARD_MESSAGE
          : commentEditDirty ? COMMENT_EDIT_DISCARD_MESSAGE
          : listDrafts.current.size ? LIST_DRAFT_DISCARD_MESSAGE
          : '저장하지 않은 편집, 전송 중인 공동 편집 또는 보내지 않은 댓글이 있습니다. 이 브라우저에 임시 보관하고 이동할까요?';
        if (!window.confirm(message)) { event.preventDefault(); return; }
        rememberDraft(draftRef.current); rememberComment();
      }
      afterAcceptedNavigation(event, discardCommentEdit);
      if (templateFormOpen.current) afterAcceptedNavigation(event, closeCreateDocument);
    };
    window.addEventListener('teamspace:navigate', guard);
    return () => window.removeEventListener('teamspace:navigate', guard);
  }, [annotationDialog, archiveImport, closeCreateDocument, confirmTemplateDraftDiscard, notify, rememberDraft, rememberComment, selectedDocumentId, isReplySending, hasReplyDraft, offlineExport,
    discardCommentEdit, hasCommentEditDraft, isCommentEditPending]);

  useEffect(() => {
    if (teamCreation && !creating && !teamCreationRejected) createSubmit.current?.focus({ preventScroll: true });
  }, [creating, teamCreation, teamCreationRejected]);

  const saveDraft = useCallback(async () => {
    const captured = draftRef.current;
    if (!captured?.dirty || savingRef.current || actorRef.current !== activeActorRef.current) return;
    if (conflictRef.current && conflictRef.current !== 'generic') { setShowLatest(true); return; }
    if (archivedLiveRecoveryRef.current) { notify('보관한 공동 편집을 먼저 복구하거나 최신 문서를 열어주세요.', 'error'); return; }
    const collaborative = sessionRef.current?.enabled && sessionRef.current.document.id === captured.id;
    if (collaborative && (manualRecoveryRef.current || liveStateRef.current?.phase !== 'connected' || liveStateRef.current?.pending)) { notify('공동 편집 연결과 본문 동기화를 먼저 확인해주세요.', 'error'); return; }
    const capturedActor = actorRef.current;
    const pending: DocumentSave = { actorId: capturedActor, documentId: captured.id };
    documentSave.current = pending;
    savingRef.current = true;
    setSaving(true);
    try {
      if (!collaborative) {
        const latest = await api<CollaborationSession>(`/documents/${captured.id}/collaboration`);
        if (latest.enabled) {
          sessionRef.current = latest; setSession(latest);
          if (captured.bodyDirty) { manualRecoveryRef.current = true; setManualRecovery(true); }
          notify('공동 편집이 시작된 문서입니다. 보관한 편집을 확인한 후 이어서 작업해주세요.', 'error');
          return;
        }
        observeDocument({ document: latest.document, live: false });
      }
      const base = captured.baseMetadata;
      const result = await api<DocPage>(`/documents/${captured.id}`, { method: 'PATCH', headers: { 'X-Actor-Id': capturedActor }, body: JSON.stringify({
        expectedVersion: captured.expectedVersion,
        ...(!base || documentTitleForSave(captured.title) !== documentTitleForSave(base.title) ? { title: documentTitleForSave(captured.title) } : {}),
        ...(!base || !sameLabels(captured.labels, base.labels) ? { labels: captured.labels } : {}),
        ...(!base || captured.status !== base.status ? { status: captured.status } : {}),
        ...(!base || captured.parentId !== base.parentId ? { parentId: captured.parentId } : {}),
        ...(!collaborative && captured.bodyDirty ? { content: captured.content, plainText: captured.plainText, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION } : {}),
      }) });
      const current = draftRef.current;
      if (current?.id === captured.id && actorRef.current === capturedActor && activeActorRef.current === capturedActor) {
        storeDraft(draftAfterSave(captured, current, result, Boolean(collaborative)), !collaborative);
        setConflict(null);
      } else {
        // Reconcile only the request owner's cached buffer. A response for a
        // different actor/document must never change the current editor/cache.
        try {
          const key = cacheKey(capturedActor, captured.id);
          const stored = localStorage.getItem(key);
          const cached = stored ? JSON.parse(stored) as Draft : null;
          if (cached?.id === captured.id && cached.expectedVersion === captured.expectedVersion && cached.editSequence >= captured.editSequence) {
            const next = draftAfterSave(captured, cached, result, Boolean(collaborative));
            if (next.dirty) localStorage.setItem(key, JSON.stringify(next));
            else localStorage.removeItem(key);
          }
        } catch { setStorageProblem(true); }
      }
      await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        if (draftRef.current?.id === captured.id && actorRef.current === capturedActor && activeActorRef.current === capturedActor) setConflict('generic');
        notify('다른 변경사항이 있어 저장하지 않았습니다. 내 편집은 임시 보관되어 있어요.', 'error');
        await refresh().catch(() => {});
      } else notify(error instanceof Error ? error.message : '문서를 저장하지 못했습니다.', 'error');
    } finally {
      documentSave.current = null;
      if (pending.observed && capturedActor === activeActorRef.current) observeDocument(pending.observed);
      savingRef.current = false;
      setSaving(false);
    }
  }, [notify, observeDocument, refresh, setConflict, storeDraft]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (issueDrawerOpen || newOpen || templateManager || offlineExport || archiveImport || referenceDialog || issueBlockDialog) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!publicationOpen && !moveOpen && !copyOpen && !orderOpen) void saveDraft();
      }
      if (event.key === 'Escape') { setSlashQuery(null); setInsertKind(null); setReferenceSelection(null); setIssueBlockSelection(null); setExportOpen(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [saveDraft, publicationOpen, moveOpen, copyOpen, orderOpen, issueDrawerOpen, newOpen, templateManager, offlineExport, archiveImport, referenceDialog, issueBlockDialog]);

  const moveBlocker = () => {
    if (savingRef.current || restoring) return '저장 또는 버전 복원이 끝나면 문서를 이동할 수 있습니다.';
    if (draftRef.current?.dirty || listDrafts.current.size) return '문서 편집과 목록 설정을 저장한 뒤 이동해 주세요.';
    if (liveStateRef.current?.pending || manualRecoveryRef.current || archivedLiveRecoveryRef.current ||
        (selectedDocumentId && hasPendingCollaboration(actorId, selectedDocumentId))) {
      return '이 브라우저의 공동 편집을 동기화하거나 복구한 뒤 문서를 이동해 주세요.';
    }
    return null;
  };
  const moveSaved = () => {
    closeMove();
    notify('문서를 이동했습니다.');
    void refresh().catch(() => notify('문서 이동을 저장했습니다. 화면을 새로 고쳐 현재 위치를 확인해 주세요.', 'error'));
  };

  const documentId = draft?.id;
  const commentActivation = documentId === selectedDocumentId ? commentFocus?.activation : undefined;
  const { rootComments, repliesByParent } = useMemo(() => {
    const rootComments: Comment[] = [];
    const repliesByParent = new Map<string, Comment[]>();
    for (const comment of comments) {
      if (comment.resourceId !== documentId) continue;
      if (!comment.parentCommentId) rootComments.push(comment);
      else {
        const siblings = repliesByParent.get(comment.parentCommentId);
        if (siblings) siblings.push(comment);
        else repliesByParent.set(comment.parentCommentId, [comment]);
      }
    }
    return { rootComments, repliesByParent };
  }, [comments, documentId]);
  const focusedComment = commentFocus && comments.find(comment => comment.id === commentFocus.commentId);
  const focusedRoot = rootComments.find(comment => comment.id === (focusedComment?.parentCommentId ?? focusedComment?.id));
  const linkedCommentMissing = commentActivation !== undefined && loadedCommentActivation === commentActivation && !focusedRoot && !commentError;
  const visibleComments = commentFilter === 'all' ? rootComments : rootComments.filter(comment => commentFilterFor(comment) === commentFilter);
  const activeCommentEdit = commentEditing.current?.base;
  const showDetachedCommentEdit = activeCommentEdit && (!visibleComments.some(comment => comment.id === (activeCommentEdit.parentCommentId ?? activeCommentEdit.id))
    || !comments.some(comment => comment.id === activeCommentEdit.id));
  useEffect(() => {
    if (!documentId) return;
    rememberComment();
    const context = { actorId, documentId };
    commentContextRef.current = context;
    resolutionRequest.current = null;
    let cached = emptyCommentDraft();
    try { cached = decodeCommentDraft(localStorage.getItem(commentCacheKey(actorId, documentId))); } catch { setStorageProblem(true); }
    commentDraftRef.current = cached;
    setComments([]); setCommentDraft(cached); setCommentsLoading(true); setCommentError('');
    setCommentFilter('all'); setResolvingCommentId(null); setResolutionError('');
    return () => {
      if (resolutionRequest.current === context) resolutionRequest.current = null;
    };
  }, [documentId, actorId, rememberComment]);

  useEffect(() => {
    if (!documentId) return;
    let activeRequest: AbortController | undefined;
    const loadComments = () => {
      activeRequest?.abort();
      const request = new AbortController();
      activeRequest = request;
      void api<Comment[]>(`/comments?resourceType=document&resourceId=${encodeURIComponent(documentId)}`, {
        signal: request.signal, headers: { 'X-Actor-Id': actorId },
      }).then(result => { if (!request.signal.aborted) { setComments(result); setCommentError(''); } })
        .catch(error => { if (!request.signal.aborted) setCommentError(error instanceof Error ? error.message : '댓글을 불러오지 못했습니다.'); })
        .finally(() => {
          if (!request.signal.aborted) {
            setCommentsLoading(false);
            setLoadedCommentActivation(commentActivation);
          }
        });
    };
    loadComments();
    window.addEventListener(COMMENT_LIST_CHANGED, loadComments);
    window.addEventListener('teamspace:trash-changed', loadComments);
    window.addEventListener('teamspace:workspace-imported', loadComments);
    return () => {
      activeRequest?.abort();
      window.removeEventListener(COMMENT_LIST_CHANGED, loadComments);
      window.removeEventListener('teamspace:trash-changed', loadComments);
      window.removeEventListener('teamspace:workspace-imported', loadComments);
    };
  }, [documentId, actorId, commentActivation]);

  useEffect(() => {
    if (!focusCommentId.current || !sidebarOpen || sideTab !== 'comments' || issueDrawerOpen || publicationOpen || documentAction || newOpen || templateManager) return;
    const article = document.getElementById(`document-comment-${focusCommentId.current}`);
    if (!article || article.closest('[inert]')) return;
    focusCommentId.current = null;
    article.scrollIntoView({ block: 'nearest' });
    article.focus({ preventScroll: true });
  }, [comments, sidebarOpen, sideTab, commentFilter, issueDrawerOpen, publicationOpen, documentAction, newOpen, templateManager]);

  useEffect(() => {
    if (!commentFocus || commentActivation !== commentFocus.activation || loadedCommentActivation !== commentFocus.activation
      || handledCommentActivation.current === commentFocus.activation || issueDrawerOpen || publicationOpen || documentAction || newOpen || templateManager) return;
    if (!sidebarOpen || sideTab !== 'comments') {
      setSidebarOpen(true);
      setSideTab('comments');
      return;
    }
    if (focusedRoot && commentFilter !== 'all' && commentFilterFor(focusedRoot) !== commentFilter) {
      setCommentFilter(commentFilterFor(focusedRoot));
      return;
    }
    const target = document.getElementById(`document-comment-${commentFocus.commentId}`) ?? commentsHeading.current;
    if (!target || target.closest('[inert]')) return;
    handledCommentActivation.current = commentFocus.activation;
    target.scrollIntoView({ block: 'nearest' });
    target.focus({ preventScroll: true });
  }, [commentFocus, commentActivation, loadedCommentActivation, focusedRoot, commentFilter, issueDrawerOpen, publicationOpen, documentAction,
    newOpen, templateManager, sidebarOpen, sideTab, issueBlockSelection]);

  useEffect(() => {
    if (!documentId || sideTab !== 'history' || publicationOpen) return;
    let active = true;
    setHistoryLoading(true); setHistoryError('');
    api<DocRevision[]>(`/documents/${documentId}/revisions`)
      .then(result => { if (active) setRevisions(result); })
      .catch(error => { if (active) setHistoryError(error instanceof Error ? error.message : '이력을 불러오지 못했습니다.'); })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [documentId, draft?.expectedVersion, sideTab, publicationOpen]);

  function selectDocument(id: string) {
    if (id === selectedDocumentId) return true;
    if (documentAction) {
      if (!window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }))) return false;
      onSelectDocument(id);
      return true;
    }
    if (savingRef.current || isReplySending() || isCommentEditPending()) { notify('저장이 끝난 후 이동해주세요.', 'error'); return false; }
    const commentEditDirty = hasCommentEditDraft();
    if (commentEditDirty || draftRef.current?.dirty || listDrafts.current.size || commentDraftRef.current.body.trim() || liveStateRef.current?.pending
      || hasReplyDraft(actorRef.current, draftRef.current?.id)) {
      const message = listDrafts.current.size && commentEditDirty ? LIST_AND_COMMENT_EDIT_DISCARD_MESSAGE
        : commentEditDirty ? COMMENT_EDIT_DISCARD_MESSAGE
        : listDrafts.current.size ? LIST_DRAFT_DISCARD_MESSAGE
        : '저장하지 않은 편집, 전송 중인 공동 편집 또는 보내지 않은 댓글이 있습니다. 이 브라우저에 임시 보관하고 다른 문서로 이동할까요?';
      if (!window.confirm(message)) return false;
    }
    rememberDraft(draftRef.current);
    rememberComment();
    discardCommentEdit();
    onSelectDocument(id);
    return true;
  }

  function openNew(parentId = '', template = 'blank') {
    const parent = data.documents.find(page => page.id === parentId);
    createOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setNewParent(parentId);
    setNewProject(parent ? parent.projectId || '' : projectId === 'all' ? '' : projectId);
    setNewTemplate(template);
    setNewTitle(template === 'blank' ? '' : DOCUMENT_TEMPLATES.find(item => item.id === template)?.name || '');
    newTitleCustomized.current = false;
    setMarkdownPreview(null);
    setMarkdownCreation(null);
    setMarkdownCreateError('');
    setTeamTemplate(null);
    setTeamTemplateConflict(false);
    recordTeamAttempt(null);
    setTeamCreationError('');
    setTeamCreationRejected(false);
    reloadTeamTemplates();
    setNewOpen(true);
  }

  function discardCreateDocument() {
    if (creatingRequest.current || !confirmTemplateDraftDiscard()) return;
    closeCreateDocument();
    requestAnimationFrame(() => createOpener.current?.focus({ preventScroll: true }));
  }

  function chooseDocumentTemplate(template: string) {
    if (!newTitleCustomized.current) {
      setNewTitle(DOCUMENT_TEMPLATES.find(item => item.id === template && item.id !== 'blank')?.name || '');
    }
    setNewTemplate(template);
    setTeamTemplate(null);
    setTeamTemplateConflict(false);
    setTeamCreationError('');
    setMarkdownPreview(null);
    setMarkdownCreateError('');
  }

  function chooseTeamTemplate(template: DocumentTemplateSummary | null) {
    if (!template) {
      chooseDocumentTemplate('blank');
      return;
    }
    if (!newTitleCustomized.current) setNewTitle(template.name);
    setNewTemplate('team');
    setTeamTemplate(template);
    setTeamTemplateConflict(false);
    setTeamCreationError('');
    setMarkdownPreview(null);
    setMarkdownCreateError('');
  }

  function changeCreateProject(value: string) {
    setNewProject(value);
    setNewParent('');
    if (teamTemplate?.projectId && teamTemplate.projectId !== value) chooseDocumentTemplate('blank');
  }

  function reviewMarkdown(preview: MarkdownImportPreview | null, fileTitle = '') {
    setMarkdownPreview(preview);
    setMarkdownCreateError('');
    if (preview && !newTitleCustomized.current) {
      setNewTitle((preview.suggestedTitle || fileTitle).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240).toWellFormed());
    }
  }

  async function createDocument(event: React.FormEvent) {
    event.preventDefault();
    if (creatingRequest.current || !newTitle.trim() || importingMarkdown && !markdownPreview || teamTemplateChanged || teamCreationRejected) return;
    if (!createAttempt && listDrafts.current.size && !window.confirm(LIST_DRAFT_DISCARD_MESSAGE)) return;
    if (markdownCreation && !markdownCreation.documentId && markdownCreation.actorId !== activeActorRef.current) {
      setMarkdownCreateError('저장을 시작한 작업자로 전환한 뒤 다시 확인해 주세요.');
      return;
    }
    if (!confirmCommentEditExit()) return;
    creatingRequest.current = true;
    setCreating(true);
    setMarkdownCreateError('');
    let documentId = markdownCreation?.documentId;
    try {
      if (teamTemplate) {
        await createFromTeamTemplate(teamTemplate);
        return;
      }
      const parent = data.documents.find(page => page.id === newParent);
      const payload = {
        title: newTitle.trim(), projectId: parent ? parent.projectId : newProject || null,
        parentId: newParent || null, content: importingMarkdown && markdownPreview ? markdownPreview.content : templateContent(newTemplate),
        status: 'draft', icon: DOCUMENT_TEMPLATES.find(item => item.id === newTemplate)?.icon || '📄',
      };
      if (importingMarkdown && !documentId) {
        const request = markdownCreation ?? { actorId, body: JSON.stringify({ ...payload, requestId: newRequestId() }) };
        setMarkdownCreation(request);
        const result = await api<DocPage>('/documents', { method: 'POST', headers: { 'X-Actor-Id': request.actorId }, body: request.body });
        documentId = result.id;
        setMarkdownCreation({ ...request, documentId });
      } else if (!importingMarkdown) {
        documentId = (await post<DocPage>('/documents', payload)).id;
      }
      rememberDraft(draftRef.current);
      if (importingMarkdown) rememberComment();
      await refresh();
      if (documentId) {
        discardCommentEdit();
        onSelectDocument(documentId);
      }
      closeCreateDocument();
      notify('새 문서를 만들었습니다.', 'success');
    } catch (error) {
      if (!importingMarkdown) notify(error instanceof Error ? error.message : '문서를 만들지 못했습니다.', 'error');
      else if (documentId) setMarkdownCreateError('문서는 저장됐습니다. 다시 열어 최신 목록을 불러오세요.');
      else if (!markdownCreation && error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 409) {
        setMarkdownCreation(null);
        setMarkdownCreateError(error.message);
      } else if (error instanceof ApiError && error.status === 409) setMarkdownCreateError(error.message);
      else setMarkdownCreateError('저장 결과를 확인할 수 없습니다. 같은 요청으로 다시 확인해 주세요.');
    } finally {
      creatingRequest.current = false;
      setCreating(false);
    }
  }

  async function createFromTeamTemplate(template: DocumentTemplateSummary) {
    if (teamCreation && !teamCreation.documentId && teamCreation.actorId !== activeActorRef.current) {
      setTeamCreationError('저장을 시작한 작업자로 전환한 뒤 다시 확인해 주세요.');
      return;
    }
    setTeamCreationError('');
    const parent = data.documents.find(page => page.id === newParent);
    const destination = parent ? parent.projectId : newProject || null;
    const request = teamCreation ?? { actorId, projectId: destination, body: JSON.stringify({ requestId: newRequestId(), templateId: template.id,
      expectedTemplateVersion: template.version, title: newTitle.trim(), projectId: destination, parentId: newParent || null }) };
    recordTeamAttempt(request);
    let documentId = request.documentId;
    try {
      if (!documentId) {
        const result = await api<DocPage>('/documents', { method: 'POST', headers: { 'X-Actor-Id': request.actorId }, body: request.body });
        if (!result?.id || result.projectId !== request.projectId || result.authorId !== request.actorId) throw new Error('문서 저장 결과를 확인할 수 없습니다.');
        documentId = result.id;
        recordTeamAttempt({ ...request, documentId });
      }
      rememberDraft(draftRef.current);
      rememberComment();
      await refresh();
      closeCreateDocument();
      discardCommentEdit();
      onSelectDocument(documentId);
      notify('새 문서를 만들었습니다.', 'success');
    } catch (cause) {
      if (documentId) setTeamCreationError('문서가 저장됐습니다. 목록을 다시 불러와 저장한 문서를 열 수 있습니다.');
      else if (!isDefiniteTemplateFailure(cause)) setTeamCreationError('저장 결과를 확인할 수 없습니다. 같은 요청으로 다시 확인해 주세요.');
      else {
        const reason = templateErrorReason(cause);
        recordTeamAttempt(null);
        setTeamCreationError(cause.message);
        if (reason === 'template_version_conflict' || reason === 'template_archived' || reason === 'template_not_found') {
          setTeamTemplateConflict(true);
          reloadTeamTemplates();
        } else if (teamCreation && (reason === 'result_unavailable' || reason === 'request_conflict')) {
          setTeamCreationRejected(true);
        }
      }
    }
  }

  function manageTemplates(opener: HTMLButtonElement, capture?: DocPage) {
    const space = capture ? capture.projectId : currentProject?.id ?? null;
    const candidate = capture ?? latestPage;
    templateManagerOpener.current = opener;
    setTemplateManager({ projectId: space, source: candidate?.projectId === space ? {
      id: candidate.id, title: candidate.title, version: candidate.version, projectId: candidate.projectId,
    } : undefined });
  }

  async function submitComment(event: React.FormEvent) {
    event.preventDefault();
    const context = commentContextRef.current;
    const payload = commentDraftPayload(commentDraftRef.current);
    if (!context || !payload.body || commentBusy) return;
    setCommentBusy(true);
    try {
      const result = await api<Comment>('/comments', { method: 'POST', headers: { 'X-Actor-Id': context.actorId },
        body: JSON.stringify({ resourceType: 'document', resourceId: context.documentId, ...payload }) });
      const current = commentContextRef.current;
      if (current?.documentId === context.documentId && current.actorId === context.actorId && activeActorRef.current === context.actorId) {
        setComments(items => items.some(item => item.id === result.id) ? items : [...items, result]);
        setCommentFilter('all');
        if (sameCommentDraft(commentDraftPayload(commentDraftRef.current), payload)) updateCommentDraft(emptyCommentDraft());
      } else {
        try {
          const key = commentCacheKey(context.actorId, context.documentId);
          const cached = decodeCommentDraft(localStorage.getItem(key));
          if (sameCommentDraft(commentDraftPayload(cached), payload)) localStorage.removeItem(key);
        } catch { setStorageProblem(true); }
      }
      window.dispatchEvent(new Event(COMMENT_LIST_CHANGED));
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : '댓글을 등록하지 못했습니다.', 'error'); }
    finally { setCommentBusy(false); }
  }

  function showSavedSelectionComment(comment: Comment) {
    closeDocumentAction(false);
    const current = commentContextRef.current;
    if (current?.documentId === comment.resourceId && current.actorId === comment.authorId && activeActorRef.current === comment.authorId) {
      focusCommentId.current = comment.id;
      setComments(items => [...items.filter(item => item.id !== comment.id), comment]);
      setCommentFilter(previous => previous === 'all' ? previous : commentFilterFor(comment));
      setSidebarOpen(true);
      setSideTab('comments');
    }
    window.dispatchEvent(new Event(COMMENT_LIST_CHANGED));
    void refresh().catch(() => undefined);
    notify('발췌 댓글을 등록했습니다.', 'success');
  }

  function showSavedReply(comment: Comment) {
    const current = commentContextRef.current;
    if (current?.documentId === comment.resourceId && current.actorId === comment.authorId && activeActorRef.current === comment.authorId) {
      focusCommentId.current = comment.id;
      setComments(items => items.some(item => item.id === comment.id) ? items : [...items, comment]);
      setSidebarOpen(true);
      setSideTab('comments');
    }
    window.dispatchEvent(new Event(COMMENT_LIST_CHANGED));
    void refresh().catch(() => undefined);
    notify('답글을 등록했습니다.', 'success');
  }

  function archiveCommentFromList(removed: Comment) {
    const current = commentContextRef.current;
    if (current?.documentId === removed.resourceId && current.actorId === actorId && activeActorRef.current === actorId) {
      setComments(items => items.filter(item => item.id !== removed.id && item.parentCommentId !== removed.id));
    }
  }

  async function changeCommentResolution(comment: Comment, trigger: HTMLButtonElement) {
    const context = commentContextRef.current;
    if (!context?.actorId || !comment.documentSource || context.documentId !== comment.resourceId
      || context.actorId !== activeActorRef.current || resolutionRequest.current) return;
    const state = comment.resolution?.state === 'resolved' ? 'open' : 'resolved';
    const currentContext = () => resolutionRequest.current === context && activeActorRef.current === context.actorId;
    resolutionRequest.current = context;
    setResolvingCommentId(comment.id);
    setResolutionError('');
    try {
      const updated = await api<Comment>(`/documents/${encodeURIComponent(context.documentId)}/selection-comments/${encodeURIComponent(comment.id)}/resolution`, {
        method: 'PATCH', headers: { 'X-Actor-Id': context.actorId },
        body: JSON.stringify({ state, expectedVersion: comment.resolution?.version ?? 0 }),
      });
      if (currentContext()) {
        const filterButton = activeCommentFilter.current;
        if (document.activeElement === trigger && filterButton && filterButton.value !== 'all' && filterButton.value !== state) {
          filterButton.focus();
        }
        setComments(previous => previous.map(item => mergeCommentUpdate(item, updated)));
        notify(state === 'resolved' ? '문장 댓글을 해결 처리했습니다.' : '문장 댓글을 다시 열었습니다.');
      }
    } catch (error) {
      if (currentContext()) {
        const reason = error instanceof ApiError && error.status === 409
          ? (error.details as { reason?: string } | undefined)?.reason : undefined;
        if (reason === 'resolution_version_changed') {
          setResolutionError('다른 사용자가 댓글 상태를 변경했습니다. 최신 상태를 확인해 주세요.');
          if (document.activeElement === trigger && activeCommentFilter.current?.value !== 'all') {
            activeCommentFilter.current?.focus();
          }
        } else {
          setResolutionError(error instanceof ApiError ? error.message : '댓글 상태를 변경했는지 확인할 수 없습니다. 최신 상태를 확인해 주세요.');
        }
      }
    } finally {
      if (resolutionRequest.current === context) {
        resolutionRequest.current = null;
        setResolvingCommentId(null);
      }
      window.dispatchEvent(new Event(COMMENT_LIST_CHANGED));
    }
  }

  async function restoreRevision(revision: DocRevision) {
    const captured = draftRef.current;
    if (!captured || savingRef.current) return;
    const capturedActor = actorRef.current;
    if (listDrafts.current.size) { notify('문서 목록 설정을 적용하거나 취소한 후 복구해주세요.', 'error'); return; }
    if (captured.dirty) { notify('현재 편집을 먼저 저장하거나 새 문서로 보관해주세요.', 'error'); return; }
    if (liveStateRef.current?.pending || (sessionRef.current?.enabled && liveStateRef.current?.phase !== 'connected')) { notify('공동 편집을 서버에 동기화한 후 복구해주세요.', 'error'); return; }
    if (!window.confirm(`${documentRevisionLabel(revision)}의 내용으로 복구할까요? 현재 내용은 이력에 남습니다.`)) return;
    clipboardImageGeneration.current++;
    savingRef.current = true; setSaving(true); setRestoring(true);
    // Toggling editability is UI state, not a content edit. Tiptap otherwise
    // emits onUpdate and would mark the newly restored revision dirty again.
    editor?.setEditable(false, false);
    try {
      const result = await post<DocPage>(`/documents/${captured.id}/restore`, { revisionId: revision.id, expectedVersion: captured.expectedVersion });
      if (draftRef.current?.id === captured.id && actorRef.current === capturedActor && activeActorRef.current === capturedActor) {
        const next = draftFromPage(result); draftRef.current = next; setDraft(next); rememberDraft(next, capturedActor);
        if (sessionRef.current?.enabled) setLiveReload(value => value + 1);
        else manualEditor?.commands.setContent(next.content, { emitUpdate: false });
        setReferenceSelection(null); setIssueBlockSelection(null); setConflict(null);
      }
      await refresh(); notify('이전 내용을 새 버전으로 복구했습니다.', 'success');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { if (actorRef.current === capturedActor && activeActorRef.current === capturedActor && draftRef.current?.id === captured.id) setConflict('generic'); await refresh().catch(() => {}); }
      notify(error instanceof Error ? error.message : '복구하지 못했습니다.', 'error');
    } finally { savingRef.current = false; setSaving(false); setRestoring(false); editor?.setEditable(true, false); }
  }

  async function saveCopy() {
    const captured = draftRef.current;
    if (!captured || savingRef.current || !confirmCommentEditExit()) return;
    const capturedActor = actorRef.current;
    savingRef.current = true; setSaving(true);
    try {
      const source = data.documents.find(page => page.id === captured.id);
      const result = await post<DocPage>('/documents', { title: `${captured.title || '제목 없는 문서'} (편집 사본)`, projectId: source?.projectId || null, parentId: source?.parentId || null, content: captured.content, status: 'draft', labels: captured.labels });
      await refresh();
      const current = draftRef.current;
      if (current?.id === captured.id && current.editSequence === captured.editSequence && actorRef.current === capturedActor && activeActorRef.current === capturedActor) {
        const clean = { ...current, dirty: false }; draftRef.current = clean; setDraft(clean); rememberDraft(clean, capturedActor);
        discardCommentEdit();
        onSelectDocument(result.id);
      }
      notify('편집 내용을 새 문서로 보관했습니다.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : '사본을 만들지 못했습니다.', 'error'); }
    finally { savingRef.current = false; setSaving(false); }
  }

  async function deleteDocument() {
    const captured = draftRef.current;
    if (!captured || savingRef.current) return;
    const capturedActor = actorRef.current;
    if (data.documents.some(page => page.parentId === captured.id)) { notify('하위 문서를 먼저 다른 위치나 휴지통으로 옮겨 주세요.', 'error'); return; }
    if (liveStateRef.current?.pending || commentBusy || isReplySending() || isCommentEditPending()) { notify('공동 편집과 댓글 저장이 끝난 후 휴지통으로 옮겨 주세요.', 'error'); return; }
    const hasDraft = captured.dirty || listDrafts.current.size || Boolean(commentDraftRef.current.body.trim()) || hasReplyDraft(capturedActor, captured.id) || hasCommentEditDraft();
    if (!window.confirm(`“${captured.title}” 문서를 휴지통으로 옮길까요?${hasDraft ? ' 저장하지 않은 편집과 댓글 초안은 사라집니다.' : ''}`)) return;
    clipboardImageGeneration.current++;
    savingRef.current = true; setSaving(true);
    try {
      await remove(`/documents/${captured.id}?expectedVersion=${captured.expectedVersion}`);
      window.dispatchEvent(new Event('teamspace:trash-changed'));
      const clean = { ...captured, dirty: false }; rememberDraft(clean, capturedActor);
      rememberComment(emptyCommentDraft(), { actorId: capturedActor, documentId: captured.id });
      clearReplyDrafts(capturedActor, captured.id);
      if (reselectedCommentDraft.current?.actorId === capturedActor && reselectedCommentDraft.current.documentId === captured.id) reselectedCommentDraft.current = null;
      try { localStorage.removeItem(selectionCommentCacheKey(capturedActor, captured.id)); } catch { setStorageProblem(true); }
      const sameContext = draftRef.current?.id === captured.id && actorRef.current === capturedActor && activeActorRef.current === capturedActor;
      if (sameContext) {
        discardCommentEdit();
        draftRef.current = null;
        setDraft(null);
        updateCommentDraft(emptyCommentDraft());
      }
      try { await refresh(); }
      catch { notify('문서를 휴지통으로 옮겼습니다. 문서 목록을 불러오지 못했습니다.', 'error'); return; }
      const next = scoped.find(page => page.id !== captured.id);
      if (next && sameContext) onSelectDocument(next.id);
      notify('문서를 휴지통으로 옮겼습니다.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : '문서를 휴지통으로 옮기지 못했습니다.', 'error'); }
    finally { savingRef.current = false; setSaving(false); }
  }

  async function linkIssue(issueId: string) {
    if (!documentId || selectedPage?.id !== documentId || linkBusyRef.current) return false;
    linkBusyRef.current = true;
    setLinkBusy(true);
    let linked = false;
    try {
      await post('/resource-links', { issueId, documentId, kind: 'related' });
      linked = true;
      await refresh();
      notify('업무와 문서를 연결했습니다.', 'success');
      return true;
    } catch (error) {
      notify(linked ? '업무와 문서를 연결했습니다. 연결 목록을 다시 확인해 주세요.'
        : error instanceof Error ? error.message : '업무를 연결하지 못했습니다.', 'error');
      return false;
    } finally {
      linkBusyRef.current = false;
      setLinkBusy(false);
    }
  }

  function discardLocal() {
    if (!selectedPage || !window.confirm('저장하지 않은 편집을 버리고 서버에 저장된 내용을 열까요?')) return;
    clipboardImageGeneration.current++;
    const latest = latestPage ?? selectedPage;
    const current = draftRef.current;
    const next = { ...draftFromPage(latest), ...(sessionRef.current?.enabled && !manualRecoveryRef.current && current ? { content: current.content, plainText: current.plainText } : {}) };
    draftRef.current = next; setDraft(next); rememberDraft(next);
    if (!sessionRef.current?.enabled || manualRecoveryRef.current) manualEditor?.commands.setContent(next.content, { emitUpdate: false });
    manualRecoveryRef.current = false; setManualRecovery(false);
    setConflict(null);
  }

  async function enableCollaboration() {
    const current = draftRef.current;
    if (!current || current.dirty || savingRef.current) { notify('현재 문서를 먼저 저장한 후 공동 편집을 시작해주세요.', 'error'); return; }
    savingRef.current = true; setSaving(true);
    try {
      const result = await post<CollaborationSession>(`/documents/${current.id}/collaboration/enable`, { expectedVersion: current.expectedVersion });
      sessionRef.current = result; setSession(result); setSessionError('');
      await refresh();
    } catch (cause) { notify(cause instanceof Error ? cause.message : '공동 편집을 시작하지 못했습니다.', 'error'); }
    finally { savingRef.current = false; setSaving(false); }
  }

  async function checkpoint() {
    const current = draftRef.current;
    if (!current || current.dirty || liveStateRef.current?.pending || liveStateRef.current?.phase !== 'connected' || savingRef.current) return;
    savingRef.current = true; setSaving(true);
    try {
      const revision = await post<DocRevision>(`/documents/${current.id}/checkpoint`, { summary: '공동 편집 버전 기록' });
      setRevisions(previous => [revision, ...previous.filter(item => item.id !== revision.id)]); setSideTab('history'); setSidebarOpen(true);
      notify('서버에 저장된 본문을 버전으로 기록했습니다.', 'success');
    } catch (cause) { notify(cause instanceof Error ? cause.message : '버전을 기록하지 못했습니다.', 'error'); }
    finally { savingRef.current = false; setSaving(false); }
  }

  const openRecoveryCopy = useCallback((id: string) => {
    void refresh().then(() => {
      if (!confirmCommentEditExit()) return;
      discardCommentEdit();
      onSelectDocument(id);
    }).catch(cause => notify(cause instanceof Error ? cause.message : '사본 목록을 불러오지 못했습니다.', 'error'));
  }, [refresh, onSelectDocument, notify, confirmCommentEditExit, discardCommentEdit]);

  function insertUrlBlock(event: React.FormEvent) {
    event.preventDefault();
    if (!editor?.isEditable) return;
    let url: URL;
    try { url = new URL(insertUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
    catch { notify('http 또는 https 주소를 입력해주세요.', 'error'); return; }
    if (insertKind === 'image') editor?.chain().focus().setImage({ src: url.href, alt: '문서 이미지' }).run();
    else editor?.chain().focus().extendMarkRange('link').setLink({ href: url.href }).run();
    setInsertKind(null); setInsertUrl('');
  }

  const insertAttachmentLink: NonNullable<AttachmentsProps['onInsertFileLink']> = ({ filename, href }) => {
    if (bodyReadOnly || archivedLiveRecovery || checklistReselecting || !editor?.isEditable || editor.isDestroyed ||
        draftRef.current?.id !== selectedPageId || (liveMode && liveState?.document.id !== selectedPageId)) return;
    const { $to } = editor.state.selection;
    const link = editor.schema.marks.link;
    // The editor keeps its mapped selection while focus is in the file panel.
    // Insert at its end to preserve selected document text.
    if (!$to.parent.isTextblock || !$to.parent.type.allowsMarkType(link)) {
      notify('본문에서 링크를 삽입할 위치를 먼저 선택해 주세요.', 'error');
      return;
    }
    const inserted = editor.chain().focus().insertContentAt($to.pos, { type: 'text', text: filename, marks: [{ type: 'link', attrs: { href } }] })
      .command(({ tr }) => { tr.removeStoredMark(link); return true; }).run();
    if (!inserted) notify('이 위치에 첨부파일 링크를 삽입할 수 없습니다.', 'error');
  };

  async function pasteClipboardImages(event: ReactClipboardEvent<HTMLDivElement>) {
    if (!editor?.isEditable || editor.isDestroyed || event.defaultPrevented || !(event.target instanceof Element) ||
        event.target.closest('[contenteditable]') !== editor.view.dom) return;
    const files = clipboardImageFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();

    const scope = clipboardImageScope.current;
    const generation = clipboardImageGeneration.current;
    const route = location.hash.split('?')[0];
    if (!scope || scope.editor !== editor || !navigator.onLine) {
      notify('문서를 편집할 수 있는 상태로 열고 연결을 확인한 뒤 이미지를 다시 붙여넣어 주세요.', 'error');
      return;
    }
    const isCurrent = () => {
      const activeSession = sessionRef.current;
      const live = liveStateRef.current;
      return clipboardImageScope.current === scope && clipboardImageGeneration.current === generation &&
        activeActorRef.current === scope.actorId && actorRef.current === scope.actorId && draftRef.current?.id === scope.documentId &&
        activeSession?.document.id === scope.documentId && !manualRecoveryRef.current && !archivedLiveRecoveryRef.current &&
        (scope.liveEpoch === null ? !activeSession.enabled : activeSession.enabled && live?.phase === 'connected' &&
          live.epoch === scope.liveEpoch && live.document.id === scope.documentId) &&
        navigator.onLine && location.hash.split('?')[0] === route && !editor.isDestroyed && editor.isEditable &&
        editor.view.dom.isConnected && !editor.view.dom.closest('[inert]');
    };
    const anchor = isCurrent() ? trackClipboardImagePosition(editor) : null;
    if (!anchor) {
      notify('이미지를 붙여넣을 문서 본문의 문단에 커서를 놓고 다시 시도해 주세요.', 'error');
      return;
    }

    setClipboardImageUploads(previous => ({ ...previous, [documentScope]: (previous[documentScope] ?? 0) + 1 }));
    let lastSavedVersion: string | undefined;
    let problem: string | undefined;
    const images: { src: string; alt: string }[] = [];
    try {
      for (const file of files) {
        if (!isCurrent()) { problem ??= '편집 화면이 변경되어 남은 이미지는 첨부하지 못했습니다.'; break; }
        if (!isInlineAttachmentImage(file.type)) { problem ??= 'PNG, JPEG, GIF, WebP 이미지를 붙여넣을 수 있습니다.'; continue; }
        if (file.size > MAX_ATTACHMENT_BYTES) { problem ??= '이미지는 한 파일당 20 MB까지 첨부할 수 있습니다.'; continue; }
        const filename = file.name || `clipboard-image.${file.type.slice('image/'.length)}`;
        const query = new URLSearchParams({ resourceType: 'document', resourceId: scope.documentId, filename });
        try {
          const attachment = await api<AttachmentHead>(`/attachments?${query}`, {
            method: 'POST', body: file, signal: AbortSignal.timeout(120_000),
            headers: { 'Content-Type': 'application/octet-stream', 'X-File-Type': file.type, 'X-Actor-Id': scope.actorId },
          });
          const src = attachmentFileUrl(attachment.currentVersionId, true);
          if (attachment.resourceType !== 'document' || attachment.resourceId !== scope.documentId || !inlineAttachmentIdFromUrl(src)) {
            problem ??= '첨부 결과를 확인하지 못했습니다. 원래 문서의 파일 탭을 확인해 주세요.';
            continue;
          }
          lastSavedVersion = attachment.currentVersionId;
          if (isInlineAttachmentImage(attachment.mimeType)) images.push({ src, alt: attachment.filename });
          else problem ??= '본문에 표시할 수 없는 형식입니다. 원래 문서의 파일 탭에서 확인해 주세요.';
        } catch (error) {
          problem ??= error instanceof ApiError
            ? `이미지를 첨부하지 못했습니다. ${error.message}`
            : '이미지 첨부를 확인하지 못했습니다. 연결과 원래 문서의 파일 탭을 확인한 뒤 다시 시도해 주세요.';
        }
      }
      const inserted = images.length > 0 && isCurrent() && anchor.insert(images);
      if (activeActorRef.current === scope.actorId) {
        if (lastSavedVersion) {
          if (editorWrap.current && draftRef.current?.id === scope.documentId) {
            setClipboardAttachment({ documentId: scope.documentId, versionId: lastSavedVersion });
          }
          void refresh().catch(() => {});
        }
        if (images.length > 0 && !inserted) {
          notify(`첨부한 이미지를 본문에 삽입하지 못했습니다. 원래 문서의 파일 탭에서 확인해 주세요.${problem ? ` ${problem}` : ''}`, 'error');
        } else if (problem) {
          notify(inserted ? `일부 이미지를 본문에 삽입했습니다. ${problem}` : problem, 'error');
        } else if (inserted) notify('이미지를 본문에 삽입했습니다.');
      }
    } finally {
      anchor.stop();
      setClipboardImageUploads(previous => {
        const next = { ...previous };
        if (next[documentScope] > 1) next[documentScope]--;
        else delete next[documentScope];
        return next;
      });
    }
  }

  async function refreshReferences() {
    if (referencesRefreshing) return; setReferencesRefreshing(true);
    try {
      await refresh();
      setChecklistReload(version => version + 1);
      notify('참조, 포함 원본, 업무 현황과 문서 목록을 새로 불러왔습니다.', 'success');
    }
    catch (cause) { notify(cause instanceof Error ? cause.message : '참조를 새로 불러오지 못했습니다.', 'error'); }
    finally { setReferencesRefreshing(false); }
  }

  function openReference(kind: ReferenceKind, slash?: DocumentSlashAnchor) {
    if (!editor?.isEditable || !draftRef.current) return;
    setReferenceSelection({ kind, editor, bookmark: editor.state.selection.getBookmark(), documentId: draftRef.current.id, slash });
    setSlashQuery(null); setInsertKind(null); setIssueBlockSelection(null); closeAnnotation();
  }

  function insertExcerpt() {
    if (!editor?.isEditable) return;
    if (findDocumentExcerpt(editor.getJSON() as RichContent)) {
      notify('이 문서에 이미 발췌 구역이 있습니다.', 'error');
      return;
    }
    if (!insertDocumentExcerpt(editor)) notify('이 위치에는 발췌 구역을 넣을 수 없습니다.', 'error');
  }

  function insertDocumentList(type: 'documentLabelList' | 'documentChildList') {
    if (!editor?.isEditable || !selectedPage) return;
    const isChildList = type === 'documentChildList';
    const max = isChildList ? MAX_DOCUMENT_CHILD_LISTS : MAX_DOCUMENT_LABEL_LISTS;
    let count = 0;
    editor.state.doc.descendants(node => { if (node.type.name === type) count++; });
    if (count >= max) {
      notify(`${isChildList ? '하위 문서 목록' : '라벨별 문서 목록'}은 문서당 ${max}개까지 넣을 수 있습니다.`, 'error');
      return;
    }
    return editor.chain().focus().insertContent([
      isChildList ? { type } : { type, attrs: { projectId: selectedPage.projectId } }, { type: 'paragraph' },
    ]).run();
  }

  function insertPropertyBlock(type: 'documentProperties' | 'documentPropertyReport') {
    if (!editor?.isEditable || !selectedPage) return;
    let count = 0;
    editor.state.doc.descendants(node => {
      if (node.type.name === 'documentProperties' || node.type.name === 'documentPropertyReport') count++;
    });
    if (count >= MAX_DOCUMENT_PROPERTY_BLOCKS) {
      notify(`속성과 속성 보고서는 한 문서에 합계 ${MAX_DOCUMENT_PROPERTY_BLOCKS}개까지 넣을 수 있습니다.`, 'error');
      return;
    }
    const block = type === 'documentProperties' ? { type } : { type, attrs: { projectId: selectedPage.projectId } };
    if (!editor.chain().focus().insertContent([block, { type: 'paragraph' }]).run()) notify('이 위치에는 블록을 넣을 수 없습니다.', 'error');
  }

  function insertColumns(count: 2 | 3, slash?: DocumentSlashRange) {
    if (editor?.isEditable && !insertDocumentColumnLayout(editor, count, slash)) notify('이 위치에는 다단 구역을 넣을 수 없습니다.', 'error');
  }

  const slashCommands: ({ label: string; search: string } & (
    { action: () => unknown } | { annotation: DocumentAnnotationKind } | { columns: 2 | 3 } |
    { reference: ReferenceKind } | { issueBlock: Parameters<OpenIssueBlock>[1] }
  ))[] = [
    ...DOCUMENT_HEADING_LEVELS.map(level => ({
      label: `제목 ${level}`,
      search: `h${level} heading 제목`,
      action: () => editor?.chain().focus().toggleHeading({ level }).run(),
    })),
    { label: '글머리 목록', search: 'list bullet 목록', action: () => editor?.chain().focus().toggleBulletList().run() },
    { label: '체크리스트', search: 'task check 할일 체크', action: () => editor?.chain().focus().toggleTaskList().run() },
    { label: '인용', search: 'quote 인용', action: () => editor?.chain().focus().toggleBlockquote().run() },
    { label: '코드 블록', search: 'code 코드', action: () => editor?.chain().focus().toggleCodeBlock().run() },
    { label: '표', search: 'table 표', action: () => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { label: '2단 구역', search: 'columns 2cols layout 2열 배치 다단 구역', columns: 2 },
    { label: '3단 구역', search: 'columns 3cols layout 3열 배치 다단 구역', columns: 3 },
    { label: '업무 참조', search: 'issue ticket 업무 참조', reference: 'issueReference' },
    { label: '업무 목록', search: 'issue list view ticket 업무 목록 공유 보기', issueBlock: 'issueList' },
    { label: '업무 현황', search: 'issue summary chart 업무 현황 집계', issueBlock: 'issueSummary' },
    { label: '문서 참조', search: 'document link 문서 참조', reference: 'documentReference' },
    { label: '라벨별 문서 목록', search: 'document list labels 라벨별 문서 목록', action: () => insertDocumentList('documentLabelList') },
    { label: '하위 문서 목록', search: 'children child pages descendants tree 하위 문서 목록', action: () => insertDocumentList('documentChildList') },
    { label: '문서 속성', search: 'document properties metadata 문서 속성', action: () => insertPropertyBlock('documentProperties') },
    { label: '문서 속성 보고서', search: 'document property report rollup 문서 속성 보고서', action: () => insertPropertyBlock('documentPropertyReport') },
    { label: '문서 포함', search: 'include embed 문서 포함', reference: 'documentInclude' },
    { label: '발췌 구역', search: 'excerpt source 발췌 구역', action: insertExcerpt },
    { label: '발췌 포함', search: 'excerpt include 발췌 포함', reference: 'documentExcerptInclude' },
    { label: '문서 버전 포함', search: 'pin snapshot version 문서 버전 고정 포함', reference: 'documentRevisionInclude' },
    { label: '본문 목차', search: 'toc table of contents 본문 목차', action: () => insertDocumentToc(editor) },
    { label: '안내 상자', search: 'callout info note warning tip panel 안내 상자', annotation: 'callout' },
    { label: '상태 배지', search: 'status badge 상태 배지', annotation: 'statusBadge' },
    { label: '접기 블록', search: 'details expand collapse 접기 펼치기', action: () => insertDetails(editor) },
    { label: '구분선', search: 'divider 구분선', action: () => editor?.chain().focus().setHorizontalRule().run() },
  ];

  const matchingSlashCommands = slashQuery === null ? [] : slashCommands.filter(command => `${command.label} ${command.search}`.toLowerCase().includes(slashQuery.toLowerCase()));

  function runSlash(command: typeof slashCommands[number]) {
    const current = draftRef.current;
    if (bodyReadOnly || !editor?.isEditable || !current || current.id !== selectedPage?.id || slashQuery === null) return;
    const { $from, empty } = editor.state.selection;
    const from = $from.start(), to = $from.pos;
    const text = editor.state.doc.textBetween(from, to, '', '\ufffc');
    setSlashQuery(null);
    if (!empty || text !== '/' + slashQuery) return;
    const range = { from, to, text };
    if ('columns' in command) insertColumns(command.columns, range);
    else if ('action' in command) {
      editor.chain().focus().deleteRange({ from, to }).run();
      command.action();
    } else {
      const slash = captureDocumentSlashAnchor(editor, range);
      if (!slash) { notify('슬래시 명령이 변경되었습니다. 편집 위치를 다시 선택해 주세요.', 'error'); return; }
      if ('reference' in command) openReference(command.reference, slash);
      else if ('issueBlock' in command) openIssueBlock(editor, command.issueBlock, undefined, slash);
      else {
        setAnnotationSelection({ editor, documentId: current.id, kind: command.annotation, opener: null, mode: 'insert',
          bookmark: editor.state.selection.getBookmark(), slash });
        setInsertKind(null); setIssueBlockSelection(null); setReferenceSelection(null);
      }
    }
  }

  function navigateSlash(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (bodyReadOnly || !matchingSlashCommands.length || event.nativeEvent.isComposing || !editor?.isFocused) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setSlashIndex(index => (index + (event.key === 'ArrowDown' ? 1 : matchingSlashCommands.length - 1)) % matchingSlashCommands.length);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      runSlash(matchingSlashCommands[slashIndex]);
    }
  }

  const references = draft ? contentReferences(draft.content) : [];
  const showLinkPanel = sidebarOpen && sideTab === 'links';
  const workspaceLocation = typeof window === 'undefined' ? undefined : window.location;
  const draftContent = draft?.content;
  const draftId = draft?.id;
  const documentsById = useMemo(() => new Map(data.documents.map(page => [page.id, page])), [data.documents]);
  const outgoingDocuments = useMemo(() => showLinkPanel && draftContent
    ? documentPanelReferences(draftContent, workspaceLocation) : [], [showLinkPanel, draftContent, workspaceLocation]);
  const backlinks = useMemo(() => showLinkPanel && draftId
    ? documentPanelBacklinks(data.documents, draftId, workspaceLocation) : [], [showLinkPanel, draftId, data.documents, workspaceLocation]);
  const savedContent = selectedPage?.content;
  const savedIssueReferences = useMemo(() => savedContent
    ? contentReferences(savedContent).filter(reference => reference.type === 'issue') : [], [savedContent]);
  const issuesById = useMemo(() => new Map(data.issues.map(issue => [issue.id, issue])), [data.issues]);
  const savedIssueReferenceIds = new Set(savedIssueReferences.map(reference => reference.id));
  const draftIssueReferences = draft?.id === selectedPage?.id
    ? references.filter(reference => reference.type === 'issue' && !savedIssueReferenceIds.has(reference.id)) : [];
  const unresolvedIssueReferences = savedIssueReferences.filter(reference => !issuesById.has(reference.id));
  const supplementalIssueReferences = [...new Map([...draftIssueReferences, ...unresolvedIssueReferences]
    .map(reference => [reference.id, reference])).values()];
  const candidateIssues = useMemo(() => {
    const linkedIssueIds = new Set(data.resourceLinks.filter(link => link.documentId === documentId).map(link => link.issueId));
    return data.issues.filter(issue => !linkedIssueIds.has(issue.id));
  }, [data.issues, data.resourceLinks, documentId]);
  const descendants = new Set<string>();
  const collectDescendants = (id: string) => { for (const child of data.documents.filter(page => page.parentId === id)) if (!descendants.has(child.id)) { descendants.add(child.id); collectDescendants(child.id); } };
  if (draft) collectDescendants(draft.id);
  const parentOptions = data.documents.filter(page => page.id !== draft?.id && !descendants.has(page.id) && page.projectId === latestPage?.projectId);
  const metadataReview = conflict && conflict !== 'generic' ? conflict : null;
  const previewDocument = metadataReview?.document ?? latestPage;
  const reviewKey = draft && metadataReview ? metadataReviewKey(draft, metadataReview) : null;
  function formatMetadata(field: DocumentMetadataField, value: DocumentMetadata) {
    switch (field) {
      case 'title': return documentTitleForSave(value.title);
      case 'status': return value.status === 'published' ? '공유 표시' : '초안';
      case 'parentId': return value.parentId ? data.documents.find(page => page.id === value.parentId)?.title ?? value.parentId : '최상위 문서';
      case 'labels': return value.labels.join(', ') || '라벨 없음';
    }
  }
  function resolveMetadata(choices: DocumentMetadataChoices) {
    const current = draftRef.current;
    const latest = conflictRef.current;
    if (savingRef.current || actorRef.current !== actorId || activeActorRef.current !== actorId || !current
      || !latest || latest === 'generic' || current.id !== selectedDocumentId || metadataReviewKey(current, latest) !== reviewKey) return;
    if (listDrafts.current.size && !liveMode) {
      notify('문서 목록 설정을 적용하거나 취소한 뒤 속성을 정리해 주세요.', 'error');
      return;
    }
    if (choices.parentId === 'local' && (latest.parentContextChanged || current.parentId && !parentOptions.some(page => page.id === current.parentId))) return;
    reconcileDraft({ document: latest.document, live: liveMode }, choices);
    if (!conflictRef.current) titleInput.current?.focus({ preventScroll: true });
  }
  const tree = (pages: DocPage[], parentId: string | null = null, level = 0, visited = new Set<string>()): React.ReactNode => pages
    .filter(page => filtersActive ? level === 0 : (page.parentId === parentId || (parentId === null && !pages.some(other => other.id === page.parentId))))
    .map(page => {
      if (visited.has(page.id)) return null;
      const nextVisited = new Set(visited); nextVisited.add(page.id);
      const children = pages.some(other => other.parentId === page.id);
      return <div key={page.id}>
        <div className={`docs-tree-row ${draft?.id === page.id ? 'is-selected' : ''}`} style={{ paddingLeft: 10 + level * 15 }}>
          <button type="button" className="docs-tree-toggle" aria-label={`${page.title} ${collapsed.has(page.id) ? '펼치기' : '접기'}`} disabled={!children || filtersActive} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(page.id)) next.delete(page.id); else next.add(page.id); return next; })}>{children && !filtersActive ? collapsed.has(page.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} /> : <span />}</button>
          <button type="button" className="docs-tree-link" onClick={() => selectDocument(page.id)}><span className="docs-page-icon">{page.icon || '📄'}</span><span>{page.title || '제목 없는 문서'}</span>{page.status === 'draft' && <span className="docs-draft-dot" title="초안" />}</button>
          <button type="button" className="docs-tree-add" title="하위 문서 만들기" aria-label={`${page.title} 하위 문서 만들기`} onClick={() => openNew(page.id)}><Plus size={13} /></button>
        </div>
        {!filtersActive && !collapsed.has(page.id) && tree(pages, page.id, level + 1, nextVisited)}
      </div>;
    });

  const canRequestPublication = Boolean(draft && !draft.dirty && !saving && !bodyReadOnly &&
    (!liveMode || (liveState?.phase === 'connected' && !liveState.pending)));
  const selectionDocument = liveMode ? liveState?.document : latestPage;
  let selectionUnavailable: string | null = null;
  if (draft?.bodyDirty) selectionUnavailable = '선택한 내용을 사용하려면 변경한 본문을 먼저 저장해 주세요.';
  else if (liveMode && (liveState?.phase !== 'connected' || liveState.pending)) {
    selectionUnavailable = '본문 동기화가 끝나면 선택한 내용을 사용할 수 있습니다.';
  } else if (saving || bodyReadOnly || conflict || !draft || !selectionDocument
    || draft.id !== selectedPage?.id || selectionDocument.id !== draft.id || selectionDocument.version !== draft.expectedVersion) {
    selectionUnavailable = '최신 저장본을 확인한 뒤 본문을 선택해 주세요.';
  }
  const selectionIssueUnavailable = data.projects.length ? null : '업무를 연결할 프로젝트가 없습니다.';
  const checklistWork = useDocumentChecklistWork(!selectionUnavailable && !checklistReselecting ? selectionDocument ?? null : null,
    data.resourceLinks, { actorId, restoreGeneration: data.restoreGeneration, reload: checklistReload });
  function showChecklistDocumentLinks() {
    setSideTab('links');
    setSidebarOpen(true);
    requestAnimationFrame(() => linksTab.current?.focus({ preventScroll: true }));
  }
  function openFollowUp(page: DocPage, opener: HTMLButtonElement, sourceSelection?: DocumentSourceSelection) {
    documentActionOpener.current = opener;
    setDocumentAction({ kind: 'create', source: { id: page.id, title: page.title, projectId: page.projectId, version: page.version, sourceSelection } });
  }
  function openChecklistFollowUp(sourceSelection: DocumentSourceSelection, opener: HTMLButtonElement) {
    if (!selectionDocument || selectionUnavailable || selectionIssueUnavailable) return;
    const { id, title, projectId, version } = selectionDocument;
    if (checklistReselecting) {
      if (documentAction?.kind !== 'create' || documentAction.source.checklistTitle === undefined || documentAction.source.id !== id) return;
      setChecklistReselecting(false);
    } else {
      documentActionOpener.current = opener;
    }
    setDocumentAction({ kind: 'create', source: { id, title, projectId, version, sourceSelection, checklistTitle: sourceSelection.text } });
  }
  function reselectChecklistSource() {
    if (documentAction?.kind !== 'create' || documentAction.source.checklistTitle === undefined || documentAction.source.id !== draft?.id) return;
    if (!liveMode && !manualRecovery && latestPage?.id === draft.id) {
      observeDocument({ document: latestPage, live: false });
    }
    setChecklistReselecting(true);
    requestAnimationFrame(() => { if (editor && !editor.isDestroyed) editor.commands.focus(); });
  }
  function cancelChecklistReselect() { setChecklistReselecting(false); }
  function openCommentFollowUp(comment: Comment, opener: HTMLButtonElement, kind: 'create' | 'link') {
    const source = comment.documentSource;
    if (!source || comment.resourceType !== 'document' || comment.parentCommentId !== undefined || latestPage?.id !== comment.resourceId) return;
    const { id, title, projectId, version } = latestPage;
    documentActionOpener.current = opener;
    const page = { id, title, projectId, version };
    const evidence = { id: comment.id, source: { ...source } };
    if (kind === 'link') setDocumentAction({ kind, source: { ...page, comment: evidence } });
    else setDocumentAction({ kind, source: { ...page, comment: { ...evidence, body: comment.body } } });
  }
  function openDecisionLink(page: DocPage, opener: HTMLButtonElement, sourceSelection: DocumentSourceSelection) {
    documentActionOpener.current = opener;
    setDocumentAction({ kind: 'link', source: { id: page.id, title: page.title, projectId: page.projectId, version: page.version, sourceSelection } });
  }
  function openSelectionComment(page: DocPage, opener: HTMLButtonElement, sourceSelection: DocumentSourceSelection) {
    documentActionOpener.current = opener;
    const preserved = reselectedCommentDraft.current;
    let initialDraft = emptyCommentDraft();
    if (preserved?.documentId === page.id && preserved.actorId === actorId) {
      initialDraft = preserved.draft;
      reselectedCommentDraft.current = null;
    }
    try {
      const key = selectionCommentCacheKey(actorId, page.id);
      const cached = localStorage.getItem(key);
      if (cached !== null) {
        if (!initialDraft.body) initialDraft = decodeCommentDraft(cached);
        localStorage.removeItem(key);
      }
    } catch { setStorageProblem(true); }
    setDocumentAction({ kind: 'comment', initialDraft, source: { id: page.id, title: page.title, version: page.version, sourceSelection } });
  }
  function reselectCommentSource(value: CommentDraft) {
    if (documentAction?.kind !== 'comment') return;
    const documentId = documentAction.source.id;
    reselectedCommentDraft.current = { actorId, documentId, draft: value };
    try { localStorage.setItem(selectionCommentCacheKey(actorId, documentId), encodeCommentDraft(value)); } catch { setStorageProblem(true); }

    if (!liveMode && !manualRecovery && latestPage?.id === documentId) {
      observeDocument({ document: latestPage, live: false });
    }
    closeDocumentAction(false);
    requestAnimationFrame(() => { if (editor && !editor.isDestroyed) editor.commands.focus(); });
  }
  const button = (label: string, icon: React.ReactNode, onClick: (event: React.MouseEvent<HTMLButtonElement>) => unknown, active = false) => <button disabled={bodyReadOnly} type="button" className={`docs-format-btn ${active ? 'is-active' : ''}`} title={label} aria-label={label} onMouseDown={event => event.preventDefault()} onClick={onClick}>{icon}</button>;
  const activeHeadingLevel = DOCUMENT_HEADING_LEVELS.find(level => editor?.isActive('heading', { level }));
  const inColumnLayout = editor?.isActive('documentColumnLayout');
  function openFind() {
    if (!canFind) return;
    if (findOpen) {
      findInput.current?.focus({ preventScroll: true });
      findInput.current?.select();
    } else setFindScope(documentScope);
  }
  function closeFind() {
    setFindScope(null);
    findOpener.current?.focus({ preventScroll: true });
  }
  function handleEditorKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (checklistReselecting) return;
    const { key, target } = event;
    if (canFind && editor && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey &&
        !event.nativeEvent.isComposing && key.toLowerCase() === 'f' &&
        target instanceof Element && target.closest('[contenteditable]') === editor.view.dom) {
      event.preventDefault();
      event.stopPropagation();
      openFind();
      return;
    }
    navigateSlash(event);
  }

  return <DocumentBlocksProvider data={data} actorId={actorId} documentId={draft?.id || null} content={draft?.content} openIssue={openIssue} openDocument={openDocument}
    editorReadOnly={bodyReadOnly || archivedLiveRecovery}
    openIssueBlock={bodyReadOnly || checklistReselecting ? undefined : openIssueBlock} onListDraftChange={trackListDraft}>
    <DocumentAnnotationProvider value={bodyReadOnly || checklistReselecting ? undefined : openAnnotation}><section className="documents-feature">
    <div className="docs-heading" inert={newOpen || archiveImport || checklistReselecting || Boolean(templateManager || offlineExport)}><div><div className="docs-eyebrow">KNOWLEDGE</div><h1>문서 <span>{scoped.length}</span></h1><p>아이디어부터 결정까지, 팀의 지식을 한곳에.</p></div>
      <div className="document-template-heading-actions">
        <button className="btn" type="button" onClick={event => openOfflineExport(currentProject ? 'project' : 'common', event.currentTarget)}>
          <ArrowDownToLine size={15} aria-hidden="true" />Markdown ZIP 내보내기
        </button>
        <button ref={archiveImportOpener} className="btn" type="button" disabled={saving || restoring || creating}
          onClick={() => { setExportOpen(false); setArchiveImport(true); }}>
          <FileInput size={15} aria-hidden="true" />Markdown ZIP 가져오기
        </button>
        <button className="btn" type="button" onClick={event => manageTemplates(event.currentTarget)}><FileStack size={15} aria-hidden="true" />팀 템플릿 관리</button>
        <button className="btn btn-primary" onClick={() => openNew()}><Plus size={16} /> 새 문서</button>
      </div>
    </div>
    <div className={`docs-layout ${sidebarOpen && !checklistReselecting ? 'has-panel' : ''}`}
      inert={publicationOpen || newOpen || archiveImport || Boolean(issueBlockDialog || templateManager || offlineExport || (documentAction && !checklistReselecting))}
      onKeyDownCapture={event => {
        if (!checklistReselecting || event.key !== 'Escape' || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        cancelChecklistReselect();
      }}>
      <aside className="docs-tree" aria-label="문서 목록" inert={checklistReselecting}>
        <label className="docs-tree-search"><Search size={14} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="문서 찾기" aria-label="문서 찾기" /></label>
        {onChangeDocumentLabel && <div className="docs-label-filters">
          <select aria-label="문서 라벨 필터" value={documentLabel ?? ''} onChange={event => onChangeDocumentLabel(event.target.value || null)}>
            <option value="">모든 라벨</option>
            {documentLabel && !labelOptions.has(documentLabel) && <option value={documentLabel}>{activeLabel}</option>}
            {[...labelOptions].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          {documentLabel && <button type="button" aria-label="라벨 필터 해제" title="라벨 필터 해제" onClick={() => onChangeDocumentLabel(null)}><X size={13} aria-hidden="true" /></button>}
        </div>}
        {filtersActive && <p role="status" className="docs-filter-count">{activeLabel && <>{activeLabel} · </>}문서 {visible.length}개</p>}
        <div className="docs-tree-content">
          <div className="docs-tree-group"><span>{currentProject?.name || '프로젝트 문서'}</span>
            <div className="docs-tree-group-actions">
              {currentProject && <NotificationSubscriptionButton actorId={actorId} targetType="space" targetId={documentNotificationSpaceId(currentProject.id)} notify={notify} />}
              <button type="button" className="docs-tree-group-add" aria-label="프로젝트 문서 추가" onClick={() => openNew()}><Plus size={14} /></button>
            </div>
          </div>
          {tree(treePages.filter(page => page.projectId !== null))}
          {!filtersActive && !visible.some(page => page.projectId !== null) && <p className="docs-tree-empty">첫 문서를 작성해보세요.</p>}
          <div className="docs-tree-group docs-tree-common"><span>팀 공통 문서</span>
            <div className="docs-tree-group-actions">
              <NotificationSubscriptionButton actorId={actorId} targetType="space" targetId={documentNotificationSpaceId(null)} notify={notify} />
              <button type="button" className="docs-tree-group-add" aria-label="팀 공통 문서 추가" onClick={() => { openNew(); setNewProject(''); }}><Plus size={14} /></button>
            </div>
          </div>
          {tree(treePages.filter(page => page.projectId === null))}
          {!filtersActive && !visible.some(page => page.projectId === null) && <p className="docs-tree-empty">함께 참고하는 지식을 모아보세요.</p>}
        </div>
        <button className="docs-template-shortcut" onClick={() => openNew('', 'meeting')}><FilePlus2 size={16} /><span>템플릿으로 시작하기</span><ChevronRight size={14} /></button>
      </aside>

      {draft && selectedPage ? <>
        <main className="docs-document">
          <div className="docs-document-topbar" inert={checklistReselecting}>
            <div className="docs-breadcrumb"><FileText size={14} /><span>{selectedPage.projectId ? data.projects.find(project => project.id === selectedPage.projectId)?.name || '프로젝트' : '팀 공통'}</span><ChevronRight size={12} /><span>{draft.title || '제목 없는 문서'}</span></div>
            <div className="docs-top-actions"><span className={`docs-save-state ${draft.dirty ? 'is-dirty' : ''}`} aria-live="polite">{saving ? <><Loader2 size={12} className="docs-spin" /> 저장 중</> : draft.dirty ? <><span /> {liveMode ? '속성 변경' : '저장 필요'}</> : liveMode ? liveState?.phase === 'connected' && !liveState.pending ? <><CheckCheck size={13} /> 동기화됨</> : '동기화 대기' : <><CheckCheck size={13} /> 저장됨</>}</span>
              <FavoriteAction type="document" id={selectedPage.id} />
              <NotificationSubscriptionButton actorId={actorId} targetType="document" targetId={selectedPage.id} notify={notify} />
              <button ref={publicationOpener} type="button" className="btn btn-ghost docs-publication-button" disabled={saving || restoring} onClick={() => setPublicationDocumentId(selectedPage.id)}><FileCheck2 size={14} />검토·발행</button>
              <button type="button" className="btn btn-ghost docs-icon-button" title="팀 템플릿으로 저장" aria-label="팀 템플릿으로 저장"
                disabled={saving || restoring} onClick={event => manageTemplates(event.currentTarget, latestPage ?? selectedPage)}><FileStack size={16} aria-hidden="true" /></button>
              {liveMode ? <button className="btn btn-ghost docs-checkpoint-button" disabled={saving || draft.dirty || liveState?.pending || liveState?.phase !== 'connected'} onClick={() => void checkpoint()}><History size={13} /> 버전 기록</button> : activeSession && !activeSession.enabled && <button className="btn btn-ghost docs-enable-collaboration" disabled={saving || draft.dirty} onClick={() => void enableCollaboration()}>공동 편집 시작</button>}
              <div className="docs-export-container">
                <button ref={exportMenuTrigger} className="btn btn-ghost docs-icon-button" title="문서 내보내기" aria-label="문서 내보내기"
                  aria-expanded={exportOpen} onClick={() => setExportOpen(value => !value)}><ArrowDownToLine size={16} /></button>
                {exportOpen && <div className="docs-popover docs-export-menu">
                  <button onClick={() => { downloadDocument(`${draft.title || 'document'}.md`, `# ${draft.title}\n\n${contentMarkdown(draft.content)}`, 'text/markdown;charset=utf-8'); setExportOpen(false); }}>Markdown 내보내기</button>
                  <button onClick={() => { downloadDocument(`${draft.title || 'document'}.json`, JSON.stringify({ format: 'teamspace-document', schemaVersion: Math.max(2, documentContentSchemaVersion(draft.content)), document: { ...selectedPage, title: draft.title, content: draft.content, plainText: draft.plainText, status: draft.status, parentId: draft.parentId, labels: draft.labels.length ? draft.labels : undefined } }, null, 2), 'application/json'); setExportOpen(false); }}>문서 JSON 내보내기</button>
                  <button onClick={() => openOfflineExport('subtree', exportMenuTrigger.current)}>문서 트리 ZIP 내보내기</button>
                </div>}
              </div>
              <button type="button" className="btn btn-ghost docs-icon-button" title="문서 이동" aria-label="문서 이동" onClick={() => {
                const blocker = moveBlocker();
                if (blocker) { notify(blocker, 'error'); return; }
                setExportOpen(false);
                setMoveDocumentId(selectedPage.id);
              }}><FolderInput size={16} aria-hidden="true" /></button>
              <button type="button" className="btn btn-ghost docs-icon-button" title="문서 복제" aria-label="문서 복제"
                disabled={saving || restoring} onClick={() => { setExportOpen(false); setCopyDocumentId(selectedPage.id); }}>
                <Copy size={16} aria-hidden="true" />
              </button>
              <button type="button" className="btn btn-ghost docs-icon-button" title="문서 순서 편집" aria-label="문서 순서 편집"
                disabled={saving || restoring} onClick={() => { setExportOpen(false); setOrderDocumentId(selectedPage.id); }}>
                <ListOrdered size={16} aria-hidden="true" />
              </button>
              <button className="btn btn-ghost docs-icon-button" title={sidebarOpen ? '정보 패널 닫기' : '정보 패널 열기'} aria-label={sidebarOpen ? '정보 패널 닫기' : '정보 패널 열기'} onClick={() => setSidebarOpen(value => !value)}>{sidebarOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button>
              <button className="btn btn-primary docs-save-button" disabled={saving || !draft.dirty || manualRecovery || Boolean(metadataReview) || (liveMode && (liveState?.pending || liveState?.phase !== 'connected'))} onClick={() => void saveDraft()}><Save size={14} /> {liveMode ? '속성 저장' : '저장'}</button>
            </div>
          </div>

          {conflict && !manualRecovery && <div className="docs-notice docs-conflict" role="alert"><strong>{metadataReview ? '같은 문서 속성이 변경됐어요.' : '다른 변경사항이 있어요.'}</strong><span>{metadataReview ? '최신본을 열어 저장할 값을 선택해 주세요.' : '내 편집은 유지했습니다. 최신본을 확인한 후 정리해주세요.'}</span><div><button aria-expanded={showLatest} onClick={() => setShowLatest(value => !value)}>서버 최신본 보기</button><button onClick={() => void saveCopy()} disabled={saving}>내 편집을 새 문서로 보관</button><button onClick={discardLocal} disabled={saving}>편집 버리고 최신본 열기</button></div></div>}
          {showLatest && previewDocument && <div className="docs-latest-preview"><div><strong>서버 버전 {previewDocument.version} · {previewDocument.title}</strong><button aria-label="최신본 미리보기 닫기" onClick={() => setShowLatest(false)}><X size={14} /></button></div>
            {Boolean(draft.labels.length || previewDocument.labels?.length) && <p className="docs-latest-labels">{previewDocument.labels?.length ? <>라벨 · {previewDocument.labels.join(', ')}</> : '라벨 없음'}</p>}
            <pre>{previewDocument.plainText || contentText(previewDocument.content)}</pre>
          </div>}
          {showLatest && metadataReview && !manualRecovery && <DocumentMetadataReview key={reviewKey} disabled={saving || restoring}
            items={metadataReview.fields.map(field => ({
              field, label: METADATA_FIELD_LABELS[field], local: formatMetadata(field, draft),
              saved: formatMetadata(field, documentMetadata(metadataReview.document)),
              localAllowed: field !== 'parentId' || (!metadataReview.parentContextChanged
                && (!draft.parentId || parentOptions.some(page => page.id === draft.parentId))),
            }))} onResolve={resolveMetadata} />}
          {storageProblem && <div className="docs-notice" role="alert">브라우저 임시 저장 공간이 부족합니다. 이동하기 전에 저장하거나 JSON으로 내보내주세요.</div>}
          {sessionError && <div className="docs-notice" role="alert">{sessionError} · 문서 연결을 확인하고 다시 열어주세요.</div>}
          {manualRecovery && <div className="docs-notice docs-manual-recovery" role="alert"><strong>보관한 수동 편집이 있습니다.</strong><p>이 문서는 공동 편집이 시작되어, 보관한 본문을 서버 문서에 자동으로 덮어쓰지 않았습니다.</p><div><button onClick={() => downloadDocument(`${draft.title}-수동편집-복구.json`, JSON.stringify({ title: draft.title, content: draft.content, plainText: draft.plainText, labels: draft.labels }, null, 2), 'application/json')}>편집 내려받기</button><button onClick={() => void saveCopy()} disabled={saving}>내 편집을 새 문서로 보관</button><button onClick={discardLocal}>편집 버리고 최신본 열기</button></div></div>}

          <div className="docs-paper-scroll">
            <div className="docs-paper">
              <div className="docs-document-meta"><span className={`docs-status-pill ${draft.status === 'published' ? 'is-published' : ''}`}>{draft.status === 'published' ? '공유 표시' : '초안'}</span><span>마지막 수정 {relativeTime((latestPage ?? selectedPage).updatedAt)}</span></div>
              <input ref={titleInput} className="docs-title-input" disabled={restoring || checklistReselecting} value={draft.title} onChange={event => updateDraft({ title: event.target.value })} placeholder="제목 없는 문서" aria-label="문서 제목" />
              <div className="docs-author-row"><span className="docs-avatar" style={{ background: data.users.find(user => user.id === selectedPage.authorId)?.color || '#78849a' }}>{data.users.find(user => user.id === selectedPage.authorId)?.name.slice(0, 1) || '팀'}</span><span>{data.users.find(user => user.id === selectedPage.authorId)?.name || '팀원'}</span><span className="docs-meta-dot">·</span><span>{when(selectedPage.createdAt)}</span><span className="docs-meta-dot">·</span><span>버전 {draft.expectedVersion}</span></div>
              <DocumentLabels key={`${actorId}:${draft.id}`} labels={draft.labels} activeKey={documentLabel} disabled={restoring || checklistReselecting}
                onChange={labels => updateDraft({ labels })} onFilter={onChangeDocumentLabel} />

              <div className="docs-editor-sticky">
              <div className="docs-editor-toolbar" role="toolbar" aria-label={checklistReselecting ? '체크리스트 항목 다시 선택' : '문서 서식'}>
                {!checklistReselecting && <>
                <button ref={findOpener} type="button" className={`docs-format-btn ${findOpen ? 'is-active' : ''}`}
                  title="본문에서 찾기" aria-label="본문에서 찾기" aria-expanded={findOpen} aria-keyshortcuts="Control+F Meta+F"
                  disabled={!canFind} onClick={() => findOpen ? closeFind() : openFind()}><Search size={15} aria-hidden="true" /></button>
                <select disabled={bodyReadOnly} aria-label="문단 서식" value={activeHeadingLevel ? `h${activeHeadingLevel}` : 'p'}
                  onChange={event => {
                    const { value } = event.target;
                    if (value === 'p') {
                      editor?.chain().focus().setParagraph().run();
                      return;
                    }
                    const level = Number(value.slice(1));
                    if (isDocumentHeadingLevel(level)) editor?.chain().focus().setHeading({ level }).run();
                  }}>
                  <option value="p">본문</option>
                  {DOCUMENT_HEADING_LEVELS.map(level => <option key={level} value={`h${level}`}>제목 {level}</option>)}
                </select><span className="docs-toolbar-separator" />
                {button('굵게', <Bold size={15} />, () => editor?.chain().focus().toggleBold().run(), editor?.isActive('bold'))}
                {button('기울임', <Italic size={15} />, () => editor?.chain().focus().toggleItalic().run(), editor?.isActive('italic'))}
                {button('취소선', <Strikethrough size={15} />, () => editor?.chain().focus().toggleStrike().run(), editor?.isActive('strike'))}
                {button('링크', <Link2 size={15} />, () => { setInsertKind('link'); setInsertUrl(String(editor?.getAttributes('link').href || '')); }, editor?.isActive('link'))}
                {editor?.isActive('link') && button('링크 해제', <Unlink size={14} />, () => editor?.chain().focus().unsetLink().run())}
                <span className="docs-toolbar-separator" />
                {button('글머리 목록', <List size={16} />, () => editor?.chain().focus().toggleBulletList().run(), editor?.isActive('bulletList'))}
                {button('번호 목록', <ListOrdered size={16} />, () => editor?.chain().focus().toggleOrderedList().run(), editor?.isActive('orderedList'))}
                {button('체크리스트', <ListChecks size={16} />, () => editor?.chain().focus().toggleTaskList().run(), editor?.isActive('taskList'))}
                {button('인용', <Quote size={15} />, () => editor?.chain().focus().toggleBlockquote().run(), editor?.isActive('blockquote'))}
                {button('코드 블록', <Code2 size={16} />, () => editor?.chain().focus().toggleCodeBlock().run(), editor?.isActive('codeBlock'))}
                {button('표 삽입', <Table2 size={15} />, () => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
                {button('2단 구역 삽입', <Columns2 size={15} />, () => insertColumns(2))}
                {button('3단 구역 삽입', <Columns3 size={15} />, () => insertColumns(3))}
                {button('이미지 URL 삽입', <ImageIcon size={15} />, () => { setInsertKind('image'); setInsertUrl(''); })}
                <button type="button" className="docs-format-btn" aria-label="참조 새로고침" title="참조 새로고침" disabled={referencesRefreshing} onMouseDown={event => event.preventDefault()} onClick={() => void refreshReferences()}>{referencesRefreshing ? <Loader2 className="docs-spin" size={15} /> : <RefreshCw size={15} />}</button>
                {button('업무 참조 삽입', <Link2 size={15} />, () => openReference('issueReference'))}
                {button('업무 목록 삽입', <ListFilter size={15} />, () => { if (editor) openIssueBlock(editor, 'issueList'); })}
                {jiraMacro && <button type="button" className="btn docs-selection-action" onMouseDown={event => event.preventDefault()}
                  onClick={event => restoreJiraIssueList(event.currentTarget)}><ListFilter size={15} aria-hidden="true" />보관된 Jira 목록 복원</button>}
                {button('업무 현황 삽입', <ChartBar size={15} />, () => { if (editor) openIssueBlock(editor, 'issueSummary'); })}
                {button('문서 참조 삽입', <FileText size={15} />, () => openReference('documentReference'))}
                {button('라벨별 문서 목록 삽입', <Files size={15} />, () => insertDocumentList('documentLabelList'))}
                {button('하위 문서 목록 삽입', <ListTree size={15} />, () => insertDocumentList('documentChildList'))}
                {button('문서 속성 삽입', <TableProperties size={15} />, () => insertPropertyBlock('documentProperties'))}
                {button('문서 속성 보고서 삽입', <Table2 size={15} />, () => insertPropertyBlock('documentPropertyReport'))}
                {button('문서 포함 삽입', <FilePlus2 size={15} />, () => openReference('documentInclude'))}
                {button('발췌 구역 삽입', <Scissors size={15} />, insertExcerpt)}
                {button('발췌 포함 삽입', <FileInput size={15} />, () => openReference('documentExcerptInclude'))}
                {button('문서 버전 포함 삽입', <FileClock size={15} />, () => openReference('documentRevisionInclude'))}
                {button('본문 목차 삽입', <TableOfContents size={15} />, () => insertDocumentToc(editor))}
                {button('안내 상자 삽입', <Info size={15} />, event => { if (editor) openAnnotation(editor, 'callout', event.currentTarget); })}
                {button('상태 배지 삽입', <Tag size={15} />, event => { if (editor) openAnnotation(editor, 'statusBadge', event.currentTarget); })}
                {button('접기 블록 삽입', <ChevronDown size={15} />, () => insertDetails(editor))}
                {button('접기 블록 모두 펼치기', <ChevronRight size={15} />, () => unfoldDetails(editor))}
                {editor?.isActive('details') && button('접기 블록 해제', <Unlink size={15} />, () => unwrapDetails(editor))}
                {button('파일 첨부', <Paperclip size={15} />, () => { setSidebarOpen(true); setSideTab('attachments'); })}
                </>}
                {checklistReselecting && !liveMode && draft.bodyDirty && <button className="btn docs-selection-action" type="button"
                  disabled={saving || manualRecovery || Boolean(metadataReview)} onClick={() => void saveDraft()}>
                  <Save size={15} aria-hidden="true" />본문 저장
                </button>}
                <DocumentSelectionActions key={`${draft.id}:${liveMode}`} editor={editor} unavailable={selectionUnavailable} issueUnavailable={selectionIssueUnavailable}
                  onCreate={(selection, opener) => { if (selectionDocument) openFollowUp(selectionDocument, opener, selection); }}
                  onLink={(selection, opener) => { if (selectionDocument) openDecisionLink(selectionDocument, opener, selection); }}
                  onComment={(selection, opener) => { if (selectionDocument) openSelectionComment(selectionDocument, opener, selection); }}
                  onCreateChecklist={openChecklistFollowUp} checklistReselecting={checklistReselecting}
                  checklistWork={checklistWork.links ? { links: checklistWork.links, data, openIssue } : undefined}
                  onShowDocumentLinks={checklistWork.hasPinnedLinks ? showChecklistDocumentLinks : undefined}
                  onCancelChecklistReselect={cancelChecklistReselect} />
              </div>
              {!checklistReselecting && findOpen && editor && <DocumentFindPanel editor={editor} inputRef={findInput}
                canReplace={!bodyReadOnly && !saving && !conflict} onClose={closeFind} />}
              {migratedIssueLink && <div className="docs-notice docs-migrated-issue-link" role="status">
                {migratedIssueLink.status === 'pending' ? '이관된 Jira 주소를 확인하는 중…' : migratedIssueLink.status === 'failed'
                  ? '이관된 Jira 주소를 조회하지 못했습니다.' : migratedIssueLink.expectsComment
                    ? '이관된 Jira 댓글을 확인할 수 없습니다.' : '이관된 Jira 업무를 확인할 수 없습니다.'}
                {migratedIssueLink.status !== 'pending' && <> <a href={migratedIssueLink.href} target="_blank" rel="noopener noreferrer">원본 열기</a></>}
              </div>}
              </div>
              {!checklistReselecting && editor && inColumnLayout && !bodyReadOnly && <div className="docs-column-layout-tools" role="group" aria-label="다단 구역 편집">
                <button type="button" aria-keyshortcuts="Control+Shift+Enter Meta+Shift+Enter" title="Ctrl/⌘+Shift+Enter"
                  onMouseDown={event => event.preventDefault()} onClick={() => exitDocumentColumnLayout(editor)}><CornerDownRight size={12} aria-hidden="true" /> 구역 다음 본문으로 이동</button>
                <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => unwrapDocumentColumnLayout(editor)}>다단 구역 해제</button>
              </div>}
              {!checklistReselecting && editor && !bodyReadOnly && <DocumentTableTools key={`${draft.id}:${liveMode}`} editor={editor} />}
              {!checklistReselecting && insertKind && <form className="docs-insert-form" onSubmit={insertUrlBlock}><input autoFocus className="field" value={insertUrl} onChange={event => setInsertUrl(event.target.value)} placeholder={insertKind === 'image' ? 'https://… 이미지 주소' : 'https://… 링크 주소'} aria-label={insertKind === 'image' ? '이미지 URL' : '링크 URL'} /><button className="btn btn-primary" type="submit">삽입</button><button className="btn btn-ghost docs-icon-button" type="button" aria-label="삽입 취소" onClick={() => setInsertKind(null)}><X size={15} /></button></form>}
              {draft.id === selectedPage.id && <DocumentEditorOutline key={draft.id} editor={editor}
                documentId={draft.id} projectId={selectedPage.projectId ?? projectId}
                sectionId={publicationOpen ? null : sectionId} savedContent={selectionDocument?.content}
                ready={!liveMode || Boolean(liveState?.ready)} canAssign={!bodyReadOnly && !saving && !conflict && !publicationOpen && !checklistReselecting} />}
              {clipboardImageUploads[documentScope] > 0 && <div className="docs-notice" role="status">이미지를 첨부하는 중입니다.</div>}
              <div ref={editorWrap} className="docs-editor-wrap" onPasteCapture={event => void pasteClipboardImages(event)} onKeyDownCapture={event => {
                if (!checklistReselecting && !event.defaultPrevented && !event.nativeEvent.isComposing && event.key === 'Enter' &&
                    !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.target instanceof HTMLAnchorElement &&
                    openMigratedIssueLink(event.target)) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                handleEditorKeys(event);
              }}
                onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSlashQuery(null); }}
                onClickCapture={event => {
                  if (!(event.target instanceof Element)) return;
                  if (checklistReselecting && event.target.closest('a[href], button, input[type="checkbox"]')) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  if (!event.target.closest('a[href]') || event.defaultPrevented || event.button !== 0 ||
                      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  if (openMigratedIssueLink(event.target)) {
                    event.preventDefault();
                    event.stopPropagation();
                  } else if (migratedIssueRequest.current) {
                    migratedIssueRequest.current.controller.abort();
                    migratedIssueRequest.current = null;
                    setMigratedIssueLink(null);
                  }
                }}
                onClick={event => {
                if (!(event.target instanceof Element) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                const href = event.target.closest('a[href]')?.getAttribute('href');
                if (href && /^#\/[^/?#]+\/reports\/(?:[0-9a-f-]{36}|(?:blockers|decision-follow-ups)(?:\?[^#]*)?)$/i.test(href)) {
                  event.preventDefault();
                  window.location.hash = href;
                  return;
                }
                if (!href) return;
                let link: URL;
                try { link = new URL(href, location.href); } catch { return; }
                if (link.origin !== location.origin || link.pathname !== location.pathname) return;
                const [path, query] = link.hash.split('?');
                if (/^#\/[^/?#]+\/documents\/[^/?#]+$/u.test(path) && isDocumentSectionId(new URLSearchParams(query).get('section'))) {
                  event.preventDefault();
                  window.location.hash = link.hash;
                }
              }}>{liveMode && activeSession ? <CollaborativeEditor key={`${draft.id}:${actorId}:${liveReload}`} session={activeSession} actorId={actorId} labels={draft.labels} onEditor={receiveLiveEditor} onContent={receiveLiveContent} onDocument={receiveLiveDocument} onState={receiveLiveState} onSessionDisabled={receiveDisabledSession} onOpenCopy={openRecoveryCopy} notify={notify} /> : <EditorContent editor={manualEditor} />}
                {!checklistReselecting && !bodyReadOnly && matchingSlashCommands.length > 0 && <div className="docs-slash-menu docs-popover" role="group" aria-label="블록 추가" style={{ top: slashTop }}>
                  <div className="docs-slash-caption" aria-hidden="true">블록 추가</div>
                  {matchingSlashCommands.map((command, index) => <button key={command.label} type="button" aria-current={index === slashIndex || undefined}
                    onMouseDown={event => event.preventDefault()} onClick={() => runSlash(command)}>{command.label}</button>)}
                </div>}
              </div>
              <div className="docs-paper-footer"><span>{draft.plainText.trim().length.toLocaleString()}자</span><span>{liveMode ? '본문 자동 동기화 · 제목과 속성은 별도 저장' : '변경 후 저장 버튼 또는 ⌘ / Ctrl + S'}</span></div>
            </div>
          </div>
        </main>

        {sidebarOpen && <aside className="docs-details" aria-label="문서 상세 정보" inert={checklistReselecting}
          style={checklistReselecting ? { display: 'none' } : undefined}><div className="docs-detail-tabs">{([{ id: 'comments', label: '댓글', icon: <MessageSquare size={14} /> }, { id: 'links', label: '연결', icon: <Link2 size={14} /> }, { id: 'history', label: '이력', icon: <History size={14} /> }, { id: 'attachments', label: '파일', icon: <Paperclip size={14} /> }, { id: 'source', label: '원본 기록', icon: <FileText size={14} /> }] as const).map(tab => <button key={tab.id} ref={tab.id === 'links' ? linksTab : undefined} className={sideTab === tab.id ? 'is-active' : ''} onClick={() => { setSideTab(tab.id); }}>{tab.icon}{tab.label}{tab.id === 'comments' && comments.length > 0 && <span>{comments.length}</span>}</button>)}</div>
          <button className="docs-panel-close" aria-label="문서 정보 패널 닫기" onClick={() => setSidebarOpen(false)}><X size={13} /> 패널 닫기</button><div className="docs-detail-content">
            {sideTab === 'links' && <AtlassianLinks targetType="document" targetId={draft.id} actorId={actorId} notify={notify} />}
            {sideTab === 'comments' && <>
              <div className="docs-panel-heading"><h3 tabIndex={-1} ref={commentsHeading}>팀과 이야기하기</h3><p>문서에 대한 질문과 의견을 남겨주세요.</p></div>
              <div className="docs-comment-filters" role="group" aria-label="문서 댓글 상태">
                {COMMENT_FILTERS.map(filter => <button key={filter} type="button" value={filter}
                  ref={filter === commentFilter ? activeCommentFilter : undefined} aria-pressed={filter === commentFilter}
                  onClick={() => setCommentFilter(filter)}>{COMMENT_FILTER_LABELS[filter]}</button>)}
              </div>
              {commentsLoading && <p className="docs-panel-muted">댓글을 불러오는 중…</p>}
              {commentError && <p className="docs-panel-error" role="alert">{commentError}</p>}
              {resolutionError && <p className="docs-panel-error" role="alert">{resolutionError}</p>}
              {linkedCommentMissing && <p className="docs-panel-muted" role="status">이동할 댓글을 찾을 수 없습니다.</p>}
              {!commentsLoading && !commentError && !visibleComments.length && (commentFilter === 'all'
                ? <div className="docs-panel-empty"><MessageSquare size={25} /><strong>아직 댓글이 없어요</strong><span>첫 의견을 남겨 대화를 시작해보세요.</span></div>
                : <p className="docs-panel-muted">{commentFilter === 'resolved' ? '해결된 문장 댓글이 없습니다.' : '미해결 문장 댓글이 없습니다.'}</p>)}
              {visibleComments.map(comment => {
                const user = data.users.find(item => item.id === comment.authorId);
                const resolution = comment.resolution;
                const resolved = resolution?.state === 'resolved';
                const resolutionActor = resolution && data.users.find(item => item.id === resolution.actorId);
                const pending = resolvingCommentId === comment.id;
                const threadReplies = repliesByParent.get(comment.id) ?? [];
                const replyEditor = reply.current?.parentId === comment.id ? reply.current : null;
                const commentControlsDisabled = commentBusy || saving || pending || reply.busy || comment.resourceId !== documentId;
                const followUpDisabled = commentControlsDisabled || restoring || isCommentEditPending() || !actorId || !data.projects.length ||
                  draft.id !== comment.resourceId || latestPage?.id !== comment.resourceId;
                return <article className="docs-comment" id={`document-comment-${comment.id}`} tabIndex={-1} key={comment.id}>
                  <div className="docs-comment-head">
                    <span className="docs-avatar" style={{ background: user?.color || '#78849a' }}>{user?.name.slice(0, 1) || '팀'}</span>
                    <strong>{user?.name || '팀원'}</strong>
                    <time title={when(comment.createdAt)}>{relativeTime(comment.createdAt)}</time>
                    <CommentEditedMark comment={comment} />
                    <CommentEditButton comment={comment} editing={commentEditing} disabled={commentControlsDisabled} />
                    <CommentTrashButton comment={comment} actorId={actorId} notify={notify} refresh={refresh}
                      disabled={commentControlsDisabled || activeCommentEdit?.id === comment.id || activeCommentEdit?.parentCommentId === comment.id}
                      confirmation={threadReplies.length ? '댓글과 답글을 휴지통으로 옮길까요? 휴지통에서 함께 복원할 수 있습니다.' : undefined}
                      onArchived={archiveCommentFromList} />
                  </div>
                  {comment.documentSource && <section className="docs-comment-source" aria-label="댓글이 달린 본문">
                    <blockquote>{comment.documentSource.text}</blockquote>
                    <DocumentDecisionRevision data={data} documentId={comment.resourceId} revisionId={comment.documentSource.revisionId}
                      label={selectedPage.title} sourceLabel="댓글 원문 저장본" selection={comment.documentSource} />
                  </section>}
                  <CommentEditBody comment={comment} editing={commentEditing} users={data.users} />
                  {comment.documentSource && <div className="docs-comment-review">
                    <span className="docs-comment-state" data-resolved={resolved}>
                      {COMMENT_FILTER_LABELS[resolved ? 'resolved' : 'open']}
                    </span>
                    {resolution && <span className="docs-comment-review-record">
                      {resolutionActor?.name || '팀원'} · <time dateTime={resolution.changedAt}>{when(resolution.changedAt)}</time>
                    </span>}
                    <div className="docs-comment-review-actions">
                      <button type="button" className="btn btn-ghost"
                        disabled={followUpDisabled} onClick={event => openCommentFollowUp(comment, event.currentTarget, 'create')}>
                        <Plus size={14} aria-hidden="true" />댓글에서 후속 업무 만들기
                      </button>
                      <button type="button" className="btn btn-ghost"
                        disabled={followUpDisabled} onClick={event => openCommentFollowUp(comment, event.currentTarget, 'link')}>
                        <Link2 size={14} aria-hidden="true" />댓글을 기존 업무에 연결
                      </button>
                      <button type="button" className="btn btn-ghost" aria-disabled={Boolean(resolvingCommentId) || !actorId}
                        onClick={event => void changeCommentResolution(comment, event.currentTarget)}>
                        {pending ? <Loader2 size={14} className="docs-spin" aria-hidden="true" />
                          : resolved ? <RotateCcw size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                        {pending ? '저장 중…' : resolved ? '다시 열기' : '해결 처리'}
                      </button>
                      {onCopyCommentLink && <button type="button" className="btn btn-ghost"
                        aria-label="댓글 링크 복사" title="댓글 링크 복사" onClick={() => onCopyCommentLink(comment.id)}>
                        <Link2 size={14} aria-hidden="true" />
                      </button>}
                      {(!resolved || reply.canRecover(comment.id)) && <button type="button" className="btn btn-ghost"
                        aria-label={resolved ? '답글 결과 확인 열기' : '답글 쓰기'} aria-expanded={Boolean(replyEditor)}
                        disabled={reply.busy || pending || saving || !actorId}
                        onClick={event => replyEditor ? reply.close() : reply.open(comment, event.currentTarget)}>
                        <MessageSquare size={14} aria-hidden="true" />{resolved ? '답글 결과 확인' : '답글'}
                      </button>}
                    </div>
                  </div>}
                  {comment.documentSource && <>
                    <DocumentReplyList replies={threadReplies} users={data.users} actorId={actorId} notify={notify} refresh={refresh}
                      editing={commentEditing} disabled={reply.busy || saving} onArchived={archiveCommentFromList} onCopyCommentLink={onCopyCommentLink} />
                    {replyEditor && <DocumentReplyComposer key={JSON.stringify([actorId, comment.id])} editor={replyEditor}
                      resolved={resolved} busy={reply.busy} users={data.users} onChange={reply.edit} onClose={reply.close}
                      onSubmit={() => void reply.submit(comment, showSavedReply)} />}
                  </>}
                </article>;
              })}
              {showDetachedCommentEdit && <CommentEditBody comment={activeCommentEdit} editing={commentEditing} users={data.users} />}
              <form className="docs-comment-form" onSubmit={submitComment}>
                <CommentMentionInput className="field" draft={commentDraft} onChange={updateCommentDraft} users={data.users}
                  placeholder="의견을 남겨주세요…" aria-label="새 문서 댓글" rows={4} />
                <button type="submit" className="btn btn-primary" disabled={!commentDraft.body.trim() || commentBusy}>{commentBusy ? <Loader2 size={13} className="docs-spin" /> : <Send size={13} />} 댓글 남기기</button>
              </form>
            </>}
            {sideTab === 'links' && <>
              <DocumentLinkedWork key={selectedPage.id} data={data} document={selectedPage} openIssue={openIssue}
                onOpenIssueForReview={onOpenIssueForReview} onOpenIssueSchedule={onOpenIssueSchedule}
                refresh={refresh} notify={notify} issueDrawerOpen={issueDrawerOpen}>
                <button className="btn docs-follow-up-button" type="button" disabled={saving || restoring || !data.projects.length || draft.id !== selectedPage.id} onClick={event => openFollowUp(selectedPage, event.currentTarget)}><Plus size={14} aria-hidden="true" /> 후속 업무 만들기</button>
              </DocumentLinkedWork>
              <ResourceLinkPicker key={`${actorId}:${selectedPage.id}`} kind="issue" items={candidateIssues} projects={data.projects}
                issueAliases={data.issueAliases} busy={linkBusy || draft.id !== selectedPage.id} onLink={linkIssue} />
              <div className="docs-reference-list">
                <h3>본문에서 참조하는 문서</h3>
                {!outgoingDocuments.length && <p>본문에 문서 링크, 참조나 포함을 추가하면 표시됩니다.</p>}
                {outgoingDocuments.map(reference => {
                  const page = documentsById.get(reference.id);
                  const sectionTitle = page && reference.sectionId ? savedDocumentSectionTitle(page.content, reference.sectionId) : undefined;
                  const missingSection = Boolean(page && reference.sectionId && sectionTitle === undefined);
                  const label = reference.revisionId ? '고정 버전 포함' : reference.kind === 'include' ? '문서 포함'
                    : reference.sectionId ? '절 링크' : reference.linkMark ? '문서 링크' : '문서 참조';
                  return <button key={documentPanelReferenceKey(reference)} disabled={!page} type="button"
                    onClick={() => page && openDocument(page.id, missingSection ? undefined : reference.sectionId)}>
                    <small>{label}{sectionTitle && ` · ${sectionTitle}`}
                      {missingSection && ' · 절을 찾을 수 없음 · 현재 문서 열기'}
                      {!page && (reference.revisionId ? ' · 원본 열기 불가' : ' · 찾을 수 없음')}</small>
                    <strong>{(reference.revisionId ? reference.label : page?.title) || reference.label || reference.id}</strong>
                  </button>;
                })}
              </div>
              <div className="docs-reference-list">
                <h3>이 문서를 참조하는 문서</h3>
                {!backlinks.length && <p>다른 문서의 참조나 링크가 아직 없습니다.</p>}
                {backlinks.map(({ document, label }) => <button key={document.id} type="button" onClick={() => openDocument(document.id)}>
                  <small>{label}</small><strong>{document.title}</strong>
                </button>)}
              </div>
              {supplementalIssueReferences.length > 0 && <div className="docs-reference-list">
                <h3>본문의 업무 참조</h3>
                {supplementalIssueReferences.map(reference => {
                  const issue = issuesById.get(reference.id);
                  const pending = !savedIssueReferenceIds.has(reference.id);
                  return <button key={reference.id} disabled={!issue} onClick={() => issue && openIssue(issue.id)}>
                    <small>{pending && '저장 전 · '}{issue?.key || '찾을 수 없는 업무'}</small>
                    <strong>{issue?.title || reference.label || reference.id}</strong>
                  </button>;
                })}
              </div>}
              <div className="docs-document-properties"><h3>문서 속성</h3><label>상위 문서<select disabled={restoring} className="field" value={draft.parentId || ''} onChange={event => updateDraft({ parentId: event.target.value || null })}><option value="">최상위 문서</option>{parentOptions.map(page => <option key={page.id} value={page.id}>{page.title}</option>)}</select></label><label>작성 상태<select disabled={restoring} className="field" value={draft.status} onChange={event => updateDraft({ status: event.target.value as DocPage['status'] })}><option value="draft">초안</option><option value="published">공유 표시</option></select></label><p className="docs-panel-muted">속성 변경도 저장할 때 반영됩니다.</p><button className="docs-danger-action" onClick={() => void deleteDocument()} disabled={saving}><Trash2 size={13} /> 문서 삭제</button></div>
            </>}
            {sideTab === 'source' && <SourceOrigins resourceType="document" resourceId={draft.id}/>}
            {sideTab === 'attachments' && <><div className="docs-panel-heading"><h3>문서에 자료 모으기</h3><p>첨부 링크나 이미지를 본문에 삽입하세요.</p></div><Attachments key={draft.id} resourceType="document" resourceId={draft.id} actorId={actorId} notify={notify} onChanged={refresh}
              reloadKey={clipboardAttachment?.documentId === draft.id ? clipboardAttachment.versionId : undefined}
              onInsertFileLink={bodyReadOnly || archivedLiveRecovery ? undefined : insertAttachmentLink}
              onInsertImage={bodyReadOnly ? undefined : url => { editor?.chain().focus().setImage({ src: url, alt: '첨부 이미지' }).run(); notify(liveMode ? '이미지를 삽입했습니다. 서버 동기화 상태를 확인해주세요.' : '이미지를 삽입했습니다. 문서를 저장하면 반영됩니다.', 'success'); }} /></>}{sideTab === 'history' && <DocumentHistory key={draft.id} revisions={revisions} loading={historyLoading} error={historyError} current={{title:draft.title,content:draft.content,plainText:draft.plainText,version:draft.expectedVersion,dirty:draft.dirty}} users={data.users} onRestore={restoreRevision} restoreDisabled={saving || draft.dirty || Boolean(liveMode && (liveState?.pending || liveState?.phase !== 'connected'))} onSaveCopy={saveCopy} saving={saving} />}
          </div>
        </aside>}
      </> : filtersActive && !visible.length ? <div className="docs-welcome"><div className="docs-welcome-icon"><FileText size={31} /></div><h2>조건에 맞는 문서가 없습니다.</h2></div>
        : <div className="docs-welcome"><div className="docs-welcome-icon"><FileText size={31} /></div><h2>팀의 다음 아이디어를 기록하세요</h2><p>업무와 문서를 연결하면, 결정의 맥락이 남습니다.</p><button className="btn btn-primary" onClick={() => openNew()}><Plus size={16} /> 첫 문서 작성하기</button><div className="docs-welcome-templates">{DOCUMENT_TEMPLATES.filter(template => template.id !== 'blank').map(template => <button key={template.id} onClick={() => openNew('', template.id)}><span>{template.icon}</span><strong>{template.name}</strong><p>{template.description}</p></button>)}</div></div>}
    </div>

    {offlineExport && <DocumentOfflineExport document={selectedPage} project={currentProject} initialScope={offlineExport}
      actorId={actorId} notify={notify} onClose={closeOfflineExport} />}
    {archiveImport && <DocumentMarkdownArchiveImport projects={data.projects} documents={data.documents} initialProjectId={currentProject?.id ?? null}
      actorId={actorId} refresh={refresh} openDocument={openDocument} onNavigationChange={recordArchiveImportNavigation} onClose={closeArchiveImport} />}
    {documentAction?.kind === 'create' && <NewIssueModal data={data} projectId={projectId} actorId={actorId} refresh={refresh} notify={notify} openIssue={openIssue}
      sourceDocument={documentAction.source} selectingChecklist={checklistReselecting} onReselectChecklist={reselectChecklistSource} onClose={closeDocumentAction} />}
    {documentAction?.kind === 'link' && <DocumentDecisionLinkDialog source={documentAction.source} data={data} actorId={actorId}
      refresh={refresh} notify={notify} onClose={closeDocumentAction}
      reloadComments={() => window.dispatchEvent(new Event(COMMENT_LIST_CHANGED))} />}
    {documentAction?.kind === 'comment' && <DocumentSelectionCommentDialog source={documentAction.source} initialDraft={documentAction.initialDraft}
      actorId={actorId} users={data.users} refresh={refresh} notify={notify} onClose={closeDocumentAction} onSaved={showSavedSelectionComment} onReselect={reselectCommentSource} />}
    {publicationOpen && selectedPage && draft?.id === selectedPage.id && <DocumentPublication data={data}
      document={{ ...selectedPage, version: draft.expectedVersion }} actorId={actorId} canRequest={canRequestPublication}
      initialSnapshot={publicationLink} projectId={selectedPage.projectId ?? projectId} sectionId={publicationLink ? sectionId : null} covered={issueDrawerOpen}
      onClose={closePublication} notify={notify} refreshDocument={refresh} />}
    {moveOpen && selectedPage && <DocumentTreeMove key={selectedPage.id} document={selectedPage} documents={data.documents}
      projects={data.projects} beforeApply={moveBlocker} refreshWorkspace={refresh}
      onClose={closeMove} onMoved={moveSaved} />}
    {copyOpen && latestPage && <DocumentTreeCopy key={latestPage.id} source={latestPage} documents={data.documents}
      projects={data.projects} actorId={actorId} refreshWorkspace={refresh} onClose={closeCopy} onOpenCopy={selectDocument} />}
    {orderOpen && selectedPage && <DocumentSiblingOrderDialog key={selectedPage.id} documentId={selectedPage.id} documents={data.documents}
      projects={data.projects} refreshWorkspace={refresh} onClose={closeOrder} />}
    {referenceDialog && <ReferenceChooser selection={referenceDialog} onClose={closeReference} notify={notify} />}
    {issueBlockDialog && <IssueBlockChooser selection={issueBlockDialog} data={data} preferredProjectId={selectedPage?.projectId ?? currentProject?.id ?? null}
      actorId={actorId} notify={notify} refreshWorkspace={refresh} onClose={closeIssueBlock} />}
    {annotationDialog && <DocumentAnnotationDialog selection={annotationDialog} onClose={closeAnnotation} />}
    {templateManager && <DocumentTemplatesManager projectId={templateManager.projectId}
      scopeLabel={data.projects.find(project => project.id === templateManager.projectId)?.name ?? '팀 공통'}
      source={templateManager.source} latestSource={templateManager.source && (latestPage?.id === templateManager.source.id ? latestPage
        : data.documents.find(page => page.id === templateManager.source?.id))}
      actorId={actorId} refresh={refresh} notify={notify} onClose={closeTemplateManager} />}
    {newOpen && <div className="docs-modal-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) discardCreateDocument();
    }}>
      <form className="docs-create-modal" role="dialog" aria-modal="true" aria-labelledby="docs-create-title" onSubmit={createDocument}
        onKeyDown={event => {
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            discardCreateDocument();
          }
          if (event.key === 'Tab') {
            const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')]
              .filter(control => control.getClientRects().length);
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
            if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
          }
        }}>
        <div className="docs-modal-header">
          <div><div className="docs-eyebrow">NEW DOCUMENT</div><h2 id="docs-create-title">새 문서 만들기</h2></div>
          <button type="button" className="btn btn-ghost docs-icon-button" aria-label="닫기" disabled={creating} onClick={discardCreateDocument}><X size={19} /></button>
        </div>
        <label className="docs-modal-label">문서 제목<input ref={createTitle} autoFocus className="field" placeholder="어떤 이야기를 기록할까요?"
          value={newTitle} onChange={event => { newTitleCustomized.current = true; setNewTitle(event.target.value); }}
          required maxLength={240} disabled={createLocked} /></label>
        {importingMarkdown ? <>
          <div className="docs-markdown-mode"><h3>Markdown 가져오기</h3><button className="btn btn-ghost" type="button" disabled={createLocked}
            onClick={() => chooseDocumentTemplate('blank')}><ChevronLeft size={15} aria-hidden="true" /> 템플릿으로 변경</button></div>
          <DocumentMarkdownImport preview={markdownPreview} onPreview={reviewMarkdown} disabled={createLocked} />
        </> : <><div className="docs-template-grid">
          {DOCUMENT_TEMPLATES.map(template => <button type="button" className={newTemplate === template.id ? 'is-selected' : ''} key={template.id}
            disabled={createLocked} onClick={() => chooseDocumentTemplate(template.id)}>
            <span>{template.icon}</span><strong>{template.name}</strong><small>{template.description}</small>{newTemplate === template.id && <Check size={14} />}
          </button>)}
          <button type="button" aria-label="Markdown 가져오기" disabled={createLocked} onClick={() => chooseDocumentTemplate('markdown')}>
            <span aria-hidden="true"><ArrowDownToLine size={18} /></span><strong>Markdown 가져오기</strong><small>파일 또는 붙여넣기</small>
          </button>
        </div>
          <DocumentTemplatePicker catalog={teamCatalog} reload={reloadTeamTemplates} value={teamTemplate?.id ?? ''}
            projectName={data.projects.find(project => project.id === newProject)?.name} disabled={createLocked}
            onChoose={chooseTeamTemplate} />
          {teamTemplate && <p className="document-template-selection">{teamTemplate.projectId === null ? '팀 공통' : data.projects.find(project => project.id === teamTemplate.projectId)?.name}
            {' · '}템플릿 버전 {teamTemplate.version}{(teamTemplate.attachmentCount ?? 0) > 0 ? ` · 첨부 ${teamTemplate.attachmentCount}개` : ''}</p>}
        </>}
        <div className="docs-location-fields">
          <label className="docs-modal-label">공간<select className="field" disabled={Boolean(newParent) || createLocked}
            value={newProject} onChange={event => changeCreateProject(event.target.value)}>
            <option value="">팀 공통 문서</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select></label>
          <label className="docs-modal-label">상위 문서<select className="field" value={newParent} disabled={createLocked} onChange={event => setNewParent(event.target.value)}>
            <option value="">최상위에 만들기</option>{data.documents.filter(page => page.projectId === (newProject || null)).map(page => <option key={page.id} value={page.id}>{page.title}</option>)}
          </select></label>
        </div>
        {markdownCreateError && <p className="error-text docs-markdown-message" role="alert">{markdownCreateError}</p>}
        {teamCreationError && <p className="document-template-error" role="alert">{teamCreationError}</p>}
        {teamTemplateChanged && <div className="document-template-picker-status document-template-review">
          <span>{currentTeamTemplate ? `현재 템플릿 버전 ${currentTeamTemplate.version}을 확인해 주세요.` : teamCatalog?.state === 'ready'
            ? '현재 공간에서 이 템플릿을 사용할 수 없습니다. 다른 템플릿을 선택해 주세요.' : '팀 템플릿 목록을 확인하고 있습니다.'}</span>
          {currentTeamTemplate && <button type="button" className="btn" disabled={createLocked} onClick={() => {
            setTeamTemplate(currentTeamTemplate);
            setTeamTemplateConflict(false);
            setTeamCreationError('');
            createTitle.current?.focus({ preventScroll: true });
          }}>최신 템플릿 사용</button>}
        </div>}
        <div className="docs-modal-footer">
          <button className="btn btn-ghost" type="button" disabled={creating} onClick={discardCreateDocument}>취소</button>
          <button ref={createSubmit} className="btn btn-primary" type="submit" disabled={!newTitle.trim() || creating || importingMarkdown && !markdownPreview || teamTemplateChanged || teamCreationRejected}>
            {creating ? <Loader2 size={14} className="docs-spin" /> : <Plus size={14} />}
            {(importingMarkdown || teamTemplate) && creating ? '저장 중…' : createAttempt?.documentId ? '저장한 문서 열기'
              : createAttempt ? '저장 다시 확인' : importingMarkdown ? 'Markdown 문서 만들기' : '문서 만들기'}
          </button>
        </div>
      </form>
    </div>}
  </section></DocumentAnnotationProvider></DocumentBlocksProvider>;
}
