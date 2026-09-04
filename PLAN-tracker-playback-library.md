# Extracting the tracker replay engine as a standalone library

**Goal.** Ship `@another-synth/tracker-playback` as a library other apps can use
to play MOD, XM, S3M and this app's own native songs, without dragging in
Quasar, Pinia, Vue, the Rust/WASM synth, or the pattern editor.

**Status.** Layers 1 and 3 done (2026-09-04). Layer 2 not started; layer 4
not started. Layer 3 is done except for physically moving the file into the
package, which is blocked on an open decision — see §6.

This document is written to be picked up cold, in a new session, by someone (or
some model) with no memory of the work. It records what was measured, what was
decided and why, and what to do next — in that order. Numbers in it were
measured on commit `417094f`; re-measure before trusting them if the tree has
moved on.

---

## 1. The pipeline, end to end

A module goes through five stages. Knowing which stage a problem lives in is
most of the work of fixing it.

```
file bytes
   |
   |  parseMod / parseXm / parseS3m            packages/tracker-playback/src/
   v                                           (mod-parser.ts, formats/*.ts)
parsed module  (samples, patterns, orders, raw effect bytes)
   |
   |  importModToTrackerSong / Xm / S3m        src/audio/tracker/*-import.ts
   v
TrackerSong  (the app's editor model: patterns of TrackerEntryData,
   |          instrument slots, one sampler Patch per sample)
   |
   |  buildPlaybackSong                        src/audio/tracker/playback-song-builder.ts
   |    (useTrackerSongBuilder is the Vue wrapper around it)
   v
PlaybackSong  (the engine's input: patterns of Step)
   |
   |  PlaybackEngine.scheduleRow / scheduleAhead    packages/tracker-playback/src/engine.ts
   |  + processEffectTick0 / TickN                  packages/tracker-playback/src/effect-processor.ts
   v
scheduled events  ("note on, track 3, at t=1.2s", "volume 0, step, at t=1.3s")
   |
   |  the Scheduled*Handler callbacks          src/stores/tracker-playback-store.ts
   v                                           -> src/audio/tracker/song-bank.ts
TrackerSongBank -> ModInstrument -> Web Audio   src/audio/mod-instrument.ts
```

The library boundary today sits between stage 4 and stage 5: the engine emits
events and knows nothing about how they are sounded.

---

## 2. What was measured

Facts worth not re-deriving. All of these were checked directly, not assumed.

### The core is already dependency-free

`packages/tracker-playback/src` is ~8,000 lines and imports **nothing** outside
itself — no `src/`, no npm runtime dependency. Verified by listing every import
specifier in the package: they are all relative, plus `vitest` in the specs.

It is **not** DOM-free, though. `clock.ts` uses `document` (visibilitychange),
`scheduler.ts` and `engine.ts` reference `AudioContext` and
`setTimeout`/`setInterval`. So its tsconfig needs `"lib": [..., "dom"]`. That is
fine for a browser audio library, but it is the reason a Node consumer must not
touch `createVisibilityClock` / `createAudioContextScheduler`. Everything else —
parsers, effect processor, engine construction — runs headless. Proven by
importing the built `dist` from a plain Node script (see §5).

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

## 3b. Layer 3 — DONE (except the move)

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

### What is left of layer 3

Moving `playback-song-builder.ts` into the package. That is blocked, not
forgotten: it converts _the app's editor model_ into `PlaybackSong`, so it only
belongs in the library if the library owns that model — which is exactly the
open question in §6. Under the alternative (importers emit `PlaybackSong`
directly), this file is an app-side adapter and should stay where it is.

Everything of value in layer 3 — the function being callable without Vue — is
already delivered either way.

### Verification performed

| Check                                   | Result                          |
| --------------------------------------- | ------------------------------- |
| `npm test`                              | 109 files, 1598 tests, all pass |
| `npx vue-tsc --noEmit -p tsconfig.json` | clean                           |
| `npm run lint`                          | clean                           |

