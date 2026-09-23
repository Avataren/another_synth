You are the coder for batch S2 ("6581 character pass") of the SID engine in this repository.
Work ONLY inside this worktree (/home/openclaw/.openclaw/workspace/another_synth/.ai/worktrees/sid-6581),
branch agent/sid-6581-0923a (already checked out; stay on it). NEVER push, NEVER merge, NEVER
rebase, NEVER touch main. NEVER edit anything outside:
- rust-wasm/src/sid/          (all code changes live here)
- .ai/sid-6581-verdict.md     (new verdict doc)
- .ai/checks-s2-*.txt         (gate outputs)
- .ai/claude-run-s2-6581.json (your own run log, already being written by your launcher)
Do NOT touch repo-root src/, public/, corpus, packages/, other rust-wasm/src files
(rust-wasm/src/lib.rs already has `pub mod sid;`), existing tests, or Cargo.toml
(ZERO new dependencies — no crates, no vendored code).

Read first (all inside this worktree):
- .ai/plan-sid-tracking.md — §6 batch row S2 is your contract; §1.2's 6581 rows ("Waveform
  6581 quirks", "ADSR", "Filter", "Output stage") define the scope; §1.1 the sample-rate
  caveats. Note the table's INFERRED-marking discipline.
- .ai/sid-voice-core-verdict.md — the S1 record: architecture, model choices, test
  discipline, ears list. Stay consistent with it (2-pole TPT filter, pitch correction,
  test-bit semantics, boxcar decimation).
- rust-wasm/src/sid/*.rs — the S1 code you extend: mod.rs, chip.rs, voice.rs, waveform.rs,
  envelope.rs, filter.rs, noise.rs, tests.rs. Keep its architecture, its doc-comment style
  (sources + INFERRED marks per module header), and its hand-derivation-first test style.

TASK: turn SidModel::Sid6581 from a refusing stub into a real model. Scope = the plan §1.2
6581 rows ONLY (no store/engine/format work):
1. 6581 filter: a static nonlinear remap of the 11-bit cutoff register to Hz (the 6581
   cutoff characteristic is strongly nonlinear where the 8580's is near-linear — public
   knowledge), plus 6581 resonance character / level-dependent peak-gain approximation
   (plan wording: "static nonlinear remap of the cutoff register + level-dependent peak gain").
2. 6581 combined-waveform quirks: the measured long/run-down distortion of 6581 combined
   waveforms, and the waveform-0-with-TEST-bit edge behaviour.
3. The 6581 ADSR attack curve (the published ~1.5 ms floor / nonlinear attack shape, as a
   level-vs-time remap; the shared rate table stays).
4. Output-stage gain/DC offset calibration (the famous 6581 DC level). Note in the verdict:
   the S1 output already has a 16 Hz DC blocker, so a DC offset manifests as a thump on
   note-on/transients, not a constant offset.
5. Per-instance model switch + 8580 regression pin (below).
Keep S1's architecture: S2 is a character pass on the same skeleton. Model-gate every change
so the Sid8580 paths stay bit-identical.

MODEL DISCIPLINE (load-bearing):
- Hand-derived derivations FIRST, as comments beside each behaviour. Every 6581 quirk marked
  with its source class: datasheet / public measurement / INFERRED (one sentence on what was
  inferred and why). No GPL emulator code or tables (reSID, resid-fp, libsidplayfp are GPL).
  Tuning guesses are allowed but must be labelled INFERRED and listed as ears-gate items.
- No reference recordings exist. Never claim hardware fidelity anywhere. Honest caveats only.

8580 REGRESSION PIN (do this FIRST, before editing any sid/ code):
- Add a test rendering a deterministic 8580 snippet through the REAL chip path
  (Chip::new(Sid8580) + register writes + render at 44.1 kHz, a fixed register program
  exercising waveforms, filter, envelope, noise) and pin the exact f32 sample values as
  constants. Capture the constants by running the test on the UNMODIFIED S1 tree, paste them
  in, THEN start implementing. After S2 the pin must pass bit-exactly — that is the proof
  S2 left 8580 behaviour unchanged. Add an equivalent deterministic 6581 render pin (your
  new model) so future refactors are covered.

TESTS (all through the real SidChip path — Chip::new + register write/read + clock/render;
no bypass fixtures — this is the jt_letgo rule):
- Model construction: Chip::new(Sid6581) now succeeds; unimplemented_reason() is None;
  rewrite S1's refusal test so it pins that BOTH models construct per-instance.
- Per-instance switch: the same register program rendered on both models — both sane, they
  differ audibly-in-numbers (6581 filter/DC/level), each respects its own maps.
- 6581 filter: remap monotonic, endpoints, clearly distinct from the 8580 map at several
  registers; resonance character pinned.
- 6581 combined waveforms: attenuated vs the 8580 wired-AND on the same phase; run-down
  decay if modelled; waveform-0 + TEST edge behaviour pinned.
- 6581 ADSR: attack curve shape (e.g. the ~1.5 ms floor) pinned against hand-derived
  level-vs-time values; rate table unchanged and shared.
- 6581 output stage: DC offset/gain calibration visible in a note-on transient (the DC
  thump), level balance vs 8580 measured in the test.
- All existing sid:: tests must still pass unchanged (the 8580 pins).

GATES (run ALL; save outputs; report honestly):
1. Baseline (ALREADY recorded — do not rerun, do not touch):
   .ai/checks-s2-baseline-cargo-test.txt — untouched main tip 4f76a8d3:
   22 test-result lines, 351 passed, 1 failed, 1 ignored; the 1 failure is the pre-existing
   manifest_covers_every_fixture (public/ fixture count; out of scope, do NOT fix). Your
   final run must show that failure identical.
2. Full suite: cd rust-wasm && cargo test --features native-host --no-fail-fast
   > ../.ai/checks-s2-final-cargo-test.txt 2>&1
   Gate: >= 351 passed, all new tests pass, failures == exactly {manifest_covers_every_fixture}.
   NOTE: plain `cargo test` does NOT build (engine_node_integration + envelope_preview need
   --features native-host) — that is documented pre-existing behaviour, keep the flag.
   These runs take minutes: run them backgrounded with output redirect and poll the file,
   never as one blocking command a tool timeout could kill.
3. gitleaks detect --no-git --source . > ../.ai/checks-s2-gitleaks.txt 2>&1 — must be clean.
4. No new compiler warnings from your files (cargo output shows them; S1 kept this clean).
If a gate fails, fix and re-run; never report a gate you did not watch pass.

DELIVERABLES:
- Code in rust-wasm/src/sid/ (extend the existing modules; keep the module split).
- .ai/sid-6581-verdict.md: what landed; model-choices table with INFERRED marks; the 8580
  regression-pin proof; test inventory (counts + exact invocation lines); the sample-rate
  caveats restated honestly; an ears-gate listening list for Morten extending the S0/S1 list
  with at least: 6581 filter grit/character, combined-waveform distortion, DC thump on
  note-on, level balance 6581 vs 8580.
- Commit EVERYTHING (code + verdict + checks files) on the current branch
  agent/sid-6581-0923a with a clear message, e.g.
  "feat(sid): S2 6581 character pass — filter nonlinearity, combined-waveform quirks, attack curve, DC/gain calibration".
  git add only your specific paths. Do NOT git push. Do NOT merge. Do NOT touch
  .ai/worktree-owner (the main run manages that marker).

FINAL REPORT (your last message): run stats (lines per module), new test count and final
suite totals, the 8580 regression-pin proof, honest caveats, branch name + paths.