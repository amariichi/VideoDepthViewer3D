import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DepthStatus } from '../types';
import { getAutoMaxInflight, getSuggestedDepthLeadMs } from './depthSyncPolicy';

const getSessionStatus = vi.hoisted(() => vi.fn());

vi.mock('./sessionApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sessionApi')>()),
  getSessionStatus,
}));

afterEach(() => {
  getSessionStatus.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubIntervals(): {
  runTick: () => void;
  clearInterval: ReturnType<typeof vi.fn>;
} {
  let callback: (() => void) | null = null;
  const clearInterval = vi.fn();
  vi.stubGlobal('window', {
    setInterval: vi.fn((next: () => void) => {
      callback = next;
      return 17;
    }),
    clearInterval,
  });
  return {
    runTick: () => {
      if (!callback) throw new Error('interval was not started');
      callback();
    },
    clearInterval,
  };
}

describe('DepthSyncController lifecycle', () => {
  it('aborts an in-flight poll without reporting a cleanup error', async () => {
    const intervals = stubIntervals();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let requestSignal: AbortSignal | undefined;
    getSessionStatus.mockImplementation((_sessionId: string, signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true }
        );
      });
    });
    const { DepthSyncController } = await import('./depthSyncController');
    const controller = new DepthSyncController(
      () => ({
        perfSettings: {
          mode: 'balanced',
          autoLead: true,
          depthLeadMs: 100,
          maxInflightRequests: 9,
        },
      }),
      vi.fn()
    );

    controller.start('old-session');
    intervals.runTick();
    controller.stop();
    await Promise.resolve();

    expect(requestSignal?.aborted).toBe(true);
    expect(intervals.clearInterval).toHaveBeenCalledWith(17);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('stops polling when the backend reports that the session is gone', async () => {
    const intervals = stubIntervals();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { SessionStatusError } = await import('./sessionApi');
    getSessionStatus.mockRejectedValue(new SessionStatusError(404));
    const { DepthSyncController } = await import('./depthSyncController');
    const controller = new DepthSyncController(
      () => ({
        perfSettings: {
          mode: 'balanced',
          autoLead: true,
          depthLeadMs: 100,
          maxInflightRequests: 9,
        },
      }),
      vi.fn()
    );

    controller.start('old-session');
    intervals.runTick();
    await Promise.resolve();
    await Promise.resolve();

    expect(intervals.clearInterval).toHaveBeenCalledWith(17);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

function rollingStats(
  patch: Partial<DepthStatus['rolling_stats']> = {}
): DepthStatus['rolling_stats'] {
  return {
    depth_fps: 0,
    latency_ms: 0,
    client_fps: 0,
    infer_avg_s: 0,
    infer_wait_avg_s: 0,
    normalize_avg_s: 0,
    pack_avg_s: 0,
    queue_avg_s: 0,
    ws_send_avg_s: 0,
    decode_avg_s: 0,
    payload_avg_bytes: 0,
    drop_count: 0,
    ...patch,
  };
}

describe('depth synchronization policy', () => {
  it('sizes automatic inflight work from mode and inference workers', () => {
    expect(getAutoMaxInflight('smooth', 3)).toBe(6);
    expect(getAutoMaxInflight('balanced', 3)).toBe(9);
    expect(getAutoMaxInflight('quality', 3)).toBe(12);
    expect(getAutoMaxInflight('manual', 3)).toBeNull();
  });

  it('includes every measured server stage in the suggested manual lead', () => {
    const stats = rollingStats({
      queue_avg_s: 0.01,
      decode_avg_s: 0.02,
      normalize_avg_s: 0.03,
      infer_wait_avg_s: 0.04,
      infer_avg_s: 0.05,
      pack_avg_s: 0.06,
    });

    // 10 + 20 + 30 + 40 + 50 + 60 ms, plus 55 ms safety.
    expect(getSuggestedDepthLeadMs(stats, 3)).toBe(265);
  });
});
