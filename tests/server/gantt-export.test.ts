import assert from 'node:assert/strict';
import test from 'node:test';
import type { GanttExportReport, GanttExportRow } from '../../shared/gantt-export-model.js';
import { renderGanttExport } from '../../shared/gantt-export.js';

function report(overrides: Partial<GanttExportReport> = {}): GanttExportReport {
  return {
    title: '팀 프로젝트 간트',
    capturedAt: '2026-11-21T02:03:04.000Z',
    range: { startDate: '2026-11-20', endDate: '2026-11-29' },
    today: '2026-11-21',
    nonworkingDates: ['2026-11-21', '2026-11-22'],
    filters: ['공유 보기 · 진행 계획', '완료 업무 숨기기'],
    baselineName: '납기 기준선',
    rows: [],
    dependencies: [],
    ...overrides,
  };
}

function row(overrides: Partial<GanttExportRow>): GanttExportRow {
  return {
    kind: 'issue', key: 'TEAM-1', title: '신규 업무', projectKey: 'TEAM', kindLabel: null,
    status: '진행 중', assignee: '김 팀원', startDate: null, endDate: null, targetDate: null,
    baseline: null, historical: false,
    ...overrides,
  };
}

function bodyRows(html: string, className: string): string[] {
  return [...html.matchAll(new RegExp(`<tr class="${className}"(?: [^>]*)?>([\\s\\S]*?)</tr>`, 'g'))].map(match => match[1]);
}

