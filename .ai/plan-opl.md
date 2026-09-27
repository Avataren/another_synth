# Plan: OPL tracking (one OPL2/OPL3 chip in Rust + S3M AdLib playback + Adlib Tracker II)

Status: **IN PROGRESS. D0–D5 accepted as recommended (Morten, 2026-09-27). Corpus fetched
(§4.1). O0, O1 and O2 landed 2026-09-27 (landing records at the end).**
Morten's brief 2026-09-27 (verbatim intent): *"I'm considering adding adlibtracker and opl
support to s3m, do you think they could share the same virtual opl chip in rust? would be
nice if it could also support opl2/3"*. Answer: yes. The shared surface is the **register
interface**: one chip, driven by register writes from any player.

Labels: **MEASURED** (verified in this repo, file:line), **INFERRED** (reasoning stated),
**UNVERIFIED** (needs a check before the batch that depends on it).

---

## 0. What already exists (MEASURED)

- The S3M parser keeps AdLib instruments: `S3mInstrument.kind === 'adlib'`, raw timbre bytes
  D00..D0B in `oplRegisters`, `adlibVolume`, `adlibKind` ('melody' for type 2, 'drum' for
  type 3+) — `packages/tracker-playback/src/formats/s3m.ts:123-150`.
- The importer carries them through untouched as `TrackerSample.opl: OplInstrumentData`
  (`kind`, `registers`, `volume`, `c2spd`) with empty PCM —
  `packages/tracker-playback/src/import/s3m-samples.ts:117-141`,
  `packages/tracker-playback/src/tracker-sample.ts:87-96`. The comment there already
  names "the future dedicated WASM OPL core" as the consumer.
- AdLib channels (channel setting types 16..29) are detected and their cells **counted then
  dropped** — `packages/tracker-playback/src/import/s3m-patterns.ts:57-74, 411-414`.
- The app already has an `'opl'` instrument type and 'OPL' badge —
  `src/audio/tracker/instrument-types.ts:16, 101, 238`.
- Only type 2 (melodic) AdLib instruments are ever played by ST3: "st3play's doadlib only
  ever sees type 2" — `packages/tracker-playback/src/formats/s3m.ts:483-485`.
- Precedent for a chip core: `rust-wasm/src/sid/` (`chip.rs` with `write`, timestamped
  `write_after(delay, reg, val)`, `flush_writes`, `set_voice_mask`; `wasm.rs` exposing a
  player class; `src/audio/worklets/sid-worklet.ts` + `sid-core.ts`). AHX has the same shape
  in `rust-wasm/src/ahx/`.
- Rust deps contain no OPL emulator (`rust-wasm/Cargo.toml`).

So S3M needs the chip and a note→register driver, not a re-parse.

---

## 1. The chip: one OPL3 core, OPL2 as a mode

### 1.1 Why one core (INFERRED from the YMF262/YM3812 datasheets)

The OPL3 is a superset of the OPL2. With the NEW bit (reg `0x105` bit 0) clear it runs in
OPL2 compatibility mode. So the design is one OPL3 implementation with a mode flag:

| | OPL2 (YM3812) | OPL3 (YMF262, NEW=1) |
|---|---|---|
| Channels | 9 × 2-op | 18 × 2-op, up to 6 pairs as 4-op (`0x104`) |
| Register space | `0x00–0xFF` | `0x000–0x0FF` + `0x100–0x1FF` |
| Waveforms | 4, gated by WSE (`0x01` bit 5) | 8 |
| Output | mono | stereo, per-channel L/R (`C0–C8` bits 4–5) |
| Rhythm mode (`0xBD`) | yes | yes |
| Native rate | 3.579545 MHz / 72 ≈ 49 716 Hz | 14.31818 MHz / 288 ≈ 49 716 Hz |

In compatibility mode (NEW=0) the chip **aliases** bank 1 onto bank 0 (every `0x1xx`
write except `0x105` lands on `0x0xx`; ymfm `write_address_hi`, "tests reveal"), limits
waveform select to 2 bits (0..3), and sends every channel to both outputs. **WSE (`0x01`
bit 5) is not honoured by a YMF262**: waveforms 0..3 are always available in compatibility
mode. WSE gating and the YM3014 DAC quantisation are YM3812-only. So "OPL2 mode" here means
an OPL3 with NEW=0, which is what SB Pro 2 / SB16 owners heard. A strict YM3812 model (WSE,
DAC, modulator delay) would be a later option if a file ever needs it. *(Corrected in O0,
2026-09-27; the first draft said "masks bank 1" and "WSE gating", both wrong for an OPL3.)*

