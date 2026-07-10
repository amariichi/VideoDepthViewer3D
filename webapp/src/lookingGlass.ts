import type {
  LookingGlassGlobalConfig,
  LookingGlassPolyfillInstance,
  LookingGlassViewConfig,
} from '@lookingglass/webxr';

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

export const DEFAULT_LOOKING_GLASS_CONFIG: LookingGlassViewConfig = {
  targetX: 0,
  targetY: 0,
  targetZ: 0,
  targetDiam: 3,
  fovy: (40 * Math.PI) / 180,
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
    config: LookingGlassViewConfig = DEFAULT_LOOKING_GLASS_CONFIG
  ): Promise<void> {
    const module = await this.preload();
    this.globalConfig = module.LookingGlassConfig;
    Object.assign(module.LookingGlassConfig, config);
    if (this.instance) {
      this.instance.update(config);
      return;
    }
    this.instance = new module.LookingGlassWebXRPolyfill(config);
  }

  get isInstalled(): boolean {
    return this.instance !== null;
  }

  get isDisplayDetected(): boolean {
    return Boolean(this.globalConfig?.calibration?.serial?.trim());
  }

  get isPopupOpen(): boolean {
    const popup = this.globalConfig?.popup;
    return Boolean(popup && !popup.closed);
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
