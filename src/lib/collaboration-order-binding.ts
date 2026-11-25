import { getUpdatedPosition as mapLocalPosition, type Editor } from '@tiptap/core';
import Collaboration, { CollaborationMappablePosition } from '@tiptap/extension-collaboration';
import type { Node } from '@tiptap/pm/model';
import { AllSelection, NodeSelection, Plugin, Selection, TextSelection, type EditorState } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import { ProsemirrorBinding, updateYFragment, ySyncPluginKey, yUndoPluginKey, type RelativeSelection,
  type SyncPluginState, type UndoPluginState } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { collaborationBlockId, collaborationBlockMoveCapacity, COLLABORATION_BLOCK_ORDER_ROOT, moveCollaborationBlock,
  projectCollaborationBlocks } from '../../shared/collaboration-block-order';
import { collaborationAbsolutePosition, collaborationRelativePosition } from './collaboration-order-positions';

const rawOrder = (root: Y.XmlFragment) => root.toArray();
const restoredOrder = Symbol('document order before structural change');
type UndoEvent = { stackItem: { meta: Map<unknown, unknown> }; changedParentTypes: Y.Transaction['changedParentTypes'] };
const hasProjection = (root: Y.XmlFragment) => {
  const ordered = projectCollaborationBlocks(root);
  return rawOrder(root).some((node, index) => node !== ordered[index]);
};

function relativeSelection(binding: ProsemirrorBinding, state: EditorState): RelativeSelection | null {
  try {
    const { selection } = state;
    const anchor = selection instanceof CellSelection ? selection.$anchorCell.pos : selection.anchor;
    const head = selection instanceof CellSelection ? selection.$headCell.pos : selection.head;
    const sync = { doc: binding.doc, type: binding.type, binding };
    return { type: selection.toJSON().type, depth: undefined, anchor: collaborationRelativePosition(anchor, sync),
      head: collaborationRelativePosition(head, sync), absAnchor: anchor, absHead: head };
  } catch { return null; }
}

/** Only the root adapter uses projected indices. The nested Tiptap reconciler uses real Yjs nodes. */
function rootAdapter(type: Y.XmlFragment): Y.XmlFragment {
  return {
    toArray: () => projectCollaborationBlocks(type),
    get: (index: number) => projectCollaborationBlocks(type)[index],
    slice: (start: number, end?: number) => projectCollaborationBlocks(type).slice(start, end),
    delete: (index: number, length: number) => {
      const physical = rawOrder(type);
      const removed = projectCollaborationBlocks(type).slice(index, index + length);
      const indices = removed.map(node => physical.indexOf(node)).sort((a, b) => b - a);
      for (const at of indices) type.delete(at, 1);
    },
    insert: (index: number, children: Parameters<Y.XmlFragment['insert']>[1]) => {
      const ordered = projectCollaborationBlocks(type);
      const right = ordered[index];
      let left = ordered[index - 1];
      const physical = rawOrder(type);
      const at = right ? physical.indexOf(right) : left ? physical.indexOf(left) + 1 : type.length;
      type.insert(at, children);
      for (const [offset, child] of children.entries()) {
        if (projectCollaborationBlocks(type)[index + offset] !== child) {
          const id = child instanceof Y.XmlElement ? collaborationBlockId(child) : null;
          const neighbor = right ?? left;
          const neighborId = neighbor instanceof Y.XmlElement ? collaborationBlockId(neighbor) : null;
          if (!id || !neighborId || !moveCollaborationBlock(type, id, neighborId, right ? 'before' : 'after')) {
            throw new Error('공동 편집 블록의 새 위치를 기록하지 못했습니다.');
          }
        }
        left = child;
      }
    },
  } as unknown as Y.XmlFragment;
}

class OrderedBinding extends ProsemirrorBinding {
  readonly order: Y.Array<unknown>;
  private writing = false;
  private projectedBefore = false;
  private events: Parameters<Parameters<Y.XmlFragment['observeDeep']>[0]>[0] = [];
  private orderBefore: readonly ReturnType<Y.XmlFragment['toArray']>[number][] = [];
  private undoManager: Y.UndoManager | undefined;

