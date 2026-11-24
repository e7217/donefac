import { Extension, getSchema, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import { Plugin, type Transaction } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as EditorNode } from '@tiptap/pm/model';
import { Mapping, ReplaceAroundStep } from '@tiptap/pm/transform';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { documentNodeExtensions } from './document-nodes.js';
import { isDocumentSectionId } from './document-sections.js';

type SectionHeading = { position: number; node: EditorNode };

function sectionHeadings(doc: EditorNode): Map<string, SectionHeading[]> {
  const sections = new Map<string, SectionHeading[]>();
  doc.descendants((node, position) => {
    if (node.type.name !== 'heading') return true;
    if (isDocumentSectionId(node.attrs.sectionId)) {
      const headings = sections.get(node.attrs.sectionId) || [];
      headings.push({ position, node });
      sections.set(node.attrs.sectionId, headings);
    }
    return false;
  });
  return sections;
}

const HeadingSections = Extension.create({
  name: 'headingSections',
  addGlobalAttributes() {
    return [{ types: ['heading'], attributes: {
      sectionId: {
        default: undefined,
        keepOnSplit: false,
        parseHTML: (heading: HTMLElement) => {
          const id = heading.getAttribute('data-document-section-id');
          return isDocumentSectionId(id) ? id : undefined;
        },
        renderHTML: (attributes: Record<string, unknown>) => isDocumentSectionId(attributes.sectionId)
          ? { 'data-document-section-id': attributes.sectionId, tabindex: -1 }
          : {},
      },
    } }];
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, previous, next) {
        if (!transactions.some(transaction => transaction.docChanged) ||
            transactions.some(transaction => transaction.getMeta(ySyncPluginKey)?.isChangeOrigin)) return null;
        const sections = sectionHeadings(next.doc);
        const duplicates = [...sections].filter(([, headings]) => headings.length > 1);
        // setBlockType changes the node wrapper but keeps its inline content in the gap.
        const levelChanged = transactions.some(transaction => transaction.steps.some(step =>
          step instanceof ReplaceAroundStep && step.insert === 1 && step.gapFrom === step.from + 1 &&
          step.gapTo === step.to - 1 && step.slice.content.firstChild?.type.name === 'heading'));
        if (!duplicates.length && !levelChanged) return null;

        const originalSections = sectionHeadings(previous.doc);
        const mapping = new Mapping();
        for (const transaction of transactions) mapping.appendMapping(transaction.mapping);
        const amendment = next.tr;
        for (const [id, headings] of duplicates) {
          const original = originalSections.get(id)?.[0];
          const mappedPosition = original && mapping.mapResult(original.position, 1);
          const survivor = mappedPosition && !mappedPosition.deleted
            ? headings.find(heading => heading.position === mappedPosition.pos) || headings[0]
            : headings[0];
          for (const heading of headings) {
            if (heading !== survivor) amendment.setNodeAttribute(heading.position, 'sectionId', undefined);
          }
        }
        if (levelChanged) for (const [id, [original]] of originalSections) {
          if (sections.has(id)) continue;
          const mapped = mapping.mapResult(original.position + 1, 1);
          if (mapped.deleted) continue;
          const heading = amendment.doc.nodeAt(mapped.pos - 1);
          if (heading?.type.name === 'heading' && heading.attrs.sectionId === undefined &&
              heading.attrs.level !== original.node.attrs.level && heading.content.eq(original.node.content)) {
            amendment.setNodeAttribute(mapped.pos - 1, 'sectionId', id);
          }
        }
        return amendment.docChanged ? amendment : null;
      },
    })];
  },
});

function checklistItems(doc: EditorNode) {
  const byId = new Map<string, number[]>();
  const missing: number[] = [];
  doc.descendants((node, position) => {
    if (node.type.name !== 'taskItem') return;
    const id = node.attrs.checklistItemId;
    if (!isDocumentSectionId(id)) {
      missing.push(position);
      return;
    }
    const positions = byId.get(id) ?? [];
    positions.push(position);
    byId.set(id, positions);
  });
  return { byId, missing };
}

