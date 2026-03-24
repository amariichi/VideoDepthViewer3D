import type { ViewerControls } from '../types';

export function getProjectionMix(controls: ViewerControls): number {
  return controls.projectionMode === 'pinhole' ? 1.0 : 0.0;
}

export function getTanHalfFovY(controls: ViewerControls): number {
  return Math.tan((controls.fovY * Math.PI) / 360);
}
