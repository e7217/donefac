import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraEnglishDate, sourceTimestamp } from '../../server/migration-source-time.js';

test('migration timestamps use the supplied zone and leave clock changes unresolved without an offset', () => {
  assert.equal(sourceTimestamp('2024-03-10 02:30:00', 'America/New_York'), null);
  assert.equal(sourceTimestamp('2024-11-03 01:30:00', 'America/New_York'), null);
  assert.equal(sourceTimestamp('2024-11-03T01:30:00-04:00', 'America/New_York'), '2024-11-03T05:30:00.000Z');
  assert.equal(sourceTimestamp('2024-11-03 01:30:00', 'Asia/Seoul'), '2024-11-02T16:30:00.000Z');
  assert.equal(sourceTimestamp('2024-11-03 01:30:00', 'Invalid/Zone'), null);
});

test('Jira export dates preserve explicit century evidence and reject invalid calendar dates', () => {
  assert.deepEqual(jiraEnglishDate('3/Nov/2024 1:30 PM'), { local: '2024-11-03 13:30:00', century: false });
  assert.deepEqual(jiraEnglishDate('3/Nov/24 12:30 AM'), { local: '2024-11-03 00:30:00', century: true });
  assert.equal(sourceTimestamp('2024-02-30T08:00:00Z', 'UTC'), null);
  assert.equal(sourceTimestamp('29/Feb/2024 1:05 PM', 'Asia/Seoul'), '2024-02-29T04:05:00.000Z');
});
