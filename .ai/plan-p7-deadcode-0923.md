# Plan: P7 — dead-code sweep (N6) + N9 scroll-sync extraction + N10 log gating

Base: `main` @ `4a005309` (MEASURED: `git rev-parse main origin/main` both `4a005309`,
fetched 2026-09-23 13:03 before branching). Branch `agent/p7-deadcode-0923a`,
worktree `.ai/worktrees/p7-deadcode` (fresh; `.quasar/` copied, `node_modules`
symlinked, owner marker written). Queue: arch-review 2026-09-22 findings N6, N9,
N10 (`.ai/arch-review-2026-09-22.md:141-152, 172-194, 196-214`). No dedicated P7
queue doc exists beyond that review — the task text's "P7" maps to these three rows.

All `file:line` below measured on this tree (`4a005309`), 2026-09-23.

## Part 1 — N6: dead-source sweep

### (a) Certainly dead — delete

Every candidate below verified with two greps on this tree: (1) module-path
substring import match (`from '...<module>'`, dynamic `import(...)`, `require`),
(2) basename-anchored relative-import match (`'./x'`, `'../x'`) with manual
filtering of same-name-but-different-file hits (tracker/playback/sampler files).
Plus a string-keyed/dynamic-dispatch sweep (`example-store`, `worklet-message-handlers`,
`WasmEngineAdapter` etc. as bare strings) — zero hits outside the dead files
themselves. **Implementation must re-run these greps immediately before each
deletion commit** (main may have moved; grep evidence below is per this tree).

| File | Lines | Importers (MEASURED) |
|---|---|---|
| `src/audio/instrument.ts` | 1010 | 0 |
| `src/audio/voice.ts` | 116 | 0 |
| `src/audio/processor.ts` | 250 | 0 |
| `src/stores/example-store.ts` | 15 | 0 (no Pinia registration either — string sweep clean) |
| `src/audio/worklets/handlers/worklet-message-handlers.ts` | 428 | 0 |
| `src/audio/worklets/handlers/oscillator-update-handler.ts` | 8 | 0 |
| `src/audio/worklets/synth-worklet.ts.backup` | 1986 | 0 (`.backup` suffix, never compiled) |
| `src/audio/adapters/wasm-engine-adapter.ts` | 660 | only `worklet-message-handlers.ts:15` (type-only; itself dead → transitive dead) |
| `src/audio/instrument-v2-pooled.ts.unused` | 155 | 0 (`.unused` suffix) |

Source subtotal: **4,628 lines** (`wc -l`, measured).

Config/doc additions (same commit series):
- `asconfig.json` — targets `public/wasm/release.wasm` (AssemblyScript era). No
  script references it (MEASURED: grep over `scripts/`, `package.json`,
  `quasar.config.ts`). Delete.
- `package.json:73-74` `exports` entry `"./build/release.js"` (AssemblyScript
  build output, no `build/release.js` exists in repo — MEASURED `ls build` absent
  path from repo root). Delete that export block; delete `assemblyscript`
  devDependency (`package.json:51`). Run `npm install` NOT required —
  node_modules is shared/symlinked; `assemblyscript` in node_modules stays
  (unverifiable removal without touching shared node_modules → UNVERIFIED
  whether anything else pins it; check `npm ls assemblyscript` before final).
- `quasar.config.ts:154` commented `// name: 'watch-assemblyscript'` block —
  delete the dead comment lines.
- `AGENTS.md:819-826` "Phase 2: Update Worklet (✅ Foundation Complete, Migration
  In Progress)" — mark migration abandoned, point to the typed-protocol work (N7)
  and the real path (`synth-worklet.ts` + `pooled-instrument-factory.ts`).
  `AGENTS.md:1015` and `:1186` reference `worklet-message-handlers.ts` — rewrite
  those rows. Doc-only; keeps future agents off dead twins.

Test-existence check (protocol (b) rule): all candidates above are category (a) —
no test imports them (grep covered `src/tests/`). If a test references a
candidate discovered during implementation, reclassify to (c), list, don't delete.

### (b) Probably dead — none identified (MEASURED; the review's list matched grep exactly)

### (c) Uncertain — listed, NOT deleted
- `public/wasm/debug.wat`/`release.wat` artifacts if present — out of scope (N3
  owns artifact policy; do not touch `public/`).
- Anything under `rust-wasm/`, `public/` — task constraint forbids.

### Deletion commit grouping (gates green after each group)
1. `chore(p7): delete dead audio twins` — `instrument.ts`, `voice.ts`,
   `processor.ts`, `instrument-v2-pooled.ts.unused`, `synth-worklet.ts.backup`.
2. `chore(p7): delete dead worklet handlers + adapter` — handlers dir files +
   `wasm-engine-adapter.ts` (adapter after its only importer).
3. `chore(p7): delete example store + AssemblyScript leftovers` — `example-store.ts`,
   `asconfig.json`, `package.json` exports/deps, `quasar.config.ts` comment.
4. `docs(p7): AGENTS.md — mark typed-protocol migration abandoned` (can merge
   into group 3 if gates run identically).

