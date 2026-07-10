import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOOKING_GLASS_CONFIG,
  LookingGlassRuntime,
  describeLookingGlassFailure,
} from './lookingGlass';

describe('LookingGlassRuntime', () => {
  it('preloads once, installs once, and updates an existing polyfill', async () => {
    const globalConfig: Record<string, number> = {};
    const update = vi.fn();
    const constructor = vi.fn(function FakePolyfill() {
      return { update };
    });
    const importer = vi.fn(async () => ({
      LookingGlassConfig: globalConfig,
      LookingGlassWebXRPolyfill: constructor,
    }));
    const runtime = new LookingGlassRuntime(importer);

    await Promise.all([runtime.preload(), runtime.preload()]);
    await runtime.activate();
    await runtime.activate({ targetDiam: 4 });

    expect(importer).toHaveBeenCalledTimes(1);
    expect(constructor).toHaveBeenCalledTimes(1);
    expect(constructor).toHaveBeenCalledWith(DEFAULT_LOOKING_GLASS_CONFIG);
    expect(update).toHaveBeenCalledWith({ targetDiam: 4 });
    expect(globalConfig.targetDiam).toBe(4);
    expect(runtime.isInstalled).toBe(true);
  });

  it('allows a retry after a transient preload failure', async () => {
    const importer = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce({
        LookingGlassConfig: {},
        LookingGlassWebXRPolyfill: class {
          update(): void {}
        },
      });
    const runtime = new LookingGlassRuntime(importer);

    await expect(runtime.preload()).rejects.toThrow('chunk unavailable');
    await expect(runtime.activate()).resolves.toBeUndefined();
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('reports whether Bridge supplied device calibration', async () => {
    const globalConfig: { calibration?: { serial?: string } } = {
      calibration: { serial: '' },
    };
    const runtime = new LookingGlassRuntime(async () => ({
      LookingGlassConfig: globalConfig,
      LookingGlassWebXRPolyfill: class {
        update(): void {}
      },
    }));

    await runtime.activate();
    expect(await runtime.waitForPresentation(0)).toEqual({
      displayDetected: false,
      popupOpen: false,
    });
    globalConfig.calibration = { serial: 'LKG-P-test' };
    expect(await runtime.waitForPresentation(0)).toEqual({
      displayDetected: true,
      popupOpen: false,
    });
  });
});

describe('describeLookingGlassFailure', () => {
  it('turns missing XR support into an actionable Bridge message', () => {
    expect(
      describeLookingGlassFailure(new Error('immersive-vr not supported'))
    ).toEqual({
      status: 'unavailable',
      label: 'Unavailable',
      detail: 'Start Looking Glass Bridge, connect the display, and try again.',
    });
  });

  it('identifies popup or user-activation failures', () => {
    const failure = describeLookingGlassFailure(
      new DOMException('Request blocked without a user gesture', 'SecurityError')
    );
    expect(failure.status).toBe('failed');
    expect(failure.label).toBe('Blocked');
  });
});
