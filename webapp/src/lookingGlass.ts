import type {
  LookingGlassGlobalConfig,
  LookingGlassPolyfillInstance,
  LookingGlassViewConfig,
} from '@lookingglass/webxr';
import type { ProjectionCalibration } from './render/projection';
import { getSourceViewFitFovY } from './render/sourceView';

interface LookingGlassModule {
  LookingGlassWebXRPolyfill: new (
    config?: LookingGlassViewConfig
  ) => LookingGlassPolyfillInstance;
  LookingGlassConfig: LookingGlassGlobalConfig;
}

type LookingGlassImporter = () => Promise<LookingGlassModule>;

export type LookingGlassStatus =
  | 'monitor'
  | 'starting'
  | 'active'
  | 'unavailable'
  | 'failed';

export interface LookingGlassFailure {
  status: Extract<LookingGlassStatus, 'unavailable' | 'failed'>;
  label: string;
  detail: string;
}

export interface LookingGlassPresentationStatus {
  displayDetected: boolean;
  popupOpen: boolean;
}

export interface LookingGlassViewControls {
  zoom: number;
  /** Automatically keep a robust depth boundary near zero parallax. */
  autoConvergence: boolean;
  /** Projection-only horizontal pan in normalized clip coordinates. */
  panX: number;
  /** Projection-only vertical pan in normalized clip coordinates. */
  panY: number;
  /** Absolute world Z selected by a stable depth click. */
  focusBaseZ: number;
  /** Small user adjustment relative to the click-selected base. */
  focusTrimZ: number;
}

export interface LookingGlassPresentationInputHandlers {
  onWheel: (input: {
    deltaY: number;
    deltaMode: number;
    pageHeightPx: number;
  }) => void;
  onFocusRequest: (input: {
    normalizedX: number;
    normalizedY: number;
  }) => void;
  onPan: (input: { deltaX: number; deltaY: number }) => void;
}

export const LOOKING_GLASS_VIEW_RANGES = {
  zoom: { min: 0.25, max: 4, step: 0.05 },
  pan: { min: -2, max: 2 },
  // Keep manual sensitivity stable even when a click selects a large absolute
  // world Z. The absolute base is intentionally not edited with a slider.
  focusTrimZ: { min: -2, max: 2, step: 0.05 },
} as const;

export const LOOKING_GLASS_RUNTIME_FOCUS_RANGE = {
  min: -100,
  max: 100,
} as const;

export const LOOKING_GLASS_TARGET_DIAMETER_RANGE = {
  min: 0.05,
  max: 50,
} as const;

export const DEFAULT_LOOKING_GLASS_TARGET_DIAMETER = 3;
export const DEFAULT_LOOKING_GLASS_FOV_Y = (40 * Math.PI) / 180;
export const LOOKING_GLASS_FOV_Y_RANGE = {
  min: Math.PI / 180,
  max: (120 * Math.PI) / 180,
} as const;
export const LOOKING_GLASS_SOURCE_FIT_MARGIN = 1.03;
export const LOOKING_GLASS_SOURCE_FIT_SCALE_RANGE = {
  min: 0.1,
  max: 1,
} as const;
export const LOOKING_GLASS_PRESENTATION_SCALE_RANGE = {
  min:
    LOOKING_GLASS_SOURCE_FIT_SCALE_RANGE.min *
    LOOKING_GLASS_VIEW_RANGES.zoom.min,
  max:
    LOOKING_GLASS_SOURCE_FIT_SCALE_RANGE.max *
    LOOKING_GLASS_VIEW_RANGES.zoom.max,
} as const;
const LOOKING_GLASS_BRIDGE_URL = 'ws://localhost:11222/driver';
const LOOKING_GLASS_BRIDGE_PROTOCOL = 'rep.sp.nanomsg.org';
const LOOKING_GLASS_BRIDGE_UNAVAILABLE =
  'Looking Glass Bridge is not reachable. Start Bridge, then try again.';

