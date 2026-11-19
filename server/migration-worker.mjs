import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

try {
  const { runMigrationWork } = await tsImport('./migration-work.ts', import.meta.url);
  parentPort.postMessage({ ok: true, value: await runMigrationWork(workerData) });
} catch (error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  parentPort.postMessage({ ok: false, status, message: status === 500 ? '이관 데이터를 준비하지 못했습니다.' : String(error.message).slice(0, 2000) });
} finally {
  parentPort.close();
}
