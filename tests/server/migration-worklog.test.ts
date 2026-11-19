import assert from 'node:assert/strict';
import test from 'node:test';
import type { LegacyRecord, LegacyValue } from '../../shared/types.js';
import { record } from '../../server/legacy-import-model.js';
import { parseJira } from '../../server/legacy-import-jira.js';
import {
  isJiraWorklog,
  isRestrictedJiraWorklog,
  MAX_JIRA_WORKLOG_SECONDS,
  parseJiraWorklog,
  type ParsedJiraWorklog,
} from '../../server/migration-worklog.js';

const row = (metadata: Record<string, LegacyValue> = {}): LegacyRecord => record('history', 'worklog:1', {
  metadata: { kind: 'worklog', started: '2026-11-19T10:30:45.123+0900', timeSpentSeconds: '91', ...metadata },
});
function parsed(value: LegacyRecord, timeZone = 'Asia/Seoul'): ParsedJiraWorklog {
  const result = parseJiraWorklog(value, timeZone);
  assert.ok(!('code' in result), JSON.stringify(result));
  return result;
}
function code(value: LegacyRecord, timeZone = 'Asia/Seoul'): string {
  const result = parseJiraWorklog(value, timeZone);
  assert.ok('code' in result, JSON.stringify(result));
  return result.code;
}
function textDuration(value: LegacyValue): LegacyRecord {
  const result = row({ timeSpent: value });
  delete result.metadata.timeSpentSeconds;
  return result;
}

test('only explicitly identified history worklogs are selected; restriction attributes preserve conservative scope', () => {
  assert.equal(isJiraWorklog(row()), true);
  assert.equal(isJiraWorklog({ ...row(), kind: 'comment' }), false);
  assert.equal(isJiraWorklog(row({ kind: 'change' })), false);
  const restrictedCases: Record<string, LegacyValue>[] = [
    { rolelevel: '10001' }, { groupLevel: 'developers' }, { visibility: { type: 'group', value: 'staff' } },
    { restrictions: [{ type: 'role', value: '10' }] }, { hasRestrictions: true }, { restriction: 0 },
    { 'ROLE-LEVEL': '0' }, { viewGroup: 'private' }, { permissions: ['read-restricted'] },
  ];
  for (const metadata of restrictedCases) {
    assert.equal(isRestrictedJiraWorklog(row(metadata)), true, JSON.stringify(metadata));
  }
  const unrestrictedCases: Record<string, LegacyValue>[] = [
    {}, { rolelevel: '' }, { grouplevel: '  ' }, { visibility: null }, { visibility: {} },
    { restrictions: [] }, { restrictions: { role: '', group: null } }, { hasRestrictions: false },
  ];
  for (const metadata of unrestrictedCases) {
    assert.equal(isRestrictedJiraWorklog(row(metadata)), false, JSON.stringify(metadata));
  }
  assert.equal(isRestrictedJiraWorklog({ ...row({ visibility: 'private' }), kind: 'issue' }), false);
});

test('numeric seconds are authoritative, exact, positive and int32 bounded with no malformed numeric fallback', () => {
  assert.equal(parsed(row({ timeSpentSeconds: MAX_JIRA_WORKLOG_SECONDS })).durationSeconds, MAX_JIRA_WORKLOG_SECONDS);
  assert.equal(parsed(row({ timeSpentSeconds: ' 00091 ', timeworked: '999', timeSpent: '3h' })).durationSeconds, 91);
  const xml = row({ timeworked: '90001', timeSpent: '1m' });
  delete xml.metadata.timeSpentSeconds;
  assert.equal(parsed(xml).durationSeconds, 90001);
  for (const invalid of ['', 'bad', '60.0', '1e3', '-1', '0', '2147483648', 0, -1, 1.5, null, false, [], {}]) {
    assert.equal(code(row({ timeSpentSeconds: invalid, timeworked: '60', timeSpent: 'PT1M' })), 'WORKLOG_DURATION_INVALID', JSON.stringify(invalid));
    const invalidXml = row({ timeworked: invalid, timeSpent: 'PT1M' });
    delete invalidXml.metadata.timeSpentSeconds;
    assert.equal(code(invalidXml), 'WORKLOG_DURATION_INVALID', JSON.stringify(invalid));
  }
});

