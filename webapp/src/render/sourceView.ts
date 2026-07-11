import type { ProjectionCalibration } from './projection';

export type Vec3Tuple = [number, number, number];

export interface SourceViewLayout {
  cameraPosition: Vec3Tuple;
  meshSourceOrigin: Vec3Tuple;
  orbitTarget: Vec3Tuple;
  cameraDistance: number;
  modelZ: number;
}

export interface SourceViewNavigation {
  zoom: number;
  panX: number;
  panY: number;
}

export const SOURCE_VIEW_ZOOM_RANGE = { min: 0.5, max: 4 } as const;
export const SOURCE_VIEW_MAX_PAN = 3;

export function getDefaultSourceViewNavigation(): SourceViewNavigation {
  return { zoom: 1, panX: 0, panY: 0 };
}

export function clampSourceViewNavigation(
  navigation: SourceViewNavigation
): SourceViewNavigation {
  return {
    zoom: Number.isFinite(navigation.zoom)
      ? Math.min(
          Math.max(navigation.zoom, SOURCE_VIEW_ZOOM_RANGE.min),
          SOURCE_VIEW_ZOOM_RANGE.max
        )
      : 1,
    panX: Number.isFinite(navigation.panX)
      ? Math.min(
          Math.max(navigation.panX, -SOURCE_VIEW_MAX_PAN),
          SOURCE_VIEW_MAX_PAN
        )
      : 0,
    panY: Number.isFinite(navigation.panY)
      ? Math.min(
          Math.max(navigation.panY, -SOURCE_VIEW_MAX_PAN),
          SOURCE_VIEW_MAX_PAN
        )
      : 0,
  };
}

/** Apply a crop-like view zoom without changing source-camera calibration. */
export function getSourceViewZoomFovY(
  autoFitFovY: number,
  zoom: number
): number {
  const safeFov = Number.isFinite(autoFitFovY)
    ? Math.min(Math.max(autoFitFovY, 1), 170)
    : 50;
  const safeZoom = clampSourceViewNavigation({
    zoom,
    panX: 0,
    panY: 0,
  }).zoom;
  return Math.min(
    Math.max(
      (2 * Math.atan(Math.tan((safeFov * Math.PI) / 360) / safeZoom) *
        180) /
        Math.PI,
      1
    ),
    170
  );
}

/** Zoom around one normalized viewport point while retaining its screen spot. */
export function zoomSourceViewAt(
  navigation: SourceViewNavigation,
  deltaY: number,
  cursorX = 0,
  cursorY = 0
): SourceViewNavigation {
  const current = clampSourceViewNavigation(navigation);
  const safeDelta = Number.isFinite(deltaY)
    ? Math.min(Math.max(deltaY, -500), 500)
    : 0;
  const zoom = Math.min(
    Math.max(
      current.zoom * Math.exp(-safeDelta * 0.0015),
      SOURCE_VIEW_ZOOM_RANGE.min
    ),
    SOURCE_VIEW_ZOOM_RANGE.max
  );
  const scale = zoom / current.zoom;
  const anchorX = Number.isFinite(cursorX)
    ? Math.min(Math.max(cursorX, -1), 1)
    : 0;
  const anchorY = Number.isFinite(cursorY)
    ? Math.min(Math.max(cursorY, -1), 1)
    : 0;
  return clampSourceViewNavigation({
    zoom,
    panX: anchorX - scale * (anchorX - current.panX),
    panY: anchorY - scale * (anchorY - current.panY),
  });
}

export function panSourceViewBy(
  navigation: SourceViewNavigation,
  deltaX: number,
  deltaY: number
): SourceViewNavigation {
  const current = clampSourceViewNavigation(navigation);
  return clampSourceViewNavigation({
    ...current,
    panX: current.panX + (Number.isFinite(deltaX) ? deltaX : 0),
    panY: current.panY + (Number.isFinite(deltaY) ? deltaY : 0),
  });
}

export const DEFAULT_SOURCE_PIVOT_DEPTH = 3.5;
export const MIN_SOURCE_PIVOT_DEPTH = 0.2;
export const MAX_SOURCE_PIVOT_DEPTH = 50;

function clampPivotDepth(value: number, zMaxClip: number): number {
  const upper = Math.min(
    Math.max(zMaxClip, MIN_SOURCE_PIVOT_DEPTH),
    MAX_SOURCE_PIVOT_DEPTH
  );
  return Math.min(Math.max(value, MIN_SOURCE_PIVOT_DEPTH), upper);
}

/**
 * Place the reconstructed camera apex at the viewer eye and put the orbit
 * target one representative scene depth in front of both. With +z pointing
 * toward the viewer, camera and mesh origin share z=pivot while the target is
 * at z=0.
 */
