const runtimeBase = (window as Window & { __VIDEO_DEPTH_API_BASE__?: string }).__VIDEO_DEPTH_API_BASE__;
const envBase = import.meta.env.VITE_API_BASE as string | undefined;

function guessBackend(): string {
  try {
    const origin = window.location.origin;
    // Vite開発環境では /api プロキシが有効なので、空文字で同一オリジンにして混在コンテンツを防ぐ
    if (origin.includes(':5173')) {
      return '';
    }
    return origin;
  } catch {
    return '';
  }
}

export const API_BASE = runtimeBase ?? envBase ?? guessBackend();

export function apiUrl(path: string): string {
  if (path.startsWith('http')) return path;
  return `${API_BASE}${path}`;
}

export function wsUrl(path: string): string {
  const base = API_BASE === '' ? window.location.origin : (API_BASE || window.location.origin);
  const url = new URL(path, base);
  url.protocol = url.protocol.replace('http', 'ws');
  return url.toString();
}
