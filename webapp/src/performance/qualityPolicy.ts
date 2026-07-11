import type { PerformanceMode } from '../types';

const MODE_TRIANGLE_CAP: Record<Exclude<PerformanceMode, 'manual'>, number> = {
  smooth: 60_000,
  balanced: 140_000,
  quality: 240_000,
};

export function getModeTargetTriangles(
  mode: PerformanceMode,
  manualTarget: number,
  depthWidth?: number,
  depthHeight?: number
): number {
  const requested = mode === 'manual' ? manualTarget : MODE_TRIANGLE_CAP[mode];
  const pixelLimit =
    depthWidth && depthHeight && depthWidth > 1 && depthHeight > 1
      ? 2 * (depthWidth - 1) * (depthHeight - 1)
      : Number.POSITIVE_INFINITY;
  return Math.max(2_000, Math.round(Math.min(requested, pixelLimit)));
}
