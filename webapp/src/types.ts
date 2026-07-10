export interface SessionInfo {
  sessionId: string;
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  inferenceWidth: number;
  inferenceHeight: number;
  sampleAspectRatio: {
    numerator: number;
    denominator: number;
  };
  rotationDegrees: number;
  calibration: CameraCalibration;
  fps: number;
  durationMs: number | null;
}

export type CalibrationOrigin = 'metadata' | 'estimated' | 'manual' | 'fallback';

export interface CameraCalibration {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  sourceWidth: number;
  sourceHeight: number;
  displayWidth: number;
  displayHeight: number;
  inferenceWidth: number;
  inferenceHeight: number;
  pixelAspectRatio: number;
  rotationDegrees: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  origin: CalibrationOrigin;
  confidence: number;
}

export interface DepthFrame {
  timestampMs: number;
  width: number;
  height: number;
  data: Float32Array;
  scale: number;
  bias: number;
  zMax: number;
}

export interface DepthStatus extends SessionInfo {
  bufferLength: number;
  lastDepthTimeMs: number | null;
  telemetry: Record<string, number>;
  rolling_stats: {
    depth_fps: number;
    latency_ms: number;
    client_fps?: number;
    infer_avg_s: number;
    infer_wait_avg_s?: number;
    queue_avg_s: number;
    ws_send_avg_s: number;
    decode_avg_s?: number;
    payload_avg_bytes: number;
    drop_count: number;
  };
  config: {
    inference_workers: number;
    decoder_workers: number;
    process_res: number;
    downsample_factor: number;
    encoding: DepthEncoding;
    mode: PerformanceMode;
    target_fps: number;
    limiting_stage: string;
  };
}

export type PerformanceMode = 'smooth' | 'balanced' | 'quality' | 'manual';
export type DepthEncoding = 'linear16' | 'log8';

export interface PerfSettings {
  mode: PerformanceMode;
  depthLeadMs: number;
  maxInflightRequests: number;
  autoLead: boolean;
}

export type ProjectionMode = 'relief' | 'pinhole';
export type ViewFramingMode = 'source' | 'orbit';

export interface ViewerControls {
  projectionMode: ProjectionMode;
  framingMode: ViewFramingMode;
  targetTriangles: number;
  fovY: number;
  sourceFovY: number;
  zScale: number;
  zBias: number;
  zGamma: number;
  zMaxClip: number;
  planeScale: number;
  yOffset: number;
}

export const DEPTH_HEADER_SIZE = 32;
export const DEPTH_MAGIC = 'VDZ1';
export const DEPTH_MAGIC_COMPRESSED = 'VDZ2';
export const DEPTH_MAGIC_LOG8 = 'VDZ3';
export const DEPTH_MAGIC_LOG8_COMPRESSED = 'VDZ4';
