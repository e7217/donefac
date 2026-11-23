import { Extension, type Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Mark, Node as EditorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import { MAX_DOCUMENT_BYTES } from '../../shared/document-nodes';

export const DOCUMENT_FIND_MATCH_LIMIT = 1000;
export const DOCUMENT_FIND_QUERY_LIMIT = 200;
export const DOCUMENT_FIND_REPLACEMENT_LIMIT = 500;

export type DocumentFindMatch = { from: number; to: number };

const lineBreak = /[\r\n\u0085\u2028\u2029]/u;
const findKey = new PluginKey<DecorationSet>('teamspace-document-find');
const replaceMeta = 'teamspace-document-find-replace';
const encoder = new TextEncoder();
// Leave room for Yjs struct, mark and delete metadata under the 1 MiB wire limit.
const replacementBatchBytes = 512 * 1024;

function singleLineText(value: string, limit: number) {
  return value.length <= limit && value.isWellFormed() && !value.includes('\0') && !lineBreak.test(value);
}

export function findDocumentText(doc: EditorNode, query: string, caseSensitive: boolean) {
  const matches: DocumentFindMatch[] = [];
  let truncated = false;
  if (!query || !singleLineText(query, DOCUMENT_FIND_QUERY_LIMIT)) return { matches, truncated };

  const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), caseSensitive ? 'gu' : 'giu');
  doc.descendants((node, position) => {
    if (truncated || node.isAtom) return false;
    if (!node.isTextblock) return true;
    let run = '';
    let start = 0;

    function scanRun() {
      if (!run || truncated) return;
      literal.lastIndex = 0;
      for (let found = literal.exec(run); found; found = literal.exec(run)) {
        if (matches.length >= DOCUMENT_FIND_MATCH_LIMIT) {
          truncated = true;
          break;
        }
        const from = start + found.index;
        matches.push({ from, to: from + found[0].length });
      }
      run = '';
    }

    node.forEach((child, offset) => {
      if (child.isText) {
        if (!run) start = position + 1 + offset;
        run += child.text;
      } else scanRun();
    });
    scanRun();
    return false;
  });
  return { matches, truncated };
}

export const documentFindExtension = Extension.create({
  name: 'teamspaceDocumentFind',
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: findKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (transaction, previous) => transaction.getMeta(findKey) ?? (transaction.docChanged ? DecorationSet.empty : previous),
      },
      props: { decorations: state => findKey.getState(state) },
      appendTransaction(transactions, _previous, next) {
        // Keep fast typing immediately after the replacement in its own manual undo step.
        if (transactions.some(transaction => transaction.getMeta(replaceMeta)) && !yUndoPluginKey.getState(next)) {
          return closeHistory(next.tr);
        }
        return null;
      },
    })];
  },
});

export function showDocumentFindMatches(editor: Editor, doc: EditorNode, matches: readonly DocumentFindMatch[], activeIndex: number) {
  if (editor.isDestroyed) return;
  const { state, view } = editor;
  const previous = findKey.getState(state);
  if (!previous || state.doc !== doc || (!matches.length && previous === DecorationSet.empty)) return;
  const decorations = DecorationSet.create(doc, matches.map(({ from, to }, index) => Decoration.inline(from, to, {
    'data-document-find-match': 'true',
    ...(index === activeIndex ? { 'data-document-find-active': 'true' } : {}),
  })));
  view.dispatch(state.tr.setMeta(findKey, decorations).setMeta('addToHistory', false));
}

function replacementSource(doc: EditorNode, { from, to }: DocumentFindMatch): { marks: readonly Mark[]; text: string } | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to <= from || to > doc.content.size) return null;
  const start = doc.resolve(from);
  const end = doc.resolve(to);
  if (start.parent !== end.parent || !start.parent.isTextblock) return null;

  let marks: readonly Mark[] | undefined;
  let text = '';
  start.parent.nodesBetween(start.parentOffset, end.parentOffset, (node, offset) => {
    if (!node.isText) return false;
    text += node.text?.slice(Math.max(start.parentOffset - offset, 0), end.parentOffset - offset) ?? '';
    marks = marks ? marks.filter(mark => mark.isInSet(node.marks)) : node.marks;
  });
  return marks && text.length === to - from && singleLineText(text, DOCUMENT_FIND_QUERY_LIMIT) ? { marks, text } : null;
}

export function documentFindReplacementFitsBatch(replacement: string, changedCount: number) {
  return Number.isSafeInteger(changedCount) && changedCount >= 0 && changedCount <= DOCUMENT_FIND_MATCH_LIMIT &&
    encoder.encode(replacement).byteLength * changedCount <= replacementBatchBytes;
}

export function replaceDocumentFindMatches(editor: Editor, doc: EditorNode, matches: readonly DocumentFindMatch[], replacement: string) {
  if (editor.isDestroyed || !editor.isEditable || !matches.length || matches.length > DOCUMENT_FIND_MATCH_LIMIT ||
      !singleLineText(replacement, DOCUMENT_FIND_REPLACEMENT_LIMIT)) return false;
  const { state, view } = editor;
  if (state.doc !== doc || view.composing || !findKey.getState(state)) return false;

  const ordered = [...matches].sort((left, right) => right.from - left.from);
  const changes: (DocumentFindMatch & { marks: readonly Mark[] })[] = [];
  let upper = doc.content.size;
  for (const match of ordered) {
    const source = replacementSource(doc, match);
    if (!source || match.to > upper) return false;
    upper = match.from;
    if (source.text !== replacement) changes.push({ ...match, marks: source.marks });
  }
  if (!changes.length || !documentFindReplacementFitsBatch(replacement, changes.length)) return false;

  const transaction = closeHistory(state.tr).setMeta(replaceMeta, true);
  for (const { from, to, marks } of changes) {
    if (replacement) transaction.replaceWith(from, to, state.schema.text(replacement, marks));
    else transaction.delete(from, to);
  }
  if (!transaction.docChanged || encoder.encode(JSON.stringify(transaction.doc.toJSON())).byteLength > MAX_DOCUMENT_BYTES) return false;

  const undoManager = yUndoPluginKey.getState(state)?.undoManager;
  undoManager?.stopCapturing();
  try {
    view.dispatch(transaction);
  } finally {
    undoManager?.stopCapturing();
  }
  return editor.state.doc !== doc;
}
