import { useId } from 'react';
import type { LegacyPackageSummary, MigrationConfluenceReview, MigrationConfluenceReviewCoverage } from '../../shared/types';

export function ConfluenceSourceReview({ reviews, coverage, packages }: {
  reviews: MigrationConfluenceReview[];
  coverage?: MigrationConfluenceReviewCoverage[];
  packages: LegacyPackageSummary[];
}) {
  const heading = useId();
  const sources = new Map(packages.filter(item => item.source.product === 'confluence').map(item => [item.id, item]));
  const reviewedIds = new Set(reviews.map(review => review.packageId));
  if (![...reviewedIds].some(id => sources.has(id))) return null;

  return <section className="migration-refresh-review" aria-labelledby={heading}>
    <h4 id={heading}>Confluence 원본 검토 범위</h4>
    {coverage?.map(({ packageId, archivePages, permissionCheckedPages }) => {
      const source = sources.get(packageId);
      if (!source || !reviewedIds.has(packageId)) return null;
      const coverageHeading = `${heading}-coverage-${packageId}`;
      return <section className="migration-refresh-entry" aria-labelledby={coverageHeading} key={packageId}>
        <h5 id={coverageHeading}>ZIP 전체 페이지 제한 확인 <small>{source.filename}</small></h5>
        <CoverageCounts counts={[
          ['현재 페이지 수', archivePages],
          ['제한 여부를 확인한 페이지', permissionCheckedPages],
          ['제한 여부를 확인할 페이지', archivePages - permissionCheckedPages],
        ]} />
      </section>;
    })}
    {reviews.map((review, index) => {
      const source = sources.get(review.packageId);
      if (!source) return null;
      const { coverage } = review;
      const counts = coverage ? [
        ['ZIP에 포함된 현재 페이지', coverage.archivePages],
        ['페이지 제한 여부 확인', coverage.permissionCheckedPages],
        ['페이지 제한 여부 미확인', coverage.archivePages - coverage.permissionCheckedPages],
        ['원본에서 찾은 페이지', coverage.matchedPages],
        ['지정 범위 밖 페이지', coverage.outsideSelectionPages],
        ['다른 공간 페이지', coverage.otherSpacePages],
        ['공간을 확인할 수 없는 페이지', coverage.unassignedPages],
      ] as const : undefined;
      return <article className="migration-refresh-entry" key={`${review.packageId}:${index}`}>
        <h5>{source.filename} <small>SHA-256 {source.sha256.slice(0, 12)}</small></h5>
        <small>{review.selection === 'explicit-pages' ? '지정한 페이지' : '계정으로 볼 수 있는 공간 페이지'} · <time dateTime={review.checkedAt}>{new Date(review.checkedAt).toLocaleString('ko-KR')}</time></small>
        <p>{review.status === 'matched' ? '검토한 범위에서 대조 일치' : '대조 결과 추가 확인 필요'}</p>
        {counts ? <CoverageCounts counts={counts} />
          : <p>이전 검토 파일에는 페이지 확인 범위가 기록되지 않았습니다.</p>}
        <small>검토 진단이 있는 페이지 {review.findingsPages.toLocaleString('ko-KR')}개
          {review.unidentifiedPages > 0 && ` · 식별하지 못한 페이지 ${review.unidentifiedPages.toLocaleString('ko-KR')}개`}
        </small>
        {review.editRestrictedPages && <p>편집만 제한된 페이지 {review.editRestrictedPages.toLocaleString('ko-KR')}개 · 원본의 편집 권한은 이관 후 별도로 검토하세요.</p>}
      </article>;
    })}
    <p>공간 권한은 원본에서 별도로 확인하세요.</p>
  </section>;
}

function CoverageCounts({ counts }: { counts: readonly (readonly [string, number])[] }) {
  return <dl>{counts.map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count.toLocaleString('ko-KR')}개</dd></div>)}</dl>;
}
