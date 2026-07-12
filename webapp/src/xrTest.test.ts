import { describe, expect, it, vi } from 'vitest';
import { Matrix4, Vector3, Vector4 } from 'three';
import type { DepthFrame, ViewerControls } from './types';
import { AutoConvergenceController } from './render/frontSafety';
import {
  RawXRTest,
  clampLookingGlassConvergenceTarget,
  getLookingGlassConvergenceBaselineScale,
  getXRSessionDepthNear,
  releaseXRPresentationState,
  scaleModelAboutSourceApex,
  scaleXRViewBaseline,
  scaleXRProjectionForSourceFit,
  shouldInitializeDepthMesh,
  shouldUseLookingGlassFixedSourceProjection,
} from './xrTest';

interface FrontSafeModelTestApi {
  getFrontSafeModel(
    baseModel: Matrix4,
    depthFrame: DepthFrame,
    effective: {
      zScale: number;
      zBias: number;
      zGamma: number;
      planeScale: number;
    },
    zMaxClip: number,
    fixedSourceProjectionActive: boolean,
    activeTargetDiameter: number
  ): Matrix4;
  manualFocusLockActive: boolean;
  lastAutoConvergenceDepthTimestamp: number;
}

describe('shouldInitializeDepthMesh', () => {
  it('recovers when startup selected mesh before GPU resources existed', () => {
    expect(
      shouldInitializeDepthMesh({
        desiredMode: 'mesh',
        currentMode: 'mesh',
        hasMesh: false,
        hasDepth: true,
        hasVideo: true,
      })
    ).toBe(true);
  });

  it('upgrades a fallback mode when the first depth frame arrives', () => {
    expect(
      shouldInitializeDepthMesh({
        desiredMode: 'mesh',
        currentMode: 'quad',
        hasMesh: false,
        hasDepth: true,
        hasVideo: true,
      })
    ).toBe(true);
  });

  it('waits for both inputs and does not rebuild an existing mesh', () => {
    const base = {
      desiredMode: 'mesh' as const,
      currentMode: 'quad' as const,
      hasMesh: false,
      hasDepth: true,
      hasVideo: true,
    };

    expect(shouldInitializeDepthMesh({ ...base, hasDepth: false })).toBe(false);
    expect(shouldInitializeDepthMesh({ ...base, hasVideo: false })).toBe(false);
    expect(
      shouldInitializeDepthMesh({
        ...base,
        currentMode: 'mesh',
        hasMesh: true,
      })
    ).toBe(false);
  });
});

describe('XR render depth range', () => {
  it('reduces only the Looking Glass near margin', () => {
    expect(getXRSessionDepthNear({ mode: 'looking-glass' })).toBe(0.01);
    expect(getXRSessionDepthNear({ mode: 'webxr' })).toBeUndefined();
  });
});

describe('releaseXRPresentationState', () => {
  it('disables the per-view scissor before the polyfill fullscreen blit', () => {
    const disable = vi.fn();
    const gl = {
      disable,
      SCISSOR_TEST: 0x0c11,
    } as Pick<WebGL2RenderingContext, 'disable' | 'SCISSOR_TEST'>;

    releaseXRPresentationState(gl);

    expect(disable).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledWith(gl.SCISSOR_TEST);
  });
});

