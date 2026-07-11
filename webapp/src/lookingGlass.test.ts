import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOOKING_GLASS_CONFIG,
  DEFAULT_LOOKING_GLASS_FOV_Y,
  LOOKING_GLASS_RUNTIME_FOCUS_RANGE,
  LOOKING_GLASS_PRESENTATION_SCALE_RANGE,
  LOOKING_GLASS_SOURCE_FIT_SCALE_RANGE,
  LookingGlassRuntime,
  clampLookingGlassViewControls,
  describeLookingGlassFailure,
  getLookingGlassCameraZ,
  getLookingGlassFocusCompensation,
  getLookingGlassEntryPivotEstimate,
  getLookingGlassPresentationScale,
  getLookingGlassSourceFit,
  getLookingGlassTargetZ,
  getLookingGlassTargetDiameterForPivot,
  toLookingGlassViewConfig,
  waitForLookingGlassBridge,
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

  it('updates focus and zoom without reinstalling the polyfill', async () => {
    const update = vi.fn();
    const constructor = vi.fn(function FakePolyfill() {
      return { update };
    });
    const runtime = new LookingGlassRuntime(async () => ({
      LookingGlassConfig: {},
      LookingGlassWebXRPolyfill: constructor,
    }));

    await runtime.activate();
    runtime.updateView({ targetZ: 1.5, targetDiam: 1.5 });

    expect(constructor).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ targetZ: 1.5, targetDiam: 1.5 });
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

  it('re-emits configuration after the XR layer installs its listeners', async () => {
    const update = vi.fn();
    const runtime = new LookingGlassRuntime(async () => ({
      LookingGlassConfig: {},
      LookingGlassWebXRPolyfill: class {
        update = update;
      },
    }));

    await runtime.activate();
    runtime.refreshAfterLayerCreation();

    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({});
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

  it('reads the connected display aspect from Bridge calibration', async () => {
    const runtime = new LookingGlassRuntime(async () => ({
      LookingGlassConfig: {
        calibration: {
          serial: 'LKG-GO-test',
          screenW: { value: 1440 },
          screenH: { value: 2560 },
        },
      },
      LookingGlassWebXRPolyfill: class {
        update(): void {}
      },
    }));

    await runtime.activate();

    expect(runtime.displayAspect).toBe(0.5625);
    await expect(runtime.waitForDisplayCalibration(0)).resolves.toBe(0.5625);
  });

  it('binds wheel and click input to the presentation canvas and detaches it', async () => {
    const canvas = new EventTarget() as EventTarget & {
      getBoundingClientRect: () => DOMRect;
      setPointerCapture: ReturnType<typeof vi.fn>;
      releasePointerCapture: ReturnType<typeof vi.fn>;
    };
    canvas.getBoundingClientRect = () => ({
      left: 10,
      top: 20,
      width: 200,
      height: 100,
      right: 210,
      bottom: 120,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    });
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    const appCanvas = new EventTarget();
    const runtime = new LookingGlassRuntime(async () => ({
      LookingGlassConfig: {
        lkgCanvas: canvas as unknown as HTMLCanvasElement,
        appCanvas: appCanvas as unknown as HTMLCanvasElement,
      },
      LookingGlassWebXRPolyfill: class {
        update(): void {}
      },
    }));
    const onWheel = vi.fn();
    const onFocusRequest = vi.fn();
    const onPan = vi.fn();
    const event = (type: string, properties: Record<string, number>): Event => {
      const value = new Event(type, { cancelable: true });
      for (const [key, property] of Object.entries(properties)) {
        Object.defineProperty(value, key, { value: property });
      }
      return value;
    };

    await runtime.activate();
    const cleanup = runtime.bindPresentationInput({
      onWheel,
      onFocusRequest,
      onPan,
    });
    const wheel = event('wheel', { deltaY: -100, deltaMode: 0 });
    canvas.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(onWheel).toHaveBeenCalledWith({
      deltaY: -100,
      deltaMode: 0,
      pageHeightPx: 100,
    });

    canvas.dispatchEvent(event('pointerdown', {
      button: 0,
      pointerId: 7,
      clientX: 110,
      clientY: 70,
    }));
    canvas.dispatchEvent(event('pointerup', {
      button: 0,
      pointerId: 7,
      clientX: 110,
      clientY: 70,
    }));
    expect(onFocusRequest).toHaveBeenCalledWith({
      normalizedX: 0.5,
      normalizedY: 0.5,
    });

    canvas.dispatchEvent(event('pointerdown', {
      button: 0,
      pointerId: 8,
      clientX: 110,
      clientY: 70,
    }));
    canvas.dispatchEvent(event('pointermove', {
      button: 0,
      pointerId: 8,
      clientX: 120,
      clientY: 70,
    }));
    canvas.dispatchEvent(event('pointerup', {
      button: 0,
      pointerId: 8,
      clientX: 120,
      clientY: 70,
    }));
    expect(onFocusRequest).toHaveBeenCalledOnce();
    expect(onPan).toHaveBeenCalledWith({
      deltaX: 0.1,
      deltaY: -0,
    });

    const appWheel = event('wheel', { deltaY: -100, deltaMode: 0 });
    appCanvas.dispatchEvent(appWheel);
    expect(appWheel.defaultPrevented).toBe(true);
    expect(onWheel).toHaveBeenCalledOnce();

    cleanup();
    canvas.dispatchEvent(event('wheel', { deltaY: 100, deltaMode: 0 }));
    expect(onWheel).toHaveBeenCalledOnce();
  });
});

