# Prompt: verify every remaining tracker effect against a reference implementation

Paste the section below into a new session.

---

I want you to audit this project's tracker effect handling against the reference
implementations, the same way D80 and D82 were done, and fix what you find.

## Why

Most of the effect bugs found in this project so far were found *by ear*, one symptom at a
time, and each fix was reasoned from a plausible reading of what the format "should" do.
That produced a string of correct-but-narrow fixes and several assumptions that turned out to
be guesses — the XM portamento period clamp (D80) and the fadeout constant (D82) were both
wrong for years, and one of them had a source comment openly admitting it was unverified.

Checking against the actual replayer source settled each of those in minutes and produced a
much better fix than reasoning would have. I want that done systematically for everything
that has *not* had it.

## The method that worked — follow it

1. **Read the reference source, don't recall it.** Fetch the file and quote the routine
   verbatim in your reasoning. Do not answer from memory about what FT2 or ProTracker does;
   memory is exactly what produced the wrong constants.
2. **Compute the concrete numbers** for a real case from the corpus — not "this is roughly
   twice as fast", but "at speed 6 and 118 BPM this reaches period 11200, which is 1/1024 of
   the note, where we produce 1/43".
3. **Measure the corpus** before changing shared behaviour: how many modules, instruments, or
   commands does this actually touch? `public/demos` has 61 modules (43 MOD in `amiga/`, 18 XM
   in `ft2/`). Write a throwaway test that walks them and prints counts. Several times this
   turned "probably harmless" into "binding in five songs" or the reverse.
4. **Write tests that fail against the old code**, and say so explicitly — `git stash` the fix,
   run them, report the count. A test that passes both ways pins nothing.
5. **Record it** as a new decision-log entry in `PLAN-module-format-support.md` (next free D
   number), with the quoted reference code, the measured numbers, and anything you chose *not*
   to change and why. Add the one-line change-log row too.

## Reference sources

Both are 8bitbubsy's cycle-accurate clones and are the authority here. `WebFetch` works on
`raw.githubusercontent.com`.

- **FT2 / XM** — `https://raw.githubusercontent.com/8bitbubsy/ft2-clone/master/src/ft2_replayer.c`
  (effect routines, envelope/fadeout handling, `period2Ft2Delta`), and
  `.../src/modloaders/ft2_load_xm.c` for how header fields are stored (check for scaling
  before trusting a constant).
- **ProTracker / MOD** — `https://raw.githubusercontent.com/8bitbubsy/pt2-clone/master/src/pt2_replayer.c`.
  Confirmed to define `arpeggio`, `portaUp`, `portaDown`, `tonePortamento`, `vibrato`,
  `tremolo`, `volumeSlide`, `volumeFineUp/Down`, `noteCut`, `noteDelay`, `sampleOffset`,
  `retrigNote`, `tonePlusVolSlide`, `vibratoPlusVolSlide`, `funkIt`/`updateFunk`,
  `filterOnOff`, `finePortaUp/Down`, `setGlissControl`, `setVibratoControl`, `setFineTune`,
  `jumpLoop`, `setTremoloControl`, `karplusStrong`, `patternDelay`, `positionJump`,
  `patternBreak`, `setSpeed`, `volumeChange`.
- OpenMPT's format documentation is a useful cross-check for *which* quirks exist, but quote
  the C, not the wiki, when fixing a number.

## Where the code lives

- `packages/tracker-playback/src/effect-processor.ts` — the per-effect state machine, tick 0
  and ticks 1..n. Most effects live here.
- `packages/tracker-playback/src/engine.ts` — row scheduling and the effects handled outside
  the processor: `Fxx` speed/tempo, `Bxx`/`Dxx`, `E6x`, `EEx`, `Gxx`/`Hxy`.
- `packages/tracker-playback/src/pitch-model.ts` — period/frequency per format, and the
  portamento clamps.
- `packages/tracker-playback/src/format-profile.ts` — **where per-format quirks belong.** If
  MOD and XM disagree, add a profile field; don't branch on the format inline (D17–D21).
- `packages/tracker-playback/src/mod-parser.ts`, `.../formats/xm.ts` — parsers; they report
  the file and interpret nothing (D23).
