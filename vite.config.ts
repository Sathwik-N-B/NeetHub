import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'chrome110',
    rollupOptions: {
      input: {
        background: path.resolve(__dirname, 'src/background/index.ts'),
        'content-neetcode-main': path.resolve(__dirname, 'src/content/neetcode-main.ts'),
        'content-neetcode': path.resolve(__dirname, 'src/content/neetcode.ts'),
        'content-authorize': path.resolve(__dirname, 'src/content/authorize.ts'),
        popup: path.resolve(__dirname, 'src/popup/popup.html'),
        options: path.resolve(__dirname, 'src/options/options.html'),
        welcome: path.resolve(__dirname, 'src/welcome/welcome.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@src': path.resolve(__dirname, 'src'),
    },
  },
});
