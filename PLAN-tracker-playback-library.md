# Extracting the tracker replay engine as a standalone library

**Goal.** Ship `@another-synth/tracker-playback` as a library other apps can use
to play MOD, XM, S3M and this app's own native songs, without dragging in
Quasar, Pinia, Vue, the Rust/WASM synth, or the pattern editor.

**Status.** All four layers done (2026-09-04). The extraction is complete.

Bytes now reach a schedulable song entirely inside the library: `parseMod` /
`parseXm` / `parseS3m` → `build*TrackerPatterns` → `buildPlaybackSong`, with no
app present. That was the point of doing layer 2 before layer 4 (§8), and it is
verified against the built `dist`, not just the source (§5).

Instruments go the same way: `build*TrackerSamples` produces a lean
`TrackerSample` — PCM, loop points, root note, envelopes — and the app's
`sampler-patch-builder.ts` is the adapter that turns one into this app's
`Patch`. That was §6's last open question, resolved in favour of the lean
descriptor.

Sound too: `TrackerSink` names the 21-member surface a sound source must
provide, `TrackerSamplerInstrument` is the Web Audio voice, and
`StandaloneTrackerSink` is a 452-line player over them. This app's
`TrackerSongBank` implements the same interface with the mixer, recording and
live patch editing the editor needs. Two implementations of one interface, as
intended.

The split now stands at ~14,400 lines in the package against ~4,400 under
`src/audio/`, of which `song-bank.ts` is 2,664 and stays. §8 is what is worth
doing next, and §3e is where to start reading if you are picking this up cold.

This document is written to be picked up cold, in a new session, by someone (or
some model) with no memory of the work. It records what was measured, what was
decided and why, and what to do next — in that order. Numbers in it were
measured on commit `417094f`; re-measure before trusting them if the tree has
moved on.

---

## 1. The pipeline, end to end

A module goes through five stages. Knowing which stage a problem lives in is
most of the work of fixing it. `pkg/` below is
`packages/tracker-playback/src/`.

```
file bytes
   |
   |  parseMod / parseXm / parseS3m            pkg/mod-parser.ts, pkg/formats/*.ts
   v
parsed module  (samples, patterns, orders, raw effect bytes)
   |
   |  build{Mod,Xm,S3m}TrackerPatterns         pkg/import/*-patterns.ts
   |  build{Mod,Xm,S3m}TrackerSamples          pkg/import/*-samples.ts
   v
rows + TrackerSamples                          pkg/tracker-types.ts,
   |                                           pkg/tracker-sample.ts
   |  createSamplerPatch  (the adapter)        src/audio/tracker/sampler-patch-builder.ts
   |  buildSlotsAndPatches                     src/audio/tracker/instrument-slots.ts
   |  import{Mod,Xm,S3m}ToTrackerSong          src/audio/tracker/*-import.ts
   |    assembles rows + patches into a song file
   v
TrackerSong  (the app's song file: rows, instrument slots, one Patch per sample)
   |
   |  buildPlaybackSong                        pkg/playback-song-builder.ts
   |    (useTrackerSongBuilder is the Vue wrapper around it)
   v
PlaybackSong  (the engine's input: patterns of Step)
   |
   |  PlaybackEngine.scheduleRow / scheduleAhead    pkg/engine.ts
   |  + processEffectTick0 / TickN                  pkg/effect-processor.ts
   v
scheduled events  ("note on, track 3, at t=1.2s", "volume 0, step, at t=1.3s")
   |
   |  the Scheduled*Handler callbacks          src/stores/tracker-playback-store.ts
   v                                           -> src/audio/tracker/song-bank.ts
TrackerSongBank -> ModInstrument -> Web Audio   src/audio/mod-instrument.ts
```

Everything above the last stage is in the library. A host supplies two things:
an adapter from `TrackerSample` to whatever it plays (this app's is
`sampler-patch-builder.ts`), and a sink for the scheduled events. Bytes to a
schedulable `PlaybackSong` needs neither, and runs with no app present.

The library boundary for *sound* still sits between stage 4 and stage 5: the
engine emits events and knows nothing about how they are sounded.

---

## 2. What was measured

Facts worth not re-deriving. All of these were checked directly, not assumed.

### The core is already dependency-free

`packages/tracker-playback/src` is ~8,000 lines and imports **nothing** outside
itself — no `src/`, no npm runtime dependency. Verified by listing every import
specifier in the package: they are all relative, plus `vitest` in the specs.

It is **not** DOM-free, though. `engine.ts` attaches a `visibilitychange`
listener; `scheduler.ts` and `engine.ts` reference `AudioContext` and
`setTimeout`/`setInterval`; `clock.ts` uses `requestAnimationFrame` in
`RafClock`. So its tsconfig needs `"lib": [..., "dom"]`. That is fine for a
browser audio library, but it is the reason a Node consumer must not touch
`createAudioContextScheduler`. Everything else — parsers, importers, effect
processor, song builder, engine construction — runs headless. Proven by
importing the built `dist` from a plain Node script (see §5).

(Corrected 2026-09-04: this used to say `clock.ts` uses `document`. It does not
— the `visibilitychange` listener is `engine.ts`'s `setupVisibilityHandling`,
and it returns early when `typeof document === 'undefined'`, which is why
constructing an engine under Node works at all. `createVisibilityClock` is
safe headless; it just stays in interval mode.)

