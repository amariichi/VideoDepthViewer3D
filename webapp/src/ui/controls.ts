import GUI from 'lil-gui';
import { usePlayerStore } from '../state/playerStore';

interface ControlCallbacks {
  onFileSelected: (file: File) => Promise<void>;
  getFrontendFps: () => number;
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

  constructor(elements: ControlElements, callbacks: ControlCallbacks) {
    this.elements = elements;
    this.callbacks = callbacks;
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
    folder.add(store.viewerControls, 'targetTriangles', 50_000, 300_000, 10_000).name('Target tris').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ targetTriangles: value });
    });
    folder.add(store.viewerControls, 'fovY', 30, 90, 1).name('FOV Y').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ fovY: value });
    });
    folder.add(store.viewerControls, 'zScale', 0.5, 5.0, 0.05).name('Z Scale').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ zScale: value });
    });
    folder.add(store.viewerControls, 'zBias', -5.0, 5.0, 0.1).name('Z Bias').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ zBias: value });
    });
    folder.add(store.viewerControls, 'zGamma', 0.5, 2.5, 0.05).name('Z Gamma').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ zGamma: value });
    });
    folder.add(store.viewerControls, 'zMaxClip', 5, 100, 1).name('Z Max Clip').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ zMaxClip: value });
    });
    folder.add(store.viewerControls, 'planeScale', 0.5, 3.5, 0.1).name('Plane Scale').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ planeScale: value });
    });
    folder.add(store.viewerControls, 'yOffset', 0.0, 2.0, 0.05).name('Y Offset').onChange((value: number) => {
      usePlayerStore.getState().updateControls({ yOffset: value });
    });

    const perfFolder = this.perfGui; // no extra nesting
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
      fps: 0,
    };
    const monitorFolder = perfFolder.addFolder('Live Telemetry');
    monitorFolder.add(stats, 'queue').name('Queue (s)').listen().disable();
    monitorFolder.add(stats, 'decode').name('Decode (s)').listen().disable();
    monitorFolder.add(stats, 'infer').name('Infer (s)').listen().disable();
    monitorFolder.add(stats, 'pack').name('Pack (s)').listen().disable();
    monitorFolder.add(stats, 'send').name('Send (s)').listen().disable();
    monitorFolder.add(stats, 'inflight').name('Inflight').listen().disable();
    monitorFolder.add(stats, 'res').name('Resolution').listen().disable();
    monitorFolder.add(stats, 'fps').name('Depth FPS').listen().disable();

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
          stats.inflight = parseInt(data.telemetry.inflight_used ?? '0');
        }
        if (data && data.config) {
          stats.res = parseInt(data.config.process_res ?? '0');
        }
        if (data && data.rolling_stats) {
          // stats.fps = parseFloat(data.rolling_stats.depth_fps?.toFixed(1) ?? '0');
        }
      }
      stats.fps = this.callbacks.getFrontendFps();
    }, 500);

    perfFolder.close();
  }

  updateStatus(message: string): void {
    this.elements.status.textContent = message;
  }
}
