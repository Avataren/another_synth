# Plan: AHX Instrument Page Redesign + Realtime Analyzer Feed (two-zone layout, preview-scoped oscilloscope/spectrum, PList canvas as sole primary editor)

> **Scope note.** This pass touches only `src/pages/AhxInstrumentPage.vue`, its child components under
> `src/components/ahx/`, `src/audio/tracker/ahx-preview.ts`, `src/audio/tracker/ahx-player.ts` (TS only, no
> `AudioWorkletProcessor`/Rust change), `src/stores/tracker-playback-store.ts`, one new module
> (`src/audio/tracker/ahx-preview-output.ts`), one new composable (`src/composables/useAhxPListEditing.ts`), one
> new component (`src/components/ahx/AhxAuditionBar.vue`), and the page's own test files. It does **not** touch
> `AhxPositionPanel.vue`, `TrackerPage.vue`'s position-panel wiring, `rust-wasm/`, `public/wasm/`, or
> `public/worklets/` (constraint, task §"Constraints", and the CRITICAL correction below).

Planner output, read-only investigation; no source file and no worktree were touched by this planning pass. Origin
(Morten, 2026-09-22 12:50, verbatim): *"What we do need though, is realtime waveform and spectrum analyzer in the
ahx instrument editor, similar to the native patch editor, and a redesign of the whole page, the layout is messy
atm."* / *"The instrument editor page for ahx that is."* Approved 12:53 (verbatim, from
`.ai/task-ahx-inst-redesign.md:8`): analyzer feed scoped to **the previewed instrument only** (tap the AHX
preview's own output GainNode, not the song mix); fixed two-zone grid (left = parameter panels, right/main =
dynamic); analyzer row top-right beside the audition bar; 14 sliders grouped into 4 fieldsets (Level & wave /
Vibrato / Square / Filter) beside their matching motion lanes; PList canvas becomes the only primary editor, full
table behind a toggle, chip strip retired; audition bar extracted to its own component; PList editing state
machine extracted to a composable. Also binding (12:48, quoted in the task, not to be contradicted): vibrato is a
deterministic instrument attribute, no tracker-side vibrato surfacing; the filter has no format field at all
(engine behavior, bit-faithful) — no new filter UI beyond what exists.

**Relation to sibling plans.** This pass builds **on** what three prior passes already landed on `main` (HEAD
`a1c72639` or later; `git log` at plan time: `a1c72639` merge pos-transpose, `5deff390` transpose feature,
`4086dd60` plist B2 test, `881b33c3` merge Song Edit B3, `d0f2841c` **merge: PList B5+B6 — plist edit core +
canvas editing UI**), but it **shares no batch** with them:

- `.ai/plan-plist-canvas.md` (batches B0–B7, all merged as of `d0f2841c`/`4086dd60`) built `PListCanvas.vue`, the
  engine-truthful playhead (`ahx-plist-playhead.ts`, a minimal **already-landed and already-committed** Rust/wasm
  change, not reopened here), and the canvas editing layer (`plist-edit.ts`, `plist-edit-input.ts`,
  `commitPListEdit`, `createPListGesture`). This pass **extracts** the page-side glue that plan already wrote
  (§2.2–§2.3 of that plan) into a composable; it does not change the ops, the write path, the size guard or undo.
- `.ai/plan-ahx-editing.md` (Song Edit) is the source of `trackerStore.isAhxEditable`, `pushHistory`, `undoStack`,
  `ahxInstrumentRefusal` — all consumed as-is (MEASURED at `AhxInstrumentPage.vue:970–988`, unchanged by this plan).
- `.ai/plan-pos-transpose.md` landed `AhxPositionPanel.vue` + its `TrackerPage.vue` wiring **today** (merge
  `a1c72639`); see the correction below.

