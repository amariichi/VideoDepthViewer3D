import type { CameraCalibration, DepthStatus, SessionInfo } from '../types';
import { apiUrl } from '../utils/env';

export const VIDEO_TRANSFER_STATUS =
  'Transferring video to the processing backend...';

export function describeVideoTransferError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'Video transfer cancelled.';
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Could not create the processing session. Please try again.';
}

export interface UploadProgress {
  loaded: number;
  total: number | null;
  fraction: number | null;
}

export interface UploadVideoOptions {
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

export class SessionStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Failed to fetch session status (${status})`);
    this.name = 'SessionStatusError';
    this.status = status;
  }
}

export function isSessionGoneError(error: unknown): boolean {
  return error instanceof SessionStatusError && error.status === 404;
}

async function backendErrorDetail(res: Response): Promise<string> {
  try {
    const payload = (await res.json()) as { detail?: unknown };
    if (typeof payload.detail === 'string' && payload.detail.trim()) {
      return `: ${payload.detail.trim()}`;
    }
  } catch {
    // The HTTP status below remains actionable when the body is not JSON.
  }
  return '';
}

function fallbackCalibration(
  width: number,
  height: number,
  displayWidth: number,
  displayHeight: number
): CameraCalibration {
  const focal = 0.5 * displayHeight / Math.tan((50 * Math.PI) / 360);
  return {
    fx: focal,
    fy: focal,
    cx: (displayWidth - 1) / 2,
    cy: (displayHeight - 1) / 2,
    sourceWidth: width,
    sourceHeight: height,
    displayWidth,
    displayHeight,
    inferenceWidth: displayWidth,
    inferenceHeight: displayHeight,
    pixelAspectRatio: 1,
    rotationDegrees: 0,
    cropX: 0,
    cropY: 0,
    cropWidth: displayWidth,
    cropHeight: displayHeight,
    origin: 'fallback',
    confidence: 0,
  };
}

function parseCalibration(
  data: Record<string, unknown> | undefined,
  fallback: CameraCalibration
): CameraCalibration {
  if (!data) return fallback;
  const number = (key: string, defaultValue: number): number => {
    const value = data[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;
  };
  const origin = data.origin;
  return {
    fx: number('fx', fallback.fx),
    fy: number('fy', fallback.fy),
    cx: number('cx', fallback.cx),
    cy: number('cy', fallback.cy),
    sourceWidth: number('source_width', fallback.sourceWidth),
    sourceHeight: number('source_height', fallback.sourceHeight),
    displayWidth: number('display_width', fallback.displayWidth),
    displayHeight: number('display_height', fallback.displayHeight),
    inferenceWidth: number('inference_width', fallback.inferenceWidth),
    inferenceHeight: number('inference_height', fallback.inferenceHeight),
    pixelAspectRatio: number('pixel_aspect_ratio', fallback.pixelAspectRatio),
    rotationDegrees: number('rotation_degrees', fallback.rotationDegrees),
    cropX: number('crop_x', fallback.cropX),
    cropY: number('crop_y', fallback.cropY),
    cropWidth: number('crop_width', fallback.cropWidth),
    cropHeight: number('crop_height', fallback.cropHeight),
    origin:
      origin === 'metadata' || origin === 'estimated' || origin === 'manual'
        ? origin
        : 'fallback',
    confidence: number('confidence', fallback.confidence),
  };
}

export function parseSessionInfo(data: Record<string, unknown>): SessionInfo {
  const width = Number(data.width);
  const height = Number(data.height);
  const displayWidth = Number(data.display_width ?? width);
  const displayHeight = Number(data.display_height ?? height);
  const inferenceWidth = Number(data.inference_width ?? displayWidth);
  const inferenceHeight = Number(data.inference_height ?? displayHeight);
  const fallback = fallbackCalibration(width, height, displayWidth, displayHeight);
  const sar = (data.sample_aspect_ratio ?? { numerator: 1, denominator: 1 }) as {
    numerator?: unknown;
    denominator?: unknown;
  };
  return {
    sessionId: String(data.session_id ?? ''),
    sourceName: String(data.source_name ?? 'video'),
    mediaType: String(data.media_type ?? 'application/octet-stream'),
    width,
    height,
    displayWidth,
    displayHeight,
    inferenceWidth,
    inferenceHeight,
    sampleAspectRatio: {
      numerator: Number(sar.numerator ?? 1),
      denominator: Number(sar.denominator ?? 1),
    },
    rotationDegrees: Number(data.rotation_degrees ?? 0),
    calibration: parseCalibration(
      data.calibration as Record<string, unknown> | undefined,
      fallback
    ),
    fps: Number(data.fps ?? 0),
    durationMs: data.duration_ms == null ? null : Number(data.duration_ms),
  };
}

function parseJsonText(text: string): Record<string, unknown> {
  try {
    const data = JSON.parse(text) as unknown;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function uploadVideoWithProgress(
  file: File,
  options: UploadVideoOptions
): Promise<SessionInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const body = new FormData();
    body.append('file', file);
    const abort = () => xhr.abort();
    const cleanup = () => options.signal?.removeEventListener('abort', abort);

    xhr.open('POST', apiUrl('/api/sessions'));
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : null;
      options.onProgress?.({
        loaded: event.loaded,
        total,
        fraction: total === null ? null : Math.min(1, event.loaded / total),
      });
    };
    xhr.onerror = () => {
      cleanup();
      reject(
        new Error(
          'Cannot reach the processing backend. Make sure ./start.sh is still running.'
        )
      );
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('Video transfer cancelled.', 'AbortError'));
    };
    xhr.onload = () => {
      cleanup();
      const data =
        xhr.response && typeof xhr.response === 'object'
          ? (xhr.response as Record<string, unknown>)
          : typeof xhr.response === 'string'
            ? parseJsonText(xhr.response)
            : {};
      if (xhr.status < 200 || xhr.status >= 300) {
        const detail =
          typeof data.detail === 'string' && data.detail.trim()
            ? `: ${data.detail.trim()}`
            : '';
        const status = xhr.statusText
          ? `${xhr.status} ${xhr.statusText}`
          : String(xhr.status);
        reject(new Error(`Processing backend rejected the video (${status})${detail}`));
        return;
      }
      options.onProgress?.({ loaded: file.size, total: file.size, fraction: 1 });
      resolve(parseSessionInfo(data));
    };

    if (options.signal?.aborted) {
      reject(new DOMException('Video transfer cancelled.', 'AbortError'));
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    xhr.send(body);
  });
}

export async function uploadVideo(
  file: File,
  options: UploadVideoOptions = {}
): Promise<SessionInfo> {
  if (options.onProgress || options.signal) {
    return uploadVideoWithProgress(file, options);
  }
  const body = new FormData();
  body.append('file', file);
  let res: Response;
  try {
    res = await fetch(apiUrl('/api/sessions'), {
      method: 'POST',
      body,
    });
  } catch (cause) {
    throw new Error(
      'Cannot reach the processing backend. Make sure ./start.sh is still running.',
      { cause }
    );
  }
  if (!res.ok) {
    const detail = await backendErrorDetail(res);
    const status = res.statusText
      ? `${res.status} ${res.statusText}`
      : String(res.status);
    throw new Error(`Processing backend rejected the video (${status})${detail}`);
  }
  return parseSessionInfo((await res.json()) as Record<string, unknown>);
}

export async function getCurrentSession(): Promise<SessionInfo | null> {
  const res = await fetch(apiUrl('/api/sessions/current'), { cache: 'no-store' });
  if (res.status === 204) return null;
  if (!res.ok) {
    throw new Error('Failed to discover the active video session');
  }
  return parseSessionInfo((await res.json()) as Record<string, unknown>);
}

export function getSessionVideoUrl(sessionId: string): string {
  return apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/video`);
}

