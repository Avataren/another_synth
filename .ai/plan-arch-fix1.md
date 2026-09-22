# Plan: architectural fix pass 1 (N1 + N3, N7 slice)

Branch `agent/arch-fix1-0922a`, base `5e26b7ae`. Source review:
`.ai/arch-review-2026-09-22.md` (N1 `:47-65`, N3 `:86-104`, N7 `:154-164`).
Gate output: `.ai/checks-archfix1.txt`.

Labels: **MEASURED** = opened/ran on this tree; **INFERRED** = follows from
measured code but not executed; **UNVERIFIED** = not checked.

Out of scope, per the brief: N5, N8, N11, any `rust-wasm/` source edit,
`public/demos`, `TrackerPage.vue`, `IndexPage.vue` (neither is touched).

---

## 0. How pooled slots are actually allocated (read before designing)

The review talks about "engine 0" and "the slot's engine". The code has two
different things called "engine", and the fix depends on which one a message
must reach.

| # | Fact | Label | Evidence |
|---|---|---|---|
| A1 | The main-thread `WorkletPool` hands each song instrument a contiguous voice range inside one *engine slice* (`VOICES_PER_ENGINE` = 8 voices) of one shared worklet. It never straddles a slice. | MEASURED | `src/audio/worklet-pool.ts:83-150` (`allocateVoices`), `:356-390` (`findContiguousRange`, loops `engineIndex < ENGINES_PER_WORKLET`) |
| A2 | The song bank asks for the patch's voice count, clamped to 8. | MEASURED | `src/audio/tracker/song-bank.ts:1974-1987` |
| A3 | The engine slice only decides **which AudioParams** the instrument writes (`gate_engine{E}_voice{V}`). | MEASURED | `pooled-instrument-factory.ts:140-145` (`getParamName`), worklet `synth-worklet.ts:2361-2391` (`buildEngineParamsForSlot`) |
| A4 | In the worklet, **every pooled instrument gets its own private `AudioEngine`**, created in `getOrCreateInstrumentSlot` and keyed by `instrumentId`. It is not `audioEngines[slice]`. | MEASURED | `synth-worklet.ts:1069-1114` (`new AudioEngine(sampleRate)` at `:1093`, `instrumentSlots.set(instrumentId, slot)` at `:1112`); slot created from `loadPatch` with an `instrumentId` at `:913-918` → `:1037` |
| A5 | `audioEngines[0..ENGINES_PER_WORKLET)` are the **legacy** engines, created at wasm init for the non-pooled editor path. While any slot exists, `process()` renders **only** slot engines; `audioEngines[]` are never rendered. | MEASURED | created `:795-803`; `process()` branches on `hasInstrumentSlots` `:2480`, slot loop `:2491-2533`, legacy loop only in `else` `:2534-2621` |
| A6 | `getTargetEngines(instrumentId)` already resolves an id to `[slot.engine]`, falls back to the legacy engines when no slot has that id (InstrumentV2 editor ids), and with no id returns every slot engine (or the legacy engines when there are no slots). | MEASURED | `synth-worklet.ts:2427-2446` |
| A7 | Port messages are FIFO, and `PooledInstrument.loadPatch` posts `loadPatch` before `song-bank.restoreAudioAssets` posts any asset import, so the slot exists when the IR/sample import arrives. | MEASURED (order) / INFERRED (FIFO is the MessagePort contract) | `pooled-instrument-factory.ts:214-221`, `song-bank.ts:2001` then `:2012`, `restoreAudioAssets` `:2096-2150` |
| A8 | Rust `AudioEngine::delete_node` removes the node from every voice graph of *that* engine (its connections go with it) and refuses system/output nodes. Disposal therefore needs no Rust change; it only has to reach the right engine. | MEASURED | `rust-wasm/src/audio_engine/wasm.rs:1101-1161` (read only) |

**Consequence for the design (decision D1).** "The song's own engine slot" is
`instrumentSlots.get(instrumentId).engine` (A4), not `audioEngines[slice]`.
The slice index from A1 is irrelevant to routing a graph or asset message;
only the `instrumentId` is. So every fix routes by `instrumentId` through the
existing `getTargetEngines` (A6); none computes a slice.

This also corrects the review's description of defect (b): an IR sent to
`audioEngines[0]` does not land in "someone else's" convolver. With slots
present it lands in a legacy engine that is never rendered (A5), so the slot
keeps its default IR. When two instruments export, both read that same legacy
engine, so the second import is what both "see" — measured in the red run
(§6: A's export returned B's IR, `-0.25` instead of `0.5`).

