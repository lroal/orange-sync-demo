import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: ['vite'],
    fs: {
      allow: ['..']
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    },
    proxy: {
      '/api': 'http://localhost:3055',
      '/rdb': 'http://localhost:3055',
      '/health': 'http://localhost:3055'
    }
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm']
  }
});