type LookingGlassBridgeSocket = Pick<
  WebSocket,
  'addEventListener' | 'close'
>;

export type LookingGlassBridgeSocketFactory = (
  url: string,
  protocols: string[]
) => LookingGlassBridgeSocket;

const createLookingGlassBridgeSocket: LookingGlassBridgeSocketFactory = (
  url,
  protocols
) => new WebSocket(url, protocols);

/**
 * Check Bridge before importing @lookingglass/webxr.
 *
 * Version 0.6.0 creates its calibration client at module evaluation and does
 * not reconnect after an initial socket failure. Importing while Bridge is
 * stopped therefore poisons that page until reload. A cheap socket handshake
 * keeps the one-shot library initialization behind a confirmed local Bridge.
 */
export function waitForLookingGlassBridge(
  timeoutMs = 1200,
  createSocket: LookingGlassBridgeSocketFactory =
    createLookingGlassBridgeSocket
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let socket: LookingGlassBridgeSocket | null = null;
    let settled = false;
    const fail = (): Error => new Error(LOOKING_GLASS_BRIDGE_UNAVAILABLE);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutId);
      try {
        socket?.close();
      } catch {
        // A socket which failed while opening may not be closable.
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const timeoutId = globalThis.setTimeout(
      () => finish(fail()),
      Math.max(timeoutMs, 0)
    );

    try {
      socket = createSocket(LOOKING_GLASS_BRIDGE_URL, [
        LOOKING_GLASS_BRIDGE_PROTOCOL,
      ]);
      socket.addEventListener('open', () => finish(), { once: true });
      socket.addEventListener('error', () => finish(fail()), { once: true });
      socket.addEventListener('close', () => finish(fail()), { once: true });
    } catch {
      finish(fail());
    }
  });
}

export function getLookingGlassTargetDiameterForPivot(
  pivotDepth: number,
  fovY = DEFAULT_LOOKING_GLASS_FOV_Y
): number {
  if (!Number.isFinite(pivotDepth) || pivotDepth <= 0) {
    return DEFAULT_LOOKING_GLASS_TARGET_DIAMETER;
  }
  const safePivot = Math.min(Math.max(pivotDepth, 0.2), 50);
  const safeFov = Number.isFinite(fovY)
    ? Math.min(Math.max(fovY, Math.PI / 180), (120 * Math.PI) / 180)
    : DEFAULT_LOOKING_GLASS_FOV_Y;
  return Math.min(
    Math.max(2 * safePivot * Math.tan(safeFov / 2), 0.1),
    50
  );
}

export interface LookingGlassEntryPivotEstimate {
  pivotDepth: number;
  sampleCount: number;
}

/** Median-of-medians entry pivot: reject an early depth outlier without wait. */
export function getLookingGlassEntryPivotEstimate(
  pivotDepths: readonly number[],
  fallbackPivotDepth: number
): LookingGlassEntryPivotEstimate {
  const values = pivotDepths
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.min(Math.max(value, 0.2), 50))
    .sort((a, b) => a - b);
  const fallback = Number.isFinite(fallbackPivotDepth)
    ? Math.min(Math.max(fallbackPivotDepth, 0.2), 50)
    : 3.5;
  if (values.length === 0) {
    return { pivotDepth: fallback, sampleCount: 0 };
  }
  const middle = (values.length - 1) / 2;
  const pivotDepth =
    (values[Math.floor(middle)] + values[Math.ceil(middle)]) / 2;
  return { pivotDepth, sampleCount: values.length };
}