describe('Looking Glass source projection boundary', () => {
  it('does not leak fixed-source placement into other XR framing modes', () => {
    const profile = {
      mode: 'looking-glass' as const,
      preserveSourceProjection: true,
    };

    expect(shouldUseLookingGlassFixedSourceProjection(profile, {
      projectionMode: 'pinhole',
      framingMode: 'source',
    })).toBe(true);
    expect(shouldUseLookingGlassFixedSourceProjection(profile, {
      projectionMode: 'pinhole',
      framingMode: 'orbit',
    })).toBe(false);
    expect(shouldUseLookingGlassFixedSourceProjection(profile, {
      projectionMode: 'relief',
      framingMode: 'source',
    })).toBe(false);
    expect(shouldUseLookingGlassFixedSourceProjection({
      mode: 'webxr',
      preserveSourceProjection: true,
    }, {
      projectionMode: 'pinhole',
      framingMode: 'source',
    })).toBe(false);
  });

  it('keeps the source apex and every central projection ray fixed while scaling depth', () => {
    const cameraCenter = new Vector3(0, 0, 0.315);
    const model = new Matrix4().makeTranslation(
      cameraCenter.x,
      cameraCenter.y,
      cameraCenter.z
    );
    const sourcePoint = new Vector3(1, -0.5, -2);
    const before = sourcePoint.clone().applyMatrix4(model);
    const afterModel = scaleModelAboutSourceApex(model, 0.16);
    const after = sourcePoint.clone().applyMatrix4(afterModel);
    const afterApex = new Vector3().setFromMatrixPosition(afterModel);

    expect(afterApex.toArray()).toEqual(cameraCenter.toArray());
    expect(
      (before.x - cameraCenter.x) / (cameraCenter.z - before.z)
    ).toBeCloseTo(
      (after.x - cameraCenter.x) / (cameraCenter.z - after.z),
      12
    );
    expect(
      (before.y - cameraCenter.y) / (cameraCenter.z - before.z)
    ).toBeCloseTo(
      (after.y - cameraCenter.y) / (cameraCenter.z - after.z),
      12
    );
    expect(scaleModelAboutSourceApex(model, Number.NaN).elements)
      .toEqual(model.elements);
  });
});

