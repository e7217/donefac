'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Columns2, GitCompareArrows, History, List, RotateCcw, X } from 'lucide-react';
import type { DocRevision, RichContent, User } from '../../shared/types';
import { diffDocuments, DOCUMENT_DIFF_LIMITS, type DocumentDiffResult, type DocumentDiffRun, type DocumentDiffSource, type DocumentDiffUnit } from '../../shared/document-diff';
import { CALLOUT_LABELS, contentReferences, ISSUE_SUMMARY_GROUP_LABELS, isCalloutVariant, isIssueSummaryGroupBy, isStatusBadgeTone, STATUS_BADGE_TONE_LABELS } from '../../shared/document-nodes';
import { documentPropertyReportProjectIds, normalizeDocumentPropertyReportOptions } from '../../shared/document-properties';
import { containsDocumentNavigation, ReadonlyDocumentContent } from './DocumentBlocks';
import { documentRevisionLabel, hasDocumentFormattedBlocks } from './document-utils';
import './document-history.css';

export interface DocumentHistoryProps {
  revisions: DocRevision[];
  loading: boolean;
  error: string;
  current: { title: string; content: RichContent; plainText: string; version: number; dirty: boolean };
  users: User[];
  onRestore: (revision: DocRevision) => void | Promise<void>;
  restoreDisabled: boolean;
  onSaveCopy?: () => void | Promise<void>;
  saving?: boolean;
}
const when = (value: string) => new Date(value).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const NODE_LABELS: Record<string, string> = { doc: '문서', paragraph: '문단', text: '텍스트 서식', heading: '제목 블록', blockquote: '인용문', callout: '안내 상자', statusBadge: '상태 배지', codeBlock: '코드', bulletList: '글머리 목록', orderedList: '번호 목록', listItem: '목록 항목', taskList: '할 일 목록', taskItem: '할 일', hardBreak: '줄바꿈', horizontalRule: '구분선', image: '이미지', table: '표', tableRow: '표 행', tableCell: '표 셀', tableHeader: '표 머리 셀', issueReference: '업무 참조', issueList: '업무 목록', issueSummary: '업무 현황', documentReference: '문서 참조', documentInclude: '문서 포함', documentRevisionInclude: '문서 버전 포함', documentExcerpt: '발췌 구역', documentExcerptInclude: '문서 발췌 포함', documentToc: '본문 목차', documentLabelList: '라벨별 문서 목록', documentChildList: '하위 문서 목록', documentProperties: '문서 속성', documentPropertyReport: '문서 속성 보고서', documentColumnLayout: '다단 구역', documentColumn: '단', details: '접기 블록', detailsSummary: '접기 제목', detailsContent: '접기 본문' };
const PAGE_SIZE = 60;