---

## 1. Decisions (verbatim, timestamped)

- **D1 (2026-09-22 20:30)** Route pool-scoped messages by `instrumentId` via
  `getTargetEngines`, never by engine slice. Evidence §0 A4-A6.
- **D2 (2026-09-22 20:30)** `deleteNode`: `PooledInstrument.deleteNode` posts
  `{ type: 'deleteNode', nodeId, instrumentId }`. The worklet deletes in
  `getTargetEngines(instrumentId)`. With an `instrumentId` that names a slot
  it replies with that slot's refreshed layout (`stateUpdated` +
  `instrumentId`), mirroring `handleCreateNode` (`synth-worklet.ts:632-646`);
  otherwise it keeps the legacy `handleRequestSync()` reply.
  - Pooled per-engine failures are caught and `console.warn`ed, because Rust
    rejects system nodes (A8) and one rejection must not skip the layout
    reply.
  - The legacy no-id path is byte-for-byte the old code, so it still throws.
  - IR import (D3) catches and `console.error`s per engine on both paths.
- **D3 (2026-09-22 20:30)** IR import: `handleImportImpulseWaveformData`
  imports into every engine `getTargetEngines(instrumentId)` returns.
  - Pooled (id with a slot): only that slot.
  - Legacy InstrumentV2 (no id, no slots): all legacy engines instead of only
    `audioEngines[0]`. This is a small legacy behaviour change and it is
    deliberate: legacy `loadPatch` loads the patch into every legacy engine
    (`:933-948`), and voices on engine 1 play through engine 1's own effect
    stack, so an IR in engine 0 only was the same "never only
    `audioEngines[0]`" bug (AGENTS.md "Worklet graph editing sync").
- **D4 (2026-09-22 20:30)** Export: `handleExportSampleData` and
  `handleExportConvolverData` read `getTargetEngines(instrumentId)[0]` and echo
  `instrumentId` in the reply. For the legacy path (no id) that is still
  `audioEngines[0]`, so InstrumentV2 export is unchanged.
- **D5 (2026-09-22 20:30)** `PooledInstrument.exportSamplerData` /
  `exportConvolverData` correlation ids become unique per instrument and per
  call (they were `export-sample:${nodeId}`, `pooled-instrument-factory.ts:1432`,
  `:1473`). Two slots on one worklet share node ids: every slot's convolver
  effect is `10003`. Created sampler ids differ per slot (MEASURED 20:30: the
  test's same-id assumption for samplers failed, so the pin uses the
  convolver). Every `PooledInstrument` on a worklet also listens on the same
  port, so concurrent exports of `10003` from A and B both resolved on the
  first reply. The listener is removed and the timer cleared on
  timeout too (it leaked before).
- **D6 (2026-09-22 20:30)** Save path: `extractAllAudioAssets` and friends take
  a structural `AudioAssetSource` (`exportSamplerData` + `exportConvolverData`)
  instead of `InstrumentV2`, which both classes satisfy. The four
  `currentInstrument as InstrumentV2` casts at the extractor call sites in
  `patch-store.ts` (`:752`, `:833`, `:921`, `:1231`) are dropped. No runtime
  change: the store already passes the pooled instrument through. It just
  stops lying to the type checker about it, which is how (c) type-checked
  (N4/N7). The other `as InstrumentV2` casts (`:368,374,439`) are not on
  this path and are left for N4.
- **D7 (2026-09-22 20:45)** N3 gate is **test-time, content-based**, plus a
  build-time writer for the wasm half:
  - Worklets: `scripts/artifact-freshness.cjs` rebuilds the three esbuild
    worklets **in memory** (`write: false`) with the *same options object*
    `build-worklets.cjs` uses, which moves into that module so it has one
    source, and byte-compares them with `public/worklets/*.js`.
  - Wasm: `build-wasm.cjs` writes `public/wasm/SOURCE_HASH.json` with the
    sha256 of the Rust inputs (`rust-wasm/src/**`, `Cargo.toml`, `Cargo.lock`,
    `rust-toolchain.toml`, `.cargo/config.toml`) and of the two produced
    files. The gate recomputes all three.
  - `src/tests/artifact-freshness.test.ts` runs both checks inside
    `npm run test:run`, so the gate everyone runs is the gate. There is no CI
    (review N3, MEASURED there). `npm run check:artifacts` runs the same
    checks standalone.
  - Every failure message names the file and the exact regenerate command.
