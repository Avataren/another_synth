# Architecture Review, 2026-09-22

Tree: `agent/arch-review-0922a` @ `e31dc0df`, clean. This builds on `ARCH-REVIEW-s3m.md` (2026-09-03, base `0b33571`).
Nothing was changed except this file and `.ai/checks-archreview.txt`.

Every `file:line` below was opened and checked against this tree. Line counts come from `wc -l` on this tree.

**Gates** (details in `.ai/checks-archreview.txt`):

| Gate | Result |
|---|---|
| `npx vue-tsc --noEmit` | 0 errors |
| `npm run lint` | 0 problems |
| `npm run test:run` | 233 files, 3743 tests, all passing |
| `gitleaks` | not run: the session's permission policy blocks the binary. Run it by hand. |

---

## 1. Status of the ARCH-REVIEW-s3m.md findings

| # | Finding (2026-09-03) | Status | Evidence (current tree) |
|---|---|---|---|
| S-1 | Strength: the FormatProfile spine; differences live in data | **still holds** | `profileForFormat` is at `packages/tracker-playback/src/format-profile.ts:991`. Its only format branches are profile *selection*: `:996` (XM Amiga), `:999-1001` (S3M/S3M_AMIGA), `:1010` (ProTracker limits). `sampler-instrument.ts` has 0 `ModuleFormat`/`moduleFormat` references. |
| S-2 | Strength: parser and import are separate (D23) | **still holds** | `parseS3m` is at `formats/s3m.ts:368`. Rows are built at `import/s3m-patterns.ts:199` and samples at `import/s3m-samples.ts:91`. The same split exists for MOD, XM and AHX. |
| S-3 | Strength: D78 has a single voice-resolution path | **still holds, moved** | `resolveCommandVoice` is now `src/audio/tracker/track-voice-registry.ts:285`. `song-bank.ts:1532,1576,1615,1646,1680,1714` all call `this.voices.resolveCommandVoice`. |
| §2a / P1 | Raw `(cmd, param)` bytes on `TrackerEntryData` (the blocker) | **fixed** | `tracker-types.ts:63-64` adds `effectCommand?/effectParam?`. `playback-song-builder.ts:166-169` prefers `decodeRawEffect(..., profile)` (`note-utils.ts:154`). The MOD, XM, S3M and AHX importers write the bytes (`mod-patterns.ts:472`, `xm-patterns.ts:174`, `s3m-patterns.ts:406`, `ahx-patterns.ts:157`). A hand edit drops them (`useTrackerEditing.ts:338,445,479`). One residue remains: effect column 2 is still text-parsed (`playback-song-builder.ts:170`). That is deliberate: it carries the pan macro (`s3m-patterns.ts:349`) and HVL's second FX column (`ahx-patterns.ts:167`), and AHX rows are display-only. |
| §2a (D52) | M/N/O/P shorthand collides with letter commands | **obsolete for imports, kept by design** | The shorthand still exists (`note-utils.ts:344`), but it now reaches only hand-authored rows, which is what §5 asked for. |
| §2b / P2 | `song-bank.ts` god class: split into 4 files + facade | **partially fixed** | Three pieces were extracted: `scheduled-events.ts` (139 lines), `recorder.ts` (77) and `track-voice-registry.ts` (335). `song-bank.ts` is 2756 lines (was 2949). The instrument-lifecycle piece was **not** extracted: `ensureInstrument` (`:1814`) through `teardownInstrument` (`:2539`), about 760 lines, is still in the class, and `queryWorkletCpu` is still at `:2718`. Finding N4 continues this. |
| §2c / P4 | Autovibrato cents-per-unit is hard-coded; should come from the pitch model | **fixed** | `PitchModel.vibratoDepthCents` is at `pitch-model.ts:169`, with implementations at `:298,:400,:597,:677`. It is used at `sampler-instrument.ts:710`. |
| §2c | `calculatePlaybackRate` relies on the musical-Hz contract | **still holds** | Moved to `sampler-instrument.ts:1163`, still A440-rooted (`:1173`). |
| P3 | Fill in the `S3M_PROFILE` fields and pitch model | **fixed** | `format-profile.ts:660-689`, plus `S3M_AMIGA_PROFILE` spread at `:784`. The landed `portamentoUnitScale` is 4 (`:669`), not the 1 the review suggested. That was a data decision made by the S3M work, and the corpus tests pass. |
| P5 | `formats/s3m.ts` + S3M importer | **fixed** | See S-2. S3M modules are in the event-stream corpus (139 goldens pass). |
| §3b / P6 | Split `mod-instrument.ts` (sample buffer / voice pool / autovibrato) | **superseded, partly done** | `src/audio/mod-instrument.ts` is now 109 lines. The DSP moved to `packages/tracker-playback/src/sampler-instrument.ts` (2168 lines), and conditioning was extracted to `sample-conditioning.ts` (316). The voice pool (`trackVoices :243`, `releasingVoices :254`) and autovibrato (`startAutoVibrato :678`, `stopAutoVibrato :797`) are still inline. |
| §3c / P6 | Split `effect-processor.ts` conservatively (state / waveforms / core) | **still open, grown** | 2454 lines (was 1961). `TrackEffectState` is at `:201`. `processEffectTick0` alone spans `:1082-1937` (~855 lines), and `processEffectTickN` starts at `:1938`. |
| §4 spec. | Adlib/OPL channel type: wait until needed | **partly overtaken** | `OplInstrumentData` now exists (`tracker-sample.ts:87`) and is used by `tracker-store.ts`. |
| §4 spec. | Per-format effect table for `parseEffectCommand` | **obsolete** | `decodeRawEffect(cmd, param, profile)` is that table, driven by the profile. |
| §5 | Don't split `engine.ts` | **still sensible, pressure rising** | `engine.ts` is 2354 lines (was 1918). `scheduleRow` spans `:1321-1876` (~555 lines, was ~400). The only native check is `:1575`. |
| §5 | Keep `channelsAreMonophonic` a boolean | **still holds** | `song-bank.ts:798`. |
| §5 | Leave worklet pooling alone | **no longer right**: the pooling path has scoping holes (N1) | See N1. |