export function DocumentHistory({ revisions, loading, error, current, users, onRestore, restoreDisabled, onSaveCopy, saving = false }: DocumentHistoryProps) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [beforeId, setBeforeId] = useState('');
  const [afterId, setAfterId] = useState('current');
  const ordered = [...revisions].sort((a, b) => {
    if (a.confluenceSourceVersion == null && b.confluenceSourceVersion != null) return -1;
    if (a.confluenceSourceVersion != null && b.confluenceSourceVersion == null) return 1;
    return (b.confluenceSourceVersion ?? b.version) - (a.confluenceSourceVersion ?? a.version) || b.createdAt.localeCompare(a.createdAt);
  });
  const preview = ordered.find(value => value.id === previewId);
  const hasFormattedPreview = preview && (containsDocumentNavigation(preview.content) || hasDocumentFormattedBlocks(preview.content) || contentReferences(preview.content).some(reference => reference.revisionId));
  const dirtyLabel = current.dirty ? '현재 미저장 초안' : '현재 편집본';
  function openCompare(revision?: DocRevision) { setBeforeId((revision || ordered[1] || ordered[0])?.id || ''); setAfterId('current'); setCompareOpen(true); }
  return <div className="document-history">
    <div className="docs-panel-heading"><h3>문서 변경 이력</h3><p>저장된 버전끼리 비교하거나 현재 편집 내용과 차이를 확인하세요.</p><button className="btn btn-ghost document-compare-open" disabled={!ordered.length || loading} onClick={() => openCompare()}><GitCompareArrows size={14} />버전 비교</button></div>
    {current.dirty && <div className="docs-history-hint">현재 편집을 저장한 후 이전 버전으로 복구할 수 있어요. 비교에서는 미저장 초안도 확인할 수 있습니다.{onSaveCopy && <button disabled={saving} onClick={() => void onSaveCopy()}>편집을 새 문서로 보관</button>}</div>}
    {loading && <p className="docs-panel-muted">이력을 불러오는 중…</p>}{error && <p className="docs-panel-error" role="alert">{error}</p>}
    {preview ? <div className="docs-history-preview">
      <button className="docs-history-back" onClick={() => setPreviewId(null)}><ArrowLeft size={13} />이력 목록</button><strong>{documentRevisionLabel(preview)}</strong><h4>{preview.title}</h4><time>{when(preview.createdAt)} · {users.find(user => user.id === preview.authorId)?.name || '팀원'}</time>
      {hasFormattedPreview ? <><span className="document-history-preview-label">본문 미리보기</span><ReadonlyDocumentContent key={preview.id} content={preview.content} documentId={preview.documentId} mode="history" showOutline
        pinnedSource={{ documentId: preview.documentId, revisionId: preview.id }} /></> : <>
        <span className="document-history-preview-label">텍스트 미리보기</span><pre>{preview.plainText ? preview.plainText.slice(0, 2000) : '텍스트 미리보기가 없습니다. 버전 비교에서 전체 문서 구조를 확인하세요.'}</pre>{preview.plainText.length > 2000 && <p className="document-history-preview-limit">전체 {preview.plainText.length.toLocaleString('ko-KR')}자 중 2,000자를 표시했습니다. 나머지 내용과 구조는 버전 비교에서 빠짐없이 확인할 수 있습니다.</p>}
      </>}
      <button className="btn document-history-preview-compare" onClick={() => openCompare(preview)}><GitCompareArrows size={13} />이 버전과 {dirtyLabel} 비교</button><button className="btn btn-primary" disabled={saving || restoreDisabled} onClick={() => void onRestore(preview)}><RotateCcw size={13} />이 버전으로 복구</button>
    </div> : ordered.map(revision => <button className="docs-revision" key={revision.id} onClick={() => setPreviewId(revision.id)}><div className="docs-revision-icon"><History size={15} /></div><div><strong>{documentRevisionLabel(revision)}{revision.confluenceSourceVersion == null && revision.version === current.version && <span>현재</span>}</strong><p>{revision.summary || revision.title}</p><time>{when(revision.createdAt)} · {users.find(user => user.id === revision.authorId)?.name || '팀원'}</time></div><ChevronRight size={13} /></button>)}
    {!loading && !error && !ordered.length && <p className="docs-panel-muted">저장된 이력이 없습니다.</p>}
    {compareOpen && typeof document !== 'undefined' && createPortal(<Comparison revisions={ordered} current={current} beforeId={beforeId} afterId={afterId} setBeforeId={setBeforeId} setAfterId={setAfterId} onClose={() => setCompareOpen(false)} />, document.body)}
  </div>;
}

type Group = { id: number; kind: 'equal' | 'change'; before: DocumentDiffUnit[]; after: DocumentDiffUnit[] };
type Row = { id: string; kind: 'equal' | 'change'; before?: DocumentDiffUnit; after?: DocumentDiffUnit } |
  { id: string; kind: 'fold'; groupId: number; count: number };
function groupsOf(runs: DocumentDiffRun[]): Group[] {
  const groups: Group[] = [];
  for (const run of runs) {
    if (run.kind === 'equal') {
      groups.push({ id: groups.length, kind: 'equal', before: run.before, after: run.after });
      continue;
    }
    let group = groups.at(-1);
    if (!group || group.kind !== 'change') {
      group = { id: groups.length, kind: 'change', before: [], after: [] };
      groups.push(group);
    }
    for (const unit of run.before) group.before.push(unit);
    for (const unit of run.after) group.after.push(unit);
  }
  return groups;
}

