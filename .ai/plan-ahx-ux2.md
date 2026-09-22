# Plan: AHX instrument editor, UX pass 2 — layout + first-time-user intuitiveness

Branch `agent/ahx-ux2-t1`, base `main` @ `8e3017ff` (the redesign merge `a5357596` is in it). Written
2026-09-22 19:50 CEST, after a read-only survey and before any source edit.

**Task (verbatim, from the dispatch prompt):** *"Another pass on the AHX instrument editor, aimed at a BETTER
LAYOUT and — emphasized — a MORE INTUITIVE experience for a first-time user. Intuitiveness means: a new user
should grasp what each control does without docs. Prefer clear grouping/order, honest labels, visible feedback
(live preview/analyzer reacting to edits), and progressive disclosure over dense panels."*

**Hard constraints (verbatim, restated so the plan is checked against them):** rust-wasm engine untouched;
audio graph behavior unchanged (analyser taps read-only, never connected to destination); `TrackerPage.vue` and
`IndexPage.vue` untouched; nothing under `public/`; nothing under `packages/tracker-playback/src/formats`; store
changes only if strictly required. **This plan needs no store change, no audio change and no engine change:**
every item below is template/CSS in `src/pages/AhxInstrumentPage.vue` plus page tests.

**Labels.** **MEASURED** = read in the code at plan time with a `file:line` citation (or, for post-change
facts, exercised by a test that is named). **INFERRED** = follows from code/CSS semantics but not exercised
here. **UNVERIFIED** = could not be checked from static reading or jsdom (browser-only), listed in §5.

## 0. Survey corrections to the task's premises

1. The page is **1326 lines**, not ~1567 (MEASURED, `wc -l src/pages/AhxInstrumentPage.vue`).
2. There is **no `AhxPListTable` component**: the full PList table is inline in the page
   (`AhxInstrumentPage.vue:482-578`), behind the `plistTableVisible` toggle (`:447-457`, `:892`). Nothing to
   refactor there for this pass; noted so nobody looks for the file.
3. **Chip-strip info preservation is already a non-issue** (MEASURED, and already said by the redesign plan
   `.ai/plan-ahx-inst-redesign.md:264-274`): row count and speed live in the PList card's own header
   (`ahx-plist-summary`, `AhxInstrumentPage.vue:401-404`), which never belonged to the strip. Nothing to do.

## 1. What a first-time user trips over today (survey findings)