export function clampLookingGlassViewControls(
  controls: LookingGlassViewControls
): LookingGlassViewControls {
  return {
    zoom: Number.isFinite(controls.zoom)
      ? Math.min(
          Math.max(controls.zoom, LOOKING_GLASS_VIEW_RANGES.zoom.min),
          LOOKING_GLASS_VIEW_RANGES.zoom.max
        )
      : 1,
    autoConvergence: controls.autoConvergence !== false,
    panX: Number.isFinite(controls.panX)
      ? Math.min(
          Math.max(controls.panX, LOOKING_GLASS_VIEW_RANGES.pan.min),
          LOOKING_GLASS_VIEW_RANGES.pan.max
        )
      : 0,
    panY: Number.isFinite(controls.panY)
      ? Math.min(
          Math.max(controls.panY, LOOKING_GLASS_VIEW_RANGES.pan.min),
          LOOKING_GLASS_VIEW_RANGES.pan.max
        )
      : 0,
    focusBaseZ: Number.isFinite(controls.focusBaseZ)
      ? Math.min(
          Math.max(
            controls.focusBaseZ,
            LOOKING_GLASS_RUNTIME_FOCUS_RANGE.min
          ),
          LOOKING_GLASS_RUNTIME_FOCUS_RANGE.max
        )
      : 0,
    focusTrimZ: Number.isFinite(controls.focusTrimZ)
      ? Math.min(
          Math.max(
            controls.focusTrimZ,
            LOOKING_GLASS_VIEW_RANGES.focusTrimZ.min
          ),
          LOOKING_GLASS_VIEW_RANGES.focusTrimZ.max
        )
      : 0,
  };
}

export function getLookingGlassTargetZ(
  controls: LookingGlassViewControls
): number {
  const { focusBaseZ, focusTrimZ } = clampLookingGlassViewControls(controls);
  return Math.min(
    Math.max(
      focusBaseZ + focusTrimZ,
      LOOKING_GLASS_RUNTIME_FOCUS_RANGE.min
    ),
    LOOKING_GLASS_RUNTIME_FOCUS_RANGE.max
  );
}

export interface LookingGlassFocusCompensation {
  targetDiameter: number;
  cameraZ: number;
  limited: boolean;
}

export interface LookingGlassSourceFit {
  projectionScale: number;
  verticalFovDegrees: number;
  horizontalFovDegrees: number;
  requestedVerticalFovDegrees: number;
  limited: boolean;
}

function clampLookingGlassFovY(fovY: number): number {
  return Number.isFinite(fovY)
    ? Math.min(
        Math.max(fovY, LOOKING_GLASS_FOV_Y_RANGE.min),
        LOOKING_GLASS_FOV_Y_RANGE.max
      )
    : DEFAULT_LOOKING_GLASS_FOV_Y;
}

/**
 * Fit every calibrated source-camera ray into the connected display aspect by
 * uniformly scaling clip X/Y. The vendor camera can retain its normal FOV,
 * distance, and zero-parallax plane while a portrait display letterboxes a
 * wide source without bending its calibrated border.
 */
export function getLookingGlassSourceFit(
  projection: ProjectionCalibration,
  displayAspect: number,
  margin = LOOKING_GLASS_SOURCE_FIT_MARGIN
): LookingGlassSourceFit {
  const fallbackAspect =
    Number.isFinite(projection.displayAspect) && projection.displayAspect > 0
      ? projection.displayAspect
      : 16 / 9;
  const safeAspect = Number.isFinite(displayAspect) && displayAspect > 0
    ? Math.min(Math.max(displayAspect, 0.1), 10)
    : fallbackAspect;
  const safeMargin = Number.isFinite(margin)
    ? Math.max(margin, 1)
    : LOOKING_GLASS_SOURCE_FIT_MARGIN;
  const requestedVerticalFovDegrees = getSourceViewFitFovY(
    projection,
    safeAspect,
    (DEFAULT_LOOKING_GLASS_FOV_Y * 180) / Math.PI,
    safeMargin
  );
  const requestedFovY =
    (requestedVerticalFovDegrees * Math.PI) / 180;
  const requestedScale =
    Math.tan(DEFAULT_LOOKING_GLASS_FOV_Y / 2) /
    Math.max(Math.tan(requestedFovY / 2), Number.EPSILON);
  const projectionScale = Math.min(
    Math.max(
      requestedScale,
      LOOKING_GLASS_SOURCE_FIT_SCALE_RANGE.min
    ),
    LOOKING_GLASS_SOURCE_FIT_SCALE_RANGE.max
  );
  const effectiveFovY =
    2 *
    Math.atan(
      Math.tan(DEFAULT_LOOKING_GLASS_FOV_Y / 2) / projectionScale
    );
  const verticalFovDegrees = (effectiveFovY * 180) / Math.PI;
  const horizontalFovDegrees =
    (2 * Math.atan(Math.tan(effectiveFovY / 2) * safeAspect) * 180) /
    Math.PI;
  return {
    projectionScale,
    verticalFovDegrees,
    horizontalFovDegrees,
    requestedVerticalFovDegrees,
    limited:
      requestedScale < LOOKING_GLASS_SOURCE_FIT_SCALE_RANGE.min,
  };
}

