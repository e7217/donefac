'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import { Download, Loader2, RotateCcw, Users, WifiOff } from 'lucide-react';
import type { CollaborationSession } from '../../shared/collaboration';
import type { DocPage, RichContent } from '../../shared/types';
import { documentPlainText } from '../../shared/document-nodes';
import { decorateDocumentExtensions } from './DocumentBlocks';
import { documentFindExtension } from './document-find';
import { createEditorExtensions } from '../../shared/editor-schema';
import { api, ApiError } from '../lib/api';
import { CollaborationClient, hasPendingCollaboration, type CollaborationView } from '../lib/collaboration-client';
import { OrderedCollaboration } from '../lib/collaboration-order-binding';
import { collaborativeCursors, publishEditorCursor } from './CollaborationCursors';
import { downloadDocument } from './document-utils';

const COPY_OPEN_AGAIN = '사본을 저장했습니다. 사본으로 보관을 눌러 다시 열어 주세요.';

export interface CollaborativeEditorProps {
  session: CollaborationSession;
  actorId: string;
  labels: string[];
  locked?: boolean;
  onEditor: (editor: Editor | null) => void;
  onContent: (content: RichContent, plainText: string) => void;
  onDocument: (document: DocPage) => void;
  onState: (state: CollaborationView | null) => void;
  onSessionDisabled: (session: CollaborationSession) => void;
  onOpenCopy: (documentId: string, finishRecovery: () => void) => Promise<boolean>;
  notify: (message: string, kind?: 'success' | 'error') => void;
}

export function CollaborativeEditor(props: CollaborativeEditorProps) {
  const { session, actorId, labels, onState, onDocument, onEditor, onSessionDisabled, onOpenCopy, notify } = props;
  const [client, setClient] = useState<CollaborationClient | null>(null);
  const [view, setView] = useState<CollaborationView | null>(null);
  const [restart, setRestart] = useState(0);
  const [error, setError] = useState('');
  const [copyError, setCopyError] = useState('');
  const [busy, setBusy] = useState(false);
  const editorRef = useRef<Editor | null>(null);

  const restartSession = useCallback(() => {
    const editor = editorRef.current;
    if (editor && !editor.isDestroyed) editor.setEditable(false, false);
    setClient(null); setView(null); setError(''); setCopyError('');
    onEditor(null); onState(null);
    setRestart(value => value + 1);
  }, [onEditor, onState]);

  useEffect(() => {
    let active = true;
    let owned: CollaborationClient | null = null;
    onEditor(null); onState(null);
    const connect = async () => {
      const current = await api<CollaborationSession>(`/documents/${session.document.id}/collaboration`);
      if (!active) return;
      if (!current.enabled && !hasPendingCollaboration(actorId, current.document.id)) { onSessionDisabled(current); return; }
      owned = new CollaborationClient(current, actorId, state => { if (active) { setView(state); onState(state); } }, onDocument, {
        isComposing: () => {
          const editor = editorRef.current;
          return Boolean(editor && !editor.isDestroyed && editor.view.composing);
        },
        restart: () => { if (active) restartSession(); },
      });
      setClient(owned);
      owned.start();
    };
    void connect().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '공동 편집에 연결하지 못했습니다.'); });
    return () => { active = false; owned?.destroy(); onEditor(null); onState(null); };
  }, [session.document.id, session.epoch, actorId, restart, onDocument, onEditor, onState, onSessionDisabled, restartSession]);

  const receiveEditor = useCallback((editor: Editor | null) => { editorRef.current = editor; onEditor(editor); }, [onEditor]);

  function downloadRecovery() {
    if (!client) return;
    const payload = { ...client.exportPending(), title: session.document.title, content: editorRef.current?.getJSON() || null, labels };
    downloadDocument(`${session.document.title || 'document'}-공동편집-복구.json`, JSON.stringify(payload, null, 2), 'application/json');
  }

  function discardRecovery() {
    if (!client || busy) return;
    if (!window.confirm('화면에 표시된 보관 편집을 버릴까요? 필요한 내용은 먼저 내려받거나 사본으로 보관해주세요.')) return;
    try { client.discardDisplayedPending(); restartSession(); }
    catch { notify('임시 편집을 정리하지 못했습니다. 복구 데이터를 먼저 내려받아주세요.', 'error'); }
  }

  async function saveRecoveryCopy() {
    const editor = editorRef.current;
    if (!client || !editor || busy) return;
    setBusy(true);
    setCopyError('');
    let saved = false;
    try {
      const path = `/documents/${encodeURIComponent(session.document.id)}/recovery-copy`;
      const document = await api<DocPage>(path, { method: 'POST', headers: { 'X-Actor-Id': actorId },
        body: JSON.stringify({ epoch: client.view.epoch, content: editor.getJSON(), labels }) });
      if (!document?.id || document.authorId !== actorId) throw new Error('Invalid recovery copy');
      saved = true;
      if (editorRef.current !== editor) return;
      const opened = await onOpenCopy(document.id, () => {
        try {
          client.discardDisplayedPending();
          notify('이전 편집을 새 문서에 보관했습니다.', 'success');
        } catch { notify('사본을 저장했습니다. 브라우저에 남은 보관 편집을 다시 확인해 주세요.', 'error'); }
      });
      if (!opened && editorRef.current === editor) setCopyError(COPY_OPEN_AGAIN);
    } catch (cause) {
      setCopyError(saved ? COPY_OPEN_AGAIN :
        cause instanceof ApiError ? cause.message : '복구 사본의 저장 결과를 확인하지 못했습니다. 같은 편집으로 다시 시도할 수 있습니다.');
    }
    finally { setBusy(false); }
  }

  const peers = view ? [...new Map(view.peers.map(peer => [peer.actorId, peer])).values()] : [];
  const recovery = view?.phase === 'recovery' || view?.phase === 'error';
  const otherRecoveries = view?.otherRecoveries ?? 0;
  return <div className="docs-collaborative-editor">
    <div className={`docs-collaboration-bar ${view?.phase || 'connecting'}`} role="status" aria-live="polite">
      <span className="docs-collaboration-state">{view?.phase === 'connected' ? <span className="docs-live-dot" /> : view?.phase === 'offline' ? <WifiOff size={13} /> : <Loader2 size={13} className={recovery ? '' : 'docs-spin'} />}
        {error || (view?.phase === 'connected' ? view.pending ? '변경 전송 중' : '서버에 동기화됨' : view?.phase === 'offline' ? view.pending ? '연결 끊김 · 편집 보관 중' : '연결 끊김' : recovery ? '편집 복구 필요' : '공동 편집 연결 중')}
      </span>
      {view?.phase === 'connected' && <span className="docs-collaboration-presence"><Users size={13} /><span>{peers.length}명 접속</span><span className="docs-peer-avatars">{peers.map(peer => <span key={peer.actorId} style={{ background: peer.color }} title={peer.name} aria-label={`${peer.name} 접속 중`}>{peer.name.slice(0, 1)}</span>)}</span></span>}
    </div>
    {view?.storageError && <div className="docs-notice" role="alert">브라우저에 편집을 임시 보관하지 못했습니다. 서버 동기화가 끝나기 전에 이 화면을 닫지 말고 복구 데이터를 내려받아주세요.<button className="docs-collab-text-button" onClick={downloadRecovery}><Download size={12} /> 복구 데이터 내려받기</button></div>}
    {recovery && <div className="docs-notice docs-collaboration-recovery" role="alert">
      <strong>{view?.error || '문서가 교체되어 이전 편집을 자동으로 합치지 않았습니다.'}</strong>
      {copyError && <p>{copyError}</p>}
      {otherRecoveries > 0 && <p>별도로 보관된 편집 {otherRecoveries}건이 있습니다.</p>}
      <div>
        <button onClick={downloadRecovery}><Download size={12} /> 복구 데이터 내려받기</button>
        <button onClick={() => void saveRecoveryCopy()} disabled={busy || !view?.ready}>사본으로 보관</button>
        <button onClick={discardRecovery} disabled={busy}><RotateCcw size={12} />{otherRecoveries > 0 ? '이 편집 버리기' : '최신 문서 열기'}</button>
      </div>
    </div>}
    {client && view?.ready ? <LiveBinding key={view.epoch} {...props} client={client} connected={view.phase === 'connected'} readOnly={Boolean(recovery || props.locked)} onEditor={receiveEditor} /> : <div className="docs-collaboration-loading">{error ? <><p>{error}</p><button className="btn" onClick={restartSession}>다시 연결</button></> : recovery ? <p>보관한 데이터 형식을 확인해야 합니다. 복구 데이터를 내려받아 보존해주세요.</p> : <><Loader2 size={20} className="docs-spin" /><p>서버의 문서를 불러오고 있어요.</p></>}</div>}
  </div>;
}