| # | Finding | Evidence | Label |
|---|---|---|---|
| F1 | **The audition bar no longer sticks.** Its `position: sticky; top: 0` (`AhxAuditionBar.vue:162-166`) is constrained by its parent, and since the two-zone reflow that parent is `.ahx-right-top` (`AhxInstrumentPage.vue:253`, CSS `:1274-1279`), a flex row exactly as tall as its content. A sticky box cannot leave its containing block, so it scrolls away with the row. Scrolling down to Filter or the PList loses both the keys *and* the analyzer — exactly the "visible feedback while editing" the task emphasises. | CSS semantics; `ahx-instrument-page-ux.test.ts:147-153` still calls it "a sticky single bar" (it pins only the class) | INFERRED (jsdom has no layout; browser check §5) |
| F2 | **The analyzer is two blank boxes until a note is played.** `ahxPreviewOutputNode` is `null` until the preview client exists (`ahx-preview-output.ts`, pinned `ahx-instrument-page-analyzer.test.ts:95`), and neither box is labelled — a new user sees two empty rectangles with no name and no instruction. | `AhxInstrumentPage.vue:267-270` | MEASURED |
| F3 | **Square / Filter sliders do nothing unless the PList turns the sweep on, and nothing at the top of the group says so.** The "Inactive…" reason and the "Turn on at row 0" button exist, but at the *bottom* of the lane (`AhxSweepLane.vue:67-80`), below three sliders the user has already tried. Same for vibrato at depth 0 (`AhxVibratoLane.vue:61,79`). | as cited | MEASURED |
| F4 | **The hard-cut controls sit in the Filter group with no word that they are not a filter setting** (redesign smaller decision 4, `.ai/plan-ahx-inst-redesign.md:325-331`). Worse, the "Hard cut release is off, so the note is muted abruptly…" warning (`AhxInstrumentPage.vue:232-239`) says the same thing as the envelope's own legend (`AhxEnvelopeEditor.vue:126-129`). | as cited | MEASURED |
| F5 | **Wave length and the wave-shape preview it redraws are in different places.** Wave length is at the top of the left column (`:74-92`); the shape preview (which draws `4 << waveLength` bars, pinned `ahx-instrument-page-b2.test.ts:58-66`) is in the *second* right-hand card, below the envelope (`:329-395`). A change to one is not seen next to it. | as cited | MEASURED |
| F6 | **The envelope is shown twice at full weight**: the draggable graph and an always-open A/D/S/R number table (`:287-318`) that edits the same seven fields. The graph already says "Double-click to type" but only in a hover title (`AhxEnvelopeEditor.vue:82`). | as cited | MEASURED |
| F7 | **"Filter position" in the Waveform card is the start *brightness*** (its help text says brightness, `ahx-plain-language.ts:76-77`), but its label reuses the word "Filter" the left-hand Filter group uses for the *sweep*; a new user reads them as one thing. | `AhxInstrumentPage.vue:358-374` | MEASURED |
| F8 | **"PList" is unexplained jargon** at the head of the page's largest section (`:399-405`); only row-level tooltips explain it (`ahx-plain-language.ts:84-85`). | as cited | MEASURED |
| F9 | **The two-zone grid has no narrow-screen fallback**: `grid-template-columns: minmax(300px, 380px) 1fr` (`:1049-1054`) overflows a phone-width viewport. | as cited | INFERRED |

## 2. Decisions

Each decision is timestamped when taken (2026-09-22, CEST).

### U1 (19:52). One sticky "sound band" above both zones: audition bar + labelled analyzer — fixes F1, F2

Move the `.ahx-right-top` row (audition bar + analyzer) **out of the right column** into its own full-width
band, `.ahx-sound-band`, placed directly under the notices and **outside** the `.ahx-body` grid (a direct
child of the page content, so its sticky containing block is the page, not a grid area or a content-sized flex
row). The band is `position: sticky; top: 0` with an opaque background. The analyzer stays **to the right of the
audition bar, at the top** — Morten's 12:53 wording "analyzer row top-right beside the audition bar" still holds;
it is now top-right of the *page* rather than of the right column.

Analyzer details (the open "analyzer row placement details" item): oscilloscope and spectrum **side by side**
(not stacked — a stacked 2 × 70 px column made the band 146 px tall, too much for a sticky strip), each with a
visible caption ("Wave", "Spectrum") and a shared empty-state line "Play a note to see it here." while
`ahxPreviewOutputNode` is `null`. The components and their `:node` binding are unchanged, so the analyser taps
stay exactly as they were (read-only; D-C of the redesign plan).

Narrow screens (≤ 760 px): the band stops being sticky (a wrapped bar + analyzer would cover a third of a phone
screen) and the two zones collapse to one column (F9).

| Option | Verdict |
|---|---|
| Full-width sticky band outside the grid (bar + analyzer side by side) | **Chosen.** Restores the E4 "sticky bar" intent the reflow broke, and keeps the analyzer in view while *any* control is dragged — the task's "visible feedback" point. |
| Make only `.ahx-right-top` sticky inside the right column | Rejected: its containing block is `.ahx-right`, a grid item; stickiness would depend on the right column being taller than the left, which it is not always, and it would still scroll away with the PList. |
| Leave as is | Rejected: the bar the tests call sticky silently isn't (F1). |
| Collapse the analyzer behind a toggle | Rejected (again, as in the redesign plan smaller decision 2 A3): an analyzer is for glancing at while playing. |

### U2 (19:54). Right column order: the tone first, then the envelope — fixes F5, F7

