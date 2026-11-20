import { Extension, getSchema, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import { Plugin } from '@tiptap/pm/state';
import type { Node as EditorNode } from '@tiptap/pm/model';
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

/** Identical document schema on the server and browser; no editor or DOM needed. */
export function createEditorExtensions(options: { collaboration?: boolean } = {}): AnyExtension[] {
  return [
    StarterKit.configure({ heading: { levels: [1,2,3] }, link: { openOnClick:false }, ...(options.collaboration ? {undoRedo:false} : {}) }),
    HeadingSections,
    TableKit.configure({ table: { resizable:true } }),
    TaskList,
    TaskItem.configure({nested:true}),
    Image.configure({allowBase64:false}),
    ...documentNodeExtensions(),
  ];
}
export function createEditorSchema() { return getSchema(createEditorExtensions()); }
