/**
 * Fails when a committed build artifact no longer matches its source:
 * public/worklets/*.js vs an esbuild of src/audio/worklets, and public/wasm vs
 * the Rust inputs recorded in public/wasm/SOURCE_HASH.json. Each failure names
 * the regenerate command. The same checks run in the vitest suite
 * (src/tests/artifact-freshness.test.ts); see scripts/artifact-freshness.cjs.
 *
 * Usage: npm run check:artifacts
 */
const { checkWasm, checkWorklets } = require('./artifact-freshness.cjs');

(async () => {
  const problems = [...(await checkWorklets()), ...checkWasm()];
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exit(1);
  }
  console.log('✓ public/worklets and public/wasm match their sources');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
