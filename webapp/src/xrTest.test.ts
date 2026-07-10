import { describe, expect, it } from 'vitest';
import { shouldInitializeDepthMesh } from './xrTest';

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
