# Multi-Format Module Support (MOD / XM / S3M)

**Status:** Phase 3 in progress — XM parser done; next is the `ModuleSong` IR.
Phase 1 still has one open item — per-channel voice allocation (B2) — deferred as
speculative until a high-channel module needs it; see D13 for why it also matters.
**Last updated:** 2026-08-28
**Owner doc for:** extending the tracker from ProTracker-only `.mod` playback to a
mode-driven player that also handles FastTracker 2 `.xm` and (later) Scream Tracker `.s3m`.

> **Keep this document current.** It is the handoff surface between sessions. When a
> phase task lands, tick its checkbox in the same commit as the code, and add a line to
> the Change Log. When a design decision is made or reversed, record it in the Decision
> Log with the reasoning — the *why* is the part that is expensive to reconstruct.

---

## 1. Goal

Play `.xm` files as faithfully as `.mod` files play today, without regressing MOD
playback. The two formats disagree on enough behaviour (pitch model, effect memory,
tick-0 semantics, default panning) that a single blended code path would degrade both.
So: **one player, explicit per-song format modes.**

S3M (and eventually IT) should fall out cheaply once the mode machinery exists. If
adding S3M turns out to be expensive after Phases 1–3 are done, the architecture is
wrong and should be revisited before pressing on.

---

## 2. Current state (verified 2026-08-28)

### 2.1 The pipeline

```
.mod bytes
  → mod-parser.ts        parse to ModSong (raw periods, cells, samples)
  → mod-import.ts        flatten to TrackerSongFile (text-encoded entries + sampler patches)
  → tracker-store.ts     song state (patterns, tracks, instrument slots)
  → useTrackerSongBuilder.ts   TrackerEntryData → playback Step
  → engine.ts            row/tick scheduling
  → effect-processor.ts  per-tick effect state machine
  → song-bank.ts         instrument instantiation + audio-time scheduling
```

### 2.2 Format assumptions currently baked in

| Layer | File | Assumption |
|---|---|---|
| Parser | `packages/tracker-playback/src/mod-parser.ts` | ~~4 channels only~~ (resolved: up to 32 via `channelsForSignature`), 64 rows fixed, 15/31-sample layouts |
| Import | `src/audio/tracker/mod-import.ts` | ~~`MAX_TRACKS = 4`~~ (resolved), `PATTERN_ROWS = 64`, one sample → one slot patch |
| Song state | `src/stores/tracker-store.ts` | ~~`patternRows` is song-level~~ (resolved: `TrackerPattern.rows`) |
| Engine | `packages/tracker-playback/src/engine.ts` | ~~`setLength` flattens all pattern lengths~~ (resolved: `setPatternLength`) |
| Effects | `packages/tracker-playback/src/effect-processor.ts` | Amiga periods throughout: `PT_PERIOD_TABLE` (`:30`), clamp 113–856 (`:11-12`), Paula/128 scaling (`:9`) |
| Entries | `src/components/tracker/tracker-types.ts` | `volume` is a plain 00–FF gain string; effects are 3-char text macros |
| Dispatch | `src/audio/tracker/song-bank.ts:1634-1670` | `instrumentType === 'mod'` + **global** `useSimplifiedModInstruments` setting |

### 2.3 What already works in our favour

- The tracker store supports **dynamic track counts** (`addTrack` / `removeTrack`,
  `tracker-store.ts:289-320`) — the UI is not hardwired to 4 channels.
- The WASM sampler already implements **ping-pong looping**
  (`rust-wasm/src/nodes/sampler.rs:251`, `SamplerLoopMode::PingPong`), which XM needs.
- `EffectType` in `packages/tracker-playback/src/types.ts:26-55` is already written in
  **FT2 vocabulary** — G/H/K/P/R/T/U are declared, even where unimplemented.
- A real MOD regression suite exists: `src/tests/mod-*.test.ts`,
  `src/tests/tracker-playback-engine.test.ts`, `packages/tracker-playback/src/__tests__/`.
  This is the safety net for the Phase 2 refactor. **Run it after every step.**

---

## 3. Blockers, in dependency order

### B1 — Per-pattern row counts (hard prerequisite)
`patternRows` is one number for the whole song. XM patterns are 1–256 rows and vary
per pattern. Nothing else in this plan works until pattern length moves onto the
pattern. Touches: `tracker-store.ts`, `engine.ts` (`setLength`, row scheduling),
`useTrackerSongBuilder.ts`, the pattern UI, and the song-file schema (needs a version bump).

### B2 — Channel count and voice allocation
Parser throws above 4 channels; importer clamps to 4. XM allows up to 32.

The deeper problem is the **voice model**: allocation is per-*instrument* (4 voices each,
`mod-import.ts:719`) against a 16-voice worklet pool (`worklet-config.ts`, 2 engines ×
8 voices). 32 channels cannot be served by per-instrument allocation. XM semantics are
one voice per channel anyway, so this should become **per-channel allocation with
channel-scoped effect state**. Touches `song-bank.ts` and `worklet-pool.ts`.

### B3 — Instrument model
Today a slot is one sample. An XM instrument is up to 16 samples plus:
note→sample keymap (96 entries); per-sample `relativeNote`, `finetune`, `panning`,
`volume`, loop type (none/forward/ping-pong), 8- or 16-bit delta-encoded data;
volume and panning envelopes (12 points each, sustain point, loop start/end);
`volumeFadeout`; autovibrato (type, sweep, depth, rate).

Also `TOTAL_SLOTS = 35` (`tracker-store.ts:8`, 5 per page × 7 pages) vs XM's 128 instruments.

### B4 — Frequency model
`effect-processor.ts` hardcodes ProTracker periods and clamps to ~C-1..B-3. XM's default
**linear** table spans 8 octaves with a different period↔frequency relation:

```
period = 10*12*16*4 − (note*16*4) − (finetune/2)
freq   = 8363 * 2^((6*12*16*4 − period) / (12*16*4))
```

XM can also be flagged into Amiga mode, which uses its own interpolated period table —
close to but not identical with ProTracker's. Every pitch helper is affected:
`updatePitchFromPeriod`, `updatePitchFromFrequency`, `applyPortamentoStep`,
`applyFinePortamento`, `protrackerArpPeriod`, glissando snapping.

