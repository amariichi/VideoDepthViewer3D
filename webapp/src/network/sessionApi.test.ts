import { afterEach, describe, expect, it, vi } from 'vitest';

function videoFile(): File {
  return new File(['video'], 'sample.mp4', { type: 'video/mp4' });
}

function sessionPayload() {
  return {
    session_id: 'session-1',
    source_name: 'phone.mov',
    media_type: 'video/quicktime',
    width: 320,
    height: 180,
    display_width: 320,
    display_height: 180,
    inference_width: 320,
    inference_height: 180,
    fps: 30,
    duration_ms: 2_000,
  };
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

  it('discovers no active session from a 204 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const { getCurrentSession } = await loadSessionApi();

    await expect(getCurrentSession()).resolves.toBeNull();
  });

  it('identifies a status request for a replaced session', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const { getSessionStatus, isSessionGoneError } = await loadSessionApi();

    const error = await getSessionStatus('session one').catch((caught) => caught);

    expect(isSessionGoneError(error)).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/session%20one/status',
      { cache: 'no-store', signal: undefined }
    );
  });

  it('parses shared-session source metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(sessionPayload()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    const {
      getBrowserVideoUrl,
      getCurrentSession,
      getSessionVideoUrl,
    } = await loadSessionApi();

    await expect(getCurrentSession()).resolves.toMatchObject({
      sessionId: 'session-1',
      sourceName: 'phone.mov',
      mediaType: 'video/quicktime',
      durationMs: 2_000,
    });
    expect(getSessionVideoUrl('session one')).toBe(
      '/api/sessions/session%20one/video'
    );
    expect(getBrowserVideoUrl('session one')).toBe(
      '/api/sessions/session%20one/browser-video'
    );
  });

  it('prepares browser playback only when requested', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const { prepareBrowserVideo } = await loadSessionApi();

    await expect(prepareBrowserVideo('session one')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/session%20one/browser-video',
      { method: 'POST' }
    );
  });

  it('reports XHR upload progress and parses the completed session', async () => {
    class FakeXMLHttpRequest {
      static instance: FakeXMLHttpRequest;
      status = 200;
      statusText = 'OK';
      response: unknown = sessionPayload();
      responseText = '';
      responseType = '';
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
        onprogress: null,
      };
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      onload: (() => void) | null = null;

      constructor() {
        FakeXMLHttpRequest.instance = this;
      }

      open(): void {}
      send(): void {}
      abort(): void {
        this.onabort?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    const progress = vi.fn();
    const { uploadVideo } = await loadSessionApi();

    const promise = uploadVideo(videoFile(), { onProgress: progress });
    FakeXMLHttpRequest.instance.upload.onprogress?.({
      lengthComputable: true,
      loaded: 2,
      total: 4,
    } as ProgressEvent);
    FakeXMLHttpRequest.instance.onload?.();

    await expect(promise).resolves.toMatchObject({
      sessionId: 'session-1',
      sourceName: 'phone.mov',
    });
    expect(progress).toHaveBeenCalledWith({ loaded: 2, total: 4, fraction: 0.5 });
    expect(progress).toHaveBeenLastCalledWith({ loaded: 5, total: 5, fraction: 1 });
  });
});
