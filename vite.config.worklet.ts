// import { defineConfig } from 'vite';
// import { resolve } from 'path';
// import wasm from '@rollup/plugin-wasm';

// export default defineConfig({
//   plugins: [wasm()],
//   build: {
//     lib: {
//       entry: resolve(__dirname, 'src/audio/worklets/synth-worklet.ts'),
//       formats: ['iife'],
//       name: 'SynthWorklet',
//       fileName: 'synth-worklet'
//     },
//     outDir: 'public/worklets',
//     rollupOptions: {
//       plugins: [wasm()]
//     }
//   }
// });
