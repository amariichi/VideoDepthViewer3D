import './style.css';
import { resolveClientMode } from './utils/clientMode';

async function start(): Promise<void> {
  const mode = resolveClientMode();
  document.body.dataset.clientMode = mode;
  const viewerRoot = document.querySelector<HTMLDivElement>('#viewer-app');
  const remoteRoot = document.querySelector<HTMLElement>('#remote-app');
  if (!viewerRoot || !remoteRoot) throw new Error('Application roots not found');

  if (mode === 'remote') {
    viewerRoot.hidden = true;
    viewerRoot.classList.add('hidden');
    remoteRoot.hidden = false;
    remoteRoot.classList.remove('hidden');
    const { MobileRemoteApp } = await import('./mobileRemoteApp');
    const app = new MobileRemoteApp(remoteRoot);
    if (import.meta.env.DEV) {
      (window as typeof window & { __mobileRemoteApp?: unknown }).__mobileRemoteApp = app;
    }
    return;
  }

  remoteRoot.hidden = true;
  remoteRoot.classList.add('hidden');
  viewerRoot.hidden = false;
  viewerRoot.classList.remove('hidden');
  const { VideoDepthApp } = await import('./app');
  const app = new VideoDepthApp(viewerRoot);
  if (import.meta.env.DEV) {
    (window as typeof window & { __videoDepthApp?: unknown }).__videoDepthApp = app;
  }
}

void start();