function LiveBinding({ client, connected, readOnly, onEditor, onContent }: CollaborativeEditorProps & { client: CollaborationClient; connected: boolean; readOnly: boolean }) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      ...decorateDocumentExtensions(createEditorExtensions({ collaboration: true })),
      documentFindExtension,
      OrderedCollaboration.configure({ document: client.doc, field: 'default' }),
      collaborativeCursors(client),
      Placeholder.configure({ placeholder: '함께 내용을 작성하세요. /로 블록을 추가하고 @로 문서를 연결하세요.' }),
    ],
    // No JSON `content`: only the server welcome/update may seed this Y.Doc.
    editable: !readOnly,
    enableContentCheck: true,
    editorProps: { attributes: { class: 'docs-prose docs-live-prose', 'aria-label': '공동 편집 문서 본문' } },
    onUpdate: ({ editor: instance }) => onContent(instance.getJSON() as RichContent, documentPlainText(instance.getJSON() as RichContent)),
    onCreate: ({ editor: instance }) => onContent(instance.getJSON() as RichContent, documentPlainText(instance.getJSON() as RichContent)),
    onContentError: ({ disableCollaboration }) => {
      client.fail('지원하지 않는 문서 형식을 발견해 편집을 중단했습니다. 복구 데이터를 보존하고 문서 형식을 확인해주세요.');
      disableCollaboration();
    },
  });
  useEffect(() => { onEditor(editor); return () => onEditor(null); }, [editor, onEditor]);
  useEffect(() => { editor?.setEditable(!readOnly, false); }, [editor, readOnly]);
  useEffect(() => {
    if (editor && !editor.isDestroyed) publishEditorCursor(editor.view, client);
  }, [editor, client, connected, readOnly]);
  return <div className="docs-live-editor">
    <EditorContent editor={editor} />
    <div className="docs-remote-carets" aria-hidden="true" />
  </div>;
}