### The parsers are already inside the library

`mod-parser.ts`, `formats/xm.ts`, `formats/s3m.ts`. All six entry points take a
`Uint8Array` consistently:

```
looksLikeMod(buffer: Uint8Array): boolean      parseMod(buffer: Uint8Array): ModSong
looksLikeXm(buffer: Uint8Array): boolean       parseXm(buffer: Uint8Array): XmSong
looksLikeS3m(buffer: Uint8Array): boolean      parseS3m(buffer: Uint8Array): S3mSong
```

(Not `ArrayBuffer` — that mistake costs ten minutes. The app's importers take an
`ArrayBuffer` and wrap.)

### The importers are thinly coupled

`src/audio/tracker/{mod,xm,s3m}-import.ts` + `sampler-patch-builder.ts` +
`note-utils.ts` = 3,059 lines. Everything they pull from the app:

| Import                                                                                  | Kind          | Notes                                                    |
| --------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------- |
| `uid` from `quasar`                                                                     | runtime       | one call each; replace with `crypto.randomUUID()`        |
| `TOTAL_SLOTS`, `CURRENT_SONG_FILE_VERSION` from `src/stores/tracker-store`              | runtime       | two constants, dragged in behind an 887-line Pinia store |
| `TrackerPattern`, `InstrumentSlot` from `src/stores/tracker-store`                      | **type only** |                                                          |
| `TrackerTrackData`, `TrackerEntryData` from `src/components/tracker/tracker-types`      | **type only** | 76-line file                                             |
| `Patch` from `src/audio/types/preset-types`                                             | **type only** |                                                          |
| `SamplerLoopMode` from `src/audio/types/synth-layout`                                   | runtime enum  |                                                          |
| `ModulationTransformation`, `WasmModulationType` from `app/public/wasm/audio_processor` | **type only** | no runtime WASM in this path                             |

So the _mechanical_ coupling is two constants and one `uid`. The real question is
a design one — see §6.

**This table is now entirely history.** `uid` is gone
(`crypto.randomUUID()`), the two constants live in the library's
`song-constants.ts` with the store re-exporting them, the four row types moved
into `tracker-types.ts`, and the instrument types into `tracker-sample.ts`.
`Patch`, `SamplerLoopMode` and the `audio_processor` types are reached only from
`sampler-patch-builder.ts`, which is app-side on purpose and staying there. The
importers under `src/audio/tracker/` are now assembly only, 116-151 lines each.

### The song builder was a pure function in Vue clothing (resolved, layer 3)

`src/composables/useTrackerSongBuilder.ts` was 490 lines containing **no**
`computed`, **no** `watch` and **no** internal `ref()` — it read `.value` off
injected refs 24 times and that was the whole of its reactivity. `songBank` was
referenced on exactly two lines, both inside `syncSlots`, never inside
`buildPlaybackSong`.

The conversion now lives in `src/audio/tracker/playback-song-builder.ts` and
takes plain values. The composable is a 175-line wrapper that snapshots the refs
and delegates.

### ModInstrument is pure Web Audio

`src/audio/mod-instrument.ts`, 2,157 lines. Node types used:
`createBufferSource` (2), `createGain` (5), `createStereoPanner` (2). Its single
`AudioWorkletNode` mention is a `workletNode: AudioWorkletNode | null = null`
compatibility field, never assigned. **No WASM, no worklets.** The
worklet/WASM machinery belongs to the synth path (`instrument-v2.ts`,
`worklet-pool.ts`, `pooled-instrument-factory.ts`), which a module player does
not need.

This is the single most important finding for scoping layer 4.

### SongBank is the coupled one, but the engine only uses a slice of it

`src/audio/tracker/song-bank.ts`, 2,654 lines, 36 public methods. Occurrence
counts of app-side symbols: `workletPool` 31, `InstrumentV2` 24, `AudioSystem`
22, `PooledInstrument` 18, `recorder` 6, `userSettings` 3.

But `src/stores/tracker-playback-store.ts` wires only ~14 of those methods into
the engine:

```
prepareInstrument          setInstrumentGain           setInstrumentMacro
noteOnAtTime               noteOffAtTime               notesOffForTrack
setVoicePitchAtTime        setVoiceVolumeAtTime        setVoicePanAtTime
setVoiceSampleOffsetAtTime setVoiceEnvelopePositionAtTime
cutAllVoicesAtTime         setMasterVolume             retriggerNoteAtTime
```

`src/audio/tracker/track-voice-registry.ts` (335 lines) — the per-channel voice
addressing that resolves "which voice does this command mean" — is already
standalone apart from a type import from song-bank.

---

## 3. Layer 1 — DONE

Committed 2026-09-04. What changed:

**`packages/tracker-playback/src/index.ts`** — widened. Previously exported 9
modules; `timing-system`, `mod-parser`, `mod-vblank` and `formats/s3m` were
missing, so a consumer could not parse an S3M or read the transport clock
through the public entry. Now exports all 14. **There are no name collisions
across the modules** — checked exhaustively, so `export *` is safe; keep it that
way when adding modules.

