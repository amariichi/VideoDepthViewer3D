import type { CameraCalibration, DepthStatus, SessionInfo } from '../types';
import { apiUrl } from '../utils/env';

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
  const width = Number(data.width);
  const height = Number(data.height);
  const displayWidth = Number(data.display_width ?? width);
  const displayHeight = Number(data.display_height ?? height);
  const inferenceWidth = Number(data.inference_width ?? displayWidth);
  const inferenceHeight = Number(data.inference_height ?? displayHeight);
  const fallback = fallbackCalibration(width, height, displayWidth, displayHeight);
  const sar = data.sample_aspect_ratio ?? { numerator: 1, denominator: 1 };
  return {
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
  };
}

export async function getSessionStatus(sessionId: string): Promise<DepthStatus> {
  const res = await fetch(apiUrl(`/api/sessions/${sessionId}/status`));
  if (!res.ok) {
    throw new Error('Failed to fetch session status');
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
      infer_avg_s: 0,
      queue_avg_s: 0,
      ws_send_avg_s: 0,
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