No behaviour changed, so no new tests: the existing 1598 passing unchanged _is_
the assertion. The six migrated files exercise the new plain-value path.

---

## 4. Layers 2 and 4 — TODO

Estimates assume familiarity with the code.

### Layer 2 — importers (~1 day)

Move `mod-import.ts`, `xm-import.ts`, `s3m-import.ts`, `sampler-patch-builder.ts`
and `note-utils.ts` into the package.

1. Replace `uid()` from quasar with `crypto.randomUUID()`.
2. Move `TOTAL_SLOTS` and `CURRENT_SONG_FILE_VERSION` out of the Pinia store
   into a plain constants module the store re-exports (so the store stays the
   app's single source of truth for the UI, without the library importing it).
3. Move the type declarations the importers need (`TrackerEntryData`,
   `TrackerTrackData`, `TrackerPattern`, `InstrumentSlot`) into the package and
   have the app re-export them, not the other way around.
4. `SamplerLoopMode` is a runtime enum — decide whether it moves or gets mirrored
   (see §6).

Nothing here is hard; the risk is doing it without running the corpus tests
after each step.

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
npm test                          # 109 files / 1598 tests
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
  console.log(lib.looksLikeMod(b), lib.parseMod(b).title);
});
"
```

---

## 6. Open decisions

Not blockers, but they shape the API and are better settled early than
retrofitted.

**What shape do the importers emit?** Today they build the app's `Patch` — a
full synth preset with modulation routing, envelopes and macro assignments,
because in this app a MOD sample _is_ a sampler patch. A standalone consumer
almost certainly wants something leaner: sample data, loop points, finetune,
default volume, root note. Options: (a) emit the lean descriptor and let the app
adapt it into a `Patch`; (b) emit `Patch` and make consumers ignore most of it;
(c) emit both behind a flag. (a) is the honest boundary but is the most work,
because `sampler-patch-builder.ts` (440 lines) is entirely about building
`Patch`es.

**Does the library own the editor model at all?** This is now the decision that
gates the rest, because layer 3 stopped on it.

Layer 2 as sketched moves `TrackerEntryData` and friends into the package. That
makes the library opinionated about how a _song_ is represented, not just how
one is _played_ — and it is what would let `playback-song-builder.ts` move in
too. The alternative is for importers to emit `PlaybackSong` directly and leave
the editor model in the app; then `playback-song-builder.ts` is an app-side
adapter that stays put, and the library's story is "bytes in, scheduled events
out".

Cheapness is not the tiebreaker — the move itself is small. `note-utils.ts` (457
lines) imports only types from `tracker-types` plus `FormatProfile` from the
package; `tracker-types.ts` is 76 lines of pure interfaces; `TrackerPattern` is
an 11-line interface; and `InstrumentSlot` is only needed by
`syncSongBankFromSlots`, which stays in the app regardless. Leaving the app-side
files as re-export shims would make the blast radius zero. The question is
whether owning an editor model is the library's job, not whether it is
affordable.

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
  restore.
- **Prettier reports pre-existing failures.** `npm run format --check` flags files
  nobody touched, mostly line-ending related. Compare against the file's own
  prettier output before assuming your change caused it.
- **A full `npm run build` needs the Rust/WASM toolchain.** `npx quasar build`
  alone is enough to verify the frontend, and reuses the checked-in
  `public/wasm` artifacts.

---

## 8. Related documents

- `PLAN-module-format-support.md` — the D-numbered log of format-accuracy fixes.
  Every `Dnn` reference in the replay code points there. Read it before changing
  effect behaviour; most of the odd-looking code is load-bearing and the comment
  usually names the module that forced it.
- `ARCH-REVIEW-s3m.md`, `TRACKER_WORKLET_SCHEDULING.md`, `WORKLET_POOLING.md` —
  background on the synth side, i.e. the parts a standalone player does _not_
  need.
