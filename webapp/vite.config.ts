import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    host: true,
    port: 5173,
    https: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
