# S5.15 verdict: 6581 die-revision calibration, target R4AR

Branch `agent/sid-r4ar-0924a`, parent `4e1da056` (main tip, v0.3.68). Code commit
`38991b25`. Not pushed, not merged. No wasm build, no deploy.

## 1. Research summary

Research notes: `.ai/sid-r4ar-research-notes.md` (main-side subagent run bc3d6d2c; public
sources only, zero GPL). Its conclusions are binding, and this pass follows them.

Sources:
- S1: Wikipedia, "MOS Technology 6581", Revisions:
  https://en.wikipedia.org/wiki/MOS_Technology_6581
- S2: C64-Wiki, "SID", sections "Chip variations" and "Trivia":
  https://www.c64-wiki.com/wiki/SID
- S3: the references behind S1's revision claim: chipmusic.org "C64 SID shootout - 6581 vs
  8580" (https://chipmusic.org/forums/topic/17495/) and polynominal.com
  "commodore-64-sid-6581-8580".

Facts used:
- F1 (S1): after R1 came R2, R3, R4 and R4AR, with "no substantial alterations", only
  input-pin protection/buffering, silicon grade and packaging.
- F2 (S2): 6581R4AR was produced 22/1986-06/1987, the last 6581.
- F3 (S2 Trivia): every 6581 volume-register write gave an audible click (the $D418
  sample trick). On the 8580 "samples were inaudible".
- F4 (S1): the 6581 filter's cutoff is non-linear and varies wildly between chips. There
  are no per-revision filter parameters in the public record.

Trait classification:

| Trait | Class | What the R4AR profile does |
|---|---|---|
| Filter cutoff curve | GENERIC-6581 (F4) | S5.12 R2's measured-anchor curve, unchanged |
| FC_HI $7F -> $80 step | GENERIC-6581 (not specified per revision) | the 0x3FF -> 0x400 drop between the anchor sets, unchanged |
| Output DC (voice DC, mixer DC) and the derived gain | GENERIC-6581 | S2 values: 0.25 / 0.5 / 0.197647, unchanged |
| Volume-DAC nonlinearity | GENERIC-6581 vs 8580 (F3) | **NEW**: INFERRED 4-bit table; the 8580 stays linear |

No trait is R4AR-specific on public evidence. So R4AR's cutoff being the S5.12 curve is a
finding, not an omission. No difference was forced.

## 2. What changed in code

- `rust-wasm/src/sid/revision.rs` (new): `DieRevision { R4AR }`, `RevisionProfile`
  (cutoff anchors lo/hi, `volume_bit_weights`, `voice_dc`, `mix_dc`; `chip_gain()` holds
  the S2 headroom rule; `volume_level()` and `volume_table()`), the filled `R4AR` profile,
  `SID6581_REVISION` (the single swap point) and `profile_6581()`. Selection is
  engine-side: no .sng/.sid field encodes the die revision. The later R3 pass adds a
  profile and flips one constant.
- `filter.rs`: `CUTOFF_ANCHORS_6581_LO/_HI` and `F_LO_6581` are now read from
  `profile_6581()`. The map code is unchanged.
- `voice.rs`: `VOICE_DC_6581 = profile_6581().voice_dc`.
- `chip.rs`: `MIX_DC_6581` and `CHIP_GAIN_6581` are read from the profile. A new per-chip
  `volume_dac: [f64; 16]` holds VOL/15 on the 8580 and the profile table on the 6581. The
  new `Chip::volume_level(vol)` feeds both the mix and the per-voice taps. The header was
  updated: level(VOL) replaces VOL/15, and a die-revision section was added.
- `mod.rs`: `pub mod revision;` and `mod tests_s515;`.
- `tests_s2.rs`: `PIN_6581` re-captured (see §4).
- `tests_s515.rs` (new): 7 tests.

