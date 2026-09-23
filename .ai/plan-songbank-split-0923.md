# Plan: arch-fix pass 3 — song-bank §2b lifecycle split + N4 shared instrument interface

Branch `agent/songbank-split-0923a`, worktree `.ai/worktrees/songbank-split`,
base main `6123b5f4` (== origin/main, verified 08:52). Findings:
`.ai/arch-review-2026-09-22.md` §2b + N4. Pure refactor — zero behavior
change is the bar. No `public/`, `rust-wasm/`, `TrackerPage`/`IndexPage.vue`,
no audio-graph changes.

## Facts (MEASURED at 6123b5f4)

- `song-bank.ts` 2764 lines. Lifecycle block to extract (review §2b/N4 step 3):
  - `ensureInstrument` :1814, `ensureInstrumentInternal` :1842-2095
  - `normalizeVoiceGain` :2097, `restoreAudioAssets` :2104, `applyMacrosFromPatch` :2165
  - `waitForInstrumentReady` :2228, `hasActivePortamento` :2246, `normalizePatch` :2258
  - `normalizePatchLayout` :2331, `normalizePatchMetadata` :2335, `mapToRecord` :2368
  - `applyNodeStates` :2377, `clamp01` :2492, `buildSamplerUpdatePayload` :2497
  - `applySamplerStates` :2529, `parseWavInfo` :~2540, `getPatchReuseKey` :2567
  - `teardownInstrument` :2586
- Non-lifecycle users of the block: `updatePatchLive` :2611-2657 and
  `updateStoredPatch` :2672-2720 call `normalizePatch` / `restoreAudioAssets` /
  `getPatchReuseKey` / `hasActivePortamento`; `syncSlots`/`prepareInstrument`
  call `ensureInstrument`; teardown callers `:2054` (inside
  ensureInstrumentInternal), `disposeInstruments` region.
- State the block touches: `generation` (read :1817, compare :2087),
  `pendingInstruments` (:1819-1838), `wasSuspended`/`needsAudioContextResume`
  (write :1857-1863), `instruments` map, `masterGain`, `audioSystem`,
  `audioContext` getter, `formatProfile` (read :1933 — mutable via
  `setModuleFormat` :767), `useWorkletPooling` :178 (literal true, never
  reassigned), `workletPool` (:176, nulled only in `dispose()` :701),
  `restoredAssets` (:153), `activeNotes` (:delete in teardown :2610),
  `voices.removeInstrument` (:2611), `eventQueue.flushPendingScheduledEvents`
  (:2081, :2093), `masterGain` reconnect (:1914-1918).
- N4 probe sites (review N4 "What"): `instanceof` at song-bank.ts :380, :436,
  :441, :1341, :2544-2545 (teardown), :2621 (updatePatchLive), :2695
  (updateStoredPatch `num_voices`), `'loadPatch' in` :2708, per-note
  `as unknown as { getParamName? }` probe :1397-1418.
- Store casts (MEASURED at current main; review claimed patch-store
  :752/:833/:921 — those sites now pass `instrumentStore.currentInstrument`
  to `extractAllAudioAssets` whose param is already the `AudioAssetSource`
  interface (audio-asset-extractor.ts:114), no cast there today): live casts
  are patch-store.ts :368, :374, :439 (`as InstrumentV2 | null`), and
  instrument-store.ts :102 (`() => this.currentInstrument as InstrumentV2 |
  null` feeding `AudioSyncManager`, sync-manager.ts:53). instrument-store
  `currentInstrument: InstrumentV2 | PooledInstrument | null` (:18); created
  as `new InstrumentV2` :86, or swapped from the song bank via
  `setCurrentInstrumentFromBank` (:45).
- `ModInstrument` (mod-instrument.ts, 109 lines) extends library
  `TrackerSamplerInstrument` (packages/tracker-playback/src/sampler-instrument.ts,
  2168 lines). The library class already carries the polymorphic surface the
  bank calls, including `outputNode` (:296) and `workletNode: AudioWorkletNode
  | null = null` (:2167) — ModInstrument's workletNode is therefore always
  null, which is why `dispatchNoteOnAtTime`'s per-note param probe
  (:1399-1423) is a no-op for ModInstrument (guards on `worklet` truthiness).
