const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: [
    'src/audio/worklets/synth-worklet.ts',
    'src/audio/worklets/effects-worklet.ts',
  ],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  outdir: 'public/worklets', // Changed from outfile to outdir
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
