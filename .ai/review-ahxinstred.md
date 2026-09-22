# Code review: agent/ahx-inst-redesign-1 (commits 0a90713b, eb8c6491, a163b349, e687ee38)

Reviewer: Claude Code headless adversarial review (read-only), 2026-09-22 ~13:51. is_error=false, cost $1.23. Verdict + findings verbatim below.

---

This matches D-D's design exactly. All the load-bearing contract points check out. Final verdict below.

---

**Verdict: PASS**

**Findings:**

1. [minor] `.ai/checks-*.txt` (worktree) — Gate §5 item 6 (`git diff --stat` on `rust-wasm/`, `public/wasm/`, `public/worklets/` must show no change, recorded in a checks file) has no corresponding log file among `checks-1-*`/`checks-2-*`/`checks-3-*.txt`. This is a process-documentation gap, not a substantive violation: the diffstat in `.ai/review-input-log.txt` independently confirms none of the 32 changed files fall under those paths, and `git status` shows the only pre-existing dirty files (`public/demos/index.json`, `public/wasm/audio_processor_bg.wasm`) predate this branch's HEAD and aren't part of its commits. No action needed beyond noting the gate wasn't separately logged.

**Verified and matching the contract, with file:line evidence:**

- **B1** (`ahx-preview-output.ts:1-18`, `ahx-preview.ts:35-238`): `outputNodeListeners` set mirrors `plistRowListeners` exactly; `onOutputNode` (`:85-88`) matches `onPListRow`'s shape; `ensureClient()` fires listeners with `client.output` right after `this.client = client` (`:216,219`), with an explicit code comment warning against `host.output` confusion (`:217-218`, addressing plan risk 3); `disposeClient()` fires `null` at `:233` before `this.client = null` at `:235`; `dispose()` clears both sets (`:165-166`). Store wiring (`tracker-playback-store.ts:540-541,550-551`) matches the plan's exact two-line addition per function, and the store's returned object is untouched (grep for `ahxPreviewOutputNode`/`ahxPListPlayhead` in the store found only the wiring-site matches, none in a `return {...}`). `ahx-preview-output.test.ts` genuinely mirrors `ahx-plist-row-client.test.ts`'s structure and proves lazy-creation, replacement survival, and dispose-order.
- **B2** (`AhxInstrumentPage.vue:267-273,1281-1298`): analyzer row gated `v-if="audible"`, testids `ahx-analyzer-row/-oscilloscope/-frequency/-off` all present, `:node="ahxPreviewOutputNode"` bound to both components, and the plan-review finding-1 sizing fix (`.ahx-analyzer > * { height: 70px }` + `:deep(canvas)`) is implemented with an explanatory comment. `ahx-instrument-page-analyzer.test.ts` smoke-tests audible/inaudible and reactive prop-following.
- **B3**: 4 fieldsets (`AhxInstrumentPage.vue:62-249`) match §1.2's mapping exactly (14 controls, hard-cut fields kept in Filter per smaller decision 4); `AhxAuditionBar.vue` props/emits/testids match §3, and the `midiChip` computed is byte-identical to the original (confirmed via diff line comparison, `review-input-diff.txt:60261-60272` vs `:61572-61583`); two-zone grid CSS (`:1049-1069`) matches D-D verbatim; `useAhxPListEditing.ts` extraction matches the plan's stated interface, correctly omits `stepSize`/`octave` (confirmed dead — `AhxInstrumentPage.vue:471-472` binds them directly to `PListCanvas`, never through the composable); the D-E table-toggle fix (`focusField` at `:928-935`, conditionally opens table then `await nextTick()`) is exactly the plan's required fix, and `ahx-instrument-page-layout.test.ts:153-166` proves the double-click hand-off from a hidden table works end-to-end; `AhxPListStrip.vue` is deleted with zero remaining references anywhere in `src/`; all three D-E test-file adaptations are applied correctly.
- **Constraints**: no `rust-wasm/`, `public/wasm/`, `public/worklets/`, `AhxPositionPanel.vue`, or `TrackerPage.vue` changes anywhere in the diff (confirmed via diffstat and grep). Worktree-owner marker present.
- **TS gate disclosure**: `checks-1-tsc.txt` has exactly 87 error lines (baseline); `checks-3-tsc.txt` has exactly 100, a growth of 13 — matching precisely the 7+6 new `.props('node'|'audible'|'octave'|'stripStart'|'latch'|'restrike'|'midiStatus')` TS2345 errors in the two new test files, the same `keyof VNodeProps` shim limitation already present in the pre-existing baseline (e.g. `ahx-instrument-page-plist-canvas.test.ts` `'selectionRect'`, `ahx-instrument-page-plist-playhead.test.ts` `.playbackRow`/`.isPlaying`). `vue-tsc` (`checks-3-vuetsc.txt`) shows the identical 6 pre-existing `#q-app/wrappers`/implicit-any errors, zero new ones. Disclosure is accurate.
- **Full regression**: `checks-3-fullsuite.txt` — 228 test files, 3664 tests, all passing; lint and gitleaks clean at every checkpoint.

Coder actions:
