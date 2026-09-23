# Plan: conservative split of effect-processor.ts (arch-review §3c, P-queue item)

Date: 2026-09-23. Base: `b045e5af` (main == origin/main verified 2026-09-23 11:44).
Branch: `agent/effect-split-0923a`, worktree `.ai/worktrees/effect-split`.
Implementer: Claude Code headless, pinned `claude-opus-5-5`.

## 0. Standing rules (from arch-review pass)

- Extractions move code **verbatim** where possible; behavioral deltas are defects
  unless justified in the addendum (arch-review-2026-09-22.md, header + §4).
- No `rust-wasm/` changes. No audible behavior change.
- No `public/demos` commits (uncommitted build artifacts exist in the main checkout — never stage them).
- Gate: the event-stream corpus goldens, `src/tests/golden/event-stream/`
  (138 golden JSONs across `amiga/`, `ft2/`, `s3m/` — MEASURED `ls | wc -l`),
  run via `npm run test:run` (`src/tests/tracker-playback-event-stream.test.ts:72`).

## 1. Current state — MEASURED (tree b045e5af, 2026-09-23)

`packages/tracker-playback/src/effect-processor.ts` = **2454 lines** (`wc -l`),
matching arch-review-2026-09-22.md:34 ("still open, grown", 2454 lines).

Top-level layout (`grep -n '^export \|^const \|^function \|^interface \|^type '`):

| Cluster | Lines | Contents (file:line) |
|---|---|---|
| Pitch/period helpers | 16–200 | `SAMPLE_OFFSET_FRAMES_PER_UNIT` :16, vibrato constants :24–26, `updatePitchFromPeriod` :28, `updatePitchFromFrequency` :37, `applyFinePortamento` :65, `vibratoFrequency` :118, `advanceVibrato` :174, `applyPortamentoStep` :183 |
| State | 201–529 | `TrackEffectState` :201, `createTrackEffectState` :449 |
| MIDI conversion | 530–533, 610–620 | `midiToFrequency` :530, `frequencyToMidi` :610 |
| Tone porta | 534–609 | `resolveTonePortaSpeed` :534, `applyTonePortaStep` :549 |
| Waveforms | 621–671 | `REFERENCE_SINE_TABLE` :621, `getWaveformValue` :653 |
| Volume helpers | 672–937 | `clampVolume` :672, `velocityFromVolume` :694, `resetVolumeSlide` :698, `resolveVolumeSlide` :738, `primeVolumeSlide` :783, `emitTick0VolumeSlide` :906, `applyVolumeSlideIfNeeded` :928 |
| Command batch | 938–1081 | `ProcessorCommand` :938, `TickCommandBatch` :1007, push helpers :1020–1081 |
| Core tick0 | 1082–1937 | `processEffectTick0` (~855 lines) |
| Core tickN | 1938–2245 | `processEffectTickN` |
| Volume column | 2246–2438 | `volumeCommandIsTickBased` :2246, `processVolumeColumnTick0` :2273, `processVolumeColumnTickN` :2375 |
| Reset | 2439–2454 | `resetEffectStateForNote` :2439 |

Consumers (MEASURED, grep): `packages/tracker-playback/src/index.ts:43`
(`export * from './effect-processor'`), `engine.ts:47` (named imports),
`format-profile.ts:859` (comment only), plus `src/tests/` specs
(`effect-processor.spec.ts`, `ahx-effect-semantics.spec.ts`,
`tracker-song-builder-volume-reset.test.ts`, `mod-import-volslide-retrigger.test.ts`,
`butterfly-syndrome-pump.test.ts`) and `src/types.ts:162` (comment only).

## 2. Extraction plan — INFERRED (membership verified by coder against imports)

The review's prescription (arch-review-2026-09-22.md:220): **"only the mechanical
`effect-state.ts`/`waveforms.ts` move"**. Follow that, plus the reset function
which is state-only:

1. **`effect-state.ts`** (new): `TrackEffectState` (:201–448), `createTrackEffectState`
   (:449–529), `resetEffectStateForNote` (:2439–2454). Deps: `FormatProfile`
   (+ `PROTRACKER_PROFILE` for the default). Any state-only helpers that
   `resetEffectStateForNote` calls (exact closure INFERRED — coder computes from
   the import graph; if the closure would swallow tick-processing helpers,
   leave those in effect-processor.ts and keep the reset there instead).
