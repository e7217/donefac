import express from 'express';
import { fstatSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createPilotAccess } from './pilot-access.js';
import { readPilotConfluenceReview } from './pilot-confluence-review.js';
import { assertPilotRehearsalWorkspace } from './pilot-rehearsal.js';

const { DONEFAC_DATA_DIR: dataDir, DONEFAC_PILOT_LOCKED_DIR: lockedDir, DONEFAC_PILOT_LOCK_FD: lockDescriptor } = process.env;
if (!dataDir || dataDir !== lockedDir || !lockDescriptor || !/^\d+$/.test(lockDescriptor)) {
  throw new Error('Use npm run start:pilot with an absolute DONEFAC_DATA_DIR.');
}
const lock = fstatSync(Number(lockDescriptor));
const lockPath = statSync(`${dataDir}.donefac.lock`);
if (!lock.isFile() || lock.dev !== lockPath.dev || lock.ino !== lockPath.ino) throw new Error('The Donefac data lock is missing.');

const migrationRehearsal = process.env.DONEFAC_PILOT_MIGRATION_REHEARSAL === '1';
assertPilotRehearsalWorkspace(dataDir, migrationRehearsal);
if (migrationRehearsal &&
    (process.env.DONEFAC_PILOT_ORIGIN !== undefined || process.env.DONEFAC_PILOT_ACCESS_FILE !== undefined)) {
  throw new Error('이관 리허설에는 팀 접속 설정을 사용할 수 없습니다.');
}

const portValue = process.env.DONEFAC_PILOT_PORT ?? '5190';
const port = Number(portValue);
if (!/^\d{1,5}$/.test(portValue) || port > 65535) throw new Error('DONEFAC_PILOT_PORT must be an integer from 0 to 65535.');
const webDirectory = fileURLToPath(new URL('../dist/pilot-web/', import.meta.url));
const index = join(webDirectory, 'index.html');
const assetDirectory = join(webDirectory, 'assets');
try {
  if (!statSync(index).isFile() || !statSync(assetDirectory).isDirectory()) throw new Error();
} catch {
  throw new Error('Build the pilot browser bundle with npm run build:pilot before starting Donefac.');
}

const access = createPilotAccess();
const confluenceReview = await readPilotConfluenceReview(process.env, Boolean(access), process.stdin);
const teamIndex = access ? readFileSync(index, 'utf8').replace('</head>', '<meta name="donefac-pilot-access" content="enabled"></head>') : null;
const api = createApp({
  dataDir,
  migrationRehearsal,
  browserOrigin: access?.origin,
  gitlabWebhookPublicOrigin: access?.origin,
  ...confluenceReview,
  seed: process.env.DONEFAC_PILOT_DEMO === '1',
  outboundWorker: process.env.DONEFAC_PILOT_OUTBOUND !== '0',
  deadlineReminderWorker: process.env.DONEFAC_PILOT_DEADLINE_REMINDERS !== '0',
  recurringIssueWorker: process.env.DONEFAC_PILOT_RECURRING_ISSUES !== '0',
});
const web = express();
web.disable('x-powered-by');
if (access) web.use(access.middleware);
web.get('/', (_request, response) => {
  if (teamIndex !== null) response.type('html').send(teamIndex);
  else response.sendFile(index, { headers: { 'Cache-Control': 'no-cache' } });
});
web.get('/donefac.svg', (_request, response) => response.sendFile(join(webDirectory, 'donefac.svg')));
web.use('/assets', express.static(assetDirectory, { index: false, redirect: false, immutable: true, maxAge: '1y' }));
web.use('/assets', (_request, response) => response.sendStatus(404));
web.use(api.app);
web.use((_request, response) => response.sendStatus(404));

const server = createServer(web);
const upgraded = new Set<Duplex>();
server.on('upgrade', (_request, socket) => {
  upgraded.add(socket);
  socket.once('close', () => upgraded.delete(socket));
});
api.attachWebSocket(server, access?.authorizeUpgrade);

let stopping = false;
function finish(exitCode: number) {
  try { access?.close(); api.close(); }
  catch (error) { console.error(error); exitCode = 1; }
  process.exit(exitCode);
}
function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => server.closeAllConnections(), 10_000).unref();
  server.close(error => {
    clearTimeout(deadline);
    if (error) console.error(error);
    finish(error ? 1 : 0);
  });
  for (const socket of upgraded) socket.destroy();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
server.once('error', error => { console.error(error); finish(1); });
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') console.log(`Donefac pilot listening on http://127.0.0.1:${address.port}`);
});
