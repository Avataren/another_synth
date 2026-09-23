# Verdict — how to add AHX support

Written 2026-09-17. Read `architecture-map.md` and `ahx-requirements.md`
first; this document assumes both and doesn't re-derive their findings.

## P0 corrections (Morten, 2026-09-18)

P0 (`.ai/p0-report.md`) resolved this document's `[VERIFY]` items against the
vendored `hvl_replay.c` and found some of what follows superseded. Recorded
here as dated corrections, not a rewrite of the reasoning above -- the hybrid
verdict itself stands.

- **No filter-mode/slope selection exists.** The "maps almost exactly onto
  `FilterCollection`'s `FilterSlope`" claim in "Why the sound-generation half
  should be a new, dedicated engine" is wrong: there is no mode/slope field
  anywhere in the reference (`hvl_instrument`/`hvl_voice`). AHX/HVL both use
  one fixed-order state-variable filter, but only at init:
  `hvl_GenFilterWaves` precomputes 31 lowpass and 31 highpass versions of
  each waveform, and at runtime the single `FilterPos` parameter only
  selects which precomputed row to read (no runtime IIR), with
  bound-reversal bounce at either limit (`p0-report.md` item 5/6).
  `filter_sweep.rs` implements it this way (landed 2026-09-22), not a
  selectable filter family.
- **Pitch table is 61-entry `period_tab`, 5 octaves (60 notes), clamp at
  60** -- not the 3-octave table this document and `architecture-map.md`
  assumed.
