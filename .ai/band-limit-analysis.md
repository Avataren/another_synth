# AHX band limiting: analysis and verdict (2026-09-22)

Branch `agent/band-limit-analysis-0922a`, read-only pass. No code was changed.
The raw numbers are in `.ai/checks-bandlimit.txt`.

Labels: **MEASURED** means run in this pass, or read directly off the code at
the cited line. **INFERRED** means reasoned or estimated, not run.

---

## TL;DR

- **Verdict: KEEP. One cheap tweak worth doing; the rest are optional.**
  - AHX "hi-fi" computes the *exact* Fourier series of the zero-order-hold
    staircase the replayer means to play. It then keeps exactly the partials
    under Nyquist, as a mipmapped wavetable. For periodic 4..128-byte chip
    cycles, that is the right model and the best available one.
  - Alias rejection in the audible band is -66 to -76 dB. The reference
    (nearest-neighbour) is at -10 to -39 dB. Timbre is preserved to within
    0.5 dB above 10 kHz.
  - Steady-state CPU cost is negligible: +0.45 µs per 128-frame quantum.
- **The real costs are all off the per-sample path:**
  - The prewarm burst runs on the audio thread: up to 116 ms per song load.
  - Memory: up to 1963 tables × 8 KiB, about 16 MiB, per song.
  - One small measured regression: isolated single-sample clipping from Gibbs
    overshoot, in 7 of 84 songs.
- **Best concrete improvement: #1, adaptive table size.**
  - Size each mip table to its partial count, not a fixed 4096 points.
  - This targets the prewarm stall and the memory, with no intended audible
    change.
- **No proposal here touches the 84-song byte-exact suites.** Those pin the
  *file* serialization (`.ahx`/`.hvl` bytes), not audio. No proposal touches
  the reference render goldens either (the hi-fi-off path). Every hi-fi change
  does move the hi-fi regression hashes in `rust-wasm/tests/ahx_hifi_baseline.rs`,
  which exist precisely to force that conversation.

---

## 1. Where it is

| What | Where | Label |
|---|---|---|
| Band-limited oscillator bank ("hi-fi") | `rust-wasm/src/ahx/hifi.rs` (whole file, 610 lines) | MEASURED |
| Model and rationale (module docs) | `hifi.rs:1-104` | MEASURED |
| Constants: `TABLE_SIZE`=4096, `MAX_HARMONICS`=512, `LEVELS_PER_OCTAVE`=2, `LEVEL_COUNT`=18, `FRAC_BITS`=4, `MAX_CACHED_TABLES`=4096 | `hifi.rs:114,119,124,128,133,148` | MEASURED |
| Level choice: richest level with `H*f0 < 0.5` | `hifi.rs:177-179` | MEASURED |
| Per-sample read: 16.16 phase × `ratio`, 2 table reads, integer lerp | `hifi.rs:195-202`; 4-lane variant `:209-222` | MEASURED |
| Exact staircase spectrum `c_k = X_(k mod N) e^(-iπk/N) sin(πk/N)/(πk)` | `hifi.rs:386-417` | MEASURED |
| Level build: zero bins above H, 4096-point inverse FFT, round to `i16` at ×16 | `hifi.rs:421-435` | MEASURED |
| Locked-bank miss: fall back to a duller built level, else the reference path | `hifi.rs:348-355` | MEASURED |
| Voice picks its oscillator once per tick (50 Hz × speed multiplier); noise excluded | `voice.rs:710-720`, called from `engine.rs:1195-1200` | MEASURED |
| Mixer, `HIFI` const-generic: hi-fi voices read the table, the others read `byte << FRAC_BITS` | `engine.rs:1317`, lanes `:1394-1401`, scalar `:1432-1439` | MEASURED |
| Ring mod: modulator stays a raw nearest-neighbour byte read | `engine.rs:1440-1443`; rationale `hifi.rs:61-64` | MEASURED |
| Gain and clamp: i64 `(a*mixgain) >> (8+FRAC_BITS)`, then clamp to `i16` | `engine.rs:1407-1411`, `:1458-1466` | MEASURED |
| Turning it on prewarms the song (walks its ticks, builds tables), then locks | `player.rs:297-303`, `engine.rs:643-705` | MEASURED |
| The app always turns it on; the settings toggle was withdrawn | `src/audio/tracker/ahx-transport.ts:110`, `ahx-preview.ts:210`; `src/tests/user-settings-migration.test.ts:159` | MEASURED |
| The prewarm runs inside the worklet's `loadSong` (the audio thread) | `src/audio/worklets/ahx-core.ts:522` (and `:408-411` for a live toggle) | MEASURED |
| The AHX "filter" is baked into the tables (31 LP + 31 HP rows), not a stage on the output | `waveform.rs:29-30`, `hifi.rs:45-53` | MEASURED |
| Pitch range: period clamped to `0x71..0xd60` | `voice.rs:679`; `period_to_freq` `voice.rs:27-30` | MEASURED |

