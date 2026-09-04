# Extracting the tracker replay engine as a standalone library

**Goal.** Ship `@another-synth/tracker-playback` as a library other apps can use
to play MOD, XM, S3M and this app's own native songs, without dragging in
Quasar, Pinia, Vue, the Rust/WASM synth, or the pattern editor.

**Status.** Layers 1 and 3 done (2026-09-04). Layer 2's **pattern half done**
(2026-09-04); its instrument half is blocked on the open question in §6. Layer 4
not started.

Bytes now reach a schedulable song entirely inside the library: `parseMod` /
`parseXm` / `parseS3m` → `build*TrackerPatterns` → `buildPlaybackSong`, with no
app present. That was the point of doing layer 2 before layer 4 (§8), and it is
verified against the built `dist`, not just the source (§5).

What is left of layer 2 is the *instrument* half — the three importers'
`buildInstrumentSlotsAndPatches` and `sampler-patch-builder.ts` — which waits on
the `TrackerSample` question in §6. §8 is the recommended next action and is
where to start reading if you are picking this up cold.

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
   |  buildModTrackerPatterns / Xm / S3m       pkg/import/*-patterns.ts
   |     the pattern half                        <- library
   |  buildInstrumentSlotsAndPatches           src/audio/tracker/*-import.ts
   |     the instrument half                     <- app, blocked on §6
   |  importModToTrackerSong / Xm / S3m        src/audio/tracker/*-import.ts
   |     assembles the two into a song file
   v
TrackerSong  (rows: patterns of TrackerEntryData  <- library, pkg/tracker-types.ts
   |          instruments: slots + one sampler Patch per sample  <- app)
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

Stages 1 to 4 are now entirely inside the library for the *pattern* path: bytes
to a schedulable `PlaybackSong` with no app present. The remaining app-side
pieces are the instrument half of stage 2 and the whole of stage 5.

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

**As of the layer-2 pattern half this table is history for the rows.** `uid` is
gone (`crypto.randomUUID()`), the two constants live in the library's
`song-constants.ts` and the store re-exports them, and the four row types moved
into `tracker-types.ts`. What is still app-side, and still coupled exactly as
the table says, is the instrument half: `Patch`, `SamplerLoopMode` and the
`audio_processor` types are reached only from `buildInstrumentSlotsAndPatches`
and `sampler-patch-builder.ts`.

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

## 4. Layer 2's instrument half, and layer 4 — TODO

Estimates assume familiarity with the code.

### Layer 2 — the instrument half (blocked on §6)

What remains is `buildInstrumentSlotsAndPatches` in each importer, plus
`sampler-patch-builder.ts`. All of it is blocked on the `TrackerSample`
question in §6, and none of it should move until that is answered: the three
functions return `Record<string, Patch>`, and `TrackerSongFile.data.songPatches`
is typed the same way, so moving them as they stand would export the app's whole
synth preset model — modulation routing, envelopes, macro assignments and the
`app/public/wasm/audio_processor` type imports — to consumers who asked for a
module player.

`SamplerLoopMode` (a runtime enum) is part of the same decision, not a separate
one: it appears only in the patch-building path.

`TrackerSongFile` itself is entangled the same way and stays in the store for
now. The library's `TrackerSongFileVersion` and `CURRENT_SONG_FILE_VERSION`
moved; the file *shape* did not.

### Layer 4 — the sound source (2–3 days)

1. Declare the ~14-method interface listed in §2 as a `TrackerSink` (or similar)
   type in the package, next to the `Scheduled*Handler` types it complements.
2. Make the app's `TrackerSongBank` implement it (it already does structurally —
   this is mostly a `satisfies` and a rename or two).
3. Write a lean second implementation over `ModInstrument` + `track-voice-registry`
   for standalone use: no worklet pool, no `AudioSystem`, no user settings, no
   recorder. `ModInstrument` moves as-is; it is plain Web Audio.
4. `sample-conditioning.ts` and `sample-quality.ts` are `ModInstrument`'s only
   non-type dependencies — check them before assuming they come free.

The app keeps `SongBank` (it needs the mixer, live patch editing, recording and
visualisation the standalone sink will not have). Two implementations of one
interface is the intended end state, not a temporary compromise.

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

And the standalone check — the only thing that proves the _built_ artifact works
outside the app, since the app resolves to source:

```sh
# in a scratch dir with a package.json containing {"type":"module"}
# and node_modules/@another-synth/tracker-playback = a copy of the package
#                                                    (dist + package.json only)
node -e "
import('@another-synth/tracker-playback').then(async (lib) => {
  const fs = await import('node:fs');
  const b = new Uint8Array(fs.readFileSync('public/demos/amiga/GSLINGER.MOD'));
  const patterns = lib.buildModTrackerPatterns(lib.parseMod(b));
  const song = lib.buildPlaybackSong({
    currentSong: { title: '', author: '', bpm: 125 },
    moduleFormat: 'protracker',
    patterns,
    sequence: patterns.map((p) => p.id),
    currentPatternId: patterns[0].id,
    playbackMode: 'song',
    stepSize: 1,
    defaultPatternRows: 64,
    resolveInstrumentId: lib.formatInstrumentId,
    normalizeInstrumentId: lib.normalizeInstrumentId,
  });
  console.log(song.patterns.length, 'patterns');
});
"
```

Since §3c this goes the whole way — bytes to a schedulable `PlaybackSong` — so
it is worth running for XM and S3M too. Those need two more arguments each (a
pitch model and an instrument-to-slot `Map`); §3c has the expected output for
all three. `PlaybackSongSource` requires both `resolveInstrumentId` and
`normalizeInstrumentId`; omitting the latter fails at runtime, not at the type
level, if you write the check in plain JS.

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

### Still open: what shape do the _samples_ take?

This is the smaller half of the same question, and the only part still undecided.

`sampler-patch-builder.ts` (440 lines) emits the app's `Patch` — a full synth
preset with modulation routing, envelopes and macro assignments, because in this
app a MOD sample _is_ a sampler patch. A standalone consumer wants far less:
sample data, loop points, finetune, default volume, root note.

Recommendation (not yet acted on): have the library emit a lean `TrackerSample`
descriptor and keep `sampler-patch-builder.ts` in the app as the adapter that
turns one into a `Patch`. That is the honest boundary, and it also takes the
last `app/public/wasm/audio_processor` type import out of the library path.

The alternatives are (b) emit `Patch` and make consumers ignore most of it, or
(c) emit both behind a flag. Both are worse; (b) exports the app's synth model
to people who did not ask for a synth.

Note this fork only touches the _instrument_ half of layer 2. The pattern half
was settled by the section above and is now done (§3c), so this question is all
that stands between the current state and a complete layer 2.

One extra data point from doing the pattern half: the seam is real and clean.
Neither `buildTrackerPatterns` nor anything it calls, in any of the three
importers, touched `Patch`, `SamplerLoopMode`, `InstrumentSlot` or
`createSamplerPatch`. So `buildInstrumentSlotsAndPatches` can be swapped for a
`TrackerSample`-emitting version without disturbing the row path at all — which
makes the recommended option cheaper than it looked when this was written.

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

**Answer the `TrackerSample` question in §6, then move the instrument half.**

That is now the only thing standing between the current state and a complete
layer 2, and it is a decision rather than a refactor — the refactor after it is
the same shape as §3c, which took an afternoon. The recommendation in §6 (emit a
lean `TrackerSample`, keep `sampler-patch-builder.ts` app-side as the adapter)
has not changed, and doing the pattern half made it look cheaper rather than
dearer: the two halves never touched.

Deciding it also removes the last `app/public/wasm/audio_processor` type import
from the library path, which is worth having before layer 4 rather than after.

**If you would rather do layer 4 first, you can.** The argument for doing the
pattern half before layer 4 was that a consumer could not otherwise load a file
at all; that no longer holds. Layer 4's sink interface can now be designed
against a library that already produces songs to feed it — the de-risking this
section previously predicted, now available. The only cost of going out of
order is that a standalone player will have no instruments to play until the §6
question is answered.

Whichever you pick: run the §5 checks after each step, not at the end. The
corpus suite is what makes this safe, and it caught nothing in §3c — but
typecheck caught two real errors, so run that after every step too.

### Two smaller things worth queuing after

- **The package has no README.** For "use it in other apps" that becomes the
  actual barrier the moment the code works. It should show the three-line
  parse-and-play path and say plainly which exports touch the DOM (§2).
- **The standalone check in §5 should be a checked-in script**, not something
  run by hand. The app resolves the package to source, so nothing in CI
  exercises `dist` at all — the one artifact external consumers actually get.

---

## 9. Related documents

- `PLAN-module-format-support.md` — the D-numbered log of format-accuracy fixes.
  Every `Dnn` reference in the replay code points there. Read it before changing
  effect behaviour; most of the odd-looking code is load-bearing and the comment
  usually names the module that forced it.
- `ARCH-REVIEW-s3m.md`, `TRACKER_WORKLET_SCHEDULING.md`, `WORKLET_POOLING.md` —
  background on the synth side, i.e. the parts a standalone player does _not_
  need.