function Comparison({ revisions, current, beforeId, afterId, setBeforeId, setAfterId, onClose }: { revisions: DocRevision[]; current: DocumentHistoryProps['current']; beforeId: string; afterId: string; setBeforeId: (id: string) => void; setAfterId: (id: string) => void; onClose: () => void }) {
  const [currentSnapshot, setCurrentSnapshot] = useState(() => structuredClone(current));
  const closeRef = useRef<HTMLButtonElement>(null), dialogRef = useRef<HTMLElement>(null);
  useEffect(() => { const previous = document.activeElement; closeRef.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  const before = revisions.find(value => value.id === beforeId);
  const savedAfter = revisions.find(value => value.id === afterId);
  const currentLabel = `${currentSnapshot.dirty ? '현재 미저장 초안' : '현재 편집본'} · 버전 ${currentSnapshot.version} 기준`;
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === 'Tab') { const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]'); if (!focusable?.length) return; const first = focusable[0], last = focusable[focusable.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
  }
  return <div className="document-diff-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} className="document-diff-dialog" role="dialog" aria-modal="true" aria-labelledby="document-diff-title" onKeyDown={keyboard}>
    <header><div><span>DOCUMENT HISTORY</span><h2 id="document-diff-title"><GitCompareArrows size={20} />문서 버전 비교</h2><p>제목과 저장된 본문 구조를 비교합니다. 비교 화면에서는 문서를 수정하지 않습니다.</p></div><button ref={closeRef} className="issue-icon-button" aria-label="문서 버전 비교 닫기" onClick={onClose}><X size={20} /></button></header>
    <DocumentComparisonContent
      before={before}
      after={afterId === 'current' ? currentSnapshot : savedAfter}
      beforeLabel={before ? documentRevisionLabel(before) : '기준 버전 없음'}
      afterLabel={afterId === 'current' ? currentLabel : savedAfter ? documentRevisionLabel(savedAfter) : '대상 버전 없음'}
      pairKey={`${beforeId}:${afterId}`}
      controls={reset => <>
        <label>기준<select className="field" aria-label="비교 기준 버전" value={beforeId} onChange={event => { setBeforeId(event.target.value); reset(); }}>
          {revisions.map(revision => <option key={revision.id} value={revision.id}>{documentRevisionLabel(revision)} · {revision.title}</option>)}
        </select></label>
        <label>대상<select className="field" aria-label="비교 대상 버전" value={afterId} onChange={event => { setAfterId(event.target.value); reset(); }}>
          <option value="current">{currentLabel}</option>
          {revisions.map(revision => <option key={revision.id} value={revision.id}>{documentRevisionLabel(revision)} · {revision.title}</option>)}
        </select></label>
      </>}
      note={reset => <div className="document-diff-current-note">
        <span>현재 편집본은 비교를 열거나 다시 불러온 시점의 내용입니다.</span>
        <button className="btn btn-ghost" onClick={() => { setCurrentSnapshot(structuredClone(current)); reset(); }}>현재 편집본 다시 불러오기</button>
      </div>}
    />
    <footer><span>서식·블록 속성·표·이미지·참조 대상의 변경도 구조 정보에 표시합니다.</span><button className="btn" onClick={onClose}>비교 닫기</button></footer>
  </section></div>;
}

interface DocumentComparisonContentProps {
  before?: DocumentDiffSource;
  after?: DocumentDiffSource;
  beforeLabel: string;
  afterLabel: string;
  pairKey?: string;
  controls?: (reset: () => void) => ReactNode;
  note?: (reset: () => void) => ReactNode;
}