### B5 — Volume column
`TrackerEntryData.volume` is a gain string. XM's volume column is a *command byte*:
`0x10-0x50` set volume, `0x60/0x70` volume slide down/up, `0x80/0x90` fine slide,
`0xA0` vibrato speed, `0xB0` vibrato, `0xC0` set panning, `0xD0/0xE0` pan slide,
`0xF0` tone portamento. Needs its own field on the entry; it cannot share the gain column.

### B6 — ProTracker quirks that must become conditional
Currently unconditional, and wrong for XM:
- Arpeggio wrapping to DC on period-table overflow (`effect-processor.ts:73-77`)
- EDx note-delay overflow carry (`carryDelayedNote`, `:215`, `:545-568`)
- Period clamping to 113–856 (`clampProtrackerPeriod`)
- LRRL default channel panning (`mod-import.ts:154-179`) — XM defaults to centre
- Tick-0 volume-slide handling and Axy effect-memory semantics

### B7 — Lossy effect encoding
Effects round-trip through a 3-character text macro (`"3A0"`) and are re-parsed in
`note-utils.ts:172`. The synthetic-parameter hack at `mod-import.ts:339-356` — re-encoding
a 9xx offset so a later `/255` yields the right fraction — is the symptom of that
lossiness. XM needs raw `(cmd, param, volumeColumn)` to survive to playback intact.

### B8 — Key-off and fadeout
XM note 97 is key-off: it releases the envelope and starts `volumeFadeout`, rather than
stopping the voice. The current model has `###` note-off and no fadeout concept.

---

## 4. Target architecture

### 4.1 Per-song format tag, not a user setting
```ts
type ModuleFormat = 'protracker' | 'xm' | 's3m' | 'native';
```
Carried on the song file and threaded into the playback engine. A global preference
cannot be correct when one app instance opens both a MOD and an XM.

### 4.2 `FormatProfile`
A single object owned by the engine and passed into the effect processor, holding:
pitch model, period clamp range, volume-slide tick-0 policy, effect-memory sharing rules,
arpeggio algorithm, default panning, E-command dispatch table, default speed/BPM,
and whether to use the WASM synth path or `ModInstrument`.

`processEffectTick0` / `processEffectTickN` take it as a parameter rather than reading
module-level constants.

### 4.3 `PitchModel`
An interface (`AmigaPitchModel`, `LinearPitchModel`) replacing the free period functions
at the top of `effect-processor.ts`. This is the largest single refactor and the thing
that makes S3M/IT cheap later.

### 4.4 Parsers behind a shared IR
```
packages/tracker-playback/src/formats/{mod,xm,s3m}.ts  →  ModuleSong (IR)  →  one importer  →  TrackerSongFile
```
`ModuleSong` carries: channel count, per-pattern row counts, order list, restart position,
instruments (sample lists + envelopes + keymaps), initial speed/BPM, and format flags.
Format weirdness stays inside the parsers; the importer stays format-agnostic.

---

## 5. Phases

Each checkbox is intended to be roughly one commit. Tick as they land.

### Phase 0 — Groundwork
- [x] Make the MOD-instrument path the default (see D3 — needs a settings-version
      migration, not just a default flip)
- [x] Add `ModuleFormat` to the song-file schema with a version bump; infer the format
      for pre-tag songs on load (see D6)
- [x] Thread the format tag from the store through `useTrackerSongBuilder` into the engine

### Phase 1 — Structural (B1, B2)
- [x] Move row count from song-level `patternRows` onto each pattern; migrate saved songs
- [x] Engine + song builder honour per-pattern lengths
- [x] Pattern UI handles varying lengths
- [x] Parser: accept 6CHN/8CHN/xxCH MOD signatures instead of throwing
- [x] Importer: drop `MAX_TRACKS = 4`, derive track count from the module
- [ ] Per-channel voice allocation in `song-bank.ts` / `worklet-pool.ts`

### Phase 2 — Format profile refactor (B4, B6, B7)
- [x] Introduce `FormatProfile`; reach it from the effect processor
      (attached to each `TrackEffectState` rather than threaded as a parameter — D17)
- [x] Extract `PitchModel` interface; move PT period logic into `AmigaPitchModel`
- [x] Add `LinearPitchModel` (XM linear table) — inert until an XM song selects it
- [x] Move each remaining ProTracker quirk (B6 list) behind a profile flag
      — moved: volume-slide unit, arpeggio DC wrap, EDx overflow carry,
        period clamping (inside `PitchModel`), volume-slide memory
      — investigated and deliberately *not* moved: LRRL import panning,
        tick-0 volume-slide policy (see D21)
- [ ] Carry raw `(cmd, param)` bytes on `TrackerEntryData` alongside the text macro;
      retire the 9xx synthetic-param hack
- [ ] MOD regression suite green with the profile in place

### Phase 3 — XM parser and import (B3, B5, B8)
- [x] `formats/xm.ts`: header, pattern decode (packed cells), instrument + sample headers
- [x] 8/16-bit delta sample decoding
- [x] Shared import layer — a `SamplerPatchSpec` builder rather than the planned
      `ModuleSong` IR (see D25 for why the abstraction moved)
- [x] Key-off (note 97) handling — mapped to the tracker's `###` note-off
- [x] Raise `TOTAL_SLOTS` (35 → 65) and allocate only for *used* instruments (F2)
- [x] Volume column: "set volume" (0x10–0x50) imported
- [ ] Volume-column *commands* (0x60+: slides, pan, vibrato, tone porta) — see D27
- [ ] Multi-sample instruments with note→sample keymap — see D26

### Phase 4 — XM instrument fidelity
- [x] Volume envelope (points + sustain) — loop not yet applied, see D31
- [ ] Panning envelope
- [x] `volumeFadeout` on key-off
- [ ] Autovibrato
- [ ] Remaining XM effects: Kxx, Lxx, Rxy, Txy, Xxy, Gxx/Hxy

### Phase 5 — S3M
- [ ] `formats/s3m.ts` → `ModuleSong`
- [ ] ST3 `FormatProfile` entry (its own effect letters, volume/tempo quirks, Adlib
      channels ignored)

---

## 6. Decision log

Append here; do not rewrite history. Reversals get a new entry referencing the old one.

**D1 — Per-song format tag, not a global user preference.**
The existing `useSimplifiedModInstruments` is app-global. Format behaviour must be a
property of the song, since one session can open several modules of different formats.

