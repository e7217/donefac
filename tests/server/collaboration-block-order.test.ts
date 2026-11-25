import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as Y from 'yjs';
import {
  COLLABORATION_BLOCK_ORDER_ROOT, CollaborationBlockOrderError, MAX_COLLABORATION_BLOCK_MOVES,
  collaborationBlockId, collaborationBlockMoveCapacity, moveCollaborationBlock, projectCollaborationBlocks, validateCollaborationBlockOrder,
} from '../../shared/collaboration-block-order.js';

function block(value: string) {
  const text = new Y.XmlText();
  text.insert(0, value);
  const node = new Y.XmlElement('paragraph');
  node.insert(0, [text]);
  return node;
}

function replica(t: TestContext, state?: Uint8Array) {
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  const root = doc.getXmlFragment('default');
  if (state) Y.applyUpdate(doc, state);
  return { doc, root };
}

function initial(t: TestContext, labels = ['a', 'b', 'charlie', 'd', 'e']) {
  const { doc, root } = replica(t);
  const nodes = labels.map(block);
  root.insert(0, nodes);
  return { doc, root, nodes, ids: nodes.map(node => collaborationBlockId(node)!) };
}

function textOf(value: unknown) {
  assert.ok(value instanceof Y.XmlElement);
  const text = value.get(0);
  assert.ok(text instanceof Y.XmlText);
  return text;
}

function idsOf(root: Y.XmlFragment) {
  return projectCollaborationBlocks(root).map(collaborationBlockId);
}

test('legacy collaborative documents read their physical order without creating a new root', t => {
  const { doc, root, nodes, ids } = initial(t);
  assert.deepEqual(projectCollaborationBlocks(root), nodes);
  assert.deepEqual(idsOf(root), ids);
  validateCollaborationBlockOrder(doc);
  assert.equal(doc.share.has(COLLABORATION_BLOCK_ORDER_ROOT), false);
  assert.equal(collaborationBlockMoveCapacity(root), MAX_COLLABORATION_BLOCK_MOVES);
  assert.equal(collaborationBlockMoveCapacity(doc.getXmlFragment('secondary')), 0);
  assert.equal(moveCollaborationBlock(root, ids[0], ids[1], 'before'), false);
  assert.equal(doc.share.has(COLLABORATION_BLOCK_ORDER_ROOT), false);
});

test('concurrent and offline moves preserve physical text identity and relative positions in every apply order', t => {
  const { doc, root, nodes, ids } = initial(t);
  const [a, b, charlie, d, e] = ids;
  const original = Y.encodeStateAsUpdate(doc);
  const seed = Y.encodeStateVector(doc);
  const anchor = Y.createRelativePositionFromTypeIndex(textOf(nodes[2]), 4, -1);
  const moving = replica(t, original);
  const typing = replica(t, original);
  const offline = replica(t, original);

  assert.equal(moveCollaborationBlock(moving.root, charlie, a, 'before'), true);
  textOf(typing.root.get(2)).insert(7, ' peer');
  textOf(offline.root.get(2)).insert(0, 'offline ');
  assert.equal(moveCollaborationBlock(offline.root, b, e, 'after'), true);
  const updates = [moving.doc, typing.doc, offline.doc].map(actor => Y.encodeStateAsUpdate(actor, seed));

  for (const sequence of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const merged = replica(t, original);
    for (const index of sequence) Y.applyUpdate(merged.doc, updates[index]);
    const reopened = replica(t, Y.encodeStateAsUpdate(merged.doc));
    for (const { doc: current, root: content } of [merged, reopened]) {
      validateCollaborationBlockOrder(current);
      assert.deepEqual(content.toArray().map(collaborationBlockId), ids);
      assert.deepEqual(idsOf(content), [charlie, a, d, e, b]);
      const leaf = textOf(projectCollaborationBlocks(content)[0]);
      assert.equal(leaf.toString(), 'offline charlie peer');
      const position = Y.createAbsolutePositionFromRelativePosition(anchor, current);
      assert.equal(position?.type, leaf);
      assert.equal(position.index, 'offline '.length + 4);
    }
  }
  assert.deepEqual(idsOf(root), ids);
});