**CRITICAL correction to the survey** (`/home/openclaw/.openclaw/workspace/.tmp/ahx-inst-redesign-survey.md`,
§2.1 and §6 point 8, which call `AhxPositionPanel.vue` "not referenced by the page — orphaned" / "dead component
to prune or wire in"): **this is wrong about deletion.** MEASURED: `AhxPositionPanel` is imported and rendered in
`TrackerPage.vue:949` and `:335`, with a template ref at `:1168`. It is genuinely absent from
`AhxInstrumentPage.vue` (the *instrument* page has no position/transpose concept — positions are a song-structure
thing), which is what the survey actually observed; its conclusion ("prune or wire in") does not follow. This plan
**forbids** touching `AhxPositionPanel.vue`, `TrackerPage.vue`'s position-panel wiring, or the rust engine, per the
task's explicit constraint.

**Labels.** **MEASURED** = read directly in the code below, with a `file:line` citation, at plan time (main
checkout, no worktree). **INFERRED** = read from code but not exercised (unit/E2E proves it in the batch that adds
the test). **UNVERIFIED** = could not be checked from static reading (listed in §7 Risks and §8, not assumed).

---

## 0. The decisions that shape the plan

### D-A. Analyzer tap point: `AhxPlayerClient.output` (the preview voice's own GainNode), not the song mix

**Evidence.** Two distinct nodes both happen to be named `output` in this codebase, and conflating them would
silently scope the analyzer to the wrong signal:

- `AhxPlayerClient.output` (`src/audio/tracker/ahx-player.ts:70`, doc comment "Master gain after the worklet";
  created `:100` `this.output = audioContext.createGain()`, wired `:101` `node.connect(this.output)`) is the
  **preview voice's own** post-worklet gain — one mono voice, keyboard/MIDI-driven, nothing else routes into it.
- `AhxTransportHost.output` / `SongBank.output` (`src/audio/tracker/ahx-transport.ts:33-37`;
  `src/audio/tracker/song-bank.ts:248-250` `get output(): AudioNode { return this.masterGain; }`) is the **whole
  song's pre-rack mix bus** — every track, every instrument.
- `AhxPreview.ensureClient()` connects the first into the second: `client.output.connect(this.host.output)`
  (`ahx-preview.ts:191`). So tapping `host.output`/`SongBank.finalOutput` (post-rack, `song-bank.ts:260-262`)
  would show the whole song (if one is playing) mixed with the previewed instrument; tapping
  `AhxPlayerClient.output` shows **only** the previewed instrument, before the song bus, matching Morten's 12:53
  wording exactly ("scoped to the previewed instrument only").

| Tap point | Verdict |
|---|---|
| `AhxPlayerClient.output` (the preview's own gain) | **Chosen.** Hears only the previewed instrument; a song playing underneath does not pollute the display. Matches the approved decision verbatim. |
| `SongBank.output` / `SongBank.finalOutput` (mix bus, pre- or post-rack) | Rejected for this feature: shows the whole song, not "the previewed instrument only." `finalOutput` is what the recorder/meters use (`song-bank.ts:253-258`, "must show what-you-hear") — a *different* honest claim than this feature makes; not reused here, and not removed. |
| A new dedicated `AnalyserNode` inside the worklet (Rust/wasm) | Rejected: forbidden by the task's engine-untouched constraint, and the tap is already a Web Audio node reachable from the main thread — no engine work is needed (§2). |

### D-B. Plumbing idiom: mirror `AhxPreview.onPListRow` + the module-level `ShallowRef` (`ahxPListPlayhead`) pattern exactly

**Evidence — the precedent, read in full (`ahx-preview.ts:35-220`, `ahx-plist-playhead.ts:1-172`,
`tracker-playback-store.ts:80, 495-542, 544-549`):**

- `AhxPreview` keeps its listeners on **itself**, not on the client (`plistRowListeners`, `ahx-preview.ts:44`), so
  subscribing never creates a worklet (`ahx-preview.ts:72-75`; proven by
  `src/tests/ahx-plist-row-client.test.ts:122-130` "creates nothing by being subscribed to").
- `ensureClient()` attaches the client's own event source to the preview's listener set only once the client
  exists (`ahx-preview.ts:196-201`); `disposeClient()` unsubscribes and tells every listener the signal is gone
  before dropping the client (`ahx-preview.ts:211-219`; here that message is `{instrument:0,row:-1}` — the
  output-node equivalent is `null`).
- The playback store owns exactly one singleton (`ahxPreviewInstance`, `tracker-playback-store.ts:80`), builds it
  in `newAhxPreview()` (`:533-542`), and wires the one-line subscription there:
  `preview.onPListRow(pushAhxPListReport)` (`:539`). `disposeAhxPreview()` (`:544-549`) explicitly clears the
  module ref (`clearAhxPListPlayhead()`) in addition to disposing the preview, because a stale preview's last
  report must not linger.
- `ahxPListPlayhead` is a `shallowRef<AhxPListPlayhead | null>` (`ahx-plist-playhead.ts:24`), replaced whole, never
  mutated — the same reasoning as `ahxSourceInfo` (`ahx-plist-playhead.ts:20-23`, "no Proxy ever wraps the
  value"). The **page imports it directly** (`AhxInstrumentPage.vue:662`
  `import { ahxPListPlayhead } from 'src/audio/tracker/ahx-plist-playhead';`) — it is **not** part of the store's
  returned public API (`tracker-playback-store.ts:1445-1499` has no `ahxPListPlayhead` in the return object). The
  store only *writes* it; consumers read the module import.

**Design for B1 (new, mirrors the above 1:1):**

1. New file `src/audio/tracker/ahx-preview-output.ts`, same shape as `ahx-plist-playhead.ts`:
   `export const ahxPreviewOutputNode: ShallowRef<AudioNode | null> = shallowRef(null);` and
   `export function setAhxPreviewOutputNode(node: AudioNode | null): void { if (ahxPreviewOutputNode.value === node) return; ahxPreviewOutputNode.value = node; }`.
2. `AhxPreview` gains a second listener set, `outputNodeListeners = new Set<(node: AudioNode | null) => void>()`,
   and `onOutputNode(listener): () => void` (identical shape to `onPListRow`, `ahx-preview.ts:72-75`).
3. `ensureClient()` (`ahx-preview.ts:183-209`): right after `this.client = client;` (`:202`), add
   `for (const listener of this.outputNodeListeners) listener(client.output);`.
4. `disposeClient()` (`ahx-preview.ts:211-219`): right after the existing `if (this.client) for (const listener of this.plistRowListeners) listener({...})`
   block (`:214-215`), add the symmetric
   `if (this.client) for (const listener of this.outputNodeListeners) listener(null);` — **before** `this.client = null;`.
5. `AhxPreview.dispose()` (`:148-153`) clears `outputNodeListeners` alongside `plistRowListeners.clear()`.
6. Store: `newAhxPreview()` (`:533-542`) adds one line, `preview.onOutputNode(setAhxPreviewOutputNode);`, beside
   `preview.onPListRow(pushAhxPListReport);`. `disposeAhxPreview()` (`:544-549`) adds
   `setAhxPreviewOutputNode(null);` beside `clearAhxPListPlayhead();`.
7. **No getter is added** (no `AhxPreview.outputNode` accessor) — `onPListRow` has no matching getter either; the
   subscription is the whole idiom, and adding a second shape would be an inconsistency, not a feature.
8. The page imports `ahxPreviewOutputNode` directly from the new module, exactly as it already imports
   `ahxPListPlayhead` — **not** through the store's return object (which does not carry `ahxPListPlayhead` either;
   see D-B evidence above). This is not "surfaced through the store" in the sense of appearing in its return
   type — it is surfaced through the store's *wiring code* (`newAhxPreview`/`disposeAhxPreview`), matching the
   existing precedent exactly. Documented here so the coder does not "fix" this by adding it to the store's return
   object, which would be a second, inconsistent shape.

| Design | Verdict |
|---|---|
| Mirror `onPListRow` + module `ShallowRef`, page imports the ref directly | **Chosen.** Matches the established idiom byte-for-byte; zero new test-mocking surface (existing page tests mock the whole `tracker-playback-store`, `src/tests/ahx-instrument-page-plist-canvas.test.ts:9-14`, and would not see a field added only to the store's return type anyway). |
| Add `ahxPreviewOutputNode` to the store's returned public API (`tracker-playback-store.ts:1445-1499`) | Rejected: `ahxPListPlayhead` — the precedent this plan is told to mirror — is deliberately **not** in that object; adding the new ref there would be a second, divergent shape for the same kind of thing. |
| Poll `ahxPreviewInstance` from the page (no listener) | Rejected: the store's `ahxPreviewInstance` is module-private (`tracker-playback-store.ts:80`, no accessor), and polling would recreate the exact "worklet accessible only from inside the store" problem D-B's plumbing exists to solve. |

### D-C. Reuse `OscilloscopeComponent.vue` / `FrequencyAnalyzerComponent.vue` as-is (Quasar-wrapped), restyle only via scoped CSS on the AHX page — do not fork into native-element AHX variants

**Evidence.** Both components (MEASURED, full read):

- Take one prop, `node: AudioNode | null` (`OscilloscopeComponent.vue:21-23`, `FrequencyAnalyzerComponent.vue:16-18`),
  self-attach/detach/clean up on `watch(node, ...)` (`OscilloscopeComponent.vue:214-219`,
  `FrequencyAnalyzerComponent.vue:186-191`) — the exact contract B2 needs, no props to add.
- Each is a single-root SFC (`<q-card><q-card-section>...` — `OscilloscopeComponent.vue:2-15`,
  `FrequencyAnalyzerComponent.vue:2-10`) with **no `data-testid` of its own** and no `inheritAttrs: false` /
  `defineOptions`, so a plain `data-testid="..."` attribute on the component tag falls through to that root
  element by Vue's default attribute inheritance — the same mechanism `plan-plist-canvas.md` §5 already relies on
  for `PatternCanvas` ("attributes on the component tag fall through to its single root"). B2 uses this; no
  component file is touched to get a testid.
- The analyser taps are read-only by construction: `FrequencyAnalyzerComponent.vue:66-70` even has the
  `analyser.connect(audioNode.context.destination)` line **commented out** with the comment left in place — direct
  evidence the authors already treated "never connect to destination" as a rule, not an oversight. `OscilloscopeComponent`
  never calls `.connect()` on anything but its own internal splitter/analysers.
- Theme is CSS-variable driven (`--app-background`, `--tracker-accent-complement`, `--text-muted`,
  `--panel-border`; `OscilloscopeComponent.vue:39-42`, `FrequencyAnalyzerComponent.vue:36-50`), refreshed by a
  `MutationObserver` on `documentElement` style attributes — the same variables the AHX page's own `ahx-card`
  language already uses (`AhxInstrumentPage.vue:1176,1188,1191,1227,1229` etc.), so no new palette is introduced.
- Sizing (plan-review finding 1, corrected): the two components are NOT symmetric. `OscilloscopeComponent.vue:240`
  has a hardcoded `height: 120px` on its canvas, but `FrequencyAnalyzerComponent.vue` has **no fixed-pixel height
  anywhere** — `:201` is `height: 100%` inside `.frequency-container { height: 100% }` (`:196`) inside
  `.frequency-card { height: 100% }` (`:210`), and its `draw()` bails when the canvas is 0×0 (`:98-100`). So the
  frequency analyzer's canvas collapses to nothing unless the PAGE gives the component's root a real height. B2
  must therefore give `.ahx-analyzer`'s two child slots explicit set heights (e.g. `.ahx-analyzer > * { height: 70px; }`)
  and/or a `:deep(canvas) { height: 70px }` override — a bare flex wrapper with no heights renders the
  oscilloscope fine at 120px and the spectrum silently blank. (Border-radius overrides via `:deep()` still apply
  to both; technique precedent `PListCanvas.vue:488-490`.)

| Option | Verdict |
|---|---|
| Reuse as-is, restyle via `:deep()` overrides in the AHX page's scoped CSS | **Chosen.** Zero risk to the reference mechanism IndexPage already ships; matches the task's explicit "reuse `OscilloscopeComponent.vue` + `FrequencyAnalyzerComponent.vue`... restyle only as needed." |
| Fork into new native-element AHX variants (no `q-card`, matching `PListCanvas.vue`'s "no `q-*`" house rule) | Rejected for this pass: a much larger diff (two ~250-line components rewritten) for a cosmetic gain the task does not ask for; the "no `q-*` in new AHX files" rule (plan-plist-canvas §5) applies to *new* AHX-native files, not to reused shared components — the AHX page already contains non-native Quasar elements at its root (`<q-page>`, `<q-icon>`, `<q-btn>`, `AhxInstrumentPage.vue:2,5,28-36`), so a `q-card` island is not a new inconsistency. |

### D-D. Fixed two-zone grid replaces `auto-fit` — evidence of the current mess, and what moves where

**Evidence of the mess (MEASURED, `AhxInstrumentPage.vue`):**

- `.ahx-body { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); ...}` (`:1219-1223`):
  card order and column count both shift with viewport width; only `.ahx-card--wide` cards are pinned full-width
  (`:1232-1234`), so most of the page reflows unpredictably.
- Six top-level `ahx-card` sections today, in source order: Audition (`:61-146`, sticky, `--wide`), Instrument
  (`:148-295`, 14 flat controls, no sub-grouping), Volume envelope (`:297-348`), Waveform (`:350-416`), Sound in
  motion (`:418-454`, `--wide`, 3 lanes), PList (`:456-634`, `--wide`, strip + canvas + table together).
- The "Sound in motion" card (`:424-453`) already groups Vibrato/Square/Filter as three lanes in its own
  `auto-fit` sub-grid — this pass keeps that grouping concept but merges each lane into its matching fieldset
  instead of a separate card, per Morten's decision.

**Design.** Two named CSS-grid columns replacing the `auto-fit` rule:

```css
.ahx-body {
  display: grid;
  grid-template-columns: minmax(300px, 380px) 1fr; /* left: fixed-ish param column; right: everything else */
  gap: 12px;
  padding: 12px;
}
.ahx-left { display: grid; gap: 12px; align-content: start; }
.ahx-right { display: grid; gap: 12px; }
.ahx-right-top { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; } /* audition bar + analyzer */
.ahx-plist-full { grid-column: 1 / -1; } /* PList section still spans the full body width, as `--wide` did */
```

The PList section (today's only content that legitimately needs full width — the canvas's own track is ~356px
plus the table below can be much wider) keeps spanning both columns via `.ahx-plist-full`, i.e. it sits **below**
the two-column area, matching the task's own wireframe ("+ PList canvas as the ONLY primary editor" listed last,
outside "left column ... right/main"). See the ASCII wireframe in §1.

| Layout mechanism | Verdict |
|---|---|
| Two named `grid-template-columns`, PList full-width below both | **Chosen.** Deterministic column count and card placement (no more `auto-fit` reflow surprises), matches the task's literal "fixed grid... left column... right/main" wording, minimal CSS diff (one rule replaced, a handful added). |
| Nested independent scroll panes per column | Rejected: `q-page` is the one scroll container today (`AhxInstrumentPage.vue:1429` comment: "The page (q-page) is its own scroll container... so 0 is just under it"); introducing per-column scrolling would break the audition bar's existing `position: sticky; top: 0` behavior and is not asked for. |
| Keep `auto-fit`, only reorder cards | Rejected: does not satisfy "fixed grid" (Morten's word) — column count would still change with viewport width. |

### D-E. PList becomes the only primary editor: canvas always shown, table behind a toggle (`v-show`, not `v-if`), chip strip retired and deleted

**Evidence — why `v-show`, not `v-if`, for the table, and a correctness trap this closes:**

`PListCanvas.vue`'s double-click hand-off (`onDoubleClick`, `:300-303`) emits `'focus-field'` with a table field's
`data-testid` (`fieldTestid`, `:292-298`, e.g. `ahx-plist-{row}-note`); the page's `focusField()`
(`AhxInstrumentPage.vue:948-953`) does a synchronous `document.querySelector(...).focus()`. **If the table is
`v-if`-removed while collapsed, this querySelector finds nothing and the hand-off silently does nothing** — a
regression the plan-plist-canvas D-C design (`.ai/plan-plist-canvas.md:274-280`, "the table stays authoritative...
double-click a cell = focus the same cell's table field") explicitly depends on working. `v-show` keeps every row,
`AhxNumberField`, `<select>` and testid in the DOM (just `display:none`), so:

1. `focusField()` must additionally **open** the table when it is closed, before focusing: set the visibility ref
   `true`, then `await nextTick()` before the querySelector/focus (a `display:none` element cannot receive focus;
   the ref flip must land in the DOM first). This is a **required B3 code change**, not cosmetic — without it, the
   double-click hand-off (already covered by `T11`/`T12`-equivalent behavior, MEASURED as exercised in
   `src/tests/ahx-instrument-page-plist-edit.test.ts`) silently breaks.
2. Every existing table-testid assertion in the six page-level test files (`ahx-instrument-page*.test.ts`, listed
   in §6) keeps working unchanged: `w.get('[data-testid="ahx-plist-row-N"]')` etc. still finds the element whether
   shown or hidden, because `mount()` + `@vue/test-utils` selectors operate on the DOM tree, not computed style.
3. The toggle itself is one boolean ref, `plistTableVisible` (default `false`, matching "full table behind a
   toggle"), rendered as a native `<button aria-expanded="...">` (native elements only, per the AHX-native-file
   house rule) with testid `ahx-plist-table-toggle`, label "Show table" / "Hide table". Opening it via the
   double-click hand-off (point 1) sets the **same** ref, so the toggle's own `aria-expanded` state is never a lie
   (the house "every visible statement is true" rule, §4).

**Chip strip retirement — evidence it is safe to delete, not just unwire:**

- `AhxPListStrip.vue` is referenced by exactly one file outside its own definition and tests
  (MEASURED, `Grep "AhxPListStrip"` across `src/` → only `AhxInstrumentPage.vue`). No other page or component
  imports it.
- Its own dedicated page-level coverage is entirely inside `src/tests/ahx-instrument-page-b2.test.ts:206-256`
  ("E6: the PList strip", 4 `it` blocks) — there is no separate component-only `AhxPListStrip.test.ts`
  (`Glob "src/tests/*strip*"` → no results). Deleting the component and this one `describe` block leaves no
  orphaned test file.
- Two **other** test files use the strip only as a convenient click target to prove selection syncs across views,
  and must be adapted (not deleted) in B3 — MEASURED exact lines:
  - `src/tests/ahx-instrument-page-plist-canvas.test.ts:66-75` — "mounts the canvas above the patterns table, and
    leaves the chip strip where it was": the whole test's premise (the strip exists) is gone; delete/replace with
    "mounts the canvas above the (initially hidden) table" asserting `ahx-plist-table-toggle`'s
    `aria-expanded="false"` and that the table row testid is present-but-hidden via `getComputedStyle`, or simply
    drop the strip-position assertion and keep the canvas-above-table one (the table is always in the DOM under
    `v-show`, so `compareDocumentPosition` still works).
  - `:83` inside "a canvas click selects the step in the table and the strip" — drop the
    `expect(el(w, 'ahx-strip-chip-2')...)` line only; the table/canvas assertions in the same test stay.
  - `:88-97` "a strip click and a focus in a table row select the step on the canvas" — replace the
    `el(w, 'ahx-strip-chip-1').trigger('click')` step with an equivalent non-strip selection source (e.g. a
    canvas `rowSelected` emit, matching the pattern already used two tests above at `:79`), keep the
    table-`focusin` half of the test (`:93`) unchanged.
  - `src/tests/ahx-instrument-page-plist-playhead.test.ts:186-195` "a selection made by hand is not moved by the
    playhead, and both show at once" — replace `el(w, 'ahx-strip-chip-0').trigger('click')` (`:188`) with
    `el(w, 'ahx-plist-row-0').trigger('focusin')` (the table's existing `@focusin="selectedRow = index"` handler,
    `AhxInstrumentPage.vue:552`, already does the same job and is unaffected by `v-show`).

**Row-count/speed preservation — the task's premise is already false, MEASURED, not "solved by design":**

The task (`.ai/task-ahx-inst-redesign.md:21`) lists "how the retired chip strip's info (row count/speed) is
preserved" as something to decide. Read closely: `AhxPListStrip.vue` **does not show row count or speed anywhere
in its own markup** (its caption is fixed prose, `AhxPListStrip.vue:3-6`; each chip shows one step's own fields,
`:29-47` — no aggregate). Row count and speed are shown in the **PList card's own `<h3>`**, entirely independent
of the strip: `AhxInstrumentPage.vue:456-463`, `data-testid="ahx-plist-summary"`,
`"{{ instrument.plist.entries.length }} rows, speed {{ instrument.plist.speed }}"`. This header is untouched by
retiring the strip. **Nothing needs to be preserved because nothing about the strip carried it.** State this
correction to Morten explicitly (§0 smaller decisions below) rather than silently building a replacement for a
problem that does not exist.

| Option | Verdict |
|---|---|
| Delete `AhxPListStrip.vue`, unwire from the page, delete its dedicated test block, adapt the 2 files above | **Chosen.** No other references exist; keeping a dead, untested-from-the-page component around is the same smell the `AhxPositionPanel` correction warns against — except here the survey's premise (dead code) is actually true. |
| Keep `AhxPListStrip.vue` on disk, unreferenced, "for later" | Rejected: Morten's approval (12:53) says "retired," not "hidden"; an unreferenced component with a broken test file left in place is a worse state than deleting both together in one batch. |
| Table default-open instead of default-collapsed | Rejected: contradicts "full table behind a toggle" (implies hidden-by-default); default-open would look identical to today's three-simultaneous-views problem this whole pass exists to fix. Flagged again as one of the three named smaller decisions in §0 below (exact wording), in case Morten prefers default-open. |

### D-F. Envelope stage-table dedup: **keep both this pass** (named smaller decision (a) from the task)

**Evidence.** `AhxEnvelopeEditor.vue` (the SVG node editor) and the page's own `<table data-testid="ahx-envelope-table">`
(`AhxInstrumentPage.vue:308-339`) edit the **same eight fields** (`aFrames/aVolume/dFrames/dVolume/sFrames/rFrames/rVolume`,
`ENVELOPE_STAGES`, `:875-886`) but are not merely duplicative — they are **wired together**:

- Each SVG node's double-click emits `'focus-field'` with the table field's own testid (`AhxEnvelopeEditor.vue:85`
  `@dblclick="emit('focus-field', ...ahx-env-${ahxNodeFramesField(node)})"`), landing on the page's `focusField()`
  (`:948-953`) — **identical hand-off mechanism** to the PList canvas's double-click-to-table (D-E), and the exact
  idiom D-E's design explicitly cites as the precedent ("This is `focusField`'s idiom (envelope node double-click)",
  `.ai/plan-plist-canvas.md:493`).
- Removing the table would require the SVG editor to gain its own direct numeric entry (arrow-key stepping exists,
  `AhxEnvelopeEditor.vue:82-84` "Drag, or use the arrow keys... Double-click to type", but there is no SVG-native
  typed-value widget) — i.e. it is not a delete-one-keep-the-other swap, it is new UI work the task does not ask
  for.
- The table's own testids (`ahx-env-aFrames` etc., `:321,332`) are asserted directly in
  `src/tests/ahx-instrument-page-ux.test.ts:135-144` ("an arrow key on a node commits to the song, and the typed
  field follows") — removing the table breaks that test's whole premise, not just its assertions.

Per the task's own instruction ("keep both the node editor and the AD/SR table this pass unless the dedup is
trivially safe, state which you chose") — **the dedup is not trivially safe** (it is a new-widget project, not a
deletion), so **this pass keeps both**, unchanged, just repositioned into the right-hand column as one section.

### Smaller decisions Morten should eyeball (the three named by the task, plus two found while verifying)

1. **Envelope stage-table dedup (task item a).** **Recommendation: keep both, unchanged, this pass** — D-F above.
   The dedup would need a new typed-entry widget on the SVG editor; not attempted here.
2. **Analyzer row placement (task item b): exact position/height/columns.** **Recommendation:** a fixed-width
   (~260–300px) column at the right edge of `.ahx-right-top` (the audition-bar row), holding
   `OscilloscopeComponent` stacked above `FrequencyAnalyzerComponent`, each height-capped to ~70–80px via `:deep()`
   override (down from IndexPage's 120–140px, since this sits *beside* a multi-line flex-wrap audition bar rather
   than in its own dedicated row) — see the wireframe in §1. **Alternatives, if this reads as cramped once built:**
   (A2) a full-width row **below** the audition bar, above the envelope section, at IndexPage's own 120–140px
   height (simplest, most legible, costs one more vertical "band" the redesign was trying to shrink);
   (A3) collapsed by default behind a small toggle, matching the PList table's own "toggle" precedent (least
   visual cost, but analyzers are supposed to be glanced at while auditioning, so hiding them by default cuts
   against the point of the feature). Recommend starting with the chosen (top-right, beside the bar) design since
   it is literally what Morten typed ("analyzer row top-right beside the audition bar"); fall back to A2 only if
   Firefox/E2E screenshots (§6 gate) show it does not fit legibly at the AHX page's normal widths.
3. **Chip strip's row-count/speed info (task item c).** **Correction, not a decision:** nothing needs preserving —
   `ahx-plist-summary` (`AhxInstrumentPage.vue:459-462`) already shows row count and speed, independent of and
   untouched by the strip's retirement (D-E evidence above). Flagged so Morten does not expect a new element that
   would be redundant.
4. **(Found while verifying.) Hard-cut release fields land in the "Filter" fieldset, not their own group.**
   Morten's four named fieldsets are Level & wave / Vibrato / Square / Filter (task, 12:53) — 14 controls split
   3/3/3/5 to fit exactly (§1 table). The two hard-cut controls (`ahx-field-hardCutRelease`,
   `ahx-field-hardCutReleaseFrames`) are not conceptually about the filter (they are note-release timing), but sit
   immediately after Filter speed in the current markup (`AhxInstrumentPage.vue:266-285`) with no natural home
   among the other three groups. Recommendation: keep them adjacent to Filter (least churn, preserves visual
   continuity); a 5th "Release" fieldset was considered and rejected because Morten named exactly four.
5. **(Found while verifying.) "Level & wave" has no matching motion lane.** Only Vibrato, Square and Filter have
   `AhxVibratoLane`/`AhxSweepLane` companions (`AhxInstrumentPage.vue:424-453`, "Sound in motion" — 3 lanes, not
   4). Level & wave (volume + wave length) sits alone at the top of the left column with no lane beside it; no new
   lane is invented (out of scope — the task says "beside their matching motion lanes," implying only the ones
   that have one).

---

## 1. Visual design

### 1.1 ASCII wireframe (approved two-zone layout)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ahx-banner  (icon · slot # · name · mode badge · Back to Tracker)               │  unchanged (D-D untouched)
├────────────────────────────────────────────────────────────────────────────────┤
│ notices / empty state                                                           │  unchanged
├───────────────────────────┬──────────────────────────────────────────────────┤
│ LEFT  .ahx-left  (fixed-ish, 300–380px)   │ RIGHT/MAIN  .ahx-right  (1fr)       │
│                                            │ ┌─ .ahx-right-top (flex, wrap) ──┐ │
│ ┌─ Level & wave ───────────────────────┐ │ │ ┌─ AhxAuditionBar ───────────┐ │ │
│ │ Volume slider                         │ │ │ │ keys · piano strip · octave │ │ │
│ │ Wave length (segmented + field)       │ │ │ │ MIDI chip · Latch ·         │ │ │
│ │ (no motion lane, §0 smaller dec. 5)   │ │ │ │ Re-strike · hint            │ │ │
│ └────────────────────────────────────────┘ │ │ └──────────────────────────────┘ │ │
│ ┌─ Vibrato ─────────────────────────────┐ │ │ ┌─ analyzer (§0 smaller dec.2)┐ │ │
│ │ Delay / Speed / Depth sliders          │ │ │ │ Oscilloscope (≈70-80px)     │ │ │
│ │ [AhxVibratoLane]                       │ │ │ │ FrequencyAnalyzer (≈70-80px)│ │ │
│ └────────────────────────────────────────┘ │ │ └──────────────────────────────┘ │ │
│ ┌─ Square ──────────────────────────────┐ │ └────────────────────────────────┘ │
│ │ Lower / Upper / Speed sliders          │ │ ┌─ Volume envelope ───────────────┐│
│ │ [AhxSweepLane kind="square"]           │ │ │ AhxEnvelopeEditor (SVG, D-F)     ││
│ └────────────────────────────────────────┘ │ │ + AD/SR table (kept, D-F)        ││
│ ┌─ Filter ──────────────────────────────┐ │ └───────────────────────────────────┘│
│ │ Lower / Upper / Speed sliders          │ │ ┌─ Waveform ───────────────────────┐│
│ │ Hard cut release + frames (dec. 4)     │ │ │ Starts-with · filter position ·  ││
│ │ [AhxSweepLane kind="filter"]           │ │ │ AhxWaveShape preview · usage list ││
│ └────────────────────────────────────────┘ │ └───────────────────────────────────┘│
├───────────────────────────┴──────────────────────────────────────────────────┤
│ .ahx-plist-full  (spans both columns, below — was `.ahx-card--wide`)            │
│ PList  N rows, speed S  [speed] [Add row] [Edit steps]  [Show table ▾]          │
│ edit notice (if any)                                                            │
│ PListCanvas  — the ONLY primary editor (chip strip DELETED, D-E)                │
│ table (v-show, default hidden; opens on toggle or on a double-click hand-off)   │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Fieldset ↔ control ↔ lane mapping (all 14 existing controls, none added/removed)

| Fieldset | Controls (existing testid, unchanged) | Motion lane | Count |
|---|---|---|---|
| Level & wave | `ahx-field-volume`, `ahx-seg-waveLength` + `ahx-field-waveLength` | *(none — §0 smaller dec. 5)* | 2 fields, 3 controls |
| Vibrato | `ahx-field-vibratoDelay`, `ahx-field-vibratoSpeed`, `ahx-field-vibratoDepth` | `AhxVibratoLane` (`:delay :speed :depth`, unchanged props) | 3 |
| Square | `ahx-field-squareLowerLimit`, `ahx-field-squareUpperLimit`, `ahx-field-squareSpeed` | `AhxSweepLane kind="square"` (unchanged props) | 3 |
| Filter | `ahx-field-filterLowerLimit`, `ahx-field-filterUpperLimit`, `ahx-field-filterSpeed`, `ahx-field-hardCutRelease`, `ahx-field-hardCutReleaseFrames` | `AhxSweepLane kind="filter"` (unchanged props) | 5 |

Total: 2 + 3 + 3 + 5 = 13 field-groups / 14 controls (waveLength has two controls for one field), matching the
survey's own count of "14 `AhxSliderField`s/`AhxSegmented`s/checkboxes" (`ahx-inst-redesign-survey.md:87`,
independently reconfirmed by direct read of `AhxInstrumentPage.vue:151-293`). No component (`AhxSliderField`,
`AhxSegmented`, `AhxNumberField`, `AhxVibratoLane`, `AhxSweepLane`) changes its props or internals — this is a pure
template reflow (move existing elements into `<fieldset>` wrappers) plus moving each matching lane out of the old
"Sound in motion" card into its fieldset.

`AHX_FILTER_NEUTRAL`, `filterLowerHint`, the hard-cut warning paragraph (`ahx-hardcut-abrupt`,
`AhxInstrumentPage.vue:286-293`) move with their fields; no filter UI is added (binding constraint, task line 9).

---

## 2. Data flow (B1)

### 2.1 Before (today)

```
AhxPlayerClient.output (GainNode, per-instance)
   │  ahx-player.ts:100-101
   ▼
AhxPreview.ensureClient() connects it → host.output (SongBank.masterGain)
   │  ahx-preview.ts:191                         no other reference to client.output exists on
   ▼                                              the main thread outside AhxPreview/AhxPlayerClient
song bus → speakers
```

Nothing on the main thread outside `AhxPreview`/`AhxPlayerClient` ever sees `client.output` — it is created,
connected, and disposed entirely inside those two classes (MEASURED: `Grep "\.output"` across
`src/audio/tracker/ahx-preview.ts` and `ahx-player.ts` shows no external read of `client.output` besides the one
`.connect()` call at `ahx-preview.ts:191`).

### 2.2 After (B1)

```
AhxPlayerClient.output  (unchanged: still connects to host.output, D-A — the song routing is not touched)
   │
   ├─(existing)──► host.output (song bus)                       — unchanged, D-A "never touched"
   │
   └─(NEW)───────► AhxPreview.outputNodeListeners
                        │  fired with `client.output` in ensureClient() (created/replaced)
                        │  fired with `null` in disposeClient() (disposed/replaced/no song)
                        ▼
                   tracker-playback-store: preview.onOutputNode(setAhxPreviewOutputNode)
                        │  newAhxPreview() / disposeAhxPreview()  — §0 D-B step 6
                        ▼
                   ahxPreviewOutputNode  (module ShallowRef<AudioNode | null>, ahx-preview-output.ts)
                        │  imported directly by the page (mirrors ahxPListPlayhead)
                        ▼
                   AhxInstrumentPage.vue  →  :node="ahxPreviewOutputNode"  →  Oscilloscope / FrequencyAnalyzer
```

**Reactivity discipline.** `ahxPreviewOutputNode` holds a real `AudioNode` (a `GainNode`), never anything Vue
would wrap in a reactive Proxy — `shallowRef` is used for consistency with the house idiom (`ahxPListPlayhead`),
not because an `AudioNode` risks Proxy-wrapping (it does not: Vue's reactivity only wraps plain objects/arrays it
owns, and a host-provided `GainNode` instance is never deep-reactive regardless of `ref` vs `shallowRef` — this is
belt-and-braces consistency, not a correctness requirement the way it is for `ahxPListPlayhead`'s plain data
object).

**Never creates the worklet.** Binding `:node="ahxPreviewOutputNode"` in the template, or importing the module,
performs no side effect — the ref starts `null` and stays `null` until `ensureClient()` runs, which only happens
from `AhxPreview.noteOn`/`preload` (unchanged call sites: `previewAhxNoteOn`, `prepareAhxPreview`,
`tracker-playback-store.ts:488-512`). This is the same "subscribing creates nothing" property `onPListRow` has,
proven for that path by `src/tests/ahx-plist-row-client.test.ts:122-130`; B1 adds the equivalent test for the new
path (§7).

**Survives client replacement/disposal.** `ensureClient()`'s "new client → notify with `client.output`" and
`disposeClient()`'s "old client gone → notify with `null`" fire in that order across a context change
(`ahx-preview.ts:169-171` `if (this.client && this.client.audioContext !== this.host.audioContext) this.disposeClient();`
then a fresh `ensureClient()` call) exactly as they already do for `onPListRow` (proven today by
`src/tests/ahx-plist-row-client.test.ts:150-174`, "keeps its listeners through a replaced worklet"). The
`AhxPlayerClient.dispose()` method also calls `this.output.disconnect()` (`ahx-player.ts:368`), severing the old
GainNode's connection into the analyser the moment it is torn down — so a disposed client's node cannot keep
feeding a stale analyser even if the page were slow to react to the `null` notification (it is not: `watch(node, ...)`
in both visualizer components runs synchronously on the ref change, `OscilloscopeComponent.vue:214-219`).

---

## 3. Mechanism — exact files and functions touched per batch

### B1 (TS-only plumbing; no `.vue` files)

| File | Change |
|---|---|
| `src/audio/tracker/ahx-preview-output.ts` (**new**) | `ahxPreviewOutputNode: ShallowRef<AudioNode\|null>`, `setAhxPreviewOutputNode(node)` — mirrors `ahx-plist-playhead.ts:1-24` exactly. |
| `src/audio/tracker/ahx-preview.ts` | Add `outputNodeListeners` set, `onOutputNode(listener)`; fire in `ensureClient()` (`:202` area) and `disposeClient()` (`:214-215` area); clear in `dispose()` (`:148-153`). |
| `src/stores/tracker-playback-store.ts` | `newAhxPreview()` (`:533-542`): add `preview.onOutputNode(setAhxPreviewOutputNode);`. `disposeAhxPreview()` (`:544-549`): add `setAhxPreviewOutputNode(null);`. Import both from the new module. **No change to the store's returned object** (D-B step 8). |

`src/audio/tracker/ahx-player.ts` is **not modified** — `AhxPlayerClient.output` already exists and is already
public; only its *consumer* (`AhxPreview`) gains a new subscription mechanism.

### B2 (`AhxInstrumentPage.vue` template + script; imports two existing components)

- Import `ahxPreviewOutputNode` from `src/audio/tracker/ahx-preview-output.ts` and `OscilloscopeComponent`,
  `FrequencyAnalyzerComponent` from `src/components/`.
- New markup inside `.ahx-right-top`, gated `v-if="audible"` / `v-else` (mirrors the existing audition-bar
  precedent at `:136-144`, same wording style):
  ```html
  <div v-if="audible" class="ahx-analyzer" data-testid="ahx-analyzer-row">
    <OscilloscopeComponent :node="ahxPreviewOutputNode" data-testid="ahx-analyzer-oscilloscope" />
    <FrequencyAnalyzerComponent :node="ahxPreviewOutputNode" data-testid="ahx-analyzer-frequency" />
  </div>
  <span v-else class="ahx-dim" data-testid="ahx-analyzer-off">Unavailable: there is no source file to play this instrument from.</span>
  ```
  (`data-testid` on each component tag falls through to its single root, D-C evidence — no component file edited.)
- Scoped CSS: `.ahx-analyzer { display: flex; flex-direction: column; gap: 6px; width: 280px; }` — and because
  `FrequencyAnalyzerComponent` inherits 100%-height with no internal fallback (plan-review finding 1), the two
  child slots MUST get explicit set heights, e.g. `.ahx-analyzer > * { height: 70px; }` plus a
  `:deep(canvas) { height: 70px }` cap for the oscilloscope's own 120px (see §1's placement recommendation).
  Additive only, no existing rule removed except the grid-template-columns swap (D-D).