- **D8 (2026-09-22 20:45)** Not mtime. The brief says "older than their
  sources". Git does not preserve mtimes: a clone or checkout stamps every file
  with checkout time, so an mtime gate passes a stale binary on every fresh
  checkout and fails spuriously after touching a source. Content comparison
  answers the actual question ("was this artifact produced from this
  source?"). See alternatives §3.
- **D9 (2026-09-22 20:45)** Seed `SOURCE_HASH.json` without a Rust rebuild.
  - The committed wasm and every Rust input were last changed in `0242229e`
    (wasm, `src`, `Cargo.*`), or earlier in `a248627c`
    (`rust-toolchain.toml`, `.cargo/config.toml`). MEASURED with
    `git log -1 -- <path>`.
  - A reproducibility rebuild into `/tmp` checks this independently (§6,
    `.ai/checks-archfix1.txt`).
- **D10 (2026-09-22 20:45)** Delete `public/worklets/wasm/audio_processor_bg.wasm`
  (20 KB AssemblyScript leftover, review N3(d)). It is unreferenced (MEASURED:
  no hit for `worklets/wasm` in `src/`, `build-*.cjs`, `quasar.config.ts`).
  Keeping it would make "every committed wasm is gated" false.
- **D11 (2026-09-22 20:45)** `recording-worklet.js` is hand-written, not an
  esbuild output (not in `build-worklets.cjs` entry points, and no `.ts`
  source). It is not gated.

## 2. N7 slice: what falls out of the N1 message changes

Done here (typed in `src/audio/types/worklet-messages.ts`):
- `DeleteNodeMessage` gains `instrumentId?`.
- New `ExportSampleDataMessage` and `ExportConvolverDataMessage` (inbound),
  plus `SampleDataMessage` and `ConvolverDataMessage` (replies, echo
  `instrumentId`), added to the `WorkletMessage` union.
- `PoolScopedAssetMessage` = the four N1 messages. The four worklet handlers
  take those types instead of ad-hoc inline shapes, so a sender adding a field
  the receiver ignores is now a visible type difference, not a silent one.
- `PooledInstrument` builds the export posts with `satisfies` against those
  types. `deleteNode` and `importImpulseWaveform` already go through
  `sendFireAndForget(message: WorkletMessage)`, which type-checks them against
  the union.

Remains (not attempted, per brief):
- `handleMessage(event: MessageEvent)` is still untyped (`synth-worklet.ts:264`).
  The dispatch switch is not a discriminated-union switch.
- About 30 other handlers still declare inline shapes. `InstrumentV2` still
  posts object literals through `port.postMessage` in its export and preview
  paths.
- `BaseMessage.type: string` makes the union non-discriminating for
  exhaustiveness. Tightening it is the real N7 migration.
- `WorkletMessageValidator` validates 7 types only.

## 3. Alternatives considered

| Question | Option | Verdict |
|---|---|---|
| Route by what? | engine slice `floor(startVoice/8)` → `audioEngines[slice]` | **Rejected.** Slot engines are private (A4); `audioEngines[]` are not rendered with slots present (A5). This would still land nowhere. |
| | `instrumentId` → `getTargetEngines` | **Chosen** (D1). |
| deleteNode reply | legacy `handleRequestSync()` (posts `audioEngines[0]` layout) | Rejected for pooled: wrong engine's layout, same class of bug. |
| | slot layout `stateUpdated`+`instrumentId` | **Chosen** (D2), mirrors createNode. |
| Legacy IR import | keep `audioEngines[0]` only | Rejected (D3): engine-1 voices keep the wrong IR in legacy mode. |
| Freshness signal | file mtime | **Rejected** (D8): meaningless after `git clone`/checkout. |
| | git-commit ordering (`git log` of artifact vs source) | Rejected: needs git history at test time (shallow clones, tarballs), and says nothing about uncommitted edits. |
| | content: rebuild-and-compare (worklets), recorded source hash (wasm) | **Chosen** (D7). Worklet rebuild costs ~0.3 s in memory. A wasm rebuild takes minutes and needs the Rust toolchain, so the wasm side records the hash of its inputs at build time instead. |
| Where the gate runs | `pretest` npm hook | Rejected: `vitest` run directly (as agents and IDEs do) would skip it. |
| | pre-commit hook | Rejected for now: not versioned/installed by default in this repo (no hooks, review N3); can call `npm run check:artifacts` later. |
| | vitest test | **Chosen**: runs in every `npm run test:run`. |
| Test harness for N1 | mocked engines (`worklet-graph-sync.test.ts` style) | Rejected as the pin: it tests source with doubles, so it cannot catch a stale bundle. |
| | built `synth-worklet.js` in `vm` + real wasm + real `WorkletPool`/`PooledInstrument` | **Chosen**; the pattern of `ahx-worklet-shell.test.ts`. |

## 4. Smaller decisions

- The harness copies inbound messages **into the vm realm**. The wasm-bindgen
  glue rejects foreign-realm objects: `processBlock` threw "Expected parameter
  map object" when handed a main-realm record (MEASURED while building the
  harness). A real port deserialises into the worklet realm, so this is the
  faithful behaviour, not a workaround.
