import pako from 'pako';
import type { DepthFrame } from '../types';
import {
  DEPTH_HEADER_SIZE,
  DEPTH_MAGIC,
  DEPTH_MAGIC_COMPRESSED,
  DEPTH_MAGIC_LOG8,
  DEPTH_MAGIC_LOG8_COMPRESSED,
} from '../types';

const DATA_TYPE_UINT16 = 1;
const DATA_TYPE_UINT8_LOG = 2;

export function decodeDepthPacket(buffer: ArrayBuffer): DepthFrame | null {
  if (buffer.byteLength < DEPTH_HEADER_SIZE) return null;

  const view = new DataView(buffer, 0, DEPTH_HEADER_SIZE);
  const magic = new TextDecoder('ascii').decode(buffer.slice(0, 4));
  const version = view.getUint16(4, true);
  const dataType = view.getUint16(6, true);
  const isCompressed =
    magic === DEPTH_MAGIC_COMPRESSED || magic === DEPTH_MAGIC_LOG8_COMPRESSED;
  const isLinear = magic === DEPTH_MAGIC || magic === DEPTH_MAGIC_COMPRESSED;
  const isLog = magic === DEPTH_MAGIC_LOG8 || magic === DEPTH_MAGIC_LOG8_COMPRESSED;
  if (!isLinear && !isLog) return null;
  if (
    (dataType === DATA_TYPE_UINT16 && version !== 1) ||
    (dataType === DATA_TYPE_UINT8_LOG && version !== 2)
  ) {
    return null;
  }

  const timestampMs = view.getUint32(8, true);
  const width = view.getUint32(12, true);
  const height = view.getUint32(16, true);
  const scale = view.getFloat32(20, true);
  const bias = view.getFloat32(24, true);
  const zMax = view.getFloat32(28, true);
  const sampleCount = width * height;
  if (!sampleCount || !Number.isSafeInteger(sampleCount)) return null;

  let bytes = new Uint8Array(buffer, DEPTH_HEADER_SIZE);
  if (isCompressed) {
    try {
      bytes = pako.inflate(bytes);
    } catch (error) {
      console.error('Depth decompression failed', error);
      return null;
    }
  }

  const data = new Float32Array(sampleCount);
  if (dataType === DATA_TYPE_UINT16 && isLinear) {
    if (bytes.byteLength !== sampleCount * 2) return null;
    const aligned =
      bytes.byteOffset % 2 === 0
        ? bytes
        : new Uint8Array(bytes).slice();
    const samples = new Uint16Array(aligned.buffer, aligned.byteOffset, sampleCount);
    for (let index = 0; index < sampleCount; index += 1) {
      data[index] = samples[index] * scale + bias;
    }
  } else if (dataType === DATA_TYPE_UINT8_LOG && isLog) {
    if (bytes.byteLength !== sampleCount) return null;
    const lookup = new Float32Array(256);
    for (let value = 0; value < lookup.length; value += 1) {
      lookup[value] = Math.exp(value * scale + bias);
    }
    for (let index = 0; index < sampleCount; index += 1) {
      data[index] = lookup[bytes[index]];
    }
  } else {
    return null;
  }

  return { timestampMs, width, height, data, scale, bias, zMax };
}
