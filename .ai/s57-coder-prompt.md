# S5.7 coder task: chip-model switcher UI + mono spectrum (TS-only)

You are the coder for S5.7 in this repo (another_synth). You are already checked out in the
worktree on branch `agent/sid-chipui-0924a` (off main tip `4322c848`). Work ONLY in this
worktree. NEVER `git push`, never merge, never touch `main`. The `.ai/worktree-owner` marker
already exists — leave it in place.

URGENT task, keep it small and focused. No gold-plating. NO Rust changes, NO wasm rebuilds.

## Deliverables

### 1. Chip-model switcher on the tracker page (SID songs only)

- When a SID song is loaded, show an `8580 ↔ 6581` toggle near the tracker page's existing
  playback/transport controls (find the neighboring controls in `src/pages/TrackerPage.vue`).
  Small control matching existing styling. MUST be visible and touch-usable in the phone
  layout (Morten is testing from his phone right now) — check how TrackerPage does its
  phone/desktop split and make sure the toggle is reachable on phone.
- Default state = the song's tagged model. The loaded song doc has `chipModel`
  (`SidChipModel` = `'8580' | '6581'`, `src/audio/tracker/sid-doc/types.ts`). The op
  `setSidChipModel(doc, chipModel)` already exists (`src/audio/tracker/sid-doc/ops.ts`).
- Switching must:
  a) Retag the loaded song doc (`setSidChipModel`) so export keeps the choice —
     `src/audio/tracker/sid-doc/sid-file-codec.ts` writes `CHIP_CODES[doc.chipModel]`
     into the file header byte 3, so a re-export after retagging carries the model.
  b) Rebuild the SID player with the chosen model. The worklet's `loadSong`
     (`src/audio/worklets/sid-core.ts`, ~line 214) constructs
     `new this.PlayerCtor(data, this.sampleRate)` — the Rust `SidSongPlayer::new` reads
     the song's own `model` from the parsed header byte. So the TS-side path is:
     re-serialize the retagged doc with the SID file codec into bytes and reload the
     player with those bytes. No Rust changes needed or allowed.
- Playback on switch: capture the current position (row) before the rebuild; after the
  new player's `song-loaded` resolves, `seek` back to that row if the player supports
  resuming there. If resuming proves unreliable, restarting playback is acceptable —
  but DISCLOSE in the verdict exactly which happens.
- Only show the toggle when the active source is SID (TrackerPage knows formats; e.g.
  `slot.instrumentFormat === 'sid'`).

### 2. Mono display for SID in the analyzers

- SID is mono. The worklet mix output is stereo with identical L/R
  (`src/audio/worklets/sid-core.ts`, outputChannelCount `[2,1,1,1]`).
- `OscilloscopeComponent.vue` / `FrequencyAnalyzerComponent.vue` (and the spectrum
  analyzer wrapper they serve) currently split L+R and draw two identical traces for SID.
- When the active source is SID, render ONE trace (mono). Keep the L/R pair for other
  formats (MOD/AHX share these components). Minimal change: find how these components
  learn the active format (TrackerPage / song bank track monitors pass data in) and add
  per-source discrimination, not a global toggle.

### 3. Tests (vitest, follow existing component-test patterns)

- Switch mid-session keeps playback consistent: after a switch, the model reaching the
  player actually changed (assert via the reload path / `chip_model` reported in the
  `song-loaded` info — see `src/tests/sid-playback-chain.test.ts` and
  `src/tests/sid-worklet-core.test.ts` and the harness `src/tests/helpers/sid-worklet-harness.ts`
  for patterns).
- Tag update persists to the export path: retag → serialize via the SID file codec →
  header byte reflects the new model.
- Mono trace for SID (one trace when source is sid) + stereo for others.

### 4. Gates (real exit codes, save output to these exact files)

Baselines already exist (run on the untouched tip, DO NOT overwrite):
`.ai/checks-s57-baseline2-vitest.txt` (exit 0), `.ai/checks-s57-baseline2-vuetsc.txt`
(exit 0), `.ai/checks-s57-baseline-lint.txt` (exit 0),
`.ai/checks-s57-baseline-gitleaks.txt` (exit 0), `.ai/checks-s57-baseline2-cargo.txt`
(exit 101 — the ONLY failure is the pre-existing `manifest_covers_every_fixture`
in `tests/ahx_render_golden.rs`).

After your changes, in the worktree root:
- `{ npm run test:run 2>&1; echo "vitest exit: $?"; } > .ai/checks-s57-vitest.txt`
- `{ npm run lint 2>&1; echo "lint exit: $?"; } > .ai/checks-s57-lint.txt`
- `{ npx vue-tsc --noEmit 2>&1; echo "vue-tsc exit: $?"; } > .ai/checks-s57-vuetsc.txt`
- `{ gitleaks detect --no-git --source . 2>&1; echo "gitleaks exit: $?"; } > .ai/checks-s57-gitleaks.txt`
- Cargo: you make NO Rust changes. If `git status --porcelain rust-wasm/` is empty after
  your work, do NOT rerun cargo; the baseline `.ai/checks-s57-baseline2-cargo.txt` stands.
  Only run `cd rust-wasm && cargo test --features native-host --no-fail-fast` if you somehow
  touched rust-wasm (you should not).

Expected deltas: vitest gains your new tests, everything else green. If a pre-existing test
fails that is not in the baseline, fix or investigate before committing — do not hand-wave.

### 5. Verdict file

Write `.ai/sid-chipui-verdict.md`:
- What the UI shows (where the toggle lives, both layouts).
- Switch behavior: exactly what happens to playback (resume vs restart) and how you know.
- Mono-display proof (what the test asserts).
- Test deltas (files + counts).
- Gate numbers (exit codes + test counts vs baseline).
- Honest caveats, especially mobile behavior.

### 6. Commit

Commit everything (code, tests, checks files, verdict, this prompt file) on the branch with a
message like `feat(sid): S5.7 chip-model switcher + mono spectrum display (TS-only)`.
No push, no merge. Report the branch name and the file list you touched.
