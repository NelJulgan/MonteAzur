/**
 * ============================================================================
 * MONTE AZUR — VITE BUNDLER CONFIGURATION (vite.config.js)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Dev Server & Public Static Assets Directory)
 * - STAGE 2: CORE FUNCTIONALITY (Production Rollup Bundling & CSS Code Splitting)
 * - STAGE 3: ENHANCEMENT / ANIMATION / OPTIMIZATION (Vendor Chunking for GSAP + Lenis)
 *
 * WHY THIS FILE EXISTS:
 * Configures Vite to serve `public/` static assets at root `/` during development
 * and splits heavy motion libraries (`gsap`, `lenis`) into a cacheable vendor chunk
 * during production builds (`npm run build`).
 *
 * TRICKY LOGIC:
 * - Separating `gsap` and `lenis` into `vendor-motion` allows browsers to cache
 *   the animation engine independently of UI/API updates in `src/`.
 *
 * TODO:
 * - Add `server.proxy` for `/api` once the local Node.js + PostgreSQL server runs on port 3000.
 * ============================================================================
 */

import { defineConfig } from 'vite';
import { resolve } from 'path';

// STEP 1: Configure development server, static asset directory, and Rollup output
export default defineConfig({
  publicDir: 'public',
  server: {
    port: 5173,
    host: true,
    open: false,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
    cssCodeSplit: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        success: resolve(__dirname, 'success.html'),
      },
      output: {
        manualChunks: {
          'vendor-motion': ['gsap', 'gsap/ScrollTrigger', 'lenis'],
        },
      },
    },
  },
});
