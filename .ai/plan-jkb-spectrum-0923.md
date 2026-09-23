# Jukebox spectrum analyzer blank for AHX (and 4ch HVL) — investigation + fix plan

Branch: `agent/jkb-spectrum-0923a` (base 2d14da32, main == origin/main, verified 2026-09-23 12:18 UTC+2)
Report (Morten, 12:18): "spectrum analyzer on jukebox page does not work for ahx, and probably not for hvl either".

## The wiring (MEASURED, code-verified)

1. **Jukebox → analyzer props.** `src/pages/JukeboxPage.vue:174-177` mounts
   `TrackerSpectrumAnalyzer` with `:node="masterOutputNode"` and
   `:track-nodes="spectrumTrackNodes"`, both from `useTrackerSongHost`
   (`src/pages/JukeboxPage.vue:316-322`).
2. **Master tap.** `masterOutputNode` = `songBank.finalOutput` =
   `audioSystem.postFxOutput` = `postFxRack.output`
   (`src/composables/useTrackerSongHost.ts:151-155`,
   `src/audio/tracker/song-bank.ts:253-255`, `src/audio/AudioSystem.ts:214-216`).
   The rack output is a stable `GainNode` and the speaker feed
   (`packages/tracker-playback/src/postfx/post-fx-rack.ts:15-33`,
   `src/audio/AudioSystem.ts:185-190`).
3. **Per-track taps.** `spectrumTrackNodes` (`useTrackerSongHost.ts:159-163`)
   is ordered from `trackAudioNodes`, filled by `updateTrackAudioNodes`
   (`useTrackerSongHost.ts:185-207`) via
   `songBank.getTrackVisualizationNode(trackIndex, instrumentId)`
   (`src/audio/tracker/song-bank.ts:361-374`): a per-track monitor `GainNode`
   only when the bank instrument is a `ModInstrument`, else
   `getInstrumentOutput(instrumentId)`, else **null**.
4. **Analyzer mode choice.** `resolveMode`
   (`src/components/tracker/TrackerSpectrumAnalyzer.vue:260-271`): exactly 4
   track nodes → **quad** (per-track bars, LRRL); anything else → **stereo**
   from the master node; no master → none. Quad is *sticky*: once in quad it
   stays quad as long as `trackNodes.length === 4`, even when every node is
   null (lines 265-267 — meant for transient pattern-boundary blips, per the
   comment). In quad, `syncGraph` only (re)connects a channel on a *non-null*
   source (lines 313-318), so all-null nodes = four dead channels with no
   fallback to the master tap.

## Why AHX/HVL shows nothing

