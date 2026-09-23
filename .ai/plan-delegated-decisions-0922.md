# Plan: delegated decisions batch (0922)

Date: 2026-09-22. Worktree: `.ai/worktrees/decide-impl`, branch
`agent/delegated-decisions-0922a`, base `df2b34a6` (main, merge of the
band-limit pass). Five small changes. The decisions were made on evidence in
phase 1; this pass only implements them. No DSP or engine change, and no
wasm rebuild.

## Objective

Fix one stale tooltip, remove one redundant control, fix one unit label and
bring two docs up to date with what has landed. Nothing audible changes.

## Per-change plan

### C1. Stale transpose tooltip (`src/audio/tracker/ahx-position-display.ts`)

- MEASURED: `:17` `ahxTransposeTitle` ends `...semitones when the song plays;
  wheel it on the track header chip, or type it in the position panel below
  the song list.` The position panel is hidden, so the second half is wrong.
  The doc comment `:11-14` also says "the panel takes typed entry".
- Change: the text after `when the song plays;` becomes
  ` wheel the track header chip to change it.` The doc comment drops the
  panel.
- INFERRED: no test asserts the old tail (grep before commit; a test that
  does gets updated).

### C2. Remove the "Exact value" start-waveform select (`src/pages/AhxInstrumentPage.vue`)

- MEASURED: `:349-362` is a `<select data-testid="ahx-start-waveform">`
  over `WAVEFORM_CHOICES` that calls `setStartWaveform`. The `AhxSegmented`
  right above it (`:341-348`, testid `ahx-seg-startWaveform`) has radios for
  values 0..4 (`START_WAVE_OPTIONS`, `:909-917`) and calls the same
  `setStartWaveform`. So the select duplicates it.
- KEEP `WAVEFORM_CHOICES`: the PList table still uses it (`:600`).
- Tests:
  - `ahx-instrument-page-b2.test.ts:80-81`: drop the select-agrees check.
  - `:84-89`: rename to `the start-waveform radio edits it` and drive
    `ahx-seg-startWaveform-1` with `setValue(true)`.
  - `ahx-instrument-page.test.ts:111`: `ahx-start-waveform` → `ahx-seg-startWaveform-4`, `setValue(true)`.

### C3. Hard-cut warning unit (`src/pages/AhxInstrumentPage.vue:327`)

- MEASURED: the warning says `tick`/`ticks`, while the field suffix and the
  envelope legend say frames.
- Change: `'frame' : 'frames'`. The regex in `ahx-instrument-page-b2.test.ts:142`
  becomes `muted abruptly 2 frames before ...`.

### C4. `.ai/ahx/verdict.md` filter/HVL sentences

- MEASURED: **the file is not in this worktree and not in git history**
  (`git log --all -- .ai/ahx/verdict.md` is empty, and `git grep` for the
  filter sentence at df2b34a6 finds nothing). It is probably an untracked
  file in the main checkout, which this session cannot read.
- Plan: **blocked**. Do not make up a file. Report the blocker, and give the
  exact replacement text so it can be applied where the file lives.

### C5. `.ai/band-limit-analysis.md` §7 row 6 (Gibbs clipping)

- MEASURED: row 6 is at `:299`, with columns # | Proposal | Audible | CPU |
  Risk | Size | Bit-exactness.
- Change: add a `DECIDED 2026-09-22` note to the Proposal cell, keeping the
  7-column shape: accept + document; evidence M5/M6 (469 clips with hi-fi on,
  all isolated single samples, max overshoot ~×1.19). Fix path if it is ever
  audible: unclamped f32 hi-fi output, not a soft-clip or taper.
- UNVERIFIED here: the "469 clips" count comes from phase 1 or M5. Check it
  against the M5 text in the same file before committing.

## Gates

Output goes to `.ai/checks-delegated-dec.txt`:

1. `npx vitest run src/tests/ahx-instrument-page.test.ts src/tests/ahx-instrument-page-b2.test.ts src/tests/ahx-instrument-page-ux2.test.ts`
2. `npm run test:run` (the full suite). Known flake: the event-stream corpus
   harness under the parallel pool. If it shows up, check whether it happens
   on df2b34a6 as well, and document it.
3. `npm run lint`
4. `npx vue-tsc --noEmit`
5. `gitleaks detect --no-git --source .` if the binary is installed.

## Rollback

Every change is its own commit on this branch, touching UI text, one template
block, tests and docs. To undo one, `git revert <sha>`. Nothing is pushed or
merged.