**D2 — Modes as a data object (`FormatProfile`), not subclasses or branches.**
Branching on `format === 'xm'` inside effect handlers will spread across a 1200-line file
and become unauditable. A profile object keeps the differences enumerable in one place,
which is also what makes S3M cheap.

**D3 — Flipping the MOD-instrument default requires a migration.**
`user-settings-store.ts` persists the whole settings object on any change, and
`loadSettings` merges stored-over-defaults. Anyone who has ever touched a setting already
has `useSimplifiedModInstruments: false` in localStorage and will not pick up a changed
default at `user-settings-store.ts:34`. Needs a settings-version field + migration step.

**D4 — Open: XM likely wants the WASM path, not `ModInstrument`.**
`ModInstrument` is native Web Audio with no envelope support, and XM needs volume/panning
envelopes plus fadeout and autovibrato. That argues for XM on the WASM synth path even as
MOD defaults to `ModInstrument` — which means "which engine" belongs in `FormatProfile`
rather than being one global default. Confirm during Phase 4.

**D6 — Legacy songs infer their format rather than all defaulting to `'protracker'`.**
Section 5 originally said to default pre-tag (v1) song files to `'protracker'`. That is
wrong: it would later apply Amiga period clamping, LRRL panning and ProTracker effect
quirks to songs hand-authored in this tracker. A MOD import is identifiable — it is the
only producer of `instrumentType: 'mod'` slots (`mod-import.ts`) — so v1 files key off
that and fall back to `'native'`. See `inferLegacyModuleFormat` in `tracker-store.ts`.

**D7 — `defaultPatternRows` kept as a seed rather than deleted.**
Row count moved onto `TrackerPattern.rows`, but the song-level value survives
(renamed `patternRows` -> `defaultPatternRows`) as the count applied to newly created
patterns. `setPatternRows` also writes it, so editing the length of the pattern you are
on and then adding a pattern behaves the way the old single control did. It is also what
pre-v3 files backfill from.

**D8 — `engine.setLength` no longer rewrites pattern lengths.**
It used to overwrite every pattern's `length`, which would flatten exactly the variation
XM needs. It now only sets the fallback used when no pattern is loaded; per-pattern edits
go through the new `engine.setPatternLength(patternId, rows)`. Regression-guarded in
`src/tests/tracker-engine-pattern-length.test.ts`.

**D9 — Startrekker FLT8 is rejected, not decoded.**
FLT8 stores an 8-channel pattern as two consecutive 4-channel blocks, with an order
table indexing blocks rather than patterns. Decoding it as a flat 8-channel pattern
silently interleaves the wrong channels. `looksLikeMod` still accepts it (so the user
gets the real reason) but `parseMod` throws. Revisit if an FLT8 module actually turns up.

**D10 — Multi-channel panning repeats the Amiga L-R-R-L grouping.**
For 5+ channels the pan is `channelIndex % 4` into the classic L-R-R-L layout, matching
what multi-channel MOD players do. The 1/2/3-channel special cases and the 4-channel
result are unchanged — pinned by a test, since panning feeds macro 0 and a regression
here would be audible on every existing MOD.

**D11 — 9xx sample offset rides on the noteOn, not on separate automation.**
9xx was a no-op end to end, in three independent ways: the offset was emitted as a
standalone command *after* the noteOn (too late — a Web Audio `AudioBufferSourceNode`
cannot be repositioned once started); `ModInstrument.setVoiceMacroAtTime` handled only
macro 0 and dropped macro 1, which is the offset route; and
`PooledInstrument.setVoiceMacroAtTime` was an empty stub, which also silently killed
per-channel panning on that path. History: the stub arrived with `3dea12d "wip pooled
engines"` (which also made pooling the default), and `a77b8f9` later corrected the
*import-side* arithmetic — a right number routed into a dead end. The offset is now
carried on the noteOn command and applied at `source.start(when, offset)`. A 9xx row
with no note still emits the standalone command, which the instrument remembers and
applies to the next note, matching ProTracker's per-channel offset memory.

**Lesson for Phase 2:** an effect can look fully implemented across the parser, effect
processor, engine and song-bank and still terminate in a stub. When verifying an effect,
trace it to the point where it touches an AudioParam or a buffer — not to the point
where it stops being interesting.

**D12 — 5xy takes its pitch-slide speed from 3xx memory, never from its own parameter.**
The 5xy parameter is entirely the volume slide (x = up, y = down); the tone-portamento
speed carries over from the last 3xx. The code fed those nibbles to
`resolveTonePortaSpeed`, which both reinterpreted a volume parameter as a pitch speed
*and* wrote `state.lastTonePorta`, destroying the remembered 3xx speed for every
following row. In GSLINGER.MOD pattern 4 track 1 — `3F0` (speed 240) followed by a long
300/500/501 tail — the first `501` dropped the speed to 1, after which the pitch could
never reach its targets and the passage drifted badly out of tune.
`resolveTonePortaSpeed` now serves 3xx only.

**D13 — Voice resolution never falls back to voice 0.**
Instruments are per-sample, so two tracks playing the same sample share one instrument
and its voice pool. `setVoiceVolumeAtTime` / `setVoiceSampleOffsetAtTime` resolved a
`-1` voice index by falling back to voice 0 when the track had no voice of its own,
aiming the command at whichever track owned voice 0. GSLINGER.MOD pattern 2: channels 1
and 3 both play sample 9, and channel 3's row-0 `C00` (volume zero, no note) landed on
channel 1's just-started lead and killed it. Both now no-op instead — a volume or offset
command on a track with nothing sounding has nothing to apply to, and the importer's
sticky volume column already carries the value to that channel's next note.

**This is a structural consequence of one-instrument-per-sample** and will recur wherever
per-voice automation resolves a track to a voice. It is another argument for the
per-channel voice allocation in B2.

**D14 — Panning effects (8xx / E8x / Pxy) now have a real handler.**
Found by the effect audit. The engine's pan case was `break;` — "pan is conveyed on
noteOn events when present" — so per-note default panning worked but *every mid-note pan
change was discarded*. Added `ScheduledPanHandler` → `songBank.setVoicePanAtTime` →
macro 0, which all three instrument implementations route to their pan control. The
effect processor works in −1..1 and the instrument pan API takes 0..1, so the engine
converts; the pan command also carries a voice index now, and resolution uses the strict
no-voice-0-fallback rule from D13.