/** Pure projection zoom: never dollies the vendor camera or scales the mesh. */
export function getLookingGlassPresentationScale(
  sourceFitScale: number,
  zoom: number
): number {
  const safeSourceFit = Number.isFinite(sourceFitScale)
    ? Math.min(
        Math.max(
          sourceFitScale,
          LOOKING_GLASS_SOURCE_FIT_SCALE_RANGE.min
        ),
        LOOKING_GLASS_SOURCE_FIT_SCALE_RANGE.max
      )
    : 1;
  const safeZoom = Number.isFinite(zoom)
    ? Math.min(
        Math.max(zoom, LOOKING_GLASS_VIEW_RANGES.zoom.min),
        LOOKING_GLASS_VIEW_RANGES.zoom.max
      )
    : 1;
  return Math.min(
    Math.max(
      safeSourceFit * safeZoom,
      LOOKING_GLASS_PRESENTATION_SCALE_RANGE.min
    ),
    LOOKING_GLASS_PRESENTATION_SCALE_RANGE.max
  );
}

/** Central camera Z used by @lookingglass/webxr 0.6.0. */
export function getLookingGlassCameraZ(
  targetZ: number,
  targetDiameter: number,
  fovY = DEFAULT_LOOKING_GLASS_FOV_Y
): number {
  const safeTargetZ = Number.isFinite(targetZ) ? targetZ : 0;
  const safeDiameter = Number.isFinite(targetDiameter)
    ? Math.min(
        Math.max(targetDiameter, LOOKING_GLASS_TARGET_DIAMETER_RANGE.min),
        LOOKING_GLASS_TARGET_DIAMETER_RANGE.max
      )
    : DEFAULT_LOOKING_GLASS_TARGET_DIAMETER;
  return (
    safeTargetZ +
    (0.5 * safeDiameter) / Math.tan(clampLookingGlassFovY(fovY) / 2)
  );
}

/**
 * Counter the vendor runtime's targetZ dolly by changing targetDiam so the
 * central camera and therefore central-view framing stay fixed.
 */
export function getLookingGlassFocusCompensation(
  previousTargetZ: number,
  previousTargetDiameter: number,
  nextTargetZ: number,
  fovY = DEFAULT_LOOKING_GLASS_FOV_Y
): LookingGlassFocusCompensation {
  const safeNextTargetZ = Number.isFinite(nextTargetZ) ? nextTargetZ : 0;
  const safeFov = clampLookingGlassFovY(fovY);
  const cameraZ = getLookingGlassCameraZ(
    previousTargetZ,
    previousTargetDiameter,
    safeFov
  );
  const requestedDiameter =
    2 * (cameraZ - safeNextTargetZ) * Math.tan(safeFov / 2);
  const targetDiameter = Number.isFinite(requestedDiameter)
    ? Math.min(
        Math.max(
          requestedDiameter,
          LOOKING_GLASS_TARGET_DIAMETER_RANGE.min
        ),
        LOOKING_GLASS_TARGET_DIAMETER_RANGE.max
      )
    : DEFAULT_LOOKING_GLASS_TARGET_DIAMETER;
  return {
    targetDiameter,
    cameraZ,
    limited:
      !Number.isFinite(requestedDiameter) ||
      requestedDiameter < LOOKING_GLASS_TARGET_DIAMETER_RANGE.min ||
      requestedDiameter > LOOKING_GLASS_TARGET_DIAMETER_RANGE.max,
  };
}

