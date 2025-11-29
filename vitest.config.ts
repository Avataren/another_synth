import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      'app/public/wasm/audio_processor': fileURLToPath(
        new URL('./tests/__mocks__/audio_processor.ts', import.meta.url)
      ),
      src: path.resolve(__dirname, './src'),
    },
  },
});
