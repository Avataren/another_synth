import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const audioProcessorMock = fileURLToPath(
  new URL('./tests/__mocks__/audio_processor.ts', import.meta.url),
);

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    pool: 'threads',
  },
  resolve: {
    alias: {
      'app/public/wasm/audio_processor': audioProcessorMock,
      'app/public/wasm/audio_processor.js': audioProcessorMock,
      // Resolve the tracker replay library to its TypeScript source rather
      // than to the `dist` its package.json points at, so tests run against
      // what is on disk and need no build step first.
      '@another-synth/tracker-playback': path.resolve(
        __dirname,
        './packages/tracker-playback/src/index.ts',
      ),
      src: path.resolve(__dirname, './src'),
    },
  },
});