export function toLookingGlassViewConfig(
  controls: LookingGlassViewControls,
  baseTargetDiameter = DEFAULT_LOOKING_GLASS_TARGET_DIAMETER
): LookingGlassViewConfig {
  const baseDiameter = Number.isFinite(baseTargetDiameter)
    ? Math.min(
        Math.max(
          baseTargetDiameter,
          LOOKING_GLASS_TARGET_DIAMETER_RANGE.min
        ),
        LOOKING_GLASS_TARGET_DIAMETER_RANGE.max
      )
    : DEFAULT_LOOKING_GLASS_TARGET_DIAMETER;
  return {
    targetZ: getLookingGlassTargetZ(controls),
    // Zoom is applied in clip space so targetDiam never dollies the camera.
    targetDiam: baseDiameter,
  };
}

export const DEFAULT_LOOKING_GLASS_CONFIG: LookingGlassViewConfig = {
  targetX: 0,
  targetY: 0,
  targetZ: 0,
  targetDiam: DEFAULT_LOOKING_GLASS_TARGET_DIAMETER,
  fovy: DEFAULT_LOOKING_GLASS_FOV_Y,
  // Keep the reconstructed metric geometry neutral instead of adding another
  // display-only depth exaggeration on top of the calibrated mesh.
  depthiness: 1,
};

const defaultImporter: LookingGlassImporter = async () =>
  import('@lookingglass/webxr');

/** Lazily installs the page-wide Looking Glass WebXR override exactly once. */
export class LookingGlassRuntime {
  private modulePromise: Promise<LookingGlassModule> | null = null;
  private instance: LookingGlassPolyfillInstance | null = null;
  private globalConfig: LookingGlassGlobalConfig | null = null;
  private presentationInputCleanup: (() => void) | null = null;
  private readonly viewConfig: LookingGlassViewConfig = {
    ...DEFAULT_LOOKING_GLASS_CONFIG,
  };
  private readonly importer: LookingGlassImporter;

  constructor(importer: LookingGlassImporter = defaultImporter) {
    this.importer = importer;
  }

  preload(): Promise<LookingGlassModule> {
    if (!this.modulePromise) {
      this.modulePromise = this.importer().catch((error: unknown) => {
        // Permit an explicit click to retry after a transient chunk-load error.
        this.modulePromise = null;
        throw error;
      });
    }
    return this.modulePromise;
  }

  async activate(
    config: LookingGlassViewConfig = {}
  ): Promise<void> {
    Object.assign(this.viewConfig, config);
    const module = await this.preload();
    this.globalConfig = module.LookingGlassConfig;
    Object.assign(module.LookingGlassConfig, this.viewConfig);
    if (this.instance) {
      this.instance.update(config);
      return;
    }
    this.instance = new module.LookingGlassWebXRPolyfill({
      ...this.viewConfig,
    });
  }

  updateView(config: LookingGlassViewConfig): void {
    Object.assign(this.viewConfig, config);
    this.instance?.update(config);
  }

  /**
   * Re-emit the active configuration after XRWebGLLayer construction.
   *
   * @lookingglass/webxr 0.6.0 creates its final quilt-to-display shader from an
   * `on-config-changed` listener installed by the layer constructor. When
   * Bridge calibration arrived before that constructor ran, there may be no
   * later event and the presentation blit remains unlinked (black output).
   */
  refreshAfterLayerCreation(): void {
    this.instance?.update({});
  }

