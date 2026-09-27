# Task: S3M playback — issues still open after O3b

Written 2026-09-27, after O3b landed (main `9d01e2c1`). Background and evidence:
`.ai/plan-opl.md`, "O3b — S3M engine fidelity". Reference throughout: st3play at
216b165183a657123e42aa1a5657086cbdb2cc59 (BSD-3); clone it, nothing is vendored.

Gate for anything touching S3M: `src/tests/s3m-adlib-st3-trace.test.ts` (pinned
unexplained-tick baselines — lower them, never raise them), then `npm run test:run` in full.
If event-stream goldens change, regenerate only the intended modules
(`EVENT_STREAM_UPDATE_GOLDENS=1 npx vitest run src/tests/tracker-playback-event-stream.test.ts -t <module>`)
and state per module why the new stream is right.

Current baselines: 8 of 10 songs exact; **koakuma 361**, **first-adlib-attempt 1**.

---

## 1. PCM c2spd: slides move the wrong period (HIGH — audible, widespread)

**What.** ST3 slides, vibrato and portamento act on the c2spd-*scaled* period
(`scalec2spd`, dig.c: `spd * 8363 / c2spd`). The engine moves the *unscaled* period and the
sampler folds c2spd into the root note (`import/s3m-samples.ts`,
`rootNote = S3M_ROOT_NOTE - 12*log2(c2spd/8363)`). In the unscaled domain ST3's step is
`d · r` with `r = c2spd / 8363`, so every slide, vibrato depth and porta speed on such a
sample is off by `r`.

**Scale (MEASURED, 2026-09-27 scan of `public/demos/s3m`).** 23 of 40 demos use pitch
effects (E F G H K L U) on PCM samples > 2 % off 8363; ratios 0.44 … 5.36. Worst: kraaap
5.36, distant_lullaby 3.99, astraying_voyages 3.35, 2nd_reality 3.31.

**Why it was left out.** No PCM oracle to gate it, and the fix needs the engine to know each
instrument's c2spd.

**Plan.**
1. Gate first: extend `src/tests/fixtures/opl/st3-traces/st3-adlib-trace.c` (or a sibling)
   to log each PCM channel's `aspd` per tick (`_zchn[0..15]`, changes only). Compare pitch
   *ratios* to the note's start: ST3 `(P/r + D)/(P/r)` equals ours `(P + D·r)/P` exactly when
   the engine is right, so the comparison needs no c2spd. Trace a handful of demos (kraaap,
   starshine, the_probe_maintheme, 2nd_reality, distant_lullaby), pin baselines.
2. Then carry per-instrument c2spd to the engine (Song-level data; store/builder plumbing)
   and run S3M pitch state in the scaled domain: note period, slides, vibrato, porta target
   and speed, and ST3's clamp (`aspdmin/aspdmax`) on the *scaled* period. Output frequency
   divided back by `r` for the sampler (its root note already folds c2spd).
3. The OPL driver currently rescales for itself via the pitch `source` ('table'/'target');
   once the engine is in the scaled domain the driver's `scaledBase + (period - periodBase)`
   logic should simplify — re-check koakuma (AdLib c2spd 33200) after.

Risk: changes pitch-effect output on most S3M demos; expect many golden regenerations.

## 2. Broken AdLib tone portamento (koakuma: 361 ticks)

`digadl.c` `doadlib`: on files with cwtv 0x1302–0x1320 or OpenMPT 0x5131–0x5FFF
(`brokenPortamentos`), a note under G sets `aorgspd` to the target immediately and never
touches `aspd`, so `s_toneslide` finds `aorgspd == asldspd` and slides nothing; the pitch
jumps to the note at the next row whose cell has no command or a D (docmd1's
`aspd = aorgspd`). All 361 of koakuma's ticks are pitch writes on OPL channel 0.
Needs: the file's cwtv reaching the engine or driver, and the engine's tone porta on OPL
instruments (`PlaybackOptions.oplInstrument`) holding pitch instead of sliding. AdLib only;
PCM portamento in `doamiga` is not broken.

## 3. Tone portamento lands one F-number short (first-adlib-attempt: 1 tick)

Tick 2260, OPL channel 6, a run of `G00`: ST3 ends on A6=A8, we stop at A7. Probably the
engine's porta target period vs ST3's integer `asldspd` (rounding). Low priority; check
together with item 1, which rewrites the porta domain.

## 4. Smaller ST3 deviations, not modelled

- **Old-ST2 vibrato** (header flags & 1, `oldstvib`): H is `>> 4` instead of `>> 5`, U `>> 6`
  instead of `>> 7`. Parsed as `S3mSong.st2Vibrato`, passed into the tracker song by
  `s3m-import.ts`, but never reaches the engine. No demo checked for it yet.
- **R (tremolo) shares `avibcnt` with vibrato** (`s_tremolo` reads and advances the same
  counter). The engine keeps separate positions.
- **Vibrato waveform 3 ("random")** adds `patmusicrand & 0x1E` to the position; we play a
  plain sine (deterministic on purpose).
- **PCM `^^` zeroes the channel volume** (`doamiga`: `ch->avol = 0` before the cell's own
  volume) — a later instrument-less note inherits 0 in ST3.
- **SD0** never plays the cell in ST3 (`anotedelaycnt` 0 never fires); check what the
  engine does for all formats (ProTracker plays ED0 normally).
- **Key-off + SDx on one cell** would delay the key-off in ST3; the engine keys off on
  tick 0. None in the corpus (scanned).
- **Pattern loop inside a delayed row**: ST3 re-runs `docmd1` on repeats, so SBx is
  evaluated again; the engine skips flow commands on repeats.
- **Tracks the row omits and `docmd1`**: the trailing-pass snap-back handles vibrato and
  arpeggio; other `aspd != aorgspd` sources (e.g. a held offset after a non-D command) are
  only reset when a later cell with a step arrives.

## 5. Other formats noticed along the way (not S3M, unverified)

- **FT2 key-off rows**: `getNewNote` runs `handleEffects_TickZero` after `keyOff`, so the
  volume column and effect apply on a key-off row. The engine still drops them for XM
  (`noteOffRowRunsCell` is S3M only) because FT2's key-off volume rules differ.
- **FT2 arpeggio reset on an empty cell**: `getNewNote` sets the period back when
  `ch->efx == 0 && ch->efxData > 0`. Not checked against the engine.
- **`rowHasPatDelay` + Dxx**: `row-scheduler.ts` adds one to a break target when the row's
  pattern delay comes first (pinned in `engine-pattern-delay.spec.ts`). Unverified against
  PT/FT2 sources.
- **ProTracker fine slides during a pattern delay** re-apply on each repeat
  (`checkEffects` on tick 0 → E1x/E2x/EAx/EBx with `tick == 0`); the engine runs tick-N
  handlers on repeat tick 0 but does not re-apply tick-0-only fine slides.
