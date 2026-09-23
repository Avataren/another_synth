# Plan: P6 store transport — extract `AhxSongTransport` behind the unchanged store API (N2)

Date: 2026-09-23. Base: **`693dcfd7`** (main == origin/main, verified 2026-09-23 12:26, after
`git fetch`; the jkb-spectrum run was in flight and had not landed — finish on this branch,
no rebase mid-run).
Branch: `agent/p6-store-transport-0923a`, worktree `.ai/worktrees/p6-store` (fresh: `.quasar/`
copied, `node_modules` symlinked to the main checkout, owner marker `.ai/worktree-owner`).
Implementer: Claude Code headless, pinned `claude-opus-5-5`.

## 0. Standing rules

- Extractions move code **verbatim**; only `export`/keyword/import lines may differ.
  Behavioral deltas are defects unless justified in the addendum.
- Import graph acyclic (runtime edges); no `rust-wasm/` changes; no `public/` changes.
- NO audible behavior change. The AHX routing tests are the sensitive gate.
- Store's **public API is unchanged** — zero consumer churn. Consumers keep calling
  `loadSong`, `play`, `pause`, `resume`, `stop`, `seek`, `setBpm`, `setPatternLength`,
  `applyAudibilityChange`, `setLoopSong`, `toggleMute`, `toggleSolo`, `previewAhxNoteOn`
  etc. on the store exactly as before.
- Tests must exercise the real production load path (jt_letgo rule): the routing tests
  already drive the real store; no hand-built fixtures may replace them.

## 1. Queue documentation — where the item comes from

`.ai/arch-review-2026-09-22.md` §N2: "The playback store implements two transports
inline, with a format branch in every verb." Ranked 4th; "needs-store-refactor, but
TS-only. Do it in steps (extract `AhxSongTransport` first) behind the unchanged store
API, with `tracker-playback-ahx-routing.test.ts` as the gate."

**No concrete plan doc existed** for the N2 item — this document is the plan-first
deliverable. Scope of *this run* is **Step 1 only** (extract `AhxSongTransport`);
Step 2 (`SampleTransport` + shared `SongTransport` interface + `capabilities`) is
queued as follow-up and intentionally NOT in this run — the sketch prescribes the
step order and one step per run keeps the refactor verifiable.

## 2. Current state — MEASURED (tree 693dcfd7, 2026-09-23)

`src/stores/tracker-playback-store.ts` — 1551 lines. Line numbers below are
**MEASURED on this tree** (the review doc's numbers have drifted by −15 lines;
this file was not touched by the P2/P5/P6-sibling work):

- **Every transport verb branches on `ahxSongActive`** (module-scope `let` inside the
  store factory, :193):
  - `play` :1140 — `if (song.moduleFormat === 'ahx') return playAhx(...)` :1149
  - `pause` :1200 — branch :1201
  - `resume` :1216 — branch :1217-1225
  - `stop` :1233 — branch :1234-1242
  - `seek` :1260 — branch :1261-1271
  - `setBpm` :1277, `setPatternLength` :1287 — silently return for AHX
  - `applyAudibilityChange` :1301 — branch :1302 (`syncAhxMuteSolo` :1314)
  - `setLoopSong` :1425 — reaches both engines (:1427-1428)
- **AHX orchestration block inside the store**: :480-1026 (comment header :480, through
  `playAhx` ending :1026): `ensureAhxTransport` :487, `disposeAhxTransport` :504,
  keyboard preview `previewAhxNoteOn` :518 / `prepareAhxPreview` :536 /
  `previewAhxNoteOff` :544 / `newAhxPreview` :563 / `disposeAhxPreview` :575,
  reload machinery `resetAhxReload` :610 … `onAhxReloaded` :687 / `handleAhxSeekKind` :718,
  instrument-edit sync :745-779, position/waveform/scope handlers :780-837,
  `handleAhxSongEnd` :839, `setAhxTransportState` :850, `leaveAhx` :867,
  `loadAhxSong` :887, `playAhx` :960. Plus `stopSampleEngine` :859 (sample-side helper
  in the middle of the block).