test('concurrent moves of the same block converge without copies when an update is replayed', t => {
  const { doc, ids: [a, b, charlie, d, e] } = initial(t);
  const original = Y.encodeStateAsUpdate(doc);
  const seed = Y.encodeStateVector(doc);
  const left = replica(t, original);
  const right = replica(t, original);
  assert.equal(moveCollaborationBlock(left.root, charlie, a, 'before'), true);
  assert.equal(moveCollaborationBlock(right.root, charlie, e, 'after'), true);
  const leftUpdate = Y.encodeStateAsUpdate(left.doc, seed);
  const rightUpdate = Y.encodeStateAsUpdate(right.doc, seed);
  Y.applyUpdate(left.doc, rightUpdate);
  Y.applyUpdate(right.doc, leftUpdate);
  Y.applyUpdate(right.doc, leftUpdate);
  assert.deepEqual(idsOf(left.root), idsOf(right.root));
  assert.deepEqual(idsOf(right.root).filter(id => id !== charlie), [a, b, d, e]);
  assert.ok(idsOf(right.root)[0] === charlie || idsOf(right.root)[4] === charlie);
  assert.equal(idsOf(right.root).length, 5);
});

test('a removed placement neighbor retains its surviving fallback and can place a newly inserted block', t => {
  const { doc, root, ids: [a, b, charlie, d, e] } = initial(t);
  assert.equal(moveCollaborationBlock(root, e, charlie, 'before'), true);
  assert.deepEqual(idsOf(root), [a, b, e, charlie, d]);
  root.delete(2, 1);
  assert.deepEqual(idsOf(root), [a, b, e, d]);

  const newBlock = block('새 문단');
  root.push([newBlock]);
  const inserted = collaborationBlockId(newBlock)!;
  assert.equal(moveCollaborationBlock(root, inserted, e, 'before'), true);
  assert.deepEqual(idsOf(root), [a, b, inserted, e, d]);
  const reopened = replica(t, Y.encodeStateAsUpdate(doc));
  assert.deepEqual(idsOf(reopened.root), [a, b, inserted, e, d]);

  root.delete(3, 1);
  assert.deepEqual(idsOf(root), [a, b, inserted, d]);
  validateCollaborationBlockOrder(doc);
});

test('removing the last original anchor keeps a moved block at the boundary after reload', t => {
  const { doc, root, ids: [a, b, charlie, d, e] } = initial(t);
  assert.equal(moveCollaborationBlock(root, e, a, 'before'), true);
  assert.deepEqual(idsOf(root), [e, a, b, charlie, d]);
  root.delete(0, 1);
  assert.deepEqual(idsOf(root), [e, b, charlie, d]);
  assert.deepEqual(idsOf(replica(t, Y.encodeStateAsUpdate(doc)).root), [e, b, charlie, d]);
});

test('coalesced deleted anchors preserve the surviving block’s location in an interior gap across replicas', t => {
  const { doc, root } = replica(t);
  const nodes = Array.from({ length: 6 }, () => new Y.XmlElement('paragraph'));
  root.insert(0, nodes);
  const [a, b, c, d, e, f] = nodes.map(node => collaborationBlockId(node)!);
  assert.equal(moveCollaborationBlock(root, f, c, 'before'), true);
  assert.deepEqual(idsOf(root), [a, b, f, c, d, e]);

  const persisted = Y.encodeStateAsUpdate(doc);
  const seed = Y.encodeStateVector(doc);
  const peer = replica(t, persisted);
  root.delete(1, 1);
  peer.root.delete(2, 1);
  const updates = [doc, peer.doc].map(current => Y.encodeStateAsUpdate(current, seed));
  for (const sequence of [updates, updates.toReversed()]) {
    const merged = replica(t, persisted);
    for (const update of sequence) Y.applyUpdate(merged.doc, update);
    const reopened = replica(t, Y.encodeStateAsUpdate(merged.doc));
    const deleted = reopened.root._start?.right;
    assert.ok(deleted?.deleted);
    assert.equal(deleted.length, 2);
    assert.deepEqual(idsOf(merged.root), [a, f, d, e]);
    assert.deepEqual(idsOf(reopened.root), [a, f, d, e]);
  }
});

