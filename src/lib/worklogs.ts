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

export function newWorklogRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