### 1.2 Shape

New tree `rust-wasm/src/opl/`, modelled on `sid/`:

- `chip.rs` — `Chip { mode: OplMode, regs: [u8; 512], ops: [Operator; 36], chans: [Channel; 18], .. }`;
  `write(reg: u16, val: u8)`, `write_after(delay_samples, reg, val)` (same idea as SID),
  `render(&mut [f32] /* interleaved L/R */)`, `set_channel_mask(u32)`, per-channel taps.
- `operator.rs` — phase generator, log-sin/exp tables, 8 waveforms, KSL, feedback.
- `envelope.rs` — ADSR with the real rate table, KSR, EG type (sustain/percussive).
- `lfo.rs` — tremolo (AM) and vibrato (VIB) with `0xBD` depth bits.
- `rhythm.rs` — BD/SD/TT/CY/HH on channels 6–8.
- `resample.rs` — 49 716 Hz to the output rate (same job as the SID's decimation step).
- `wasm.rs` — an `OplChip` class for the worklet (register stream in, stereo out) and, later,
  an `A2Player` class (§3).
- `Chip` is an instance, so dual OPL2 or two OPL3s is just two instances if a format needs it.

Cost (INFERRED): 36 operators at ~50 kHz is trivial next to the SID's per-cycle clocking.

### 1.3 Accuracy target

Aim for per-sample accuracy on the digital parts: the real log-sin/exp table arithmetic,
envelope rate counters, LFO steps, 4-op connections and the rhythm-mode noise. With those,
the output should be close to bit-exact against a reference core on held notes. The analog
path matters far less than on the SID (the OPL output is a clean DAC), so this should be a
much smaller job than the SID filter was.

---

## 2. S3M AdLib playback (library side + app side)

### 2.1 Where the driver lives

The S3M engine is TypeScript in `packages/tracker-playback`, which must stay WASM-free
(CLAUDE.md). So:

- **Library:** a new `opl-driver.ts` turns note/volume/effect state on AdLib channels into
  **OPL register writes**, as ST3 does: `D00..D0B` into the operator registers at note-on,
  F-number/block from the note and `c2spd`, volume into the carrier TL (and the modulator TL
  when the connection is additive), note-off as key-off (`B0` bit 5 clear). ST3's AdLib
  channels A1..A9 map to OPL channels 0..8.
- **Sink:** an **optional** `TrackerSink` member, e.g. `oplWrite?(time: number, reg: number,
  val: number): void`. A sink without it keeps today's behaviour (AdLib cells dropped).
  Optional keeps the 21-member interface backward compatible for external consumers.
- **App:** `song-bank.ts` implements `oplWrite` by batching the writes per tick and posting
  them to an `opl-worklet`. The worklet turns AudioContext times into sample offsets and calls
  `write_after`. Its output feeds the same mixer as the sampler voices, because one S3M can
  hold both PCM and AdLib channels.
- **Standalone:** `StandaloneTrackerSink` takes an optional injected OPL sink, so the package
  still ships without WASM while a consumer can plug a chip in.

The rule that the library never emits a `Patch` (CLAUDE.md) stands: the OPL data is the raw
register bytes it already carries.

### 2.2 Which effects apply on AdLib channels (UNVERIFIED — check against st3play / ST3 docs)

Portamento, vibrato and arpeggio work on the F-number instead of the sample period. Volume
slides work on TL. Sample offset (Oxx), panning and retrigger have no meaning. Build this
table from the reference before O4. Do not guess.

### 2.3 Drum instruments

Types 3+ are parsed but ST3 never plays them (§0). Proposal: play only type 2, keep counting
and warning about drums as the importer does now. (D2)

---

## 3. Adlib Tracker II (`.a2m` / `.a2t`)

- OPL3-native: 18 channels, 4-op, per-channel panning, percussion mode, plus its own
  instrument macros (FM register tables, arpeggio/vibrato tables) and an extended effect set.
  **UNVERIFIED:** format versions and which of them are compressed (several packers across
  versions). Pin both against real files and the reference source before O6.
- Where it lives: a Rust player next to the chip (`rust-wasm/src/opl/a2/`), with the same
  shape as `ahx/player.rs` and `sid/player.rs`. The macro and effect machinery ticks per
  frame and writes registers directly, so there is nothing to gain by routing it through the
  TS engine. The worklet API matches SID/AHX: play/pause/seek_row/loop/mute_solo/taps.
- Parsing: a `formats/a2m.ts` in the library is only needed if the editor has to show A2M
  patterns. For playback only, parse in Rust. (D3)
- "adlibtracker" could also mean the original AdLib Tracker or Reality AdLib Tracker (RAD,
  also OPL3). The chip core serves all of them. This plan assumes Adlib Tracker II. (D0)

---

## 4. Reference oracles and licensing

| Source | Use | License |
|---|---|---|
| YMF262 / YM3812 datasheets | register semantics | n/a |
| ymfm (Aaron Giles) | chip core reference / port candidate | BSD-3 (UNVERIFIED — confirm in repo) |
| Opal (Reality AdLib Tracker; used by OpenMPT for S3M OPL) | lightweight core reference | UNVERIFIED — reportedly public domain |
| Nuked OPL3 | the cycle-accurate gold standard, **render-only oracle** | LGPL 2.1 — do not copy code |
| DOSBox dbopl | — | GPL — out |
| AdPlug (`adplay` to WAV) | render oracle for A2M and AdLib-only S3M | LGPL — run, do not copy |
| OpenMPT | render oracle for mixed PCM+AdLib S3M | BSD-3 |
| Adlib Tracker II source | A2M semantics | UNVERIFIED — check before reading |

Stance (proposal, D1): port from or study permissive sources only (datasheets, ymfm, Opal
if its license checks out). Nuked/AdPlug/OpenMPT are used only as **binaries that render
WAVs** for A/B, the way gt2reloc is used for SID. This matches the SID's "no GPL code
consulted" rule.

### 4.1 Corpus (fetched 2026-09-27)

`src/tests/fixtures/opl/`, with its README as the manifest: 42 AdLib S3Ms and 278 A2Ms
(all of modland's "Screamtracker 3 AdLib" and "AdLib Tracker 2" folders, plus NAB622's
*Corridors of Time*), 5.1 MB. Findings that change the plan:

- **No S3M in the corpus has a type 3+ drum instrument**, so D2 (melodic only) costs
  nothing. Six files do enable drum (B) channel settings; the driver ignores them.
- The three `Manwe/` S3Ms mix PCM and AdLib, and are the O5 mixer gate.
- A2M versions present: 1, 5, 9, 10, 11 (145 files), 12, 13, 14. There are no `.a2t` files.
  O6 has to cover all eight versions, or refuse the ones it cannot parse.
- **Real-hardware reference:** NAB622's own recording of *Corridors of Time* from a Sound
  Blaster 16 CT2290 (OPL3), kept locally at `.ai/opl-ref/` (24 MB FLAC, not vendored). Add it
  to the O1 gate (chip character vs a real YMF262) and the O7 gate (the A2M player end to end).

---

## 5. Batch plan (O-series; not started)

| Batch | Scope | Gate |
|---|---|---|
| **O0** spike | one 2-op channel: operator + envelope + sine, OPL2 mode, one held note | bit-exact (or within ±1 LSB) against the oracle render of the same register writes; Morten's ears |
| **O1** chip | full OPL3: 18 ch, 8 waveforms, 4-op, LFOs, rhythm, stereo, OPL2 mode masking, resampler | register-script tests (a script of writes → WAV compare vs oracle); OPL2-mode tests (WSE off → sine only, bank 1 ignored) |
| **O2** WASM + worklet | `OplChip` in `wasm.rs`; `src/audio/worklets/opl-worklet.ts` + `opl-core.ts`; `build-worklets.cjs` entry; timestamped write queue | a scripted note sequence sounds right in the browser; writes land on the right sample (unit test on offset math) |
| **O3** S3M driver | `opl-driver.ts` in the library (note-on/off, F-number/block, TL volume); optional `TrackerSink.oplWrite`; stop dropping AdLib cells in `s3m-patterns.ts` | driver unit tests (cell → exact register writes); corpus S3M with AdLib renders against OpenMPT |
| **O4** S3M effects | the §2.2 effect table on AdLib channels | per-effect tests vs reference renders |
| **O5** app | `song-bank.ts` mixer routing, mute/solo, scope/spectrum taps, instrument panel shows OPL as playable, StandaloneTrackerSink injection | e2e: mixed PCM+AdLib S3M plays in the app; `npm run test:run` green |
| **O6** A2M parse | Rust parser for the supported A2M/A2T versions incl. decompression | corpus parse test: every file parses or refuses with a true one-liner (E15 discipline) |
| **O7** A2M player | macros, effects, 4-op, percussion; `A2Player` worklet class; tracker page hookup like AHX/SID | A/B vs AdPlug renders; *Corridors of Time* vs the SB16 recording (§4.1); Morten's ears |

Later / out of scope for now: an OPL instrument **editor** (the raw-register patch is
already the model, so it would be UI only), A2M export, RAD/HSC/IMF/DRO playback (cheap
once the chip exists, since they are register streams or simple players), and editing
AdLib channels in the S3M editor.

### Sequencing

O0 → O1 → O2 before any format work. After O2, the S3M track (O3–O5) and the A2M track
(O6–O7) are independent. Do S3M first: the data is already parsed and it proves the chip on
a smaller surface.

---

## 6. Decisions (all accepted as recommended — Morten, 2026-09-27)

- **D0 — which "adlibtracker"?** Recommend Adlib Tracker II (`.a2m`/`.a2t`), the one with a
  live scene and OPL3 content. RAD is a cheap follow-up.
- **D1 — licensing stance.** Recommend permissive-only for code; LGPL/GPL tools as render
  oracles only (§4).
- **D2 — S3M drum instruments.** Recommend melodic only, matching ST3 (§2.3).
- **D3 — A2M in the pattern editor, or playback only?** Recommend playback only first (Rust
  parser); editor support means a TS parser and a row model for 4-op/macros and is its own plan.
- **D4 — OPL2 DAC quantisation.** Recommend skip; revisit only if an A/B shows it matters.
- **D5 — default output rate path.** Recommend always running the chip at its native
  49 716 Hz and resampling, not clocking it at the output rate. This keeps envelope and LFO
  timing exact at 22.05/44.1/48 kHz.

---

## 7. Risks / honest caveats

- **Envelope and LFO timing** are where cheap OPL cores audibly differ (slow attacks,
  tremolo depth). O0/O1 must A/B held notes, not only note-ons.
- **ST3's own AdLib quirks** (F-number rounding from `c2spd`, how volume scales TL) define
  "correct" for S3M, not the chip. The reference is a player (st3play/OpenMPT), so the driver
  tests pin register writes, not only audio.
- **A2M format sprawl**: many versions and packers. Expect refusals for some files. Refuse
  truthfully, never silently.
- **Timing across the TS→worklet boundary**: per-tick write batches must be scheduled ahead
  like notes are now. A late batch is a timing bug, not a chip bug, so log it separately.

---

## Landing records

### O0 — chip spike (2026-09-27)

- `rust-wasm/src/opl/` (`tables.rs`, `operator.rs`, `chip.rs`, `tests.rs`): a port of ymfm's
  OPL3 path (commit 81aec25c, BSD-3; the notice is in `mod.rs`). The scope ended up wider than
  planned, because the port made it cheap: all 18 channels as 2-op, NEW=0 and NEW=1, 8
  waveforms, feedback, both connections, KSL/KSR, LFO AM/PM with depth bits, and C0 L/R output
  bits. **Not yet (O1):** 4-op (`0x104`), rhythm mode (`0xBD` bit 5), resampling to the output
  rate, and a strict YM3812 model.
- Oracle: `golden/opl3-oracle.cpp` is built against ymfm by `golden/regen.sh`, which clones
  the pinned commit (nothing vendored). There are 8 register scripts (sine, ADSR + quiet
  re-prepare, feedback/waveforms/additive/multiples, LFO, 9-voice clamp, NEW=1 stereo +
  waveforms 4..7, bank aliasing, re-key/rate-62 glitch/mid-note changes). **All 8 match
  ymfm on every sample.** A mutation check (feedback shift, modulation shift) fails 5 and 8
  of the scripts respectively, so the gate has teeth.
- Timing that matters for matching, recorded for O2/O3: a register write takes effect on the
  next sample's prepare step. Phase advances before output, so the first sample after
  key-on uses phase = one step. An inactive channel (released below `EG_QUIET`) stops
  updating its feedback until the next re-prepare, which happens after any write or every
  4096 samples.
- Ears: `.ai/opl-ref/o0-starport-phrase.wav` (local only) is a 3 s phrase on the first
  three AdLib instruments of Purple Motion's *starport bbs introtune*, loaded exactly as ST3
  lays out D00..D0A. The render is identical to ymfm's. Made with the ignored test
  `opl::tests::render_script_to_wav`.
- Full Rust suite: green except `ahx_render_golden::manifest_covers_every_fixture`, which
  was already failing and is unrelated.

### O1 — full chip + resampler (2026-09-27)

- **4-op:** a dynamic operator map from `0x104` (ymfm `operator_map`), rebuilt at every
  prepare step. Key-ons route through the map *as of the last prepare*, so enabling 4-op
  and keying on in the same sample keys only the old 2-op pair. The mask is read whatever
  NEW says, as ymfm does. The four connections come from C0 bit 0 of the primary and
  partner channels, and `opout` wraps as int16.
- **Rhythm:** `0xBD` key-ons are a second key source ORed with the normal one (ymfm
  `KEYON_RHYTHM`). BD/HH/SD/TT/TC use the noise LFSR and the op13/op17 phase-select bits,
  outputs are doubled, and the bass drum's feedback runs even when its C0 output bits are
  clear.
- **Gate:** four new scripts (09 all four 4-op connections + a bank-1 pair; 10 mask edge
  cases incl. the same-sample key-on and clearing NEW; 11 OPL2 rhythm: each drum, both BD
  connections, re-triggers; 12 rhythm + 4-op + 2-op under NEW=1 with panning and LFO bits,
  then rhythm off mid-note). **All 12 scripts match ymfm on every sample.** Mutations (a
  wrong 4-op connection, snare without noise, BD keying one operator) each fail the right
  scripts. One mutation found dead code: ymfm's pair sums `opout[5..7]` serve only the OPN
  algorithms, so they were dropped.
- **Resampler** (`resample.rs`): polyphase windowed sinc, Kaiser β 8.6, cutoff at 0.9 × the
  lower Nyquist. Taps scale with the ratio (66 at 48 kHz, 72 at 44.1, 144 at 22.05) so the
  transition band stays proportional to the output rate. Tests: passband within 0.1 dB up
  to 0.8 × the output Nyquist at 48/44.1/22.05 kHz, content above the output Nyquist
  folds back below −70 dB, and the frame count tracks the ratio.
- **Throughput:** 18 sounding channels + resampling to 48 kHz run at 78× real time (native
  release build). Measure the WASM build in O2.
- **Deferred:** the SB16 *Corridors of Time* A/B, planned as part of the O1 gate, needs the
  A2M player, so it moves wholly to O7. A strict YM3812 model (WSE, DAC, modulator delay)
  stays unbuilt until a file needs it.

### O2 — WASM class + worklet (2026-09-27)

- **`OplRenderer`** (`rust-wasm/src/opl/wasm.rs`) is a register-stream device, not a song
  player. `write_at(frame, reg, val)` stamps a write with an output frame of the renderer's
  own clock and queues it by *native* sample index (`ceil(frame × native / out)`). It is
  applied inside the resampler's pull loop, so it lands within one native sample (≈ 20 µs),
  regardless of the render quantum. Past-due writes apply at once and are counted
  (`late_writes`). Also `write` (immediate), `set_gain`, `set_channel_mask`, and `panic`
  (drop the queue, fastest release, key everything off, rhythm off).
- **Worklet:** `src/audio/worklets/opl-core.ts` + `opl-worklet.ts`, registered as
  `opl-audio-processor`, with the same wasm handshake as SID/AHX. Commands:
  `writes` (Float64Array of (AudioContext seconds, reg, val) triples), `set-gain`,
  `set-channel-mask`, `panic`, `dispose`. Events: `late-writes` (at most every 0.5 s, when
  the count changes) and `error`. It maps time to frames with `currentFrame − frames_rendered`,
  refreshed every quantum, and seeded from `currentFrame` at construction so writes sent
  before the first quantum map correctly too. It is added to `WORKLET_BUILD_OPTIONS`.
- **Gate:** 7 Rust renderer tests. The strongest: the same stamped writes rendered in chunks
  of 1, 37, 128 and 1000 frames give bit-identical output. Onsets track their stamps with a
  constant ≈ 34-frame delay at 48 kHz (the resampler's group delay), ±2 frames of
  quantisation. There are 7 core tests over the real wasm (mid-context start, pitch, batches
  out of order, late reporting, panic/dispose, mono, mask/gain) and 4 shell tests on the
  *built* bundle in a vm scope that advances `currentFrame`.
- **WASM throughput:** 18 sounding channels to 48 kHz run at 64× real time, 42 µs per
  128-frame quantum (≈ 1.6 % of the budget).
- The wasm had been stale since the O0 commit (every file under `rust-wasm/src` is hashed,
  golden fixtures included), and this rebuild fixes it. **Remember: any change under
  `rust-wasm/src/opl/golden` also needs `npm run build:wasm`.** Full JS suite green (302
  files, 4909 tests) on a clean run. An earlier run lost 3 tests to an OOM incident on the
  machine; they pass on their own and on the re-run.
- **Not in O2:** per-channel scope taps, and wiring into the app's mixer and song bank (O5).
