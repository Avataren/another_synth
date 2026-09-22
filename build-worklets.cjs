const esbuild = require('esbuild');
// Shared with the freshness gate (npm run check:artifacts and
// src/tests/artifact-freshness.test.ts), which rebuilds with these same options
// and byte-compares against the committed public/worklets/*.js.
const { WORKLET_BUILD_OPTIONS } = require('./scripts/artifact-freshness.cjs');

const isWatch = process.argv.includes('--watch');

const buildOptions = WORKLET_BUILD_OPTIONS;

if (isWatch) {
  esbuild
    .context(buildOptions)
    .then((ctx) => ctx.watch())
    .catch(() => process.exit(1));
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1));
}
