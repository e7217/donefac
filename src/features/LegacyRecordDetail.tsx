'use client';

import { X } from 'lucide-react';
import type { LegacyRecord, LegacyRecordKind } from '../../shared/types';
import './legacy-import.css';

export const legacyRecordKindLabels: Record<LegacyRecordKind, string> = { identity: '사용자', project: '프로젝트·공간', issue: '업무', page: '문서', comment: '댓글', revision: '문서 버전', history: '변경 이력', attachment: '첨부파일', relation: '관계', field: '필드', option: '선택지', workflow: '워크플로' };

export function LegacyRecordDetail({ record, onClose }: { record: LegacyRecord; onClose?: () => void }) {
  const limit = 20000, metadata = JSON.stringify(record.metadata, null, 2), references = JSON.stringify(record.references, null, 2);
  const bodyPreview = record.text.slice(0, limit), metadataPreview = metadata.slice(0, Math.max(0, limit - bodyPreview.length));
  const referencePreview = references.slice(0, Math.max(0, limit - bodyPreview.length - metadataPreview.length));
  const truncated = record.text.length + metadata.length + references.length > limit;
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `legacy-${record.kind}-${record.sourceId.replace(/[^a-zA-Z0-9가-힣_-]/g, '_').slice(0, 80)}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="legacy-record-detail" aria-label="원본 객체 상세"><header><h4>{record.title || '(제목 없음)'}</h4>{onClose && <button className="btn btn-ghost" type="button" aria-label="원본 객체 상세 닫기" onClick={onClose}><X size={16} />닫기</button>}</header>
    <dl><dt>원본 ID / 종류</dt><dd>{record.sourceId} · {legacyRecordKindLabels[record.kind]}</dd><dt>컨테이너 / 상위 ID</dt><dd>{record.containerId || '없음'} / {record.parentId || '없음'}</dd><dt>작성자 ID</dt><dd>{record.authorId || '원본에 없음'}</dd><dt>생성 시각</dt><dd>{record.createdAt || '원본에 없음'}</dd><dt>수정 시각</dt><dd>{record.updatedAt || '원본에 없음'}</dd><dt>본문 형식</dt><dd>{record.textFormat}</dd></dl>
    <div className="legacy-raw-actions"><p>{truncated ? '부분 표시: 본문·메타데이터·관계는 화면에 합계 20,000자까지만 표시합니다. 전체 JSON에는 원문 전체가 보존됩니다.' : '원본 문자열을 읽기 전용으로 표시합니다. 마크업은 실행하지 않습니다.'}</p><button className="btn" type="button" onClick={download}>원본 객체 전체 JSON 다운로드</button></div>
    <h5>원본 본문</h5><pre className="legacy-raw-body" aria-label="원본 본문">{bodyPreview || '(본문 없음)'}</pre>
    <details><summary>원본 메타데이터</summary>{metadataPreview ? <pre>{metadataPreview}</pre> : <p>화면 표시 한도에 도달했습니다. 전체 JSON에서 확인해 주세요.</p>}</details>
    <details><summary>원본 관계 {record.references.length}개</summary>{referencePreview ? <pre>{referencePreview}</pre> : <p>화면 표시 한도에 도달했습니다. 전체 JSON에서 확인해 주세요.</p>}</details>
  </section>;
}
