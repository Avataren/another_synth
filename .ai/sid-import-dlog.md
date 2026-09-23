# S5 D-log — GoatTracker `.sng` import/export (branch agent/sid-import-0923a)

plan-sid-tracking.md §6 row S5. Base: main @ 95d16f65. Every fact below is marked:
**§x.y** = GoatTracker v2.72 readme (`/tmp/gt-curate/gt2-readme.txt`, the spec), **MEASURED** =
observed in the corpus bytes with my own scripts (`/tmp/s5work/*.js|py`, `src/tests/sid-sng-corpus.test.ts`
re-checks each), **INFERRED** = my reading where no document speaks; each INFERRED item says
what evidence it rests on.

## 0. GPL discipline

- **Read**: the readme (§1.1 warnings, §1.2 v1 compatibility, §2.1 command-line options,
  §3.1-§3.4 orderlist/pattern/instrument/table semantics, §3.6-§3.7, §6.1 and §6.2 formats);
  `/tmp/gt-curate/REPORT.md` (the curator's distillation, allowed by the brief);
  `candidates-full.json` (provenance: names, sizes, hashes); the corpus bytes (hexdumps, my own
  node/python walkers).
- **Never opened**: `gsong.c`, `gsong.h`, `gcommon.h` (present in /tmp/gt-curate), any other
  GoatTracker or reSID source, and also `validate.py` / `validate.json` (the curator's
  validator is described in REPORT.md as "pinned to loadsong.c", i.e. a transcription of the
  GPL loader, so I treated it as off-limits too).
- **Copied**: no GT code, no GT table. The only numbers taken from GT's documentation are
  format facts (offsets, byte meanings) and the old-parameter conversion examples of §3.4.4.

## 1. GTS5 layout, pinned (reader `src/audio/tracker/sid-doc/gt-sng-read.ts`, writer `gt-sng-write.ts`)

| Offset / field | Meaning | Source |
|---|---|---|
| +0, 4 bytes | `GTS5` identification | §6.1.1 |
| +4, 32 | song name, zero padded; text = bytes up to the first NUL, latin-1 | §6.1.1 (NUL-termination: INFERRED from "padded with zeros") |
| +36, 32 | author | §6.1.1 |
| +68, 32 | copyright | §6.1.1 |
| +100, 1 | number of subtunes (1..32) | §6.1.1; 32 = §3.1 |
| +101 | orderlists: subtune 0 ch1, ch2, ch3, subtune 1 … | §6.1.2 |
| orderlist +0 | length n | §6.1.2 "not counting restart pos"; **MEASURED: n counts the $FF endmark** (e.g. dojo @101: `0E` then 14 bytes ending `FF`, then the restart byte) |
| orderlist +1, n+1 | data: $00-$CF pattern, $D0-$DF repeat, $E0-$FE transpose, $FF RST, then restart | §6.1.2 |
| restart byte | an index into the orderlist BYTES, not the patterns | **MEASURED**: 84 of 183 GTS5 orderlists restart on a command byte |
| repeat $Dx | x = 1..15 plays, $D0 = 16 | §3.1 ("R0" = 16) |
| transpose $Ex/$Fx | value − $F0, i.e. $F0 = 0, $FE = +14, $E1 = −15 | §3.1 (up 0-14, down 1-15); **$E0 = −16 is INFERRED** (in the §6.1.2 range, not named by §3.1; absent from the corpus) |
| instruments +0 | count n ≤ 63, then n × 25 bytes | §6.1.3; 63 = §3.3 |
| instrument +0..+8 | AD, SR, wave ptr, pulse ptr, filter ptr, vibrato param (speed ptr), vibrato delay, HR/gate timer, 1st-frame wave | §6.1.3 |
| instrument +9, 16 | name, zero padded | §6.1.3 |
| gate timer bit $80 / $40 | no hard restart / no gate-off | §3.3 |
| tables ×4 | wave, pulse, filter, speed: n, n left bytes, n right bytes | §6.1.4 |
| patterns +0 | count 1..208 | §6.1.5; 208 = §3.2 |
| pattern +0 | length m | §6.1.6 "in rows"; **MEASURED: m counts the $FF end row** (every one of the 61 files' patterns ends `FF 00 00 00` and the file is consumed exactly) → rows = m − 1 ≤ 128 |
| row bytes | note ($60-$BC C-0..G#7, $BD rest, $BE key off, $BF key on, $FF end), instrument $00-$3F, command $0-$F, parameter | §6.1.6 |
| end of file | right after the last pattern | **MEASURED** (61/61 exact) |

Doc mapping: note byte − $5F → doc note 1..93 (doc's note table index + 1 = GT's C-0 = index 0);
$BD → 0 (empty cell), $BE → 126, $BF → 127 (`types.ts` constants). Instrument bytes map 1:1 to
`attack/decay/sustain/release/wavePtr/pulsePtr/filterPtr/speedPtr/vibratoDelay/firstWave`;
`gateTimer = byte & $3F`, `hardRestart = !(byte & $80)`. Tables map row for row.

### What a `.sng` does not store (defaults and hints, all INFERRED)

- **Tempo**: §6.1 has no tempo field; songs set it with FXY (§3.2). Import uses 6, the doc's
  `SID_DEFAULT_TEMPO` (S3's reading of GT's default; the readme's own timing example assumes "a
  tempo of 6", §3.5). INFERRED. The readme's "startup default tempo with the Attack/Decay of
  instrument 63" (§3.6) is a packed-player trick and is not read. Export refuses a doc whose
  start tempo is not 6, with the reason.
- **Speed multiplier**: GT's `-S` option (§2.1), not in the file. **Chip model**: GT's `-E`
  option (§2.1), not in the file. Import takes both from the FILE NAME when it carries a token
  (`gtSongHintsFromName`: `6581`/`8580`, `Nx` for N 2..16), else 8580 / 1x. This is a corpus
  naming convention (`defunkt_final_fv_po_ro_6581_ffff`, `space_2x`, `mw title remix, 2x-speed`),
  not a format rule. Corpus: 1 file tagged 6581, 4 tagged 2x. Export reports both as notes
  ("not stored in a .sng") and writes the file anyway.
- **Instrument waveform / pulse width / filter**: a GT instrument has none (its tables set
  them). Import writes the doc's neutral values (0, 0, disabled/0/0/0); export REFUSES a doc
  instrument with any of them set ("set them with table rows instead"). A new app song's default
  instrument (pulse $40, width $800) is therefore refused; converting such instruments into
  table rows is S6 (the brief scopes S5's writer to the round trip).

### GTS5 deviations (doc cannot hold a byte exactly as GT means it)

| Kind | Count | Files | Handling |
|---|---|---|---|
| `table-padded` | 2 | mch/balcony_princess (wave ptr 25 > 24 rows), mch/in_a_rush (speed ptr 16 > 11 rows) | INFERRED: GT keeps 255-row tables in memory and saves the used prefix, so a pointer past it reads blank rows. The doc gets blank ($00/$00) rows up to the pointer. Round-trips exactly (the export writes the padded table). |
| `no-gateoff` | 1 | stinsen/upsandowns (instrument 2, gate byte with $40) | The doc has no "no gate-off" flag (`SidInstrument` has gateTimer + hardRestart; the ASID codec reserves bit 6). Imported as gate timer 0 (the player's "never early", the closest behaviour: no gate-off, no HR); `hardRestart` keeps bit $80's meaning. The original timer value is lost; the doc round-trips. |
| `loop-transpose` | 3 | stinsen/game_tune (3 orderlists) | GT keeps the running transpose across the loop (§3.1 "reset only when starting the song, not when looping"); these lists loop to an entry whose second-pass transpose differs from its first. The doc holds the first pass. The export restates the transpose at the restart entry, so the exported file plays the doc's semantics in GT (and re-imports equal). |

57 of 61 GTS5 files import with nothing to report.

## 2. GTS! (GoatTracker 1), converted (`gt-sng-gt1.ts`)

Documented: §1.2 (GT2 loads v1.xx songs, converts arpeggio commands to wavetable programs,
"some subtleties … will not play back exactly"), §3.4.4 (old vibrato `$34` → speed `03` depth
`40`; old portamento `$08` → `$0020`, i.e. ×4), §1.1 note 7 (pre-2.18 wavetable left values:
only $08-$0F changed meaning; the GT1 corpus has 80 wave rows in $01-$0F, all $01-$04, which are
delays in both eras, MEASURED, so none needs converting). **Everything else here is INFERRED from
the bytes.**

Layout (MEASURED; every one of the 22 files consumes exactly under it; it matches REPORT.md):
header as GTS5 (+4/+36/+68 texts, +100 subtunes, +101 orderlists, same orderlist encoding);
then exactly 31 instruments of 8 bytes + 16-byte name + (byte 7 / 2) (left, right) wavetable
pairs; then pattern count, each pattern a length in BYTES and 3-byte rows (note,
instrument<<3 | command, parameter), last row $FF; then a 256-byte filter table (64 rows × 4)
that is OPTIONAL (absent in 5 of 22: the four Cadaver example/test files and Yehar's b.o.f.h.).

Conversion rules (all INFERRED unless marked):
- Notes $00-$5C → doc 1..93 (GT2's $60-$BC minus $60); $5E key off; $5F rest; $FF end.
  $5D and $60-$FE are refused (none in the corpus).
- Instrument bytes: +0 AD, +1 SR; +2 pulse start, +3 pulse speed, +4/+5 low/high limit (start and
  limits = the 12-bit width's top 8 bits); +6 filter-table row; +7 wavetable length in bytes.
- Wavetable: GT2's encoding fits every corpus byte (left: waveforms, $00 keep, $FF jump; right:
  $00-$5F up, $80+ absolute); jumps are 1-based within the instrument and are relocated into the
  shared wave table; identical programs are shared (the dedup REPORT.md predicted).
- Pulse: limit-based sweep → GT2 time-based rows (§3.6.1 describes the conversion idea): set
  start; up to the high limit; then down/up between the limits forever. **Speed unit: taken as
  GT2's own (×1).** The alternative, §1.1 note 9's doubling for pre-2.4 GT2 songs, would push 43
  instruments past $7F (GT2's signed range) while ×1 fits every speed below $80 and matches the
  GTS5 corpus's measured speeds (16-127 per frame, 35 % in 32-47). Five instruments still
  exceed $7F and are clamped, and five have limits that leave no sweep: all ten are in
  cadaver/maximum_rastertime_test, yehar/b.o.f.h. (both without a filter table) and shinobi/wod,
  whose pulse bytes look differently scaled (limits $01-$0F, speeds $80-$F0): probably an older
  GT1 sub-version, unresolved.
- Filter table (64 × 4 bytes): control byte ≠ 0 = set row: bits 0-2 passband (1 LP, 2 BP, 4 HP),
  bits 4-6 channels 1-3, byte 1 = resonance<<4 | volume, byte 2 = cutoff; control 0 = modulation
  (byte 1 time, byte 2 signed speed); byte 3 = next row. → GT2 "set params" + "set cutoff" rows,
  timed rows split at $7F, jumps for `next` (a set row looping on itself becomes a stop). The
  bit assignment is the weakest inference here: `$8x` rows then route no channel.
- GT2 defaults for bytes GT1 lacks: first wave $09, gate timer 2, hard restart on (§3.3/§3.7
  "usually $09", "normally 2"); no vibrato delay or instrument vibrato.
- Commands: 0 XY (≠0) arpeggio → a looping 0/X/Y wave program started by command 8 (X's bit 3
  masked: `$B7`, `$C7`, `$D8` read as 3/7, 4/7, 5/8 chords); 1/2/3 → speed row of 4 × param
  (§3.4.4), 3 00 stays tie-note; 4 XY → speed row (X, Y<<4) (§3.4.4); 5 → A (filter row);
  6 → dropped (2 uses, both `$00`); 7 → F, same parameter.
- Trailing empty instruments not referenced by any pattern are trimmed (31 → as few as 1).

GTS! notes (MEASURED, pinned in `sid-sng-corpus.test.ts`): `gt1-convert` 55 (49 arpeggio
programs, 5 pulse clamps, 1 zero-time filter modulation), `gt1-dropped` 41 (26 filter-pointer
commands and 8 instrument filter bytes in files with no filter table: b.o.f.h. has 25+6 of them,
it clearly used GT1's filter without a table in a way I cannot read; 5 pulse programs with no
sweep; 2 command-6 rows). 7 of the 22 GT1 files import with nothing to report; the files with
drops are aeuk/streets, cadaver/mw1 title example, cadaver/tarantula, shinobi/wod, yehar/b.o.f.h.

## 3. Per-file deviation list (every file with a note; MEASURED)

| File | Variant | Notes | Kinds |
|---|---|---|---|
| aeuk/metal_warrior_4_streets | GTS! | 5 | 4 arpeggio program, 1 command 6 dropped |
| aeuk/metal_warrior_4_unused_jingle | GTS! | 1 | 1 arpeggio program |
| barfington/metal_warrior_4_research_facility | GTS! | 7 | 7 arpeggio program |
| cadaver/covert_ops_in_2d_funktempo | GTS! | 6 | 6 arpeggio program |
| cadaver/dojo | GTS! | 4 | 4 arpeggio program |
| cadaver/goattracker_example_mw1_title | GTS! | 6 | 2 instrument filter byte dropped, 1 filter command dropped, 3 arpeggio program |
| cadaver/maximum_rastertime_test | GTS! | 1 | 1 pulse speed clamped |
| cadaver/metal_warrior_4_covert_ops_in_2d | GTS! | 3 | 3 arpeggio program |
| cadaver/metal_warrior_4_investigations | GTS! | 2 | 2 arpeggio program |
| cadaver/mw_title_remix | GTS! | 3 | 3 arpeggio program |
| cadaver/mw_title_remix_2x_speed | GTS! | 3 | 3 arpeggio program |
| cadaver/tarantula | GTS! | 1 | 1 command 6 dropped |
| cadaver/warlord | GTS! | 1 | 1 arpeggio program |
| mch/balcony_princess | GTS5 | 1 | 1 table-padded |
| mch/in_a_rush | GTS5 | 1 | 1 table-padded |
| shinobi/wod | GTS! | 12 | 1 zero-time filter row, 1 pulse speed clamped, 4 pulse no sweep, 6 arpeggio program |
| stinsen/game_tune | GTS5 | 3 | 3 loop-transpose |
| stinsen/upsandowns | GTS5 | 1 | 1 no-gateoff |
| yehar/b_o_f_h_ingame_death_victory | GTS! | 41 | 6 instrument filter byte dropped, 3 pulse speed clamped, 1 pulse no sweep, 25 filter command dropped, 6 arpeggio program |

Every other file (57 GTS5, 7 GTS!) imports with nothing to report. Tabulated from the importer
(`/tmp/s5work/table-entry.ts`, bundled with esbuild); the test pins the per-kind totals and the
file sets.

## 4. Round trip

- **83/83 import** (61 GTS5 + 22 GTS!), **83/83 doc-equal** after import → export (GTS5) →
  import, the re-import reports nothing, and the writer is at a fixed point (exporting the
  re-import gives the same bytes). For GTS! files "doc-equal" is the conversion's doc: the GT1
  bytes are not reproduced (the writer is GTS5 only), which is the honest invariant; faithfulness
  to the GT1 source is checked separately (every row's note and instrument, every pattern length
  and every orderlist's patterns, re-read independently in the test).
- GTS5 faithfulness is checked byte for byte against an independent walker in the test: every
  row's 4 bytes, every instrument's 25, every table byte (plus only blank padding), every
  orderlist's patterns.
- Byte-exact export vs the author's file: not required and not claimed. Differences: an
  author's `$D1` (repeat 1) or redundant transpose is not rewritten; restarts point at the
  restart entry's first command; bytes after a text's NUL are zeroed.

## 5. The corrupt file

`sleepwalk.sng` (Spock; GTS! magic) is refused whole: `pattern 2 is 26 bytes long, not a whole
number of 3-byte rows`. (REPORT.md reports the desync under every layout the curator tried; under
this reader's layout it shows at pattern 2.) `importGtSong` never throws; the app path throws
`Cannot import this GoatTracker song: …` from `parseSongBuffer`, `loadSongFromBuffer` logs it,
and the loaded song stays (tested).

## 6. Player pins forced by the corpus (Rust changed; wasm rebuilt and committed)

- **3XY with $00 is tie-note** — "$00 for "tie-note" effect (move pitch instantly to target
  note)" (§3.2). The S3 player read parameter 0 as "no speed row" and never moved the pitch, so a
  tied note kept the previous pitch. **MEASURED: 4791 rows in 56 of the 61 GTS5 files** are
  `3 00` with a note. Fixed in `player.rs` `read_row` (pitch set at once, no trigger);
  `rust-wasm/src/sid/tests_s5.rs` (2 of its 3 tests: the tie, and the glide control); header comment
  updated. `npm run build:wasm && npm run build:worklets` rebuilt `public/wasm`
  (`audio_processor_bg.wasm`, `SOURCE_HASH.json`); the worklet bundles came out unchanged.

- **A wave-table delay row sets its note, and lasts delay + 1 frames** — §3.4.1: "01-0F Delay
  this step by 1-15 frames" and its example "21 00 | 02 03 | 02 07 | 02 00 | FF 02 … A delayed
  minor chord arpeggio … Each step takes 3 ticks". The S3 player waited `left` frames and never
  applied a delay row's note, so every delayed arpeggio lost its notes and ran fast. **MEASURED:
  478 delay rows in 36 of the 61 GTS5 files** (at least 301 of them, in 21 files, move the note
  away from the base). Fixed in `wave_step` (the note helper `wave_note` is shared with the other
  rows); test `a_delayed_wave_step_waits_then_sets_its_note_the_readme_minor_chord` plays the
  readme's example. **INFERRED phase**: the note comes AFTER the wait (not on the row's first
  frame), from §1.1 note 5 ("Using delayed wavetable … in the first step … may result in missing
  notes", which only happens if the note waits).
- Red controls RC7 and RC8 (`.ai/checks-s5-red-controls.txt`) revert each pin and watch its test
  go red. `cargo test` for the whole crate is in `.ai/checks-s5-cargo.txt`: +3 passed vs baseline.

## 7. Player semantics the doc carries faithfully but the S3 player does not reproduce (S6/S8 inherit)

MEASURED on the 61 GTS5 files; none changed here (the brief: only corpus-forced pins; these are
missing features, not a wrong reading of a documented byte):
- funktempo `E` commands: 301 rows / 15 files (player ignores E); `F` $00-$02 (funktempo recall /
  tempo 2): 156 rows / 2 files (player sets tempo 1-2); `F` $80+ per-channel tempo: 2 rows / 1
  file (player's tempo is global);
- wavetable command rows $F0-$FE: 18 rows / 10 files (not executed);
- speedtable $80 realtime vibrato/portamento: 7 rows / 6 files (not modelled);
- instrument vibrato with delay 0: 17 instruments / 10 files; GT: "$00 turns instrument vibrato
  off" (§3.3), the player starts it at once;
- pulse width: the player loads the instrument's `pulseWidth` (0 for every GT instrument) on each
  trigger; GT leaves the width alone when the pulse pointer is 0 (199 of 1329 GTS5 instruments);
- filter routing: the player clears a voice's routing bit on a trigger of an instrument with the
  doc filter disabled (every GT instrument); GT leaves the filter state to the filter table;
- GT's hard-restart ADSR (`-A`, filename tokens `0f00`/`ffff`), realtime-command tick-0 skip
  (`-R`), and 50 vs 50.125 Hz are player/global settings no `.sng` stores.

## 8. Proof song

**Mch — "Alien Funk"** (`mch/alien_funk.sng`, GTS5, 19 KB, 19 instruments, 3 subtunes,
filter table 73 rows): loaded by `src/tests/sid-sng-load-chain.test.ts` through the real song
host (`loadSongFromFile` → `parseSongBuffer` → `importGtSongToTrackerSong` → `applySongFile` →
`loadSongFile` → `adoptSidFile`) and played by the real playback store / SID transport / player
client into the real `SidProcessorCore` over the rebuilt `public/wasm`: the worklet receives
exactly `serializeSidFile(store.sidDoc)`, the mix and all three voice taps are non-silent over the
first 64 rows. Also played: cadaver/dojo (GT1); chip tag: stinsen/defunkt_…_6581_… reaches the
player's bytes as 6581.

## 9. Wiring and deploy

- `src/audio/tracker/sid-import.ts`: assembly only (like `ahx-import.ts`): the doc becomes a
  song file whose authority is `data.sidFile`, so the load goes through S3's `adoptSidFile` and
  the song is grid-editable at once. GT1 songs with an empty title take the file name.
- `useTrackerFileIO.parseSongBuffer(data, name?)` dispatches on the `GTS` magic (after
  MOD/XM/S3M/AHX, before the JSON fallback); `loadSongFromFile`/`loadSongFromUrl` and the jukebox
  pass the name as the hint source; `.sng` added to the picker and drop extensions.
- `public/songs/goattracker/<artist>/<house name>.sng` (83) + `public/songs/README.md` (ModLand
  credit, provenance table). No consumer lists them yet: the jukebox manifest script
  (`scripts/refresh-demos.sh`) covers `public/demos/` only, so no index was generated.
- Test fixtures: `src/tests/fixtures/gt-songs/` (the same 83, own README) and
  `src/tests/fixtures/gt-songs-corrupt/sleepwalk.sng`.
