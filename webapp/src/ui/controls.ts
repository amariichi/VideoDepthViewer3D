import GUI from 'lil-gui';
import { usePlayerStore } from '../state/playerStore';
import type { ViewFramingMode } from '../types';

interface ControlCallbacks {
  onFileSelected: (file: File) => Promise<void>;
  getFrontendFps: () => number;
  getSyncDeltaMs: () => number;
  getViewDistance: () => number;
  onViewDistanceChanged: (distance: number) => void;
  getModelZOffset: () => number;
  onModelZOffsetChanged: (offset: number) => void;
}

interface ControlElements {
  fileInput: HTMLInputElement;
  status: HTMLElement;
  depthGui: HTMLElement;
  perfGui: HTMLElement;
}

export class ControlPanel {
  private depthGui: GUI;
  private perfGui: GUI;
  private elements: ControlElements;
  private callbacks: ControlCallbacks;
  private framingState: { framingMode: ViewFramingMode } = { framingMode: 'source' };
  private viewDistanceState = { cameraDistance: 3.5 };
  private modelZState = { modelZOffset: 0 };
  private framingModeController: ReturnType<GUI['add']> | null = null;
  private cameraDistanceController: ReturnType<GUI['add']> | null = null;
  private modelZController: ReturnType<GUI['add']> | null = null;

  constructor(elements: ControlElements, callbacks: ControlCallbacks) {
    this.elements = elements;
    this.callbacks = callbacks;
    this.framingState.framingMode = usePlayerStore.getState().viewerControls.framingMode;
    this.viewDistanceState.cameraDistance = this.callbacks.getViewDistance();
    this.modelZState.modelZOffset = this.callbacks.getModelZOffset();
    this.depthGui = new GUI({ container: elements.depthGui, title: 'Depth Controls' });
    this.perfGui = new GUI({ container: elements.perfGui, title: 'Performance' });
    this.mountFileInput();
    this.mountSliders();
  }

  private mountFileInput(): void {
    this.elements.fileInput.addEventListener('change', async (event) => {
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      await this.callbacks.onFileSelected(file);
      input.value = '';
    });
  }

