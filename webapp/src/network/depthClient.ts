import pako from 'pako';
import type { DepthFrame, DepthStatus, PerfSettings } from '../types';
import { DEPTH_HEADER_SIZE, DEPTH_MAGIC, DEPTH_MAGIC_COMPRESSED } from '../types';
import { wsUrl } from '../utils/env';
import { getSessionStatus } from './sessionApi';

type DepthListener = (frame: DepthFrame) => void;
type StatusListener = (state: { connected: boolean }) => void;

export class DepthClient {
  private socket: WebSocket | null = null;
  private listeners: Set<DepthListener> = new Set();
  private statusListeners: Set<StatusListener> = new Set();
  private inflight = 0;
  private pending: number[] = [];
  private droppedFrames = 0;
  private lastTimestampMs = -1;
  private sessionId: string;
  private requestTimes = new Map<number, number>();
  private rtt = 0;
  private rttAlpha = 0.1; // EMA factor
  // debug counters (currently unused)
  private dbg = { recv: 0, droppedUnknown: 0, droppedVersion: 0, droppedOrder: 0 };

  constructor(sessionId: string, _getPerfSettings: () => PerfSettings) {
    this.sessionId = sessionId;
  }

  connect(): void {
    const url = wsUrl(`/api/sessions/${this.sessionId}/stream`);
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onopen = () => {
      if (import.meta.env.DEV) console.debug('depth ws open');
      this.emitStatus(true);
      this.flushQueue();
    };
    this.socket.onclose = () => {
      if (import.meta.env.DEV) console.debug('depth ws closed');
      this.emitStatus(false);
    };
    this.socket.onerror = (event) => {
      console.error('depth ws error', event);
      this.emitStatus(false);
    };
    this.socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const payload = JSON.parse(event.data);
        if (payload.type === 'error') {
          console.error('Depth stream error', payload.message);
        }
        this.decrementInflight();
        this.flushQueue();
        return;
      }
      this.decrementInflight();
      this.updateJitter();
      const frame = this.parseDepthFrame(event.data as ArrayBuffer);
      if (frame) {
        // Calculate RTT
        const start = this.requestTimes.get(frame.timestampMs);
        if (start) {
          const duration = performance.now() - start;
          this.requestTimes.delete(frame.timestampMs);

          // Update EMA RTT
          // Ignore initial large spikes (e.g. model loading > 2s) to prevent skewing
          // But if it's consistently high, we should eventually adapt?
          // Let's cap the single-sample contribution.
          // Or just ignore if > 5000ms and we have a low RTT?
          // If RTT is 0 (init), we take it.

          if (this.rtt === 0) {
            // First sample. If it's huge (model load), maybe clamp it?
            // If we set it to 16s, we are screwed for 30 frames.
            // Let's clamp init to 1000ms max.
            this.rtt = Math.min(1000, duration);
          } else {
            // If duration is huge (e.g. 10s) but current rtt is small (100ms), 
            // it's likely a hiccup or model load. Ignore or clamp.
            // If duration is small but rtt is huge, we want to decay fast.

            // Clamp duration to max 2000ms for update purposes?
            // This prevents one huge spike from ruining the average.
            const clampedDuration = Math.min(2000, duration);
            this.rtt = this.rtt * (1 - this.rttAlpha) + clampedDuration * this.rttAlpha;
          }
        }

        if (import.meta.env.DEV) {
          console.debug('depth frame', frame.width, frame.height, frame.zMax);
          if (this.droppedFrames > 0) {
            console.debug('depth frames dropped', this.droppedFrames);
            this.droppedFrames = 0;
          }
        }
        this.listeners.forEach((cb) => cb(frame));
      } else {
        // drop debug removed to avoid noisy console
      }
      this.flushQueue();
    };
  }

  close(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.pending = [];
    this.inflight = 0;
  }

  requestDepth(timeMs: number): void {
    this.enqueueRequest(timeMs);
    this.flushQueue();
  }

  onDepth(cb: DepthListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private emitStatus(connected: boolean): void {
    this.statusListeners.forEach((cb) => cb({ connected }));
  }

  private flushQueue(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    // const settings = this.getPerfSettings(); // Original code used this for maxInflight
    // We ignore maxInflight here because the App controls it.
    // We just send whatever is in pending.
    // But we should still respect a hard limit to prevent socket overflow?
    // Let's trust the App.

    while (this.pending.length > 0) {
      const target = this.pending.shift();
      if (target == null) break;
      this.inflight += 1;
      const now = performance.now();
      this.requestTimes.set(target, now); // Record send time
      this.socket.send(JSON.stringify({ time_ms: target }));
      if (import.meta.env.DEV) {
        // console.debug(`[DepthClient] Sent request for ${target}ms. Inflight: ${this.inflight}`);
      }
    }
  }

  public getInflightCount(): number {
    return this.inflight;
  }

  public getRTT(): number {
    return this.rtt;
  }

  private lastArrival = 0;
  private arrivalDeltas: number[] = [];

  public getJitter(): number {
    if (this.arrivalDeltas.length < 2) return 0;
    const sum = this.arrivalDeltas.reduce((a, b) => a + b, 0);
    const avg = sum / this.arrivalDeltas.length;
    const sqDiff = this.arrivalDeltas.reduce((a, b) => a + Math.pow(b - avg, 2), 0);
    return Math.sqrt(sqDiff / this.arrivalDeltas.length);
  }

  private updateJitter() {
    const now = performance.now();
    if (this.lastArrival > 0) {
      const delta = now - this.lastArrival;
      this.arrivalDeltas.push(delta);
      if (this.arrivalDeltas.length > 30) this.arrivalDeltas.shift();
    }
    this.lastArrival = now;
  }

  private enqueueRequest(timeMs: number): void {
    // const settings = this.getPerfSettings();
    // maxInflight is no longer used for queue sizing here, we use a fixed small buffer.
    // const maxInflight = Math.max(1, Math.floor(settings.maxInflightRequests));
    // Keep the pending queue very short to ensure freshness.
    // If we have more than 2 pending requests, we are already lagging.
    // Drop the oldest pending request to make room for the new one.
    // UPDATE: Increased to 60 to work with DepthBuffer flow control.
    // We rely on the app to throttle requests based on inflight count.
    const maxPending = 60; // short queue to keep freshness

    this.pending.push(timeMs);
    if (import.meta.env.DEV) {
      // console.debug(`[DepthClient] Enqueued ${timeMs}ms. Pending: ${this.pending.length}`);
    }

    while (this.pending.length > maxPending) {
      // Drop the oldest request (FIFO drop) to prioritize newer ones
      const droppedTime = this.pending.shift();
      if (droppedTime != null) {
        this.requestTimes.delete(droppedTime); // Remove from RTT tracking if dropped
      }
      if (import.meta.env.DEV) {
        this.droppedFrames += 1;
      }
    }

    // Safety: If we have high inflight but haven't received anything for a while,
    // we might be deadlocked.
    // This is a heuristic: if we are at max inflight, and pending queue is full,
    // and we haven't seen a response in > 2 seconds, reset inflight?
    // Better implemented in a watchdog or heartbeat.
    // For now, relying on backend queue size increase.
  }

  private decrementInflight(): void {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  // debug logging removed

  private parseDepthFrame(buffer: ArrayBuffer): DepthFrame | null {
    if (buffer.byteLength < DEPTH_HEADER_SIZE) return null;

    const view = new DataView(buffer, 0, DEPTH_HEADER_SIZE);
    const magic = new TextDecoder('ascii').decode(buffer.slice(0, 4));

    let samples: Uint16Array;

    if (magic === DEPTH_MAGIC_COMPRESSED) {
      try {
        const compressedData = new Uint8Array(buffer, DEPTH_HEADER_SIZE);
        const decompressedData = pako.inflate(compressedData);
        samples = new Uint16Array(decompressedData.buffer);
      } catch (err) {
        console.error('Decompression failed', err);
        return null;
      }
    } else if (magic === DEPTH_MAGIC) {
      samples = new Uint16Array(buffer, DEPTH_HEADER_SIZE);
    } else {
      this.dbg.droppedUnknown += 1;
      return null;
    }

    const version = view.getUint16(4, true);
    if (version !== 1) {
      this.dbg.droppedVersion += 1;
    }
    const timestampMs = view.getUint32(8, true);

    // Discard out-of-order frames, BUT allow large backward jumps (seek/rewind)
    // If timestamp is significantly smaller (e.g. > 500ms diff), assume it's a seek.
    const isSeek = (this.lastTimestampMs - timestampMs) > 500;

    if (timestampMs < this.lastTimestampMs && !isSeek) {
      this.dbg.droppedOrder += 1;
      return null;
    }
    this.lastTimestampMs = timestampMs;

    const width = view.getUint32(12, true);
    const height = view.getUint32(16, true);
    const scale = view.getFloat32(20, true);
    const bias = view.getFloat32(24, true);
    const zMax = view.getFloat32(28, true);

    const data = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      data[i] = samples[i] * scale + bias;
    }
    return {
      timestampMs,
      width,
      height,
      data,
      scale,
      bias,
      zMax,
    };
  }

  async getStats(): Promise<DepthStatus | null> {
    try {
      return await getSessionStatus(this.sessionId);
    } catch (e) {
      console.error('getStats error', e);
      return null;
    }
  }
}