5. **AHX/HVL songs have no bank instruments.** The display model is imported
   with **no patches** (`songPatches: {}`, `src/audio/tracker/ahx-import.ts:59`)
   and name-only slots for AHX / no slots at all for HVL
   (`ahx-import.ts:55-56`, comment at `ahx-import.ts:15-20`: "no patches … the
   worklet's engine plays them"). `syncSongBankFromSlots` therefore builds
   nothing (`src/composables/useTrackerSongBuilder.ts:148-161` — slots without
   a `patchId` are dropped), so `getTrackVisualizationNode` returns **null for
   every track** (`song-bank.ts:361-374`).
6. **So for AHX/HVL the per-track taps are permanently null** — a structural
   property of the format (the file engine plays the bytes; no per-channel
   bank instrument exists to tap), not a transient gap. MEASURED from the
   import/slot/bank code chain above; pinned by the new tests.
7. **Quad still engages, and then sticks.** The jukebox page shares the
   tracker stores: on mount, `useTrackerSongHost`'s immediate
   `trackMonitoringWanted` watch (`useTrackerSongHost.ts:118-127`) builds taps
   for whatever song the store still holds (the editor's — real instruments,
   non-null taps → quad). The playlist itself spans all collections
   (`allDemoSongs`, `src/composables/useJukeboxPlayer.ts:305-306`) and is
   mostly 4-channel (78/99 AHX/HVL entries, 78/80 amiga MODs —
   `public/demos/index.json`), so the analyzer sits in quad with real taps,
   then every 4ch AHX/HVL entry loads into structurally-null taps → **sticky
   quad, four dead channels, blank** (item 4). INFERRED for the exact entry
   ordering, MEASURED for each link.
8. **The audio does reach the master tap.** `play()` routes
   `moduleFormat === 'ahx'` to `playAhx`
   (`src/stores/tracker-playback-store.ts:1149`); `AhxTransport` connects the
   engine's `client.output` into the song bank's pre-rack mix bus
   (`src/audio/tracker/ahx-transport.ts:103`,
   `tracker-playback-store.ts:489`); `masterGain → destinationNode`
   (`song-bank.ts:176`); `destinationNode → postFxRack → postFxOutput`
   (`AudioSystem.ts:185-190`). So the **stereo fallback via `masterOutputNode`
   would show AHX/HVL** — it is never chosen because the host offers four
   null taps instead of none.
9. **HVL:** 4-channel HVL songs are byte-for-byte the same story (same import,
   same `moduleFormat: 'ahx'` — `ModuleFormat` has no `'hvl'`,
   `packages/tracker-playback/src/types.ts:16`). Non-4ch HVL (21 entries,
   8/10ch) get `trackNodes.length !== 4` → stereo → those already work.
   Matches the report's "probably not for hvl either".

**Root cause (one sentence):** the host advertises per-track spectrum taps for
AHX/HVL although those formats can never have per-track bank instruments, so
the analyzer locks into quad mode with four permanently-dead channels instead
of falling back to the master output's stereo mode.

## Fix (minimal, display-only)

In `useTrackerSongHost.spectrumTrackNodes` (`useTrackerSongHost.ts:159-163`):
return **no taps at all** (`[]`) when `moduleFormat === 'ahx'` (the only
format value whose songs carry no patches — AHX and HVL both). The analyzer
then resolves `length !== 4` → stereo → master output. This is a read-only
visualization prop: no connection to the audio graph changes, nothing audible
changes. The same host drives the tracker page, so AHX/HVL on the tracker page
is fixed by the same change. The AHX editor page's analyzer has its own feed
(ahx-instrument-visuals / preview output) and is untouched.

Deliberately NOT changed: `resolveMode`'s quad stickiness (correct for real
transient blips in ModInstrument songs); `trackAudioNodes`/waveforms (also
blank for AHX today — pre-existing, separate display concern, out of scope);
`rust-wasm/` (no changes — the defect is entirely in the tap *offering*, not
the engine).

## Test strategy (jt_letgo: real production path, no hand-built fixtures)

- **Host-level, real load path:** real pinia stores + real
  `useTrackerSongHost`; load a real AHX demo through the real import/store
  path (`importAhxToTrackerSong` on `public/demos/ahx/*.ahx` bytes → real
  `trackerStore.loadSongFile`) and assert `spectrumTrackNodes` is `[]` while
  `trackCount` is still 4. AudioContext stubbed pre-import (postfx-path
  pattern, `src/tests/postfx-path.test.ts:15-19`) — safe because AHX builds
  zero instruments, so no worklet dependency.
- **Component-level contract:** `TrackerSpectrumAnalyzer` with
  `trackNodes: []` + a master node builds the stereo graph from the master
  node (fake audio nodes, oscilloscope-mono pattern,
  `src/tests/oscilloscope-mono.test.ts`), and with four live track nodes
  builds quad — pinning the prop contract the jukebox depends on.
- The empty-vs-quad assertions pin the event/prop contract (the analyzer has
  no event stream; the computed-prop handoff is the contract).

## Gates

npm run test:run, npm run lint, npx vue-tsc --noEmit, gitleaks detect --no-git,
npm run check:artifacts — on the branch tip, real exit codes recorded in the
addendum. Stop on the branch; no push, no merge, no deploy.

## Addendum — implementation record

Branch tip at implementation: `agent/jkb-spectrum-0923a` (base 2d14da32).

**What changed (2 files + 1 new test):**

