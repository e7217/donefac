import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webPort = parsePort('TEAMSPACE_TEST_WEB_PORT', 5179);
const apiPort = parsePort('TEAMSPACE_TEST_API_PORT', 5189);
if (webPort === apiPort) throw new Error('브라우저 검사 웹/API 포트는 서로 달라야 합니다.');
const children = [];
const abort = new AbortController();
const groups = process.platform !== 'win32';
let taskDataDir;
let checkoutRoot = projectRoot;
let stopping = false;
let shutdownPromise;

function parsePort(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name}은 1~65535 범위의 포트여야 합니다.`);
  return value;
}
function available(port) {
  return new Promise((resolveReady, reject) => {
    const probe = createServer();
    probe.once('error', error => reject(new Error(`검사 전용 포트 ${port}를 사용할 수 없습니다: ${error.message}`)));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolveReady()));
  });
}
function mirrorSource(destination) {
  const excluded = new Set(['node_modules', 'data', '.git', '.sites-runtime', '.vinext', '.wrangler', '.next', 'dist', 'test-results', 'playwright-report', 'coverage', 'outputs', 'work', '.agents', '.codex', 'secrets', '.secrets', 'tsconfig.tsbuildinfo']);
  cpSync(projectRoot, destination, { recursive: true, dereference: false, verbatimSymlinks: true, filter: source => {
    const first = relative(projectRoot, source).split(sep)[0];
    const filename = basename(source);
    return !excluded.has(first) && !filename.startsWith('.env') && !['.credential-key', 'id_rsa', 'id_ed25519'].includes(filename) && !['.pem', '.pfx', '.p12', '.key'].includes(extname(filename).toLowerCase());
  } });
  // Use local node_modules/.vite and .vite-temp directories. Symlinking the
  // entire dependency directory would share the development optimizer cache.
  // Cloudflare's CJS handling also expects optimized files under node_modules.
  const dependencies = join(projectRoot, 'node_modules');
  const localDependencies = join(destination, 'node_modules');
  mkdirSync(localDependencies, { recursive: true });
  for (const entry of readdirSync(dependencies, { withFileTypes: true })) {
    if (entry.name.startsWith('.vite') || entry.name === '.cache') continue;
    symlinkSync(join(dependencies, entry.name), join(localDependencies, entry.name), process.platform === 'win32' && entry.isDirectory() ? 'junction' : entry.isDirectory() ? 'dir' : 'file');
  }
  const originalProfile = join(projectRoot, '.sites-runtime', 'execution-profile.json');
  if (existsSync(originalProfile)) { mkdirSync(join(destination, '.sites-runtime'), { recursive: true }); writeFileSync(join(destination, '.sites-runtime', 'execution-profile.json'), readFileSync(originalProfile)); }
}
function signalChild(child, signal) {
  if (!child.pid) return;
  try { process.kill(groups ? -child.pid : child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') console.error(`[browser-server] ${signal}: ${error.message}`); }
}
function shutdown(code, reason) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  abort.abort();
  shutdownPromise = (async () => {
    if (reason) console.error(`[browser-server] ${reason}`);
    for (const { child } of children) signalChild(child, 'SIGTERM');
    const exited = Promise.allSettled(children.map(entry => entry.closed));
    let timeout;
    await Promise.race([exited, new Promise(resolveReady => { timeout = setTimeout(resolveReady, 5000); })]);
    clearTimeout(timeout);
    // A framework can exit before its workerd descendants. Stop the owned groups
    // as well; no unrelated development process belongs to these process groups.
    for (const { child } of children) signalChild(child, 'SIGKILL');
    let finalTimeout;
    await Promise.race([exited, new Promise(resolveReady => { finalTimeout = setTimeout(resolveReady, 2000); })]);
    clearTimeout(finalTimeout);
    if (taskDataDir) {
      try { rmSync(taskDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); console.log(`[browser-server] cleaned ${taskDataDir}`); }
      catch (error) { console.error(`[browser-server] 임시 데이터 정리 실패: ${error.message}`); code = 1; }
    }
    process.exit(code);
  })();
  return shutdownPromise;
}
function launch(name, args, env) {
  const child = spawn(process.execPath, args, { cwd: checkoutRoot, env, detached: groups, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolveClosed => child.once('close', resolveClosed));
  children.push({ child, closed });
  child.stdout.on('data', value => process.stdout.write(`[browser-${name}] ${value}`));
  child.stderr.on('data', value => process.stderr.write(`[browser-${name}] ${value}`));
  child.once('error', error => { void shutdown(1, `${name} 시작 실패: ${error.message}`); });
  child.once('exit', (code, signal) => { if (!stopping) void shutdown(1, `${name} 서버가 예기치 않게 종료되었습니다 (code=${code}, signal=${signal || 'none'}).`); });
  return child;
}
async function healthy(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '응답 없음';
  while (!stopping && Date.now() < deadline) {
    try { const response = await fetch(url, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]) }); if (response.ok) return; lastError = `HTTP ${response.status}`; await response.body?.cancel(); }
    catch (error) { lastError = error.message; }
    if (!stopping) await new Promise(resolveReady => setTimeout(resolveReady, 200));
  }
  if (!stopping) throw new Error(`${url} 준비 시간 초과: ${lastError}`);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
process.on('uncaughtException', error => { void shutdown(1, error.stack || error.message); });
process.on('unhandledRejection', error => { void shutdown(1, error instanceof Error ? error.stack || error.message : String(error)); });

try {
  await available(apiPort); await available(webPort);
  if (!stopping) {
    taskDataDir = mkdtempSync(join(tmpdir(), 'teamspace-browser-'));
    checkoutRoot = join(taskDataDir, 'checkout');
    mirrorSource(checkoutRoot);
    const runtimeDir = join(checkoutRoot, '.sites-runtime');
    const env = { ...process.env, PORT: String(apiPort), API_PORT: String(apiPort), WEB_PORT: String(webPort), TEAMSPACE_DATA_DIR: join(taskDataDir, 'workspace'), BROWSER: 'none', CI: '1', SITES_RUNTIME_ROOT: runtimeDir, WRANGLER_REGISTRY_PATH: join(runtimeDir, 'wrangler/dev-registry'), MINIFLARE_REGISTRY_PATH: join(runtimeDir, 'wrangler/registry'), WRANGLER_LOG_PATH: join(runtimeDir, 'wrangler/logs'), WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' };
    console.log(`[browser-server] isolated workspace ${taskDataDir}; web=${webPort}, api=${apiPort}`);
    launch('api', ['--import', 'tsx', 'server/index.ts'], env);
    await healthy(`http://127.0.0.1:${apiPort}/api/health`, 20_000);
    if (!stopping) {
      launch('web', ['scripts/run-framework.mjs', 'dev', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], env);
      await healthy(`http://127.0.0.1:${webPort}/api/health`, 100_000);
      if (!stopping) console.log(`[browser-server] ready http://127.0.0.1:${webPort}`);
    }
  }
} catch (error) { if (!stopping) await shutdown(1, error.stack || error.message); }
