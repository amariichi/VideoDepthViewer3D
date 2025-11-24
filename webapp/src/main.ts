import './style.css';
import { VideoDepthApp } from './app';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) {
  throw new Error('Root element not found');
}

new VideoDepthApp(root);
