export function formatWorklogMinutes(minutes: number): string {
  const seconds = Math.round(minutes * 60);
  const hours = Math.floor(seconds / 3600);
  const remainingMinutes = Math.floor(seconds / 60) % 60;
  const remainingSeconds = seconds % 60;
  const parts = [
    hours ? `${hours.toLocaleString('ko-KR')}시간` : '',
    remainingMinutes ? `${remainingMinutes}분` : '',
    remainingSeconds ? `${remainingSeconds}초` : '',
  ];
  return parts.filter(Boolean).join(' ') || '0분';
}
