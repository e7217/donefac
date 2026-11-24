import { calendarDate, calendarDay, isCalendarDate } from './calendar.js';
import type { GanttExportDependency, GanttExportReport, GanttExportRow } from './gantt-export-model.js';
import { DEPENDENCY_LABELS, isDependencyType, SCHEDULE_DATE_LABELS } from './schedule-dependencies.js';

type Dates = Pick<GanttExportRow, 'startDate' | 'endDate' | 'targetDate'>;
type Plot = { start: number; end: number; days: number };

const htmlEntities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;' };
const escapeHtml = (text: string) => text.replace(/[&<>"'\r]/g, character => htmlEntities[character]);
const text = (value: string) => `<span class="plain-text">${escapeHtml(value)}</span>`;
const percent = (offset: number, plot: Plot) => `${Number((offset / plot.days * 100).toFixed(6))}%`;
const dateDay = (value: string | null) => isCalendarDate(value) ? calendarDay(value) : null;

function dateText(value: string | null): string {
  if (value === null) return '미정';
  if (!isCalendarDate(value)) return text(value);
  return `<time datetime="${value}">${value.replaceAll('-', '.')}</time>`;
}

function captureText(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return text(value);
  const [day, time] = date.toISOString().split('T');
  return `<time datetime="${escapeHtml(value)}">${day.replaceAll('-', '.')} ${time.slice(0, 8)} UTC</time>`;
}

function dateBar(dates: Dates, plot: Plot, baseline: boolean): string {
  const start = dateDay(dates.startDate);
  const end = dateDay(dates.endDate);
  if (start === null || end === null) return '';
  const left = Math.max(start, plot.start);
  const right = Math.min(end, plot.end);
  if (left > right) return '';

  const classes = ['date-bar'];
  if (baseline) classes.push('is-baseline');
  if (start < plot.start) classes.push('is-clipped-start');
  if (end > plot.end) classes.push('is-clipped-end');
  return `<span class="${classes.join(' ')}" style="left:${percent(left - plot.start, plot)};width:${percent(right - left + 1, plot)}"></span>`;
}

function dateMarker(value: string | null, plot: Plot, baseline: boolean, mark = 'date-marker'): string {
  const day = dateDay(value);
  if (day === null || day < plot.start || day > plot.end) return '';
  return `<span class="${mark}${baseline ? ' is-baseline' : ''}" style="left:${percent(day - plot.start + .5, plot)}"></span>`;
}

function partialDate(dates: Dates): string | null {
  return dates.startDate && dates.endDate ? null : dates.startDate ?? dates.endDate;
}

function dateMarks(dates: Dates, plot: Plot, baseline: boolean): string {
  return dateBar(dates, plot, baseline) + dateMarker(dates.targetDate, plot, baseline) +
    dateMarker(partialDate(dates), plot, baseline, 'date-endpoint');
}

function dateFields(dates: Dates, row: GanttExportRow, plot: Plot, baseline = false): string {
  const milestone = row.kind === 'milestone';
  const targetLabel = milestone ? '날짜' : row.kind === 'issue' ? '목표 마감일' : '목표일';
  const values = [
    ...(!milestone ? [['시작일', dates.startDate], ['종료일', dates.endDate]] as const : []),
    ...(milestone || dates.targetDate !== null ? [[targetLabel, dates.targetDate]] as const : []),
  ];
  const start = dateDay(dates.startDate);
  const end = dateDay(dates.endDate);
  const days = [start, end, dateDay(dates.targetDate)].filter(day => day !== null);
  const intervalOverlaps = start !== null && end !== null && start <= end && start <= plot.end && end >= plot.start;
  const outside = days.length > 0 && !intervalOverlaps && days.every(day => day < plot.start || day > plot.end);
  return `<div class="date-fields${baseline ? ' baseline-fields' : ''}">
    ${baseline ? '<strong>기준선</strong>' : ''}
    <dl>${values.map(([label, value]) => `<div><dt>${label}</dt><dd>${dateText(value)}</dd></div>`).join('')}</dl>
    ${outside ? '<span class="date-note">표시 기간 밖</span>' : ''}
  </div>`;
}

function nonworkingBands(dates: string[], plot: Plot): string {
  const days = [...new Set(dates.map(dateDay).filter((day): day is number => day !== null && day >= plot.start && day <= plot.end))]
    .sort((a, b) => a - b);
  if (!days.length) return '';
  const stops: string[] = [];
  let cursor = 0;
  for (let index = 0; index < days.length; index++) {
    const start = days[index] - plot.start;
    while (days[index + 1] === days[index] + 1) index++;
    const end = days[index] - plot.start + 1;
    stops.push(`transparent ${percent(cursor, plot)} ${percent(start, plot)}`, `#e9edf1 ${percent(start, plot)} ${percent(end, plot)}`);
    cursor = end;
  }
  if (cursor < plot.days) stops.push(`transparent ${percent(cursor, plot)} 100%`);
  return `linear-gradient(to right,${stops.join(',')})`;
}

function axis(plot: Plot, today: string): { labels: string; grid: string; todayLine: string } {
  const count = Math.min(5, plot.days);
  const offsets = Array.from({ length: count }, (_, index) => count === 1 ? 0 : Math.round(index * (plot.days - 1) / (count - 1)));
  const ticks = offsets.map(offset => ({
    date: calendarDate(plot.start + offset),
    position: percent(offset + .5, plot),
  }));
  const todayDay = dateDay(today);
  return {
    labels: ticks.map(({ date, position }) => `<span class="axis-label" style="--position:${position}">${date.slice(5).replace('-', '.')}</span>`).join(''),
    grid: ticks.map(({ position }) => `<span class="grid-line" style="left:${position}"></span>`).join(''),
    todayLine: todayDay !== null && todayDay >= plot.start && todayDay <= plot.end
      ? `<span class="today-line" style="left:${percent(todayDay - plot.start + .5, plot)}"></span>` : '',
  };
}

function timelineRow(row: GanttExportRow, plot: Plot, grid: string): string {
  const kind = row.historical ? `historical-${row.kind}` : row.kind;
  const context = [row.key ?? row.projectKey, row.projectName ?? null, row.kindLabel].filter(value => value !== null);
  const fields = [
    ...(!row.historical ? [dateFields(row, row, plot)] : []),
    ...(row.baseline ? [dateFields(row.baseline, row, plot, true)] : []),
  ];
  const marks = [
    ...(!row.historical ? [dateMarks(row, plot, false)] : []),
    ...(row.baseline ? [dateMarks(row.baseline, plot, true)] : []),
  ];
  return `<tr class="timeline-row" data-kind="${escapeHtml(kind)}">
    <th scope="row">
      ${context.length ? `<span class="item-context">${context.map(escapeHtml).join(' · ')}</span>` : ''}
      <strong class="item-title">${text(row.title)}</strong>
      ${row.status !== null ? `<span class="item-detail">${text(row.status)}</span>` : ''}
      ${row.assignee !== null ? `<span class="item-detail">담당 ${text(row.assignee)}</span>` : ''}
    </th>
    <td>${fields.join('')}</td>
    <td class="plot-cell">
      <div class="track${row.baseline ? ' has-baseline' : ''}" aria-hidden="true">${grid}${marks.join('')}</div>
    </td>
  </tr>`;
}

function dependencyCheck(check: GanttExportDependency['check']): string {
  if (!check) return '미점검';
  if (check.kind === 'valid') return '충돌 없음';
  if (check.kind === 'invalid') return `<strong>점검 필요</strong><span class="dependency-detail">${text(check.reason)}</span>`;
  const dates = `선행 ${SCHEDULE_DATE_LABELS[check.predecessorEndpoint]} ${dateText(check.predecessorDate)}
    · 후행 ${SCHEDULE_DATE_LABELS[check.successorEndpoint]} ${dateText(check.successorDate)}`;
  if (check.kind === 'missing') return `<strong>날짜 미정</strong><span class="dependency-detail">${dates}</span>`;
  return `<strong>일정 충돌</strong><span class="dependency-detail">${dates} · 후행 필요 날짜 ${dateText(check.requiredDate)}</span>`;
}

function dependencyRow(dependency: GanttExportDependency): string {
  const { predecessorKey, successorKey, type, lagDays, check, teamBlocker } = dependency;
  const label = isDependencyType(type) ? `${DEPENDENCY_LABELS[type]} (${type})` : text(type);
  const crossProjectLabel = teamBlocker ? '<strong>프로젝트 간 차단</strong> · ' : '';
  const lag = escapeHtml(`${lagDays > 0 ? '+' : ''}${lagDays}근무일`);
  return `<tr class="dependency-row"><th scope="row">${text(predecessorKey)}</th>
    <td>${text(successorKey)}</td><td>${crossProjectLabel}${label}</td><td>${lag}</td><td>${dependencyCheck(check)}</td></tr>`;
}

const styles = `
:root { color-scheme: light; font-family: system-ui, "Noto Sans KR", "Malgun Gothic", sans-serif; color: #182230; background: #f0f3f6; }
* { box-sizing: border-box; }
body { margin: 0; }
main { max-width: 90rem; margin: auto; padding: clamp(.9rem, 4vw, 2.8rem); }
.report-header { border-bottom: 2px solid #334155; padding-bottom: 1.15rem; }
h1, h2, p { margin: 0; }
h1 { font-size: clamp(1.5rem, 4vw, 2.25rem); line-height: 1.2; letter-spacing: -.025em; overflow-wrap: anywhere; white-space: pre-wrap; }
h2 { font-size: 1.2rem; margin-bottom: .65rem; }
section { margin-top: 1.65rem; }
dl { margin: 0; }
dd { margin: 0; }
dt { color: #45536a; }
.report-details { display: flex; flex-wrap: wrap; gap: .65rem 1.5rem; margin-top: 1rem; font-size: .92rem; }
.report-details > div { min-width: 0; }
.report-details dt { font-size: .8em; font-weight: 650; margin-bottom: .2em; }
.plain-text { white-space: pre-wrap; overflow-wrap: anywhere; }
time { white-space: nowrap; font-variant-numeric: tabular-nums; }
.filters, .timeline-key { display: flex; flex-wrap: wrap; gap: .3rem .8rem; margin: 0; padding: 0; list-style: none; }
.timeline-key { gap: .25rem 1rem; margin-bottom: .65rem; font-size: .85rem; color: #344155; }
.timeline-key li { display: flex; gap: .35em; align-items: center; }
.key-bar, .key-baseline { width: 1.4em; height: .65em; border: 2px solid #285c69; background: #2c6978; border-radius: .15em; }
.key-baseline { border: 1px dashed #4a5669; background: transparent; }
.key-marker { width: .65em; height: .65em; border: 2px solid #182230; transform: rotate(45deg); margin: 0 .2em; background: #fff; }
.key-endpoint { width: .65em; height: .65em; border: 2px solid #182230; border-radius: 50%; margin: 0 .2em; background: #fff; }
.key-nonworking { width: 1.4em; height: .65em; border: 1px solid #727d8a; background: #e9edf1; }
.key-today { height: 1em; border-left: 2px dashed #475569; margin: 0 .55em; }
.table-scroll { overflow-x: auto; max-width: 100%; border: 1px solid #c9d4df; background: white; }
.table-scroll:focus-visible { outline: 2px solid #285c69; outline-offset: 2px; }
table { border-collapse: collapse; table-layout: fixed; width: 100%; font-size: .875rem; }
.timeline-table { min-width: 49rem; }
.dependency-table { min-width: 37rem; }
.item-column { width: 26%; }
.dates-column { width: 23%; }
.dependency-table col:first-child, .dependency-table col:nth-child(2) { width: 13%; }
.dependency-table col:nth-child(3) { width: 17%; }
.dependency-table col:nth-child(4) { width: 13%; }
th, td { border-bottom: 1px solid #d4dce5; padding: .6rem .7rem; vertical-align: middle; text-align: start; overflow-wrap: anywhere; }
thead th { background: #eff3f6; color: #243447; font-weight: 700; border-bottom: 1px solid #9eabb9; }
tbody tr:last-child > * { border-bottom: 0; }
tbody th { font-weight: normal; }
.item-context, .item-title, .item-detail { display: block; }
.item-context { font-size: .79em; color: #45536a; font-weight: 700; white-space: pre-wrap; }
.item-title { line-height: 1.25; }
.item-detail { color: #405067; font-size: .86em; }
.item-title + .item-detail { margin-top: .25em; }
.date-fields { font-size: .9em; }
.date-fields dl > div { display: flex; flex-wrap: wrap; gap: 0 .5em; }
.date-fields dt { min-width: 3.5em; }
.baseline-fields { color: #45536a; }
.baseline-fields:not(:first-child) { margin-top: .3em; padding-top: .3em; border-top: 1px dashed #bdc7d1; }
.baseline-fields strong { font-size: .9em; }
.date-note { display: block; color: #45536a; font-size: .9em; margin-top: .15em; }
.axis { position: relative; height: 1.6em; margin-top: .16rem; }
.axis-label { position: absolute; left: clamp(2ch, var(--position), calc(100% - 2ch)); transform: translateX(-50%); top: 0; font-size: .84em; white-space: nowrap; font-variant-numeric: tabular-nums; }
.track { position: relative; height: 1.65rem; border: 1px solid #aab8c5; background: var(--calendar-bands, #fff); overflow: hidden; }
.track.has-baseline { height: 2.65rem; }
.grid-line, .today-line { position: absolute; inset-block: 0; border-left: 1px solid #c2ccd6; }
.today-line { border-left: 2px dashed #536174; }
.date-bar { position: absolute; top: .34rem; height: .85rem; border: 2px solid #285c69; background: #2c6978; border-radius: .16rem; }
.date-bar.is-baseline { top: 1.38rem; border: 1px dashed #243347; background: transparent; }
.date-bar.is-clipped-start { border-start-start-radius: 0; border-end-start-radius: 0; }
.date-bar.is-clipped-end { border-start-end-radius: 0; border-end-end-radius: 0; }
.date-marker, .date-endpoint { position: absolute; top: .47rem; width: .62rem; height: .62rem; transform: translateX(-50%); border: 2px solid #172033; background: white; }
.date-marker { transform: translateX(-50%) rotate(45deg); }
.date-endpoint { border-radius: 50%; }
.date-marker.is-baseline, .date-endpoint.is-baseline { top: 1.51rem; border: 1px dashed #243347; }
.dependency-detail { display: block; margin-top: .22rem; color: #405067; font-size: .9em; }
.empty { padding: .9rem; color: #45536a; border: 1px solid #c9d4df; background: white; }
@page { size: A4 landscape; margin: 10mm; }
@media print {
  :root { background: white; color: black; font-size: 10.5pt; print-color-adjust: exact; }
  main { max-width: none; margin: 0; padding: 0; }
  .report-header { break-inside: avoid; }
  h1 { font-size: 18pt; }
  h2 { break-after: avoid; }
  section { margin-top: 1.1rem; }
  .timeline-key { break-after: avoid; }
  .table-scroll { overflow: visible; max-width: none; width: 100%; }
  .timeline-table, .dependency-table { min-width: 0; width: 100%; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th, td { padding: .32rem .45rem; }
  .date-bar, .key-bar { background: #d5dce2; border-color: #172033; }
}
`;

export function renderGanttExport(report: GanttExportReport): string {
  const start = calendarDay(report.range.startDate);
  const end = calendarDay(report.range.endDate);
  const plot = { start, end, days: end - start + 1 };
  const chart = axis(plot, report.today);
  const bands = nonworkingBands(report.nonworkingDates, plot);
  const legend = [
    '<li><span class="key-bar" aria-hidden="true"></span>현재 일정</li>',
    ...(report.baselineName !== null ? ['<li><span class="key-baseline" aria-hidden="true"></span>기준선</li>'] : []),
    '<li><span class="key-marker" aria-hidden="true"></span>목표일·마일스톤</li>',
    ...(report.rows.some(row => partialDate(row) || (row.baseline && partialDate(row.baseline)))
      ? ['<li><span class="key-endpoint" aria-hidden="true"></span>시작일 또는 종료일만 지정</li>'] : []),
    ...(bands ? ['<li><span class="key-nonworking" aria-hidden="true"></span>비근무일</li>'] : []),
    ...(chart.todayLine ? [`<li><span class="key-today" aria-hidden="true"></span>오늘 ${dateText(report.today)}</li>`] : []),
  ];
  const timeline = report.rows.length ? `<ul class="timeline-key">${legend.join('')}</ul>
    <div class="table-scroll" role="region" aria-label="일정 타임라인 스크롤" tabindex="0">
      <table class="timeline-table" aria-label="일정 타임라인"${bands ? ` style="--calendar-bands:${bands}"` : ''}>
        <colgroup><col class="item-column"><col class="dates-column"><col></colgroup>
        <thead><tr><th scope="col">항목</th><th scope="col">날짜</th>
          <th scope="col">표시 기간<div class="axis" aria-hidden="true">${chart.labels}</div></th></tr></thead>
        <tbody>${report.rows.map(row => timelineRow(row, plot, chart.grid + chart.todayLine)).join('')}</tbody>
      </table>
    </div>` : '<p class="empty">표시할 일정 항목이 없습니다.</p>';
  const dependencies = report.dependencies.length ? `<div class="table-scroll" role="region" aria-label="업무 연결 스크롤" tabindex="0">
    <table class="dependency-table" aria-label="업무 연결">
      <colgroup><col><col><col><col><col></colgroup>
      <thead><tr><th scope="col">선행 업무</th><th scope="col">후행 업무</th><th scope="col">연결 유형</th>
        <th scope="col">근무일 간격</th><th scope="col">일정 점검</th></tr></thead>
      <tbody>${report.dependencies.map(dependencyRow).join('')}</tbody>
    </table>
  </div>` : '<p class="empty">표시할 업무 연결이 없습니다.</p>';
  const filters = report.filters.length
    ? `<ul class="filters">${report.filters.map(filter => `<li>${text(filter)}</li>`).join('')}</ul>`
    : '적용된 조건 없음';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(report.title)}</title>
  <style>${styles}</style>
</head>
<body>
  <main>
    <header class="report-header">
      <h1>${escapeHtml(report.title)}</h1>
      <dl class="report-details">
        <div><dt>표시 기간</dt><dd id="export-range">${dateText(report.range.startDate)} ~ ${dateText(report.range.endDate)}</dd></div>
        <div><dt>캡처 시각</dt><dd>${captureText(report.capturedAt)}</dd></div>
        ${report.baselineName !== null ? `<div><dt>비교 기준선</dt><dd>${text(report.baselineName)}</dd></div>` : ''}
        <div><dt>보기 조건</dt><dd>${filters}</dd></div>
      </dl>
    </header>
    <section aria-labelledby="timeline-heading"><h2 id="timeline-heading">일정 타임라인</h2>${timeline}</section>
    <section aria-labelledby="dependencies-heading"><h2 id="dependencies-heading">업무 연결</h2>${dependencies}</section>
  </main>
</body>
</html>
`;
}
