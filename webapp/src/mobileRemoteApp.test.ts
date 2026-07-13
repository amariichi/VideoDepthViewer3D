import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionInfo } from './types';

interface EndedPlaybackHarness {
  session: SessionInfo | null;
  control: {
    sendCommand: ReturnType<typeof vi.fn>;
  } | null;
  userSeeking: boolean;
  remoteEventSuppressionUntil: number;
}

async function createHarness(connected: boolean): Promise<{
  app: EndedPlaybackHarness;
  video: HTMLVideoElement;
  sendCommand: ReturnType<typeof vi.fn>;
}> {
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:5173' } });
  const { MobileRemoteApp } = await import('./mobileRemoteApp');
  const sendCommand = vi.fn();
  const video = Object.assign(new EventTarget(), {
    currentTime: 12.5,
    paused: true,
    ended: true,
  }) as HTMLVideoElement;
  const root = {
    querySelector: () => video,
  } as unknown as HTMLElement;
  const app = new MobileRemoteApp(root) as unknown as EndedPlaybackHarness;
  app.session = connected ? ({} as SessionInfo) : null;
  app.control = connected ? { sendCommand } : null;
  app.userSeeking = true;
  app.remoteEventSuppressionUntil = 0;
  return { app, video, sendCommand };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('MobileRemoteApp ended playback', () => {
  it('rewinds the local preview and tells the PC to remain paused at zero', async () => {
    const { app, video, sendCommand } = await createHarness(true);

    video.dispatchEvent(new Event('ended'));

    expect(video.currentTime).toBe(0);
    expect(app.userSeeking).toBe(false);
    expect(app.remoteEventSuppressionUntil).toBeGreaterThan(performance.now());
    expect(sendCommand).toHaveBeenCalledOnce();
    expect(sendCommand).toHaveBeenCalledWith('seek', 0, true);
  });

  it('still rewinds the local preview when the PC control channel is absent', async () => {
    const { video, sendCommand } = await createHarness(false);

    video.dispatchEvent(new Event('ended'));

    expect(video.currentTime).toBe(0);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