- **No new prop, no new store action.** `audible` (`:899`) is the existing computed, unchanged.

### B3 (component extraction + layout)

| File | Change |
|---|---|
| `src/components/ahx/AhxAuditionBar.vue` (**new**) | Owns the `<section class="ahx-card ahx-audition-bar" data-testid="ahx-audition">` root (drop `ahx-card--wide` — D-D reflow) and everything inside it today (`AhxInstrumentPage.vue:61-146`). Props: `audible: boolean`, `heldKeys: ReadonlySet<number>`, `latch: boolean`, `restrike: boolean`, `octave: number`, `stripStart: number`, `midiStatus: MidiInputStatus`. Emits: `pointer-down(midi)`, `pointer-up(midi)`, `set-octave(value)`, `toggle-midi()`, `update:latch(v)`, `update:restrike(v)`. Computes its own `midiChip` text/title internally from the `midiStatus` prop (moves `AhxInstrumentPage.vue:1104-1126`, ~23 script lines, into the component). Renders `AhxPianoStrip` internally (page no longer imports it directly). **Every existing testid inside the bar is unchanged** (§4 table). |
| `src/composables/useAhxPListEditing.ts` (**new**) | Takes `{ instrument, slotNumber, songFormat, sourceVersion, stepSize, octave, trackerStore, selectedRow, selectRow, releaseKeyboard }` (the last two are the page's existing `ref`/function; `trackerStore` passed directly — D-decision below). Owns and returns: `plistEdit` (reactive `{mode,column,nibble}`), `plistCanvasRef`, `canEditPList`, `plistCursor`, `EDIT_TOGGLE_TITLE`, `EDIT_UNAVAILABLE_TITLE`, `setPListEditMode`, `onPListCursor`, `onPListSelect`, `onPListEdit`, `onPListUndo`, `onPListRedo`, `plistMenuReasons`, `addRow`, `removeRow`. Internalizes `plistGesture` (`createPListGesture()`), `plistHost` (`PListEditHost`, built from `trackerStore`), `runPListEdit`, `runTableRowOp`, `plistContext` — this is exactly `AhxInstrumentPage.vue:964-1075` (the survey's "~530 lines of script that is not page-layout code," of which this slice is ~110 lines) moved verbatim, with `instrument`/`slotNumber` becoming passed-in `ComputedRef`s instead of page-local closures over `slot`/`route`. The three mode-closing `watch()`s (`:1065-1074`, slot change / `canEditPList` false / entries empty) move with it. |
| `AhxInstrumentPage.vue` | Replaces the audition-bar block with `<AhxAuditionBar ... @pointer-down="play.pointerDown" ... />`; calls `useAhxPListEditing({...})` instead of the inline state; adds `plistTableVisible` ref (default `false`) + toggle button; changes `focusField()` to open the table first (D-E point 1); wraps the DOM table's container in `v-show="plistTableVisible"` (was unconditional inside `v-if="instrument.plist.entries.length"`, now both conditions apply — `v-if` for "no rows at all" stays, `v-show` layers on top for the toggle); deletes the `<AhxPListStrip>` block and its now-unused import; applies the D-D grid CSS. |
| `src/components/ahx/AhxPListStrip.vue` | **Deleted.** |
| `src/tests/ahx-instrument-page-b2.test.ts` | Delete the "E6: the PList strip" `describe` block (`:206-256`). |
| `src/tests/ahx-instrument-page-plist-canvas.test.ts` | Adapt `:66-75`, `:83`, `:88-97` per D-E evidence above. |
| `src/tests/ahx-instrument-page-plist-playhead.test.ts` | Adapt `:186-195` per D-E evidence above. |

