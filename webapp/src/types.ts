export interface SessionInfo {
  sessionId: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number | null;
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
    infer_avg_s: number;
    queue_avg_s: number;
    ws_send_avg_s: number;
    decode_avg_s?: number;
    drop_count: number;
  };
  config: {
    inference_workers: number;
    process_res: number;
    downsample_factor: number;
  };
}

export interface PerfSettings {
  depthLeadMs: number;
  maxInflightRequests: number;
  autoLead: boolean;
}

export interface ViewerControls {
  targetTriangles: number;
  fovY: number;
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
