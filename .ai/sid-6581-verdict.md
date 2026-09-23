# S2 6581 character pass — verdict (6581 rows of plan §1.2 + batch row S2)

Status 2026-09-23, branch `agent/sid-6581-0923a` (from main tip `4f76a8d3`). Not merged,
not pushed. Scope: `.ai/plan-sid-tracking.md` §6 row S2, limited to the §1.2 **6581**
rows ("Waveform 6581 quirks", "ADSR", "Filter", "Output stage"). No store, engine or format
work. The row's "per-song SID-model tag" is S3 song-model work; S2 delivers the per-instance
switch it will need. The S1 record is `.ai/sid-voice-core-verdict.md`, and this batch keeps
its architecture, its 2-pole TPT filter, its pitch/TEST semantics and its boxcar decimation.

**No hardware claim is made anywhere.** No reference recordings exist and none were used.
Every 6581 number below is either a derivation from a stated rule or an INFERRED tuning
guess. None is a measurement of a chip. Real 6581s differ widely from one another (plan §1.1).
This is one invented "representative" chip for the ears gate.

## What landed

`SidModel::Sid6581` is now a real model, picked per `Chip` instance at construction.
`Chip::new(Sid6581)` succeeds and `unimplemented_reason()` is `None` for both models. Every
6581 behaviour is gated on the model. The 8580 render is **bit-identical** to S1 (proof below).
Zero new dependencies and no vendored code. Only `rust-wasm/src/sid/` changed.

| File | Lines (S1 → S2) | S2 change |
|---|---|---|
| `mod.rs` | 99 → 103 | model docs; both models construct; `tests_s2` module |
| `chip.rs` | 269 → 300 | per-model voices/filter; 6581 mixer DC `MIX_DC_6581`; derived `CHIP_GAIN_6581`; output-stage header |
| `voice.rs` | 206 → 321 | `Voice::new(model)`; 6581 DAC DC offset; attack-shape lag (`envelope_amplitude()`); waveform-0 fade |
| `waveform.rs` | 275 → 388 | 6581 combined-waveform neighbour pull-down (`combined_6581`, 4096-entry `COMBINED_6581` const table) + 2 tests |
| `filter.rs` | 240 → 480 | 6581 log-logistic cutoff map, weaker Q map, band-pass state soft limit; `Filter::with_model`, `cutoff()`, `q()` + 5 tests |
| `envelope.rs` | 216 → 218 | header only: the rate table and counter are shared, the 6581 shape lives in `voice.rs` |
| `noise.rs` | 148 → 148 | unchanged (the LFSR is the same circuit on both chips) |
| `tests.rs` | 1112 → 1111 | only S1's refusal test rewritten (below) |
| `tests_s2.rs` | new, 609 | render pins + 14 chip-level 6581 tests |

Diff vs `4f76a8d3`: 7 files +561/−57, plus the new `tests_s2.rs` (609 lines).

## 8580 regression pin (the proof S2 left the 8580 alone)

1. **Before any `sid/` model edit**, I added `tests_s2.rs` with
   `pin_8580_render_is_bit_identical_to_s1`, plus the one `mod tests_s2;` line in `mod.rs`.
   The test renders a fixed register program through the real chip (`Chip::new(Sid8580)`,
   register writes, `render` at 44.1 kHz, 0.6 s = 26 460 samples). The program covers saw,
   PWM pulse, saw+tri, ring+sync, noise, noise+pulse lock-up, TEST+pulse, waveform 0, the
   LP/BP filter at res 10, the LP+HP notch, cutoff jumps, attack/decay/sustain/release and a
   volume change. It pins the FNV-1a-64 hash of every sample's f32 bit pattern
   (`0x1b605c397a1c65b3`) and 33 sample bit patterns (every 826th sample).
2. I captured the constants on the **unmodified S1 tree** and confirmed them green there (63/63
   `sid::` tests). The record is `.ai/checks-s2-8580-pin-capture.txt`: git status/diff showing
   only the test file and its mod line, sha256 of the S1 model sources, and the test run.
