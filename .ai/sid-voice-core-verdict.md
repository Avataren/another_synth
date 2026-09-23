# S1 SID voice core — verdict (8580 rows of plan §1.2 + batch row S1)

Status 2026-09-23, branch `agent/sid-voice-core-0923a`. Not merged, not pushed.
Scope: `.ai/plan-sid-tracking.md` §6 row S1 and the **8580** rows of §1.2. The 6581
rows are S2 and are not here (the model flag refuses a 6581, see below).
Starting point: the accepted S0 spike (`.ai/sid-spike-verdict.md`, `sidspike/`).

## What landed

`rust-wasm/src/sid/` (2565 lines incl. tests), wired in with one line
`pub mod sid;` in `rust-wasm/src/lib.rs`. Zero new dependencies and no vendored code.

| File | Content |
|---|---|
| `mod.rs` | constants (PAL 985 248 Hz, 24-bit acc), `SidModel` (`Sid8580` implemented, `Sid6581` a refusing stub), `SidError`, datasheet pitch helpers |
| `chip.rs` | `Chip`: register map $00–$18 write, $1B OSC3 / $1C ENV3 read, per-cycle ordering (accumulators → sync → noise/envelope/latch), FILT1–3 routing, LP/BP/HP mode bits, 3OFF, master volume, boxcar decimation, output coupling, `render(&mut [f32])` at 44.1/48 kHz (8–192 kHz accepted) |
| `voice.rs` | accumulator, TEST hold, waveform latch (waveform-0 hold), 8580 linear DAC product, read-only accessors |
| `waveform.rs` | pure bit functions: saw, triangle, ring-mod triangle, pulse, TEST-forced pulse, 8580 wired-AND combinations |
| `envelope.rs` | measured rate table, 15-bit equality rate counter (ADSR delay bug), exponential divider, sustain equality, zero freeze |
| `filter.rs` | 2-pole TPT state-variable filter, 8580 cutoff/resonance maps (S0's) |
| `noise.rs` | 23-bit LFSR, TEST reset, combined-waveform write-back (lock-up) |
| `tests.rs` | chip-level goldens (hand derivations first), sync/ring truth tables, routing, saw-harmonic gate |

## Sample-rate model (plan §1.1 caveats, restated)

- **The digital core is cycle-counted** at 985 248 Hz: accumulators, waveform bit logic,
  sync, ring mod, TEST, noise LFSR and envelope all step once per chip cycle, exactly as
  the chip counts.
- **The analog path is a sample-rate model.** Each output sample is the boxcar average
  of the ~22.34 cycles it spans at 44.1 kHz (~20.53 at 48 kHz). The filter, volume and
  DC-blocking output coupling then run once per output sample. The boxcar is a cheap
  anti-alias with its first null at the output rate. Content above ~15 kHz is only
  partly suppressed.
- **Register writes land between chip cycles** (`clock`/`clock_cycles`). With `render`,
  a caller can only write at sample boundaries (in practice at 50 Hz ticks). The chip's
  one-cycle write pipeline delays are not modelled.
- So this is a sample-rate approximation of the analog path over an exact digital
  core. It is not cycle-exact audio, and it is not reSID.

## Model choices and INFERRED marks

**Carried unchanged from S0:**
- Pure waveforms, PWM comparator and the noise taps/seed (exact).
- The measured envelope rate table. The sourcing doubt S0 raised still stands: these
  values also appear in GPL emulators. They are hardware measurements, not code.
- The exponential breakpoints.
- The 8580 linear DAC with no DC offset (INFERRED).
- CHIP_GAIN 0.28 and the 16 Hz DC blocker (INFERRED tuning).
- The filter and both of its register maps (INFERRED tuning guesses, ears-gate).

**New in S1:**

| Behaviour | Model | Label |
|---|---|---|
| Ring mod | Triangle fold = `MSB(own) XOR NOT MSB(source)` (plan wording); touches the triangle function only, also inside combined waveforms | INFERRED (polarity of the NOT is the plan's spec; the XOR is the public die-level description) |
| Sync | Destination accumulator reset to 0 when its source's MSB **rises** (0→1) in this cycle; the source's wrap (MSB 1→0) does not sync; the destination's own increment that cycle is discarded; sources 1←3, 2←1, 3←2 | Rising edge and source map: public hardware notes/datasheet. Same-cycle ordering: INFERRED |
| Chained sync | A source that is itself sync-reset this cycle does not propagate its MSB rise (its MSB never presents as 1) | INFERRED |
| Sync lockout | TEST (or freq 0) on the source: MSB never rises, destination runs free. TEST on the destination: held at 0, sync is a no-op. Freq-0 destination: parked at 0 by the first sync | Follows from the above; pinned |
| TEST, oscillator | Accumulator 0 and held | Datasheet, exact |
| TEST, pulse | Pulse output forced to 0xFFF | Datasheet says "held at a DC level"; the level is INFERRED (test-bit digi lore) |
| TEST, noise | LFSR held at 0x7FFFFF. On release the first shift is exactly 2¹⁹/freq cycles later (phase relation reset) | Datasheet says "noise output is reset". All-ones value and immediate (not leaky) reset: INFERRED |
| TEST, envelope | **Not touched.** | See "Deviation from the brief" below |
| Combined waveforms 8580 | Bitwise AND of the selected 12-bit outputs (wired-AND view) | The AND is the public combinational view. That the 8580 ≈ ideal AND is INFERRED. The residual bit-line pull-down is **not modelled** (no GPL-free data) |
| Noise lock-up | With noise combined, tap cells whose DAC line is low are cleared just before each shift; the register can reach 0 (fixed point) and only TEST revives it | Public lore. Write-back timing: INFERRED |
| Waveform 0 | The DAC input holds its last value; the real slow fade is not modelled | INFERRED |
| ADSR delay bug | 15-bit rate counter compared for **equality**; lowering the period below the counter costs a full wrap (up to 32 768 cycles) | Public descriptions of the bug; equality model INFERRED |
| Sustain | Decay stops on level **==** S·17. Lowering S resumes the decay; raising it above the level lets the decay run to 0 | INFERRED (S0 used `>`) |
| OSC3 / ENV3 | Top 8 bits of voice 3's latched waveform (incl. combined/ring/held); voice 3's envelope level | Datasheet |
| Routing | FILTn → filter, else direct. No mode bit → filtered voices vanish. 3OFF drops voice 3 from the **direct** path only. FILTEX: no external input (silent). Volume linear VOL/15 | Datasheet. The linear volume and no 8580 volume-DC step are INFERRED |
| Unused reads | POTX/POTY/write-only registers read 0 | INFERRED simplification |
| Model flag | `SidModel::Sid6581`: `Chip::new` returns `SidError::ModelNotImplemented` with the reason ("its filter, combined waveforms, attack curve and DC offsets are the S2 batch"). No half-model | Decision |

**Deviation from the brief (deliberate, flagged for review):** the brief asks that TEST
"resets the envelope counter/shift register while asserted". The only documentation
available here is the datasheet's TEST text, which names the oscillator, the noise
output and the pulse output. It says nothing about the envelope. Inventing an envelope
reset would be a model claim with no source. So TEST leaves the envelope alone, and
`test_bit_leaves_the_envelope_alone` pins that. "Shift register" is read as the noise
LFSR, which TEST does reset. If Morten has a source for an envelope reset, the change
is two lines in `voice.rs`.

**The filter's pole count:** the plan's §1.2/S1 wording says "3-pole". The datasheet
fixes the SID filter at 12 dB/oct LP/HP and 6 dB/oct BP, taken from one two-integrator
loop. That is 2 poles, and the summable LP/BP/HP modes (incl. the LP+HP notch) exist
only in that topology. §1.2 gives no concrete reason for a third pole: its "3-pole"
reads as a loose description of "resonant multimode". I therefore **kept S0's 2-pole TPT
SVF**. The tests pin 12/12/6 dB/oct slopes, the LP+HP notch, |H(fc)| = Q, unity DC gain
and stability over the register grid at 44.1 and 48 kHz. If the ears gate wants a
steeper top, the swap is a one-pole after the LP tap in `filter.rs`. That would no
longer match the datasheet slope.

**Not modelled (8580 scope, honest):** the one-cycle write pipeline; the waveform-0
fade; 8580 combined-waveform pull-down residue; the leaky noise reset time; the
analog filter's small nonlinearity; external audio input; paddles; the bus-decay read
value.

## Pitch number correction (found while pinning goldens)

The plan and S0 state "A-4 = 7493 → 440.02 Hz, +0.08 cent". Exact:
7493·985 248 = 7 382 463 264; minus 440·2²⁴ = 488 224; /2²⁴ = 0.0291. So the pitch is
**440.0291 Hz, +0.114 cent**. "440.02" is that value truncated, and S0's cent figure was
an arithmetic slip. Still far inside the 2-cent gate; `a4_register_is_7493_at_440_02_hz`
pins the exact value.

## Tests

Invocation (native, `rust-wasm/`):
```sh
cargo test --features native-host --no-fail-fast
```
Plain `cargo test` does not build: `tests/engine_node_integration.rs` and
`tests/envelope_preview.rs` import `audio_engine::native`, which needs `native-host`
(`.ai/checks-s1-baseline-cargo-test-nofeature.txt`). That is pre-existing and was
not touched.

| Run | Passed | Failed | Ignored | File |
|---|---|---|---|---|
| Baseline (before S1) | 267 | 1 | 1 | `.ai/checks-s1-baseline-cargo-test.txt` |
| Final | 329 | 1 | 1 | `.ai/checks-s1-final-cargo-test.txt` |

The one failure is identical in both runs and pre-existing:
`ahx_render_golden::manifest_covers_every_fixture` asserts 24 files in
`public/demos/ahx`, and there are now 99 (`public/` is out of scope). No regression:
+62 passed = exactly the 62 new `sid::` tests. The new files add no compiler warnings.

**New tests: 62**, all through the real construction path (`Chip::new` → register
`write`/`read` → `clock`/`render`, or the pure public functions of the real modules):
- `sid::tests` (41), chip-level:
  - model flag;
  - pitch ×4: A-4 exact, C-1..A#7 within 2 cents plus the top-of-range clamp,
    an accumulator/OSC3 golden trace, 100 wraps in 224 000 cycles;
  - rendered 440 Hz at 44.1 and 48 kHz;
  - envelope ×7: attack on the measured period, exponential decay 756 periods,
    sustain equality, release + zero freeze, ADSR delay bug (27 777 cycles) with
    its control case, retrigger from the current level, TEST leaves the envelope alone;
  - sync ×11: rising-edge only, no SYNC bit, source wrap vs destination wrap,
    TEST-held destination, TEST-held source lockout, TEST on a source with MSB set,
    zero-freq destination, zero-freq source, chained sync, all three source pairs;
  - ring ×2: chip-level truth table, live-source check every cycle for all three pairs;
  - TEST ×3: accumulator, pulse, noise reset + phase;
  - noise lock-up + TEST recovery, with its pure-noise control;
  - combined waveforms via OSC3, waveform-0 hold, OSC3/ENV3 are voice 3 only;
  - routing ×6: FILT bits, filter registers, per-voice FILT, 3OFF, linear volume,
    band-pass;
  - saw harmonics ×2.
- `sid::waveform` (8): the bit functions, the ring truth table, the wired-AND, TEST pulse,
  waveform 0.
- `sid::envelope` (2): table vs datasheet, breakpoints.
- `sid::filter` (6): maps, stability at 44.1/48 kHz, DC gain/overshoot, resonance =
  Q, slopes, no-mode silence + notch.
- `sid::noise` (5): seed/shift, balance, no self lock-up, TEST value, write-back.

**Negative controls** (`.ai/checks-s1-negative-controls.txt`). Each mutant was run against
the real code, then the tree was restored and verified with `diff -r`. Every one is
killed by the tests meant to catch it:
- sync on any MSB change (5 fail); no chain rule (1); wrong sync source map (9);
- ring fold without the NOT (3);
- S0's `>=` rate compare, which loses the delay bug (1); S0's floor sustain (1);
- no noise write-back (2); TEST not resetting noise (2); TEST not forcing pulse (2);
- 3OFF ignored (1); OR instead of AND (13);
- waveform 0 → midpoint (2); point-sampling instead of the boxcar (2).

Two first-attempt mutants were mis-targeted (a `sed` hit the wrong line; one injected DC
instead of removing the boxcar). They are recorded as such in the file, and the redo is
beside them.

## Gate 3: saw-harmonic deviation, closed by first cause

S0's selftest failure was **not** in the chip. Experiment
(`.ai/sid-voice-core/saw_harmonic_experiment.py`, output in
`.ai/checks-s1-saw-harmonic-experiment.txt`; it loads S0's `spectral.py` unmodified):

| Measurement | max \|dev\| k=1..10 |
|---|---|
| A: ideal analytic saw at 440.03 Hz, S0 estimator | 1.21 dB (k=4) |
| B: ideal analytic saw at a bin-centred 441.43 Hz, S0 estimator | 0.00 dB |
| C: rendered S0 `wave-saw.wav`, S0 estimator | 1.23 dB (k=4) |
| C minus predicted Hann scalloping | ≤ 0.14 dB (= boxcar droop) |
| D: rendered `wave-saw.wav`, Hann DFT evaluated at exactly k·f0 | 0.14 dB (k=10) |
| D minus predicted boxcar sinc droop | ≤ 0.01 dB |

**Verdict.** The first cause is the estimator's scalloping loss, not the boxcar
decimator. S0's check takes the peak FFT bin near k·f0. With 4096 points at 44.1 kHz,
k·440.03 Hz sits k·40.87 bins in, so k=4 is 0.48 bins off-grid. A Hann window loses
1.42 dB half a bin off-centre. The same estimator gives the same deviation on an ideal
analytic saw with no chip in the path, and 0.00 dB at a bin-centred pitch. Measured at
the exact harmonic frequency, the chip's saw sits on −20·log10(k) to within the boxcar's
predicted sinc droop (≤0.14 dB at 4.4 kHz), with ≤0.01 dB left over. The model is right,
so nothing is changed.

Pinned in Rust:
- `saw_harmonics_match_ideal_minus_decimator_droop`: exact-frequency DFT, tolerance
  **0.05 dB** (S0's was 0.5).
- `s0_bin_grid_estimator_reproduces_the_scalloping_first_cause`: S0's own estimator on
  a fresh render matches the analytic scalloping + droop prediction within 0.05 dB, and
  shows the ~1.2 dB k=4 miss.

The point-sampling mutant kills both, so the droop term is really measured, not
assumed. The S0 selftest in `sidspike/tools/spectral.py` is left as it was (throwaway
code). Its 0.5 dB assertion is simply the wrong instrument for off-grid harmonics.

## Ears-gate caveats: what Morten should listen for

No reference recordings exist and none were used. Nothing here claims fidelity to
hardware recordings. These are listening items. The S0 list is carried whole and
extended:

1. **Resonance character/amount.** The Q curve (0.71 → 2.6, +8.3 dB) is a guess. Too
   polite? Too whistly at 15? Does the 8580 need more bite?
2. **Cutoff curve.** The linear 30 Hz–12 kHz map puts most of a sweep above ~2 kHz.
   Check the low end of sweeps and the ceiling.
3. **Filter linearity.** There is no saturation at all. Listen for sterility at high
   resonance.
4. **2-pole vs "3-pole".** Does the filtered top end sound too open next to what you
   expect from an 8580? (See the pole-count section; the swap is one file.)
5. **ADSR feel.** Decay/release snap and staccato retriggers. **New:** the ADSR delay bug
   is now IN (S0 lacked it). Notes whose envelope period is lowered past the rate
   counter can start up to ~33 ms late, as on hardware. GT-style hard restart should
   avoid it. Listen for "missing" or late attacks in fast passages. They are
   intended, but confirm they feel like the chip.
6. **Sustain equality (new).** Raising sustain mid-note lets the note decay to silence
   instead of swelling. That is intended, but check it against what songs expect.
7. **Noise brightness.** Noise follows 16·f0. Too dark or too bright? The boxcar
   decimator may add fizz.
8. **Top-end aliasing.** High saw/pulse notes and high-frequency noise can show
   inharmonic fizz; the boxcar is the only anti-alias.
9. **Level balance/mix.** The 0.28 chip gain and the 16 Hz DC blocker are arbitrary. Check
   thin bass or pumping, and three voices plus resonance near full scale.
10. **Envelope-to-waveform DAC.** Linear with no DC offset: is the gate-edge click on a
    real 8580 more audible?
11. **Combined waveforms (new).** Ideal AND. The real 8580's are said to be close but not
    identical (bit-line pull-down). Listen to saw+tri, pulse+saw and pulse+tri tones,
    e.g. GT instruments that use $30/$50/$60 waveforms. Are they too loud or too
    "digital"?
12. **Ring mod / sync timbre (new).** The logic is pinned. Check that classic ring-mod
    bells and sync leads sound right, including sync sweeps where the source is
    near the destination.
13. **Noise lock-up (new).** Combining noise with another waveform now silences noise
    until a TEST write, as on hardware. Tunes that mix noise combinations without
    TEST will lose their noise. That is intended, but flag it if a known tune goes quiet.
14. **Waveform-0 hold (new).** A voice whose waveform bits are cleared holds its last
    level with no fade; volume/envelope changes can then click. The real chip fades
    slowly.
15. **TEST-bit envelope choice (new).** If hard-restart routines that toggle TEST behave
    differently from expectations, the envelope choice above is the first suspect.
16. **Volume steps.** Master volume is linear with no 8580 DC step: volume-register digis
    will be near-silent, as on most 8580s. Confirm that is the wanted default.

## Reproduce

```sh
cd rust-wasm && cargo test --features native-host --lib sid::      # 62 new tests
cd rust-wasm && cargo test --features native-host --no-fail-fast   # full suite
python3 .ai/sid-voice-core/saw_harmonic_experiment.py              # needs sidspike/ (untracked S0 crate)
gitleaks detect --no-git --source .
```

Check outputs: `.ai/checks-s1-baseline-cargo-test.txt`,
`.ai/checks-s1-baseline-cargo-test-nofeature.txt`, `.ai/checks-s1-final-cargo-test.txt`,
`.ai/checks-s1-negative-controls.txt`, `.ai/checks-s1-saw-harmonic-experiment.txt`,
`.ai/checks-s1-gitleaks.txt`, `.ai/checks-s1-lint.txt`.