**Composable design choice — pass `trackerStore` directly, not six narrowed callbacks:**

| Option | Verdict |
|---|---|
| `useAhxPListEditing` takes `trackerStore: ReturnType<typeof useTrackerStore>` directly | **Chosen.** The page already calls `trackerStore.isAhxEditable/pushHistory/undoStack/ahxInstrumentRefusal/updateAhxInstrument/undo/redo` directly (`:970-988,1041-1047`); this composable is not meant for reuse outside this page (the task names it for *this* extraction only), and end-to-end coverage already exists at the `mount()` level with a real Pinia store (`ahx-instrument-page-plist-edit.test.ts`). A narrower interface would only pay off for a composable-only unit test nobody has asked for. |
| Narrow callback interface (`canUndo`, `pushHistory`, `refuse`, `update`, `undo`, `redo` as 6 separate function props) | Rejected: adds indirection with no new test coverage to justify it; `PListEditHost` (`plist-edit.ts`) already *is* that narrow interface one layer down — building it would just move where the 6-callback object is constructed, not remove it. |

---

## 4. Interaction & UI rules

### 4.1 Testid preservation table

| Group | Testids | Disposition |
|---|---|---|
| Page/banner/notices | `ahx-instrument-display`, `ahx-instrument-name`, `ahx-editable-badge`, `ahx-source-missing`, `ahx-notice`, `ahx-instrument-missing` | Unchanged, untouched markup. |
| Audition bar | `ahx-audition`, `ahx-audition-{midi}` (×3), `ahx-octave-down`, `ahx-octave`, `ahx-octave-up`, `ahx-midi-chip`, `ahx-audition-latch`, `ahx-audition-restrike`, `ahx-audition-off` | **Moved** into `AhxAuditionBar.vue`, same testids, same DOM shape (minus `.ahx-card--wide` class). |
| Instrument fields (14) | `ahx-field-volume`, `ahx-seg-waveLength`, `ahx-field-waveLength`, `ahx-field-vibratoDelay/Speed/Depth`, `ahx-field-squareLowerLimit/UpperLimit/Speed`, `ahx-field-filterLowerLimit/UpperLimit/Speed`, `ahx-field-hardCutRelease`, `ahx-field-hardCutReleaseFrames`, `ahx-hardcut-abrupt` | **Regrouped** into 4 `<fieldset>`s (§1.2), testids unchanged, same components. |
| Envelope | `ahx-envelope-editor`, `ahx-envelope`, `ahx-envelope-ceiling`, `ahx-envelope-ideal`, `ahx-envelope-line`, `ahx-envelope-hardcut`, `ahx-env-node-{a,d,s,r}`, `ahx-env-marker-next`, `ahx-env-marker-lead`, `ahx-envelope-table`, `ahx-env-{field}` (×7), `ahx-envelope-never-rises`, `ahx-envelope-warning-{id}` | **Both kept** (D-F), repositioned into the right column, otherwise unchanged. |
| Waveform | `ahx-seg-startWaveform`, `ahx-start-waveform`, `ahx-start-filter`, `ahx-wave-character`, `ahx-waveforms` | Repositioned into the right column, unchanged. |
| Sound in motion | *(card removed as a distinct section — lanes move into their fieldsets, §1.2)* | Lanes DO carry testids (plan-review finding 2, corrected): `ahx-vibrato-lane/-trace/-caption` (`AhxVibratoLane.vue:2,23,28`) and nine `${kind}`-scoped `ahx-sweep-*` testids (`AhxSweepLane.vue:5-74`, incl. `ahx-sweep-band-filter` asserted by `ahx-instrument-page-b2.test.ts:202`). They survive the move automatically because the lane components are moved unmodified — preserve them. |
| PList header/controls | `ahx-plist-summary`, `ahx-plist-speed`, `ahx-plist-add`, `ahx-plist-edit-toggle`, `ahx-plist-edit-unavailable`, `ahx-edit-notice` | Unchanged. |
| PList canvas | `ahx-plist-canvas` (+ its `data-*` attrs), `ahx-plist-canvas-legend*`, `ahx-plist-canvas-caption*`, `ahx-plist-edit-hint`, `ahx-plist-canvas-menu*` | Unchanged (component untouched by this plan). |
| PList table | `ahx-plist`, `ahx-plist-row-{n}`, `ahx-plist-{n}-note/waveform/fixed/fx{0,1}/param{0,1}`, `ahx-plist-insert-{n}`, `ahx-plist-remove-{n}` | Unchanged; now inside `v-show="plistTableVisible"` (D-E) — still present in the DOM, still queryable, at all times. |
| PList chip strip | `ahx-plist-strip`, `ahx-plist-strip-caption`, `ahx-strip-chip-{n}`, `ahx-strip-fx-{n}-{i}` | **Retired and deleted** (D-E). |
| New (B2) | `ahx-analyzer-row`, `ahx-analyzer-oscilloscope`, `ahx-analyzer-frequency`, `ahx-analyzer-off` | New. |
| New (B3) | `ahx-plist-table-toggle` | New. |

