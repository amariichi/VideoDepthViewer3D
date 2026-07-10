import type { DepthFrame, DepthStatus, PerfSettings } from '../types';
import { wsUrl } from '../utils/env';
import { getSessionStatus } from './sessionApi';
import { decodeDepthPacket } from './depthPacket';

type DepthListener = (frame: DepthFrame) => void;
type StatusListener = (state: { connected: boolean }) => void;

export class DepthClient {
  private socket: WebSocket | null = null;
  private listeners: Set<DepthListener> = new Set();
  private statusListeners: Set<StatusListener> = new Set();
  private inflight = 0;
  private pending: number[] = [];
  private droppedFrames = 0;
  private sessionId: string;
  private getPerfSettings: () => PerfSettings;
  private getAppliedFps: () => number;
  private requestTimes = new Map<number, number>();
  private rtt = 0;
  private rttAlpha = 0.1; // EMA factor
  // debug counters (currently unused)
  private dbg = { droppedUnknown: 0 };

  constructor(
    sessionId: string,
    getPerfSettings: () => PerfSettings,
    getAppliedFps: () => number = () => 0
  ) {
    this.sessionId = sessionId;
    this.getPerfSettings = getPerfSettings;
    this.getAppliedFps = getAppliedFps;
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
        try {
          const payload = JSON.parse(event.data) as {
            type?: string;
            message?: string;
            time_ms?: number;
          };
          if (payload.type === 'error') {
            console.error('Depth stream error', payload.message);
          }
          if (Number.isFinite(payload.time_ms)) {
            this.takeRequestStart(Number(payload.time_ms));
          } else {
            this.decrementInflight();
          }
        } catch (error) {
          console.error('Invalid depth stream message', error);
          this.decrementInflight();
        }
        this.flushQueue();
        return;
      }
      this.updateJitter();
      const frame = this.parseDepthFrame(event.data as ArrayBuffer);
      if (frame) {
        // Calculate RTT
        const start = this.takeRequestStart(frame.timestampMs);
        if (start !== null) {
          const duration = performance.now() - start;

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
        // A binary response consumes one request even when its packet is
        // malformed. Otherwise flow control remains saturated until the stale
        // request watchdog fires (at least two seconds later).
        this.decrementInflight();
      }
      this.flushQueue();
    };
  }

  close(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.resetStreamState();
  }

  resetStreamState(): void {
    this.pending = [];
    this.inflight = 0;
    this.droppedFrames = 0;
    this.requestTimes.clear();
    this.rtt = 0;
    this.lastArrival = 0;
    this.arrivalDeltas = [];
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
      const settings = this.getPerfSettings();
      this.socket.send(
        JSON.stringify({
          time_ms: target,
          rtt: this.rtt,
          performance_mode: settings.mode,
          applied_fps: this.getAppliedFps(),
        })
      );
      if (import.meta.env.DEV) {
        // console.debug(`[DepthClient] Sent request for ${target}ms. Inflight: ${this.inflight}`);
      }
    }
  }

  public getInflightCount(): number {
    this.pruneStaleRequests();
    this.inflight = this.requestTimes.size;
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
    const oldest = this.requestTimes.keys().next().value as number | undefined;
    if (oldest !== undefined) this.requestTimes.delete(oldest);
    this.inflight = this.requestTimes.size;
  }

  // debug logging removed

  private parseDepthFrame(buffer: ArrayBuffer): DepthFrame | null {
    const frame = decodeDepthPacket(buffer);
    if (!frame) {
      this.dbg.droppedUnknown += 1;
      return null;
    }
    // Parallel decode/inference completes out of request order by design. The
    // playback buffer inserts by timestamp, so accepting every valid response
    // avoids both holes and head-of-line blocking. Explicit seeks reconnect and
    // clear the buffer in VideoDepthApp.
    return frame;
  }

  private takeRequestStart(timestampMs: number): number | null {
    this.pruneStaleRequests();
    const exact = this.requestTimes.get(timestampMs);
    if (exact !== undefined) {
      this.requestTimes.delete(timestampMs);
      this.inflight = this.requestTimes.size;
      return exact;
    }
    let closestKey: number | null = null;
    let closestDelta = 50;
    for (const key of this.requestTimes.keys()) {
      const delta = Math.abs(key - timestampMs);
      if (delta <= closestDelta) {
        closestKey = key;
        closestDelta = delta;
      }
    }
    if (closestKey === null) return null;
    const start = this.requestTimes.get(closestKey) ?? null;
    this.requestTimes.delete(closestKey);
    this.inflight = this.requestTimes.size;
    return start;
  }

  private pruneStaleRequests(): void {
    const timeoutMs = Math.max(2_000, this.rtt * 2 + 500);
    const cutoff = performance.now() - timeoutMs;
    for (const [timestamp, sentAt] of this.requestTimes) {
      if (sentAt < cutoff) {
        this.requestTimes.delete(timestamp);
      }
    }
    this.inflight = this.requestTimes.size;
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