**Pitch-range consequence (MEASURED from `voice.rs:679`):**

- The byte rate is `3546895 / period`, so 1036..31389 bytes/s.
- The mixer step is at most **0.65 bytes per output sample** at 48 kHz (0.71 at
  44.1 kHz). The reference never skips bytes; it always *up*samples the byte
  stream.
- So all of the reference's aliasing is the zero-order-hold *images* of the
  staircase folding back, never decimation aliasing.
- The fundamental ranges are:
  - N=4: 259 Hz – 7.85 kHz.
  - N=128: 8 Hz – 245 Hz.

## 2. What the current approach is, precisely

1. **Signal model.**
   - The replayer's intended signal is the continuous staircase
     `s(t) = x[floor(t·N)]`, which is Paula's DMA hold.
   - `hifi.rs` computes its Fourier series in closed form. The ZOH sinc term
     is included, so the staircase's own images stay part of the sound
     (`hifi.rs:16-30`).
2. **Mipmap.**
   - There are 18 levels at 2 per octave, holding 512 → 1 partials.
   - The level is chosen per tick from the voice's `f0` (`voice.rs:718`).
   - The top partial kept always sits in `(0.354, 0.5)·fs`: 17–24 kHz at
     48 kHz, 15.6–22 kHz at 44.1 kHz. (INFERRED from the ladder, `hifi.rs:152-179`.)
3. **Table.**
   - Each level is 4096 points, built by inverse FFT and stored as `i16` at
     ×16 of the `i8` scale, which gives about 4 fractional bits.
   - Reads use linear interpolation between adjacent points, with at least 8
     points per period of the top partial.
   - That is the whole "filter". There is no FIR, no polyphase kernel and no
     BLEP.
4. **Order and cost per voice-sample.**
   - One u64 multiply, a mask, two `i16` loads from an 8 KiB table (fits in L1),
     and one integer lerp. The lerp is 4-lane SIMD when no voice is
     ring-modulating (`engine.rs:1348`).
   - The reference path is one byte load.
5. **Place in the render chain.**
   - Oscillator read → (ring mod) × volume → pan → Σ voices → × mixgain →
     `i16` clamp → `f32` × gain (`player.rs:34-38`).
   - Band limiting happens at the oscillator, before any nonlinearity except
     ring mod.
6. **The filter-sweep interplay.**
   - A filter row is just a different table. It gets its own spectrum and
     levels, so the resonant response is kept up to Nyquist and nothing is
     filtered twice (`hifi.rs:45-53`).
   - A sweep or PWM step changes the table at a tick boundary. The new table
     starts at the same phase, but the jump between the two tables' values is
     *not* band-limited. See M3.
7. **What stays nearest-neighbour (MEASURED at the cited lines):**
   - noise (`voice.rs:712`);
   - the ring-mod modulator (`engine.rs:1441`);
   - any voice whose table a locked bank never built (`hifi.rs:348-355`).
     This was measured at **0 misses** over the whole corpus (M1, M5).

## 3. Measurements

The tooling constraint shaped how everything was measured:

- `cargo` and writing under `/tmp` needed approvals that this headless run
  did not have.