describe('toLookingGlassViewConfig', () => {
  it('uses a robust median entry pivot without waiting for slow monitor refreshes', () => {
    expect(
      getLookingGlassEntryPivotEstimate([0.5, 3, 3.1, 100], 3.5)
    ).toEqual({ pivotDepth: 3.05, sampleCount: 4 });
    expect(getLookingGlassEntryPivotEstimate([], 2.75)).toEqual({
      pivotDepth: 2.75,
      sampleCount: 0,
    });
  });

  it('keeps the polyfill camera diameter independent from projection zoom', () => {
    expect(toLookingGlassViewConfig({
      zoom: 2,
      autoConvergence: true,
      panX: 0,
      panY: 0,
      focusBaseZ: -3,
      focusTrimZ: 1.25,
    })).toEqual({
      targetZ: -1.75,
      targetDiam: 3,
    });
  });

  it('clamps unsafe values and restores defaults for non-finite input', () => {
    expect(toLookingGlassViewConfig({
      zoom: 100,
      autoConvergence: true,
      panX: 0,
      panY: 0,
      focusBaseZ: -1000,
      focusTrimZ: -1000,
    })).toEqual({
      targetZ: LOOKING_GLASS_RUNTIME_FOCUS_RANGE.min,
      targetDiam: 3,
    });
    expect(toLookingGlassViewConfig({
      zoom: Number.NaN,
      autoConvergence: true,
      panX: Number.NaN,
      panY: Number.NaN,
      focusBaseZ: Infinity,
      focusTrimZ: Number.NaN,
    })).toEqual({
      targetZ: 0,
      targetDiam: 3,
    });
  });

  it('keeps an absolute click base separate from the fixed manual trim', () => {
    const controls = clampLookingGlassViewControls({
      zoom: 1,
      autoConvergence: true,
      panX: 0.25,
      panY: -0.5,
      focusBaseZ: 4.25,
      focusTrimZ: 0.5,
    });
    expect(controls).toEqual({
      zoom: 1,
      autoConvergence: true,
      panX: 0.25,
      panY: -0.5,
      focusBaseZ: 4.25,
      focusTrimZ: 0.5,
    });
    expect(getLookingGlassTargetZ(controls)).toBe(4.75);
    expect(toLookingGlassViewConfig(controls)).toEqual({
      targetZ: 4.75,
      targetDiam: 3,
    });

    const trimmed = clampLookingGlassViewControls({
      zoom: 1,
      autoConvergence: false,
      panX: 100,
      panY: -100,
      focusBaseZ: 4.25,
      focusTrimZ: 100,
    });
    expect(trimmed.focusTrimZ).toBe(2);
    expect(getLookingGlassTargetZ(trimmed)).toBe(6.25);
    expect(getLookingGlassTargetZ({
      zoom: 1,
      autoConvergence: true,
      panX: 0,
      panY: 0,
      focusBaseZ: 99,
      focusTrimZ: 2,
    })).toBe(LOOKING_GLASS_RUNTIME_FOCUS_RANGE.max);
  });

  it('keeps an automatically fitted source pivot while zoom changes', () => {
    expect(
      toLookingGlassViewConfig({
        zoom: 2,
        autoConvergence: true,
        panX: 0,
        panY: 0,
        focusBaseZ: 0,
        focusTrimZ: 0,
      }, 1.2)
    ).toEqual({
      targetZ: 0,
      targetDiam: 1.2,
    });
  });

  it('keeps the central camera fixed while moving focus to a distant point', () => {
    const previousTargetZ = 0;
    const previousTargetDiameter = 3;
    const previousCameraZ = getLookingGlassCameraZ(
      previousTargetZ,
      previousTargetDiameter
    );
    const compensated = getLookingGlassFocusCompensation(
      previousTargetZ,
      previousTargetDiameter,
      -3
    );

    expect(compensated.limited).toBe(false);
    expect(compensated.targetDiameter).toBeGreaterThan(
      previousTargetDiameter
    );
    expect(
      getLookingGlassCameraZ(-3, compensated.targetDiameter)
    ).toBeCloseTo(previousCameraZ, 12);
  });

  it('keeps focus compensation independent from the user zoom value', () => {
    const zoom = 2;
    const previousTargetZ = 0;
    const previousTargetDiameter = 1.5;
    const previousCameraZ = getLookingGlassCameraZ(
      previousTargetZ,
      previousTargetDiameter
    );
    const compensated = getLookingGlassFocusCompensation(
      previousTargetZ,
      previousTargetDiameter,
      -2
    );
    const config = toLookingGlassViewConfig(
      {
        zoom,
        autoConvergence: true,
        panX: 0,
        panY: 0,
        focusBaseZ: -2,
        focusTrimZ: 0,
      },
      compensated.targetDiameter
    );

    expect(config.targetDiam).toBeCloseTo(compensated.targetDiameter, 12);
    expect(
      getLookingGlassCameraZ(config.targetZ ?? 0, config.targetDiam ?? 0)
    ).toBeCloseTo(previousCameraZ, 12);
    expect(zoom).toBe(2);
  });

  it('reports when physical diameter limits prevent exact focus compensation', () => {
    const compensated = getLookingGlassFocusCompensation(0, 3, 100);

    expect(compensated.limited).toBe(true);
    expect(compensated.targetDiameter).toBe(0.05);
    expect(
      getLookingGlassCameraZ(100, compensated.targetDiameter)
    ).not.toBeCloseTo(compensated.cameraZ, 3);
  });

  it('uses the vendor default FOV when compensation receives a non-finite FOV', () => {
    const fallback = getLookingGlassFocusCompensation(0, 3, -1, Number.NaN);
    const explicit = getLookingGlassFocusCompensation(
      0,
      3,
      -1,
      DEFAULT_LOOKING_GLASS_FOV_Y
    );

    expect(fallback).toEqual(explicit);
  });

  it('fits a wide source into a portrait Looking Glass Go calibration', () => {
    const sourceFovY = (50 * Math.PI) / 180;
    const sourceAspect = 16 / 9;
    const projection = {
      focalNormX: 1 / (2 * sourceAspect * Math.tan(sourceFovY / 2)),
      focalNormY: 1 / (2 * Math.tan(sourceFovY / 2)),
      principalUvX: 0.5,
      principalUvY: 0.5,
      depthMetricScale: 1,
      displayAspect: sourceAspect,
    };

    const fit = getLookingGlassSourceFit(projection, 1440 / 2560);

    expect(fit.limited).toBe(false);
    expect(fit.projectionScale).toBeGreaterThan(0.2);
    expect(fit.projectionScale).toBeLessThan(0.3);
    expect(fit.verticalFovDegrees).toBeGreaterThan(111);
    expect(fit.verticalFovDegrees).toBeLessThan(115);
    expect(fit.horizontalFovDegrees).toBeGreaterThan(79);
  });

  it('uses a modest source-fit FOV on a landscape display', () => {
    const sourceFovY = (50 * Math.PI) / 180;
    const sourceAspect = 16 / 9;
    const projection = {
      focalNormX: 1 / (2 * sourceAspect * Math.tan(sourceFovY / 2)),
      focalNormY: 1 / (2 * Math.tan(sourceFovY / 2)),
      principalUvX: 0.5,
      principalUvY: 0.5,
      depthMetricScale: 1,
      displayAspect: sourceAspect,
    };

    const fit = getLookingGlassSourceFit(projection, 16 / 9);

    expect(fit.limited).toBe(false);
    expect(fit.projectionScale).toBeGreaterThan(0.7);
    expect(fit.projectionScale).toBeLessThan(0.8);
    expect(fit.verticalFovDegrees).toBeGreaterThan(50);
    expect(fit.verticalFovDegrees).toBeLessThan(53);
  });

  it('reports when a source needs more than the vendor FOV limit', () => {
    const projection = {
      focalNormX: 0.25,
      focalNormY: 0.5,
      principalUvX: 0.5,
      principalUvY: 0.5,
      depthMetricScale: 1,
      displayAspect: 2,
    };

    const fit = getLookingGlassSourceFit(projection, 0.5);

    expect(fit.limited).toBe(true);
    expect(fit.projectionScale).toBe(
      LOOKING_GLASS_SOURCE_FIT_SCALE_RANGE.min
    );
  });

  it('combines source fit and reversible projection zoom without camera dolly', () => {
    expect(getLookingGlassPresentationScale(0.24, 1)).toBeCloseTo(0.24);
    expect(getLookingGlassPresentationScale(0.24, 4)).toBeCloseTo(0.96);
    expect(getLookingGlassPresentationScale(0.24, 0.25)).toBeCloseTo(0.06);
    expect(getLookingGlassPresentationScale(1, 99)).toBe(
      LOOKING_GLASS_PRESENTATION_SCALE_RANGE.max
    );
    expect(getLookingGlassPresentationScale(Number.NaN, Number.NaN)).toBe(1);
  });
});