- The harness replaces `import.meta` with `{ url }`, which is all an
  AudioWorkletGlobalScope's `import.meta` has. **Side finding, not fixed (out
  of scope):** `synth-worklet.ts:1462` reads `import.meta.env.DEV` inside
  `handleUpdateConnection`'s `try`. In the worklet `import.meta.env` is
  `undefined`, so every `updateConnection` would throw into the
  `catch` at `:1517`. Neither Vite nor esbuild rewrites it: the committed
  bundle has it verbatim, and `public/` is served untransformed. INFERRED. It
  needs its own check in a browser; see the final report.
- The 8-voice fixture patch (`public/default-patch.json` patch 0,
  `voiceCount` set to 8) forces the second instrument onto engine slice 1, the
  review's scenario. It also pins A1.
- The tests assert audibly for delete: B silent after its only oscillator is
  deleted, A still sounding. They assert by value for export (exact samples)
  and by first-sample sign/magnitude for IR. The convolver may pad or
  partition the IR, so length is only checked as `>=`.
- The AGENTS.md "Worklet graph editing sync" section gets two bullets (routing
  rule, freshness gate), so the next agent does not rediscover this.

## 5. Files

- `src/audio/worklets/synth-worklet.ts`: 4 handlers (D2-D4), typed (§2).
- `src/audio/pooled-instrument-factory.ts`: `deleteNode`, export
  correlation (D2, D5).
- `src/audio/types/worklet-messages.ts`: N7 slice (§2).
- `src/audio/serialization/audio-asset-extractor.ts`, `src/stores/patch-store.ts`: D6.
- `public/worklets/synth-worklet.js`: rebuilt by `npm run build:worklets`.
- `scripts/artifact-freshness.cjs`, `scripts/check-artifacts.cjs`,
  `build-worklets.cjs`, `build-wasm.cjs`, `package.json`
  (`check:artifacts`), `public/wasm/SOURCE_HASH.json`: N3.
- `public/worklets/wasm/audio_processor_bg.wasm`: deleted (D10).
- Tests: `src/tests/synth-worklet-pooled-scoping.test.ts`,
  `src/tests/helpers/synth-worklet-harness.ts`,
  `src/tests/artifact-freshness.test.ts`.
- `AGENTS.md`: notes.

## 6. Evidence log