**`packages/tracker-playback/tsconfig.json`** — made standalone. It used to
`extends: "../../tsconfig.json"`, which chains to `.quasar/tsconfig.json`, a
_generated_ file. That meant the library could not be typechecked or built
without first running `quasar prepare` in the app. It now declares its own
options. The strict flags are deliberately kept identical to the app's, because
the code is written against them — in particular `exactOptionalPropertyTypes`
(the source is full of `...(x !== undefined ? { x } : {})`, which exists only to
satisfy it) and `noUncheckedIndexedAccess`. Do not relax either; a lot of code
will quietly change meaning.

**`packages/tracker-playback/package.json`** — `types` moved first in the
`exports` map (esbuild warns otherwise, since conditions are order-sensitive),
`--clean` added to the build, a `typecheck` script added, `sideEffects: false`
for tree-shaking, real author/keywords.

**Root `package.json`** — added `"workspaces": ["packages/*"]` (so npm links the
package into `node_modules/@another-synth/` and installs its `tsup` devDep) and
a `build:tracker-playback` script.

**Imports rewritten** — 57 files under `src/` and `tests/` used deep relative
paths like `../../packages/tracker-playback/src/engine`. All now import
`@another-synth/tracker-playback`. This is what stops the app reaching past the
library's public API, and it is why widening `index.ts` had to come first.

**Alias wiring** — three places, all pointing the package name at
`packages/tracker-playback/src/index.ts` rather than at `dist`:

- `vitest.config.ts` → `resolve.alias`
- `quasar.config.ts` → `extendViteConf` (uses `process.cwd()`, not `__dirname`;
  the config is ESM)
- `tsconfig.json` → `compilerOptions.paths`

The reasoning: the app is the library's first consumer and builds it from
source, so `dist` only ever has to be current for _other_ consumers. Nobody has
to remember to build before `quasar dev`. The cost is that the app never
exercises the built artifact — hence the standalone smoke test in §5.

**`.eslintignore`** — added `/packages/*/dist`, otherwise eslint lints the build
output (336 warnings).

**`packages/tracker-playback/.gitignore`** — `dist/`.

### Verification performed

