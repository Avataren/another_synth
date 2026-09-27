# O7 progress (A2M player) — handoff, 2026-09-27 (session 3)

**Session 3 status (supersedes "Where things stand" and open items 1-3 below):**
batches 7-9 committed (`8d43d113`, `b3f84da2`, `ce533e0f`). The engine's register state
equals AdPlug's for every tick of every corpus song as AdPlug plays it (end flag, cap 120000)
on 277/278 files; the instrument set is refused at load (`A2Engine::refusal`). The gate is a
Rust test (`tests.rs`: `engine_state_matches_adplug_for_whole_songs`, `..._on_probes`) over
`oracle/gate.tsv` + `oracle/probes.tsv` (298 probes, songs in `gate.rs` sparse form), made by
`oracle/regen-gate.sh`. Dev: `oracle/dev/{both.sh,sweep.sh,full.py}` (need $A2M_SCRATCH).
Batch 10 (`e665fa40`): `A2Player` (`opl/a2/player.rs`: load/refuse, play/pause, seek by silent
replay, set_loop_order, song_end_reached, mute/solo over tracks -> channel mask, taps +
track_channel, info getters) and the song mode of `opl-audio-processor` (`opl-core.ts`:
load-a2m/unload-song/play/pause/seek/set-loop-order/set-mute-solo/set-stop-at-end; events
song-loaded(info)/position(order,pattern,row)/song-end/error{id}); tests in
`src/tests/opl-worklet-core.test.ts`.
Next: O7 step 4 (tracker hookup), then step 5 (audio A/B + landing record). Step 4 design notes:
- ModuleFormat has no 'a2m' yet (`packages/tracker-playback/src/types.ts` + MODULE_FORMATS;
  ~33 format branches in 11 app files, see `grep -rn "=== 'sid'"`), plus a format brand.
- The wasm is only instantiated in worklets, and the grid needs the song's cells: plan is an
  A2Player method returning a pattern's packed cells, sent with `song-loaded` for the patterns
  the order list uses; the import is then async (load in the worklet, build the display
  TrackerSongFile from `info`), playback-only like AHX (`ahx-import.ts`, `AhxSongTransport`
  in `tracker-playback-store.ts`); file detection in `useTrackerFileIO.parseSongBuffer`
  (magic `_A2module_`). Sequence = order positions; tracks = info.tracks; per-track scopes
  from tap output 1 + info.trackChannels[t].
AdPlug-vs-AT2 choices found this session (for the landing record): &4x without a note is not
skipped under porta/note delay; combined effect with 00 and nothing to reuse still runs (AT2
drops it); global slide only on later tracks whose column is free (AT2: all later tracks); v1
FFy all ZF0 and FA-FD always modulator (AT2 maps FF1-9 to locks/modes/carrier toggle); tremor
count restarts on previous-row rule while saved level follows last_effect; retrigger count
from 1 follows last_effect.


Read with `.ai/plan-opl.md` (§3, §4, §6 incl. the D1 relaxation note, O6 record) and
`.ai/opl-next-session-prompt.md`. Commits: `14f3f8d5`, `701d87fe`, `66e2fad3`, `398df56d`
(batches 1–4), `5ed81cf4` (batch 5), batch 6 (this session's second commit).

## Where things stand

- `rust-wasm/src/opl/a2/engine.rs` — `A2Engine`, emits register writes to a `RegisterSink`.
  `adplug_quirks` = reproduce AdPlug-only behaviour (on in `a2m_tool cmp` only).
- **Gate (per-tick register STATE vs AdPlug, 3000 ticks, `A2M_STATE=1`): 263 of 278 corpus files
  match, all 17 tier-1 files match.** All ~270 probes pass (`dev/runprobes.sh`).
- Remaining 15 (first differing tick): instrument set #001 (0 — order list is only markers:
  refuse at load, AdPlug releases every channel and ends), rainbow factory 462, class05 618,
  LIMITBRK 806, oskari's returns 1142, TG_VEGAS 1158, pink chiptune 1162, crack it 1170,
  oskari wins 1849, bring the pain 1988, battletoads 2052, mutable signs 2694,
  c3 comp entry 2695, complete devastation 2883, clear 2985. Not yet looked at.
- Nothing exported to wasm yet; no worklet, no app hookup (O7 prompt steps 3–5).

## D1 relaxed (Morten: "just peek at at2 source, for debugging the last issues")