**D15 — A bare sample number resets the channel volume.**
ProTracker reloads a sample's default volume into the channel whenever a sample number
appears, note or no note. Composers depend on it: PT has one effect column, so Axy alone
only moves volume one way, and the standard hand-rolled tremolo alternates
"sample-number-only" rows (reset to full) against Axy rows (slide down). The importer
applied the reset only on rows that also carried a note, so the slide walked the volume
down with nothing to restore it. musiklinjen.mod pattern 5 channel 2 — a pumping string
built from `smp=13 A06` and bare `smp=13` — faded out and stayed quiet.

Setting the volume on those rows also stops them tripping the engine's "naked instrument
number revives the last note" convention, which is correct: ProTracker does not
retrigger on a bare sample number either. So this fixed a spurious retrigger as well.

**D16 — Axy volume slides run at the authentic 1/64 rate (was 1/128).**
Resolved the observation left under D15. Measured: at speed 6 an `A06` row dropped 0.234
where ProTracker drops 5 x 6/64 = 0.469 — exactly half. The `1/128` came from `b0840ae`
("Softer slide ... to better match MOD feel"), whose own comment said 1/256 while the
code said 1/128, so it was never derived. It looks like an ear-made compensation for a
double-application bug fixed independently since: the slide now runs once per tick for
ticks 1..speed-1, five times at speed 6, matching ProTracker. Fine slides (EAx/EBx) and
tonePortaVol/vibratoVol already used 1/64, so the file was internally inconsistent too.

The existing spec test asserted `1/128` with the comment "matches vol slide scaling in
effect-processor" — i.e. it mirrored the implementation instead of the format, so it
agreed with the halved rate rather than catching it. It now states ProTracker's rule.

**Verified by ear on the test deploy.** Every Axy fade is now twice as fast; this is the
authentic rate and it sounds correct.

**D17 — The profile lives on `TrackEffectState`, not in the function signatures.**
`processEffectTick0` / `TickN` already take seven positional parameters, and the quirks
are read from a dozen private helpers below them. Threading a profile argument through
all of those would be churn with no benefit, so each track's state carries a reference to
the song's (shared, immutable) profile, set when the engine creates the state. The engine
clears its track states on `loadSong` so a profile change cannot leak across songs.

All four profiles currently hold identical, ProTracker-derived values. That is
deliberate: the plumbing lands first so each behaviour can be migrated and tested on its
own, rather than as one sweeping rewrite. `NATIVE_PROFILE` keeps the ProTracker values
indefinitely for now — songs authored against the current engine were composed by ear
with those behaviours in place.

**D18 — Arpeggio's table-overflow behaviour belongs to the `PitchModel`, not the profile.**
`arpeggioWrapsToDC` was briefly a `FormatProfile` flag (D17). It moved into
`createAmigaPitchModel(options)` because the artefact only exists as a consequence of
stepping through a period *table* at all — a linear model computes arpeggio
arithmetically and has nowhere to overflow. Period clamping moved with it for the same
reason: the playable range is a property of the representation.

The model exposes both `rawPeriodFromFrequency` (unclamped) and `periodFromFrequency`
(clamped) because the processor genuinely needs both — clamping when converting a note's
literal frequency back to a period would silently retune notes sitting outside the
nominal table, which is exactly the MOD pitch precision earlier commits worked to
preserve.

**D19 — The linear model emits musical Hz, scaled by 32.**
XM's table gives a sample *playback rate*: period 4608 (C-4) yields 8363 Hz, the Amiga
convention for a sample played at its recorded rate. The engine works in musical Hz —
`ModInstrument.calculatePlaybackRate` compares the frequency against
`440*2^((rootNote-69)/12)` — so the linear model divides by 32, exactly as the Amiga
model divides the Paula rate by 128. 8363/32 = 261.3 Hz, i.e. C-4. Emitting raw XM rates
would drive the sampler ~32x too fast, the same failure the Paula scaling exists to avoid.

**Needs validation against real XM playback in Phase 3:** the linear period clamp is set
to XM's own note range (1600 = B-7 .. 7680 = C-0), derived from the format's note range
rather than measured against FastTracker 2. In particular it is not confirmed whether FT2
lets portamento run past B-7 instead of clamping. Nothing selects this model yet, so the
guess is currently harmless.

**D20 — Volume-slide memory is a real format difference; MOD now matches ProTracker.**
ProTracker has no volume-slide memory: `A00` means "no volume change". FastTracker 2
reuses the last non-zero parameter. The engine did the FT2 thing for every format.

Measured across the 20 modules in the local collection: 569 of 27378 `Axx` commands carry
a zero parameter, concentrated heavily — 330 of 1224 in `resii.mod` (27%), 157 of 1164 in
`playingw.mod`. Those rows were continuing a remembered slide where ProTracker holds the
volume steady, so volume drifted.

Scoped deliberately to *volume*-slide memory. The same survey showed portamento
(`1xx`/`2xx`) uses a zero parameter only 2 times in 1501, so its memory semantics are not
worth changing, and vibrato's per-nibble memory is used in 2463 of 4452 `4xy` commands and
already behaves correctly in both formats. `NATIVE_PROFILE` keeps memory so existing
songs written against this engine are unchanged.

**D21 — Two listed B6 quirks were investigated and left alone, on purpose.**

*LRRL import panning* lives in `mod-import.ts`, which is by definition the MOD importer;
LRRL is correct there and the XM importer will set XM's own panning (centre, plus
per-instrument pan) when it is written. Routing it through a playback profile would add
indirection without expressing anything the file layout does not already decide.

*Tick-0 volume-slide policy* — no actionable difference found. Both ProTracker and FT2
apply volume slides on ticks 1..speed-1, which is what the engine already does (verified
by measurement under D16). The genuinely tick-0 commands are the *fine* slides
(`EAx`/`EBx`), which are already handled separately and identically in both formats. No
flag added rather than inventing a distinction to fill a checklist row.

**D22 — Delta accumulation wraps within the sample's word size.**
XM stores PCM as running deltas. Accumulating them in JavaScript's wider numbers instead
of masking to 8 or 16 bits lets the running value drift outside the sample's range on long
samples and clip audibly. `decodeDeltaSample` masks (`& 0xff` / `& 0xffff`) and then
reinterprets as signed, which is what the format's 8/16-bit accumulators do.