**Volume-DAC table (INFERRED).** Bit weights [1.0, 2.0, 3.9, 7.6] (sum 14.5), so
level(v) = (weights of v's set bits) / 14.5. This models a binary-weighted DAC whose two
upper bits run slightly under their ideal 4 and 8, the usual shape of an untrimmed NMOS
DAC. The table is monotonic and exact at 0 and 15, so every full-volume render is
unchanged. Its largest error is ±0.0092 of full scale at 7/8 (0.4759 / 0.5241 vs
0.4667 / 0.5333). The 7 -> 8 midscale step is 0.0483, where a linear DAC gives 0.0667. It
scales the tone and the S2 mixer DC alike, so a $D418 write steps the output by
MIX_DC · Δlevel · G6. The weights are a disclosed guess: no verified per-bit weights
exist publicly. Ears-gate item.

## 3. Red → green evidence

Red was captured in two stages on unmodified engine code (tests only). The logs are
`.ai/checks-s515-red-stage1.txt` and `.ai/checks-s515-red-stage2.txt`.

Stage 1, behavioural tests (these compile on the old code): `cargo test --lib tests_s515`
gave 0 passed, 3 failed, exit 101.
- `volume_dac_6581_mixer_dc_step_follows_the_r4ar_table_not_vol_over_15`: `vol 5:
  0.03294117748737335, want 0.0333955`. The old code gives linear 5/15.
- `volume_dac_6581_scales_a_steady_tone_by_the_table_and_the_8580_stays_linear`:
  `6581 vol 8: 0.5333333332210732, want 0.524138`.
- `volume_digi_is_loud_on_the_6581_and_silent_on_the_8580`: `7 -> 8 step
  0.006588233975946246` (want 0.0047708). The loud-6581 / silent-8580 assertions in this
  test passed on the old code too: S2's mixer DC already gave that trait. The red is the
  table-shaped step size.

Stage 2, API tests appended: compile failure, exit 101. `error[E0432]: unresolved import
super::revision` and 2× `error[E0599]: no method named volume_level found for struct
Chip` (tests `sid6581_plays_the_r4ar_profile`, `r4ar_cutoff_is_the_s512_measured_curve`,
`r4ar_output_dc_and_gain_are_s2s_values`,
`r4ar_volume_table_is_monotonic_nonlinear_and_exact_at_the_ends`).

Green (`.ai/checks-s515-green-sid.txt`): `cargo test --lib sid::` gave 137 passed, 0
failed, exit 0. All 7 `tests_s515` pass. All S2/S5.12 tests pass: the filter.rs anchor
and map tests, the tick-0 tests in `tests_s512.rs`, `pin_8580` bit-exact, and S2's VOL 15
step/digi and level-balance tests (unchanged, because level(15) = 1 exactly).

## 4. PIN_6581 re-capture (the one pinned value that moved)

The S2 pin program writes VOL 10 at sample 22 050. With the table that level is 0.662069
instead of 10/15, so pin values 27-32 changed (27 × 826 = 22 302 is the first pinned
sample after the write). Values 0-26 are bit-identical. New hash `0x2d1344bceadb4e1f`
(was `0xffd4c8a5a72afed7`).

Disable-and-reproduce check (`.ai/checks-s515-pin-linear-reproduce.txt`): with the
profile weights temporarily set to linear [1, 2, 4, 8], the OLD pin passed bit-exactly
(2 passed, exit 0). So the refactor through the profile is bit-neutral, and the INFERRED
table is the whole change. The weights were then restored to [1.0, 2.0, 3.9, 7.6].

## 5. Gates

| Gate | File | Result |
|---|---|---|
| Baseline cargo (before changes) | `checks-s515-baseline-cargo.txt` | 408 passed / 1 failed / 1 ignored, exit 101; failure: `manifest_covers_every_fixture` (ahx_render_golden) |
| Cargo after | `checks-s515-cargo.txt` | **415 passed / 1 failed / 1 ignored, exit 101**; the failure set is unchanged (`manifest_covers_every_fixture` only); +7 = the new tests |
| Vitest | `checks-s515-vitest.txt` | 261 files: 260 passed, 1 failed; 4210 tests: 4208 passed, 2 failed; exit 1 |
| Lint + vue-tsc | `checks-s515-lint.txt` | eslint exit 0; `vue-tsc --noEmit` exit 0 |
| Gitleaks (`/usr/bin/gitleaks detect --no-git --source .`) | `checks-s515-gitleaks.txt` | no leaks found, exit 0 |
| GPL guard | `checks-s515-gplguard.txt` | no 16+-entry hex table added; the only reSID/GPL keyword hit is the "GPL-free" source disclaimer line |

Both vitest failures are in `src/tests/artifact-freshness.test.ts`, and both come from the
Rust sources changing while `public/wasm` was not rebuilt (the brief forbids a wasm
build):
- "public/wasm matches the Rust sources recorded in SOURCE_HASH.json" reports `public/wasm
  is stale ... Rebuild and commit public/wasm with: npm run build:wasm`.
- "when a wasm output was replaced without rebuilding" expects exactly 1 problem and gets
  2: its injected problem plus the real stale-hash problem.

At the parent `4e1da056`, the same file passes 5/5 (`checks-s515-freshness-at-parent.txt`,
clean temp worktree). This matches the S5.12 precedent: freshness stays red until the
deploy's "refresh build inputs" commit (`npm run build:wasm`).

Zero GPL: no reSID/libsidplayfp code, tables, spline or bytes were consulted or copied.
The cutoff anchors are S5.12's published-figure anchors, moved rather than re-derived.
The volume weights are an original INFERRED guess.

## 6. Honest caveats

- Literature-based calibration. No real 6581R4AR was on the bench and nothing was
  measured.
- The volume-DAC table is INFERRED. No verified public per-bit weights exist. The shape
  (upper bits under-weighted, ≤0.01 FS error, monotonic) and the numbers are a tuning
  guess, marked INFERRED in code. Its audible effect is small by design: the loud 6581
  digi comes from S2's mixer DC (itself INFERRED, 0.5), which the table scales.
- The research run's web search was unavailable, and die-analysis pages (siliconpr0n
  6581, die-shot write-ups) returned 403/404. Any per-revision filter or volume data they
  may hold is UNVERIFIED here, not known to be absent.
- Because the public record gives nothing R4AR-specific, the "R4AR profile" is the refined
  generic-6581 model plus the new volume DAC. The R3 pass will likely be near-identical
  or identical on current evidence.
- The wasm artifacts are stale until the deploy rebuilds them. The browser app keeps the
  old (linear-volume) 6581 until then.
- The app's TS visuals port (`sid-instrument-visuals.ts`) mirrors the cutoff anchors,
  which did not change, and does not model volume. No port or fixture update was needed.