Swap the right column's two cards: **"Starting tone"** (today "Waveform") first, then "Volume envelope". The
tone preview now sits beside "Level & wave", so dragging Wave length redraws the picture next to it. Honest
labels in that card: heading "Waveform" → **"Starting tone"** (the card's own note already says it edits what
the *first* PList row picks), and "Filter position" → **"Starting brightness"** (its help text is about
brightness; the Filter group is the sweep). Test ids unchanged (`ahx-start-filter`, `ahx-start-waveform`,
`ahx-seg-startWaveform-*`), and no test pins either old label (MEASURED, `grep -rn "Filter position\|>Waveform" src/tests` → none).

### U3 (19:55). Each group says what it does and whether it is on — fixes F3

Under every left-hand `<legend>`, one dim plain-language line saying what the group does to the sound, and for
Vibrato / Square / Filter a status pill **On / Off** at the group's top-right, computed from the **same
functions the lanes already draw from**, so the pill and the lane can never disagree:

- Vibrato: Off when depth is 0 or the speed wraps to a still vibrato (`ahxVibratoStep(speed).still`,
  `ahx-instrument-visuals.ts:161`) — the lane caption's own "off"/"nothing wobbles" cases.
- Square / Filter: On iff `ahxSweepState(ahxSweepSetup(ins, kind, ctx), kind) === 'on'`
  (`ahx-instrument-visuals.ts:375,414`) — exactly the lane's `state` (`AhxSweepLane.vue:126-127`). The Off pill's
  title carries the reason ("nothing in the PList switches it on — see the button below").

The pill is a sibling of the `<legend>`, not inside it: `ahx-instrument-page-layout.test.ts:84` pins the legend
text exactly (`['Level & wave','Vibrato','Square','Filter']`), and that pin stays untouched.

### U4 (19:56). Hard cut gets its own labelled sub-group inside Filter; the duplicate warning goes — fixes F4

Morten's approved grouping (12:53, verbatim in `.ai/plan-ahx-inst-redesign.md:17`: *"14 sliders grouped into 4
fieldsets (Level & wave / Vibrato / Square / Filter)"*) is kept: the two hard-cut controls stay in the fourth
fieldset, so the layout test's 4-fieldset map (`ahx-instrument-page-layout.test.ts:56-68`) is unchanged. Inside
it they get a divider and a sub-heading **"Note ending (hard cut)"** with the line "Not a filter setting: how a
note is cut short when the next one arrives. The volume envelope draws it." — so the grouping is no longer
dishonest.

The page-level "abruptly" warning (`ahx-hardcut-abrupt`) duplicates the envelope's legend (F4); **it stays**,
because `ahx-instrument-page-b2.test.ts:142` pins its exact wording and the task forbids weakening pins. Moving
it (or the whole sub-group) into the envelope card is a **smaller decision for Morten** (§4.1).

### U5 (19:57). Envelope: a how-to line up top, typed values behind a toggle — the stage-table dedup (F6)

The redesign plan kept both "unless the dedup is trivially safe" (`.ai/plan-ahx-inst-redesign.md:282-303`).
The *hide* half of a dedup **is** trivially safe with the mechanism D-E already proved for the PList table:

- Visible caption above the graph: "Drag a dot to shape how the volume rises and falls over a note (arrow keys
  work too); double-click a dot to type its exact value."
- The stage table moves behind a toggle **"Type exact values" / "Hide exact values"**
  (`ahx-envelope-table-toggle`, `aria-expanded`), `v-show` not `v-if`, default hidden — the same idiom as
  `ahx-plist-table-toggle` (`AhxInstrumentPage.vue:447-457`).