  constructor(type: Y.XmlFragment, onError: (error: Error) => void) {
    super(type, new Map(), onError);
    this.order = this.doc.getArray(COLLABORATION_BLOCK_ORDER_ROOT);
  }

  private withOrderedRead(operation: () => void) {
    const type = this.type;
    const ordered = projectCollaborationBlocks(type);
    const original = type.toArray;
    const own = Object.hasOwn(type, 'toArray');
    const restore = () => {
      if (own) type.toArray = original;
      else Reflect.deleteProperty(type, 'toArray');
    };
    // The upstream read-only projection consumes toArray; the nested types and Yjs item links stay untouched.
    type.toArray = () => { restore(); return [...ordered]; };
    try { operation(); }
    finally { restore(); }
  }

  override _forceRerender() {
    this.withOrderedRead(() => super._forceRerender());
  }

  private rememberSelection = () => {
    if (this.invalidContentError || !this.prosemirrorView) return;
    this.projectedBefore = hasProjection(this.type);
    this.orderBefore = this.order.length ? projectCollaborationBlocks(this.type) : [];
    this.beforeTransactionSelection = relativeSelection(this, this.prosemirrorView.state);
  };

  private rememberUndoOrder = ({ stackItem, changedParentTypes }: UndoEvent) => {
    if (!this.orderBefore.length || stackItem.meta.has(restoredOrder) ||
        ![...changedParentTypes].some(([type, events]) => Object.is(type, this.type) &&
          events.some(event => Object.is(event.target, this.type)))) return;
    stackItem.meta.set(restoredOrder, this.orderBefore.map(block => Y.createRelativePositionFromTypeIndex(block, 0)));
  };

  private restoreUndoOrder = ({ stackItem }: UndoEvent) => {
    const saved = stackItem.meta.get(restoredOrder) as Y.RelativePosition[] | undefined;
    if (!saved || !collaborationBlockMoveCapacity(this.type)) return;
    const existing = new Set(this.orderBefore);
    const live = new Set(rawOrder(this.type));
    const order = saved.flatMap(relative => {
      const block = Y.createAbsolutePositionFromRelativePosition(relative, this.doc)?.type;
      return block instanceof Y.XmlElement && live.has(block) ? [block] : [];
    });
    this.doc.transact(() => {
      for (let index = order.length - 1; index >= 0; index--) {
        const block = order[index];
        if (existing.has(block)) continue;
        const next = order[index + 1], previous = order[index - 1];
        const target = next ?? previous;
        const from = collaborationBlockId(block), to = target && collaborationBlockId(target);
        if (from && to) moveCollaborationBlock(this.type, from, to, next ? 'before' : 'after');
      }
    });
  };

  private collect: Parameters<Y.XmlFragment['observeDeep']>[0] = events => { this.events.push(...events); };

  private refresh = (transaction: Y.Transaction) => {
    const events = this.events;
    this.events = [];
    if (!events.length || this.writing || !this.prosemirrorView) return;
    if (!this.projectedBefore && !hasProjection(this.type)) {
      super._typeChanged(events, transaction);
      return;
    }

    const undo = transaction.origin instanceof Y.UndoManager ? transaction.origin.currStackItem : null;
    const historic = undo?.meta.get(this) as RelativeSelection | undefined;
    const selection = historic ?? this.beforeTransactionSelection;
    const before = this.beforeTransactionSelection;
    this.beforeTransactionSelection = null;
    undo?.meta.delete(this);
    try { this.withOrderedRead(() => super._typeChanged(events, transaction)); }
    finally {
      this.beforeTransactionSelection = before;
      if (historic) undo?.meta.set(this, historic);
    }
    if (!this.invalidContentError && selection) this.restoreSelection(selection);
  };

