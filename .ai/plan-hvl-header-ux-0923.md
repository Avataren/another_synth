# Plan: HVL header UX fixes (2026-09-23)

Two bugs Morten reported from the live tracker (Syphus "afterstorm" HVL, 12 tracks).
Branch `agent/hvl-ux-fix-0923a` off `main` @ 2bd5963e (verified main == origin/main == HEAD).
Worktree `.ai/worktrees/hvl-ux-fix1`, owner marker `.ai/worktree-owner`.

## BUG 1 — "I don't see transpose on canvas header for HVL"

### Symptom

The transpose chip renders only when `ahxTransposeLabels.length > 0`
(`src/pages/TrackerPage.vue:813-815` canvas, `:843-844` DOM fallback), and those
labels derive from `ahxDoc` positions (`TrackerPage.vue:1147-1152`). `isAhxEditable`
(`src/stores/tracker-store.ts:510`) is `moduleFormat==='ahx' && ahxDoc!==null`, and an
HVL song never gets an `ahxDoc`: `adoptAhxDoc` early-returns when the source record's
format is not `'ahx'` (`tracker-store.ts:1303`), and the HVL import attaches its bytes
with `format: song.format` = `'hvl'`
(`src/audio/tracker/ahx-import.ts` → `attachAhxSource(songFile, bytes, { format: song.format, ... })`).

### Format finding (investigated, not assumed): HVL HAS per-position per-channel transpose

- **File format**: `parseHvlBody` reads, per position, per channel, a track byte and a
  signed transpose byte — `packages/tracker-playback/src/formats/ahx.ts:475`
  (`channels = (b8 >> 2) + 4`, up to 16) and `:490-505` (`track.push(...); transpose.push(toI8(...))`).
- **Engine applies it**: the Rust worklet engine assigns it to every voice each step —
  `rust-wasm/src/ahx/engine.rs:1155-1157` (`v.transpose = self.song.positions[cur].transpose[i]`,
  `v.next_transpose = ...[nextpos].transpose[i]`), and HVL's `EFx` override transpose rides the
  same field (`engine.rs:1668`).
- **Frontend parses then drops it**: `parseAhx` returns `AhxSong.positions[].transpose`
  (`formats/ahx.ts:505`), but `buildAhxTrackerPatterns`
  (`packages/tracker-playback/src/import/ahx-patterns.ts:173-224`) maps positions to
  `TrackerPattern`s carrying only tracks/rows/entries — transpose never reaches the row model.
- So the chip's absence is a **display gap**, not a format limitation. The AHX chip edits
  through the doc (`setAhxPositionTranspose`, `tracker-store.ts:1576`); for HVL the pattern
  area is deliberately read-only ("plays from its file"), so editing is out of scope this pass.

### Decision: branch (c) — cheap read-only display

The parsed transpose already exists in the frontend at import time; surfacing it read-only
is a small, honest fix. Full edit path (doc model + writer + playback reload for HVL) is
explicitly NOT built here.

1. **Row model**: add optional `positionTranspose?: number[]` to `TrackerPattern`
   (`packages/tracker-playback/src/tracker-types.ts:88`). Optional, so nothing else changes shape.
2. **Import**: `importAhxToTrackerSong` (`src/audio/tracker/ahx-import.ts`) copies
   `song.positions[i].transpose` onto pattern `i`. App layer only — the library builder and
   its pins are untouched. Survives save/load: `.cmod` JSON carries patterns verbatim.
3. **Page** (`TrackerPage.vue`): when not editable (`isAhxEditable` false) and the current
   pattern carries `positionTranspose`, derive labels via the existing `ahxTransposeLabel`
   and read-only titles (value shown, "read-only" instead of "wheel … to change"). The
   read-only position index is `sequence.indexOf(currentPatternId)` (HVL patterns have
   random ids, one per position, sequence index == position index, `ahx-import.ts`).
   Editable AHX keeps the doc path byte-for-byte.
4. **Honest non-interactivity**: pass `:transpose-editable="isAhxEditable"` to
   `PatternCanvas.vue` and `TrackerPattern.vue`; without it the chip does not bind
   click/wheel and loses the `ns-resize` cursor (`.transpose-readonly`). The wheel handler
   was already inert read-only (`onTransposeChipStep` early-returns when the position index
   is -1, `TrackerPage.vue:1168`), but the cursor lied.

Read-only doc-less AHX songs (saved without bytes) get the same read-only chips — same
symmetry argument, same code path.

### Tests

- `src/tests/ahx-import.test.ts`: HVL fixture import → each pattern's `positionTranspose`
  equals `parseAhx(bytes).positions[i].transpose` (real fixture bytes, real import path).
- `src/tests/pattern-canvas-transpose-chip.test.ts`: mount with `transpose-editable: false`
  → chips render with labels, click/wheel emit nothing, readonly class present.

## BUG 2 — "header colors have an abrupt shading change after track 8"

### Root cause

Per-track accent colors come from an 8-entry ramp built once per theme
(`buildTrackAccents`, `src/components/tracker/pattern-canvas/track-accents.ts:29`,
`TRACK_ACCENT_COUNT = 8`, lightness sweep ±9 across the set). The consumer wraps with
modulo — `trackAccent` (`src/components/tracker/pattern-canvas/pattern-draw.ts:52-62`,
`accents[index % accents.length]`) — so track 9 (index 8) jumps from the ramp's lightest
end (secondary, sweep +9) back to its darkest (primary, sweep -9). AHX has at most 4
channels of tracks but HVL grows to 16 (`formats/ahx.ts:33`, `AHX_MAX_CHANNELS = 16`),
which is why only HVL shows it.