  private mountSliders(): void {
    const store = usePlayerStore.getState();
    const folder = this.depthGui; // no extra nesting
    folder
      .add(store.viewerControls, 'projectionMode', {
        'Calibrated Pinhole': 'pinhole',
        'Creative Relief': 'relief',
      })
      .name('Projection')
      .onChange((value: 'relief' | 'pinhole') => {
        if (value === 'relief') {
          this.setFramingMode('orbit');
          usePlayerStore.getState().updateControls({
            projectionMode: value,
            framingMode: 'orbit',
          });
          return;
        }
        usePlayerStore.getState().updateControls({ projectionMode: value });
      });
    this.framingModeController = folder
      .add(this.framingState, 'framingMode', {
        'Auto Source View': 'source',
        'Free Orbit': 'orbit',
      })
      .name('Framing')
      .onChange((value: ViewFramingMode) => {
        this.setFramingMode(value);
        usePlayerStore.getState().updateControls({ framingMode: value });
      });
    const meshFolder = folder.addFolder('Advanced / Mesh');
    meshFolder.add(store.viewerControls, 'targetTriangles', 50_000, 300_000, 10_000).name('Manual target tris').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ targetTriangles: value });
    });
    folder.add(store.viewerControls, 'sourceFovY', 30, 100, 1).name('Source FOV Y').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ sourceFovY: value });
    });
    const placementFolder = folder.addFolder('View Placement');
    placementFolder.add(store.viewerControls, 'fovY', 30, 140, 1).name('Min View FOV Y').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ fovY: value });
    });
    this.cameraDistanceController = placementFolder.add(this.viewDistanceState, 'cameraDistance', 0.2, 50.0, 0.05).name('Orbit Distance').onChange((value: number) => {
      this.callbacks.onViewDistanceChanged(value);
    });
    this.modelZController = placementFolder.add(this.modelZState, 'modelZOffset', -5.0, 50.0, 0.05).name('Model Z Offset').onChange((value: number) => {
      this.callbacks.onModelZOffsetChanged(value);
    });
    this.updatePlacementControlsAvailability();
    const creativeFolder = folder.addFolder('Advanced / Creative Relief');
    creativeFolder.add(store.viewerControls, 'zScale', 0.5, 5.0, 0.05).name('Z Scale').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ zScale: value });
    });
    creativeFolder.add(store.viewerControls, 'zBias', -5.0, 5.0, 0.1).name('Z Bias').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ zBias: value });
    });
    creativeFolder.add(store.viewerControls, 'zGamma', 0.5, 2.5, 0.05).name('Z Gamma').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ zGamma: value });
    });
    folder.add(store.viewerControls, 'zMaxClip', 5, 100, 1).name('Z Max Clip').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ zMaxClip: value });
    });
    creativeFolder.add(store.viewerControls, 'planeScale', 0.5, 3.5, 0.1).name('Plane Scale').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ planeScale: value });
    });
    placementFolder.add(store.viewerControls, 'yOffset', 0.0, 2.0, 0.05).name('Y Offset').onChange((value: number) => {
      this.setFramingMode('orbit');
      usePlayerStore.getState().updateControls({ framingMode: 'orbit', yOffset: value });
    });
    meshFolder.close();
    placementFolder.close();
    creativeFolder.close();

    const perfFolder = this.perfGui; // no extra nesting
    perfFolder
      .add(store.perfSettings, 'mode', {
        'Auto Smooth': 'smooth',
        'Auto Balanced': 'balanced',
        'Auto Quality': 'quality',
        'Manual / Creative': 'manual',
      })
      .name('Mode')
      .onChange((value: 'smooth' | 'balanced' | 'quality' | 'manual') => {
        usePlayerStore.getState().updatePerfSettings({ mode: value });
      });
    perfFolder
      .add(store.perfSettings, 'autoLead')
      .name('Auto Lead')
      .onChange((value: boolean) => {
        usePlayerStore.getState().updatePerfSettings({ autoLead: value });
        leadController.disable(value);
      });

    const leadController = perfFolder
      .add(store.perfSettings, 'depthLeadMs', 0, 6000, 10)
      .name('Depth lead (ms)')
      .onChange((value: number) => {
        usePlayerStore.getState().updatePerfSettings({ depthLeadMs: value });
      });
    leadController.disable(store.perfSettings.autoLead);

    perfFolder
      .add(store.perfSettings, 'maxInflightRequests', 1, 50, 1)
      .name('Max inflight requests')
      .onChange((value: number) => {
        usePlayerStore.getState().updatePerfSettings({ maxInflightRequests: value });
      });

    const stats = {
      queue: 0,
      infer: 0,
      pack: 0,
      send: 0,
      decode: 0,
      inflight: 0,
      res: 0,
      downsample: 0,
      payloadKb: 0,
      mode: '-',
      encoding: '-',
      limiting: '-',
      calibration: '-',
      fps: 0,
      syncMs: 0,
    };
    const monitorFolder = perfFolder.addFolder('Live Telemetry');
    monitorFolder.add(stats, 'queue').name('Queue (s)').listen().disable();
    monitorFolder.add(stats, 'decode').name('Decode (s)').listen().disable();
    monitorFolder.add(stats, 'infer').name('Infer (s)').listen().disable();
    monitorFolder.add(stats, 'pack').name('Pack (s)').listen().disable();
    monitorFolder.add(stats, 'send').name('Send (s)').listen().disable();
    monitorFolder.add(stats, 'inflight').name('Inflight').listen().disable();
    monitorFolder.add(stats, 'res').name('Resolution').listen().disable();
    monitorFolder.add(stats, 'downsample').name('Downsample').listen().disable();
    monitorFolder.add(stats, 'payloadKb').name('Payload (KiB)').listen().disable();
    monitorFolder.add(stats, 'mode').name('Mode').listen().disable();
    monitorFolder.add(stats, 'encoding').name('Encoding').listen().disable();
    monitorFolder.add(stats, 'limiting').name('Limiter').listen().disable();
    monitorFolder.add(stats, 'calibration').name('Calibration').listen().disable();
    monitorFolder.add(stats, 'fps').name('Depth FPS').listen().disable();
    monitorFolder.add(stats, 'syncMs').name('Sync delta (ms)').listen().disable();

    setInterval(async () => {
      const client = usePlayerStore.getState().depthClient;
      if (client) {
        const data = await client.getStats();
        if (data && data.telemetry) {
          // console.debug('Telemetry update', data.telemetry);
          stats.queue = parseFloat(data.telemetry.queue_wait_s?.toFixed(3) ?? '0');
          stats.decode = parseFloat(data.telemetry.decode_s?.toFixed(3) ?? '0');
          stats.infer = parseFloat(data.telemetry.infer_s?.toFixed(3) ?? '0');
          stats.pack = parseFloat(data.telemetry.pack_s?.toFixed(3) ?? '0');
          stats.send = parseFloat(data.telemetry.ws_send_s?.toFixed(3) ?? '0');
          stats.inflight = Math.trunc(data.telemetry.inflight_used ?? 0);
        }
        if (data && data.config) {
          stats.res = Math.trunc(data.config.process_res ?? 0);
          stats.downsample = Math.trunc(data.config.downsample_factor ?? 0);
          stats.mode = data.config.mode ?? '-';
          stats.encoding = data.config.encoding ?? '-';
          stats.limiting = data.config.limiting_stage ?? '-';
        }
        if (data?.calibration) {
          stats.calibration = `${data.calibration.origin} ${Math.round(
            data.calibration.confidence * 100
          )}%`;
        }
        if (data && data.rolling_stats) {
          stats.payloadKb = parseFloat(
            ((data.rolling_stats.payload_avg_bytes ?? 0) / 1024).toFixed(1)
          );
        }
      }
      stats.fps = this.callbacks.getFrontendFps();
      stats.syncMs = parseFloat(this.callbacks.getSyncDeltaMs().toFixed(1));
    }, 500);

    perfFolder.close();
  }

  updateStatus(message: string): void {
    this.elements.status.textContent = message;
  }

  setViewDistance(distance: number): void {
    this.viewDistanceState.cameraDistance = distance;
    this.cameraDistanceController?.updateDisplay();
  }

  setModelZOffset(offset: number): void {
    this.modelZState.modelZOffset = offset;
    this.modelZController?.updateDisplay();
  }

  setFramingMode(mode: ViewFramingMode): void {
    this.framingState.framingMode = mode;
    this.framingModeController?.updateDisplay();
    this.updatePlacementControlsAvailability();
  }

  private updatePlacementControlsAvailability(): void {
    const sourceViewOwnsPlacement = this.framingState.framingMode === 'source';
    this.cameraDistanceController?.disable(sourceViewOwnsPlacement);
    this.modelZController?.disable(sourceViewOwnsPlacement);
  }
}
