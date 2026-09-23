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