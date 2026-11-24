'use client';

import { useId, useMemo, useState } from 'react';
import { ArrowUpRight, ChartBar, ChevronRight, SlidersHorizontal, X } from 'lucide-react';
import { DOCUMENT_ISSUE_LIST_LIMIT, ISSUE_SUMMARY_GROUP_LABELS, isIssueSummaryGroupBy, type DocumentIssueSummary } from '../../shared/document-nodes';
import { PRIORITY, type Issue, type Priority, type SavedView, type WorkspaceSnapshot } from '../../shared/types';
import { projectStatuses } from '../../shared/workflow-helpers';
import { issueListAttrs, keepDocumentSelection, matchingDocumentIssues } from './DocumentIssueList';

const number = new Intl.NumberFormat('ko-KR');
const percentage = new Intl.NumberFormat('ko-KR', { style: 'percent', maximumFractionDigits: 1 });
const priorityOrder: Priority[] = ['urgent', 'high', 'medium', 'low'];
const priorityColors: Record<Priority, string> = { urgent: '#b65448', high: '#aa7738', medium: '#5f887b', low: '#71848c' };
const defaultColor = '#728a80';
const unknownGroupOrder = Number.MAX_SAFE_INTEGER;

type Group = { id: string; label: string; color: string; issues: Issue[] };

export function issueSummaryAttrs(attrs: Record<string, unknown> | undefined): DocumentIssueSummary {
  return { ...issueListAttrs(attrs), groupBy: isIssueSummaryGroupBy(attrs?.groupBy) ? attrs.groupBy : 'status' };
}

function summarize(data: WorkspaceSnapshot, projectId: string, savedView: SavedView | undefined, groupBy: DocumentIssueSummary['groupBy']) {
  const statuses = groupBy === 'status' ? projectStatuses(data, projectId) : [];
  const people = groupBy === 'assignee' ? data.users : [];
  const statusGroups = statuses.map(status => [status.id, { label: status.label, color: status.color }] as const);
  const assigneeGroups = people.map(person => [person.id, { label: person.name, color: person.color }] as const);
  const priorityGroups = priorityOrder.map(priority => [priority, { label: PRIORITY[priority], color: priorityColors[priority] }] as const);
  const definitions = new Map<string, Pick<Group, 'label' | 'color'>>(
    groupBy === 'status' ? statusGroups : groupBy === 'assignee' ? assigneeGroups : priorityGroups,
  );
  const orderedIds = new Map([...definitions.keys()].map((id, index) => [id, index]));
  const groups = new Map<string, Group>();
  const matching = matchingDocumentIssues(data, projectId, savedView);

  for (const issue of matching) {
    const id = groupBy === 'status' ? issue.status : groupBy === 'assignee' ? (issue.assigneeId ?? '') : issue.priority;
    let group = groups.get(id);
    if (!group) {
      const definition = definitions.get(id);
      const missingLabel = groupBy === 'assignee' ? id ? '알 수 없는 담당자' : '미지정' : id || '미지정';
      group = { id, label: definition?.label ?? missingLabel, color: definition?.color ?? defaultColor, issues: [] };
      groups.set(id, group);
    }
    group.issues.push(issue);
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (groupBy === 'assignee') {
      if (!a.id || !b.id) return Number(!a.id) - Number(!b.id);
      return a.label.localeCompare(b.label, 'ko') || a.id.localeCompare(b.id);
    }
    const order = (orderedIds.get(a.id) ?? unknownGroupOrder) - (orderedIds.get(b.id) ?? unknownGroupOrder);
    return order || a.label.localeCompare(b.label, 'ko');
  });
  return { groups: ordered, total: matching.length };
}

function PageControls({ page, setPage, pageSize, total, label }: { page: number; setPage: (page: number) => void; pageSize: number; total: number; label: string }) {
  if (total <= pageSize) return null;
  const start = page * pageSize;
  return <div className="doc-issue-summary-pages">
    <span aria-live="polite">{label} {number.format(start + 1)}–{number.format(Math.min(total, start + pageSize))} / {number.format(total)}</span>
    <button type="button" className="btn btn-ghost" aria-label={`이전 ${label}`} disabled={page === 0} onMouseDown={keepDocumentSelection} onClick={event => { event.stopPropagation(); setPage(page - 1); }}>이전</button>
    <button type="button" className="btn btn-ghost" aria-label={`다음 ${label}`} disabled={start + pageSize >= total} onMouseDown={keepDocumentSelection} onClick={event => { event.stopPropagation(); setPage(page + 1); }}>다음</button>
  </div>;
}

