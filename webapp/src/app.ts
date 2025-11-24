import { ControlPanel } from './ui/controls';
import { uploadVideo, deleteSession } from './network/sessionApi';
import { DepthClient } from './network/depthClient';
import { RenderScene } from './render/scene';
import { usePlayerStore } from './state/playerStore';
import { RawXRTest } from './xrTest';
import type { SessionInfo, DepthFrame } from './types';

import { DepthBuffer } from './utils/depthBuffer';
import { perfStats } from './utils/perfStats';

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
  private rawXR: RawXRTest | null = null;

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
      }
    );

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



    usePlayerStore.subscribe((state) => {
      this.renderScene.updateControls(state.viewerControls);
    });

    this.mountXRButtons();

    // ダブルクリックでビューを初期状態に戻す
    canvasContainer.addEventListener('dblclick', () => {
      this.renderScene.resetView();
    });

    this.startRenderLoop();
  }

  private mountXRButtons(): void {
    const rawVrBtn = document.getElementById('btn-vr') as HTMLButtonElement;
    const helpCheckbox = document.getElementById('chk-hints') as HTMLInputElement;
    const sbsBtn = document.getElementById('btn-sbs') as HTMLButtonElement;

    if (!rawVrBtn || !helpCheckbox || !sbsBtn) {
      console.warn('XR buttons not found in DOM');
      return;
    }

    // VR button (RawXR only)
    rawVrBtn.disabled = true;
    rawVrBtn.addEventListener('click', async () => {
      if (!this.rawXR) {
        this.rawXR = new RawXRTest(document.querySelector('#canvas-container') as HTMLElement);
      }
      this.rawXR.setVideo(this.videoEl);
      this.rawXR.setControlsGetter(() => usePlayerStore.getState().viewerControls);
      this.rawXR.setDepthBuffer(this.depthBuffer);
      this.rawXR.setSessionEndedCallback(() => this.resumeRenderLoop());
      this.rawXR.enableDepthMesh();
      this.rawXR.setHintsEnabled(helpCheckbox.checked);
      try {
        this.pauseRenderLoop();
        await this.rawXR.start();
        this.controlPanel.updateStatus('Raw XR started');
      } catch (err) {
        console.error(err);
        this.controlPanel.updateStatus('Raw XR failed');
      }
    });

    // VR Hints Checkbox
    helpCheckbox.checked = false;
    helpCheckbox.addEventListener('change', () => {
      this.renderScene.setInstructionsVisible(helpCheckbox.checked);
      if (this.rawXR) {
        this.rawXR.setHintsEnabled(helpCheckbox.checked);
      }
      this.controlPanel.updateStatus(helpCheckbox.checked ? 'VR hints ON' : 'VR hints OFF');
    });

    // Enable VR button only after a session (video) is ready
    usePlayerStore.subscribe((state) => {
      rawVrBtn.disabled = !state.session;
    });

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

    // フルスクリーン解除時はSBSもOFFに戻す
    document.addEventListener('fullscreenchange', () => {
      const inFull = Boolean(document.fullscreenElement);
      if (!inFull && this.renderScene.isSbsEnabled()) {
        this.renderScene.setSbsEnabled(false);
        this.renderScene.resize();
        sbsBtn.dataset.enabled = 'false';
        sbsBtn.textContent = 'SBS Stereo (0DOF)';
        document.body.classList.remove('sbs-active');
        this.controlPanel.updateStatus('SBS OFF');
      }
    });
  }

  private async handleFileSelected(file: File): Promise<void> {
    await this.cleanupSession();
    this.controlPanel.updateStatus('アップロード中...');
    const session = await uploadVideo(file);
    this.currentSession = session;
    usePlayerStore.getState().setSession(session);
    this.controlPanel.updateStatus(`Session ${session.sessionId} (${session.width}x${session.height})`);
    this.openVideo(file);
    this.openDepthStream(session);
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
    this.videoEl.addEventListener('ended', () => this.handleVideoEnded());
    this.videoEl.play();
  }

  private openDepthStream(session: SessionInfo): void {
    this.depthClient?.close();
    this.depthClient = new DepthClient(session.sessionId, () => usePlayerStore.getState().perfSettings);
    usePlayerStore.getState().setDepthClient(this.depthClient);
    this.depthClient.onDepth((frame) => this.handleDepthFrame(frame));
    this.depthClient.onStatus(({ connected }) => {
      usePlayerStore.getState().setDepthConnected(connected);
    });
    this.depthClient.connect();
    // Reset buffer on new stream
    this.depthBuffer = new DepthBuffer();
    this.startHealthReporting();
  }

  private handleDepthFrame(frame: DepthFrame): void {
    const start = performance.now();
    // Store in buffer instead of immediate render
    this.depthBuffer.add(frame);
    perfStats.add('app.handleDepthFrame', performance.now() - start);

    // Update aspect ratio if needed (only once or if changed)
    // We can do this in render loop or here.
    // Doing it here is fine for metadata.
    const aspect = frame.width / frame.height;
    if (Math.abs(aspect - this.lastAspect) > 0.01) {
      const controls = usePlayerStore.getState().viewerControls;
      this.renderScene.updateMeshResolution(aspect, controls);
      this.lastAspect = aspect;
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
          const controls = usePlayerStore.getState().viewerControls;
          this.renderScene.updateDepth(frame, controls);
          perfStats.add('app.sync.delta', Math.abs(timeMs - frame.timestampMs));
          perfStats.add('app.sync.miss', 0);
          this.frameCount++;
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

    if (this.currentSession) {
      try {
        await deleteSession(this.currentSession.sessionId);
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
    if (this.healthIntervalId !== null) {
      window.clearInterval(this.healthIntervalId);
      this.healthIntervalId = null;
    }
  }

  private handleVideoEnded(): void {
    // Reset playback position and depth buffers so replay works
    this.depthBuffer.clear();
    this.videoEl.currentTime = 0;
    // Refresh depth stream connection to drop pending/inflight safely
    if (this.depthClient) {
      this.depthClient.close();
      this.depthClient.connect();
    }
    // Let the user press play again; depth polling loop will pick up from t=0
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
      // const fps = 0; // TODO: Implement FPS tracking in DepthClient if needed

      const msg = `[Health] Buffer=${bufferSize} RTT=${rtt.toFixed(0)}ms Jitter=${jitter.toFixed(1)}ms Inflight=${inflight}`;

      const isDebug = new URLSearchParams(window.location.search).get('debug') === 'true';
      if (isDebug) {
        console.log(msg);
      }

      // Send to backend for centralized logging
      fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      }).catch(() => { }); // Ignore errors
    }, 5000);
  }
}