2. **`waveforms.ts`** (new): `REFERENCE_SINE_TABLE` (:621–652), `getWaveformValue`
   (:653–671), vibrato table constants (`VIBRATO_TABLE_PEAK` :24,
   `VIBRATO_DEPTH_DIVISOR` :25, `TREMOLO_DEPTH_DIVISOR` :26) and the pure
   waveform helpers `vibratoFrequency` (:118) / `advanceVibrato` (:174) **only if**
   their imports stay acyclic (they read `TrackEffectState`; put them in
   waveforms.ts importing the type from effect-state.ts — types only, no cycle).
3. **`effect-processor.ts` keeps**: tick0/tickN processors, volume-column
   processors, command batch, pitch/portamento helpers, volume-slide helpers,
   MIDI conversion. It **re-exports everything it previously exported**
   (including the moved names) so `index.ts:43`, `engine.ts:47` and all test
   imports stay byte-identical — zero consumer churn.

Constraint: acyclic import graph, verified by `npx vue-tsc --noEmit`. Internal
(non-exported) helpers may be moved only when verbatim and their call sites
updated mechanically.

## 3. Sizing — UNVERIFIED targets (verify in addendum)

- effect-processor.ts: 2454 → roughly 1700–1900 lines after the move.
- New files: effect-state.ts ~300–350 lines, waveforms.ts ~100–150 lines.
- No size target justifies a behavior change; if the closure is messier than
  this, stop and report rather than improvise (stop-condition per queue).

## 4. Gates (real exit codes, on branch tip)

`npm run test:run`, `npm run lint`, `npx vue-tsc --noEmit`,
`gitleaks detect --no-git`, `npm run check:artifacts`. Baseline: main @ b045e5af
all green (HVL P3 record). 233 test files / 3743 tests at review time; expect
≥ baseline (HVL P3 landed 241/3922 per e1fc93f4 message).

## 5. Stop conditions

- Gates green on branch tip → STOP: no push, no merge, no deploy.
- Any gate failure not attributable to mechanical move mechanics → fix or stop.
- If the code contradicts this plan (e.g. hidden state coupling prevents an
  acyclic, verbatim move) → stop, write stop notes, report.

## 6. Addendum (post-implementation — filled by implementer)

To be appended after gates: deviations, extraction map with before/after
sizes, gate table with real exit codes.

## ADDENDUM (implementer, 2026-09-23)

Done per §2 without stopping: the move is verbatim, the import graph is acyclic, and no consumer changed
(index.ts, engine.ts and the tests are untouched).

### Deviations (honest list)

1. **`ProcessorCommand` moved to effect-state.ts as well.** The plan did not list it. `TrackEffectState`
   has `effectCommandBuffer: ProcessorCommand[]` and `volumeCommandBuffer: ProcessorCommand[]`, so leaving
   the type in effect-processor.ts would force effect-state.ts to import from effect-processor.ts, which is the
   cycle the rules forbid. It is a pure type with no dependencies, so it moved verbatim. effect-processor.ts
   re-exports it. `TickCommandBatch` and the `push*` helpers stay in effect-processor.ts.
2. **`VIBRATO_TABLE_PEAK` is exported from waveforms.ts** because the tremolo code in processEffectTickN
   (orig ~:2083) uses it alongside `TREMOLO_DEPTH_DIVISOR`. My first cut missed this: vue-tsc failed with TS2304
   and the tests failed. I fixed it mechanically by adding it to the import, then re-ran all gates. The outputs
   below are from that final run.
3. `export` was added to the five waveforms.ts names that effect-processor.ts consumes. They were module-private
   before, and they are **not** added to index.ts, so the public API is unchanged.
4. File sizes: effect-processor.ts 2454 → 1896 (inside the §3 1700–1900 range). effect-state.ts is 413 lines,
   above the ~300–350 estimate, because it also holds `ProcessorCommand` (57 lines). waveforms.ts is 170 lines,
   a little above the ~100–150 estimate, because the vibrato doc comments are long.
5. Prettier is not a gate, and the original file already fails `prettier --check`. The moved lines were kept
   byte-identical and not reformatted.

