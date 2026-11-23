'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';
import { cellAround, CellSelection, columnIsHeader, isInTable, rowIsHeader, selectedRect } from '@tiptap/pm/tables';
import { useEditorState, type Editor } from '@tiptap/react';
import { MAX_DOCUMENT_TABLE_SPAN } from '../../shared/document-nodes';

type RangeStart = { doc: ProseMirrorNode; tableStart: number; position: number };

const editActions = [
  ['mergeCells', '셀 병합'],
  ['splitCell', '셀 나누기'],
  ['toggleHeaderRow', '첫 행 헤더 전환'],
  ['toggleHeaderColumn', '첫 열 헤더 전환'],
  ['toggleHeaderCell', '현재 셀 헤더 전환'],
  ['addRowAfter', '행 추가'],
  ['addColumnAfter', '열 추가'],
  ['deleteRow', '행 삭제'],
  ['deleteColumn', '열 삭제'],
  ['deleteTable', '표 삭제'],
] as const;
type TableAction = typeof editActions[number][0];

function currentCell(editor: Editor) {
  if (editor.isDestroyed || !editor.isEditable) return null;
  const { selection } = editor.state;
  return selection instanceof CellSelection ? selection.$headCell : cellAround(selection.$head);
}

function tableState(editor: Editor | null, rangeStart: RangeStart | null) {
  if (!editor || editor.isDestroyed || !editor.isEditable || !isInTable(editor.state)) return null;
  const cell = currentCell(editor);
  if (!cell) return null;
  const { left, right, top, bottom, table, tableStart, map } = selectedRect(editor.state);
  const width = right - left;
  const height = bottom - top;
  const can = editor.can();
  const selection = editor.state.selection;
  const oneCell = !(selection instanceof CellSelection) || selection.ranges.length === 1;
  const firstRowHeader = rowIsHeader(map, table, 0);
  const firstColumnHeader = columnIsHeader(map, table, 0);
  const headerRowTargets = map.cellsInRect({ left: firstColumnHeader ? 1 : 0, top: 0, right: map.width, bottom: 1 });
  const headerColumnTargets = map.cellsInRect({ left: 0, top: firstRowHeader ? 1 : 0, right: 1, bottom: map.height });
  const rangeActive = rangeStart?.doc === editor.state.doc && rangeStart.tableStart === tableStart;
  return {
    rangeActive,
    canEndRange: rangeActive && rangeStart.position !== cell.pos,
    firstRowHeader,
    firstColumnHeader,
    currentCellHeader: oneCell ? cell.nodeAfter?.type.spec.tableRole === 'header_cell' : undefined,
    available: {
      mergeCells: width <= MAX_DOCUMENT_TABLE_SPAN && height <= MAX_DOCUMENT_TABLE_SPAN && can.mergeCells(),
      splitCell: can.splitCell(),
      toggleHeaderRow: headerRowTargets.length > 0 && can.toggleHeaderRow(),
      toggleHeaderColumn: headerColumnTargets.length > 0 && can.toggleHeaderColumn(),
      toggleHeaderCell: oneCell && can.toggleHeaderCell(),
      addRowAfter: can.addRowAfter(),
      addColumnAfter: can.addColumnAfter(),
      deleteRow: height < map.height && can.deleteRow(),
      deleteColumn: width < map.width && can.deleteColumn(),
      deleteTable: can.deleteTable(),
    } satisfies Record<TableAction, boolean>,
  };
}

