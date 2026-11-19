import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { MAX_COLLABORATION_CURSOR_BYTES, type CollaborationPeer } from '../../shared/collaboration';
import { decodeBytes, encodeBytes, type CollaborationClient } from '../lib/collaboration-client';

const cursorKey = new PluginKey<DecorationSet>('teamspace-remote-cursors');
const rootName = 'default';
const cursorBase64Limit = Math.ceil(MAX_COLLABORATION_CURSOR_BYTES / 3) * 4;

function decodePosition(value: string): Y.RelativePosition | null {
  if (typeof value !== 'string' || !value || value.length > cursorBase64Limit) return null;
  const bytes = decodeBytes(value);
  if (bytes.length > MAX_COLLABORATION_CURSOR_BYTES) return null;
  const position = Y.decodeRelativePosition(bytes);
  return position.tname === null || position.tname === rootName ? position : null;
}

function textPosition(state: EditorState, position: number | null): position is number {
  return position !== null && Number.isSafeInteger(position) && position >= 0 &&
    position <= state.doc.content.size && state.doc.resolve(position).parent.inlineContent;
}

interface RemoteTextPosition {
  peer: CollaborationPeer;
  color: string;
  anchor: number;
  head: number;
}

function resolveRemotePositions(state: EditorState, client: CollaborationClient): RemoteTextPosition[] {
  const sync = ySyncPluginKey.getState(state);
  if (!sync || sync.snapshot || sync.prevSnapshot) return [];
  const positions: RemoteTextPosition[] = [];
  for (const { peer, selection } of client.getRemoteCursors()) {
    try {
      const anchor = decodePosition(selection.anchor);
      const head = decodePosition(selection.head);
      if (!anchor || !head) continue;
      const resolve = (position: Y.RelativePosition) => relativePositionToAbsolutePosition(sync.doc, sync.type, position, sync.binding.mapping);
      const anchorOffset = resolve(anchor);
      const headOffset = resolve(head);
      if (!textPosition(state, anchorOffset) || !textPosition(state, headOffset)) continue;
      const color = /^#[\da-f]{6}$/i.test(peer.color) ? peer.color : '#27745e';
      positions.push({ peer, color, anchor: anchorOffset, head: headOffset });
    } catch {
      // A remote relative position can become unresolvable as its blocks are edited.
    }
  }
  return positions;
}

function renderCarets(view: EditorView, layer: HTMLElement, positions: readonly RemoteTextPosition[]): void {
  const bounds = layer.getBoundingClientRect();
  const carets = layer.ownerDocument.createDocumentFragment();
  for (const { peer, color, head } of positions) {
    let line: ReturnType<typeof view.coordsAtPos>;
    try { line = view.coordsAtPos(head, -1); }
    catch { continue; }
    if (line.bottom <= line.top) continue;
    const caret = layer.ownerDocument.createElement('span');
    caret.className = 'docs-remote-caret';
    caret.dataset.peerId = peer.id;
    caret.dataset.actorId = peer.actorId;
    caret.dataset.peerName = peer.name;
    caret.setAttribute('aria-hidden', 'true');
    caret.style.setProperty('--docs-peer-color', color);
    caret.style.left = `${line.left - bounds.left}px`;
    caret.style.top = `${line.top - bounds.top}px`;
    caret.style.height = `${line.bottom - line.top}px`;
    carets.append(caret);
  }
  layer.replaceChildren(carets);
}

export function publishEditorCursor(view: EditorView, client: CollaborationClient): void {
  const sync = ySyncPluginKey.getState(view.state);
  const selection = view.state.selection;
  const document = view.dom.ownerDocument;
  if (client.view.phase !== 'connected' || view.isDestroyed || !view.editable || !view.hasFocus() ||
    !document.hasFocus() || document.visibilityState === 'hidden' || !sync || sync.snapshot || sync.prevSnapshot ||
    !(selection instanceof TextSelection) || !selection.$anchor.parent.inlineContent || !selection.$head.parent.inlineContent) {
    client.setCursor(null);
    return;
  }
  try {
    const encode = (position: number) => {
      const bytes = Y.encodeRelativePosition(absolutePositionToRelativePosition(position, sync.type, sync.binding.mapping));
      return bytes.length <= MAX_COLLABORATION_CURSOR_BYTES ? encodeBytes(bytes) : null;
    };
    const anchor = encode(selection.anchor);
    const head = selection.empty ? anchor : encode(selection.head);
    client.setCursor(anchor && head ? { anchor, head } : null);
  } catch {
    client.setCursor(null);
  }
}

