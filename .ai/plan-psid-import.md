# Plan: import `.sid` (PSID/RSID) files as editable GoatTracker songs

Status: **PHASES 1-4 LANDED 2026-09-26** on branch `claude/wonderful-gauss-ycn0ve` (phase 5
refinements open; see §6 and §7). Follows
`.ai/plan-sid-authoring.md` (phases 1-5 landed: GT-native doc, `.sng` export, flat song
model, new SID songs, `.sid`/`.prg`/`.bin` export with GoatTracker's own `player.s`).

Brief (Morten, 2026-09-26): import PSID files directly and compile them into the
GoatTracker-shaped song the tracker already edits, so an imported `.sid` can be edited and
exported to `.sng`, `.sid`, `.prg` like any SID song. Test against famous SIDs. Consider
ChiptuneSAK (https://github.com/c64cryptoboy/ChiptuneSAK) as a tool; my call.

---

## 1. What a `.sid` is, and why this is two problems

A `.sid` holds **6502 machine code**: a player routine plus its data, and the addresses to
call (init with the subsong in A, then play once per frame, or the tune installs its own
interrupt). There is no song data format to parse in general; every composer's player keeps
notes and instruments its own way. So:

- **Any player (the famous ones: Hubbard, Galway, Tel, Daglish, ...):** run the code on an
  emulated C64, record what it writes to the SID every frame, and **transcribe** that register
  stream into GoatTracker's model (notes on rows, instruments as wave/pulse/filter tables,
  vibrato, hard restart). Lossy by nature; the result is measured, not assumed (§4).
- **A tune made with GoatTracker** (thousands in HVSC, and every `.sid` this app exports): the
  file holds `player.s` and GT's packed data. That can be **unpacked exactly**, the inverse of
  `sid-export/gt-pack.ts`, giving back the song as its author wrote it.

## 2. Decisions

**D1. ChiptuneSAK: not a dependency; a reference.** Read at `c64cryptoboy/ChiptuneSAK@master`
(MIT). Its SID import (`chiptunesak/sid.py`) emulates the tune with a thin C64 layer and
extracts **notes only**: every note gets instrument 1 (`rc_row.instr_num = 1  # FUTURE: Do
something with instruments?`), so its GoatTracker export (`goat_tracker.py`) plays the right
pitches with a generic sound. It is Python, so it cannot run in the browser, and the part that
matters most here (turning a player's sound into GT instruments) is the part it does not do.
What we take from it, as facts: the PSID environment rules (bank setup per call address, CIA
timer defaults, the KERNAL IRQ exit range `$EA31-$EA83` as the end of a play call), and the
idea of tuning detection. Its test tune `Defender_of_the_Crown.sid` is a candidate fixture.

**D2. Our own emulator, in TypeScript, app code.** A 6510 with every opcode the NMOS part runs
(illegal ones included; players use them), decimal mode, cycle counts, IRQ/NMI; a C64 bus with
the `$01` banking, CIA 1/2 timers and interrupts, the VIC's raster counter and raster IRQ, and
the SID's registers recorded with the cycle of every write. **No ROM images** (not ours to
ship): a tiny stand-in KERNAL of our own (IRQ/NMI entry and exit, vectors, `RTS` elsewhere),
visible when `$01` banks the KERNAL in. `src/tests/helpers/cpu6502.ts` stays as an independent
test CPU: both must play every GT export identically.

**D3. Scope of files.** PSID v1-v4 fully (VBI or CIA speed, play address 0 = the tune's own
interrupt). RSID best effort (the tune's own interrupts; C64 BASIC tunes refused: no BASIC
ROM). Two/three-SID tunes: the first SID is imported (GoatTracker is single-SID), with a note.
PAL is GoatTracker's clock; an NTSC tune's pitches are mapped by its own clock (right notes),
and its tempo is noted.

**D4. What "transcribe" produces.** A normal `SidDoc` through the flat model
(`compileSidFlatSong`: shared patterns, orderlists, per-voice restarts), so the song is edited,
played and exported by the code that exists. Per PSID subsong one GT subsong (start song
first) while GoatTracker's limits hold (63 instruments, 255 rows per table, 208 patterns, 32
subsongs, 254-byte orderlists); what does not fit is dropped with a note naming it.

