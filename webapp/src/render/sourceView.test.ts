import { describe, expect, it } from 'vitest';
import type { ProjectionCalibration } from './projection';
import { unprojectTextureUv } from './projection';
import {
  SOURCE_VIEW_MAX_PAN,
  SOURCE_VIEW_ZOOM_RANGE,
  clampSourceViewNavigation,
  estimateSourcePivotDepth,
  getDefaultSourceViewNavigation,
  getSourceViewFitFovY,
  getSourceViewFovY,
  getSourceViewLayout,
  getSourceViewZoomFovY,
  panSourceViewBy,
  zoomSourceViewAt,
} from './sourceView';

const centeredProjection: ProjectionCalibration = {
  focalNormX: 0.5 / (16 / 9),
  focalNormY: 0.5,
  principalUvX: 0.5,
  principalUvY: 0.5,
  depthMetricScale: 1,
  displayAspect: 16 / 9,
};

describe('Source View framing', () => {
  it('places the viewer eye exactly at the reconstructed source-camera origin', () => {
    const layout = getSourceViewLayout(4.2, 1.2);

    expect(layout.cameraPosition).toEqual([0, 1.2, 4.2]);
    expect(layout.meshSourceOrigin).toEqual(layout.cameraPosition);
    expect(layout.orbitTarget).toEqual([0, 1.2, 0]);
    expect(layout.cameraDistance).toBe(4.2);
    expect(layout.modelZ).toBe(4.2);
  });

  it('keeps every reconstructed source ray unchanged in the central view', () => {
    const layout = getSourceViewLayout(3.5, 1.2);
    const localPoint = unprojectTextureUv(0.8, 0.25, 2.4, centeredProjection);
    const worldPoint = localPoint.map(
      (value, axis) => value + layout.meshSourceOrigin[axis]
    );
    const eyeRelative = worldPoint.map(
      (value, axis) => value - layout.cameraPosition[axis]
    );

    expect(eyeRelative[0]).toBeCloseTo(localPoint[0], 12);
    expect(eyeRelative[1]).toBeCloseTo(localPoint[1], 12);
    expect(eyeRelative[2]).toBeCloseTo(localPoint[2], 12);
  });

  it('derives the central display FOV from the active source calibration', () => {
    expect(getSourceViewFovY(centeredProjection)).toBeCloseTo(90, 12);

    const narrow = { ...centeredProjection, focalNormY: 1 };
    expect(getSourceViewFovY(narrow)).toBeCloseTo(
      (2 * Math.atan(0.5) * 180) / Math.PI,
      12
    );
  });

  it('reprojects every source pixel independently of its depth', () => {
    const fovY = getSourceViewFovY(centeredProjection);
    const tanHalfFovY = Math.tan((fovY * Math.PI) / 360);
    const samples = [
      { u: 0.1, v: 0.2, depth: 0.8 },
      { u: 0.7, v: 0.6, depth: 3.4 },
      { u: 0.95, v: 0.85, depth: 12 },
    ];

    for (const sample of samples) {
      const [x, y, z] = unprojectTextureUv(
        sample.u,
        sample.v,
        sample.depth,
        centeredProjection
      );
      const ndcX = (x / -z) / (tanHalfFovY * centeredProjection.displayAspect);
      const ndcY = (y / -z) / tanHalfFovY;
      expect(ndcX).toBeCloseTo(2 * sample.u - 1, 12);
      expect(ndcY).toBeCloseTo(2 * sample.v - 1, 12);
    }
  });

  it('fits the full source width into each half-width SBS viewport', () => {
    const fullViewportFov = getSourceViewFitFovY(
      centeredProjection,
      16 / 9,
      0
    );
    const sbsViewportFov = getSourceViewFitFovY(
      centeredProjection,
      8 / 9,
      0
    );

    expect(fullViewportFov).toBeCloseTo(90, 12);
    expect(sbsViewportFov).toBeCloseTo(
      (2 * Math.atan(2) * 180) / Math.PI,
      12
    );
    expect(
      getSourceViewFitFovY(centeredProjection, 8 / 9, 130)
    ).toBe(130);
  });

  it('uses a robust sampled depth pivot and applies the active metric scale', () => {
    const depth = new Float32Array(100).fill(2);
    depth[11] = Number.NaN;
    depth[22] = 0;
    depth[33] = 1000;

    expect(estimateSourcePivotDepth(depth, 10, 10, 1.5, 50)).toBeCloseTo(3, 12);
  });

  it('falls back safely when a frame has no valid depth', () => {
    const depth = new Float32Array(16);

    expect(estimateSourcePivotDepth(depth, 4, 4, 1, 50, 2.75)).toBe(2.75);
  });

  it('zooms the fitted view without changing source-camera calibration', () => {
    const baseFov = getSourceViewFitFovY(centeredProjection, 8 / 9, 0);

    expect(getSourceViewZoomFovY(baseFov, 2)).toBeLessThan(baseFov);
    expect(getSourceViewZoomFovY(baseFov, 0.5)).toBeGreaterThan(baseFov);
    expect(getSourceViewZoomFovY(baseFov, 1)).toBeCloseTo(baseFov, 12);
  });

  it('keeps the source point under the cursor anchored while zooming', () => {
    const cursor = { x: 0.6, y: -0.4 };
    const before = getDefaultSourceViewNavigation();
    const sourceX = (cursor.x - before.panX) / before.zoom;
    const sourceY = (cursor.y - before.panY) / before.zoom;
    const after = zoomSourceViewAt(before, -200, cursor.x, cursor.y);

    expect(after.zoom).toBeGreaterThan(before.zoom);
    expect(after.zoom * sourceX + after.panX).toBeCloseTo(cursor.x, 12);
    expect(after.zoom * sourceY + after.panY).toBeCloseTo(cursor.y, 12);
  });

  it('bounds source-view wheel zoom and drag pan', () => {
    let navigation = getDefaultSourceViewNavigation();
    for (let i = 0; i < 10; i += 1) {
      navigation = zoomSourceViewAt(navigation, -100_000);
    }
    expect(navigation.zoom).toBe(SOURCE_VIEW_ZOOM_RANGE.max);
    for (let i = 0; i < 10; i += 1) {
      navigation = zoomSourceViewAt(navigation, 100_000);
    }
    expect(navigation.zoom).toBe(SOURCE_VIEW_ZOOM_RANGE.min);

    navigation = panSourceViewBy(navigation, 100, -100);
    expect(navigation.panX).toBe(SOURCE_VIEW_MAX_PAN);
    expect(navigation.panY).toBe(-SOURCE_VIEW_MAX_PAN);
    expect(
      clampSourceViewNavigation({
        zoom: Number.NaN,
        panX: Infinity,
        panY: Number.NaN,
      })
    ).toEqual(getDefaultSourceViewNavigation());
  });
});
