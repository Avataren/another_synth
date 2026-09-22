# Plan: arch fix pass 2 (N5 WAV-decode hardening + N11 CPU meter + N8 per-song engine setting)

Branch: `agent/arch-fix2-0922a` (from main `51c4ffeb`), worktree `.ai/worktrees/arch-fix2`.
Engine: Claude Code headless, `--model claude-opus-5-5` (pinned 2026-09-22), CLI 2.1.280.
Authorization: Morten, 2026-09-22 20:33 — "All these should be fix" (rust-wasm source changes authorized).
Review: `.ai/arch-review-2026-09-22.md` N5 (:124), N8 (:166), N11 (:187). Fix pass 1 (N1+N3) landed on main; freshness gate (`npm run check:artifacts`, `public/wasm/SOURCE_HASH.json`) is part of every vitest run.

## Decisions

- **D1 (2026-09-22 20:55)** N5 fix = the review's sketch, verbatim: hoist one shared
  `read_wav_samples_f32(reader) -> Result<Vec<f32>, String>` next to the three decode
  sites in `rust-wasm/src/audio_engine/wasm.rs`, using
  `collect::<Result<Vec<_>, _>>()` so hound's `Err` on a truncated `data` chunk
  propagates instead of `.unwrap()` panicking. All three call sites carry the
  identical format match (32-float / 16-int / 24-int / 32-int / unsupported-error,
  MEASURED at wasm.rs:65-83, :1365-1381, :2014-2030 — same conversion arms and
  scales), so the helper owns the whole match and each site shrinks to one call:
  - `import_wav_hound_reader` (returns `Result<_, Box<dyn Error>>`):
    `.map_err(Into::into)`.
  - `import_wave_impulse` and `import_sample` (return `Result<_, JsValue>`):
    `.map_err(|e| JsValue::from_str(&e))`.
  Error convention: plain `String` messages in the existing house style
  ("Unsupported WAV format: bits_per_sample=… sample_format=…" stays the
  unsupported-arm text, unchanged wording).
- **D2 (2026-09-22 20:55)** N5 scope = the three decode sites only. Other
  unwraps in wasm.rs (:378-400 wavetable bank builders, :431-440 effect chain
  setup, :744-747 serde round-trips) are not in the WAV/asset decode path and are
  NOT touched — review N5 names only the `.map(|s| s.unwrap())` sites.
  `samples[start..end]` slicing after the helper is safe (num_cycles derived from
  `samples.len()`), verified by reading the surrounding code.
- **D3 (2026-09-22 20:55)** N11 = `wasm.rs` CPU meter: replace the hard-coded
  `quantum_sec = 128.0 / sample_rate` (:914 region) with
  `frames as f64 / sample_rate`, where `frames = output_left.len()` is already
  taken at :770 region. The `js_sys::Date::now()` timing itself STAYS: the code
  already accumulates `cpu_time_accum / audio_time_accum` over a ≥0.1 s audio-time
  window before sampling (`last_cpu_usage` update), so 1 ms per-block resolution
  is averaged out; the 128-frame hard-code against a variable quantum was the
  real defect. `performance.now()` is unavailable in AudioWorkletGlobalScope, so
  the review's worklet-side timing alternative is out of scope here.
- **D4 (2026-09-22 20:55)** N8 = least-magic mechanism, current behavior is the
  default:
  - Add `readonly instrumentEngine?: 'sampler' | 'worklet'` to `FormatProfile`
    (`packages/tracker-playback/src/format-profile.ts:26`), threaded through
    `ProfileOptions`/`profileForFormat` exactly like the existing optional
    file-level flags (`linearFrequency`, `amigaLimits`, `fastVolumeSlides`,
    MEASURED :991-1015). Absent everywhere by default; `profileForFormat` output
    is unchanged when the option is not supplied.
  - `song-bank.ts` engine choice (:1911-1935 region, `useSimplified` read):
    resolve as `formatProfile.instrumentEngine ?? (useSimplifiedModInstruments ?
    'sampler' : 'worklet')`. Mapping MEASURED from the code comment at :1917-1929:
    `useSimplifiedModInstruments = true` (the default, user-settings-store.ts:211)
    → ModInstrument; `false` → full WASM synth via pooled worklet.
  - No importer sets `instrumentEngine` yet, and `setModuleFormat`
    (song-bank.ts:767-777) does not pass it: every existing song resolves through
    the global-setting fallback, i.e. byte-for-byte today's behavior. The
    persisted-settings migration and the "setting becomes debug override" move
    from the review sketch are DEFERRED — see Smaller decisions (Morten veto
    pending, D4 still open per review).
  - IndexPage.vue editability gating (:440-451) stays on the global setting:
    since no profile can set `instrumentEngine` yet, resolving it there would be
    dead branching; touching the editor path adds risk for zero behavior.
    Documented, not done.
