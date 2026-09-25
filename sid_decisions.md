# SID player: decisions and outstanding issues

First written after v0.3.78 (S5.19, commit `4337c998`), when the player began
writing all 25 SID registers the way GoatTracker 2.72's own playroutine does.
Revised 2026-09-25, after the authoring work of `.ai/plan-sid-authoring.md`
(phases 1-3: GT-only instruments, `.sng` export, new SID songs, and song
editing through the flat model). The oracle tools are in `.ai/sid-oracle/`.

Measured now, gtref (GT's playroutine + reSID, MULT-aware) against our Rust
player, every subsong of the 84 corpus songs, 4000 frames, all 25 registers:
**100 of 102 subsongs identical**. The two others are "Ballad" (§3, a chosen
difference) and one register-frame on `yehar/b_o_f_h_ingame_death_victory`
subsong 3 (master volume on frame 0, not yet looked at).

## Resolved

### 1. App-made songs follow GT's timing too. KEPT (2026-09-25)

Every song plays by GT's rules, including the quirks:

- the pulse table skips the row-read frame, a note's frame, the first frame
  of a pattern's last row and the frame a voice starts a pattern
  (GT's default `optimizepulse`);
- filter changes are heard one frame later (GT sets $15-$18 at the top of
  the frame);
- the cutoff wraps instead of clamping;
- a note with a wave table keeps the old pitch for its first frame.

**Why kept:** plan-sid-authoring D1 made every instrument a GoatTracker
instrument, and every export (`.sng` now, `.sid`/`.prg` with GT's own
`player.s` next) runs GT's rules. A second rule set would be a sound the
exports cannot make. The flat song model relies on it too: because a voice's
pattern starts are audible, it records them (below).

### 2. "Waveform 0 marks an instrument as GT-style". OBSOLETE (D1)

The instrument's own waveform, pulse width and filter are gone (D1): every
instrument is GT-style, and nothing is inferred. What remains true is GT's:
first-frame `$00` leaves a fresh voice's gate shut (`initchannels` zeroes it),
so a note is silent until its wave table opens the gate. The SID instrument
page now warns when the first-frame byte is `$00`.

### 3. "Ballad": the C64 player, not GT's editor. KEPT (2026-09-25)

"Ballad" uses a fine vibrato with shift `$42` (66). GT's editor (C on x86)
shifts by 66 mod 32 = 2 and plays vibrato; GT's C64 player (`player.s`, one
`lsr` per count) shifts 66 times, which gives 0: no vibrato. Ours follows the
C64 player (1 130 register-frames on voice 2 differ from gtref, which is the
editor's C code).

**Why kept:** `.sid`/`.prg` export will run `player.s` (D2), so the app
sounds like the file it exports. The editor's behaviour would be a one-line
change (`shift & 31` in `SidSongPlayer::speed` and `vibrato`).

### 4. Starting tempo at speed multipliers above 1. FIXED (2026-09-25)

GT starts every subsong at 6 frames per row per 1x (`6 * mult - 1` stored,
gplay.c:207-218), or at instrument 63's AD byte when instrument 63 has no
wave table and an AD of 2 or more (gplay.c:220-221, GT's hidden song tempo).
The player started at the doc's tempo whatever the multiplier, so a 2x
subsong with no F command on its first row ran twice as fast as in GT. The
flat model makes that easy to reach (delete the F), and a gate found it.

Fix: the doc's tempo is the start tempo at 1x (always 6 in a doc the app
writes, D6), and the player starts at `tempo * multiplier`, or at the hidden
tempo (`SidSongPlayer::start_tempo`). The TS side agrees (`sidImpliedTempo`,
`sidDocTiming`). Tests: `rust-wasm/src/sid/tests_start_tempo.rs`. Gates:
`start_tempo_gate.ts` (1x/2x/4x new songs with the F removed, and the hidden
tempo at 1x and 2x) 8/8 identical to gtref (2/8 before); every corpus subsong
plays byte-identical to before (all its multispeed songs set F on row 0).

The rejected alternative, `doc.tempo = 6 * mult` in the importer, would have
broken D6 (`.sng` export refuses a doc tempo other than 6).

## Deferred

### 5. Per-voice cursors in the tracker UI

The grid's playhead follows one row count, but a voice can run at its own
tempo (F with `$80`) or funktempo, and then drifts from the highlighted row.
Rare in the corpus; the flat model does not change it. Revisit if a user
meets it.

## Deliberate differences from GT

- **Past the end of a filter table's stored rows, ours stops.** GT would read
  zero rows there and set the cutoff to 0 every frame (for up to 255 frames).
  Only an unterminated table reaches that.
- **Wave-table commands `$F0`, `$F8` and `$FE`** stop the song in GT. Ours
  moves on to the next row.
- **Very first frames:** GT's first note sounds a constant `6 * mult - 1`
  frames after ours (5 at 1x). The gates allow for it; everything after is
  frame-locked.

Before `.sid`/`.prg` export (plan phase 4), the first two become "the app vs
the exported file" differences: either match GT, or have the exporter warn.

## The flat song model (plan-sid-authoring phase 2)

What the editor edits is a flat song compiled to GT's orderlists
(`src/audio/tracker/sid-doc/flat.ts`). Facts found building it:

- **A voice's pattern starts are audible:** GT skips a voice's pulse-table
  step on the frame it starts a pattern (gplay.c:853). Cutting every voice
  at every position changed 81 of 102 corpus subsongs; the flat song records
  each voice's starts, and compile cuts exactly there: 102/102 identical, in
  gtref and in our player, for 30 000 frames.
- **Exact loops need a long enough song:** a voice that loops back into the
  middle of its own pattern cannot be written as a GT orderlist (a loop goes
  to an entry). Flatten lays the song out until every voice is at one of its
  own pattern starts (e.g. "nintendometal" 1144 -> 6376 rows). Where that
  never happens or does not fit GT, a pattern is cut at the loop row, and GT
  skips one pulse step there per loop: corpus "forest_encounter" subsong 1
  (voices 1 and 2) and "investigations" (voice 2), inaudible there (gtref
  identical).

## Outstanding issues

- **`stinsen/game_tune` after its loop point (frame ~5122):** GT's running
  transpose (`F2` in the orderlist) carries round the loop. The doc can't hold
  that; the importer reports it as `loop-transpose`. A doc-model limit.
- **`yehar/b_o_f_h_ingame_death_victory` subsong 3:** one register-frame (the
  master volume, frame 0) differs from gtref. Not looked at.
- **6581 note onset (not re-measured):** voice 3 of "Coconut Conundrum" was
  0.875x GT's RMS on the first frame after the gate opens (8580: 0.99x).
  Chip-level (attack lag / `ATTACK_FLOOR`). Re-measure with KEEP=4 GT renders
  and `audio_cmp.py`.
- **Note-start DC step through the filter:** +0.061 in reSID vs -0.054 in ours
  before the polarity fix. Re-check the sign now that the polarity is fixed.
- **Hiss above 8 kHz at noise frequency $FFFF:** ours has less than reSID
  (boxcar decimation vs reSID's aliasing fast mode).
- **Chip profile selector:** no tracker or WASM setting chooses between the
  6581 profiles (GT_REF, the default, and R4AR) yet.
- **Unrelated, pre-existing:**
  - `rust-wasm/tests/ahx_render_golden.rs::manifest_covers_every_fixture`
    fails on a clean tree (fixtures on disk not in the manifest).
  - `npx tsc --noEmit` reports 93 errors, all in test files; the app's own
    check (`npx vue-tsc --noEmit`) is clean.
