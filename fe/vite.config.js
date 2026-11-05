import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // GUIDE #9 A1: heavy vendors in their own chunks, loaded only by the pages that need them.
    // Vite 8 bundles with Rolldown: its native codeSplitting groups (with priorities) are used instead of
    // Rollup's manualChunks, whose compat mode merged React into the first manual chunk (leaflet) and
    // made every page preload Leaflet.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', priority: 40, test: /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run[\\/]router|react-is)[\\/]/ },
            { name: 'leaflet', priority: 30, test: /[\\/]node_modules[\\/](leaflet|react-leaflet|@react-leaflet[\\/]core)[\\/]/ },
            {
              name: 'recharts', priority: 20,
              test: /[\\/]node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor|internmap|decimal\.js-light|es-toolkit|immer|reselect|@reduxjs[\\/]toolkit|redux|react-redux|redux-thunk|eventemitter3|tiny-invariant)[\\/]/,
            },
            { name: 'socket', priority: 10, test: /[\\/]node_modules[\\/](socket\.io-client|engine\.io-client|socket\.io-parser|engine\.io-parser|@socket\.io[\\/]component-emitter|debug|ms|xmlhttprequest-ssl)[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:5000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:5000', changeOrigin: true, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    css: false,
    restoreMocks: true,
  },
});