export function DocumentTableTools({ editor }: { editor: Editor }) {
  const hintId = useId();
  const controls = useRef<HTMLDivElement>(null);
  const [rangeStart, setRangeStart] = useState<RangeStart | null>(null);
  const tools = useEditorState({ editor, selector: ({ editor: instance }) => tableState(instance, rangeStart) });

  useEffect(() => {
    if (!rangeStart || editor.isDestroyed) return;
    const cancelIfStale = () => {
      const cell = currentCell(editor);
      if (!cell || editor.state.doc !== rangeStart.doc || cell.start(-1) !== rangeStart.tableStart) setRangeStart(null);
    };
    editor.on('transaction', cancelIfStale);
    return () => { editor.off('transaction', cancelIfStale); };
  }, [editor, rangeStart]);

  useEffect(() => {
    if (editor.isDestroyed) return;
    const dom = editor.view.dom;
    function focusTools(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.key !== 'Tab' || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey ||
        !editor.isEditable || !(editor.state.selection instanceof CellSelection)) return;
      const group = controls.current;
      const button = group?.querySelector<HTMLButtonElement>('[data-action="mergeCells"]:enabled') ??
        group?.querySelector<HTMLButtonElement>('[data-action="splitCell"]:enabled') ??
        group?.querySelector<HTMLButtonElement>('button:enabled');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      button.focus();
    }
    dom.addEventListener('keydown', focusTools, true);
    return () => dom.removeEventListener('keydown', focusTools, true);
  }, [editor]);

  if (!tools) return null;

  function beginRange() {
    const cell = currentCell(editor);
    if (!cell) return;
    if (editor.chain().focus().setCellSelection({ anchorCell: cell.pos }).run()) {
      setRangeStart({ doc: cell.doc, tableStart: cell.start(-1), position: cell.pos });
    }
  }

  function finishRange() {
    const cell = currentCell(editor);
    if (!cell || rangeStart?.doc !== cell.doc || rangeStart.tableStart !== cell.start(-1)) {
      setRangeStart(null);
      return;
    }
    if (rangeStart.position !== cell.pos && editor.chain().focus().setCellSelection({ anchorCell: rangeStart.position, headCell: cell.pos }).run()) {
      setRangeStart(null);
    }
  }

  function cancelRange() {
    setRangeStart(null);
    if (editor.isDestroyed || !editor.isEditable) return;
    const { doc, selection } = editor.state;
    if (selection instanceof CellSelection) {
      editor.view.dispatch(editor.state.tr.setSelection(Selection.near(doc.resolve(selection.$headCell.pos + 1))));
    }
    editor.commands.focus();
  }

  function apply(action: TableAction) {
    if (!tableState(editor, rangeStart)?.available[action]) return;
    if (editor.chain().focus()[action]().run()) setRangeStart(null);
  }

  return <div ref={controls} className="docs-table-tools" role="group" aria-label="표 편집" aria-describedby={hintId}
    onMouseDown={event => { if (event.target instanceof HTMLButtonElement) event.preventDefault(); }}>
    <div className="docs-table-tool-actions">
      {tools.rangeActive ? <>
        <button type="button" disabled={!tools.canEndRange} onClick={finishRange}>여기까지 선택</button>
        <button type="button" onClick={cancelRange}>셀 범위 취소</button>
      </> : <button type="button" onClick={beginRange}>셀 범위 시작</button>}
      {editActions.map(([action, label]) => <button key={action} type="button" data-action={action}
        className={action === 'deleteTable' ? 'docs-table-delete' : undefined} disabled={!tools.available[action]}
        aria-pressed={action === 'toggleHeaderRow' ? tools.firstRowHeader : action === 'toggleHeaderColumn' ? tools.firstColumnHeader
          : action === 'toggleHeaderCell' ? tools.currentCellHeader : undefined}
        onClick={() => apply(action)}>{label}</button>)}
    </div>
    {tools.rangeActive && <p role="status">같은 표에서 마지막 셀을 고른 뒤 ‘여기까지 선택’을 누르세요.</p>}
    <p id={hintId}>셀을 끌거나 Shift+클릭으로 범위를 고를 수 있습니다. 키보드로는 셀 끝에서 Shift+방향키로 선택한 뒤 Shift+Tab으로 표 편집 도구를 여세요.</p>
  </div>;
}