**D23 — The XM parser stays close to the file and makes no interpretation decisions.**
It reports what the file says — note 97 as key-off, volume-column bytes uninterpreted,
loop points converted from bytes to frames only because that is a unit fix rather than a
judgement. Mapping to instrument slots, tracker entries and effect commands belongs to
the import layer, so the parser can be tested purely against the layout and the import
rules stay in one place.

**D24 — XM's frequency table is selected per file, so it rides on `Song`, not `ModuleFormat`.**
Half the real corpus uses XM's Amiga table (F1), and the choice lives in the module
header rather than being a property of "being an XM". Adding an `xm-amiga` member to
`ModuleFormat` would have made a file-level flag masquerade as a format. Instead
`Song.linearFrequency` carries it and `profileForFormat(format, options)` selects
`XM_AMIGA_PROFILE`, which differs from `XM_PROFILE` only in its pitch model — the flag
genuinely changes nothing else.

`createXmAmigaPitchModel` uses the Paula relation `rate = 8363*1712/period` with C-4 at
period 1712. Both XM modes agree *exactly* on every note's pitch — verified by test —
and differ only in how slides interpolate between notes, which is the actual purpose of
the flag. ProTracker's table is visible inside it: XM note 60 is period 856 and note 72
is 428, the classic Amiga C-1 and C-2.

**Known approximation:** FT2 ships a precomputed table with logarithmic interpolation
across eight finetune steps per semitone, whose entries deviate from this continuous
formula by up to about a period unit. Inaudible for note playback, possibly audible on
long slides. Swap in FT2's literal table if XM slides sound subtly off against a
reference player.

**D25 — The shared import layer is a patch builder, not the planned `ModuleSong` IR.**
Section 4.4 called for both parsers to emit a common `ModuleSong` that one importer
consumes. Measuring the actual duplication changed the answer.

`createSamplerPatchForSample` was **368 of mod-import.ts's 950 lines** and is almost
entirely format-agnostic node-graph construction — sampler → mixer, amp envelope, the
standard effect nodes, and the two macro routes playback depends on (macro 0 = pan,
macro 1 = sample offset). *That* is what would have been duplicated for XM, and it sits
well below where a parser-level IR would have helped. It is now
`sampler-patch-builder.ts`, taking a `SamplerPatchSpec` of plain numbers; mod-import
dropped to 625 lines and supplies its own ProTracker-specific values (root note 65,
finetune/8 × 100 cents, the `loopLength > 2` no-loop convention).

The `ModuleSong` IR is **not** being built for now, for two reasons. It would have one
real consumer (XM) plus a guess, since migrating the MOD path to it means rewriting
import logic the user has verified by ear across many songs — risk with no functional
payoff. And the genuinely shared code turned out to be below the parser boundary, not at
it. Revisit when S3M lands and there are two real implementations to generalise from
rather than one plus an assumption.

**D26 — One sample per XM instrument, for now.**
XM instruments carry up to 16 samples with a 96-note keymap. Measured across the corpus,
**only 3 instruments in one file (an-path.xm) have more than one sample, and not a single
instrument anywhere uses a non-uniform keymap.** The importer therefore takes each
instrument's first sample with data and ignores the keymap. That is lossy for exactly 3
instruments out of 268, against a large amount of machinery — and slot pressure would
double or worse if each sample needed its own slot. Revisit if a real song sounds wrong
because of it; the parser already reads the full keymap, so only the importer changes.

**D27 — Volume-column commands beyond "set volume" are not interpreted yet.**
XM's volume column is heavily used (686–17101 cells per module) but mostly for plain
volume: e.g. an-path.xm uses it 17101 times, 12735 of them set-volume. The remaining
0x60+ range (volume slides, fine slides, vibrato, panning, pan slide, tone portamento)
is imported as nothing. That is a real gap — roughly 25% of volume-column usage in the
busiest files — and needs a dedicated field on `TrackerEntryData`, since the existing
`volume` column is a plain gain and cannot carry a command.

**D28 — XM's sampler root note is derived, not fitted.**
`rootNote = 69 + 12*log2(44100/32/440) = 88.77`, from requiring
`playbackRate = scheduledFrequency / f(rootNote)` to equal the XM rate for a buffer
declared at 44100. The identical derivation with MOD's /128 scale yields 64.77 — which is
where mod-import's empirically calibrated 65 came from. Getting the existing magic number
to fall out of the formula is good evidence the relation is right.

A sample's `relativeNote` is folded into its root note rather than into the scheduled
note frequency, since the root is per-instrument while frequency is per-note. Applying it
in both places would transpose twice; a test asserts the frequency stays put while the
root moves.

**D29 — Only a row that starts a note may stamp `entry.instrument`.**
In ProTracker a bare sample number does not change the sounding sample: it selects the
sample for the channel's *next* note and reloads the channel volume. One MOD sample is
one instrument here, so stamping the instrument on such a row re-routes every per-voice
effect on it — arpeggio pitch, volume, slides — to an instrument with nothing playing,
and the sounding voice receives none of them.

`think_twice_iii.mod` exposed it: a C64-style channel holds one note and steps the sample
number through 11..18, whose header volumes descend 64..13 to form a hand-made decay
envelope, with an arpeggio (`05A`) repeated on every row. The arpeggio was audible for
exactly one row and the envelope never applied at all.

The importer now stamps the instrument only on note rows (tone portamento still excluded,
for the same "keep addressing the sounding voice" reason), and tracks each channel's
latched sample number so a note written without one still resolves correctly.

**This interacts with D13.** Before the voice-0 fallback was removed, these misrouted
commands landed on some arbitrary voice and did *something*; afterwards they were
correctly dropped, which made the symptom starker. D13 was still right — the misrouting
was the actual bug, and it had simply been masked by a second one.

**Scope, measured across the 30-module local collection:** the idiom is not a C64-
conversion curiosity — it is ordinary Amiga practice. **18 of 30 modules use it**, with
**8005 bare sample-number rows, 6166 of them carrying an effect** that was previously
routed to a silent instrument.

| Module | Bare rows | With effect |
|---|---|---|
| think_twice_iii | 4282 | 2782 |
| musiklinjen | 1105 | 1085 |
| nexus_seven | 561 | 553 |
| tempest-acidjazz | 524 | 381 |
| stardstm | 511 | 509 |
| resii | 416 | 392 |
| ELYSIUM | 224 | 220 |
| peacedroid | 176 | 52 |
| physical_presence | 109 | 109 |

