# Plan: band-limit improvement pass 1 (adaptive tables + FRAC_BITS)

> **REVISION 2026-09-22 21:30.** D1 below (8·H sizing) was **falsified** by
> measurement before any code change; the pass stopped under D5; Morten
> un-stopped with option (a): **64·H sizing**, same FRAC_BITS 7. The binding
> decision is now **D1′** in §9 below. §1–§8 are kept as originally decided,
> with the superseded entries marked.

Date: 2026-09-22 ~21:15+02:00. Worktree: `.ai/worktrees/bandlimit2`, branch
`agent/band-limit-improve-0922a`, base `agent/arch-fix2-0922a` @ b6febdee
(deliberate wasm-artifact stacking on the engine pass — do NOT rebase onto main).
Input: `.ai/band-limit-analysis.md` (committed on main; read-only analysis pass
2026-09-22). Morten's delegation: improvements **1+2 APPROVED**; improvement 3
(ring mod) and everything else **OUT OF SCOPE**.

## Scope (verbatim decisions)

- ~~**D1 (2026-09-22 21:15).**~~ **SUPERSEDED by D1′ (§9)** — implement analysis
  improvement **#1** only:
  adaptive per-level table size. For mip level `j` with harmonic count
  `H = level_harmonics(j)`, the level's table becomes
  `clamp(next_pow2(8*H), 64, 4096)` points instead of fixed
  `TABLE_SIZE = 4096` (`hifi.rs:114`). Rationale: preserves the ≥8 points per
  top-partial-period that `hifi.rs` module docs (~:111-113) rely on, and keeps
  `H <= size/8` (the "Nyquist bin never populated" invariant, module docs).
  Level 0 (H=512) keeps 4096; the deepest levels shrink to 64.
- **D2 (2026-09-22 21:15).** Floor the per-table size at the cycle length `n`
  (4..128, power of two): `size = max(clamp(next_pow2(8*H), 64, 4096), n)`.
  MEASURED at `hifi.rs:~289` (`oscillator`): `ratio = (TABLE_SIZE / n) as u64`
  is *integer* division, so a per-level size below `n` would make `ratio` 0
  (frozen phase) — the analysis spec misses this. The floor only ever bites on
  deep-dull levels (H ≤ 4) of long cycles: in-engine `f0*n <= ~0.65` bytes per
  sample (analysis §1, period clamp 0x71..0xd60 at 48 kHz) means the selected
  level for an n=128 cycle has H=64 → 512 points; the floor is reachable only
  by hand-built test fixtures (e.g. `dc_is_preserved` with f0=0.1, n=128 → H=4
  → raw 64 < 128). `size` and `n` are both powers of two, so `ratio = size/n`
  stays exact. Quality: ≥32 points per partial period on floored tables.
- **D3 (2026-09-22 21:15).** Implement analysis improvement **#2** bundled:
  `FRAC_BITS` 4 → **7** (`hifi.rs:133`), not 6.
  Why 7: alias floor −86…−90 dB vs −81…−86 dB for 6 (analysis M4, MEASURED in
  simulation), at zero per-sample CPU cost either way.
  Headroom check (analysis M4 + MEASURED off the code):
  - Table peak ≤ 1.19 × i8 full scale (M5/M6 Gibbs bound estimate) →
    1.19 · 127 · 2^7 ≈ 19 341; MEASURED table peak in the landed 64·H build is
    ~22 900 i16 (landing review, 2026-09-22) — both < `i16::MAX` = 32 767;
    `build_level`'s clamp (`hifi.rs:435`) never saturates. FRAC 6 would be
    roughly half of these figures.
  - Mixer scale-through (`engine.rs` mix_chunk, HIFI lanes `:1394-1411`,
    scalar `:1432-1466`): `s·vol` ≤ 22 900·64 ≈ 1.47e6 (i32 ✓);
    `(j·pan) >> 7` with pan multiplier ≤ 255 (verify `pan_mult_left/right`
    provenance ≤ 255 when implementing; even 256 keeps it ≈ 3.2e8 < i32::MAX,
    ~6.8× margin) ✓; per-channel sum over 16 voices ≤ ~4e7 (i32 ✓); the
    mix-gain shift already runs in i64 (`>> (8 + FRAC_BITS)`), so the wider
    FRAC_BITS only widens an intermediate that is already 64-bit ✓.
  - CAPTURE scope path (`engine.rs`, `j >> FRAC_BITS`) widens with the const —
    check the capture clamp still holds (i16 cast) when implementing.
