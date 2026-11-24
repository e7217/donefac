import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const commandEnv = { PATH: process.env.PATH, LANG: process.env.LANG };

async function deadline(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function launch(command, args, env, detached = false, input) {
  const child = spawn(command, args, { cwd: repo, env, detached, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => {
    let error;
    child.once('error', cause => { error = cause; });
    child.once('close', (code, signal) => resolve({ code, signal, error }));
  });
  if (input) {
    // A startup failure may close the pipe before the full configuration is read.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  }
  return { child, exited };
}

const exitLabel = ({ code, signal, error }) => error?.code ?? signal ?? code ?? 'unknown';

function apiRequest(url, pilotSignal) {
  return (path, { method = 'GET', headers: fields, body, signal, timeoutMs = 60_000 } = {}) => {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('파일럿 API 경로는 /로 시작해야 합니다.');
    const target = new URL(`/api${path}`, url);
    if (target.origin !== url.origin || !target.pathname.startsWith('/api/')) {
      throw new Error('파일럿의 API 경로를 지정해 주세요.');
    }
    const headers = new Headers(fields);
    const streaming = body instanceof Readable || body instanceof ReadableStream;
    if (body !== undefined && typeof body !== 'string' && !streaming && !ArrayBuffer.isView(body) && !(body instanceof ArrayBuffer)) {
      body = JSON.stringify(body);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }
    return fetch(target, {
      method, headers, body, redirect: 'error', ...(streaming ? { duplex: 'half' } : {}),
      signal: AbortSignal.any([pilotSignal, signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
    });
  };
}

export async function startRehearsalPilot(dataDir, { signal, port = 0, restrictions = [], reviews = [], coverage = [] } = {}) {
  signal?.throwIfAborted();
  if (!isAbsolute(dataDir) || (lstatSync(dataDir, { throwIfNoEntry: false })?.isSymbolicLink() ?? false)) {
    throw new Error('리허설 데이터 경로는 심볼릭 링크가 아닌 절대 경로여야 합니다.');
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('리허설 포트는 0~65535여야 합니다.');
  // Start the normal pilot with its lock, and keep service credentials out of its environment.
  const input = reviews.length ? JSON.stringify({ restrictions, reviews, ...(coverage.length ? { coverage } : {}) })
    : restrictions.length ? JSON.stringify(restrictions) : undefined;
  const reviewEnv = reviews.length ? { TEAMSPACE_PILOT_CONFLUENCE_REVIEW: 'stdin' }
    : restrictions.length ? { TEAMSPACE_PILOT_CONFLUENCE_RESTRICTIONS: 'stdin' } : {};
  const { child, exited } = launch('bash', ['scripts/pilot-lock.sh', dataDir, process.execPath, '--import', 'tsx', 'server/pilot.ts'], {
    ...commandEnv, TEAMSPACE_PILOT_PORT: String(port), TEAMSPACE_PILOT_MIGRATION_REHEARSAL: '1',
    ...reviewEnv,
  }, false, input);
  let startupError = '', stdout = '', stopping;
  const ready = new Promise(resolve => {
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk).slice(-2048);
      const address = /Teamspace pilot listening on (http:\/\/127\.0\.0\.1:\d+)\s/.exec(stdout)?.[1];
      if (address) resolve(new URL(address));
    });
  });
  child.stderr.on('data', chunk => { startupError = (startupError + chunk).slice(-2048); });

  const close = () => stopping ??= (async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) child.kill('SIGTERM');
    let result;
    try {
      result = await deadline(exited, 15_000, '리허설 파일럿의 정상 종료 시간을 초과했습니다.');
    } catch (error) {
      child.kill('SIGKILL');
      await deadline(exited, 5_000, '리허설 파일럿의 종료를 확인할 수 없습니다.');
      throw error;
    }
    if (result.code !== 0) throw new Error(`리허설 파일럿 종료 실패 (${exitLabel(result)})`);
  })();
  const stopOnAbort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', stopOnAbort, { once: true });
  void exited.then(() => signal?.removeEventListener('abort', stopOnAbort));
  try {
    const url = await deadline(Promise.race([ready, exited.then(result => {
      throw new Error(`리허설 파일럿 시작 실패 (${exitLabel(result)})${startupError ? `\n${startupError.trim()}` : ''}`);
    })]), 25_000, '리허설 파일럿의 시작 시간을 초과했습니다.');
    signal?.throwIfAborted();
    return { url: url.origin, request: apiRequest(url, signal), close, exited };
  } catch (error) {
    await close().catch(() => {});
    signal?.throwIfAborted();
    throw error;
  }
}

async function coldCopy(action, source, target, signal) {
  signal?.throwIfAborted();
  const { child, exited } = launch(process.execPath, ['scripts/pilot-backup.mjs', action, source, target], commandEnv, true);
  let diagnostics = '', cancellation, escalation;
  child.stdout.resume();
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2048); });

  // The backup CLI runs a lock wrapper and a guarded worker. Stop the group together.
  function killGroup(kind) {
    if (!child.pid) return;
    try { process.kill(-child.pid, kind); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  function cancel(error) {
    if (cancellation) return;
    cancellation = error;
    killGroup('SIGTERM');
    escalation = setTimeout(() => killGroup('SIGKILL'), 5_000);
  }
  const stopOnAbort = () => cancel(signal.reason);
  signal?.addEventListener('abort', stopOnAbort, { once: true });
  const timeout = setTimeout(() => cancel(new Error(`리허설 물리 복사 시간 초과 (${action})`)), 15 * 60_000);
  try {
    const result = await exited;
    if (cancellation) throw cancellation;
    if (result.code !== 0) {
      throw new Error(`리허설 물리 복사 실패 (${action}, ${exitLabel(result)})${diagnostics ? `\n${diagnostics.trim()}` : ''}`);
    }
  } finally {
    signal?.removeEventListener('abort', stopOnAbort);
    clearTimeout(timeout);
    clearTimeout(escalation);
  }
}

export async function backupAndRestoreRehearsal(source, backupDir, restoredDataDir, { signal } = {}) {
  await coldCopy('backup', source, backupDir, signal);
  await coldCopy('restore', backupDir, restoredDataDir, signal);
}
