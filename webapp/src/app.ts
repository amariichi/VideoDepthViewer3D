import { ControlPanel } from './ui/controls';
import {
  VIDEO_TRANSFER_STATUS,
  deleteSession,
  describeVideoTransferError,
  uploadVideo,
} from './network/sessionApi';
import { DepthClient } from './network/depthClient';
import { RenderScene } from './render/scene';
import { usePlayerStore } from './state/playerStore';
import { RawXRTest } from './xrTest';
import type { SessionInfo, DepthFrame, ViewerControls } from './types';

import { DepthBuffer } from './utils/depthBuffer';
import { perfStats } from './utils/perfStats';
import { apiUrl } from './utils/env';
import { getModeTargetTriangles } from './performance/qualityPolicy';
import { getProjectionCalibration } from './render/projection';
import { estimateSourcePivotDepth } from './render/sourceView';
import {
  DEFAULT_LOOKING_GLASS_FOV_Y,
  DEFAULT_LOOKING_GLASS_TARGET_DIAMETER,
  LookingGlassRuntime,
  clampLookingGlassViewControls,
  describeLookingGlassFailure,
  getLookingGlassFocusCompensation,
  getLookingGlassEntryPivotEstimate,
  getLookingGlassPresentationScale,
  getLookingGlassSourceFit,
  getLookingGlassTargetZ,
  getLookingGlassTargetDiameterForPivot,
  toLookingGlassViewConfig,
  waitForLookingGlassBridge,
} from './lookingGlass';
import type {
  LookingGlassSourceFit,
  LookingGlassViewControls,
} from './lookingGlass';
import {
  LookingGlassFocusClickGuard,
  getLookingGlassWheelZoom,
} from './lookingGlassInteraction';

type XRDisplayMode = 'vr' | 'looking-glass';

export class VideoDepthApp {
  private videoEl: HTMLVideoElement;
  private renderScene: RenderScene;
  private controlPanel: ControlPanel;
  private depthClient: DepthClient | null = null;
  private currentSession: SessionInfo | null = null;
  private depthRafId: number | null = null;
  private renderRafId: number | null = null;
  private depthBuffer = new DepthBuffer();
  private lastAspect = 0;
  private lastTargetTriangles = 0;
  private latestDepthFrame: DepthFrame | null = null;
  private rawXR: RawXRTest | null = null;
  private readonly lookingGlassRuntime = new LookingGlassRuntime();
  private lookingGlassViewControls: LookingGlassViewControls = {
    zoom: 1,
    autoConvergence: true,
    panX: 0,
    panY: 0,
    focusBaseZ: 0,
    focusTrimZ: 0,
  };
  private lookingGlassBaseTargetDiameter =
    DEFAULT_LOOKING_GLASS_TARGET_DIAMETER;
  private lookingGlassConfiguredTargetZ = 0;
  private lookingGlassEntryPivotSampleCount = 0;
  private lookingGlassSourceFit: LookingGlassSourceFit | null = null;
  private lookingGlassPresentationCleanup: (() => void) | null = null;
  private readonly lookingGlassFocusClickGuard =
    new LookingGlassFocusClickGuard();
  private suppressSeekRefresh = false;
  private lastAppliedDepthTimestamp = -1;
  private currentSyncDeltaMs = 0;

  constructor(root: HTMLElement) {
    // ... (existing constructor code)
    const video = document.createElement('video');
    video.id = 'source-video';
    video.controls = true;
    video.playsInline = true;
    video.muted = true;
    video.preload = 'metadata';
    root.querySelector('#video-container')?.appendChild(video);
    this.videoEl = video;
    this.videoEl.addEventListener('ended', () => this.handleVideoEnded());
    this.videoEl.addEventListener('seeked', () => this.handleVideoSeeked());
    usePlayerStore.getState().setVideo(video);

    const canvasContainer = root.querySelector('#canvas-container') as HTMLElement;
    const header = root.querySelector('header') as HTMLElement | null;
    const controls = usePlayerStore.getState().viewerControls;
    this.renderScene = new RenderScene(canvasContainer, controls, video, header ?? undefined);

    this.controlPanel = new ControlPanel(
      {
        fileInput: root.querySelector('#video-file') as HTMLInputElement,
        status: root.querySelector('#status-text') as HTMLElement,
        depthGui: root.querySelector('#gui-depth') as HTMLElement,
        perfGui: root.querySelector('#gui-perf') as HTMLElement,
      },
      {
        onFileSelected: async (file) => this.handleFileSelected(file),
        getFrontendFps: () => this.getFrontendFps(),
        getSyncDeltaMs: () => this.currentSyncDeltaMs,
        getFrontSafetyPushback: () =>
          this.rawXR?.getFrontSafetyPushback() ?? 0,
        getLookingGlassEffectiveTargetZ: () =>
          this.rawXR?.getAutoConvergenceTargetZ() ??
          getLookingGlassTargetZ(this.lookingGlassViewControls),
        getLookingGlassManualFocusLocked: () =>
          this.rawXR?.isLookingGlassManualFocusLocked() ?? false,
        getLookingGlassSourceDepthScale: () =>
          this.rawXR?.getLookingGlassSourceDepthScale() ?? 1,
        getViewDistance: () => this.renderScene.getViewDistance(),
        onViewDistanceChanged: (distance) => this.renderScene.setViewDistance(distance),
        getModelZOffset: () => this.renderScene.getModelZOffset(),
        onModelZOffsetChanged: (offset) => this.renderScene.setModelZOffset(offset),
        onLookingGlassViewChanged: (controls) => {
          this.setLookingGlassViewControls(controls, true);
        },
        onLookingGlassResumeAuto: () => {
          this.lookingGlassFocusClickGuard.reset();
          const resumed =
            this.rawXR?.resumeLookingGlassAutoConvergence() ?? false;
          this.controlPanel.updateStatus(
            resumed
              ? 'Looking Glass automatic depth placement resumed'
              : 'Looking Glass automatic depth placement is already active'
          );
        },
        onLookingGlassRefitForeground: () => {
          if (this.lookingGlassSourceFit) {
            this.controlPanel.updateStatus(
              'Looking Glass Source View keeps mesh pushback disabled to preserve projection'
            );
            return;
          }
          this.rawXR?.refitFrontSafety();
          this.controlPanel.updateStatus(
            'Looking Glass foreground will re-fit on the next XR frame'
          );
        },
        onLookingGlassResetView: () => {
          this.setLookingGlassViewControls(
            {
              ...this.lookingGlassViewControls,
              zoom: 1,
              panX: 0,
              panY: 0,
            },
            true
          );
          this.controlPanel.updateStatus(
            'Looking Glass zoom and pan reset'
          );
        },
      }
    );
    this.renderScene.setViewDistanceChangeHandler((distance) => {
      this.controlPanel.setViewDistance(distance);
    });
    this.renderScene.setModelZOffsetChangeHandler((offset) => {
      this.controlPanel.setModelZOffset(offset);
    });
    this.renderScene.setFramingModeChangeHandler((mode) => {
      this.controlPanel.setFramingMode(mode);
      const state = usePlayerStore.getState();
      if (state.viewerControls.framingMode !== mode) {
        state.updateControls({ framingMode: mode });
      }
    });

    // Manual Open Video button handler to ensure video is paused BEFORE file dialog opens
    const openBtn = root.querySelector('#btn-open-file');
    const fileInput = root.querySelector('#video-file') as HTMLInputElement;

    openBtn?.addEventListener('click', () => {
      // 1. Pause video immediately (stability fix)
      if (this.videoEl && !this.videoEl.paused) {
        this.videoEl.pause();
      }
      // 2. Trigger the hidden file input
      fileInput?.click();
    });



    usePlayerStore.subscribe(() => {
      const controls = this.getEffectiveViewerControls();
      this.renderScene.updateControls(controls);
      this.lastTargetTriangles = controls.targetTriangles;
    });

    this.mountXRButtons();

    // ダブルクリックでビューを初期状態に戻す
    canvasContainer.addEventListener('dblclick', () => {
      this.renderScene.resetView();
    });

    this.startRenderLoop();
  }

