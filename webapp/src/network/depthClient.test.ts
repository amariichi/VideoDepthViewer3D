import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEPTH_HEADER_SIZE } from '../types';

type SocketHandler = ((event: { data: string | ArrayBuffer }) => void) | null;

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: SocketHandler = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }

  receive(data: string | ArrayBuffer): void {
    this.onmessage?.({ data });
  }
}

function depthPacket(timestampMs: number): ArrayBuffer {
  const sample = new Uint16Array([1]);
  const buffer = new ArrayBuffer(DEPTH_HEADER_SIZE + sample.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode('VDZ1'), 0);
  bytes.set(new Uint8Array(sample.buffer), DEPTH_HEADER_SIZE);
  const view = new DataView(buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, 1, true);
  view.setUint32(8, timestampMs, true);
  view.setUint32(12, 1, true);
  view.setUint32(16, 1, true);
  view.setFloat32(20, 1, true);
  view.setFloat32(24, 0, true);
  view.setFloat32(28, 50, true);
  return buffer;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeWebSocket.instances = [];
});

describe('DepthClient response flow control', () => {
  it('accepts valid responses in completion order and releases every slot', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:5174' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const { DepthClient } = await import('./depthClient');
    const client = new DepthClient('test-session', () => ({
      mode: 'balanced',
      autoLead: true,
      depthLeadMs: 100,
      maxInflightRequests: 9,
    }));
    const received: number[] = [];
    client.onDepth((frame) => received.push(frame.timestampMs));
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    for (const timestamp of [100, 200, 300]) client.requestDepth(timestamp);
    expect(client.getInflightCount()).toBe(3);

    for (const timestamp of [300, 100, 200]) {
      socket.receive(depthPacket(timestamp));
    }

    expect(received).toEqual([300, 100, 200]);
    expect(client.getInflightCount()).toBe(0);
  });

  it('releases a slot for a malformed packet or timestamped miss', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:5174' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const { DepthClient } = await import('./depthClient');
    const client = new DepthClient('test-session', () => ({
      mode: 'balanced',
      autoLead: true,
      depthLeadMs: 100,
      maxInflightRequests: 9,
    }));
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    client.requestDepth(100);
    client.requestDepth(200);
    socket.receive(new ArrayBuffer(1));
    socket.receive(JSON.stringify({ type: 'miss', time_ms: 200 }));

    expect(client.getInflightCount()).toBe(0);
  });
});
