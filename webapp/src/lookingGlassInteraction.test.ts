import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  getLookingGlassWheelZoom,
  isLookingGlassPickTriangleContinuous,
  pickLookingGlassDepthMesh,
  sampleRawXRDepth,
} from './lookingGlassInteraction';
import type { DepthFrame, ViewerControls } from './types';

const controls: ViewerControls = {
  projectionMode: 'pinhole',
  framingMode: 'source',
  targetTriangles: 300_000,
  fovY: 60,
  sourceFovY: 60,
  zScale: 1,
  zBias: 0,
  zGamma: 1,
  zMaxClip: 5,
  planeScale: 1,
  yOffset: 0,
};

describe('getLookingGlassWheelZoom', () => {
  it('maps wheel up to zoom in and wheel down to zoom out', () => {
    expect(getLookingGlassWheelZoom(1, -100, 0)).toBe(1.162);
    expect(getLookingGlassWheelZoom(1, 100, 0)).toBe(0.861);
  });

  it('normalizes line/page deltas and clamps the physical range', () => {
    expect(getLookingGlassWheelZoom(1, -3, 1)).toBe(1.075);
    expect(getLookingGlassWheelZoom(1, -1, 2, 800)).toBe(3.32);
    expect(getLookingGlassWheelZoom(4, -1000, 0)).toBe(4);
    expect(getLookingGlassWheelZoom(0.25, 1000, 0)).toBe(0.25);
  });

  it('returns symmetrically and snaps when crossing the default zoom', () => {
    const zoomedIn = getLookingGlassWheelZoom(1, -100, 0);
    expect(getLookingGlassWheelZoom(zoomedIn, 100, 0)).toBe(1);
    expect(getLookingGlassWheelZoom(1.02, 100, 0)).toBe(1);
    expect(getLookingGlassWheelZoom(0.98, -100, 0)).toBe(1);
  });
});

describe('Looking Glass depth picking', () => {
  it('samples typed depth rows in the same top-to-bottom order as RawXR', () => {
    const frame: DepthFrame = {
      timestampMs: 0,
      width: 2,
      height: 3,
      data: new Float32Array([
        1, 2,
        3, 4,
        5, 6,
      ]),
      scale: 1,
      bias: 0,
      zMax: 6,
    };

    expect(sampleRawXRDepth(frame, 0, 0)).toBe(1);
    expect(sampleRawXRDepth(frame, 1, 0)).toBe(2);
    expect(sampleRawXRDepth(frame, 0, 1)).toBe(5);
    expect(sampleRawXRDepth(frame, 1, 1)).toBe(6);
  });

  it('picks a synthetic flat depth mesh at the zero-parallax world plane', () => {
    const frame: DepthFrame = {
      timestampMs: 0,
      width: 4,
      height: 4,
      data: new Float32Array(16).fill(1),
      scale: 1,
      bias: 0,
      zMax: 5,
    };
    const cameraMatrixWorld = new THREE.Matrix4().makeTranslation(0, 0, 1);
    const projectionMatrix = new THREE.Matrix4().makePerspective(
      -0.1,
      0.1,
      0.1,
      -0.1,
      0.1,
      10
    );
    const modelMatrix = new THREE.Matrix4().makeTranslation(0, 0, 1);

    const pick = pickLookingGlassDepthMesh({
      normalizedX: 0.5,
      normalizedY: 0.5,
      cameraMatrixWorld,
      projectionMatrix,
      modelMatrix,
      frame,
      controls,
      calibration: null,
    });

    expect(pick).not.toBeNull();
    expect(pick?.point.x).toBeCloseTo(0, 5);
    expect(pick?.point.y).toBeCloseTo(0, 5);
    expect(pick?.point.z).toBeCloseTo(0, 5);
    expect(pick?.distance).toBeCloseTo(1, 5);
  });

  it('rejects artificial curtain triangles at large depth jumps', () => {
    expect(isLookingGlassPickTriangleContinuous(1, 1.05, 1.1)).toBe(true);
    expect(isLookingGlassPickTriangleContinuous(1, 1.05, 2)).toBe(false);
  });
});