test('undoing a move leaves another actor’s moved-block content and independent order intact after reload', t => {
  const { doc, root, nodes, ids: [a, b, charlie, d, e] } = initial(t);
  const undoOrigin = Symbol('block move');
  const order = doc.getArray(COLLABORATION_BLOCK_ORDER_ROOT);
  const undo = new Y.UndoManager(order, { trackedOrigins: new Set([undoOrigin]) });
  t.after(() => undo.destroy());
  const seed = Y.encodeStateVector(doc);
  const peer = replica(t, Y.encodeStateAsUpdate(doc));
  assert.equal(moveCollaborationBlock(root, charlie, a, 'before', undoOrigin), true);
  assert.equal(moveCollaborationBlock(peer.root, b, e, 'after'), true);
  textOf(peer.root.get(2)).insert(7, ' peer');
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer.doc, seed));
  assert.deepEqual(idsOf(root), [charlie, a, d, e, b]);

  undo.undo();
  assert.deepEqual(idsOf(root), [a, charlie, d, e, b]);
  assert.equal(textOf(nodes[2]).toString(), 'charlie peer');
  const undone = replica(t, Y.encodeStateAsUpdate(doc));
  assert.deepEqual(idsOf(undone.root), [a, charlie, d, e, b]);
  undo.redo();
  const redone = replica(t, Y.encodeStateAsUpdate(doc));
  assert.deepEqual(idsOf(redone.root), [charlie, a, d, e, b]);
  assert.equal(textOf(projectCollaborationBlocks(redone.root)[0]).toString(), 'charlie peer');
});

test('unsupported root kinds, wrong encoded list items and malformed records are rejected after decode', t => {
  const invalid = [
    (doc: Y.Doc) => doc.getMap(COLLABORATION_BLOCK_ORDER_ROOT).set('one', 'unexpected'),
    (doc: Y.Doc) => doc.getText(COLLABORATION_BLOCK_ORDER_ROOT).insert(0, 'unexpected'),
    (doc: Y.Doc) => doc.getText(COLLABORATION_BLOCK_ORDER_ROOT).insertEmbed(0, ['1:0', 'before', '2:0', null]),
    (doc: Y.Doc) => doc.getArray(COLLABORATION_BLOCK_ORDER_ROOT).push([['1:0', 'before', '1:0', null]]),
    (doc: Y.Doc) => doc.getArray(COLLABORATION_BLOCK_ORDER_ROOT).push([['1:0', 'before', '2:0', '2:0']]),
    (doc: Y.Doc) => doc.getArray(COLLABORATION_BLOCK_ORDER_ROOT).push([['4294967296:0', 'before', '2:0', null]]),
    (doc: Y.Doc) => doc.getArray(COLLABORATION_BLOCK_ORDER_ROOT).push([['1:9007199254740992', 'before', '2:0', null]]),
  ];
  for (const write of invalid) {
    const { doc } = replica(t);
    write(doc);
    const loaded = replica(t, Y.encodeStateAsUpdate(doc));
    assert.throws(() => validateCollaborationBlockOrder(loaded.doc), CollaborationBlockOrderError);
  }
});

test('local control and server validation both bound the number of live order records', t => {
  const { doc, root, ids: [a, b] } = initial(t);
  const order = doc.getArray(COLLABORATION_BLOCK_ORDER_ROOT);
  order.push(Array.from({ length: MAX_COLLABORATION_BLOCK_MOVES }, () => [b, 'before', a, null]));
  validateCollaborationBlockOrder(doc);
  assert.equal(collaborationBlockMoveCapacity(root), 0);
  assert.equal(moveCollaborationBlock(root, b, a, 'after'), false);
  assert.equal(order.length, MAX_COLLABORATION_BLOCK_MOVES);
  order.push([[b, 'after', a, null]]);
  const loaded = replica(t, Y.encodeStateAsUpdate(doc));
  assert.throws(() => validateCollaborationBlockOrder(loaded.doc), CollaborationBlockOrderError);
});