describe('waitForLookingGlassBridge', () => {
  it('confirms and closes the official Bridge socket before library import', async () => {
    const listeners = new Map<string, EventListener>();
    const close = vi.fn();
    const createSocket = vi.fn(() => ({
      addEventListener: vi.fn(
        (type: string, listener: EventListenerOrEventListenerObject) => {
          if (typeof listener === 'function') listeners.set(type, listener);
        }
      ),
      close,
    }));

    const pending = waitForLookingGlassBridge(100, createSocket);
    listeners.get('open')?.(new Event('open'));

    await expect(pending).resolves.toBeUndefined();
    expect(createSocket).toHaveBeenCalledWith(
      'ws://localhost:11222/driver',
      ['rep.sp.nanomsg.org']
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails without importing the one-shot runtime when Bridge is absent', async () => {
    const listeners = new Map<string, EventListener>();
    const createSocket = vi.fn(() => ({
      addEventListener: vi.fn(
        (type: string, listener: EventListenerOrEventListenerObject) => {
          if (typeof listener === 'function') listeners.set(type, listener);
        }
      ),
      close: vi.fn(),
    }));

    const pending = waitForLookingGlassBridge(100, createSocket);
    listeners.get('error')?.(new Event('error'));

    await expect(pending).rejects.toThrow(
      'Looking Glass Bridge is not reachable'
    );
  });
});

describe('getLookingGlassTargetDiameterForPivot', () => {
  it('places the polyfill camera at the representative source depth', () => {
    const pivot = 1.4;
    const fovY = (40 * Math.PI) / 180;
    const diameter = getLookingGlassTargetDiameterForPivot(pivot, fovY);
    const cameraDistance = diameter / (2 * Math.tan(fovY / 2));

    expect(cameraDistance).toBeCloseTo(pivot, 10);
  });

  it('falls back safely when no representative depth is available', () => {
    expect(getLookingGlassTargetDiameterForPivot(Number.NaN)).toBe(3);
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