- `setEnvelopePositionAtTime` is reached via a second inline structural probe
  (`target.active.instrument as { setEnvelopePositionAtTime? }`,
  song-bank.ts :1654-1656).

## Stage 1 — N4 step 1: `BankInstrument` interface

- New file `src/audio/tracker/bank-instrument.ts`:
  `export interface BankInstrument` with the members the bank calls on the
  union (noteOnAtTime, noteOffAtTime, noteOn, noteOff, gateOffVoiceAtTime,
  cancelScheduledNotes, cancelAndSilenceVoice, allNotesOff, setOutputGain,
  getOutputGain, getQuantumDurationSeconds, getVoiceLimit, setGainForAllVoices,
  setVoiceFrequencyAtTime, setVoiceGainAtTime, setVoiceMacroAtTime,
  setEnvelopePositionAtTime? (optional — probe site :1654), loadPatch,
  isReady, outputNode, workletNode, dispose). Optional: `getParamName?`.
- `ActiveInstrument.instrument: BankInstrument` (song-bank.ts :126-131);
  all three classes declare `implements BankInstrument`.
- `getInstrument` return type widens to `BankInstrument | null` (same union
  members, single named type).
- Zero behavior change: pure typing; runtime probes that remain are the ones
  that need concrete-class members (`instanceof PooledInstrument` for pool
  deallocation :2544, `num_voices` :2695 — concrete members, not on the
  interface).
- Gate: test:run, lint, vue-tsc, gitleaks, check:artifacts.

## Stage 2 — N4 step 2: `EditableInstrument`, remove store casts

- Inventory the editor surface first (sync-manager.ts, asset-store
  restoreAudioAssets, restoreGeneratedConvolvers): declare
  `EditableInstrument` in bank-instrument.ts from what the stores actually
  call; `AudioSyncManager` constructor param becomes
  `() => EditableInstrument | null`; delete the three patch-store casts and
  the instrument-store.ts:102 cast.
- If any store member is genuinely InstrumentV2-only and PooledInstrument
  lacks it, the cast stays and the finding is reported as PARTIAL with the
  reason. No behavior change either way.

## Stage 3 — §2b: extract `instrument-lifecycle.ts`

- House pattern (track-voice-registry.ts / recorder.ts): verbatim move as one
  gated unit, deps-injected, extracted class constructed in the bank's
  constructor, header comment records the extraction.
- Moved: the 18 methods listed above. Bank keeps thin delegates where the
  call sites are wide (`this.lifecycle.ensureInstrument(...)`,
  `this.lifecycle.teardownInstrument(...)` etc. — call sites updated to the
  lifecycle handle, matching the `this.voices.*` pattern).
- Injected deps (functions for mutable bank state, shared maps by reference,
  house style): `instruments`, `activeNotes`, `eventQueue`, `voices`
  (removeInstrument), `masterGain`, `audioSystem`, `formatProfile: () =>
  FormatProfile`, `useWorkletPooling: () => boolean`, `workletPool: () =>
  WorkletPool | null`, audioContext, resume-flag accessors
  (`wasSuspended`/`needsAudioContextResume` via a small shared flags object so
  bank-side readers (syncSlots, onstatechange) see the writes), `generation`
  via `() => number`.
- `restoredAssets` map MOVES into the lifecycle module (only
  restoreAudioAssets + teardown touch it — MEASURED).
- Dispatch note: `ensureInstrumentInternal` writes `this.wasSuspended` /
  `this.needsAudioContextResume`; bank reads them in syncSlots and
  onstatechange. Shared flags object preserves both directions.

## Stage 4 — N4 steps 4-5 (bounded)

- Step 4 (delete unreachable InstrumentV2 branch): NOT DONE this pass.
  MEASURED: the branch (:2024-2070 region) is reachable whenever
  `workletPool` is null — after `dispose()` (:701) or if pool construction
  failed; `waitForInstrumentReady`/`applyNodeStates` are its helpers. Tests
  may construct the bank against a bare AudioContext. Deleting is a
  behavioral cleanup that needs its own characterization pass; keeping it
  typed under BankInstrument is the zero-behavior choice. Reported to Morten
  as a follow-up decision.