describe('Looking Glass immediate foreground recovery', () => {
  function makeManualHoldRaw(
    previousFrontBoundaryZ: number
  ): {
    raw: RawXRTest;
    privateRaw: FrontSafeModelTestApi;
  } {
    const convergence = new AutoConvergenceController();
    const now = performance.now();
    const raw = Object.create(RawXRTest.prototype) as RawXRTest;
    Object.assign(raw, {
      frontSafetyProfile: {
        mode: 'looking-glass',
        targetZ: 0,
        targetDiameter: 1,
        preserveSourceProjection: true,
        autoConvergence: true,
      },
      autoConvergence: convergence,
      manualFocusLockActive: false,
      autoConvergenceFastUntilMs: 0,
      lastAutoConvergenceFrontBoundaryZ: previousFrontBoundaryZ,
      lastAutoConvergenceDepthTimestamp: -1,
      lookingGlassSourceDepthScale: 1,
      lastLookingGlassSourceDepthRebaseTimestamp: -1,
      lastFrontSafetySampleMs: 0,
      lastFrontSafetyFrameMs: now - 100,
    });
    raw.setManualLookingGlassConvergenceTarget(0.5, true);
    return {
      raw,
      privateRaw: raw as unknown as FrontSafeModelTestApi,
    };
  }

  function renderManualHoldFrame(
    privateRaw: ReturnType<typeof makeManualHoldRaw>['privateRaw'],
    timestampMs: number
  ): void {
    privateRaw.getFrontSafeModel(
      new Matrix4().makeTranslation(0, 0, 1),
      {
        timestampMs,
        width: 100,
        height: 1,
        data: new Float32Array(100).fill(1),
        scale: 1,
        bias: 0,
        zMax: 50,
      },
      { zScale: 1, zBias: 0, zGamma: 1, planeScale: 2 },
      50,
      true,
      1
    );
  }

  it('keeps a near click locked when unchanged depth only looks all-behind', () => {
    const { raw, privateRaw } = makeManualHoldRaw(0);

    renderManualHoldFrame(privateRaw, 11_000);

    expect(raw.getAutoConvergenceTargetZ()).toBeCloseTo(0.5, 12);
    expect(privateRaw.manualFocusLockActive).toBe(true);
  });

  it('resumes automatic convergence explicitly after a persistent lock', () => {
    const { raw, privateRaw } = makeManualHoldRaw(0);

    expect(raw.resumeLookingGlassAutoConvergence()).toBe(true);
    expect(privateRaw.manualFocusLockActive).toBe(false);
    expect(raw.resumeLookingGlassAutoConvergence()).toBe(false);
  });

  it('still releases a manual hold for a real depth-boundary cut', () => {
    const { raw, privateRaw } = makeManualHoldRaw(0.6);

    renderManualHoldFrame(privateRaw, 12_000);

    expect(raw.getAutoConvergenceTargetZ()).toBeLessThan(0.5);
    expect(privateRaw.manualFocusLockActive).toBe(false);
  });

  it('snaps q20 on the first new depth frame before the normal sample cadence', () => {
    const convergence = new AutoConvergenceController();
    convergence.reset(-0.5);
    const depth: DepthFrame = {
      timestampMs: 12_000,
      width: 100,
      height: 1,
      data: new Float32Array(100).fill(0.5),
      scale: 1,
      bias: 0,
      zMax: 50,
    };
    const raw = Object.create(RawXRTest.prototype) as RawXRTest;
    Object.assign(raw, {
      frontSafetyProfile: {
        mode: 'looking-glass',
        targetZ: 0,
        targetDiameter: 1,
        preserveSourceProjection: true,
        autoConvergence: true,
      },
      autoConvergence: convergence,
      manualFocusLockActive: true,
      autoConvergenceFastUntilMs: 0,
      lastAutoConvergenceFrontBoundaryZ: -0.5,
      lastAutoConvergenceDepthTimestamp: -1,
      lookingGlassSourceDepthScale: 1,
      lastLookingGlassSourceDepthRebaseTimestamp: -1,
      // A recent normal sample proves this correction does not rely on the
      // ordinary 250 ms gate becoming eligible.
      lastFrontSafetySampleMs: performance.now(),
      lastFrontSafetyFrameMs: performance.now(),
    });
    const privateRaw = raw as unknown as FrontSafeModelTestApi;

    privateRaw.getFrontSafeModel(
      new Matrix4().makeTranslation(0, 0, 1),
      depth,
      { zScale: 1, zBias: 0, zGamma: 1, planeScale: 2 },
      50,
      true,
      1
    );

    expect(raw.getAutoConvergenceTargetZ()).toBeCloseTo(0.5, 12);
    expect(privateRaw.lastAutoConvergenceDepthTimestamp).toBe(12_000);
    expect(privateRaw.manualFocusLockActive).toBe(false);
  });

  it('rebases the measured 7-second q1 behind the vendor near plane', () => {
    const entryPivot = 2.1776;
    const captureDiameter =
      2 * entryPivot * Math.tan((40 * Math.PI) / 360);
    const projectionScale = 0.25;
    const depth: DepthFrame = {
      timestampMs: 7_000,
      width: 100,
      height: 1,
      data: new Float32Array([
        0.2928,
        0.2928,
        ...new Array(98).fill(0.5344),
      ]),
      scale: 1,
      bias: 0,
      zMax: 50,
    };
    const raw = Object.create(RawXRTest.prototype) as RawXRTest;
    Object.assign(raw, {
      frontSafetyProfile: {
        mode: 'looking-glass',
        targetZ: 0,
        // Runtime comfort calculations divide out clip-space source fit. The
        // near guard must multiply it back to recover vendor targetDiam.
        targetDiameter: captureDiameter / projectionScale,
        projectionScale,
        preserveSourceProjection: true,
        // Hard raster safety remains active when automatic focus is disabled.
        autoConvergence: false,
      },
      autoConvergence: new AutoConvergenceController(),
      manualFocusLockActive: false,
      autoConvergenceFastUntilMs: 0,
      lastAutoConvergenceFrontBoundaryZ: null,
      lastAutoConvergenceDepthTimestamp: -1,
      lookingGlassSourceDepthScale: 1,
      lastLookingGlassSourceDepthRebaseTimestamp: -1,
      lastFrontSafetySampleMs: 0,
      lastFrontSafetyFrameMs: performance.now(),
    });
    const privateRaw = raw as unknown as {
      getFrontSafeModel(
        baseModel: Matrix4,
        depthFrame: DepthFrame,
        effective: {
          zScale: number;
          zBias: number;
          zGamma: number;
          planeScale: number;
        },
        zMaxClip: number,
        fixedSourceProjectionActive: boolean,
        activeTargetDiameter: number
      ): Matrix4;
    };

    const model = privateRaw.getFrontSafeModel(
      new Matrix4().makeTranslation(0, 0, entryPivot),
      depth,
      { zScale: 1, zBias: 0, zGamma: 1, planeScale: 2 },
      50,
      true,
      captureDiameter / projectionScale
    );
    const scale = raw.getLookingGlassSourceDepthScale();
    const nearDistance =
      entryPivot - captureDiameter + 0.01;

    expect(scale).toBeGreaterThan(2);
    expect(0.2928 * scale).toBeGreaterThan(nearDistance);
    expect(new Vector3().setFromMatrixPosition(model).z)
      .toBeCloseTo(entryPivot, 12);
  });
});