export function DocumentComparisonContent({ before, after, beforeLabel, afterLabel, pairKey = '', controls, note }: DocumentComparisonContentProps) {
  const [layout, setLayout] = useState<'split' | 'unified'>('split');
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [page, setPage] = useState(0);
  const outcome = useMemo((): { result?: DocumentDiffResult; error?: string } => {
    if (!before || !after) return { error: '비교할 두 버전을 선택하세요.' };
    try {
      return { result: diffDocuments(before, after) };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : '문서 구조를 비교하지 못했습니다.' };
    }
  }, [before, after]);
  const groups = useMemo(() => groupsOf(outcome.result?.runs || []), [outcome.result]);
  const rows = useMemo(() => {
    const result: Row[] = [];
    for (const group of groups) {
      if (group.kind === 'equal' && group.before.length > 4 && !expanded.has(group.id)) {
        result.push({ id: `fold:${group.id}`, kind: 'fold', groupId: group.id, count: group.before.length });
      } else if (layout === 'unified' && group.kind === 'change') {
        for (const [index, unit] of group.before.entries()) result.push({ id: `${group.id}:old:${index}`, kind: 'change', before: unit });
        for (const [index, unit] of group.after.entries()) result.push({ id: `${group.id}:new:${index}`, kind: 'change', after: unit });
      } else {
        for (let index = 0; index < Math.max(group.before.length, group.after.length); index++) {
          result.push({ id: `${group.id}:${index}`, kind: group.kind, before: group.before[index], after: group.after[index] });
        }
      }
    }
    return result;
  }, [groups, expanded, layout]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const visible = rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const reset = () => { setExpanded(new Set()); setPage(0); };
  return <div className={`document-diff-content${controls ? '' : ' is-inline'}`}>
    <div className="document-diff-controls">
      {controls?.(reset)}
      <div className="document-diff-layout" role="group" aria-label="비교 표시 방식">
        <button type="button" className={layout === 'split' ? 'active' : ''} aria-pressed={layout === 'split'} onClick={() => { setLayout('split'); setPage(0); }}><Columns2 size={14} />나란히</button>
        <button type="button" className={layout === 'unified' ? 'active' : ''} aria-pressed={layout === 'unified'} onClick={() => { setLayout('unified'); setPage(0); }}><List size={14} />통합</button>
      </div>
    </div>
    {note?.(reset)}
    <div className="document-diff-source-labels"><span>기준 · {beforeLabel}<strong>{before?.title}</strong></span><span>대상 · {afterLabel}<strong>{after?.title}</strong></span></div>
    {outcome.error ? <div className="document-diff-error" role="alert">{outcome.error}<p>한도: 본문 8MiB · 제목 64KiB · {DOCUMENT_DIFF_LIMITS.nodes.toLocaleString('ko-KR')}개 노드 · 깊이 {DOCUMENT_DIFF_LIMITS.depth}. 한도를 넘으면 비교를 중단하며 내용을 잘라서 동일하다고 표시하지 않습니다.</p></div> : outcome.result && <>
      <div className="document-diff-summary" role="status"><span className="is-add">+ 추가 {outcome.result.stats.added}</span><span className="is-remove">− 삭제 {outcome.result.stats.removed}</span><span>변경 없음 {outcome.result.stats.unchanged}</span>{outcome.result.identical && <strong>제목과 본문 구조가 같습니다.</strong>}<small>단위: 구조 정보 또는 최대 {DOCUMENT_DIFF_LIMITS.textChunk.toLocaleString('ko-KR')}자 텍스트 조각</small></div>
      {outcome.result.fallbackGaps > 0 && <p className="document-diff-bound-note">변경량이 큰 {outcome.result.fallbackGaps}개 구간은 세부 정렬 대신 삭제·추가 묶음으로 표시합니다. 원본과 대상의 내용을 생략하지 않습니다.</p>}
      <div className={`document-diff-rows is-${layout}`} aria-label="문서 차이 내용">
        {visible.map(row => {
          if (row.kind === 'fold') {
            return <button type="button" className="document-diff-fold" key={row.id}
              onClick={() => { setExpanded(previous => new Set(previous).add(row.groupId)); setPage(0); }}>
              변경 없는 내용 {row.count.toLocaleString('ko-KR')}개 펼치기<ChevronRight size={14} />
            </button>;
          }
          const unchanged = row.kind === 'equal';
          return <div className={`document-diff-row is-${row.kind}`} key={row.id}>
            {layout === 'split' ? <>
              <DiffCell key={`${pairKey}:split:before`} unit={row.before} kind={unchanged ? 'equal' : 'delete'} />
              <DiffCell key={`${pairKey}:split:after`} unit={row.after} kind={unchanged ? 'equal' : 'insert'} />
            </> : <DiffCell key={`${pairKey}:unified`} unit={unchanged ? row.after : row.before || row.after}
              kind={unchanged ? 'equal' : row.before ? 'delete' : 'insert'} />}
          </div>;
        })}
      </div>
      <div className="document-diff-pagination">
        <button type="button" className="btn btn-ghost" aria-label="문서 차이 이전 페이지" disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}><ChevronLeft size={14} />이전</button>
        <span>{currentPage + 1} / {totalPages} 페이지 · {rows.length.toLocaleString('ko-KR')}개 표시 행 · 페이지당 최대 {PAGE_SIZE}행</span>
        <button type="button" className="btn btn-ghost" aria-label="문서 차이 다음 페이지" disabled={currentPage + 1 >= totalPages}
          onClick={() => setPage(currentPage + 1)}>다음<ChevronRight size={14} /></button>
        <button type="button" className="btn btn-ghost" disabled={!expanded.size} onClick={reset}>변경 없는 내용 접기</button>
      </div>
    </>}
  </div>;
}

