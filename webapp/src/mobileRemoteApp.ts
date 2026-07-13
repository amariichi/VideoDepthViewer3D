import {
  describeVideoTransferError,
  uploadVideo,
} from './network/sessionApi';
import type { SessionInfo } from './types';
import {
  PlaybackControlClient,
  type PlaybackAction,
  type PlaybackEvent,
} from './network/playbackControl';

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing mobile remote element: ${selector}`);
  return element;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export class MobileRemoteApp {
  private readonly video: HTMLVideoElement;
  private readonly fileInput: HTMLInputElement;
  private readonly openButton: HTMLButtonElement;
  private readonly emptyState: HTMLElement;
  private readonly previewCard: HTMLElement;
  private readonly connection: HTMLElement;
  private readonly fileDetails: HTMLElement;
  private readonly fileName: HTMLElement;
  private readonly fileSize: HTMLElement;
  private readonly progressGroup: HTMLElement;
  private readonly progress: HTMLProgressElement;
  private readonly progressValue: HTMLElement;
  private readonly progressLabel: HTMLElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly help: HTMLElement;
  private readonly error: HTMLElement;
  private readonly desktopState: HTMLElement;

  private session: SessionInfo | null = null;
  private control: PlaybackControlClient | null = null;
  private uploadAbort: AbortController | null = null;
  private objectUrl: string | null = null;
  private remoteEventSuppressionUntil = 0;
  private userSeeking = false;
  private lastSeekCommandAt = 0;
  private desktopSynchronized = false;
  private preSyncIntervalId: number | null = null;

  constructor(root: HTMLElement) {
    this.video = requiredElement(root, '#remote-video');
    this.fileInput = requiredElement(root, '#remote-video-file');
    this.openButton = requiredElement(root, '#remote-open-file');
    this.emptyState = requiredElement(root, '#remote-empty-state');
    this.previewCard = requiredElement(root, '#remote-preview-card');
    this.connection = requiredElement(root, '#remote-connection');
    this.fileDetails = requiredElement(root, '#remote-file-details');
    this.fileName = requiredElement(root, '#remote-file-name');
    this.fileSize = requiredElement(root, '#remote-file-size');
    this.progressGroup = requiredElement(root, '#remote-progress-group');
    this.progress = requiredElement(root, '#remote-progress');
    this.progressValue = requiredElement(root, '#remote-progress-value');
    this.progressLabel = requiredElement(root, '#remote-progress-label');
    this.cancelButton = requiredElement(root, '#remote-cancel-upload');
    this.help = requiredElement(root, '#remote-help');
    this.error = requiredElement(root, '#remote-error');
    this.desktopState = requiredElement(root, '#remote-desktop-state');

    this.openButton.addEventListener('click', () => {
      this.fileInput.value = '';
      this.fileInput.click();
    });
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (file) void this.selectFile(file);
    });
    this.cancelButton.addEventListener('click', () => this.uploadAbort?.abort());
    this.video.addEventListener('play', () => this.publishLocalAction('play'));
    this.video.addEventListener('pause', () => {
      if (!this.video.ended) this.publishLocalAction('pause');
    });
    this.video.addEventListener('ended', () => this.handleEnded());
    this.video.addEventListener('seeking', () => this.handleSeeking());
    this.video.addEventListener('seeked', () => this.handleSeeked());
    this.video.addEventListener('error', () => {
      if (this.objectUrl) {
        this.setError(
          'This phone cannot preview the selected codec. Transfer can still continue.'
        );
      }
    });
  }

  private async selectFile(file: File): Promise<void> {
    this.uploadAbort?.abort();
    const uploadAbort = new AbortController();
    this.uploadAbort = uploadAbort;
    this.control?.close();
    this.control = null;
    this.stopPreSyncHeartbeat();
    this.desktopSynchronized = false;
    this.session = null;
    this.setError('');

    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.video.src = this.objectUrl;
    this.video.load();
    this.video.classList.remove('hidden');
    this.emptyState.classList.add('hidden');
    void this.video.play().catch(() => undefined);

    this.fileName.textContent = file.name;
    this.fileSize.textContent = `${formatBytes(file.size)} · local preview`;
    this.fileDetails.classList.remove('hidden');
    this.openButton.textContent = 'Choose another video';
    this.previewCard.setAttribute('aria-busy', 'true');
    this.progress.value = 0;
    this.progressValue.textContent = '0%';
    this.progressLabel.textContent = 'Transferring to PC';
    this.progressGroup.classList.remove('hidden');
    this.cancelButton.disabled = false;
    this.cancelButton.classList.remove('hidden');
    this.help.textContent = 'Keep this page open until the transfer finishes.';
    this.setConnection('Transferring');
    this.desktopState.textContent =
      'The PC viewer will attach automatically when the transfer finishes.';

    try {
      const session = await uploadVideo(file, {
        signal: uploadAbort.signal,
        onProgress: ({ loaded, total, fraction }) => {
          if (fraction !== null) {
            this.progress.value = fraction;
            this.progressValue.textContent = `${Math.round(fraction * 100)}%`;
          } else {
            this.progress.removeAttribute('value');
            this.progressValue.textContent = formatBytes(loaded);
          }
          if (total !== null) {
            this.progressLabel.textContent = `${formatBytes(loaded)} of ${formatBytes(total)}`;
          }
        },
      });
      if (uploadAbort.signal.aborted || this.uploadAbort !== uploadAbort) return;
      this.session = session;
      this.previewCard.setAttribute('aria-busy', 'false');
      this.progress.value = 1;
      this.progressValue.textContent = '100%';
      this.progressLabel.textContent = 'Transfer complete';
      this.cancelButton.disabled = true;
      this.cancelButton.classList.add('hidden');
      this.help.textContent =
        'Use this preview to play, pause, or seek. The PC remains the playback clock.';
      this.desktopState.textContent =
        'Ready for the PC viewer. Looking Glass, WebXR, and SBS stay on the PC.';
      this.connectControl(session);
    } catch (cause) {
      if (this.uploadAbort !== uploadAbort) return;
      this.previewCard.setAttribute('aria-busy', 'false');
      this.cancelButton.disabled = true;
      this.cancelButton.classList.add('hidden');
      this.setConnection('Not connected');
      this.setError(describeVideoTransferError(cause));
      this.help.textContent = 'The local preview remains available. Try the transfer again.';
    }
  }

  private connectControl(session: SessionInfo): void {
    const control = new PlaybackControlClient(session.sessionId, 'remote');
    this.control = control;
    this.desktopSynchronized = false;
    control.onStatus((connected) => {
      if (this.control !== control) return;
      if (!connected) {
        this.desktopSynchronized = false;
        this.startPreSyncHeartbeat();
      }
      this.setConnection(connected ? 'Ready for PC' : 'Reconnecting');
    });
    control.onEvent((event) => this.handleControlEvent(control, event));
    control.connect();
    this.startPreSyncHeartbeat();
  }

  private handleControlEvent(
    control: PlaybackControlClient,
    event: PlaybackEvent
  ): void {
    if (this.control !== control) return;
    if (event.type === 'session-ended') {
      this.stopPreSyncHeartbeat();
      this.control = null;
      this.setConnection('Session replaced');
      this.desktopState.textContent =
        'This transfer was replaced by another video. Choose a video to reconnect.';
      return;
    }
    if (event.type === 'error') {
      this.setError(event.message ?? 'Playback control could not be synchronized.');
      return;
    }
    if (
      event.type !== 'state' ||
      event.originRole !== 'viewer' ||
      event.currentTimeMs === undefined ||
      event.paused === undefined ||
      this.userSeeking
    ) {
      return;
    }

    this.desktopSynchronized = true;
    this.stopPreSyncHeartbeat();
    this.setConnection('PC synchronized');
    this.desktopState.textContent =
      'The PC is playing this session. Phone controls are synchronized.';
    const targetSeconds = event.currentTimeMs / 1000;
    const shouldSeek = Math.abs(this.video.currentTime - targetSeconds) > 0.45;
    const shouldPause = event.paused && !this.video.paused;
    const shouldPlay = !event.paused && this.video.paused;
    if (shouldSeek || shouldPause || shouldPlay) {
      this.remoteEventSuppressionUntil = performance.now() + 200;
    }
    if (shouldSeek) {
      this.video.currentTime = targetSeconds;
    }
    if (shouldPause) {
      this.video.pause();
    } else if (shouldPlay) {
      void this.video.play().catch(() => undefined);
    }
  }

  private publishLocalAction(action: PlaybackAction): void {
    if (
      !this.session ||
      !this.control ||
      performance.now() < this.remoteEventSuppressionUntil
    ) {
      return;
    }
    this.control.sendCommand(
      action,
      this.video.currentTime * 1000,
      this.video.paused
    );
  }

  private handleEnded(): void {
    // Keep the native controls reusable after playback reaches the end. The
    // explicit command also covers the race where the PC's own ended event and
    // its periodic state update arrive in the opposite order.
    this.userSeeking = false;
    this.remoteEventSuppressionUntil = performance.now() + 200;
    this.video.currentTime = 0;
    if (!this.session || !this.control) return;
    this.control.sendCommand('seek', 0, true);
  }

  private handleSeeking(): void {
    this.userSeeking = true;
    if (
      !this.control ||
      performance.now() < this.remoteEventSuppressionUntil ||
      performance.now() - this.lastSeekCommandAt < 120
    ) {
      return;
    }
    this.lastSeekCommandAt = performance.now();
    this.control.sendCommand(
      'seek',
      this.video.currentTime * 1000,
      this.video.paused
    );
  }

  private handleSeeked(): void {
    this.userSeeking = false;
    if (!this.control || performance.now() < this.remoteEventSuppressionUntil) return;
    this.control.sendCommand(
      'seek',
      this.video.currentTime * 1000,
      this.video.paused
    );
  }

  private startPreSyncHeartbeat(): void {
    this.stopPreSyncHeartbeat();
    const publish = () => {
      if (this.desktopSynchronized || !this.control || !this.session) return;
      this.control.sendCommand(
        this.video.paused ? 'pause' : 'play',
        this.video.currentTime * 1000,
        this.video.paused
      );
    };
    publish();
    this.preSyncIntervalId = window.setInterval(publish, 1_000);
  }

  private stopPreSyncHeartbeat(): void {
    if (this.preSyncIntervalId === null) return;
    window.clearInterval(this.preSyncIntervalId);
    this.preSyncIntervalId = null;
  }

  private setConnection(label: string): void {
    this.connection.textContent = label;
  }

  private setError(message: string): void {
    this.error.textContent = message;
    this.error.classList.toggle('hidden', !message);
  }
}