`peacedroid.mod` — the checked-in reference the user described as "pretty broken" from
the start of this work — is on that list, so this fix plausibly improves it too.

**D30 — The position display follows the scheduler's row timeline, not elapsed time.**
`updatePosition` derived the current row as `elapsed / currentRowDuration`. That silently
assumes the row duration never changes: the instant a song hits an `Fxx` speed or tempo
command, the new duration is applied retroactively to *all* previously elapsed time, so
the displayed row jumps and stays wrong for the rest of the song. `EEx` pattern delay,
`E6x` pattern loop and `Bxx`/`Dxx` jumps break the same assumption by making rows
non-linear in time — a pattern-delayed row cannot be expressed as a time division at all.

Audio was never affected: the scheduler advances `nextRowTime` cumulatively with the
tempo in force at each row, so it was already correct. Only the *display* re-derived the
position, and re-derivation was the bug.

The engine now records `(time, row, sequenceIndex, patternId)` as each row is scheduled
and the display reports the latest entry whose time has been reached. That is exact under
tempo changes, pattern delay, loops and jumps, because it reuses the scheduler's own
timeline rather than trying to reconstruct it. The queue is cleared on stop, seek and
`loadSong` so stale rows cannot leak between runs.

`TimingSystem.getCurrentRow` is now unused by the display. It is left in place — it still
serves seek/anchor maths — but it should not be reintroduced as a position source.

**D31 — Volume envelopes run as Web Audio automation on a dedicated gain stage.**
Resolves D5. Measured across the corpus, **92–100% of notes in most modules are played by
instruments with a volume envelope or fadeout** — `4-mat_-_rose` is the outlier at 19%/10%,
which is exactly why it was the one module that already sounded close to right. This was
the dominant XM quality gap, well ahead of the volume-column commands (D27).

Each voice gets its own envelope gain node ahead of the channel-volume node, so the
envelope *multiplies* with the volume that effects automate instead of overwriting it —
the same conflict that made 9xx and pan collide before. Points are scheduled as
`linearRampToValueAtTime` at note-on, which needs no per-tick JS work at all: the
JS-tick-loop option in D5 would have cost per-tick automation across up to 32 channels for
a curve the audio thread can interpolate itself.

Envelope positions are in ticks, so the note carries the tick duration in force at its
position (`ScheduledNoteEvent.tickSeconds`) and timing follows the song's tempo.

Fadeout is exact: XM subtracts `fadeout` from a 65536 counter each tick and scales volume
by `counter/65536`, so silence arrives after `65536/fadeout` ticks and the decay is linear
— one linear ramp reproduces it.

**Known approximations:** the envelope's own points past the sustain also continue in FT2,
multiplying with the fadeout; only the fadeout is applied on release, since it is the term
that reaches silence. Envelope *loops* are parsed and carried but not yet applied. Both
matter most for long sustained notes.

**D32 — Voices are owned per tracker channel, not pooled per instrument.**
A tracker channel is monophonic, so a note on a channel should only ever replace *that*
channel's note. `ModInstrument` instead allocated from a pool shared by every channel
using the instrument, and — worse — `num_voices` was hardcoded to 4 and never read the
patch's `voiceCount`. One sample is one instrument here, so an instrument played on more
than four channels had notes stolen from channels that were still sounding. Measured:
`an-path.xm` exceeds four on **2566 rows**, `jt_letgo.xm` on 1520, `elw-sick.xm` on 890.
Heard as notes simply missing.

Voices are now assigned per channel and held for the life of the instrument, and the XM
importer sizes each patch by the number of *distinct channels* that ever play it — not
the peak overlap, since sizing by peak would leave some channel without a voice of its
own and put it back to stealing. Real allocations: `an-path` up to 26 voices for one
instrument, `sweetdre` 21, `elw-sick` 15, where every instrument previously got 4.
Voices are free until a note sounds: audio nodes are built at note-on.

**D33 — XM portamento moves four period units per parameter unit.**
XM's period scale is four times finer than ProTracker's — its Amiga C-4 is 1712 against
ProTracker's C-2 of 428, and its linear table uses 64 units per semitone — and
FastTracker 2 correspondingly slides by `param * 4`. Using ProTracker's scale left every
XM slide at a quarter speed, so slides never reached their target and the pitch sat
wrong: audibly "out of tune slides".

`portamentoUnitScale` on the profile is 1 for ProTracker/native and 4 for XM in both
frequency modes. The invariant worth keeping: XM **Amiga** mode then slides at exactly
ProTracker's musical rate (asserted to within 0.001 cent), because a 4x finer period
scale and a 4x larger step cover the same interval. XM **linear** mode deliberately
differs — linear slides are constant in cents, Amiga slides are not.

**Still unscaled:** fine portamento (E1x/E2x) works in semitone fractions rather than
period units, so it is unaffected by this scale and has not been checked against FT2.

**D5 — Resolved by D31.**
Either drive XM envelopes from the JS tick loop (simple, mode-agnostic, but per-tick
automation cost × up to 32 channels) or implement them in the WASM sampler (better
runtime, more work). Decide at the start of Phase 4, informed by measured Phase 3 cost.

---

## 6b. Effect audit (2026-08-28)

Every effect traced from the parser to the point where it touches an AudioParam or a
buffer, prompted by D11. Findings:

**Dead ends found and fixed**
- 9xx sample offset — three independent breaks (D11).
- Volume/offset voice resolution falling back to voice 0 across tracks (D13).
- 8xx / E8x / Pxy panning — discarded by `case 'pan': break;` in the engine (D14).

**No-ops that are correct, now documented as such in code**
- `ModInstrument.setMacro` (instrument-wide macro). Implementing it naively would write
  pan to every voice of a shared instrument and reintroduce the D13 cross-track class.
  MOD playback does not need it: macro 0 rides on the note-on as `step.pan`, and mid-note
  changes go through the per-voice pan path.
- `ModInstrument.setMacroParameter` — unreachable on the tracker path.
- `ModInstrument.cancelScheduledNotes` — it does schedule ahead, but the transport calls
  `allNotesOff()` right after, and `source.stop()` on a not-yet-started source cancels it.

**Confirmed wired correctly**
- ECx note cut (handled per-tick outside the effect switch), E6x pattern loop, Gxx/Hxy
  global volume (all handled in the engine rather than the processor), EAx/EBx (mapped to
  volSlide), E4x/E7x waveform selects, E9x/Rxy retrigger, EDx note delay.

