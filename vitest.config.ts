import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const audioProcessorMock = fileURLToPath(
  new URL('./tests/__mocks__/audio_processor.ts', import.meta.url),
);

export default defineConfig({
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
      src: path.resolve(__dirname, './src'),
    },
  },
});