- `focusField` (`:928-935`) already opens the PList table for a `ahx-plist-N-*` test id before focusing; it gains
  the same branch for `ahx-env-*`, so a node double-click opens the table from hidden and focuses the field
  (a `display:none` field cannot take focus — the redesign's top risk, D-E point 1).
- Every `ahx-env-*` test id stays in the DOM (`v-show`), so every existing assertion that types into them
  (`ahx-instrument-page-ux.test.ts:112-145`, `ahx-instrument-page.test.ts:98-160`) keeps working unchanged.

| Option | Verdict |
|---|---|
| Table behind a `v-show` toggle, double-click opens it (mirror D-E) | **Chosen.** One view by default, precise entry one click (or one double-click) away; no new widget. |
| Delete the table, add a typed-entry widget to the SVG | Rejected: new-widget project; pins type into `ahx-env-*`. |
| Keep both always open | Rejected: the redundancy the task's "progressive disclosure over dense panels" names. |

### U6 (19:58). The PList explains itself in one line — fixes F8

Under the PList heading, one dim line: "The instrument's own little score: while a note sounds, it steps down
these rows, and each row can change the pitch, switch the tone or add an effect." The heading text and
`ahx-plist-summary` are unchanged (pinned `ahx-instrument-page.test.ts:149`).

### Not doing (considered, 19:59)

- **Removing the "Exact value" start-waveform `<select>`**: it offers exactly the same five values as the
  "Starts with" radio group (`WAVEFORM_CHOICES` `:803-806` vs `START_WAVE_OPTIONS` `:792-800`), so it is a pure
  duplicate — but `ahx-instrument-page-b2.test.ts:84-89` ("the exact-value select still edits it") pins it as a
  working control. Flagged, §4.2.
- **Relabelling Latch / Re-strike**: their titles already explain them (`AhxAuditionBar.vue:65,78`); a label
  change is taste, not a fix.

## 3. Tests (real production paths: `importAhxToTrackerSong(karma.ahx)` + `loadSongFile` + the mounted page)

New file `src/tests/ahx-instrument-page-ux2.test.ts`, same harness as `ahx-instrument-page-layout.test.ts`
(real store, real importer, real `setCurrentAhxSource`; only the playback store's two preview calls are mocked,
as every page test already does):

1. U1: the band (`ahx-sound-band`) holds the audition bar and the analyzer, sits **outside** `.ahx-body` and
   **before** it in document order; the analyzer has the two captions; the empty-state line shows while the node
   is null and goes when a node arrives (fake node as in the analyzer test).
2. U2: in the right column the tone card precedes the envelope card; labels "Starting tone" and "Starting brightness".
3. U3: pills — karma instrument 1's states computed through the same helpers and matched; vibrato depth → 0
   through the real stepper/field turns the pill Off; "Turn on at row 0" (real `enableAhxSweep` path) turns the
   filter/square pill On (pick a karma slot with the sweep off — the b2 test uses slot 6).
4. U4: the "Note ending" sub-group contains exactly the two hard-cut test ids and sits in the Filter fieldset.
5. U5: the envelope table starts hidden (`display:none`), the toggle reveals it, and a node double-click
   (`ahx-env-node-A` `dblclick`) opens it from hidden and focuses `ahx-env-aFrames`.
6. U6: the PList explainer line is present.

Existing pins: **no existing assertion is edited or removed.**

## 4. Smaller decisions for Morten

1. **Move the hard-cut pair (and its "abruptly" warning) into the Volume envelope card?** It is note-ending
   timing, the envelope already draws it and has a draggable lead marker for it, and its warning duplicates the
   envelope legend (F4). Not done: it contradicts your 12:53 "14 sliders in 4 fieldsets" and would edit the
   layout test's fieldset map and the b2 warning pin. This pass only labels it honestly (U4).
2. **Drop the "Exact value" start-waveform `<select>`?** Pure duplicate of "Starts with" (same five choices).
   Not done: pinned by `ahx-instrument-page-b2.test.ts:84-89`.
3. **Envelope typed values default hidden (U5).** Chosen for consistency with the PList table; if you want them
   open by default it is one `ref(false)` → `ref(true)`.
4. **Sticky band on narrow screens is off (U1).** Under 760 px the band scrolls with the page, on the judgement
   that a wrapped bar + analyzer would cover too much of a phone screen.
5. **Out of scope by constraint, noted only:** nothing here needed the store, the audio graph, the engine,
   `TrackerPage.vue`, `IndexPage.vue`, `public/` or `packages/tracker-playback/src/formats`.

## 5. Risks / UNVERIFIED

- U1 stickiness and the band's height are layout facts jsdom cannot measure. UNVERIFIED unless a browser check is
  run; the unit tests pin the DOM structure (band outside the grid, sticky class present) that the CSS relies on.
- The analyzer at a smaller height (56 px) inherits the redesign's sizing fix (`.ahx-analyzer > *` height +
  `:deep(canvas)`), kept as is so the spectrum does not collapse to 0 (redesign plan D-C sizing note).

