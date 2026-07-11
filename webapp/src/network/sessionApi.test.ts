import { afterEach, describe, expect, it, vi } from 'vitest';

function videoFile(): File {
  return new File(['video'], 'sample.mp4', { type: 'video/mp4' });
}

async function loadSessionApi() {
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:5173' } });
  return import('./sessionApi');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('video session creation errors', () => {
  it('turns an unreachable backend into an actionable English error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const { uploadVideo } = await loadSessionApi();

    await expect(uploadVideo(videoFile())).rejects.toThrow(
      'Cannot reach the processing backend. Make sure ./start.sh is still running.'
    );
  });

  it('includes the backend status and detail when the upload is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Unsupported video container' }), {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    const { uploadVideo } = await loadSessionApi();

    await expect(uploadVideo(videoFile())).rejects.toThrow(
      'Processing backend rejected the video (400 Bad Request): Unsupported video container'
    );
  });

  it('provides the English in-progress status used by the app', async () => {
    const { VIDEO_TRANSFER_STATUS } = await loadSessionApi();

    expect(VIDEO_TRANSFER_STATUS).toBe(
      'Transferring video to the processing backend...'
    );
  });
});
