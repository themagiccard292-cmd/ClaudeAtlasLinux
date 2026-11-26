import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Production-only CSP (dev needs inline scripts for React Refresh). */
function csp(): Plugin {
  return {
    name: 'atlas-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const policy = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
      ].join('; ');
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), csp()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'chrome120' },
  server: { port: 5173, strictPort: true },
  test: { environment: 'node', include: ['electron/**/*.test.ts', 'src/**/*.test.ts', 'shared/**/*.test.ts'] },
});
