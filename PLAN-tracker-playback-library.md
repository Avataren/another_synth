# Extracting the tracker replay engine as a standalone library

**Goal.** Ship `@another-synth/tracker-playback` as a library other apps can use
to play MOD, XM, S3M and this app's own native songs, without dragging in
Quasar, Pinia, Vue, the Rust/WASM synth, or the pattern editor.

**Status.** Layer 1 done (2026-09-04). Layers 2–4 not started.

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
   |  buildPlaybackSong                        src/composables/useTrackerSongBuilder.ts
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

### The song builder is a pure function in Vue clothing

`src/composables/useTrackerSongBuilder.ts`, 490 lines. Contains **no**
`computed`, **no** `watch`, **no** internal `ref()`. It reads `.value` off
injected refs 24 times and that is the whole of its reactivity. `songBank` is
referenced on exactly two lines, both inside `syncSlots` — not inside
`buildPlaybackSong`, which is the function the engine path needs.

Corroborating evidence: every test that exercises it has to wrap plain values in
`ref()` purely to satisfy the signature. See `buildFrom` in
`src/tests/tracker-note-delay-without-volume.test.ts`.

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

## 4. Layers 2–4 — TODO

Estimates assume familiarity with the code; roughly a week in total for
something publishable.

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

### Layer 3 — song builder (hours)

Change `TrackerSongBuilderContext` from refs to plain values, move
`buildPlaybackSong` into the package as a free function, and have the composable
in `src/composables/` become a thin wrapper that unwraps `.value` and calls it.
`syncSlots` stays in the app — it is the only part that touches `songBank`.

Do this one _before_ layer 2 if you want an early win: it is small, it is
self-contained, and it deletes a lot of `ref()` noise from the tests.

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

**Does the library own the editor model at all?** Layer 2 as sketched moves
`TrackerEntryData` and friends into the package. That makes the library
opinionated about how a _song_ is represented, not just how one is _played_. The
alternative is for importers to emit `PlaybackSong` directly and leave the
editor model in the app — which would make layer 3 disappear, but would lose the
round-trip the pattern editor and exporter depend on.

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