- Step 5 (per-note param probe behind debug flag): the probe
  (:1397-1423) does two `parameters.get` lookups + string building per
  note-on and can only ever produce a console.warn (no AudioParam writes —
  MEASURED). Moved behind a module-level `SONGBANK_DEBUG_PARAM_PROBE` flag,
  default off. This is the one intentional log-surface change; flagged to
  Morten in the report. Same treatment for the second probe
  (setEnvelopePositionAtTime :1654) is NOT needed — that one is a genuine
  capability probe used for behavior, stays as a typed optional interface
  member.

## Gates

Per stage: `npm run test:run` (baseline 235 files / 3841 tests — record
actual), `npm run lint`, `npx vue-tsc --noEmit`, `gitleaks`, `npm run
check:artifacts`. Review gate: `tracker-channel-voice-addressing` + song-bank
suites (per N4). Commits on the branch, then stop — no push/merge.

## Parallel-run hygiene

Chiprolled-removal and HVL doc-model passes run in other worktrees; owner
marker written at `.ai/worktrees/songbank-split/.ai/worktree-owner`; no files
outside this worktree touched.
## Evidence / landed (2026-09-23, run 6a0acf4e)

Branch `agent/songbank-split-0923a` (base 6123b5f4, NOT merged, NOT pushed):

- 57f0260f docs: this plan
- fe5337e3 Stage 1 — `BankInstrument` (bank-instrument.ts, 199 lines):
  interface from the members the bank calls on the union; InstrumentV2,
  ModInstrument (inherited via TrackerSamplerInstrument), PooledInstrument all
  `implements`; `ActiveInstrument.instrument: BankInstrument`; the
  `setEnvelopePositionAtTime` structural probe (:1654) became a typed optional
  member. `getInstrument` keeps the concrete union for the editor boundary
  (IndexPage.vue concrete-class checks; one documented cast).
- f55ca3b7 Stage 2 — `EditableInstrument extends BankInstrument` (editor
  surface: node-state updates, asset import/export, reverb generation,
  arpeggiator, envelope/sampler previews); AudioSyncManager provider and
  asset-store/patch-store params widen to it; all four `as InstrumentV2`
  casts deleted (patch-store :368/:374/:439, instrument-store :102). Review's
  claimed :752/:833/:921 casts no longer exist on main (extractAllAudioAssets
  is AudioAssetSource-typed) — recorded as stale.
- 160bc39c Stage 3 — §2b: instrument-lifecycle.ts (889 lines) holds the
  lifecycle block verbatim (ensureInstrument/ensureInstrumentInternal,
  normalizePatch*, restoreAudioAssets/parseWavInfo, applyNodeStates/
  applySamplerStates/applyMacrosFromPatch, getPatchReuseKey,
  teardownInstrument) plus pendingInstruments/restoredAssets; bank injects
  instruments/activeNotes/eventQueue/voices/formatProfile()/useWorkletPooling()/workletPool()/generation()/flags.
  song-bank.ts 2764 -> 2003 lines. Test access paths moved with their pins
  (deep-link-suspended-load, instrument-build-slicing, patch-signature; no
  weakening).
- 9cf8256b Stage 4 — N4 step 5: per-note param probe in dispatchNoteOnAtTime
  behind `SONGBANK_DEBUG_PARAM_PROBE` (module constant, default off). Only
  ever logged; no AudioParam writes.

Gates per staged step, all exit 0 on the exact commit content:
| Stage | test:run | vue-tsc | lint | check:artifacts | gitleaks |
|-------|----------|---------|------|-----------------|----------|
| 1     | 235/3841 | 0       | 0    | OK              | no leaks (full history) |
| 2     | 235/3841 | 0       | 0    | OK              | no leaks |
| 3     | 235/3841 | 0       | 0    | OK              | no leaks |
| 4     | 235/3841 | 0       | 0    | OK              | no leaks |

Stage-3 red run fixed before landing: 3 test files accessed moved internals
(spy on bank.ensureInstrument, Reflect.get getPatchReuseKey,
bank.needsAudioContextResume) — access paths re-pointed to the lifecycle
module / resumeFlags, same assertions.

Not done (reported to Morten): N4 step 4 — deleting the "unreachable"
InstrumentV2 branch. MEASURED: reachable whenever workletPool is null
(after dispose(), or if pool construction fails); needs its own
characterization pass.