**D5. Capture length and loops.** Each subsong runs until the machine repeats a state it was in
at an earlier frame (RAM, SID registers and CIA setup hashed incrementally, Zobrist-style, on
every write): from there the music repeats exactly, so the capture stops and the GT orderlists
restart at that row. A tune that never repeats (a free-running counter) is cut at a cap and
loops to its start. Writes made inside an NMI handler stay out of the hash: a digi tune's
sample pointer never repeats, and would hide the song's loop (Giana's title: exact loop at
tick 9985 of 21123 once its NMIs were left out; before, it ran the whole 600 s cap).

**D6. Fidelity is measured.** The transcribed doc is exported with the app's own `.sid`
exporter and played on the same emulator; per voice per frame the two register streams are
compared: pitch within 50 cents, whether the voice sounds (gate on, test bit off), waveform,
envelope settings at note starts, pulse width, filter, and the **envelope level** the SID makes
of the writes (`psid/envelope.ts`: the chip's rate counter, exponential decay, sustain and zero
holds, and its ADSR delay bug). Exact loops are unrolled, so a short song is compared past its
first pass. The score is an import note, and the corpus tests pin it per fixture.

The level term came from a bug the register comparison could not see: transcribed notes
started with the gate off on tick 0 (so the pitch would land on the gate-on frame) let the
note's own slow release rate run the envelope's rate counter for a frame, and the chip's ADSR
delay bug then held the attack for up to 33 ms. Commando's one-frame drum hits played no sound
at all in the app, while every register matched.