test('Importers ISO periods and human seconds/minutes/hours convert without rounding seconds', () => {
  for (const [input, seconds] of [
    ['PT1M', 60], ['PT3H', 10800], ['PT1H2M3S', 3723], ['PT90M', 5400],
    ['PT0.1M', 6], ['PT0.5H', 1800], ['2147483647s', MAX_JIRA_WORKLOG_SECONDS],
    ['1h 30m 45s', 5445], ['1h30m', 5400], ['2 hours 3 minutes 1 second', 7381],
    ['0.1min', 6], ['1.25 hr', 4500], ['91sec', 91], [' 2 H  5 M ', 7500],
    ['0.5s 0.5s', 1], ['PT0.01M0.4S', 1],
  ] as const) {
    assert.equal(parsed(textDuration(input)).durationSeconds, seconds, input);
  }
  for (const input of ['PT', 'P', 'PT0S', 'PT0.1S', '0.00001h', '0.3333m', '5', '1h junk', '1h -2m', '1ms', '1e3s', 'PT1M2H', {}, null]) {
    assert.equal(code(textDuration(input)), 'WORKLOG_DURATION_INVALID', JSON.stringify(input));
  }
  for (const input of ['P1D', 'P1W', 'P1W3D', 'P1DT2H', 'P1M', 'P1Y', '1d', '2 weeks', '1h 1 day']) {
    assert.equal(code(textDuration(input)), 'WORKLOG_DURATION_AMBIGUOUS', input);
  }
});

test('explicit offsets preserve the written local work date even when the UTC instant falls on another date', () => {
  assert.deepEqual(parsed(row({ started: '2012-08-31T00:30:02.161+1400' }), 'America/New_York'), {
    workDate: '2012-08-31', durationSeconds: 91, startedAt: '2012-08-30T10:30:02.161Z',
  });
  assert.deepEqual(parsed(row({ started: '2012-08-31T23:30:02-07:00' }), 'Asia/Seoul'), {
    workDate: '2012-08-31', durationSeconds: 91, startedAt: '2012-09-01T06:30:02.000Z',
  });
  assert.equal(parsed(row({ started: '2026-11-19T10:30Z' })).startedAt, '2026-11-19T10:30:00.000Z');
  assert.equal(parsed(row({ started: '2026-11-19 10:30:45.1+0900' })).startedAt, '2026-11-19T01:30:45.100Z');
});

test('strict start validation rejects normalized dates, clocks, offsets, precision loss and relative timestamps', () => {
  for (const started of [
    '2023-02-29T12:00:00Z', '2024-02-30T12:00:00Z', '2026-13-01T12:00:00Z',
    '2026-11-19T24:00:00Z', '2026-11-19T10:60:00Z', '2026-11-19T10:30:60Z',
    '2026-11-19T10:30:00+2400', '2026-11-19T10:30:00+0960', '2026-11-19T10:30:00+9',
    '2026-11-19T10:30:00.1234Z', '19/11/2026', 'P-1D', 'yesterday', '', null, 123,
  ]) assert.equal(code(row({ started })), 'WORKLOG_START_INVALID', String(started));
  const fallback = row({ startDate: '2026-11-19T00:00:00Z' });
  delete fallback.metadata.started;
  assert.equal(parsed(fallback).workDate, '2026-11-19');
  fallback.metadata.started = '';
  assert.equal(code(fallback), 'WORKLOG_START_INVALID');
  const createdOnly = row();
  delete createdOnly.metadata.started;
  createdOnly.createdAt = '2026-11-19T00:00:00Z';
  assert.equal(code(createdOnly), 'WORKLOG_START_INVALID');
});

test('date-only work dates have no invented instant, including skipped midnights/days; IANA configuration stays strict', () => {
  for (const [started, zone] of [
    ['2024-02-29', 'UTC'], ['2018-11-04', 'America/Sao_Paulo'], ['2011-12-30', 'Pacific/Apia'],
    ['0000-01-01', 'Asia/Seoul'], ['9999-12-31', 'America/New_York'],
  ]) assert.deepEqual(parsed(row({ started }), zone), { workDate: started, durationSeconds: 91, startedAt: null });
  for (const zone of ['not/a-zone', '+09:00', ' Asia/Seoul', '']) assert.equal(code(row(), zone), 'WORKLOG_START_INVALID');
});

test('timezone-less XML datetimes use exact IANA conversion and reject DST gaps/folds without choosing an occurrence', () => {
  const xml = row({ startdate: '2026-11-19 10:30:45.123' });
  delete xml.metadata.started;
  assert.equal(parsed(xml).startedAt, '2026-11-19T01:30:45.123Z');
  assert.equal(parsed(row({ started: '2024-03-10T01:30:00' }), 'America/New_York').startedAt, '2024-03-10T06:30:00.000Z');
  for (const [started, zone] of [
    ['2024-03-10T02:30:00', 'America/New_York'], ['2024-11-03T01:30:00', 'America/New_York'],
    ['2024-10-06T02:15:00', 'Australia/Lord_Howe'], ['2024-04-07T01:45:00', 'Australia/Lord_Howe'],
    ['2018-11-04T00:30:00', 'America/Sao_Paulo'], ['2011-12-30T12:00:00', 'Pacific/Apia'],
  ]) assert.equal(code(row({ started }), zone), 'WORKLOG_START_INVALID', `${started} ${zone}`);
  assert.equal(parsed(row({ started: '2024-11-03T01:30:00-0400' }), 'America/New_York').startedAt, '2024-11-03T05:30:00.000Z');
  assert.equal(parsed(row({ started: '2024-11-03T01:30:00-0500' }), 'America/New_York').startedAt, '2024-11-03T06:30:00.000Z');
});