| Check                                          | Result                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm test` (whole suite)                       | 109 files, 1598 tests, all pass                                              |
| `npx vue-tsc --noEmit -p tsconfig.json`        | clean                                                                        |
| `npm run lint`                                 | clean                                                                        |
| `npm run build:tracker-playback`               | ESM 144 KB, CJS 147 KB, d.ts 87 KB, no warnings                              |
| `npx quasar build`                             | Build succeeded                                                              |
| Built `dist` consumed from a plain Node script | parses MOD/XM/S3M, runs the effect processor, constructs the engine — no DOM |

Note the suite's 109 files = 105 under `src/tests` + 4 under
`packages/tracker-playback/src/__tests__`. The package's own specs are picked up
by the root vitest run; keep it that way.

---

## 3b. Layer 3 — DONE

Committed 2026-09-04. The conversion from the app's song model to the engine's
`PlaybackSong` is now a plain function.

**`src/audio/tracker/playback-song-builder.ts`** (new) — `buildPlaybackSong`,
`buildPlaybackPatterns`, `buildPlaybackStepsForTrack`, `resolveSequenceForMode`
and `resolveInstrumentForTrack`, all taking a `PlaybackSongSource`: a plain
snapshot of what used to arrive as a dozen refs. Logic and comments moved
verbatim; the only edits were `ref.value` reads becoming field reads.

Two of those reads needed care, and the same trap waits anywhere else this
pattern is unwound. `context.linearFrequency !== undefined` used to ask "was a
ref supplied", and `context.initialSpeed ? … : …` tested the truthiness of a ref
_object_, which is always true when present. As plain values they became
`source.linearFrequency !== undefined` and `source.initialSpeed !== undefined` —
equivalent for every caller, but `!== undefined` rather than truthiness matters:
`initialSpeed: 0` would otherwise change meaning.

**`src/composables/useTrackerSongBuilder.ts`** — now 175 lines (was 490). Same
exported API, same context type, so no caller changed. It snapshots the refs
**per call**, not once at construction: a snapshot taken when the composable is
created would build every subsequent song from whatever was loaded first.
`syncSongBankFromSlots` keeps its body, being the only part that touches the
song bank.

**`src/tests/helpers/imported-song.ts`** (new) — `sourceFromImport` /
`songFromImport`. Six test files had each spelled out an identical ref context;
they now call this and import no Vue at all. Net −556/+90 lines.

Six _other_ test files were left alone, but not all for the same reason, and
the difference matters if you are tempted to tidy them.

Three diverge deliberately, and collapsing them onto the shared helper would
change what they cover: `s3m-engine` passes `initialGlobalVolume` (an S3M header
field the others have no use for), `xm-amiga-frequency-table` builds from a
single pattern because that is the unit under test, and
`tracker-module-format-plumbing` builds a hand-made song rather than importing
one.

Two had simply drifted, and were fixed rather than preserved:

- **`raw-effect-bytes` pinned `linearFrequency` to `true`** regardless of what
  the file said. It runs over _every_ XM in `public/demos/ft2`, five of which
  select the Amiga frequency table — `4-mat_-_rose`, `BUTTERFL`, `external`,
  `jt_strng`, `radix_-_take_on_me`. `profileForFormat` returns
  `XM_AMIGA_PROFILE` only on `linearFrequency === false`, so those five were
  scheduled through `XM_PROFILE`, and the raw-vs-text identity this file exists
  to assert was never checked under the Amiga pitch model at all. It now reads
  `file.data.linearFrequency ?? true` like every other test. All 108 cases still
  pass, so nothing was hiding behind it — but the coverage is real: `pitch` is
  the _only_ field that differs between the two profiles, so those five files
  previously exercised the wrong pitch model end to end.
- **`xm-tone-portamento-keyoff` used `normalizeInstrumentId: (id) => id`** where
  everything else maps a falsy id to `undefined`. The two differ only on
  `instrument === ''`, and across the 271,467 entries the XM corpus imports
  there are none, so it was equivalent — but gratuitously different in a way
  that reads as deliberate. Now consistent.

`mod-channel-volume-carry` supplies neither speed nor frequency table, which is
also drift rather than intent — `profileForFormat` reads neither for `mod`, so
it is inert. It is left as it is because it builds a hand-made single pattern
and would not fit the shared helper anyway.

### What was left of layer 3 — now done

Moving `playback-song-builder.ts` into the package. It was blocked on §6; once
that resolved in favour of the library owning the row model, the move was
mechanical. It now lives at `packages/tracker-playback/src/playback-song-builder.ts`
with a re-export shim at the old path, and takes its `TrackerPattern` /
`TrackerTrackData` / `TrackerEntryData` from the library's own `tracker-types`.

### Verification performed

| Check                                   | Result                          |
| --------------------------------------- | ------------------------------- |
| `npm test`                              | 109 files, 1598 tests, all pass |
| `npx vue-tsc --noEmit -p tsconfig.json` | clean                           |
| `npm run lint`                          | clean                           |

No behaviour changed, so no new tests: the existing 1598 passing unchanged _is_
the assertion. The six migrated files exercise the new plain-value path.

---

## 3c. Layer 2, pattern half — DONE

Committed 2026-09-04. Every importer splits at the same seam: the pattern half
is in the library, the instrument half stayed in the app.

**Moved into the package**

| File                              | Was                                            |
| --------------------------------- | ---------------------------------------------- |
| `tracker-types.ts`                | `src/components/tracker/tracker-types.ts`      |
| `note-utils.ts`                   | `src/audio/tracker/note-utils.ts`              |
| `playback-song-builder.ts`        | `src/audio/tracker/playback-song-builder.ts`   |
| `song-constants.ts`               | constants inside `src/stores/tracker-store.ts` |
| `instrument-ids.ts`               | part of `src/audio/tracker/instrument-ids.ts`  |
| `import/{mod,xm,s3m}-patterns.ts` | the pattern half of each `*-import.ts`         |

Every old path is a re-export shim, so **no import site under `src/` changed** —
the 57 files that import the package and the ~30 that import `tracker-types`
were untouched. The whole diff is the moved files, their shims, the store, and
`instrument-ids.ts`.

**The seam.** All three importers had the same shape without anyone having
planned it: `buildTrackerPatterns` plus cell decoding on one side,
`buildInstrumentSlotsAndPatches` plus `createSamplerPatchFor*` on the other,
joined only by the top-level `import*ToTrackerSong` that assembles the
`TrackerSongFile`. No pattern half referenced `Patch`, `SamplerLoopMode`,
`InstrumentSlot` or `createSamplerPatch` at all — checked before moving, not
assumed. So the split needed no new abstraction, only renames to survive
`export *`: each file had its own `buildTrackerPatterns`, now
`buildModTrackerPatterns`, `buildXmTrackerPatterns`, `buildS3mTrackerPatterns`.

**What each pattern half exports beyond its builder**, because the app's
instrument half or top level still needs it: `MOD_PATTERN_ROWS`; XM's
`firstSampleOf`; S3M's `measureS3m` (the D96/D97 drop-count audit),
`S3mImportCounts` and `UNMAPPED_COMMAND_BYTES`.

**Duplication collapsed on the way.** `formatInstrumentId` existed in four
copies — `instrument-ids.ts` plus a private one in each importer — all
byte-identical. `midiToTrackerNote` existed in three, identical in behaviour
(MOD's differed only in how the note-name array was wrapped). Each now has one
home: `instrument-ids.ts` and `note-utils.ts` respectively, the latter next to
its inverse `parseTrackerNoteSymbol`. `normalizeInstrumentId` moved with
`formatInstrumentId`; `pickActiveInstrumentId` did not, because it reads
`InstrumentSlot`.

**`TOTAL_PAGES` inverted.** `TOTAL_SLOTS` used to be `SLOTS_PER_PAGE *
TOTAL_PAGES`. The slot count is a property of the song model (XM's
128-instrument maximum) and had to move; the 5-per-page paging is
instrument-panel UI and had to stay. So the store now derives `TOTAL_PAGES =
Math.ceil(TOTAL_SLOTS / SLOTS_PER_PAGE)` — still 26, and no longer able to
drift from the slot count.

`DEFAULT_SPEED`, `DEFAULT_PATTERN_ROWS`, `MIN`/`MAX_PATTERN_ROWS` and
`clampPatternRows` moved too: XM's 256-row maximum is a format fact, and the XM
and S3M pattern halves call `clampPatternRows` directly.

`TrackerSelectionRect` deliberately did **not** move. It is a pattern-editor
selection rectangle with no part in replay, used only by the canvas code and
the Vue components. It stays declared in the app's `tracker-types.ts` shim
alongside the re-exports.

### Verification performed

The §5 checks were run after each step, not at the end.

| Check                                   | Result                                           |
| --------------------------------------- | ------------------------------------------------ |
| `npm test`                              | 109 files, 1599 tests, all pass                  |
| `npx vue-tsc --noEmit -p tsconfig.json` | clean                                            |
| `npm run lint`                          | clean                                            |
| `npm run build:tracker-playback`        | ESM 181 KB, CJS 185 KB, d.ts 104 KB, no warnings |
| `npx quasar build`                      | Build succeeded                                  |
| Standalone `dist` from a Node script    | all three formats, see below                     |

No behaviour changed, so no new tests; 1599 passing unchanged is the assertion.
(The count is 1599, not the 1598 recorded for layers 1 and 3 — one test was
added between. Re-measure rather than matching a number in this document.)

Two mistakes were caught only by typecheck, both the same kind: a constant used
by *both* halves that followed the pattern half out of the file.
`XM_NOTE_TO_MIDI_OFFSET` genuinely belonged with the rows; `S3M_C2FREQ` did not
and had to come back. Expect roughly one per file when the instrument half
moves.

The standalone check now goes the whole way, on all three formats, against the
built `dist`:

```
MOD   "guitar slinger"       -> 41 patterns,  4 tracks,  5073 steps
XM    "One fine day..."      -> 39 patterns, 24 tracks, 19506 steps
S3M   "2nd Reality <Skaven>" -> 73 patterns,  8 tracks, 14978 steps
```

That is `parse*` then `build*TrackerPatterns` then `buildPlaybackSong`, in
Node, with no app, no Vue and no DOM. A consumer can write their own audio
backend against the library today — which is what §8 predicted this layer would
unlock, and the reason it went before layer 4.

---

## 3d. Layer 2, instrument half — DONE

Committed 2026-09-04, once §6 resolved in favour of a lean descriptor. Layer 2
is now complete: both halves of all three importers are in the library.

**The type was already there.** `SamplerPatchSpec`, the input to
`createSamplerPatch`, was the lean descriptor §6 asked for and had been since
the patch builder was extracted — format-neutral, carrying data, loop points,
root note, detune, gain, pan and the XM envelopes. Only two of its fields were
app presentation rather than format fact: `category` (`'Imported/MOD'`) and
`fallbackName`. So `TrackerSample` was not a type to design; it was
`SamplerPatchSpec` minus those two, moved. `sampler-patch-builder.ts` was
already the adapter the plan wanted to keep app-side.

**Moved into the package**

| File                              | Was                                        |
| --------------------------------- | ------------------------------------------ |
| `tracker-sample.ts`               | `SamplerPatchSpec` + the tracker types in `synth-layout.ts` + `OplInstrumentData` in the store |
| `import/{mod,xm,s3m}-samples.ts`  | `buildInstrumentSlotsAndPatches` and `createSamplerPatchFor*` in each `*-import.ts` |

**Stayed in the app**, and always will: `sampler-patch-builder.ts`, now
`createSamplerPatch(sample: TrackerSample, { fallbackName, category })`. It is
the whole boundary — what a sample *is* on one side, how this app sounds one on
the other. A different host writes its own adapter and never sees a `Patch`.

**New app-side: `src/audio/tracker/instrument-slots.ts`.** All three importers
had their own copy of the same loop — make a patch, fill an `InstrumentSlot`,
record it in `songPatches` — differing only in the bank and category strings.
One `buildSlotsAndPatches(samples, options)` now serves all three.

**Loop mode is a string union, not the app's enum.** `TrackerSampleLoop` is
`'off' | 'forward' | 'pingpong'`; the adapter maps it to `SamplerLoopMode`.
§6 left this open ("moves or gets mirrored") and neither turned out right:
`SamplerLoopMode`'s *numbers* are serialised into saved patches, so a library
type pinned to them would make the app's file format part of this package's
API. It is also used across the app's synth side — `SamplerComponent.vue`,
`node-state-store.ts`, `patch-serializer.ts`, `instrument.ts`, `instrument-v2.ts`
— which would all then be importing an enum from a tracker playback library.
XM's parser already reports loop type in words, so the union costs nothing.

**`sourceIndex` alongside `slot`.** A `TrackerSample` carries both the slot the
importer allocated and the module's own instrument number. They differ whenever
packing happens: XM and S3M pack referenced instruments down into consecutive
slots, so instrument 40 might land in slot 3. The fallback patch name
("Instrument 40") must use the file's number — the composer's numbering is what
that name refers to. Dropping `sourceIndex` would silently rename every patch
in a sparse XM.

**AdLib instruments come through as samples with no data.** An S3M AdLib
instrument gets `opl` set and an empty `data`; it occupies a slot, because it is
part of the song's instrument numbering, but never enters `slotForInstrument`
because nothing can play it. That is the same "inactive slot carrying its
register bytes" the previous code expressed by filling a slot with no `patchId`.

**Slot allocation moved with it, and had to.** `buildXmTrackerPatterns` and
`buildS3mTrackerPatterns` take a `slotForInstrument` map to resolve a cell's
instrument byte — so the pattern half already depended on the instrument half's
packing. Both now live in the library and `TrackerSampleSet` carries the map
between them, which is why a standalone consumer gets the app's exact slot
numbering rather than an identity map that happens to work.

### Verification performed

| Check                                   | Result                          |
| --------------------------------------- | ------------------------------- |
| `npm test`                              | 109 files, 1599 tests, all pass |
| `npx vue-tsc --noEmit -p tsconfig.json` | clean                           |
| `npm run lint`                          | clean                           |
| `npx quasar build`                      | Build succeeded                 |
| `npm run check:tracker-playback-dist`   | all checks pass                 |

No behaviour changed. Two things did change that are worth knowing: MOD import
lost two per-slot `console.log` lines the other two formats never had, and the
three importers shrank to assembly — `mod-import.ts` 255 → 116 lines,
`xm-import.ts` 387 → 123, `s3m-import.ts` 338 → 151.

**Process note.** Three of the errors in this step were the same mistake as
§3c's, worse: cutting a file by line number takes the *next* declaration's doc
comment with it, or strands its own. Doing it by hand cost more time than the
rest of the step. The fix, if this is ever needed again, is to anchor on the
declaration and walk *backwards* over its comment rather than slicing line
ranges — and to scan the result for a line matching `^ \* ` immediately after a
blank line, which is exactly what a stranded comment looks like.

---

## 3e. Layer 4, the sound source — DONE

Committed 2026-09-04. The extraction is complete: a consumer can now load a
module and hear it without the app.

**`sink.ts` — the interface.** 21 members, named from what
`tracker-playback-store.ts` actually wires into `TrackerSongBank`. `TrackerSongBank
implements TrackerSink` compiled with **no changes at all**, which is the
evidence that the interface describes the real surface rather than a wished-for
one. Its doc comment carries the three conventions a second implementer needs:
`instrumentId` may be undefined and is a no-op then, a `time` in the past means
"now" rather than "skip", and (instrumentId, trackIndex) is what actually
addresses a voice — `voiceIndex` alone is not enough when two channels share an
instrument.

**`sampler-instrument.ts` — the voice.** `ModInstrument` moved almost verbatim
(2,157 lines) as `TrackerSamplerInstrument`. The DSP was not touched: only the
imports, the `SamplerState` type, the loop-mode comparisons, and `loadPatch`.

`loadPatch(patch: Patch)` split in two. The library gets `load(config, data,
sampleRate, channels, voiceCount)` and `loadSample(sample: TrackerSample)`; the
app keeps a 109-line `ModInstrument extends TrackerSamplerInstrument` whose only
job is `loadPatch` — decode the patch's sample asset, map its `SamplerState`,
call `load`. That subclass exists because `song-bank.ts` calls `loadPatch`
polymorphically across `InstrumentV2 | ModInstrument | PooledInstrument` and
does `instanceof ModInstrument`; a subclass satisfies both.

`sample-conditioning.ts` and `sample-quality.ts` moved with it, unchanged — as
§4 predicted, both had zero imports.

**`standalone-sink.ts` — the second implementation.** 452 lines against
`TrackerSongBank`'s 2,664: one `TrackerSamplerInstrument` per instrument, a
master gain, and a per-track voice map. No worklet pool, no `AudioSystem`, no
user settings, no recorder, no mixer, no visualisation.

```ts
const { samples } = buildModTrackerSamples(parseMod(bytes));
const sink = new StandaloneTrackerSink({ audioContext });
await sink.loadSamples(samples);
```

**`track-voice-registry.ts` deliberately did not move.** §4 assumed it would.
It imports `ActiveInstrument` from `song-bank.ts` and takes the bank's
voice-replacement policy by injection (`isMonophonicChannel`,
`getGateLeadTime`) — and its own header records D78's decision not to abstract
that policy yet. The standalone sink needs far less: because
`TrackerSamplerInstrument.noteOnAtTime` already takes a `trackIndex` and returns
the voice it chose, remembering that per track is the whole of the addressing.
Moving the registry would have meant abstracting a policy the code says to leave
alone, to serve an implementation that does not need it.

### Verification performed

| Check                                   | Result                                         |
| --------------------------------------- | ---------------------------------------------- |
| `npm test`                              | 110 files, 1611 tests, all pass                |
| `npx vue-tsc --noEmit -p tsconfig.json` | clean                                          |
| `npm run lint`                          | clean                                          |
| `npx quasar build`                      | Build succeeded                                |
| `npm run check:tracker-playback-dist`   | 35 expected exports, all checks pass           |

The 11 existing `ModInstrument` test files — loops, autovibrato, panning
envelopes, pitch automation, sample offset, monophony — all pass unchanged
against the moved class, which is what makes the move safe to believe.

New: `packages/tracker-playback/src/__tests__/standalone-sink.spec.ts`, 12 tests.
The app's suite covers `TrackerSongBank` heavily and the standalone sink not at
all, so these cover what is specific to it: instrument addressing by slot id,
OPL slots getting no instrument, per-voice routing through the track map and its
fallback, clamping a past `time` to now, `notesOffForTrack` cutting only its own
track, retrigger cutting before restarting, and master-volume clamping. Verified
they fail as well as pass: breaking the voice lookup and the time clamp fails
exactly two of them.

### What is left

Nothing, for the extraction. Two things a *consumer* would still want, neither
blocking:

- **A README.** Still the actual barrier to "use it in other apps".
- **A worked end-to-end example** — bytes to sound in one file. The standalone
  check gets to `PlaybackSong`; nothing yet shows wiring the engine's handlers
  into a sink, which is the last thing a consumer has to work out for themselves.

---

## 4. Layer 4 — DONE (see §3e)

Estimates assume familiarity with the code.

The plan for it is superseded by what was actually done; see §3e. Two of its
assumptions turned out wrong and are worth recording: the sink is 21 members
rather than ~14, and `track-voice-registry.ts` did not move (§3e says why).

---

## 5. How to verify a change to any layer

Run these before and after. The corpus suite is the safety net that makes this
whole extraction viable; do not skip it because a change "obviously" cannot
affect playback.

```sh
npm test                          # 109 files / 1599 tests (re-measure; it grows)
npx vue-tsc --noEmit -p tsconfig.json
npm run lint
npm run build:tracker-playback
npx quasar build                  # uses prebuilt public/wasm; no Rust needed
```

And the standalone check -- the only thing that proves the _built_ artifact works
outside the app, since the app resolves to source:

```sh
npm run check:tracker-playback-dist
```

That builds the package and runs `scripts/check-tracker-playback-dist.mjs`,
which imports `@another-synth/tracker-playback` by name under plain Node. The
npm-workspace symlink plus the package's own `exports` map send that to `dist/`,
so it really does load the build rather than the source -- no scratch directory
or hand-copied package needed, which is how this used to be done.

It checks four things: that both the ESM and CJS entries load; that 26 named
public exports are actually present (an `export *` collision in `index.ts`
silently drops a name, and nothing else would notice); that MOD, XM and S3M each
go bytes -> rows -> `PlaybackSong` with real notes in the steps; and that
`PlaybackEngine` and `createVisibilityClock` construct with no DOM. It exits
non-zero on any failure -- verified by deleting an export, rebuilding and
watching it fail, not just by watching it pass.

It picks the first demo of each format rather than naming files, so it survives
the demo set changing, and asserts shape rather than exact counts.

---

## 6. Decisions

### Resolved: the library owns the row model

**Question.** Should the importers emit the app's editor model
(`TrackerEntryData` and friends), or emit `PlaybackSong` directly and leave the
editor model in the app? The second reading would have kept
`playback-song-builder.ts` app-side permanently and made layer 2 much smaller.

**Answer: the importers emit the row model, and it moves into the library.**

The evidence is in the two types. `Step` (the engine's input) carries
`effect?: EffectCommand` — a _decoded_ effect. `TrackerEntryData` carries
`effectCommand` and `effectParam`, the raw format-native bytes. Those bytes are
the source of truth for imported rows: it is the whole subject of
`src/tests/raw-effect-bytes.test.ts`, and `buildPlaybackStepsForTrack` prefers
them over the text macro precisely because the text is presentation and can
collide with the hand-authored dialect (D94).

So `PlaybackSong` cannot round-trip back to a row. An importer that emitted only
`PlaybackSong` would leave the app unable to show an imported module in the
pattern editor or re-export it, and the app would have to keep a second copy of
the importers to get the rows back. That settles it.

Consequence: `tracker-types.ts`, `note-utils.ts`, the three importers and
`playback-song-builder.ts` all belong in the package. The app keeps re-export
shims so no import site has to change.

**Acted on (2026-09-04, see §3c)** for everything except the importers'
instrument half, which the next section still blocks.

### Resolved: the library emits a lean `TrackerSample`

Decided by Morten, 2026-09-04, in favour of the recommendation below. Acted on
the same day; see §3d.

`sampler-patch-builder.ts` (440 lines) emits the app's `Patch` — a full synth
preset with modulation routing, envelopes and macro assignments, because in this
app a MOD sample _is_ a sampler patch. A standalone consumer wants far less:
sample data, loop points, finetune, default volume, root note.

**Answer: the library emits a lean `TrackerSample` descriptor and
`sampler-patch-builder.ts` stays in the app as the adapter that turns one into a
`Patch`.** That is the honest boundary, and it also takes the last
`app/public/wasm/audio_processor` type import out of the library path.

What made it cheap, discovered while acting on it: the descriptor already
existed. `SamplerPatchSpec` — `createSamplerPatch`'s input, format-neutral since
the patch builder was extracted — was this type minus a rename, carrying PCM,
loop points, root note, detune, gain, pan and the XM envelopes. Only `category`
and `fallbackName` were app presentation. §3d has what actually moved.

The alternatives are (b) emit `Patch` and make consumers ignore most of it, or
(c) emit both behind a flag. Both are worse; (b) exports the app's synth model
to people who did not ask for a synth.

The `SamplerLoopMode` sub-question ("moves or gets mirrored") turned out to have
a third answer, which is what shipped: neither. The library describes loops in
words (`'off' | 'forward' | 'pingpong'`) and the adapter maps to the app's enum,
because that enum's *numbers* are serialised into saved patches and it is used
across the app's synth side as well. See §3d.

### How much the move cost — settled

The estimate was: `note-utils.ts` (457 lines) imports only types from
`tracker-types` plus `FormatProfile`; `tracker-types.ts` is 76 lines of pure
interfaces with no imports at all; `TrackerPattern` is an 11-line interface;
`InstrumentSlot` is needed only by `syncSongBankFromSlots`, which stays in the
app regardless. With re-export shims left behind, the blast radius is zero.

That held exactly. `InstrumentSlot` did stay in the app, and no import site
under `src/` changed. §3c has what the move actually touched.

**Native-format support.** `NATIVE_PROFILE` and the app's own song format are in
the library already. Whether an external consumer cares is unclear, but it costs
nothing to leave in.

---

## 7. Gotchas

Small things that cost time if you meet them cold.

- **`node_modules` may be absent.** This repo is often cloned without installing.
  `npm install` then `npx quasar prepare` — the latter generates
  `.quasar/tsconfig.json`, which the _app's_ tsconfig extends. Without it,
  vitest fails to load its config with a `TSConfckParseError`. (The library's own
  tsconfig no longer needs it — that was fixed in layer 1.)
- **`npx vitest` installs the wrong vitest.** Use `./node_modules/.bin/vitest` or
  `npm run test:run`; a bare `npx vitest` pulled vitest 5 and failed to resolve
  the config.
- **Line endings are CRLF.** Scripted edits must preserve them or every file
  shows as fully rewritten. Read as bytes, detect `\r\n`, normalise, edit,
  restore. Note `sed` on Git Bash strips the `\r` while `printf` does not, so a
  file built from both comes out mixed; normalise the whole file at the end.
  `playback-song-builder.ts` is the one file that is LF, not CRLF.
- **Splitting a file? Watch the constants, not the functions.** Moving a
  function is easy to get right because the compiler checks it. The two errors
  in §3c were both a `const` sitting between two functions that the *other* half
  also used, and both surfaced only at typecheck. Grep each candidate constant
  across both halves before cutting.
- **A doc comment belongs to the function below it.** Cutting a range that ends
  at a function boundary takes the *next* function's comment with it. Check the
  last lines of what you moved.
- **Prettier reports pre-existing failures.** `npm run format --check` flags files
  nobody touched, mostly line-ending related. Compare against the file's own
  prettier output before assuming your change caused it.
- **A full `npm run build` needs the Rust/WASM toolchain.** `npx quasar build`
  alone is enough to verify the frontend, and reuses the checked-in
  `public/wasm` artifacts.

---

## 8. Recommended next action

**The extraction is done.** What is left is not more extraction; it is the
things a first outside consumer would hit.

1. **A README for the package.** It has been the top of this list since layer 1
   and it is now the only real barrier: the code works, and nothing tells anyone
   how to use it. It should show bytes-to-sound in one screen, say plainly which
   exports touch the DOM (§2), and name the two sink implementations.
2. **A worked example.** `scripts/check-tracker-playback-dist.mjs` proves the
   library gets to a `PlaybackSong`; nothing yet shows the last hop — wiring the
   engine's `Scheduled*Handler`s into a `TrackerSink` and starting the transport.
   That is the one part a consumer still has to reverse-engineer from
   `src/stores/tracker-playback-store.ts`.
3. **Version and publish**, if it is ever meant to leave this repo. It is
   `0.0.1` and unpublished; `files: ["dist"]` and the `exports` map are already
   right for it.

Optional, and only if something asks for it:

- **`track-voice-registry.ts`** could move if the app's voice-replacement policy
  is ever abstracted (D78 says not yet). The standalone sink does not need it.
- **`song-bank.ts`** stays in the app permanently. It is 2,664 lines of mixer,
  live patch editing, recording and visualisation, and none of that belongs to
  a module player.

### Where those queued items ended up

- **The package still has no README.** Promoted to §8 item 1 — it is now the
  top of the list rather than a footnote, because the code it would document
  finally does the whole job.
- ~~**The standalone check in §5 should be a checked-in script.**~~ Done
  2026-09-04: `scripts/check-tracker-playback-dist.mjs`, wired as
  `npm run check:tracker-playback-dist`. It is not part of `npm test` — it needs
  a build first, so it belongs in CI as its own step. Add it there when there is
  a CI pipeline to add it to.

---

## 9. Related documents

- `PLAN-module-format-support.md` — the D-numbered log of format-accuracy fixes.
  Every `Dnn` reference in the replay code points there. Read it before changing
  effect behaviour; most of the odd-looking code is load-bearing and the comment
  usually names the module that forced it.
- `ARCH-REVIEW-s3m.md`, `TRACKER_WORKLET_SCHEDULING.md`, `WORKLET_POOLING.md` —
  background on the synth side, i.e. the parts a standalone player does _not_
  need.
