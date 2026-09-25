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

The first two never reach an exported file. GoatTracker's own packer refuses
both songs ("TABLE EXECUTION OVERFLOWS", "ILLEGAL WAVETABLE COMMAND"), and
so does ours, with the reason (plan phase 4, decided 2026-09-25).

## GoatTracker's editor vs its C64 player (found by the `.sid` gate, 2026-09-25)

The app plays like GoatTracker's editor (`gplay.c`, gtref). An exported
`.sid` runs GoatTracker's C64 player (`player.s`), and the file is
byte-identical to GoatTracker 2.77's own export (`psid_gate.ts`, 400/400). A
6502 playing it against our Rust player, 30 000 frames, all 118 subsongs of
the corpus and new songs: 107 identical. Leaving out the first 30 frames,
pulse bit 0, and frequency/pulse while the waveform bits are 0 (all
inaudible). Where the two GoatTracker players part:

- **Pulse bit 0:** the editor writes `pulse & $FE`, the C64 player all 8
  bits. Inaudible (1/4096). Not compared.
- **Before a voice's first note** the C64 player runs effects (instrument 1's
  vibrato) on voices with waveform 0. Inaudible. Not compared.
- **A pulse row with modulation time 0** (`00 xx`): the editor stays on it and
  changes nothing; the C64 player counts down from 256 and sweeps. Audible.
  3 corpus songs (sniff, flumbos_keps, forced_entry).
- **A note past the note table** (index 96-127, after a transpose or a
  wave-table step): the editor plays frequency 0; the C64 player's table ends
  at the last note the song needs, so it reads the file's next bytes. Audible
  (noise drums), and depends on the file's layout. 7 subsongs.
- **A pulse or filter jump onto another jump row:** both treat that row as a
  "set" row, but the C64 player's table is renumbered and has only the rows a
  pointer or jump reaches, so the value and the row after it can differ.
  maximum_rastertime_test, kalachnikov/sid_warrior.
- **GT's optimized build (`SIMPLEPULSE`)** keeps a pulse in one nybble-swapped
  byte, so sweeps wrap and carry differently (7 subsongs), and writes the high
  nybble into the pulse low byte. The export dialog writes GT's "disable
  optimization" build (Morten, 2026-09-25), which has neither.
- **"Ballad"** (§3): the one of these where our player already follows the
  C64 player.
- **One frame of stinsen/tribal_tribunal voice 3** (frequency $2715 vs $2714
  at frame 3869, 7 frames in 30 000): not explained yet.

**Decision (Morten, 2026-09-25): the exporter warns** (pulse time 0, notes
past the table, jumps onto jumps: `gt-pack.ts` `tableDifferences` /
`noteRangeDifferences`). The file is still written, since it is GoatTracker's
own. `player.rs` is unchanged. Every non-identical subsong in the gate is one
the exporter warns about.

## A subsong switch in the `.prg` (plan-sid-authoring phase 5, found by `prg_play_gate.ts`)

GoatTracker's `mt_init` only stores the subsong; the next play resets 14
bytes a channel (sequencer, counters) and the filter step. The channels'
frequency, pulse, filter type and cutoff, and the operands the player
modifies in its own code stay as the subsong before left them. A SID
player reloads the whole `.sid` for another subsong, so there every
subsong starts from the loaded player. In the `.prg`, a key pressed
mid-song with init alone changed 73 of 118 subsongs audibly (from frame 1;
b_o_f_h subsong 4 for the whole run). **The shell copies the player's pages
(up to the song data, which is never written) aside at start and back
before every init**, so each subsong starts as its `.sid` does: 118/118
identical, from boot and after a switch.

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