- **D4 (2026-09-22 21:15).** Ring-mod (#3/#4), BLEP rewrite (#5), headroom
  soft-clip (#6), Amiga output (#7): **not implemented.** #4 is parked
  explicitly for Morten's A/B.
- ~~**D5 (2026-09-22 21:15).**~~ Expected audible change: **none** (INFERRED;
  analysis §7 rows 1–2, "Bit-exactness" column). **Superseded by D1′/§9:** this
  expectation was falsified for 8·H sizing (§9); for 64·H it holds by
  simulation at every pitch tested.

## 9. Revision: D1 falsified, pass stopped, revised to 64·H (2026-09-22 21:28-21:30)

### 9.1 The stop (verbatim from the coder run, session e0d5e212, opus 5.5,
2026-09-22 21:22+02:00)

> "I stopped under plan D5 and your hard constraint. I edited no tracked files
> and made no commits … The plan (D5) and the analysis both assume the new
> table sizes change samples only 'in the last LSBs'. They don't."

Nothing was implemented (steps 2–9 never ran); tree unchanged at b6febdee.

### 9.2 D1 falsification (MEASURED in simulation — bit-faithful numpy port of
`hifi.rs` `staircase_spectrum`/`build_level`/`sample`, 48 kHz, 65536-pt BH4;
script: `.ai/bandlimit2-alias-sim.py`, full output: `.ai/checks-bandlimit2.txt`)

With only 8 table points per period of the top partial, linear interpolation
creates images that fold into the audible range. Level 0 was always built this
way, but with 512 partials the effect is buried; giving *smaller* levels the
same 8 points/period makes aliasing **10–28 dB worse at mid and high pitches**.
FRAC_BITS 7 cannot help: its −86…−90 dB target sits under a new −50…−60 dB
interpolation floor. Inharmonic energy, dB (lower better; H = partials kept):

| Case | Current (4096 pts, F4) | 8·H (F7) | 16·H | 32·H | **64·H** |
|---|---|---|---|---|---|
| sq4, H=8 | −77.5 | −50.2 | −62.3 | −74.0 | **−82.0** |
| sq4, H=3 | −78.3 | −59.3 | −59.3 | −71.4 | **−83.2** |
| saw8, H=6 | −74.6 | −50.9 | −63.0 | −75.0 | **−86.1** |
| sq32 25%, H=64 | −70.2 | −57.9 | −67.6 | −70.7 | **−71.0** |
| tri16, H=64 | −73.3 | −63.7 | −76.0 | −78.2 | **−78.4** |

Same result with unquantised tables → the cause is interpolation, not rounding.
64·H **matches or beats current at every pitch tested** (simulation).

### 9.3 D1′ (binding, 2026-09-22 21:28 — Morten's un-stop decision, option (a))

