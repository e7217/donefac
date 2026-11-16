'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import {
  ArrowDownToLine, ArrowLeft, Bold, Check, CheckCheck, ChevronDown, ChevronRight,
  Code2, FilePlus2, FileText, History, ImageIcon, Italic, Link2, List,
  ListChecks, ListOrdered, Loader2, MessageSquare, PanelRightClose,
  PanelRightOpen, Paperclip, Plus, Quote, RotateCcw, Save, Search, Send, Strikethrough,
  Table2, Trash2, Unlink, X,
} from 'lucide-react';
import type { Comment, DocPage, DocRevision, FeatureProps, RichContent } from '../../shared/types';
import { ApiError, api, post, relativeTime, remove } from '../lib/api';
import { contentMarkdown, contentText, DOCUMENT_TEMPLATES, downloadDocument, templateContent } from './document-utils';
import { Attachments } from './Attachments';
import './documents.css';

type Props = FeatureProps & { selectedDocumentId: string | null; onSelectDocument: (id: string) => void };
type Draft = {
  id: string; title: string; content: RichContent; plainText: string;
  status: DocPage['status']; parentId: string | null; expectedVersion: number;
  dirty: boolean; editSequence: number;
};
type SideTab = 'comments' | 'history' | 'links' | 'attachments';
const cacheKey = (actorId: string, id: string) => `teamspace:document-draft:${actorId}:${id}`;
const commentCacheKey = (actorId: string, id: string) => `teamspace:document-comment-draft:${actorId}:${id}`;
type CommentContext = { actorId: string; documentId: string };
const draftFromPage = (page: DocPage): Draft => ({
  id: page.id, title: page.title, content: page.content, plainText: page.plainText,
  status: page.status, parentId: page.parentId, expectedVersion: page.version, dirty: false, editSequence: 0,
});
const when = (value: string) => new Date(value).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function Documents({ data, projectId, actorId, refresh, notify, openIssue, selectedDocumentId, onSelectDocument }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const actorRef = useRef(actorId);
  const activeActorRef = useRef(actorId);
  activeActorRef.current = actorId;
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const savingRef = useRef(false);
  const [conflict, setConflict] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const [storageProblem, setStorageProblem] = useState(false);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sideTab, setSideTab] = useState<SideTab>('comments');
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentBody, setCommentBody] = useState('');
  const commentBodyRef = useRef('');
  const commentContextRef = useRef<CommentContext | null>(null);
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentError, setCommentError] = useState('');
  const [revisions, setRevisions] = useState<DocRevision[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [previewRevision, setPreviewRevision] = useState<DocRevision | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newParent, setNewParent] = useState('');
  const [newProject, setNewProject] = useState(projectId === 'all' ? '' : projectId);
  const [newTitle, setNewTitle] = useState('');
  const [newTemplate, setNewTemplate] = useState('blank');
  const [creating, setCreating] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [insertKind, setInsertKind] = useState<'link' | 'image' | null>(null);
  const [insertUrl, setInsertUrl] = useState('');
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashTop, setSlashTop] = useState(40);
  const [issueSearch, setIssueSearch] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [, forceToolbar] = useState(0);

  const selectedPage = data.documents.find(page => page.id === selectedDocumentId);
  const currentProject = data.projects.find(project => project.id === projectId);
  const scoped = useMemo(() => data.documents.filter(page => projectId === 'all' || page.projectId === projectId || page.projectId === null), [data.documents, projectId]);

  useEffect(() => { if (window.matchMedia('(max-width: 1180px)').matches) setSidebarOpen(false); }, []);

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
    const next = { ...previous, ...changes, dirty: true, editSequence: previous.editSequence + 1 };
    draftRef.current = next;
    setDraft(next);
    rememberDraft(next);
  }, [rememberDraft]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false } }),
      TableKit.configure({ table: { resizable: true } }),
      TaskList, TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: '내용을 작성하세요. / 를 입력해 블록을 추가할 수 있어요.' }),
      Image.configure({ allowBase64: false }),
    ],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    editorProps: { attributes: { class: 'docs-prose', 'aria-label': '문서 본문' } },
    onUpdate: ({ editor: instance }) => {
      updateDraft({ content: instance.getJSON() as RichContent, plainText: instance.getText() });
      const { $from } = instance.state.selection;
      const before = $from.parent.textContent.slice(0, $from.parentOffset);
      const match = before.match(/^\/([^\s/]*)$/);
      setSlashQuery(match ? match[1] : null);
      if (match) {
        const coordinates = instance.view.coordsAtPos($from.pos);
        setSlashTop(coordinates.bottom - instance.view.dom.getBoundingClientRect().top + 7);
      }
    },
    onSelectionUpdate: () => { forceToolbar(value => value + 1); setSlashQuery(null); },
  });

  useEffect(() => {
    if (!editor || !selectedPage) return;
    const old = draftRef.current;
    const sameActor = actorRef.current === actorId;
    if (old?.id === selectedPage.id && old.dirty && sameActor) return;
    if (old && (old.id !== selectedPage.id || !sameActor)) rememberDraft(old);
    actorRef.current = actorId;
    let next = draftFromPage(selectedPage);
    try {
      const cached = localStorage.getItem(cacheKey(actorId, selectedPage.id));
      if (cached) {
        const candidate = JSON.parse(cached) as Draft;
        if (candidate.id === selectedPage.id && candidate.dirty && candidate.content?.type === 'doc' && Number.isInteger(candidate.expectedVersion)) next = candidate;
      }
    } catch { /* A malformed local draft must not prevent opening a saved document. */ }
    draftRef.current = next;
    setDraft(next);
    editor.commands.setContent(next.content, { emitUpdate: false });
    setConflict(next.dirty && next.expectedVersion !== selectedPage.version);
    setShowLatest(false);
    setPreviewRevision(null);
    setSlashQuery(null);
    setInsertKind(null);
  }, [selectedPage?.id, selectedPage?.version, actorId, editor, rememberDraft]); // Deliberately preserve the local buffer on snapshot refresh.

  useEffect(() => {
    if (!selectedDocumentId && scoped.length) onSelectDocument(scoped[0].id);
  }, [selectedDocumentId, scoped, onSelectDocument]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (draftRef.current?.dirty || commentBodyRef.current.trim()) { rememberDraft(draftRef.current); rememberComment(); event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', handler);
    return () => { window.removeEventListener('beforeunload', handler); rememberDraft(draftRef.current); rememberComment(); };
  }, [rememberDraft, rememberComment]);

  useEffect(() => {
    const guard = (event: Event) => {
      if (savingRef.current) {
        event.preventDefault();
        notify('저장이 끝난 후 이동해주세요.', 'error');
      } else if (draftRef.current?.dirty || commentBodyRef.current.trim()) {
        if (!window.confirm('저장하지 않은 문서 편집 또는 보내지 않은 댓글이 있습니다. 이 브라우저에 임시 보관하고 이동할까요?')) event.preventDefault();
        else { rememberDraft(draftRef.current); rememberComment(); }
      }
    };
    window.addEventListener('teamspace:navigate', guard);
    return () => window.removeEventListener('teamspace:navigate', guard);
  }, [notify, rememberDraft, rememberComment]);

  const saveDraft = useCallback(async (status?: DocPage['status']) => {
    const captured = draftRef.current;
    if (!captured || savingRef.current || (!captured.dirty && (!status || status === captured.status))) return;
    const capturedActor = actorRef.current;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await api<DocPage>(`/documents/${captured.id}`, { method: 'PATCH', headers: { 'X-Actor-Id': capturedActor }, body: JSON.stringify({
        expectedVersion: captured.expectedVersion, title: captured.title.trim() || '제목 없는 문서',
        content: captured.content, plainText: captured.plainText,
        status: status || captured.status, parentId: captured.parentId,
      }) });
      const current = draftRef.current;
      if (current?.id === captured.id && actorRef.current === capturedActor && activeActorRef.current === capturedActor) {
        const next = current.editSequence === captured.editSequence ? draftFromPage(result) : { ...current, expectedVersion: result.version, ...(status && current.status === captured.status ? { status } : {}) };
        draftRef.current = next;
        setDraft(next);
        rememberDraft(next, capturedActor);
        setConflict(false);
      } else {
        // Reconcile only the request owner's cached buffer. A response for a
        // different actor/document must never change the current editor/cache.
        try {
          const key = cacheKey(capturedActor, captured.id);
          const stored = localStorage.getItem(key);
          const cached = stored ? JSON.parse(stored) as Draft : null;
          if (cached?.id === captured.id && cached.expectedVersion === captured.expectedVersion) {
            if (cached.editSequence === captured.editSequence) localStorage.removeItem(key);
            else localStorage.setItem(key, JSON.stringify({ ...cached, expectedVersion: result.version }));
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveDraft(); }
      if (event.key === 'Escape') { setSlashQuery(null); setInsertKind(null); setExportOpen(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [saveDraft]);

  const documentId = draft?.id;
  useEffect(() => {
    if (!documentId) return;
    let active = true;
    rememberComment();
    const context = { actorId, documentId };
    commentContextRef.current = context;
    let cached = '';
    try { cached = localStorage.getItem(commentCacheKey(actorId, documentId)) || ''; } catch { setStorageProblem(true); }
    commentBodyRef.current = cached;
    setComments([]); setCommentBody(cached); setCommentsLoading(true); setCommentError('');
    api<Comment[]>(`/comments?resourceType=document&resourceId=${encodeURIComponent(documentId)}`)
      .then(result => { if (active) setComments(result); })
      .catch(error => { if (active) setCommentError(error instanceof Error ? error.message : '댓글을 불러오지 못했습니다.'); })
      .finally(() => { if (active) setCommentsLoading(false); });
    return () => { active = false; };
  }, [documentId, actorId, rememberComment]);

  useEffect(() => {
    if (!documentId || sideTab !== 'history') return;
    let active = true;
    setHistoryLoading(true); setHistoryError('');
    api<DocRevision[]>(`/documents/${documentId}/revisions`)
      .then(result => { if (active) setRevisions(result); })
      .catch(error => { if (active) setHistoryError(error instanceof Error ? error.message : '이력을 불러오지 못했습니다.'); })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [documentId, draft?.expectedVersion, sideTab]);

  function selectDocument(id: string) {
    if (id === selectedDocumentId) return;
    if (savingRef.current) { notify('저장이 끝난 후 이동해주세요.', 'error'); return; }
    if ((draftRef.current?.dirty || commentBodyRef.current.trim()) && !window.confirm('저장하지 않은 문서 편집 또는 보내지 않은 댓글이 있습니다. 이 브라우저에 임시 보관하고 다른 문서로 이동할까요?')) return;
    rememberDraft(draftRef.current);
    rememberComment();
    onSelectDocument(id);
  }

  function openNew(parentId = '', template = 'blank') {
    const parent = data.documents.find(page => page.id === parentId);
    setNewParent(parentId);
    setNewProject(parent ? parent.projectId || '' : projectId === 'all' ? '' : projectId);
    setNewTemplate(template);
    setNewTitle(template === 'blank' ? '' : DOCUMENT_TEMPLATES.find(item => item.id === template)?.name || '');
    setNewOpen(true);
  }

  async function createDocument(event: React.FormEvent) {
    event.preventDefault();
    if (creating || !newTitle.trim()) return;
    setCreating(true);
    try {
      const parent = data.documents.find(page => page.id === newParent);
      const result = await post<DocPage>('/documents', {
        title: newTitle.trim(), projectId: parent ? parent.projectId : newProject || null,
        parentId: newParent || null, content: templateContent(newTemplate),
        status: 'draft', icon: DOCUMENT_TEMPLATES.find(item => item.id === newTemplate)?.icon || '📄',
      });
      rememberDraft(draftRef.current);
      await refresh();
      setNewOpen(false);
      onSelectDocument(result.id);
      notify('새 문서를 만들었습니다.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : '문서를 만들지 못했습니다.', 'error'); }
    finally { setCreating(false); }
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
        setComments(items => [...items, result]);
        if (commentBodyRef.current.trim() === body) updateCommentBody('');
      } else {
        try {
          const key = commentCacheKey(context.actorId, context.documentId);
          if (localStorage.getItem(key)?.trim() === body) localStorage.removeItem(key);
        } catch { setStorageProblem(true); }
      }
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : '댓글을 등록하지 못했습니다.', 'error'); }
    finally { setCommentBusy(false); }
  }

  async function restoreRevision(revision: DocRevision) {
    const captured = draftRef.current;
    if (!captured || savingRef.current) return;
    const capturedActor = actorRef.current;
    if (captured.dirty) { notify('현재 편집을 먼저 저장하거나 새 문서로 보관해주세요.', 'error'); return; }
    if (!window.confirm(`버전 ${revision.version}의 내용으로 복구할까요? 현재 내용은 이력에 남습니다.`)) return;
    savingRef.current = true; setSaving(true); setRestoring(true);
    // Toggling editability is UI state, not a content edit. Tiptap otherwise
    // emits onUpdate and would mark the newly restored revision dirty again.
    editor?.setEditable(false, false);
    try {
      const result = await post<DocPage>(`/documents/${captured.id}/restore`, { revisionId: revision.id, expectedVersion: captured.expectedVersion });
      if (draftRef.current?.id === captured.id && actorRef.current === capturedActor && activeActorRef.current === capturedActor) {
        const next = draftFromPage(result); draftRef.current = next; setDraft(next); rememberDraft(next, capturedActor);
        editor?.commands.setContent(next.content, { emitUpdate: false }); setPreviewRevision(null); setConflict(false);
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
      const result = await post<DocPage>('/documents', { title: `${captured.title || '제목 없는 문서'} (편집 사본)`, projectId: source?.projectId || null, parentId: source?.parentId || null, content: captured.content, status: 'draft' });
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
    if (data.documents.some(page => page.parentId === captured.id)) { notify('하위 문서를 먼저 이동하거나 삭제해주세요.', 'error'); return; }
    if (!window.confirm(`“${captured.title}” 문서를 삭제할까요?${captured.dirty ? ' 저장하지 않은 편집 내용도 사라집니다.' : ''}`)) return;
    savingRef.current = true; setSaving(true);
    try {
      await remove(`/documents/${captured.id}?expectedVersion=${captured.expectedVersion}`);
      const clean = { ...captured, dirty: false }; rememberDraft(clean, capturedActor);
      rememberComment('', { actorId: capturedActor, documentId: captured.id });
      const sameContext = draftRef.current?.id === captured.id && actorRef.current === capturedActor && activeActorRef.current === capturedActor;
      if (sameContext) { draftRef.current = null; setDraft(null); commentBodyRef.current = ''; setCommentBody(''); }
      await refresh();
      const next = scoped.find(page => page.id !== captured.id);
      if (next && sameContext) onSelectDocument(next.id);
      notify('문서를 삭제했습니다.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : '문서를 삭제하지 못했습니다.', 'error'); }
    finally { savingRef.current = false; setSaving(false); }
  }

  async function linkIssue(issueId: string) {
    if (!draft || linkBusy) return;
    setLinkBusy(true);
    try { await post('/resource-links', { issueId, documentId: draft.id, kind: 'related' }); setIssueSearch(''); await refresh(); notify('업무와 문서를 연결했습니다.', 'success'); }
    catch (error) { notify(error instanceof Error ? error.message : '업무를 연결하지 못했습니다.', 'error'); }
    finally { setLinkBusy(false); }
  }

  function discardLocal() {
    if (!selectedPage || !window.confirm('저장하지 않은 편집을 버리고 서버에 저장된 내용을 열까요?')) return;
    const next = draftFromPage(selectedPage); draftRef.current = next; setDraft(next); rememberDraft(next);
    editor?.commands.setContent(next.content, { emitUpdate: false }); setConflict(false); setShowLatest(false);
  }

  function insertUrlBlock(event: React.FormEvent) {
    event.preventDefault();
    let url: URL;
    try { url = new URL(insertUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
    catch { notify('http 또는 https 주소를 입력해주세요.', 'error'); return; }
    if (insertKind === 'image') editor?.chain().focus().setImage({ src: url.href, alt: '문서 이미지' }).run();
    else editor?.chain().focus().extendMarkRange('link').setLink({ href: url.href }).run();
    setInsertKind(null); setInsertUrl('');
  }

  const slashCommands = [
    { label: '제목 1', search: 'h1 heading 제목', action: () => editor?.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: '제목 2', search: 'h2 heading 제목', action: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: '글머리 목록', search: 'list bullet 목록', action: () => editor?.chain().focus().toggleBulletList().run() },
    { label: '체크리스트', search: 'task check 할일 체크', action: () => editor?.chain().focus().toggleTaskList().run() },
    { label: '인용', search: 'quote 인용', action: () => editor?.chain().focus().toggleBlockquote().run() },
    { label: '코드 블록', search: 'code 코드', action: () => editor?.chain().focus().toggleCodeBlock().run() },
    { label: '표', search: 'table 표', action: () => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { label: '구분선', search: 'divider 구분선', action: () => editor?.chain().focus().setHorizontalRule().run() },
  ];

  function runSlash(action: () => unknown) {
    if (!editor) return;
    const { $from } = editor.state.selection;
    editor.chain().focus().deleteRange({ from: $from.start(), to: $from.pos }).run();
    action(); setSlashQuery(null);
  }

  const linkedIssues = data.resourceLinks.filter(link => link.documentId === draft?.id).map(link => data.issues.find(issue => issue.id === link.issueId)).filter(issue => issue !== undefined);
  const candidateIssues = data.issues.filter(issue => !linkedIssues.some(linked => linked.id === issue.id) && `${issue.key} ${issue.title}`.toLowerCase().includes(issueSearch.toLowerCase())).slice(0, 6);
  const descendants = new Set<string>();
  const collectDescendants = (id: string) => { for (const child of data.documents.filter(page => page.parentId === id)) if (!descendants.has(child.id)) { descendants.add(child.id); collectDescendants(child.id); } };
  if (draft) collectDescendants(draft.id);
  const parentOptions = data.documents.filter(page => page.id !== draft?.id && !descendants.has(page.id) && page.projectId === selectedPage?.projectId);
  const visible = scoped.filter(page => page.title.toLowerCase().includes(search.toLowerCase()));
  const tree = (pages: DocPage[], parentId: string | null = null, level = 0, visited = new Set<string>()): React.ReactNode => pages
    .filter(page => search ? level === 0 : (page.parentId === parentId || (parentId === null && !pages.some(other => other.id === page.parentId))))
    .map(page => {
      if (visited.has(page.id)) return null;
      const nextVisited = new Set(visited); nextVisited.add(page.id);
      const children = pages.some(other => other.parentId === page.id);
      return <div key={page.id}>
        <div className={`docs-tree-row ${draft?.id === page.id ? 'is-selected' : ''}`} style={{ paddingLeft: 10 + level * 15 }}>
          <button type="button" className="docs-tree-toggle" aria-label={`${page.title} ${collapsed.has(page.id) ? '펼치기' : '접기'}`} disabled={!children || Boolean(search)} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(page.id)) next.delete(page.id); else next.add(page.id); return next; })}>{children && !search ? collapsed.has(page.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} /> : <span />}</button>
          <button type="button" className="docs-tree-link" onClick={() => selectDocument(page.id)}><span className="docs-page-icon">{page.icon || '📄'}</span><span>{page.title || '제목 없는 문서'}</span>{page.status === 'draft' && <span className="docs-draft-dot" title="초안" />}</button>
          <button type="button" className="docs-tree-add" title="하위 문서 만들기" aria-label={`${page.title} 하위 문서 만들기`} onClick={() => openNew(page.id)}><Plus size={13} /></button>
        </div>
        {!search && !collapsed.has(page.id) && tree(pages, page.id, level + 1, nextVisited)}
      </div>;
    });

  const button = (label: string, icon: React.ReactNode, onClick: () => unknown, active = false) => <button type="button" className={`docs-format-btn ${active ? 'is-active' : ''}`} title={label} aria-label={label} onMouseDown={event => event.preventDefault()} onClick={onClick}>{icon}</button>;

  return <section className="documents-feature">
    <div className="docs-heading"><div><div className="docs-eyebrow">KNOWLEDGE</div><h1>문서 <span>{scoped.length}</span></h1><p>아이디어부터 결정까지, 팀의 지식을 한곳에.</p></div><button className="btn btn-primary" onClick={() => openNew()}><Plus size={16} /> 새 문서</button></div>
    <div className={`docs-layout ${sidebarOpen ? 'has-panel' : ''}`}>
      <aside className="docs-tree" aria-label="문서 목록">
        <label className="docs-tree-search"><Search size={14} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="문서 찾기" aria-label="문서 찾기" /></label>
        <div className="docs-tree-content">
          <div className="docs-tree-group"><span>{currentProject?.name || '프로젝트 문서'}</span><button aria-label="프로젝트 문서 추가" onClick={() => openNew()}><Plus size={14} /></button></div>
          {tree(visible.filter(page => page.projectId !== null))}
          {!visible.some(page => page.projectId !== null) && <p className="docs-tree-empty">{search ? '검색 결과가 없어요.' : '첫 문서를 작성해보세요.'}</p>}
          <div className="docs-tree-group docs-tree-common"><span>팀 공통 문서</span><button aria-label="팀 공통 문서 추가" onClick={() => { openNew(); setNewProject(''); }}><Plus size={14} /></button></div>
          {tree(visible.filter(page => page.projectId === null))}
          {!visible.some(page => page.projectId === null) && <p className="docs-tree-empty">함께 참고하는 지식을 모아보세요.</p>}
        </div>
        <button className="docs-template-shortcut" onClick={() => openNew('', 'meeting')}><FilePlus2 size={16} /><span>템플릿으로 시작하기</span><ChevronRight size={14} /></button>
      </aside>

      {draft && selectedPage ? <>
        <main className="docs-document">
          <div className="docs-document-topbar">
            <div className="docs-breadcrumb"><FileText size={14} /><span>{selectedPage.projectId ? data.projects.find(project => project.id === selectedPage.projectId)?.name || '프로젝트' : '팀 공통'}</span><ChevronRight size={12} /><span>{draft.title || '제목 없는 문서'}</span></div>
            <div className="docs-top-actions"><span className={`docs-save-state ${draft.dirty ? 'is-dirty' : ''}`} aria-live="polite">{saving ? <><Loader2 size={12} className="docs-spin" /> 저장 중</> : draft.dirty ? <><span /> 저장 필요</> : <><CheckCheck size={13} /> 저장됨</>}</span>
              <div className="docs-export-container"><button className="btn btn-ghost docs-icon-button" title="문서 내보내기" aria-label="문서 내보내기" onClick={() => setExportOpen(value => !value)}><ArrowDownToLine size={16} /></button>{exportOpen && <div className="docs-popover docs-export-menu"><button onClick={() => { downloadDocument(`${draft.title || 'document'}.md`, `# ${draft.title}\n\n${contentMarkdown(draft.content)}`, 'text/markdown;charset=utf-8'); setExportOpen(false); }}>Markdown 내보내기</button><button onClick={() => { downloadDocument(`${draft.title || 'document'}.json`, JSON.stringify({ format: 'teamspace-document', schemaVersion: 1, document: { ...selectedPage, title: draft.title, content: draft.content, plainText: draft.plainText, status: draft.status, parentId: draft.parentId } }, null, 2), 'application/json'); setExportOpen(false); }}>문서 JSON 내보내기</button></div>}</div>
              <button className="btn btn-ghost docs-icon-button" title={sidebarOpen ? '정보 패널 닫기' : '정보 패널 열기'} aria-label={sidebarOpen ? '정보 패널 닫기' : '정보 패널 열기'} onClick={() => setSidebarOpen(value => !value)}>{sidebarOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button>
              <button className="btn btn-primary docs-save-button" disabled={saving || !draft.dirty} onClick={() => void saveDraft()}><Save size={14} /> 저장</button>
            </div>
          </div>

          {conflict && <div className="docs-notice docs-conflict" role="alert"><strong>다른 변경사항이 있어요.</strong><span>내 편집은 유지했습니다. 최신본을 확인한 후 정리해주세요.</span><div><button onClick={() => setShowLatest(value => !value)}>서버 최신본 보기</button><button onClick={() => void saveCopy()} disabled={saving}>내 편집을 새 문서로 보관</button><button onClick={discardLocal}>편집 버리고 최신본 열기</button></div></div>}
          {showLatest && <div className="docs-latest-preview"><div><strong>서버 버전 {selectedPage.version} · {selectedPage.title}</strong><button aria-label="최신본 미리보기 닫기" onClick={() => setShowLatest(false)}><X size={14} /></button></div><pre>{selectedPage.plainText || contentText(selectedPage.content)}</pre></div>}
          {storageProblem && <div className="docs-notice" role="alert">브라우저 임시 저장 공간이 부족합니다. 이동하기 전에 저장하거나 JSON으로 내보내주세요.</div>}

          <div className="docs-paper-scroll">
            <div className="docs-paper">
              <div className="docs-document-meta"><span className={`docs-status-pill ${draft.status === 'published' ? 'is-published' : ''}`}>{draft.status === 'published' ? '게시됨' : '초안'}</span><span>마지막 수정 {relativeTime(selectedPage.updatedAt)}</span></div>
              <input className="docs-title-input" disabled={restoring} value={draft.title} onChange={event => updateDraft({ title: event.target.value })} placeholder="제목 없는 문서" aria-label="문서 제목" />
              <div className="docs-author-row"><span className="docs-avatar" style={{ background: data.users.find(user => user.id === selectedPage.authorId)?.color || '#78849a' }}>{data.users.find(user => user.id === selectedPage.authorId)?.name.slice(0, 1) || '팀'}</span><span>{data.users.find(user => user.id === selectedPage.authorId)?.name || '팀원'}</span><span className="docs-meta-dot">·</span><span>{when(selectedPage.createdAt)}</span><span className="docs-meta-dot">·</span><span>버전 {draft.expectedVersion}</span></div>

              <div className="docs-editor-toolbar" role="toolbar" aria-label="문서 서식">
                <select aria-label="문단 서식" value={editor?.isActive('heading', { level: 1 }) ? 'h1' : editor?.isActive('heading', { level: 2 }) ? 'h2' : editor?.isActive('heading', { level: 3 }) ? 'h3' : 'p'} onChange={event => { if (event.target.value === 'p') editor?.chain().focus().setParagraph().run(); else editor?.chain().focus().toggleHeading({ level: Number(event.target.value.slice(1)) as 1 | 2 | 3 }).run(); }}><option value="p">본문</option><option value="h1">제목 1</option><option value="h2">제목 2</option><option value="h3">제목 3</option></select><span className="docs-toolbar-separator" />
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
                {button('파일 첨부', <Paperclip size={15} />, () => { setSidebarOpen(true); setSideTab('attachments'); })}
              </div>
              {editor?.isActive('table') && <div className="docs-table-tools"><button onClick={() => editor.chain().focus().addRowAfter().run()}>행 추가</button><button onClick={() => editor.chain().focus().addColumnAfter().run()}>열 추가</button><button onClick={() => editor.chain().focus().deleteRow().run()}>행 삭제</button><button onClick={() => editor.chain().focus().deleteColumn().run()}>열 삭제</button><button onClick={() => editor.chain().focus().deleteTable().run()}>표 삭제</button></div>}
              {insertKind && <form className="docs-insert-form" onSubmit={insertUrlBlock}><input autoFocus className="field" value={insertUrl} onChange={event => setInsertUrl(event.target.value)} placeholder={insertKind === 'image' ? 'https://… 이미지 주소' : 'https://… 링크 주소'} aria-label={insertKind === 'image' ? '이미지 URL' : '링크 URL'} /><button className="btn btn-primary" type="submit">삽입</button><button className="btn btn-ghost docs-icon-button" type="button" aria-label="삽입 취소" onClick={() => setInsertKind(null)}><X size={15} /></button></form>}
              <div className="docs-editor-wrap"><EditorContent editor={editor} />{slashQuery !== null && <div className="docs-slash-menu docs-popover" style={{ top: slashTop }}><div className="docs-slash-caption">블록 추가</div>{slashCommands.filter(command => `${command.label} ${command.search}`.toLowerCase().includes(slashQuery.toLowerCase())).map(command => <button key={command.label} onMouseDown={event => event.preventDefault()} onClick={() => runSlash(command.action)}>{command.label}<span>추가</span></button>)}</div>}</div>
              <div className="docs-paper-footer"><span>{draft.plainText.trim().length.toLocaleString()}자</span><span>변경 후 저장 버튼 또는 ⌘ / Ctrl + S</span></div>
            </div>
          </div>
        </main>

        {sidebarOpen && <aside className="docs-details" aria-label="문서 상세 정보"><div className="docs-detail-tabs">{([{ id: 'comments', label: '댓글', icon: <MessageSquare size={14} /> }, { id: 'links', label: '연결', icon: <Link2 size={14} /> }, { id: 'history', label: '이력', icon: <History size={14} /> }, { id: 'attachments', label: '파일', icon: <Paperclip size={14} /> }] as const).map(tab => <button key={tab.id} className={sideTab === tab.id ? 'is-active' : ''} onClick={() => { setSideTab(tab.id); setPreviewRevision(null); }}>{tab.icon}{tab.label}{tab.id === 'comments' && comments.length > 0 && <span>{comments.length}</span>}</button>)}</div>
          <button className="docs-panel-close" aria-label="문서 정보 패널 닫기" onClick={() => setSidebarOpen(false)}><X size={13} /> 패널 닫기</button><div className="docs-detail-content">
            {sideTab === 'comments' && <><div className="docs-panel-heading"><h3>팀과 이야기하기</h3><p>문서에 대한 질문과 의견을 남겨주세요.</p></div>{commentsLoading && <p className="docs-panel-muted">댓글을 불러오는 중…</p>}{commentError && <p className="docs-panel-error" role="alert">{commentError}</p>}{!commentsLoading && !commentError && !comments.length && <div className="docs-panel-empty"><MessageSquare size={25} /><strong>아직 댓글이 없어요</strong><span>첫 의견을 남겨 대화를 시작해보세요.</span></div>}{comments.map(comment => { const user = data.users.find(item => item.id === comment.authorId); return <article className="docs-comment" key={comment.id}><div className="docs-comment-head"><span className="docs-avatar" style={{ background: user?.color || '#78849a' }}>{user?.name.slice(0, 1) || '팀'}</span><strong>{user?.name || '팀원'}</strong><time title={when(comment.createdAt)}>{relativeTime(comment.createdAt)}</time></div><p>{comment.body}</p></article>; })}<form className="docs-comment-form" onSubmit={submitComment}><textarea className="field" value={commentBody} onChange={event => updateCommentBody(event.target.value)} placeholder="의견을 남겨주세요…" aria-label="새 문서 댓글" rows={4} /><button type="submit" className="btn btn-primary" disabled={!commentBody.trim() || commentBusy}>{commentBusy ? <Loader2 size={13} className="docs-spin" /> : <Send size={13} />} 댓글 남기기</button></form></>}
            {sideTab === 'links' && <><div className="docs-panel-heading"><h3>연결된 업무</h3><p>문서의 맥락을 실제 업무와 연결하세요.</p></div>{!linkedIssues.length && <div className="docs-panel-empty"><Link2 size={25} /><strong>연결된 업무가 없어요</strong><span>관련 업무를 검색해 연결할 수 있어요.</span></div>}{linkedIssues.map(issue => <button key={issue.id} className="docs-linked-issue" onClick={() => openIssue(issue.id)}><span>{issue.key}<ChevronRight size={12} /></span><strong>{issue.title}</strong></button>)}<label className="docs-issue-search"><Search size={14} /><input value={issueSearch} onChange={event => setIssueSearch(event.target.value)} placeholder="업무 번호 또는 제목 검색" aria-label="연결할 업무 검색" /></label>{issueSearch && <div className="docs-issue-results">{candidateIssues.length ? candidateIssues.map(issue => <button key={issue.id} onClick={() => void linkIssue(issue.id)} disabled={linkBusy}><span>{issue.key}</span><strong>{issue.title}</strong><Plus size={14} /></button>) : <p className="docs-panel-muted">연결할 수 있는 업무가 없습니다.</p>}</div>}<div className="docs-document-properties"><h3>문서 속성</h3><label>상위 문서<select disabled={restoring} className="field" value={draft.parentId || ''} onChange={event => updateDraft({ parentId: event.target.value || null })}><option value="">최상위 문서</option>{parentOptions.map(page => <option key={page.id} value={page.id}>{page.title}</option>)}</select></label><label>상태<select disabled={restoring} className="field" value={draft.status} onChange={event => updateDraft({ status: event.target.value as DocPage['status'] })}><option value="draft">초안</option><option value="published">게시됨</option></select></label><p className="docs-panel-muted">속성 변경도 저장할 때 반영됩니다.</p><button className="docs-danger-action" onClick={() => void deleteDocument()} disabled={saving}><Trash2 size={13} /> 문서 삭제</button></div></>}
            {sideTab === 'attachments' && <><div className="docs-panel-heading"><h3>문서에 자료 모으기</h3><p>파일을 첨부하고 이미지를 본문에 삽입하세요.</p></div><Attachments key={draft.id} resourceType="document" resourceId={draft.id} actorId={actorId} notify={notify} onChanged={refresh} onInsertImage={restoring ? undefined : url => { editor?.chain().focus().setImage({ src: url, alt: '첨부 이미지' }).run(); notify('이미지를 삽입했습니다. 문서를 저장하면 반영됩니다.', 'success'); }} /></>}{sideTab === 'history' && <><div className="docs-panel-heading"><h3>문서 변경 이력</h3><p>저장된 내용을 확인하고 이전 버전으로 복구하세요.</p></div>{draft.dirty && <div className="docs-history-hint">현재 편집을 저장한 후 이전 버전으로 복구할 수 있어요.<button onClick={() => void saveCopy()} disabled={saving}>편집을 새 문서로 보관</button></div>}{historyLoading && <p className="docs-panel-muted">이력을 불러오는 중…</p>}{historyError && <p className="docs-panel-error" role="alert">{historyError}</p>}{previewRevision ? <div className="docs-history-preview"><button className="docs-history-back" onClick={() => setPreviewRevision(null)}><ArrowLeft size={13} /> 이력 목록</button><strong>버전 {previewRevision.version}</strong><h4>{previewRevision.title}</h4><time>{when(previewRevision.createdAt)}</time><pre>{previewRevision.plainText || contentText(previewRevision.content)}</pre><button className="btn btn-primary" disabled={saving || draft.dirty} onClick={() => void restoreRevision(previewRevision)}><RotateCcw size={13} /> 이 버전으로 복구</button></div> : revisions.map(revision => <button className="docs-revision" key={revision.id} onClick={() => setPreviewRevision(revision)}><div className="docs-revision-icon"><History size={15} /></div><div><strong>버전 {revision.version}{revision.version === draft.expectedVersion && <span>현재</span>}</strong><p>{revision.summary || revision.title}</p><time>{when(revision.createdAt)} · {data.users.find(user => user.id === revision.authorId)?.name || '팀원'}</time></div><ChevronRight size={13} /></button>)}{!historyLoading && !historyError && !revisions.length && <p className="docs-panel-muted">저장된 이력이 없습니다.</p>}</>}
          </div>
        </aside>}
      </> : <div className="docs-welcome"><div className="docs-welcome-icon"><FileText size={31} /></div><h2>팀의 다음 아이디어를 기록하세요</h2><p>업무와 문서를 연결하면, 결정의 맥락이 남습니다.</p><button className="btn btn-primary" onClick={() => openNew()}><Plus size={16} /> 첫 문서 작성하기</button><div className="docs-welcome-templates">{DOCUMENT_TEMPLATES.filter(template => template.id !== 'blank').map(template => <button key={template.id} onClick={() => openNew('', template.id)}><span>{template.icon}</span><strong>{template.name}</strong><p>{template.description}</p></button>)}</div></div>}
    </div>

    {newOpen && <div className="docs-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !creating) setNewOpen(false); }}><form className="docs-create-modal" role="dialog" aria-modal="true" aria-labelledby="docs-create-title" onSubmit={createDocument}><div className="docs-modal-header"><div><div className="docs-eyebrow">NEW DOCUMENT</div><h2 id="docs-create-title">새 문서 만들기</h2></div><button type="button" className="btn btn-ghost docs-icon-button" aria-label="닫기" disabled={creating} onClick={() => setNewOpen(false)}><X size={19} /></button></div><label className="docs-modal-label">문서 제목<input autoFocus className="field" placeholder="어떤 이야기를 기록할까요?" value={newTitle} onChange={event => setNewTitle(event.target.value)} required maxLength={240} /></label><div className="docs-template-grid">{DOCUMENT_TEMPLATES.map(template => <button type="button" className={newTemplate === template.id ? 'is-selected' : ''} key={template.id} onClick={() => { setNewTemplate(template.id); if (!newTitle || DOCUMENT_TEMPLATES.some(item => item.name === newTitle)) setNewTitle(template.id === 'blank' ? '' : template.name); }}><span>{template.icon}</span><strong>{template.name}</strong><small>{template.description}</small>{newTemplate === template.id && <Check size={14} />}</button>)}</div><div className="docs-location-fields"><label className="docs-modal-label">공간<select className="field" disabled={Boolean(newParent)} value={newProject} onChange={event => { setNewProject(event.target.value); setNewParent(''); }}><option value="">팀 공통 문서</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label className="docs-modal-label">상위 문서<select className="field" value={newParent} onChange={event => setNewParent(event.target.value)}><option value="">최상위에 만들기</option>{data.documents.filter(page => page.projectId === (newProject || null)).map(page => <option key={page.id} value={page.id}>{page.title}</option>)}</select></label></div><div className="docs-modal-footer"><button className="btn btn-ghost" type="button" disabled={creating} onClick={() => setNewOpen(false)}>취소</button><button className="btn btn-primary" type="submit" disabled={!newTitle.trim() || creating}>{creating ? <Loader2 size={14} className="docs-spin" /> : <Plus size={14} />} 문서 만들기</button></div></form></div>}
  </section>;
}