  private applyLookingGlassViewConfig(): void {
    const config = {
      ...toLookingGlassViewConfig(
        this.lookingGlassViewControls,
        this.lookingGlassBaseTargetDiameter
      ),
      fovy: DEFAULT_LOOKING_GLASS_FOV_Y,
    };
    this.lookingGlassConfiguredTargetZ = config.targetZ ?? 0;
    this.lookingGlassRuntime.updateView(config);
    this.applyLookingGlassRenderProfile(config);
  }

  private applyLookingGlassRenderProfile(
    config?: ReturnType<typeof toLookingGlassViewConfig>
  ): void {
    const viewConfig = config ?? {
      ...toLookingGlassViewConfig(
        this.lookingGlassViewControls,
        this.lookingGlassBaseTargetDiameter
      ),
      targetZ: this.lookingGlassConfiguredTargetZ,
    };
    const projectionScale = getLookingGlassPresentationScale(
      this.lookingGlassSourceFit?.projectionScale ?? 1,
      this.lookingGlassViewControls.zoom
    );
    this.rawXR?.setFrontSafetyProfile({
      mode: 'looking-glass',
      targetZ: viewConfig.targetZ ?? 0,
      targetDiameter:
        (viewConfig.targetDiam ?? DEFAULT_LOOKING_GLASS_TARGET_DIAMETER) /
        projectionScale,
      projectionScale,
      projectionZoom: this.lookingGlassViewControls.zoom,
      preserveSourceProjection: this.lookingGlassSourceFit !== null,
      autoConvergence:
        this.lookingGlassSourceFit !== null &&
        this.lookingGlassViewControls.autoConvergence,
      projectionPanX: this.lookingGlassViewControls.panX,
      projectionPanY: this.lookingGlassViewControls.panY,
    });
  }

