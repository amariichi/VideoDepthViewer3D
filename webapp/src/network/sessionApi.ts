import type { DepthStatus, SessionInfo } from '../types';
import { apiUrl } from '../utils/env';

export async function uploadVideo(file: File): Promise<SessionInfo> {
  const body = new FormData();
  body.append('file', file);
  const res = await fetch(apiUrl('/api/sessions'), {
    method: 'POST',
    body,
  });
  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.statusText}`);
  }
  const data = await res.json();
  return {
    sessionId: data.session_id,
    width: data.width,
    height: data.height,
    fps: data.fps,
    durationMs: data.duration_ms ?? null,
  };
}

export async function getSessionStatus(sessionId: string): Promise<DepthStatus> {
  const res = await fetch(apiUrl(`/api/sessions/${sessionId}/status`));
  if (!res.ok) {
    throw new Error('Failed to fetch session status');
  }
  const data = await res.json();
  return {
    sessionId: data.session_id,
    width: data.width,
    height: data.height,
    fps: data.fps,
    durationMs: data.duration_ms ?? null,
    bufferLength: data.buffer_length ?? 0,
    lastDepthTimeMs: data.last_depth_time_ms ?? null,
    telemetry: data.telemetry ?? {},
    rolling_stats: data.rolling_stats ?? {
      depth_fps: 0,
      latency_ms: 0,
      infer_avg_s: 0,
      queue_avg_s: 0,
      ws_send_avg_s: 0,
      drop_count: 0,
    },
    config: data.config ?? {
      inference_workers: 3,
      process_res: 640,
      downsample_factor: 1,
    },
  };
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(apiUrl(`/api/sessions/${sessionId}`), { method: 'DELETE' });
}
