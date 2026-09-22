// @vitest-environment node
//
// The committed build artifacts match their sources (arch review 2026-09-22
// N3, plan `.ai/plan-arch-fix1.md` D7-D11). Several tests load
// `public/worklets/*.js` and `public/wasm/*` directly, so a source edit
// committed without a rebuild would otherwise be tested against the old
// binary and pass. The checks live in `scripts/artifact-freshness.cjs`, shared
// with `npm run check:artifacts` and the build scripts.
//
// On failure, the message names the stale file and the command that
// regenerates it (`npm run build:worklets` or `npm run build:wasm`); commit
// the regenerated file(s) with the source change.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Read = (relative: string) => Buffer | null;
interface Freshness {
  WASM_MANIFEST: string;
  readCommitted: Read;
  checkWasm(read?: Read): string[];
  checkWorklets(read?: Read): Promise<string[]>;
}

const ROOT = resolve(__dirname, '../..');
const freshness = createRequire(import.meta.url)(
  resolve(ROOT, 'scripts/artifact-freshness.cjs'),
) as Freshness;

/** The committed files, with one of them seen as edited (nothing on disk changes). */
function withEdited(target: string, edit: (text: string) => string): Read {
  return (relative) => {
    const bytes = freshness.readCommitted(relative);
    if (relative !== target || !bytes) return bytes;
    return Buffer.from(edit(bytes.toString('utf8')));
  };
}

describe('committed build artifacts are fresh', () => {
  it('public/worklets/*.js are byte-identical to an esbuild of their sources', async () => {
    expect(await freshness.checkWorklets()).toEqual([]);
  }, 30_000);

  it('public/wasm matches the Rust sources recorded in SOURCE_HASH.json', () => {
    expect(freshness.checkWasm()).toEqual([]);
  });
});

// The gate has to fire, not just pass. Each case hands the check a reader
// that sees one committed file as edited; nothing on disk changes, so the
// suites that load these artifacts in parallel are unaffected.
describe('the freshness gate fails, with a regenerate instruction', () => {
  it('when a worklet bundle is older than its TypeScript source', async () => {
    // As if the N1 routing fix were committed without `npm run build:worklets`.
    const read = withEdited('public/worklets/synth-worklet.js', (text) =>
      text.replace('instrumentId: data.instrumentId', 'instrumentId: void 0'),
    );
    const problems = await freshness.checkWorklets(read);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('public/worklets/synth-worklet.js is stale');
    expect(problems[0]).toContain('npm run build:worklets');
  }, 30_000);

  it('when the Rust sources changed after the wasm was built', () => {
    const read = withEdited(freshness.WASM_MANIFEST, (text) =>
      text.replace(/"sourceHash": "[0-9a-f]+"/, '"sourceHash": "0000"'),
    );
    const problems = freshness.checkWasm(read);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('public/wasm is stale');
    expect(problems[0]).toContain('npm run build:wasm');
  });

  it('when a wasm output was replaced without rebuilding', () => {
    const read = withEdited('public/wasm/audio_processor.js', (text) =>
      text.replace('export', 'export /* hand-patched */'),
    );
    const problems = freshness.checkWasm(read);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('public/wasm/audio_processor.js does not match');
    expect(problems[0]).toContain('npm run build:wasm');
  });
});