### Extraction map

See `.ai/extraction-map-effect-split.txt`. Summary: effect-state.ts ← orig :198–525, :938–994, :2436–2454;
waveforms.ts ← orig :18–26, :87–181, :614–670. Verbatim status was checked with a line-multiset diff of the
original against the union of the three files. The only differences are the `export` keywords, the file headers,
and the import/re-export lines.

### Gates (worktree, final tree; outputs in `.ai/checks-split-*.txt`)

| Gate | Command | Exit |
|---|---|---|
| tests | `npm run test:run` | 0 (241 files / 3922 tests passed, equal to baseline) |
| lint | `npm run lint` | 0 |
| types | `npx vue-tsc --noEmit` | 0 |
| secrets | `gitleaks detect --no-git --source .` | 0 |
| artifacts | `npm run check:artifacts` | 0 |

Not pushed, not merged.

## Landing record (2026-09-23, landed by run e5be76e6)

Merged `agent/effect-split-0923a` into main with `git merge --no-ff` from the main tree.
Merge sha: **b6acbc0a** (`b045e5af..b6acbc0a main -> main`, pushed, no force).
Merged tree hash `59bc0ba7…` is byte-identical to the reviewed tip `d88f2500`'s tree — the merge
contains exactly the reviewed content. Note: local main had moved one commit past the review base
b045e5af to 63fbb1ca (the plan-first commit for this very plan file, authored 11:45 today); it is an
ancestor of the branch (branch merge-base = main tip), origin/main was still b045e5af with no foreign
pushes, so the merge was conflict-free by construction. 63fbb1ca went out with the same push.

Review PASS reference: PASS on d88f2500 — verbatim-move line-multiset proof with only 13 benign lines
(export keywords, file headers, import/re-export lines), extraction 2454 → 1896 + 413 + 170, acyclic
import graph, zero consumer churn, no API leakage, gates 241/3922.

### Gates (merged main, tree 59bc0ba7…; logs /tmp/gate-*.log)

| Gate | Command | Exit |
|---|---|---|
| tests | `npm run test:run` | 0 (241 files / 3922 tests passed) |
| lint | `npm run lint` | 0 |
| types | `npx vue-tsc --noEmit` | 0 |
| secrets | `gitleaks detect --no-git` | 0 (no leaks found) |
| artifacts | `npm run check:artifacts` | 0 (worklets and wasm match their sources) |

### Deploy proof

`bash scripts/deploy.sh` → avatar@192.168.50.161:~/repos/docker-info-ws-server/html/synth, exit 0,
script self-verified ("Deployed and verified (a8bac153cdb80bc32e4bfaac155e1eef)" — index.html md5).
Independent md5 spot-check local (dist/spa) ↔ remote, all identical:
- index.html a8bac153cdb80bc32e4bfaac155e1eef
- demos/index.json 932613b4b8ce6b5e61448f0ada9a32eb
- wasm/audio_processor_bg.wasm e52bf5a9cd4f38e458532726f86e3f67
- worklets/effects-worklet.js ea0b2d2be2fd5dd6ec9a6a6ccb5c5e71

### Caveat: wasm rebuild is NOT byte-stable in this environment

This branch touches no rust-wasm/. The deploy-time `build:wasm` ran against the identical source set
(SOURCE_HASH.json sourceHash 5c9e359d…, 75 files, unchanged) but produced a different wasm sha256 than
the committed artifact (a9f17cab… vs committed 61a0c69e…). An identical phenomenon was observed at 09:41
today (same source hash, different output bytes, same file size); both pre-date and are unaffected by this
branch. The deployed wasm was built from exactly the reviewed sources, so it is source-correct, but the
byte-stability assumption for wasm rebuilds is empirically false here — likely nondeterministic
wasm-pack/wasm-bindgen output. The rebuild artifacts (demos/index.json timestamp, SOURCE_HASH.json, wasm
bytes) were stashed, not committed: `git stash list` → "post-deploy-p4: deploy-time wasm rebuild artifacts…"
and "pre-land-p4: local wasm/demo rebuild artifacts 0941". Worth a follow-up if byte-stable wasm deploys matter.

Landed, pushed, deployed.
