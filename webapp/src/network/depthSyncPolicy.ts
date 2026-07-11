import type { DepthStatus, PerformanceMode } from '../types';

const INFLIGHT_MULTIPLIER: Record<Exclude<PerformanceMode, 'manual'>, number> = {
  smooth: 2,
  balanced: 3,
  quality: 4,
};

export function getAutoMaxInflight(
  mode: PerformanceMode,
  inferenceWorkers: number
): number | null {
  if (
    mode === 'manual' ||
    !Number.isFinite(inferenceWorkers) ||
    inferenceWorkers <= 0
  ) {
    return null;
  }
  return (
    Math.max(1, Math.floor(inferenceWorkers)) * INFLIGHT_MULTIPLIER[mode]
  );
}

export function getSuggestedDepthLeadMs(
  stats: DepthStatus['rolling_stats'],
  inferenceWorkers: number
): number {
  const safetyMargin = 0.05 + stats.infer_avg_s * 0.1;
  const totalProcessingS =
    stats.queue_avg_s +
    (stats.decode_avg_s || 0.05) +
    (stats.normalize_avg_s ?? 0) +
    (stats.infer_wait_avg_s ?? 0) +
    stats.infer_avg_s +
    (stats.pack_avg_s ?? 0) +
    safetyMargin;
  const pipelineLeadMs =
    Number.isFinite(inferenceWorkers) && inferenceWorkers > 0
      ? Math.floor(inferenceWorkers) * 40
      : 0;
  return Math.round(
    Math.max(
      50,
      Math.min(2000, Math.max(totalProcessingS * 1000, pipelineLeadMs))
    )
  );
}
