import pako from 'pako';
import { describe, expect, it } from 'vitest';
import { DEPTH_HEADER_SIZE } from '../types';
import { decodeDepthPacket } from './depthPacket';

function packet(
  magic: string,
  version: number,
  dataType: number,
  width: number,
  height: number,
  scale: number,
  bias: number,
  body: Uint8Array,
  compressed = false
): ArrayBuffer {
  const payload = compressed ? pako.deflate(body, { level: 1 }) : body;
  const buffer = new ArrayBuffer(DEPTH_HEADER_SIZE + payload.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode(magic), 0);
  const view = new DataView(buffer);
  view.setUint16(4, version, true);
  view.setUint16(6, dataType, true);
  view.setUint32(8, 1234, true);
  view.setUint32(12, width, true);
  view.setUint32(16, height, true);
  view.setFloat32(20, scale, true);
  view.setFloat32(24, bias, true);
  view.setFloat32(28, 50, true);
  bytes.set(payload, DEPTH_HEADER_SIZE);
  return buffer;
}

describe('depth packet decoding', () => {
  it('decodes legacy linear uint16 packets', () => {
    const samples = new Uint16Array([0, 32768, 65535]);
    const frame = decodeDepthPacket(
      packet(
        'VDZ1',
        1,
        1,
        3,
        1,
        4 / 65535,
        1,
        new Uint8Array(samples.buffer)
      )
    );

    expect(frame).not.toBeNull();
    expect(frame?.timestampMs).toBe(1234);
    expect(Array.from(frame?.data ?? [])).toEqual([
      1,
      expect.closeTo(3, 4),
      5,
    ]);
  });

  it('decodes compressed log8 packets with relative precision', () => {
    const logMin = Math.log(0.5);
    const logStep = Math.log(100) / 255;
    const frame = decodeDepthPacket(
      packet(
        'VDZ4',
        2,
        2,
        3,
        1,
        logStep,
        logMin,
        new Uint8Array([0, 128, 255]),
        true
      )
    );

    expect(frame).not.toBeNull();
    expect(frame?.data[0]).toBeCloseTo(0.5, 5);
    expect(frame?.data[2]).toBeCloseTo(50, 3);
    expect(frame?.data[1]).toBeGreaterThan(frame?.data[0] ?? 0);
  });

  it('rejects version/type and sample-count mismatches', () => {
    expect(
      decodeDepthPacket(packet('VDZ3', 1, 2, 1, 1, 1, 0, new Uint8Array([0])))
    ).toBeNull();
    expect(
      decodeDepthPacket(packet('VDZ3', 2, 2, 2, 1, 1, 0, new Uint8Array([0])))
    ).toBeNull();
  });
});