- `src/composables/useTrackerSongHost.ts:159-177` — `spectrumTrackNodes` now
  returns `[]` when `moduleFormat === 'ahx'` (the only `ModuleFormat` value
  whose songs carry no patches — AHX and HVL both report it,
  `packages/tracker-playback/src/types.ts:16`, `src/audio/tracker/ahx-import.ts:50`),
  so the analyzer resolves its stereo mode against `masterOutputNode`
  (`postFxRack.output`) instead of locking into quad with four permanently
  null taps. Per-track tap building, `trackAudioNodes`, the waveform path and
  the audio graph are untouched (the fix is a read-only computed).
- `src/tests/jukebox-spectrum-ahx.test.ts` (new) — pins the contract:
  - **Host-level, real production path** (real pinia stores, real
    `TrackerSongBank` on a stubbed suspended `AudioContext`, real demo bytes):
    `(iridion 0.5)q22.ahx` and `ring_modulation_test_song.hvl` loaded through
    the real funnel (`parseSongBuffer` → `applySongFile`) end with
    `trackCount === 4` and `spectrumTrackNodes === []`; a native-format song
    keeps the one-slot-per-track array shape (transient-null case unchanged).
    Verified to FAIL against the unfixed host with exactly the root-cause
    signature (`expected [null, null, null, null] to deeply equal []`) by
    stashing the fix.
  - **Component-level prop contract** (`TrackerSpectrumAnalyzer`, fake audio
    nodes, oscilloscope-mono pattern): no taps + master → stereo graph built
    from the master node; four live taps → quad (one analyser each);
    quad → no taps (the AHX handoff) → tears down quad and rebuilds stereo
    on the master node.

**Deviations from the plan, honestly described:**

- The plan's host test proposed `host.loadSongFromBuffer`; the host does not
  re-export it — the tests call its two real constituents,
  `host.parseSongBuffer` + `host.applySongFile` (the same funnel
  `loadSongFromBuffer` is, and the shared path of the demo browser and
  jukebox). Same production path, no mock.
- The real-path test runs on a *suspended* stubbed `AudioContext` (postfx-path
  pattern, `src/tests/postfx-path.test.ts:15-19`): with a running context the
  AHX transport awaits the worklet's wasm handshake, which the fake worklet
  never completes; a suspended context skips that await exactly like the
  fresh-tab deep-link path (`src/stores/tracker-playback-store.ts`,
  `loadAhxSong` suspended branch). The analyzer-tap contract does not depend
  on context state; the suspended choice mirrors a real browser fresh tab.
- `masterOutputNode`/`trackAudioNodes` identity in the component test is
  pinned with `markRaw` taps: Vue proxies props, which would otherwise break
  connect-source identity assertions (target identity — splitter/analysers —
  is unaffected).
- Root cause confirmed as planned; no rust-wasm changes, no audio-path
  changes, no public/demos changes. The jukebox handover entry scenario
  (editor song's live taps engaging quad before the first AHX plays) is
  INFERRED from the wiring (`JukeboxPage.vue:625-631`,
  `useTrackerSongHost.ts:118-127`) — not reproduced in a browser here; the
  fix removes the failure mode regardless of which 4-track song precedes the
  AHX/HVL one.

**Gates (branch tip, real exit codes):**

| Gate | Command | Exit |
| --- | --- | --- |
| tests | `npm run test:run` (242 files / 3928 tests) | 0 |
| lint | `npm run lint` | 0 |
| types | `npx vue-tsc --noEmit` | 0 |
| secrets | `gitleaks detect --no-git --source .` | 0 (no leaks) |
| artifacts | `npm run check:artifacts` | 0 |

Raw outputs: `.ai/checks-spectrum-test.txt`, `.ai/checks-spectrum-rest.txt`
(first pass — its per-tool EXIT lines are unreliable because of a `tail`
pipe; re-run clean in `.ai/checks-spectrum-rest2.txt`, which caught and led
to fixing a real `exactOptionalPropertyTypes` error in the new test).

**Main moved mid-run:** `main`/`origin/main` = 693dcfd7 (P5 engine-split
landing) while this branch bases 2d14da32, per instructions no rebase was
done; `git diff 2d14da32..693dcfd7` touches none of the three files this fix
changes (`useTrackerSongHost.ts`, `TrackerSpectrumAnalyzer.vue`,
`ahx-import.ts`), so the later merge is expected clean.

Stopped on the branch: no push, no merge, no deploy.