### 4.2 Theme rules

The AHX card language (MEASURED, `AhxInstrumentPage.vue` `<style scoped>`): native `<button>`/`<select>`/`<input>`
elements only in AHX-native files (no `q-*`); `background: var(--app-background, #0b111a)` for the page
(`:1176`); card background `rgba(255, 255, 255, 0.03)` (`:1229`); card border `1px solid rgba(255,255,255,0.08)`
(`:1227`); border-radius `6px` (`:1228`); accent family `--tracker-accent-primary #f0b25e`,
`--tracker-accent-secondary #5ec2e8` / `#3b82a0`, `--tracker-active-bg #14283d` (used throughout). B3's new
`<fieldset>` wrappers and `AhxAuditionBar.vue`'s root reuse these exact tokens (no new palette). B2's analyzer
components are restyled only via `:deep()` height/border-radius overrides (D-C) — their own accent
(`--tracker-accent-complement`, `OscilloscopeComponent.vue:33`) is already the same theme family
(`theme-palette.ts`, cited by the survey §4, MEASURED not re-derived here since it is unchanged by this plan).

### 4.3 E-style assertion table (every new/changed visible statement, checked against code)

| Visible statement | True because | Asserted by |
|---|---|---|
| The analyzer row shows only the previewed instrument, not the whole song | `AhxPlayerClient.output` is a per-preview GainNode, connected to (not from) the song bus (D-A, `ahx-player.ts:100-101`, `ahx-preview.ts:191`) | B1 unit test: a second, unrelated `AudioNode` stand-in for the song bus is never passed as `:node` |
| The analyzer row is absent (not just blank) when there is no source file to play from | `v-if="audible"` gates the whole row, same flag the audition bar already gates on (`:899`, `:136`) | B2 test: `audible=false` → `ahx-analyzer-row` absent, `ahx-analyzer-off` present |
| Nothing is drawn until a note is struck (or the song's own prewarm ran) | `ahxPreviewOutputNode` starts `null`; the components' own `watch(node,...)` does not attach until non-null (D-A/D-B evidence) | B1 unit test: importing/binding the ref creates no worklet; B2 test: `:node="null"` renders the canvases with no draw loop started (no `requestAnimationFrame` call asserted) |
| "Show table" reveals every existing row exactly as it always looked | `v-show`, not `v-if` — same DOM, same testids, same values, just `display:none` toggled (D-E) | B3 test: table rows' text content identical before/after toggling; existing `ahx-plist-{n}-*` assertions pass regardless of toggle state |
| Double-clicking a canvas cell opens the table and focuses the right field, even if the table was hidden | `focusField()` sets `plistTableVisible.value = true` before `nextTick()` + focus (D-E point 1) | B3 test: start with table hidden, double-click a PList cell, assert `plistTableVisible === true` and the target field has focus |
| The retired chip strip's info (row count, speed) is still shown | `ahx-plist-summary` was never part of the strip (D-E evidence, `AhxInstrumentPage.vue:459-462`) | Existing test coverage of `ahx-plist-summary` (unchanged file) stays green |
| The 4 fieldsets and their lanes are the same controls as before, just regrouped | No `AhxSliderField`/`AhxSegmented`/lane component prop changes (§1.2 table) | Existing `ahx-instrument-page-ux.test.ts` "E3" describe block (`:61-114`) passes unchanged |

---

## 5. Batches and sequencing

Order: **B1 → B2 → B3**, each gated before the next starts. No batch touches `rust-wasm/`, `public/wasm/`,
`public/worklets/` (constraint) or `AhxPositionPanel.vue`/`TrackerPage.vue` (constraint).

| Batch | Deliverable | Depends on | Gate (beyond the common gates below) |
|---|---|---|---|
| **B1** | `ahx-preview-output.ts`, `AhxPreview.onOutputNode`, store wiring (§3) | — | New unit tests (§6) green; every existing `ahx-plist-row-client.test.ts` / `ahx-plist-row-core.test.ts` / `ahx-preview*` / `ahx-player*` suite green and unmodified in behavior (only new methods added, nothing removed); `tsc --noEmit` clean on the 3 touched `.ts` files |
| **B2** | Analyzer row on the page, wired to B1's ref, gated on `audible` | B1 merged/committed on the branch | `vue-tsc --noEmit` clean; new B2 tests (§6) green; existing `ahx-instrument-page*.test.ts` suites green **unmodified** (B2 only adds markup, does not touch the strip/table/fieldsets) |
| **B3** | `AhxAuditionBar.vue`, `useAhxPListEditing.ts`, two-zone grid, 4 fieldsets, table-behind-toggle, strip deleted | B2 | `vue-tsc --noEmit` clean; all testids from §4.1 present with the stated disposition; the 3 test-file adaptations (§0 D-E) applied and green; full regression sweep (below) green |

**Regression sweep (run once, at the end of B3, and after each batch for the files that batch touches):**

`src/tests/ahx-instrument-page.test.ts`, `ahx-instrument-page-ux.test.ts`, `ahx-instrument-page-play.test.ts`,
`ahx-instrument-page-b2.test.ts` (minus the deleted E6 block), `ahx-instrument-page-plist-canvas.test.ts`,
`ahx-instrument-page-plist-playhead.test.ts`, `ahx-instrument-page-plist-edit.test.ts`,
`ahx-plist-row-client.test.ts`, `ahx-plist-row-core.test.ts`, `ahx-plist-playhead-driver.test.ts`,
`ahx-instrument-edit.test.ts`, `ahx-instrument-display.test.ts`, `ahx-instrument-visuals.test.ts`,
`ahx-instrument-sync.test.ts`, `ahx-instrument-codec.test.ts` — every one of these MEASURED to exist under
`src/tests/` at plan time (Glob results, §"Required reading"); the coder confirms the list is still complete
before reporting done (new files may have landed on `main` between plan time and coding time).

**Gates (every batch, per `AGENTS.md:14-19` and the task's own constraints), run per repo rule — never as a
blocking foreground exec for anything long; wrap in `timeout` and/or background into `.ai/checks-<n>.txt`, poll,
never end a turn while one runs:**

1. `npm run lint` (`eslint --ext .js,.ts,.vue ./`, `package.json:13`) — clean.
2. `npx tsc --noEmit` — clean on touched `.ts` files (does not see `.vue`, per `AGENTS.md:17`).
3. `npx vue-tsc --noEmit` — required for every batch touching `.vue` files (B2, B3); record the pre-existing
   baseline error count/message set before the batch (this repo has a known non-zero baseline per
   `.ai/plan-plist-canvas.md:598-599`, "11 `#q-app`" at that plan's time — re-measure fresh, do not assume it is
   still 11) and confirm it is unchanged after.
4. `npm run test:run -- <files>` per-batch (never the bare `npm run test`, which is watch mode and never exits,
   per `CLAUDE.md`/`AGENTS.md`), then the full suite once at the end of B3, alone, backgrounded with `timeout`.
5. `gitleaks detect --no-git --source .` — clean (per task §3).
6. `git diff --stat` on `rust-wasm/`, `public/wasm/`, `public/worklets/` — must show **no** change (this pass is
   TS/Vue-only; any diff there is a mistake, stop and report).
7. Record every gate's output in `.ai/checks-<n>.txt` before reporting a batch done (`AGENTS.md:19`).

**`.ai` state.** Fresh worktree per the task's constraints (unique branch `agent/ahx-inst-redesign-<short-suffix>`,
worktree-owner marker at start, cleared at end/abort — repo convention, not a file this plan writes). No entry is
needed in `PLAN-module-format-support.md` §8 (memory `tracker-playback-changelog-d-numbers`): that log is for
module-**format** (parser/replay) fixes, and this pass changes neither a parser nor replay semantics — it is a UI
layout and analyzer-plumbing pass. Do not add a D-number for it.

---

## 6. Risks

1. **`v-show` table + focus hand-off (D-E).** The single highest-value correctness fix this plan specifies
   (§0 D-E point 1) is easy to skip by accident (a naive "put a toggle around the existing `v-if` block" reading
   would keep `v-if` and silently break double-click hand-off when the table starts hidden). Mitigation: the E-style
   assertion table (§4.3) names an explicit test for it; treat it as a required B3 deliverable, not a nice-to-have.
2. **Analyzer geometry may not fit legibly beside a multi-line audition bar** (§0 smaller decision 2). The audition
   bar's `flex-wrap: wrap` (`AhxInstrumentPage.vue:1439-1443`) means its height varies with viewport width; a
   fixed-height analyzer column beside it can look mismatched at some widths. Mitigation: the fallback layouts
   (A2/A3) are pre-specified so the coder does not have to invent one mid-batch; a screenshot check is cheap to add
   to whatever manual/E2E verification the coder already runs for this app (no new E2E harness is required by this
   plan — UNVERIFIED whether the app has an AHX-page E2E script at all; §8).
3. **`AhxPlayerClient.output`/`AhxTransportHost.output` name collision** (D-A) is a standing trap for anyone
   reading the diff quickly — a reviewer skimming `preview.output.connect(host.output)`-shaped code could plausibly
   "fix" the new tap to use `host.output` by mistake, silently changing the feature from "previewed instrument
   only" to "whole song." Mitigation: this plan's D-A section and the code comments the coder should add at the new
   `onOutputNode` call sites should say explicitly which `output` is meant.
4. **Six lettered decisions above touch a page with 7 existing dedicated test files** (§5 regression sweep) —
   the largest test surface of any AHX pass so far. Mitigation: the three concrete test-file edits are pre-specified
   with line numbers (D-E), not left for the coder to discover by running the suite and reacting to red.
5. **Deleting `AhxPListStrip.vue`** is the only outright file deletion in this plan. If a reference exists that the
   `Grep` at plan time missed (e.g. a dynamic import, or a file added to `main` after plan time but before coding),
   deleting it would be a build break the `vue-tsc`/`tsc` gates would catch immediately — low risk, but the coder
   should re-run the same `Grep "AhxPListStrip"` at the start of B3 before deleting, since the codebase moves.
6. **`AhxAuditionBar.vue`'s new internal `midiChip` computed** must reproduce the existing 4-branch logic
   (`unsupported`/`requesting`/`denied`/`ready`, `AhxInstrumentPage.vue:1106-1125`) exactly, including the
   device-count pluralization (`:1117-1122`) — a plausible small-diff error site. No test currently pins this exact
   text (checked: `Grep "MIDI: "` across `src/tests/` for the exact strings found none), so this plan recommends
   B3 add one, rather than relying on the existing suite to catch a wording regression.
7. **(Plan-review finding 1.) The frequency analyzer silently renders nothing if B2 forgets explicit heights.**
   `FrequencyAnalyzerComponent` has no internal fixed height (`:196,201,210` are all `height: 100%`; its `draw()`
   bails at 0×0, `:98-100`), so an unsized flex wrapper collapses its canvas to 0 while the oscilloscope still
   draws at its own 120px — a blank spectrum with no error. Mitigation: §3 B2 now REQUIRES
   `.ahx-analyzer > * { height: 70px; }` (and/or `:deep(canvas) { height: 70px }`); the B2 wiring test should
   assert the rendered canvas has non-zero client height in addition to prop binding.

---

## 7. Tests

### 7.1 New, B1 — `src/tests/ahx-preview-output.test.ts` (mirrors `ahx-plist-row-client.test.ts` structure exactly)

- `AhxPreview.onOutputNode`: "creates nothing by being subscribed to" (no `createAhxPlayer` call after
  `preview.onOutputNode(() => undefined)` with no `preload`/`noteOn`), mirroring
  `ahx-plist-row-client.test.ts:122-130`.
- "fires the client's `output` once it exists, and not after unsubscribe" — mirrors `:132-148`.
- "keeps its listeners through a replaced worklet: fires `null` for the old client, then the new client's `output`"
  — mirrors `:150-174` (a context change forces `disposeClient()` then a fresh `ensureClient()`).
- "dispose fires `null`, then forgets the listeners" — mirrors `:176-192`.
- "dispose with no worklet ever made fires nothing" — mirrors `:194-201`.
- Store wiring: "a subscribed store makes no worklet until something asks for one" (mirrors `:267-271`); "the
  preview's client `output` lands in `ahxPreviewOutputNode`" after `store.prepareAhxPreview()` (mirrors the
  `storeWithPreview()` helper, `:257-265`); "a different song clears the node" (mirrors `:311-323`); "dispose
  clears the node" (mirrors `:341-350`).
