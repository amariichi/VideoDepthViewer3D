import { describe, expect, it } from 'vitest';
import type { ProjectionCalibration } from './projection';
import { unprojectTextureUv } from './projection';
import {
  estimateSourcePivotDepth,
  getSourceViewFitFovY,
  getSourceViewFovY,
  getSourceViewLayout,
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
});
