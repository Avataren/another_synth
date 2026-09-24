# SID player: open decisions and outstanding issues

State after v0.3.78 (S5.19, commit `4337c998`). The player now writes all 25 SID
registers the way GoatTracker 2.72's own playroutine does on 83 of the 84 corpus
songs. Details are in AGENTS.md under "SID player: every register against GT's
playroutine (S5.19)". The oracle tools are in `.ai/sid-oracle/`.

## Decisions needed

### 1. Should songs made in the app get GT's timing too?

The GT behaviour now applies to every song, not only imported ones:

- the pulse table skips the row-read frame, a note's frame and the first frame
  of a pattern's last row (GT's default `optimizepulse`);
- filter changes (instrument, table, commands A/B/C/D) are heard one frame
  later, because GT sets $15-$18 at the top of the frame;
- the cutoff wraps instead of clamping at 0 / $FF;
- a note with a wave table keeps the old pitch for its first frame.

It's all GT's behaviour, and a song exported to `.sng` plays the same in GT,
but app-made songs sound slightly different from before v0.3.78.

- **Keep (current):** one set of rules; the app plays what GT plays.
- **Alternative:** a per-song "GT-exact" switch, on for imports and off for new
  songs. That adds a format field and a second code path.

### 2. Waveform 0 marks an instrument as "GT-style"

An instrument whose own waveform is 0 (what the importer writes) follows GT's
rules:

- the first-frame byte is held as the waveform until the wave table sets one;
- first-frame `$00` leaves both the waveform and the gate alone;
- `$FE`/`$FF` set the gate only;
- the wave table is skipped on the note's frame;
- an all-zero filter leaves the voice's filter routing alone.

**The catch:** with first-frame `$00`, a note on a fresh channel keeps the gate
shut, so it's silent. GT does the same (`initchannels` zeroes the gate). An app
user who sets waveform 0 with first-frame 0 will hit it.

Options:
- keep it;
- warn in the instrument editor when waveform 0 is combined with first-frame 0;
- add an explicit "GT-style" flag to the instrument instead of inferring it.

### 3. "Ballad": GT's editor or GT's C64 player?

"Ballad" is the only corpus song still off (1 130 register-frames, voice 2
frequency). It uses a fine vibrato with shift `$42` (66):

- **GT's editor** (C on x86) shifts by 66 mod 32 = 2, so you hear vibrato.
- **GT's C64 player** (`player.s`, one `lsr` per count) shifts 66 times, which
  gives 0: no vibrato. Ours does the same.

The composer probably heard vibrato in the editor, but the exported `.sid` has
none. Switching to the editor's behaviour is a one-line change in
`SidSongPlayer::speed` and `vibrato` (use `shift & 31`).

### 4. Starting tempo at speed multipliers above 1

The importer sets `tempo = 6` at any multiplier. GT starts every channel at
`6 * mult - 1` (12 frames per row at 2x), with funktempo defaults
`9*mult-1` / `6*mult-1`. The player already uses the multiplied funk defaults.

All four 2x corpus songs set their tempo with an F command on row 0, so they
match GT exactly at `MULT=2` for 8000 frames. A 2x song without that command
would play twice as fast as in GT.

The fix would set `doc.tempo = 6 * mult` in the importer. That also moves the
TS timing (`sidDocTiming`) and the projected grid, so it needs a look at the UI
side too.

### 5. Per-channel cursors in the tracker UI

`sidDocTiming` and `projectSidPatterns` still assume one global tempo, but the
audio now has per-channel tempo (command F with `$80`) and funktempo. The
playhead follows the longest channel, so it stays coherent, but a channel
running at its own tempo drifts from the highlighted grid row. Does the UI need
per-channel cursors?

## Deliberate differences from GT

- **Past the end of a filter table's stored rows, ours stops.** GT would read
  zero rows there and set the cutoff to 0 every frame (for up to 255 frames).
  Only an unterminated table, which in practice means an app-made one, reaches
  that. The pulse table matches GT there anyway (it stalls).
- **Wave-table commands `$F0`, `$F8` and `$FE`** stop the song in GT. Ours just
  moves on to the next row.
- **Very first frames of a song:** GT's first note sounds a constant 5 frames
  after ours (11 at 2x speed). Everything after that is frame-locked.

## Outstanding issues

- **`stinsen/game_tune` after its loop point (frame ~5122):** GT's running
  transpose (`F2` in the orderlist) carries round the loop. The doc can't hold
  that, and the importer reports it as `loop-transpose`. It's a limit of the doc
  model, not the player.
- **6581 note onset (not re-measured):** voice 3 of "Coconut Conundrum" was
  0.875x GT's RMS on the first frame after the gate opens (8580: 0.99x). This is
  chip-level (attack lag / `ATTACK_FLOOR`). Worth re-measuring now that the
  register streams match, with KEEP=4 GT renders and `audio_cmp.py`.
- **Note-start DC step through the filter:** +0.061 in reSID vs -0.054 in ours
  before the polarity fix. Re-check the sign now that the polarity is fixed.
- **Hiss above 8 kHz at noise frequency $FFFF:** ours has less than reSID
  (boxcar decimation vs reSID's aliasing fast mode).
- **Chip profile selector:** there's no tracker or WASM setting to choose
  between the 6581 profiles R4AR and GT_REF yet.
- **Unrelated, pre-existing:**
  - `rust-wasm/tests/ahx_render_golden.rs::manifest_covers_every_fixture` fails
    on a clean tree (99 fixtures on disk, 24 in the manifest).
  - `npx tsc --noEmit` reports 93 errors in 13 test files (AHX pages,
    `pattern-canvas`, `tracker-pattern-buffer`, and others). The same set
    appears before and after S5.19; the older notes say "3 known errors".