function SummaryGroups({ groups, total, limit, openIssue }: { groups: Group[]; total: number; limit: number; openIssue: (id: string) => void }) {
  const cardId = useId();
  const [groupPage, setGroupPage] = useState(0);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [issuePage, setIssuePage] = useState(0);
  const groupPageSize = Math.max(1, Math.min(8, Math.floor(limit / 2)));
  const currentGroupPage = Math.min(groupPage, Math.ceil(groups.length / groupPageSize) - 1);
  const start = currentGroupPage * groupPageSize;
  const visibleGroups = groups.slice(start, start + groupPageSize);
  const issuePageSize = limit - visibleGroups.length;

  function showGroupPage(page: number) {
    setGroupPage(page);
    setOpenGroup(null);
    setIssuePage(0);
  }

  return <>
    <ul className="doc-issue-list-rows doc-issue-summary-groups">
      {visibleGroups.map((group, index) => {
        const count = group.issues.length;
        const ratio = count / total;
        const detailsId = `${cardId}-issues-${index}`;
        const percentageId = `${cardId}-percent-${index}`;
        const expanded = group.id === openGroup;
        const currentIssuePage = issuePageSize > 0 ? Math.min(issuePage, Math.ceil(count / issuePageSize) - 1) : 0;
        const issueStart = currentIssuePage * issuePageSize;
        return <li key={group.id}>
          <button type="button" className="doc-issue-summary-group" aria-label={`${group.label} ${number.format(count)}개`} aria-describedby={percentageId}
            aria-expanded={expanded} aria-controls={detailsId} onMouseDown={keepDocumentSelection} onClick={event => {
              event.stopPropagation();
              setOpenGroup(expanded ? null : group.id);
              setIssuePage(0);
            }}>
            <span className="doc-issue-summary-group-name">{group.label}</span>
            <span className="doc-issue-summary-group-count">{number.format(count)}개</span>
            <ChevronRight size={15} aria-hidden="true" />
            <span className="doc-issue-summary-meter" aria-hidden="true"><i style={{ width: `${ratio * 100}%`, backgroundColor: group.color }} /></span>
            <span className="doc-issue-summary-percent" id={percentageId}>{ratio < 0.001 ? '<0.1%' : percentage.format(ratio)}</span>
          </button>
          <div className="doc-issue-summary-issues" id={detailsId} hidden={!expanded}>
            {expanded && (issuePageSize > 0 ? <>
              <ul className="doc-issue-list-rows">
                {group.issues.slice(issueStart, issueStart + issuePageSize).map(issue => <li key={issue.id}>
                  <button type="button" className="doc-issue-list-row doc-issue-summary-issue" aria-label={`현황 업무 열기 ${issue.key} ${issue.title}`}
                    onMouseDown={keepDocumentSelection} onClick={event => { event.stopPropagation(); openIssue(issue.id); }}>
                    <span className="doc-issue-list-name"><small>{issue.key}</small><strong>{issue.title}</strong></span>
                    <ArrowUpRight size={13} aria-hidden="true" />
                  </button>
                </li>)}
              </ul>
              <PageControls page={currentIssuePage} setPage={setIssuePage} pageSize={issuePageSize} total={count} label="업무" />
            </> : <p className="doc-issue-list-message">포함 문서의 표시 한도에 도달했습니다. 원본 문서에서 업무를 확인하세요.</p>)}
          </div>
        </li>;
      })}
    </ul>
    <PageControls page={currentGroupPage} setPage={showGroupPage} pageSize={groupPageSize} total={groups.length} label="그룹" />
  </>;
}

export function IssueSummaryCard({ data, attrs, openIssue, limit = DOCUMENT_ISSUE_LIST_LIMIT, onEdit, onDelete }: {
  data: WorkspaceSnapshot;
  attrs: DocumentIssueSummary;
  openIssue: (id: string) => void;
  limit?: number;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { projectId, savedViewId, groupBy } = attrs;
  const project = data.projects.find(item => item.id === projectId);
  const savedView = data.savedViews?.find(item => item.projectId === projectId && item.id === savedViewId);
  const unavailable = !project ? '프로젝트를 찾을 수 없습니다.' : savedViewId && !savedView ? '공유 보기를 찾을 수 없습니다.' : '';
  const label = !unavailable && project ? `${project.name} · ${savedView?.name ?? '전체 업무'}` : attrs.label || '업무 현황';
  const { groups, total } = useMemo(() => unavailable ? { groups: [], total: 0 } : summarize(data, projectId, savedView, groupBy), [data, projectId, savedView, groupBy, unavailable]);

  return <section className="doc-issue-list doc-issue-summary" aria-label="업무 현황">
    <header className="doc-issue-list-heading">
      <ChartBar size={16} aria-hidden="true" />
      <div className="doc-issue-list-caption"><small>업무 현황 · {ISSUE_SUMMARY_GROUP_LABELS[groupBy]}별</small><strong>{label}</strong></div>
      {!unavailable && <span className="doc-issue-list-count">{number.format(total)}개</span>}
      {onEdit && onDelete && <div className="doc-issue-list-actions">
        <button type="button" className="btn btn-ghost docs-icon-button" title="업무 현황 설정" aria-label="업무 현황 설정" onMouseDown={keepDocumentSelection} onClick={event => { event.stopPropagation(); onEdit(); }}><SlidersHorizontal size={14} /></button>
        <button type="button" className="btn btn-ghost docs-icon-button" title="업무 현황 삭제" aria-label="업무 현황 삭제" onMouseDown={keepDocumentSelection} onClick={event => { event.stopPropagation(); onDelete(); }}><X size={14} /></button>
      </div>}
    </header>
    {unavailable ? <p className="doc-issue-list-message">{unavailable}</p> : total === 0 ? <p className="doc-issue-list-message">조건에 맞는 업무가 없습니다.</p> :
      <SummaryGroups key={JSON.stringify([projectId, savedViewId, groupBy])} groups={groups} total={total} limit={limit} openIssue={openIssue} />}
  </section>;
}
