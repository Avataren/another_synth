// build-worklets.js
const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/audio/worklets/synth-worklet.ts'], // Update this path to your worklet file(s)
  bundle: true,
  format: 'esm',
  target: 'es2020',
  outfile: 'public/worklets/synth-worklet.js', // Output path
  minify: false,
  platform: 'browser',
  logLevel: 'info',
  loader: {
    '.ts': 'ts',
  },
};

if (isWatch) {
  esbuild
    .context(buildOptions)
    .then((ctx) => ctx.watch())
    .catch(() => process.exit(1));
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1));
}
