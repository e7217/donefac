import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.js';
import { OutboundWebhookService } from '../../server/outbound-webhooks.js';
import { PILOT_REHEARSAL_DIRECTORY } from '../../server/pilot-rehearsal.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const reviewOnly = /pilot:rehearsal review 명령/;
const teamAccess = /이관 리허설에는 팀 접속 설정을 사용할 수 없습니다/;

function temporary(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-rehearsal-entrypoint-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function assertStoreUnopened(directory: string) {
  for (const name of ['teamspace.sqlite', '.credential-key']) assert.equal(existsSync(join(directory, name)), false);
}

test('marked data refuses ordinary API startup before opening SQLite, even for malformed markers', t => {
  const scratch = temporary(t);
  const markers = [mkdirSync, (path: string) => writeFileSync(path, '{}'), (path: string) => symlinkSync('missing', path)];
  for (const [index, makeMarker] of markers.entries()) {
    const dataDir = join(scratch, String(index));
    mkdirSync(dataDir);
    makeMarker(join(dataDir, PILOT_REHEARSAL_DIRECTORY));
    assert.throws(() => createApp({ dataDir }), reviewOnly);
    assertStoreUnopened(dataDir);
  }

  const dataDir = join(scratch, 'unmarked');
  const ordinary = createApp({ dataDir, seed: false, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
  try { assert.ok(existsSync(join(dataDir, 'teamspace.sqlite'))); }
  finally { ordinary.close(); }
});

test('pilot startup refuses marked data and refuses team access in rehearsal mode before reading credentials', t => {
  const dataDir = temporary(t);
  mkdirSync(join(dataDir, PILOT_REHEARSAL_DIRECTORY));
  for (const [rehearsal, error] of [[false, reviewOnly], [true, teamAccess]] as const) {
    const result = spawnSync('bash', ['scripts/pilot-lock.sh', dataDir, process.execPath, '--import', 'tsx', 'server/pilot.ts'], {
      cwd: repo, encoding: 'utf8', timeout: 12_000,
      env: {
        NODE_ENV: 'test', PATH: process.env.PATH, LANG: process.env.LANG, TEAMSPACE_PILOT_PORT: '0',
        TEAMSPACE_PILOT_ORIGIN: 'https://example.invalid', TEAMSPACE_PILOT_ACCESS_FILE: join(dataDir, 'absent-key'),
        ...(rehearsal ? { TEAMSPACE_PILOT_MIGRATION_REHEARSAL: '1' } : {}),
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, error);
    assert.doesNotMatch(result.stdout, /listening/);
    assertStoreUnopened(dataDir);
  }
  assert.throws(() => createApp({ dataDir, migrationRehearsal: true, browserOrigin: 'https://example.invalid' }), teamAccess);
  assertStoreUnopened(dataDir);
});

test('isolated app startup forces demo data and scheduled work off for a rehearsal', async t => {
  const dataDir = temporary(t);
  mkdirSync(join(dataDir, PILOT_REHEARSAL_DIRECTORY));
  const work = t.mock.method(OutboundWebhookService.prototype, 'tick', async () => 0);
  const deadline = t.mock.fn(() => new Date());
  const recurring = t.mock.fn(() => new Date());
  const service = createApp({ dataDir, migrationRehearsal: true, seed: true, outboundWorker: true,
    deadlineReminderWorker: true, deadlineReminderClock: deadline, deadlineReminderIntervalMs: 10,
    recurringIssueWorker: true, recurringIssueClock: recurring, recurringIssueIntervalMs: 10 });
  try {
    await setTimeout(45);
    assert.equal(work.mock.callCount(), 0);
    assert.equal(deadline.mock.callCount(), 0);
    assert.equal(recurring.mock.callCount(), 0);
  } finally { service.close(); }
  const store = new DatabaseSync(join(dataDir, 'teamspace.sqlite'), { readOnly: true });
  try { assert.equal(store.prepare('SELECT count(*) AS count FROM projects').get()?.count, 0); }
  finally { store.close(); }
});
