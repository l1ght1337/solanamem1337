import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Gitpod выдает базовый URL в GITPOD_WORKSPACE_URL, а реальный хост для
 * проброшенного порта выглядит как: `${PORT}-${hostname}`.
 * Например: 5173-l1ght1337-solanamem-....gitpod.io
 */
const gpUrl = process.env.GITPOD_WORKSPACE_URL
  ? new URL(process.env.GITPOD_WORKSPACE_URL)
  : null;

const port = 5173; // ваш dev-порт Vite
const hmrHost = gpUrl ? `${port}-${gpUrl.hostname}` : undefined;

export default defineConfig({
  plugins: [react()],
  define: {
    // Disable any potential eval in production
    __DEV__: process.env.NODE_ENV !== 'production',
  },
  build: {
    sourcemap: false, // Disable sourcemaps for CSP compliance
    minify: 'terser',
    terserOptions: { 
      keep_classnames: true, 
      keep_fnames: true,
      // Additional CSP-safe options
      compress: {
        drop_console: true,
        drop_debugger: true,
      }
    },
    // CSP-safe rollup options
    rollupOptions: {
      output: {
        manualChunks: undefined, // Prevent dynamic imports that might use eval
      }
    }
  },
  server: {
    host: true,           // слушать 0.0.0.0, чтобы Gitpod мог проксировать
    port,                 // фиксируем порт
    strictPort: true,     // не прыгать на другой порт
    allowedHosts: true,   // динамический gitpod-домен
    hmr: gpUrl
      ? {
          host: hmrHost,  // <— ВАЖНО: 5173-<hostname>
          protocol: "wss",
          clientPort: 443,
        }
      : undefined,
    proxy: {
      // Jupiter price API
      "/x/jup": {
        target: "https://price.jup.ag",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/x\/jup/, ""),
      },
      // Dexscreener API
      "/x/dex": {
        target: "https://api.dexscreener.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/x\/dex/, ""),
      },
       "/x/pump": { 
         target: "https://pumpportal.fun", 
         changeOrigin: true, 
         rewrite: p => p.replace(/^\/x\/pump/, "") },
    },
    // На случай «дрожащей» FS в контейнере можно включить polling:
    // watch: { usePolling: true, interval: 1000 },
  },
});
