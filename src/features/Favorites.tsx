'use client';

import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import { BookOpen, ChevronRight, CircleDot, Star } from 'lucide-react';
import type { Favorite, FeatureProps, WorkspaceSnapshot } from '../../shared/types';
import { statusMeta } from '../../shared/workflow-helpers';
import './workspace-search.css';
import './favorites.css';

type FavoriteButtonProps = {
  favorite: boolean;
  pending?: boolean;
  disabled?: boolean;
  itemLabel?: string;
  onToggle: () => void;
};

export function FavoriteButton({ favorite, pending, disabled, itemLabel, onToggle }: FavoriteButtonProps) {
  const action = favorite ? '즐겨찾기 해제' : '즐겨찾기 추가';
  const label = itemLabel ? `${itemLabel} ${action}` : action;
  return <button type="button" className={`btn btn-ghost favorite-button${favorite ? ' is-favorite' : ''}`}
    aria-label={label} title={label} aria-pressed={favorite} aria-busy={pending || undefined}
    disabled={disabled || pending} onClick={onToggle}>
    <Star size={16} aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} />
  </button>;
}

type FavoritesViewProps = Pick<FeatureProps, 'openIssue' | 'openDocument'> & {
  data: WorkspaceSnapshot;
  favorites: readonly Favorite[];
  loading?: boolean;
  error?: string;
  isPending?: (resourceType: Favorite['resourceType'], resourceId: string) => boolean;
  toggle: (resourceType: Favorite['resourceType'], resourceId: string) => void;
  retry?: () => void;
};

export function FavoritesView({ data, favorites, loading, error, isPending, openIssue, openDocument, toggle, retry }: FavoritesViewProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const listContainer = useRef<HTMLDivElement>(null);
  const lastRemovalButton = useRef<HTMLElement | null>(null);
  const issuesById = useMemo(() => new Map(data.issues.map(issue => [issue.id, issue])), [data.issues]);
  const documentsById = useMemo(() => new Map(data.documents.map(document => [document.id, document])), [data.documents]);
  const projectsById = useMemo(() => new Map(data.projects.map(project => [project.id, project.name])), [data.projects]);

  const issueRows: ReactNode[] = [], documentRows: ReactNode[] = [];
  for (const { resourceType, resourceId } of favorites) {
    const remove = () => {
      if (document.activeElement instanceof HTMLElement && listContainer.current?.contains(document.activeElement)) {
        lastRemovalButton.current = document.activeElement;
      }
      toggle(resourceType, resourceId);
    };
    const pending = isPending?.(resourceType, resourceId);
    if (resourceType === 'issue') {
      const issue = issuesById.get(resourceId);
      if (!issue) continue;
      const status = statusMeta(data, issue.projectId, issue.status);
      issueRows.push(<FavoriteRow key={issue.id} label={issue.key} openLabel={`${issue.key} 업무 열기`}
        icon={<CircleDot size={18} color={status.color} aria-hidden="true" />}
        title={<><span className="workspace-search-issue-key">{issue.key}</span><strong>{issue.title}</strong></>}
        subtitle={`${projectsById.get(issue.projectId) ?? '프로젝트'} · ${status.label}`}
        pending={pending} disabled={loading} open={() => openIssue(issue.id)} remove={remove} />);
    } else {
      const page = documentsById.get(resourceId);
      if (!page) continue;
      const title = page.title || '제목 없는 문서';
      const space = page.projectId ? projectsById.get(page.projectId) ?? '프로젝트' : '팀 공통';
      const parent = page.parentId ? documentsById.get(page.parentId) : undefined;
      const subtitle = parent?.projectId === page.projectId && parent.title ? `${space} › ${parent.title}` : space;
      documentRows.push(<FavoriteRow key={page.id} label={title} openLabel={`${title} 문서 열기`}
        icon={<BookOpen size={18} aria-hidden="true" />} title={<strong>{title}</strong>} subtitle={subtitle}
        pending={pending} disabled={loading} open={() => openDocument(page.id)} remove={remove} />);
    }
  }
  const hasItems = issueRows.length > 0 || documentRows.length > 0;

  useEffect(() => {
    const removed = lastRemovalButton.current;
    if (!removed || removed.isConnected) return;
    lastRemovalButton.current = null;
    if (document.activeElement === document.body) heading.current?.focus({ preventScroll: true });
  }, [favorites, data.issues, data.documents]);

  return <div className="page favorites-page" ref={listContainer}>
    <header className="page-heading"><h1 ref={heading} tabIndex={-1}>즐겨찾기</h1></header>
    {error && <div className="card favorites-message">
      <p role="alert">{error}</p>
      {retry && <button type="button" className="btn" disabled={loading} onClick={retry}>즐겨찾기 다시 불러오기</button>}
    </div>}
    {hasItems ? <div className="favorites-groups">
      {issueRows.length > 0 && <FavoriteGroup title="즐겨찾는 업무">{issueRows}</FavoriteGroup>}
      {documentRows.length > 0 && <FavoriteGroup title="즐겨찾는 문서">{documentRows}</FavoriteGroup>}
    </div> : loading ? <p className="card favorites-message" role="status">즐겨찾기를 불러오는 중…</p> : !error &&
      <p className="card favorites-message">업무나 문서에서 별표를 눌러 즐겨찾기에 추가하세요.</p>}
  </div>;
}

function FavoriteGroup({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return <section className="card favorites-group" aria-labelledby={headingId}>
    <header className="workspace-search-results-heading"><h2 id={headingId}>{title}</h2></header>
    <ul className="workspace-search-result-list" role="list">{children}</ul>
  </section>;
}

function FavoriteRow({ label, openLabel, icon, title, subtitle, pending, disabled, open, remove }: {
  label: string;
  openLabel: string;
  icon: ReactNode;
  title: ReactNode;
  subtitle: string;
  pending?: boolean;
  disabled?: boolean;
  open: () => void;
  remove: () => void;
}) {
  const descriptionId = useId();
  return <li className="favorite-row">
    <button type="button" className="workspace-search-result" aria-label={openLabel} aria-describedby={descriptionId} onClick={open}>
      {icon}
      <span className="workspace-search-result-content" id={descriptionId}>
        <span className="workspace-search-result-title">{title}</span>
        <span className="workspace-search-result-path">{subtitle}</span>
      </span>
      <ChevronRight size={16} aria-hidden="true" className="workspace-search-result-arrow" />
    </button>
    <FavoriteButton favorite pending={pending} disabled={disabled} itemLabel={label} onToggle={remove} />
  </li>;
}