**Known unimplemented** (declared but no behaviour): `filterToggle` (E0x, Amiga hardware
filter) and `invertLoop` (EFx funk repeat). Both are ProTracker-specific and rare; left
for the `FormatProfile` work.

---

## 6c. XM parser validated against real files (2026-08-28)

Parsed all nine `.xm` files in `~/Downloads/mods/ft2` plus one `.s3m` (correctly rejected
by `looksLikeXm`). Every module parsed without error, with plausible structure and
sample statistics — decoded audio roughness 0.04–0.11 and DC offset near zero, where a
broken delta decode shows roughness near 0.5 and large DC drift.

| File | Ch | Pats | Ins | Row counts | Freq table |
|---|---|---|---|---|---|
| 4-mat_-_rose | 4 | 51 | 32 | 64 | **Amiga** |
| 4-mat_-_rose_intro | 4 | 48 | 32 | **5, 64** | **Amiga** |
| BUTTERFL | 16 | 28 | 55 | **8, 16, 32, 64** | **Amiga** |
| an-path | **32** | 50 | 62 | 64 | linear |
| elw-sick | 24 | 47 | 30 | 64 | linear |
| external | 10 | 15 | 22 | 64 | **Amiga** |
| jt_letgo | 26 | 9 | **128** | **256** | linear |
| sweetdre | 24 | 53 | 24 | 64 | linear |
| xyce-dans_la_rue | 22 | 35 | 11 | **32, 64, 96** | linear |

Three findings that change the plan:

**F1 — Amiga-mode XM is common, not exotic: 4 of 9 files.** ✅ **Resolved** — see D24.
`createAmigaPitchModel` was *not* reusable for them: it carries ProTracker's 113–856
clamp and 36-entry three-octave table, while XM spans eight octaves.

**F2 — `TOTAL_SLOTS = 35` is confirmed as a hard blocker (B3).** `jt_letgo.xm` declares
128 instruments. Instrument paging or a raised limit is required, not optional.

**F3 — Per-pattern row counts (B1) were essential, and the range is wide.** Real files
use 5, 8, 16, 32, 64, 96 and 256 rows, sometimes several within one song. The Phase 1
work is load-bearing rather than speculative, and `MAX_PATTERN_ROWS = 256` is exactly
right.

Also confirmed: channel counts reach 32 (`an-path.xm`), the B2 ceiling.

No real module is checked into the repo — these are the user's files, parsed in place.

---

## 7. Testing

- MOD regression suite is the contract for "no regression": `src/tests/mod-*.test.ts`,
  `src/tests/tracker-*.test.ts`, `packages/tracker-playback/src/__tests__/`.
  Run `npm run test` after each checkbox.
- `misc/peacedroid.mod` is the checked-in manual-listening reference for MOD. Note it
  plays with known pre-existing problems unrelated to this work; it is a *comparison*
  reference (does it sound the same as before?), not a correctness one.
- Structural checks are not enough for effects. See D11: 9xx looked implemented at every
  layer and still terminated in a stub. Confirm changes on the deployed build by ear.
- Add an XM equivalent to `misc/` when Phase 3 starts, plus parser unit tests covering:
  packed-cell decoding, 16-bit delta samples, linear vs Amiga frequency flag, and
  per-pattern row counts.

---

## 8. Change log

