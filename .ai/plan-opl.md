# Plan: OPL tracking (one OPL2/OPL3 chip in Rust + S3M AdLib playback + Adlib Tracker II)

Status: **IN PROGRESS. D0–D5 accepted as recommended, D6 decided (Morten, 2026-09-27). Corpus
fetched (§4.1). O0–O3, O3b, O5 and O6 landed 2026-09-27 (landing records at the end).**
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
  Format versions and packers: pinned in O6 (landing record), against the authors'
  `techinfo.htm` and every corpus file.
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
| AdPlug (`adplay` to WAV) | render oracle for A2M and AdLib-only S3M; in O6 also a black-box **unpacking and field oracle** (`rust-wasm/src/opl/a2/oracle/`) | LGPL — run, do not copy. `unlzh.c` was read under D6; only its five constants and the meaning of the flag byte were used |
| OpenMPT | render oracle for mixed PCM+AdLib S3M | BSD-3 |
| Adlib Tracker II source | A2M semantics | **GPL 3+ (MEASURED, 2026-09-27: `COPYING` in ivan-tat/at2, ijsf/at2) — out; not read** |
| AT2 `techinfo.htm` (adlibtracker.net/files, the authors' own format document) | A2M/A2T layout per version, effect table | documentation, no license text; read (a description, not code) |
| apultra `src/expand.c` (Emmanuel Marty) | aPLib decompressor (A2M v9–11) | zlib (MEASURED, `LICENSE.zlib.md`) |
| sixpack-kotlin (Benedikt Wüller) | SixPack decompressor (A2M v1, v5) | MIT (MEASURED); a port of Gage's 1991 DDJ SIXPACK.C, which itself states no license |

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
- **D6 — the AT2 LZH packer (v12–14), which has no permissive description.** Morten chose
  (c) relax D1, isolating the GPL/LGPL code in its own wasm module. **Outcome: no isolation
  was needed.** AdPlug's `unlzh.c` states that it is Okumura's public-domain ar002 with five
  constants changed. The file was read in full (allowed by D6), but only those numbers and the
  meaning of its flag byte were used. The decoder is a port of a Python ar002 reader that had
  been written from scratch before the file was opened. Everything in `opl/a2/` is MIT-side
  code. If Morten prefers, the LZH module can still move to a separate wasm with no API change.
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

### O3 — S3M AdLib driver, against ST3's own register writes (2026-09-27)

- **Reference:** st3play (8bitbubsy's C port of ST3.21, BSD-3). `digadl.c` is ST3's AdLib code.
  `src/tests/fixtures/opl/st3-traces/` holds an oracle (`st3-adlib-trace.c`: st3play's
  replayer with the OPL2 emulator replaced by a logger, built by `regen.sh` from a pinned
  commit) and its traces for the ten tier-1 songs: every `outaw`, stamped with its tick.
- **Design change from §2.1:** the driver is **sink-side**, not an optional
  `TrackerSink.oplWrite`. `S3mOplDriver` (`packages/tracker-playback/src/opl-driver.ts`)
  consumes a sink's note-on/off, pitch and volume events for tracks playing an AdLib
  instrument and emits `(time, reg, val)` to an `OplRegisterTarget`. The engine is not
  OPL-aware, and a host (song bank, standalone sink) routes by instrument (`handles`).
- **ST3 rules transcribed:**
  - pitch: `hz = 14317056 / scalec2spd(period)` → `updateadlib`'s block/F-number;
  - key: key-off + key-on on a new note, the key-on stamped **one chip sample later**, or the
    chip would see no edge and the retrigger would be lost;
  - volume: TL `63 − ((63 − TL)·(vol+1)) >> 6`, modulator too when additive, KSL kept;
  - timbre: reloaded only when the instrument changes;
  - registers: an `outaw`-style cache drops redundant writes;
  - channel state: kept per AdLib channel *setting*, as ST3's `_zchn` is.
- **Engine changes (generic, not OPL-specific):**
  - `PlaybackOptions.steppedTickAutomation(instrumentId, track)`: when true, the row scheduler
    skips its "one ramp per row" shortcut and emits slides tick by tick, as ST3 writes the
    chip.
  - Pitch commands carry an optional `source: 'table' | 'target'` (arpeggio steps; tone
    portamento arriving), passed as the optional 7th `ScheduledPitchHandler` argument. The
    driver scales these afresh (`scalec2spd`) and adds slides and vibrato to the scaled
    period, as ST3 does. Without this, an instrument with c2spd 33200 (koakuma) turned an
    arpeggio into a negative period, i.e. a key-off.
- **Importer:** AdLib instruments now get slots in `slotForInstrument`, AdLib cells are kept
  (with the AdLib header volume as the default), and `s3mAdlibChannelForTrack` gives each
  track's OPL channel. The app warning now says the notes are imported but silent until O5.
  The `sun.s3m` event-stream golden was regenerated: 0 → 1224 events (the cells used to be
  dropped).
- **Gate** (`src/tests/s3m-adlib-st3-trace.test.ts`): real importer + engine + driver,
  compared tick by tick (aligned per row) with ST3's writes. Inaudible, documented
  differences are classified rather than failed: tick 0's idle key-on at F-number 0,
  writes on a channel still holding the empty timbre (AR 0), and pitch within 2 F-number
  steps. **starport2, mystic and a-vision match ST3 on every one of 2000–3000 ticks.** The
  other seven are pinned as regression baselines; each residue is the *engine's* S3M state
  disagreeing with ST3's (below), not the driver. There are 14 driver unit tests with
  hand-worked values (C-4 = hz 4181 → B0/A0 `2A`/`AC`).
- **Pitch:** a note on an AdLib channel sounds an octave below the "musical Hz" our engine
  uses for PCM (f_OPL ≈ hz / 32.2; C-4 ≈ 130 Hz). This is ST3's own arithmetic, confirmed by
  the exact traces.
- **Loudness:** renders of the ten songs (listening aid: `OPL_WAV_DIR=… npm run test:run --
  src/tests/s3m-adlib-st3-trace.test.ts`; copies in `.ai/opl-ref/o3/`) sit at −8 to −21 dBFS
  RMS and clip the chip's own 16-bit output on ≤ 0.26 % of samples, as a real YMF262 would.
  O5 decides mixer headroom.
- **Known driver-level differences:** SCx and tremolo reach AdLib channels (ST3 ignores
  both there: TL is re-sent only on instrument / volume column / D·K·L), and ST3.03–3.20's
  broken AdLib tone portamento is not modelled.
- **Not done:** `npm run check:tracker-playback-dist` fails on clean HEAD too (exit 127, the
  build tool is missing in this environment); nothing in CI builds `dist`.

### Proposed O3b — S3M engine fidelity (found by the ST3 traces; affects PCM too)

Each is a deviation of the playback engine's S3M channel state from ST3's. The trace gate
measures it, and lowering a song's pinned baseline in the test proves a fix.
1. **SEx / EEx pattern delay re-triggers the row's notes** on every repeat
   (`engine.ts` re-runs `scheduleRow`). PT, FT2 and ST3 hold the notes. Affects every
   format. (church: 430 ticks.)
2. **`J00` does not continue the last arpeggio** (ST3's `GET_LAST_NFO` memory).
   (rotagilla, koakuma.)
3. **S3M vibrato timing and values** differ from `s_vibrato` by 1–2 ticks. (starport,
   rance-bird, first-adlib-attempt.)
4. **A volume on a key-off (`^^`) row is dropped**, so ST3's TL cut on the release is lost.
   (first-adlib-attempt.)
5. **Note delay (SDx) applies the row's volume on tick 0.** ST3 defers the whole cell.
   (koakuma.)
6. **Two file channels on one channel setting** are two engine tracks, where ST3 merges them
   into one channel state (`getnote1`). (redemptions, rance-bird.)
7. **c2spd for PCM samples:** the sampler folds c2spd into its root note, so slides move the
   unscaled period (ST3 slides the scaled one). The OPL driver now corrects this for itself
   via `source`; PCM does not.

### O3b — S3M engine fidelity (2026-09-27)

Reference: st3play 216b1651 (`digread.c`, `digcmd.c`, `digadl.c`, `digamg.c`); pt2-clone and
ft2-clone for pattern delay. Unexplained-tick baselines in `s3m-adlib-st3-trace.test.ts`,
before → after each step (all ten songs now exact except koakuma and first-adlib-attempt):

| Song | Start | Steps | Now |
|---|---|---|---|
| church | 430 | item 1 → 0 | **0** |
| rotagilla | 350 | item 2 → 22, item 5 → 1, item 4 → 0 | **0** |
| starport | 38 | item 3 → 0 | **0** |
| redemptions | 38 | item 6 → 5, driver TL batching → 0 | **0** |
| rance-bird | 1249 | item 2 → 1184, item 3 → 119, driver retrigger batching → 0 | **0** |
| first-adlib-attempt | 56 | item 4 → 52, item 3 → 40, item 3 (hold/bake) → 1 | 1 |
| koakuma | 407 | item 5 (+ arpeggio snap-back) → 361 | 361 |
| starport2, mystic, a-vision | 0 | — | 0 |

1. **Pattern delay** (`4397b20d`): a repeat holds the notes and runs only effects — ST3
   re-runs tick 0 (`docmd1`), PT/FT2 run tick-N handlers on it
   (`FormatProfile.patternDelayRepeatsTickZero`). Also fixed D71: EEx plays the row x + 1
   times, and a break on the delayed row waits for the repeats. The trace reader folds
   dorow's one-tick `np_row--` flick back into the repeat. No golden changed.
2. **Shared parameter memory** (`08aae3c8`): ST3's `alastnfo` is one byte per channel for
   every command; D E F I J K L Q R S reuse it via `GET_LAST_NFO`. S3M steps carry
   `rawEffect`; the scheduler re-decodes zero-parameter cells
   (`sharedEffectInfoCommands`). J00 used to be dropped outright. 6 goldens regenerated.
3. **Vibrato** (`03fede15`, `69311632`): ST3's tables, arithmetic-shift depth, H/U nibble
   memory (`Hx0` = depth 0), restart rules (bit 7 on non-H/U/K/R/D commands; PCM note
   resets, AdLib note does not → new `PlaybackOptions.oplInstrument`), and the offset is
   held on non-empty/non-D cells and folded into the note by E/F (`st3Vibrato`).
   14 goldens regenerated (vibrato in the 30 s window; E/F right after vibrato).
4. **Key-off row** (`0722d2a6`): a `^^` cell still runs its volume and effect
   (`noteOffRowRunsCell`, S3M only; FT2 does too but its key-off volume rules differ, so
   XM is untouched). 2 goldens (funtro S8x pans, bubblez D slides).
5. **Note delay** (`2ea0ba44`): SDx defers the whole cell, volume included
   (`noteDelayDefersCell`). Also: an arpeggio snaps back on a row the pattern leaves empty
   for that channel (docmd1's `aspd = aorgspd`). 6 goldens (SDx cells with a volume).
6. **Shared channel setting** (`7e647118`) — **done, worth it**: 5 of the 42 AdLib files
   (redemptions + four "(opl2)" rips) put two file channels on one setting, and
   redemptions uses the second as an effect column that otherwise did nothing. The PCM demos
   that share settings have nothing in the extra channels. Import-time field merge
   (`getnote1` order), ST3-saved files only; the one per-cell case a merge gets wrong (note
   in an earlier cell, SDx in a later one) stays split. No golden changed.
7. **PCM c2spd — evaluated, left out.** Confirmed from the code: ST3 slides, vibrato and
   portamento move the c2spd-*scaled* period (`scalec2spd`: `spd * 8363 / c2spd`), while
   the engine moves the unscaled one and the sampler folds c2spd into the root note. In
   the unscaled domain ST3's step is `d · r` (r = c2spd / 8363), so every slide, vibrato
   depth and porta speed on such a sample is off by r. Scale: 23 of the 40 S3M demos use
   pitch effects on samples > 2 % off 8363, r from 0.44 to 5.36 (kraaap 5.36, distant_lullaby
   3.99, 2nd_reality 3.31). It is audible and widespread, but a correct fix needs (a) the
   engine to know each instrument's c2spd (Song-level data, store plumbing) and work in the
   scaled domain incl. porta targets and ST3's clamp on the scaled period, and (b) a gate:
   there is no PCM oracle yet. Proposed as its own batch: extend `st3-adlib-trace.c` to log
   each PCM channel's `aspd` per tick and compare pitch *ratios* to the note's start —
   `(P/r + D)/(P/r)` = `(P + D·r)/P`, so the gate needs no c2spd — then move S3M pitch state
   into the scaled domain.

Driver fixes found on the way (`44574705`, `2a1d835d`): the retrigger and the TL write now
wait for their tick to settle (next event on the channel at a later time, a microtask, or
`S3mOplDriver.flush()`), as `updateadlib` writes once per tick. The retrigger one was
audible: a fine slide on a note's row keyed on with stale block bits.

Still open: koakuma's 361 are ST3.03–3.20 / OpenMPT's broken AdLib tone portamento
(`digadl.c` `brokenPortamentos`: a G note sets `aorgspd` to the target at once, so nothing
slides until the next empty/D row); first-adlib-attempt's 1 is a porta landing one F-number
short. Not modelled: `st2Vibrato` (parsed, not plumbed; `>> 4`), R sharing `avibcnt` with
vibrato, vibrato waveform 3's randomness, PCM `^^` zeroing `avol`.

### O5 — app wiring (2026-09-27)

- **`OplOutput`** (`src/audio/tracker/opl-output.ts`) holds the OPL worklet node (built only
  once a song with AdLib instruments loads; `prepareInstrument` awaits it), an
  `S3mOplDriver` and the batching. The driver's writes collect and go as one `writes`
  message per task, after `driver.flush()`, so a scheduler wake-up is one message.
- **Routing:** `TrackerSongBank` sends note on/off, retrigger, pitch (with the new optional
  `source` argument on `TrackerSink.setVoicePitchAtTime`) and volume for an instrument
  `isOplInstrument` accepts to the chip, mirroring `playThroughDriver`. The playback store
  passes `steppedTickAutomation` and `oplInstrument`. `cancelAllScheduled`/`allNotesOff`
  (stop, pause, every start, and a play from another row) **restart** the chip: `panic`, then
  `driver.reset`. Dropping the chip's queue leaves the driver's register cache stale, so
  keying off alone is not enough. A song-loop cut (`cutAllVoicesAtTime`) is
  `driver.allNotesOff`. A seek while playing only moves the engine's position, so it gets
  nothing extra.
- **Channel map:** `s3mAdlibChannelForTrack` is kept on the song as `oplChannels` (S3M only,
  saved and loaded, null for PCM/drum tracks) and reaches the bank from
  `syncSongBankFromSlots` together with the AdLib timbres and `amigaLimits`.
- **Mute/solo:** through `set-channel-mask`. A channel is silenced only when every track on it
  is inaudible. OPL note events are no longer dropped for muted tracks, so ST3's channel
  state keeps running and an unmute mid-note is right. Checked in the browser: rotagilla's
  tracks 2–7 and 12–14 clear mask bits 0–5 and 6–8, and its PCM tracks leave the mask alone.
- **Level (revised after Morten's listen: "OPL seems a bit quiet"):** the chip's gain is
  per file, **OpenMPT's balance**, found by reading its code (Compatible mix levels; its
  comment says "approximately as loud as in DOSBox and a real SoundBlaster 16"). There, a
  centred full-volume PCM channel reaches `preamp/128` of full scale, where `preamp` is the
  S3M header master volume (`s3mSamplePreamp`, Load_s3m.cpp's rules). The chip reaches
  `32768·6169·(36/48)/2²⁷` ≈ 1.13. Here the same PCM channel reaches cos(π/4) and the preamp
  is not applied, so `s3mOplMixGain` = `cos(π/4)·1.13·128/preamp`. That is 2.13 at ST3's
  default of 48, 0.80 for rotagilla and rocking-horse (127), 1.60 for ultrasound (64) and 3.19
  for starport (32). It is stored as the song's `oplGain`. The first cut was a flat 0.5,
  12.6 dB too quiet at preamp 48. It **bypasses the song's global volume**, because
  st3play's `updateadlib` scales TL by `avol` only, but follows the user's master volume.
  Measured afterwards, as dBFS RMS of the final output: AdLib-only songs −8 (starport) and
  −11 (mystic), with the limiter holding peaks at 0.84; a PCM S3M (satellite_one) −13.9;
  rotagilla PCM −25.1 / OPL −28.4; ultrasound PCM −23.6 / OPL −21.8. The deeper mismatch is
  that the app ignores the S3M preamp for PCM, which makes low-master-volume files loud
  everywhere. Not changed here: it would move every S3M's level.
- **`StandaloneTrackerSink`** takes an optional `opl: { target, channelForTrack?,
  amigaLimits?, panic? }`; `handlesOpl(id)` is for the two engine options.
- **UI:** OPL slots count as filled song instruments (`isOplSlot`, `listsSongInstrument`),
  their volume knob is disabled (slot volume is not applied to the chip), the bank name is
  "S3M Import (OPL)", and the import notice says the notes play.
- **Gate:** all three `Manwe/` songs play PCM and AdLib together in the app (headless
  Chromium over the dev server: the OPL node renders, sampler voices start, no console
  errors). `npm run test:run` green: 4965 tests; three worklet tests timed out under memory
  pressure while Chromium ran and pass on a re-run. New: `opl-output.test.ts`,
  `tracker-song-bank-opl-routing.test.ts`, standalone-sink OPL cases, and an `oplChannels`
  save/load round trip.
- **Not done:** keyboard preview of an OPL instrument (immediate `noteOn` has no track, so
  it stays silent), per-channel OPL scope taps, the slot volume knob on OPL slots, and an OPL
  instrument editor.
- **Gotcha for driving the app:** Space is *Play Pattern*. Use the "Play Song" button.


### O6 pre-flight — licensing and packers (2026-09-27; STOPPED for Morten, nothing built)

The prompt said: if no permissive description of the format or its packers exists, stop and
report. That is the case for one of the three packers the corpus needs.

- **AT2 source is GPL 3+** (MEASURED). Not read. AdPlug (LGPL) not read either.
- **Format description exists and is permissive enough to read:** the AT2 authors'
  `techinfo.htm` (kept locally at `.ai/a2m-ref/`, text in `techinfo.txt`). It gives the header
  (`_A2module_`, CRC32 @0x0a, version @0x0e, #pat @0x0f), the block-length table (5 × u16 for
  v1–4, 9 × u16 for v5–8, 17 × u32 for v9+), songdata layout per version (names, 13/14-byte
  instruments, v9+ FM macro tables 255×3831, arp/vib macros 255×521, order 128, tempo/speed,
  flags, pattern length, track count, macro speed-up, 4-op flags, lock flags; v11+ pattern
  names, disabled-FM-column table; v12+ 4-op pair flags; v14 rows-per-beat + tempo finetune),
  and pattern layout (v1–4: 16 pats/block, 64 rows × 9 ch × 4 B, row-major; v5–8: 8/block,
  18 ch × 64 rows × 4 B, channel-major; v9+: 8/block, 20 ch × 256 rows × 6 B, two effects).
- **Packers per version — doc vs. files:**
  | Version | Doc says | Files show (MEASURED) | Corpus files | Permissive reference |
  |---|---|---|---|---|
  | 1, 5 | SixPack | header lengths sum to file size (v1: only `ceil(#pat/16)` lengths are real; the rest are junk) | 11 + 27 | sixpack-kotlin (MIT) — packer match UNVERIFIED |
  | 9, 10, 11 | aPLib | first byte = literal Pascal length of the song name, as aPLib's raw first literal | 38 + 1 + 146 | apultra `expand.c` (zlib) |
  | 12 | aPLib | **not aPLib:** `00`, u32 LE unpacked size (`0x115e9f` songdata, `0x3c000` per pattern block), stream — same container as 13/14 | 8 | none |
  | 13 | "own implementation of LZH" (`adt2pack.pas`) | as v12 | 17 | none |
  | 14 | (not stated) | as v12, songdata `0x115ea2` | 30 | none |
  | 2/6 LZW, 3/7 LZSS, 4/8 raw | — | none in corpus | 0 | not needed |
- **The AT2 LZH is not a stock public-domain LZH** (MEASURED against a from-scratch ar002/lh5
  table reader over every NT/TBIT/CBIT/NP/PBIT combination, both bit orders, bit offsets 0–80
  of the stream: no valid parse). The next big-endian u16 looks like an lh5-style block symbol
  count (961 for a 245 760-byte near-empty pattern block ≈ 245760/256), so it is probably a
  relative of lh5 with a different table encoding (INFERRED).
- **Decision (D6, Morten):** (c), with the GPL/LGPL part isolated. See §6 D6 and the O6 record
  for how it turned out. The table above is superseded by the O6 record where they differ.

### O6 — A2M parse (2026-09-27)

- **Where:** `rust-wasm/src/opl/a2/`: `sixpack.rs`, `aplib.rs`, `lzh.rs` (decompressors),
  `model.rs` (`parse`, `unpack`, `A2mSong`), `tests.rs`, and `oracle/` (the black-box
  harnesses, `regen.sh`, and their outputs `blocks.tsv` and `song-info.tsv`). Not yet exported to
  wasm, so the wasm binary only changed in its hash inputs.
- **Result:** all **278/278** corpus files parse. There are no refusals, because every version in
  the corpus (1, 5, 9–14) is supported. Refused truthfully in synthetic tests: A2T, versions 2/6
  (LZW) and 3/7 (LZSS), which no file uses, versions > 14, zero or excess pattern counts, a
  needed block with length 0, a block past EOF, trailing bytes, a packed stream that ends early,
  or bytes left over in a block, a wrong unpacked size, and an overlong Pascal string. Versions
  4 and 8 (stored) are accepted, but no file tests them.
- **Packers, MEASURED** (each is byte-exact to AdPlug's depacker on every block, 999 blocks):
  | Versions | Packer | How it differs from the textbook version |
  |---|---|---|
  | 1, 5 | Gage's SIXPACK | MAXCOPY 255 (Gage: 64); bits MSB-first from 16-bit LE words. Both from AdPlug's installed `sixdepack.h` enum and signature, then measured |
  | 9–11 | aPLib | **The high-offset subtractor is always 3.** Current aPLib uses 2 right after a match. Found by diffing against the oracle: the file decodes correctly up to the first match that follows a match |
  | 12–14 | ar002 (lh5 family) | DICBIT 14, THRESHOLD 2, CBIT 16, PBIT 14, TBIT 15. Container: flag byte (bit 0 "ultra", never set; refused), u32 LE unpacked size, stream. The stream's last code ends in the block's last byte |
- **Where `techinfo.htm` is wrong (MEASURED):** v12 is the LZH container, not aPLib. v9
  songdata uses v10's 42-character instrument names and offsets, and ends at `0x1128a5`, not
  `0x111eaf`. Also MEASURED, where the document is silent: v1 headers carry leftover lengths
  beyond the blocks the pattern count needs, which are ignored. Every pattern block unpacks to a
  full set of 8 (or 16) patterns. Block lengths sum exactly to the file size in every file.
- **Header check value (0x0a):** UNVERIFIED. It is not CRC-32 (standard, or without init or
  final xor) of the packed blocks, the unpacked blocks, or the file after the header. So a
  corrupt stream that stays well-formed parses (the mutation test shows 7 of 24 flips do,
  caught only by the oracle hash). In the app that means a damaged file plays wrong instead of
  being refused. Worth another try if a file ever needs it.
- **Model** (`A2mSong`): names as raw bytes (`cp437()` for display); 250/255 instruments (11
  FM bytes, panning, finetune, voice type); v9+ FM macros (255 × 255 steps), arpeggio and
  vibrato macros; order as 128 raw bytes, since jump/end markers are the player's call;
  tempo, speed, flags, pattern length, tracks, macro speed-up; v10 4-op track flags and lock
  flags; v11 pattern names and disabled-FM-column table; v12 4-op instrument pairs; v14
  rows-per-beat and tempo finetune. Patterns are normalised to row-major cells (note,
  instrument, two effects). Effect numbers are stored as the file has them: v1–4 use 0–15 and
  v5–8 use 0–35, which O7 has to map.
- **Gate (`cargo test --lib opl::a2`, 6 tests, ≈ 7 s debug):**
  1. every file parses (or would have to be listed with its one-line reason);
  2. every unpacked block equals AdPlug's (size + FNV-1a-64, `blocks.tsv`);
  3. title and author equal AdPlug's player API for all 278 files. Instrument names match
     too, except 52 names in two exactly-shaped AdPlug display artifacts. A name whose length
     byte is 32 comes back as 41 characters (32 plus stale slot bytes), and a name with
     embedded NULs comes back cut at the NUL. AdPlug's instrument count is 250 before v9 and
     the last instrument with FM data after, both confirmed;
  4. tier-1 spot checks (every version plus *Corridors of Time*: name, composer, first 12
     orders, tempo, speed, pattern length, tracks, and the first non-empty cell of the first
     and last pattern). They are compared with a Python reading of AdPlug-unpacked blocks at
     the doc's offsets, which is not this parser;
  5. one flipped bit per packer at 8 bit positions: all 24 are caught (17 refusals, 7 by the
     oracle hash);
  6. refusal messages for the synthetic cases.
- **Declared features** (header and instrument data, not pattern use): 4-op in 22 files,
  percussion flag in 17, percussion instruments in 25, panning in 99. Per-version table in the
  fixtures README.
- **Oracle build:** AdPlug + libbinio from GitHub, static, under `.ai/adplug-oracle/prefix`
  (gitignored); `ADPLUG_PREFIX=… rust-wasm/src/opl/a2/oracle/regen.sh` rebuilds both TSVs.
  O7 will reuse the same build as its render oracle.
- **Not in O6:** the player (O7), wasm exports, A2T, and LZW/LZSS (versions 2/3/6/7).
