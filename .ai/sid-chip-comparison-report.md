# SID chip comparison: our Rust core vs GoatTracker 2's bundled reSID

Date: 2026-09-24. Read-only analysis. No code was changed.

- **Ours:** `rust-wasm/src/sid/{noise,waveform,voice,envelope,filter,chip,mod,player}.rs`, plus the importer `src/audio/tracker/sid-doc/gt-sng-read.ts`, which I read only to check how it passes table data through.
- **Theirs:** `/tmp/gt2-src/src/resid/*` (classic reSID, "Copyright (C) 2004 Dag Lem", GPL v2) and GT2's `gsid.cpp`, `gsound.c`, `gplay.c`, `gsong.c`, `goattrk2.c` and `bme/bme_snd.c`.

**What this report compares.** It compares two pieces of emulation source. It makes no claim about what real hardware does. A match with reSID means only that our code agrees with reSID's code.

**No GPL text in here.** reSID and GT2 are described in my own words, with citations. No GPL source block and no GPL table data are reproduced. The few frequency and ratio numbers quoted are facts from comparison calculations, not listings.

**How GT2 runs by default.** Every GT2-side statement assumes GT2's defaults unless it says otherwise:
- `sidmodel = 0`, so the 6581 (goattrk2.c:47, help text goattrk2.c:181).
- `interpolate = 0` (goattrk2.c:63). That gives classic reSID with `SAMPLE_FAST` (gsound.c:216 → gsid.cpp:77-80), not resid-fp.
- `adparam = 0x0F00` (goattrk2.c:49).
- `optimizerealtime = 1` (goattrk2.c:55) and `optimizepulse = 1` (goattrk2.c:54).

`SAMPLE_FAST` matters in several sections below. It makes reSID use its *delta-clock* paths (sid.cpp:766-790 → sid.cpp:656-730): oscillators advance in chunks, the output is point-sampled once per output sample, and the filter integrates in 8-cycle steps with a lower cutoff ceiling.

**Classification key**
- **REAL DIVERGENCE:** the semantics differ, and our side does not document the difference as a deliberate choice.
- **INTENTIONAL SIMPLIFICATION:** our code says in a comment that it is an approximation or an INFERRED choice.
- **EQUIVALENT:** equivalent but expressed differently.

Impact is rated high / med / low / none. Confidence (Conf) is rated high / med / low.

---

## 0. ANSWER FIRST — noise and pitch lock

**Our noise LFSR is clocked by the oscillator's phase accumulator, not by per-sample randomness. The pitch-tracking mechanism is present.**

How our side works:
- `Noise::shift()` (noise.rs:60-63) is a 23-bit Fibonacci LFSR step. The feedback is bit 22 XOR bit 17 (noise.rs:61).
- It has exactly one non-test caller: `Voice::finish_cycle` (voice.rs:291). That call runs only when accumulator bit 19 (`NOISE_CLOCK_BIT = 0x08_0000`, voice.rs:72) goes 0→1 between `prev_acc` and `acc` (voice.rs:285).
- `prev_acc` and `acc` are updated once per chip cycle by `clock_accumulator` (voice.rs:251-259), as `acc += freq`.
- `finish_cycle` runs once per emulated PAL cycle from `Chip::clock` (chip.rs:277-279). `Chip::render_inner` calls `Chip::clock` about 22.34 times per 44.1 kHz output sample (chip.rs:314-323).
- A grep of `rust-wasm/src/sid/*.rs` finds no RNG anywhere. The other `.shift()` calls are unit tests (noise.rs:99/109/122).
- Result: the shift rate is `freq_reg × 985248 / 2^20` Hz, which is 16 × the oscillator pitch (the header says so at noise.rs:5-8). The noise spectrum follows the note.

**reSID does the same thing.**
- `WaveformGenerator::clock()` shifts the same polynomial (bit 22 XOR bit 17) whenever accumulator bit 19 rises (wave.h:148-154).
- The delta-clock variant that GT2's default `SAMPLE_FAST` actually uses counts the bit-19 rising edges crossed in a multi-cycle step and shifts once per edge (wave.h:178-211).
- Output taps: reSID takes register bits 22,20,16,13,11,7,4,2 (wave.h:309-320). Ours takes 20,18,14,11,9,5,2,0 (noise.rs:37-38). The spacing is identical and only offset by two shift positions, so our output stream is reSID's stream two shifts earlier. That is a sub-millisecond phase shift of the same sequence, not a spectral difference.

**Verdict on the symptom** ("noise drums sound like pure white noise in ours but tonal in GT2"): **the chip mechanism is present in ours, and the chip-level noise is equivalent.** The cause must be elsewhere. Candidates, in the order I would test them:

