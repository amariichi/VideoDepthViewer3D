import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DepthFrame } from '../types';
import { DepthBuffer } from './depthBuffer';

function frame(timestampMs: number): DepthFrame {
  return {
    timestampMs,
    width: 1,
    height: 1,
    data: new Float32Array([1]),
    scale: 1,
    bias: 0,
    zMax: 1,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DepthBuffer', () => {
  it('returns the closest frame only inside the sync tolerance', () => {
    const buffer = new DepthBuffer();
    buffer.add(frame(100));
    buffer.add(frame(133));

    expect(buffer.getFrame(120)?.timestampMs).toBe(133);
    expect(buffer.getFrame(200)).toBeNull();
  });

  it('returns a bounded nearest-frame window for entry-time stabilization', () => {
    const buffer = new DepthBuffer();
    [0, 100, 200, 300, 900, 1500].forEach((timestamp) => {
      buffer.add(frame(timestamp));
    });

    expect(
      buffer.getFramesNear(250, 400, 3).map((item) => item.timestampMs)
    ).toEqual([200, 300, 100]);
    expect(buffer.getFramesNear(Number.NaN)).toEqual([]);
  });

  it('does not reserve an entire look-ahead window before flow control', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const buffer = new DepthBuffer();
    const missing = buffer.getMissing(0, 100, 20, 500);

    expect(missing).toEqual([0, 20, 40, 60, 80, 100]);
    expect(buffer.requestedSize).toBe(0);

    buffer.markRequested(missing.slice(0, 2));
    expect(buffer.requestedSize).toBe(2);
    expect(buffer.getMissing(0, 100, 20, 500)).toEqual([40, 60, 80, 100]);
  });

  it('allows a timed-out request to be selected again', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    const buffer = new DepthBuffer();
    buffer.markRequested([50]);

    now.mockReturnValue(1200);
    expect(buffer.getMissing(50, 50, 10, 500)).toEqual([]);
    now.mockReturnValue(1600);
    expect(buffer.getMissing(50, 50, 10, 500)).toEqual([50]);
  });

  it('matches decoded integer PTS to a fractional requested timestamp', () => {
    const buffer = new DepthBuffer();
    buffer.markRequested([1000 / 30]);

    buffer.add(frame(33));

    expect(buffer.requestedSize).toBe(0);
  });
});