  /**
   * Replace the vendor's per-event mouse navigation with app-owned controls.
   * Projection-only wheel/pan changes avoid vendor configuration events and
   * quilt reallocation; a stationary primary click remains a depth focus pick.
   */
  bindPresentationInput(
    handlers: LookingGlassPresentationInputHandlers
  ): () => void {
    this.presentationInputCleanup?.();
    const canvas = this.globalConfig?.lkgCanvas;
    if (!canvas) return () => undefined;
    const appCanvas = this.globalConfig?.appCanvas;

    const maxClickMovementPx = 5;
    let pointerStart: {
      pointerId: number;
      button: number;
      x: number;
      y: number;
      lastX: number;
      lastY: number;
      maxDistance: number;
      dragging: boolean;
    } | null = null;

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
      handlers.onWheel({
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        pageHeightPx: canvas.getBoundingClientRect().height,
      });
    };
    const onMouseMove = (event: MouseEvent): void => {
      if (event.buttons === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onAppCanvasWheel = (event: WheelEvent): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onNavigationKey = (event: KeyboardEvent): void => {
      if (!['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 && event.button !== 2) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pointerStart = {
        pointerId: event.pointerId,
        button: event.button,
        x: event.clientX,
        y: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        maxDistance: 0,
        dragging: false,
      };
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is optional in some popup/fullscreen implementations.
      }
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!pointerStart || pointerStart.pointerId !== event.pointerId) return;
      pointerStart.maxDistance = Math.max(
        pointerStart.maxDistance,
        Math.hypot(
          event.clientX - pointerStart.x,
          event.clientY - pointerStart.y
        )
      );
      if (
        !pointerStart.dragging &&
        pointerStart.maxDistance > maxClickMovementPx
      ) {
        pointerStart.dragging = true;
      }
      const deltaX = event.clientX - pointerStart.lastX;
      const deltaY = event.clientY - pointerStart.lastY;
      pointerStart.lastX = event.clientX;
      pointerStart.lastY = event.clientY;
      if (!pointerStart.dragging || (deltaX === 0 && deltaY === 0)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      handlers.onPan({
        deltaX: (2 * deltaX) / rect.width,
        deltaY: (-2 * deltaY) / rect.height,
      });
    };
    const clearPointer = (event: PointerEvent): void => {
      if (!pointerStart || pointerStart.pointerId !== event.pointerId) return;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        // It may already have been released by fullscreen/window transitions.
      }
      pointerStart = null;
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (!pointerStart || pointerStart.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const shouldFocus =
        pointerStart.button === 0 &&
        pointerStart.maxDistance <= maxClickMovementPx;
      clearPointer(event);
      if (!shouldFocus) return;

      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const normalizedX = (event.clientX - rect.left) / rect.width;
      const normalizedY = (event.clientY - rect.top) / rect.height;
      if (
        normalizedX < 0 ||
        normalizedX > 1 ||
        normalizedY < 0 ||
        normalizedY > 1
      ) {
        return;
      }
      handlers.onFocusRequest({ normalizedX, normalizedY });
    };
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    canvas.addEventListener('wheel', onWheel, {
      capture: true,
      passive: false,
    });
    canvas.addEventListener('mousemove', onMouseMove, {
      capture: true,
      passive: false,
    });
    canvas.addEventListener('pointerdown', onPointerDown, { capture: true });
    canvas.addEventListener('pointermove', onPointerMove, { capture: true });
    canvas.addEventListener('pointerup', onPointerUp, { capture: true });
    canvas.addEventListener('pointercancel', clearPointer, { capture: true });
    canvas.addEventListener('contextmenu', onContextMenu, { capture: true });
    canvas.addEventListener('keydown', onNavigationKey, { capture: true });
    canvas.addEventListener('keyup', onNavigationKey, { capture: true });
    if (appCanvas && appCanvas !== canvas) {
      appCanvas.addEventListener('wheel', onAppCanvasWheel, {
        capture: true,
        passive: false,
      });
      appCanvas.addEventListener('mousemove', onMouseMove, {
        capture: true,
        passive: false,
      });
      appCanvas.addEventListener('keydown', onNavigationKey, { capture: true });
      appCanvas.addEventListener('keyup', onNavigationKey, { capture: true });
    }

    const cleanup = (): void => {
      canvas.removeEventListener('wheel', onWheel, { capture: true });
      canvas.removeEventListener('mousemove', onMouseMove, { capture: true });
      canvas.removeEventListener('pointerdown', onPointerDown, { capture: true });
      canvas.removeEventListener('pointermove', onPointerMove, { capture: true });
      canvas.removeEventListener('pointerup', onPointerUp, { capture: true });
      canvas.removeEventListener('pointercancel', clearPointer, { capture: true });
      canvas.removeEventListener('contextmenu', onContextMenu, { capture: true });
      canvas.removeEventListener('keydown', onNavigationKey, { capture: true });
      canvas.removeEventListener('keyup', onNavigationKey, { capture: true });
      if (appCanvas && appCanvas !== canvas) {
        appCanvas.removeEventListener('wheel', onAppCanvasWheel, { capture: true });
        appCanvas.removeEventListener('mousemove', onMouseMove, { capture: true });
        appCanvas.removeEventListener('keydown', onNavigationKey, { capture: true });
        appCanvas.removeEventListener('keyup', onNavigationKey, { capture: true });
      }
      pointerStart = null;
      if (this.presentationInputCleanup === cleanup) {
        this.presentationInputCleanup = null;
      }
    };
    this.presentationInputCleanup = cleanup;
    return cleanup;
  }

  get isInstalled(): boolean {
    return this.instance !== null;
  }

  get isDisplayDetected(): boolean {
    return Boolean(this.globalConfig?.calibration?.serial?.trim());
  }

  get displayAspect(): number | null {
    const width = this.globalConfig?.calibration?.screenW?.value;
    const height = this.globalConfig?.calibration?.screenH?.value;
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      (width ?? 0) <= 0 ||
      (height ?? 0) <= 0
    ) {
      return null;
    }
    return (width as number) / (height as number);
  }