1. **Wave-table gate bit (player, REAL DIVERGENCE, high).**
   - GT2 stores the whole control byte, gate bit included, from a wave-table row (gplay.c:525; `$E0-$EF` rows keep the low nibble including gate, gplay.c:527). It writes `wave & gate` to the chip (gplay.c:945). A drum table row such as `$80` (noise, gate bit clear) or `$40` therefore **releases the envelope** in GT2.
   - Our `wave_step` strips the gate bit (`l & !GATE` at player.rs:732, `l & 0x0E` at player.rs:733). `write_registers` then ORs in the channel's own gate (player.rs:875). Command 7 strips it too (player.rs:551).
   - So in ours the noise part of the drum **keeps sustaining** at the instrument's sustain level instead of releasing. The pitched pulse/triangle frames that give a GT2 drum its "tonal" body are then masked by a long, flat noise tail.
   - The importer passes the table bytes through untouched (gt-sng-read.ts:216), so the gate bits are in our data. Only the player ignores them.
2. **New-note first frame (player, REAL DIVERGENCE, med).**
   - On a new note's tick 0, GT2 jumps straight to the register write (gplay.c:510-514). It runs neither the wave table nor the pulse table and does not set a new frequency there: the pitch comes from the first wave-table row on the next frame (gplay.c:714-719).
   - Ours sets the note frequency at trigger time (player.rs:581). It always runs `pulse_step` on the first frame (player.rs:435), and runs `wave_step` on it whenever `first_wave == 0` (player.rs:696).
   - For drum instruments with no first wave, our whole noise→pulse sequence therefore starts one 20 ms frame early relative to the note, and the first frame carries the new pitch instead of the old one.
3. **Filter ceiling (chip/sampling, REAL DIVERGENCE, med–high for filtered drums).**
   - In GT2's default `SAMPLE_FAST` mode, reSID's filter clamps cutoff to 4 kHz (filter.cpp:263-265, applied in filter.h:461).
   - It also uses a measured 6581 cutoff curve that is very different from ours (§6).
   - A filtered noise drum is therefore band-limited and "thuddy" in GT2, and brighter in ours above reg ≈ $A0.
4. For completeness, one thing **does not explain it**. Our boxcar decimator (chip.rs:317-327) attenuates noise stepping faster than the output rate, while GT2's point-sampling (sid.cpp:780-783) aliases it at full level. That makes *ours* darker at very high noise pitches, which is the opposite of the symptom.

---

## 1. NOISE GENERATION

| # | Ours | Theirs | Semantic delta | Impact | Conf | Class |
|---|---|---|---|---|---|---|
| 1.1 | noise.rs:61-62 | wave.h:150-153 | Same 23-bit LFSR, feedback bit22 ⊕ bit17, shift-left. | none | high | EQUIVALENT |
| 1.2 | voice.rs:285-291 (per cycle, bit-19 rising edge) | wave.h:148-154 (per cycle); wave.h:178-211 (delta mode, edge count) | Same clock source. reSID notes a real 2-cycle shift delay it does not model (wave.h:204); we don't either. | none | high | EQUIVALENT |
| 1.3 | noise.rs:37-38 taps 20,18,14,11,9,5,2,0 → DAC 11..4 | wave.h:309-320 taps 22,20,16,13,11,7,4,2 → DAC 11..4 | Same tap spacing offset by 2 bits, so our output leads reSID's by 2 shifts. Bits 3..0 = 0 on both sides. | none | high | EQUIVALENT |
| 1.4 | noise.rs:32 power-on 0x7FFFF8 | wave.cpp:135 reset 0x7ffff8 | Same seed. Because of 1.3, the first output words differ (ours 0xFC0, reSID 0xFF0). | none | high | EQUIVALENT |
| 1.5 | voice.rs:283-284 + noise.rs:83-85: TEST holds the register at **all ones** (0x7FFFFF) every cycle; shifting resumes from there | wave.cpp:105-108: TEST **clears** the register to 0; wave.cpp:115-116: TEST release reloads 0x7ffff8 | During TEST our noise output is 0xFF0 and reSID's is 0x000. After release the two sequences start from different states (both deterministic). This is a DC level difference during the TEST frame (a click), not a spectral one. | low | high | REAL DIVERGENCE (ours documented as INFERRED, noise.rs:14-20) |
| 1.6 | noise.rs:21-28, 71-79; voice.rs:286-289: noise combined with other waveforms **writes zeros back** into the tap cells at each shift, so the LFSR can lock at 0 until TEST | wave.h:405-453: any noise combination simply **outputs 0**, with no write-back into the LFSR (the lock-up is mentioned but explicitly not modelled, wave.h:407-411) | reSID silences noise combinations but leaves the LFSR intact. Ours outputs the AND (§2) and can lock the LFSR, which silences later *pure* noise on that voice until a TEST. | low–med (only songs that select noise+X, then plain noise without a TEST in between) | high | REAL DIVERGENCE (ours is the more hardware-motivated side; see the last section) |
| 1.7 | voice.rs:274-277 + 285: a sync reset happens before the noise clock, so a synced cycle never shifts | wave.h:149 shifts inside `clock()`, before `synchronize()` (sid.cpp:636-643) | On a sync cycle reSID can shift once where we don't. | none | high | EQUIVALENT (sub-cycle) |