Implement improvement #1 with the sizing rule
`clamp(next_pow2(64·H), 64, 4096)` per level (H = level's harmonic count),
plus **D3 unchanged: FRAC_BITS 4 → 7**, plus **D2 unchanged: per-table size
floored at the cycle length n** (ratio integrality). Verbatim rationale:

> "only (a) preserves the pass's hard constraint of no measurable quality
> regression (your measurements: matches or beats current at every pitch
> tested), and FRAC 7 deepens the floor again once the 64·H interpolation
> floor is lifted. Savings land where they exist (levels with <64 partials
> shrink); we accept that the 4× dream is dead — honest scope beats a quality
> regression."

Exact per-level sizes (MEASURED off the ladder, `level_harmonics`):
levels 0–7 (H=512…45) → 4096 (unchanged); levels 8–9 (H=32,23) → 2048;
levels 10–11 (H=16,11) → 1024; levels 12–13 (H=8,6) → 512; levels 14–15
(H=4,3) → 256; level 16 (H=2) → 128; level 17 (H=1) → 64. Per-source table
points: 73728 → 40640 (**−45%**; the ~4× memory dream of the original D1 is
dead by decision). Prewarm savings land only on builds at levels ≥ 8.
Level counts, ladder, `level_for`, `MAX_HARMONICS`, `MAX_CACHED_TABLES`:
unchanged.

### 9.4 Guardrail carried into the revision (unchanged)

If implementation shows the 64·H + FRAC 7 combination *also* regresses quality
anywhere measurable → stop again with the evidence. No audible/quality
regression goes in.

Everything else in this plan (implementation shape, tests, gates, artifact
procedure, commit plan) applies unchanged under D1′.

---

Everything below §9 is the original plan text (superseded entries marked);

## Files / mechanisms (verified MEASURED against this worktree)

| What | Where |
|---|---|
| `TABLE_SIZE=4096`, `MAX_HARMONICS`, `FRAC_BITS=4`, `PHASE_MASK` | `rust-wasm/src/ahx/hifi.rs:114,119,133,136` |
| `level_harmonics` ladder (18 levels, 512→1) | `hifi.rs:152-166` |
| `HifiOsc { table, ratio }`, `sample` (16.16 phase, 2 reads, lerp) | `hifi.rs:170-202` |
| `sample4` 4-lane variant | `hifi.rs:204-222` |
| `HifiBank`: single inverse-FFT plan `plan_fft_inverse(TABLE_SIZE)`, 4096-slot scratch | `hifi.rs:262-277` |
| `oscillator`: `ratio: (TABLE_SIZE / n)` | `hifi.rs:~289` |
| `build_level`: bins 1..=H + conjugates, inverse FFT, round to i16 ×2^FRAC_BITS | `hifi.rs:~421-435` |
| Voice per-tick pick | `voice.rs:710-724` (`select_hifi`; noise → None) |
| Mixer consumption: only `h.sample4` / `h.sample` + `FRAC_BITS` const | `engine.rs:1394-1411, 1432-1466` |

Implementation shape (smallest diff that keeps the invariants):
- `TABLE_SIZE` stays as the *maximum* (rename or keep + doc); per-level size
  function `table_size_for(harmonics) -> usize` (pure, unit-testable), floored
  at `n` at build time (D2).
- `HifiOsc` carries its own phase mask + index wrap (per-table `size`), replaces
  the file-level `PHASE_MASK` and `TABLE_SIZE-1` indexing (`sample`, `sample4`).
  Arithmetic per sample unchanged: still one mul, mask, two loads, one lerp.
- `HifiBank` plans inverse FFTs per needed size (rustfft's planner caches per
  length; keep the planner in the bank) and slices the existing 4096-slot
  scratch to `size` per build.
- `Source` keys stay table contents (fixed `n` per source, since key = the
  `n`-byte cycle) — so per-source level tables can keep the `LEVEL_COUNT` slot
  array with per-level sizes resolved at build.
- Docs in `hifi.rs` module + consts updated to match (8 points per top partial
  period, ≥8 guaranteed by next_pow2; floored tables get more).

## Alternatives considered

| Question | Option | Verdict |
|---|---|---|
| FRAC_BITS 6 or 7 | 6: −81…−86 dB floor, more i32 margin | Chosen **7** (D3): margin still ~6.8×, floor 5 dB better, zero CPU |
| Small-table floor for `ratio` | fractional 16.16 `ratio` (extra shift per sample) | Rejected: per-sample CPU for a case the engine never hits; `max(size, n)` (D2) costs nothing |
| Per-level size stored vs recomputed | stored in a const ladder | Chosen: pure fn + `OnceLock` table, mirrors `level_harmonics` style |
| Scratch per size | separate scratch vecs | Rejected: one 4096 slot vec, slice per size |

## Tests and gates

1. New unit tests in `hifi.rs` (or the integration test file): `table_size_for`
   over all 18 levels (exact sizes), boundary behavior (H=1 → 64, H=512 →
   4096, non-power-of-two H → next_pow2), and the D2 floor invariant
   `size >= n` across realizable `(n, f0)` pairs (`f0*n <= 0.65`).
2. `cargo test --features native-host` in `rust-wasm/` (plain `cargo test`
   exit 101 is PRE-EXISTING: `tests/engine_node_integration.rs` needs
   `native-host` — `.ai/plan-arch-fix2.md:192-194`, checks-archfix2.txt). Must
   include `ahx_hifi.rs` properties, `ahx_render_golden.rs` (must NOT move),
   `ahx_hifi_baseline.rs` (WILL move — see D5 below).
3. **Baseline regen (D5, verbatim decision):** regenerate
   `rust-wasm/tests/ahx_hifi_baseline.rs` hashes via
   `PRINT_HIFI_BASELINE=1 cargo test --test ahx_hifi_baseline -- --nocapture`.
   Justification for the commit: intentional DSP change (adaptive table size +
   FRAC_BITS 7), per analysis §7/#1+#2 and the pin's own header ("when hi-fi is
   *meant* to change, regenerate ... and say why"). The hash also folds prewarm
   table/source counts; #1 does not change *which* levels are built, only their
   sizes, so counts must stay identical — verify counts unchanged and say so.
4. **Untouched-by-construction confirmations (MEASURED after the change):**
   - 84-song byte-exact export suites (`ahx-writer-corpus.test.ts`,
     `ahx-exporter-corpus.test.ts`) — file serialization only.
   - Reference render goldens (`ahx_render_golden.rs` + `tests/golden/`) —
     `HIFI=false` instance is separate code (`engine.rs:1311-1316`).
5. Table-memory measurement (MEASURED): before/after sum of table bytes for the
   5 baseline songs via a print (prewarm each song, Σ `table.len()*2`), or
   equivalent in-repo harness; also prewarm wall-time per baseline song
   before/after if cheaply measurable natively (upgrade the stall claim from
   INFERRED to native-MEASURED; browser stall stays INFERRED).
6. Frontend gates to `.ai/checks-bandlimit2.txt`: touched vitest suites +
   FULL `npm run test:run` (includes the artifact-freshness gate), eslint,
   `vue-tsc --noEmit`. Gitleaks if permitted (else say so; parent runs it).
7. Rebuild the wasm artifact: `npm run build:wasm` (wasm-pack target web
   --release, no wasm-opt by default); commit the new
   `public/wasm/audio_processor_bg.wasm`, `public/wasm/SOURCE_HASH.json`
   (written by the build, hash of committed sources must equal manifest —
   `scripts/artifact-freshness.cjs` verifies), and `audio_processor.js` glue
   only if the build changes it.

## Commit plan

On `agent/band-limit-improve-0922a` only. NO push, NO merge, NO rebase.
- Commit 1: hifi.rs change + tests + regen'd baseline + docs; commit message
  states FRAC_BITS=7 choice + why, baseline-regen justification, table-count
  invariance.
- Commit 2: rebuilt wasm artifact + SOURCE_HASH.json (+ glue if changed).
- Gates output appended to `.ai/checks-bandlimit2.txt` (committed or left
  uncommitted per repo habit — prior passes committed evidence logs; follow
  plan-arch-fix2's pattern).

## Smaller decisions

- `MAX_HARMONICS` (512) and the 18-level ladder are untouched: level *counts*
  stay identical, only table *sizes* change (keeps the hash's table/source
  counts stable — see D5 check).
- `MAX_CACHED_TABLES` (4096) counts tables, not bytes: unchanged. Worst-case
  memory drops ~4× anyway (most levels are far below 4096 points); do not
  retune the cap in this pass.
- No public/demos changes; no TrackerPage/IndexPage changes; rust-wasm edits
  limited to hifi/table-size + FRAC_BITS scope.
## Landed (2026-09-22)

Landed on `main` from `agent/band-limit-improve-0922a` @ 20c33f08 (base
b6febdee, ancestor of main) via no-ff merge `df2b34a6`; push range
`32aacc6a..df2b34a6`. Worktree `.ai/worktrees/bandlimit2` and the branch are
left in place, clean.

### Review

PASS. Independent reviewer verified all 8 verification areas; 2 non-blocking
nits (the doc nit is fixed in this landing commit — see below).

### The falsification story (§9)

- D1 (8·H sizing) was falsified by measurement before any code change:
  bit-faithful numpy simulation (`.ai/bandlimit2-alias-sim.py`) showed that 8
  table points per period of the top partial create interpolation images
  folding into the audible range — 10–28 dB worse at mid/high pitches
  (−50…−60 dB floor), which FRAC_BITS 7 cannot rescue. The coder run stopped
  under D5 having edited nothing (session e0d5e212, 21:22).
- Morten un-stopped with option (a): **64·H sizing + FRAC_BITS 7** (D1′).
  Simulation: 64·H matches or beats current at every pitch tested.

### Measured before/after (native, 44.1 kHz, release; checks-bandlimit2.txt)

- Quality guardrail: **30/30 cases, worst d −0.0 dB, best d −13.2 dB,
  regressions 0** (SUMMARY M64).
- Table memory: total table_bytes 42,770,432 → 40,497,152 (**−5.3%** over the
  7 baseline songs; per-song −1.2%…−27.8%); per-source ceiling 73,728 → 40,640
  points (−44.9%). Table/source/tick counts identical on all 7 songs.
- Prewarm: ~unchanged (median deltas −7.1%…+1.9%; two songs +≤2%, measurement
  noise).
- Baseline regen (D5): `ahx_hifi_baseline` hashes regenerated with counts
  verified unchanged; old pin FAILED before regen (karma moved) as expected.
- Untouched-by-construction: 84-song byte-exact export suites pass; all 38
  `ahx_render_golden` fixture renders pass (the manifest test's known
  pre-existing fixture-count failure untouched — 24 vs 84,
  `.ai/plan-arch-fix2.md:196`).

### Post-merge gates on main (df2b34a6, real exit codes)

| Gate | Result |
|---|---|
| `npm run test:run` | PASS — 236 files / 3758 tests, exit 0 |
| eslint | PASS, exit 0 |
| `vue-tsc --noEmit` | PASS, exit 0 |
| `npm run check:artifacts` | PASS — worklets/wasm match sources, exit 0 |
| `gitleaks detect --no-git` | PASS — no leaks |
| `cargo test --features native-host` | 268 passed, 1 known pre-existing failure (`ahx_render_golden::manifest_covers_every_fixture`, 24 vs 84 — documented, NOT a blocker) |

### Deploy (2026-09-22 ~22:08–22:10)

`scripts/deploy.sh` →
avatar@192.168.50.161:~/repos/docker-info-ws-server/html/synth. Full output:
`.ai/deploy-bandlimit-20260922.log` (force-added; `.ai/` is gitignored at
`.gitignore:41`). Build succeeded; script's own verify: "Deployed and
verified". Independent md5 byte-match, local `dist/spa` ↔ remote — all 8
artifacts identical:

| Artifact | md5 | match |
|---|---|---|
| index.html | 9a6484b9c32508a3d3aed1c4c2efcd8b | ✓ |
| wasm/audio_processor_bg.wasm | e52bf5a9cd4f38e458532726f86e3f67 | ✓ |
| wasm/audio_processor.js | b4a1b4ccd50a92959320c9763539ef94 | ✓ |
| worklets/ahx-worklet.js | 0b1e28a2d692f80a2f9fc3a46d77f1e6 | ✓ |
| worklets/effects-worklet.js | ea0b2d2be2fd5dd6ec9a6a6ccb5c5e71 | ✓ |
| worklets/recording-worklet.js | 9c96bf69c35c1b90db4314dd0923147f | ✓ |
| worklets/synth-worklet.js | d3be4813a900d1db107ac182b425f346 | ✓ |
| demos/index.json | eb5a5b28e6a62dc81ec3cd28998ccdd6 | ✓ |

Wasm provenance note: the deploy rebuild produced sha256 `a9f17cab…` while the
committed SOURCE_HASH.json output record is `61a0c69e…`; the SOURCE hash is
identical on both (`5c9e359d…`, 75 files), so the difference is the documented
non-byte-reproducible wasm rebuild class (timestamp/build-path), not source
drift. The deployed wasm is built from the merged sources and byte-matches the
local dist exactly. `audio_processor.js` glue unchanged (`58a87d19…`, matches
the committed record). Postdeploy residue (demos/index.json timestamp + wasm
rebuild) stashed residue-recoverable per the arch-fix2 precedent
(stash@{0} "On main: bandlimit postdeploy: deploy residue").

### Reviewer's doc nit — handling

The plan doc's D3 headroom check claimed table peak ~19 341 i16 (Gibbs-bound
estimate); the reviewer measured ~22 900 i16. Fixed in this landing commit:
the D3 bullet now records both the estimate and the measured peak
(~22 900 < `i16::MAX`, clamp never saturates) and the mixer-scale margin uses
the measured (larger) value (22 900·64 ≈ 1.47e6, i32 ✓). Conclusion unaffected.