- **D5 (2026-09-22 20:55)** N5 regression test goes through the REAL load path:
  the built artifact. Pattern: `synth-worklet-harness.ts` already evaluates the
  built `public/worklets/synth-worklet.js` glue in a bare vm realm against the
  real `public/wasm/audio_processor_bg.wasm` (harness header, MEASURED). The test
  feeds a truncated WAV (valid header, `data` chunk size larger than the
  remaining bytes) where the old code trapped (`unreachable`), and asserts:
  1. the call surfaces a catchable JS error (hound's message), not a dead module;
  2. the engine/worklet is still usable afterwards (a subsequent valid WAV
     import succeeds and a render still produces samples).
  Preferred route: through the worklet protocol if a message path carries WAV
  bytes into `import_sample`/`import_wave_impulse` (coder verifies the message
  and cites it — e.g. the patch-load path the review names at
  synth-worklet.ts:691-698); else through the glue's wasm export instantiated
  from the committed artifact in the harness realm. Whichever is used, the test
  file cites the exact production path. Plus a Rust `#[cfg(test)]` unit test in
  wasm.rs feeding a hand-built truncated WAV `Cursor` to the decode helper,
  expecting `Err` (no new dev-dependency; header built by hand).
- **D6 (2026-09-22 20:55)** Artifact rebuild procedure (per plan-arch-fix1.md
  D7-D9, Landed section): `npm run build:wasm` (build-wasm.cjs; wasm-pack 0.13.1
  present, `--no-opt` unless `ENABLE_WASM_OPT`, same args as the fix1
  reproducibility run) → commit the new `public/wasm/audio_processor_bg.wasm` +
  `audio_processor.js` if changed + the `SOURCE_HASH.json` the build script
  writes (manifest hash must equal the hash of the new committed sources — the
  freshness gate enforces this in every vitest run). `npm run build:worklets` is
  NOT expected to change anything (no TS worklet edits in this pass) and the
  freshness gate will prove that.

## Alternatives

| Alternative | Verdict | Why |
|---|---|---|
| Per-site `map_err` without a shared helper (D1) | rejected | three copies drift again; the review explicitly sketches the hoist |
| `catch_unwind` around decode | rejected | `panic = "abort"` (Cargo.toml:56, MEASURED) means unwinding is compiled out; and it would leave engine state undefined anyway |
| N11: worklet-side `performance.now()` timing (review option) | rejected | `performance` is not in AudioWorkletGlobalScope; accumulation already averages the 1 ms resolution |
| N8: full review sketch (settings migration + version bump, setting demoted to debug override) | deferred | changes the default audio path — exactly what Morten's guardrail forbids without a product decision (D4 open) |
| N8: no code at all until D4 decided | rejected | the profile field + fallback resolver stages the mechanism with zero behavior change; review ranked it "risky-migration" only because of the migration we are deferring |

## Smaller decisions (Morten veto slot)

- **S1** N8 lands as: optional `FormatProfile.instrumentEngine` + fallback to
  `useSimplifiedModInstruments`. No song format sets it yet; the global setting
  stays authoritative. The review's "migrate + version bump" step and the
  per-song opt-in surface (importer header flag vs. song metadata vs. UI) are
  left for the D4 product decision. Veto-friendly: reverting N8 after this pass
  is a deletion of one optional field + one fallback expression.
- **S2** N11 keeps `js_sys::Date::now()` block timing (accumulated), fixing only
  the hard-coded 128.0 quantum denominator. The meter stays display-only.

## Gates (to .ai/checks-archfix2.txt)

- touched vitest suites, then FULL `npx vitest run` (includes the freshness gate).
- `npm run lint`; `npx vue-tsc --noEmit`.
- `cargo test` in `rust-wasm/` (toolchain MEASURED present: cargo
  1.100.0-nightly, wasm-pack 0.13.1).
- `gitleaks`: parent runs it (if blocked here, noted in the report).

## Evidence log

- 20:49 **N5 sites (MEASURED, base 51c4ffeb):** `.map(|s| s.unwrap())` decode
  matches at wasm.rs:65-83 (`import_wav_hound_reader`), :1365-1381
  (`import_wave_impulse`), :2014-2030 (`import_sample`); identical arms and
  scales, as D1 says.
- 20:52 **D1 deviation — helper location (MEASURED).** `wasm.rs` is only
  compiled under `#[cfg(all(feature = "wasm", target_arch = "wasm32"))]`
  (audio_engine/mod.rs:4-5), so a `#[cfg(test)]` module inside it never runs
  under native `cargo test`. The helper therefore lives in a new sibling
  `rust-wasm/src/audio_engine/wav_decode.rs` (gated
  `any(all(feature="wasm", target_arch="wasm32"), test)`, mod.rs:3-4) and
  `wasm.rs` imports it (:44). Same signature (`&mut hound::WavReader<R>` ->
  `Result<Vec<f32>, String>`), same arms/scales, same "Unsupported WAV
  format: bits_per_sample=… sample_format=…" wording. After: wasm.rs:66
  (`?` into `Box<dyn Error>`), :1340 and :1965 (`map_err(JsValue::from_str)`).
  Also covered for free: the load-time asset path `import_audio_assets`
  (wasm.rs:2955, `import_sample` :2966 / `import_wave_impulse` :2975) calls
  the same two functions, so a bad asset in a saved patch now fails
  `loadPatch` with an error instead of trapping. D2 honoured: no other
  unwrap touched.
- 20:53 **Rust unit tests (MEASURED):** `wav_decode::tests::
  truncated_data_chunk_is_an_error_not_a_panic` (hand-built 16-bit mono
  header declaring 100 data bytes, 5 present -> `Err`) and
  `complete_16bit_data_keeps_the_i16_max_scale` (0x7fff -> 1.0, 0x8001 ->
  -1.0). Both pass.
- 20:54 **N11 (MEASURED):** wasm.rs:889 `quantum_sec = frames as f64 /
  self.sample_rate as f64` (`frames = output_left.len()`, in scope since the
  top of `process_with_frequency`); comment updated. `Date::now()`
  accumulation unchanged (D3/S2).
- 20:58 **D6 rebuild (MEASURED):** `npm run build:wasm` exit 0 (wasm-pack
  0.13.1, `--no-opt`). `audio_processor_bg.wasm` 36977586… -> 763c2488…;
  `audio_processor.js` unchanged (58a87d19…), so `synth-worklet.js` (which
  bundles the glue) needs no rebuild; `SOURCE_HASH.json` sources 74 -> 75
  files (the new wav_decode.rs), hash 581ee7b8… -> 32bf6464…
  `npm run check:artifacts` clean.
- 20:59 **N8 (MEASURED):** `FormatProfile.instrumentEngine?`
  (format-profile.ts:303-310) and `ProfileOptions.instrumentEngine?`
  (:997-1002); `profileForFormat` wraps the old body (now
  `formatBaseProfile`) and spreads the field on only when supplied, so the
  shared constants are returned by identity otherwise (pinned). song-bank.ts
  :1928-1936 resolves `formatProfile.instrumentEngine ??
  (useSimplifiedModInstruments ? 'sampler' : 'worklet')`; `useSimplified` is
  derived from it so the log/decision lines are unchanged. Nothing sets the
  field (`setModuleFormat` untouched, no importer change): grep
  `instrumentEngine` hits only format-profile.ts, song-bank.ts and the test.
  IndexPage.vue and the settings store untouched.
- 20:59 **tracker-playback dist (MEASURED):** the app aliases the package to
  source (vitest.config.ts:39-41, quasar.config.ts:215-217,
  tsconfig.json:7-8) and `dist/` is not committed, so nothing needs
  rebuilding. `npm run check:tracker-playback-dist` could not run here:
  `tsup` is not installed in the shared node_modules (exit 127) —
  environment, not this change; not run.
- 21:01 **D5 path (MEASURED):** worklet messages carry WAV bytes into both
  exports: `importSample` (synth-worklet.ts:373) -> `handleImportSample` ->
  `engine.import_sample` (:733), and `importImpulseWaveform` (:329) ->
  `handleImportImpulseWaveformData` -> `engine.import_wave_impulse` (:699).
  Test `src/tests/synth-worklet-truncated-wav.test.ts` drives both through
  the real `WorkletPool`/`PooledInstrument` -> built `synth-worklet.js` ->
  committed wasm (harness `helpers/synth-worklet-harness.ts`), two
  instruments on one worklet.
- 21:02 **Red against the old artifact (MEASURED):** with base's
  `audio_processor_bg.wasm` swapped in temporarily, both tests fail — the
  caught value is an object (`RuntimeError: unreachable`), and the
  subsequent valid sample import exports `[]` (engine dead, wasm-bindgen
  borrow never released). With the new wasm: caught value is the string
  "Failed to read enough bytes.", the re-import round-trips exactly, the IR
  re-import exports, and both slots render (RMS > 1e-3). New wasm restored
  (sha 763c2488… re-verified).
- 21:02-21:07 **Gates** (full text `.ai/checks-archfix2.txt`):
  touched suites 7 files / 68 tests pass; full `npx vitest run` 236 files /
  3758 tests pass (freshness gate included); `npm run lint` exit 0;
  `npx vue-tsc --noEmit` exit 0; `npm run check:artifacts` clean.
  `cargo test` (plain) exit 101 — PRE-EXISTING: `tests/engine_node_integration.rs`
  and `tests/envelope_preview.rs` import `audio_engine::native`, gated on
  `native-host` (mod.rs, unchanged from base). `cargo test --features
  native-host`: lib 116 pass (incl. the 2 new), all suites pass except
  `ahx_render_golden::manifest_covers_every_fixture` — PRE-EXISTING: it pins
  24 fixtures, main already commits 84 in `public/demos/ahx`
  (e5ba2dc0, 35e0a4a3, both ancestors of base; test last touched 33c3f9d9).
  Not fixed here (out of scope).

## Landed

- 2026-09-22 21:08, branch `agent/arch-fix2-0922a` (not merged, not pushed):
  266959fb N5, 5ecd5e78 N11, d2ddf727 N8, b4fe9146 test + wasm artifact,
  plus this docs commit. Gates as in the evidence log (vitest 236/3758,
  lint 0, vue-tsc 0, artifacts fresh; two pre-existing cargo failures
  recorded, none caused here).