Gate after each group: `npm run test:run`, `npm run lint`, `npx vue-tsc --noEmit`.
Full gate set (incl. `gitleaks detect --no-git`, `npm run check:artifacts`) at tip.

## Part 2 — N9: TrackerPage.vue scroll-sync + style extraction

MEASURED on this tree: `src/pages/TrackerPage.vue` is 4231 lines (review said
4220 — other lanes landed since; anchors shifted accordingly):
- Scroll-sync block: `resolvePatternTracksWrapper` `:1758` through
  `setupTrackScrollSync` ending ~`:2028` (setup at `:1972`, teardown closure
  assignments `:1993`, `:2025-2027`), plus `syncTrackScroll`/`measureTrackScrollbar`
  and `refreshVisualizerAlignment` `:2001-2011` which re-wire the sync.
- Manual listener lifecycle: 6 listeners added/removed by hand, `teardownTrackScrollSync`
  closure variable; page `onBeforeUnmount` at `:2872` does not tear the sync down
  itself (rely on refresh paths) — the composable must own teardown in its own
  `onBeforeUnmount`.
- Style block: `<style scoped>` `:2900` → EOF `:4231` (~1331 lines).

Steps:
1. Extract `useTrackerScrollSync(refs…)` composable in `src/composables/`
   (same dir as the existing `useTracker*` composables — verify dir name at
   implementation time). Move `resolvePatternTracksWrapper`, `syncTrackScroll`,
   `measureTrackScrollbar`, `setupTrackScrollSync`, teardown, and the
   `trackScrollbarObserver`/`teardownTrackScrollSync` state. The composable
   registers its own `onBeforeUnmount(teardown)`.
   - Callers that remain in TrackerPage: `refreshVisualizerAlignment`, the
     mount/nextTick wiring (`:1963-1968`), and `syncTrackScroll` external calls
     (grep before moving; keep a re-export only if >2 call sites need it — prefer
     returning the needed functions from the composable).
   - Gate: `npx vue-tsc --noEmit` + scroll/visualizer tests (search for
     tracker scroll sync tests; if none, behaviour is covered by the existing
     page-level suite only — note in addendum, no new audible risk).
2. Move the scoped style to `src/css/tracker-page.scss` (verify `src/css/`
   layout) and import it FROM the same `<style scoped lang="scss">` block
   (`@import`), preserving scoping exactly. INFERRED: keeping the import inside
   the scoped block is the zero-behaviour-change route; a global import would
   change cascade/specificity and is forbidden here.
3. Commit as `refactor(p7): N9 — extract useTrackerScrollSync + move tracker
   styles to scss`. Gates after.

Constraint: no template/logic changes beyond the extraction; if the extraction
requires changing template refs, STOP and re-scope in the addendum.

## Part 3 — N10: gate playback/instrument-build logging behind ?diag

MEASURED: existing opt-in mechanism `src/diagnostics/playback-diagnostics.ts`
(`?diag=playback`, `isPlaybackDiagEnabled(search)` at `:132`, boot file
`src/boot/playback-diagnostics.ts`). song-bank.ts has 24 `console.log` (review
said 46; some removed since — INFERRED by earlier landed lanes). Playback-store
`console.log` count >20 on load/play paths (MEASURED `:493-608` etc.).

Steps:
1. Add a small gated logger (e.g. `src/diagnostics/debug-log.ts`):
   `debugLog(tag, ...args)` — no-op unless the diag mechanism is enabled
   (read the same query param / a module-scoped flag initialized by
   `initPlaybackDiagnostics` to avoid re-parsing the URL per call). Keep it
   dependency-free and testable.
2. Convert `console.log` → `debugLog('[SongBank]', …)` in
   `src/audio/tracker/song-bank.ts` and `debugLog('[PlaybackStore]', …)` in
   `src/stores/tracker-playback-store.ts` — **logs on playback and
   instrument-build paths only**, per the queue scope. Leave `console.warn` /
   `console.error` untouched (real warnings must stay visible).
3. Extend/keep the existing `playback-diagnostics` test green; add a small test
   for the gated logger (enabled vs disabled).
4. Update any test that PINS the console.log output being removed — document
   each such test in the addendum (protocol rule).
5. No `quasar.config.ts` drop/pure console build setting — the queue sketch
   mentions it, but build-level stripping changes logging for ALL modules incl.
   warnings paths; converting the hot-path logs is the scoped fix. UNVERIFIED
   whether esbuild drop would break vitest mocks; deliberately not done.

## Constraints (verbatim from task)
- No `rust-wasm/` changes; no `public/` changes; no audible behaviour change;
  no API surface removal used by external consumers (`packages/` checked —
  none of the deleted files are exported from `packages/*`, MEASURED via the
  import sweeps above; re-verify at implementation).
- Tests updated only if they pin deleted dead code — each documented.

## Gates at tip (real exit codes into `.ai/checks-p7-*.txt`)
`npm run test:run` · `npm run lint` · `npx vue-tsc --noEmit` ·
`gitleaks detect --no-git` · `npm run check:artifacts`

Stop on green branch. No push, no merge, no deploy. Addendum records deviations,
final tally, N9/N10 outcomes.

## Addendum (post-run)

_(filled at completion)_