- So all measurements are Node scripts passed inline (`node -e`). They read
  only the **committed** `public/wasm/audio_processor_bg.wasm` and the corpus
  in `public/demos/ahx/`, or they are exact JS ports of the `hifi.rs`
  algorithm.
- No artifact files were written; the outputs are pasted into
  `.ai/checks-bandlimit.txt`.

### M1. Corpus render, 84 songs, 10 s each at 48 kHz, 128-frame quanta, continue-phase on (MEASURED, Node 24 / x86 wasm)

| Metric | Hi-fi off (reference) | Hi-fi on (app) |
|---|---|---|
| Mixer time per 128-frame quantum, mean over songs | 1.19 µs | **1.64 µs** (+0.45 µs, ×1.38) |
| Share of one core | 0.045 % | 0.062 % |
| Prewarm on `set_hifi(true)` | – | median **15.7 ms**, max **115.7 ms** (`moderate_sellotaping.hvl`); `get_to_the_chopper.ahx` 112 ms |
| Tables built | – | median 160, max 1963 (× 8 KiB = 15.3 MiB, plus ~4.5 KiB per source) |
| Locked misses after prewarm | – | 0 |
| Peak, hi-fi / reference | – | median ×1.066, max ×1.188 (Gibbs) |
| Energy of (hi-fi − reference) / reference | – | median −24.8 dB (range −38.8 to −15.4). This is the aliasing removed. |

- Prewarm time tracks the table count. The heavy songs spend about
  **0.045 ms per table** (for example 1963 tables → about 88 of the 116 ms).
  So table builds, not the tick walk, dominate the worst stalls. (INFERRED
  from the per-song rows.)
- Browser wasm will be slower than Node in absolute terms. The *ratios* are
  what matter here.

### M2. Steady-tone aliasing, exact algorithm ports, 48 kHz, 65536-point Blackman-Harris FFT (MEASURED in simulation)

**How to read this:**

- The metric is inharmonic energy / total energy, counting the whole band
  and, separately, only the part below 16 kHz ("aud").
- "top" is the harmonic energy at ≥10 kHz relative to the ideal band-limited
  staircase.
- Tables are the real AHX generators (`gen_sawtooth`, squares, and an
  approximate triangle), at the lowest, mid and highest periods.
- Each HIFI port reproduces `hifi.rs:195-202,421-435` bit for bit.

| Method | Alias, whole band (dB) | Alias below 16 kHz (dB) | top ≥10 kHz vs ideal | Notes |
|---|---|---|---|---|
| **NN (reference replayer)** | **−10 … −37** | −11 … −39 | 0 | Worst at high notes and small N: sq4 at the top period is −10 dB |
| **HIFI (current)** | **−66 … −74** | **−67 … −76** | **−0.0 … −0.5 dB** (−1.9 on sq32 at 32 Hz) | The floor comes from the `i16` ×16 quantization |
| HIFI with float tables | −67 … −131 | −68 … −131 | same | Shows the quantization is the floor |
| HIFI at 4 levels/octave | identical at the tested pitches | – | – | Only moves the worst-case cutoff from 0.354·fs to 0.42·fs |
| BLEP, Kaiser, 32 taps (W16) | −57 … −117 | **−91 … −124** | −0.4 dB (−16 dB on sq4 at 7.8 kHz: its 23.5 kHz 3rd partial) | Aliases pile into the 16–24 kHz transition band |
| BLEP, 8 taps (W4) | −43 … −91 | −85 … −99 | −1.1 … −2.1 dB (−12.5 on sq4 top) | Passband droop |
| polyBLEP (2 taps) | −27 … −73 | −38 … −81 | −2.4 … −7.5 dB | Not good enough |
| Windowed sinc (Kaiser, 32 taps) on the bytes as samples | ≈ ideal | ≈ ideal | **−75 … −110 dB** | Removes the staircase images: a sq4 becomes a sine. Wrong model for AHX. |
| Hermite / Catmull-Rom on the bytes | −43 … −96 | −43 … −97 | −2 … −76 dB | Dull *and* still aliased at high notes |

The ideal band-limited staircase measures −91 to −105 dB inharmonic: that is
the FFT window floor.