- **Module-level engine handles and listener sets** :70-107: `playbackEngineInstance`
  :72, engine event unsubscribes :74-76, `ahxTransportInstance` :82, `ahxUnsubscribes`
  :83, `ahxPreviewInstance` :85, `ahxSourceUnsubscribe` :86, `ahxStructureUnsubscribe`
  :87, `ahxReloadScheduler` :89, `ahxEditSync` :91, `ahxEditUnsubscribe` :92,
  `ahxScopesWanted` :95, `ahxScopeViews` :99, listener sets :101-107.
- **AHX epoch/place/burst state** (store factory scope, non-reactive `let`s):
  `ahxEpoch` :201, `ahxPlace` :210, `ahxSpaceMap` :218, `ahxReloadInFlight` :224,
  `ahxReloadBurst` :227, `ahxReloadEpoch` :229, `ahxAwaitingSeekKind` :232.
- **AHX document state is module-level in `src/audio/tracker/ahx-source.ts` :75-102**:
  `current` :75, `previewBytes` :82, `ahxSourceInfo` (reactive, exported) :93,
  `edits` :96, listener sets :97-102, `lastGood` :103, `editListeners` :104 —
  invisible to Pinia. (MEASURED: this state stays put in Step 1; moving it is not
  in the sketch's step 1.)
- **The store caches `lastPlaybackSong`** (`recordLastSong` :171, ref :166) because
  `PlaybackSong` assembly lives in `useTrackerSongBuilder` on the page (review,
  citing plan-fullscreen-transport.md D-B).
- **Gate tests exist and are green at base**: `src/tests/stores/tracker-playback-ahx-routing.test.ts`
  (1020 lines) and `src/tests/playback-store-replay.test.ts` (447 lines). The routing
  test drives the **real store definition** (`useTrackerPlaybackStore`), not a
  hand-built fixture (jt_letgo rule satisfied by the existing gate).

## 3. Inference vs measurement

- INFERRED (from the sketch + the verb bodies): the AHX branch logic is self-contained
  enough to move as a unit because it communicates with the store only through
  (a) reactive state writes (`isPlaying`, `isPaused`, `playbackRow`, `playbackMode`),
  (b) the listener sets, (c) `currentSequenceIndex`/`selectedSequenceIndex`,
  (d) `loopSong`, (e) `mutedTracks`/`soloedTracks`, (f) the song bank
  (`getSongBank()`), (g) `trackerStore.rowsForPattern` in `seek` :1264, and
  (h) `audioStore.setPlaybackState`. `AhxSongTransport` will receive these as
  constructor dependencies (refs/getters + callbacks), so the store keeps ALL
  reactive state and the class holds the module-level instances + epoch machinery.
- UNVERIFIED until implementation: whether any handler closure captures another
  store function not listed above (e.g. `broadcastPosition`); the implementer must
  verify each moved closure's captured names against the dependency list and add
  missing dependencies to the class interface rather than leaving hidden captures.

## 4. Step 1 deliverable (this run)

1. New file `src/audio/tracker/ahx-song-transport.ts` exporting `AhxSongTransport`
   (class) that owns, **moved verbatim** from the store:
   - the AHX transport instance + unsubscriptions (from :82-83),
   - the reload scheduler, edit sync, structure/source subscriptions (:86-92),
   - the keyboard preview (:85, :518-584),
   - epoch/place/space-map/burst state (:201-233),
   - the handlers and verbs :487-884 (`ensureAhxTransport` … `leaveAhx`) and
     `loadAhxSong` :887 / `playAhx` :960.
   Dependencies (refs, getters, callbacks — `setAhxTransportState`, `handleAhxSongEnd`
   writing to store listeners, `syncAhxMuteSolo`, `seek`'s row lookup, `audioStore`,
   `trackerStore`) are injected via the constructor; the class never imports Pinia.
2. The store's AHX verbs become thin delegations: `play`/`loadSong`/`pause`/`resume`/
   `stop`/`seek`/`setLoopSong`/`applyAudibilityChange`/preview calls hand off to
   `this.ahx` (the `AhxSongTransport` instance), keeping signatures and behavior
   identical. `ahxSongActive` becomes owned by the transport (`isActive`) and the
   store asks it — the branching verbs may keep their shape in Step 1; the
   format-branch removal itself is Step 2.
3. Store module-level AHX singletons (:82-92) and the AHX `let`s (:201-233) are
   deleted from the store; the sample-engine singletons (:72-76) stay.
4. `stopSampleEngine` :859 stays with the sample path in the store (it touches
   `playbackEngineInstance` only).
5. The two gate tests must pass **unmodified**. If a test reaches a moved symbol
   directly, the implementation may add a store-level pass-through ONLY if the test
   already reached it via the store's returned API; any other test edit is a
   deviation and must be justified in the addendum.

## 5. Gates (real exit codes, on the branch tip)

- `npm run test:run`
- `npm run lint`
- `npx vue-tsc --noEmit`
- `gitleaks detect --no-git`
- `npm run check:artifacts`

All green → stop on the branch. No push, no merge, no deploy.

## 6. Stop conditions (premise check)

The premise was verified against the current tree (§2) and HOLDS: the branch-per-verb
structure, the inline AHX block, and the module-level singletons are all as the
review documents (line drift −15, explained by the P5 landing on main). No stop.

## 7. Addendum

Implemented 2026-09-23 on `agent/p6-store-transport-0923a`.

- New `src/audio/tracker/ahx-song-transport.ts` (785 lines): `AhxSongTransport` :113,
  deps interface `AhxSongTransportDeps`, constructor :162 (the three subscriptions, same
  order as the store factory had them), `isActive` getter :191. Store 1551 → 919 lines
  (+61/−693); instance built at `tracker-playback-store.ts:396`, `stopSampleEngine` stays
  in the store (:381, moved above the construction so it reads next to its injection).
- Verbatim check: every removed store line, with indentation, `this.` and `this.deps.`
  stripped, is found in the new file except declaration lines (`function x` → method /
  arrow field) and the verb branches that now delegate.

Deviations / judgement calls:

1. **Worklet singletons stay module-level, in the new module** (`ahx-song-transport.ts:79-95`),
   not instance fields. They were module-level in the store and outlive a Pinia: a new
   store (every test `beforeEach` makes one) cancels the previous one's source / structure /
   edit subscriptions and `dispose` frees the previous transport. As instance fields, an
   old store's subscriptions would stay live after a Pinia swap — a behavior change. The
   per-store `let`s (:201-233) became instance fields, as the plan said.
   `ahxScopesWanted` / `ahxScopeViews` (store :93-94, outside the plan's :82-92 range)
   moved too: only moved code touches them.
2. **`PlaybackMode` is defined in the new module** and re-exported by the store
   (`export type { PlaybackMode }`), so the transport never imports the store (no
   Pinia, no cycle, not even type-only). Consumers still import it from the store.
3. **Extra deps found by the capture audit** (plan §3 UNVERIFIED): `hasSongLoaded`,
   `playbackMode`, `applyPosition`, `resolveStartSequenceIndex`, `recordLastSong`,
   `sanitizeMuteSoloState`, `stopSampleEngine`, `songEndListeners`. `broadcastPosition`
   is reached only via `applyPosition`, which stays in the store.
4. Callbacks handed to other objects (`handleAhxPosition`/`SongEnd`/`Waveforms`/
   `SeekKind`/`StructureChange`, `sendAhxInstrumentEdits`, `ahxPlayheadTiming`) are
   arrow-function fields so `this` binds; a few methods destructure `this.deps` in one
   added line to keep the body lines verbatim. `errorText` moved to module scope.
5. The store verbs keep their `if (ahx.isActive)` shape (Step 2 removes it). The
   AHX `syncAhxMuteSolo` moved into the class (it reads the transport handle); the store
   calls `ahx.syncAhxMuteSolo()` from `applyAudibilityChange` and `sanitizeMuteSoloState`.
   `setLoopSong` calls `ahx.setLoopSong(loop)` (the old `setStopAtEnd(!loop)` line).
   The store's preview/scope functions are one-line pass-throughs with the same signatures.

No test edits; no `rust-wasm/`, `public/` changes. Gates on the branch tip (outputs in
`.ai/checks-p6-*.txt`): test:run 0 (241 files / 3922 tests), lint 0, vue-tsc 0,
gitleaks 0, check:artifacts 0.
