import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
      // Force all packages that proxy framer-motion/motion to resolve react
      // from the single top-level copy.  Without this Vite inlines a second
      // React inside the pre-bundled framer-motion chunk, causing the
      // "Invalid hook call / cannot read useState" crash at App.tsx:147.
      dedupe: ['react', 'react-dom'],
    },
    optimizeDeps: {
      // Pre-bundle motion + framer-motion together with react so Vite resolves
      // their React import to the same singleton the app uses.
      include: ['react', 'react-dom', 'motion', 'framer-motion'],
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify - file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