export function collaborativeCursors(client: CollaborationClient): Extension {
  return Extension.create({
    name: 'teamspaceCollaborativeCursors',
    addProseMirrorPlugins() {
      return [new Plugin<DecorationSet>({
        key: cursorKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, previous) {
            const decorations = tr.getMeta(cursorKey) as DecorationSet | undefined;
            return decorations ?? (tr.docChanged ? previous.map(tr.mapping, tr.doc) : previous);
          },
        },
        props: { decorations: state => cursorKey.getState(state) },
        view(view) {
          const document = view.dom.ownerDocument;
          const ownerWindow = document.defaultView;
          let released = false;
          let repaintQueued = false;
          let publishQueued = false;
          let layoutFrame: number | undefined;
          const getCaretLayer = () => view.dom.closest('.docs-live-editor')?.querySelector<HTMLElement>('.docs-remote-carets');
          const paintCarets = (positions: RemoteTextPosition[]) => {
            const layer = getCaretLayer();
            if (layer) renderCarets(view, layer, positions);
          };
          const onLayout = () => {
            if (!ownerWindow || layoutFrame !== undefined || !client.getRemoteCursors().length) return;
            layoutFrame = ownerWindow.requestAnimationFrame(() => {
              layoutFrame = undefined;
              if (!released && !view.isDestroyed) paintCarets(resolveRemotePositions(view.state, client));
            });
          };
          // Read the Yjs binding after all plugin views have processed the transaction.
          const repaint = () => {
            if (repaintQueued) return;
            repaintQueued = true;
            queueMicrotask(() => {
              repaintQueued = false;
              if (released || view.isDestroyed) return;
              const positions = resolveRemotePositions(view.state, client);
              const selection = positions.flatMap(({ peer, anchor, head, color }) => anchor === head ? [] : [
                Decoration.inline(Math.min(anchor, head), Math.max(anchor, head), {
                  class: 'docs-remote-selection',
                  'data-peer-id': peer.id,
                  'data-actor-id': peer.actorId,
                  style: `--docs-peer-selection-color: ${color}33`,
                }),
              ]);
              const decorations = DecorationSet.create(view.state.doc, selection);
              if (decorations !== DecorationSet.empty || cursorKey.getState(view.state) !== DecorationSet.empty)
                view.dispatch(view.state.tr.setMeta(cursorKey, decorations).setMeta('addToHistory', false));
              paintCarets(positions);
            });
          };
          const publish = () => {
            if (publishQueued) return;
            publishQueued = true;
            queueMicrotask(() => {
              publishQueued = false;
              if (!released && !view.isDestroyed) publishEditorCursor(view, client);
            });
          };
          const clear = () => client.setCursor(null);
          const blur = (event: FocusEvent) => {
            const next = event.relatedTarget;
            if (!(next instanceof Node) || !view.dom.contains(next)) clear();
          };
          const visibility = () => {
            if (document.visibilityState === 'hidden') clear();
            else { publish(); onLayout(); }
          };
          const unsubscribe = client.subscribeCursors(repaint);
          const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onLayout);
          resizeObserver?.observe(view.dom);
          view.dom.addEventListener('focusin', publish);
          view.dom.addEventListener('focusout', blur);
          view.dom.addEventListener('load', onLayout, true);
          ownerWindow?.addEventListener('focus', publish);
          ownerWindow?.addEventListener('blur', clear);
          ownerWindow?.addEventListener('resize', onLayout);
          document.addEventListener('scroll', onLayout, true);
          document.addEventListener('visibilitychange', visibility);
          repaint();
          publish();
          return {
            update(view, previous) {
              if (view.state.doc !== previous.doc && client.getRemoteCursors().length) repaint();
              if (view.state.doc !== previous.doc || !view.state.selection.eq(previous.selection)) publish();
            },
            destroy() {
              released = true;
              unsubscribe();
              resizeObserver?.disconnect();
              if (layoutFrame !== undefined) ownerWindow?.cancelAnimationFrame(layoutFrame);
              getCaretLayer()?.replaceChildren();
              view.dom.removeEventListener('focusin', publish);
              view.dom.removeEventListener('focusout', blur);
              view.dom.removeEventListener('load', onLayout, true);
              ownerWindow?.removeEventListener('focus', publish);
              ownerWindow?.removeEventListener('blur', clear);
              ownerWindow?.removeEventListener('resize', onLayout);
              document.removeEventListener('scroll', onLayout, true);
              document.removeEventListener('visibilitychange', visibility);
              clear();
            },
          };
        },
      })];
    },
  });
}
