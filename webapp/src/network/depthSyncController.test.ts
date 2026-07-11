import { describe, expect, it } from 'vitest';

import type { DepthStatus } from '../types';
import { getAutoMaxInflight, getSuggestedDepthLeadMs } from './depthSyncPolicy';

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
