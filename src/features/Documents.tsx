'use client';

import { useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { getMarkRange, type EditorEvents, type MappablePosition } from '@tiptap/core';
import { CollaborationMappablePosition } from '@tiptap/extension-collaboration';
import Placeholder from '@tiptap/extension-placeholder';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { history } from '@tiptap/pm/history';
import { NodeSelection, type Transaction } from '@tiptap/pm/state';
import { createAbsolutePositionFromRelativePosition, createRelativePositionFromTypeIndex } from 'yjs';
import {
  ArrowDownToLine, Bold, BookOpen, ChartBar, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight,
  Code2, Columns2, Columns3, Copy, CornerDownRight, FileCheck2, FileClock, FileInput, FilePlus2, FileStack, Files, FileText, FolderInput, GripVertical, History, House, ImageIcon, Info, Italic, Link2, List,
  ListChecks, ListFilter, ListOrdered, ListTree, Loader2, MessageSquare, PanelRightClose,
  PanelRightOpen, Paperclip, Pencil, Plus, Quote, RefreshCw, Save, Scissors, Search, Send, Strikethrough,
  RotateCcw, Table2, TableOfContents, TableProperties, Tag, Trash2, Unlink, X,
} from 'lucide-react';
import { createEditorExtensions } from '../../shared/editor-schema';
import { parseConfluenceJiraList } from '../../shared/confluence-jira-list';
import { readCycleCompletionRecordId } from '../../shared/cycle-completion-address';
import { documentLabelKey, normalizeDocumentLabels } from '../../shared/document-labels';
import { MAX_DOCUMENT_LABEL_LISTS } from '../../shared/document-label-list';
import { MAX_DOCUMENT_CHILD_LISTS } from '../../shared/document-child-list';
import { MAX_DOCUMENT_PROPERTY_BLOCKS } from '../../shared/document-properties';
import { DOCUMENT_CONTENT_SCHEMA_VERSION, DOCUMENT_HEADING_LEVELS, contentReferences, documentContentSchemaVersion, documentPlainText, findDocumentExcerpt, isDocumentHeadingLevel } from '../../shared/document-nodes';
import { documentPanelBacklinks, documentPanelReferenceKey, documentPanelReferences } from '../../shared/document-panel-references';
import { documentReadingHash, isDocumentSectionId, parseDocumentHash, savedDocumentSectionTitle } from '../../shared/document-sections';
import { isRelationId } from '../../shared/issue-relations';
import { inlineAttachmentIdFromUrl } from '../../shared/inline-attachment';
import { jiraMigratedTargetAddress, type MigratedJiraTarget } from '../../shared/jira-migration-address';
import { normalizeWorkspaceSearchKey, WORKSPACE_SEARCH_QUERY_LIMIT } from '../../shared/workspace-search';
import { DocumentBlocksProvider, DocumentDecisionRevision, ReadonlyDocumentContent, ReferenceChooser, decorateDocumentExtensions, insertDetails, insertDocumentExcerpt, unfoldDetails, unwrapDetails, type ReferenceKind, type ReferenceSelection } from './DocumentBlocks';
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
import { readDocumentCreationAttempt, writeDocumentCreationAttempt, type DocumentCreationAttempt } from './document-creation-attempt';
import { confirmMarkdownArchiveClose, DocumentMarkdownArchiveImport, type ArchiveImportNavigation } from './DocumentMarkdownArchiveImport';
import { DocumentOfflineExport, type DocumentOfflineExportScope } from './DocumentOfflineExport';
import { DocumentTemplatePicker, DocumentTemplatesManager, isDefiniteTemplateFailure, templateErrorReason, useDocumentTemplates } from './DocumentTemplates';
import { DocumentTreeMove } from './DocumentTreeMove';
import { DocumentTreeCopy } from './DocumentTreeCopy';
import { DocumentSiblingOrderDialog } from './DocumentSiblingOrderDialog';
import { reorderDocumentPlacement, useDocumentTreeDrag, type DocumentOrderPlacement } from './document-tree-drag';
import { useDocumentTreeExpansion } from './document-tree-expansion';
import { DocumentPublication } from './DocumentPublication';
import { DocumentEditorHistory } from './DocumentEditorHistory';
import { DocumentEditorOutline } from './DocumentEditorOutline';
import { DocumentFindPanel } from './DocumentFindPanel';
import { DocumentReadFindPanel } from './DocumentReadFindPanel';
import { documentFindExtension } from './document-find';
import { clipboardImageFiles, trackClipboardImagePosition } from './document-clipboard-image';
import { captureDocumentSlashAnchor, type DocumentSlashAnchor, type DocumentSlashRange } from './document-slash-insertion';
import { insertDocumentToc } from './DocumentToc';
import { DocumentSelectionActions } from './DocumentSelectionActions';
import { DocumentTableTools } from './DocumentTableTools';
import { DocumentTablePaste } from './DocumentTablePaste';
import { DocumentBlockOrder } from './DocumentBlockOrder';
import { DocumentPageSuggestions } from './DocumentPageSuggestions';
import { exitDocumentColumnLayout, insertDocumentColumnLayout, unwrapDocumentColumnLayout } from './document-column-layout';
import { DocumentSelectionCommentDialog, type SelectionCommentSource } from './DocumentSelectionCommentDialog';
import { DocumentDecisionLinkDialog } from './DocumentDecisionLinkDialog';
import { readDecisionLinkAttempt, writeDecisionLinkAttempt, type DecisionLinkAttempt, type DecisionLinkSource } from './document-decision-link-attempt';
import { DocumentLinkedWork } from './DocumentLinkedWork';
import { ResourceLinkPicker } from './ResourceLinkPicker';
import { NewIssueModal, type FollowUpSource } from './NewIssueModal';
import { documentNotificationSpaceId, type AttachmentHead, type Comment, type DocPage, type DocRevision, type DocumentPublicationTarget, type DocumentSiblingOrder, type DocumentSourceSelection, type DocumentTemplateSummary, type FeatureProps, type RichContent } from '../../shared/types';
import { ApiError, api, post, relativeTime, remove } from '../lib/api';
import { afterAcceptedNavigation, isDocumentPreservedByNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import { DOCUMENT_TEMPLATES, templateContent } from './document-built-in-templates';
import { contentMarkdown, contentText, documentAncestors, documentRevisionLabel, downloadDocument } from './document-utils';
import { Attachments, attachmentFileUrl, isInlineAttachmentImage, MAX_ATTACHMENT_BYTES, type AttachmentsProps } from './Attachments';
import { CommentEditBody, CommentEditButton, CommentEditedMark, useCommentEditing } from './CommentEdit';
import { COMMENT_LIST_CHANGED, CommentTrashButton } from './CommentTrashButton';
import { CommentMentionInput, commentDraftPayload, decodeCommentDraft, emptyCommentDraft, encodeCommentDraft, sameCommentDraft, type CommentDraft } from './CommentMentions';
import { DocumentReplyComposer, DocumentReplyList, useDocumentCommentReply } from './DocumentCommentReplies';
import { NotificationSubscriptionButton } from './NotificationSubscriptionButton';
import { DocumentSpaceHomeAction } from './DocumentSpaceHomeAction';
import { FavoriteAction } from './FavoritesState';
import { CollaborativeEditor } from './CollaborativeEditor';
import type { CollaborationSession } from '../../shared/collaboration';
import { hasPendingCollaboration, type CollaborationView } from '../lib/collaboration-client';
import type { OpenIssueForReview } from '../lib/issue-review';
import './documents.css';
import './document-comment-review.css';

type Props = FeatureProps & {
  selectedDocumentId: string | null;
  onSelectDocument: (id: string, recovery?: { documentId: string | null; expectedRestoreGeneration?: string; beforeOpen: () => void }, reading?: boolean) => boolean;
  openDocument: (id: string, sectionId?: string) => void;
  reading: boolean;
  onChangeReading: (reading: boolean) => void;
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
type DocumentAction = { kind: 'create'; source: FollowUpSource } |
  { kind: 'link'; source: DecisionLinkSource; actorId: string; generation: string; initialAttempt?: DecisionLinkAttempt }
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
type DocumentLinkTarget = {
  editor: Editor; documentId: string; actorId: string;
  from: MappablePosition; to: MappablePosition; selectedText: string;
};
type DocumentSave = { actorId: string; documentId: string; observed?: ObservedDocument };
type DocumentSaveAttempt = { actorId: string; requestId: string; expectedRestoreGeneration: string; collaborative: boolean; draft: Draft };
type DocumentRestoreAttempt = {
  actorId: string; documentId: string; requestId: string; expectedRestoreGeneration: string;
  expectedVersion: number; revisionId: string;
};
type ClipboardImageScope = { editor: Editor; documentId: string; actorId: string; liveEpoch: string | null };
type SideTab = 'comments' | 'history' | 'links' | 'attachments' | 'source';
type MigratedIssueLinkState = { href: string; status: 'pending' | 'missing' | 'failed'; expectsComment: boolean };
type CommentFilter = 'all' | 'open' | 'resolved';
type CommentLoadMode = 'event' | 'manual' | 'automatic';
const COMMENT_REFRESH_INTERVAL_MS = 15_000;
const COMMENT_LOAD_TIMEOUT_MS = 12_000;
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
const commentSearchTerms = (query: string) => normalizeWorkspaceSearchKey(query).split(' ').filter(Boolean);
function threadMatchesCommentSearch(root: Comment, replies: readonly Comment[], terms: readonly string[], authors: ReadonlyMap<string, string>) {
  if (!terms.length) return true;
  const text = normalizeWorkspaceSearchKey([root.documentSource?.text, ...[root, ...replies].flatMap(comment =>
    [comment.body, authors.get(comment.authorId) ?? '팀원'])].join(' '));
  return terms.every(term => text.includes(term));
}

const cacheKey = (actorId: string, id: string) => `teamspace:document-draft:${actorId}:${id}`;
const saveCacheKey = (actorId: string, id: string) => `teamspace:document-save:${JSON.stringify([actorId, id])}`;
const restoreCacheKey = (actorId: string, id: string) => `teamspace:document-restore:${JSON.stringify([actorId, id])}`;
const editCopyCacheKey = (actorId: string, id: string) => `teamspace:document-edit-copy:${JSON.stringify([actorId, id])}`;
const commentCacheKey = (actorId: string, id: string) => `teamspace:document-comment-draft:${actorId}:${id}`;
const commentAttemptKey = (actorId: string, id: string) => `teamspace:document-comment-attempt:${JSON.stringify([actorId, id])}`;
const selectionCommentCacheKey = (actorId: string, id: string) => `teamspace:document-selection-comment-draft:${actorId}:${id}`;
type CommentContext = { actorId: string; documentId: string };
type CommentAttempt = CommentContext & { requestId: string; generation: string; content: ReturnType<typeof commentDraftPayload> };
type DocumentEditCopyAttempt = {
  actorId: string; sourceId: string; editSequence: number; sourceMetadata: DocumentMetadata; documentId?: string;
  input: Pick<DocPage, 'title' | 'projectId' | 'parentId' | 'content' | 'status' | 'labels'> & {
    requestId: string; expectedRestoreGeneration: string;
  };
};
type TemplateManagerContext = { projectId: string | null; source?: Pick<DocPage, 'id' | 'title' | 'version' | 'projectId'> };
const draftFromPage = (page: DocPage): Draft => {
  const metadata = documentMetadata(page);
  return {
    id: page.id, content: page.content, plainText: page.plainText, expectedVersion: page.version,
    dirty: false, editSequence: 0, bodyDirty: false, ...metadata, baseMetadata: metadata, baseProjectId: page.projectId,
  };
};
const sameBody = (left: RichContent, right: RichContent) => left === right || JSON.stringify(left) === JSON.stringify(right);
const manualHistoryKey = history().spec.key;

function readSaveAttempt(actorId: string, id: string, generation?: string): DocumentSaveAttempt | null {
  try {
    const attempt = JSON.parse(sessionStorage.getItem(saveCacheKey(actorId, id)) ?? 'null') as DocumentSaveAttempt | null;
    if (attempt?.actorId === actorId && generation && attempt.expectedRestoreGeneration === generation &&
        typeof attempt.requestId === 'string' && typeof attempt.collaborative === 'boolean' && attempt.draft?.id === id &&
        attempt.draft.dirty && attempt.draft.content?.type === 'doc' && Number.isSafeInteger(attempt.draft.expectedVersion)) return attempt;
  } catch { /* The cached request may be unavailable or malformed. */ }
  return null;
}

function readRestoreAttempt(actorId: string, id: string, generation?: string): DocumentRestoreAttempt | null {
  try {
    const attempt = JSON.parse(sessionStorage.getItem(restoreCacheKey(actorId, id)) ?? 'null') as DocumentRestoreAttempt | null;
    if (generation && attempt?.actorId === actorId && attempt.documentId === id && attempt.expectedRestoreGeneration === generation &&
        Number.isSafeInteger(attempt.expectedVersion) && typeof attempt.requestId === 'string' && typeof attempt.revisionId === 'string') return attempt;
  } catch { /* A malformed cached request must not prevent opening the document. */ }
  return null;
}

function readEditCopyAttempt(actorId: string, id: string, generation?: string): DocumentEditCopyAttempt | null {
  try {
    const attempt = JSON.parse(sessionStorage.getItem(editCopyCacheKey(actorId, id)) ?? 'null') as DocumentEditCopyAttempt | null;
    if (generation && attempt?.input?.expectedRestoreGeneration === generation && attempt.actorId === actorId && attempt.sourceId === id &&
        Number.isSafeInteger(attempt.editSequence) && Array.isArray(attempt.sourceMetadata?.labels) &&
        attempt.input.content?.type === 'doc' && typeof attempt.input.requestId === 'string') return attempt;
  } catch { /* The cached request may be unavailable or malformed. */ }
  return null;
}

function loadManualBody(editor: Editor | null, content: RichContent) {
  if (!editor || editor.isDestroyed) return;
  editor.chain().setMeta('addToHistory', false).setContent(content, { emitUpdate: false }).run();
  const state = editor.state;
  const historyPlugin = manualHistoryKey?.get(state);
  if (!historyPlugin) return;
  // Reinitialize the undo and redo stacks without resetting the other editor plugins.
  const withoutHistory = state.reconfigure({ plugins: state.plugins.filter(plugin => plugin !== historyPlugin) });
  editor.view.updateState(withoutHistory.reconfigure({ plugins: state.plugins }));
}

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
  reading, onChangeReading, documentLabel, onChangeDocumentLabel, sectionId, publicationLink, onClosePublicationLink, issueDrawerOpen = false,
  commentFocus, onCopyCommentLink, onOpenIssueForReview, onOpenIssueSchedule, onOpenMigratedIssue }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [homeEntryReady, setHomeEntryReady] = useState<string | null>(null);
  const [findScope, setFindScope] = useState<string | null>(null);
  const findOpener = useRef<HTMLButtonElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const [readingFindScope, setReadingFindScope] = useState<string | null>(null);
  const readingFindOpener = useRef<HTMLButtonElement>(null);
  const readingFindInput = useRef<HTMLInputElement>(null);
  const readingBody = useRef<HTMLDivElement>(null);
  const readingTitle = useRef<HTMLHeadingElement>(null);
  const pendingHomeFocus = useRef<string | null>(null);
  const documentScope = JSON.stringify([actorId, selectedDocumentId]);
  if (findScope !== null && findScope !== documentScope) setFindScope(null);
  if (readingFindScope !== null && (!reading || readingFindScope !== documentScope)) setReadingFindScope(null);
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
  const activeGeneration = useRef(data.restoreGeneration);
  activeGeneration.current = data.restoreGeneration;
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState<DocumentRestoreAttempt | null>(null);
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
  const saveRecoveryRef = useRef<DocumentSaveAttempt | null>(null);
  const saveRecoveryObserved = useRef<ObservedDocument | undefined>(undefined);
  const [saveRecovery, setSaveRecovery] = useState<DocumentSaveAttempt | null>(null);
  const showSaveRecovery = useCallback((attempt: DocumentSaveAttempt | null) => {
    if (saveRecoveryRef.current !== attempt) saveRecoveryObserved.current = undefined;
    saveRecoveryRef.current = attempt;
    setSaveRecovery(attempt);
  }, []);
  const titleInput = useRef<HTMLInputElement>(null);
  const manualEditorRef = useRef<Editor | null>(null);
  const [publicationDocumentId, setPublicationDocumentId] = useState<string | null>(null);
  const [moveRequest, setMoveRequest] = useState<{ source: DocPage; destination?: Pick<DocPage, 'projectId' | 'parentId'> } | null>(null);
  const closeMove = useCallback(() => setMoveRequest(null), []);
  const [copyDocumentId, setCopyDocumentId] = useState<string | null>(null);
  const closeCopy = useCallback(() => setCopyDocumentId(null), []);
  const [orderRequest, setOrderRequest] = useState<{ documentId: string; placement?: DocumentOrderPlacement } | null>(null);
  const closeOrder = useCallback(() => setOrderRequest(null), []);
  const publicationOpener = useRef<HTMLButtonElement>(null);
  const closePublication = useCallback(() => {
    setPublicationDocumentId(null);
    if (selectedDocumentId && publicationLink) onClosePublicationLink?.(selectedDocumentId,publicationLink);
    requestAnimationFrame(() => publicationOpener.current?.focus());
  }, [onClosePublicationLink,publicationLink,selectedDocumentId]);
  const [storageProblem, setStorageProblem] = useState(false);
  const [editCopyAttempt, setEditCopyAttempt] = useState<DocumentEditCopyAttempt | null>(null);
  const recoveringEditCopy = editCopyAttempt?.actorId === actorId && editCopyAttempt.sourceId === selectedDocumentId &&
    editCopyAttempt.input.expectedRestoreGeneration === data.restoreGeneration ? editCopyAttempt : null;
  const rememberEditCopy = useCallback((attempt: DocumentEditCopyAttempt, pending: boolean) => {
    if (actorRef.current === attempt.actorId && activeActorRef.current === attempt.actorId &&
        activeGeneration.current === attempt.input.expectedRestoreGeneration && draftRef.current?.id === attempt.sourceId) {
      setEditCopyAttempt(pending ? attempt : null);
    }
    try {
      const key = editCopyCacheKey(attempt.actorId, attempt.sourceId);
      if (pending) sessionStorage.setItem(key, JSON.stringify(attempt));
      else sessionStorage.removeItem(key);
    } catch { setStorageProblem(true); }
  }, []);
  const rememberSaveAttempt = useCallback((owner: string, id: string, attempt: DocumentSaveAttempt | null) => {
    try {
      const key = saveCacheKey(owner, id);
      if (attempt) sessionStorage.setItem(key, JSON.stringify(attempt));
      else sessionStorage.removeItem(key);
    } catch { setStorageProblem(true); }
  }, []);
  const reportReplyStorageProblem = useCallback(() => setStorageProblem(true), []);
  const reply = useDocumentCommentReply(actorId, draft?.id, reportReplyStorageProblem);
  const { isSending: isReplySending, hasDraft: hasReplyDraft, clearDocument: clearReplyDrafts } = reply;
  const [search, setSearch] = useState('');
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
  const [commentQuery, setCommentQuery] = useState('');
  const commentSearchInput = useRef<HTMLInputElement>(null);
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
  const commentSendPending = useRef(false);
  const [commentAttempt, setCommentAttempt] = useState<CommentAttempt | null>(null);
  const [commentSubmitError, setCommentSubmitError] = useState('');
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsRefreshing, setCommentsRefreshing] = useState(false);
  const [commentError, setCommentError] = useState('');
  const loadCommentList = useRef<((mode: CommentLoadMode) => void) | null>(null);
  const [historyResult, setHistoryResult] = useState<{ key: string; revisions: DocRevision[]; error: string } | null>(null);
  const [historyReload, setHistoryReload] = useState(0);
  const [newOpen, setNewOpen] = useState(false);
  const [newParent, setNewParent] = useState('');
  const [newProject, setNewProject] = useState(projectId === 'all' ? '' : projectId);
  const [newTitle, setNewTitle] = useState('');
  const [newTemplate, setNewTemplate] = useState('blank');
  const [creating, setCreating] = useState(false);
  const creatingRequest = useRef(false);
  const newTitleCustomized = useRef(false);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownImportPreview | null>(null);
  const [storedCreateAttempt, setCreateAttempt] = useState<DocumentCreationAttempt | null>(null);
  const createAttempt = storedCreateAttempt?.actorId === actorId &&
    storedCreateAttempt.input.expectedRestoreGeneration === data.restoreGeneration ? storedCreateAttempt : null;
  const [createStorageProblem, setCreateStorageProblem] = useState(false);
  const [createError, setCreateError] = useState('');
  const importingMarkdown = newTemplate === 'markdown';
  const [teamTemplate, setTeamTemplate] = useState<DocumentTemplateSummary | null>(null);
  const [teamTemplateConflict, setTeamTemplateConflict] = useState(false);
  const [creationRejected, setCreationRejected] = useState(false);
  const [templateManager, setTemplateManager] = useState<TemplateManagerContext | null>(null);
  const templateManagerOpener = useRef<HTMLButtonElement>(null);
  const templateFormOpen = useRef(false);
  const templateDraftDirty = useRef(false);
  const creationAttemptRef = useRef<DocumentCreationAttempt | null>(null);
  const createAttemptPersisted = useRef(false);
  const createOpener = useRef<HTMLElement>(null);
  const createSubmit = useRef<HTMLButtonElement>(null);
  const createTitle = useRef<HTMLInputElement>(null);
  const { catalog: teamCatalog, reload: reloadTeamTemplates } = useDocumentTemplates(newProject || null, newOpen && !importingMarkdown);
  const currentTeamTemplate = teamCatalog?.state === 'ready' ? teamCatalog.templates.find(item => item.id === teamTemplate?.id) : undefined;
  const teamTemplateChanged = Boolean(teamTemplate && !createAttempt && (teamTemplateConflict ||
    teamCatalog?.state === 'ready' && currentTeamTemplate?.version !== teamTemplate.version));
  const createLocked = creating || Boolean(createAttempt) || creationRejected;
  templateFormOpen.current = newOpen && Boolean(teamTemplate);
  templateDraftDirty.current = templateFormOpen.current && !createAttempt && (newTitleCustomized.current || teamTemplateChanged);
  const recordCreateAttempt = useCallback((value: DocumentCreationAttempt | null) => {
    const attempt = value ?? creationAttemptRef.current;
    const saved = attempt ? writeDocumentCreationAttempt(attempt, Boolean(value)) : false;
    creationAttemptRef.current = value;
    createAttemptPersisted.current = Boolean(value) && saved;
    setCreateAttempt(value);
    setCreateStorageProblem(Boolean(value) && !saved);
  }, []);
  const closeCreateDocument = useCallback(() => {
    templateFormOpen.current = false;
    templateDraftDirty.current = false;
    setNewOpen(false);
    setMarkdownPreview(null);
    setCreateError('');
    setTeamTemplate(null);
    setTeamTemplateConflict(false);
    setCreationRejected(false);
  }, []);
  useEffect(() => {
    const previous = creationAttemptRef.current;
    if (previous?.actorId === actorId && previous.input.expectedRestoreGeneration === data.restoreGeneration) return;
    if (previous) closeCreateDocument();
    const attempt = readDocumentCreationAttempt(actorId, data.restoreGeneration);
    creationAttemptRef.current = attempt;
    createAttemptPersisted.current = Boolean(attempt);
    setCreateAttempt(attempt);
    setCreateStorageProblem(false);
  }, [actorId, data.restoreGeneration, closeCreateDocument]);
  const confirmCreateDocumentExit = useCallback((discard = false) => {
    if (creationAttemptRef.current) return !discard && createAttemptPersisted.current ||
      window.confirm(discard ? '문서가 저장됐을 수 있습니다. 이 탭에 보관한 결과 확인을 지울까요?' :
        '문서가 저장됐을 수 있습니다. 목록에서 확인할 수 있습니다. 계속할까요?');
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
  const documentLinkTarget = useRef<DocumentLinkTarget | null>(null);
  const clipboardImageScope = useRef<ClipboardImageScope | null>(null);
  const tablePasteActive = useRef(false);
  const setTablePasteActive = useCallback((active: boolean) => { tablePasteActive.current = active; }, []);
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
  const [decisionLinkAttempt, setDecisionLinkAttempt] = useState<DecisionLinkAttempt | null>(null);
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
  const [openedEditorScope, setOpenedEditorScope] = useState<string | null>(null);
  const editorSessionNeeded = !reading || openedEditorScope === documentScope;
  const [sessionError, setSessionError] = useState('');
  const [manualRecovery, setManualRecovery] = useState(false);
  const manualRecoveryRef = useRef(false);
  const [liveEditor, setLiveEditor] = useState<Editor | null>(null);
  const [liveState, setLiveState] = useState<CollaborationView | null>(null);
  const liveStateRef = useRef<CollaborationView | null>(null);
  const [archivedLiveRecovery, setArchivedLiveRecovery] = useState(false);
  const archivedLiveRecoveryRef = useRef(false);

  const selectedPage = data.documents.find(page => page.id === selectedDocumentId);
  const selectedPageId = selectedPage?.id;
  const publicationOpen = Boolean(selectedPage && (publicationLink || selectedPage.id === publicationDocumentId));
  const pendingDecisionLink = decisionLinkAttempt?.source.id === selectedPageId && decisionLinkAttempt?.actorId === actorId &&
    decisionLinkAttempt?.expectedRestoreGeneration === data.restoreGeneration ? decisionLinkAttempt : null;
  useEffect(() => {
    const generation = data.restoreGeneration;
    setDecisionLinkAttempt(selectedPageId && generation ? readDecisionLinkAttempt(actorId, selectedPageId, generation) : null);
  }, [actorId, selectedPageId, data.restoreGeneration]);
  const rememberDecisionLink = useCallback((attempt: DecisionLinkAttempt, next: DecisionLinkAttempt | null) => {
    if (activeActorRef.current === attempt.actorId && activeGeneration.current === attempt.expectedRestoreGeneration &&
        draftRef.current?.id === attempt.source.id) setDecisionLinkAttempt(next);
    try { writeDecisionLinkAttempt(attempt, next); }
    catch { setStorageProblem(true); }
  }, []);

  useLayoutEffect(() => {
    setMigratedIssueLink(null);
    return () => {
      migratedIssueRequest.current?.controller.abort();
      migratedIssueRequest.current = null;
    };
  }, [documentScope, sectionId, issueDrawerOpen, publicationOpen, checklistReselecting, reading]);

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
  const moveOpen = Boolean(moveRequest);
  const copyOpen = Boolean(selectedPage && selectedPage.id === copyDocumentId);
  const orderOpen = Boolean(orderRequest);
  const currentProject = data.projects.find(project => project.id === projectId);
  const pagesById = useMemo(() => new Map(data.documents.map(page => [page.id, page])), [data.documents]);
  const configuredProjectHome = currentProject ? data.documentSpaceHomes?.find(home => home.projectId === currentProject.id) : undefined;
  const configuredTeamHome = data.documentSpaceHomes?.find(home => home.projectId === null);
  const projectHomePage = configuredProjectHome?.documentId ? pagesById.get(configuredProjectHome.documentId) : undefined;
  const teamHomePage = configuredTeamHome?.documentId ? pagesById.get(configuredTeamHome.documentId) : undefined;
  const projectHome = projectHomePage?.projectId === currentProject?.id ? projectHomePage : undefined;
  const teamHome = teamHomePage?.projectId === null ? teamHomePage : undefined;
  const moveSource = moveRequest && (pagesById.get(moveRequest.source.id) ?? moveRequest.source);
  const scoped = useMemo(() => data.documents.filter(page => projectId === 'all' || page.projectId === projectId || page.projectId === null), [data.documents, projectId]);
  const activeSession = editorSessionNeeded && session?.document.id === selectedPageId ? session : null;
  const manualSession = activeSession?.enabled === false;
  const liveMode = Boolean(activeSession && (activeSession.enabled || archivedLiveRecovery) && !manualRecovery);
  const confirmingSave = saveRecovery?.actorId === actorId && saveRecovery.draft.id === draft?.id;
  const confirmingRestore = restoreAttempt?.actorId === actorId && restoreAttempt.documentId === selectedPageId &&
    restoreAttempt.expectedRestoreGeneration === data.restoreGeneration ? restoreAttempt : null;
  useEffect(() => {
    setRestoreAttempt(selectedPageId ? readRestoreAttempt(actorId, selectedPageId, data.restoreGeneration) : null);
  }, [actorId, selectedPageId, data.restoreGeneration]);
  function rememberRestoreAttempt(attempt: DocumentRestoreAttempt, pending: boolean) {
    if (actorRef.current === attempt.actorId && activeActorRef.current === attempt.actorId &&
        activeGeneration.current === attempt.expectedRestoreGeneration && draftRef.current?.id === attempt.documentId) {
      setRestoreAttempt(pending ? attempt : null);
    }
    try {
      const key = restoreCacheKey(attempt.actorId, attempt.documentId);
      if (pending) sessionStorage.setItem(key, JSON.stringify(attempt));
      else sessionStorage.removeItem(key);
    } catch { setStorageProblem(true); }
  }
  const restoreRecovery = confirmingRestore && !reading && !saving && <div className="docs-notice" role="status">
    문서 버전 복구 응답을 확인하지 못했습니다.
    <button type="button" className="btn btn-ghost" onClick={() => void sendRevisionRestore(confirmingRestore)}>버전 복구 결과 다시 확인</button>
  </div>;
  const liveDocument = liveState?.document;
  const remoteDocument = liveMode ? liveDocument : activeSession?.document;
  const latestPage = selectedPage && remoteDocument?.id === selectedPage.id && remoteDocument.version > selectedPage.version ? remoteDocument : selectedPage;
  const ancestors = useMemo(() => latestPage?.parentId ? documentAncestors(latestPage, pagesById) : [], [latestPage, pagesById]);
  const { collapsed, toggleBranch } = useDocumentTreeExpansion(actorId, data.restoreGeneration, selectedDocumentId, ancestors);
  const spaceTitle = latestPage?.projectId ? data.projects.find(project => project.id === latestPage.projectId)?.name || '프로젝트' : '팀 공통';
  const crumbParameters = new URLSearchParams();
  if (reading) crumbParameters.set('mode', 'read');
  if (documentLabel) crumbParameters.set('label', documentLabel);
  const crumbQuery = crumbParameters.size ? `?${crumbParameters}` : '';
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
      loadManualBody(manualEditorRef.current, next.content);
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
    const recovery = saveRecoveryRef.current;
    if (recovery?.draft.id === document.id && recovery.actorId === actorRef.current) {
      if (!saveRecoveryObserved.current || saveRecoveryObserved.current.document.version < document.version) saveRecoveryObserved.current = observed;
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
      Placeholder.configure({ placeholder: '내용을 작성하세요. /로 블록을 추가하고 @로 문서를 연결하세요.' }),
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
  }, [actorId, editor, selectedPageId, clipboardWritable, clipboardLiveEpoch]);
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
    loadManualBody(manualEditor, next.content);
    sessionRef.current = current; setSession(current);
    archivedLiveRecoveryRef.current = false; setArchivedLiveRecovery(false);
    manualRecoveryRef.current = false; setManualRecovery(false);
    setConflict(next.dirty ? 'generic' : null);
    void refresh().catch(() => {});
  }, [manualEditor, rememberDraft, refresh, setConflict]);

  useEffect(() => {
    // Leave an open editor connected so a same-document mode change preserves its history and pending updates.
    setOpenedEditorScope(previous => !reading || previous === documentScope ? documentScope : null);
  }, [documentScope, reading]);

  useEffect(() => {
    if (!selectedPageId) return;
    let active = true;
    sessionRef.current = null; setSession(null); setSessionError('');
    manualRecoveryRef.current = false; setManualRecovery(false);
    archivedLiveRecoveryRef.current = false; setArchivedLiveRecovery(false);
    if (!editorSessionNeeded) return;
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
  }, [selectedPageId, actorId, editorSessionNeeded, observeDocument]);

  useEffect(() => { manualEditor?.setEditable(manualSession && !manualRecovery && !archivedLiveRecovery && !restoring, false); }, [manualEditor, manualSession, manualRecovery, archivedLiveRecovery, restoring]);
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
      showSaveRecovery(null);
      setEditCopyAttempt(null);
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
    const attempt = readSaveAttempt(actorId, selectedPage.id, data.restoreGeneration);
    if (attempt && (!next.dirty || next.expectedVersion < attempt.draft.expectedVersion)) next = attempt.draft;
    showSaveRecovery(attempt && next.expectedVersion === attempt.draft.expectedVersion ? attempt : null);
    setEditCopyAttempt(readEditCopyAttempt(actorId, selectedPage.id, data.restoreGeneration));
    draftRef.current = next;
    setDraft(next);
    loadManualBody(manualEditor, next.content);
    setConflict(next.dirty && next.expectedVersion !== selectedPage.version ? 'generic' : null);
    setShowLatest(false);
    setReferenceSelection(null);
    setIssueBlockSelection(null);
    closeAnnotation();
    setSlashQuery(null);
    setInsertKind(null);
  }, [selectedPage, actorId, manualEditor, rememberDraft, manualSession, archivedLiveRecovery, observeDocument, setConflict, closeAnnotation,
    data.restoreGeneration, showSaveRecovery]);

  useEffect(() => {
    if (archiveImport || selectedDocumentId || filtersActive) {
      setHomeEntryReady(null);
      return;
    }
    let active = true;
    // A teammate can change the home while this workspace remains open.
    void refresh().catch(() => {}).finally(() => { if (active) setHomeEntryReady(projectId); });
    return () => { active = false; };
  }, [archiveImport, selectedDocumentId, filtersActive, projectId, refresh]);
  useEffect(() => {
    if (archiveImport || selectedDocumentId || (!filtersActive && homeEntryReady !== projectId)) return;
    if (projectHome && !filtersActive) {
      if (onSelectDocument(projectHome.id, undefined, true)) pendingHomeFocus.current = projectHome.id;
    } else if (visible.length) onSelectDocument(visible[0].id);
  }, [archiveImport, selectedDocumentId, projectHome, filtersActive, homeEntryReady, projectId, visible, onSelectDocument]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (archiveImportNavigation.current !== 'ready' || creatingRequest.current || (creationAttemptRef.current && !createAttemptPersisted.current)
        || templateDraftDirty.current || draftRef.current?.dirty
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
      if (tablePasteActive.current) {
        event.preventDefault();
        notify('표 데이터 입력을 마친 뒤 이동해 주세요.', 'error');
        return;
      }
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
      const closeCreateForm = newOpen && Boolean(templateFormOpen.current || creationAttemptRef.current);
      if (closeCreateForm && !confirmCreateDocumentExit()) {
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
      if (closeCreateForm) afterAcceptedNavigation(event, closeCreateDocument);
    };
    window.addEventListener('teamspace:navigate', guard);
    return () => window.removeEventListener('teamspace:navigate', guard);
  }, [annotationDialog, archiveImport, closeCreateDocument, confirmCreateDocumentExit, newOpen, notify, rememberDraft, rememberComment, selectedDocumentId, isReplySending, hasReplyDraft, offlineExport,
    discardCommentEdit, hasCommentEditDraft, isCommentEditPending]);

  useEffect(() => {
    if (newOpen && createAttempt && !creating && !creationRejected) createSubmit.current?.focus({ preventScroll: true });
  }, [newOpen, creating, createAttempt, creationRejected]);

  const saveDraft = useCallback(async () => {
    const editable = draftRef.current;
    if (!editable || savingRef.current || actorRef.current !== activeActorRef.current) return;
    const capturedActor = actorRef.current;
    const cachedAttempt = saveRecoveryRef.current;
    const recovering = cachedAttempt?.draft.id === editable.id && cachedAttempt.actorId === capturedActor ? cachedAttempt : null;
    const captured = recovering?.draft ?? editable;
    const collaborative = recovering?.collaborative ?? Boolean(sessionRef.current?.enabled && sessionRef.current.document.id === captured.id);
    if (!recovering) {
      if (!captured.dirty) return;
      if (conflictRef.current && conflictRef.current !== 'generic') { setShowLatest(true); return; }
      if (archivedLiveRecoveryRef.current) { notify('보관한 공동 편집을 먼저 복구하거나 최신 문서를 열어주세요.', 'error'); return; }
      if (collaborative && (manualRecoveryRef.current || liveStateRef.current?.phase !== 'connected' || liveStateRef.current?.pending)) { notify('공동 편집 연결과 본문 동기화를 먼저 확인해주세요.', 'error'); return; }
    }
    const sameContext = () => draftRef.current?.id === captured.id && actorRef.current === capturedActor && activeActorRef.current === capturedActor;
    const pending: DocumentSave = { actorId: capturedActor, documentId: captured.id, observed: recovering ? saveRecoveryObserved.current : undefined };
    let attempt = recovering;
    documentSave.current = pending;
    savingRef.current = true;
    setSaving(true);
    try {
      if (!recovering && !collaborative) {
        const latest = await api<CollaborationSession>(`/documents/${captured.id}/collaboration`, { headers: { 'X-Actor-Id': capturedActor } });
        if (latest.enabled) {
          sessionRef.current = latest; setSession(latest);
          if (captured.bodyDirty) { manualRecoveryRef.current = true; setManualRecovery(true); }
          notify('공동 편집이 시작된 문서입니다. 보관한 편집을 확인한 후 이어서 작업해주세요.', 'error');
          return;
        }
        observeDocument({ document: latest.document, live: false });
      }
      if (!attempt && data.restoreGeneration) {
        attempt = { actorId: capturedActor, requestId: newRequestId(), expectedRestoreGeneration: data.restoreGeneration, collaborative, draft: captured };
        rememberSaveAttempt(capturedActor, captured.id, attempt);
      }
      const base = captured.baseMetadata;
      const result = await api<DocPage>(`/documents/${captured.id}`, { method: 'PATCH', headers: { 'X-Actor-Id': capturedActor }, body: JSON.stringify({
        expectedVersion: captured.expectedVersion,
        ...(attempt ? { requestId: attempt.requestId, expectedRestoreGeneration: attempt.expectedRestoreGeneration } : {}),
        ...(!base || documentTitleForSave(captured.title) !== documentTitleForSave(base.title) ? { title: documentTitleForSave(captured.title) } : {}),
        ...(!base || !sameLabels(captured.labels, base.labels) ? { labels: captured.labels } : {}),
        ...(!base || captured.status !== base.status ? { status: captured.status } : {}),
        ...(!base || captured.parentId !== base.parentId ? { parentId: captured.parentId } : {}),
        ...(!collaborative && captured.bodyDirty ? { content: captured.content, plainText: captured.plainText, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION } : {}),
      }) });
      if (result?.id !== captured.id || result.version !== captured.expectedVersion + 1 || result.content?.type !== 'doc') {
        throw new Error('문서 저장 응답을 확인하지 못했습니다.');
      }
      const current = draftRef.current;
      if (current && sameContext()) {
        const next = draftAfterSave(captured, current, result, collaborative);
        storeDraft(next, !collaborative);
        if (!next.bodyDirty && manualRecoveryRef.current && sessionRef.current?.enabled && sessionRef.current.document.id === captured.id) {
          manualRecoveryRef.current = false;
          setManualRecovery(false);
        }
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
      if (attempt) rememberSaveAttempt(capturedActor, captured.id, null);
      if (sameContext()) showSaveRecovery(null);
      try {
        await refresh();
        if (recovering && sameContext()) notify('문서 저장 결과를 확인했습니다.', 'success');
      } catch { notify('문서를 저장했습니다. 목록을 다시 열어 최신 내용을 확인해 주세요.', 'error'); }
    } catch (error) {
      if (attempt && !isDefiniteTemplateFailure(error)) {
        if (sameContext()) showSaveRecovery(attempt);
        return;
      }
      if (attempt) rememberSaveAttempt(capturedActor, captured.id, null);
      if (sameContext()) showSaveRecovery(null);
      if (error instanceof ApiError && error.status === 409) {
        if (sameContext()) setConflict('generic');
        notify(recovering ? error.message : '다른 변경사항이 있어 저장하지 않았습니다. 내 편집은 임시 보관되어 있어요.', 'error');
        await refresh().catch(() => {});
      } else notify(error instanceof Error ? error.message : '문서를 저장하지 못했습니다.', 'error');
    } finally {
      documentSave.current = null;
      if (pending.observed && capturedActor === activeActorRef.current) observeDocument(pending.observed);
      savingRef.current = false;
      setSaving(false);
    }
  }, [data.restoreGeneration, notify, observeDocument, refresh, rememberSaveAttempt, setConflict, showSaveRecovery, storeDraft]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (issueDrawerOpen || newOpen || templateManager || offlineExport || archiveImport || referenceDialog || issueBlockDialog) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        if (reading) return;
        event.preventDefault();
        if (!publicationOpen && !moveOpen && !copyOpen && !orderOpen) void saveDraft();
      }
      if (event.key === 'Escape') { setSlashQuery(null); setInsertKind(null); setReferenceSelection(null); setIssueBlockSelection(null); setExportOpen(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [saveDraft, reading, publicationOpen, moveOpen, copyOpen, orderOpen, issueDrawerOpen, newOpen, templateManager, offlineExport, archiveImport, referenceDialog, issueBlockDialog]);

  const moveBlocker = (sourceId: string) => {
    if (savingRef.current || restoring) return '저장 또는 버전 복원이 끝나면 문서를 이동할 수 있습니다.';
    const affectsOpenDocument = sourceId === selectedDocumentId || ancestors.some(page => page.id === sourceId);
    if (affectsOpenDocument && (draftRef.current?.dirty || listDrafts.current.size)) return '문서 편집과 목록 설정을 저장한 뒤 이동해 주세요.';
    if ((affectsOpenDocument && (liveStateRef.current?.pending || manualRecoveryRef.current || archivedLiveRecoveryRef.current ||
        (selectedDocumentId && hasPendingCollaboration(actorId, selectedDocumentId)))) || hasPendingCollaboration(actorId, sourceId)) {
      return '이 브라우저의 공동 편집을 동기화하거나 복구한 뒤 문서를 이동해 주세요.';
    }
    return null;
  };
  const openMove = (source: DocPage, destination?: Pick<DocPage, 'projectId' | 'parentId'>) => {
    const blocker = moveBlocker(source.id);
    if (blocker) { notify(blocker, 'error'); return; }
    setExportOpen(false);
    setMoveRequest({ source, destination });
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
  const commentResultPending = commentAttempt?.actorId === actorId && commentAttempt.documentId === documentId;
  const commentAuthors = useMemo(() => new Map(data.users.map(user => [user.id, user.name])), [data.users]);
  const commentTerms = useMemo(() => commentSearchTerms(commentQuery), [commentQuery]);
  const statusComments = useMemo(() => commentFilter === 'all' ? rootComments
    : rootComments.filter(comment => commentFilterFor(comment) === commentFilter), [commentFilter, rootComments]);
  const matchedComments = useMemo(() => statusComments.filter(comment =>
    threadMatchesCommentSearch(comment, repliesByParent.get(comment.id) ?? [], commentTerms, commentAuthors)),
  [commentAuthors, commentTerms, repliesByParent, statusComments]);
  const replyParent = reply.current?.parentId;
  const retainedReplyParent = replyParent && !matchedComments.some(comment => comment.id === replyParent)
    ? statusComments.find(comment => comment.id === replyParent) : undefined;
  const visibleComments = retainedReplyParent ? [...matchedComments, retainedReplyParent] : matchedComments;
  const activeCommentEdit = commentEditing.current?.base;
  const showDetachedCommentEdit = activeCommentEdit && (!visibleComments.some(comment => comment.id === (activeCommentEdit.parentCommentId ?? activeCommentEdit.id))
    || !comments.some(comment => comment.id === activeCommentEdit.id));
  const commentsPanelVisible = sidebarOpen && sideTab === 'comments' && !issueDrawerOpen && !publicationOpen && !newOpen &&
    !archiveImport && !issueBlockDialog && !templateManager && !offlineExport && !documentAction && !checklistReselecting;
  const keepCommentListFocus = useEffectEvent((result: Comment[]) => {
    const focused = document.activeElement?.closest('article[id^="document-comment-"]');
    const filter = activeCommentFilter.current;
    if (!focused || !filter) return;
    const comment = result.find(item => `document-comment-${item.id}` === focused.id);
    const root = comment?.parentCommentId ? result.find(item => item.id === comment.parentCommentId) : comment;
    if (!root || (filter.value !== 'all' && commentFilterFor(root) !== filter.value)) {
      filter.focus({ preventScroll: true });
    } else if (root.id !== replyParent && commentTerms.length && !threadMatchesCommentSearch(root,
      result.filter(item => item.parentCommentId === root.id), commentTerms, commentAuthors)) {
      commentSearchInput.current?.focus({ preventScroll: true });
    }
  });
  useEffect(() => {
    if (!documentId) return;
    rememberComment();
    const context = { actorId, documentId };
    commentContextRef.current = context;
    resolutionRequest.current = null;
    let cached = emptyCommentDraft();
    let attempt: CommentAttempt | null = null;
    try {
      cached = decodeCommentDraft(localStorage.getItem(commentCacheKey(actorId, documentId)));
      const saved = JSON.parse(sessionStorage.getItem(commentAttemptKey(actorId, documentId)) ?? 'null') as CommentAttempt | null;
      if (saved?.actorId === actorId && saved.documentId === documentId && typeof saved.requestId === 'string' &&
          typeof saved.generation === 'string' && typeof saved.content?.body === 'string' && saved.content.body) attempt = saved;
    } catch { setStorageProblem(true); }
    commentDraftRef.current = cached;
    setComments([]); setCommentDraft(cached); setCommentsLoading(true); setCommentsRefreshing(false); setCommentError('');
    setCommentAttempt(attempt); setCommentSubmitError('');
    setCommentFilter('all'); setCommentQuery(''); setResolvingCommentId(null); setResolutionError('');
    return () => {
      if (resolutionRequest.current === context) resolutionRequest.current = null;
    };
  }, [documentId, actorId, rememberComment]);

  useEffect(() => {
    if (!documentId) return;
    let activeRequest: AbortController | undefined;
    const loadComments = (mode: CommentLoadMode) => {
      if (mode === 'automatic' && activeRequest) return;
      activeRequest?.abort();
      const request = new AbortController();
      activeRequest = request;
      if (mode === 'manual') {
        setCommentsRefreshing(true);
        setCommentError('');
      }
      void api<Comment[]>(`/comments?resourceType=document&resourceId=${encodeURIComponent(documentId)}`, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(COMMENT_LOAD_TIMEOUT_MS)]), headers: { 'X-Actor-Id': actorId },
      }).then(result => {
        if (request.signal.aborted) return;
        keepCommentListFocus(result);
        setComments(result);
        setCommentError('');
      })
        .catch(error => {
          if (!request.signal.aborted && mode !== 'automatic') {
            setCommentError(error instanceof ApiError ? error.message : '댓글을 불러오지 못했습니다.');
          }
        })
        .finally(() => {
          if (activeRequest !== request || request.signal.aborted) return;
          activeRequest = undefined;
          setCommentsLoading(false);
          setCommentsRefreshing(false);
          setLoadedCommentActivation(commentActivation);
        });
    };
    const reload = () => loadComments('event');
    loadCommentList.current = loadComments;
    reload();
    window.addEventListener(COMMENT_LIST_CHANGED, reload);
    window.addEventListener('teamspace:trash-changed', reload);
    window.addEventListener('teamspace:workspace-imported', reload);
    return () => {
      activeRequest?.abort();
      loadCommentList.current = null;
      window.removeEventListener(COMMENT_LIST_CHANGED, reload);
      window.removeEventListener('teamspace:trash-changed', reload);
      window.removeEventListener('teamspace:workspace-imported', reload);
    };
  }, [documentId, actorId, commentActivation]);

  useEffect(() => {
    if (!documentId || !commentsPanelVisible) return;
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') loadCommentList.current?.('automatic');
    };
    refreshVisible();
    const timer = window.setInterval(refreshVisible, COMMENT_REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [documentId, commentsPanelVisible]);

  useEffect(() => {
    if (!focusCommentId.current || !sidebarOpen || sideTab !== 'comments' || issueDrawerOpen || publicationOpen || documentAction || newOpen || templateManager) return;
    const article = document.getElementById(`document-comment-${focusCommentId.current}`);
    if (!article && commentTerms.length && comments.some(comment => comment.id === focusCommentId.current)) {
      setCommentQuery('');
      return;
    }
    if (!article || article.closest('[inert]')) return;
    focusCommentId.current = null;
    article.scrollIntoView({ block: 'nearest' });
    article.focus({ preventScroll: true });
  }, [comments, sidebarOpen, sideTab, commentFilter, commentTerms, issueDrawerOpen, publicationOpen, documentAction, newOpen, templateManager]);

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
    const commentTarget = document.getElementById(`document-comment-${commentFocus.commentId}`);
    if (!commentTarget && focusedRoot && commentTerms.length) {
      setCommentQuery('');
      return;
    }
    const target = commentTarget ?? commentsHeading.current;
    if (!target || target.closest('[inert]')) return;
    handledCommentActivation.current = commentFocus.activation;
    target.scrollIntoView({ block: 'nearest' });
    target.focus({ preventScroll: true });
  }, [commentFocus, commentActivation, loadedCommentActivation, focusedRoot, commentFilter, commentTerms, issueDrawerOpen, publicationOpen, documentAction,
    newOpen, templateManager, sidebarOpen, sideTab, issueBlockSelection]);

  const historyVersion = reading ? latestPage?.version : draft?.expectedVersion;
  const historyDocumentId = documentId === selectedPageId ? documentId : undefined;
  const historyScope = JSON.stringify([actorId, historyDocumentId, data.restoreGeneration]);
  const historyKey = JSON.stringify([historyScope, historyVersion, historyReload]);
  const currentHistory = historyResult?.key === historyKey ? historyResult : null;
  useEffect(() => {
    if (!historyDocumentId || sideTab !== 'history' || publicationOpen) return;
    const controller = new AbortController();
    api<DocRevision[]>(`/documents/${encodeURIComponent(historyDocumentId)}/revisions`, { cache: 'no-store', signal: controller.signal })
      .then(revisions => {
        if (!controller.signal.aborted) setHistoryResult({ key: historyKey, revisions, error: '' });
      })
      .catch(error => {
        if (!controller.signal.aborted) setHistoryResult({ key: historyKey, revisions: [], error: error instanceof ApiError ? error.message : '이력을 불러오지 못했습니다.' });
      });
    return () => controller.abort();
  }, [historyDocumentId, historyKey, sideTab, publicationOpen]);

  function selectDocument(id: string, showReading = reading) {
    if (id === selectedDocumentId) return true;
    if (documentAction) {
      if (!window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }))) return false;
      return onSelectDocument(id, undefined, showReading);
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
    return onSelectDocument(id, undefined, showReading);
  }

  function openSpaceHome(page: DocPage) {
    if (page.id === selectedDocumentId) {
      if (reading) readingTitle.current?.focus();
      else onChangeReading(true);
    } else if (selectDocument(page.id, true)) pendingHomeFocus.current = page.id;
  }

  function openNew(parentId = '', template = 'blank') {
    if (createAttempt) {
      reopenCreateDocument(createAttempt);
      return;
    }
    const parent = data.documents.find(page => page.id === parentId);
    createOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setNewParent(parentId);
    setNewProject(parent ? parent.projectId || '' : projectId === 'all' ? '' : projectId);
    setNewTemplate(template);
    setNewTitle(template === 'blank' ? '' : DOCUMENT_TEMPLATES.find(item => item.id === template)?.name || '');
    newTitleCustomized.current = false;
    setMarkdownPreview(null);
    setCreateError('');
    setTeamTemplate(null);
    setTeamTemplateConflict(false);
    setCreationRejected(false);
    reloadTeamTemplates();
    setNewOpen(true);
  }

  function reopenCreateDocument(attempt: DocumentCreationAttempt) {
    const { input } = attempt;
    createOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    newTitleCustomized.current = true;
    setNewParent(input.parentId ?? '');
    setNewProject(input.projectId ?? '');
    setNewTitle(input.title);
    setNewTemplate(attempt.template);
    setTeamTemplate(attempt.teamTemplate ?? null);
    setTeamTemplateConflict(false);
    setMarkdownPreview(attempt.markdown && input.content ? { ...attempt.markdown, content: input.content } : null);
    setCreationRejected(false);
    setCreateError(attempt.documentId ? '문서를 저장했습니다. 목록을 다시 불러와 저장한 문서를 열어 주세요.' :
      '저장 결과를 확인할 수 없습니다. 같은 요청으로 다시 확인해 주세요.');
    setNewOpen(true);
  }

  function discardCreateDocument() {
    if (creatingRequest.current || !confirmCreateDocumentExit(true)) return;
    if (createAttempt) recordCreateAttempt(null);
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
    setMarkdownPreview(null);
    setCreateError('');
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
    setMarkdownPreview(null);
    setCreateError('');
  }

  function changeCreateProject(value: string) {
    setNewProject(value);
    setNewParent('');
    if (teamTemplate?.projectId && teamTemplate.projectId !== value) chooseDocumentTemplate('blank');
  }

  function reviewMarkdown(preview: MarkdownImportPreview | null, fileTitle = '') {
    setMarkdownPreview(preview);
    setCreateError('');
    if (preview && !newTitleCustomized.current) {
      setNewTitle((preview.suggestedTitle || fileTitle).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240).toWellFormed());
    }
  }

  async function createDocument(event: React.FormEvent) {
    event.preventDefault();
    if (creatingRequest.current || !newTitle.trim() || !createAttempt && importingMarkdown && !markdownPreview || teamTemplateChanged || creationRejected) return;
    if (!createAttempt && listDrafts.current.size && !window.confirm(LIST_DRAFT_DISCARD_MESSAGE)) return;
    const generation = data.restoreGeneration;
    if (!generation || activeGeneration.current !== generation) {
      setCreateError('작업 공간이 변경되었습니다. 문서 목록을 다시 확인해 주세요.');
      return;
    }
    if (!confirmCommentEditExit()) return;
    let request = createAttempt;
    if (!request) {
      const parent = data.documents.find(page => page.id === newParent);
      const destination = parent ? parent.projectId : newProject || null;
      const source = teamTemplate ? { templateId: teamTemplate.id, expectedTemplateVersion: teamTemplate.version } : {
        content: importingMarkdown && markdownPreview ? markdownPreview.content : templateContent(newTemplate),
        status: 'draft' as const, icon: DOCUMENT_TEMPLATES.find(item => item.id === newTemplate)?.icon || '📄',
      };
      request = { actorId, template: newTemplate,
        input: { ...source, requestId: newRequestId(), expectedRestoreGeneration: generation,
          title: newTitle.trim(), projectId: destination, parentId: newParent || null },
        ...(teamTemplate && { teamTemplate }), ...(markdownPreview && importingMarkdown && { markdown: {
          suggestedTitle: markdownPreview.suggestedTitle, warnings: markdownPreview.warnings,
        } }),
      };
    }
    const sameContext = () => request.actorId === activeActorRef.current && request.input.expectedRestoreGeneration === activeGeneration.current;
    creatingRequest.current = true;
    setCreating(true);
    setCreateError('');
    recordCreateAttempt(request);
    let documentId = request.documentId;
    try {
      if (!documentId) {
        const result = await api<DocPage>('/documents', { method: 'POST', headers: { 'X-Actor-Id': request.actorId },
          body: JSON.stringify(request.input), signal: AbortSignal.timeout(12_000) });
        if (typeof result?.id !== 'string' || !result.id || result.projectId !== request.input.projectId || result.authorId !== request.actorId) {
          throw new Error('문서 저장 결과를 확인할 수 없습니다.');
        }
        documentId = result.id;
        if (!sameContext()) { writeDocumentCreationAttempt({ ...request, documentId }, true); return; }
        recordCreateAttempt({ ...request, documentId });
      }
      rememberDraft(draftRef.current);
      rememberComment();
      await refresh();
      if (!sameContext()) return;
      if (!onSelectDocument(documentId, { documentId: selectedDocumentId, expectedRestoreGeneration: generation, beforeOpen: discardCommentEdit })) {
        setCreateError('문서를 저장했습니다. 목록을 다시 불러와 저장한 문서를 열어 주세요.');
        return;
      }
      recordCreateAttempt(null);
      closeCreateDocument();
      notify('새 문서를 만들었습니다.', 'success');
    } catch (cause) {
      if (!sameContext()) return;
      if (documentId) setCreateError('문서를 저장했습니다. 목록을 다시 불러와 저장한 문서를 열어 주세요.');
      else if (!isDefiniteTemplateFailure(cause)) setCreateError('저장 결과를 확인할 수 없습니다. 같은 요청으로 다시 확인해 주세요.');
      else {
        const reason = templateErrorReason(cause);
        recordCreateAttempt(null);
        setCreateError(cause.message);
        if (teamTemplate && (reason === 'template_version_conflict' || reason === 'template_archived' || reason === 'template_not_found')) {
          setTeamTemplateConflict(true);
          reloadTeamTemplates();
        } else if (reason === 'result_unavailable' || reason === 'request_conflict' || reason === 'workspace_changed') {
          setCreationRejected(true);
        }
      }
    } finally {
      creatingRequest.current = false;
      setCreating(false);
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
    if (!context || context.documentId !== documentId || context.actorId !== activeActorRef.current || commentSendPending.current) return;
    const pending = commentResultPending ? commentAttempt : null;
    const payload = pending?.content ?? commentDraftPayload(commentDraftRef.current);
    if (!payload.body) return;
    const generation = data.restoreGeneration;
    const attempt = pending ?? (generation ? { ...context, requestId: newRequestId(), generation, content: payload } : null);
    const isCurrent = () => commentContextRef.current?.documentId === context.documentId &&
      commentContextRef.current.actorId === context.actorId && activeActorRef.current === context.actorId;
    const key = commentAttemptKey(context.actorId, context.documentId);
    function finishAttempt() {
      if (!attempt) return;
      if (isCurrent()) setCommentAttempt(current => current?.requestId === attempt.requestId ? null : current);
      try {
        const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as CommentAttempt | null;
        if (saved?.requestId === attempt.requestId) sessionStorage.removeItem(key);
      } catch { setStorageProblem(true); }
    }
    commentSendPending.current = true;
    setCommentBusy(true); setCommentSubmitError('');
    if (attempt) {
      setCommentAttempt(attempt);
      try { sessionStorage.setItem(key, JSON.stringify(attempt)); } catch { setStorageProblem(true); }
    }
    try {
      const result = await api<Comment>('/comments', { method: 'POST', headers: { 'X-Actor-Id': context.actorId },
        body: JSON.stringify({ resourceType: 'document', resourceId: context.documentId, ...payload,
          ...(attempt ? { requestId: attempt.requestId, expectedRestoreGeneration: attempt.generation } : {}) }) });
      if (!result?.id || result.resourceType !== 'document' || result.resourceId !== context.documentId ||
          result.authorId !== context.actorId || result.documentSource || result.parentCommentId) throw new Error('저장한 댓글 응답을 확인하지 못했습니다.');
      finishAttempt();
      if (attempt && activeGeneration.current !== attempt.generation) return;
      if (isCurrent()) {
        setComments(items => items.some(item => item.id === result.id) ? items : [...items, result]);
        setCommentFilter('all');
        setCommentQuery(query => threadMatchesCommentSearch(result, [], commentSearchTerms(query), commentAuthors) ? query : '');
        if (sameCommentDraft(commentDraftPayload(commentDraftRef.current), payload)) updateCommentDraft(emptyCommentDraft());
      } else {
        try {
          const key = commentCacheKey(context.actorId, context.documentId);
          const cached = decodeCommentDraft(localStorage.getItem(key));
          if (sameCommentDraft(commentDraftPayload(cached), payload)) localStorage.removeItem(key);
        } catch { setStorageProblem(true); }
      }
      window.dispatchEvent(new Event(COMMENT_LIST_CHANGED));
      await refresh().catch(() => { if (isCurrent()) setCommentSubmitError('댓글을 등록했습니다. 문서 목록을 다시 불러와 주세요.'); });
    } catch (error) {
      const knownFailure = error instanceof ApiError && [400, 404, 409, 422].includes(error.status);
      if (knownFailure) finishAttempt();
      if (isCurrent()) {
        const detail = error instanceof Error ? error.message : '댓글을 등록하지 못했습니다.';
        setCommentSubmitError(knownFailure || !attempt ? detail : '댓글 등록 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.');
      }
    } finally { commentSendPending.current = false; setCommentBusy(false); }
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

  function closeDocumentReply() {
    reply.close();
    if (retainedReplyParent) commentSearchInput.current?.focus({ preventScroll: true });
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

  function restoreRevision(revision: DocRevision, reviewedVersion: number) {
    const captured = draftRef.current;
    const generation = data.restoreGeneration;
    if (!captured || captured.id !== selectedDocumentId || revision.documentId !== captured.id || !generation ||
        savingRef.current || confirmingRestore || confirmingSave || actorRef.current !== activeActorRef.current ||
        activeGeneration.current !== generation) return;
    if (captured.expectedVersion !== reviewedVersion || (latestPage && latestPage.version > reviewedVersion)) {
      notify('현재 저장본이 변경되었습니다. 이력 목록에서 복구할 버전을 다시 확인해 주세요.', 'error');
      return;
    }
    if (listDrafts.current.size) { notify('문서 목록 설정을 적용하거나 취소한 후 복구해주세요.', 'error'); return; }
    if (captured.dirty) { notify('현재 편집을 먼저 저장하거나 새 문서로 보관해주세요.', 'error'); return; }
    if (liveStateRef.current?.pending || (sessionRef.current?.enabled && liveStateRef.current?.phase !== 'connected')) { notify('공동 편집을 서버에 동기화한 후 복구해주세요.', 'error'); return; }
    if (!window.confirm(`${documentRevisionLabel(revision)}의 내용으로 복구할까요? 현재 내용은 이력에 남습니다.`)) return;
    void sendRevisionRestore({ actorId: actorRef.current, documentId: captured.id, requestId: newRequestId(),
      expectedRestoreGeneration: generation, expectedVersion: reviewedVersion, revisionId: revision.id });
  }

  async function sendRevisionRestore(attempt: DocumentRestoreAttempt) {
    const { actorId: owner, documentId: id, ...input } = attempt;
    const checkingOutcome = confirmingRestore?.requestId === attempt.requestId;
    const sameContext = () => draftRef.current?.id === id && actorRef.current === owner &&
      activeActorRef.current === owner && activeGeneration.current === input.expectedRestoreGeneration;
    if (savingRef.current || !sameContext()) return;
    if (listDrafts.current.size || liveStateRef.current?.pending) {
      notify('문서 목록 설정과 공동 편집의 저장을 마친 뒤 복구 결과를 확인해 주세요.', 'error');
      return;
    }
    const collaborative = sessionRef.current?.enabled === true;
    clipboardImageGeneration.current++;
    savingRef.current = true; setSaving(true); setRestoring(true);
    rememberRestoreAttempt(attempt, true);
    editor?.setEditable(false, false);
    try {
      const restored = await api<DocPage>(`/documents/${encodeURIComponent(id)}/restore`, {
        method: 'POST', headers: { 'X-Actor-Id': owner }, body: JSON.stringify(input), signal: AbortSignal.timeout(12_000),
      });
      if (restored?.id !== id || restored.version !== input.expectedVersion + 1 || restored.content?.type !== 'doc') {
        throw new Error('문서 버전 복구 응답을 확인하지 못했습니다.');
      }
      rememberRestoreAttempt(attempt, false);
      if (sameContext()) {
        if (!collaborative) {
          const before = draftRef.current;
          reconcileDraft({ document: restored, live: false });
          if (before && draftRef.current?.expectedVersion === restored.version && !draftRef.current.bodyDirty &&
              before.expectedVersion < restored.version && sameBody(before.content, restored.content)) loadManualBody(manualEditor, restored.content);
        }
        setReferenceSelection(null); setIssueBlockSelection(null);
      }
      try {
        await refresh();
        if (sameContext()) notify(checkingOutcome ? `버전 ${restored.version}에 복구한 결과를 확인했습니다.` : '이전 내용을 새 버전으로 복구했습니다.', 'success');
      } catch {
        if (sameContext()) notify('문서 버전을 복구했습니다. 문서 목록을 다시 열어 최신 내용을 확인해 주세요.', 'error');
      }
    } catch (error) {
      if (isDefiniteTemplateFailure(error)) {
        rememberRestoreAttempt(attempt, false);
        if (sameContext()) notify(error.message, 'error');
        if (error.status === 409) await refresh().catch(() => {});
      }
    } finally { savingRef.current = false; setSaving(false); setRestoring(false); }
  }

  async function saveCopy() {
    const captured = draftRef.current;
    if (!captured || captured.id !== selectedDocumentId || savingRef.current || !data.restoreGeneration ||
        actorRef.current !== activeActorRef.current || !confirmCommentEditExit()) return;
    const capturedActor = actorRef.current;
    let request = recoveringEditCopy;
    if (!request) {
      const source = pagesById.get(captured.id);
      if (!captured.dirty || !source) return;
      request = { actorId: capturedActor, sourceId: captured.id, editSequence: captured.editSequence,
        sourceMetadata: documentMetadata(captured),
        input: { requestId: newRequestId(), expectedRestoreGeneration: data.restoreGeneration,
          title: `${documentTitleForSave(captured.title)} (편집 사본)`, projectId: source.projectId, parentId: source.parentId,
          content: captured.content, status: 'draft', labels: captured.labels } };
    }
    const attempt = request;
    const { expectedRestoreGeneration } = attempt.input;
    const sameContext = () => draftRef.current?.id === attempt.sourceId && actorRef.current === attempt.actorId &&
      activeActorRef.current === attempt.actorId && activeGeneration.current === expectedRestoreGeneration;
    savingRef.current = true; setSaving(true);
    rememberEditCopy(request, true);
    let copyId = request.documentId;
    try {
      if (!copyId) {
        const result = await api<DocPage>('/documents', { method: 'POST', headers: { 'X-Actor-Id': attempt.actorId }, body: JSON.stringify(attempt.input) });
        if (typeof result?.id !== 'string' || !result.id || result.id === attempt.sourceId || result.projectId !== attempt.input.projectId || result.authorId !== attempt.actorId) {
          throw new Error('편집 사본의 저장 결과를 확인하지 못했습니다.');
        }
        copyId = result.id;
        rememberEditCopy({ ...attempt, documentId: copyId }, true);
      }
      await refresh();
      if (!sameContext()) return;
      const current = draftRef.current;
      if (current && current.editSequence === attempt.editSequence && sameMetadata(current, attempt.sourceMetadata) && sameBody(current.content, attempt.input.content)) {
        const opened = onSelectDocument(copyId, { documentId: attempt.sourceId, expectedRestoreGeneration, beforeOpen: () => {
          const clean = { ...current, dirty: false, bodyDirty: false };
          draftRef.current = clean;
          setDraft(clean);
          rememberDraft(clean, attempt.actorId);
          discardCommentEdit();
        } });
        if (!opened) {
          notify('저장한 사본을 목록에서 찾지 못했습니다. 현재 편집은 보관했습니다.', 'error');
          return;
        }
      }
      rememberEditCopy(attempt, false);
      notify('편집 내용을 새 문서로 보관했습니다.', 'success');
    } catch (error) {
      if (copyId) {
        notify('편집 사본을 저장했습니다. 목록을 다시 불러와 확인해 주세요.', 'error');
      } else if (isDefiniteTemplateFailure(error)) {
        rememberEditCopy(attempt, false);
        notify(error.message, 'error');
        if (templateErrorReason(error) === 'workspace_changed') await refresh().catch(() => {});
      } else {
        notify('사본의 저장 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.', 'error');
      }
    }
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
      rememberSaveAttempt(capturedActor, captured.id, null);
      rememberComment(emptyCommentDraft(), { actorId: capturedActor, documentId: captured.id });
      clearReplyDrafts(capturedActor, captured.id);
      if (reselectedCommentDraft.current?.actorId === capturedActor && reselectedCommentDraft.current.documentId === captured.id) reselectedCommentDraft.current = null;
      try { localStorage.removeItem(selectionCommentCacheKey(capturedActor, captured.id)); } catch { setStorageProblem(true); }
      const sameContext = draftRef.current?.id === captured.id && actorRef.current === capturedActor && activeActorRef.current === capturedActor;
      if (sameContext) {
        showSaveRecovery(null);
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
    if (!sessionRef.current?.enabled || manualRecoveryRef.current) loadManualBody(manualEditor, next.content);
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
      await post<DocRevision>(`/documents/${current.id}/checkpoint`, { summary: '공동 편집 버전 기록' });
      setHistoryReload(value => value + 1); setSideTab('history'); setSidebarOpen(true);
      notify('서버에 저장된 본문을 버전으로 기록했습니다.', 'success');
    } catch (cause) { notify(cause instanceof Error ? cause.message : '버전을 기록하지 못했습니다.', 'error'); }
    finally { savingRef.current = false; setSaving(false); }
  }

  const openRecoveryCopy = useCallback(async (id: string, finishRecovery: () => void) => {
    const sourceId = draftRef.current?.id;
    if (!sourceId) return false;
    const actor = activeActorRef.current;
    await refresh();
    if (draftRef.current?.id !== sourceId || activeActorRef.current !== actor || !confirmCommentEditExit()) return false;
    return onSelectDocument(id, { documentId: sourceId, beforeOpen: () => {
      rememberDraft(draftRef.current);
      rememberComment();
      discardCommentEdit();
      finishRecovery();
    } });
  }, [refresh, onSelectDocument, confirmCommentEditExit, discardCommentEdit, rememberDraft, rememberComment]);

  useLayoutEffect(() => {
    if (!editor || insertKind !== 'link') return;
    const mapLinkTarget = ({ transaction, appendedTransactions }: EditorEvents['transaction']) => {
      const target = documentLinkTarget.current;
      if (target?.editor !== editor) return;
      for (const change of [transaction, ...appendedTransactions]) {
        if (!change.docChanged) continue;
        try {
          // The collaboration extension resolves the same anchors in the new Yjs projection.
          const from = editor.utils.getUpdatedPosition(target.from, change);
          const to = target.from === target.to ? from : editor.utils.getUpdatedPosition(target.to, change);
          if (change.getMeta('preventUpdate') || from.mapResult?.deleted || to.mapResult?.deleted ||
              from.position.position < 1 || to.position.position < from.position.position) {
            documentLinkTarget.current = null;
            return;
          }
          target.from = from.position;
          target.to = to.position;
        } catch {
          documentLinkTarget.current = null;
          return;
        }
      }
    };
    editor.on('transaction', mapLinkTarget);
    return () => {
      editor.off('transaction', mapLinkTarget);
      if (documentLinkTarget.current?.editor === editor) documentLinkTarget.current = null;
    };
  }, [editor, insertKind]);

  function openDocumentLink() {
    if (bodyReadOnly || !editor?.isEditable || editor.isDestroyed || !selectedPageId || draftRef.current?.id !== selectedPageId) return;
    const { selection, schema, doc } = editor.state;
    const existingRange = getMarkRange(selection.$from, schema.marks.link);
    const range = existingRange && existingRange.from <= selection.from && existingRange.to >= selection.to ? existingRange : selection;
    let from = editor.utils.createMappablePosition(range.from);
    const sync = ySyncPluginKey.getState(editor.state);
    if (range.from < range.to && sync && from instanceof CollaborationMappablePosition && from.yRelativePosition) {
      const absolute = createAbsolutePositionFromRelativePosition(from.yRelativePosition, sync.doc);
      // A selection's start follows its first character, while the end follows its last.
      if (absolute) from = new CollaborationMappablePosition(range.from, createRelativePositionFromTypeIndex(absolute.type, absolute.index, 0));
    }
    const to = range.from === range.to ? from : editor.utils.createMappablePosition(range.to);
    documentLinkTarget.current = { editor, documentId: selectedPageId, actorId, from, to,
      selectedText: doc.textBetween(range.from, range.to, '\n', '\ufffc') };
    setInsertKind('link');
    setInsertUrl(String(editor.getAttributes('link').href || ''));
  }

  function insertUrlBlock(event: React.FormEvent) {
    event.preventDefault();
    if (bodyReadOnly || !editor?.isEditable || editor.isDestroyed || !insertKind) return;
    let url: URL;
    try { url = new URL(insertUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
    catch { notify('http 또는 https 주소를 입력해주세요.', 'error'); return; }
    if (insertKind === 'image') editor.chain().focus().setImage({ src: url.href, alt: '문서 이미지' }).run();
    else {
      const target = documentLinkTarget.current;
      const { doc, schema } = editor.state;
      const from = target?.from.position ?? 0, to = target?.to.position ?? 0;
      if (!target || target.editor !== editor || target.actorId !== actorId ||
          target.documentId !== selectedPageId || target.documentId !== draftRef.current?.id ||
          from < 1 || to < from || to > doc.content.size || doc.textBetween(from, to, '\n', '\ufffc') !== target.selectedText) {
        notify('링크를 적용할 본문 위치가 바뀌었습니다. 본문에서 다시 선택해 주세요.', 'error');
        return;
      }
      const link = schema.marks.link;
      const position = doc.resolve(from);
      if (from === to && (!position.parent.isTextblock || !position.parent.type.allowsMarkType(link))) {
        notify('본문에서 링크를 삽입할 위치를 먼저 선택해 주세요.', 'error');
        return;
      }
      const edit = editor.chain().focus().setTextSelection({ from, to });
      const applied = from !== to ? edit.setLink({ href: url.href }).run()
        : edit.insertContentAt(from, schema.text(url.href, link.create({ href: url.href }).addToSet(position.marks())).toJSON())
          .command(({ tr }) => { tr.removeStoredMark(link); return true; }).run();
      if (!applied) { notify('이 위치에 링크를 적용할 수 없습니다.', 'error'); return; }
    }
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
  const displayedContent = reading ? latestPage?.content : draft?.content;
  const draftId = draft?.id;
  const documentsById = useMemo(() => new Map(data.documents.map(page => [page.id, page])), [data.documents]);
  const outgoingDocuments = useMemo(() => showLinkPanel && displayedContent
    ? documentPanelReferences(displayedContent, workspaceLocation) : [], [showLinkPanel, displayedContent, workspaceLocation]);
  const backlinks = useMemo(() => showLinkPanel && draftId
    ? documentPanelBacklinks(data.documents, draftId, workspaceLocation) : [], [showLinkPanel, draftId, data.documents, workspaceLocation]);
  const savedContent = (reading ? latestPage : selectedPage)?.content;
  const savedIssueReferences = useMemo(() => savedContent
    ? contentReferences(savedContent).filter(reference => reference.type === 'issue') : [], [savedContent]);
  const issuesById = useMemo(() => new Map(data.issues.map(issue => [issue.id, issue])), [data.issues]);
  const savedIssueReferenceIds = new Set(savedIssueReferences.map(reference => reference.id));
  const draftIssueReferences = !reading && draft?.id === selectedPage?.id
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

  const dragAvailable = !filtersActive && !checklistReselecting && !moveOpen && !orderOpen && !copyOpen &&
    !saving && !restoring && !publicationOpen && !issueDrawerOpen;
  const helpId = useId();
  const treeDrag = useDocumentTreeDrag(JSON.stringify([actorId, projectId, data.restoreGeneration]), dragAvailable, pagesById, (id, target) => {
    if (target.kind === 'move') {
      const page = pagesById.get(id);
      if (page) openMove(page, target.destination);
    } else {
      const { placement } = target;
      const order = data.documentOrders?.find(order => order.projectId === placement.projectId && order.parentId === placement.parentId);
      const next = order && reorderDocumentPlacement(order, id, placement);
      if (next?.every((id, index) => id === order?.documentIds[index])) return;
      setExportOpen(false);
      setOrderRequest({ documentId: id, placement });
    }
  });

  const tree = (pages: DocPage[], parentId: string | null = null, level = 0, visited = new Set<string>()): React.ReactNode => pages
    .filter(page => filtersActive ? level === 0 : (page.parentId === parentId || (parentId === null && !pages.some(other => other.id === page.parentId))))
    .map(page => {
      if (visited.has(page.id)) return null;
      const nextVisited = new Set(visited); nextVisited.add(page.id);
      const children = pages.some(other => other.parentId === page.id);
      const canToggle = children && !filtersActive;
      const branchCollapsed = collapsed.has(page.id);
      const selected = selectedDocumentId === page.id;
      return <div key={page.id}>
        <div className={`docs-tree-row ${selected ? 'is-selected' : ''}`} style={{ paddingLeft: 10 + level * 15 }}
          data-dragging={treeDrag.draggedId === page.id ? '' : undefined} {...treeDrag.row(page)}>
          <button type="button" className="docs-tree-toggle" aria-label={`${page.title} ${branchCollapsed ? '펼치기' : '접기'}`}
            aria-expanded={canToggle ? !branchCollapsed : undefined} disabled={!canToggle} onClick={() => toggleBranch(page.id)}>
            {canToggle ? branchCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} /> : <span />}
          </button>
          <button type="button" className="docs-tree-link" aria-current={selected ? 'page' : undefined} onClick={() => selectDocument(page.id)}><span className="docs-page-icon">{page.icon || '📄'}</span><span>{page.title || '제목 없는 문서'}</span>{page.status === 'draft' && <span className="docs-draft-dot" title="초안" />}</button>
          <button type="button" className="docs-tree-add" title="하위 문서 만들기" aria-label={`${page.title} 하위 문서 만들기`} onClick={() => openNew(page.id)}><Plus size={13} /></button>
          {dragAvailable && <span className="docs-tree-grip" draggable aria-hidden="true" title="끌어서 문서 배치"
            onDragStart={event => treeDrag.start(event, page, data.documentOrders?.find(order =>
              order.projectId === page.projectId && order.parentId === page.parentId)?.version)}
            onDragEnd={treeDrag.clear}><GripVertical size={14} /></span>}
        </div>
        {!filtersActive && !branchCollapsed && tree(pages, page.id, level + 1, nextVisited)}
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
    const page = { id, title, projectId, version };
    const evidence = { id: comment.id, source: { ...source } };
    if (kind === 'link') openDecisionLinkAction({ ...page, comment: evidence }, opener);
    else {
      documentActionOpener.current = opener;
      setDocumentAction({ kind, source: { ...page, comment: { ...evidence, body: comment.body } } });
    }
  }
  function openDecisionLink(page: DocPage, opener: HTMLButtonElement, sourceSelection: DocumentSourceSelection) {
    openDecisionLinkAction({ id: page.id, title: page.title, projectId: page.projectId, version: page.version, sourceSelection }, opener);
  }
  function openDecisionLinkAction(source: DecisionLinkSource, opener: HTMLButtonElement) {
    const generation = data.restoreGeneration;
    if (!generation || source.id !== selectedPageId) return;
    documentActionOpener.current = opener;
    setDocumentAction({ kind: 'link', source: pendingDecisionLink?.source ?? source, actorId, generation, initialAttempt: pendingDecisionLink ?? undefined });
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

  function openInlineDocumentLink(href: string, keepReading = false) {
    let destination: URL;
    try { destination = new URL(href, location.href); } catch { return false; }
    if (destination.origin !== location.origin || destination.pathname !== location.pathname ||
        destination.username || destination.password) return false;
    const [path, query] = destination.hash.split('?');
    const parameters = new URLSearchParams(query);
    const sectionLink = /^#\/[^/?#]+\/documents\/[^/?#]+$/u.test(path) && isDocumentSectionId(parameters.get('section'));
    const completionLink = /^#\/[^/?#]+\/planning$/u.test(path) && readCycleCompletionRecordId(parameters);
    const documentLink = parseDocumentHash(destination.hash, { allowLabel: true });
    if (!sectionLink && !completionLink && !documentLink) return false;
    if (keepReading && (documentLink || sectionLink) && !parameters.has('publication')) {
      parameters.set('mode', 'read');
      destination.hash = `${path}?${parameters}`;
    }
    window.location.hash = destination.hash;
    return true;
  }

  const readingPage = reading ? latestPage : null;
  useLayoutEffect(() => {
    if (!readingPage || readingPage.id !== selectedDocumentId || draft?.id !== readingPage.id ||
        pendingHomeFocus.current !== readingPage.id || !readingTitle.current) return;
    pendingHomeFocus.current = null;
    if (!sectionId && !commentFocus && !publicationOpen && !issueDrawerOpen) readingTitle.current.focus();
  }, [draft?.id, readingPage, selectedDocumentId, sectionId, commentFocus, publicationOpen, issueDrawerOpen]);
  const readingFindOpen = Boolean(readingPage && readingFindScope === documentScope);
  function openReadingFind() {
    if (readingFindOpen) {
      readingFindInput.current?.focus({ preventScroll: true });
      readingFindInput.current?.select();
    } else setReadingFindScope(documentScope);
  }
  function closeReadingFind() {
    setReadingFindScope(null);
    readingFindOpener.current?.focus({ preventScroll: true });
  }
  function handleReadingFindShortcut(event: ReactKeyboardEvent<HTMLElement>) {
    if (!readingPage || issueDrawerOpen || event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey ||
        event.nativeEvent.isComposing || event.key.toLowerCase() !== 'f' || !(event.target instanceof Node) ||
        !event.currentTarget.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    openReadingFind();
  }
  const breadcrumbTitle = documentTitleForSave(readingPage?.title ?? draft?.title ?? '');
  const readingEditPending = readingPage && ((draft?.id === readingPage.id && draft.dirty) ||
    (liveState?.document.id === readingPage.id && liveState.pending));
  const migratedIssueNotice = migratedIssueLink && <div className="docs-notice docs-migrated-issue-link" role="status">
    {migratedIssueLink.status === 'pending' ? '이관된 Jira 주소를 확인하는 중…' : migratedIssueLink.status === 'failed'
      ? '이관된 Jira 주소를 조회하지 못했습니다.' : migratedIssueLink.expectsComment
        ? '이관된 Jira 댓글을 확인할 수 없습니다.' : '이관된 Jira 업무를 확인할 수 없습니다.'}
    {migratedIssueLink.status !== 'pending' && <> <a href={migratedIssueLink.href} target="_blank" rel="noopener noreferrer">원본 열기</a></>}
  </div>;
  async function copyReadingLink(page: DocPage) {
    const href = new URL(documentReadingHash(page.id, page.projectId ?? projectId, sectionId), window.location.href).href;
    try {
      await navigator.clipboard.writeText(href);
      notify('읽기 링크를 복사했습니다.', 'success');
    } catch {
      notify('주소창에서 읽기 링크를 복사해 주세요.', 'error');
    }
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
    {!newOpen && createAttempt && <section className="docs-notice" aria-label="새 문서 생성 결과">
      <p><strong>{createAttempt.input.title}</strong> · {createAttempt.documentId ? '저장 확인됨 · 문서 열기 필요' : '저장 결과 확인 필요'}</p>
      <button className="btn" type="button" onClick={() => reopenCreateDocument(createAttempt)}>생성 결과 열기</button>
    </section>}
    <div className={`docs-layout ${sidebarOpen && !checklistReselecting ? 'has-panel' : ''}`}
      inert={publicationOpen || newOpen || archiveImport || Boolean(issueBlockDialog || templateManager || offlineExport || (documentAction && !checklistReselecting))}
      onKeyDownCapture={event => {
        if (!checklistReselecting || event.key !== 'Escape' || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        cancelChecklistReselect();
      }}>
      <aside className="docs-tree" aria-label="문서 목록" aria-describedby={helpId} inert={checklistReselecting}>
        <p id={helpId} className="sr-only">순서나 위치를 바꾸려면 문서의 순서 편집 또는 이동 버튼을 사용하세요. 문서 목록의 손잡이를 끌어 배치할 수도 있습니다.</p>
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
          <div className="docs-tree-group" {...(currentProject && treeDrag.space(currentProject.id))}><span>{currentProject?.name || '프로젝트 문서'}</span>
            <div className="docs-tree-group-actions">
              {projectHome && <button className="docs-tree-group-add" type="button" aria-label="프로젝트 문서 홈 열기"
                title={projectHome.title} onClick={() => openSpaceHome(projectHome)}><House size={14} aria-hidden="true" /></button>}
              {currentProject && <NotificationSubscriptionButton actorId={actorId} targetType="space" targetId={documentNotificationSpaceId(currentProject.id)} notify={notify} />}
              <button type="button" className="docs-tree-group-add" aria-label="프로젝트 문서 추가" onClick={() => openNew()}><Plus size={14} /></button>
            </div>
          </div>
          {tree(treePages.filter(page => page.projectId !== null))}
          {!filtersActive && !visible.some(page => page.projectId !== null) && <p className="docs-tree-empty">첫 문서를 작성해보세요.</p>}
          <div className="docs-tree-group docs-tree-common" {...treeDrag.space(null)}><span>팀 공통 문서</span>
            <div className="docs-tree-group-actions">
              {teamHome && <button className="docs-tree-group-add" type="button" aria-label="팀 공통 문서 홈 열기"
                title={teamHome.title} onClick={() => openSpaceHome(teamHome)}><House size={14} aria-hidden="true" /></button>}
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
        <main className="docs-document" onKeyDown={handleReadingFindShortcut}>
          <div className="docs-document-topbar" inert={checklistReselecting}>
            <nav className="docs-breadcrumb" aria-label="문서 위치" tabIndex={-1}>
              <FileText size={14} aria-hidden="true" /><span title={spaceTitle}>{spaceTitle}</span>
              {ancestors.map(ancestor => <span className="docs-breadcrumb-step" key={ancestor.id}>
                <ChevronRight size={12} aria-hidden="true" />
                <a href={`#/${encodeURIComponent(ancestor.projectId ?? projectId)}/documents/${encodeURIComponent(ancestor.id)}${crumbQuery}`}
                  title={documentTitleForSave(ancestor.title)} onClick={event => {
                    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
                    event.preventDefault();
                    if (selectDocument(ancestor.id)) event.currentTarget.closest('nav')?.focus({ preventScroll: true });
                  }}>{documentTitleForSave(ancestor.title)}</a>
              </span>)}
              <span className="docs-breadcrumb-step"><ChevronRight size={12} aria-hidden="true" />
                <span aria-current="page" title={breadcrumbTitle}>{breadcrumbTitle}</span>
              </span>
            </nav>
            <div className="docs-top-actions">{!reading && <span className={`docs-save-state ${draft.dirty ? 'is-dirty' : ''}`} aria-live="polite">{saving ? <><Loader2 size={12} className="docs-spin" /> 저장 중</> : confirmingSave ? <><span /> 저장 결과 미확인</> : draft.dirty ? <><span /> {liveMode ? '속성 변경' : '저장 필요'}</> : liveMode ? liveState?.phase === 'connected' && !liveState.pending ? <><CheckCheck size={13} /> 동기화됨</> : '동기화 대기' : <><CheckCheck size={13} /> 저장됨</>}</span>}
              <FavoriteAction type="document" id={selectedPage.id} />
              <NotificationSubscriptionButton actorId={actorId} targetType="document" targetId={selectedPage.id} notify={notify} />
              <button type="button" className="btn btn-ghost docs-reading-toggle" disabled={saving || restoring}
                onClick={() => { setExportOpen(false); onChangeReading(!reading); }}>
                {reading ? <Pencil size={14} aria-hidden="true" /> : <BookOpen size={14} aria-hidden="true" />}
                {reading ? '편집으로 돌아가기' : '저장본 읽기'}
              </button>
              {reading && <button type="button" className="btn btn-ghost docs-icon-button" aria-label="저장본 새로고침" title="저장본 새로고침"
                disabled={referencesRefreshing} onClick={() => void refreshReferences()}>
                <RefreshCw size={15} aria-hidden="true" className={referencesRefreshing ? 'docs-spin' : undefined} />
              </button>}
              {readingPage && <button ref={readingFindOpener} type="button" className="btn btn-ghost docs-icon-button"
                aria-label="저장본 본문에서 찾기" title="저장본 본문에서 찾기" aria-expanded={readingFindOpen} aria-keyshortcuts="Control+F Meta+F"
                onClick={() => readingFindOpen ? closeReadingFind() : openReadingFind()}><Search size={15} aria-hidden="true" /></button>}
              {readingPage && <button type="button" className="btn btn-ghost docs-icon-button" aria-label="읽기 링크 복사" title="읽기 링크 복사"
                onClick={() => void copyReadingLink(readingPage)}><Link2 size={15} aria-hidden="true" /></button>}
              {!reading && <>
              <DocumentSpaceHomeAction key={selectedPage.id} document={selectedPage} home={selectedPage.projectId === null ? configuredTeamHome : configuredProjectHome}
                restoreGeneration={data.restoreGeneration} disabled={saving || restoring} refresh={refresh} notify={notify} />
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
              <button type="button" className="btn btn-ghost docs-icon-button" title="문서 이동" aria-label="문서 이동"
                onClick={() => openMove(selectedPage)}><FolderInput size={16} aria-hidden="true" /></button>
              <button type="button" className="btn btn-ghost docs-icon-button" title="문서 복제" aria-label="문서 복제"
                disabled={saving || restoring} onClick={() => { setExportOpen(false); setCopyDocumentId(selectedPage.id); }}>
                <Copy size={16} aria-hidden="true" />
              </button>
              <button type="button" className="btn btn-ghost docs-icon-button" title="문서 순서 편집" aria-label="문서 순서 편집"
                disabled={saving || restoring} onClick={() => { setExportOpen(false); setOrderRequest({ documentId: selectedPage.id }); }}>
                <ListOrdered size={16} aria-hidden="true" />
              </button>
              </>}
              <button className="btn btn-ghost docs-icon-button" title={sidebarOpen ? '정보 패널 닫기' : '정보 패널 열기'} aria-label={sidebarOpen ? '정보 패널 닫기' : '정보 패널 열기'} onClick={() => setSidebarOpen(value => !value)}>{sidebarOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button>
              {!reading && <button className="btn btn-primary docs-save-button" disabled={saving || (!confirmingSave && (!draft.dirty || manualRecovery || Boolean(metadataReview) || (liveMode && (liveState?.pending || liveState?.phase !== 'connected'))))} onClick={() => void saveDraft()}><Save size={14} /> {confirmingSave ? '저장 결과 다시 확인' : liveMode ? '속성 저장' : '저장'}</button>}
            </div>
          </div>

          {pendingDecisionLink && !documentAction && !publicationOpen && <div className="docs-notice" role="status">
            {pendingDecisionLink.confirmedIssueKey ? '결정 근거를 연결했습니다. 연결 목록을 다시 불러올 수 있습니다.' : '결정 근거 연결 응답을 확인하지 못했습니다.'}
            <button type="button" className="btn btn-ghost" disabled={saving || issueDrawerOpen}
              onClick={event => openDecisionLinkAction(pendingDecisionLink.source, event.currentTarget)}>결정 근거 연결 결과 다시 확인</button>
          </div>}
          {!reading && <>
          {confirmingSave && !saving && <div className="docs-notice" role="status">문서 저장 응답을 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.</div>}
          {(!sidebarOpen || sideTab !== 'history') && restoreRecovery}
          {recoveringEditCopy && !saving && <div className="docs-notice" role="status">
            {recoveringEditCopy.documentId ? '편집 사본을 저장했습니다. 문서 목록을 다시 불러와 주세요.' : '편집 사본의 저장 응답을 확인하지 못했습니다.'}
            <button type="button" className="btn btn-ghost" onClick={() => void saveCopy()}>
              {recoveringEditCopy.documentId ? '사본 목록 다시 불러오기' : '사본 저장 결과 다시 확인'}
            </button>
          </div>}
          {conflict && !manualRecovery && !confirmingSave && <div className="docs-notice docs-conflict" role="alert"><strong>{metadataReview ? '같은 문서 속성이 변경됐어요.' : '다른 변경사항이 있어요.'}</strong><span>{metadataReview ? '최신본을 열어 저장할 값을 선택해 주세요.' : '내 편집은 유지했습니다. 최신본을 확인한 후 정리해주세요.'}</span><div><button aria-expanded={showLatest} onClick={() => setShowLatest(value => !value)}>서버 최신본 보기</button>{!recoveringEditCopy && <button onClick={() => void saveCopy()} disabled={saving}>내 편집을 새 문서로 보관</button>}<button onClick={discardLocal} disabled={saving}>편집 버리고 최신본 열기</button></div></div>}
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
          {manualRecovery && !confirmingSave && <div className="docs-notice docs-manual-recovery" role="alert"><strong>보관한 수동 편집이 있습니다.</strong><p>이 문서는 공동 편집이 시작되어, 보관한 본문을 서버 문서에 자동으로 덮어쓰지 않았습니다.</p><div><button onClick={() => downloadDocument(`${draft.title}-수동편집-복구.json`, JSON.stringify({ title: draft.title, content: draft.content, plainText: draft.plainText, labels: draft.labels }, null, 2), 'application/json')}>편집 내려받기</button>{!recoveringEditCopy && <button onClick={() => void saveCopy()} disabled={saving}>내 편집을 새 문서로 보관</button>}<button onClick={discardLocal}>편집 버리고 최신본 열기</button></div></div>}
          </>}
          {readingPage && readingFindOpen && <DocumentReadFindPanel inputRef={readingFindInput} contentRef={readingBody}
            content={readingPage.content} onClose={closeReadingFind} />}
          {readingPage && <div className="docs-paper-scroll">
            <article className="docs-paper docs-reading-paper" aria-label="저장본 읽기" key={readingPage.id}
              onClickCapture={event => {
                if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
                    !(event.target instanceof Element)) return;
                const link = event.target.closest<HTMLAnchorElement>('a[href]');
                if (link && !link.closest('.docs-migrated-issue-link') && (openMigratedIssueLink(link) || openInlineDocumentLink(link.href, true))) event.preventDefault();
              }}>
              <div className="docs-document-meta"><span>저장본 · 버전 {readingPage.version}</span><span>마지막 수정 {relativeTime(readingPage.updatedAt)}</span></div>
              <h2 ref={readingTitle} tabIndex={-1} className="docs-title-input">{breadcrumbTitle}</h2>
              {Boolean(readingPage.labels?.length) && <ul className="docs-label-chips" aria-label="문서에 적용한 라벨">
                {readingPage.labels?.map(label => <li className="docs-label-chip" key={label}><span>{label}</span></li>)}
              </ul>}
              {readingEditPending && <p className="docs-reading-draft" role="status">편집 화면에 저장 대기 중인 변경이 있습니다.</p>}
              {migratedIssueNotice}
              <DocumentBlocksProvider data={data} actorId={actorId} documentId={readingPage.id} content={readingPage.content}
                openIssue={openIssue} openDocument={openDocument}>
                <ReadonlyDocumentContent content={readingPage.content} documentId={readingPage.id} nodeBudget={30_000} showOutline sectionId={sectionId} findContentRef={readingBody}
                  onNavigateSection={id => openDocument(readingPage.id, id ?? undefined)}
                  sectionLinkHref={id => documentReadingHash(readingPage.id, readingPage.projectId ?? projectId, id)} />
              </DocumentBlocksProvider>
            </article>
          </div>}

          <div className="docs-paper-scroll" hidden={reading} inert={reading}>
            <div className="docs-paper">
              <div className="docs-document-meta"><span className={`docs-status-pill ${draft.status === 'published' ? 'is-published' : ''}`}>{draft.status === 'published' ? '공유 표시' : '초안'}</span><span>마지막 수정 {relativeTime((latestPage ?? selectedPage).updatedAt)}</span></div>
              <input ref={titleInput} className="docs-title-input" disabled={restoring || checklistReselecting} value={draft.title} onChange={event => updateDraft({ title: event.target.value })} placeholder="제목 없는 문서" aria-label="문서 제목" />
              <div className="docs-author-row"><span className="docs-avatar" style={{ background: data.users.find(user => user.id === selectedPage.authorId)?.color || '#78849a' }}>{data.users.find(user => user.id === selectedPage.authorId)?.name.slice(0, 1) || '팀'}</span><span>{data.users.find(user => user.id === selectedPage.authorId)?.name || '팀원'}</span><span className="docs-meta-dot">·</span><span>{when(selectedPage.createdAt)}</span><span className="docs-meta-dot">·</span><span>버전 {draft.expectedVersion}</span></div>
              <DocumentLabels key={`${actorId}:${draft.id}`} labels={draft.labels} activeKey={documentLabel} disabled={restoring || checklistReselecting}
                onChange={labels => updateDraft({ labels })} onFilter={onChangeDocumentLabel} />

              <div className="docs-editor-sticky">
              <div className="docs-editor-toolbar" role="toolbar" aria-label={checklistReselecting ? '체크리스트 항목 다시 선택' : '문서 서식'}>
                {!checklistReselecting && <>
                <DocumentEditorHistory editor={editor}
                  disabled={bodyReadOnly || archivedLiveRecovery || publicationOpen || Boolean(issueDrawerOpen) || draft.id !== selectedPageId} />
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
                {button('링크', <Link2 size={15} />, openDocumentLink, editor?.isActive('link'))}
                {editor?.isActive('link') && button('링크 해제', <Unlink size={14} />, () => editor?.chain().focus().unsetLink().run())}
                <span className="docs-toolbar-separator" />
                {button('글머리 목록', <List size={16} />, () => editor?.chain().focus().toggleBulletList().run(), editor?.isActive('bulletList'))}
                {button('번호 목록', <ListOrdered size={16} />, () => editor?.chain().focus().toggleOrderedList().run(), editor?.isActive('orderedList'))}
                {button('체크리스트', <ListChecks size={16} />, () => editor?.chain().focus().toggleTaskList().run(), editor?.isActive('taskList'))}
                {button('인용', <Quote size={15} />, () => editor?.chain().focus().toggleBlockquote().run(), editor?.isActive('blockquote'))}
                {button('코드 블록', <Code2 size={16} />, () => editor?.chain().focus().toggleCodeBlock().run(), editor?.isActive('codeBlock'))}
                {button('표 삽입', <Table2 size={15} />, () => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
                <DocumentTablePaste key={`${actorId}:${draft.id}`} editor={editor} canEdit={clipboardWritable && !saving && !restoring}
                  onActiveChange={setTablePasteActive} />
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
                {editor && (manualSession || liveMode) && !bodyReadOnly && !archivedLiveRecovery && !publicationOpen && !checklistReselecting && !issueDrawerOpen && draft.id === selectedPageId &&
                  <DocumentBlockOrder editor={editor} collaborative={liveMode} />}
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
              {!reading && migratedIssueNotice}
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
                sectionId={reading || publicationOpen ? null : sectionId} savedContent={selectionDocument?.content}
                ready={!liveMode || Boolean(liveState?.ready)} canAssign={!bodyReadOnly && !saving && !conflict && !publicationOpen && !checklistReselecting} />}
              {clipboardImageUploads[documentScope] > 0 && <div className="docs-notice" role="status">이미지를 첨부하는 중입니다.</div>}
              <div ref={editorWrap} className="docs-editor-wrap" onPasteCapture={event => void pasteClipboardImages(event)} onKeyDownCapture={event => {
                if (!checklistReselecting && !event.defaultPrevented && !event.nativeEvent.isComposing && event.key === 'Enter' &&
                    !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.target instanceof HTMLAnchorElement &&
                    (openMigratedIssueLink(event.target) || openInlineDocumentLink(event.target.href))) {
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
                if (href && openInlineDocumentLink(href)) {
                  event.preventDefault();
                }
              }}>{liveMode && activeSession ? <CollaborativeEditor key={`${draft.id}:${actorId}`} session={activeSession} actorId={actorId} labels={draft.labels} locked={restoring} onEditor={receiveLiveEditor} onContent={receiveLiveContent} onDocument={receiveLiveDocument} onState={receiveLiveState} onSessionDisabled={receiveDisabledSession} onOpenCopy={openRecoveryCopy} notify={notify} /> : <EditorContent editor={manualEditor} />}
                {editor && !bodyReadOnly && !archivedLiveRecovery && !publicationOpen && !checklistReselecting && !issueDrawerOpen && draft.id === selectedPageId &&
                  <DocumentPageSuggestions key={documentScope} editor={editor} wrap={editorWrap} documentId={draft.id} documents={data.documents} projects={data.projects} />}
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
            {sideTab === 'links' && <AtlassianLinks targetType="document" targetId={draft.id} actorId={actorId} notify={notify} readOnly={reading} />}
            {sideTab === 'comments' && <>
              <div className="docs-panel-heading docs-comment-heading">
                <div><h3 tabIndex={-1} ref={commentsHeading}>팀과 이야기하기</h3><p>문서에 대한 질문과 의견을 남겨주세요.</p></div>
                <button className="btn btn-ghost" type="button" title="댓글 새로고침" aria-label="댓글 새로고침"
                  aria-busy={commentsRefreshing} aria-disabled={commentsRefreshing}
                  onClick={() => { if (!commentsRefreshing) loadCommentList.current?.('manual'); }}>
                  {commentsRefreshing ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
                </button>
              </div>
              <div className="docs-comment-filters" role="group" aria-label="문서 댓글 상태">
                {COMMENT_FILTERS.map(filter => <button key={filter} type="button" value={filter}
                  ref={filter === commentFilter ? activeCommentFilter : undefined} aria-pressed={filter === commentFilter}
                  onClick={() => setCommentFilter(filter)}>{COMMENT_FILTER_LABELS[filter]}</button>)}
              </div>
              <label className="docs-comment-search">
                <Search size={14} aria-hidden="true" />
                <input ref={commentSearchInput} className="field" type="search" aria-label="문서 댓글 검색"
                  value={commentQuery} onChange={event => setCommentQuery(event.currentTarget.value)}
                  placeholder="댓글·답글·발췌·작성자" maxLength={WORKSPACE_SEARCH_QUERY_LIMIT} />
              </label>
              {commentsLoading && <p className="docs-panel-muted">댓글을 불러오는 중…</p>}
              {commentError && <p className="docs-panel-error" role="alert">{commentError}</p>}
              {resolutionError && <p className="docs-panel-error" role="alert">{resolutionError}</p>}
              {linkedCommentMissing && <p className="docs-panel-muted" role="status">이동할 댓글을 찾을 수 없습니다.</p>}
              {!commentsLoading && !commentError && commentTerms.length > 0 && <p className="docs-panel-muted" role="status">
                {matchedComments.length ? `${matchedComments.length.toLocaleString('ko-KR')}개 댓글 대화` : '검색 조건에 맞는 댓글이 없습니다.'}
              </p>}
              {!commentsLoading && !commentError && !commentTerms.length && !visibleComments.length && (commentFilter === 'all'
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
                        onClick={event => replyEditor ? closeDocumentReply() : reply.open(comment, event.currentTarget)}>
                        <MessageSquare size={14} aria-hidden="true" />{resolved ? '답글 결과 확인' : '답글'}
                      </button>}
                    </div>
                  </div>}
                  {comment.documentSource && <>
                    <DocumentReplyList replies={threadReplies} users={data.users} actorId={actorId} notify={notify} refresh={refresh}
                      editing={commentEditing} disabled={reply.busy || saving} onArchived={archiveCommentFromList} onCopyCommentLink={onCopyCommentLink} />
                    {retainedReplyParent?.id === comment.id && <p className="docs-panel-muted">답글 작성 중</p>}
                    {replyEditor && <DocumentReplyComposer key={JSON.stringify([actorId, comment.id])} editor={replyEditor}
                      resolved={resolved} busy={reply.busy} users={data.users} onChange={reply.edit} onClose={closeDocumentReply}
                      onSubmit={() => void reply.submit(comment, showSavedReply)} />}
                  </>}
                </article>;
              })}
              {showDetachedCommentEdit && <CommentEditBody comment={activeCommentEdit} editing={commentEditing} users={data.users} />}
              <form className="docs-comment-form" onSubmit={submitComment}>
                {commentSubmitError && <p className="docs-panel-error" role="alert">{commentSubmitError}</p>}
                <CommentMentionInput className="field" draft={commentDraft} onChange={updateCommentDraft} users={data.users}
                  placeholder="의견을 남겨주세요…" aria-label="새 문서 댓글" rows={4} />
                <button type="submit" className="btn btn-primary" disabled={(!commentResultPending && !commentDraft.body.trim()) || commentBusy}>
                  {commentBusy ? <Loader2 size={13} className="docs-spin" /> : <Send size={13} />}
                  {commentBusy ? '댓글 등록 확인 중…' : commentResultPending ? '댓글 결과 다시 확인' : '댓글 남기기'}
                </button>
              </form>
            </>}
            {sideTab === 'links' && <>
              <DocumentLinkedWork key={selectedPage.id} data={data} document={selectedPage} openIssue={openIssue}
                onOpenIssueForReview={onOpenIssueForReview} onOpenIssueSchedule={onOpenIssueSchedule}
                refresh={refresh} notify={notify} issueDrawerOpen={issueDrawerOpen}>
                {!reading && <button className="btn docs-follow-up-button" type="button" disabled={saving || restoring || !data.projects.length || draft.id !== selectedPage.id} onClick={event => openFollowUp(selectedPage, event.currentTarget)}><Plus size={14} aria-hidden="true" /> 후속 업무 만들기</button>}
              </DocumentLinkedWork>
              <div hidden={reading}><ResourceLinkPicker key={`${actorId}:${selectedPage.id}`} kind="issue" items={candidateIssues} projects={data.projects}
                issueAliases={data.issueAliases} busy={linkBusy || draft.id !== selectedPage.id} onLink={linkIssue} /></div>
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
              {!reading && <div className="docs-document-properties"><h3>문서 속성</h3><label>상위 문서<select disabled={restoring} className="field" value={draft.parentId || ''} onChange={event => updateDraft({ parentId: event.target.value || null })}><option value="">최상위 문서</option>{parentOptions.map(page => <option key={page.id} value={page.id}>{page.title}</option>)}</select></label><label>작성 상태<select disabled={restoring} className="field" value={draft.status} onChange={event => updateDraft({ status: event.target.value as DocPage['status'] })}><option value="draft">초안</option><option value="published">공유 표시</option></select></label><p className="docs-panel-muted">속성 변경도 저장할 때 반영됩니다.</p><button className="docs-danger-action" onClick={() => void deleteDocument()} disabled={saving}><Trash2 size={13} /> 문서 삭제</button></div>}
            </>}
            {sideTab === 'source' && <SourceOrigins resourceType="document" resourceId={draft.id}/>}
            {sideTab === 'attachments' && <>{!reading && <div className="docs-panel-heading"><h3>문서에 자료 모으기</h3><p>첨부 링크나 이미지를 본문에 삽입하세요.</p></div>}<Attachments key={draft.id} resourceType="document" resourceId={draft.id} actorId={actorId} notify={notify} onChanged={refresh} readOnly={reading}
              reloadKey={clipboardAttachment?.documentId === draft.id ? clipboardAttachment.versionId : undefined}
              onInsertFileLink={reading || bodyReadOnly || archivedLiveRecovery ? undefined : insertAttachmentLink}
              onInsertImage={reading || bodyReadOnly ? undefined : url => { editor?.chain().focus().setImage({ src: url, alt: '첨부 이미지' }).run(); notify(liveMode ? '이미지를 삽입했습니다. 서버 동기화 상태를 확인해주세요.' : '이미지를 삽입했습니다. 문서를 저장하면 반영됩니다.', 'success'); }} /></>}
            {sideTab === 'history' && <DocumentHistory key={historyScope} revisions={currentHistory?.revisions ?? []} loading={!currentHistory} error={currentHistory?.error ?? ''}
              onReload={() => setHistoryReload(value => value + 1)} restoreRecovery={restoreRecovery}
              current={readingPage ? { ...readingPage, dirty: false } : { title: draft.title, content: draft.content, plainText: draft.plainText, version: draft.expectedVersion, dirty: draft.dirty }}
              users={data.users} onRestore={reading ? undefined : restoreRevision}
              restoreDisabled={saving || draft.dirty || confirmingSave || Boolean(confirmingRestore) || !data.restoreGeneration || !activeSession || manualRecovery || Boolean(liveMode && (liveState?.pending || liveState?.phase !== 'connected'))}
              onSaveCopy={reading || confirmingSave || recoveringEditCopy ? undefined : saveCopy} saving={saving} />}
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
    {documentAction?.kind === 'link' && documentAction.actorId === actorId && documentAction.generation === data.restoreGeneration && documentAction.source.id === selectedPageId &&
      <DocumentDecisionLinkDialog source={documentAction.source} generation={documentAction.generation} initialAttempt={documentAction.initialAttempt}
      data={data} actorId={actorId} refresh={refresh} notify={notify} onClose={closeDocumentAction} onAttemptChange={rememberDecisionLink}
      reloadComments={() => window.dispatchEvent(new Event(COMMENT_LIST_CHANGED))} />}
    {documentAction?.kind === 'comment' && <DocumentSelectionCommentDialog source={documentAction.source} initialDraft={documentAction.initialDraft}
      actorId={actorId} users={data.users} refresh={refresh} notify={notify} onClose={closeDocumentAction} onSaved={showSavedSelectionComment} onReselect={reselectCommentSource} />}
    {publicationOpen && selectedPage && draft?.id === selectedPage.id && <DocumentPublication data={data}
      document={{ ...selectedPage, version: draft.expectedVersion }} actorId={actorId} canRequest={canRequestPublication}
      initialSnapshot={publicationLink} projectId={selectedPage.projectId ?? projectId} sectionId={publicationLink ? sectionId : null} covered={issueDrawerOpen}
      onClose={closePublication} notify={notify} refreshDocument={refresh} />}
    {moveRequest && moveSource && <DocumentTreeMove key={moveSource.id} document={moveSource} documents={data.documents}
      projects={data.projects} destination={moveRequest.destination} beforeApply={() => moveBlocker(moveSource.id)} refreshWorkspace={refresh}
      onClose={closeMove} onMoved={moveSaved} />}
    {copyOpen && latestPage && <DocumentTreeCopy key={latestPage.id} source={latestPage} documents={data.documents}
      projects={data.projects} actorId={actorId} refreshWorkspace={refresh} onClose={closeCopy} onOpenCopy={selectDocument} />}
    {orderRequest && <DocumentSiblingOrderDialog key={orderRequest.documentId} documentId={orderRequest.documentId} documents={data.documents}
      projects={data.projects} placement={orderRequest.placement} refreshWorkspace={refresh} onClose={closeOrder} />}
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
          <DocumentTemplatePicker catalog={teamCatalog} reload={reloadTeamTemplates} value={teamTemplate} projectId={newProject || null} data={data}
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
        {createError && <p className="document-template-error" role="alert">{createError}</p>}
        {createStorageProblem && <p className="document-template-error" role="status">이 탭을 새로고침하기 전에 문서 저장 결과를 확인해 주세요.</p>}
        {teamTemplateChanged && <div className="document-template-picker-status document-template-review">
          <span>{currentTeamTemplate ? `현재 템플릿 버전 ${currentTeamTemplate.version}을 확인해 주세요.` : teamCatalog?.state === 'ready'
            ? '현재 공간에서 이 템플릿을 사용할 수 없습니다. 다른 템플릿을 선택해 주세요.' : '팀 템플릿 목록을 확인하고 있습니다.'}</span>
          {currentTeamTemplate && <button type="button" className="btn" disabled={createLocked} onClick={() => {
            setTeamTemplate(currentTeamTemplate);
            setTeamTemplateConflict(false);
            setCreateError('');
            createTitle.current?.focus({ preventScroll: true });
          }}>최신 템플릿 사용</button>}
        </div>}
        <div className="docs-modal-footer">
          <button className="btn btn-ghost" type="button" disabled={creating} onClick={discardCreateDocument}>취소</button>
          <button ref={createSubmit} className="btn btn-primary" type="submit" disabled={!newTitle.trim() || creating || !createAttempt && importingMarkdown && !markdownPreview || teamTemplateChanged || creationRejected}>
            {creating ? <Loader2 size={14} className="docs-spin" /> : <Plus size={14} />}
            {creating ? '저장 중…' : createAttempt?.documentId ? '저장한 문서 열기'
              : createAttempt ? '저장 다시 확인' : importingMarkdown ? 'Markdown 문서 만들기' : '문서 만들기'}
          </button>
        </div>
      </form>
    </div>}
  </section></DocumentAnnotationProvider></DocumentBlocksProvider>;
}
