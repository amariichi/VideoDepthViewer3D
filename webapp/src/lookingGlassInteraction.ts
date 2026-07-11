import * as THREE from 'three';
import {
  LOOKING_GLASS_VIEW_RANGES,
} from './lookingGlass';
import {
  getEffectiveGeometryControls,
  getProjectionCalibration,
  getProjectionMix,
} from './render/projection';
import { getGridSegments } from './render/mesh';
import type {
  CameraCalibration,
  DepthFrame,
  ViewerControls,
} from './types';

const WHEEL_ZOOM_EXPONENT_PER_PIXEL = 0.0015;
const WHEEL_LINE_HEIGHT_PX = 16;
const DEFAULT_WHEEL_PAGE_HEIGHT_PX = 800;
const PICK_DISCONTINUITY_ABSOLUTE = 0.15;
const PICK_DISCONTINUITY_RELATIVE = 0.2;

export interface LookingGlassDepthPickInput {
  normalizedX: number;
  normalizedY: number;
  cameraMatrixWorld: THREE.Matrix4;
  projectionMatrix: THREE.Matrix4;
  modelMatrix: THREE.Matrix4;
  frame: DepthFrame;
  controls: ViewerControls;
  calibration: CameraCalibration | null;
}

export interface LookingGlassDepthPick {
  point: THREE.Vector3;
  distance: number;
}

/** RawXR grid v=0 is the top row; typed depth uploads retain row order. */
export function sampleRawXRDepth(
  frame: DepthFrame,
  u: number,
  v: number
): number {
  const sampleX = Math.min(
    frame.width - 1,
    Math.max(0, Math.round(u * (frame.width - 1)))
  );
  const sampleY = Math.min(
    frame.height - 1,
    Math.max(0, Math.round(v * (frame.height - 1)))
  );
  return frame.data[sampleY * frame.width + sampleX];
}

export function getLookingGlassWheelZoom(
  currentZoom: number,
  deltaY: number,
  deltaMode: number,
  pageHeightPx = DEFAULT_WHEEL_PAGE_HEIGHT_PX
): number {
  const modeScale = deltaMode === 1
    ? WHEEL_LINE_HEIGHT_PX
    : deltaMode === 2
      ? Math.max(pageHeightPx, 1)
      : 1;
  const safeCurrent = Number.isFinite(currentZoom) ? currentZoom : 1;
  const safeDelta = Number.isFinite(deltaY) ? deltaY : 0;
  const normalizedDelta = Math.min(
    Math.max(safeDelta * modeScale, -1000),
    1000
  );
  const rawNext =
    safeCurrent *
    Math.exp(-normalizedDelta * WHEEL_ZOOM_EXPONENT_PER_PIXEL);
  const crossesDefault =
    (safeCurrent < 1 && rawNext > 1) ||
    (safeCurrent > 1 && rawNext < 1);
  const next = crossesDefault ? 1 : Math.round(rawNext * 1000) / 1000;
  return Math.min(
    Math.max(
      Math.round(next * 1000) / 1000,
      LOOKING_GLASS_VIEW_RANGES.zoom.min
    ),
    LOOKING_GLASS_VIEW_RANGES.zoom.max
  );
}

export function isLookingGlassPickTriangleContinuous(
  depthA: number,
  depthB: number,
  depthC: number
): boolean {
  if (![depthA, depthB, depthC].every(Number.isFinite)) return false;
  const minDepth = Math.min(depthA, depthB, depthC);
  const maxDepth = Math.max(depthA, depthB, depthC);
  if (minDepth < 0) return false;
  const threshold = Math.max(
    PICK_DISCONTINUITY_ABSOLUTE,
    minDepth * PICK_DISCONTINUITY_RELATIVE
  );
  return maxDepth - minDepth <= threshold;
}

/**
 * Pick the visible RawXR height-field surface from the central Looking Glass
 * view. RawXR world +z points toward the viewer, matching targetZ. The render
 * mesh remains fully connected; only artificial curtain-like discontinuity
 * triangles are ignored for focus selection.
 */