---

## 2. WAVEFORM COMBOS

| # | Ours | Theirs | Semantic delta | Impact | Conf | Class |
|---|---|---|---|---|---|---|
| 2.1 | waveform.rs:146-162: combined = bitwise AND of the selected 12-bit outputs; waveform.rs:165: the 8580 uses the plain AND | wave.h:380-402 + wave.cpp:49-63: combined outputs come from **measured 8-bit OSC3 tables** (`wave8580_*`, `wave6581_*`, 4096 entries each), indexed by saw (or triangle>>1 for P_T), and gated by pulse | reSID's tables are much sparser and quieter than an ideal AND. On 8580 pulse+saw ($61) our mean 8-bit level is ~127 vs ~62 in the table (about +6 dB). On 8580 saw+tri, ours is ~64 vs ~20 (about +10 dB). Figures come from a transient calculation over all 4096 phases with the pulse held high. | **high** for songs that use $51/$61/$71 lead and bass sounds | high | INTENTIONAL SIMPLIFICATION (waveform.rs:33-41, "residual NOT modelled") |
| 2.2 | waveform.rs:166, 175-207: 6581 = a neighbour-pull pass over the AND (my own rule, INFERRED) | same tables, 6581 set | Ours is still far louder. Pulse+saw mean ~75 vs ~7 (about +20 dB). Pulse+saw+tri ~12 vs ~0.4. Saw+tri ~12 vs ~1.5. On GT2's default 6581, a $61 or $71 sound is near-silent or thin in reSID but clearly audible in ours. | **high** | high | INTENTIONAL SIMPLIFICATION (waveform.rs:61-67, "Ears-gate") |
| 2.3 | waveform.rs:143-145 + voice.rs:294-306: no waveform selected → hold the last DAC value (8580 forever; 6581 drops to 0 after 65 536 cycles) | wave.h:244-247: waveform 0 outputs 0x000 immediately | reSID's voice jumps to its lowest DAC code, which shows up as a DC step through the envelope (`(0 − wave_zero)·env`, voice.h:72). Ours freezes. This differs on every GT2 "first wave $08/$09" TEST frame and on `$E0-$EF` silent table rows. | low–med (clicks and thumps) | high | INTENTIONAL SIMPLIFICATION (waveform.rs:68-75, INFERRED) |
| 2.4 | waveform.rs:160-161: noise+X = AND (plus write-back, §1.6) | wave.h:414-453: noise+X = 0 | Ours leaks some audio for a few shifts, then goes quiet; reSID is silent at once. | low | high | REAL DIVERGENCE |
| 2.5 | Tables: none; computed each cycle (6581 through a precomputed 4096 table of our own rule, waveform.rs:199-207) | 8 GPL tables of measured data (wave6581_*.cpp, wave8580_*.cpp, 536 lines each) | Where the data comes from: reSID uses measurement, we use inference. We cannot adopt reSID's tables (GPL, plan §8.3). | — | high | INTENTIONAL SIMPLIFICATION |

---

## 3. RING MOD + SYNC