AT2 source cloned at `.ai/at2-src` (github.com/ivan-tat/at2 @ 336fbdd, gitignored). Useful
files: `adt2unit/pas/play_line.pas` (row logic, read in full), `adt2unit/*.c` (C port of the
player — closest to what AdPlug's `a2m-v2` derives from; e.g. `macro_poll_proc.c`,
`update_effects.c`, `output_note.c`, `set_ins_volume.c`, `calc_freq_shift_*.c`),
`formats/a2m/get_pat_event_a2m_v{1,5}.c` (old effect conversion), `check_crc32_a2m.c` (would
settle O6's unverified header check value). Read for semantics; the Rust is written fresh.
**Current AT2 ≠ AdPlug** in places (AdPlug ports an older AT2). AdPlug stays the gate; AT2 is
used to form hypotheses, then probed. Record which one play follows in the landing record.

## Rules pinned this session (all commented in engine.rs)

- Old effects: v1–4 table + FFy/FAy..FDy; v5–8 identity except 0x16 (manual slide → &4x/&5y:
  with no note it adds to block+F-number raw), ZC/ZD dropped. AT2's converter also maps
  FF1..FF9 to ZF2/ZF3/ZF4/ZF5/(ADSR target toggle)/ZF7/ZF6/ZF8 and F2y y=4..7 to a modulator
  waveform, and FA–FD depend on a per-channel toggle (FF5/FF6) — **not implemented** (no corpus
  file uses them; my earlier AdPlug probe of FF3/FF7 looked like ZF0 — recheck before relying).
- Volume scaling (flag bit 7): sounding ops relative to the instrument's TL; reset level 0 for
  carrier/additive modulator only (percussion modulator keeps its TL, then scaled again).
- Voice = track's instrument or t+1 before any: decides additive, 0C/28 no-op on empty voice.
- 4-op pairs: key/pitch/key-bit shared on the second track's channel; 4-op volume lock
  (lock bit 6, ZE5/ZE6 per pair); FM-macro retrigger only from the second track, which also
  restarts the first track's tables.
- Tone porta 03: armed per column by a note with 03; one-shot effects keep it, running ones
  disarm and zero its own speed. ZE2/ZE3 force-key. ZFF no-restart; ZFF + 26/27 = legato.
- Arpeggio restore also for 18/19 (base counts as step 0); arpeggio table has its own base
  note (`arp_note`); 26/27 swap after the note.
- Tremor saves/restores its start level; AdPlug quirk: column-2 tremolo only ever louder.
- Vibrato table: AT2 base-pitch model (`vib_freq`), reset by any pitch change incl. the
  arpeggio table; key-off restart also resets its count (not its delay).
- Pitch: AT2 `calc_freq_shift_up/down` (single wrap, wraps even for 0), porta limits
  nFreq(0)=0x157 / nFreq(97)=block 7 0x2AE, nFreq caps notes ≥97, finetune added to the whole
  word, 13-bit mask on writes; vibrato position advances on idle tracks.
- FM macro flags 0x80 retrig, 0x40 envelope restart, 0x20 zero pitch until next step.
- Declared track count (`song.tracks`) limits the tracks played; fixed notes (0x90+n).
- Retrig counter zeroed on non-retrig rows; one-shot effects don't become "last effect".
- Pan lock: reload takes lock-flag panning; FM-macro panning ignored under lock.

## Tools

Scratch setup (dev scripts now read `$A2M_SCRATCH`): build `trace-oracle`
(`g++ -O1 oracle/trace-oracle.cpp -I$P/include -I$P/include/adplug -L$P/lib -ladplug -llibbinio`,
`P=.ai/adplug-oracle/prefix`), copy `oracle/dev/*` and `oracle/probes/*.py` (into
`$A2M_SCRATCH/probes/`) there, write `tier1.txt` / `all.txt` (corpus-relative paths, one per
line). Then `A2M_SCRATCH=... A2M_STATE=1 LIST=$A2M_SCRATCH/all.txt bash dev/tier1.sh` sweeps the
corpus in ~5 s; `dev/cmp.sh <file> [ticks] [show]` shows diffs (the position label lags one
row: it is the position *before* the tick); `dev/pp.sh VER FX P` is a quick two-track probe.
`a2m_tool mine <file> <ticks> <regs>` prints the engine's writes; `fx4op` lists 4-op effects.

## Open items, in order

1. The 14 remaining corpus divergences (above), same method: `cmp.sh`, dump the row, read the
   AT2 routine, probe AdPlug, implement, rerun probes + sweep.
2. Extend the gate to full song length (until AdPlug's `ended` flag in the trace header).
3. Commit the gate as a Rust test: per-file per-tick state hashes (FNV per 64-tick chunk)
   from a `regen` script, plus the probe suite as TSV (the test must not need AdPlug).
4. O7 steps 3–5: `A2Player` wasm class (engine + `Chip` + resampler, stepped at
   `refresh()`), worklet / `opl-audio-processor` mode (load, play/pause, seek, loop,
   mute/solo, scope taps), tracker hookup like AHX/SID, truthful refusal at load (e.g. an
   order list with no pattern).
5. Audio A/B vs AdPlug renders (`trace-oracle render`), CoT vs the SB16 recording, Morten's
   ears, O7 landing record in the plan (list every AdPlug-vs-AT2 choice: arpeggio-table
   off-by-one, column-2 tremolo, empty-ADSR mute workaround not in AdPlug, porta after an
   empty row, key-off vibrato restart, old FFy mapping).