test('Gantt HTML renders ordered timeline rows with inclusive clipped bars and retained dates', () => {
  const html = renderGanttExport(report({ rows: [
    row({ kind: 'plan', kindLabel: '사이클', key: null, title: '분기 계획', startDate: '2026-11-18', endDate: '2026-11-22', targetDate: '2026-11-23' }),
    row({ title: '개선 업무', startDate: '2026-11-27', endDate: '2026-12-05', targetDate: '2026-12-03',
      baseline: { startDate: '2026-11-25', endDate: '2026-11-26', targetDate: null } }),
    row({ key: 'TEAM-2', title: '시작일만 기록', startDate: '2026-11-25' }),
    row({ key: 'TEAM-3', title: '범위 밖 업무', startDate: '2026-12-10', endDate: '2026-12-12' }),
    row({ key: 'TEAM-4', title: '삭제된 업무', historical: true, status: '삭제된 업무 기록',
      baseline: { startDate: '2026-11-19', endDate: '2026-11-21', targetDate: null } }),
    row({ kind: 'milestone', kindLabel: '마일스톤', key: null, title: '시험 완료', targetDate: '2026-11-25',
      baseline: { startDate: null, endDate: null, targetDate: '2026-11-28' } }),
    row({ kind: 'milestone', kindLabel: '마일스톤', key: null, title: '삭제된 목표', historical: true, status: '삭제된 마일스톤 기록',
      baseline: { startDate: null, endDate: null, targetDate: '2026-12-01' } }),
  ] }));
  assert.match(html, /^<!DOCTYPE html>\n<html lang="ko">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<h1>팀 프로젝트 간트<\/h1>/);
  assert.match(html, /<dd id="export-range"><time datetime="2026-11-20">2026\.11\.20<\/time> ~ <time datetime="2026-11-29">2026\.11\.29<\/time>/);
  assert.match(html, /2026\.11\.21 02:03:04 UTC/);
  assert.match(html, /공유 보기 · 진행 계획/);
  assert.match(html, /완료 업무 숨기기/);
  assert.match(html, /비교 기준선[\s\S]*?납기 기준선/);
  assert.match(html, /linear-gradient\(to right,transparent 0% 10%,#e9edf1 10% 30%,transparent 30% 100%\)/);
  assert.match(html, /class="today-line" style="left:15%"/);
  assert.match(html, /role="region" aria-label="일정 타임라인 스크롤" tabindex="0"/);
  assert.match(html, /<thead><tr><th scope="col">항목<\/th><th scope="col">날짜<\/th>/);

  const rows = bodyRows(html, 'timeline-row');
  assert.equal(rows.length, 7);
  assert.match(rows[0], /사이클[\s\S]*분기 계획[\s\S]*datetime="2026-11-18"/);
  assert.match(rows[0], /class="date-bar is-clipped-start" style="left:0%;width:30%"/);
  assert.match(rows[0], /class="date-marker" style="left:35%"/);
  assert.match(rows[1], /TEAM-1[\s\S]*개선 업무[\s\S]*진행 중[\s\S]*김 팀원/);
  assert.match(rows[1], /목표 마감일<\/dt><dd><time datetime="2026-12-03"/);
  assert.match(rows[1], /class="date-bar is-clipped-end" style="left:70%;width:30%"/);
  assert.match(rows[1], /class="date-bar is-baseline" style="left:50%;width:20%"/);
  assert.match(rows[2], /datetime="2026-11-25"[\s\S]*종료일<\/dt><dd>미정/);
  assert.match(rows[2], /class="date-endpoint" style="left:55%"/);
  assert.doesNotMatch(rows[2], /class="date-bar/);
  assert.match(rows[3], /datetime="2026-12-10"[\s\S]*datetime="2026-12-12"[\s\S]*표시 기간 밖/);
  assert.doesNotMatch(rows[3], /class="date-bar/);
  assert.match(rows[4], /삭제된 업무 기록[\s\S]*datetime="2026-11-19"/);
  assert.match(rows[4], /class="date-bar is-baseline is-clipped-start" style="left:0%;width:20%"/);
  assert.match(rows[5], /시험 완료[\s\S]*datetime="2026-11-25"[\s\S]*datetime="2026-11-28"/);
  assert.match(rows[5], /class="date-marker" style="left:55%"/);
  assert.match(rows[5], /class="date-marker is-baseline" style="left:85%"/);
  assert.match(rows[6], /삭제된 마일스톤 기록[\s\S]*datetime="2026-12-01"[\s\S]*표시 기간 밖/);
  assert.doesNotMatch(rows[6], /class="date-marker/);
});

test('Gantt HTML preserves dependency direction, relation, signed lag and check details', () => {
  const html = renderGanttExport(report({ dependencies: [
    { predecessorKey: 'TEAM-9', successorKey: 'TEAM-2', type: 'SF', lagDays: -3,
      check: { kind: 'conflict', predecessorEndpoint: 'startDate', predecessorDate: '2026-11-27',
        successorEndpoint: 'endDate', successorDate: '2026-11-22', requiredDate: '2026-11-24' } },
    { predecessorKey: 'TEAM-2', successorKey: 'TEAM-5', type: 'FS', lagDays: 0,
      check: { kind: 'missing', predecessorEndpoint: 'endDate', predecessorDate: '2026-11-22',
        successorEndpoint: 'startDate', successorDate: null } },
    { predecessorKey: 'TEAM-5', successorKey: 'TEAM-8', type: 'FF', lagDays: 2, check: { kind: 'valid' } },
    { predecessorKey: 'TEAM-8', successorKey: 'TEAM-9', type: 'SS', lagDays: 0, check: { kind: 'invalid', reason: '점검 범위 밖' } },
    { predecessorKey: 'TEAM-2', successorKey: 'TEAM-8', type: 'SF', lagDays: 0, check: null },
  ] }));
  assert.match(html, /aria-label="업무 연결"[\s\S]*선행 업무[\s\S]*후행 업무/);
  const dependencies = bodyRows(html, 'dependency-row');
  assert.equal(dependencies.length, 5);
  assert.match(dependencies[0], /TEAM-9[\s\S]*TEAM-2[\s\S]*시작 후 완료 \(SF\)[\s\S]*-3근무일[\s\S]*일정 충돌/);
  assert.match(dependencies[0], /선행 시작일[\s\S]*datetime="2026-11-27"[\s\S]*후행 종료일[\s\S]*datetime="2026-11-22"[\s\S]*후행 필요 날짜[\s\S]*datetime="2026-11-24"/);
  assert.match(dependencies[1], /완료 후 시작 \(FS\)[\s\S]*0근무일[\s\S]*날짜 미정[\s\S]*후행 시작일 미정/);
  assert.match(dependencies[2], /완료 후 완료 \(FF\)[\s\S]*\+2근무일[\s\S]*충돌 없음/);
  assert.match(dependencies[3], /시작 후 시작 \(SS\)[\s\S]*점검 필요[\s\S]*점검 범위 밖/);
  assert.match(dependencies[4], /미점검/);
});

test('Gantt HTML escapes user strings and includes print styles without active or external content', () => {
  const payload = '<img src="https://evil.test/x" onerror="alert(1)"> & \'<script>\r\n내용';
  const html = renderGanttExport(report({
    title: payload, baselineName: payload, capturedAt: '2026-11-21T11:03:04.000+09:00', filters: [payload],
    rows: [row({ key: payload, title: payload, kindLabel: payload, status: payload, assignee: payload, startDate: payload })],
    dependencies: [{ predecessorKey: payload, successorKey: payload, type: payload, lagDays: 0, check: { kind: 'invalid', reason: payload } }],
  }));
  assert.doesNotMatch(html, /<(?:script|iframe|img|link)\b|\s(?:src|href)="https?:\/\//);
  assert.ok(html.includes('&lt;img src=&quot;https://evil.test/x&quot; onerror=&quot;alert(1)&quot;&gt; &amp; &#39;&lt;script&gt;&#13;\n내용'));
  assert.match(html, /<time datetime="2026-11-21T11:03:04\.000\+09:00">2026\.11\.21 02:03:04 UTC<\/time>/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"/);
  assert.match(html, /@page \{ size: A4 landscape;/);
  assert.match(html, /@media print \{[\s\S]*\.table-scroll \{ overflow: visible;[\s\S]*min-width: 0; width: 100%;[\s\S]*thead \{ display: table-header-group;/);
});

test('Gantt HTML handles an empty report and a one-day timeline', () => {
  const empty = renderGanttExport(report({ filters: [], baselineName: null }));
  assert.match(empty, /적용된 조건 없음/);
  assert.match(empty, /표시할 일정 항목이 없습니다/);
  assert.match(empty, /표시할 업무 연결이 없습니다/);
  assert.doesNotMatch(empty, /비교 기준선/);

  const day = '2026-11-21';
  const one = renderGanttExport(report({
    range: { startDate: day, endDate: day },
    rows: [row({ startDate: day, endDate: day, targetDate: day })],
  }));
  assert.match(one, /class="date-bar" style="left:0%;width:100%"/);
  assert.match(one, /class="date-marker" style="left:50%"/);
});
