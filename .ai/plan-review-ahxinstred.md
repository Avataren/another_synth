# Plan review: AHX instrument-page redesign plan

Reviewer: Claude Code headless plan-critique pass (read-only), 2026-09-22. Verdict and findings below, verbatim.

---

## Verdict: **SOUND** (proceed to coding), with 2 minor fixes recommended before or during B2/B3

I spot-checked every load-bearing citation set named in the task (ahx-player.ts, ahx-preview.ts, ahx-plist-playhead.ts, tracker-playback-store.ts, AhxInstrumentPage.vue template/script/style, OscilloscopeComponent.vue, FrequencyAnalyzerComponent.vue, PListCanvas.vue, AhxEnvelopeEditor.vue, TrackerPage.vue, AhxPListStrip.vue, song-bank.ts, ahx-transport.ts, and all named test-file line ranges including every `describe` block in `ahx-instrument-page-plist-edit.test.ts`) plus several unstated ones (AhxVibratoLane.vue, AhxSweepLane.vue). Of ~55 discrete `file:line` claims checked, 53 were exact or within one line; two were factually wrong. The design decisions (D-A through D-F) are all independently corroborated by the code, not just asserted.

## Findings

**1. [major] §0 D-C / §3 B2 — `FrequencyAnalyzerComponent.vue:199-206` citation misstates the sizing mechanism, and the risk isn't in §6.**
The plan claims both reused components have `canvas { width:100%; height:120px; ...}` in their own scoped style, citing `OscilloscopeComponent.vue:238-244` and `FrequencyAnalyzerComponent.vue:199-206` as parallel evidence. Verified: `OscilloscopeComponent.vue:240` does have a hardcoded `height: 120px`. But `FrequencyAnalyzerComponent.vue:201` has `height: 100%`, nested inside `.frequency-container { height: 100%; }` (`:196`) which is itself inside `.frequency-card { height: 100%; }` (`:210`) — there is no fixed-pixel height anywhere in this component. Its actual canvas size is entirely inherited from whatever height the *page* gives the component's root; `FrequencyAnalyzerComponent.vue:98-100` bails out of `draw()` when `canvas.width === 0 || canvas.height === 0`.
- **Failure scenario:** if B2's `.ahx-analyzer { display: flex; flex-direction: column; gap: 6px; width: 280px; }` (§3 B2) is implemented as written — no explicit height on the wrapping elements — the frequency analyzer's ancestor chain resolves `height:100%` against an unsized flex item and collapses to 0, so the spectrum bars silently never draw (blank canvas), while the oscilloscope renders fine at its self-fixed 120px. This is a correctness bug, not a cosmetic one, and it is not covered by §7.2's wiring-smoke test (asserts prop binding, not rendered size) nor by any of the six §6 risks (risk 2 only discusses "may look cramped," not "may render nothing").
- **Fix:** correct the citation, and add explicit guidance that `.ahx-analyzer`'s two child slots need their own set heights (e.g. `.ahx-analyzer > * { height: 70px; }`), not just a `:deep(canvas)` height override — a direct `:deep(canvas) { height: 70px }` override would still work regardless, but the plan should say so explicitly rather than implying a symmetric "override a fixed 120px" story for both components. Consider adding this as risk 7.

**2. [minor] §4.1 testid table — "Lanes have no testids of their own (checked: AhxVibratoLane.vue, AhxSweepLane.vue define none)" is false.**
Grep confirms both components define several: `AhxVibratoLane.vue` has `ahx-vibrato-lane` (`:2`), `ahx-vibrato-trace` (`:23`), `ahx-vibrato-caption` (`:28`); `AhxSweepLane.vue` has nine `${kind}`-scoped testids (`ahx-sweep-lane-`, `-band-`, `-trace-`, `-off-`, `-pulses`, `-pulse-`, `-caption-`, `-why-`, `-enable-${kind}`, lines 5-74), one of which (`ahx-sweep-band-filter`) is in fact asserted by the existing suite (`ahx-instrument-page-b2.test.ts:202`).
- **Consequence:** low — since the lanes are moved unmodified (no prop/internal changes, per §1.2), these testids survive the move automatically regardless of whether the plan's evidence about them is correct. This is a documentation-accuracy defect, not an implementation-blocking one.
- **Fix:** correct the table cell to "Lanes carry their own testids (`ahx-vibrato-*`, `ahx-sweep-*-${kind}`), unaffected since the components are relocated, not modified" rather than "define none."

## Everything else checked out

- **D-B step 8 (page imports `ahxPreviewOutputNode` directly, not through the store's return object) is defensible and consistent with the precedent it claims to mirror.** `tracker-playback-store.ts:1445-1499` confirmed to have no `ahxPListPlayhead` field, and the task's own instruction says to "mirror… the `ahxPListPlayhead` ShallowRef pattern" — that pattern *is* "store wiring writes it, page imports the module directly." Reading "surfaced through the playback store" as "the store's wiring code is what subscribes/writes it" is the only interpretation that doesn't contradict the explicit mirror instruction, and D-B's rejected-alternative note (`ahx-instrument-page-plist-canvas.test.ts:9-14`, the whole store is mocked in page tests) is independently verified and a genuinely strong supporting argument.
- **D-A (tap point)** is fully corroborated: `AhxPlayerClient.output` (`ahx-player.ts:70,100-101`) → `host.output` (`ahx-preview.ts:191`) → confirmed to be `SongBank.masterGain` (pre-rack, `song-bank.ts:248-250`), distinct from `finalOutput`/post-rack (`song-bank.ts:260-262`, comment matches verbatim), distinct from `AhxTransportHost.output` (`ahx-transport.ts:33-37`, comment matches verbatim).
- **D-E (chip-strip deletion, `v-show` table)** blast-radius claims verified: `AhxPListStrip` has exactly one non-test importer (`AhxInstrumentPage.vue`), no dedicated component test file (`Glob "src/tests/*strip*"` → empty, confirmed), and the three adapted-test-file edits cite exact, verified line ranges with correct existing content.
- **CRITICAL correction re: `AhxPositionPanel.vue`** is correct — confirmed imported/rendered/ref'd in `TrackerPage.vue:335,949,1168` exactly as cited; the plan rightly forbids touching it.
- **Regression sweep list** — all 15 named test files exist (`Glob` confirms), and `ahx-instrument-page-plist-edit.test.ts`'s eight `describe` blocks are cited at the exact correct line numbers.
- **No Rust/worklet/wasm touches, no push/merge, gate list, `.ai/checks-<n>.txt` recording** are all present and match `CLAUDE.md`/task constraints.

## Top 3 actions
1. Fix the `FrequencyAnalyzerComponent.vue:199-206` citation and add explicit sizing guidance for B2 (finding 1) — this is the one finding with real implementation risk (a silently-blank spectrum analyzer).
2. Correct the lane-testid claim in §4.1 (finding 2).
3. Otherwise: proceed to B1. The plan's factual grounding is unusually strong — nearly every citation across six source files and four test files verified exact on first read.
