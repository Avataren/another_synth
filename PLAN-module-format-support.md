# Multi-Format Module Support (MOD / XM / S3M)

**Status:** Phase 1 in progress (per-pattern rows done; channel count next)
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
- [ ] Extract `PitchModel` interface; move PT period logic into `AmigaPitchModel`
- [ ] Add `LinearPitchModel` (XM linear table)
- [ ] Introduce `FormatProfile`; pass it through `processEffectTick0` / `TickN`
- [ ] Move each ProTracker quirk (B6 list) behind a profile flag
- [ ] Carry raw `(cmd, param)` bytes on `TrackerEntryData` alongside the text macro;
      retire the 9xx synthetic-param hack
- [ ] MOD regression suite green with the profile in place

### Phase 3 — XM parser and import (B3, B5, B8)
- [ ] `formats/xm.ts`: header, pattern decode (packed cells), instrument + sample headers
- [ ] 8/16-bit delta sample decoding
- [ ] `ModuleSong` IR + refactor the MOD path to produce it too
- [ ] Format-agnostic importer IR → `TrackerSongFile`
- [ ] Multi-sample instruments with note→sample keymap
- [ ] Volume-column field on `TrackerEntryData` + XM volume-column commands
- [ ] Key-off (note 97) handling
- [ ] Raise `TOTAL_SLOTS` or introduce instrument paging beyond 35

### Phase 4 — XM instrument fidelity
- [ ] Volume envelope (12 points, sustain, loop)
- [ ] Panning envelope
- [ ] `volumeFadeout`
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

**D5 — Open: envelope execution site.**
Either drive XM envelopes from the JS tick loop (simple, mode-agnostic, but per-tick
automation cost × up to 32 channels) or implement them in the WASM sampler (better
runtime, more work). Decide at the start of Phase 4, informed by measured Phase 3 cost.

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
| 2026-08-28 | fix | Voice resolution no longer falls back to voice 0, which let one track's volume/offset commands hit another track's voice when both used the same sample (D13). Found via GSLINGER.MOD pattern 2. Tests: `src/tests/tracker-song-bank-cross-track-volume.test.ts` (confirmed failing against the old code). |
| 2026-08-28 | fix | 5xy no longer reads its pitch-slide speed from the volume-slide parameter, and no longer clobbers the 3xx speed memory (D12). Found via GSLINGER.MOD pattern 4 track 1. Tests: `src/tests/mod-toneporta-volslide-speed.test.ts` (3 of 5 confirmed failing against the old code). |
| 2026-08-28 | fix | **Verified by ear on the test deploy — 9xx now correct.** 9xx sample offset fixed end to end (D11): offset now rides on the noteOn and is applied at voice start; `ModInstrument` honours macro 1 with ProTracker-style offset memory; `PooledInstrument.setVoiceMacroAtTime` implemented (also restores per-channel pan on the pooled path). Tests: `src/tests/mod-sample-offset-playback.test.ts`, `src/tests/mod-instrument-sample-offset.test.ts`. |
| 2026-08-28 | 1 | MOD parser accepts up to 32 channels (`channelsForSignature`: `<n>CHN`, `<nn>CH/CN`, `TDZ<n>`, CD81/OKTA/OCTA); FLT8 explicitly rejected (D9). Importer derives track count from the module and repeats L-R-R-L panning past 4 channels (D10). Verified `misc/peacedroid.mod` parses byte-identically before/after. Tests: `src/tests/mod-parser-multichannel.test.ts` (includes per-channel effect-routing coverage). |
| 2026-08-28 | 1 | Row count moved onto `TrackerPattern.rows`; song file v3 backfills pre-v3 files from `data.patternRows` (D7). `engine.setLength` no longer flattens pattern lengths; added `setPatternLength` (D8). Song builder, playback store, export duration and the pattern UI all read per-pattern counts. Tests: `src/tests/stores/tracker-store-pattern-rows.test.ts`, `src/tests/tracker-engine-pattern-length.test.ts`. |