export function getSourceViewLayout(
  pivotDepth: number,
  y: number
): SourceViewLayout {
  const pivot = Number.isFinite(pivotDepth)
    ? Math.max(pivotDepth, MIN_SOURCE_PIVOT_DEPTH)
    : DEFAULT_SOURCE_PIVOT_DEPTH;
  const verticalCenter = Number.isFinite(y) ? y : 0;
  const sourceOrigin: Vec3Tuple = [0, verticalCenter, pivot];
  return {
    cameraPosition: [...sourceOrigin],
    meshSourceOrigin: [...sourceOrigin],
    orbitTarget: [0, verticalCenter, 0],
    cameraDistance: pivot,
    modelZ: pivot,
  };
}

/** Return the total vertical source-camera FOV represented by normalized K. */
export function getSourceViewFovY(
  projection: ProjectionCalibration
): number {
  const focal = Math.max(projection.focalNormY, Number.EPSILON);
  const principal = Math.min(Math.max(projection.principalUvY, 0), 1);
  const below = Math.atan(principal / focal);
  const above = Math.atan((1 - principal) / focal);
  return ((below + above) * 180) / Math.PI;
}

/**
 * Return a symmetric vertical FOV that contains every source-camera boundary
 * in the active viewport. SBS passes the aspect of one half, not the combined
 * canvas. A manual FOV acts as a minimum zoom-out without changing eye pose.
 */
export function getSourceViewFitFovY(
  projection: ProjectionCalibration,
  viewportAspect: number,
  minimumFovY = 0,
  margin = 1
): number {
  const focalX = Math.max(projection.focalNormX, Number.EPSILON);
  const focalY = Math.max(projection.focalNormY, Number.EPSILON);
  const principalX = Math.min(Math.max(projection.principalUvX, 0), 1);
  const principalY = Math.min(Math.max(projection.principalUvY, 0), 1);
  const safeAspect = Math.max(viewportAspect, 0.01);
  const safeMargin = Math.max(margin, 1);
  const horizontalExtent = Math.max(
    principalX / focalX,
    (1 - principalX) / focalX
  );
  const verticalExtent = Math.max(
    principalY / focalY,
    (1 - principalY) / focalY
  );
  const fitTanHalf = Math.max(
    verticalExtent,
    horizontalExtent / safeAspect
  ) * safeMargin;
  const fitFovY = (2 * Math.atan(fitTanHalf) * 180) / Math.PI;
  const manualFloor = Number.isFinite(minimumFovY)
    ? minimumFovY
    : 0;
  return Math.min(Math.max(fitFovY, manualFloor, 1), 170);
}

/**
 * Estimate an orbit pivot from a sparse central crop. This runs on decoded
 * browser depth, so depthMetricScale must be supplied when fallback Source FOV
 * changes the metric scale. Sampling bounds CPU work independently of 2K/4K
 * source resolution.
 */
export function estimateSourcePivotDepth(
  data: Float32Array,
  width: number,
  height: number,
  depthMetricScale: number,
  zMaxClip: number,
  fallback = DEFAULT_SOURCE_PIVOT_DEPTH,
  maxSamples = 2048
): number {
  const safeWidth = Math.max(0, Math.floor(width));
  const safeHeight = Math.max(0, Math.floor(height));
  const expectedLength = safeWidth * safeHeight;
  const scale = Number.isFinite(depthMetricScale) && depthMetricScale > 0
    ? depthMetricScale
    : 1;
  const clip = Number.isFinite(zMaxClip) && zMaxClip > 0
    ? zMaxClip
    : MAX_SOURCE_PIVOT_DEPTH;
  const safeFallback = clampPivotDepth(
    Number.isFinite(fallback) ? fallback : DEFAULT_SOURCE_PIVOT_DEPTH,
    clip
  );

  if (
    safeWidth === 0 ||
    safeHeight === 0 ||
    expectedLength === 0 ||
    data.length < expectedLength
  ) {
    return safeFallback;
  }

  const xStart = Math.floor(safeWidth * 0.1);
  const xEnd = Math.max(xStart + 1, Math.ceil(safeWidth * 0.9));
  const yStart = Math.floor(safeHeight * 0.1);
  const yEnd = Math.max(yStart + 1, Math.ceil(safeHeight * 0.9));
  const cropArea = Math.max((xEnd - xStart) * (yEnd - yStart), 1);
  const stride = Math.max(1, Math.ceil(Math.sqrt(cropArea / Math.max(maxSamples, 1))));
  const values: number[] = [];

  for (let y = yStart; y < yEnd; y += stride) {
    const row = y * safeWidth;
    for (let x = xStart; x < xEnd; x += stride) {
      const raw = data[row + x];
      if (!Number.isFinite(raw) || raw <= 0) continue;
      const metric = raw * scale;
      if (!Number.isFinite(metric) || metric <= 0) continue;
      values.push(Math.min(metric, clip));
    }
  }

  if (values.length === 0) return safeFallback;
  values.sort((a, b) => a - b);
  const middle = (values.length - 1) / 2;
  const lower = values[Math.floor(middle)];
  const upper = values[Math.ceil(middle)];
  return clampPivotDepth((lower + upper) / 2, clip);
}