  get isPopupOpen(): boolean {
    const popup = this.globalConfig?.popup;
    return Boolean(popup && !popup.closed);
  }

  async waitForDisplayCalibration(
    timeoutMs = 1200,
    pollMs = 50
  ): Promise<number | null> {
    const deadline = performance.now() + Math.max(timeoutMs, 0);
    while (
      (!this.isDisplayDetected || this.displayAspect === null) &&
      performance.now() < deadline
    ) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, Math.max(pollMs, 1));
      });
    }
    return this.isDisplayDetected ? this.displayAspect : null;
  }

  async waitForPresentation(
    timeoutMs = 1200,
    pollMs = 50
  ): Promise<LookingGlassPresentationStatus> {
    const deadline = performance.now() + Math.max(timeoutMs, 0);
    while (
      (!this.isDisplayDetected || !this.isPopupOpen) &&
      performance.now() < deadline
    ) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, Math.max(pollMs, 1));
      });
    }
    return {
      displayDetected: this.isDisplayDetected,
      popupOpen: this.isPopupOpen,
    };
  }
}

export function describeLookingGlassFailure(error: unknown): LookingGlassFailure {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = `${error instanceof Error ? error.name : ''} ${detail}`.toLowerCase();

  if (
    /not.?supported|unavailable|bridge|device|connect|webxr/.test(normalized)
  ) {
    return {
      status: 'unavailable',
      label: 'Unavailable',
      detail: 'Start Looking Glass Bridge, connect the display, and try again.',
    };
  }

  if (/security|gesture|popup|permission|blocked/.test(normalized)) {
    return {
      status: 'failed',
      label: 'Blocked',
      detail: 'Allow the XR popup, then activate Looking Glass again.',
    };
  }

  return {
    status: 'failed',
    label: 'Failed',
    detail: detail || 'Looking Glass could not be started.',
  };
}