export function getBrowserVideoUrl(sessionId: string): string {
  return apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/browser-video`);
}

export async function prepareBrowserVideo(sessionId: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(getBrowserVideoUrl(sessionId), { method: 'POST' });
  } catch (cause) {
    throw new Error(
      'Cannot reach the processing backend while preparing browser playback.',
      { cause }
    );
  }
  if (!res.ok) {
    const detail = await backendErrorDetail(res);
    throw new Error(`Could not prepare browser-compatible video${detail}`);
  }
}

export async function getSessionStatus(
  sessionId: string,
  signal?: AbortSignal
): Promise<DepthStatus> {
  const res = await fetch(
    apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/status`),
    { cache: 'no-store', signal }
  );
  if (!res.ok) {
    throw new SessionStatusError(res.status);
  }
  const data = await res.json();
  const width = Number(data.width);
  const height = Number(data.height);
  const displayWidth = Number(data.display_width ?? width);
  const displayHeight = Number(data.display_height ?? height);
  const inferenceWidth = Number(data.inference_width ?? displayWidth);
  const inferenceHeight = Number(data.inference_height ?? displayHeight);
  const fallback = fallbackCalibration(width, height, displayWidth, displayHeight);
  const sar = data.sample_aspect_ratio ?? { numerator: 1, denominator: 1 };
  return {
    sourceName: String(data.source_name ?? 'video'),
    mediaType: String(data.media_type ?? 'application/octet-stream'),
    sessionId: data.session_id,
    width,
    height,
    displayWidth,
    displayHeight,
    inferenceWidth,
    inferenceHeight,
    sampleAspectRatio: {
      numerator: Number(sar.numerator ?? 1),
      denominator: Number(sar.denominator ?? 1),
    },
    rotationDegrees: Number(data.rotation_degrees ?? 0),
    calibration: parseCalibration(data.calibration, fallback),
    fps: data.fps,
    durationMs: data.duration_ms ?? null,
    bufferLength: data.buffer_length ?? 0,
    lastDepthTimeMs: data.last_depth_time_ms ?? null,
    telemetry: data.telemetry ?? {},
    rolling_stats: data.rolling_stats ?? {
      depth_fps: 0,
      latency_ms: 0,
      client_fps: 0,
      infer_avg_s: 0,
      infer_wait_avg_s: 0,
      normalize_avg_s: 0,
      pack_avg_s: 0,
      queue_avg_s: 0,
      ws_send_avg_s: 0,
      decode_avg_s: 0,
      payload_avg_bytes: 0,
      drop_count: 0,
    },
    config: data.config ?? {
      inference_workers: 3,
      decoder_workers: 4,
      process_res: 640,
      downsample_factor: 1,
      encoding: 'linear16',
      mode: 'manual',
      target_fps: 0,
      limiting_stage: 'unknown',
    },
  };
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(apiUrl(`/api/sessions/${sessionId}`), { method: 'DELETE' });
}
