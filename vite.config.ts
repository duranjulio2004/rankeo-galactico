import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: { outDir: '../../dist/client', emptyOutDir: true },
  // Trailing slash matters: a bare '/api' prefix also matches the module /api.ts.
  server: { port: 5173, proxy: { '/api/': 'http://localhost:3000' } },
});