type SummaryLine = { label: string; value: string };
const MARK_LABELS: Record<string, string> = { bold: '굵게', italic: '기울임', underline: '밑줄', strike: '취소선', code: '인라인 코드', link: '링크', highlight: '강조', subscript: '아래 첨자', superscript: '위 첨자', textStyle: '글자 스타일' };
function summaryValue(value: unknown) { const text = typeof value === 'string' ? value || '없음' : value === null || value === undefined ? '없음' : typeof value === 'object' ? JSON.stringify(value) : String(value); return text.length > 180 ? `${text.slice(0, 180)}… (전체 ${text.length.toLocaleString('ko-KR')}자, 구조 상세에서 확인)` : text; }
function metadataSummary(unit: DocumentDiffUnit): { lines: SummaryLine[]; additional: number } {
  let data: { properties?: Record<string, unknown>; shape?: { childCount?: number } };
  try { data = JSON.parse(unit.metadata); } catch { return { lines: [{ label: '구조 정보', value: '상세에서 원본 확인' }], additional: 0 }; }
  const properties = data.properties || {}, attrs = properties.attrs && typeof properties.attrs === 'object' && !Array.isArray(properties.attrs) ? properties.attrs as Record<string, unknown> : {};
  const lines: SummaryLine[] = [], used = new Set<string>();
  let additional = 0;
  const add = (label: string, value: unknown) => { if (lines.length < 10) lines.push({ label, value: summaryValue(value) }); else additional++; };
  const attribute = (key: string, label: string, showEmpty = false, transform?: (value: unknown) => unknown) => { used.add(key); if (showEmpty || attrs[key] !== undefined && attrs[key] !== null && attrs[key] !== '') add(label, transform ? transform(attrs[key]) : attrs[key]); };
  const rawMarks: unknown[] = Array.isArray(properties.marks) ? properties.marks : [];
  const marks = rawMarks.filter(value => value && typeof value === 'object' && !Array.isArray(value)) as { type?: string; attrs?: Record<string, unknown> }[];
  additional += rawMarks.length - marks.length;
  if (unit.nodeType === 'text' || marks.length) add('서식', marks.length ? `${marks.slice(0, 8).map(mark => MARK_LABELS[mark.type || ''] || mark.type || '알 수 없는 서식').join(', ')}${marks.length > 8 ? ` 외 ${marks.length - 8}개` : ''}` : '기본');
  for (const mark of marks.slice(0, 8)) {
    const values = mark.attrs || {};
    for (const [key, value] of Object.entries(values)) { if (value === null || value === undefined || value === '') continue; const labels: Record<string, string> = { href: '링크 주소', target: '링크 대상 창', color: mark.type === 'highlight' ? '강조 색' : '글자색', backgroundColor: '배경색', fontFamily: '글꼴', fontSize: '글자 크기', rel: '링크 관계' }; add(labels[key] || `${MARK_LABELS[mark.type || ''] || mark.type || '서식'} · ${key}`, value); }
  }
  if (marks.length > 8) additional += marks.length - 8;
  if (unit.nodeType === 'heading') attribute('level', '제목 단계');
  if (unit.nodeType === 'documentColumnLayout') {
    attribute('weights', '단 너비 비율', true, value => Array.isArray(value) ? value.join(' : ') : value);
    attribute('border', '테두리', true, value => value === true ? '표시' : '숨김');
  }
  if (unit.nodeType === 'documentToc') {
    attribute('minLevel', '시작 제목 단계');
    attribute('maxLevel', '끝 제목 단계');
    attribute('layout', '목차 배치', true, value => value === 'flat' ? '가로 목록' : '세로 목록');
  }
  if (unit.nodeType === 'documentLabelList') {
    attribute('title', '목록 제목', true);
    attribute('projectId', '문서 범위', true, value => value ?? '팀 공통');
    attribute('labels', '라벨', true, value => Array.isArray(value) ? value.join(', ') : value);
    attribute('match', '라벨 일치 방식', true, value => value === 'all' ? '모든 라벨' : '라벨 하나 이상');
    attribute('sort', '정렬 기준', true, value => value === 'title' ? '제목' : value === 'created' ? '생성일' : '수정일');
    attribute('descending', '정렬 방향', true, value => value ? '내림차순' : '오름차순');
    attribute('limit', '최대 문서 수', true);
    attribute('showLabels', '라벨 표시', true, value => value ? '표시' : '숨김');
    attribute('showSpace', '공간 이름 표시', true, value => value ? '표시' : '숨김');
    attribute('excludeCurrent', '현재 문서 제외', true, value => value ? '제외' : '포함');
  }
  if (unit.nodeType === 'documentChildList') {
    attribute('title', '목록 제목');
    attribute('scope', '문서 범위', true, value => {
      if (value === 'document') return '지정 문서';
      if (value === 'space') return '지정 공간';
      return value === 'current-space' ? '이 문서의 공간' : '이 문서';
    });
    attribute('documentId', '기준 문서 ID');
    attribute('projectId', '프로젝트 ID', attrs.scope === 'space', value => value ?? '팀 공통');
    attribute('depth', '하위 단계', true, value => value === 'all' ? '모든 하위 단계' : value);
    attribute('first', '첫 단계 최대 문서 수', true, value => value ?? '제한 없음');
    attribute('sort', '정렬 기준', true, value => value === 'title' ? '제목' : value === 'created' ? '작성일' : '수정일');
    attribute('descending', '정렬 방향', true, value => value ? '내림차순' : '오름차순');
    attribute('style', '표시 방식', true, value => value === 'list' ? '글머리 목록' : `제목 ${String(value).slice(1)}`);
  }
  if (unit.nodeType === 'documentProperties') {
    attribute('group', '속성 그룹');
    attribute('hidden', '원본에 표시', true, value => value === true ? '숨김' : '표시');
    attribute('entries', '속성', true, value => Array.isArray(value) ? value.map(entry => `${entry?.name} ${entry?.value}`).join(' · ') : value);
  }
  if (unit.nodeType === 'documentPropertyReport') {
    attribute('title', '보고서 제목');
    const report = normalizeDocumentPropertyReportOptions(attrs);
    if (report?.projectIds) {
      used.add('projectId');
      attribute('projectIds', '문서 공간', true, () => documentPropertyReportProjectIds(report).map(id => id ?? '팀 공통').join(', '));
    } else {
      if (attrs.projectIds == null) used.add('projectIds');
      attribute('projectId', '문서 공간', true, value => value ?? '팀 공통');
    }
    attribute('group', '속성 그룹', true, value => value || '모든 그룹');
    attribute('labels', '라벨', true, value => Array.isArray(value) ? value.join(', ') : value);
    attribute('match', '라벨 일치 방식', true, value => value === 'all' ? '모든 라벨' : '라벨 하나 이상');
    attribute('columns', '표시 열', true, value => Array.isArray(value) ? value.join(', ') || '자동' : value);
    attribute('sort', '정렬 기준', true, value => value === 'title' ? '문서 제목' : '수정일');
    attribute('descending', '정렬 방향', true, value => value ? '내림차순' : '오름차순');
    attribute('limit', '최대 행 수', true);
  }
  if (unit.nodeType === 'image') { attribute('src', '이미지 주소', true); attribute('alt', '대체 텍스트', true); attribute('title', '이미지 설명'); attribute('width', '너비'); attribute('height', '높이'); }
  if (['issueReference', 'documentReference', 'documentInclude', 'documentRevisionInclude', 'documentExcerptInclude'].includes(unit.nodeType)) { attribute(unit.nodeType === 'issueReference' ? 'issueId' : 'documentId', '참조 대상 ID', true); attribute('label', '저장된 이름', true); }
  if (unit.nodeType === 'documentExcerpt') attribute('hidden', '원본에 표시', true, value => value === true ? '숨김' : '표시');
  if (unit.nodeType === 'documentExcerptInclude') attribute('noPanel', '원본 안내', true, value => value === true ? '숨김' : '표시');
  if (unit.nodeType === 'documentRevisionInclude') attribute('revisionId', '고정 버전 ID', true);
  if (unit.nodeType === 'issueList' || unit.nodeType === 'issueSummary') {
    attribute('projectId', '프로젝트 ID', true);
    attribute('savedViewId', '공유 보기 ID', true, value => value ?? '프로젝트 전체');
    attribute('label', '저장된 이름', true);
    if (unit.nodeType === 'issueSummary') attribute('groupBy', '그룹 기준', true, value => ISSUE_SUMMARY_GROUP_LABELS[isIssueSummaryGroupBy(value) ? value : 'status']);
  }
  if (unit.nodeType === 'tableCell' || unit.nodeType === 'tableHeader') { attribute('colspan', '가로 병합', true, value => `${value ?? 1}칸`); attribute('rowspan', '세로 병합', true, value => `${value ?? 1}칸`); attribute('colwidth', '열 너비'); }
  if (unit.nodeType === 'orderedList') attribute('start', '시작 번호');
  if (unit.nodeType === 'taskItem') attribute('checked', '완료 여부', true, value => value === true ? '완료' : '미완료');
  if (unit.nodeType === 'codeBlock') attribute('language', '코드 언어', true);
  if (unit.nodeType === 'details') attribute('open', '펼침 상태', false, value => value === true ? '열림' : '닫힘');
  if (unit.nodeType === 'callout') {
    attribute('variant', '안내 상자 유형', true, value => isCalloutVariant(value) ? CALLOUT_LABELS[value] : value);
    attribute('title', '안내 상자 제목', true);
  }
  if (unit.nodeType === 'statusBadge') {
    attribute('label', '배지 이름', true);
    attribute('tone', '배지 색상', true, value => isStatusBadgeTone(value) ? STATUS_BADGE_TONE_LABELS[value] : value);
  }
  attribute('textAlign', '문단 정렬'); attribute('color', '글자색'); attribute('backgroundColor', '배경색');
  const countLabels: Record<string, string> = { doc: '하위 블록', detailsContent: '하위 블록', blockquote: '하위 블록', bulletList: '목록 항목', orderedList: '목록 항목', taskList: '목록 항목', listItem: '하위 블록', table: '표 행', tableRow: '표 셀', documentColumnLayout: '단 수', documentColumn: '하위 블록' };
  if (countLabels[unit.nodeType] && typeof data.shape?.childCount === 'number') add(countLabels[unit.nodeType], `${data.shape.childCount.toLocaleString('ko-KR')}개`);
  for (const key of Object.keys(attrs)) if (!used.has(key)) { if (lines.length < 10) add(`추가 속성 · ${key}`, attrs[key]); else additional++; }
  for (const key of Object.keys(properties)) if (!['type', 'attrs', 'marks'].includes(key)) { if (lines.length < 10) add(`추가 정보 · ${key}`, properties[key]); else additional++; }
  if (!lines.length) add('설정', unit.nodeType === 'paragraph' ? '기본 문단' : unit.nodeType === 'details' ? '접기 제목과 본문' : '기본');
  return { lines, additional };
}
function DiffCell({ unit, kind }: { unit?: DocumentDiffUnit; kind: 'equal' | 'delete' | 'insert' }) {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => unit?.kind === 'node' ? metadataSummary(unit) : null, [unit]);
  if (!unit) return <div className="document-diff-cell is-empty" />;
  const label = unit.kind === 'title' ? '제목' : unit.kind === 'text' ? '내용' : `구조 · ${NODE_LABELS[unit.nodeType] || unit.nodeType}`;
  return <div className={`document-diff-cell is-${kind}`} data-diff-kind={unit.kind}><div className="document-diff-unit-heading"><span>{kind === 'insert' ? '+' : kind === 'delete' ? '−' : '·'} {label}</span><small>{unit.path}</small></div>{unit.kind === 'node' ? <><div className="document-diff-node-summary">{summary?.lines.map((line, index) => <p key={index}><span>{line.label}: </span><strong>{line.value}</strong></p>)}{Boolean(summary?.additional) && <p className="document-diff-summary-more">추가 정보 {summary!.additional.toLocaleString('ko-KR')}개는 구조 상세에서 확인하세요.</p>}</div><details className="document-diff-structure" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary aria-label={`${unit.path} 구조 상세`}>구조 상세</summary>{expanded && <pre><code>{unit.metadata}</code></pre>}</details></> : <pre>{unit.text || '(빈 제목)'}</pre>}</div>;
}