describe('scaleXRProjectionForSourceFit', () => {
  it('scales clip X/Y including off-axis terms without changing depth', () => {
    const projection = new Matrix4().set(
      2, 0, 0.5, 0,
      0, 3, 0.25, 0,
      0, 0, -1, -0.2,
      0, 0, -1, 0
    );

    const scaled = scaleXRProjectionForSourceFit(projection, 0.25);

    expect(scaled.elements[0]).toBeCloseTo(projection.elements[0] * 0.25);
    expect(scaled.elements[5]).toBeCloseTo(projection.elements[5] * 0.25);
    expect(scaled.elements[8]).toBeCloseTo(projection.elements[8] * 0.25);
    expect(scaled.elements[9]).toBeCloseTo(projection.elements[9] * 0.25);
    expect(scaled.elements[10]).toBe(projection.elements[10]);
    expect(scaled.elements[14]).toBe(projection.elements[14]);
    expect(scaled).not.toBe(projection);
  });

  it('uses the unscaled projection for invalid input', () => {
    const projection = new Matrix4().makePerspective(-1, 1, 1, -1, 0.1, 10);

    expect(
      scaleXRProjectionForSourceFit(projection, Number.NaN).elements
    ).toEqual(projection.elements);
  });

  it('zooms in through projection scale without moving depth terms', () => {
    const projection = new Matrix4().set(
      2, 0, 0.5, 0,
      0, 3, 0.25, 0,
      0, 0, -1, -0.2,
      0, 0, -1, 0
    );

    const scaled = scaleXRProjectionForSourceFit(projection, 2);

    expect(scaled.elements[0]).toBeCloseTo(projection.elements[0] * 2);
    expect(scaled.elements[5]).toBeCloseTo(projection.elements[5] * 2);
    expect(scaled.elements[10]).toBe(projection.elements[10]);
    expect(scaled.elements[14]).toBe(projection.elements[14]);
  });

  it('pans in clip space without changing perspective depth', () => {
    const projection = new Matrix4().makePerspective(
      -1,
      1,
      1,
      -1,
      0.1,
      10
    );
    const point = new Vector4(0.2, -0.1, -2, 1);
    const before = point.clone().applyMatrix4(projection);
    const after = point
      .clone()
      .applyMatrix4(
        scaleXRProjectionForSourceFit(projection, 1, 0.25, -0.5)
      );

    expect(after.x / after.w - before.x / before.w).toBeCloseTo(0.25, 12);
    expect(after.y / after.w - before.y / before.w).toBeCloseTo(-0.5, 12);
    expect(after.z).toBeCloseTo(before.z, 12);
    expect(after.w).toBeCloseTo(before.w, 12);
  });
});

