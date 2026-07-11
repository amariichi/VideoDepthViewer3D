import { describe, expect, it } from 'vitest';
import type { DepthFrame } from '../types';
import {
  FRONT_SAFETY_MAX_VIOLATION_FRACTION,
  LOOKING_GLASS_AUTO_CONVERGENCE_CROWDED_QUANTILE,
  AutoConvergenceController,
  FrontSafetyController,
  classifyLookingGlassAutoConvergence,
  estimateRenderedDepthQuantiles,
  getLookingGlassRequiredPushback,
  getLookingGlassAutoConvergenceTarget,
  getLookingGlassSourceDepthScaleRebase,
  getLookingGlassNearPlaneDistance,
  getLookingGlassSourceNearClipRebase,
  getWebXRRequiredPushback,
  estimateRenderedNearDepth,
  shouldApplyRigidFrontSafety,
} from './frontSafety';

const metricControls = {
  zScale: 1,
  zBias: 0,
  zGamma: 1,
  planeScale: 2,
};

function depthFrame(values: number[]): DepthFrame {
  return {
    timestampMs: 0,
    width: values.length,
    height: 1,
    data: new Float32Array(values),
    scale: 1,
    bias: 0,
    zMax: 50,
  };
}

describe('foreground safety depth occupancy', () => {
  it('ignores a small foreground corner and follows the 20% area quantile', () => {
    const values = [
      ...new Array(10).fill(0.1),
      ...new Array(20).fill(1),
      ...new Array(70).fill(3),
    ];
    const near = estimateRenderedNearDepth(
      depthFrame(values),
      metricControls,
      50,
      FRONT_SAFETY_MAX_VIOLATION_FRACTION,
      values.length
    );

    expect(near).toBeCloseTo(1, 5);
    expect(getWebXRRequiredPushback(near ?? 0)).toBe(0);

    const crowdedForeground = estimateRenderedNearDepth(
      depthFrame([
        ...new Array(30).fill(0.1),
        ...new Array(70).fill(3),
      ]),
      metricControls,
      50,
      FRONT_SAFETY_MAX_VIOLATION_FRACTION,
      values.length
    );
    expect(crowdedForeground).toBeCloseTo(0.1, 5);
    expect(getWebXRRequiredPushback(crowdedForeground ?? 0)).toBeCloseTo(
      0.4,
      5
    );
  });

  it('applies active geometry shaping before estimating occupancy', () => {
    const near = estimateRenderedNearDepth(
      depthFrame(new Array(10).fill(2)),
      { ...metricControls, zScale: 2, zBias: 0.5 },
      3,
      0.2,
      10
    );

    expect(near).toBe(3.5);
  });

  it('derives multiple percentiles from one sparse depth sample', () => {
    const quantiles = estimateRenderedDepthQuantiles(
      depthFrame(Array.from({ length: 100 }, (_, index) => index + 1)),
      metricControls,
      100,
      [0.1, 0.25, 0.5],
      100
    );

    expect(quantiles?.[0]).toBeCloseTo(10.9, 5);
    expect(quantiles?.[1]).toBeCloseTo(25.75, 5);
    expect(quantiles?.[2]).toBeCloseTo(50.5, 5);
  });
});

