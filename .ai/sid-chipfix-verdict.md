# S5.12 chip-comparison follow-up fixes — verdict: BLOCKED (Claude Code session limit), aborted before any fix work

Date: 2026-09-24. Run: s512-sid-chipfix-0924a (subagent 4ef5961b / session 434fe8ca).

## Status

**BLOCKED — no fixes implemented, no commits, no push, no merge.**

The task's execution path is Claude Code headless (`claude-opus-5-5`, `--permission-mode acceptEdits --allowedTools Bash`), with the explicit rule: "If Claude 429s: STOP, report blocker, do not improvise."

The R1 launch failed instantly with exit 1 and body:

> You've hit your session limit · resets 12pm (Europe/Oslo)

This is the Pro-subscription rate/session limit, not a transient API hiccup. Per the stop rule, all fix work was halted before any file was modified. Nothing was improvised.

## What was done (setup, fully reusable)

- Base verified: main tip `adc778b1` ("S5.12 queued" docs commit; the task's stated tip `1a3c6c5c` is its parent and an ancestor — both committed this morning at 09:35). Worktree branched from the actual tip.
- Worktree `.ai/worktrees/sid-chipfix`, branch `agent/sid-chipfix-0924a` at `adc778b1`, clean (0 modified files), owner marker written and then cleared on abort. No push, no merge.
- Baseline cargo gate captured on the untouched tree, house command
  `cargo test --features native-host --no-fail-fast`:
  - **402 passed / 1 failed / 1 ignored across 20 test binaries, exit 101.**
  - The only failure is the known baseline failure `manifest_covers_every_fixture`
    (`tests/ahx_render_golden.rs:419`, `left: 99 / right: 24`) — same signature as
    `.ai/checks-s59-baseline-cargo.txt`, unrelated to the SID core.
  - Saved as `.ai/worktrees/sid-chipfix/.ai/checks-s512-baseline-cargo.txt`.
- Chip-comparison report read in full; all four in-scope fix sites located and read:
  1. **Combined waveforms too loud** — `waveform.rs:146-207` (8580 = plain wired-AND; 6581 = "neighbour-pull" pass over the AND). Report means: 8580 $61 ~127 vs reSID ~62 (+6 dB), $51 ~64 vs ~20 (+10 dB); 6581 $61 ~75 vs ~7 (+20 dB), $71 ~12 vs ~0.4, $51 ~12 vs ~1.5. Both sides are documented INFERRED models; reSID's actual tables are GPL measured data and must not be copied.
  2. **4 kHz filter ceiling** — `filter.rs` `Filter::set()` applies only the 0.49·fs clamp; reSID's delta-clock (SAMPLE_FAST, GT2 default) path clamps cutoff to 4 kHz (`filter.cpp:259-265` via `filter.h:461`, reached from `gsound.c:216` → `gsid.cpp:77-80`). Fix shape: clamp the effective cutoff after the model map, before the fs clamp, both models; keep `cutoff_hz*()` maps unclamped so the S2 map tests stay intact.
  3. **6581 cutoff curve** — `filter.rs:101-107` log-logistic (INFERRED, 220 Hz–18 kHz, K=7) is 2–3× below reSID's measured spline across FC_HI $50–$7F and lacks the $3FF→$400 step (~6 kHz → ~4.6 kHz). Target anchors from the report §6.3: ~420 Hz @ 512, ~1.6 kHz @ 768, ~6 kHz @ 1023, ~4.6 kHz @ 1024, ~9.5 kHz @ 1280, ~14.5 kHz @ 1536, 220 Hz floor @ 0. Derivation path: log-interpolated two-piece curve through those anchors (measured facts), disclosed as derived; reSID's spline points are GPL.
  4. **Tick-0 effects remainder** — `player.rs` `continuous()` (~727-786): the S5.10 `tick0` gate already covers command 4 and command 0 instrument vibrato; **commands 1/2 (slides) and command 3's portamento branch still run on tick 0** — exactly the report's +20 %-per-row remainder at tempo 6. The `3 00` tie branch is already phase-correct (`if self.tick != 0`) and must not be touched. Fix shape: extend the `!tick0` gate to 1/2/3-portamento; red test pins (speed−1) steps per row at tempo 6.
- Ready-made red-first run prompts for both batches were written to `/tmp/s512-r1-prompt.md` (R1: tick-0 + ceiling) and `/tmp/s512-r2-prompt.md` (R2: combined-waveform levels + 6581 curve, with the licence rules, derived-value disclosure requirements, and a no-GPL-byte-diff grep guard baked in). They encode the scoping decisions above so the rerun needs no re-derivation.

## Licence discipline (recorded now, applies to the rerun)

Zero GPL code or table bytes in any planned fix. reSID's `wave6581_*/wave8580_*` tables and the measured filter spline are GPL; the published measurement *facts* (Antti Lankila's reSID-fp work, arXiv:0805.0171 and bel.fi/~ankila measurement pages) are not. Both R2 fixes derive values from the report's measured comparisons and cited published shape descriptions, with mandatory derived-value disclosure comments and a tolerance note vs reSID (±3 dB RMS per combination for waveforms; ±15 % in the 1–10 kHz region, ±5 % at anchors for the cutoff curve). Web search was unavailable in this run, so citations were not re-fetched live; the rerun should verify the citation URLs before committing them into source comments.

## Unchanged (out of scope, untouched)

Report items #6 (new-note first frame — interacts with S5.6 table timing), #7 (sampling method — band-limited is deliberate), #8 (filter-table wrap/order), #9 (DC terms), #10 (resonance), and all lower-impact items: untouched. Also untouched: everything else — **no source file in the worktree differs from `adc778b1`**.

## Rerun instructions

When the subscription limit resets (12:00 Europe/Oslo today), rerun from the main session with the same task envelope. The worktree, branch, baseline gate file, and both prompts survive. Re-establish the owner marker (`.ai/worktree-owner`), verify `git -C .ai/worktrees/sid-chipfix status --porcelain` is empty and HEAD is still `adc778b1`, then execute R1 followed by R2 (`claude -p "$(cat /tmp/s512-r1-prompt.md)" --model claude-opus-5-5 --permission-mode acceptEdits --allowedTools Bash`, detached, JSON + exit code captured to `.ai/claude-run-s512-r1.*`). If `/tmp` was cleared, the prompt contents are summarised in "What was done" above. Wasm artifact rebuild (`node build-wasm.cjs`, commit refreshed artifacts) happens after both batches land, per house rule; the merged-tree artifact gate is the authority.

## Ear-verification

Morten's, after a landed run — nothing to verify yet.