### M3. Non-steady: table switches at tick boundaries (MEASURED in simulation)

Error energy in 20 Hz–16 kHz versus a 128-tap Kaiser BLEP rendering of the
*same* switched staircase:

| Case | NN | HIFI (current) | BLEP W16 | BLEP W4 |
|---|---|---|---|---|
| Steady sq32 25%, period 0x280 (control) | −26.3 | −71.7 | −115.4 | −47.1 |
| PWM sweep, duty 1..31 per tick, period 0x280 | −26.0 | −65.3 | −115.2 | −46.3 |
| PWM sweep, period 0xe2 (490 Hz) | −21.4 | **−50.9** | −112.4 | −43.4 |
| Slide 0x280→0x71 (crosses mip levels) | −25.0 | −68.2 | −113.4 | −45.8 |
| Vibrato ±3 % at 6.25 Hz | −23.1 | −71.1 | −112.8 | −43.5 |

- Level crossings (slide, vibrato) cost hi-fi nothing measurable.
- Fast PWM at a high pitch costs about 20 dB, because the jump between tables
  is not band-limited. It is still 30 dB better than the reference.
- BLEP W4's roughly −45 dB here is *passband droop* (a linear timbre change),
  not aliasing. Compare M2, where its below-16-kHz alias figure is −85 dB.

### M4. Hi-fi alias floor vs table `FRAC_BITS` (MEASURED in simulation)

| Case | FRAC 4 (now) | FRAC 6 | FRAC 7 | float |
|---|---|---|---|---|
| sq32 25%, 0x280 | −74.4 | −83.8 | −86.1 | −87.2 |
| sq4, 0x280 | −74.2 | −86.1 | −90.5 | −94.5 |
| saw128, 0x71 | −70.2 | −81.2 | −85.1 | −88.2 |

- The table peak is at most 1.19 × `i8` full scale, so FRAC 7 still fits in
  `i16` (19.4 k).
- The mixer headroom is INFERRED fine: volume ≤ 64 and pan ≤ 255 give at most
  3.2e8 before the `>>7`, under `i32::MAX`. Verify against the pan table
  before doing it.

### M5. Full-length clipping, 84 songs, 168 min, 48 kHz, gain 1 (MEASURED)

- Clipped samples: **112 with hi-fi off, 469 with hi-fi on.**
- Hi-fi adds clipping in 7 songs that are clean in the reference:
  - `digital_retribution.ahx`: 0 → 220.
  - `the_chase.ahx`: 0 → 60.
  - `nightmar3.ahx`: 0 → 53.
  - `quite_classic.ahx`: 0 → 15.
  - `sliding_away.hvl`: 0 → 7.
  - `sundown.ahx`: 0 → 2.
  - `depressed.ahx`: 0 → 1.
- **Every clip is an isolated single sample** (longest run: 1): a Gibbs
  overshoot spike shaved at the `i16` clamp (`engine.rs:1465`).
- Where to listen (A/B):
  - `digital_retribution.ahx` at 35.1 s (position 36, row 8), 37.0 s (38/8)
    and 40.3–41.1 s (42/0).
  - `the_chase.ahx` at 31.7 s (7/12).
  - Expected audibility: none (INFERRED), since each is at most about 1.5 dB
    of a single sample.

### M6. Can a spectral taper remove the Gibbs overshoot? (MEASURED in simulation)

- Lanczos σ: peak 1.18 → 1.02, but the top half of each level's partials
  loses **about 7 dB**.
- That band is 8.5–24 kHz depending on level, so this is audible dulling. Rejected.
- A raised-cosine taper over the top 25 %: peak 1.18 → 1.17, loss 0.9 dB.
  It does nothing useful.
- Conclusion: the clip is a headroom issue, not a filter-design issue.

**Not measured:** browser-thread CPU (only Node wasm), the in-browser prewarm
stall, and ears. The B2.1 E2E stall numbers in memory (36–38 ms per editing
session) are the in-browser reference.

## 4. Against the canon