describe('mode-specific rigid pushback', () => {
  it('preserves calibrated Looking Glass Source View projection', () => {
    expect(
      shouldApplyRigidFrontSafety({
        mode: 'looking-glass',
        preserveSourceProjection: true,
      })
    ).toBe(false);
    expect(shouldApplyRigidFrontSafety({ mode: 'looking-glass' })).toBe(true);
    expect(
      shouldApplyRigidFrontSafety({
        mode: 'webxr',
        preserveSourceProjection: true,
      })
    ).toBe(true);
  });

  it('limits Looking Glass protrusion relative to target diameter', () => {
    expect(getLookingGlassRequiredPushback(1.2, 0.5, 2)).toBeCloseTo(0.54, 10);
    expect(getLookingGlassRequiredPushback(0.6, 0.5, 2)).toBe(0);
  });

  it('keeps generic WebXR content away from the initial eye', () => {
    expect(getWebXRRequiredPushback(0.2)).toBeCloseTo(0.3, 10);
    expect(getWebXRRequiredPushback(1)).toBe(0);
  });

  it('moves backward smoothly without pulling the scene forward again', () => {
    const safety = new FrontSafetyController();
    safety.observe(0.4);
    expect(safety.value).toBe(0.4);

    safety.observe(1.4);
    const halfway = safety.advance(0.1);
    expect(halfway).toBeGreaterThan(0.4);
    expect(halfway).toBeLessThan(1.4);

    safety.observe(0.1);
    expect(safety.targetValue).toBe(1.4);
    safety.advance(1);
    expect(safety.value).toBeGreaterThan(halfway);
  });

  it('rejects a one-sample later spike and confirms sustained increases', () => {
    const safety = new FrontSafetyController();
    safety.observe(0, 3);
    expect(safety.isInitialized).toBe(true);

    safety.observe(2, 3);
    expect(safety.pendingIncreaseCount).toBe(1);
    expect(safety.targetValue).toBe(0);
    safety.observe(0, 3);
    expect(safety.pendingIncreaseCount).toBe(0);
    expect(safety.targetValue).toBe(0);

    safety.observe(0.6, 3);
    safety.observe(0.5, 3);
    safety.observe(0.7, 3);
    expect(safety.targetValue).toBeCloseTo(0.5, 12);
    expect(safety.pendingIncreaseCount).toBe(0);

    safety.reset();
    expect(safety.value).toBe(0);
    expect(safety.targetValue).toBe(0);
    expect(safety.pendingIncreaseCount).toBe(0);
    expect(safety.isInitialized).toBe(false);
  });
});