**D7. How a note starts is chosen by the envelope.** GoatTracker writes a new note's
attack/decay, sustain/release and first-frame waveform on the row's first tick, and its pitch
on the next (the wave table's first row). So the row starts one frame before the original's
gate-on, and the first frame is either `$09` (gate on, test bit silencing the old pitch: the
envelope starts a frame early, right after the gate-off or hard restart, and no delay bug) or
the gate off in the original's waveform (the attack on the original's frame; needed where the
original's one frame of gate-off *is* that frame, or the note would never retrigger). Per note
both are simulated from where the original's gate went off, against the original's envelope;
the instrument takes what its notes' summed difference favours.

## 3. The transcriber (what the Hubbard fixtures showed)

Measured on the four fixtures (§5) before writing it:

- **Timing:** Commando and Crazy Comets start every note on a 6-frame grid (tempo 6);
  Knucklebusters alternates 9 and 10 frames per row (GT funktempo `E` / `F00-F02`).
- **Note start:** pitch and gate change on the same frame. GoatTracker writes a new note's
  pitch one frame after its gate (the wave table's first row). Transcription starts GT's row one
  frame early, its first frame chosen per D7, so the wave table's first row sets waveform and
  pitch on the original's frame.
- **Hard restart:** ADSR `0000` three frames before the next note; gate off earlier still.
  GT's gate timer + hard restart.
- **Instruments:** per-frame waveform programs (noise click, then pulse), octave arpeggios
  every frame, drums with absolute pitches: GT wave table rows (relative / absolute notes,
  delays, loops).
- **Vibrato:** Hubbard's depth is (next semitone's frequency - this one's) >> n, GT's
  "calculated speed" speed-table entry exactly; his shape is one-sided (0..+3 units), GT's is
  symmetric: an approximation.
- **Pulse:** sweeps that bounce or wrap within the low byte, and pulse state kept per
  instrument across notes: GT pulse tables restart per note, so the phase is approximate.

Pipeline: trace -> per-voice note events (gate edges, intra-frame retriggers) -> tempo grid
(single tempo or two alternating) -> per-note register programs -> instrument clusters ->
GT instruments and tables -> rows (note, instrument, key-off, commands) -> flat subsong ->
`compileSidFlatSong` -> doc; then §D6.

## 4. Phases

Each phase lands on its own with tests (red-first where it changes behaviour), `npm run
test:run`, eslint, `vue-tsc`, and a checks file.

1. **Emulator + trace** (`src/audio/tracker/psid/`): PSID/RSID parser, 6510, C64 machine,
   driver (init/play, VBI/CIA rate, IRQ mode, RSID), per-frame register trace with intra-frame
   gate/test pulses, loop detection, digi detection (many `$D418` writes). Gates: every corpus
   GT export gives the same registers as the test CPU; the four fixtures run every subsong;
   Chimera (RSID, play 0) produces sound.
2. **Transcriber v1 + fidelity:** §3. Gates: fidelity floors per fixture subsong; the GT corpus
   exported to `.sid` and transcribed back (known notes: note-level accuracy).
3. **App wiring:** open/drop `.sid`; the import's method, fidelity and notes shown; export back
   to `.sng`/`.sid`/`.prg`.
4. **Exact GoatTracker unpack:** identify `player.s`'s build in the file (assemble candidate
   define sets with `asm6502.ts`, match code, read the data labels' addresses from operands),
   invert `gt-pack.ts`. Gate: the 84-song corpus, exported and imported, gives the same doc
   (flat-compile equal) and identical register streams.
5. **Refinements**, by measured payoff: portamento and legato (`3xx`), continuous pulse,
   filter sweeps, per-voice note offsets, NTSC tempo mapping.

## 5. Test material

- `src/tests/fixtures/psid/`: 16 tunes Morten provided on 2026-09-26 (Hubbard: Commando, Crazy
  Comets, Knucklebusters, Chimera; Galway: Arkanoid, Comic Bakery, Commando High-Score, Ocean
  Loaders 1 and 2; Daglish: Krakout, The Last Ninja; Hülsbeck: Great Giana Sisters, R-Type; Tel:
  Golden Axe, RoboCop 3), plus ChiptuneSAK's Defender of the Crown and its NTSC GoatTracker
  export `vibratotest.sid`; provenance and hashes in its README.
- The 84-song GoatTracker corpus through our `.sid` exporter: real music with known notes.
- HVSC and ModLand are denied by this session's network policy (`hvsc.c64.org`,
  `ftp.modland.com`, `csdb.dk` return 403 from the proxy). More famous tunes arrive when that
  opens or when Morten uploads them; the fixture README lists what to fetch.

## 6. Where it stands (2026-09-26)

Landed: `src/audio/tracker/psid/` (parser, `mos6510.ts`, `c64.ts`, `sid-capture.ts`,
`envelope.ts`, `transcribe/`, `fidelity.ts`, `index.ts`, `psid-import-worker.ts`),
`psid-import.ts` (the app's `.sid` open/drop path, through the worker; the summary is told
when the song is applied), the tests
`src/tests/psid-{file,cpu,capture,envelope,transcribe,load-chain,import-worker}.test.ts`, and
the demo browser's C64 SID collection (`public/demos/sid/`, `psid-demo-load-chain.test.ts`).

Start songs, imported alone (fidelity, D6 with the level term):

| Tune | Score | | Tune | Score |
|---|---|---|---|---|
| Commando | 0.956 | | Krakout | 0.976 |
| Crazy Comets | 0.902 | | The Last Ninja | 0.869 |
| Knucklebusters | 0.963 | | Great Giana Sisters | 0.991 |
| Chimera | 0.879 | | R-Type | 0.957 |
| Arkanoid | 0.858 | | Defender of the Crown | 0.996 |
| Comic Bakery | 0.949 | | Golden Axe | 0.885 |
| Commando High-Score | 0.937 | | RoboCop 3 | 0.903 |
| Ocean Loader 1 / 2 | 0.963 / 0.966 | | vibratotest (NTSC, GT) | 0.790 |

Emulator fixes the tests found: an IRQ that came while an NMI ran waited a whole timer period
(the idle loop jumped to the next event before taking it; Giana's title read as silent after
2 s); an NMI inside the music's IRQ took the IRQ's tick with it; a 50 Hz tune writing on even
frames only was "decimated" to 25 Hz; a between-semitones pitch set no note at all.

Open, by payoff:

1. ~~Exact GoatTracker unpack~~ (phase 4): landed, §7.
2. **GoatTracker's 208 patterns** limit the subsongs of big game soundtracks: Giana imports 9
   of 23 (its 3,700-note title takes most of them), The Last Ninja 3 of 11. Transposed pattern
   reuse would fit more.
3. **Mixed speeds** (Arkanoid's jingles run at 2x, its songs at 1x: 2 of 20 import).
4. **Import time:** the app imports in a worker (`psid/psid-import-worker.ts`), so the page
   stays responsive, but a digi tune still takes seconds: Arkanoid ~7 s in Chromium, nearly all
   of it subsong 2, 441 s of music that never repeats exactly and runs to the 600 s cap. A
   register-stream repeat test could end such captures early.
5. Transcription: Hubbard-style pulse sweeps that run on across notes (the instrument restarts
   them), Tel's pitch effects (RoboCop 3 voice 3 pitch 0.37), the filter on Knucklebusters'
   long subsong, NTSC tempo.

## 7. Phase 4: GoatTracker files, unpacked (2026-09-26)

A `.sid` whose player is GoatTracker 2's is not transcribed: its song data is read back into
the song it was packed from (`psid/gt-unpack/`), which then plays and packs exactly like the
file.

**D8. The player's build is read off its code.** The relocator assembles `player.s` under
defines it computes from the song (a feature the song does not use is left out; the
instrument groups' first numbers, the frequency table's first note, the hard-restart
envelope, the start tempo, the fixed first wave and gate timer...) and appends the data,
which the code reads at absolute addresses. `player-match.ts` walks `player.s`
(`parseAsmTree`: every `.IF` branch parsed) against the file's bytes as an assembler would lay
it out, with the defines unknown: an opcode must be the byte there; an operand with one
unknown in it fixes that unknown (`cpy #FIRSTNOHRINSTR`, `lda mt_insad-1,y`, a forward
branch), one with more waits until the others are fixed (`mt_freqtbllo-FIRSTNOTE` resolves
when `mt_freqtbllo-$80` or the data start pins the label); an `.IF` on unknown defines takes
the side the bytes agree with, narrowing the defines' ranges, and backtracks when later bytes
disagree. About 10 ms a file. The relocator's author info (32 bytes written into the assembled
player) is taken as it is.

**D9. The data, back through the packer.** `gt-unpack/index.ts` inverts `gt-pack.ts` step by
step: orderlists (a repeat is written after its pattern), patterns (an unchanged command and a
repeated instrument are left out, runs of rests packed, a tempo parameter one less: 2 reads as
F02 when the build has funktempo code, else F03, which play alike), instruments renumbered
into hard-restart, no-hard-restart and legato groups (at multispeed the packer counts one
no-hard-restart instrument too many), the tables as the build encodes them (wave delays,
simple pulse, filter modes). It writes a GTS5 `.sng` image and reads it with `importGtSong`,
so the doc is the one a `.sng` import makes. Two things the packer's input had are put back so
packing gives the same bytes: a speed-table row an instrument pointed to with vibrato delay 0
(it never vibrates, the packer writes neither) goes back to an instrument without vibrato; and
a table part the packer's duplicate scan would now merge (its scan steps through the table as
the song had it, unused rows included, and the closed-up table lines parts up differently)
gets a blank row before it, never reached.

**D10. The check is packing again.** `exact` when the doc packs (in either build the export
dialog makes, at the file's player and zero-page addresses) to the file's C64 bytes. A file
built with an option this app's export does not have (buffered writes, sound effects, volume,
author info) unpacks but cannot be exact; `importPsid` keeps it when it plays like the file
(fidelity 0.98 or better), else transcribes.

Measured: the 84-song corpus exported in both builds, 168 of 168 exact and playing the same
notes with the same instruments; GoatTracker 2.77's own files (`fixtures/gt-sids`), 4 of 4
exact; builds with the other relocator options, unpacked to the notes packed. Tests:
`src/tests/psid-gt-unpack.test.ts`.

Not unpacked (transcribed instead): players of other GoatTracker versions
(`vibratotest.sid`, from ChiptuneSAK's test data); ghost-register builds (they never write the
SID, so they are not distributed as `.sid`). Lost, as the packer drops them: instrument names,
instruments and table rows nothing used, an instrument written again on a note that already
had it.