---

## 2. New findings

Risk classes: **safe-TS-Vue**, **needs-store-refactor**, **touches-rust-wasm-engine**, **risky-migration**.

### N1: Several synth-worklet paths ignore a pooled slot's `instrumentId`, so edits land on the wrong engine or nowhere
- **What.** The 2026-08 fix scoped `createNode` and `updateConnection` to the slot's engine (AGENTS.md "Worklet graph editing sync"). Four other paths were never scoped:
  1. **Delete node is a silent no-op for song instruments.** `PooledInstrument.deleteNode` does nothing (`src/audio/pooled-instrument-factory.ts:1122-1124`). The worklet handler is unscoped anyway (`src/audio/worklets/synth-worklet.ts:472-477`, which uses `getGraphEngines()`, i.e. every slot's engine).
     - The trigger is the node tab's close button. `GenericTabContainer.vue:146-170` calls `store.currentInstrument?.deleteNode(nodeId)` and then `connectionStore.deleteNodeCleanup`, which drops the node from the layout and node-state stores (`connection-store.ts:155-157`).
     - When a song instrument is being edited live, `currentInstrument` is the pooled slot (`IndexPage.vue:487-490` calls `useExternalInstrument`, typed `InstrumentV2 | PooledInstrument` at `instrument-store.ts:201`).
     - Result: the node disappears from the UI and from the saved patch but keeps sounding until the next reload.
  2. **The impulse-response import always goes to engine 0.** `handleImportImpulseWaveformData` calls `this.audioEngines[0].import_wave_impulse` (`synth-worklet.ts:655-667`) and ignores the `instrumentId` that `PooledInstrument.importImpulseWaveformData` sends (`pooled-instrument-factory.ts:1078-1085`).
     - This runs on **every song load** for instruments with an IR asset (`song-bank.ts:2142-2143` in `restoreAudioAssets`), as well as from `ConvolverComponent.vue:184`.
     - With `ENGINES_PER_WORKLET = 2` (`worklet-config.ts:23`), a slot on engine 1 keeps the default IR, and engine 0's convolver gets someone else's.
  3. **Sample and convolver export read engine 0 only** (`synth-worklet.ts:2027-2031`, `:2053-2057`), even though the pooled side sends `instrumentId` (`pooled-instrument-factory.ts:1449-1454`).
     - `patch-store.ts:751-752, 832-833, 920-921` export assets from `currentInstrument as InstrumentV2`, so saving a live-edited song instrument whose slot is not on engine 0 exports from the wrong engine.
     - The extractor then drops the empty result and falls back to `assetStore`, so an asset changed during the live edit is silently not captured.
- **Why it matters.** These are audible, user-facing errors: the wrong reverb on song load, a phantom node after a delete, and a lost asset on save. They are also the exact class AGENTS.md already calls out ("never only `audioEngines[0]`").
- **Fix sketch.**
  - In the worklet, route `deleteNode`, `importImpulseWaveform`, `exportSampleData` and `exportConvolverData` through `getTargetEngines(data.instrumentId)` (`synth-worklet.ts:2427`). For `deleteNode`, mirror `createNode`'s pooled reply, i.e. post that slot's refreshed layout.
  - Implement `PooledInstrument.deleteNode` to post `{type:'deleteNode', nodeId, instrumentId}`.
  - Add real-worklet cases to `src/tests/worklet-graph-sync.test.ts`: two slots on different engines, and assert that only the target engine sees each operation.
  - Rebuild the committed `public/worklets/synth-worklet.js` with `npm run build:worklets`. That is esbuild only; no Rust is involved.
- **Size:** S–M. **Risk:** safe-TS-Vue.

### N2: The playback store implements two transports inline, with a format branch in every verb
- **What.** `useTrackerPlaybackStore` drives either `PlaybackEngine`+`TrackerSongBank` or the AHX worklet transport, and it decides which with an `if` in each verb:
  - `loadSong :1088`, `play :1149`, `pause :1201-1205`, `resume :1217-1225`, `stop :1234-1242`, `seek :1261-1268`, `setBpm :1279`, `setPatternLength :1288`, `applyAudibilityChange :1302`, `setLoopSong :1427-1428`.
  - About 540 lines of AHX orchestration sit inside the store (`src/stores/tracker-playback-store.ts:487-1026`).
  - Engine handles and listener sets are module-level singletons (`:69-106`).
  - AHX document state is also module-level, in `src/audio/tracker/ahx-source.ts:75-96` (`current`, `previewBytes`, `edits`, three listener sets), and is invisible to Pinia.
- **Why it matters.**
  - Every transport feature has to be written twice and kept in sync by hand. Top-bar play, fullscreen transport, jukebox and mute/solo all landed in the last few weeks.
  - What a transport cannot do is implicit, not declared. `setBpm` and `setPatternLength` silently return for AHX.
  - Because `PlaybackSong` assembly lives in the page (`useTrackerSongBuilder`), the store has to cache `lastPlaybackSong` (`recordLastSong :171`) to replay. `plan-fullscreen-transport.md:56-62` (D-B) records that the layout cannot build a song itself.
  - This store is the most-touched file in recent feature work. That makes it the highest-leverage refactor for user-facing reliability.
- **Fix sketch.**
  - Define `interface SongTransport { load; play; pause; resume; stop; seek; setLoop; setMuteSolo; setBpm?; setPatternLength?; readonly capabilities; dispose }`.
  - Add `SampleTransport`, which wraps `PlaybackEngine` and the bank (moving `:1031-1063` and `:1140-1290`).
  - Add `AhxSongTransport`, which moves `:487-1026` and owns the reload scheduler, preview and epoch.
  - The store keeps one `active: SongTransport` and the reactive state (`isPlaying`, `playbackRow`, mute/solo). Each verb becomes `active.x()`. The UI reads `capabilities` instead of guessing.
  - Do it in steps: extract `AhxSongTransport` first behind the unchanged store API. The gate is `src/tests/stores/tracker-playback-ahx-routing.test.ts` (1013 lines) plus `playback-store-replay.test.ts`.
- **Size:** L. **Risk:** needs-store-refactor.

### N3: Tests consume committed build artifacts, and nothing checks they match source (no CI)
- **What.**
  - `public/wasm/audio_processor_bg.wasm`, `public/wasm/audio_processor.js` and `public/worklets/{synth,ahx,effects,recording}-worklet.js` are tracked in git: `.gitignore` has no entry for them, and `git ls-files` lists them.
  - They are rebuilt by `build-wasm.cjs:94-101` and `build-worklets.cjs:6-14`.
  - 9 files under `src/tests/` (tests plus `helpers/ahx-render.ts`) load them directly, for example `src/tests/ahx-worklet-shell.test.ts:21,29` (the *built* `ahx-worklet.js` plus the real wasm) and `ahx-worklet-core.test.ts:70`. Meanwhile `vitest.config.ts:34-35` mocks the wasm JS module for everything else.
  - The repo has no CI config (no `.github/`, `.gitlab-ci`, or hooks).
  - The only freshness mechanism is agent discipline. Today the wasm happens to be in sync: `public/wasm/audio_processor_bg.wasm` and `rust-wasm/src` were both last changed in `0242229e`.
- **Why it matters.**
  - A Rust or worklet-TS change committed without a rebuild ships stale binaries, and the TS suite keeps passing because it tests the old binaries.
  - N1's fix needs a worklet rebuild, so it is exposed to exactly this.
  - Deploy builds fresh (`scripts/deploy.sh:34`), so production and tests can diverge in both directions.
  - Also stale: `public/worklets/wasm/audio_processor_bg.wasm` is a 20 KB AssemblyScript-era file, last touched 2024-12-09, unreferenced, and different from the real one.
- **Fix sketch.**
  - (a) Add `scripts/check-artifacts.mjs`. It rebuilds the worklets with esbuild into a temp dir and byte-compares them with `public/worklets/*.js`.
  - (b) Have `build-wasm.cjs` write `public/wasm/SOURCE_HASH` (sha256 over `rust-wasm/src/**`, `Cargo.toml`, `Cargo.lock`). Add a vitest test that recomputes the hash and fails with "rebuild wasm" on mismatch.
  - Seeding the hash needs no rebuild, because the current binary and source share the same last commit.
  - (c) Run (a) and (b) as a `pretest`-style step or a pre-commit hook.
  - (d) Delete `public/worklets/wasm/`.
- **Size:** S. **Risk:** safe-TS-Vue (build scripts and tests only; Rust source untouched).

### N4: `TrackerSongBank` still owns the instrument lifecycle, over a three-way instrument union with no shared interface
- **What.**
  - `ActiveInstrument.instrument: InstrumentV2 | ModInstrument | PooledInstrument` (`src/audio/tracker/song-bank.ts:125-130`) has no common interface.
  - Callers probe at runtime: `instanceof` at `:376, 436, 441, 1340, 2543-2544, 2621, 2686`, `'loadPatch' in` at `:2701`, and an `as unknown as { getParamName? }` probe on **every scheduled note** (`:1397-1418`, two `parameters.get` lookups plus string building per note-on).
  - `PooledInstrument` (1512 lines) duplicates `InstrumentV2`'s allocator, glide and update surface (`allocateVoice`, `findNextFreeVoice`, `releaseVoice`, `markVoiceActive`, `midiNoteToFrequency` in both files: `instrument-v2.ts:1764-2048` vs `pooled-instrument-factory.ts:666-774`).
  - The stores cast it away: `instrument-store.ts:102` and `patch-store.ts:368,374,439,752,833,921` use `as InstrumentV2`.
  - The song bank's `InstrumentV2` branch (`song-bank.ts:2024-2070`) is unreachable in practice. `useWorkletPooling` is `true` and never reassigned (`:178`), and `workletPool` is nulled only in `dispose()` (`:701`). That leaves `waitForInstrumentReady` (`:2201`) and `applyNodeStates` (`:2325`) reachable only from that branch.
  - The debug "Decision" log (`:1943-1949`) reports "InstrumentV2 (LEGACY …)" for non-MOD patches, but the code at `:1967` actually builds a `PooledInstrument`.
- **Why it matters.** The union is why N1's scoping holes type-check. It is also why each new instrument capability becomes a new `instanceof` in the bank. And the lifecycle code (~760 lines) is the part of the bank the 2026-09-03 plan (§3a `instrument-lifecycle.ts`) never extracted.
- **Fix sketch.**
  1. Declare `interface BankInstrument` from the ~20 members the bank actually calls (noteOnAtTime, gateOffVoiceAtTime, setOutputGain, importSampleData, …) and make all three classes `implements` it.
  2. Declare `interface EditableInstrument` for the editor surface that `instrument-store`/`patch-store` use, and delete the `as InstrumentV2` casts.
  3. Move `ensureInstrument*`, `restoreAudioAssets`, `normalizePatch*`, `applyMacrosFromPatch`, `teardownInstrument` and `buildSamplerUpdatePayload` into `instrument-lifecycle.ts`.
  4. Delete the unreachable `InstrumentV2` branch and its helpers, or make it an explicit option.
  5. Move the per-note param probe behind a debug flag.
  - Gate: `tracker-channel-voice-addressing` tests plus the song-bank tests.
- **Size:** M–L. **Risk:** safe-TS-Vue (behavioural; needs characterization tests before step 3).

### N5: Rust WAV decoding `unwrap()`s every sample; with `panic = "abort"`, a malformed file traps the shared worklet
- **What.** Three copies of the same decoder call `.map(|s| s.unwrap())` per sample:
  - `rust-wasm/src/audio_engine/wasm.rs:65-83` (`import_wav_hound_reader`, wavetables)
  - `:1365-1381` (`import_wave_impulse`)
  - `:2014-2030` (`import_sample`)

  `hound`'s sample iterator yields `Err` on a truncated `data` chunk. The release profile uses `panic = "abort"` (`rust-wasm/Cargo.toml:56`), so the panic becomes a wasm `unreachable` trap mid-call. All three functions already return `Result<_, JsValue>`, so the error has somewhere to go.
- **Why it matters.**
  - One pooled worklet hosts several instruments' engines in one wasm instance (`ENGINES_PER_WORKLET`).
  - The trap happens inside a `&mut self` call, so that engine's state after it is undefined, and a single bad user-imported WAV (sampler or convolver) can silence or corrupt every instrument on that worklet.
  - The worklet wraps these calls in `try/catch` (e.g. `synth-worklet.ts:691-698`). That catches the JS exception, but it cannot restore the engine's state.
- **Fix sketch.**
  - Hoist one `decode_wav_samples(reader) -> Result<Vec<f32>, String>` that uses `collect::<Result<Vec<_>, _>>()`.
  - Call it from all three sites and map the error to `JsValue`.
  - Add a Rust unit test with a truncated WAV.
- **Size:** S. **Risk:** touches-rust-wasm-engine.

### N6: About 4,600 lines of dead source, and AGENTS.md still describes it as the architecture
- **What.** These files have zero importers:
  - `src/audio/instrument.ts` (1010), `src/audio/voice.ts` (116), `src/audio/processor.ts` (250), `src/stores/example-store.ts` (15)
  - `src/audio/worklets/handlers/worklet-message-handlers.ts` (428) and `oscillator-update-handler.ts` (8)
  - `src/audio/adapters/wasm-engine-adapter.ts` (660). Its only importer is the dead handlers file.
  - `src/audio/worklets/synth-worklet.ts.backup` (1986) and `src/audio/instrument-v2-pooled.ts.unused` (155)
  - AssemblyScript leftovers: `asconfig.json` (targets `public/wasm/release.wasm`), `package.json:70-75` `exports` pointing at `./build/release.js`, and the `assemblyscript` devDependency.

  `AGENTS.md:819-826` still says "Phase 2: Update Worklet … Migration In Progress", with `worklet-message-handlers.ts` as the path forward.
- **Why it matters.** Agents follow AGENTS.md. Grep hits in dead twins (for example `instrument.ts:289` `importImpulseWaveformData`) waste review time and hide real call sites.
- **Fix sketch.** Delete the files. Mark the typed-protocol migration in AGENTS.md as abandoned and point to N7. Remove the AssemblyScript config.
- **Size:** S. **Risk:** safe-TS-Vue.

### N7: The worklet message protocol is untyped at the point that matters
- **What.**
  - `src/audio/types/worklet-messages.ts` (688 lines) exists, but the worklet dispatches on `event.data.type` from an untyped `MessageEvent` (`synth-worklet.ts:264-265`) and imports only `LoadPatchMessage` (`:47`).
  - Each handler declares its own ad-hoc parameter shape. `InstrumentV2` and `PooledInstrument` each post about 36 messages, built as object literals.
- **Why it matters.** Message drift is invisible to `vue-tsc`. N1 is the proof: the sender adds `instrumentId`, the receiver's handler type omits it, and nothing complains.
- **Fix sketch.**
  - Make `WorkletInboundMessage` a discriminated union in `worklet-messages.ts` and type `handleMessage(event: MessageEvent<WorkletInboundMessage>)`.
  - Give every pool-scoped message a required `instrumentId?: string` field in the union.
  - Have both instrument classes build messages through a typed `post(msg: WorkletInboundMessage)`.
  - This can be done one message at a time. Start with the four in N1.
- **Size:** M. **Risk:** safe-TS-Vue.

### N8: The engine choice for module instruments is app-global, not per-song (D4 still open)
- **What.** `song-bank.ts:1911-1928` chooses between `ModInstrument` and the worklet path from `userSettings.settings.useSimplifiedModInstruments`, and the code comment itself says this should move to the `FormatProfile` per D4. The same setting also decides whether live editing is possible: `IndexPage.vue:440` and `:487` skip `ModInstrument`.
- **Why it matters.** One persisted toggle (`SETTINGS_VERSION = 7`, `user-settings-store.ts:191`; default at `:211`) silently changes playback fidelity and editability for every song.
- **Fix sketch.** Add `FormatProfile.instrumentEngine: 'sampler' | 'worklet'` and read it in `ensureInstrumentInternal`. Keep the setting only as a debug override, and migrate it with a settings version bump.
- **Size:** M. **Risk:** risky-migration (a persisted settings migration, and it changes the default audio path).

### N9: `TrackerPage.vue` is 4220 lines
- **What.** The template is `:1-927`, the script `:928-2887` (with 10+ `useTracker*` composables already extracted) and the scoped style `:2889-4220`. The largest remaining cohesive block is scroll-sync and visualizer alignment (`:1747-2016`: `resolvePatternTracksWrapper` … `setupTrackScrollSync`), which adds and removes 6 DOM listeners by hand.
- **Why it matters.** Every tracker UI change lands in this file, and the manual listener lifecycle is a leak and regression risk.
- **Fix sketch.** Extract `useTrackerScrollSync(refs)` (the listeners belong in the composable's own `onBeforeUnmount`). Move the style block to `tracker-page.scss`.
- **Size:** M. **Risk:** safe-TS-Vue.

### N10: Too much logging on playback and instrument-build paths
- **What.**
  - `song-bank.ts` has 46 `console.log`s, including a 7-line "DETAILED DEBUGGING" block per instrument created (`:1930-1950`).
  - `tracker-playback-store.ts` logs on every load and play (`:1079-1080`, `:1146-1148`).
  - `quasar.config.ts` has no `drop`/`pure` console stripping.
- **Why it matters.** A 30-instrument XM logs hundreds of lines at play start, on the same main thread whose longtasks `song-bank.ts:82-95` works hard to slice. The noise also buries real warnings.
- **Fix sketch.** Add a `debugLog(tag, …)` gated on the existing `?diag=` mechanism (there is a `playback-diagnostics` test for it). Convert the per-instrument and per-play logs.
- **Size:** S. **Risk:** safe-TS-Vue.

### N11: The CPU meter in the engine uses millisecond timing and a hard-coded 128-frame quantum
- **What.** `wasm.rs:765` times each block with `js_sys::Date::now()`, which has 1 ms resolution against a ~2.9 ms quantum. `:914` assumes `128.0 / sample_rate` regardless of the `frames` actually processed (`:770`).
- **Why it matters.** The per-instrument CPU readout is quantized noise. It is display only and does not affect audio.
- **Fix sketch.** Use `frames as f64 / sample_rate`, and time with `performance.now()` from the worklet side, or accumulate across blocks before sampling.
- **Size:** S. **Risk:** touches-rust-wasm-engine.

---

## 3. Top 5, ranked by user impact × architectural leverage

| Rank | Issue | Fix order | Why this rank |
|---|---|---|---|
| 1 | **N1:** pooled-slot scoping holes (delete no-op, IR to engine 0, export from engine 0) | **1st** | The worst audible, data-affecting bug: it misroutes on every song load with an IR asset and on every live-edit save, and the fix is small. |
| 2 | **N2:** two transports inline in the playback store | **4th** | The largest leverage: every future transport feature is written once instead of twice. It is ranked below N1 for impact, and ordered after N3 and N4 because it is the largest change and benefits from their gates and interfaces. |
| 3 | **N5:** WAV decode `unwrap()` traps the shared worklet | **with the human, in parallel** | A malformed WAV can kill several instruments at once. The fix is trivial but in Rust, so it is not for autonomous work. |
| 4 | **N3:** committed build artifacts, no freshness gate, no CI | **2nd** | It protects every other fix, N1 first, since N1 must rebuild `synth-worklet.js`. The cost is small and it removes a whole class of "tests pass on stale binaries". |
| 5 | **N4:** song-bank lifecycle and the untyped three-way instrument union | **3rd** | The root cause that let N1 type-check. The interface it introduces also removes the `as InstrumentV2` casts in the stores, and it finishes the 2026-09-03 plan's §3a. |

Honourable mentions, cheap and worth bundling: **N6** (dead code and stale AGENTS.md, any time, S) and **N7** (typed protocol, done incrementally with N1).

## 4. Autonomous vs human-gated

**Safe to fix autonomously (TS, Vue and store work):**
- **N1:** worklet TS plus `PooledInstrument`. It needs `npm run build:worklets` (esbuild only) and a commit of the rebuilt `public/worklets/synth-worklet.js`. Rust is untouched.
- **N3:** build scripts and a vitest guard. Seeding `SOURCE_HASH` needs no wasm rebuild, because the binary and source are in sync at `0242229e`.
- **N4:** a behavioural TS refactor. Characterization tests come first.
- **N2:** needs-store-refactor, but TS-only. Do it in steps (extract `AhxSongTransport` first) behind the unchanged store API, with `tracker-playback-ahx-routing.test.ts` as the gate.
- Also safe: **N6, N7, N9, N10.**

**Bring to the human, do not fix autonomously:**
- **N5** (touches-rust-wasm-engine): an S-sized Rust change, then a wasm rebuild and a commit of the new `public/wasm/*` binaries.
- **N11** (touches-rust-wasm-engine): low value; batch it with N5 if Rust is being rebuilt anyway.
- **N8** (risky-migration): a persisted-settings migration that changes the default instrument engine for module playback, and it needs a product decision on D4.
- **§3c effect-processor and the `engine.ts` split** (carried over): not recommended now. They are regression-sensitive, `processEffectTick0` alone is ~855 lines, and there is no user-facing gain. If pursued, only the mechanical `effect-state.ts`/`waveforms.ts` move, gated by the 139-module event-stream goldens.
