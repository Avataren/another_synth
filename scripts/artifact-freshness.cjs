/**
 * Freshness checks for the committed build artifacts the tests load.
 *
 * `public/worklets/{synth,effects,ahx}-worklet.js` and `public/wasm/*` are
 * committed, and tests load them directly (the built worklet in a `vm`, the
 * real wasm). A source edit committed without a rebuild would leave the suite
 * testing the old binary and passing. This module answers "was this artifact
 * produced from this source?" by content, never by mtime: git stamps every
 * file with checkout time, so mtimes say nothing after a clone.
 *
 * - Worklets: rebuild in memory with the exact options `build-worklets.cjs`
 *   uses and byte-compare with the committed files.
 * - Wasm: a rebuild needs the Rust toolchain and takes minutes, so
 *   `build-wasm.cjs` records a sha256 of every Rust input, and of the two
 *   files it produced, in `public/wasm/SOURCE_HASH.json`. The check
 *   recomputes all three.
 *
 * Used by `build-worklets.cjs`, `build-wasm.cjs`, `scripts/check-artifacts.cjs`
 * (`npm run check:artifacts`) and `src/tests/artifact-freshness.test.ts`.
 * Plan: `.ai/plan-arch-fix1.md` (D7-D11).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** The one set of esbuild options for the worklet bundles. */
const WORKLET_BUILD_OPTIONS = {
  entryPoints: [
    'src/audio/worklets/synth-worklet.ts',
    'src/audio/worklets/effects-worklet.ts',
    'src/audio/worklets/ahx-worklet.ts',
    'src/audio/worklets/sid-worklet.ts',
  ],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  outdir: 'public/worklets',
  minify: false,
  platform: 'browser',
  logLevel: 'info',
  loader: {
    '.ts': 'ts',
  },
};

const WORKLET_REBUILD = 'npm run build:worklets';
const WASM_REBUILD = 'npm run build:wasm';

/** Rust inputs whose content determines the wasm binary. */
const WASM_SOURCE_ROOTS = [
  'rust-wasm/src',
  'rust-wasm/Cargo.toml',
  'rust-wasm/Cargo.lock',
  'rust-wasm/rust-toolchain.toml',
  'rust-wasm/.cargo/config.toml',
];
const WASM_OUTPUTS = ['public/wasm/audio_processor_bg.wasm', 'public/wasm/audio_processor.js'];
const WASM_MANIFEST = 'public/wasm/SOURCE_HASH.json';

/** Reads a committed file by repo-relative path; null when it is missing. */
function readCommitted(relative) {
  const absolute = path.join(ROOT, relative);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute) : null;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function listFiles(relative) {
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return [relative];
  return fs
    .readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => listFiles(path.posix.join(relative, entry.name)));
}

/** sha256 over (path, content) of every Rust input, sorted, posix paths. */
function wasmSourceHash() {
  const files = WASM_SOURCE_ROOTS.flatMap(listFiles).sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(ROOT, file)));
    hash.update('\0');
  }
  return { sourceHash: hash.digest('hex'), fileCount: files.length };
}

function wasmManifest(read = readCommitted) {
  const { sourceHash, fileCount } = wasmSourceHash();
  const outputs = {};
  for (const file of WASM_OUTPUTS) {
    const bytes = read(file);
    outputs[file] = bytes ? sha256(bytes) : null;
  }
  return {
    comment: `Written by build-wasm.cjs. Checked by scripts/artifact-freshness.cjs; regenerate with ${WASM_REBUILD}.`,
    sourceRoots: WASM_SOURCE_ROOTS,
    sourceFileCount: fileCount,
    sourceHash,
    outputs,
  };
}

/** Called by build-wasm.cjs after it copies the wasm-pack output. */
function writeWasmManifest() {
  const manifest = wasmManifest();
  fs.writeFileSync(path.join(ROOT, WASM_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * @param read the committed-file reader (tests inject a tampered one)
 * @returns {string[]} problems; empty when the wasm matches its source.
 */
function checkWasm(read = readCommitted) {
  const manifestBytes = read(WASM_MANIFEST);
  if (!manifestBytes) {
    return [`${WASM_MANIFEST} is missing. Regenerate the wasm with: ${WASM_REBUILD}`];
  }
  const recorded = JSON.parse(manifestBytes.toString('utf8'));
  const current = wasmManifest(read);
  const problems = [];
  if (recorded.sourceHash !== current.sourceHash) {
    problems.push(
      `public/wasm is stale: the Rust sources (${WASM_SOURCE_ROOTS.join(', ')}) changed since the committed wasm was built. Rebuild and commit public/wasm with: ${WASM_REBUILD}`,
    );
  }
  for (const file of WASM_OUTPUTS) {
    if (recorded.outputs?.[file] !== current.outputs[file]) {
      problems.push(
        `${file} does not match the build recorded in ${WASM_MANIFEST} (replaced by hand, or rebuilt without the manifest). Rebuild and commit public/wasm with: ${WASM_REBUILD}`,
      );
    }
  }
  return problems;
}

/**
 * @param read the committed-file reader (tests inject a tampered one)
 * @returns {Promise<string[]>} problems; empty when every worklet matches.
 */
async function checkWorklets(read = readCommitted) {
  const esbuild = require('esbuild');
  const result = await esbuild.build({
    ...WORKLET_BUILD_OPTIONS,
    absWorkingDir: ROOT,
    write: false,
    logLevel: 'silent',
  });
  const problems = [];
  for (const output of result.outputFiles) {
    const relative = path.relative(ROOT, output.path).split(path.sep).join('/');
    const committed = read(relative);
    if (!committed) {
      problems.push(`${relative} is missing. Rebuild and commit it with: ${WORKLET_REBUILD}`);
      continue;
    }
    if (!Buffer.from(output.contents).equals(committed)) {
      problems.push(
        `${relative} is stale: it differs from an esbuild of its current TypeScript sources. Rebuild and commit it with: ${WORKLET_REBUILD}`,
      );
    }
  }
  return problems;
}

module.exports = {
  WORKLET_BUILD_OPTIONS,
  readCommitted,
  WASM_MANIFEST,
  checkWasm,
  checkWorklets,
  wasmSourceHash,
  writeWasmManifest,
};
