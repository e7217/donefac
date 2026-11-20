'use client';

import { useId, useMemo, useState } from 'react';
import { STATUS, type FeatureProps, type ReportStatusDuration } from '../../shared/types';

const pageSize = 25;

function distinctStatusLabels(statuses: ReadonlyMap<string, string>) {
  const counts = new Map<string, number>();
  for (const label of statuses.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
  return new Map([...statuses].map(([id, label]) => [id, (counts.get(label) ?? 0) > 1 ? `${label} (${id})` : label]));
}

export function reportDuration(hours: number | null): string {
  if (hours === null) return '표본 없음';
  if (hours > 0 && hours < 1 / 60) return '1분 미만';
  return hours > 0 && hours < 1
    ? `${(hours * 60).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}분`
    : `${hours.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}시간`;
}

export function StatusDurationReport({ data, report, projectId, frozen, openIssue, formatTime }: {
  data: FeatureProps['data'];
  report: ReportStatusDuration;
  projectId: string;
  frozen: boolean;
  openIssue: FeatureProps['openIssue'];
  formatTime: (value: string) => string;
}) {
  const headingId = useId();
  const queueHeadingId = useId();
  const [status, setStatus] = useState<{ id: string; label: string } | null>(null);
  const [offset, setOffset] = useState(0);
  const activeIds = useMemo(() => new Set(data.issues.filter(issue => issue.projectId === projectId).map(issue => issue.id)), [data.issues, projectId]);
  const options = new Map(report.openIssues.map(issue => [issue.statusId, issue.statusLabel]));
  if (status && !options.has(status.id)) options.set(status.id, status.label);
  const currentLabels = distinctStatusLabels(options);
  const periodLabels = distinctStatusLabels(new Map(report.completedVisits.map(visit => [visit.statusId, visit.statusLabel])));
  const rows = status ? report.openIssues.filter(issue => issue.statusId === status.id) : report.openIssues;
  const start = Math.min(offset, Math.max(0, Math.floor((rows.length - 1) / pageSize) * pageSize));

  return <section className="card reports-status-duration" aria-labelledby={headingId}>
    <header>
      <h2 id={headingId}>상태별 체류 시간</h2>
      <p>선택 기간에 해당 상태에서 나간 업무를 집계합니다. 유형과 담당자는 전이 직전 값이며, 진입과 이탈을 모두 관측한 경과 시간으로 중앙값을 계산합니다. 야간과 휴무도 포함합니다.</p>
    </header>
    {report.completedVisits.length ? <div className="reports-table-scroll">
      <table aria-label="선택 기간의 상태별 기록">
        <thead>
          <tr><th scope="col">상태</th><th scope="col">중앙값</th><th scope="col">최장</th><th scope="col">관측 표본</th><th scope="col">진입 시점 미관측</th></tr>
        </thead>
        <tbody>{report.completedVisits.map(visit => <tr key={visit.statusId}>
          <th scope="row"><strong>{periodLabels.get(visit.statusId)}</strong>{visit.statusLabel !== STATUS[visit.category].label && <small>{STATUS[visit.category].label}</small>}</th>
          <td>{reportDuration(visit.medianHours)}</td>
          <td>{reportDuration(visit.maxHours)}</td>
          <td>{visit.samples.toLocaleString()}회</td>
          <td>{visit.unknownEntries.toLocaleString()}회</td>
        </tr>)}</tbody>
      </table>
    </div> : <p className="reports-no-rows">선택 기간에 관측된 상태 전이가 없습니다.</p>}
    <section className="reports-dwell-queue" aria-labelledby={queueHeadingId}>
      <header>
        <div>
          <h3 id={queueHeadingId}>현재 상태에 머무는 업무</h3>
          <p>{frozen ? '보관 당시' : '보고서 조회 시점의'} 미완료 업무입니다. 선택 기간과 관계없이 오래 머문 순서로 표시합니다.</p>
        </div>
        {options.size > 0 && <label>상태
          <select className="field" aria-label="현재 체류 상태 필터" value={status?.id ?? ''} onChange={event => {
            const id = event.target.value;
            const label = options.get(id);
            setStatus(label === undefined ? null : { id, label });
            setOffset(0);
          }}>
            <option value="">모든 상태</option>
            {[...currentLabels].sort(([a, aLabel], [b, bLabel]) => aLabel.localeCompare(bLabel, 'ko-KR') || a.localeCompare(b)).map(([id, label]) =>
              <option value={id} key={id}>{label}</option>)}
          </select>
        </label>}
      </header>
      {rows.length ? <ul className="reports-dwell-issues" aria-label="체류 중인 업무 목록">
        {rows.slice(start, start + pageSize).map(issue => <li key={issue.issueId}>
          {activeIds.has(issue.issueId) ? <button type="button" className="reports-issue-link" aria-label={`${issue.key} ${issue.title}`} onClick={() => openIssue(issue.issueId)}>
            <strong>{issue.key}</strong><span>{issue.title}</span>
          </button> : <span className="reports-missing-issue"><strong>{issue.key}</strong><span>{issue.title}</span><small>현재 열 수 없는 업무</small></span>}
          <span className="reports-status"><i style={{ background: STATUS[issue.category].color }} />{currentLabels.get(issue.statusId)}</span>
          <div className="reports-dwell-elapsed">
            {issue.enteredAt !== null && issue.elapsedHours !== null ? <>
              <strong>{reportDuration(issue.elapsedHours)}</strong>
              <small>진입 {formatTime(issue.enteredAt)}</small>
            </> : <small>진입 시점 미관측</small>}
          </div>
        </li>)}
      </ul> : <p className="reports-no-rows">{status ? '선택한 상태에 머무는 업무가 없습니다.' : '조건에 맞는 미완료 업무가 없습니다.'}</p>}
      {rows.length > pageSize && <div className="reports-pagination">
        <span>{start + 1}–{Math.min(start + pageSize, rows.length)} / {rows.length}</span>
        <button type="button" className="btn btn-ghost" aria-label="체류 업무 이전 페이지" disabled={start === 0}
          onClick={() => setOffset(Math.max(0, start - pageSize))}>이전</button>
        <button type="button" className="btn btn-ghost" aria-label="체류 업무 다음 페이지" disabled={start + pageSize >= rows.length}
          onClick={() => setOffset(start + pageSize)}>다음</button>
      </div>}
    </section>
  </section>;
}
