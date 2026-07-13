import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    port: 5173,
    https: false,
    // Tailscale Serve terminates HTTPS and forwards the original *.ts.net
    // host to this loopback-only development server.
    allowedHosts: ['.ts.net'],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
