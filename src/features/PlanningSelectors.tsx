'use client';

import type { PlanningKind, WorkspaceSnapshot } from '../../shared/types';

export const PLAN_LABELS: Record<PlanningKind, string> = { cycle: '사이클', module: '모듈', release: '릴리스' };
export const PLAN_ID_FIELDS = { cycle: 'cycleId', module: 'moduleId', release: 'releaseId' } as const;

export function PlanningSelect({ data, projectId, kind, value, legacyLabel, onChange, name, ariaLabel, disabled = false, required = false }: { data: WorkspaceSnapshot; projectId: string; kind: PlanningKind; value?: string | null; legacyLabel?: string | null; onChange?: (id: string | null) => void; name?: string; ariaLabel?: string; disabled?: boolean; required?: boolean }) {
  const items = (data.planningItems || []).filter(item => item.projectId === projectId && item.kind === kind && (item.status !== 'archived' || item.id === value));
  const currentMissing = Boolean(value && !items.some(item => item.id === value));
  const selected = value === undefined ? { defaultValue: '' } : { value: value || '' };
  return <select key={`${projectId}:${kind}`} className="field" aria-label={ariaLabel || PLAN_LABELS[kind]} name={name || PLAN_ID_FIELDS[kind]} {...selected} onChange={onChange ? event => onChange(event.target.value || null) : undefined} disabled={disabled} required={required}>
    <option value="">{!value && legacyLabel ? `${legacyLabel} (이전 표시 정보)` : '미지정'}</option>
    {currentMissing && <option value={value!}>{legacyLabel || value} (현재 연결 · 최신 정보 없음)</option>}
    {items.map(item => <option key={item.id} value={item.id}>{item.name}{item.status === 'archived' ? ' (보관됨 · 현재 연결)' : ''}</option>)}
  </select>;
}
