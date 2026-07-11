declare module '@lookingglass/webxr' {
  export interface LookingGlassViewConfig {
    targetX?: number;
    targetY?: number;
    targetZ?: number;
    targetDiam?: number;
    fovy?: number;
    depthiness?: number;
  }

  export interface LookingGlassPolyfillInstance {
    update(config: LookingGlassViewConfig): void;
  }

  export interface LookingGlassGlobalConfig extends LookingGlassViewConfig {
    calibration?: {
      serial?: string;
      screenW?: { value?: number };
      screenH?: { value?: number };
    };
    popup?: Window | null;
    lkgCanvas?: HTMLCanvasElement | null;
    appCanvas?: HTMLCanvasElement | null;
  }

  export class LookingGlassWebXRPolyfill
    implements LookingGlassPolyfillInstance {
    constructor(config?: LookingGlassViewConfig);
    update(config: LookingGlassViewConfig): void;
  }

  export const LookingGlassConfig: LookingGlassGlobalConfig;
}