describe('Looking Glass convergence baseline', () => {
  it('clamps distant clicks to both reachable and foreground-safe targets', () => {
    const foregroundSafe = clampLookingGlassConvergenceTarget(
      4,
      0,
      -100,
      -1
    );
    expect(foregroundSafe).toEqual({
      targetZ: -1,
      limited: true,
      baselineLimited: true,
      foregroundLimited: true,
    });

    const occupancyOnly = clampLookingGlassConvergenceTarget(
      4,
      0,
      -3,
      -1
    );
    expect(occupancyOnly.targetZ).toBe(-1);
    expect(occupancyOnly.baselineLimited).toBe(false);
    expect(occupancyOnly.foregroundLimited).toBe(true);

    const manualOnly = clampLookingGlassConvergenceTarget(4, 0, -100);
    expect(manualOnly.targetZ).toBe(-4);
    expect(manualOnly.baselineLimited).toBe(true);
    expect(manualOnly.foregroundLimited).toBe(false);

    expect(clampLookingGlassConvergenceTarget(4, 0, -2).limited).toBe(false);
    expect(clampLookingGlassConvergenceTarget(4, 0, 100).targetZ).toBe(3);
  });

  it('moves zero parallax without moving the center camera', () => {
    expect(getLookingGlassConvergenceBaselineScale(4, 0, 2)).toBe(0.5);
    expect(getLookingGlassConvergenceBaselineScale(4, 0, -4)).toBe(2);
    expect(
      getLookingGlassConvergenceBaselineScale(4, 4, 2)
    ).toBe(1);

    const center = new Matrix4().makeTranslation(0, 0, 4);
    const view = new Matrix4().makeTranslation(1, 0, 4);
    const adjusted = scaleXRViewBaseline(view, center, 0.5);
    const position = new Vector3().setFromMatrixPosition(adjusted);
    const centerPosition = new Vector3().setFromMatrixPosition(
      scaleXRViewBaseline(center, center, 0.5)
    );

    expect(position.toArray()).toEqual([0.5, 0, 4]);
    expect(centerPosition.toArray()).toEqual([0, 0, 4]);
  });

  it('rebases an Auto-enabled unreachable click while keeping its apex fixed', () => {
    const sourceOriginZ = 0.314879477;
    const clickedDepth = 1.652332366;
    const frame: DepthFrame = {
      timestampMs: 46_000,
      width: 100,
      height: 1,
      data: new Float32Array(100).fill(clickedDepth),
      scale: 1,
      bias: 0,
      zMax: 50,
    };
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
    const context = {
      cameraMatrixWorld: new Matrix4().makeTranslation(0, 0, sourceOriginZ),
      projectionMatrix: new Matrix4(),
      modelMatrix: new Matrix4().makeTranslation(0, 0, sourceOriginZ),
      frame,
      controls,
      calibration: null,
    };
    const raw = Object.create(RawXRTest.prototype) as RawXRTest;
    Object.assign(raw, {
      frontSafetyProfile: {
        mode: 'looking-glass',
        targetZ: 0,
        targetDiameter: 0.95,
        preserveSourceProjection: true,
        autoConvergence: true,
      },
      latestLookingGlassPickContext: context,
      lookingGlassSourceDepthScale: 1,
      autoConvergence: new AutoConvergenceController(),
      manualFocusLockActive: false,
      autoConvergenceFastUntilMs: 0,
      lastAutoConvergenceFrontBoundaryZ: null,
      lastAutoConvergenceDepthTimestamp: -1,
      lastLookingGlassSourceDepthRebaseTimestamp: -1,
      lastFrontSafetySampleMs: 0,
    });

    const result = raw.prepareLookingGlassConvergenceTarget(
      sourceOriginZ - clickedDepth,
      true
    );
    const rebasedPoint = new Vector3(0, 0, -clickedDepth)
      .applyMatrix4(context.modelMatrix);

    expect(result.sourceRebased).toBe(true);
    expect(result.targetZ).toBe(0);
    expect(result.baselineLimited).toBe(false);
    expect(raw.getLookingGlassSourceDepthScale()).toBeCloseTo(
      sourceOriginZ / clickedDepth,
      6
    );
    expect(new Vector3().setFromMatrixPosition(context.modelMatrix).z)
      .toBeCloseTo(sourceOriginZ, 12);
    expect(rebasedPoint.z).toBeCloseTo(0, 6);
  });
});