export function pickLookingGlassDepthMesh({
  normalizedX,
  normalizedY,
  cameraMatrixWorld,
  projectionMatrix,
  modelMatrix,
  frame,
  controls,
  calibration,
}: LookingGlassDepthPickInput): LookingGlassDepthPick | null {
  if (
    !Number.isFinite(normalizedX) ||
    !Number.isFinite(normalizedY) ||
    normalizedX < 0 ||
    normalizedX > 1 ||
    normalizedY < 0 ||
    normalizedY > 1 ||
    frame.width <= 0 ||
    frame.height <= 0 ||
    frame.data.length < frame.width * frame.height
  ) {
    return null;
  }

  const projection = getProjectionCalibration(
    calibration,
    controls,
    frame.width / frame.height
  );
  const effective = getEffectiveGeometryControls(
    controls,
    projection.depthMetricScale
  );
  const projectionMix = getProjectionMix(controls);
  const { segmentsX, segmentsY } = getGridSegments({
    aspect: projection.displayAspect,
    targetTriangles: controls.targetTriangles,
  });
  const rowStride = segmentsX + 1;
  const vertexCount = rowStride * (segmentsY + 1);
  const positions = new Float32Array(vertexCount * 3);
  const surfaceDepths = new Float32Array(vertexCount);
  const valid = new Uint8Array(vertexCount);
  const local = new THREE.Vector3();

  for (let gridY = 0; gridY <= segmentsY; gridY += 1) {
    const v = gridY / segmentsY;
    for (let gridX = 0; gridX <= segmentsX; gridX += 1) {
      const u = gridX / segmentsX;
      const rawDepth = sampleRawXRDepth(frame, u, v);
      const vertexIndex = gridY * rowStride + gridX;
      if (!Number.isFinite(rawDepth) || rawDepth < 0) continue;

      const shapedDepth = Math.pow(Math.max(rawDepth, 0), effective.zGamma);
      const zDepth = Math.min(
        Math.max(shapedDepth * effective.zScale, 0),
        controls.zMaxClip
      );
      const z = zDepth + effective.zBias;
      if (!Number.isFinite(z)) continue;

      const sampleV = 1 - v;
      const reliefX = (u - 0.5) * projection.displayAspect * effective.planeScale;
      const reliefY = (0.5 - v) * effective.planeScale;
      const pinholeX = ((u - projection.principalUvX) / projection.focalNormX) * z;
      const pinholeY = ((sampleV - projection.principalUvY) / projection.focalNormY) * z;
      const x = THREE.MathUtils.lerp(reliefX, pinholeX, projectionMix);
      const y = THREE.MathUtils.lerp(reliefY, pinholeY, projectionMix);

      local.set(x, y, -z).applyMatrix4(modelMatrix);
      const positionIndex = vertexIndex * 3;
      positions[positionIndex] = local.x;
      positions[positionIndex + 1] = local.y;
      positions[positionIndex + 2] = local.z;
      surfaceDepths[vertexIndex] = zDepth;
      valid[vertexIndex] = 1;
    }
  }

  const inverseProjection = projectionMatrix.clone().invert();
  const rayOrigin = new THREE.Vector3().setFromMatrixPosition(cameraMatrixWorld);
  const rayTarget = new THREE.Vector3(
    normalizedX * 2 - 1,
    1 - normalizedY * 2,
    1
  )
    .applyMatrix4(inverseProjection)
    .applyMatrix4(cameraMatrixWorld);
  const ray = new THREE.Ray(
    rayOrigin,
    rayTarget.sub(rayOrigin).normalize()
  );
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const candidate = new THREE.Vector3();
  const bestPoint = new THREE.Vector3();
  let bestDistance = Number.POSITIVE_INFINITY;

  const loadVertex = (index: number, target: THREE.Vector3): void => {
    const offset = index * 3;
    target.set(
      positions[offset],
      positions[offset + 1],
      positions[offset + 2]
    );
  };
  const testTriangle = (i0: number, i1: number, i2: number): void => {
    if (!valid[i0] || !valid[i1] || !valid[i2]) return;
    if (
      !isLookingGlassPickTriangleContinuous(
        surfaceDepths[i0],
        surfaceDepths[i1],
        surfaceDepths[i2]
      )
    ) {
      return;
    }
    loadVertex(i0, a);
    loadVertex(i1, b);
    loadVertex(i2, c);
    const hit = ray.intersectTriangle(a, b, c, false, candidate);
    if (!hit) return;
    const distance = hit.distanceTo(rayOrigin);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPoint.copy(hit);
    }
  };

  for (let gridY = 0; gridY < segmentsY; gridY += 1) {
    for (let gridX = 0; gridX < segmentsX; gridX += 1) {
      const i0 = gridY * rowStride + gridX;
      const i1 = i0 + 1;
      const i2 = i0 + rowStride;
      const i3 = i2 + 1;
      testTriangle(i0, i2, i1);
      testTriangle(i1, i2, i3);
    }
  }

  return Number.isFinite(bestDistance)
    ? { point: bestPoint.clone(), distance: bestDistance }
    : null;
}
