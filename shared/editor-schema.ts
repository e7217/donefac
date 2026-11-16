import { getSchema, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import { documentNodeExtensions } from './document-nodes.js';

/** Identical document schema on the server and browser; no editor or DOM needed. */
export function createEditorExtensions(options: { collaboration?: boolean } = {}): AnyExtension[] {
  return [
    StarterKit.configure({ heading: { levels: [1,2,3] }, link: { openOnClick:false }, ...(options.collaboration ? {undoRedo:false} : {}) }),
    TableKit.configure({ table: { resizable:true } }),
    TaskList,
    TaskItem.configure({nested:true}),
    Image.configure({allowBase64:false}),
    ...documentNodeExtensions(),
  ];
}
export function createEditorSchema() { return getSchema(createEditorExtensions()); }