| Approach | Fit for AHX | Quality (audible band) | Per-sample CPU | Memory / prewarm | Verdict |
|---|---|---|---|---|---|
| **Mipmapped exact-Fourier wavetables (current)** | Exact: models the ZOH staircase, keeps Paula's images | −67 … −76 dB alias, ≤0.5 dB top loss (M2) | 2 loads + lerp, +0.45 µs/quantum (M1) | Up to ~16 MiB and ~116 ms prewarm per song (M1) | **Best result per cycle of audio-thread CPU** |
| BLEP / minBLEP (Blargg's `blip_buf` family) on the staircase | Also exact in principle: the staircase *is* a sum of steps, at ≤0.65 steps per sample (§1). Uniquely covers ring mod (a product of staircases is a staircase), noise and table switches. | W16: −91 … −124 dB, switches exact (M3). W4: −85 … −99 dB with −1…−2 dB droop | INFERRED ~0.65 × 2W MACs per voice-sample: roughly 5–15× current hi-fi, still about 1–5 % of a quantum for 16 voices. Plus W samples of latency (centred) or minimum-phase distortion (minBLEP). | **None**: no tables, no prewarm, no miss path | The only real alternative. See improvement #5. |
| polyBLEP | Same model, 2-tap residual | −38 … −81 dB, −2.4 … −7.5 dB top (M2) | Cheapest BLEP | None | Too leaky for 8-bit squares at high pitch |
| Polyphase windowed-sinc (Kaiser / Remez-designed) resampling of the bytes | **Wrong model.** Treats the bytes as samples and so filters out the staircase images, which *are* the timbre. | Alias ≈ ideal, but −75 … −110 dB top: sq4 becomes a sine (M2) | 32+ MACs per voice-sample | Kernel table only | Right for MOD/XM sample playback, wrong for AHX |
| Remez / Parks–McClellan FIR design | Only a way to design the kernel for the row above | – | – | – | Moot: no FIR is needed |
| Hermite / Catmull-Rom on the bytes | Wrong model, and no anti-alias guarantee | Dull and aliased (M2) | 4 loads, ~10 ops | None | Reject |
| Oversample ×k, then decimate (the reSID `SAMPLE_RESAMPLE` family) | Generic. reSID runs the chip at ~1 MHz and FIR-decimates, the canonical SID approach. | Good if k·fs ≫ the image energy, but the images still fold at k·Nyquist | k × mixer + a long FIR: the reason reSID's resampling mode is a CPU hog | Small | Much more CPU for a worse result than the current path |
| 8580/6581 filter-model approaches | Not applicable: the AHX filter is baked into the tables (`hifi.rs:45-53`) | – | – | – | – |
| Nearest-neighbour (the reference) | Bit-exact to `hvl_replay.c` | −10 … −39 dB alias | 1 load | None | The golden path. Stays available as `HIFI=false`. |

## 5. Faithfulness: where the line is

- **Authentic, and kept by hi-fi:**
  - the staircase itself (its images and the "8-bit" edge of small-N tables);
  - the 50 Hz tick stepping of sweeps, PWM, vibrato and envelopes;
  - the baked filter responses, resonance included;
  - `i8` table quantization;
  - noise grit;
  - ring-mod grit.
- **An artifact, and removed by hi-fi:** foldback of staircase images above
  Nyquist. That is inharmonic garbage *below* the note on high pitches
  (−10 dB inharmonic on sq4 at the top period, M2). A real Amiga never
  produced it, because Paula's output is analog ZOH.
- **Neither model reproduces the real Amiga output stage.** On a real
  machine, the A500's fixed ~4.4 kHz 6 dB/oct RC filter (and the optional LED
  Butterworth) makes the real hardware *duller* than both `hvl_replay` and
  hi-fi. That is a separate, opt-in "Amiga output" question, not band
  limiting. It is listed only as a note (#7).

## 6. Verdict: **KEEP** (with small tweaks)

- **Keep the approach.** It targets the correct signal, the steady-state
  quality is excellent, and the per-sample CPU is negligible.
- **Replace it?** BLEP is the only genuine rival. It wins on memory, the
  prewarm stall, ring mod and PWM switch steps. It loses on per-sample CPU and
  latency, and it would be a large rewrite of a tuned, SIMD-laned mixer.
  - None of what BLEP wins is currently a measured *audible* problem.
  - The prewarm stall is a real cost, but #1 attacks it directly for far less.
- The things worth doing are cheap and aimed at the costs that are actually
  measured (prewarm and memory), not at quality.

## 7. Ranked improvements

**Audibility caveat:** the "expected audible" column is INFERRED. The user's
ears are ground truth, and anything marked other than "none" needs an
explicit A/B and an OK.

| # | Proposal | Expected audible difference | CPU delta | Risk | Size | Bit-exactness |
|---|---|---|---|---|---|---|
| **1** | **Adaptive table size per level.** Build level H into `clamp(next_pow2(8·H), 64, 4096)` points instead of always 4096; keep `ratio`/`PHASE_MASK` per table (`hifi.rs:114,136,186-202,421-435`). This keeps the ≥8 points per top-partial period that `hifi.rs:111-113` relies on. | **None expected.** Linear-interp error per partial stays within the current spec. Rounding will differ in the last LSB. | Per-sample: same. Prewarm: the inverse FFT shrinks from 4096 points to 8H (a level of H ≤ 64 builds ≥8× cheaper). Worst songs: INFERRED 116 ms → about 30–40 ms, since table builds are ~0.045 ms of each table (M1). Memory drops about in proportion. | Low. `PHASE_MASK` becomes per-table, and `sample4` must use the same arithmetic. | S | Changes the **hi-fi baseline hashes only** (`ahx_hifi_baseline.rs`; regenerate with `PRINT_HIFI_BASELINE=1` and justify in the commit). Reference goldens and the 84-song file-export suites are untouched. |
| 2 | **`FRAC_BITS` 4 → 6 or 7** (`hifi.rs:133`). The mixer already carries the scale and shifts in i64 (`engine.rs:1407-1411,1458-1460`). | None expected: the alias floor goes from −70…−74 to −81…−90 dB (M4), already far below audibility | 0 | Low. Check the pan table's max value for `i32` headroom in `(j*pan)` (`engine.rs:1403,1453`); FRAC 6 leaves 2× margin. | S | Hi-fi baseline hashes only. Bundle with #1 so the baseline moves once. |
| 3 | **Band-limit the table-switch step.** When a voice's table changes at a tick, add a short BLEP residual (W ≈ 8) of `Δ = new(phase) − old(phase)` at the tick boundary. | Probably none: the fast-PWM worst case goes from −51 to about −70 dB (M3); every other case is already at the floor | ≈0: one residual per voice per switching tick, 50 Hz | Medium: a new per-voice residual buffer in the mixer, a lanes-path interaction and a new state across render calls (seek/replay determinism) | M | Hi-fi baseline hashes only |
| 4 | **Ring mod:** give the modulator its own hi-fi oscillator, with a joint partial budget (`H_c·f_c + H_m·f_m < 0.5`). HVL only: the command is at `voice.rs:610-616`. | **Possibly audible.** HVL ring-mod voices at high pitch lose their current fold-back grit. That grit is arguably part of how ring mod sounds in HivelyTracker, so an **A/B is required**. | +1 table read per ring voice-sample; lanes are already off for ring voices (`engine.rs:1348`) | Medium: more tables to prewarm, and the joint budget halves each factor's partials (duller) | M | Hi-fi baseline hashes only |
| 5 | **Strategic: replace mipmaps with BLEP/minBLEP** over the staircase (every byte transition, table switch, ring product edge and noise byte). Delete the bank, prewarm, lock/miss and edit-prewarm machinery. | Steady tones: none expected (both are ≤ −67 dB, M2). Ring mod and (optionally) noise become band-limited: **audible, A/B required.** Recommend keeping noise on NN for grit. | Per-sample up, INFERRED 5–15× the current hi-fi mixer: still ~1–5 % of a quantum for 16 voices. Prewarm stall → 0, tables → 0. | High: a rewrite of `mix_chunk`, lookahead latency or minBLEP phase, seek/replay determinism, and the preview path | L | Hi-fi baseline hashes only. Only worth it if the prewarm stall or memory still hurts after #1. |
| 6 | **Clipping headroom** (M5). Either (a) do nothing, or (b) for hi-fi, soft-clip the mix instead of hard-clamping `i16` at `engine.rs:1465`. | (a) None expected: isolated single samples. (b) None expected. | 0 / ~1 compare per sample | Low | S | (b) moves the hi-fi hashes only for songs that clip; none of the 5 baseline songs clip in their first 10 s |
| 7 | *(Note, not a band-limit change)* An optional "Amiga output" filter: the A500 RC ~4.4 kHz, plus LED. | **Clearly audible** (duller, authentic-hardware). Opt-in only, and the user's call. | A few ops per sample | Low | S | Off by default: nothing moves |

**Explicitly not recommended:**

- 4 levels per octave. It measured no gain at the tested pitches; it only
  raises the worst-case cutoff from 17 to 20 kHz, and it doubles tables and
  prewarm, which works against #1.
- A Lanczos/σ taper to kill Gibbs (−7 dB top octave, M6).
- Sinc or Hermite resampling of the bytes (wrong model, M2).
- Oversample-and-decimate (more CPU for less quality).

## 8. What each class of test is affected by

| Suite | What it pins | Touched by #1–#6? |
|---|---|---|
| `src/tests/ahx-writer-corpus.test.ts:10-13`, `ahx-exporter-corpus.test.ts:12-16` (the "84 songs byte-exact") | `.ahx`/`.hvl` **file** bytes from the writer and exporter. `song-export/` has no audio/WAV render path (grep: no `wav`/`render` in `src/audio/tracker/song-export/`). | **No.** No DSP change can move these. |
| `rust-wasm/tests/ahx_render_golden.rs` + `tests/golden/*.txt` | Reference render (hi-fi **off**, `HIFI=false`) | **No.** The `false` instance of `mix_chunk` is separate code (`engine.rs:1311-1316`, `hifi.rs:66-71`). |
| `rust-wasm/tests/ahx_hifi_baseline.rs` | FNV-1a hashes of hi-fi-**on** renders, 5 songs, plus table/source counts | **Yes, every item.** That is the pin's purpose. Regenerate it and say why in the commit. #1 also changes the table *count* folded into the hash if the ladder changes (it does not in #1). |
| `rust-wasm/tests/ahx_hifi.rs` | Hi-fi properties: >20 dB under the reference, pitch/level kept, no misses after prewarm | Should still pass. Re-run. |
| `src/tests/ahx-worklet-core.test.ts:578-609` | Hi-fi ≠ plain, RMS within 2 dB, determinism | Should still pass |

---

**Summary.**

- AHX band limiting lives in `rust-wasm/src/ahx/hifi.rs`. It is an
  exact-Fourier, mipmapped wavetable model of the replayer's zero-order-hold
  staircase, read with linear interpolation from 4096-point `i16` tables and
  picked per tick. The app always has it on.
- **Quality:** it cuts aliasing from −10…−39 dB (reference) to −66…−76 dB,
  and it keeps the staircase's authentic images to within 0.5 dB above
  10 kHz. That beats every canonical alternative on quality per CPU cycle.
  - Sinc and Hermite resampling dull the chip timbre, because they treat the
    bytes as samples.
  - polyBLEP leaks.
  - Only a full BLEP matches it, at 5–15× the per-sample cost.
- **Its costs** are all off the per-sample path: a prewarm on the audio thread
  of up to 116 ms per song load, and up to about 16 MiB of tables. There is
  also one small regression: isolated single-sample Gibbs clipping in 7 songs,
  expected inaudible.
- **Verdict: KEEP.**
  - Do #1 (adaptive table size, plus #2 `FRAC_BITS` in the same change) to cut
    the prewarm and memory, with no intended audible change.
  - Treat ring-mod band limiting (#4) and a BLEP rewrite (#5) as
    listen-first options.
- None of this touches the reference goldens or the 84-song file-export
  suites; only the hi-fi regression hashes move.