  private setLookingGlassViewControls(
    controls: LookingGlassViewControls,
    applyToRuntime: boolean
  ): {
    focusCompensationLimited: boolean;
    convergenceLimited: boolean;
    foregroundLimited: boolean;
    baselineLimited: boolean;
    sourceRebased: boolean;
    appliedTargetZ: number;
  } {
    let clamped = clampLookingGlassViewControls(controls);
    const previousTargetZ = getLookingGlassTargetZ(
      this.lookingGlassViewControls
    );
    const requestedTargetZ = getLookingGlassTargetZ(clamped);
    const requestedFocusChanged =
      Math.abs(requestedTargetZ - previousTargetZ) > 1e-6;
    const autoChanged =
      clamped.autoConvergence !==
      this.lookingGlassViewControls.autoConvergence;
    if (autoChanged) {
      this.lookingGlassFocusClickGuard.reset();
    }
    const viewerControls = this.getEffectiveViewerControls();
    const sourceConvergenceActive =
      this.lookingGlassSourceFit !== null &&
      viewerControls.projectionMode === 'pinhole' &&
      viewerControls.framingMode === 'source';
    let convergenceLimited = false;
    let foregroundLimited = false;
    let baselineLimited = false;
    let sourceRebased = false;

    if (
      applyToRuntime &&
      sourceConvergenceActive &&
      (requestedFocusChanged || autoChanged)
    ) {
      const safeTarget = this.rawXR?.prepareLookingGlassConvergenceTarget(
        requestedTargetZ,
        clamped.autoConvergence
      );
      if (safeTarget?.limited) {
        convergenceLimited = true;
        foregroundLimited = safeTarget.foregroundLimited;
        baselineLimited = safeTarget.baselineLimited;
        sourceRebased = safeTarget.sourceRebased === true;
        const focusBaseChanged =
          Math.abs(
            clamped.focusBaseZ -
            this.lookingGlassViewControls.focusBaseZ
          ) > 1e-6;
        clamped = clampLookingGlassViewControls(
          focusBaseChanged
            ? {
                ...clamped,
                focusBaseZ: safeTarget.targetZ - clamped.focusTrimZ,
              }
            : {
                ...clamped,
                focusTrimZ: safeTarget.targetZ - clamped.focusBaseZ,
              }
        );
        if (
          Math.abs(
            getLookingGlassTargetZ(clamped) - safeTarget.targetZ
          ) > 1e-6
        ) {
          clamped = clampLookingGlassViewControls({
            ...clamped,
            focusBaseZ: safeTarget.targetZ - clamped.focusTrimZ,
          });
        }
      }
    }

    const nextTargetZ = getLookingGlassTargetZ(clamped);
    const focusChanged = Math.abs(nextTargetZ - previousTargetZ) > 1e-6;
    let focusCompensationLimited = false;

    if (focusChanged && !sourceConvergenceActive) {
      const diameterBeforeFocus = toLookingGlassViewConfig(
        this.lookingGlassViewControls,
        this.lookingGlassBaseTargetDiameter
      ).targetDiam ?? DEFAULT_LOOKING_GLASS_TARGET_DIAMETER;
      const compensation = getLookingGlassFocusCompensation(
        previousTargetZ,
        diameterBeforeFocus,
        nextTargetZ,
        DEFAULT_LOOKING_GLASS_FOV_Y
      );
      this.lookingGlassBaseTargetDiameter = compensation.targetDiameter;
      focusCompensationLimited = compensation.limited;
    }

    this.lookingGlassViewControls = clamped;
    this.controlPanel.setLookingGlassViewControls(clamped);
    if (applyToRuntime) {
      if (focusChanged && !sourceConvergenceActive) {
        this.applyLookingGlassViewConfig();
      } else {
        this.applyLookingGlassRenderProfile();
      }
      if (
        sourceConvergenceActive &&
        (focusChanged || autoChanged || sourceRebased)
      ) {
        const applied = this.rawXR?.setManualLookingGlassConvergenceTarget(
          nextTargetZ,
          requestedFocusChanged && clamped.autoConvergence
        );
        if (applied?.limited) {
          convergenceLimited = true;
          foregroundLimited ||= applied.foregroundLimited;
          baselineLimited ||= applied.baselineLimited;
        }
      }
    }
    return {
      focusCompensationLimited,
      convergenceLimited,
      foregroundLimited,
      baselineLimited,
      sourceRebased,
      appliedTargetZ: nextTargetZ,
    };
  }

  private setLookingGlassAutoFitTargetDiameter(
    neutralBaseTargetDiameter: number
  ): boolean {
    const controls = this.lookingGlassViewControls;
    const targetZ = getLookingGlassTargetZ(controls);
    const neutralTargetDiameter = toLookingGlassViewConfig(
      { ...controls, focusBaseZ: 0, focusTrimZ: 0 },
      neutralBaseTargetDiameter
    ).targetDiam ?? DEFAULT_LOOKING_GLASS_TARGET_DIAMETER;
    const compensation = getLookingGlassFocusCompensation(
      0,
      neutralTargetDiameter,
      targetZ,
      DEFAULT_LOOKING_GLASS_FOV_Y
    );
    this.lookingGlassBaseTargetDiameter = compensation.targetDiameter;
    return compensation.limited;
  }

  private getLookingGlassEntryPivot(
    controls: ViewerControls
  ): ReturnType<typeof getLookingGlassEntryPivotEstimate> {
    const fallbackPivot =
      this.renderScene.getSourceViewDiagnostics().pivotDepth;
    const currentTimeMs = this.videoEl.currentTime * 1000;
    const nearbyFrames = this.depthBuffer.getFramesNear(
      currentTimeMs,
      1000,
      7
    );
    const frames = nearbyFrames.length > 0
      ? nearbyFrames
      : this.latestDepthFrame
        ? [this.latestDepthFrame]
        : [];
    const pivots = frames.map((frame) => {
      const projection = getProjectionCalibration(
        this.currentSession?.calibration ?? null,
        controls,
        frame.width / Math.max(frame.height, 1)
      );
      return estimateSourcePivotDepth(
        frame.data,
        frame.width,
        frame.height,
        projection.depthMetricScale,
        controls.zMaxClip,
        fallbackPivot
      );
    });
    return getLookingGlassEntryPivotEstimate(pivots, fallbackPivot);
  }

