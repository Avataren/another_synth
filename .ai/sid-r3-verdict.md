# S5.16 verdict: 6581 R3 die-revision pass + measured-parameter cutoff map

Branch `agent/sid-r3-0924a` (worktree `.ai/worktrees/sid-r3`), base main
8d31dce6. No push, no merge, no amend; wasm not rebuilt (deferred, freshness
gate left as the 2 pre-existing failures). Landing is main-side after review
PASS.

## Research result (full notes: `.ai/sid-r3-research-notes.md`)

**The public record contains no R3-specific measured trait.** Neither
reference engine parameterizes die revision (reSID `siddefs.h.in:63`:
MOS6581|MOS8580); the only 6581 whose filter parts were measured in the
published record is the R4AR 0687 14 (reSID `filter.cc:29-70`, reSIDfp
`FilterModelConfig.cpp:47-90`). Encyclopedic sources list R3 vs R4AR
differences as production dates and packaging only ("no substantial
alterations", Wikipedia; C64-Wiki: R3 42/1985-07/1986, R4AR 22/1986-06/1987).
web_search had no provider in this environment; the hunt covered the primary
sources directly. This is the legitimate "nothing found" outcome — nothing
was invented to fill the gap.

Classification table (per trait): filter op-amp transfer R4AR-only-measured;
f0-DAC kink R4AR-only-measured, GENERIC-6581 claim; cutoff anchor figures
shared-6581 (community, chip-spread); volume DAC per-bit weights UNKNOWN for
every 6581 revision (both engines ideal — the [1,2,3.9,7.6] table stays
INFERRED, per S5.15); voice/mixer DC shared-6581, INFERRED; $D418 click
shared-6581; **R3-specific: NOT FOUND**.

## What changed

1. **`revision.rs`**: `DieRevision::R3` added; `SID6581_REVISION` flipped to
   R3 (most real SID songs were written for R3, Morten 15:36). R4AR stays
   intact and selectable. The R3 profile is INHERITED on every field —
   the discriminant is the only difference from R4AR (marked INHERITED, not
   SPEC/INFERRED, per the research result). `RevisionProfile` gains the
   measured R4AR kink/VCR SPEC parameters: `f0_dac_2r_div_r` 2.20,
   `f0_dac_terminated` false, `f0_dac_zero` 6.65, `f0_dac_scale` 2.63,
   `vcr_vth` 1.31, `vcr_vx` 5.0.
2. **`filter.rs` — the cutoff model upgrade (the R3 ammunition)**: the
   fit_6581-lineage log-linear anchor interpolation is replaced by a
   drive-segmented map (`cutoff_hz_6581_driven`):
   - register -> re-derived kinked 11-bit f0 DAC (`f0_dac_11`; plain R-2R
     circuit math re-derived in Rust from the adopted SPEC values — the
     published per-bit weights [1.000, 1.4545, 2.5702, 4.8542, ...]
     reproduce EXACTLY, ladder full-scale sums to 1.0000);
   - DAC voltage (bias + scale) -> VCR drive = squared excess over
     Vth + voice DC (triode square law, w0 ~ Ids/C);
   - between the 8 measured anchors the square law is fitted to each anchor
     pair, so every anchor is hit EXACTLY (the old chords passed within
     ±5%). The kinked DAC's real bit-boundary dips (~6% from 0x10 up) and
     the measured 6000 -> 4600 Hz $7F -> $80 step survive; the step is now
     DAC physics (low-ten-bits sum 0.5158 > top bit 0.4842), not a
     hand-authored special case.
   - Mechanics choice (documented per the brief): the anchors are KEPT as
     the calibration skeleton and superseded as the interpolation law; the
     profile gained the kink/VCR fields. A pure closed-form drive law
     WITHOUT per-segment fitting misfits the measured middle anchors by
     2-3x (chip-variant spread is not reproducible from one parameter set)
     — reSID/reSIDfp avoid this by integrating the VCR dynamically per
     clock, which a static TPT map cannot; the per-segment fit is the
     honest static equivalent.
3. **Pins superseded honestly (with disable-and-reproduce proof)**:
   - S5.12 map tests: anchor tolerance ±5% -> exact; hand point 0x280
     819.756 Hz (log-linear) -> 985.861 Hz (driven); per-piece strict
     monotonicity superseded by the DAC's real dips
     (`map_6581_follows_the_kinked_dac_and_keeps_the_fc_hi_step`).
   - S2 6581 render pin re-captured (hash 0x2d13_44bc_eadb_4e1f ->
     0x7575_57cc_bd4c_481b; the program's fc 0x305 moves 1642.0 -> 1699.0 Hz;
     the unfiltered tail is bit-identical) and the S2 peak-gain pin
     re-measured 11.225 -> 11.794. Proof that the map is the whole change:
     with the old log-linear map restored, ALL 16 tests_s2 pins reproduce
     bit-exactly (`.ai/checks-s516-pin-oldmap-reproduce.txt`).
   - **S5.6 `3 00` tie-branch pin untouched** (tests_s5.rs, verified green).
   - S5.15 swap-point test updated to R3 (R4AR selectability still pinned).
4. **TS port + fixture**: `sid-instrument-visuals.ts` ports the driven map
   op-for-op (plain circuit math, no GPL structure); the Rust-dumped
   `sid-visuals-parity.json` regenerated
   (UPDATE_SID_VISUALS_FIXTURE=1); vitest parity 7/7 against the new
   fixture. This follows the S5.12 R2 precedent (same situation, same
   resolution, commit ecf96547).
5. **Red-first**: `.ai/checks-s516-red-1.txt` — on the old map the new
   production-path pins failed (260 passed / 4 failed: driven-map equality,
   hand points, dips, stale R4AR assertion), everything else green.

## Gates (records `.ai/checks-s516-*.txt`)

- cargo lib: 264 passed / 0 failed (lib target).
- cargo full `--features native-host --no-fail-fast`: 421 passed / 2 failed
  / 1 ignored — the 2 failures are the pre-existing
  `manifest_covers_every_fixture` (fixture corpus count 99 vs 24, unchanged
  from main) and the wasm-deferred `sid_visuals_parity` fixture, which is
  REGENERATED and green in the final state (see below).
- vitest: 4208 passed / 2 failed — exactly the 2 pre-existing
  wasm-freshness failures (this is a wasm-deferred branch; `npm run
  build:wasm` not run per task scope). The parity file
  `sid-instrument-visuals.test.ts` passes 7/7 against the regenerated
  fixture.
- eslint: 0. vue-tsc: 0. gitleaks: clean.
- gplguard (adopted spec tables): the only reSID/GPL keyword hit in the diff
  is the "GPL-free" source-disclaimer line and the "SPEC ... not copied"
  disclosures; no GPL code structure, no lookup-table dumps — the f0 DAC is
  re-derived ladder math, the op-amp transfer is not embedded at all.

Final full-cargo state after fixture regeneration: 422 passed / 1 failed
(only the pre-existing `manifest_covers_every_fixture`), vitest unchanged.

## Honest caveats

- The R3 profile is a *label*, not a measurement: every value traces to
  R4AR measurements or S5.12 community anchors. If R3-specific data
  surfaces, fields move from INHERITED to SPEC one by one.
- The within-segment curvature and dip magnitudes are DERIVED (square law +
  kinked DAC), ears-gate; the old log-linear chords were equally derived.
  Ears check recommended across FC_HI $40-$7F, where the new map moves up
  to ~2x (e.g. reg 0x280: 820 -> 986 Hz; 0x380: 3106 -> 3600 Hz; 0x5AA:
  12580 -> 9161 Hz down).
- The static map cannot express per-chip spread (reSID's
  adjust_filter_bias / reSIDfp's setFilterCurve); a future bias knob maps
  onto `f0_dac_zero` directly.
- The volume-DAC digi trait stays INFERRED beyond-reference, unchanged.
