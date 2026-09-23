# S5 verdict — GoatTracker `.sng` import/export (branch agent/sid-import-0923a)

Base main @ 95d16f65. D-log: `.ai/sid-import-dlog.md` (offsets with §-citations, every INFERRED
rule, per-file deviations, GPL note). Not pushed, not merged.

## What landed

- **Parser** `src/audio/tracker/sid-doc/gt-sng-{common,read,gt1}.ts`: `importGtSong(bytes, hints)`
  → `SidDoc` + per-occurrence `notes`, never throws, refuses whole with a true reason. Dispatch on
  magic: `GTS5` (readme §6.1), `GTS!` (GoatTracker 1, converted; optional trailing filtertable),
  `GTS2/3/4` refused (GT2 betas, none in the wild), 6-orderlist structure refused as dual SID (S7).
  Zero deps, latin-1 texts.
- **Writer** `gt-sng-write.ts`: `exportGtSong(doc)` → GTS5 bytes + notes (chip model / multispeed
  are not storable), or a refusal (tempo ≠ 6, instrument with its own waveform/pulse/filter,
  transpose outside −16..+14, orderlist > 254 bytes, NUL in a text, model violation).
- **Wiring**: `src/audio/tracker/sid-import.ts` (assembly; the song file's authority is
  `data.sidFile`, so load goes through S3's `adoptSidFile` and the grid is editable at once);
  `useTrackerFileIO.parseSongBuffer(data, name?)` dispatches on the GTS magic; `.sng` in the
  picker/drop lists; file/URL/jukebox loads pass the name (chip / `2x` hints).
- **Player pins forced by the corpus** (Rust, `player.rs`; `public/wasm` rebuilt and committed,
  worklet bundles unchanged; `check:artifacts` green): `3 00` = tie-note (4791 rows, 56/61 GTS5
  files played the wrong pitch); a wave-table delay row sets its note after the wait and lasts
  delay+1 frames (478 rows, 36/61 files). Readme §3.2 / §3.4.1; phase of the delay INFERRED.
- **Deploy**: 83 files in `public/songs/goattracker/<artist>/` (house names) +
  `public/songs/README.md` (ModLand credit, provenance table). No jukebox index: the manifest
  script covers `public/demos/` only, so `public/songs` has no consumer yet.
- **Fixtures**: `src/tests/fixtures/gt-songs/` (same 83 + README), `gt-songs-corrupt/sleepwalk.sng`.
- AGENTS.md: S5 section appended.

## Corpus acceptance

- **Parsed: 83/83** (61 GTS5, 22 GTS!). Faithfulness checked against an independent raw walker
  in the test: GTS5 byte for byte (rows, instruments, tables, orderlist patterns); GTS! every
  row's note and instrument, pattern lengths, orderlist patterns.
- **Round trip doc-equal: 83/83** (import → export GTS5 → import; re-import reports nothing;
  writer at a fixed point). For GTS! this is the conversion's doc, not the GT1 bytes.
- **Deviations** (import notes, pinned): GTS5 — 2 table-padded, 1 no-gateoff, 3 loop-transpose
  in 4 files (57/61 clean); GTS! — 55 conversions (49 arpeggio programs, 5 pulse clamps, 1
  zero-time filter row) and 41 drops (26 filter commands + 8 instrument filter bytes in files
  without a filtertable, 5 no-sweep pulse programs, 2 command-6 rows) in 15 files (7/22 clean).
- **Corrupt file**: sleepwalk.sng refused (`pattern 2 is 26 bytes long, not a whole number of
  3-byte rows`); through the app, `parseSongBuffer` rejects and the loaded song stays.
- **Proof song**: Mch "Alien Funk" (`mch/alien_funk.sng`) loads through the real song host and
  plays through playback store → SID transport → player client → real `SidProcessorCore` on the
  rebuilt wasm; the worklet receives exactly the doc's bytes; mix peak > 0.05 and every voice
  tap > 0.01 over 64 rows. Also dojo (GT1) plays; the `_6581_` name reaches the player as 6581.

## Gates (files in `.ai/`)

| Gate | Result | Baseline |
|---|---|---|
| `npm run test:run` → checks-s5-test.txt | 4061 passed / 0 failed, 255 files, EXIT 0 | 4011 / 0 → delta +50 = new tests |
| `npm run lint` → checks-s5-lint.txt | EXIT 0 | EXIT 0 |
| `npx vue-tsc --noEmit` → checks-s5-vuetsc.txt | EXIT 0 | EXIT 0 |
| `cargo test --features native-host --no-fail-fast` → checks-s5-cargo.txt | 384 passed / 1 failed / 1 ignored | 381/1/1 → +3 = tests_s5; the 1 is the same `ahx_render_golden manifest_covers_every_fixture` |
| `gitleaks detect --no-git --source .` → checks-s5-gitleaks.txt | no leaks, EXIT 0 | same |
| `npm run check:artifacts` → checks-s5-artifacts.txt | EXIT 0 | — |
| Red controls → checks-s5-red-controls.txt | RC1 (fixture byte desync, brief-mandated) red→restore→green; RC2-RC8 code mutations | — |

New tests: sid-sng-import 24, sid-sng-export 12, sid-sng-corpus 9, sid-sng-load-chain 5 (TS);
tests_s5.rs 3 (Rust).

## Honest caveats

- **GT1 conversion is mostly INFERRED** (no GT1 documentation; GT source deliberately unread):
  pulse byte scaling and speed unit (×1 chosen; ×2 per §1.1 note 9 would clamp 43 instruments),
  filtertable bit layout (weakest: `$8x` rows route no channel), arpeggio flag bit, command 6/7
  meanings, GT2 defaults for first wave/gate timer. Three files (maximum_rastertime_test,
  b.o.f.h., wod) look like an older GT1 sub-version whose pulse/filter bytes I cannot read.
  Nothing here is verified by ear or against GoatTracker's own playback.
- Red-control record includes two honest misfires: RC4 was an invalid (syntax-error) mutation,
  redone as RC4b; RC6 stayed GREEN and exposed a real gap in the corpus test, fixed and rerun
  (RC6b). RC5's summary lines were captured by hand (RC5c).
- Hints from file names (chip, `2x`) are a corpus convention, not format.
- The writer refuses app-made instruments (own waveform/pulse/filter) and non-6 start tempos:
  new SID songs made in the editor cannot be exported as `.sng` yet.
- During the run I stopped my own gate run with a broad `pkill -f vitest`, which would also have
  stopped any vitest process of another session on this machine at that moment (none found
  afterwards; I cannot tell whether one was hit). Later stops were by PID.

## What S6 / S8 inherit

- S6 (export): the dialog row + size budgets + "GT loads our files" verification; converting
  instrument waveform/pulse width/filter and start tempo into table rows / an F command instead
  of refusing; a GT1 writer is not planned (GT1 imports export as GTS5).
- Player semantics carried faithfully in the doc but not played (D-log §7, counts measured):
  funktempo E (301 rows / 15 files) and F $00-$02; per-channel tempo; wavetable $F0-$FE commands;
  speedtable $80 realtime; vibrato delay 0 = off; the player resetting pulse width and filter
  routing on triggers of table-less GT instruments; GT's HR ADSR `-A`, `-R` tick-0 skip, 50.125 Hz.
- The doc model has no "no gate-off" flag (1 instrument in the corpus); the ASID codec's reserved
  bit 6 is where it would go (Rust `song.rs` too).
- S7: the dual-SID refusal is structural only; the corpus has no dual-SID file.