- `AhxPlayerClient.onPListRow`-equivalent low-level test is **not needed**: `client.output` is already a public
  readonly field (`ahx-player.ts:70`), not an event — there is nothing to unit-test at that layer beyond "the
  field exists and is a `GainNode`," which the existing `createAhxPlayer`/constructor tests already cover
  incidentally.

### 7.2 New, B2 — `src/tests/ahx-instrument-page-analyzer.test.ts`

- `audible=true` renders `ahx-analyzer-row` with both `ahx-analyzer-oscilloscope` and `ahx-analyzer-frequency`
  (attribute fallthrough, D-C) bound `:node="ahxPreviewOutputNode"` (assert via `wrapper.findComponent(...).props('node')`).
- `audible=false` renders `ahx-analyzer-off` instead, no analyzer components mounted.
- Setting `ahxPreviewOutputNode.value` to a stand-in `AudioNode`-shaped object and back to `null` updates the
  bound prop reactively (proves the direct-import wiring works end to end through the page, not just the store
  unit tests in §7.1).
- Smoke only: does not assert canvas pixels or real `AnalyserNode` behavior (out of scope; `OscilloscopeComponent`/
  `FrequencyAnalyzerComponent` are unmodified and already covered, if at all, by whatever tests IndexPage has —
  UNVERIFIED whether such tests exist, §8).