- `packages/tracker-playback/src/note-utils.ts` — note, volume and effect *text* parsing,
  plus `decodeRawEffect` for the raw format-native bytes.
- `packages/tracker-playback/src/import/{mod,xm,s3m}-patterns.ts` — cells → tracker rows,
  where a format's effect bytes become an entry's `effectCommand`/`effectParam`.
- `src/audio/tracker/mod-import.ts`, `xm-import.ts`, `s3m-import.ts` — the instrument half
  only: samples → slots and sampler patches, including envelopes.
- `src/audio/mod-instrument.ts` — voices, volume/panning envelopes, fadeout, autovibrato.
- `src/audio/tracker/song-bank.ts` — voice allocation and per-voice command routing.

To see what an effect actually schedules, drive `PlaybackEngine` directly: `loadSong`,
`loadPattern(id)`, then call the private `scheduleRow(row, time)` in a loop, with handlers that
log. That is how D77, D79 and D80 were each pinned.

## Already verified against a reference — do not redo

`Gxx` set global volume (D80), the XM portamento period clamps (D80), XM volume envelope
sustain/key-off semantics and the fadeout constant (D82), XM key-off with no volume envelope
(D63), the XM Amiga vs linear frequency tables (D24, D59), `E5x` finetune's differing meaning
per format (D51), vibrato/tremolo/fine-porta depths and units (D48), `ECx` (D49), `Axy` slide
rate (D16), `A00` memory (D20), `9xx` sample offset (D46/D47).

## Known open, already investigated — don't rediscover

- **D71** — `EEx` pattern delay repeats one time short (`EE2` plays the row twice, ProTracker
  plays it `param + 1` times). Pinned in a test.
- **D81** — `Hxy` global volume slide runs once per row; FT2 runs it once per tick, and it also
  lacks FT2's parameter memory and nibble precedence. Pinned in a test. Verified against
  ft2-clone already; only the fix is outstanding, and it needs the slide moved into the tick
  loop.

Either fix these deliberately (with corpus measurement first — `Hxy` appears in one module,
`EEx` in two) or leave them; don't re-derive them.

## Must not regress

- **Ultimate Soundtracker support (D73).** `mod-import`/`mod-parser` detect UST from the data
  and treat it as its own format: arpeggio is command **1** there, not 0, and sample loop
  starts are **byte** offsets, not words. pt2-clone is ProTracker, not UST, so do not
  "correct" these against it. `lepeltheme.mod` needs the UST reading and `jackdance.mod` is the
  over-detection boundary — both are in the corpus and both have tests.
- **The channel-addressing rule (D78).** Only a row that starts a note changes what a channel
  is playing, and every per-voice command must address the voice that is sounding. Several
  import-side rules (D29, D55, D68, D77) exist to protect it.
- The declared-but-unimplemented ProTracker effects `E0x` (Amiga filter) and `EFx` (funk
  repeat / `funkIt`) are known gaps, not regressions. Decide explicitly whether they are worth
  implementing; `EFx` has a real routine in pt2-clone.

## Constraints

- **No browser automation here, so nothing can be checked by ear.** Assert on scheduled
  commands and computed values, never on sound. Every claim in your write-up must come from
  quoted source, a measured corpus number, or a test.
- `npm run test` (931 at time of writing), `npm run lint`, and `npx quasar build` must all
  pass — note `npx tsc` alone does **not** type-check Vue templates.
- Prefer measuring to assuming. If you cannot verify something, say so and leave it, the way
  D81 was left.

## What to produce

Work through the effects in order of how much the corpus actually uses them (§6e of
`PLAN-module-format-support.md` has counts, and note its warning: the two formats rank effects
very differently, so "rare enough to skip" has to be asked per format). For each one, either:

- **verified correct** — say so, with the quoted routine and the case you checked it against;
- **fixed** — with a decision-log entry, corpus impact, and tests confirmed failing against the
  old code; or
- **open** — with what you found, what you could not settle, and why, following D81's shape.

Start by giving me the list of effects you intend to check and the order, ranked by corpus
usage, before you start fixing anything.
