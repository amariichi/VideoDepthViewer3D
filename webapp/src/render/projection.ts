import type { ViewerControls } from '../types';

export function getProjectionMix(controls: ViewerControls): number {
  return controls.projectionMode === 'pinhole' ? 1.0 : 0.0;
}

export function getTanHalfSourceFovY(controls: ViewerControls): number {
  return Math.tan((controls.sourceFovY * Math.PI) / 360);
}
