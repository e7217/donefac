'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type { Transaction } from '@tiptap/pm/state';
import {
  ArrowDownToLine, Bold, ChartBar, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight,
  Code2, FileCheck2, FileClock, FileInput, FilePlus2, FileStack, Files, FileText, FolderInput, History, ImageIcon, Info, Italic, Link2, List,
  ListChecks, ListFilter, ListOrdered, ListTree, Loader2, MessageSquare, PanelRightClose,
  PanelRightOpen, Paperclip, Plus, Quote, RefreshCw, Save, Scissors, Search, Send, Strikethrough,
  Table2, TableOfContents, Tag, Trash2, Unlink, X,
} from 'lucide-react';
import { createEditorExtensions } from '../../shared/editor-schema';
import { documentLabelKey, normalizeDocumentLabels } from '../../shared/document-labels';
import { MAX_DOCUMENT_LABEL_LISTS } from '../../shared/document-label-list';
import { MAX_DOCUMENT_CHILD_LISTS } from '../../shared/document-child-list';
import { DOCUMENT_CONTENT_SCHEMA_VERSION, contentReferences, documentContentSchemaVersion, documentPlainText, findDocumentExcerpt } from '../../shared/document-nodes';
import { isDocumentSectionId } from '../../shared/document-sections';
import { DocumentBlocksProvider, DocumentDecisionRevision, ReferenceChooser, decorateDocumentExtensions, insertDetails, insertDocumentExcerpt, unfoldDetails, unwrapDetails, type ReferenceKind, type ReferenceSelection } from './DocumentBlocks';
import { DocumentAnnotationDialog, DocumentAnnotationProvider, type DocumentAnnotationKind, type DocumentAnnotationSelection, type OpenDocumentAnnotation } from './DocumentAnnotations';
import { IssueBlockChooser, type IssueBlockSelection, type OpenIssueBlock } from './DocumentIssueList';
import { SourceOrigins } from './SourceOrigins';
import { AtlassianLinks } from './AtlassianLinks';
import { DocumentHistory } from './DocumentHistory';
import { DocumentLabels } from './DocumentLabels';
import { DocumentMarkdownImport, type MarkdownImportPreview } from './DocumentMarkdownImport';
import { DocumentTemplatePicker, DocumentTemplatesManager, isDefiniteTemplateFailure, templateErrorReason, useDocumentTemplates } from './DocumentTemplates';
import { DocumentTreeMove } from './DocumentTreeMove';
import { DocumentPublication } from './DocumentPublication';
import { DocumentEditorOutline } from './DocumentEditorOutline';
import { insertDocumentToc } from './DocumentToc';
import { DocumentSelectionActions } from './DocumentSelectionActions';
import { DocumentSelectionCommentDialog, type SelectionCommentSource } from './DocumentSelectionCommentDialog';
import { DocumentDecisionLinkDialog, type DecisionLinkSource } from './DocumentDecisionLinkDialog';
import { DocumentLinkedWork } from './DocumentLinkedWork';
import { ResourceLinkPicker } from './ResourceLinkPicker';
import { NewIssueModal, type FollowUpSource } from './NewIssueModal';
import { documentNotificationSpaceId, type Comment, type DocPage, type DocRevision, type DocumentPublicationTarget, type DocumentSourceSelection, type DocumentTemplateSummary, type FeatureProps, type RichContent } from '../../shared/types';
import { ApiError, api, post, relativeTime, remove } from '../lib/api';
import { afterAcceptedNavigation, isDocumentPreservedByNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import { contentMarkdown, contentText, DOCUMENT_TEMPLATES, documentRevisionLabel, downloadDocument, templateContent } from './document-utils';
import { Attachments } from './Attachments';
import { COMMENT_LIST_CHANGED, CommentTrashButton } from './CommentTrashButton';
import { NotificationSubscriptionButton } from './NotificationSubscriptionButton';
import { CollaborativeEditor } from './CollaborativeEditor';
import type { CollaborationSession } from '../../shared/collaboration';
import { hasPendingCollaboration, type CollaborationView } from '../lib/collaboration-client';
import './documents.css';

type Props = FeatureProps & {
  selectedDocumentId: string | null;
  onSelectDocument: (id: string) => void;
  documentLabel?: string | null;
  onChangeDocumentLabel?: (label: string | null) => void;
  sectionId?: string | null;
  publicationLink?: DocumentPublicationTarget | null;
  onClosePublicationLink?: (documentId: string, target: DocumentPublicationTarget) => void;
  issueDrawerOpen?: boolean;
};
type DocumentAction = { kind: 'create'; source: FollowUpSource } | { kind: 'link'; source: DecisionLinkSource }
  | { kind: 'comment'; source: SelectionCommentSource; initialBody: string };
type DocumentMetadata = Pick<DocPage, 'title' | 'status' | 'parentId'> & { labels: string[] };
type Draft = DocumentMetadata & {
  id: string; content: RichContent; plainText: string;
  expectedVersion: number;
  dirty: boolean; editSequence: number;
  bodyDirty?: boolean;
  baseMetadata?: DocumentMetadata;
};
type SideTab = 'comments' | 'history' | 'links' | 'attachments' | 'source';
const cacheKey = (actorId: string, id: string) => `teamspace:document-draft:${actorId}:${id}`;
const commentCacheKey = (actorId: string, id: string) => `teamspace:document-comment-draft:${actorId}:${id}`;
const selectionCommentCacheKey = (actorId: string, id: string) => `teamspace:document-selection-comment-draft:${actorId}:${id}`;
type CommentContext = { actorId: string; documentId: string };
type MarkdownCreation = { actorId: string; body: string; documentId?: string };
type TeamTemplateCreation = MarkdownCreation & { projectId: string | null };
type TemplateManagerContext = { projectId: string | null; source?: Pick<DocPage, 'id' | 'title' | 'version' | 'projectId'> };
const documentMetadata = (page: Pick<DocPage, 'title' | 'status' | 'parentId' | 'labels'>): DocumentMetadata => ({
  title: page.title, status: page.status, parentId: page.parentId, labels: page.labels ?? [],
});
const sameLabels = (left: string[], right: string[]) => left.length === right.length && left.every((label, index) => label === right[index]);
const sameMetadata = (left: DocumentMetadata, right: DocumentMetadata) => left.title === right.title && left.status === right.status
  && left.parentId === right.parentId && sameLabels(left.labels, right.labels);
const draftFromPage = (page: DocPage): Draft => {
  const metadata = documentMetadata(page);
  return {
    id: page.id, content: page.content, plainText: page.plainText, expectedVersion: page.version,
    dirty: false, editSequence: 0, bodyDirty: false, ...metadata, baseMetadata: metadata,
  };
};
const when = (value: string) => new Date(value).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const LIST_DRAFT_DISCARD_MESSAGE = '적용하지 않은 문서 목록 설정을 버리고 이동할까요? 다른 편집과 댓글 초안은 임시로 보관합니다.';

export function Documents({ data, projectId, actorId, refresh, notify, openIssue, openDocument, selectedDocumentId, onSelectDocument, documentLabel, onChangeDocumentLabel, sectionId, publicationLink, onClosePublicationLink, issueDrawerOpen = false }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
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
  const [conflict, setConflict] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const [publicationDocumentId, setPublicationDocumentId] = useState<string | null>(null);
  const [moveDocumentId, setMoveDocumentId] = useState<string | null>(null);
  const closeMove = useCallback(() => setMoveDocumentId(null), []);
  const publicationOpener = useRef<HTMLButtonElement>(null);
  const closePublication = useCallback(() => {
    setPublicationDocumentId(null);
    if (selectedDocumentId && publicationLink) onClosePublicationLink?.(selectedDocumentId,publicationLink);
    requestAnimationFrame(() => publicationOpener.current?.focus());
  }, [onClosePublicationLink,publicationLink,selectedDocumentId]);
  const [storageProblem, setStorageProblem] = useState(false);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sideTab, setSideTab] = useState<SideTab>('comments');
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentBody, setCommentBody] = useState('');
  const commentBodyRef = useRef('');
  const commentContextRef = useRef<CommentContext | null>(null);
  const reselectedCommentDraft = useRef<(CommentContext & { body: string }) | null>(null);
  const focusCommentId = useRef<string | null>(null);
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
  const [insertKind, setInsertKind] = useState<'link' | 'image' | null>(null);
  const [insertUrl, setInsertUrl] = useState('');
  const [referenceSelection, setReferenceSelection] = useState<ReferenceSelection | null>(null);
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
  const documentActionOpener = useRef<HTMLButtonElement>(null);
  const closeDocumentAction = useCallback((restoreFocus = true) => {
    const opener = documentActionOpener.current;
    setDocumentAction(null);
    documentActionOpener.current = null;
    if (restoreFocus) requestAnimationFrame(() => { if (opener?.isConnected) opener.focus({ preventScroll: true }); });
  }, []);
  const [referencesRefreshing, setReferencesRefreshing] = useState(false);
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
  const publicationOpen = Boolean(selectedPage && (publicationLink || selectedPage.id === publicationDocumentId));
  const moveOpen = Boolean(selectedPage && selectedPage.id === moveDocumentId);
  const currentProject = data.projects.find(project => project.id === projectId);
  const scoped = useMemo(() => data.documents.filter(page => projectId === 'all' || page.projectId === projectId || page.projectId === null), [data.documents, projectId]);
  const activeSession = session?.document.id === selectedPage?.id ? session : null;
  const liveMode = Boolean(activeSession && (activeSession.enabled || archivedLiveRecovery) && !manualRecovery);
  const liveDocument = liveState?.document;
  const latestPage = selectedPage && liveDocument?.id === selectedPage.id && liveDocument.version > selectedPage.version ? liveDocument : selectedPage;
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

  const rememberComment = useCallback((body = commentBodyRef.current, context = commentContextRef.current) => {
    if (!context || typeof window === 'undefined') return;
    try {
      const key = commentCacheKey(context.actorId, context.documentId);
      if (body) localStorage.setItem(key, body);
      else localStorage.removeItem(key);
    } catch { setStorageProblem(true); }
  }, []);

  const updateCommentBody = useCallback((value: string) => {
    commentBodyRef.current = value;
    setCommentBody(value);
    rememberComment(value);
  }, [rememberComment]);

  const updateDraft = useCallback((changes: Partial<Draft>) => {
    const previous = draftRef.current;
    if (!previous) return;
    const next = { ...previous, ...changes, dirty: true, bodyDirty: previous.bodyDirty || 'content' in changes, editSequence: previous.editSequence + 1 };
    draftRef.current = next;
    setDraft(next);
    rememberDraft(next);
  }, [rememberDraft]);

  const receiveLiveEditor = useCallback((instance: Editor | null) => setLiveEditor(instance), []);
  const receiveLiveState = useCallback((state: CollaborationView | null) => { liveStateRef.current = state; setLiveState(state); }, []);
  const receiveLiveContent = useCallback((content: RichContent, plainText: string) => {
    const current = draftRef.current;
    if (!current) return;
    const next = { ...current, content, plainText, bodyDirty: false };
    draftRef.current = next; setDraft(next);
    if (next.dirty) rememberDraft(next);
  }, [rememberDraft]);
  const receiveLiveDocument = useCallback((document: DocPage) => {
    const current = draftRef.current;
    if (!current || current.id !== document.id || current.expectedVersion > document.version) return;
    const metadata = documentMetadata(document);
    const baseUnchanged = current.baseMetadata && sameMetadata(current.baseMetadata, metadata);
    const ownMatches = sameMetadata(current, metadata);
    if (current.dirty && !baseUnchanged && !ownMatches) { setConflict(true); return; }
    const next = current.dirty ? { ...current, expectedVersion: document.version } : { ...current, ...metadata, baseMetadata: metadata, expectedVersion: document.version };
    draftRef.current = next; setDraft(next);
    if (next.dirty) rememberDraft(next);
  }, [rememberDraft]);

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
  const editor = liveMode ? liveEditor : manualEditor;
  const bodyReadOnly = restoring || manualRecovery || !activeSession || (liveMode && (!liveState?.ready || liveState.phase === 'recovery' || liveState.phase === 'error'));
  const annotationDialog = !bodyReadOnly && !publicationOpen && annotationSelection?.editor === editor && annotationSelection.documentId === selectedPage?.id ? annotationSelection : null;
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
  const openIssueBlock = useCallback<OpenIssueBlock>((instance, nodeType, target) => {
    const current = draftRef.current;
    if (!current || instance !== editor || instance.isDestroyed || !instance.isEditable) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const context = { editor: instance, documentId: current.id, opener, nodeType };
    setIssueBlockSelection(target ? { ...context, kind: 'edit', target } : { ...context, kind: 'insert', bookmark: instance.state.selection.getBookmark() });
    setSlashQuery(null); setInsertKind(null); setReferenceSelection(null); closeAnnotation();
  }, [editor, closeAnnotation]);
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
    const next = { ...draftFromPage(current.document), ...(previous.dirty ? {
      ...documentMetadata(previous),
      expectedVersion: previous.expectedVersion, baseMetadata: previous.baseMetadata,
      editSequence: previous.editSequence, dirty: true,
    } : {}) };
    draftRef.current = next; setDraft(next); rememberDraft(next);
    manualEditor?.commands.setContent(next.content, { emitUpdate: false });
    sessionRef.current = current; setSession(current);
    archivedLiveRecoveryRef.current = false; setArchivedLiveRecovery(false);
    manualRecoveryRef.current = false; setManualRecovery(false);
    setConflict(Boolean(next.dirty));
    void refresh().catch(() => {});
  }, [manualEditor, rememberDraft, refresh]);

  useEffect(() => {
    if (!selectedPage) return;
    let active = true;
    sessionRef.current = null; setSession(null); setSessionError('');
    manualRecoveryRef.current = false; setManualRecovery(false);
    archivedLiveRecoveryRef.current = false; setArchivedLiveRecovery(false);
    const check = async () => {
      try {
        const current = await api<CollaborationSession>(`/documents/${selectedPage.id}/collaboration`);
        if (!active) return;
        if (sessionRef.current?.enabled && !current.enabled) return;
        sessionRef.current = current; setSession(current); setSessionError('');
        const archive = !current.enabled && hasPendingCollaboration(actorId, current.document.id);
        archivedLiveRecoveryRef.current = archive; setArchivedLiveRecovery(archive);
        const cached = draftRef.current;
        if (current.enabled && cached?.id === selectedPage.id && cached.bodyDirty) {
          manualRecoveryRef.current = true; setManualRecovery(true);
        }
      } catch (cause) { if (active) setSessionError(cause instanceof Error ? cause.message : '공동 편집 상태를 확인하지 못했습니다.'); }
    };
    void check();
    // Discover another opener enabling collaboration; this polls capability,
    // never document writes. Once live, the WebSocket owns synchronization.
    const timer = setInterval(() => { if (!sessionRef.current?.enabled) void check(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [selectedPage?.id, actorId]);

  useEffect(() => { manualEditor?.setEditable(Boolean(activeSession && !activeSession.enabled) && !manualRecovery && !archivedLiveRecovery, false); }, [manualEditor, activeSession?.enabled, Boolean(activeSession), manualRecovery, archivedLiveRecovery]);
  useEffect(() => { if (activeSession?.enabled && draft?.bodyDirty) { manualRecoveryRef.current = true; setManualRecovery(true); } }, [activeSession?.enabled, draft?.id, draft?.bodyDirty]);

  useEffect(() => {
    if (!manualEditor) return;
    const old = draftRef.current;
    if (!selectedPage) {
      if (old) {
        rememberDraft(old);
        draftRef.current = null;
        setDraft(null);
      }
      return;
    }
    const sameActor = actorRef.current === actorId;
    if (old?.id === selectedPage.id && (old.dirty || listDrafts.current.size) && sameActor) return;
    if (old?.id === selectedPage.id && sameActor && old.expectedVersion > selectedPage.version) return;
    if (liveMode && old?.id === selectedPage.id && sameActor) { receiveLiveDocument(selectedPage); return; }
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
            bodyDirty: candidate.bodyDirty ?? JSON.stringify(candidate.content) !== JSON.stringify(selectedPage.content),
          };
        }
      }
    } catch { /* A malformed local draft must not prevent opening a saved document. */ }
    draftRef.current = next;
    setDraft(next);
    manualEditor.commands.setContent(next.content, { emitUpdate: false });
    setConflict(next.dirty && next.expectedVersion !== selectedPage.version);
    setShowLatest(false);
    setReferenceSelection(null);
    setIssueBlockSelection(null);
    closeAnnotation();
    setSlashQuery(null);
    setInsertKind(null);
  }, [selectedPage?.id, selectedPage?.version, actorId, manualEditor, rememberDraft, liveMode, receiveLiveDocument, closeAnnotation]); // Deliberately preserve the local buffer on snapshot refresh.

  useEffect(() => {
    if (!selectedDocumentId && visible.length) onSelectDocument(visible[0].id);
  }, [selectedDocumentId, visible, onSelectDocument]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (creatingRequest.current || templateCreateAttempt.current || templateDraftDirty.current || draftRef.current?.dirty
        || listDrafts.current.size || commentBodyRef.current.trim() || liveStateRef.current?.pending) {
        rememberDraft(draftRef.current); rememberComment(); event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => { window.removeEventListener('beforeunload', handler); rememberDraft(draftRef.current); rememberComment(); };
  }, [rememberDraft, rememberComment]);

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (isDocumentPreservedByNavigation(event, selectedDocumentId)) {
        if (annotationDialog) {
          event.preventDefault();
          notify('문서 서식 편집을 마친 뒤 업무를 열어 주세요.', 'error');
        }
        return;
      }
      if (savingRef.current || creatingRequest.current) {
        event.preventDefault();
        notify('저장이 끝난 후 이동해주세요.', 'error');
        return;
      }
      if (templateFormOpen.current && !confirmTemplateDraftDiscard()) {
        event.preventDefault();
        return;
      }
      if (draftRef.current?.dirty || listDrafts.current.size || commentBodyRef.current.trim() || liveStateRef.current?.pending) {
        if (!window.confirm(listDrafts.current.size ? LIST_DRAFT_DISCARD_MESSAGE : '저장하지 않은 편집, 전송 중인 공동 편집 또는 보내지 않은 댓글이 있습니다. 이 브라우저에 임시 보관하고 이동할까요?')) event.preventDefault();
        else { rememberDraft(draftRef.current); rememberComment(); }
      }
      if (templateFormOpen.current) afterAcceptedNavigation(event, closeCreateDocument);
    };
    window.addEventListener('teamspace:navigate', guard);
    return () => window.removeEventListener('teamspace:navigate', guard);
  }, [annotationDialog, closeCreateDocument, confirmTemplateDraftDiscard, notify, rememberDraft, rememberComment, selectedDocumentId]);

  useEffect(() => {
    if (teamCreation && !creating && !teamCreationRejected) createSubmit.current?.focus({ preventScroll: true });
  }, [creating, teamCreation, teamCreationRejected]);

  const saveDraft = useCallback(async (status?: DocPage['status']) => {
    const captured = draftRef.current;
    if (!captured || savingRef.current || (!captured.dirty && (!status || status === captured.status))) return;
    if (archivedLiveRecoveryRef.current) { notify('보관한 공동 편집을 먼저 복구하거나 최신 문서를 열어주세요.', 'error'); return; }
    const collaborative = sessionRef.current?.enabled && sessionRef.current.document.id === captured.id;
    if (collaborative && (manualRecoveryRef.current || liveStateRef.current?.phase !== 'connected' || liveStateRef.current?.pending)) { notify('공동 편집 연결과 본문 동기화를 먼저 확인해주세요.', 'error'); return; }
    const capturedActor = actorRef.current;
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
      }
      const result = await api<DocPage>(`/documents/${captured.id}`, { method: 'PATCH', headers: { 'X-Actor-Id': capturedActor }, body: JSON.stringify({
        expectedVersion: captured.expectedVersion, title: captured.title.trim() || '제목 없는 문서',
        ...(!collaborative && captured.bodyDirty ? { content: captured.content, plainText: captured.plainText, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION } : {}),
        ...(!captured.baseMetadata || !sameLabels(captured.labels, captured.baseMetadata.labels) ? { labels: captured.labels } : {}),
        status: status || captured.status, parentId: captured.parentId,
      }) });
      const current = draftRef.current;
      if (current?.id === captured.id && actorRef.current === capturedActor && activeActorRef.current === capturedActor) {
        const latest = collaborative && liveStateRef.current?.document.id === captured.id && liveStateRef.current.document.version > result.version ? liveStateRef.current.document : result;
        const savedMetadata = documentMetadata(result);
        const newerMetadata = !sameMetadata(documentMetadata(latest), savedMetadata);
        const editedAgain = current.editSequence !== captured.editSequence;
        const next = !editedAgain ? { ...draftFromPage(latest), ...(collaborative ? { content: current.content, plainText: current.plainText } : {}) } : {
          ...current, expectedVersion: newerMetadata ? result.version : latest.version,
          baseMetadata: savedMetadata,
          ...(status && current.status === captured.status ? { status } : {}),
        };
        draftRef.current = next;
        setDraft(next);
        rememberDraft(next, capturedActor);
        setConflict(Boolean(editedAgain && newerMetadata));
      } else {
        // Reconcile only the request owner's cached buffer. A response for a
        // different actor/document must never change the current editor/cache.
        try {
          const key = cacheKey(capturedActor, captured.id);
          const stored = localStorage.getItem(key);
          const cached = stored ? JSON.parse(stored) as Draft : null;
          if (cached?.id === captured.id && cached.expectedVersion === captured.expectedVersion) {
            if (cached.editSequence === captured.editSequence) localStorage.removeItem(key);
            else localStorage.setItem(key, JSON.stringify({ ...cached, expectedVersion: result.version, baseMetadata: documentMetadata(result) }));
          }
        } catch { setStorageProblem(true); }
      }
      await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        if (draftRef.current?.id === captured.id && actorRef.current === capturedActor && activeActorRef.current === capturedActor) setConflict(true);
        notify('다른 변경사항이 있어 저장하지 않았습니다. 내 편집은 임시 보관되어 있어요.', 'error');
        await refresh().catch(() => {});
      } else notify(error instanceof Error ? error.message : '문서를 저장하지 못했습니다.', 'error');
    } finally { savingRef.current = false; setSaving(false); }
  }, [notify, refresh, rememberDraft]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (issueDrawerOpen || newOpen || templateManager) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!publicationOpen && !moveOpen) void saveDraft();
      }
      if (event.key === 'Escape') { setSlashQuery(null); setInsertKind(null); setReferenceSelection(null); setIssueBlockSelection(null); setExportOpen(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [saveDraft, publicationOpen, moveOpen, issueDrawerOpen, newOpen, templateManager]);

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
  useEffect(() => {
    if (!documentId) return;
    rememberComment();
    const context = { actorId, documentId };
    commentContextRef.current = context;
    let cached = '';
    try { cached = localStorage.getItem(commentCacheKey(actorId, documentId)) || ''; } catch { setStorageProblem(true); }
    commentBodyRef.current = cached;
    setComments([]); setCommentBody(cached); setCommentsLoading(true); setCommentError('');
    let activeRequest: AbortController | undefined;
    const loadComments = () => {
      activeRequest?.abort();
      const request = new AbortController();
      activeRequest = request;
      void api<Comment[]>(`/comments?resourceType=document&resourceId=${encodeURIComponent(documentId)}`, {
        signal: request.signal, headers: { 'X-Actor-Id': actorId },
      }).then(result => { if (!request.signal.aborted) { setComments(result); setCommentError(''); } })
        .catch(error => { if (!request.signal.aborted) setCommentError(error instanceof Error ? error.message : '댓글을 불러오지 못했습니다.'); })
        .finally(() => { if (!request.signal.aborted) setCommentsLoading(false); });
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
  }, [documentId, actorId, rememberComment]);

  useEffect(() => {
    if (!focusCommentId.current || !sidebarOpen || sideTab !== 'comments') return;
    const article = document.getElementById(`document-comment-${focusCommentId.current}`);
    if (!article) return;
    focusCommentId.current = null;
    article.scrollIntoView({ block: 'nearest' });
    article.focus({ preventScroll: true });
  }, [comments, sidebarOpen, sideTab]);

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
    if (id === selectedDocumentId) return;
    if (documentAction) {
      if (window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }))) onSelectDocument(id);
      return;
    }
    if (savingRef.current) { notify('저장이 끝난 후 이동해주세요.', 'error'); return; }
    if ((draftRef.current?.dirty || listDrafts.current.size || commentBodyRef.current.trim() || liveStateRef.current?.pending) &&
      !window.confirm(listDrafts.current.size ? LIST_DRAFT_DISCARD_MESSAGE : '저장하지 않은 편집, 전송 중인 공동 편집 또는 보내지 않은 댓글이 있습니다. 이 브라우저에 임시 보관하고 다른 문서로 이동할까요?')) return;
    rememberDraft(draftRef.current);
    rememberComment();
    onSelectDocument(id);
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
      if (documentId) onSelectDocument(documentId);
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
    const body = commentBodyRef.current.trim();
    if (!context || !body || commentBusy) return;
    setCommentBusy(true);
    try {
      const result = await api<Comment>('/comments', { method: 'POST', headers: { 'X-Actor-Id': context.actorId }, body: JSON.stringify({ resourceType: 'document', resourceId: context.documentId, body }) });
      const current = commentContextRef.current;
      if (current?.documentId === context.documentId && current.actorId === context.actorId && activeActorRef.current === context.actorId) {
        setComments(items => items.some(item => item.id === result.id) ? items : [...items, result]);
        if (commentBodyRef.current.trim() === body) updateCommentBody('');
      } else {
        try {
          const key = commentCacheKey(context.actorId, context.documentId);
          if (localStorage.getItem(key)?.trim() === body) localStorage.removeItem(key);
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
      setSidebarOpen(true);
      setSideTab('comments');
    }
    window.dispatchEvent(new Event(COMMENT_LIST_CHANGED));
    void refresh().catch(() => undefined);
    notify('발췌 댓글을 등록했습니다.', 'success');
  }

  async function restoreRevision(revision: DocRevision) {
    const captured = draftRef.current;
    if (!captured || savingRef.current) return;
    const capturedActor = actorRef.current;
    if (listDrafts.current.size) { notify('문서 목록 설정을 적용하거나 취소한 후 복구해주세요.', 'error'); return; }
    if (captured.dirty) { notify('현재 편집을 먼저 저장하거나 새 문서로 보관해주세요.', 'error'); return; }
    if (liveStateRef.current?.pending || (sessionRef.current?.enabled && liveStateRef.current?.phase !== 'connected')) { notify('공동 편집을 서버에 동기화한 후 복구해주세요.', 'error'); return; }
    if (!window.confirm(`${documentRevisionLabel(revision)}의 내용으로 복구할까요? 현재 내용은 이력에 남습니다.`)) return;
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
        setReferenceSelection(null); setIssueBlockSelection(null); setConflict(false);
      }
      await refresh(); notify('이전 내용을 새 버전으로 복구했습니다.', 'success');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { if (actorRef.current === capturedActor && activeActorRef.current === capturedActor && draftRef.current?.id === captured.id) setConflict(true); await refresh().catch(() => {}); }
      notify(error instanceof Error ? error.message : '복구하지 못했습니다.', 'error');
    } finally { savingRef.current = false; setSaving(false); setRestoring(false); editor?.setEditable(true, false); }
  }

  async function saveCopy() {
    const captured = draftRef.current;
    if (!captured || savingRef.current) return;
    const capturedActor = actorRef.current;
    savingRef.current = true; setSaving(true);
    try {
      const source = data.documents.find(page => page.id === captured.id);
      const result = await post<DocPage>('/documents', { title: `${captured.title || '제목 없는 문서'} (편집 사본)`, projectId: source?.projectId || null, parentId: source?.parentId || null, content: captured.content, status: 'draft', labels: captured.labels });
      await refresh();
      const current = draftRef.current;
      if (current?.id === captured.id && current.editSequence === captured.editSequence && actorRef.current === capturedActor && activeActorRef.current === capturedActor) {
        const clean = { ...current, dirty: false }; draftRef.current = clean; setDraft(clean); rememberDraft(clean, capturedActor);
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
    if (liveStateRef.current?.pending || commentBusy) { notify('공동 편집과 댓글 전송이 끝난 후 휴지통으로 옮겨 주세요.', 'error'); return; }
    const hasDraft = captured.dirty || listDrafts.current.size || Boolean(commentBodyRef.current.trim());
    if (!window.confirm(`“${captured.title}” 문서를 휴지통으로 옮길까요?${hasDraft ? ' 저장하지 않은 편집과 보내지 않은 댓글은 사라집니다.' : ''}`)) return;
    savingRef.current = true; setSaving(true);
    try {
      await remove(`/documents/${captured.id}?expectedVersion=${captured.expectedVersion}`);
      window.dispatchEvent(new Event('teamspace:trash-changed'));
      const clean = { ...captured, dirty: false }; rememberDraft(clean, capturedActor);
      rememberComment('', { actorId: capturedActor, documentId: captured.id });
      if (reselectedCommentDraft.current?.actorId === capturedActor && reselectedCommentDraft.current.documentId === captured.id) reselectedCommentDraft.current = null;
      try { localStorage.removeItem(selectionCommentCacheKey(capturedActor, captured.id)); } catch { setStorageProblem(true); }
      const sameContext = draftRef.current?.id === captured.id && actorRef.current === capturedActor && activeActorRef.current === capturedActor;
      if (sameContext) { draftRef.current = null; setDraft(null); commentBodyRef.current = ''; setCommentBody(''); }
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
    const candidate = liveStateRef.current?.document || sessionRef.current?.document;
    const latest = candidate?.id === selectedPage.id && candidate.version >= selectedPage.version ? candidate : selectedPage;
    const current = draftRef.current;
    const next = { ...draftFromPage(latest), ...(sessionRef.current?.enabled && !manualRecoveryRef.current && current ? { content: current.content, plainText: current.plainText } : {}) };
    draftRef.current = next; setDraft(next); rememberDraft(next);
    if (!sessionRef.current?.enabled || manualRecoveryRef.current) manualEditor?.commands.setContent(next.content, { emitUpdate: false });
    manualRecoveryRef.current = false; setManualRecovery(false);
    setConflict(false); setShowLatest(false);
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

  const openRecoveryCopy = useCallback((id: string) => { void refresh().then(() => onSelectDocument(id)).catch(cause => notify(cause instanceof Error ? cause.message : '사본 목록을 불러오지 못했습니다.', 'error')); }, [refresh, onSelectDocument, notify]);

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

  async function refreshReferences() {
    if (referencesRefreshing) return; setReferencesRefreshing(true);
    try { await refresh(); notify('참조, 포함 원본, 업무 현황과 문서 목록을 새로 불러왔습니다.', 'success'); }
    catch (cause) { notify(cause instanceof Error ? cause.message : '참조를 새로 불러오지 못했습니다.', 'error'); }
    finally { setReferencesRefreshing(false); }
  }

  function openReference(kind: ReferenceKind) {
    if (!editor?.isEditable || !draftRef.current) return;
    setReferenceSelection({ kind, editor, bookmark: editor.state.selection.getBookmark(), documentId: draftRef.current.id });
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

  const slashCommands: ({ label: string; search: string } & ({ action: () => unknown } | { annotation: DocumentAnnotationKind }))[] = [
    { label: '제목 1', search: 'h1 heading 제목', action: () => editor?.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: '제목 2', search: 'h2 heading 제목', action: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: '글머리 목록', search: 'list bullet 목록', action: () => editor?.chain().focus().toggleBulletList().run() },
    { label: '체크리스트', search: 'task check 할일 체크', action: () => editor?.chain().focus().toggleTaskList().run() },
    { label: '인용', search: 'quote 인용', action: () => editor?.chain().focus().toggleBlockquote().run() },
    { label: '코드 블록', search: 'code 코드', action: () => editor?.chain().focus().toggleCodeBlock().run() },
    { label: '표', search: 'table 표', action: () => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { label: '업무 참조', search: 'issue ticket 업무 참조', action: () => openReference('issueReference') },
    { label: '업무 목록', search: 'issue list view ticket 업무 목록 공유 보기', action: () => { if (editor) openIssueBlock(editor, 'issueList'); } },
    { label: '업무 현황', search: 'issue summary chart 업무 현황 집계', action: () => { if (editor) openIssueBlock(editor, 'issueSummary'); } },
    { label: '문서 참조', search: 'document link 문서 참조', action: () => openReference('documentReference') },
    { label: '라벨별 문서 목록', search: 'document list labels 라벨별 문서 목록', action: () => insertDocumentList('documentLabelList') },
    { label: '하위 문서 목록', search: 'children child pages descendants tree 하위 문서 목록', action: () => insertDocumentList('documentChildList') },
    { label: '문서 포함', search: 'include embed 문서 포함', action: () => openReference('documentInclude') },
    { label: '발췌 구역', search: 'excerpt source 발췌 구역', action: insertExcerpt },
    { label: '발췌 포함', search: 'excerpt include 발췌 포함', action: () => openReference('documentExcerptInclude') },
    { label: '문서 버전 포함', search: 'pin snapshot version 문서 버전 고정 포함', action: () => openReference('documentRevisionInclude') },
    { label: '본문 목차', search: 'toc table of contents 본문 목차', action: () => insertDocumentToc(editor) },
    { label: '안내 상자', search: 'callout info note warning tip panel 안내 상자', annotation: 'callout' },
    { label: '상태 배지', search: 'status badge 상태 배지', annotation: 'statusBadge' },
    { label: '접기 블록', search: 'details expand collapse 접기 펼치기', action: () => insertDetails(editor) },
    { label: '구분선', search: 'divider 구분선', action: () => editor?.chain().focus().setHorizontalRule().run() },
  ];

  const matchingSlashCommands = slashQuery === null ? [] : slashCommands.filter(command => `${command.label} ${command.search}`.toLowerCase().includes(slashQuery.toLowerCase()));

  function runSlash(command: typeof slashCommands[number]) {
    const current = draftRef.current;
    if (!editor?.isEditable || !current || slashQuery === null) return;
    const { $from } = editor.state.selection;
    const from = $from.start(), to = $from.pos;
    const text = editor.state.doc.textBetween(from, to, '', '\ufffc');
    if (text !== '/' + slashQuery) { setSlashQuery(null); return; }
    if ('annotation' in command) {
      setAnnotationSelection({ editor, documentId: current.id, kind: command.annotation, opener: null, mode: 'insert',
        bookmark: editor.state.selection.getBookmark(), slash: { from, to, text } });
      setInsertKind(null); setIssueBlockSelection(null); setReferenceSelection(null);
    } else {
      editor.chain().focus().deleteRange({ from, to }).run();
      command.action();
    }
    setSlashQuery(null);
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
  const outgoingDocuments = [...new Map(references.filter(reference => reference.type === 'document').map(reference => [JSON.stringify([reference.id, reference.kind, reference.revisionId]), reference])).values()];
  const inlineIssues = [...new Map(references.filter(reference => reference.type === 'issue').map(reference => [reference.id, reference])).values()];
  const backlinks = data.documents.filter(page => page.id !== draft?.id && contentReferences(page.content).some(reference => reference.type === 'document' && reference.id === draft?.id));
  const candidateIssues = useMemo(() => {
    const linkedIssueIds = new Set(data.resourceLinks.filter(link => link.documentId === documentId).map(link => link.issueId));
    return data.issues.filter(issue => !linkedIssueIds.has(issue.id));
  }, [data.issues, data.resourceLinks, documentId]);
  const descendants = new Set<string>();
  const collectDescendants = (id: string) => { for (const child of data.documents.filter(page => page.parentId === id)) if (!descendants.has(child.id)) { descendants.add(child.id); collectDescendants(child.id); } };
  if (draft) collectDescendants(draft.id);
  const parentOptions = data.documents.filter(page => page.id !== draft?.id && !descendants.has(page.id) && page.projectId === selectedPage?.projectId);
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

  const issueBlockDialog = !bodyReadOnly && issueBlockSelection?.editor === editor && issueBlockSelection.documentId === draft?.id ? issueBlockSelection : null;
  const canRequestPublication = Boolean(draft && !draft.dirty && !saving && !bodyReadOnly &&
    (!liveMode || (liveState?.phase === 'connected' && !liveState.pending)));
  const selectionDocument = liveMode ? liveState?.document : selectedPage;
  let selectionUnavailable: string | null = null;
  if (draft?.bodyDirty) selectionUnavailable = '선택한 내용을 사용하려면 변경한 본문을 먼저 저장해 주세요.';
  else if (liveMode && (liveState?.phase !== 'connected' || liveState.pending)) {
    selectionUnavailable = '본문 동기화가 끝나면 선택한 내용을 사용할 수 있습니다.';
  } else if (saving || bodyReadOnly || conflict || !draft || !selectionDocument
    || draft.id !== selectedPage?.id || selectionDocument.id !== draft.id || selectionDocument.version !== draft.expectedVersion) {
    selectionUnavailable = '최신 저장본을 확인한 뒤 본문을 선택해 주세요.';
  }
  const selectionIssueUnavailable = data.projects.length ? null : '업무를 연결할 프로젝트가 없습니다.';
  function openFollowUp(page: DocPage, opener: HTMLButtonElement, sourceSelection?: DocumentSourceSelection) {
    documentActionOpener.current = opener;
    setDocumentAction({ kind: 'create', source: { id: page.id, title: page.title, projectId: page.projectId, version: page.version, sourceSelection } });
  }
  function openDecisionLink(page: DocPage, opener: HTMLButtonElement, sourceSelection: DocumentSourceSelection) {
    documentActionOpener.current = opener;
    setDocumentAction({ kind: 'link', source: { id: page.id, title: page.title, projectId: page.projectId, version: page.version, sourceSelection } });
  }
  function openSelectionComment(page: DocPage, opener: HTMLButtonElement, sourceSelection: DocumentSourceSelection) {
    documentActionOpener.current = opener;
    const preserved = reselectedCommentDraft.current;
    let initialBody = '';
    if (preserved?.documentId === page.id && preserved.actorId === actorId) {
      initialBody = preserved.body;
      reselectedCommentDraft.current = null;
    }
    try {
      const key = selectionCommentCacheKey(actorId, page.id);
      const cached = localStorage.getItem(key);
      if (cached !== null) {
        initialBody ||= cached;
        localStorage.removeItem(key);
      }
    } catch { setStorageProblem(true); }
    setDocumentAction({ kind: 'comment', initialBody, source: { id: page.id, title: page.title, version: page.version, sourceSelection } });
  }
  function reselectCommentSource(body: string) {
    if (documentAction?.kind !== 'comment') return;
    const documentId = documentAction.source.id;
    reselectedCommentDraft.current = { actorId, documentId, body };
    try { localStorage.setItem(selectionCommentCacheKey(actorId, documentId), body); } catch { setStorageProblem(true); }

    const current = draftRef.current;
    if (!liveMode && !manualRecovery && current?.id === documentId && selectedPage?.id === documentId
      && current.dirty && !current.bodyDirty && current.expectedVersion < selectedPage.version) {
      const base = current.baseMetadata;
      if (base && sameMetadata(base, documentMetadata(selectedPage))) {
        const next = { ...current, content: selectedPage.content, plainText: selectedPage.plainText, expectedVersion: selectedPage.version };
        draftRef.current = next;
        setDraft(next);
        rememberDraft(next);
        manualEditor?.commands.setContent(next.content, { emitUpdate: false });
        setConflict(false);
      } else setConflict(true);
    }
    closeDocumentAction(false);
    requestAnimationFrame(() => { if (editor && !editor.isDestroyed) editor.commands.focus(); });
  }
  const button = (label: string, icon: React.ReactNode, onClick: (event: React.MouseEvent<HTMLButtonElement>) => unknown, active = false) => <button disabled={bodyReadOnly} type="button" className={`docs-format-btn ${active ? 'is-active' : ''}`} title={label} aria-label={label} onMouseDown={event => event.preventDefault()} onClick={onClick}>{icon}</button>;

  return <DocumentBlocksProvider data={data} documentId={draft?.id || null} content={draft?.content} openIssue={openIssue} openDocument={openDocument}
    openIssueBlock={bodyReadOnly ? undefined : openIssueBlock} onListDraftChange={trackListDraft}>
    <DocumentAnnotationProvider value={bodyReadOnly ? undefined : openAnnotation}><section className="documents-feature">
    <div className="docs-heading" inert={newOpen || Boolean(templateManager)}><div><div className="docs-eyebrow">KNOWLEDGE</div><h1>문서 <span>{scoped.length}</span></h1><p>아이디어부터 결정까지, 팀의 지식을 한곳에.</p></div>
      <div className="document-template-heading-actions">
        <button className="btn" type="button" onClick={event => manageTemplates(event.currentTarget)}><FileStack size={15} aria-hidden="true" />팀 템플릿 관리</button>
        <button className="btn btn-primary" onClick={() => openNew()}><Plus size={16} /> 새 문서</button>
      </div>
    </div>
    <div className={`docs-layout ${sidebarOpen ? 'has-panel' : ''}`} inert={publicationOpen || newOpen || Boolean(issueBlockDialog || documentAction || templateManager)}>
      <aside className="docs-tree" aria-label="문서 목록">
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
          {tree(visible.filter(page => page.projectId !== null))}
          {!filtersActive && !visible.some(page => page.projectId !== null) && <p className="docs-tree-empty">첫 문서를 작성해보세요.</p>}
          <div className="docs-tree-group docs-tree-common"><span>팀 공통 문서</span>
            <div className="docs-tree-group-actions">
              <NotificationSubscriptionButton actorId={actorId} targetType="space" targetId={documentNotificationSpaceId(null)} notify={notify} />
              <button type="button" className="docs-tree-group-add" aria-label="팀 공통 문서 추가" onClick={() => { openNew(); setNewProject(''); }}><Plus size={14} /></button>
            </div>
          </div>
          {tree(visible.filter(page => page.projectId === null))}
          {!filtersActive && !visible.some(page => page.projectId === null) && <p className="docs-tree-empty">함께 참고하는 지식을 모아보세요.</p>}
        </div>
        <button className="docs-template-shortcut" onClick={() => openNew('', 'meeting')}><FilePlus2 size={16} /><span>템플릿으로 시작하기</span><ChevronRight size={14} /></button>
      </aside>

      {draft && selectedPage ? <>
        <main className="docs-document">
          <div className="docs-document-topbar">
            <div className="docs-breadcrumb"><FileText size={14} /><span>{selectedPage.projectId ? data.projects.find(project => project.id === selectedPage.projectId)?.name || '프로젝트' : '팀 공통'}</span><ChevronRight size={12} /><span>{draft.title || '제목 없는 문서'}</span></div>
            <div className="docs-top-actions"><span className={`docs-save-state ${draft.dirty ? 'is-dirty' : ''}`} aria-live="polite">{saving ? <><Loader2 size={12} className="docs-spin" /> 저장 중</> : draft.dirty ? <><span /> {liveMode ? '속성 변경' : '저장 필요'}</> : liveMode ? liveState?.phase === 'connected' && !liveState.pending ? <><CheckCheck size={13} /> 동기화됨</> : '동기화 대기' : <><CheckCheck size={13} /> 저장됨</>}</span>
              <NotificationSubscriptionButton actorId={actorId} targetType="document" targetId={selectedPage.id} notify={notify} />
              <button ref={publicationOpener} type="button" className="btn btn-ghost docs-publication-button" disabled={saving || restoring} onClick={() => setPublicationDocumentId(selectedPage.id)}><FileCheck2 size={14} />검토·발행</button>
              <button type="button" className="btn btn-ghost docs-icon-button" title="팀 템플릿으로 저장" aria-label="팀 템플릿으로 저장"
                disabled={saving || restoring} onClick={event => manageTemplates(event.currentTarget, latestPage ?? selectedPage)}><FileStack size={16} aria-hidden="true" /></button>
              {liveMode ? <button className="btn btn-ghost docs-checkpoint-button" disabled={saving || draft.dirty || liveState?.pending || liveState?.phase !== 'connected'} onClick={() => void checkpoint()}><History size={13} /> 버전 기록</button> : activeSession && !activeSession.enabled && <button className="btn btn-ghost docs-enable-collaboration" disabled={saving || draft.dirty} onClick={() => void enableCollaboration()}>공동 편집 시작</button>}
              <div className="docs-export-container"><button className="btn btn-ghost docs-icon-button" title="문서 내보내기" aria-label="문서 내보내기" onClick={() => setExportOpen(value => !value)}><ArrowDownToLine size={16} /></button>{exportOpen && <div className="docs-popover docs-export-menu"><button onClick={() => { downloadDocument(`${draft.title || 'document'}.md`, `# ${draft.title}\n\n${contentMarkdown(draft.content)}`, 'text/markdown;charset=utf-8'); setExportOpen(false); }}>Markdown 내보내기</button><button onClick={() => { downloadDocument(`${draft.title || 'document'}.json`, JSON.stringify({ format: 'teamspace-document', schemaVersion: Math.max(2, documentContentSchemaVersion(draft.content)), document: { ...selectedPage, title: draft.title, content: draft.content, plainText: draft.plainText, status: draft.status, parentId: draft.parentId, labels: draft.labels.length ? draft.labels : undefined } }, null, 2), 'application/json'); setExportOpen(false); }}>문서 JSON 내보내기</button></div>}</div>
              <button type="button" className="btn btn-ghost docs-icon-button" title="문서 이동" aria-label="문서 이동" onClick={() => {
                const blocker = moveBlocker();
                if (blocker) { notify(blocker, 'error'); return; }
                setExportOpen(false);
                setMoveDocumentId(selectedPage.id);
              }}><FolderInput size={16} aria-hidden="true" /></button>
              <button className="btn btn-ghost docs-icon-button" title={sidebarOpen ? '정보 패널 닫기' : '정보 패널 열기'} aria-label={sidebarOpen ? '정보 패널 닫기' : '정보 패널 열기'} onClick={() => setSidebarOpen(value => !value)}>{sidebarOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button>
              <button className="btn btn-primary docs-save-button" disabled={saving || !draft.dirty || manualRecovery || (liveMode && (liveState?.pending || liveState?.phase !== 'connected'))} onClick={() => void saveDraft()}><Save size={14} /> {liveMode ? '속성 저장' : '저장'}</button>
            </div>
          </div>

          {conflict && !manualRecovery && <div className="docs-notice docs-conflict" role="alert"><strong>다른 변경사항이 있어요.</strong><span>내 편집은 유지했습니다. 최신본을 확인한 후 정리해주세요.</span><div><button onClick={() => setShowLatest(value => !value)}>서버 최신본 보기</button><button onClick={() => void saveCopy()} disabled={saving}>내 편집을 새 문서로 보관</button><button onClick={discardLocal}>편집 버리고 최신본 열기</button></div></div>}
          {showLatest && latestPage && <div className="docs-latest-preview"><div><strong>서버 버전 {latestPage.version} · {latestPage.title}</strong><button aria-label="최신본 미리보기 닫기" onClick={() => setShowLatest(false)}><X size={14} /></button></div>
            {Boolean(draft.labels.length || latestPage.labels?.length) && <p className="docs-latest-labels">{latestPage.labels?.length ? <>라벨 · {latestPage.labels.join(', ')}</> : '라벨 없음'}</p>}
            <pre>{latestPage.plainText || contentText(latestPage.content)}</pre>
          </div>}
          {storageProblem && <div className="docs-notice" role="alert">브라우저 임시 저장 공간이 부족합니다. 이동하기 전에 저장하거나 JSON으로 내보내주세요.</div>}
          {sessionError && <div className="docs-notice" role="alert">{sessionError} · 문서 연결을 확인하고 다시 열어주세요.</div>}
          {manualRecovery && <div className="docs-notice docs-manual-recovery" role="alert"><strong>보관한 수동 편집이 있습니다.</strong><p>이 문서는 공동 편집이 시작되어, 보관한 본문을 서버 문서에 자동으로 덮어쓰지 않았습니다.</p><div><button onClick={() => downloadDocument(`${draft.title}-수동편집-복구.json`, JSON.stringify({ title: draft.title, content: draft.content, plainText: draft.plainText, labels: draft.labels }, null, 2), 'application/json')}>편집 내려받기</button><button onClick={() => void saveCopy()} disabled={saving}>내 편집을 새 문서로 보관</button><button onClick={discardLocal}>편집 버리고 최신본 열기</button></div></div>}

          <div className="docs-paper-scroll">
            <div className="docs-paper">
              <div className="docs-document-meta"><span className={`docs-status-pill ${draft.status === 'published' ? 'is-published' : ''}`}>{draft.status === 'published' ? '공유 표시' : '초안'}</span><span>마지막 수정 {relativeTime(selectedPage.updatedAt)}</span></div>
              <input className="docs-title-input" disabled={restoring} value={draft.title} onChange={event => updateDraft({ title: event.target.value })} placeholder="제목 없는 문서" aria-label="문서 제목" />
              <div className="docs-author-row"><span className="docs-avatar" style={{ background: data.users.find(user => user.id === selectedPage.authorId)?.color || '#78849a' }}>{data.users.find(user => user.id === selectedPage.authorId)?.name.slice(0, 1) || '팀'}</span><span>{data.users.find(user => user.id === selectedPage.authorId)?.name || '팀원'}</span><span className="docs-meta-dot">·</span><span>{when(selectedPage.createdAt)}</span><span className="docs-meta-dot">·</span><span>버전 {draft.expectedVersion}</span></div>
              <DocumentLabels key={`${actorId}:${draft.id}`} labels={draft.labels} activeKey={documentLabel} disabled={restoring}
                onChange={labels => updateDraft({ labels })} onFilter={onChangeDocumentLabel} />

              <div className="docs-editor-toolbar" role="toolbar" aria-label="문서 서식">
                <select disabled={bodyReadOnly} aria-label="문단 서식" value={editor?.isActive('heading', { level: 1 }) ? 'h1' : editor?.isActive('heading', { level: 2 }) ? 'h2' : editor?.isActive('heading', { level: 3 }) ? 'h3' : 'p'} onChange={event => { if (event.target.value === 'p') editor?.chain().focus().setParagraph().run(); else editor?.chain().focus().toggleHeading({ level: Number(event.target.value.slice(1)) as 1 | 2 | 3 }).run(); }}><option value="p">본문</option><option value="h1">제목 1</option><option value="h2">제목 2</option><option value="h3">제목 3</option></select><span className="docs-toolbar-separator" />
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
                {button('이미지 URL 삽입', <ImageIcon size={15} />, () => { setInsertKind('image'); setInsertUrl(''); })}
                <button type="button" className="docs-format-btn" aria-label="참조 새로고침" title="참조 새로고침" disabled={referencesRefreshing} onMouseDown={event => event.preventDefault()} onClick={() => void refreshReferences()}>{referencesRefreshing ? <Loader2 className="docs-spin" size={15} /> : <RefreshCw size={15} />}</button>
                {button('업무 참조 삽입', <Link2 size={15} />, () => openReference('issueReference'))}
                {button('업무 목록 삽입', <ListFilter size={15} />, () => { if (editor) openIssueBlock(editor, 'issueList'); })}
                {button('업무 현황 삽입', <ChartBar size={15} />, () => { if (editor) openIssueBlock(editor, 'issueSummary'); })}
                {button('문서 참조 삽입', <FileText size={15} />, () => openReference('documentReference'))}
                {button('라벨별 문서 목록 삽입', <Files size={15} />, () => insertDocumentList('documentLabelList'))}
                {button('하위 문서 목록 삽입', <ListTree size={15} />, () => insertDocumentList('documentChildList'))}
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
                <DocumentSelectionActions key={`${draft.id}:${liveMode}`} editor={editor} unavailable={selectionUnavailable} issueUnavailable={selectionIssueUnavailable}
                  onCreate={(selection, opener) => { if (selectionDocument) openFollowUp(selectionDocument, opener, selection); }}
                  onLink={(selection, opener) => { if (selectionDocument) openDecisionLink(selectionDocument, opener, selection); }}
                  onComment={(selection, opener) => { if (selectionDocument) openSelectionComment(selectionDocument, opener, selection); }} />
              </div>
              {editor?.isActive('table') && !bodyReadOnly && <div className="docs-table-tools"><button onClick={() => editor.chain().focus().addRowAfter().run()}>행 추가</button><button onClick={() => editor.chain().focus().addColumnAfter().run()}>열 추가</button><button onClick={() => editor.chain().focus().deleteRow().run()}>행 삭제</button><button onClick={() => editor.chain().focus().deleteColumn().run()}>열 삭제</button><button onClick={() => editor.chain().focus().deleteTable().run()}>표 삭제</button></div>}
              {insertKind && <form className="docs-insert-form" onSubmit={insertUrlBlock}><input autoFocus className="field" value={insertUrl} onChange={event => setInsertUrl(event.target.value)} placeholder={insertKind === 'image' ? 'https://… 이미지 주소' : 'https://… 링크 주소'} aria-label={insertKind === 'image' ? '이미지 URL' : '링크 URL'} /><button className="btn btn-primary" type="submit">삽입</button><button className="btn btn-ghost docs-icon-button" type="button" aria-label="삽입 취소" onClick={() => setInsertKind(null)}><X size={15} /></button></form>}
              {draft.id === selectedPage.id && <DocumentEditorOutline key={draft.id} editor={editor}
                documentId={draft.id} projectId={selectedPage.projectId ?? projectId}
                sectionId={publicationOpen ? null : sectionId} savedContent={selectionDocument?.content}
                ready={!liveMode || Boolean(liveState?.ready)} canAssign={!bodyReadOnly && !saving && !conflict && !publicationOpen} />}
              <div ref={editorWrap} className="docs-editor-wrap" onKeyDownCapture={navigateSlash}
                onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSlashQuery(null); }}
                onClick={event => {
                if (!(event.target instanceof Element) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                const href = event.target.closest('a[href]')?.getAttribute('href');
                if (href && /^#\/[^/?#]+\/reports\/(?:[0-9a-f-]{36}|blockers(?:\?[^#]*)?)$/i.test(href)) {
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
                {!bodyReadOnly && matchingSlashCommands.length > 0 && <div className="docs-slash-menu docs-popover" role="group" aria-label="블록 추가" style={{ top: slashTop }}>
                  <div className="docs-slash-caption" aria-hidden="true">블록 추가</div>
                  {matchingSlashCommands.map((command, index) => <button key={command.label} type="button" aria-current={index === slashIndex || undefined}
                    onMouseDown={event => event.preventDefault()} onClick={() => runSlash(command)}>{command.label}</button>)}
                </div>}
              </div>
              <div className="docs-paper-footer"><span>{draft.plainText.trim().length.toLocaleString()}자</span><span>{liveMode ? '본문 자동 동기화 · 제목과 속성은 별도 저장' : '변경 후 저장 버튼 또는 ⌘ / Ctrl + S'}</span></div>
            </div>
          </div>
        </main>

        {sidebarOpen && <aside className="docs-details" aria-label="문서 상세 정보"><div className="docs-detail-tabs">{([{ id: 'comments', label: '댓글', icon: <MessageSquare size={14} /> }, { id: 'links', label: '연결', icon: <Link2 size={14} /> }, { id: 'history', label: '이력', icon: <History size={14} /> }, { id: 'attachments', label: '파일', icon: <Paperclip size={14} /> }, { id: 'source', label: '원본 기록', icon: <FileText size={14} /> }] as const).map(tab => <button key={tab.id} className={sideTab === tab.id ? 'is-active' : ''} onClick={() => { setSideTab(tab.id); }}>{tab.icon}{tab.label}{tab.id === 'comments' && comments.length > 0 && <span>{comments.length}</span>}</button>)}</div>
          <button className="docs-panel-close" aria-label="문서 정보 패널 닫기" onClick={() => setSidebarOpen(false)}><X size={13} /> 패널 닫기</button><div className="docs-detail-content">
            {sideTab === 'links' && <AtlassianLinks targetType="document" targetId={draft.id} actorId={actorId} notify={notify} />}
            {sideTab === 'comments' && <>
              <div className="docs-panel-heading"><h3>팀과 이야기하기</h3><p>문서에 대한 질문과 의견을 남겨주세요.</p></div>
              {commentsLoading && <p className="docs-panel-muted">댓글을 불러오는 중…</p>}
              {commentError && <p className="docs-panel-error" role="alert">{commentError}</p>}
              {!commentsLoading && !commentError && !comments.length && <div className="docs-panel-empty"><MessageSquare size={25} /><strong>아직 댓글이 없어요</strong><span>첫 의견을 남겨 대화를 시작해보세요.</span></div>}
              {comments.map(comment => {
                const user = data.users.find(item => item.id === comment.authorId);
                return <article className="docs-comment" id={`document-comment-${comment.id}`} tabIndex={-1} key={comment.id}>
                  <div className="docs-comment-head">
                    <span className="docs-avatar" style={{ background: user?.color || '#78849a' }}>{user?.name.slice(0, 1) || '팀'}</span>
                    <strong>{user?.name || '팀원'}</strong>
                    <time title={when(comment.createdAt)}>{relativeTime(comment.createdAt)}</time>
                    <CommentTrashButton comment={comment} actorId={actorId} notify={notify} refresh={refresh}
                      disabled={commentBusy || saving || comment.resourceId !== documentId}
                      onArchived={removed => {
                        const current = commentContextRef.current;
                        if (current?.documentId === removed.resourceId && current.actorId === actorId && activeActorRef.current === actorId) {
                          setComments(previous => previous.filter(value => value.id !== removed.id));
                        }
                      }} />
                  </div>
                  {comment.documentSource && <section className="docs-comment-source" aria-label="댓글이 달린 본문">
                    <blockquote>{comment.documentSource.text}</blockquote>
                    <DocumentDecisionRevision data={data} documentId={comment.resourceId} revisionId={comment.documentSource.revisionId}
                      label={selectedPage.title} sourceLabel="댓글 원문 저장본" selection={comment.documentSource} />
                  </section>}
                  <p>{comment.body}</p>
                </article>;
              })}
              <form className="docs-comment-form" onSubmit={submitComment}><textarea className="field" value={commentBody} onChange={event => updateCommentBody(event.target.value)} placeholder="의견을 남겨주세요…" aria-label="새 문서 댓글" rows={4} /><button type="submit" className="btn btn-primary" disabled={!commentBody.trim() || commentBusy}>{commentBusy ? <Loader2 size={13} className="docs-spin" /> : <Send size={13} />} 댓글 남기기</button></form>
            </>}
            {sideTab === 'links' && <>
              <DocumentLinkedWork key={selectedPage.id} data={data} document={selectedPage} openIssue={openIssue}
                refresh={refresh} notify={notify} issueDrawerOpen={issueDrawerOpen}>
                <button className="btn docs-follow-up-button" type="button" disabled={saving || restoring || !data.projects.length || draft.id !== selectedPage.id} onClick={event => openFollowUp(selectedPage, event.currentTarget)}><Plus size={14} aria-hidden="true" /> 후속 업무 만들기</button>
              </DocumentLinkedWork>
              <ResourceLinkPicker key={`${actorId}:${selectedPage.id}`} kind="issue" items={candidateIssues} projects={data.projects}
                busy={linkBusy || draft.id !== selectedPage.id} onLink={linkIssue} />
              <div className="docs-reference-list"><h3>본문에서 참조하는 문서</h3>{!outgoingDocuments.length && <p>본문에 문서 참조나 포함을 추가하면 표시됩니다.</p>}{outgoingDocuments.map(reference => { const page = data.documents.find(value => value.id === reference.id); return <button key={JSON.stringify([reference.id, reference.kind, reference.revisionId])} disabled={!page} onClick={() => page && openDocument(page.id)}><small>{reference.revisionId ? '고정 버전 포함' : reference.kind === 'include' ? '문서 포함' : '문서 참조'}{!page && (reference.revisionId ? ' · 원본 열기 불가' : ' · 찾을 수 없음')}</small><strong>{(reference.revisionId ? reference.label : page?.title) || reference.label || reference.id}</strong></button>; })}</div><div className="docs-reference-list"><h3>이 문서를 참조하는 문서</h3>{!backlinks.length && <p>다른 문서의 참조가 아직 없습니다.</p>}{backlinks.map(page => <button key={page.id} onClick={() => openDocument(page.id)}><small>{contentReferences(page.content).some(reference => reference.id === draft.id && reference.kind === 'include') ? '내 문서를 포함함' : '내 문서를 참조함'}</small><strong>{page.title}</strong></button>)}</div><div className="docs-reference-list"><h3>본문의 업무 참조</h3>{!inlineIssues.length && <p>본문에 삽입한 업무 참조가 없습니다.</p>}{inlineIssues.map(reference => { const issue = data.issues.find(value => value.id === reference.id); return <button key={reference.id} disabled={!issue} onClick={() => issue && openIssue(issue.id)}><small>{issue?.key || '찾을 수 없는 업무'}</small><strong>{issue?.title || reference.label || reference.id}</strong></button>; })}</div><div className="docs-document-properties"><h3>문서 속성</h3><label>상위 문서<select disabled={restoring} className="field" value={draft.parentId || ''} onChange={event => updateDraft({ parentId: event.target.value || null })}><option value="">최상위 문서</option>{parentOptions.map(page => <option key={page.id} value={page.id}>{page.title}</option>)}</select></label><label>작성 상태<select disabled={restoring} className="field" value={draft.status} onChange={event => updateDraft({ status: event.target.value as DocPage['status'] })}><option value="draft">초안</option><option value="published">공유 표시</option></select></label><p className="docs-panel-muted">속성 변경도 저장할 때 반영됩니다.</p><button className="docs-danger-action" onClick={() => void deleteDocument()} disabled={saving}><Trash2 size={13} /> 문서 삭제</button></div></>}
            {sideTab === 'source' && <SourceOrigins resourceType="document" resourceId={draft.id}/>}
            {sideTab === 'attachments' && <><div className="docs-panel-heading"><h3>문서에 자료 모으기</h3><p>파일을 첨부하고 이미지를 본문에 삽입하세요.</p></div><Attachments key={draft.id} resourceType="document" resourceId={draft.id} actorId={actorId} notify={notify} onChanged={refresh} onInsertImage={bodyReadOnly ? undefined : url => { editor?.chain().focus().setImage({ src: url, alt: '첨부 이미지' }).run(); notify(liveMode ? '이미지를 삽입했습니다. 서버 동기화 상태를 확인해주세요.' : '이미지를 삽입했습니다. 문서를 저장하면 반영됩니다.', 'success'); }} /></>}{sideTab === 'history' && <DocumentHistory key={draft.id} revisions={revisions} loading={historyLoading} error={historyError} current={{title:draft.title,content:draft.content,plainText:draft.plainText,version:draft.expectedVersion,dirty:draft.dirty}} users={data.users} onRestore={restoreRevision} restoreDisabled={saving || draft.dirty || Boolean(liveMode && (liveState?.pending || liveState?.phase !== 'connected'))} onSaveCopy={saveCopy} saving={saving} />}
          </div>
        </aside>}
      </> : filtersActive && !visible.length ? <div className="docs-welcome"><div className="docs-welcome-icon"><FileText size={31} /></div><h2>조건에 맞는 문서가 없습니다.</h2></div>
        : <div className="docs-welcome"><div className="docs-welcome-icon"><FileText size={31} /></div><h2>팀의 다음 아이디어를 기록하세요</h2><p>업무와 문서를 연결하면, 결정의 맥락이 남습니다.</p><button className="btn btn-primary" onClick={() => openNew()}><Plus size={16} /> 첫 문서 작성하기</button><div className="docs-welcome-templates">{DOCUMENT_TEMPLATES.filter(template => template.id !== 'blank').map(template => <button key={template.id} onClick={() => openNew('', template.id)}><span>{template.icon}</span><strong>{template.name}</strong><p>{template.description}</p></button>)}</div></div>}
    </div>

    {documentAction?.kind === 'create' && <NewIssueModal data={data} projectId={projectId} actorId={actorId} refresh={refresh} notify={notify} openIssue={openIssue}
      sourceDocument={documentAction.source} onClose={closeDocumentAction} />}
    {documentAction?.kind === 'link' && <DocumentDecisionLinkDialog source={documentAction.source} data={data} actorId={actorId}
      refresh={refresh} notify={notify} onClose={closeDocumentAction} />}
    {documentAction?.kind === 'comment' && <DocumentSelectionCommentDialog source={documentAction.source} initialBody={documentAction.initialBody}
      actorId={actorId} refresh={refresh} notify={notify} onClose={closeDocumentAction} onSaved={showSavedSelectionComment} onReselect={reselectCommentSource} />}
    {publicationOpen && selectedPage && draft?.id === selectedPage.id && <DocumentPublication data={data}
      document={{ ...selectedPage, version: draft.expectedVersion }} actorId={actorId} canRequest={canRequestPublication}
      initialSnapshot={publicationLink} projectId={selectedPage.projectId ?? projectId} sectionId={publicationLink ? sectionId : null} covered={issueDrawerOpen}
      onClose={closePublication} notify={notify} refreshDocument={refresh} />}
    {moveOpen && selectedPage && <DocumentTreeMove key={selectedPage.id} document={selectedPage} documents={data.documents}
      projects={data.projects} beforeApply={moveBlocker} refreshWorkspace={refresh}
      onClose={closeMove} onMoved={moveSaved} />}
    {referenceSelection && referenceSelection.editor === editor && referenceSelection.documentId === draft?.id && <ReferenceChooser selection={referenceSelection} onClose={() => setReferenceSelection(null)} notify={notify} />}
    {issueBlockDialog && <IssueBlockChooser selection={issueBlockDialog} data={data} preferredProjectId={selectedPage?.projectId ?? currentProject?.id ?? null} onClose={closeIssueBlock} />}
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
