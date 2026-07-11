import './style.css';
import { VideoDepthApp } from './app';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) {
  throw new Error('Root element not found');
}

const app = new VideoDepthApp(root);
if (import.meta.env.DEV) {
  (window as typeof window & { __videoDepthApp?: VideoDepthApp }).__videoDepthApp = app;
}
