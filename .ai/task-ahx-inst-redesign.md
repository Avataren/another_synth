# Task: AHX instrument-page redesign + realtime analyzer feed

Approved by Morten 2026-09-22 12:53 (decisions verbatim below). Repo starts from main HEAD a1c72639 or later.

## Morten's decisions (verbatim)

- 12:50: "What we do need though, is realtime waveform and spectrum analyzer in the ahx instrument editor, similar to the native patch editor, and a redesign of the whole page, the layout is messy atm." / "The instrument editor page for ahx that is."
- 12:53 approving the proposed design: analyzer feed scoped to the PREVIEWED INSTRUMENT ONLY (tap the AHX preview's own output GainNode, NOT the song mix); fixed two-zone grid (left = parameter panels, right/main = dynamic); analyzer row top-right beside the audition bar; 14 sliders grouped into 4 fieldsets (Level & wave / Vibrato / Square / Filter) sitting beside their matching motion lanes; PList canvas becomes the only primary editor with the full table behind a toggle and the chip strip retired; audition bar extracted to its own component; PList editing state machine extracted to a composable.
- Also relevant (do not contradict): vibrato is a deterministic instrument attribute visible in the instrument editor — no tracker-side vibrato surfacing (Morten 12:48). The filter has no format field at all (engine behavior, bit-faithful) — do not add filter UI beyond what exists.

## Survey

Read the full survey first: `/home/openclaw/.openclaw/workspace/.tmp/ahx-inst-redesign-survey.md` (reference mechanism §1, page inventory §2, plumbing plan §3, style capture §4, plan conventions §5). Verify key claims against the code before building on them.

## CRITICAL CORRECTION vs the survey

Do NOT delete or prune `AhxPositionPanel.vue` — it is NOT orphaned; it was landed today and is wired into `TrackerPage.vue` (merge a1c72639). The survey only observed that the AHX INSTRUMENT page doesn't reference it, which is correct and intentional. Leave it alone.

## Deliverables

1. Plan first: `.ai/plan-ahx-inst-redesign.md` in the house format (follow `.ai/plan-plist-canvas.md` style: verbatim decisions with timestamps, MEASURED/INFERRED/UNVERIFIED labels, every claim cited file:line, decision table D-A… with alternatives+verdicts, "smaller decisions Morten should eyeball" list, batches, risks, tests). Include an ASCII wireframe of the two-zone layout. Smaller decisions to leave for Morten: envelope stage-table dedup (node editor + AD SR table currently edit the same 8 fields — keep both this pass unless the dedup is trivially safe), analyzer row placement details, how the retired chip strip's info (row count/speed) is preserved.
2. Implement in batches on branch `agent/ahx-inst-redesign-<short-suffix>`:
   - **B1** — preview output plumbing (TS only, NO Rust/worklet changes): expose the preview's output GainNode with the established lazy-subscribe idiom (never creates the worklet; survives client replacement/disposal; mirrors AhxPreview.onPListRow + the ahxPListPlayhead ShallowRef pattern), surfaced through the playback store.
   - **B2** — analyzer row on AhxInstrumentPage: reuse `OscilloscopeComponent.vue` + `FrequencyAnalyzerComponent.vue` (they take `node: AudioNode | null` and self-manage attach/cleanup/theme); wire `:node` from B1; gate visibility consistently with the page's existing audible/mode logic; restyle only as needed to sit in the AHX card language.
   - **B3** — layout redesign per the approved sketch: fixed two-zone grid, 4 slider fieldsets matched beside their lanes, `AhxAuditionBar.vue` extraction, PList single-primary (canvas) + table behind a toggle + strip retired, page script slimmed (extract plist editing state machine into a composable). Keep ALL existing behavior and testids that still apply; retire only what the plan says is retired.
3. Tests: unit tests for the B1 plumbing (lazy — proves no worklet is created until a note is requested; replacement survival), analyzer wiring smoke, and a regression sweep of everything touched. Run the gates per repo AGENTS.md. Do not run long build/test commands as blocking foreground execs.
4. Update `.ai` state per repo conventions.

## Constraints

- Read the repo's AGENTS.md + `.ai` conventions first and follow them.
- Fresh worktree, unique branch, worktree-owner marker at start, cleared at end/abort.
- Engine (rust-wasm) untouched; audio graph unchanged (analyser taps are read-only, never connected to destination).
- Do NOT push, do NOT merge. Stop on the branch.
- Do not touch `AhxPositionPanel.vue`, `TrackerPage.vue`'s position panel wiring, or the rust engine.
