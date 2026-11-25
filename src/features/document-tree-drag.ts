import { useRef, useState, type DragEvent } from 'react';
import type { DocPage, DocumentSiblingOrder } from '../../shared/types';
import { documentAncestors } from './document-utils';

type Location = Pick<DocPage, 'projectId' | 'parentId'>;
export type DocumentOrderPlacement = Location & { targetId: string; side: 'before' | 'after'; version: string };
type DropPlacement = { kind: 'order'; placement: DocumentOrderPlacement } | { kind: 'move'; destination: Location };
type DragSource = { page: DocPage; version?: string; scope: string };
type DropTarget = DropPlacement & { key: string; appearance: 'before' | 'after' | 'inside' | 'root'; label: string };

const DOCUMENT_DRAG = 'application/x-teamspace-document-tree';
const sameLocation = (first: Location, second: Location) =>
  first.projectId === second.projectId && first.parentId === second.parentId;

export function reorderDocumentPlacement(order: DocumentSiblingOrder, sourceId: string, placement: DocumentOrderPlacement) {
  if (order.version !== placement.version || !sameLocation(order, placement) ||
      sourceId === placement.targetId || !order.documentIds.includes(sourceId)) return null;
  const ids = order.documentIds.filter(id => id !== sourceId);
  const targetIndex = ids.indexOf(placement.targetId);
  if (targetIndex < 0) return null;
  ids.splice(targetIndex + (placement.side === 'after' ? 1 : 0), 0, sourceId);
  return ids;
}

export function useDocumentTreeDrag(scope: string, enabled: boolean, pages: ReadonlyMap<string, DocPage>,
  onPlace: (id: string, target: DropPlacement) => void) {
  const source = useRef<DragSource | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [hover, setHover] = useState<DropTarget | null>(null);

  function clear() {
    source.current = null;
    setDraggedId(null);
    setHover(null);
  }

  function start(event: DragEvent<HTMLElement>, page: DocPage, version: string | undefined) {
    if (!enabled) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DOCUMENT_DRAG, page.id);
    source.current = { page, version, scope };
    setDraggedId(page.id);
    setHover(null);
  }

  function activeSource(event: DragEvent<HTMLElement>) {
    const drag = source.current;
    if (!enabled || drag?.scope !== scope || !event.dataTransfer.types.includes(DOCUMENT_DRAG)) return null;
    const current = pages.get(drag.page.id);
    return current && sameLocation(drag.page, current) ? drag : null;
  }

  function rowTarget(event: DragEvent<HTMLElement>, drag: DragSource, target: DocPage): DropTarget | null {
    if (drag.page.id === target.id) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = event.clientY - bounds.top;
    const side = offset < bounds.height * 0.25 ? 'before' : offset > bounds.height * 0.75 ? 'after' : null;
    const key = `page:${target.id}`;
    if (side) {
      return drag.version && sameLocation(drag.page, target) ? { kind: 'order', key, appearance: side,
        label: side === 'before' ? '위에 놓기' : '아래에 놓기',
        placement: { projectId: target.projectId, parentId: target.parentId, targetId: target.id, side, version: drag.version },
      } : null;
    }
    if (target.id === drag.page.parentId || documentAncestors(target, pages).some(page => page.id === drag.page.id)) return null;
    return { kind: 'move', key, appearance: 'inside', label: '하위에 놓기',
      destination: { projectId: target.projectId, parentId: target.id } };
  }

  function spaceTarget(drag: DragSource, projectId: string | null): DropTarget | null {
    const destination = { projectId, parentId: null };
    if (sameLocation(drag.page, destination)) return null;
    return { kind: 'move', key: `space:${projectId ?? ''}`, appearance: 'root', label: '최상위에 놓기', destination };
  }

  function dropArea(key: string, findTarget: (event: DragEvent<HTMLElement>, drag: DragSource) => DropTarget | null) {
    const target = (event: DragEvent<HTMLElement>) => {
      const drag = activeSource(event);
      return drag ? findTarget(event, drag) : null;
    };
    const showTarget = enabled && hover?.key === key;
    return {
      'data-document-drop': showTarget ? hover.appearance : undefined,
      'data-drop-label': showTarget ? hover.label : undefined,
      onDragOver(event: DragEvent<HTMLElement>) {
        const next = target(event);
        if (next) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }
        setHover(previous => previous?.key === next?.key && previous?.appearance === next?.appearance ? previous : next);
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setHover(previous => previous?.key === key ? null : previous);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        const drag = activeSource(event);
        if (!drag || event.dataTransfer.getData(DOCUMENT_DRAG) !== drag.page.id) return;
        const next = findTarget(event, drag);
        clear();
        if (next) { event.preventDefault(); onPlace(drag.page.id, next); }
      },
    };
  }

  return { draggedId: enabled ? draggedId : null, start, clear,
    row: (page: DocPage) => dropArea(`page:${page.id}`, (event, drag) => rowTarget(event, drag, page)),
    space: (projectId: string | null) => dropArea(`space:${projectId ?? ''}`, (_, drag) => spaceTarget(drag, projectId)),
  };
}
