# Plan: P5 engine split — extract `scheduleRow` (+ `calculatePlaybackRate` relocation correction)

Date: 2026-09-23. Base: **`b6acbc0a`** (main == origin/main, verified 2026-09-23 12:05).
Branch: `agent/p5-engine-split-0923a`, worktree `.ai/worktrees/p5-engine`.
Implementer: Claude Code headless, pinned `claude-opus-5-5`.

## 0. Standing rules (from arch-review pass; unchanged from P4 plan)

- Extractions move code **verbatim**; only `export`/keyword/import lines may differ.
  Behavioral deltas are defects unless justified in the addendum.
- Import graph acyclic (runtime edges); no `rust-wasm/` changes; no `public/` changes.
- NO audible behavior change. `scheduleRow`/`calculatePlaybackRate` are on the playback
  hot path: the event-stream goldens (`src/tests/golden/event-stream/`, 138 golden JSONs)
  and the engine-bytes pin (`raw-effect-bytes.test.ts`) are the sensitive gates.
- Zero consumer churn preferred: re-exports over consumer edits. Any forced consumer
  import change is justified in the addendum.
- No `public/demos` commits (uncommitted build artifacts exist in the main checkout).

## 1. Queue documentation — where the item comes from

The P-queue for this pass lives in `.ai/arch-review-2026-09-22.md` (the fix-pass
authorization is recorded in the operator's daily note 2026-09-22: "ALL arch-review
findings get fixed INCLUDING engine items ... engine.ts scheduleRow ~555 §5;
calculatePlaybackRate A440-rooted §2c"). There was **no concrete plan doc** for the
engine item (P4's plan, `.ai/plan-effect-split-0923.md`, covered only §3c) — this
document is the plan-first deliverable.

**Task-text vs queue discrepancy, resolved by MEASURED evidence (not a stop):**
the dispatch text said "extract scheduleRow and calculatePlaybackRate from engine.ts".
MEASURED: `calculatePlaybackRate` is **not in engine.ts** — it is a private method of
`ModInstrument` at `packages/tracker-playback/src/sampler-instrument.ts:1163`, exactly
as the queue row §2c documents ("Moved to `sampler-instrument.ts:1163`, still
A440-rooted"). The queue doc and the code agree; the dispatch text's "from engine.ts"
is imprecise for this function. Scope below extracts each function from the module the
queue documents. §2c's *remaining* finding (A440-rooted musical-Hz contract) is a
semantic fix that would change audible behavior — explicitly out of scope here; no
behavior-touching edit is authorized by this item.

## 2. Current state — MEASURED (tree b6acbc0a, 2026-09-23)

- `packages/tracker-playback/src/engine.ts` = **2354 lines** (`wc -l`), matching the
  queue row §5 ("2354 lines (was 1918)").
- `scheduleRow` = private method, **`:1321` through `:1876`** (~556 lines); next class
  member `dispatchCommands` starts `:1877`. Matches §5's ":1321-1876 (~555 lines)".
- Single real call site: `engine.ts:1113` (`this.scheduleRow(actualRow,
  scheduledRowTime)`); other matches (:461, :885, :892, :1140) are comments.
- The `moduleFormat === 'native'` check §5 cites is inside the body (`:1575`), via
  `shouldRetriggerLastNote(newNote, step, ...)` — moves with the body.
- `shouldRetriggerLastNote` = exported free function at `engine.ts:55` (module level).
  Its only engine-internal use is `:1575` (inside scheduleRow). External consumer:
  `packages/tracker-playback/src/__tests__/engine-retrigger.spec.ts:3`
  (`import { shouldRetriggerLastNote } from '../engine'`), plus `index.ts:16`
  (`export * from './engine'`).
- `calculatePlaybackRate` = private method `sampler-instrument.ts:1163–1184` (~22
  lines, pure arithmetic). Internal call sites: `:880, :1025, :1653, :1969`. Comment
  references: `pitch-model.ts:320`, `src/tests/mod-pal-tuning.test.ts:14` (no code
  imports).
- `engine.ts` public exports: `shouldRetriggerLastNote` (:55), `PlaybackEngine` (:154).
  Consumers of `./engine`: five `__tests__` specs + `index.ts:16`. None import
  `scheduleRow` (private — impossible).

### scheduleRow `this.` dependency set (MEASURED, 28 members)

Methods (6, all `private`): `dispatchCommands`, `isTickBasedEffect`,
`canUseAutomationRamp`, `getTrackEffectState`, `getMsPerTick`, `getMsPerRow`.
Fields (22): `scheduledNoteHandler`, `stepIndex`, `pendingPosCommand`,
`patternLoopCount`, `patternLoopStart`, `patternLoopPending`, `patternDelayCount`,
`pendingSongStop`, `lastTrackNote`, `tracksWithStepsScratch`, `trackEffectStates`,
`formatProfile`, `moduleFormat`, `timingSystem`, `globalVolume`,
`scheduledNoteHandler`, `scheduledVolumeHandler`, `scheduledGlobalVolumeHandler`,
`scheduledPitchHandler`, `scheduledAutomationHandler`, `scheduledFilterHandler`,
`scheduledMacroHandler`, `macroHandler`.
Module-level helper used by the body: `shouldRetriggerLastNote` (engine.ts:55).

### calculatePlaybackRate dependency set (MEASURED)

`this.samplerState` (`:213`, private) and `this.oversampleFactor` (`:273`, private).
No other reads; no module-level helper calls.

## 3. Extraction plan — INFERRED mechanism (membership as measured above)

House precedent: the P2 song-bank split extracted class methods via a host interface
(`ScheduledEventHost`, `src/audio/tracker/scheduled-events.ts:26`). To keep the moved
bodies byte-verbatim (P4 standard: line-multiset diff, only header/import/export lines
differ), the receiver stays `this` via a TS `this`-parameter:

1. **`row-scheduler.ts`** (new):
   - `export interface ScheduleRowHost { ... }` — declares exactly the 28 members
     above (coder copies member signatures from the class declaration, mechanical).
   - `export function scheduleRow(this: ScheduleRowHost, row: number, time: number):
     void { <engine.ts:1321 body byte-verbatim> }`.
   - `export function shouldRetriggerLastNote(...)` moved verbatim from
     `engine.ts:55` (its only engine-internal use is inside scheduleRow; leaving it in
     engine.ts would create the runtime cycle engine → row-scheduler → engine).
2. **`engine.ts`**: delete the `:1321–1876` body and the `:55` function; add
   `import { scheduleRow } from './row-scheduler'` and
   `export { shouldRetriggerLastNote } from './row-scheduler'` (re-export keeps
   `engine-retrigger.spec.ts:3` and `index.ts:16` churn-free). The private method
   becomes a one-line delegate:
   `private scheduleRow(row: number, time: number): void { scheduleRow.call(this as
   unknown as ScheduleRowHost, row, time); }` — call site `:1113` unchanged.
   The `as unknown as` cast is required because the class's private members do not
   satisfy the interface structurally; it is compile-time only, zero runtime effect
   (documented as deviation D1).
3. **`playback-rate.ts`** (new):
   - `export interface PlaybackRateHost { readonly samplerState: TrackerSamplerConfig
     | null; readonly oversampleFactor: number; }` (type imported from its defining
     module, wherever `TrackerSamplerConfig` lives — coder follows the existing import).
   - `export function calculatePlaybackRate(this: PlaybackRateHost, frequency:
     number): number { <sampler-instrument.ts:1163–1184 body byte-verbatim> }`.
4. **`sampler-instrument.ts`**: remove `:1163–1184`; add import; private method becomes
   `private calculatePlaybackRate(frequency: number): number { return
   calculatePlaybackRate.call(this as unknown as PlaybackRateHost, frequency); }` —
   four call sites (`:880, :1025, :1653, :1969`) unchanged.
5. **No rust-wasm/, no public/, no index.ts, no test edits.** Runtime import graph:
   engine.ts → row-scheduler.ts (one direction); sampler-instrument.ts →
   playback-rate.ts (one direction). No cycles.

## 4. Sizing — UNVERIFIED targets (verify in addendum)

- engine.ts 2354 → ~1795 (−556 body, +~10 delegate/import/re-export lines).
- sampler-instrument.ts 2168 → ~2147.
- New: row-scheduler.ts ~600, playback-rate.ts ~45.
- Hot-path note: one extra `.call()` frame per scheduled row — semantics identical,
  no scheduling logic changes; goldens must confirm.

## 5. Gates (real exit codes, on branch tip)

`npm run test:run`, `npm run lint`, `npx vue-tsc --noEmit`,
`gitleaks detect --no-git`, `npm run check:artifacts`.
Baseline: main @ b6acbc0a all green (P4 addendum: 241 files / 3922 tests).

## 6. Stop conditions

- Gates green on branch tip → STOP: no push, no merge, no deploy.
- Any gate failure not attributable to mechanical move mechanics → fix or stop.
- If the body proves entangled beyond this mechanism (e.g. a dependency the class
  cannot expose through the host interface without a behavior change) → stop, write
  stop notes, report; do not redesign.

## 7. Addendum (post-implementation — filled by implementer)

Deviations, extraction map with before/after sizes, gate table with real exit codes.