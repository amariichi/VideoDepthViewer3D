import { describe, expect, it } from 'vitest';
import type { CameraCalibration, ViewerControls } from '../types';
import {
  getEffectiveGeometryControls,
  getOffAxisFrustum,
  getProjectionCalibration,
  getProjectionMix,
  getTanHalfSourceFovY,
  unprojectTextureUv,
} from './projection';

const controls: ViewerControls = {
  projectionMode: 'pinhole',
  framingMode: 'source',
  targetTriangles: 200_000,
  fovY: 50,
  sourceFovY: 50,
  zScale: 1,
  zBias: 0,
  zGamma: 1,
  zMaxClip: 50,
  planeScale: 2,
  yOffset: 1.2,
};

const calibration: CameraCalibration = {
  fx: 400,
  fy: 300,
  cx: 319.5,
  cy: 239.5,
  sourceWidth: 640,
  sourceHeight: 480,
  displayWidth: 640,
  displayHeight: 480,
  inferenceWidth: 640,
  inferenceHeight: 480,
  pixelAspectRatio: 1,
  rotationDegrees: 0,
  cropX: 0,
  cropY: 0,
  cropWidth: 640,
  cropHeight: 480,
  origin: 'manual',
  confidence: 1,
};

describe('projection controls', () => {
  it('selects pinhole and relief paths without blending ambiguity', () => {
    expect(getProjectionMix(controls)).toBe(1);
    expect(getProjectionMix({ ...controls, projectionMode: 'relief' })).toBe(0);
  });

  it('converts the source vertical field of view to a pinhole tangent', () => {
    expect(getTanHalfSourceFovY({ ...controls, sourceFovY: 90 })).toBeCloseTo(1, 12);
    expect(getTanHalfSourceFovY(controls)).toBeCloseTo(Math.tan((50 * Math.PI) / 360), 12);
  });

  it('keeps source and display fields of view independent', () => {
    const baseline = getTanHalfSourceFovY(controls);
    expect(getTanHalfSourceFovY({ ...controls, fovY: 80 })).toBe(baseline);
    expect(getTanHalfSourceFovY({ ...controls, sourceFovY: 80 })).not.toBe(baseline);
  });

  it('unprojects a known K plane back into camera coordinates', () => {
    const projection = getProjectionCalibration(calibration, controls);
    const expected: [number, number, number] = [0.4, -0.2, -2];
    const u = projection.principalUvX + (calibration.fx * (expected[0] / 2)) / 640;
    const v = projection.principalUvY + (calibration.fy * (expected[1] / 2)) / 480;

    const actual = unprojectTextureUv(u, v, 2, projection);

    expect(actual[0]).toBeCloseTo(expected[0], 12);
    expect(actual[1]).toBeCloseTo(expected[1], 12);
    expect(actual[2]).toBe(expected[2]);
  });

  it('uses Source FOV to replace fallback K and metric scale together', () => {
    const fallback = { ...calibration, origin: 'fallback' as const };
    const baseline = getProjectionCalibration(fallback, controls);
    const wider = getProjectionCalibration(
      fallback,
      { ...controls, sourceFovY: 60 }
    );

    expect(baseline.depthMetricScale).toBeCloseTo(
      (0.5 * 480) / (Math.tan((50 * Math.PI) / 360) * calibration.fy),
      12
    );
    expect(wider.focalNormY).toBeLessThan(baseline.focalNormY);
    expect(wider.depthMetricScale).toBeLessThan(baseline.depthMetricScale);
  });

  it('locks calibrated geometry while preserving relief controls', () => {
    expect(getEffectiveGeometryControls(controls, 0.75)).toEqual({
      zScale: 0.75,
      zBias: 0,
      zGamma: 1,
      planeScale: 2,
    });
    expect(
      getEffectiveGeometryControls({
        ...controls,
        projectionMode: 'relief',
        zScale: 1.5,
        zBias: 0.4,
        zGamma: 1.2,
        planeScale: 3,
      })
    ).toEqual({ zScale: 1.5, zBias: 0.4, zGamma: 1.2, planeScale: 3 });
  });

  it('builds mirrored off-axis frusta that converge at one distance', () => {
    const left = getOffAxisFrustum(50, 1, 0.1, 100, -0.032, 3.5);
    const right = getOffAxisFrustum(50, 1, 0.1, 100, 0.032, 3.5);

    expect(left.left + left.right).toBeCloseTo(-(right.left + right.right), 12);
    expect((left.left + left.right) / 2).toBeCloseTo(
      (0.032 * 0.1) / 3.5,
      12
    );
  });

  it('applies one shared view-window pan without changing stereo separation', () => {
    const left = getOffAxisFrustum(50, 1, 0.1, 100, -0.032, 3.5);
    const right = getOffAxisFrustum(50, 1, 0.1, 100, 0.032, 3.5);
    const pannedLeft = getOffAxisFrustum(
      50,
      1,
      0.1,
      100,
      -0.032,
      3.5,
      0.25,
      -0.4
    );
    const pannedRight = getOffAxisFrustum(
      50,
      1,
      0.1,
      100,
      0.032,
      3.5,
      0.25,
      -0.4
    );

    expect(
      pannedLeft.left + pannedLeft.right - (left.left + left.right)
    ).toBeCloseTo(
      pannedRight.left + pannedRight.right - (right.left + right.right),
      12
    );
    expect(pannedLeft.top + pannedLeft.bottom).not.toBeCloseTo(0, 12);
    expect(
      (pannedLeft.left + pannedLeft.right) -
        (pannedRight.left + pannedRight.right)
    ).toBeCloseTo(
      (left.left + left.right) - (right.left + right.right),
      12
    );
  });
});