## 7. Implementation record (2026-09-22, ~20:10 CEST)

- U1–U6 implemented as planned, all in `src/pages/AhxInstrumentPage.vue` (+314/−100). No component, store,
  audio, engine or `public/` file touched. The analyzer components and their `:node` binding are unchanged
  (moved, not rewired).
- One addition beyond the plan text: `.ahx-right` got `align-content: start` (as `.ahx-left` already had), so
  when the left column is taller the right-hand cards stay packed at the top instead of stretching.
- New suite `src/tests/ahx-instrument-page-ux2.test.ts`, 13 tests. The pill-vs-lane test runs over **every**
  karma instrument and asserts that the song has filter pills in both states, so the agreement is not vacuous.
  MEASURED: all 97 pre-existing page tests pass with no assertion edited.
- Gates: `.ai/checks-1.ahxux2.txt`. Tests, lint and vue-tsc are green. **gitleaks could not be run** (the
  session's permission policy refused it), so per the task's rule **no commit was made**.
- Still UNVERIFIED (§5): real-browser stickiness/height of the band. The E2E harness from earlier passes is
  outside this worktree, which this task forbids touching.

## 6. Gates

`npm run test:run -- src/tests/ahx-instrument-page` (every page suite, touched or not), full `npm run lint`,
`npx vue-tsc --noEmit`, into `.ai/checks-<n>.ahxux2.txt` with each command and exit code; then
`gitleaks detect --no-git --source .` (any finding aborts, no commit).

## Landed (2026-09-22)

Merged `agent/ahx-ux2-t1` tip `4df8713b` into main as `31bab50b` (no-ff,
"merge: AHX instrument editor UX pass 2 (agent/ahx-ux2-t1)"), pushed
`8e3017ff..f75201a0` to origin. Post-merge suite found exactly 2 failures, both
stale corpus-size pins pre-existing on `8e3017ff` (proved in a detached
worktree before landing): the corpus grew 62→84 files (77 `.ahx` + 7 `.hvl`)
at `c027f2a2` and the pins were never re-measured. Pin repair commit
`f75201a0` ("test: re-measure corpus size pins (69→84 files) — stale since
corpus-add15 c027f2a2"): re-measured 2026-09-22 — corpus 84 files, 1290
instruments (was pinned 69/987); behavior assertions untouched. Gates after
repair, all on main: full vitest 3743/3743 (233 files) green, eslint 0,
`vue-tsc --noEmit` 0. Deployed via `scripts/deploy.sh` (checksum of script
`439f0c032a0119f4573ba08d4cd8e3f8`) to avatar@192.168.50.161, log
`.ai/deploy-ahxux2-20260922.log`; script-verified index.html checksum
`d6681d714152863cc4120587d46117dd` plus independent md5 byte-match local vs
remote — index.html (`d6681d714152863cc4120587d46117dd`),
wasm/audio_processor_bg.wasm (`52dbe56b61aab40a198558cd437e75b5`),
worklets/synth-worklet.js (`b9f0f86d4878f268daa1ef148ce631ca`),
worklets/ahx-worklet.js (`0b1e28a2d692f80a2f9fc3a46d77f1e6`),
worklets/effects-worklet.js (`ea0b2d2be2fd5dd6ec9a6a6ccb5c5e71`),
worklets/recording-worklet.js (`9c96bf69c35c1b90db4314dd0923147f`),
demos/index.json (`33d044fd161e572a4308720634b7fbc3`) — all 7 identical.
Note: `plan-ahx-ux2.md` existed only untracked in the ahx-ux2 worktree; it is
brought into main's tracked `.ai/` by this landing record (this file). Branch
+ worktree left in place; no force-push, no history rewrite.
