import type { LegacyPackageSummary } from '../../shared/types';
import { ApiError } from '../lib/api';

export type LegacyImportProduct = 'auto' | LegacyPackageSummary['source']['product'];
export const MAX_LEGACY_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_LEGACY_INSTANCE_LENGTH = 200;
export const LEGACY_FILE_ACCEPT = '.zip,.xml,.csv,.json';

export function legacyFileProblem(file: File) {
  if (!file.size) return '내용이 있는 원본 파일을 선택해 주세요.';
  if (file.size > MAX_LEGACY_FILE_BYTES) return '원본 파일은 64 MiB 이하여야 합니다.';
  if (!/\.(?:zip|xml|csv|json)$/iu.test(file.name)) return 'ZIP·XML·CSV·JSON 파일을 선택해 주세요.';
  return '';
}

export function legacySizeLabel(bytes: number) {
  return bytes < 1024 ? `${bytes.toLocaleString()} B` : bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export async function uploadLegacyFile(file: File, instanceKey: string, product: LegacyImportProduct, actorId: string) {
  const source = instanceKey.trim();
  const params = new URLSearchParams({ filename: file.name, instanceKey: source, product });
  const response = await fetch(`/api/legacy-import/packages?${params}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': actorId }, body: file,
  });
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new ApiError(response.status, typeof value?.error === 'string' ? value.error : '원본 분석을 완료하지 못했습니다.');
  }
  const summary = await response.json() as LegacyPackageSummary;
  if (![200, 201].includes(response.status) || typeof summary?.id !== 'string' || !summary.id || summary.size !== file.size ||
    !/^[a-f\d]{64}$/u.test(summary.sha256) || summary.source?.instanceKey !== source ||
    !['jira', 'confluence'].includes(summary.source.product) || (product !== 'auto' && product !== summary.source.product) ||
    !Number.isSafeInteger(summary.errors) || !Number.isSafeInteger(summary.warnings)) {
    throw new Error('원본 분석 결과를 확인하지 못했습니다.');
  }
  return { summary, reused: response.status === 200 };
}