3. After all S2 edits the same pin passes **bit-exactly**, both in the full suite and in
   `two_models_side_by_side_share_no_state`. That test interleaves an 8580 and a 6581 chunk by
   chunk through the same program and gets the S1 hash from the 8580.
4. Negative control: nudging `CHIP_GAIN` by 3.6e-7 relative makes the pin fail
   (`.ai/checks-s2-negative-controls.txt`), so the pin is sensitive and not vacuous.

`pin_6581_render_is_bit_identical_to_s2` pins the same program on the 6581 (hash
`0x0a9a561218c42f29` + 33 values). It was **captured** from S2's own first green run. It is
a refactor guard, not a derivation or a reference.

## Model choices (6581) and source classes

Source classes: **datasheet**, **public** (public C64-community knowledge or measurement,
stated qualitatively), **INFERRED** (my choice, with a reason), **derived** (follows by
arithmetic from the rows above it). No GPL emulator code, tables or constants were consulted
or copied (plan §8.3). The numeric 6581 curves published inside reSID/resid-fp/libsidplayfp
were deliberately not used, so every 6581 number here is INFERRED.

| Behaviour | Model | Class |
|---|---|---|
| Cutoff map | `fc = 220·(18000/220)^s(x)`, `x = reg/2047`, `s` = logistic with K = 7 in log-frequency, normalised so s(0)=0, s(1)=1. Strictly monotonic and geometrically symmetric about 1989.97 Hz. Flat bottom (0x200 → 383.6 Hz, where the 8580 gives 3024 Hz), fast middle, flat top | Shape: **public** (6581 cutoff strongly nonlinear, high floor, fast mid-sweep). Form, 220 Hz, 18 kHz, K: **INFERRED** tuning |
| Resonance map | `Q = 0.707·2^(res/12)` (0.707 → 1.68, vs the 8580's 0.707 → 2.59) | Direction: **public** (6581 resonance weaker than the 8580's). Exponent: **INFERRED** |
| Level-dependent peak gain | Band-pass integrator state soft-limited after each update: `s1 ← tanh(s1)` (SAT = 1.0 = one full-scale voice). Small signals keep \|H(fc)\| = Q; loud ones compress and pick up odd harmonics. Measured through the chip: a full-level A-4 saw at res 15 is compressed 2.5 dB (RMS ratio 11.225 vs the linear 15.000) | "Grit"/level dependence: **public**. Placement and SAT: **INFERRED**. The input-dependent cutoff *shift* is not modelled; the plan approximates it by the static remap |
| Combined waveforms | Ideal AND, then each 1-bit is cleared if the pull of the zero bits around it, `Σ 2^(11−\|i−j\|)`, reaches 1536 (0.75·2048). Isolated bits vanish, and a run's bottom bit is eaten above a long zero run ("run-down"). Only applied with ≥2 waveforms selected; single waveforms are identical on both models. saw+tri @0x600000: 8580 0x400, 6581 0 | Attenuation and the shared-bit-line explanation: **public**. The neighbour-pull rule, weights and threshold: **INFERRED** (no GPL-free measured table) |
| Noise in combinations | The LFSR write-back uses the pulled-down 6581 output (consistent with the same bit-line picture) | **derived** from the two rows above + S1 |
| Waveform 0 | 6581: the held DAC value drops to 0 after 65 536 consecutive cycles with no waveform (66.5 ms). 8580: S1's hold | Leak exists, faster on the 6581: **public**. Hold time and the single drop: **INFERRED** |
| Waveform 0 + TEST | TEST drives nothing with no waveform selected: the held value stays, and the 6581 fade count is neither restarted nor stopped. PULSE+TEST (0xFFF) → TEST alone holds 0xFFF, and the 6581 then fades it | The TEST text is **datasheet**. That TEST leaves the float alone is **INFERRED**. This is my reading of the plan's "waveform 0 with test-bit edge behaviour" |
| ADSR rate table/counter | Unchanged and shared; ENV3 identical on both models (checked every 97th cycle over 600 000 cycles) | **datasheet**/**public** (S1) |
| Attack shape | The applied amplitude follows level/255 through a rise-only one-pole lag, τ = 1.5 ms / ln 9 = 672.61 cycles. So the 10-90 % rise of any step is exactly 1.5 ms (the "floor"), and the fastest attack's half-amplitude point moves from 1.17 ms (8580) to 1.80 ms. Falls follow the level exactly | The "~1.5 ms floor / nonlinear shape" is the **plan's cited figure (§1.2), taken at face value**; I had no GPL-free copy of the underlying measurement. The one-pole form and the 10-90 % reading: **INFERRED** |
| Voice DC | `out = ((wave−0x800)/0x800 + 0.25)·amp`: the envelope scales a DC | Existence and sign: **public** (the 6581 DAC zero point is below mid-scale; loud gate thumps and envelope digis). Size 0.25: **INFERRED** |
| Mixer/volume DC | `x = (filter + direct + 0.5)·VOL/15·G6`: a volume write steps the output | Existence: **public** (loud `$D418` volume digis on the 6581, near-silent on the 8580). Size 0.5: **INFERRED** |
| Output gain | `G6 = 0.28·3/(3·1.25 + 0.5) = 0.197647`: the S0/S1 headroom rule with every DC term at worst. The same waveform is −3.03 dB vs the 8580 | **derived** (from the INFERRED DC sizes) |
| Volume DAC | Linear, VOL/15, as S1 | **INFERRED** simplification |

**Deviation from the plan, flagged:** §1.2 says "attack curve … as a table lookup". A
stateless level→amplitude table applied only in attack jumps whenever the stage changes
mid-attack: a gate-off at level L snaps from table(L) to L/255, which is a click. The same
table applied in every stage would change every sustain level. So the shape is a rise-only
lag. It is continuous by construction, and `attack_lag_releases_into_exact_decay_and_release`
pins that decay, sustain and release then equal level/255 exactly. The resulting level-vs-time
curve is hand-derived and pinned (`attack_6581_follows_the_hand_derived_lag_curve`).

**The DC blocker caveat (as asked):** S1's output already has a 16 Hz DC blocker (the C64
output capacitor), shared by both models. So the 6581's DC offsets never appear as a steady
offset. They appear only as **transients**. A note-on from silence gives a 0.25·G6 = 0.049
(−26 dBFS) low-frequency thump that decays with the blocker's ~10 ms time constant.
A volume write gives a step of 0.5·G6·ΔVOL/15. Hence the volume digi: a 15/0 toggle
renders at > 0.03 RMS on the 6581 and exactly 0 on the 8580. Envelope moves on a held or
silent waveform thump too. The 6581 waveform-0 fade from a high held value (e.g. 0xFFF
after TEST+pulse) with the envelope still open is a full-scale step, i.e. a click, and is
an ears item.

## Sample-rate caveats (plan §1.1, restated; unchanged from S1)

- The digital core (accumulators, waveform bits incl. the 6581 pull-down, sync/ring, TEST,
  noise LFSR, envelope counter, and now the 6581 attack lag and waveform-0 fade counter)
  is stepped every chip cycle at 985 248 Hz.
- The analog path is a sample-rate model. Each output sample is the boxcar average of the
  ~22.34 cycles it spans (44.1 kHz); the filter (incl. the 6581 tanh limit), the mixer DC,
  volume and the DC blocker run once per output sample. The 6581's nonlinear filter is
  exactly where this matters most. Its real inter-sample nonlinear behaviour, and the
  aliasing the tanh adds at the output rate (no oversampling), are not captured.
- Register writes land at sample boundaries when using `render`. The one-cycle write
  pipeline is not modelled.
- So this is a sample-rate approximation of the analog path over an exact digital core.
  It is not cycle-exact, it is not reSID, and it is not any particular 6581.

## Tests

Invocation (native, from `rust-wasm/`):
```sh
cargo test --features native-host --no-fail-fast            # full suite (gate 2)
cargo test --features native-host --lib sid::                # the 85 SID tests
```
Plain `cargo test` still does not build (pre-existing: `engine_node_integration` and
`envelope_preview` need `native-host`); the flag is kept.

| Run | Test-result lines | Passed | Failed | Ignored | File |
|---|---|---|---|---|---|
| Baseline (main `4f76a8d3`), as recorded | 22 | 351 | 1 | 1 | `.ai/checks-s2-baseline-cargo-test.txt` |
| Baseline, deduplicated (17 unique binaries) | 17 | 329 | 1 | 1 | same file |
| Final (S2) | 17 | **352** | 1 | 1 | `.ai/checks-s2-final-cargo-test.txt` (exit 101) |

**About the baseline's 351:** the recorded baseline file holds two interleaved copies of the
run's tail. It ends with `exit=101` twice, and `ahx_seek` (14), `automation_frame` (1),
`engine_node_integration` (5), `envelope_preview` (2) and the doc-tests (0) each appear
twice. So its 22 lines / 351 passed count 22 tests twice. Deduplicated, it is 17 binaries
with **329 passed**, the same as S1's recorded final. I left the file untouched, as
instructed. The final run is one complete run: 17 result lines, 352 passed = 329 + exactly
the 23 new `sid::` tests (lib unittests 182 → 205; every other binary's count is unchanged
line by line). The brief's gate (≥ 351 passed) is met; the like-for-like comparison is
329 → 352.

The one failure is identical in both runs and pre-existing:
`ahx_render_golden::manifest_covers_every_fixture` (37 passed / 1 failed in that binary,
the `public/demos/ahx` fixture count; `public/` is out of scope and was not touched).
**gitleaks:** clean, both scanning `rust-wasm/` (the brief's command) and the worktree root
(which covers the new `.ai/` files): `.ai/checks-s2-gitleaks.txt`, `EXIT=0` twice.

**New tests: 23** (`sid::` 62 → 85), all through the real construction path (`Chip::new` →
`write`/`read` → `clock`/`render`), or through the pure public functions of the real modules
as S1 did:
- `sid::tests_s2` (16):
  - render pins ×2: 8580 (S1 capture), 6581 (S2 capture);
  - per-instance ×3: interleaved chips share no state (the 8580 reproduces the S1 hash);
    the same program is sane on both models and differs by > 30 % RMS; each instance
    reports its own cutoff/Q maps (hand values);
  - filter: level-dependent peak gain through the chip (8580 ratio exactly 15; 6581 11.225,
    MEASURED and labelled);
  - combined waveforms ×2: OSC3 hand values on both models; the 6581 is a bit subset of the
    8580 every cycle for 4 combinations, and strictly quieter;
  - waveform 0 ×2: the fade on the exact cycle (67 072), TEST not touching it, re-drive after
    TEST; the TEST+pulse → waveform-0 edge;
  - ADSR ×3: the attack lag at 4 hand-derived points (±5e-4) and the half-amplitude cycle
    (1776 ±3); exact decay/sustain/release after the lag meets the level; ENV3 identical on
    both models at every 97th cycle over 600 000 cycles (shared rate table);
  - output stage ×3: the mixer-DC step `0.0988235·r^n` on every sample, with the 8580
    exactly 0, and the volume digi; the note-on thump `0.25·r^(m−81.60)` from sample 400 to
    3000 (±1 %); level balance RMS ratio 0.705882 (−3.03 dB).
- `sid::filter` (+5): 6581 endpoints, symmetry and a hand point (0x200 → 383.63 Hz);
  monotonic and unlike the 8580 at 4 registers; weaker Q; stable at 44.1/48 kHz even
  overdriven ×10; small-signal peak = Q and compression with level, with the 8580 linear
  at ×3.
- `sid::waveform` (+2): pull-down hand table (10 values); the pull-down only clears bits,
  only for combinations.
- `sid::tests` (rewritten, count unchanged): `model_flag_both_models_construct_per_instance`
  replaces S1's refusal test. Both models construct, each instance keeps its own model, and
  the sample-rate refusal holds for both. No other existing test was changed.

**Derivation slips the tests caught** (recorded in the test comments, as S1 did): the
pull-down value of 0x555 (I missed the edge bit 0; the right answer is 0x001); the 8580
res-15 Q (2.5933, not 2.6093); the half-amplitude attack cycle (1776, not 1758); and a thump
comparison window that started before the lag residual had decayed (sample 200 → 400). In
each case the model was right and the hand arithmetic was fixed.

**Negative controls** (`.ai/checks-s2-negative-controls.txt`): each mutant was applied to
the real code, `sid::` was run, and then the tree was restored (`diff -r` clean, 85/85
green). Every mutant is killed:
- 6581 saturator un-gated onto the 8580 (6 fail, including the 8580 pin);
- VOICE_DC = 0 (4); no attack lag (3); pull-down disabled (4); no waveform-0 fade (2);
- MIX_DC = 0 (4); 6581 using the 8580 cutoff map (5);
- CHIP_GAIN nudged 3.6e-7 (4, including the 8580 pin).

**Warnings:** the `sid/` files add no compiler warnings in the plain lib build, the
`native-host` build, the test build or the `wasm32-unknown-unknown` build (0 lines mentioning
`src/sid` in each).

## Ears-gate listening list for Morten (S0/S1 items 1-16 carry over unchanged; new 6581 items)

Every 6581 number is a guess to be judged by ear. None is claimed to match a chip.

17. **6581 filter grit/character.** Is the tanh limit on the resonant state (SAT = 1.0) too
    polite or too fuzzy? Listen with 1 vs 3 voices filtered, and at res 0 vs 15. Sweeps
    should get dirtier as more voices are filtered.
18. **6581 cutoff curve.** 220 Hz floor, 18 kHz top, K = 7. Does the bottom quarter of a sweep
    feel "dead" in the right 6581 way, or too dead? Does the middle rush too fast? Known
    6581 tunes that sweep low (bass filter sweeps) are the test.
19. **6581 resonance amount.** Q tops out at 1.68 (+4.5 dB). Is that too weak next to what
    6581 songs rely on?
20. **Combined-waveform distortion.** saw+tri ($30) mostly silent, pulse+saw ($60) only the
    top of the ramp, pulse+tri ($50) eroded. Too much, too little, or wrong in texture?
    (Threshold 0.75 and the 2^-d weights are the knobs.)
21. **DC thump on note-on.** −26 dBFS low bump on every note-on from silence, ~10 ms decay.
    Is it too loud, too soft, or wrong in pitch? (VOICE_DC = 0.25 is the knob; the blocker
    corner is shared with the 8580.)
22. **Volume-register digis.** $D418 digis now play on the 6581 (MIX_DC = 0.5). Are they
    loud enough compared with the voices?
23. **Level balance 6581 vs 8580.** The derived gain makes the same waveform −3.03 dB on
    the 6581. The real impression is often the reverse. Should the 6581 be louder, with
    less headroom?
24. **Attack shape.** The fastest attacks now have a ~1.5 ms soft onset (half amplitude at
    1.80 ms vs 1.17 ms). Are percussive 6581 attacks too soft? Is the plan's "1.5 ms floor"
    reading right?
25. **Waveform-0 fade.** The held DAC value drops to 0 after 66.5 ms, as one step rather
    than a gradual leak. Listen for clicks when a tune deselects the waveform with the
    envelope still open, especially after TEST+pulse (held 0xFFF).
26. **Filter aliasing.** The tanh adds harmonics at the output rate with no oversampling.
    Listen for fizz on loud, high, resonant filtered notes.

## Reproduce

```sh
cd rust-wasm && cargo test --features native-host --lib sid::      # 85 SID tests
cd rust-wasm && cargo test --features native-host --no-fail-fast   # full suite
gitleaks detect --no-git --source .
```

Check outputs: `.ai/checks-s2-baseline-cargo-test.txt` (recorded before S2, untouched),
`.ai/checks-s2-8580-pin-capture.txt`, `.ai/checks-s2-negative-controls.txt`,
`.ai/checks-s2-final-cargo-test.txt`, `.ai/checks-s2-gitleaks.txt`.