| Date | Phase | Change |
|---|---|---|
| 2026-08-28 | — | Investigation complete; this document created. No code changes yet. |
| 2026-08-28 | 0 | `useSimplifiedModInstruments` now defaults on, via a new `settingsVersion` field + `migrateSettingsVersion` (v0→v1 rewrite) so existing localStorage blobs actually pick it up. Test: `src/tests/user-settings-migration.test.ts`. |
| 2026-08-28 | 0 | `ModuleFormat` added to `packages/tracker-playback/src/types.ts`; song file bumped to v2 with `data.moduleFormat`; reader accepts v1 and v2; MOD import stamps `'protracker'`; v1 files inferred (D6). Tests: `src/tests/stores/tracker-store-module-format.test.ts`. |
| 2026-08-28 | 0 | Tag threaded store → `useTrackerSongBuilder` → `Song.moduleFormat` → `PlaybackEngine` (`getModuleFormat()`). Nothing branches on it yet. Tests: `src/tests/tracker-module-format-plumbing.test.ts`. **Phase 0 complete.** |
| 2026-08-28 | 4 | Per-channel voice ownership (D32): `ModInstrument` no longer hardcodes 4 voices or pools them across channels, and XM patches are sized by distinct channels per instrument. Fixes notes going missing — `an-path` exceeded 4 voices on 2566 rows. XM portamento scaled by 4 to match FT2's finer period scale (D33), fixing out-of-tune slides. 516 tests green. |
| 2026-08-28 | 4 | XM volume envelopes and fadeout implemented (D31), on a dedicated per-voice gain stage so they multiply with effect-driven volume. Chosen by measurement: 92–100% of notes in most modules need them, vs 19%/10% in `rose` — the reason rose alone sounded right. Tick duration now travels with each note so envelope timing follows tempo. Tests: `src/tests/xm-volume-envelope.test.ts`. 511 green. |
| 2026-08-28 | fix | Pattern display no longer desyncs from playback (D30). It followed elapsed-time ÷ current-row-duration, which broke permanently at the first `Fxx` speed/tempo change and could not represent `EEx`/`E6x`/`Bxx`/`Dxx` at all. Now driven by the scheduler's recorded per-row audio times. Audio was always correct; only the display was wrong. Tests: `src/tests/tracker-position-sync.test.ts`. |
| 2026-08-28 | fix | Measured the D29 idiom across the collection: 18 of 30 modules, 8005 bare sample-number rows, 6166 carrying misrouted effects. Not a C64-conversion curiosity — ordinary Amiga practice. |
| 2026-08-28 | fix | A bare sample number no longer switches the sounding instrument, so per-voice effects keep addressing the voice that is playing (D29). Found via `think_twice_iii.mod`, where a hand-made decay envelope and a continuous arpeggio were both being routed to silent instruments. Tests appended to `src/tests/mod-import-sample-number-volume-reset.test.ts` (3 of 5 confirmed failing against the old code). |
| 2026-08-28 | 3 | **XM files now import and are selectable in the file picker.** `xm-import.ts` maps notes (with exact frequencies from the per-song pitch model), key-off, set-volume, effects (including FT2's G+ extras), per-pattern rows and instrument slots. `TOTAL_SLOTS` 35 → 65, allocating only for *used* instruments (D26–D28). Verified: all 9 real modules import — 4–32 tracks, 8–42 slots, frequencies 32.7–3947 Hz. 487 tests green. |
| 2026-08-28 | 3 | Sampler patch construction extracted from `mod-import.ts` (368 lines) into `sampler-patch-builder.ts`, ready for the XM importer to share (D25). mod-import 950 → 625 lines. Pure refactor — 472 tests green, including the MOD import tests that assert patch structure. The planned `ModuleSong` IR is deliberately not built; see D25. |
| 2026-08-28 | 3 | XM Amiga-mode pitch model added (`createXmAmigaPitchModel`) plus `XM_AMIGA_PROFILE`, selected per song via `Song.linearFrequency` (D24). Closes F1. Both XM modes verified to agree exactly on note pitch. 472 tests green; still not reachable from the UI. |
| 2026-08-28 | 3 | XM parser validated against 9 real modules (see §6c). All parse cleanly with sane sample statistics. Surfaced F1 (Amiga-mode XM is 4 of 9 files and needs its own pitch model), F2 (128 instruments confirms the slot blocker), F3 (row counts 5..256 confirm Phase 1). |
| 2026-08-28 | 3 | XM parser added (`packages/tracker-playback/src/formats/xm.ts`): header, per-pattern row counts, packed + unpacked cell decoding, instruments with 96-note keymaps, volume/panning envelopes, fadeout, autovibrato fields, per-sample tuning/loop settings, and 8/16-bit delta decoding (D22). Reports the file faithfully and interprets nothing (D23). 21 tests against synthetic modules; 459 total green. Not yet reachable from the UI. |
| 2026-08-28 | 2 | `volumeSlideHasMemory` added: ProTracker `A00` now holds volume steady instead of continuing the last slide, matching PT (D20). **Audible on MOD playback** — 569 affected commands across the local collection, 27% of `resii.mod`'s slides. XM and native keep memory. Two remaining B6 items investigated and deliberately not moved (D21). **Phase 2 complete.** Tests: `src/tests/format-profile.test.ts`. |
| 2026-08-28 | 2 | `createLinearPitchModel` added (XM default frequency table) and assigned to `XM_PROFILE`; emits musical Hz via a /32 scale (D19). Nothing selects the XM profile yet, so MOD playback is untouched — 434 tests green. XM Amiga-mode still needs its own profile, which arrives with the parser in Phase 3. |
| 2026-08-28 | 2 | `PitchModel` extracted to `pitch-model.ts`; the ProTracker period table, clamp range, Paula scaling, arpeggio table-stepping and glissando snapping now live in `createAmigaPitchModel` and are reached via `state.profile.pitch` (D18). `effect-processor.ts` no longer contains any Amiga-specific pitch constant. No behaviour change — 425 tests green. Tests: `src/tests/pitch-model.test.ts`. |
| 2026-08-28 | 2 | `FormatProfile` introduced and reaching the effect processor via `TrackEffectState` (D17). Three quirks migrated behind it: volume-slide unit, arpeggio DC wrap, EDx overflow carry. All profiles hold identical values, so no behaviour change — 416 tests green. Tests: `src/tests/format-profile.test.ts`. |
| 2026-08-28 | fix | **Verified by ear — Axy now sounds right.** Axy volume slides corrected from half-rate to ProTracker's 1/64 per tick (D16). Audible on any song using Axy. Test rewritten to assert the format's rule rather than mirror the constant. |
| 2026-08-28 | fix | A bare sample number (no note) now resets the channel volume to the sample default, restoring the Axy pump idiom and removing a spurious retrigger (D15). Found via musiklinjen.mod pattern 5 channel 2. Tests: `src/tests/mod-import-sample-number-volume-reset.test.ts` (3 of 5 confirmed failing against the old code). |
| 2026-08-28 | fix | Effect audit: 8xx / E8x / Pxy panning was discarded by a `break;` in the engine's pan dispatch; added a real pan handler through to the instrument (D14). Tests: `src/tests/mod-pan-effects.test.ts` (all 4 confirmed failing against the dead end). |
| 2026-08-28 | fix | Voice resolution no longer falls back to voice 0, which let one track's volume/offset commands hit another track's voice when both used the same sample (D13). Found via GSLINGER.MOD pattern 2. Tests: `src/tests/tracker-song-bank-cross-track-volume.test.ts` (confirmed failing against the old code). |
| 2026-08-28 | fix | 5xy no longer reads its pitch-slide speed from the volume-slide parameter, and no longer clobbers the 3xx speed memory (D12). Found via GSLINGER.MOD pattern 4 track 1. Tests: `src/tests/mod-toneporta-volslide-speed.test.ts` (3 of 5 confirmed failing against the old code). |
| 2026-08-28 | fix | **Verified by ear on the test deploy — 9xx now correct.** 9xx sample offset fixed end to end (D11): offset now rides on the noteOn and is applied at voice start; `ModInstrument` honours macro 1 with ProTracker-style offset memory; `PooledInstrument.setVoiceMacroAtTime` implemented (also restores per-channel pan on the pooled path). Tests: `src/tests/mod-sample-offset-playback.test.ts`, `src/tests/mod-instrument-sample-offset.test.ts`. |
| 2026-08-28 | 1 | MOD parser accepts up to 32 channels (`channelsForSignature`: `<n>CHN`, `<nn>CH/CN`, `TDZ<n>`, CD81/OKTA/OCTA); FLT8 explicitly rejected (D9). Importer derives track count from the module and repeats L-R-R-L panning past 4 channels (D10). Verified `misc/peacedroid.mod` parses byte-identically before/after. Tests: `src/tests/mod-parser-multichannel.test.ts` (includes per-channel effect-routing coverage). |
| 2026-08-28 | 1 | Row count moved onto `TrackerPattern.rows`; song file v3 backfills pre-v3 files from `data.patternRows` (D7). `engine.setLength` no longer flattens pattern lengths; added `setPatternLength` (D8). Song builder, playback store, export duration and the pattern UI all read per-pattern counts. Tests: `src/tests/stores/tracker-store-pattern-rows.test.ts`, `src/tests/tracker-engine-pattern-length.test.ts`. |
