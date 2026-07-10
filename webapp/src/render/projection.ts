import type { CameraCalibration, ViewerControls } from '../types';

export interface ProjectionCalibration {
  focalNormX: number;
  focalNormY: number;
  principalUvX: number;
  principalUvY: number;
  depthMetricScale: number;
  displayAspect: number;
}

export interface EffectiveGeometryControls {
  zScale: number;
  zBias: number;
  zGamma: number;
  planeScale: number;
}

export interface OffAxisFrustum {
  left: number;
  right: number;
  top: number;
  bottom: number;
  near: number;
  far: number;
}

export function getProjectionMix(controls: ViewerControls): number {
  return controls.projectionMode === 'pinhole' ? 1.0 : 0.0;
}

export function getTanHalfSourceFovY(controls: ViewerControls): number {
  return Math.tan((controls.sourceFovY * Math.PI) / 360);
}

export function getProjectionCalibration(
  calibration: CameraCalibration | null,
  controls: ViewerControls,
  fallbackAspect = 16 / 9
): ProjectionCalibration {
  const tanHalfFov = getTanHalfSourceFovY(controls);
  if (!calibration) {
    return {
      focalNormX: 1 / (2 * fallbackAspect * tanHalfFov),
      focalNormY: 1 / (2 * tanHalfFov),
      principalUvX: 0.5,
      principalUvY: 0.5,
      depthMetricScale: 1,
      displayAspect: fallbackAspect,
    };
  }

  const width = Math.max(calibration.displayWidth, 1);
  const height = Math.max(calibration.displayHeight, 1);
  let fx = calibration.fx;
  let fy = calibration.fy;
  let depthMetricScale = 1;

  // Container metadata rarely includes K. In fallback mode the Source FOV
  // control replaces the assumed K, and the same focal ratio corrects the
  // already-scaled DA3Metric depth without another inference pass.
  if (calibration.origin === 'fallback') {
    const selectedFocal = 0.5 * height / tanHalfFov;
    depthMetricScale = selectedFocal / Math.max(calibration.fy, Number.EPSILON);
    fx = selectedFocal;
    fy = selectedFocal;
  }

  return {
    focalNormX: fx / width,
    focalNormY: fy / height,
    principalUvX: (calibration.cx + 0.5) / width,
    principalUvY: 1 - (calibration.cy + 0.5) / height,
    depthMetricScale,
    displayAspect: width / height,
  };
}

export function getEffectiveGeometryControls(
  controls: ViewerControls,
  depthMetricScale = 1
): EffectiveGeometryControls {
  if (controls.projectionMode === 'pinhole') {
    return {
      zScale: depthMetricScale,
      zBias: 0,
      zGamma: 1,
      planeScale: 2,
    };
  }
  return {
    zScale: controls.zScale,
    zBias: controls.zBias,
    zGamma: controls.zGamma,
    planeScale: controls.planeScale,
  };
}

export function unprojectTextureUv(
  u: number,
  v: number,
  depth: number,
  calibration: ProjectionCalibration
): [number, number, number] {
  return [
    ((u - calibration.principalUvX) / calibration.focalNormX) * depth,
    ((v - calibration.principalUvY) / calibration.focalNormY) * depth,
    -depth,
  ];
}

export function getOffAxisFrustum(
  fovYDegrees: number,
  aspect: number,
  near: number,
  far: number,
  eyeOffset: number,
  convergenceDistance: number
): OffAxisFrustum {
  const safeConvergence = Math.max(convergenceDistance, near + Number.EPSILON);
  const top = near * Math.tan((fovYDegrees * Math.PI) / 360);
  const halfWidth = top * aspect;
  const center = (-eyeOffset * near) / safeConvergence;
  return {
    left: -halfWidth + center,
    right: halfWidth + center,
    top,
    bottom: -top,
    near,
    far,
  };
}
