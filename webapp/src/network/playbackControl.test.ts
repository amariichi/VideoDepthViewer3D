import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  send(message: string): void {
    this.sent.push(message);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadPlaybackControl() {
  vi.stubGlobal('window', {
    location: { origin: 'http://127.0.0.1:5173' },
    setTimeout: vi.fn(setTimeout),
    clearTimeout,
  });
  vi.stubGlobal('WebSocket', { OPEN: 1, CONNECTING: 0 });
  return import('./playbackControl');
}

describe('playback control protocol', () => {
  it('parses normalized server events and rejects malformed commands', async () => {
    const { parsePlaybackEvent } = await loadPlaybackControl();
    expect(
      parsePlaybackEvent({
        type: 'command',
        action: 'seek',
        current_time_ms: 750,
        paused: true,
        revision: 3,
      })
    ).toMatchObject({
      type: 'command',
      action: 'seek',
      currentTimeMs: 750,
      paused: true,
      revision: 3,
    });
    expect(parsePlaybackEvent({ type: 'command', action: 'explode' })).toBeNull();
  });

  it('queues remote commands until connected and emits viewer state', async () => {
    const { PlaybackControlClient } = await loadPlaybackControl();

    const remoteSocket = new FakeSocket();
    const remote = new PlaybackControlClient(
      'session one',
      'remote',
      'phone',
      () => remoteSocket as unknown as WebSocket
    );
    remote.connect();
    remote.sendCommand('play', 500, false);
    remote.sendCommand('seek', 1_250, true);
    expect(remoteSocket.sent).toHaveLength(0);
    remoteSocket.open();
    expect(remoteSocket.sent).toHaveLength(1);
    expect(JSON.parse(remoteSocket.sent[0])).toMatchObject({
      type: 'command',
      action: 'seek',
      current_time_ms: 1_250,
      paused: true,
      role: 'remote',
      client_id: 'phone',
    });

    const received = vi.fn();
    remote.onEvent(received);
    remoteSocket.receive({
      type: 'state',
      current_time_ms: 1_300,
      paused: false,
      revision: 4,
    });
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'state', currentTimeMs: 1_300 })
    );
    remote.close();

    const viewerSocket = new FakeSocket();
    const viewer = new PlaybackControlClient(
      'session one',
      'viewer',
      'desktop',
      () => viewerSocket as unknown as WebSocket
    );
    viewer.connect();
    viewerSocket.open();
    viewer.sendState(2_000, false);
    expect(JSON.parse(viewerSocket.sent[0])).toMatchObject({
      type: 'state',
      current_time_ms: 2_000,
      paused: false,
      role: 'viewer',
      client_id: 'desktop',
    });
    viewer.close();
  });

  it('does not reconnect after the server rejects an ended session', async () => {
    const { PlaybackControlClient } = await loadPlaybackControl();
    const socket = new FakeSocket();
    const createSocket = vi.fn(() => socket as unknown as WebSocket);
    const client = new PlaybackControlClient(
      'ended-session',
      'remote',
      'phone',
      createSocket
    );

    client.connect();
    socket.open();
    socket.serverClose(1008);

    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(window.setTimeout).not.toHaveBeenCalled();
  });
});
