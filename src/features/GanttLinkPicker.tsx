'use client';

import { SCHEDULE_DATE_LABELS } from '../../shared/schedule-dependencies';
import './gantt-link-picker.css';

export type GanttLinkEndpoint = keyof typeof SCHEDULE_DATE_LABELS;

type PromptProps = {
  source: { key: string; endpoint: GanttLinkEndpoint } | null;
  canPick: boolean;
  crossProject: boolean;
  onReset: () => void;
  onCancel: () => void;
};

export function GanttLinkPrompt({ source, canPick, crossProject, onReset, onCancel }: PromptProps) {
  return (
    <section className="gantt-link-prompt" aria-label="차트 연결 선택">
      <div className="gantt-link-instructions">
        <p role="status" aria-atomic="true">
          {source && <><strong>{source.key}</strong> {SCHEDULE_DATE_LABELS[source.endpoint]}을 선택했습니다. </>}
          {canPick
            ? `${source ? '후행' : '선행'} 업무를 선택하세요.`
            : '같은 프로젝트의 업무 두 개 이상을 차트에 표시해 주세요.'}
        </p>
        {canPick && <p>막대에서 시작일이나 종료일을 고르세요. 업무 이름을 선택하면 선행 종료일과 후행 시작일을 사용합니다.</p>}
        {crossProject && <p>서로 다른 프로젝트의 진행 가능한 업무는 선행 종료일과 후행 시작일을 선택해 차단 관계를 검토합니다.</p>}
      </div>
      <div className="gantt-link-prompt-actions">
        {source && <button type="button" className="btn" onClick={onReset}>선행 다시 선택</button>}
        <button type="button" className="btn btn-ghost" onClick={onCancel}>연결 선택 취소</button>
      </div>
    </section>
  );
}

type EndpointsProps = {
  issueKey: string;
  step: '선행' | '후행';
  startPosition: number | null;
  endPosition: number | null;
  timelineWidth: number;
  canPick: (endpoint: GanttLinkEndpoint) => boolean;
  onPick: (endpoint: GanttLinkEndpoint) => void;
};

export function GanttLinkEndpoints({ issueKey, step, startPosition, endPosition, timelineWidth, canPick, onPick }: EndpointsProps) {
  if ((startPosition === null && endPosition === null) || timelineWidth <= 0) return null;
  const width = Math.min(timelineWidth, 44);
  const halfWidth = width / 2;
  const endpoints = [
    { endpoint: 'startDate', position: startPosition, label: '시작' },
    { endpoint: 'endDate', position: endPosition, label: '종료' },
  ] as const;

  return (
    <div className="gantt-link-endpoints">
      {endpoints.map(({ endpoint, position, label }) => {
        if (position === null) return null;
        const center = Math.max(halfWidth, Math.min(position, timelineWidth - halfWidth));
        const accessibleLabel = `${issueKey} ${step} ${SCHEDULE_DATE_LABELS[endpoint]} 선택`;
        return (
          <button key={endpoint} type="button" className="gantt-link-endpoint"
            data-endpoint={endpoint} aria-label={accessibleLabel} title={accessibleLabel}
            style={{ left: center, width }} disabled={!canPick(endpoint)} onClick={() => onPick(endpoint)}>
            <span aria-hidden="true">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