Consumers, both through `trackAccent`: the DOM header chips'
`--track-accent` (`PatternCanvas.vue:336-342`) and the canvas play-cursor stroke
(`pattern-draw.ts:826`).

### Fix: ping-pong continuation in `trackAccent`

For `index >= accents.length`, reflect across the ramp (period `(n-1)*2`, endpoint-skip):
track 9 lands one step inside the ramp end and walks back toward the start; every adjacent
pair differs by exactly one ramp step. `buildTrackAccents` and its tests stay untouched —
indices 0-7 return exactly today's colors, so AHX rendering is pixel-identical.

### Tests

- Extend `src/tests/track-accents.test.ts` (or sibling): real `buildTrackAccents` theme +
  real `trackAccent` — 12 tracks: indices 0-7 equal the base ramp (AHX pin); index 8 is not
  the ramp start; every adjacent pair's HSL lightness step is within one ramp step
  (smooth progression, no restart jump). Plus a DOM-level assertion through the mounted
  `PatternCanvas` header strip (12 tracks → 12 chips, `--track-accent` values match
  `trackAccent` and continue smoothly) — real renderer path.

## Gates

Full `vitest run`, `npm run lint`, `npx vue-tsc --noEmit`, `gitleaks detect`,
`npm run check:artifacts`. Commits on the branch, stop, no push/merge.

## Out of scope

- HVL transpose editing (doc model + writer + live reload) — reported to Morten as feasible
  but a full feature; the format evidence above is what he needs to decide.
- `rust-wasm/` — not touched (read-only investigation only).

## Landed (2026-09-23)

Landed by main-agent landing run (session `agent:main:subagent:b94c7f91-f80e-49bd-b652-9b5e8f9b6b81`, 08:38–08:5x).

### What landed

**Bug 1 — HVL transpose read-only chips.** Format verdict (investigated, not assumed):
HVL *has* per-position per-channel transpose in the file format — `parseHvlBody` reads a
track byte plus a signed transpose byte per position/channel
(`packages/tracker-playback/src/formats/ahx.ts:475,:490-505`), and the Rust engine assigns
it to every voice each step (`rust-wasm/src/ahx/engine.rs:1155-1157`). The frontend
**parsed then dropped** it: `parseAhx` returns `positions[].transpose`, but
`buildAhxTrackerPatterns` never carried transpose into the `TrackerPattern` row model —
a display gap, not a format limitation. Fix: optional `positionTranspose?: number[]` on
`TrackerPattern`, copied at import in the app layer only; read-only chips render when
`transpose-editable=false` (value shown, "read-only", no wheel/click binding, correct
cursor). Editable AHX keeps the doc path byte-for-byte; editing for HVL stays out of
scope (reported as a feasible follow-up feature).

**Bug 2 — track-header accent ping-pong.** Root cause: the 8-entry accent ramp
(`buildTrackAccents`, lightness sweep ±9) was consumed with modulo wrap, so track 9
jumped from the ramp's lightest end back to its darkest — visible only on HVL, which
grows to 16 tracks. Fix: ping-pong reflection in `trackAccent` for `index >= 8`
(period `(n-1)*2`, endpoint-skip) — every adjacent pair differs by exactly one ramp step.
**AHX byte-identical claim:** indices 0–7 return exactly the pre-fix ramp colors, so AHX
rendering is unchanged; pinned by the extended `track-accents` tests (0–7 equal base ramp).

### Review

Independent review **PASS** (2026-09-23 08:38): 12-file diff exact, read-only chip gating
verified, ping-pong math independently recomputed, moved test honest, gates all fresh green.

### Post-merge gates on main (real exit codes, this run)

| Gate | Result | Exit |
|---|---|---|
| vitest (full) | 235 files / 3841 tests passed (62.0s) | 0 |
| eslint | no findings | 0 |
| vue-tsc --noEmit | clean | 0 |
| npm run check:artifacts | worklets + wasm match sources | 0 |
| gitleaks detect --no-git | no leaks | 0 |

### Deploy

`scripts/deploy.sh` → `avatar@192.168.50.161:~/repos/docker-info-ws-server/html/synth`.
Build succeeded (spa mode); refusal guard passed; script self-verification
`Deployed and verified (289b0e3ce9751f4a3bfe37b9928682a3)` (index.html md5); deploy exit 0.
Log: `.ai/deploy-hvl-headerux-20260923.log`.

**Independent byte-match (md5, local `dist/spa` ↔ remote, all identical): 8/8**

| File | md5 |
|---|---|
| index.html | `289b0e3ce9751f4a3bfe37b9928682a3` |
| wasm/audio_processor_bg.wasm | `acf69b52abc38d941d30e3a493eb270e` |
| wasm/audio_processor.js | `b4a1b4ccd50a92959320c9763539ef94` |
| worklets/recording-worklet.js | `9c96bf69c35c1b90db4314dd0923147f` |
| worklets/ahx-worklet.js | `0b1e28a2d692f80a2f9fc3a46d77f1e6` |
| worklets/synth-worklet.js | `d3be4813a900d1db107ac182b425f346` |
| worklets/effects-worklet.js | `ea0b2d2be2fd5dd6ec9a6a6ccb5c5e71` |
| demos/index.json | `197bcd24e7a9b2770299d2b530bfda59` |

**wasm UNCHANGED — verified:** no `rust-wasm/` or `public/wasm/` paths in the merge range
(`git diff --stat 2bd5963e..209f564e` on those paths: empty); `SOURCE_HASH.json` sourceHash
`5c9e359d…` unchanged; and the deployed wasm md5 `acf69b52…` is **byte-identical to the
07:33 HVL-corpus deploy's wasm** (residue stash `stash@{0}`, created 07:34, hashes
equal) — the rebuild reproduced the same bytes as the previous deploy.