describe('Looking Glass auto convergence', () => {
  it('targets the 20% boundary while retaining 10% as a safety signal', () => {
    expect(LOOKING_GLASS_AUTO_CONVERGENCE_CROWDED_QUANTILE).toBe(0.2);
    expect(getLookingGlassAutoConvergenceTarget(1.2, 0.6)).toBe(0.6);
    expect(
      getLookingGlassAutoConvergenceTarget(1.2, Number.NaN)
    ).toBe(1.2);
  });

  it('prioritizes unsafe placement over generic scene-change detection', () => {
    const base = {
      frontBoundaryZ: 0,
      crowdedBoundaryZ: -0.1,
      currentTargetZ: 0,
      previousFrontBoundaryZ: 0,
      targetDiameter: 2,
    };

    expect(classifyLookingGlassAutoConvergence(base)).toBe('normal');
    expect(classifyLookingGlassAutoConvergence({
      ...base,
      crowdedBoundaryZ: 0.2,
    })).toBe('crowded-front');
    expect(classifyLookingGlassAutoConvergence({
      ...base,
      frontBoundaryZ: -0.2,
      crowdedBoundaryZ: -0.3,
    })).toBe('all-behind');
    expect(classifyLookingGlassAutoConvergence({
      ...base,
      frontBoundaryZ: 1,
      crowdedBoundaryZ: 0.5,
      previousFrontBoundaryZ: -1,
    })).toBe('crowded-front');
    expect(classifyLookingGlassAutoConvergence({
      ...base,
      frontBoundaryZ: 1,
      crowdedBoundaryZ: -0.1,
      previousFrontBoundaryZ: -1,
    })).toBe('scene-change');
  });

  it('uses a recent median, deadband, bounded steps, and bidirectional motion', () => {
    const convergence = new AutoConvergenceController();
    convergence.reset(0);

    convergence.observe(3, 2);
    convergence.observe(-20, 2);
    expect(convergence.targetValue).toBe(0);
    convergence.observe(3.2, 2);
    expect(convergence.targetValue).toBeCloseTo(0.2, 12);

    const forward = convergence.advance(0.25);
    expect(forward).not.toBeNull();
    expect(forward ?? 0).toBeGreaterThan(0);
    expect(forward ?? 1).toBeLessThan(0.2);

    convergence.observe(-2, 2);
    convergence.observe(-2.2, 2);
    convergence.observe(-2.1, 2);
    expect(convergence.targetValue).toBeCloseTo(0, 12);
  });

  it('seeds safely and ignores non-finite observations', () => {
    const convergence = new AutoConvergenceController();
    convergence.observe(Number.NaN, 1);
    expect(convergence.value).toBeNull();
    convergence.observe(-1.5, 1);
    expect(convergence.value).toBe(-1.5);
    convergence.reset();
    expect(convergence.value).toBeNull();
  });

  it('skips history but keeps a smooth frame transition for urgent recovery', () => {
    const convergence = new AutoConvergenceController();
    convergence.reset(0);
    convergence.observeImmediate(3);

    expect(convergence.targetValue).toBe(3);
    expect(convergence.value).toBe(0);
    const recovering = convergence.advance(0.1, 10);
    expect(recovering ?? 0).toBeGreaterThan(1.5);
    expect(recovering ?? 3).toBeLessThan(3);
  });

  it('snaps a crowded foreground correction without one easing frame', () => {
    const convergence = new AutoConvergenceController();
    convergence.reset(-1);
    convergence.observe(4, 2);
    convergence.snap(0.5);

    expect(convergence.value).toBe(0.5);
    expect(convergence.targetValue).toBe(0.5);
    expect(convergence.advance(0, 0)).toBe(0.5);
  });

  it('rebases the measured 31-to-33-second all-behind scene into reach', () => {
    const sourceOriginZ = 0.314879477;
    const robustNearBoundaryZ = -1.641291726;
    const crowdedBoundaryZ = -2.225394666;
    const rebase = getLookingGlassSourceDepthScaleRebase({
      sourceOriginZ,
      cameraCenterZ: sourceOriginZ,
      configuredTargetZ: 0,
      robustNearBoundaryZ,
      crowdedBoundaryZ,
      currentScale: 1,
      targetDiameter: 0.95,
    });

    expect(rebase?.reason).toBe('all-behind');
    expect(rebase?.scale).toBeCloseTo(0.160969, 5);
    const rebasedNear = sourceOriginZ +
      (robustNearBoundaryZ - sourceOriginZ) * (rebase?.scaleFactor ?? 1);
    const rebasedCrowded = sourceOriginZ +
      (crowdedBoundaryZ - sourceOriginZ) * (rebase?.scaleFactor ?? 1);
    expect(rebasedNear).toBeCloseTo(0, 6);
    expect(rebasedCrowded).toBeGreaterThan(
      rebase?.farReachableTargetZ ?? Number.POSITIVE_INFINITY
    );
  });

  it('reproduces the earlier-close-to-46-second failure and safe click rebase', () => {
    const sourceOriginZ = 0.314879477;
    const robustNearBoundaryZ = sourceOriginZ - 1.201229352;
    const crowdedBoundaryZ = sourceOriginZ - 1.652332366;
    const automatic = getLookingGlassSourceDepthScaleRebase({
      sourceOriginZ,
      cameraCenterZ: sourceOriginZ,
      configuredTargetZ: 0,
      robustNearBoundaryZ,
      crowdedBoundaryZ,
      currentScale: 1,
      targetDiameter: 0.95,
    });
    expect(automatic?.reason).toBe('all-behind');
    expect(automatic?.scale).toBeCloseTo(
      sourceOriginZ / 1.201229352,
      6
    );

    const click = getLookingGlassSourceDepthScaleRebase({
      sourceOriginZ,
      cameraCenterZ: sourceOriginZ,
      configuredTargetZ: 0,
      // Auto click safety first limits a farther selection to q20.
      robustNearBoundaryZ: crowdedBoundaryZ,
      crowdedBoundaryZ,
      currentScale: 1,
      targetDiameter: 0.95,
    });
    expect(click?.reason).toBe('all-behind');
    expect(
      sourceOriginZ +
        (crowdedBoundaryZ - sourceOriginZ) * (click?.scaleFactor ?? 1)
    ).toBeCloseTo(0, 6);
  });

  it('leaves an in-range scene unchanged', () => {
    expect(
      getLookingGlassSourceDepthScaleRebase({
        sourceOriginZ: 1,
        cameraCenterZ: 1,
        configuredTargetZ: 0,
        robustNearBoundaryZ: -0.2,
        crowdedBoundaryZ: -0.6,
        currentScale: 1,
        targetDiameter: 1,
      })
    ).toBeNull();
  });

  it('expands a persistently crowded close scene around the same apex', () => {
    const sourceOriginZ = 0.315;
    const crowdedBoundaryZ = 0.28;
    const rebase = getLookingGlassSourceDepthScaleRebase({
      sourceOriginZ,
      cameraCenterZ: sourceOriginZ,
      configuredTargetZ: 0,
      robustNearBoundaryZ: 0.27,
      crowdedBoundaryZ,
      currentScale: 0.16,
      targetDiameter: 0.9,
    });

    expect(rebase?.reason).toBe('crowded-front');
    expect(
      sourceOriginZ +
        (crowdedBoundaryZ - sourceOriginZ) * (rebase?.scaleFactor ?? 1)
    ).toBeCloseTo(0, 6);
  });

  it('bounds extreme source-depth scale requests and rejects invalid input', () => {
    const limited = getLookingGlassSourceDepthScaleRebase({
      sourceOriginZ: 0.315,
      cameraCenterZ: 0.315,
      configuredTargetZ: 0,
      robustNearBoundaryZ: 0.3,
      crowdedBoundaryZ: 0.314999,
      currentScale: 1,
      targetDiameter: 0.9,
    });
    expect(limited?.scale).toBe(20);
    expect(limited?.limited).toBe(true);

    expect(
      getLookingGlassSourceDepthScaleRebase({
        sourceOriginZ: Number.NaN,
        cameraCenterZ: 1,
        configuredTargetZ: 0,
        robustNearBoundaryZ: -2,
        crowdedBoundaryZ: -3,
        currentScale: 1,
        targetDiameter: 1,
      })
    ).toBeNull();
  });

  it('reproduces the vendor near plane and protects the measured 7-second close shot', () => {
    const fovY = (40 * Math.PI) / 180;
    const entryPivot = 2.1776;
    const targetDiameter =
      2 * entryPivot * Math.tan(fovY / 2);
    expect(
      getLookingGlassNearPlaneDistance(targetDiameter, fovY, 0.1)
    ).toBeCloseTo(0.6924, 3);
    expect(
      getLookingGlassNearPlaneDistance(targetDiameter, fovY, 0.01)
    ).toBeCloseTo(0.6024, 3);

    const rebase = getLookingGlassSourceNearClipRebase({
      robustNearDepth: 0.2928,
      currentScale: 1,
      targetDiameter,
      fovYRadians: fovY,
      depthNear: 0.01,
    });
    expect(rebase?.scale).toBeGreaterThan(2);
    expect(0.2928 * (rebase?.scale ?? 0)).toBeCloseTo(
      rebase?.requiredNearDepth ?? Number.NaN,
      6
    );
  });

  it('leaves an already renderable q1 unchanged and bounds extreme guards', () => {
    const fovY = (40 * Math.PI) / 180;
    expect(getLookingGlassSourceNearClipRebase({
      robustNearDepth: 0.7,
      currentScale: 1,
      targetDiameter: 1.5,
      fovYRadians: fovY,
      depthNear: 0.01,
    })).toBeNull();

    const limited = getLookingGlassSourceNearClipRebase({
      robustNearDepth: 0.00001,
      currentScale: 1,
      targetDiameter: 1.5,
      fovYRadians: fovY,
      depthNear: 0.01,
    });
    expect(limited?.scale).toBe(20);
    expect(limited?.limited).toBe(true);
    expect(
      getLookingGlassNearPlaneDistance(1, Number.NaN, 0.01)
    ).toBeNull();
  });
});