test('REST analyzer preserves worklog start and restriction flags with raw notes while credential properties stay excluded', () => {
  const dataset = parseJira(new Map([['rest.json', Buffer.from(JSON.stringify({ issues: [{
    id: '1', key: 'OLD-1', fields: { summary: 'synthetic', worklog: { worklogs: [{
      id: '77', started: '2026-11-19T00:30:00+1400', startdate: '2026-11-19', timeSpentSeconds: 91,
      rolelevel: '10', groupLevel: 'staff', visibility: { type: 'group', value: 'internal', token: 'NEVER_COPY' },
      restrictions: { role: 'reviewers' }, hasRestrictions: true, comment: '원래 작업 메모',
    }] } },
  }] }))]]), 'synthetic-worklogs');
  const worklog = dataset.records.find(item => item.id === 'history:worklog:77');
  assert.ok(worklog);
  assert.equal(worklog.text, '원래 작업 메모');
  assert.equal(worklog.metadata.started, '2026-11-19T00:30:00+1400');
  assert.equal(worklog.metadata.startdate, '2026-11-19');
  assert.equal(worklog.metadata.timeSpentSeconds, '91');
  assert.equal(worklog.metadata.rolelevel, '10');
  assert.equal(worklog.metadata.groupLevel, 'staff');
  assert.deepEqual(worklog.metadata.visibility, { type: 'group', value: 'internal' });
  assert.equal(worklog.metadata.hasRestrictions, true);
  assert.equal(isRestrictedJiraWorklog(worklog), true);
  assert.equal(parsed(worklog).workDate, '2026-11-19');
  assert.ok(!JSON.stringify(dataset).includes('NEVER_COPY'));
});

test('XML and Importers JSON analyzers keep time units distinct and retain started/visibility metadata', () => {
  const xml = parseJira(new Map([['entities.xml', Buffer.from('<entity-engine-xml><Project id="1" pkey="OLD" name="synthetic"/><Issue id="2" project="1" number="1" summary="task"/><Worklog id="3" issue="2" author="alice" startdate="2026-11-19 10:30:00.000" timeworked="91" rolelevel="" grouplevel="staff" visibility="internal" hasRestrictions="true"><body>메모</body></Worklog></entity-engine-xml>')]]), 'synthetic-worklogs');
  const xmlWorklog = xml.records.find(item => item.id === 'history:worklog:3');
  assert.ok(xmlWorklog);
  assert.equal(xmlWorklog.metadata.timeworked, '91');
  assert.equal(xmlWorklog.metadata.visibility, 'internal');
  assert.equal(xmlWorklog.metadata.hasRestrictions, 'true');
  assert.equal(isRestrictedJiraWorklog(xmlWorklog), true);
  assert.equal(parsed(xmlWorklog).startedAt, '2026-11-19T01:30:00.000Z');
  const imported = parseJira(new Map([['importers.json', Buffer.from(JSON.stringify({ projects: [{ key: 'OLD', issues: [{ externalId: '1', summary: 'task', worklogs: [{ author: 'alice', startDate: '2012-08-31T17:59:02.161+0100', timeSpent: 'PT1M' }] }] }] }))]]), 'synthetic-worklogs');
  const importedWorklog = imported.records.find(item => isJiraWorklog(item));
  assert.ok(importedWorklog);
  assert.deepEqual(parsed(importedWorklog), { workDate: '2012-08-31', durationSeconds: 60, startedAt: '2012-08-31T16:59:02.161Z' });
});

test('parsing does not mutate retained raw history and never reads an unrelated created timestamp', () => {
  const original = row({ started: 'P-1D', timeSpentSeconds: 91 });
  original.createdAt = '2026-11-19T00:00:00Z';
  const before = structuredClone(original);
  assert.equal(code(original), 'WORKLOG_START_INVALID');
  assert.deepEqual(original, before);
  assert.equal(code({ ...original, kind: 'issue' }), 'WORKLOG_RECORD_INVALID');
});