| # | Ours | Theirs | Semantic delta | Impact | Conf | Class |
|---|---|---|---|---|---|---|
| 3.1 | waveform.rs:113-117: fold = MSB(own) XOR **NOT** MSB(source) | wave.h:259-261: fold = MSB(own) XOR MSB(source) (accumulator MSBs, not outputs) | **Opposite polarity.** Our ring-mod triangle is reSID's with bits 11..1 inverted (our own test pins this at waveform.rs:296-299). Alone, it is a half-period phase shift, inaudible. In ring+pulse+tri combinations the inverted triangle ANDs differently, and the 6581 DC offset makes the inversion faintly audible. | low | high | REAL DIVERGENCE (ours cites "the plan's specified polarity", waveform.rs:18-24) |
| 3.2 | Both ring mod and sync use the accumulator MSB, not the output (waveform.rs:114-115; chip.rs:268-270) | wave.h:146, 259 | Same. | none | high | EQUIVALENT |
| 3.3 | chip.rs:268-275: sync on the source's MSB rising edge, suppressed when the source is itself synced that cycle | wave.h:228-230 | Same rule, including the "synced source doesn't propagate" special case. | none | high | EQUIVALENT |
| 3.4 | voice.rs:253-258: under TEST, `acc = 0` every cycle and `msb_rising` is recomputed as false | wave.h:135-137: under TEST `clock()` returns early and leaves `msb_rising` **stale**; `synchronize()` (wave.h:228) can then keep resetting the destination every cycle | Edge case: a TEST'd sync source whose last cycle had a rising MSB hard-locks its destination in reSID; in ours the destination runs free. | low | med | REAL DIVERGENCE (reSID artefact) |
| 3.5 | Sync in ours is exact per cycle (chip.rs:264-281) | Delta mode clocks up to the next MSB toggle of any sync source (sid.cpp:677-722) | Both hit the sync cycle exactly. | none | high | EQUIVALENT |
| 3.6 | 6581/8580: no model difference in ring or sync | reSID: none either (it notes the 8580's one-cycle output delay without modelling it, wave.h:236-237) | — | none | high | EQUIVALENT |

---

## 4. PULSE WIDTH

| # | Ours | Theirs | Semantic delta | Impact | Conf | Class |
|---|---|---|---|---|---|---|
| 4.1 | waveform.rs:121-127: high when `acc[23:12] >= pw` (12-bit) | wave.h:284-287 | Same comparator. | none | high | EQUIVALENT |
| 4.2 | waveform.rs:158: TEST forces the pulse to 0xFFF | wave.h:286 | Same. | none | high | EQUIVALENT |
| 4.3 | Pulse+saw/tri = AND with the pulse (waveform.rs:146-162), then §2 | wave.h:389-401: table sample ANDed with the pulse output | The pulse gating is the same; the level differs (§2.1/2.2). | see §2 | high | EQUIVALENT (gating) |
| 4.4 | voice.rs:229-230 PW_HI masks 4 bits; player writes the full 12 bits (player.rs:868-869) | wave.cpp:84-86 same mask; **GT2 clears PW bit 0** on every write (gplay.c:943) | A 1/4096 duty difference. | none | high | EQUIVALENT (player-level nit) |
| 4.5 | — | wave.h:277-278: reSID notes a one-cycle pulse output delay, not modelled | Neither models it. | none | high | EQUIVALENT |

---

## 5. ADSR

| # | Ours | Theirs | Semantic delta | Impact | Conf | Class |
|---|---|---|---|---|---|---|
| 5.1 | envelope.rs:53-55 rate periods | envelope.cpp:99-116 | Identical 16 values. | none | high | EQUIVALENT |
| 5.2 | envelope.rs:166-170: 15-bit counter, equality compare, wraps 0x7FFF→0 | envelope.h:102-110: 16-bit counter, bit 15 set → skip to 1 | The ADSR delay bug exists on both sides. The wrap point differs by one cycle. | none | high | EQUIVALENT |
| 5.3 | envelope.rs:65-75, 180-184: the exponential divider is **computed from the current level** each step | envelope.h:154-180: the divider is **latched** when the counter passes 255/93/54/26/14/6/0 **in any direction** | After a partial attack (for example up to level 100, then release), reSID keeps the divider latched on the way up (2 at level 93) until the next breakpoint. Ours uses 1 above 93, so our release starts faster. reSID documents this effect (envelope.cpp:123-124). | low | high | REAL DIVERGENCE |
| 5.4 | envelope.rs:174-177: attack `saturating_add`, then decay at 255 | envelope.h:131-135: attack increments **mod 256**; entering attack at 0xFF wraps to 0x00 and freezes (hold_zero) | reSID models the "envelope wrap" silence. Ours can't. Trigger: legato re-gate within one release period after a sustain-F note (for example R=F, 31 ms, longer than one frame) and no hard restart. | low–med | high | REAL DIVERGENCE |
| 5.5 | envelope.rs:185-189: hold at level 0 in decay/release | envelope.h:143-149, 173-178: release decrements mod 256; hold_zero is set on reaching 0 and cleared only by gate-on (envelope.cpp:190-192) | The "0→0xFF" release wrap in reSID needs attack→release before the first step at 0. Otherwise the zero freeze behaves the same. | none–low | med | EQUIVALENT (except the edge case) |
| 5.6 | envelope.rs:185-186: sustain compare `level == S*17` | envelope.cpp:156-173 + envelope.h:138 | Same (nibble repeated in both halves, stop on equality). | none | high | EQUIVALENT |
| 5.7 | envelope.rs:173: attack resets the exponential counter | envelope.h:115 | Same. | none | high | EQUIVALENT |
| 5.8 | Gate-on delay: none beyond the rate-counter phase (envelope.rs:49-50) | None (envelope.cpp:183-184 only mentions the rate-counter delay; the 1-cycle exp delay is not modelled, envelope.cpp:136-149) | Same. | none | high | EQUIVALENT |
| 5.9 | voice.rs:307-314: **6581 attack lag** (one-pole, τ ≈ 673 cycles) on the applied amplitude | reSID: none; amplitude = counter (voice.h:72) | Ours softens 6581 attacks faster than about 2 ms. reSID is linear. | low–med (fast-attack 6581 drums/plucks lose a little click) | high | INTENTIONAL SIMPLIFICATION (INFERRED, voice.rs:34-57) |
| 5.10 | TEST has no effect on the envelope (envelope.rs:46-47) | Same (envelope.cpp:126-127) | — | none | high | EQUIVALENT |

---

## 6. FILTERS

| # | Ours | Theirs | Semantic delta | Impact | Conf | Class |
|---|---|---|---|---|---|---|
| 6.1 | chip.rs:324-342: **one shared filter**. Every voice with FILTn=1 is summed into `filt_in`; the rest go to `direct` | filter.h:250-316: same 3-input bus (plus EXT IN) | Same topology. Our per-voice taps (chip.rs:78-83) are a display feature and show filtered voices unfiltered; the mix is not per-voice. | none | high | EQUIVALENT |
| 6.2 | filter.rs:213-235: 2-pole TPT SVF at the output rate, on the boxcar-averaged input | filter.h:326-330: forward-Euler two-integrator loop per cycle; in GT2's default delta mode, 8-cycle Euler steps (filter.h:446-470) | Same filter family. The integration method differs (in-band equivalent). | low | high | EQUIVALENT |
| 6.3 | 6581 cutoff: filter.rs:101-107, logistic in log f, 220 Hz–18 kHz. Values: reg 512 → 384 Hz, 768 → 761 Hz, 1023 → 1986 Hz, 1280 → 5.2 kHz, 1536 → 10.3 kHz | filter.cpp:45-80: measured spline, 220 Hz floor, about 420 Hz at 512, 1.6 kHz at 768, ~6 kHz at 1023, **then a discontinuity down to ~4.6 kHz at 1024 (FC_HI $80)**, 9.5 kHz at 1280, 14.5 kHz at 1536 | Ours is **2–3× darker across FC_HI $50–$7F**, where most 6581 sweeps live, and has no $7F/$80 step. | **high** | high | INTENTIONAL SIMPLIFICATION (filter.rs:43-46, "No measured curve was used") |
| 6.4 | 8580 cutoff: filter.rs:77-79, linear 30 Hz–12 kHz | filter.cpp:82-105: spline 0 Hz–12.5 kHz, slightly bowed | Ours is 5–10 % lower mid-range (for example 4.5 vs 4.8 kHz at reg 768). | low | high | EQUIVALENT (close) |
| 6.5 | Ours has no ceiling other than 0.49·fs (filter.rs:204) | filter.cpp:259-265: cutoff limited to 16 kHz (1-cycle mode) and **4 kHz in delta mode**; GT2's default `SAMPLE_FAST` takes the delta path (sid.cpp:780 → 725-726 → filter.h:461) | **In default GT2, no filter setting opens past 4 kHz**, on either chip model. Songs were mixed by ear against that ceiling, so high-cutoff sweeps and bright filtered drums are brighter in ours. | **high** (sweeps above ~$70 on 6581, ~$50 on 8580) | high | REAL DIVERGENCE |
| 6.6 | Resonance: filter.rs:82-84 (8580) Q = 0.707·2^(res/8), max 2.59; filter.rs:110-112 (6581) Q = 0.707·2^(res/12), max 1.68 | filter.cpp:269-278: Q = 0.707 + res/15, max 1.707, the same for both models | Our 8580 peaks about 3.6 dB hotter at res 15. The 6581 shape is similar (1.12 vs 1.24 at res 8). | med (8580 resonant songs) | high | INTENTIONAL SIMPLIFICATION (filter.rs:19-24, INFERRED) |
| 6.7 | filter.rs:218-220: 6581 tanh soft limit on the band-pass state | none (reSID's filter is linear; it notes the op-amp misbehaviour but does not model it, filter.h:31-36) | Ours compresses loud resonant 6581 filtering. | low–med | high | INTENTIONAL SIMPLIFICATION (ours only) |
| 6.8 | Filter taps non-inverted (LP DC gain +1) | filter.h:40-43, 330: outputs are **inverted** relative to the input (LP settles at −Vi) | In reSID a filtered voice is summed into the mix phase-inverted relative to unfiltered voices. Audible only for correlated content (two voices on the same note, one filtered). | low | high | REAL DIVERGENCE |
| 6.9 | chip.rs:338-341: 3OFF only removes voice 3 when it is not filtered | filter.h:226-231 | Same. | none | high | EQUIVALENT |
| 6.10 | Mode sum LP/BP/HP, none = silent (filter.rs:224-234) | filter.h:496-522 | Same. | none | high | EQUIVALENT |
| 6.11 | extfilt: chip.rs:104, 350-353, a 16 Hz one-pole DC blocker; the boxcar decimator does the anti-aliasing | extfilt.cpp:38-39 + extfilt.h:85-108: ~16 kHz low-pass + ~16 Hz high-pass | Same high-pass. reSID has an extra 16 kHz low-pass. | low | high | EQUIVALENT |

**GT2 filter-table frame semantics** (what songs expect). There is no `setfilter` function in gsong.c; gsong.c:601-630 only converts the old GT1 filter-table format on load. The run-time semantics live in `playroutine()`:

| # | Ours | Theirs | Semantic delta | Impact | Conf | Class |
|---|---|---|---|---|---|---|
| 6.12 | player.rs:438: filter table runs **after** the channels in a frame | gplay.c:253-302: filter table runs **before** the channel loop (gplay.c:304) | A filter pointer set by an instrument trigger starts in the same frame in ours and one frame later in GT2. | low–med | high | REAL DIVERGENCE |
| 6.13 | player.rs:805-808, 827: cutoff speed adds `speed<<3` to an 11-bit value, **clamped** to 0..0x7FF | gplay.c:293: 8-bit `filtercutoff += speed` **wraps** mod 256; FC_LO is always written as 0 (gplay.c:299) | A sweep that runs past $FF/$00 jumps to the other end in GT2 and sticks at the limit in ours. | med (songs that rely on the wrap) | high | REAL DIVERGENCE |
| 6.14 | player.rs:829-832: a `$80+` row sets mode/resonance/routing; the next row runs next frame | gplay.c:265-276: a `$80+` row immediately followed by a `$00` cutoff row is consumed **in the same frame** | Our cutoff lands one frame late after a set-filter row. | low | high | REAL DIVERGENCE |
| 6.15 | player.rs:564: command B only sets $17 | gplay.c:469-471 / 677-679: command B with 0 also **stops the filter table** | A running filter table keeps going in ours. | low–med | high | REAL DIVERGENCE |

---

## 7. VOLUME / DAC

| # | Ours | Theirs | Semantic delta | Impact | Conf | Class |
|---|---|---|---|---|---|---|
| 7.1 | voice.rs:208-215: waveform DAC linear; 8580 zero point 0x800; output `(wave−0x800)/0x800 · env/255` | voice.cpp:103-104 + voice.h:72: 8580 zero 0x800, no DC; output `(wave − 0x800)·env` | Same. | none | high | EQUIVALENT |
| 7.2 | voice.rs:76, 213: 6581 envelope-scaled DC = +0.25 half-scale | voice.cpp:78: 6581 zero point 0x380, so the envelope-scaled offset = 0x480/0x800 ≈ **+0.56** half-scale | reSID's 6581 gate thump and envelope-DC "digi" is about 2.25× ours. | med (6581 thumps and digis) | high | INTENTIONAL SIMPLIFICATION (INFERRED tuning, voice.rs:28-33) |
| 7.3 | chip.rs:97, 347: 6581 mixer DC = **+0.5 voice**, scaled by volume | voice.cpp:99: a **constant +1 half-scale per voice** (`voice_DC`, not envelope-scaled; three voices give +3) plus a small negative mixer DC (filter.cpp:170, −1/18) | reSID's volume-register ($D418) DC step is roughly 5–6× ours. In reSID the per-voice constant also passes through the filter when the voice is routed there, so mode or routing changes make DC steps. Ours has none. | med ($D418 digis, 6581 filter/volume clicks) | med | INTENTIONAL SIMPLIFICATION (chip.rs:57-67, INFERRED) |
| 7.4 | chip.rs:306, 345-348: volume linear VOL/15 | filter.h:526: linear `·vol` | Same. | none | high | EQUIVALENT |
| 7.5 | No DAC bit-weight nonlinearity | No DAC bit-weight nonlinearity in classic reSID either (voice.h:72 is a linear product). Only resid-fp has "voice nonlinearity" (gsid.cpp:121-122), and GT2 uses it only with `-I2/-I3` (gsound.c:216) | Neither default path has the 6581 DAC "crunch". The 6581 character in default GT2 comes from the combined-waveform tables (§2) and the DC offsets (7.2/7.3). | none (default) | high | EQUIVALENT |
| 7.6 | chip.rs:94, 100: float output, CHIP_GAIN 0.28 (8580) / 0.198 (6581), no clip | sid.cpp:119-131: 20-bit sum scaled to 16-bit and **hard-clipped** | Different headroom. reSID can clip on hot resonant 6581 mixes; ours cannot. | low | high | EQUIVALENT (different scaling) |

---

## 8. FRAME / TIMING

| # | Ours | Theirs | Semantic delta | Impact | Conf | Class |
|---|---|---|---|---|---|---|
| 8.1 | player.rs:96, 199: frame = exactly 1/50 s (fractional samples per frame) | bme_snd.c:386 + gsound.c:93-94: player called every `(mixrate·5/2)/125` samples = 882 at 44.1 kHz = exactly 50 Hz; gsid.cpp:144: 19 704 cycles per frame (integer) | Both use 50 Hz, not the raster's 50.125 Hz. | none | high | EQUIVALENT |
| 8.2 | chip.rs:314-323: digital core clocked **every cycle**; output = boxcar mean of ~22.34 cycles | gsid.cpp:77-80 → sid.cpp:766-790: `SAMPLE_FAST`, core advanced in **delta chunks**, output **point-sampled** once per sample | GT2 aliases hard: high saw/pulse harmonics and fast noise fold back at full level. Ours is band-limited (first null at fs). Ours is cleaner and slightly darker on bright waveforms. | med | high | REAL DIVERGENCE (ours is a deliberate choice, chip.rs:48-55) |
| 8.3 | player.rs:862-883: all registers written at one output-sample boundary, order freq, PW, AD, SR, control, then $15-$18 | gsid.cpp:147-187 + gsid.h:5-6: 25 writes, 9 cycles apart, **+4 cycles before each control write**, order $15,$16,$18,$17, then per voice PW, SR, AD, freq, control (gsid.cpp:20-24); `adparam ≥ $F000` switches to control-first (gsid.cpp:26-30, 126-132) | GT2 spreads writes over about 250 cycles (~0.25 ms). Relative order differs only in details (filter first; SR before AD); ADSR lands before control on both sides. | none–low | high | EQUIVALENT |
| 8.4 | player.rs:432-438: per channel continuous → wave → pulse → hard restart; then filter; then writes | gplay.c:253-302 filter first; per channel gplay.c:318-337 tick, TICK0 sequencer/new-note (340-400), tick-0 command (404-509), WAVEEXEC (516-724), TICKNEFFECTS (727-843), PULSEEXEC (845-898), GETNEWNOTES at `tick == gatetimer` (899-935), write (936-946) | See 6.12 for the filter. The per-channel order is the same shape. | low | high | EQUIVALENT (except 6.12) |
| 8.5 | player.rs:632-634, 638-691: continuous effects (commands 1/2/3/4 and instrument vibrato) run on **every frame but the trigger frame**, including tick 0 of non-trigger rows | gplay.c:728: with `optimizerealtime` (the default) tick-N effects are **skipped on tick 0 of every row** | Our portamento and vibrato advance tempo/(tempo−1) × as far per row (at tempo 6: 6 steps vs 5, +20 % slide distance and vibrato phase drift). Only the `3 00` tie case is aligned (player.rs:652-666). | **med** | high | REAL DIVERGENCE |
| 8.6 | player.rs:581, 435, 696: trigger sets freq; pulse runs on the trigger frame; wave runs on it when `first_wave == 0` | gplay.c:510-514: a new note on tick 0 skips wave, pulse and freq; the pitch comes from the first wave row next frame (gplay.c:714-719) | This is the §0 candidate 2. With `first_wave == 0`, every instrument's table timeline is one frame early and its first frame is at the new pitch. | med | high | REAL DIVERGENCE |
| 8.7 | player.rs:732-733, 551, 875: waveform gate bit stripped; the channel gate decides | gplay.c:525, 527, 433, 652, 945: table/command waveform byte kept whole; register = `wave & gate` | This is the §0 candidate 1. Table rows with gate bit 0 release the note in GT2 and not in ours. | **high** | high | REAL DIVERGENCE |
| 8.8 | player.rs:872-876: `first_wave` written raw on the trigger frame | gplay.c:356-364: `firstwave ≥ $FE` only **sets the gate mask** ($FE = gate off, $FF = on) and leaves the waveform alone | An instrument with first wave $FE/$FF writes control $FE/$FF in ours (all waveforms + TEST + sync + ring). | low (rare), but severe when hit | high | REAL DIVERGENCE |
| 8.9 | player.rs:856-859: hard-restart ADSR = AD $00, SR $00 | gplay.c:929-930 + goattrk2.c:49: AD = adparam>>8 = **$0F**, SR = $00 | Only the decay nibble differs, and it is irrelevant while the gate is off (release state), except for rate-counter phase at re-trigger. | none–low | high | REAL DIVERGENCE (trivial) |
| 8.10 | player.rs:843-860: hard restart at `tick == tempo − gate_timer`, next row must hold a note and not command 3 | gplay.c:899-935: GETNEWNOTES at `tick == gatetimer` (tick counts down), same note / non-toneporta test (gplay.c:919-933) | Same moment by construction (pinned in S5). Not re-derived here. | none | med | EQUIVALENT |
| 8.11 | player.rs:764-801: pulse table runs every frame | gplay.c:846-857: with `optimizepulse` (the default) the pulse table is skipped on the `gatetimer` frame (it jumps to new-note fetch) and on sequencer frames | A pulse-sweep timing difference of one frame per row. | low | med | REAL DIVERGENCE |

---

## What we do that GT2/reSID does not

These are deliberate extras on our side. Some are more hardware-motivated than reSID, and none of them is in reSID's code.

1. **Noise write-back and LFSR lock-up** (noise.rs:21-28, 71-79; voice.rs:286-289). reSID zeroes noise combinations and says it does not model lock-up (wave.h:405-411). Ours can leave a voice's noise silent until a TEST.
2. **Waveform-0 hold and 6581 fade** (voice.rs:294-306). reSID outputs 0 at once (wave.h:244-247).
3. **Boxcar anti-alias decimation** of a per-cycle core (chip.rs:314-323). Default GT2 point-samples a delta-clocked core (sid.cpp:766-790).
4. **6581 attack-lag envelope** (voice.rs:307-314). reSID has none.
5. **6581 band-pass saturation** (filter.rs:218-220). reSID's filter is linear.
6. **No 4 kHz / 16 kHz cutoff ceiling** (filter.rs:204). reSID has both (filter.cpp:259-265).
7. **Per-model resonance maps**, with the 8580 stronger (filter.rs:82-84, 110-112). reSID has one linear Q map for both.
8. **Exact per-cycle sync and noise clocking at all times.** reSID's delta paths approximate them (wave.h:160-212; sid.cpp:677-722), though they are correct at edges.
9. **Per-voice taps and a voice mask** (chip.rs:78-85, 186-188). These are app features with no reSID equivalent.
10. **No output clipping** (chip.rs:344-353). reSID hard-clips at 16 bit (sid.cpp:119-131).
11. **TEST holds the LFSR at all ones** (noise.rs:83-85). reSID clears it to 0 (wave.cpp:105-108) and reseeds on release.

Things reSID models that we do not:
- Measured combined-waveform tables (§2).
- The measured 6581 cutoff spline with its $7F/$80 discontinuity (§6.3).
- The 8-bit envelope wrap-to-zero freeze (§5.4).
- The latched exponential divider (§5.3).
- A bus-value readback for write-only registers (sid.cpp:151-178). Ours returns 0 (chip.rs:253-260).
- Filter output inversion (§6.8).
- The larger 6581 DC terms (§7.2, 7.3).

---

## Top discrepancies ranked by audible impact

1. **Wave-table / command-7 gate bit is dropped** (player.rs:732-733, 551, 875 vs gplay.c:525, 945). Notes whose table rows turn the gate off keep sustaining; noise drums get long white tails. *Most likely cause of the reported drum symptom.* REAL DIVERGENCE, high/high.
2. **Combined waveforms are far too loud**, most of all on the 6581 (waveform.rs:146-166, 175-207 vs wave.h:380-402 + tables). $61/$71/$51 sounds are +6…+20 dB relative to reSID. INTENTIONAL SIMPLIFICATION, high/high.
3. **Filter ceiling of 4 kHz in default GT2** (filter.cpp:263-265 via sid.cpp:780) vs none in ours. Every bright filter setting is brighter in ours. REAL DIVERGENCE, high/high.
4. **6581 cutoff curve** (filter.rs:101-107 vs filter.cpp:45-80). Ours is 2–3× lower across FC_HI $50–$7F and lacks the $80 step. INTENTIONAL SIMPLIFICATION, high/high.
5. **Tick-0 effects run in ours** (player.rs:632-691 vs gplay.c:728). Slides and vibrato go about 20 % further per row at tempo 6. REAL DIVERGENCE, med/high.
6. **New-note first frame** (player.rs:435, 581, 696 vs gplay.c:510-514). Table timelines are one frame early when first wave = 0. REAL DIVERGENCE, med/high.
7. **Sampling method** (chip.rs:314-323 vs sid.cpp:766-790). GT2 aliases, ours is band-limited. REAL DIVERGENCE (deliberate), med/high.
8. **Filter-table cutoff wrap vs clamp, and filter-before-channels order** (player.rs:805, 438 vs gplay.c:293, 253-304). REAL DIVERGENCE, med/high.
9. **6581 DC terms** (voice.rs:76, chip.rs:97 vs voice.cpp:78, 99). Thumps are about 2.25× smaller in ours, and volume-digi DC about 5–6× smaller. INTENTIONAL SIMPLIFICATION, med/med.
10. **8580 resonance** about 3.6 dB hotter at res 15 (filter.rs:82-84 vs filter.cpp:277). INTENTIONAL SIMPLIFICATION, med/high.
11. Lower-impact items: envelope wrap freeze (5.4), noise write-back/lock-up vs zero (1.6), waveform-0 hold (2.3), ring-mod polarity (3.1), TEST-time LFSR value (1.5), `firstwave ≥ $FE` (8.8), filter output inversion (6.8).

**No matching mechanism found:**
- `gsong.c` has no `setfilter`. The filter-table run-time semantics are in `gplay.c:253-302`; gsong.c only converts old-format filter tables on load (gsong.c:601-630).
- Our 6581 attack lag, band-pass saturation and waveform-0 fade have no reSID counterpart.
- reSID's bus-value readback, and the stale-`msb_rising`-under-TEST sync artefact (wave.h:135-137), have no counterpart in ours.