function newChecklistItemId(): string {
  // getRandomValues also works in self-hosted deployments served over HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function loadsChecklistContent(transaction: Transaction): boolean {
  const origin = transaction.getMeta('appendedTransaction') as Transaction | undefined;
  return Boolean(transaction.getMeta('preventUpdate') || transaction.getMeta(ySyncPluginKey)?.isChangeOrigin ||
    origin?.getMeta('preventUpdate') || origin?.getMeta(ySyncPluginKey)?.isChangeOrigin);
}

function stripCopiedChecklistIds(fragment: Fragment, liveDragIds?: ReadonlyMap<string, number[]>): Fragment {
  const nodes: EditorNode[] = [];
  let changed = false;
  fragment.forEach(node => {
    const content = node.isLeaf ? node.content : stripCopiedChecklistIds(node.content, liveDragIds);
    const id = node.attrs.checklistItemId;
    const next = node.type.name === 'taskItem' && id !== undefined && !liveDragIds?.has(id)
      ? node.type.create({ ...node.attrs, checklistItemId: undefined }, content, node.marks)
      : node.copy(content);
    nodes.push(next);
    changed ||= next !== node;
  });
  return changed ? Fragment.fromArray(nodes) : fragment;
}

const ChecklistItemIdentity = Extension.create({
  name: 'checklistItemIdentity',
  addGlobalAttributes() {
    return [{ types: ['taskItem'], attributes: {
      checklistItemId: {
        default: undefined,
        keepOnSplit: false,
        parseHTML: (item: HTMLElement) => {
          const id = item.getAttribute('data-checklist-item-id');
          return isDocumentSectionId(id) ? id : undefined;
        },
        renderHTML: (attributes: Record<string, unknown>) => isDocumentSectionId(attributes.checklistItemId)
          ? { 'data-checklist-item-id': attributes.checklistItemId } : {},
      },
    } }];
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        transformPasted(slice, view) {
          // ProseMirror supplies its in-memory slice for a same-editor drag and a parsed slice for clipboard input.
          const liveDragIds = view.dragging?.slice === slice ? checklistItems(view.state.doc).byId : undefined;
          const content = stripCopiedChecklistIds(slice.content, liveDragIds);
          return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
        },
      },
      appendTransaction(transactions, previous, next) {
        if (!transactions.some(transaction => transaction.docChanged) || transactions.some(loadsChecklistContent)) return null;

        const { byId, missing } = checklistItems(next.doc);
        const duplicates = [...byId].filter(([, positions]) => positions.length > 1);
        if (duplicates.length) {
          const originalItems = checklistItems(previous.doc).byId;
          const mapping = new Mapping();
          for (const transaction of transactions) mapping.appendMapping(transaction.mapping);
          for (const [id, positions] of duplicates) {
            const originals = originalItems.get(id);
            const mapped = originals?.length === 1 ? mapping.mapResult(originals[0], 1) : undefined;
            const survivor = mapped && !mapped.deleted ? mapped.pos : undefined;
            // Without a mapped original, no duplicate can inherit historical links.
            for (const position of positions) if (position !== survivor) missing.push(position);
          }
        }

        if (!missing.length) return null;
        const reserved = new Set(byId.keys());
        const amendment = next.tr;
        for (const position of missing) {
          let id = newChecklistItemId();
          while (reserved.has(id)) id = newChecklistItemId();
          reserved.add(id);
          amendment.setNodeAttribute(position, 'checklistItemId', id);
        }
        return amendment;
      },
    })];
  },
});

/** Identical document schema on the server and browser; no editor or DOM needed. */
export function createEditorExtensions(options: { collaboration?: boolean } = {}): AnyExtension[] {
  return [
    StarterKit.configure({ heading: { levels: [1,2,3] }, link: { openOnClick:false }, ...(options.collaboration ? {undoRedo:false} : {}) }),
    HeadingSections,
    ChecklistItemIdentity,
    TableKit.configure({ table: { resizable:true } }),
    TaskList,
    TaskItem.configure({nested:true}),
    Image.configure({allowBase64:false}),
    ...documentNodeExtensions(),
  ];
}
export function createEditorSchema() { return getSchema(createEditorExtensions()); }