### 7.3 New, B3

- `src/tests/use-ahx-plist-editing.test.ts` (composable-level, if practical without a full page mount) **or**
  folded into the existing page-level files if the composable's internals are hard to isolate cleanly from
  `trackerStore` — coder's call, but the *behavior* coverage (mode toggling, row ops, undo/redo, menu reasons) must
  not regress from what `ahx-instrument-page-plist-edit.test.ts` already proves today; that file's `describe`
  blocks (`:106,177,226,261,362,406,437,453`) are the acceptance bar and must stay green with **zero** behavior
  change (only the *location* of the code moves, per the composable extraction in §3).
- `src/tests/ahx-instrument-page-layout.test.ts` (new, small): the 4 fieldsets contain exactly the testids listed
  in §1.2's table (no field lost or duplicated in the reflow); `AhxAuditionBar` receives the props listed in §3 and
  its emits reach the same handlers the inline code used to call directly (`play.pointerDown` etc.).
- Table toggle: `ahx-plist-table-toggle` starts `aria-expanded="false"`; clicking it sets `true` and reveals the
  table (assert via the wrapping element's inline `style.display` or a `data-visible` attribute the coder adds for
  testability, since `v-show`'s CSS effect is otherwise awkward to assert in `happy-dom` without a real layout
  engine); double-click hand-off (§4.3) opens it from either state.