- **Channel topology: AHX itself is fixed-4, but HVL is not.** `.hvl`'s
  channel count is packed into the header (`(buf[8]>>2)+4`) and can exceed 4
  -- all 7 vendored `.hvl` fixtures do. The "AHX-first, fixed-4 voices" engine
  design (`.ai/task.md`'s standing decision 2) keeps the channel count as one
  constant at the engine boundary specifically so this is a later lift, not a
  rewrite; HVL playback has since landed (update 2026-09-22): `format.rs`
  decodes `.hvl` up to 16 channels, and `.hvl` songs play, edit and export
  (`song-export/hvl-exporter.ts`).
- **Tick rate is 50 Hz PAL vblank x `SpeedMultiplier`, not 125 Hz.**
  `hvl_DecodeFrame` hardcodes a 50 base, scaled 1-4x by the header's speed
  multiplier (50/100/150/200 Hz); there is no 125 Hz or CIA-timer path
  anywhere in the reference.
- **"Ping-pong" is the square/filter bounce-sweep reversal, not a table-wrap.**
  `vc_SquarePos`/`vc_FilterPos` walk between two bounds and flip direction on
  hitting either one -- not a waveform-table read-position bounce analogous to
  a PCM loop's ping-pong.

## The question, restated precisely

Two things are being asked at once and they don't have to have the same
answer:

1. **Transport/scheduling**: does AHX reuse `PlaybackEngine`,
   `effect-processor.ts`, `FormatProfile`, `TrackerSink`? (the "extend the
   existing library" question)
2. **Sound generation**: does AHX reuse the existing per-instrument
   `Patch`/`AudioGraph`/worklet machinery, or get a dedicated wasm module
   rendering all 4 channels? (Morten's stated question)

These are separable because `architecture-map.md` §1's five-stage pipeline
has a clean boundary at exactly this point: everything through
`PlaybackSong` → `TrackerSink` is transport, and the sink is where sound
generation starts. It is entirely possible (and, this review concludes, the
right call) to answer "reuse" to question 1 and "new dedicated module" to
question 2.

## Verdict: **(c) hybrid** — reuse the transport, build a new dedicated wasm AHX engine for sound

Not a compromise for lack of a clean answer — the two halves of the pipeline
have opposite cost/benefit profiles for AHX, and treating them the same way
would be wrong in both directions.

### Why the transport half should be reused, not rebuilt

`ahx-requirements.md` §3's asymmetry finding is the load-bearing fact here:
AHX's complexity is concentrated in **the sound source**, not **the effect
vocabulary**. The tick/row scheduler, lookahead buffering, absolute-time
`AudioContext` scheduling, pattern/position/sequence bookkeeping — all of
`engine.ts` outside `scheduleRow`'s per-effect dispatch — is generic tracker
machinery that AHX needs in the same shape MOD/XM/S3M do. Rebuilding it would
be pure waste: re-deriving lookahead/jitter handling
(`TRACKER_WORKLET_SCHEDULING.md`'s documented pain points) that's already
been hardened against three formats' worth of real-world corpus testing.

The `FormatProfile`/`effect-processor.ts` pattern is proven to extend at
low marginal cost for a *fourth sample-based* format (S3M landed with zero
new `EffectType` union members, per `ARCH-REVIEW-s3m.md`). AHX will not be
that cheap — it needs new `EffectType` members for arpeggio-via-PList,
filter-envelope triggers, buzz, squarewave modulation — but "extend a proven,
switch-based dispatch with new cases" is still cheap *relative to* writing a
parallel scheduler, and it keeps AHX inside the same test/corpus discipline
(`PLAN-module-format-support.md`'s D-numbered decision log, the raw-effect-
bytes machinery, the profile-selection pattern) that's caught real bugs in
every format added so far.

Concretely, this means: a new `formats/ahx.ts` parser (D23 discipline: report
the file, interpret nothing), a new `'ahx'` member on `ModuleFormat`, PList
and filter/buzz semantics threaded through as new `EffectType` members and
new `FormatProfile`/`TrackEffectState` fields (the PList stepper is the one
piece that doesn't fit the existing per-tick-effect model cleanly — see
"biggest fidelity risk" below), and `AHX_PROFILE` filled in the same way
`S3M_PROFILE` was.

### Why the sound-generation half should be a new, dedicated engine

`architecture-map.md`'s summary table is blunt about this: `sampler-
instrument.ts`, `sampler-patch-builder.ts` and `instrument-slots.ts` are not
reusable for AHX at any level above "same calling convention" — they are
built around a PCM buffer that AHX instruments don't have. The alternative
— routing AHX instruments through this app's own `Patch`/`AudioGraph`/
worklet system as a new node-graph "patch" (oscillator → tracker-envelope →
tracker-filter-sweep, wired through the existing macro/modulation system) —
was seriously considered as the "refactor path" (option (a) in the brief) and
rejected, for three concrete reasons:

1. **The DSP shape doesn't decompose into that graph's modulation model
   without fighting it.** The existing graph's envelope (`nodes/envelope.rs`)
   and modulation routing are built for continuous, LFO/macro-driven
   synthesis, not a tick-quantized, frame-count table walk that must also
   drive a PList stepper advancing on the *same* tick clock the pattern
   effects run on. Making the generic graph tick-synchronous in that way
   would either bend the graph's abstraction for one instrument type or add
   a second, parallel modulation pathway inside it — both worse than a
   fresh, purpose-built voice.
2. **The instrument-loading model is wrong-shaped.** `Patch` loading
   (`sampler-patch-builder.ts`, `instrument-slots.ts`) assumes N
   independently-authored instruments dropped into slots, decoded from
   asset data. AHX's 4 channels are fixed and its instruments are tiny,
   inline descriptors (a few dozen bytes each) — there's no "asset" to
   decode, and forcing one through the existing slot/asset machinery buys
   nothing.
3. **It's the more expensive path for a smaller win.** The refactor path's
   only real advantage is sharing worklet/pool code (`WorkletPool`,
   `song-bank.ts`'s instrument lifecycle). But `architecture-map.md` §3's
   summary table already shows the dedicated-engine path gets the important
   part of that win for free: `ENGINES_PER_WORKLET`'s existing pattern (one
   `AudioWorkletProcessor` hosting multiple independent wasm-rendered voice
   groups, driven by sample-accurate `AudioParam` automation) is precisely
   Morten's "one wasm module, all voices" idea, already proven in production
   for the existing synth — just currently used for polyphony within one
   instrument rather than 4 fixed tracker channels. Reusing *that pattern*
   (not that code) costs far less than bending the graph to fit AHX and
   loses nothing real.

**So: a new Rust module (either a new crate, or a new `mod ahx` inside the
existing `rust-wasm` crate — see structure proposal) renders all 4 AHX
channels' waveform generation, envelope, filter sweep and PList stepping
per render block, exposed via `#[wasm_bindgen]` the same way `AudioEngine`
is, driven from a thin TS layer that looks structurally like
`StandaloneTrackerSink` (`architecture-map.md` §1: 452 lines, the existing
worked example of "small `TrackerSink` implementation over a dedicated voice
backend") implementing `TrackerSink`.**

### Assessing "one wasm module, all voices" honestly

Given the existing `AudioEngine`/worklet precedent, this is not a novel or
risky architecture for this codebase — it's the same shape already shipping.
Specifics:

- **Latency**: no worse than today's synth. Note-on reaches the wasm voice
  the same way (`AudioParam.setValueAtTime` on a gate/frequency param,
  sample-accurate, no message round-trip) — see `architecture-map.md` §3.
  AHX's own 4-channel-fixed model if anything *simplifies* this versus the
  existing per-instrument dynamic voice allocation, since there's no
  round-robin voice-stealing to reason about — channel N always means
  channel N.
- **Scheduling**: reuses `engine.ts`'s existing lookahead scheduler
  unchanged (transport half, above). The one new wrinkle: PList stepping and
  filter-envelope stepping happen *inside* the wasm voice on its own tick
  clock once triggered, independent of what the pattern schedules next — so
  the JS side needs to hand the voice "how long is one tick, in seconds" (already
  available: `PlaybackEngine`'s `getMsPerTick()`, `engine.ts:1317`) rather
  than needing to schedule every PList step itself. This is a clean split:
  JS schedules note-on/off and pattern effects at row/tick granularity as it
  already does; the wasm voice free-runs its own instrument-internal
  micro-sequencing between those triggers.
- **Worklet integration**: fits the existing `SynthAudioProcessor`
  pattern directly — an AHX song is one more "engine" per the `engines:
  AudioEngine[]` array shape, or (cleaner, since AHX doesn't need the
  general graph's flexibility) a sibling `ahxEngines: AhxEngine[]` array in
  a **new** worklet processor dedicated to AHX playback, avoiding coupling
  the general synth worklet to a wholly different rendering ABI. Given AHX
  is always exactly 4 channels, one AHX song needs exactly one `AhxEngine`
  instance — no pooling/allocation logic needed at all, which is simpler
  than `WorkletPool` addresses for the general synth.
- **Mixing**: identical pattern to the existing `process()` loop — render
  4 channels into a scratch buffer inside wasm (or as 4 wasm calls into
  shared output buffers), mix into the worklet's stereo output, apply master
  gain. AHX has no per-instrument "gain" concept beyond per-channel volume,
  which is simpler than the existing mixer.
- **Live-editing implications**: exactly as tractable as the existing synth's
  (`NOTES-LIVE-EDITING.md`'s blockers are about *where the engine lives*
  across navigation, not about live parameter changes reaching a running
  voice — driving DSP via `AudioParam`s is inherently live-editable, that's
  the whole reason the existing synth does it that way). No new problem here,
  and no regression versus today either — AHX inherits the same
  not-yet-solved persistent-playback-service gap (`PLAN-playback-service.md`)
  everything else in this app has.

## Structure proposal

Prefer a **new module inside the existing `rust-wasm` crate** over a brand
new crate: it shares the build pipeline (`build-wasm.cjs`, `wasm-pack`,
`public/wasm/` artifact placement), shares utility code that's genuinely
useful (`biquad`/filter primitives, buffer pool patterns from `graph/
buffer_pool.rs`), and avoids maintaining a second `Cargo.toml`/toolchain
version pin. Cost: the wasm binary grows for consumers who only want one
synth type — acceptable at this project's scale (one app, one bundle) and
revisit only if bundle size becomes a real complaint.

```
rust-wasm/src/
  ahx/
    mod.rs              # AhxEngine: #[wasm_bindgen] entry point, 4-channel
                         # render loop, mirrors AudioEngine's process_audio
                         # shape but fixed-topology (no generic graph)
    format.rs            # header/instrument/track/PList structs + byte parse
                         # (mirrors patch_loader.rs's role: pure decode)
    waveform.rs           # triangle/sawtooth/square/noise generators at the
                         # 6 wavelength settings; reuses biquad/oscillator
                         # math where it overlaps WavetableOscillator
    envelope.rs           # frame-count volume-table stepper (reuses
                         # EnvelopePhase's phase shape, replaces curve math)
    filter_sweep.rs       # cutoff-envelope stepper driving FilterCollection
                         # (reuse the existing filter DSP, new sequencing)
    plist.rs              # per-voice PList stepper: advances on the tick
                         # clock, drives note-offset/waveform-override/
                         # filter-nudge
    voice.rs              # one AHX channel: waveform + envelope + filter +
                         # plist + squarewave-mod state, ~ voice.rs's role
                         # but fixed-topology instead of graph-based
```

```
packages/tracker-playback/src/
  formats/ahx.ts          # parseAhx(bytes) -> AhxSong, looksLikeAhx(bytes)
  import/ahx-patterns.ts  # buildAhxTrackerPatterns -- rows + raw effect
                           # bytes onto TrackerEntryData, D23/D94 discipline
  # no import/ahx-samples.ts equivalent -- AHX instruments are not
  # TrackerSamples; see "what does NOT get built" below
```

```
src/audio/tracker/
  ahx-import.ts           # assembly: parseAhx -> buildAhxTrackerPatterns ->
                           # TrackerSongFile, mirrors {mod,xm,s3m}-import.ts's
                           # 116-151-line assembly-only shape
  ahx-sink.ts              # AhxTrackerSink implements TrackerSink, backed by
                           # the new wasm AhxEngine -- StandaloneTrackerSink's
                           # shape and size, not TrackerSongBank's
```

**What does NOT get built, deliberately:** an AHX equivalent of
`sampler-patch-builder.ts`/`instrument-slots.ts`/`TrackerSample`. AHX
instruments never become this app's `Patch` type and never occupy the
sampler instrument-slot table — they stay inside `AhxSong`/the wasm engine's
own instrument table, addressed by the AHX file's own instrument numbering.
This is a deliberate boundary, the same shape as the tracker-playback
library's existing rule (`CLAUDE.md`: "Do not widen the library to emit a
`Patch`... a consumer wanting a module player should never see one") — AHX
instruments are even less `Patch`-shaped than a MOD sample was, so the same
discipline applies with more force. If the editor ever wants to *edit* an
AHX instrument's waveform/envelope/filter, that's a new, AHX-specific editor
UI reading/writing the wasm engine's instrument table directly — not a
detour through the existing patch editor.

## Effort estimate

Rough, commit-sized units, assuming the `[VERIFY]` items in
`ahx-requirements.md` §4 get resolved first (that resolution itself is
~1-2 days of focused reading against `hvl_replay.c`, not estimated as
commits here):

| Phase | Content | Estimate |
|---|---|---|
| P0 | Resolve `[VERIFY]` items against `hvl_replay.c`; write a plain-Rust (non-wasm) reference decoder + a handful of golden-value tests against known AHX files, no audio yet | 2-3 days |
| P1 | `formats/ahx.ts` parser + `import/ahx-patterns.ts`, proven against the P0 golden values from the JS side (rows/effects only, no sound) | 2-3 commits |
| P2 | `AHX_PROFILE` + new `EffectType` members for arpeggio/filter-trigger/buzz effects that don't map onto existing union members; `effect-processor.ts` switch arms | 2-3 commits |
| P3 | Rust `ahx::` module: waveform generators, envelope stepper, filter-sweep stepper, PList stepper, single-voice render, wired to `#[wasm_bindgen]` | 1-2 weeks (this is the bulk of the work — it's a from-scratch DSP voice, not a data-table fill-in) |
| P4 | New dedicated worklet processor (or an `ahxEngines` array variant of the existing one) + `AhxTrackerSink`, wired to `PlaybackEngine` via the existing `Scheduled*Handler` plumbing | 3-5 commits |
| P5 | Corpus testing against real AHX/HVL files for fidelity (ear + measurement against a reference player's rendered output, mirroring how MOD/XM/S3M fidelity was verified in this repo) | ongoing, size depends on how strict "faithful" needs to be |

P3 is the long pole and the place effort estimates are least reliable, because
it's genuinely new DSP work rather than following an established pattern the
way P1/P2/P4 do.

## Biggest fidelity risks, ranked

1. **PList timing and interaction with pattern-level effects.** This is the
   part of the format with no analogue anywhere in this codebase (§2 of
   `ahx-requirements.md`), the highest implementation complexity, and the
   easiest to get subtly wrong in a way that's audible but hard to pin down
   (a real AHX song leaning on PList-driven synth drums will sound "off" in
   a way that doesn't look like a bug until compared directly against a
   reference player). Mitigate by building the P0 golden-value tests against
   *specific known PList-heavy instruments*, not just format-level byte
   parsing.
2. **Waveform-generation exactness, especially the white-noise PRNG and the
   ping-pong table-walk** (`ahx-requirements.md` §2, both flagged
   `[VERIFY]`). Getting the noise sequence or the ping-pong trigger
   condition wrong produces plausible-sounding but not bit-faithful audio —
   the kind of error this repo's own history shows is easy to ship
   unnoticed (see `blue-stars-instr03-loop-pop` in project memory: a
   loop-seam discontinuity that took real diagnosis to distinguish from a
   regression). Budget explicit A/B listening against a reference player,
   not just "it plays something."
3. **Filter envelope exactness** — the up/down bound, speed, and how a
   pattern effect retriggers/reverses the sweep mid-flight. Lower risk than
   #1/#2 because `FilterCollection`'s DSP is already solid and the sequencing
   logic is simpler (closer to the existing volume-envelope shape) — but
   still a place where "sounds like a filter sweep" and "sounds like *this*
   filter sweep" diverge audibly.
4. **Format-timing base rate** (the 125 Hz question, `ahx-requirements.md`
   §2/§4). Get this wrong and every AHX song plays at a globally wrong
   tempo — high-visibility if wrong, but also the easiest of these four to
   catch immediately (any AHX file with a known correct playback time makes
   this trivially checkable), so ranked last despite being simple to verify,
   precisely because it's simple to verify.

## One-sentence verdict

Reuse the transport (`PlaybackEngine`, `FormatProfile`/`effect-processor.ts`
pattern, `TrackerSink` contract) because AHX's effect vocabulary is a normal,
if new, extension of a proven mechanism; build a new dedicated Rust/wasm
voice engine for sound generation because AHX's instrument model (waveform
synthesis, frame-table envelopes, filter sweeps, PList micro-sequencing) has
essentially nothing in common with the PCM-sampler DSP this app already has —
and Morten's "one wasm module, all 4 voices" instinct is not just viable but
is already the exact pattern this codebase's existing synth worklet uses for
multi-voice rendering, just not yet pointed at a fixed-4-channel synthesis
engine instead of a general modular graph.
