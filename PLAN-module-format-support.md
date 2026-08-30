# Multi-Format Module Support (MOD / XM / S3M)

**Status:** Phase 3 essentially complete — XM parses, imports and plays, including the
volume column (D50). The largest remaining gaps in XM fidelity are **autovibrato** (13.4%
of corpus notes) and **panning envelopes** (7.3%); both are already parsed and then
dropped at import. Phase 1 still has one open item — per-channel voice allocation (B2) —
deferred as speculative until a high-channel module needs it; see D13 for why it also
matters. Multi-sample keymaps (D26) are **not** the priority this document previously
claimed: 0 of 219 corpus instruments use one (§6f).
**Last updated:** 2026-08-29
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
| Entries | `src/components/tracker/tracker-types.ts` | `volume` is a plain 00–FF gain string (XM's volume-column *commands* now ride alongside on `volumeCommand` — D50); effects are still 3-char text macros, with the `Pxy` collision D52 records |
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

### B5 — Volume column ✅ **Resolved** — see D50
`TrackerEntryData.volume` is a gain string. XM's volume column is a *command byte*:
`0x10-0x50` set volume, `0x60/0x70` volume slide down/up, `0x80/0x90` fine slide,
`0xA0` vibrato speed, `0xB0` vibrato, `0xC0` set panning, `0xD0/0xE0` pan slide,
`0xF0` tone portamento. Needs its own field on the entry; it cannot share the gain column.

Resolved as predicted: the commands live on a new `TrackerEntryData.volumeCommand`
holding the raw XM byte, while `0x10-0x50` continues to import as an ordinary velocity.

### B6 — ProTracker quirks that must become conditional
Currently unconditional, and wrong for XM:
- Arpeggio wrapping to DC on period-table overflow (`effect-processor.ts:73-77`)
- EDx note-delay overflow carry (`carryDelayedNote`, `:215`, `:545-568`)
- Period clamping to 113–856 (`clampProtrackerPeriod`)
- LRRL default channel panning (`mod-import.ts:154-179`) — XM defaults to centre
- Tick-0 volume-slide handling and Axy effect-memory semantics

### B7 — Lossy effect encoding — *partly* resolved
Effects round-trip through a 3-character text macro (`"3A0"`) and are re-parsed in
`note-utils.ts:172`. The synthetic-parameter hack at `mod-import.ts:339-356` — re-encoding
a 9xx offset so a later `/255` yields the right fraction — is the symptom of that
lossiness. XM needs raw `(cmd, param, volumeColumn)` to survive to playback intact.

The 9xx hack is gone (D46) and `volumeColumn` now survives on its own field (D50), so
the two concrete symptoms are dealt with. The encoding itself is unchanged, and D52
records what it still costs: a leading `P` is this tracker's macro-3 shorthand *and*
XM's panning-slide letter, and the string carries nothing to tell them apart.

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
- [x] Retire the 9xx synthetic-param hack — the offset is now carried in sample
      *frames* and resolved by the instrument that owns the buffer (D46)
- [ ] Carry raw `(cmd, param)` bytes on `TrackerEntryData` alongside the text macro
      — still outstanding; the volume column got its own field rather than raw
        bytes (D50), and the `Pxy`/macro-3 letter collision (D52) is the
        remaining symptom of the text encoding
- [x] MOD regression suite green with the profile in place

### Phase 3 — XM parser and import (B3, B5, B8)
- [x] `formats/xm.ts`: header, pattern decode (packed cells), instrument + sample headers
- [x] 8/16-bit delta sample decoding
- [x] Shared import layer — a `SamplerPatchSpec` builder rather than the planned
      `ModuleSong` IR (see D25 for why the abstraction moved)
- [x] Key-off (note 97) handling — mapped to the tracker's `###` note-off
- [x] Raise `TOTAL_SLOTS` (35 → 65) and allocate only for *used* instruments (F2)
- [x] Volume column: "set volume" (0x10–0x50) imported
- [x] Volume-column *commands* (0x60+: slides, pan, vibrato, tone porta) — D50.
      8789 cells across the corpus, 5602 of them panning
- [ ] Multi-sample instruments with note→sample keymap — see D26

### Phase 4 — XM instrument fidelity
- [x] Volume envelope (points, sustain, and loop)
- [x] Panning envelope (D62)
- [x] `volumeFadeout` on key-off
- [x] Autovibrato (D57)
- [x] Remaining XM effects: Kxx, Rxy, Txy, Xxy, Gxx/Hxy (D48, D51, §6e)
- [x] `Lxx` set envelope position (D62)

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
~~For 5+ channels the pan is `channelIndex % 4` into the classic L-R-R-L layout, matching
what multi-channel MOD players do.~~ **Reversed by D44** — that claim was asserted without
being checked against a real multi-channel module. The 1/2/3-channel special cases and the
4-channel result are unchanged and pinned by a test, since panning feeds macro 0 and a
regression there would be audible on every existing MOD.

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

Envelope loops are implemented as of D38, and the release segment as of D39.

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

**D34 — The envelope was silently dropped in `normalizeSamplerStateWithDefaults`, and the
unit tests could not see it.**
`normalizeSamplerStateWithDefaults` rebuilds `SamplerState` from an explicit field list,
so `trackerEnvelope` — reached the patch correctly, present after import, present after a
JSON round-trip — vanished the moment `song-bank.normalizePatch` ran, which is on the path
to *every* instrument. Envelopes did nothing at all while eleven unit tests passed.

The tests could not catch it because they injected `samplerState` via `Reflect.set`,
verifying the scheduling maths in isolation and bypassing the pipeline entirely. This is
the same shape as D11 (9xx terminating in a stub) — plumbing that looks complete at every
layer and drops the value at one of them — arrived at from the opposite direction: there
the *code* was missing, here the *test coverage* was.

Two pipeline tests now cover it, both confirmed to fail against the drop: the envelope
survives `deserializePatch`, and it reaches `ModInstrument` and schedules automation via a
*normalized* patch rather than the raw one. A test that loads the patch directly does not
count — it passes either way.

**Rule for anything added to `SamplerState` from now on:** add it to
`normalizeSamplerStateWithDefaults` too, and assert it through `deserializePatch`, not
just at the point of use.

**D35 — Ping-pong loops are materialised into the buffer.**
`ModInstrument` gated looping on `loopMode === 1`, so ping-pong samples fell through and
did not loop at all — 27 samples across the local XM corpus, including 10 in `an-path.xm`
and 8 in `elw-sick.xm`. An `AudioBufferSourceNode` can only loop forwards, so the loop
region is now followed by a reversed copy of itself at load time and the loop spans both
halves; playing that forwards reproduces the bounce exactly.

Loop bounds are resolved once in `prepareLoop` rather than recomputed per note, which also
removes the duplicated loop arithmetic that existed in both note-on paths.

**D36 — Note-off was scheduled-away entirely, and releases had nothing to cut them.**
Two faults in the release path, both found by the user's ear rather than by tests.

`ModInstrument.noteOffAtTime` acted only when the release fell within 100ms of the
current time and silently dropped it otherwise. The engine schedules half a second to a
second ahead, so *every* note-off was discarded: notes were never released, XM key-off did
nothing, and the fadeout added in D31 never ran because nothing reached
`gateOffVoiceAtTime`. It now releases at the scheduled time, and releases the channel's
own voice whatever note it holds — a tracker key-off releases a channel, not a pitch.

`song-bank.dispatchNoteOffAtTime` also passed a *voice* index into `noteOffAtTime`'s
*track* index parameter. Harmless only because the callee ignored the argument; it now
gates the known voice directly.

Separately, `gateOffVoiceAtTime` removes a voice from the active set immediately so the
slot can be reused, which left nothing able to stop a voice still fading. A new note on
the channel played *over* the released one instead of replacing it. Invisible while
releases lasted 10ms; obvious once XM fadeouts stretched them past a second. Releasing
voices are now tracked and cut by the next note on that channel, by `allNotesOff`, and by
`destroy`.

**D37 — Ticks per row is carried per song; XM declares its own and it is rarely 6.**
"Speed" (the Fxx 01-1F parameter) is ticks per row and is independent of BPM. The engine
hardcoded `setSpeed(6)` on every play and the XM importer never read `defaultSpeed` from
the header — so XM songs played at the right BPM but the wrong tempo. Most of the corpus
declares 3 (`rose`, `jt_letgo`, `sweetdre`, `xyce`) or 5 (`an-path`, `elw-sick`,
`BUTTERFL`); at the default 6 a speed-3 song runs at exactly half tempo.

`Song.initialSpeed` now carries it, the engine applies it at `loadSong` *and* when
scheduled playback starts (that reset previously reverted to a hardcoded 6, so any Fxx
from a previous run had to be undone but the song's own speed was lost with it). The
song file field is optional and additive: files without it get the tracker default of 6,
which is exactly what every song saved before it existed assumed, so no version bump.

**D38 — Envelope loops are unrolled, not held.**
FT2 repeats `loopStart..loopEnd` for as long as a note is held. Deferring that (D31) meant
a looping envelope was played once and then held at its final value — silence for most
instruments that use one. 23 of the 95 envelopes in the corpus loop, including **all 16 in
`external.xm`**.

AudioParam automation cannot loop, so the passes are unrolled at note-on to cover 30
seconds or 256 passes, whichever comes first. Sustain still takes precedence: an envelope
with a sustain point waits for key-off rather than looping, which is what FT2 does.

**Caveat:** this was found by measurement while chasing a report of samples going silent,
and it is a genuine gap, but it has *not* been confirmed as the cause of that report. 31
of 95 envelopes legitimately end at zero and hold, which is correct FT2 behaviour for a
non-looping, non-sustaining envelope, so some silence is expected and correct.

**D39 — Key-off is an envelope release, not a mute.**
Corrected by the user. XM's note 97 releases the envelope: the note carries on, the
envelope continues past its sustain point, and the fadeout (if any) takes it to silence.

The release was cutting the note in 10ms whenever an instrument had no fadeout, which is
a mute in all but name — notes that were meant to ring simply disappeared. Release now
follows the envelope's own points past the sustain point, and ends at whichever of the
release tail or the fadeout reaches zero first. An envelope with *neither* has no defined
end in FT2: the note sustains until the channel plays again, so no stop is scheduled at
all and the voice is left for the next note on that channel to replace.

**D40 — Replacing a voice must be scheduled, not immediate.**
`stopReleasingVoice` and the note-on retirement path both called `source.stop()` with no
argument, which stops *now*. Rows are scheduled up to a second ahead, so this silenced a
note at the moment its successor was *scheduled* rather than when that successor sounded.
For any part with notes close together — `external.xm` pattern 1 puts a note, a key-off a
row later, and the next note a few rows on — scheduling a batch of rows destroyed most of
the notes in it. Both paths now stop at the replacing note's start time.

This was introduced by the D36 fix for "notes don't get stopped", and is a good argument
for treating "stop the previous thing" as always needing an explicit time in a
lookahead scheduler.

**D41 — Replacing a note and releasing one are different operations.**
A tracker channel has no polyphony: a new note *ends* the previous note on that channel.
Key-off is the other thing entirely — the envelope release runs, the fadeout takes the
note to silence, and it is meant to ring on.

Making `gateOffVoiceAtTime` perform the envelope release (D31/D39) quietly turned every
*replacement* into a release, because song-bank used that one method for both. A new note
therefore started a fadeout on the previous note instead of ending it, leaving it sounding
underneath — seconds of it, on XM.

Worst where a channel switches instrument: the old instrument's voice went into *its*
releasing set, and nothing on the new instrument ever came back to cut it, so it ran the
full fadeout every time. `4-mat_-_rose.xm` has 30 instruments across 4 channels, so this
happened constantly.

`cutVoiceAtTime` now ends a voice with a 3ms de-click ramp and reaches voices that are
already releasing. Every note-on path in song-bank uses it — same-instrument, cross-
instrument and the mono-patch case — while genuine note-offs keep the release.

**D42 — MOD voice sizing was never given the per-channel treatment XM got.**
`mod-import` kept a hardcoded `voiceCount: 4` after the XM importer moved to sizing by
distinct channels (D32). Fine for a classic four-channel module, badly short beyond it:
`DOPE.MOD` is a **28-channel** module (`28CH`) whose busiest sample appears on **19
channels**, so notes were constantly stolen from channels still sounding. Now sized the
same way as XM, with four as a floor.

Worth noting the multi-channel MOD support (Phase 1) had been landed and tested against
synthetic buffers and 4-channel files only; the first real high-channel module found this
immediately.

**D43 — Track columns tighten as the channel count grows.**
Columns already scrolled horizontally, but at full width very few of 28 or 32 channels are
visible at once. Width and gap now tighten above 8 tracks, with a floor at the entry's own
`min-width` (156px) plus padding — below that the note, instrument, volume and effect
columns clip rather than merely crowd. Genuinely fitting 28 channels on screen would need
a compact entry rendering, which is a larger UI change and not attempted here.

**D44 — Channels past the classic four default to centre, not L-R-R-L.**
Reverses D10. The Amiga layout exists because Paula's four hardware voices are wired two
left and two right; a PC-tracker extension (`6CHN`, `8CHN`, `xxCH`) has no such wiring.
Modules written for those expect centred channels and place anything they care about with
`8xx`.

`DOPE.MOD` is the case that showed it: 28 channels, and just **54 panning commands in the
entire module**. Repeating the grouping hard-panned alternating channels, splitting the
mix into two halves the composer never heard. Verified after the change: `peacedroid.mod`
(4 channels) still yields only the L and R pan values, `DOPE.MOD` yields centre throughout.

D10 was reached by reasoning about what "multi-channel MOD players do" rather than by
checking one, and the test written alongside it pinned the assumption rather than the
behaviour — so it defended the bug instead of catching it.

**D45 — Demo manifest title fallback was overwritten by a spread.**
`DOPE.MOD`'s title field is 20 NUL bytes. The generator computed a filename fallback and
then spread the parsed description *after* it, putting the empty title back — the browser
showed a blank row. Field order in an object literal is not cosmetic when a spread is
involved.

**D46 — A 9xx offset is a distance in frames, not a fraction of the sample.**
Reverses the import-side half of D11. ProTracker's 9xx means "start `param * 256` frames
in" — an absolute distance with nothing to do with how long the sample is. The processor
was normalising it to `param / 255` and treating that as a fraction of the buffer, which
is only correct for a sample of exactly `255 * 256 = 65280` frames.

D11 papered over this in `mod-import.ts` by recomputing the fraction from
`mod.samples[n].length` and re-encoding a *synthetic* parameter byte. That had three
holes, all measured across the 26-module Amiga corpus (2087 resolvable 9xx rows):

- It could only fire on rows naming an instrument. 60 rows do not — `GSLINGER.MOD`, the
  file D11 was written for, has 32 of its 104 — and those fell back to the raw fraction,
  landing a mean of 5556 frames (~0.66 s) away, worst case 12534.
- It requantised the position to eight bits: 1682 rows were off by up to 127 frames
  (~15 ms), which on a drum or guitar attack is audible as a click. This was the
  "slightly wrong sample offset" the user reported by ear.
- Being an import-time fixup it did nothing for XM, whose 2775 9xx cells were all wrong.

The offset now travels as `sampleOffsetFrames` (noteOn → `ScheduledNoteEvent` → song bank
→ instrument) and `ModInstrument` resolves it against its own buffer. That also fixes
ping-pong samples, whose buffer is longer than the sample, and lets overruns follow
ProTracker — which clamps the remaining one-shot length to a single word, so the channel
drops into the sample's loop rather than being clamped to the end of the buffer and
restarting the loop from an arbitrary point.

**D47 — A 9xx on a row with no note is silent.**
Also reverses part of D11. ProTracker consults the offset where a note arms the sample
pointer, so a bare 9xx only updates the channel's memory. D11 had the processor emit a
standalone offset command that latched a pending offset on the *instrument*, to be
consumed by the next note — which meant a note on a different channel, carrying no 9xx of
its own, could start mid-waveform. That is a click manufactured out of nothing. The
memory (`state.lastSampleOffset`) is per channel and was already correct; only the latch
was wrong. `SongBank.setVoiceSampleOffsetAtTime` is now unreachable from playback and
documented as such rather than deleted.

**D48 — Effects defined in period or volume units cannot be implemented as musical amounts.**
Four effects were written as fixed fractions of a semitone or of full volume. The
trackers define them against the *period* and the 0-64 volume, so the two only agree at
one pitch and one depth:

- **Vibrato** used `wave * depth / 16` semitones. ProTracker uses
  `(table * depth) / 128` period units with a table peaking at 255, so the musical width
  of a given depth depends on the note: the old code under-swung ~23% at C-2 and
  over-swung ~55% an octave lower. 12155 occurrences in the MOD corpus and 16241 in the
  XM one — the most-used pitch effect after volume.
- **Tremolo** divided the −1..1 waveform by 64 and dropped the table's 255 peak, making
  every tremolo a quarter as deep as it should be.
- **E1x/E2x fine portamento** applied `2^(x/192)`, i.e. read the parameter as sixteenths
  of a semitone. ProTracker subtracts it from the period directly; FT2 subtracts `x*4`,
  which is `portamentoUnitScale`.
- **Xxy extra-fine portamento** (XM 0x21) was dropped entirely — `parseEffectCommand` had
  no `X`. It is a quarter of E1x's step, so it passes an explicit unit scale of 1.

`vibratoFrequency` deliberately computes from `currentPeriod` without mutating it:
vibrato is a deviation around the note, not a slide.

**D49 — ECx cuts by zeroing the volume, not by releasing the note.**
Both trackers write `volume = 0`; the channel then stays silent until something sets it
again. Sending a `noteOff` runs the release path instead, which on XM means the
instrument's `volumeFadeout` — seconds long where FT2 stops dead. 3693 ECx cells in the
XM corpus, and none at all in the MOD one, which is why this survived the §6b audit that
listed ECx as "confirmed wired correctly": that audit traced MOD playback.

**D50 — The XM volume column gets its own entry field.**
Three candidates: overload `TrackerEntryData.volume`, reuse the `macro2` second effect
column, or add a field. The gain column is out — this tracker's own `volume` is a plain
00-FF velocity and FT2's byte is a tagged union, so overloading it would break native
songs. `macro2` is displayed and editable, which is attractive, but `mod-import` already
uses it for panning and a user's own second-column effect would collide. So:
`TrackerEntryData.volumeCommand`, holding the raw XM byte in hex, parsed by
`parseVolumeColumnCommand` into a `VolumeColumnCommand` on the step.

Two things needed care in playback. FT2 runs both columns on the same row, so the volume
column has its own slide accumulators (`volumeColumnSlide`, `volumeColumnPanSlide`) —
sharing the effect column's would let whichever was primed last cancel the other. And the
engine's ramp shortcut, which collapses a whole row into one automation ramp, has to step
back to discrete per-tick commands when the volume column also has work.

`processVolumeColumnTick0` runs *after* `processEffectTick0` rather than before it as FT2
does, because the note's own velocity has to be established first or the column's fine
slides are simply overwritten. The cost is that where both columns write the same thing
the volume column wins rather than the effect column; no corpus row does that.

The field has no editor UI yet. It round-trips through save/load for free, since
`serializeSong` deep-copies pattern entries wholesale.

**D51 — E5x's nibble means something different in each format, by a full semitone.**
ProTracker reads it as a *signed* 4-bit value in eighths of a semitone (0-7 up, 8-15
down). FT2 reads it as an unsigned position in its −128..127 finetune range
(`finetune = x*16 - 128`, 128 units to the semitone), so 8 is neutral and 0 is a full
semitone flat. For every nibble below 8 they disagree by exactly one semitone.

All 840 E5x commands in the XM corpus use nibble 1 or 6, so every one of those notes was
playing a semitone sharp. Now `FormatProfile.finetuneFromNibble`.

Still applied only to the note on its own row, and not remembered for later notes on the
channel as the trackers do. Every E5x in both corpora sits on a row carrying a note, so
the difference has not come up; persisting it properly means undoing the sample's own
finetune, which this engine bakes into the instrument patch as a fixed detune.

**D52 — `Pxy` collides with the macro-3 shorthand, and is left colliding.**
`parseEffectCommand` checks the `M`/`N`/`O`/`P` macro-shorthand letters before the effect
table, so XM's `Pxy` panning slide (effect 0x19, written `P` by `xmEffectToMacro`) parses
as macro 3 and never reaches the pan-slide handler. The string carries no format tag, so
the two readings are genuinely ambiguous, and resolving it in favour of XM would break
native songs that use the shorthand. Zero occurrences in the corpus. Left as is, and
recorded here as the concrete remaining cost of B7's text encoding.

**D53 — Channel volume is playback state; the importer must not guess at it.**
Reported as "the flute in GSLINGER.MOD pattern 36 is way too quiet". Two separate causes,
both of which come from treating a *channel* volume as if it belonged to the sample.

First, `mod-import` stamped its own running volume onto every note that carried no sample
number, on the reasoning that ProTracker's channel volume "sticks". It does — but it
sticks to whatever Cxx, the sample defaults *and any running Axy/EAx/EBx slide* have left
it at, and an importer has no idea what the slides will have done by the time the row
plays. Its `lastVolume` is a snapshot of the last value written into a cell. Pattern 36
channel 4 is the case: `D-3 23 A50` swells the flute from the sample's default 8 up to
33 across the row, and the next row's bare `C#3 ... ED3` was stamped straight back down
to 8, throwing the swell away every time. The existing guard — skip the stamp when *this*
row carries a slide — cannot help, because the slide that matters ran on an earlier row.

The stamp is gone. A note with no sample number now gets no volume at all, and the effect
processor emits `currentVolume` on every note trigger instead. That last part is load
bearing rather than tidy: a note allocates a fresh voice whose gain node starts from the
instrument's own gain, so the channel volume has to be stated explicitly or the new voice
plays at the wrong level. `channelVolumes` and the `lastVolume` parameter are now dead
and removed.

Second, the sample's header volume was baked into the sampler patch's `gain` *as well as*
being stamped into the volume column. During pattern playback that is harmless — the
volume column's value is absolute and lands on the voice before it sounds — but it makes
the instrument permanently quiet everywhere the volume column is not in charge, which is
exactly what auditioning it from the keyboard is. GSLINGER's sample 23 declares volume 8,
so it played at an eighth of the level of any sample declaring 64, with no way to turn it
up. 271 of the 524 samples in the local MOD corpus declare a header volume below 64, so
this was not an edge case. Both importers now build the sampler at unity; the "keep unity
when the header volume is 0" special case disappears with it.

Worth noting what this does *not* fix: pattern 36 really is written at Cxx volumes of 1
to 8 out of 64 on that flute, so the passage stays quiet. What comes back is the swell
and the ability to hear the instrument on its own.

**D54 — A note-on has to carry its own level (follow-up to D53, caught by ear).**
D53 left the note-on velocity at its hardcoded 127 and relied on the volume command that
follows it. That was survivable only while the sample's default volume was baked into the
instrument gain: the note-on's own gain landed near the right level by accident, so a
volume command that failed to apply was not obviously wrong. Removing the baked-in gain
turned that same fallback into *full scale*.

And the volume command genuinely can fail to apply. `setVoiceVolumeAtTime` drops a
command it cannot resolve to a voice on this track rather than falling back to voice 0 —
which is correct, and is D13 — so the note-on's velocity is the level the note is heard at
whenever that happens. GSLINGER.MOD pattern 2 is the case, and it is the same file and
the same pair of channels as D13: channels 1 and 3 play the same flute, channel 3 three
rows behind as an echo at volume 11 against the lead's 24, and the echo came out at 64.

The note-on now carries `velocityFromVolume(currentVolume)`, so it starts at the right
level whether or not anything else lands, and the volume command that follows is
belt-and-braces. This also required moving the row's own volume assignment *above* the
note-trigger block in `processEffectTick0`, since the note-on now reads it.

Two things this exposes about the D53 change. The comment inside `setVoiceVolumeAtTime`
explicitly justified dropping unresolvable commands on the grounds that "the importer's
sticky volume column already reproduces" ProTracker's behaviour — so removing that stamp
invalidated a documented assumption elsewhere in the pipeline, and grepping for what
*cites* a behaviour is part of removing it. And a latent unit mismatch surfaced while
fixing this: `lastTrackNote` stored a note-on's 0-127 velocity but the "naked instrument
number revives the last note" path reads it back as a 0-255 volume-column value, so a
revived note played at roughly half its recorded volume. Now converted on the way in.

**D55 — "Has an instrument id" does not mean "named an instrument" (second D53 regression).**
Also caught by ear, on the same passage as D54: GSLINGER.MOD pattern 2's flute echo was
still blaring after that fix.

`useTrackerSongBuilder` resets a note's velocity to 255 -- full scale -- when the row has
a note and `entry.instrument` but no volume column. The reasoning is sound for a song
authored here: a tracker resets the channel volume on an explicit instrument number, and
only preserves it when the row deliberately omits one. But `entry.instrument` cannot carry
that meaning for an imported module, because both importers stamp it onto *every* row of
a track so the builder knows which instrument a naked effect addresses. Every
sample-number-less note therefore looked like an explicit trigger. Channel 3's echo, which
plays at volume 11 against the lead's 24, came out at 64 on exactly those rows.

The branch was unreachable for MOD imports until D53, because mod-import used to stamp a
volume on every note row. Removing that stamp exposed it. It is now gated to native songs,
where `entry.instrument` really is explicit; for imported formats the importer already
writes a volume wherever the tracker resets one, so the *absence* of a volume is
meaningful and has to be respected. (It also reset to full, where a tracker resets to the
sample's default -- a second thing wrong with it for module playback.)

**Verify at the level the bug can occur at.** D53 and D54 were both verified by driving
`processEffectTick0` directly with a velocity, which passes whether or not the builder is
doing the right thing, and both shipped a regression that lived in the builder. The
regression tests for this now run a real `Step` from `useTrackerSongBuilder` through a
`PlaybackEngine` with recording handlers, which is the smallest harness that could have
caught any of the three. `engine.scheduleRow(row, time)` is directly callable, so this
costs very little; there is no excuse for asserting note volume anywhere shallower.

**D56 — A channel's selected sample outlives the pattern, so import must follow play order.**
Reported as a guitar in GSLINGER.MOD being silent when its pattern was played alone and
"way too low pitch, or maybe the wrong sample" when reached from the previous one. Both
symptoms, one cause.

ProTracker's bare sample number does not retrigger anything; it latches the sample for the
channel's *next* note (D29). That latch is **channel** state and outlives the pattern it
was set in. `buildTrackerPatterns` re-created it for every pattern, so a note written
without a sample number in the opening rows of a pattern resolved to no instrument at all.
GSLINGER channel 1 latches sample 24 at row 32 of one pattern and plays `D-2 ... C10` at
row 0 of the next with no sample number: the row imported with `instrument: undefined`, so
the engine's `if (!instrumentId) continue` dropped it outright when the pattern was
started cold, and fell back to `effectState.instrumentId` -- sample 4, a different guitar
-- when it was reached in sequence. 320 notes across 13 of the 28 modules in the local
corpus were resolving to nothing or to the wrong sample.

Patterns are now converted in **play order**, walking the order list, with the latch
carried across; patterns the order list never reaches are converted afterwards from a
clean latch so an orphan still imports. The result array is assigned by pattern index
rather than appended, because the order list indexes it.

Known approximation: a pattern played at several order positions inherits whatever the
*first* of those positions had, since one pattern converts to one object that every
position shares. Getting that exactly right means latching at playback time -- the engine
would need a per-track "selected sample" distinct from the "sounding instrument" that
`step.instrumentId` carries. Worth doing if a module turns up where it matters; note that
import-time resolution has a compensating virtue the playback-time version would lack,
which is that every pattern is self-describing and so plays correctly when started from
cold, which is what the pattern-at-a-time UI does.

**D57 — Autovibrato rides on `detune`, so it composes instead of competing.**
XM instruments carry their own vibrato (type, sweep, depth, rate), applied by FT2 on top
of whatever the effect column is doing to the period. 20 of the 219 corpus instruments
declare one and they account for 13.4% of all played notes (§6f), every one of which
played dead straight. The parser had read the fields since the start; nothing consumed
them.

Two choices worth recording.

**Where it composes.** Channel pitch is automation on the source's `playbackRate`, written
by portamento, 4xy and arpeggio. An instrument-level wobble on the same param would have
to be merged with all of them, in the effect processor, which does not know anything about
instruments. `AudioBufferSourceNode.detune` is a *separate* AudioParam that combines
multiplicatively with `playbackRate`, so the instrument's vibrato can be scheduled once at
note start and simply ride along. This is the same shape as the volume envelope's
dedicated gain stage (D31): give instrument-level modulation its own parameter rather than
teaching channel-level code about it.

**An oscillator, not unrolled automation.** FT2 advances the vibrato position by `rate`
each tick over a 256-step cycle, so a fast rate is only a few ticks per cycle; sampling
that per tick for the length of a note would mean thousands of automation events per
voice, as the envelope unrolling already does for its own reasons. An `OscillatorNode`
into a gain stage expresses the same LFO exactly, at two nodes, with the sweep as a linear
ramp on the gain. Type maps to the oscillator's own waveforms. The oscillator is given a
*scheduled* stop with its source as well as being disconnected by the deferred teardown --
it is connected to an AudioParam rather than to the output, so one that outlived its note
would be inaudible and accumulate silently.

**Depth calibration, stated because it is the risky part.** Depth is 0-15 in the song's
period units, converted here to cents at 100/64 per unit -- XM's linear table is
logarithmic in period, 64 units to a semitone everywhere, so the conversion is a constant
and depth 15 is about 23 cents. That is roughly an eighth of what the same nibble means to
a 4xy vibrato, which matches autovibrato being the subtler of the two. The Amiga frequency
table is *not* logarithmic in period, so there the same offset is a different interval at
every pitch and the constant is an approximation; worth revisiting against a reference
player if an Amiga-table module sounds off. Getting a depth scaling wrong is exactly the
class of bug D48 was, so this one is written down rather than left implicit.

**D58 — An instantaneous volume command must step, not ramp.**
Reported as 4-mat's "rose" playing perfectly until pattern 44 (order index 63), with the
trouble on track 2. That pattern is the **first in the whole song to use ECx** -- every
other effect and instrument in it has appeared many patterns earlier -- which is what
pointed at the note cut.

`TrackerSongBank.setVoiceVolumeAtTime` defaults to a linear ramp, and
`linearRampToValueAtTime` runs from the *previous* automation event. For a per-tick slide
that is the intended approximation: one ramp across the row instead of a write every tick.
For a command the tracker applies instantly it is wrong -- the change is smeared backwards
across the whole preceding row. Track 2's figure is `F-5`, a `309` tone portamento up to
`G-5`, then a short `G-4 .. EC2`; at the song's speed of 3 that cut lands on the last of
three ticks, so the note faded across its entire length instead of sounding and stopping.
The handler's own doc comment claimed it defaulted to "discrete setValueAtTime", so the
ramping default was never intended in the first place.

Volume commands can now ask for `'step'`, and the four instantaneous ones do: ECx note cut,
Cxx, the fine volume slides (EAx/EBx and the volume column's 0x8x/0x9x), and the level a
note starts at. Per-tick slides still ramp. `PooledInstrument` and `InstrumentV2` already
fell through to `setValueAtTime` for any unrecognised mode, so they needed only the wider
type; `ModInstrument` needed a real branch, which also cancels automation from that point
so a ramp already aimed past the cut cannot keep pulling the gain afterwards.

Checked and *not* changed while looking: the pitches on that track are exactly right --
`F-5`, `G-5` and `G-4` come out as Amiga periods 641, 571 and 1143, which are ProTracker's
160, 143 and 285 times four -- and the `309` slide reaches its target in the two ticks
available. Vibrato is used from order 0 of this song and sounds right, which is useful
independent evidence that the Amiga-mode vibrato depth (D48) is calibrated correctly.

**D59 — The XM frequency table never reached the engine, so every Amiga-mode slide was wrong.**
Reported as 4-mat's "rose" -- an Amiga-table module -- having a lead on track 2 that
"lands about a semitone short of where it's supposed to be".

`xm-import` read `xm.linearFrequency` from the parser and put it in its `console.log`
instead of the song data. `Song.linearFrequency` was therefore always undefined,
`profileForFormat` requires `linearFrequency === false` to pick `XM_AMIGA_PROFILE`, and so
**every XM played with the linear pitch model** regardless of what its header said. D24
built that profile and nothing ever selected it.

The reason this survived so long is the shape of the failure. Note frequencies are
resolved at *import*, with the correct model, and travel on the step as `frequency`. So
every note is perfectly in tune and the song sounds right until something slides: the
effect processor computes portamento, tone portamento, vibrato, arpeggio and glissando in
period space, and it had the wrong period space. Rose's `104` moved 0.5 of a semitone
(4 linear units a tick, 64 to a semitone) where its Amiga periods call for 0.886 --
and across the `20A`/`214` bend two rows later the landing was out by more than three
semitones. A tone portamento clamps to its target, which hides the error completely; a
plain `1xx`/`2xx` has no target, so its landing *is* the rate, which is why the symptom
appeared on exactly the patterns that use one.

Now carried the way `initialSpeed` is: song file -> store (with snapshot and
serialize/load) -> builder context -> `Song` -> engine. Absent means linear, XM's own
default, which is also what every song saved before the field existed was played as.

Two things worth taking from this. First, it is the fourth instance of the same class in
this document -- D34 (`trackerEnvelope` dropped by the sampler-state whitelist), D57 (the
same whitelist, avoided by testing through the normalizer), D55 (the builder's meaning of
`entry.instrument`) and now this: **a value that is read correctly, then dropped at a layer
boundary, while every layer looks right in isolation.** Second, the tell was that the
failure was *musical rather than structural* -- in tune but sliding the wrong distance.
Anything that resolves a value at import and also needs it at playback should be tested
end to end, at the engine, not at either end.

**D60 — Channel monophony is a format property, and a released voice has to stay killable.**
Reported as some songs letting a previous instrument's envelope release run on under a
new note. Two parts.

**The leak.** `dispatchNoteOffAtTime` releases the track's voice and then clears the
track's voice tracking. Clearing is right in one sense -- the voice is no longer what the
track is *playing* -- but it also made the voice **unkillable**, because both paths that
end a previous note on a new note (`trackVoiceOwner` and `gateOffPreviousTrackVoice`) find
their target through that tracking. So a keyed-off note went on sounding underneath the
next note for its whole fadeout, which on XM is measured in seconds.

It only bit when the channel changed *instrument*: `ModInstrument.noteOnAtTime` already
cuts a releasing voice sitting on the slot it is about to reuse (`stopReleasingVoice`), so
same-instrument retriggers were covered and the fault looked intermittent. Released voices
are now recorded per track in `trackReleasingVoices` and cut when the next note takes the
channel.

**The policy.** D41 made a replacing note *cut* the previous one, which is right for a MOD
or XM channel -- one voice, taken over, nothing survives -- and wrong for a song authored
here, where overlapping notes on a track are a feature. The bank now knows the song's
format (`setModuleFormat`, set from `loadSong` alongside the engine's own copy) and
branches: module formats cut, native releases and lets the note ring.

The default when no song has been loaded is native, matching `DEFAULT_MODULE_FORMAT` and
the engine's own default. It was briefly the other way -- reasoning that a note ringing on
under another is heard as a fault while an unnecessary cut is merely drier -- but the user
called it, and they are right: a song carrying no format tag *is* a native song, so any
other default is the bank quietly disagreeing with the rest of the pipeline about what it
is playing. Every real module sets the format from `loadSong` before a note is scheduled,
so the default is not load-bearing anyway.

**D61 — A sample number loads its volume even when the row is a tone portamento.**
Reported as nexus_seven.mod, UI pattern 6 (index 5), channel 1: "a ton of notes there, but
90% of them make no sound", and silent the same way with the pattern played alone and
every other track muted.

The channel alternates `C-3 12 3F0` against bare `A06` rows -- the pumped portamento
bassline, where each sample number reloads the sample's volume and each slide walks it back
down. The importer skipped the volume reload on tone-portamento rows, on the reasoning
(recorded in D15's comment and pinned by a test) that "3xx doesn't retrigger the sample, so
resetting volume there would be wrong".

That conflates two things ProTracker keeps apart. In `mt_PlayVoice` the sample-number
block, which writes `n_volume`, runs *before* the tone-porta check; that check only decides
whether the sample restarts and how the period is used. A sample number loads its volume
into the channel either way -- the same rule D15 already established for a *bare* sample
number, just never carried across to this case.

With no reload the `A06` rows could only subtract: the channel reached zero by row 3 and
every remaining note in the pattern was silent, since a tone portamento never retriggers
and so never brings a volume of its own. Traced through the engine the channel now pumps
58 -> 22 -> 58 instead of collapsing to 0 and staying there.

The instrument stamp stays suppressed on these rows (D29): reloading the volume must not
become a retrigger, and the row still has to address the voice that is already sounding.

Worth noting how it presented. The reporter's first reading was that "notes without an
instrument don't retrigger the previous instrument" -- and the imported pattern really does
show `..` in the instrument column on those rows. But the rows *do* carry sample 12 in the
file, and they are tone portamentos, which correctly never retrigger; nothing was wrong
with the triggering at all. The audible fault was entirely the missing volume reload, two
columns away from where it looked like it was.

**D62 — Panning envelopes offset the channel pan, and Lxx repositions both envelopes.**
The last two Phase 4 items. Panning envelopes are 20 of the 219 corpus instruments and
7.3% of played notes (§6f); `Lxx` has no corpus occurrences and is here for completeness.

**Why the panning envelope could not reuse the volume envelope's shape.** The volume
envelope gets a dedicated gain stage that *multiplies* with the channel volume, so the two
never have to know about each other (D31). Panning does not compose that way: two panners
in series are not the sum of their pans, and there is only one `pan` parameter. FT2 also
does not treat the envelope as a position -- it is an offset around the channel pan, scaled
by the room that pan leaves:

    final = pan + (envelope - 32) * (128 - |pan - 128|) / 32

so a centred channel can swing the whole field while a hard-panned one barely moves, and
the envelope can never push a channel past the edge. The consequence for the
implementation is that the pan parameter holds *pan and envelope already combined*, so a
mid-note pan command cannot simply write to it -- `setPan` re-derives the remaining
envelope around the new base, from the envelope tick the note has reached.

**Lxx** moves both envelopes' read position without touching the note. That needed
`scheduleTrackerEnvelope` to gain a `fromTick`: it sets the envelope's interpolated value
at that tick immediately and schedules everything after it relative to now. The same
parameter is what lets `setPan` rebuild a panning envelope mid-flight, so the two features
paid for each other.

`envelopeValueAtTick` interpolates between points, since a jump target rarely lands exactly
on one.

Both new sampler-state fields are named in the patch normalizer's whitelist, and the import
tests assert *through* `deserializePatch` rather than against the raw patch -- the D34/D57
trap, now guarded by habit rather than by memory.

**D63 — Without a volume envelope, XM key-off cuts; the fadeout is never heard.**
Reported on `elw-sick.xm`: at order 10 the pattern opens with key-offs on six channels,
and notes from the previous pattern carried on underneath instead of stopping.

FastTracker 2's `keyOff` branches on the volume envelope's enabled flag. With an envelope
it clears sustain and lets the envelope and fadeout run. **Without one it sets the channel
volume to zero on the spot** -- the instrument's `volumeFadeout` field still holds a value,
it is simply never audible, because the volume has already gone.

`toTrackerEnvelope` built an envelope out of the fadeout alone when the envelope was
disabled, on the (correct) observation that most corpus modules set a fadeout without
enabling an envelope. The conclusion was the wrong way round: that turned an instant cut
into `65536 / fadeout` ticks of fade, which for `elw-sick`'s fadeout of 128 is 512 ticks --
over ten seconds at its tempo, and clamped only by the 10-second release cap. `ModInstrument`
already did the right thing for an instrument with *no* envelope at all (a 10 ms de-click
ramp), so the fix is simply to stop manufacturing one.

68 of the 219 corpus instruments have the envelope off with a fadeout set. 90 key-offs land
on one, concentrated in `sweetdre.xm` (69) and `elw-sick.xm` (15) -- and each one was worth
up to ten seconds of a note that should have stopped instantly, on a 24-channel module.
Worth noting the second-order effect: notes that never stop also pile up in the mix, so
this was feeding the clipping the level meters had just made visible.

Third time a test has pinned the wrong behaviour with a plausible rationale attached
(D61, D59's F1 note, now this). The pattern is the same each time: a true observation about
the corpus, and a conclusion about semantics that does not follow from it. The corpus tells
you what is *common*, never what is *correct*.

**D64 — Two more sources of notes that would not stop, found by counting.**
Same report as D63 -- `elw-sick.xm` carrying sound between patterns -- but D63 only fixed
part of it. Rather than reason about the file again, this was found by **accounting**:
drive the engine over orders 0-16 and compare, per channel, the note-ons and note-offs it
emits against the notes and key-offs actually in the file. Every discrepancy is either a
bug or a rule worth being able to name.

**Key-offs opening a pattern were dropped.** `ctx.instrumentId` in the song builder only
remembers what the *current pattern* has played, so a `###` on a channel before that
channel's first note in the pattern resolved to no instrument, failed the "skip rows with
nothing on them" test, and never became a step at all. elw-sick is built out of patterns
that open exactly that way, clearing the tail of the one before: 31 key-offs in the file
produced 14 note-offs. The engine keeps its own per-track instrument *across* patterns, so
the row only has to survive the builder for it to resolve; it is now kept whenever it
carries a note or a note-off.

**Volume-column rows were reviving the channel's last note.** "A naked instrument number
revives the last note" is this tracker's own convention and no module format has it -- in
ProTracker and FT2 alike an instrument number alone selects the sample and reloads the
volume, never retriggering (D15, D29). It went unnoticed for MOD because mod-import stamps
a volume on such rows for unrelated reasons, which trips the function's velocity guard.
XM has no such accident, and once the volume column started producing steps for rows that
previously made none (D50), every row carrying nothing but a volume-column command revived
the last note: 26 spurious retriggers per channel on three channels, 18 on a fourth. Now
gated on the song being native, which is the only place the convention was ever meant to
apply.

After both, the accounting comes out clean: every remaining difference is a tone
portamento (which correctly does not retrigger) or a key-off on a channel that has never
played.

**Counting beats listening for this class of bug.** Three separate "notes that should have
stopped" reports (D60, D63, this) were all diagnosed from the same question -- does the
engine emit exactly the events the file asks for -- and the harness is a dozen lines on top
of `engine.scheduleRow`. Reach for it before reasoning about pattern data.

**D65 — A retrigger is a note-on, and was not being treated as one.**
Reported on `peacedroid.mod` patterns 16 and 17: noise on track 1 that lingers when new
notes trigger, and carries into the next pattern *through* the notes that follow.

Both patterns end their track-1 phrase on `E93 E92 E91` -- eight retriggers across three
rows at speed 6. `retriggerNoteAtTime` called the instrument's `noteOnAtTime` directly
with `allowDuplicate: true` and **no track index**, which skipped the entire
channel-replacement path. With no track index `ModInstrument.resolveVoiceForTrack` falls
through to `allocateAnyVoice()`, its round-robin pool, so each repeat took a *different*
voice from the one the channel owns. None of them was cut, and none of them ever could be:
`trackVoiceOwner`, `gateOffPreviousTrackVoice` and `trackReleasingVoices` all find their
target through the channel's voice mapping, and these were not in it. They were invisible
to every mechanism that stops a channel, which is exactly why a later note did not silence
them.

E9x and Rxy restart the sample from the beginning, so a retrigger simply *is* a note-on on
that channel. It now goes through `dispatchNoteOnAtTime` like any other, which gets the
cut, the ownership and the releasing-voice sweep for free.

Checked and correct, so not changed: the retrigger counts (1, 2 and 5 for `E93`/`E92`/`E91`
at speed 6, matching ProTracker's tick arithmetic) and the levels -- the phrase slides from
40 up to 55 under `A30` and back down to 35 under four rows of `A01`, and every retrigger
carries 35, because E9x leaves the channel volume alone. The reporter's suspicion that the
retriggers were resetting volume turned out to be the stacking heard from the outside:
each fresh voice started at the channel level while the previous ones kept going.

**D66 — Looping the song is a restart, so it starts from silence.**
Reported on `xyce-dans_la_rue.xm`: the last pattern fades out, and when the song loops a
sample is left looping that should not be there.

The fade is a *global volume* ramp -- channel 3 counts `G1F` down to `G00` over the final
pattern -- which turns the mix down without stopping anything. Eight channels are still
holding notes at the last row, on instruments 5, 7, 8 and 9: fifty-frame forward-looping
samples whose volume envelopes have no sustain point, no loop, and a final point above zero
(5 and 10 of 64). Such a note runs to the end of its envelope, holds there, and loops its
sample forever; fadeout only applies after a key-off and there is none. The first pattern
then opens with `G80`, restoring the volume and bringing all of it back.

**FastTracker 2 behaves identically**, so this is not a fidelity fix. A song written to fade
out is not written to loop, and the composer ended it with the fade. The judgement is that a
player looping such a song should restart it rather than run over the top of itself.

The wrap now stops every voice, clears per-track effect state and restores the global
volume. The second reason is plainer than the first: without it a second pass does not
sound like the first, because effect state and global volume carry over -- which is a
correctness problem regardless of any particular song.

`cutAllVoicesAtTime` sweeps voice *indices* rather than the tracking maps, deliberately: a
voice the maps have lost sight of is exactly the kind that needs catching (D65 is what
happens when one escapes them). It is scheduled rather than immediate, because the engine
decides this while scheduling ahead and "now" still belongs to the previous pass.

Known cost, accepted: a song that loops seamlessly with a note held across the boundary now
has that note cut.

**D67 — The per-track waveforms were showing the instrument, not the track.**
Reported as the waveform strips above each track being "very inaccurate".

They read `songBank.getInstrumentOutput(instrumentId)`. One MOD sample is one instrument
here, and an instrument is shared by every channel that plays it, so that node carries the
*sum* of every track using it. Two channels on the same sample drew identical waveforms,
each showing both; a channel's display jumped to an unrelated mix the moment it changed
instrument; and a channel showed sound it was not making.

There is no per-track node in the graph to read instead -- the mixing happens inside the
instrument -- so one had to be created. Each voice now connects to a per-track tap
(`getTrackMonitor`) in addition to its instrument's output, taken after panning so the tap
shows what the channel actually sounds like. The taps end in a zero-gain node wired to the
destination: a branch ending in nothing is not guaranteed to be processed, and this
guarantees it at no audible cost.

Only `ModInstrument` routes per voice, so `getTrackVisualizationNode` keeps the old
instrument-output behaviour for other instrument types rather than showing a flat line for
native songs.

**D68 — A key-off releases the channel, not the instrument named on the row.**
Reported on `xyce-dans_la_rue.xm`: a note from order 27 bleeds into order 28, where row
`0C` has a key-off that "seems to have no effect -- the note just keeps playing at full
volume".

The row is `=== 11` on channel 1, and the 11 is an **instrument number**, not a volume. XM
rows carry one alongside `===` routinely: in FT2 it selects the sample for the channel's
*next* note and has nothing to do with what is being released. Channel 1 had been holding a
note from an earlier pattern on **instrument 10**.

Two consequences, both fixed:

- The note-off was routed to instrument 11, which has nothing sounding on that channel, so
  the held voice was never released. `dispatchNoteOffAtTime` now asks `trackVoiceOwner`
  which instrument actually owns the channel's voice, and only falls back to the row's own.
- `xm-import` stamped the instrument onto the key-off row, so `effectState.instrumentId`
  switched to 11 and *every per-voice effect after it* went the same wrong way. The rows
  before the key-off are `62` volume-column slides meant to fade the note out; they were
  landing on instrument 11 too, which is why the note stayed at full volume rather than
  merely failing to stop. Only a row that starts a note now switches the channel's
  instrument -- exactly the rule mod-import has followed since D29.

Traced after the fix, the slides run 64 → 48 across rows 8-11 and the key-off lands, both on
instrument 10.

Third time D29's rule has had to be re-derived somewhere else (D56 for the MOD latch, D55
for the builder, now XM key-offs). **Only a row that starts a note changes what a channel is
playing** is worth stating once as a rule of the pipeline rather than rediscovering per
format.

### D69 — The row cursor has to restart at a pattern boundary; E6x is a countdown

Both found in xyce-dans_la_rue.xm, at the transition the user pointed at (order 37, the
pattern after a 96-row one), by walking the whole order list and asserting that every
pattern gets its own rows starting at 0.

```
seq 36 pattern 28: rows 0..95 count=96 expected=96
seq 37 pattern 29: 0,33,34,35,...,63          <- 32 rows missing
seq 18 pattern 15: 0,33,34,35,...,63          <- same shape
```

**The cursor.** `scheduleAhead` counts `lastScheduledRow` monotonically and folds it into a
row with `actualRow = currentRow % this.length`. On a pattern boundary it loaded the next
pattern but left the cursor where it was, so the first row of the new pattern was
`oldLength % oldLength = 0` — right — and the *second* was `(oldLength + 1) % newLength`.
That is only row 1 when the two patterns are the same length. After the 96-row pattern:
`97 % 64 = 33`. After a 32-row one: `33 % 64 = 33`. Both jumped to exactly row 33, which is
what made it look like a shared cause rather than a length coincidence.

Every module in the corpus that sounded right was one where consecutive patterns happened to
share a length. The fix is to reset the cursor to `-1` and re-enter the loop, so the row is
derived from the pattern actually playing.

**E6x.** The loop-back was written as a tally counting up toward a target:

```ts
if (this.patternLoopCount === 0) { this.patternLoopTarget = loopCount; this.patternLoopCount = 1; }
// later, after scheduling the row:
this.patternLoopCount++;
if (this.patternLoopCount <= this.patternLoopTarget) { /* jump */ } else { /* reset */ }
```

With `E61` — one repeat, the common case — the count goes 1 → 2, `2 <= 1` is false, and it
resets **without ever jumping**. The section simply plays once and the effect is silent, so
nothing in the corpus flagged it. Counting up cannot work in general either: the jump lands
back on a row that re-arms the effect, so a tally either never jumps or never stops.

ProTracker and FT2 both keep a single countdown instead: the first visit to `E6x` loads the
counter, every later visit decrements it, and the jump happens while it is still above zero.
That terminates because the row that re-arms is the same row that decrements. `patternLoopTarget`
is gone, replaced by `patternLoopPending` — "the row just scheduled owes a jump back".

Pattern 15 now plays rows 0-31 twice before continuing to 32, which is what its
`E60`/`E61`/`E60` triplet asks for.

### D70 — Global volume is effect state and has to be reset with the rest

Second bug the user reported on the same song: *"whenever I start the song after having
stopped it, the volume is really low."*

`globalVolume` was reset in exactly one place — `restartSong`, added by D66 for the sequence
wrap. `resetEffectStates()`, which runs on stop and on load, cleared every other effect
state and left this one. xyce fades out with `G00`, so stopping anywhere near the end left
the field at ~0; pressing play started from the stored sequence position, and with no `Gxx`
between there and the next one, nothing restored it.

Gxx/Hxy are per-song effect state exactly like vibrato memory or the loop counter. Reset
moved into `resetEffectStates()`, which makes `restartSong`'s own line redundant but
harmless — it keeps the handler call that pushes the value to the audio graph.

### D72 — The song's global volume scales the user's master level, it does not replace it

Reported as *"sweet dreams got super loud and clipping like crazy when it restarted."*

sweetdre.xm has **no `Gxx` at all**, every pattern is 64 rows, and no `E6x` — so neither
D69 nor D70 touches it. The cause is older: `songBank.setMasterVolume()`, the only consumer
of `scheduledGlobalVolumeHandler`, wrote its argument straight onto `masterGain`:

```ts
this.masterGain.gain.setValueAtTime(clamped, when);   // ignores userMasterVolume
```

The user's master level was 50%, and with no `Gxx` in the song nothing touched the gain
while it played. Then D66's restart pushed global volume `1.0` on the sequence wrap — and
that landed as an absolute `1.0`, doubling the level. On 24 channels it clipped hard.

Two independent quantities had been sharing one field. The song's global volume says how
loud this moment is relative to the rest of the song; the user's master says how loud the
app is. What reaches `masterGain` is the product. `songGlobalVolume` is now tracked
alongside `userMasterVolume`, every write multiplies them, and `resetMasterVolumeToBaseline`
clears the song's half back to 1.

Worth noting the bug was latent long before the restart made it audible: any module using
`Gxx` already overrode the user's setting outright — `G40` forced the master to 0.5 whatever
the slider said. D66 only made a *silent* song do it too, which is what made it loud enough
to notice.

### D73 — Ultimate Soundtracker is a different format wearing the same layout

lepeltheme.mod, reported as *"track 1 on the first pattern sounds wrong"*. Channel 0 carries
`137` on **all 64 rows** — as ProTracker that is portamento up at 55 units per tick, which
runs the pitch off the top of the range and never stops.

The parse was faithful; the bytes really are `01 37`. What is wrong is the assumption that a
15-sample module uses ProTracker's command numbering. Two measurements settled it:

**The effect histogram.** The module uses command `1` and *nothing else* — no `C` volume, no
`F` speed, no `D` break. A ProTracker or NoiseTracker module essentially always uses `C` and
`F`. And the parameters are `0x47`, `0x37`, `0x59`, `0x58`: major triad, minor triad, sixth,
fifth. Those are arpeggio chords, not slide rates.

**The loop offsets.** Every looped sample overruns its own length when loopStart is read as
words and fits *exactly* when read as bytes:

```
lepeltheme sample 2: len=8800 rs=3326 rl=4970   words -> 11622 (over)   bytes -> 8296
```

So Ultimate Soundtracker (Obarski, 1987) differs from every later tracker in two ways, and
declares neither — it shares the signature-less 15-sample layout with the other early
Soundtrackers:

1. **Arpeggio is command 1.** ProTracker moved it to 0 and gave 1 to portamento up.
2. **Sample loop start is a byte offset**, not a word offset.

Both are detected from the data, separately, because a given module only carries evidence for
what it uses: one with no looped samples cannot show the second, one with no effects cannot
show the first. Either is taken as proof and both behaviours then apply — harmlessly, where
there is nothing to apply them to.

**The over-detection risk is the real constraint**, and jackdance.mod is what pins it: a
15-sample module that uses command `0` with exactly the same arpeggio parameters. It is a
*later* Soundtracker, and remapping it would delete every arpeggio it has. So the command
test requires command 0 to be entirely unused, not merely that command 1 is present. Across
the ten 15-sample modules in the collection this classifies six as Ultimate Soundtracker
(amegas, blueberry, crystalhammer, lepeltheme, pretend, sleepwalk) and leaves AXELF,
jackdance and telephone as later Soundtracker — and no module in the corpus loops past the
end of its own sample any more, which is asserted over the collection.

One part is not established from the corpus: command `2` is a pitch bend whose direction
depends on which nibble is set, and which nibble means which way appears five times in one
module. Either reading beats leaving it as ProTracker portamento down, where a parameter of
`0x80` is a slide of 128 units per tick.

**A note on the corpus rule.** D55/D64 recorded that "the corpus tells you what is common,
never what is correct". This is the inverse case and worth stating alongside it: here the
corpus was the *only* available evidence, because the format carries no declaration of
itself. What made that sound rather than circular is that the two signals are structural and
independent — a loop that overruns its sample is wrong under any interpretation, and it
agreed with a command histogram derived separately.

### D74 — Vibrato ran with an inverted phase, and reset to centre every row

jt_911.xm, reported as *"pattern 21 sounds a bit out of tune... it seems like 400 will
increase pitch, is that correct? isn't 4 vibrato?"*

`4xy` is vibrato and `400` continues it with the remembered speed and depth — the module
writes one `41F` and then **2172** `400` rows to hold it. The observation was exactly right,
and it pointed at two separate faults.

**The phase was inverted.** ProTracker and FT2 both branch on the sign of the vibrato
position and *add* the delta to the period while it is positive, so the first half of the
wave bends the pitch **down**. This subtracted instead, raising it. On a fast vibrato that is
inaudible — it only shifts the phase. But pattern 20 (order 11) holds `41F`: speed 1, depth
15, a cycle about ten rows long. Inverted, that leaves the channel nearly two semitones sharp
for five rows while other channels hold the chord.

Worth noting the tremolo directly below it in the same file has always added its offset to
the volume, which is the same convention. Period being inverted relative to pitch is what
made the vibrato look right.

**The wave reset to centre once a row.** `processEffectTick0` ends with a fallback that emits
the base frequency if nothing else emitted a pitch, to keep schedulers in sync. On every
`400` row that is the bare, un-offset pitch, so tick 0 snapped the vibrato back to centre
before it resumed on tick 1 — a sawtooth rather than a wave, once per row, at a depth of
nearly two semitones. Tick 0 now re-states the current vibrato offset. The position only
advances on later ticks, so this restates the value rather than moving it, and the wave is
continuous across the boundary.

Measured over sixteen rows, in cents from the base:

```
before:  0 +18 +36 +54 +71 +88 | 0 +104 +118 ...      (up first; reset each row)
after:   0 -18 -36 -54 -71 -88 | -88 -104 -118 ...     (down first; continuous)
```

The depth itself was already right: ±187 cents for depth 15 is what FT2's own formula gives
(255 x depth / 32 in linear units, 64 units to a semitone).

**Two tests had pinned the inverted sign** — the fourth time in this project that a test
recorded a real measurement with the wrong conclusion drawn from it (D55, D61, D63). They
asserted the correct *magnitude*, 15.9375 period units, which is what they were written to
check; the direction rode along unexamined. Fixing one of them also surfaced that its note,
C-1, sits on ProTracker's longest period, so bending down from it clamps: it now measures the
upward half and says why.

### D75 — A vibrato holds its offset through empty rows

Follow-up to D74, same song: *"at pattern 16 I have the same pattern with 41f 400 and it goes
out of tune badly, I think the vibrato is either too slow or too deep."*

**The depth is right, and the XM spec settles it.** The format doc gives
`Frequency = 8363*1712/Period` for the Amiga table, so XM's Amiga period for C-4 is 1712
where ProTracker's is 428 — exactly four times. `portamentoUnitScale: 4` is therefore correct
for the Amiga path, and since FT2 runs one vibrato formula against both tables it is correct
for the linear path too. The doc's `Period = 10*12*16*4 - Note*16*4` also confirms our 64
units per semitone. Depth 15 really is about ±187 cents.

**What was wrong is the rows in between.** Pattern 15 (order 7, shown as "Pattern 16") writes
`41F` on row 0 and then `400` only every *fourth* row, with the rows between completely
empty. FT2's effect handler returns early on an empty cell and never writes the channel
period, so the vibrato simply holds its offset there.

`processEffectTickN` already did the right thing — an empty cell emits nothing, so the pitch
stays. `processEffectTick0` did not: its "emit at least one pitch to keep schedulers in sync"
fallback wrote the bare note pitch, so every empty row sprang back to centre. D74 fixed that
for rows carrying `400` but not for rows carrying nothing, which is three rows out of four
here:

```
before:   0 -18 -36 -54 -71 -88 | 0 | 0 | 0 | -88 -104 ...
after:    0 -18 -36 -54 -71 -88 | -88 | -88 | -88 | -88 -104 ...
```

Because the position keeps creeping while the note holds, the size of that spring-back grows
with it — by row 12 it was jerking most of a tone, four times a bar, against two other
channels playing the same note without vibrato. That is the "badly out of tune".

A cell carrying some *other* effect still re-states the note, which is the conservative
reading, and a new note always starts from its own pitch so the hold cannot outlive it.

**Ruled out while looking**, both worth recording so they are not re-examined: pitch commands
resolve to a voice per channel via `lastTrackVoice`, so the vibrato on channels 3-4 was never
reaching the doubled channels 5-6; and the `C4`/`CC` in those cells is the volume column's
`$c0-$cf` set-panning range, not a volume.

### D76 — Running out of instrument slots plays the wrong sample, silently

radix_-_yuki_satellites.xm, reported at the order 23 -> 24 boundary: *"there are some weird
sounds on track 2, it sounds like either a completely wrong sample or some misbehaving
effect"*, then *"it sounds to me like it's simply playing the wrong sample on that track"* —
which is exactly what it was.

Driving the engine across the boundary and logging track 2:

```
order 24 row 4:  NOTE trk=1 noteOn ins=01 midi=89 vel=127
```

The file says `F-6 72`. The note is right (midi 89 is F-6); the instrument is **01**, which is
what the *previous* pattern was playing.

`TOTAL_SLOTS` was 65. This song references **98** instruments and declares 117. The import
allocates a slot per referenced instrument and, on running out, logs a warning and drops the
rest — and a note whose instrument was dropped is emitted with no instrument at all, so the
channel simply keeps the sample it already had. The song plays on, in tune and in time, with
the wrong sound on a third of its instruments and nothing to say so.

The 65 came from measuring the corpus: the busiest module then to hand referenced 42. That is
the trap. **A capacity sized to what has been measured fails silently the first time
something exceeds it**, and this failure mode is quiet by construction. It is now sized to
XM's own maximum instead — 26 pages of 5 is 130, which no valid XM can exceed. Empty slots
cost an object each and audio resources are allocated per *used* instrument, so the headroom
is close to free. The page selector wraps.

A test asserts both halves: that the capacity covers the format's 128, and that every XM in
the collection fits inside it — the second so a future module that would have overflowed
shows up as a failure rather than as a wrong sample.

**Ruled out on the way**, recorded so they are not re-examined: the sample decodes correctly
(instrument 72 is one of 90 sixteen-bit samples in this song, and comes out as clean audio);
no instrument in the file uses a multi-sample keymap; and the tone portamento ending the
previous pattern is cleared by the new note, so it was not sliding across the boundary.

### D77 — A tone portamento row must not stamp the channel's instrument (XM)

"im in love with you", reported as one note in the lead landing off pitch: *"f-5 to g-5 with
101 and 307 effects, this doesn't land at the correct pitch."*

Driving the engine over the rows shows it, in the instrument the commands are addressed to:

```
row 0x1E   NOTE noteOn ins=04 midi=77      pitch ins=04 697.70 -> 710.41
row 0x1F   pitch ins=01 710.41 -> 728.59 -> 747.24 -> 766.37 -> 783.15
```

The slide is *correct*, note for note, and ends exactly on G-5. It is simply addressed to
instrument **01** — the number written on the tone-porta row — while the voice belongs to
**04**. `setVoicePitchAtTime` resolves a voice through `lastTrackVoice` keyed by instrument,
finds nothing for 01 on that channel, and returns. The lead stays where the preceding `101`
left it.

`xm-import` stamped `entry.instrument` on any row carrying an instrument number.
`mod-import` has excluded tone portamento since **D55**, for exactly this reason: `3xx`/`5xy`
slide the voice already sounding rather than starting a new one, so the row's instrument must
not become the channel's. FT2 reloads the volume from it and goes on playing the current
sample. The rule simply never reached the XM path — D68 added the key-off exclusion there
without the tone-porta one beside it.

Excluded now for `3xx`, `5xy`, and the volume column's own `0xFy` tone portamento.

**Fifth time this rule has been re-derived somewhere else** — D29 (MOD latch), D55 (builder),
D68 (XM key-off), and now XM tone porta. It is worth stating once as a property of the
pipeline rather than per format: *only a row that starts a note changes what a channel is
playing, and every per-voice command must address the voice that is sounding.* The remaining
gap is that `setVoicePitchAtTime` and `setVoiceVolumeAtTime` still resolve by instrument
first and fall back to the track, where `dispatchNoteOffAtTime` resolves by track outright
(D68). Making them all resolve by channel would make this class unrepresentable instead of
fixable case by case.

**Found and fixed on the way, but not this bug** (recorded because the reporter was right to
push back): oversampling clamped its kernel at the buffer edges, which is wrong for a looping
sample and left a step at the loop seam — 0.17 on this song's 66-frame single-cycle
waveforms, against 2e-5 through the middle, so a buzz at every note's own pitch. Real, and
worth fixing, but it was *every* note rather than this one.

### D71 — Open: EEx repeats one time short

Turned up while re-pinning `engine-pattern-delay.spec.ts`, which had been asserting on
`lastScheduledRow` — a value the D69 fix legitimately changes, since the cursor now restarts
at each boundary. Rewritten to record the rows actually scheduled, which is what the test was
always about.

Doing so made the repeat count visible: `EE2` yields **two** plays of the row, where
ProTracker plays it `param + 1` times. The counter is decremented before the row that would
have been its last repeat. Not fixed here — it is unrelated to the two reported bugs and
touches timing on every module that uses `EEx` — but pinned in the test so changing it is
deliberate.

---

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

**Correction (2026-08-29).** Three entries in the "confirmed wired correctly" list above
were confirmed *reachable*, not *correct* — the audit traced dispatch, and stopped at the
point where an effect touched an AudioParam without checking what value it wrote. ECx
reached the engine and released the note where it should have zeroed the volume (D49);
E4x/E7x reached the waveform state and discarded the "don't retrigger" bit with `& 3`;
Rxy reached the retrigger handler with no parameter memory. Tracing reachability is not
the same test as checking the number, and §6e is the audit that does the second one.

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

**F1 — Amiga-mode XM is common, not exotic: 4 of 9 files.** ✅ **Resolved** — see D24,
and D59: the model was built by D24 but nothing selected it until then, because the header
flag stopped at the importer's console.log.
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

## 6d. Demo song browser

The app can load modules published alongside it. `scripts/build-demo-manifest.mjs` stages
a collection and writes `demos/index.json`, parsing each module for its real title and
channel count rather than trusting filenames. `scripts/publish-demos.sh` uploads it;
`scripts/deploy.sh` builds and deploys the app.

Two things that are load-bearing rather than incidental:

- **The app deploy must pass `--exclude=demos/`.** It uses `rsync --delete` on the same
  directory, so without the exclusion every deploy would wipe the collection.
- **`publish-demos.sh` must pass `--chmod=D755,F644`.** The staging directory comes from
  `mktemp -d`, which is 0700, and plain `rsync -a` carries that to the server. The web
  server can then stat the directory but not traverse it, serving 403 for the directory
  and 404 for every file in it — which is exactly what happened first time.

The modules are third-party music and several megabytes of it, so they are deliberately
outside the repository and outside the Quasar build. The browser treats a missing manifest
as an expected state, not an error.

---

## 6e. Effect usage measured across both corpora (2026-08-29)

Counted from the raw files rather than after import, so the figures say what the music
actually asks for and can be used to rank work by audible impact. 26 modules in
`~/Downloads/mods/amiga`, 9 in `~/Downloads/mods/ft2`.

| Effect | MOD | XM | Note |
|---|---|---|---|
| Cxx set volume | 35244 | 951 | |
| Axy volume slide | 30953 | 8900 | |
| 4xy vibrato | 6880 | 14615 | depth was wrong at every pitch (D48) |
| 6xy vibrato + vol | 5275 | 1626 | |
| 0xy arpeggio | 4338 | 5973 | |
| 3xx tone porta | 4277 | 4205 | |
| 8xx panning | 54 | 12386 | |
| 9xx sample offset | 2087 | 2775 | every XM one was wrong (D46) |
| EBx fine vol down | 2068 | 2414 | |
| ECx note cut | 0 | 3693 | faded instead of cutting (D49) |
| E5x set finetune | 0 | 840 | a semitone sharp on XM (D51) |
| 7xy tremolo | 546 | 0 | 4× too weak (D48) |
| E1x/E2x fine porta | 114 | 3 | wrong unit (D48) |
| Gxx global volume | 0 | 257 | |
| E9x / Rxy retrigger | 55 | 42 | no Rxy memory |
| EDx note delay | 140 | 264 | |
| E6x pattern loop | 8 | 3 | |
| EEx pattern delay | 2 | 0 | |
| Txy tremor, Xxy, Lxx, Pxy | 0 | 0 | |

XM volume column, which was dropped wholesale before D50:

| Command | Cells |
|---|---|
| `Cx` set panning | 5602 |
| `8x` fine volume down | 2699 |
| `9x` fine volume up | 322 |
| `7x` volume slide up | 201 |
| `Ex` pan slide right | 124 |
| `6x` volume slide down | 122 |

Two things worth carrying forward. First, the two formats rank effects very differently —
`8xx` is 54 commands in the MOD corpus and 12386 in the XM one, `ECx` is 0 and 3693 — so
"rare enough to skip" has to be asked per format. Second, an effect being absent from the
MOD corpus is exactly how a bug survives a MOD-only audit; see the correction in §6b.

The counting scripts were throwaway (`modstat`/`xmstat`/`offseterr` in the session
scratchpad) and are not checked in; the numbers are reproducible from the file formats.

---

## 6f. What is actually left in XM, measured (2026-08-29)

Counted with the real parser over all nine corpus modules — 219 instruments, 72172 played
notes — after the volume column landed, to decide what to do next rather than work down
the phase list in order.

| Gap | Instruments | Notes affected | Status |
|---|---|---|---|
| Autovibrato | 20 | 9683 (13.4%) | parsed, dropped at import |
| Panning envelope | 20 | 5261 (7.3%) | parsed, dropped at import |
| Multi-sample keymap (D26) | **0** | **0** | not exercised at all |
| `Lxx` set envelope position | — | 0 | unparsed |
| `Pxy` panning slide (D52) | — | 0 | shadowed by the macro-3 shorthand |

**F4 — D26 is not the blocker this document called it.** Not one instrument in the corpus
maps more than one sample across its keymap, and not one stores more than a single sample.
The "largest known gap in XM fidelity" label it carried (repeated in the status header
until now) was inherited from the format's capabilities rather than measured against real
files. It stays on the list — a sample library or a drum-kit instrument would need it —
but behind the two envelope features.

**F5 — The two envelope gaps are cheap.** `formats/xm.ts` already reads `vibratoType`,
`vibratoSweep`, `vibratoDepth`, `vibratoRate` and `panningEnvelope`; `xm-import.ts`
consumes none of them. The volume envelope (D31, D38) is the working template for the
panning one, and it already has a per-voice stage to hang automation on.

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
- *Reachability* is not correctness. D46/D48/D49 were all effects that reached the right
  handler and wrote the wrong number, and §6b's audit passed them for that reason. Where
  a tracker defines an effect arithmetically (period units, volume units, a table peak, a
  nibble convention), assert the arithmetic against the format's own formula rather than
  against what the code currently produces.
- Count the effect in the corpus before deciding it is too rare to fix, and count it *per
  format* — §6e has entries that are 0 in one corpus and in the thousands in the other.
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
| 2026-08-30 | fix | **A tone portamento row no longer stamps the channel instrument in XM** (D77). `3xx`/`5xy` slide the sounding voice, so the row's instrument number must not become the channel's — stamping it addressed the slide to an instrument with no voice on that channel and it was dropped, leaving the lead where the previous row left it. mod-import has excluded this since D55; the fifth place this rule has had to be re-derived. 893 green. |
| 2026-08-30 | fix | **Filter kernels wrap a loop instead of clamping** (D77 aside). Oversampling clamped at the buffer edges, right for a one-shot sample and wrong for a looping one: on 66-frame single-cycle chiptune waveforms it left a 0.17 step at the loop seam against 2e-5 through the middle — a buzz at every note's pitch. |
| 2026-08-30 | fix | **Instrument slots sized to XM's maximum, not to the corpus** (D76). radix_-_yuki_satellites.xm references 98 instruments against a limit of 65; the import dropped the rest, and notes referencing a dropped instrument carry none at all, so the channel kept playing its previous sample — a wrong sound on a third of the song, with nothing reporting it. Now 130 slots, covering the format's 128, with a test that every XM in the collection fits. 845 green. |
| 2026-08-30 | fix | **A vibrato holds its offset through empty rows** (D75). FT2 leaves the channel period alone on a cell carrying no effect, so a vibrato keeps its offset; tick 0's sync fallback wrote the bare note pitch instead. jt_911.xm writes `400` only every fourth row, so three rows in four sprang back to centre — by a growing amount, against two channels doubling the same note. The depth itself is confirmed correct against the XM spec's own `8363*1712/Period`. 828 green. |
| 2026-08-30 | fix | **Vibrato bends down first, and holds across rows** (D74). Both ProTracker and FT2 add the offset to the period while the position is positive; this subtracted, inverting every vibrato's phase. And tick 0 of a continuing `400` row emitted the bare base pitch, resetting the wave to centre once a row. jt_911.xm holds `41F` (speed 1, depth 15) over a ten-row cycle across 2172 `400` rows, so both were plainly audible. Two tests had pinned the inverted sign. 826 green. |
| 2026-08-30 | fix | **Ultimate Soundtracker read as its own format** (D73). Arpeggio is command 1 there, not 0, so lepeltheme.mod's `137` minor triad on all 64 rows of a channel played as a runaway portamento; and sample loop starts are byte offsets, so every looped sample looped past its own end. Both detected from the data, with jackdance.mod (command 0 arpeggio, 15 samples) pinning the over-detection boundary. Tests: `src/tests/mod-ultimate-soundtracker.test.ts`. 824 green. |
| 2026-08-29 | fix | **Song global volume now scales the user's master level** (D72). `setMasterVolume` wrote `Gxx` values absolutely, so D66's restart pushing global volume 1.0 overrode a 50% master setting — sweetdre.xm (24 channels, no `Gxx`) clipped hard on every loop. Latent for any `Gxx` module before that. Tests: `src/tests/tracker-song-bank-master-volume.test.ts`. 702 green. |
| 2026-08-29 | fix | **Patterns start at row 0 again, and `E6x` actually loops** (D69). The row cursor is folded into a row with `% length` but was carried across pattern boundaries, so a pattern following one of a different length started partway in — after xyce's 96-row pattern, order 37 played row 0 then jumped to row 33 (`97 % 64`). Separately `E6x` counted up toward a target and reset without ever jumping, making pattern loops silent. Both now match ProTracker. Tests: `src/tests/tracker-sequence-walk.test.ts`. 698 green. |
| 2026-08-29 | fix | **Global volume resets on stop** (D70). `Gxx` state lived only through `restartSong`, so stopping during xyce's closing `G00` fade meant the next play started near-silent with nothing to restore it. Moved into `resetEffectStates()`, alongside every other effect state. |
| 2026-08-29 | fix | **A key-off follows the channel, not the instrument on the row** (D68). `=== 11` names the sample for the channel's *next* note; routing the release there sent it to an instrument with nothing playing, and stamping it re-routed the volume slides that were meant to fade the note out — so it neither faded nor stopped. 689 green. |
| 2026-08-29 | ui | **Per-track waveforms now show their own track** (D67). They read the instrument's output, which one sample-per-instrument makes shared across every channel playing it — so channels on the same sample drew each other's audio. Voices now also connect to a per-track tap. Tests: `src/tests/tracker-track-monitor.test.ts`. 685 green. |
| 2026-08-29 | fix | **Looping the song now restarts it** (D66) — voices stopped, effect state cleared, global volume restored. xyce-dans_la_rue.xm fades out with `Gxx` and opens with `G80`, so the eight channels still holding looping samples came back at full volume on the wrap. FT2 does the same, so this is a player decision rather than a fidelity fix; it also makes a second pass sound like the first. 678 green. |
| 2026-08-29 | fix | **A retrigger now takes the channel like any other note** (D65). `retriggerNoteAtTime` passed no track index, so `E9x`/`Rxy` repeats were allocated from the instrument's round-robin pool instead of the channel's own voice — invisible to everything that cuts a channel, so they stacked and played on through later notes. peacedroid.mod patterns 16 and 17 end on `E93 E92 E91`, eight repeats in three rows. 671 green. |
| 2026-08-29 | fix | **Dropped key-offs and spurious retriggers** (D64), found by counting the engine's note events against the file. A `###` opening a pattern was dropped by the builder when that channel had not played yet in the pattern (31 key-offs → 14 note-offs), and every XM row carrying only a volume-column command revived the channel's last note — a native-only convention that D50 made reachable. 665 green. |
| 2026-08-29 | fix | **A key-off on an instrument with no volume envelope now cuts** (D63). The importer built an envelope out of the fadeout alone, turning FT2's instant cut into up to ten seconds of fade — 68 of 219 corpus instruments, and the reason `elw-sick.xm`'s order 10 had the previous pattern still sounding under it. 661 green. |
| 2026-08-29 | ui | **Stereo peak meter beside the instrument list.** dBFS scale with 0 dB marked, peak hold, and a latching CLIP readout, so headroom is visible rather than guessed. Trackers do not limit (FT2 clamps, Paula sums in analog), so a busy module genuinely can run over. Arithmetic in `level-meter-math.ts` with its own tests. |
| 2026-08-29 | 4 | **Panning envelopes and Lxx implemented** (D62) — the last two Phase 4 items. The panning envelope is an offset *around* the channel pan scaled by that pan's headroom, not an absolute position, so the pan parameter carries both combined and `setPan` re-derives the remainder around a new base. `Lxx` repositions both envelopes, via a `fromTick` on the envelope scheduler that the panning rebuild also uses. Tests: `src/tests/xm-panning-envelope.test.ts`. 647 green. |
| 2026-08-29 | fix | **A sample number reloads its volume on a tone-portamento row too** (D61). The reload was skipped there, so nexus_seven.mod's pumped portamento bassline could only slide down: the channel hit zero within four rows and every remaining note in the pattern was silent. ProTracker writes `n_volume` from the sample number before it checks for tone porta; that check only governs the retrigger. 637 green. |
| 2026-08-29 | fix | **A new note on a module channel now kills everything the channel was sounding** (D60). A key-off released the voice and then cleared the track's voice tracking, which made it unkillable — so a released note rang on under the next one for its whole fadeout whenever the channel changed instrument. Released voices are tracked per track and cut by the next note. The bank also learns the song's format: module channels cut on replacement, native songs release and let the note ring. Tests: `src/tests/tracker-channel-monophony.test.ts` (3 of 7 confirmed failing against the old code). 634 green. |
| 2026-08-29 | fix | **The XM frequency table now reaches the engine** (D59). `xm-import` put `linearFrequency` in a console.log rather than the song data, so `profileForFormat` never selected `XM_AMIGA_PROFILE` and every Amiga-table XM computed its pitch *effects* in linear period space — in tune, but every slide moving the wrong distance. Roughly half of real XM files are Amiga-table. Found via 4-mat's "rose". Tests: `src/tests/xm-amiga-frequency-table.test.ts`. 627 green. |
| 2026-08-29 | fix | **Instantaneous volume commands step instead of ramping** (D58). A scheduled volume change defaulted to a linear ramp, which runs from the previous automation event — so ECx, Cxx and the fine slides were smeared backwards across the preceding row. Found via 4-mat's "rose", whose pattern 44 is the first in the song to use ECx: track 2's short `G-4 .. EC2` notes faded across their whole length at speed 3. 621 green. |
| 2026-08-29 | 4 | **XM autovibrato implemented** (D57) — instrument-level vibrato, 13.4% of corpus notes, parsed since the beginning and never consumed. Runs as an OscillatorNode into the source's `detune`, which composes with the channel's `playbackRate` automation instead of fighting it. Tests: `src/tests/xm-autovibrato.test.ts`. 616 green. |
| 2026-08-29 | fix | **MOD patterns are converted in play order so the channel sample latch survives a pattern boundary** (D56). A note with no sample number in a pattern's opening rows resolved to no instrument — silent when the pattern was played alone, wrong sample when reached in sequence. 320 notes across 13 of 28 corpus modules. Tests: `src/tests/mod-import-sample-latch.test.ts`. 608 green. |
| 2026-08-29 | fix | **The song builder no longer reads a stamped instrument id as an explicit one** (D55), the second regression from D53 and again caught by ear on GSLINGER.MOD pattern 2's flute echo. It reset any note+instrument row without a volume column to velocity 255, and the importers stamp `entry.instrument` onto every row — so every sample-number-less note played at full scale. Now gated to native songs. Regression tests moved up to engine level, which is where all three of these bugs were actually reachable. 604 green. |
| 2026-08-29 | fix | **A note-on now carries its own level** (D54), caught by ear as GSLINGER.MOD pattern 2's flute echo blaring. D53 removed the sample volume from the instrument gain but left the note-on velocity hardcoded at 127, and `setVoiceVolumeAtTime` legitimately drops a volume command it cannot resolve to a voice on this track (D13) — so the fallback level went from "roughly right by accident" to full scale. Also fixes a 0-127 vs 0-255 mismatch in `lastTrackNote`. 601 green. |
| 2026-08-29 | fix | **Channel volume is no longer guessed at import time** (D53). A note with no sample number was stamped with the importer's running volume, which knows nothing about slides — GSLINGER.MOD pattern 36's flute swells 8→33 under `A50` and the next row reset it to 8. The stamp is gone and the effect processor states `currentVolume` on every note trigger instead. The sample header volume is also no longer baked into the patch gain on top of the volume column, which had left 271 of the corpus's 524 samples permanently attenuated when auditioned from the keyboard. Tests: `src/tests/mod-channel-volume-carry.test.ts`. 598 green. |
| 2026-08-29 | 3/4 | **XM volume-column commands implemented** (D50) — 8789 cells across the corpus, 5602 of them panning, previously dropped wholesale. New `TrackerEntryData.volumeCommand` → `parseVolumeColumnCommand` → `Step.volumeCommand` → `processVolumeColumnTick0/TickN`, with slide accumulators kept separate from the effect column's. Also `Xxy` (was unparseable), `Txy` tremor's continuous counter and parameter memory, `Rxy` per-nibble memory, and E4x/E7x's "don't retrigger waveform" bit. Tests: `src/tests/xm-volume-column.test.ts`, `src/tests/ft2-effect-details.test.ts`. 592 green. |
| 2026-08-29 | fix | **E5x was a full semitone off on XM** (D51). ProTracker reads the nibble as signed eighths of a semitone, FT2 as a position in its −128..127 finetune range; they disagree by exactly one semitone for every nibble under 8, and all 840 E5x commands in the XM corpus use nibble 1 or 6. Now `FormatProfile.finetuneFromNibble`; MOD unchanged. |
| 2026-08-29 | fix | **Vibrato, tremolo and fine portamento recalibrated to period/volume units** (D48). Vibrato was ±23% to ±55% off depending on pitch (12155 MOD + 16241 XM occurrences), tremolo was 4× too weak, E1x/E2x used a semitone ratio instead of period units. **ECx now zeroes the volume instead of releasing the note** (D49) — on XM that was running a multi-second fadeout where FT2 stops dead, on 3693 cells. Tests: `src/tests/mod-effect-depths.test.ts`. |
| 2026-08-29 | fix | **9xx sample offset corrected end to end, again** (D46, D47), reversing the import-side half of D11. The offset is a distance in frames (`param * 256`), not a fraction of the sample; the import-time re-encode is retired. Measured across 2087 MOD rows: 60 rows (no instrument number, so the old fixup skipped them) were a mean 5556 frames out, and 1682 more were off by up to 127 frames from 8-bit requantisation — the audible click the user reported. All 2775 XM 9xx cells were unhandled. A bare 9xx no longer latches an offset onto an unrelated later note. |
| 2026-08-29 | — | Effect usage measured across both corpora (§6e), and §6b corrected: three effects it listed as "confirmed wired correctly" were confirmed reachable, not correct. |
| 2026-08-29 | fix | Channels beyond the classic four now default to centre panning rather than repeating the Amiga L-R-R-L grouping (D44, reversing D10) — `DOPE.MOD` has 28 channels and 54 pan commands, so the grouping hard-split the mix. Demo browser no longer shows blank names for modules with an empty title field (D45). |
| 2026-08-29 | fix | MOD instruments are sized by the channels that play them, not a fixed 4 (D42) — `DOPE.MOD` has 28 channels and one sample on 19 of them. Track columns tighten for high channel counts (D43). |
| 2026-08-29 | 4 | New notes now *cut* the previous note on their channel instead of releasing it (D41). Making key-off perform an envelope release had turned every replacement into a fadeout, so previous notes rang on underneath — worst when a channel switches instrument, where nothing ever cut the old voice. Tracker channels are monophonic. |
| 2026-08-29 | 4 | Two fixes for notes going missing: voice replacement is now scheduled at the replacing note's time rather than immediately (D40 — self-inflicted by the D36 fix, and the cause of the `external.xm` report), and key-off is a real envelope release rather than a 10ms cut (D39, corrected by the user). |
| 2026-08-29 | 4 | Envelope loops implemented (D38). A looping envelope was previously played once and held at its final value, silencing most instruments that use one — 23 envelopes in the corpus loop, including all 16 in `external.xm`. Not confirmed as the cause of the reported silence; see the caveat in D38. |
| 2026-08-29 | 4 | XM tempo fixed (D37): "speed" (ticks per row) is separate from BPM, and the importer never read the header's `defaultSpeed` while the engine hardcoded 6. Most XM files declare 3, so they played at exactly half tempo. Now carried on `Song.initialSpeed` and through the song file. |
| 2026-08-29 | 4 | Note release fixed (D36): `noteOffAtTime` dropped every release scheduled more than 100ms ahead — i.e. all of them — so notes were never released and XM key-off did nothing. Releasing voices are now also cut by the next note on the channel, which previously played over them. |
| 2026-08-29 | 4 | Ping-pong sample loops now loop, by mirroring the loop region into the buffer at load (D35). They previously failed a `loopMode === 1` check and played as one-shots — 27 samples in the corpus. Tests go through the normalized patch, and were confirmed to fail with the handling disabled. |
| 2026-08-29 | 4 | **Volume envelopes never actually ran.** `normalizeSamplerStateWithDefaults` rebuilds sampler state from a field whitelist and dropped `trackerEnvelope` on the path to every instrument, while eleven unit tests passed by injecting state directly (D34). Fixed, plus two pipeline tests confirmed to fail against the drop. |
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