- `AhxAuditionBar.vue` unit test for the `midiChip` computed's 4 branches + device pluralization (risk 6) — new
  coverage, not previously pinned anywhere.
- The three adapted files from D-E (`ahx-instrument-page-plist-canvas.test.ts`,
  `ahx-instrument-page-plist-playhead.test.ts`, `ahx-instrument-page-b2.test.ts`) — exact edits specified in §0 D-E.

---

## 8. What could not be verified from code (UNVERIFIED)

- **Whether any E2E/browser script exercises the AHX instrument page today** (the required-reading list names
  `firefox-e2e-recipe` and the AHX transport/B2/editing plans' own E2E series, but those cover the *tracker* page's
  playhead/edit flows, not this page's analyzer/layout specifically). If one exists, B2/B3 should extend it with a
  screenshot check for the analyzer geometry (risk 2); if none exists, this plan does not require creating one —
  the task's own test requirements (§3) list "analyzer wiring smoke," which §7.2's unit test satisfies without a
  browser.
- **Real canvas/analyser behavior** (does the oscilloscope actually draw a waveform for a struck AHX note, does the
  spectrum bar show energy) is not verified by this plan's own reading — it is inherited, unmodified, from
  `OscilloscopeComponent`/`FrequencyAnalyzerComponent`, whose behavior with a real `AudioContext` was not run here
  (no browser/audio execution during planning). B2's test (§7.2) is a wiring smoke test, not an audio-correctness
  test.
- **Exact baseline `vue-tsc --noEmit` error count/message set at coding time** — not re-measured by this plan
  (static reading only); the coder must record it fresh in B0/B2's gate step rather than trusting the plist-canvas
  plan's stale "11 `#q-app`" figure (that plan's own numbers are already months old relative to this one).
- **Whether `getComputedStyle`/`style.display` assertions work reliably against `v-show` inside `happy-dom`** (the
  test environment `ahx-instrument-page*.test.ts` uses, INFERRED from `mount()` + no `@vitest-environment node`
  pragma in those files) — §7.3 notes a `data-visible` attribute as a fallback if direct style assertion proves
  awkward; the coder decides once actually running the test.
- **Whether `AhxAuditionBar.vue`'s prop-drilling of `midiStatus` (a `MidiInputStatus` object from
  `src/audio/midi-input.ts`) is itself reactive-safe** (a plain object from a non-Vue class, INFERRED not
  MEASURED against `midi-input.ts`'s source, which was not read in full during this planning pass) — low risk
  (the page already reads `play.midiStatus.value` today with no reported issue), but flagged since this plan did
  not verify `midi-input.ts` itself.

---

## 9. Summary of the three batches for a coder to start from

1. **B1**: `ahx-preview-output.ts` + `AhxPreview.onOutputNode` + store wiring. Pure TS, no `.vue` touched, no Rust,
   no worklet rebuild. Test file mirrors `ahx-plist-row-client.test.ts` line-for-line in structure.
2. **B2**: two new lines of import + one `v-if`/`v-else` block + CSS in `AhxInstrumentPage.vue`, reusing
   `OscilloscopeComponent`/`FrequencyAnalyzerComponent` unmodified. No other file touched.
3. **B3**: the actual redesign — `AhxAuditionBar.vue` extraction, `useAhxPListEditing.ts` extraction, two-column
   CSS grid, 4 `<fieldset>`s, `AhxPListStrip.vue` deletion, table-behind-`v-show`-toggle with the focus-hand-off
   fix. Touches the most files and the most existing tests; §0 D-E and §6 risk 1 are the two places most likely to
   go wrong if rushed.

Each batch's own gate (§5) must be green before the next starts; the full regression sweep (§5) runs once more at
the end of B3. Stop on the branch — do not push, do not merge (task constraint).

---

## Landed (2026-09-22)

Merged `agent/ahx-inst-redesign-1` (31065df1, 5 commits on a1c72639) into main as
`a5357596` (no-ff, "merge: AHX instrument page redesign T1"), pushed
`d094aebe..a5357596` to origin. Post-merge full gate on main green: complete vitest
suite 229 files / 3670 tests, eslint clean, `vue-tsc --noEmit` exit 0 with zero
errors (the 11-error `#q-app` baseline no longer reproduces — the path mapping in
tsconfig.json resolves in the current node_modules, so the run is strictly cleaner
than baseline; logs `.ai/checks-postmerge-test.txt`, `.ai/checks-postmerge-lint.txt`,
`.ai/checks-postmerge-vuetsc-raw.txt`). Deployed via `scripts/deploy.sh` to
avatar@192.168.50.161 (log `.ai/deploy-ahx-inst-red-20260922-140617.log`), script
checksum `cb7616eab4807fa11bffd174202370ab` plus independent md5 byte-match on
index.html, wasm/audio_processor_bg.wasm, all 4 worklet js files, and
demos/index.json — all identical local vs remote. Reviewer adversarial PASS on
31065df1 remains the branch evidence; minor checks-4-gate6-diffstat.txt closed.
Branch + worktree left in place; no force-push, no history rewrite.