  private async waitForLookingGlassEntryPivot(
    controls: ViewerControls,
    minimumSamples = 3,
    timeoutMs = 1500
  ): Promise<ReturnType<typeof getLookingGlassEntryPivotEstimate>> {
    const deadline = performance.now() + timeoutMs;
    let estimate = this.getLookingGlassEntryPivot(controls);
    while (
      estimate.sampleCount < minimumSamples &&
      performance.now() < deadline
    ) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 50);
      });
      estimate = this.getLookingGlassEntryPivot(controls);
    }
    return estimate;
  }

  private configureLookingGlassViewForEntry(
    controls: ViewerControls,
    displayAspect: number | null,
    entryPivot?: ReturnType<typeof getLookingGlassEntryPivotEstimate>
  ): LookingGlassSourceFit | null {
    this.lookingGlassSourceFit = null;

    const usesCalibratedSourceView =
      controls.projectionMode === 'pinhole' &&
      controls.framingMode === 'source';
    const pivot = entryPivot ?? this.getLookingGlassEntryPivot(controls);
    const pivotDepth = pivot.pivotDepth;
    this.lookingGlassEntryPivotSampleCount = pivot.sampleCount;
    const neutralBaseTargetDiameter = usesCalibratedSourceView
      ? getLookingGlassTargetDiameterForPivot(
          pivotDepth,
          DEFAULT_LOOKING_GLASS_FOV_Y
        )
      : DEFAULT_LOOKING_GLASS_TARGET_DIAMETER;
    this.setLookingGlassAutoFitTargetDiameter(neutralBaseTargetDiameter);

    if (!usesCalibratedSourceView) return null;

    const fallbackSourceAspect = this.currentSession
      ? this.currentSession.displayWidth /
        Math.max(this.currentSession.displayHeight, 1)
      : this.videoEl.videoWidth /
        Math.max(this.videoEl.videoHeight, 1);
    const projection = getProjectionCalibration(
      this.currentSession?.calibration ?? null,
      controls,
      fallbackSourceAspect || 16 / 9
    );
    const fit = getLookingGlassSourceFit(
      projection,
      displayAspect ?? 16 / 9
    );
    this.lookingGlassSourceFit = fit;
    return this.lookingGlassSourceFit;
  }

  private handleLookingGlassWheel(input: {
    deltaY: number;
    deltaMode: number;
    pageHeightPx: number;
  }): void {
    const zoom = getLookingGlassWheelZoom(
      this.lookingGlassViewControls.zoom,
      input.deltaY,
      input.deltaMode,
      input.pageHeightPx
    );
    if (zoom === this.lookingGlassViewControls.zoom) return;

    this.setLookingGlassViewControls(
      { ...this.lookingGlassViewControls, zoom },
      true
    );
    this.controlPanel.updateStatus(
      `Looking Glass zoom ${zoom.toFixed(2)}×`
    );
  }

  private handleLookingGlassPan(input: {
    deltaX: number;
    deltaY: number;
  }): void {
    const controls = clampLookingGlassViewControls({
      ...this.lookingGlassViewControls,
      panX: this.lookingGlassViewControls.panX + input.deltaX,
      panY: this.lookingGlassViewControls.panY + input.deltaY,
    });
    if (
      controls.panX === this.lookingGlassViewControls.panX &&
      controls.panY === this.lookingGlassViewControls.panY
    ) {
      return;
    }
    this.setLookingGlassViewControls(controls, true);
  }

  private handleLookingGlassFocusRequest(input: {
    normalizedX: number;
    normalizedY: number;
  }): void {
    const pick = this.rawXR?.pickLookingGlassFocus(
      input.normalizedX,
      input.normalizedY
    );
    if (!pick) {
      this.controlPanel.updateStatus(
        'Looking Glass focus: no stable depth at cursor'
      );
      return;
    }

    const requestedFocusBaseZ = pick.point.z;
    const viewConfig = toLookingGlassViewConfig(
      this.lookingGlassViewControls,
      this.lookingGlassBaseTargetDiameter
    );
    const projectionScale = getLookingGlassPresentationScale(
      this.lookingGlassSourceFit?.projectionScale ?? 1,
      this.lookingGlassViewControls.zoom
    );
    const activeTargetDiameter =
      (viewConfig.targetDiam ?? DEFAULT_LOOKING_GLASS_TARGET_DIAMETER) /
      projectionScale;
    const clickDecision = this.lookingGlassFocusClickGuard.evaluate({
      ...input,
      requestedTargetZ: requestedFocusBaseZ,
      currentTargetZ:
        this.rawXR?.getAutoConvergenceTargetZ() ??
        getLookingGlassTargetZ(this.lookingGlassViewControls),
      targetDiameter: activeTargetDiameter,
    });
    if (clickDecision.action === 'confirm-far-focus') {
      this.controlPanel.updateStatus(
        'Far focus not applied (possible misclick). Click the same area again after a moment to confirm.'
      );
      return;
    }

    const controls = clampLookingGlassViewControls({
      ...this.lookingGlassViewControls,
      focusBaseZ: requestedFocusBaseZ,
      focusTrimZ: 0,
    });
    const {
      focusCompensationLimited,
      foregroundLimited,
      baselineLimited,
      sourceRebased,
      appliedTargetZ,
    } =
      this.setLookingGlassViewControls(controls, true);
    const focusRangeLimited =
      !sourceRebased &&
      Math.abs(controls.focusBaseZ - requestedFocusBaseZ) > 1e-3;
    const limitations = [
      sourceRebased ? 'scene depth rebased' : null,
      focusRangeLimited ? 'focus range' : null,
      foregroundLimited ? 'foreground safety' : null,
      baselineLimited ? 'convergence range' : null,
      focusCompensationLimited ? 'framing compensation' : null,
    ].filter((value): value is string => value !== null);
    const manualFocusLocked =
      this.rawXR?.isLookingGlassManualFocusLocked() ?? false;
    const placementState = manualFocusLocked
      ? 'focus locked; Resume Auto or a scene/safety change releases it'
      : controls.autoConvergence
        ? 'automatic depth placement active'
        : 'manual placement held';
    this.controlPanel.updateStatus(
      limitations.length > 0
        ? `Looking Glass target Z ${appliedTargetZ.toFixed(2)} (${limitations.join(' and ')} limited); ${placementState}`
        : `Looking Glass target Z ${appliedTargetZ.toFixed(2)}; ${placementState}`
    );
  }

  private attachLookingGlassPresentationInput(): void {
    this.detachLookingGlassPresentationInput();
    this.lookingGlassPresentationCleanup =
      this.lookingGlassRuntime.bindPresentationInput({
        onWheel: (input) => this.handleLookingGlassWheel(input),
        onFocusRequest: (input) =>
          this.handleLookingGlassFocusRequest(input),
        onPan: (input) => this.handleLookingGlassPan(input),
      });
  }

  private detachLookingGlassPresentationInput(): void {
    this.lookingGlassPresentationCleanup?.();
    this.lookingGlassPresentationCleanup = null;
    this.lookingGlassFocusClickGuard.reset();
  }

  private mountXRButtons(): void {
    const rawVrBtn = document.getElementById('btn-vr') as HTMLButtonElement;
    const lookingGlassBtn = document.getElementById(
      'btn-looking-glass'
    ) as HTMLButtonElement;
    const lookingGlassStatus = document.getElementById(
      'looking-glass-status'
    ) as HTMLElement;
    const helpCheckbox = document.getElementById('chk-hints') as HTMLInputElement;
    const sbsBtn = document.getElementById('btn-sbs') as HTMLButtonElement;
    const sbsSwapCheckbox = document.getElementById('chk-sbs-swap') as HTMLInputElement;

    if (
      !rawVrBtn ||
      !lookingGlassBtn ||
      !lookingGlassStatus ||
      !helpCheckbox ||
      !sbsBtn ||
      !sbsSwapCheckbox
    ) {
      console.warn('XR buttons not found in DOM');
      return;
    }

    let activeMode: XRDisplayMode | null = null;
    let transitioning = false;
    let lookingGlassRuntimeSelected = false;

    const setLookingGlassStatus = (
      label: string,
      detail: string,
      showDetail = false
    ): void => {
      lookingGlassStatus.textContent = showDetail
        ? `${label} — ${detail}`
        : label;
      lookingGlassStatus.title = detail;
    };

    const refreshXRButtons = (): void => {
      const hasSession = Boolean(usePlayerStore.getState().session);
      rawVrBtn.textContent = activeMode === 'vr'
        ? 'Exit VR (RawXR)'
        : 'Start VR (RawXR)';
      lookingGlassBtn.textContent = activeMode === 'looking-glass'
        ? 'Exit Looking Glass'
        : 'Enter Looking Glass';

      rawVrBtn.disabled =
        !hasSession ||
        transitioning ||
        activeMode === 'looking-glass' ||
        (lookingGlassRuntimeSelected && activeMode !== 'vr');
      lookingGlassBtn.disabled =
        !hasSession || transitioning || activeMode === 'vr';
      rawVrBtn.title = lookingGlassRuntimeSelected
        ? 'Looking Glass owns WebXR for this page. Reload to restore native VR.'
        : 'Start the generic RawXR headset path.';
    };

    const handleXRSessionEnded = (): void => {
      const endedMode = activeMode;
      activeMode = null;
      transitioning = false;
      this.resumeRenderLoop();
      if (endedMode === 'looking-glass') {
        this.detachLookingGlassPresentationInput();
        setLookingGlassStatus(
          'Monitor',
          'Looking Glass ended; monitor rendering is active.'
        );
        this.controlPanel.updateStatus('Looking Glass ended');
      } else if (endedMode === 'vr') {
        this.controlPanel.updateStatus('Raw XR ended');
      }
      refreshXRButtons();
    };

    const prepareRawXR = (mode: XRDisplayMode): RawXRTest => {
      if (!this.rawXR) {
        this.rawXR = new RawXRTest(document.querySelector('#canvas-container') as HTMLElement);
      }
      this.rawXR.setVideo(this.videoEl);
      this.rawXR.setControlsGetter(() => this.getEffectiveViewerControls());
      this.rawXR.setCalibration(this.currentSession?.calibration ?? null);
      this.rawXR.setDepthBuffer(this.depthBuffer);
      if (mode === 'looking-glass') {
        const config = toLookingGlassViewConfig(
          this.lookingGlassViewControls,
          this.lookingGlassBaseTargetDiameter
        );
        const projectionScale = getLookingGlassPresentationScale(
          this.lookingGlassSourceFit?.projectionScale ?? 1,
          this.lookingGlassViewControls.zoom
        );
        this.rawXR.setFrontSafetyProfile({
          mode: 'looking-glass',
          targetZ: this.lookingGlassConfiguredTargetZ,
          targetDiameter:
            (config.targetDiam ?? DEFAULT_LOOKING_GLASS_TARGET_DIAMETER) /
            projectionScale,
          projectionScale,
          projectionZoom: this.lookingGlassViewControls.zoom,
          preserveSourceProjection: this.lookingGlassSourceFit !== null,
          autoConvergence:
            this.lookingGlassSourceFit !== null &&
            this.lookingGlassViewControls.autoConvergence,
          projectionPanX: this.lookingGlassViewControls.panX,
          projectionPanY: this.lookingGlassViewControls.panY,
        });
      } else {
        this.rawXR.setFrontSafetyProfile({ mode: 'webxr' });
      }
      this.rawXR.setSessionEndedCallback(handleXRSessionEnded);
      this.rawXR.enableDepthMesh();
      this.rawXR.setHintsEnabled(mode === 'vr' && helpCheckbox.checked);
      return this.rawXR;
    };

    const startXR = async (mode: XRDisplayMode): Promise<void> => {
      if (transitioning) return;
      if (activeMode === mode) {
        transitioning = true;
        refreshXRButtons();
        if (mode === 'looking-glass') {
          this.detachLookingGlassPresentationInput();
        }
        await this.rawXR?.stop();
        return;
      }
      if (activeMode !== null) return;

      transitioning = true;
      activeMode = mode;
      refreshXRButtons();

      try {
        if (mode === 'looking-glass') {
          setLookingGlassStatus(
            'Starting…',
            'Checking Bridge before loading the Looking Glass WebXR runtime.'
          );
          // @lookingglass/webxr 0.6.0 performs a one-shot calibration request
          // when its module is evaluated and does not reconnect after failure.
          // Do not import/install it until the local Bridge socket is ready.
          await waitForLookingGlassBridge();
          await this.lookingGlassRuntime.activate();
          const displayAspect =
            await this.lookingGlassRuntime.waitForDisplayCalibration();
          const controls = this.getEffectiveViewerControls();
          const usesCalibratedSourceView =
            controls.projectionMode === 'pinhole' &&
            controls.framingMode === 'source';
          let entryPivot:
            | ReturnType<typeof getLookingGlassEntryPivotEstimate>
            | undefined;
          if (usesCalibratedSourceView) {
            setLookingGlassStatus(
              'Starting…',
              'Stabilizing current depth before fixing the display camera.'
            );
            entryPivot = await this.waitForLookingGlassEntryPivot(controls);
          }
          this.configureLookingGlassViewForEntry(
            controls,
            displayAspect,
            entryPivot
          );
          this.applyLookingGlassViewConfig();
          // The official polyfill overrides navigator.xr for the lifetime of
          // this page. Keep generic VR disabled after this point.
          lookingGlassRuntimeSelected = true;
        }

        const rawXR = prepareRawXR(mode);
        this.pauseRenderLoop();
        await rawXR.start();
        if (mode === 'looking-glass') {
          // The 0.6.0 polyfill installs its final presentation-shader listener
          // while XRWebGLLayer is constructed. Re-emit configuration now so a
          // calibration received before entry cannot leave that shader unlinked.
          this.lookingGlassRuntime.refreshAfterLayerCreation();
          this.attachLookingGlassPresentationInput();
        }
        if (activeMode !== mode) return;

        let lookingGlassPresentation = {
          displayDetected: false,
          popupOpen: false,
        };
        if (mode === 'looking-glass') {
          lookingGlassPresentation =
            await this.lookingGlassRuntime.waitForPresentation();
          if (activeMode !== mode) return;
        }
        transitioning = false;
        if (mode === 'looking-glass') {
          if (!lookingGlassPresentation.popupOpen) {
            setLookingGlassStatus(
              'Blocked',
              'Allow pop-ups/window management, exit, and activate again.',
              true
            );
            this.controlPanel.updateStatus('Looking Glass window blocked');
          } else if (lookingGlassPresentation.displayDetected) {
            const fit = this.lookingGlassSourceFit;
            const fitSummary = fit
              ? ` Full-source projection: ${fit.verticalFovDegrees.toFixed(0)}°V × ${fit.horizontalFovDegrees.toFixed(0)}°H effective${fit.limited ? ' (limited)' : ''}; Bridge camera stays 40°V; entry pivot used ${this.lookingGlassEntryPivotSampleCount} depth sample${this.lookingGlassEntryPivotSampleCount === 1 ? '' : 's'}.`
              : '';
            setLookingGlassStatus(
              'Active',
              `Bridge calibration is active.${fitSummary} Wheel to zoom; click stable depth to lock focus; use Resume Auto to release it.`
            );
            this.controlPanel.updateStatus(
              fit
                ? `Looking Glass active; full-source fit ${(fit.projectionScale * 100).toFixed(0)}%`
                : 'Looking Glass active'
            );
          } else {
            setLookingGlassStatus(
              'Unverified',
              'XR preview started, but Bridge/display calibration was not detected.',
              true
            );
            this.controlPanel.updateStatus('Looking Glass unverified');
          }
        } else {
          this.controlPanel.updateStatus('Raw XR started');
        }
        refreshXRButtons();
      } catch (err) {
        console.error(err);
        activeMode = null;
        lookingGlassRuntimeSelected =
          lookingGlassRuntimeSelected || this.lookingGlassRuntime.isInstalled;
        // start() may have created a canvas or XRSession before failing.
        await this.rawXR?.stop();
        this.resumeRenderLoop();
        transitioning = false;
        if (mode === 'looking-glass') {
          this.detachLookingGlassPresentationInput();
          const failure = describeLookingGlassFailure(err);
          setLookingGlassStatus(failure.label, failure.detail, true);
          this.controlPanel.updateStatus(`Looking Glass ${failure.label.toLowerCase()}`);
        } else {
          this.controlPanel.updateStatus('Raw XR failed');
        }
        refreshXRButtons();
      }
    };

    rawVrBtn.addEventListener('click', () => {
      void startXR('vr');
    });
    lookingGlassBtn.addEventListener('click', () => {
      void startXR('looking-glass');
    });

    // VR Hints Checkbox
    helpCheckbox.checked = false;
    helpCheckbox.addEventListener('change', () => {
      this.renderScene.setInstructionsVisible(helpCheckbox.checked);
      if (this.rawXR) {
        this.rawXR.setHintsEnabled(activeMode === 'vr' && helpCheckbox.checked);
      }
      this.controlPanel.updateStatus(helpCheckbox.checked ? 'VR hints ON' : 'VR hints OFF');
    });

    setLookingGlassStatus('Monitor', 'Monitor rendering is active.');
    refreshXRButtons();
    usePlayerStore.subscribe(() => refreshXRButtons());

    // SBS Toggle
    sbsBtn.addEventListener('click', () => {
      // toggle
      const enabled = sbsBtn.dataset.enabled === 'true';
      const next = !enabled;
      this.renderScene.setSbsEnabled(next);
      sbsBtn.dataset.enabled = String(next);
      sbsBtn.textContent = next ? 'SBS Stereo (Stop)' : 'SBS Stereo (0DOF)';
      this.controlPanel.updateStatus(next ? 'SBS ON' : 'SBS OFF');

      // フルスクリーンに切り替え（失敗しても無視）
      const canvasContainer = document.querySelector('#canvas-container') as HTMLElement;
      if (next) {
        document.body.classList.add('sbs-active');
        if (canvasContainer.requestFullscreen) {
          canvasContainer.requestFullscreen().catch(() => undefined);
        }
      } else {
        document.body.classList.remove('sbs-active');
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => undefined);
        }
      }
    });
    sbsBtn.dataset.enabled = 'false';
    sbsSwapCheckbox.checked = false;
    sbsSwapCheckbox.addEventListener('change', () => {
      this.renderScene.setSbsSwapEyes(sbsSwapCheckbox.checked);
      if (this.renderScene.isSbsEnabled()) {
        this.controlPanel.updateStatus(sbsSwapCheckbox.checked ? 'SBS swap ON' : 'SBS swap OFF');
      }
    });

    // フルスクリーン解除時はSBSもOFFに戻す
    document.addEventListener('fullscreenchange', () => {
      const inFull = Boolean(document.fullscreenElement);
      // Fullscreen changes the container dimensions without reliably emitting
      // a window resize in every browser. Re-measure now and once after layout.
      this.renderScene.resize();
      window.requestAnimationFrame(() => this.renderScene.resize());
      if (!inFull && this.renderScene.isSbsEnabled()) {
        this.renderScene.setSbsEnabled(false);
        sbsBtn.dataset.enabled = 'false';
        sbsBtn.textContent = 'SBS Stereo (0DOF)';
        document.body.classList.remove('sbs-active');
        this.controlPanel.updateStatus('SBS OFF');
      }
    });
  }

  private async handleFileSelected(file: File): Promise<void> {
    try {
      await this.cleanupSession();
      this.controlPanel.updateStatus(VIDEO_TRANSFER_STATUS);
      const session = await uploadVideo(file);
      this.currentSession = session;
      usePlayerStore.getState().setSession(session);
      usePlayerStore.getState().updateControls({ framingMode: 'source' });
      this.controlPanel.setFramingMode('source');
      this.renderScene.setCalibration(session.calibration);
      this.rawXR?.setCalibration(session.calibration);
      this.controlPanel.updateStatus(
        `Session ${session.sessionId} (${session.displayWidth}x${session.displayHeight})`
      );
      this.openVideo(file);
      this.openDepthStream(session);
    } catch (error) {
      console.error('Failed to create video session', error);
      this.currentSession = null;
      usePlayerStore.getState().setSession(null);
      usePlayerStore.getState().setDepthConnected(false);
      this.controlPanel.updateStatus(describeVideoTransferError(error));
      this.resumeRenderLoop();
    }
  }

  private openVideo(file: File): void {
    const objectUrl = URL.createObjectURL(file);
    this.videoEl.src = objectUrl;
    const onLoaded = () => {
      this.renderScene.updateVideo(this.videoEl);
      this.videoEl.removeEventListener('loadeddata', onLoaded);
      this.startDepthPolling();
      this.startRenderLoop(); // Restart render loop
    };
    this.videoEl.addEventListener('loadeddata', onLoaded);
    this.videoEl.play();
  }

  private openDepthStream(session: SessionInfo): void {
    this.depthClient?.close();
    this.depthClient = new DepthClient(
      session.sessionId,
      () => usePlayerStore.getState().perfSettings,
      () => this.getFrontendFps()
    );
    usePlayerStore.getState().setDepthClient(this.depthClient);
    this.depthClient.onDepth((frame) => this.handleDepthFrame(frame));
    this.depthClient.onStatus(({ connected }) => {
      usePlayerStore.getState().setDepthConnected(connected);
    });
    this.depthClient.connect();
    // Reset buffer on new stream
    this.depthBuffer = new DepthBuffer();
    this.lastAppliedDepthTimestamp = -1;
    this.latestDepthFrame = null;
    this.startHealthReporting();
  }

  private handleDepthFrame(frame: DepthFrame): void {
    const start = performance.now();
    // Store in buffer instead of immediate render
    this.depthBuffer.add(frame);
    this.latestDepthFrame = frame;
    perfStats.add('app.handleDepthFrame', performance.now() - start);

    // Update aspect ratio if needed (only once or if changed)
    // We can do this in render loop or here.
    // Doing it here is fine for metadata.
    const aspect =
      this.currentSession?.calibration.displayWidth &&
      this.currentSession.calibration.displayHeight
        ? this.currentSession.calibration.displayWidth /
          this.currentSession.calibration.displayHeight
        : frame.width / frame.height;
    const controls = this.getEffectiveViewerControls(frame);
    if (
      Math.abs(aspect - this.lastAspect) > 0.01 ||
      controls.targetTriangles !== this.lastTargetTriangles
    ) {
      this.renderScene.updateMeshResolution(aspect, controls);
      this.lastAspect = aspect;
      this.lastTargetTriangles = controls.targetTriangles;
    }
  }

  private startRenderLoop(): void {
    let lastTime = performance.now();
    const loop = () => {
      const now = performance.now();
      perfStats.add('app.renderLoop.dt', now - lastTime);
      lastTime = now;
      this.updateFps();

      if (this.videoEl && !this.videoEl.paused) {
        const timeMs = this.videoEl.currentTime * 1000;
        const frame = this.depthBuffer.getFrame(timeMs);
        if (frame) {
          if (frame.timestampMs !== this.lastAppliedDepthTimestamp) {
            const controls = this.getEffectiveViewerControls(frame);
            this.renderScene.updateDepth(frame, controls);
            this.lastAppliedDepthTimestamp = frame.timestampMs;
            this.frameCount++;
          }
          this.currentSyncDeltaMs = Math.abs(timeMs - frame.timestampMs);
          perfStats.add('app.sync.delta', this.currentSyncDeltaMs);
          perfStats.add('app.sync.miss', 0);
        } else {
          // Only log miss if we actually wanted a frame (video playing)
          // and buffer wasn't empty (if empty, it's starvation, handled below)
          if (this.depthBuffer.bufferSize > 0) {
            perfStats.add('app.sync.miss', 1);
          }
        }

        if (this.depthBuffer.bufferSize === 0) {
          perfStats.add('app.sync.starvation', 1);
        } else {
          perfStats.add('app.sync.starvation', 0);
        }
      }
      this.renderRafId = window.requestAnimationFrame(loop);
    };
    this.renderRafId = window.requestAnimationFrame(loop);
  }

  private pauseRenderLoop(): void {
    if (this.renderRafId !== null) {
      window.cancelAnimationFrame(this.renderRafId);
      this.renderRafId = null;
    }
  }

  private resumeRenderLoop(): void {
    if (this.renderRafId === null) {
      this.startRenderLoop();
    }
  }

  private frameCount = 0;
  private lastFpsUpdate = 0;
  private currentFps = 0;

  public getFrontendFps(): number {
    return this.currentFps;
  }

  private getEffectiveViewerControls(frame = this.latestDepthFrame) {
    const state = usePlayerStore.getState();
    return {
      ...state.viewerControls,
      targetTriangles: getModeTargetTriangles(
        state.perfSettings.mode,
        state.viewerControls.targetTriangles,
        frame?.width,
        frame?.height
      ),
    };
  }

  private updateFps(): void {
    const now = performance.now();
    if (now - this.lastFpsUpdate >= 1000) {
      this.currentFps = this.frameCount;
      this.frameCount = 0;
      this.lastFpsUpdate = now;
    }
  }

  private startDepthPolling(): void {
    if (this.depthRafId !== null) {
      window.cancelAnimationFrame(this.depthRafId);
    }
    const loop = () => {
      const start = performance.now();
      if (!this.depthClient || !this.currentSession) {
        this.depthRafId = null;
        return;
      }

      // Robust Buffering Logic
      const currentTimeMs = this.videoEl.currentTime * 1000;
      const fps = this.currentSession.fps || 30;
      const stepMs = 1000 / fps;

      // Target Buffer: 3 seconds ahead
      const bufferWindowMs = 3000;

      // Latency-aware Lookahead
      // Use measured RTT to determine safe lead time.
      const rtt = this.depthClient.getRTT();
      const { autoLead, depthLeadMs } = usePlayerStore.getState().perfSettings;

      let minLeadMs = 0;
      if (autoLead) {
        // If RTT is 0 (unknown), assume 100ms.
        // If RTT is high (e.g. 4000ms), we must request > 4000ms ahead.
        // BUT, we shouldn't request further than our buffer window (3000ms).
        // If RTT > 3000ms, we are just broken/buffering.
        minLeadMs = Math.min(3000, Math.max(100, rtt + 100));
      } else {
        minLeadMs = depthLeadMs;
      }

      // Timeout for re-requesting: RTT * 2 + buffer
      const timeoutMs = Math.max(1000, rtt * 2 + 500);

      const startMs = Math.max(0, currentTimeMs + minLeadMs);
      // Align startMs to frame grid
      const alignedStartMs = Math.ceil(startMs / stepMs) * stepMs;
      const endMs = alignedStartMs + bufferWindowMs;

      // Send requests respecting maxInflight
      const { maxInflightRequests } = usePlayerStore.getState().perfSettings;

      // Flow Control: Only send if we have room in inflight
      const currentInflight = this.depthClient.getInflightCount();
      const availableSlots = Math.max(0, maxInflightRequests - currentInflight);

      if (availableSlots > 0) {
        // Get missing frames, limited by available slots
        const missing = this.depthBuffer.getMissing(alignedStartMs, endMs, stepMs, timeoutMs);
        const batch = missing.slice(0, availableSlots);

        if (batch.length > 0 && import.meta.env.DEV) {
          console.debug(`[App] RTT=${rtt.toFixed(0)}ms Lead=${minLeadMs.toFixed(0)}ms Inflight=${currentInflight}/${maxInflightRequests} Req=${batch.length} Missing=${missing.length}`);
        }

        for (const t of batch) {
          this.depthClient.requestDepth(t);
        }
        // Reserve only requests that were actually admitted by flow control.
        // getMissing() can return the whole look-ahead window, which is larger
        // than the available slots on most frames.
        this.depthBuffer.markRequested(batch);
      }

      // Cleanup old requests
      this.depthBuffer.cleanup(currentTimeMs);

      this.depthRafId = window.requestAnimationFrame(loop);
      perfStats.add('app.depthPolling', performance.now() - start);
    };
    this.depthRafId = window.requestAnimationFrame(loop);
  }

  private async cleanupSession(): Promise<void> {
    // Pause video immediately to stop rendering loop from asking for more frames
    if (this.videoEl) {
      this.videoEl.pause();
    }

    // XR owns its own canvas and reads the current session/depth buffer.
    // End it before replacing or deleting those resources.
    this.detachLookingGlassPresentationInput();
    await this.rawXR?.stop();

    const currentSession = this.currentSession;
    this.currentSession = null;
    usePlayerStore.getState().setSession(null);
    usePlayerStore.getState().setDepthConnected(false);
    if (currentSession) {
      try {
        await deleteSession(currentSession.sessionId);
      } catch (e) {
        console.warn('Failed to delete session', e);
      }
    }
    this.depthClient?.close();
    this.depthClient = null;
    usePlayerStore.getState().setDepthClient(null);
    if (this.depthRafId !== null) {
      window.cancelAnimationFrame(this.depthRafId);
      this.depthRafId = null;
    }
    if (this.renderRafId !== null) {
      window.cancelAnimationFrame(this.renderRafId);
      this.renderRafId = null;
    }
    this.depthBuffer = new DepthBuffer();
    this.lastAppliedDepthTimestamp = -1;
    this.latestDepthFrame = null;
    this.lastTargetTriangles = 0;
    this.renderScene.setCalibration(null);
    this.rawXR?.setCalibration(null);
    if (this.healthIntervalId !== null) {
      window.clearInterval(this.healthIntervalId);
      this.healthIntervalId = null;
    }
  }

  private handleVideoEnded(): void {
    // Reset playback position and depth buffers so replay works
    this.depthBuffer.clear();
    this.lastAppliedDepthTimestamp = -1;
    this.latestDepthFrame = null;
    this.suppressSeekRefresh = true;
    this.videoEl.currentTime = 0;
    // Refresh depth stream connection to drop pending/inflight safely
    if (this.depthClient) {
      this.depthClient.close();
      this.depthClient.connect();
    }
    // Let the user press play again; depth polling loop will pick up from t=0
  }

  private handleVideoSeeked(): void {
    if (this.suppressSeekRefresh) {
      this.suppressSeekRefresh = false;
      return;
    }
    if (!this.depthClient || !this.currentSession) return;
    // Drop stale future requests and frames after explicit timeline jumps.
    this.depthBuffer.clear();
    this.lastAppliedDepthTimestamp = -1;
    this.latestDepthFrame = null;
    this.depthClient.close();
    this.depthClient.connect();
  }

  private healthIntervalId: number | null = null;

  private startHealthReporting(): void {
    if (this.healthIntervalId !== null) clearInterval(this.healthIntervalId);

    this.healthIntervalId = window.setInterval(() => {
      if (!this.depthClient || !this.currentSession) return;

      const bufferSize = this.depthBuffer.bufferSize;
      const rtt = this.depthClient.getRTT();
      const jitter = this.depthClient.getJitter();
      const inflight = this.depthClient.getInflightCount();

      const msg = `[Health] Buffer=${bufferSize} RTT=${rtt.toFixed(0)}ms Jitter=${jitter.toFixed(1)}ms Inflight=${inflight}`;

      const isDebug = new URLSearchParams(window.location.search).get('debug') === 'true';
      if (isDebug) {
        console.log(msg);
      }

      // Send to backend for centralized logging
      fetch(apiUrl('/api/log'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      }).catch(() => { }); // Ignore errors
    }, 5000);
  }
}
