'use client';

import { useRef, useState } from 'react';
import { House, LoaderCircle } from 'lucide-react';
import type { DocPage, DocumentSpaceHome, FeatureProps } from '../../shared/types';
import { api, ApiError, patch } from '../lib/api';

type Props = Pick<FeatureProps, 'refresh' | 'notify'> & {
  document: DocPage;
  home?: DocumentSpaceHome;
  restoreGeneration?: string;
  disabled: boolean;
};

export function DocumentSpaceHomeAction({ document, home, restoreGeneration, refresh, notify, disabled }: Props) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const currentHome = home?.documentId === document.id;
  const label = currentHome ? '공간 홈 해제' : '공간 홈으로 지정';

  async function save() {
    if (pending.current || !restoreGeneration) return;
    pending.current = true;
    setBusy(true);
    const path = '/document-space-home' + (document.projectId === null ? '' : `?projectId=${encodeURIComponent(document.projectId)}`);
    const documentId = currentHome ? null : document.id;
    const expectedVersion = home?.version ?? 0;
    try {
      const resolveRefresh = async () => {
        try { await refresh(); return true; }
        catch { return false; }
      };
      try {
        await patch<DocumentSpaceHome>(path, { documentId, expectedVersion, restoreGeneration });
      } catch (error) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          if (error.status === 409 || error.status === 422) await resolveRefresh();
          notify(error.message, 'error');
          return;
        }
        const saved = await api<DocumentSpaceHome>(path, { cache: 'no-store' }).catch(() => null);
        if (saved?.documentId !== documentId || saved.version !== expectedVersion + 1) {
          await resolveRefresh();
          notify('공간 홈 저장을 확인할 수 없습니다. 최신 설정을 확인해 주세요.', 'error');
          return;
        }
      }
      if (await resolveRefresh()) notify(currentHome ? '공간 홈을 해제했습니다.' : '문서를 공간 홈으로 지정했습니다.');
      else notify('공간 홈을 저장했습니다. 최신 설정을 불러오지 못했습니다.', 'error');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <button type="button" className="btn btn-ghost docs-icon-button"
    aria-label={label} title={label} disabled={disabled || busy || !restoreGeneration}
    aria-busy={busy} onClick={() => void save()}>
    {busy ? <LoaderCircle size={16} className="docs-spin" aria-hidden="true" /> : <House size={16} aria-hidden="true" />}
  </button>;
}
