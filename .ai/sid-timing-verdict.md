# S5.6 verdict — GT tie-note timing-nuance alignment (branch agent/sid-timing-0923a, base ac35c660)

Scope: the two tie-note frame-level details recorded by the S5 cross-check
(`.ai/sid-crosscheck-verdict.md` (a), D-log §6 — "recorded, NOT changed" at the time) are now
aligned with GT2's replay. Facts only; nothing copied from the GPL source.

## Execution note (deviation from the batch brief)

The batch was briefed for Claude Code headless (canonical claude-opus-5-5,
`--permission-mode acceptEdits --allowedTools Bash`). The account was hard-limited:
`429 "You've hit your session limit · resets 12:40am (Europe/Oslo)"` on the main run and on a
retry (22:47, zero tokens served). To keep the S5 pipeline moving, the orchestrating agent
implemented the prepared brief directly — `.ai/coder-brief-s56.md`, unchanged, written before
the first run attempt — and ran every gate itself. The branch lands uncommitted-work-free and
is ready for the normal review flow.

## Deviation 1 — tie-note jump phase (red → green)

GT: realtime optimisation defaults ON (goattrk2.c:55 `optimizerealtime = 1`), tick-N effects
skip tick 0 (gplay.c:728 `if ((!optimizerealtime) || (cptr->tick))`), so the `3 00` instant
jump (gplay.c:807-811 `freq = targetfreq; vibtime = 0`; commands PDF p.1 "ST = 00 slides
instantly") lands on **tick 1**, not tick 0, and re-asserts every tick while command 3 stands.
`targetfreq = freqtbl[cptr->note]` where `cptr->note` is the persistent last note (updated at
tick 0 even for command-3 rows, gplay.c:350) — so a `3 00` on a rest or key-off row snaps back
to the last note too. Our player jumped at read_row (tick 0) and never re-asserted.

Fix (`rust-wasm/src/sid/player.rs`): `read_row` no longer writes the pitch for command 3
(no tick-0 jump; `target = Some(...)` kept for both params); `continuous`'s command-3 arm
gained the param-0 branch — from `self.tick != 0`, `freq = gt_note_freq_reg(base_note)`. The
param≠0 glide arm is byte-for-byte unchanged.

Red first: the updated S5 tie pin failed at its old tick-0 expectation (C-4 was already
E-4 on the row's first frame) — `.ai/checks-s56-red.txt`, 3 failed / 2 passed, EXIT=101.
Green: `.ai/checks-s56-green-tests5.txt`, 5/5. The pin's substance is preserved and
disclosed in the D-log addendum: no retrigger (control 0x11, `channel_note` = 52 already on
tick 0), instant jump (no glide) — one frame later, exactly GT's phase.

## Deviation 2 — wave-table notes pass through under portamento (red → green)

GT: the wave-note path has NO command check (gplay.c:714-722 — relative notes use the
already-updated `cptr->note`, so a wave note on the tie's tick 0 uses the NEW base) and jumps
past the tick effects on wave-note frames (gplay.c:722 `goto PULSEEXEC`) — the wave note wins
its own frame; the next non-wave frame re-asserts the base pitch (deviation 1). Our player
suppressed wave-table notes under any portamento (`wave_note`, `matches!(ch.cmd, 0x1..=0x3)`).

Fix: the suppression is removed — the note applies under any command. Our frame order
(`continuous` before `wave_step`) lands the same final register value as GT's effects-skip:
the wave note is written last on its frame.

Red → green via two new tests (red in `.ai/checks-s56-red.txt`, green in
`.ai/checks-s56-green-tests5.txt`):
- `a_wave_table_note_passes_through_a_tie_and_the_base_pitch_is_re_asserted`: the tie row's
  tick 0 keeps the standing wave note (no tick-0 jump), tick 1 lands the arpeggio note
  THROUGH the tie, tick 2 re-asserts the tie base, tick 3 the arpeggio note again; control
  alternates 0x11/0x21 and the gate never drops (no retrigger).
- `a_wave_table_note_passes_through_a_speed_glide_and_the_glide_resumes`: under `3 01`
  (0x10/frame toward E-4) the wave note wins its frame over the glide and the glide resumes
  down from it — the "any portamento" half of the old suppression.

## Corpus impact (honest)

- The pattern-data counts did NOT move: 478 delay rows / 36 files and 4791 `3 00` rows /
  56 files are import-side counts; `src/tests/sid-sng-corpus.test.ts` needed no change and is
  green in the vitest run.
- Player behavior changed, disclosed: wave-table notes are now heard during ties and glides
  (winning their frame, base pitch re-asserting between notes), and the tie pitch lags one
  frame (tick 1, per GT's realtime optimisation). No corpus or load-chain test asserted the
  old tie/wave play behavior — none needed updating (vitest: 256 files / 4147 tests,
  identical to the untouched-tree baseline `.ai/checks-s56-baseline-test.txt`).

## Playback proof + artifacts

- `npm run build:wasm && npm run build:worklets` (EXIT=0, `.ai/checks-s56-wasm-build.txt`):
  `public/wasm/SOURCE_HASH.json` + `public/wasm/audio_processor_bg.wasm` rebuilt and committed
  with the batch (supersedes ac35c660's comment-only refresh); the worklet bundles came out
  unchanged. `npm run check:artifacts` EXIT=0 — "public/worklets and public/wasm match their
  sources".
- Load-chain proof: `src/tests/sid-sng-load-chain.test.ts` is green in the vitest run on the
  rebuilt wasm (real playback store / SID transport / `SidProcessorCore`, D-log §8).

## Gates (real exit codes in `.ai/checks-s56-*.txt`)

Baselines first, on untouched ac35c660 in this worktree:
- `cargo test --features native-host --no-fail-fast` → `checks-s56-baseline-cargo.txt`:
  384 passed / 1 failed (the pre-existing AHX `manifest_covers_every_fixture`) / 1 ignored,
  EXIT=101 — identical to the S5/S5x baseline.
- `npx vitest run` → `checks-s56-baseline-test.txt`: 256 files / 4147 tests, EXIT=0.
- `npx vue-tsc --noEmit` EXIT=0; `npm run lint` EXIT=0;
  `gitleaks detect --no-git --source .` "no leaks found" EXIT=0.

Final:
- cargo → `checks-s56-cargo.txt`: 386 passed (+2 new tests) / 1 failed (the same known
  AHX failure) / 1 ignored, EXIT=101 — the only intended deltas.
- vitest → `checks-s56-test.txt`: 256 files / 4147 tests, EXIT=0.
- vue-tsc EXIT=0; lint EXIT=0; gitleaks "no leaks found" EXIT=0; artifacts EXIT=0.
- Red run → `checks-s56-red.txt` (3 target tests failed before the fix); green
  tests_s5 → `checks-s56-green-tests5.txt`.

## What changes audibly

Engine semantics now match GT's replay: a `3 00` tie lands its pitch on the row's second
frame and re-asserts it each tick (one frame of the previous pitch per tie row — GT's own
realtime-optimisation phase), and wave-table arpeggio notes are heard during ties and glides,
winning their frame with the base pitch re-asserting between notes. Whether it sounds right
is ear-verification — Morten's; no hardware-fidelity claim is made here.

## Recorded, not changed

- The param≠0 glide still starts on tick 0 (pinned by tests_s3's portamento test and the S5
  control test); GT's realtime optimisation would start it on tick 1 as well. Outside the two
  documented deviations.
- The tie re-assertion does not reset instrument vibrato (gplay.c:811 `vibtime = 0` is not
  modelled); the S3 vibrato model stands as pinned.
- A `3XY` glide row on a rest row still has no glide target in our model (GT would glide
  toward the persistent note); undocumented corner, untouched.

Branch: agent/sid-timing-0923a (base ac35c660, recorded in the owner-marker protocol).
Files: `rust-wasm/src/sid/player.rs`, `rust-wasm/src/sid/tests_s5.rs`,
`public/wasm/SOURCE_HASH.json`, `public/wasm/audio_processor_bg.wasm`,
`.ai/sid-import-dlog.md` (S5.6 addendum), this verdict. No push, no merge.