- 20:28 **Red run.** The new N1 pins run against the unfixed committed bundle
  (HEAD `5e26b7ae`): 4 of 5 fail, each for the predicted reason (text in
  `.ai/checks-archfix1.txt`).
  - delete: no `stateUpdated`, because `PooledInstrument.deleteNode` is a
    no-op.
  - IR: A's export returned B's IR, because both import and export use
    `audioEngines[0]`.
  - sample export: the extractor returned no asset ("Sampler node not
    found" on `audioEngines[0]`).
  - concurrent export: empty result.
  - The allocation pin (A1: A at voice 0, B at voice 8, one worklet) passes.
- Worklet artifacts were byte-identical to a fresh esbuild of source at base
  (MEASURED 20:25, in-memory build vs `public/worklets/{synth,effects,ahx}-worklet.js`).
- 20:26 **Wasm reproducibility (D9).** `wasm-pack build --no-opt --target
  web --release --out-dir /tmp/archfix1-wasm` (the args `build-wasm.cjs` uses)
  on this tree reproduced `public/wasm/audio_processor_bg.wasm` and
  `audio_processor.js` byte for byte (sha256 `36977586…` and `58a87d19…`).
  So the seeded `SOURCE_HASH.json` (74 input files, source hash `581ee7b8…`)
  describes the committed binary. MEASURED. `public/wasm/*` were not rewritten.
- 20:31 **D5 pin fires.** With the correlation id temporarily reverted to
  `export-${kind}:${nodeId}`, the concurrent-export test fails: A's listener
  resolved with B's IR. MEASURED, then restored.
- 20:32 **Red re-run.** The final pins (async harness) run against the HEAD
  bundle plus the HEAD `pooled-instrument-factory.ts`: 4 of 5 fail, as above.
- 20:34 **N3 catches N1.** The N1 TS sources with the HEAD (stale)
  `synth-worklet.js` on disk:
  - `npm run check:artifacts` exits 1 with "public/worklets/synth-worklet.js
    is stale … Rebuild and commit it with: npm run build:worklets".
  - The freshness test fails.
  - All 4 N1 pins fail. The new `PooledInstrument` against the old bundle
    deletes the oscillator in *every* slot (the old unscoped handler), which
    is the corruption AGENTS.md warns about.
- 20:35-20:38 **Gates** (full text in `.ai/checks-archfix1.txt`):
  - touched suites: 6 files, 49 tests, pass.
  - full `npx vitest run`: 235 files, 3753 tests, pass. That is 233/3743 at
    review time, plus this branch's 2 files and 10 tests.
  - `npm run lint`: 0 problems.
  - `npx vue-tsc --noEmit`: 0 errors.
  - `gitleaks detect --no-git --source .`: no leaks.
  - `npm run check:artifacts`: clean.

## 7. Deferred / not done

- **N7 remainder:** see §2 "Remains".
- **Side finding, not fixed:** `import.meta.env.DEV` in the worklet's
  `handleUpdateConnection` (§4). It likely breaks every live connection edit
  in the browser. It needs a one-line `import.meta.env?.DEV` fix plus a
  worklet rebuild, and a browser check first. It is out of this pass's scope.
- **Gate gaps:**
  - Build flags inside `build-wasm.cjs` (`--no-opt`, `ENABLE_WASM_OPT`) are
    not part of the source hash. Hashing the script would have made the seed
    unverifiable, since this branch edits it.
  - A toolchain upgrade with unchanged `rust-toolchain.toml` is also not
    detected.
  - A different esbuild version in `node_modules` flags every worklet as
    stale. That is correct: the bundle is esbuild's output.
- **Not touched:** N4 casts outside the save path (`patch-store.ts:368,374,439`),
  and `InstrumentV2` export correlation (already unique per call).

## Landed (2026-09-22)

- Merged agent/arch-fix1-0922a @ e1a4d024 into main via no-ff merge commit 7f7f11e7 (message: "merge: pooled-slot routing fixes + artifact freshness gate (agent/arch-fix1-0922a)"). Diff scope 19 files, as reviewed.
- Post-merge gates on main (real exit codes): full vitest suite 235 files / 3753 tests passed (exit 0); eslint 0 problems (exit 0); vue-tsc --noEmit (exit 0); npm run check:artifacts standalone ✅ "public/worklets and public/wasm match their sources" (exit 0). The N3 freshness gate ran inside the vitest suite and standalone.
- Pushed main: range 5e26b7ae..7f7f11e7 -> origin/main (push exit 0).
- Deployed via scripts/deploy.sh (default target avatar@192.168.50.161:~/repos/docker-info-ws-server/html/synth), exit 0; script's own index.html checksum verified: 12c00aef8b6a78ea9fe348e5f9dfa1fe.
- Independent md5 byte-match (dist/spa vs deployed), all PASS:
  - index.html 12c00aef8b6a78ea9fe348e5f9dfa1fe
  - wasm/audio_processor_bg.wasm 660f3c70e72d0b87e2ed2dadc65eee42
  - worklets/ahx-worklet.js 0b1e28a2d692f80a2f9fc3a46d77f1e6
  - worklets/effects-worklet.js ea0b2d2be2fd5dd6ec9a6a6ccb5c5e71
  - worklets/recording-worklet.js 9c96bf69c35c1b90db4314dd0923147f
  - worklets/synth-worklet.js d3be4813a900d1db107ac182b425f346 (rebuilt on this branch — deployed copy matches)
  - demos/index.json 8c509dd895820af982e574204fcde15c
- Landing record: .ai/deploy-archfix1-20260922.log; worktree owner marker cleared; branch agent/arch-fix1-0922a and worktree .ai/worktrees/arch-fix1 left in place.
