let actorId = '';
export function setActor(id: string) { actorId = id; }
export class ApiError extends Error { constructor(public status: number, message: string, public details?: unknown) { super(message); } }
export async function apiResponse(path: string, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(actorId ? {'X-Actor-Id': actorId} : {}), ...options.headers },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText })) as {error?: unknown; message?: unknown; details?: unknown};
    const message = typeof error.error === 'string' ? error.error : typeof error.message === 'string' ? error.message : '요청을 처리하지 못했습니다.';
    throw new ApiError(response.status, message, error.details);
  }
  return response;
}
export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiResponse(path, options);
  if (response.status === 204) return undefined as T;
  return response.json();
}
export const post = <T = unknown>(path: string, data: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const patch = <T = unknown>(path: string, data: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });
export const remove = (path: string) => api(path, { method: 'DELETE' });
export const dateLabel = (date: string | null) => date ? date.slice(5).replace('-', '.') : '미정';
export const relativeTime = (iso: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  return minutes < 1 ? '방금' : minutes < 60 ? `${minutes}분 전` : minutes < 1440 ? `${Math.floor(minutes / 60)}시간 전` : `${Math.floor(minutes / 1440)}일 전`;
};