  private restoreSelection(selection: RelativeSelection) {
    const view = this.prosemirrorView;
    if (!view) return;
    const sync = { doc: this.doc, type: this.type, binding: this };
    const anchor = collaborationAbsolutePosition(selection.anchor, sync);
    const head = collaborationAbsolutePosition(selection.head, sync);
    const { doc } = view.state;
    let next: Selection;
    if (selection.type === 'all') next = new AllSelection(doc);
    else if (anchor === null || head === null || anchor < 0 || head < 0 || anchor > doc.content.size || head > doc.content.size) return;
    else if (selection.type === 'node' && doc.resolve(anchor).nodeAfter) next = NodeSelection.create(doc, anchor);
    else if (selection.type === 'cell') {
      try { next = CellSelection.create(doc, anchor, head); }
      catch { next = Selection.near(doc.resolve(anchor)); }
    } else next = TextSelection.between(doc.resolve(anchor), doc.resolve(head));
    if (!next.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(next).setMeta('addToHistory', false)
      .setMeta(ySyncPluginKey, { isChangeOrigin: true }));
  }

  write(document: Node, includeHistory: boolean) {
    if (this.invalidContentError) return;
    this.writing = true;
    try {
      this.doc.transact(tr => {
        tr.meta.set('addToHistory', includeHistory);
        if (!this.order.length) super._prosemirrorChanged(document);
        else {
          const root = rootAdapter(this.type);
          try { updateYFragment(this.doc, root, document, this); }
          finally { this.mapping.delete(root); }
          this.mapping.set(this.type, document);
          this.beforeTransactionSelection = this.prosemirrorView && relativeSelection(this, this.prosemirrorView.state);
        }
      }, ySyncPluginKey);
    } finally { this.writing = false; }
  }

  override initView(view: EditorView) {
    if (this.prosemirrorView) this.destroy();
    this.prosemirrorView = view;
    this.doc.on('beforeAllTransactions', this.rememberSelection);
    this.doc.on('afterAllTransactions', this.afterAllTransactions);
    this.doc.on('afterTransaction', this.refresh);
    this.type.observeDeep(this.collect);
    this.order.observeDeep(this.collect);
    const manager = yUndoPluginKey.getState(view.state)?.undoManager;
    if (manager) {
      this.undoManager = manager;
      manager.addToScope(this.order);
      manager.on('stack-item-added', this.rememberUndoOrder);
      manager.on('stack-item-updated', this.rememberUndoOrder);
      manager.on('stack-item-popped', this.restoreUndoOrder);
    }
  }

  override destroy() {
    if (!this.prosemirrorView) return;
    this.prosemirrorView = null;
    this.doc.off('beforeAllTransactions', this.rememberSelection);
    this.doc.off('afterAllTransactions', this.afterAllTransactions);
    this.doc.off('afterTransaction', this.refresh);
    this.type.unobserveDeep(this.collect);
    this.order.unobserveDeep(this.collect);
    this.undoManager?.off('stack-item-added', this.rememberUndoOrder);
    this.undoManager?.off('stack-item-updated', this.rememberUndoOrder);
    this.undoManager?.off('stack-item-popped', this.restoreUndoOrder);
    this.undoManager = undefined;
    this.mapping.clear();
  }
}

function rootShapeChanged(before: Node, after: Node): boolean {
  if (before.childCount !== after.childCount) return true;
  const oldIndices = new Map<Node, number>();
  before.forEach((node, _offset, index) => oldIndices.set(node, index));
  for (let index = 0; index < after.childCount; index++) {
    const node = after.child(index), oldIndex = oldIndices.get(node);
    if (node.type !== before.child(index).type || oldIndex !== undefined && oldIndex !== index) return true;
  }
  return false;
}

function orderedSync(root: Y.XmlFragment, onError: (error: Error) => void) {
  const binding = new OrderedBinding(root, onError);
  return new Plugin<SyncPluginState>({
    key: ySyncPluginKey,
    state: {
      init: () => ({ type: root, doc: binding.doc, binding, snapshot: null, prevSnapshot: null,
        isChangeOrigin: false, isUndoRedoOperation: false, addToHistory: true, colors: [], colorMapping: new Map(), permanentUserData: null }),
      apply: (tr, state) => {
        const change = tr.getMeta(ySyncPluginKey) as Partial<SyncPluginState> | undefined;
        return { ...state, ...change, isChangeOrigin: Boolean(change?.isChangeOrigin),
          isUndoRedoOperation: Boolean(change?.isUndoRedoOperation), addToHistory: tr.getMeta('addToHistory') !== false };
      },
    },
    props: { editable: () => binding.invalidContentError === null },
    filterTransaction: tr => {
      if (!tr.docChanged || tr.getMeta(ySyncPluginKey)) return true;
      if (binding.invalidContentError) return false;
      return !binding.order.length || collaborationBlockMoveCapacity(root) >= tr.doc.childCount ||
        !rootShapeChanged(tr.before, tr.doc);
    },
    view(view) {
      binding.initView(view);
      binding._forceRerender();
      return {
        update(current, previous) {
          const shared = ySyncPluginKey.getState(current.state);
          if (!shared || shared.isChangeOrigin || current.state.doc === previous.doc) return;
          const manager = yUndoPluginKey.getState(current.state)?.undoManager;
          if (!shared.addToHistory) manager?.stopCapturing();
          binding.write(current.state.doc, shared.addToHistory);
        },
        destroy: () => binding.destroy(),
      };
    },
  });
}

export const OrderedCollaboration = Collaboration.extend({
  onBeforeCreate() {
    this.editor.utils.createMappablePosition = position => {
      const sync = ySyncPluginKey.getState(this.editor.state);
      return new CollaborationMappablePosition(position, sync ? collaborationRelativePosition(position, sync) : null);
    };
    this.editor.utils.getUpdatedPosition = (position, tr) => {
      const sync = ySyncPluginKey.getState(this.editor.state);
      const relative = position instanceof CollaborationMappablePosition ? position.yRelativePosition : null;
      const result = mapLocalPosition(position, tr);
      if (sync && relative && tr.getMeta(ySyncPluginKey)?.isChangeOrigin) {
        const absolute = collaborationAbsolutePosition(relative, sync);
        if (absolute !== null) return { position: new CollaborationMappablePosition(absolute, relative), mapResult: null };
      }
      const absolute = result.position.position;
      return { position: new CollaborationMappablePosition(absolute, relative ?? (sync ? collaborationRelativePosition(absolute, sync) : null)),
        mapResult: result.mapResult };
    };
  },
  addProseMirrorPlugins() {
    const root = this.options.fragment ?? this.options.document?.getXmlFragment(this.options.field);
    if (!root) throw new Error('공동 편집 문서의 본문을 찾을 수 없습니다.');
    return (this.parent?.() ?? []).map(plugin => {
      if (plugin.spec.key === ySyncPluginKey) return orderedSync(root, error => this.editor.emit('contentError', {
        error, editor: this.editor, disableCollaboration: () => { this.storage.isDisabled = true; root.doc?.destroy(); },
      }));
      if (plugin.spec.key === yUndoPluginKey && plugin.spec.state) {
        plugin.spec.state.apply = (tr, state: UndoPluginState, previous, next) => {
          const sync = ySyncPluginKey.getState(next);
          const prevSel = sync && !sync.binding.invalidContentError && !tr.getMeta(ySyncPluginKey)?.isChangeOrigin
            ? relativeSelection(sync.binding, previous) : state.prevSel;
          return { ...state, prevSel, hasUndoOps: state.undoManager.canUndo(), hasRedoOps: state.undoManager.canRedo() };
        };
      }
      return plugin;
    });
  },
});

export function moveCollaborationEditorBlock(editor: Editor, index: number, nextIndex: number): boolean {
  const sync = ySyncPluginKey.getState(editor.state);
  if (!sync || !(sync.binding instanceof OrderedBinding) || sync.binding.invalidContentError || !editor.isEditable ||
      editor.view.composing || Math.abs(nextIndex - index) !== 1) return false;
  const ordered = projectCollaborationBlocks(sync.type);
  const block = ordered[index], neighbor = ordered[nextIndex];
  if (!(block instanceof Y.XmlElement) || !(neighbor instanceof Y.XmlElement)) return false;
  const id = collaborationBlockId(block), neighborId = collaborationBlockId(neighbor);
  if (!id || !neighborId) return false;
  const manager = yUndoPluginKey.getState(editor.state)?.undoManager;
  manager?.stopCapturing();
  const moved = moveCollaborationBlock(sync.type, id, neighborId, nextIndex < index ? 'before' : 'after', ySyncPluginKey);
  manager?.stopCapturing();
  return moved;
}
