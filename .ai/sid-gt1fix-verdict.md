# S5.5 GT1 conversion fix verdict (branch agent/sid-gt1fix-0923a, base ac35c660)

plan-sid-tracking.md §6 row S5.5. Executed via Claude Code headless (`claude-opus-5-5`,
`--permission-mode acceptEdits --allowedTools Bash`) per the workshop skill
`claude-code-headless`; prompt preserved at `.ai/claude-prompt-s55-gt1.txt`, run record
`.ai/claude-run-s55-gt1.json`. GT2 C source at `/tmp/gt2-src` read for FACTS ONLY — zero GPL
code copied; every behavioural fact below carries a file:line citation. Worktree
`.ai/worktrees/sid-gt1fix`, owner marker protocol honoured (`.ai/worktree-owner`, base sha
`ac35c66037ea81f9af4b34aef6a1fe643c163efb`, clean at run start, no foreign live claim).

**Run event, disclosed:** the headless run landed the red tests and all five fix commits, then
hit Morten's Pro-subscription session limit ("resets 12:40am Europe/Oslo") before the final
gates. The run's last state was green on the targeted tests; the mechanical tail (prettier
pass, full gates, the re-pin commit, this verdict, the D-log addendum) was finished by the
orchestrator (S5.5 subagent) from that state — no conversion code was written outside the
headless run's commits.

## 0. Baselines (untouched ac35c660, this worktree)

| Gate | Result | File |
|---|---|---|
| `cargo test --features native-host --no-fail-fast` | **384 passed / 1 failed / 1 ignored** (the failure is the pre-existing `manifest_covers_every_fixture`, `tests/ahx_render_golden.rs:419`, AHX — unrelated) | `.ai/checks-s55-cargo-baseline.txt` |
| `npm run test:run` | **256 files / 4147 tests passed, exit 0** | `.ai/checks-s55-frontend-baseline.txt` |
| `npx vue-tsc --noEmit` | clean, exit 0 | `.ai/checks-s55-vuetsc-baseline.txt` |
| `npm run lint` | clean, exit 0 | `.ai/checks-s55-lint-baseline.txt` |
| `gitleaks detect --no-git --source .` | no leaks, exit 0 | `.ai/checks-s55-gitleaks-baseline.txt` |

## 1. Method for the count updates (disclosed)

Two independent measurements:

1. **Raw GTS! byte walker** `.ai/gt1probe-s55.py` (own code, preserved here; walks the measured
   layout and counts the facts the bug list speaks about, per file — output
   `.ai/checks-s55-probe.txt`). This is the BEFORE picture of the inputs.
2. **The importer's `notes`**, re-measured and re-pinned by `src/tests/sid-sng-corpus.test.ts`
   (commit `79b0d6c9`). This is the AFTER picture of what the import reports.

Per-song impact is derived from the two: a song's sound changes where a fixed semantic touches
bytes it actually uses.

## 2. The raw facts (BEFORE, walker totals over the 22 GTS! files)

| Fact | Count | Where |
|---|---|---|
| Arpeggio `0XY` rows with a real note | 456 | 21 files |
| Arpeggio `0XY` rows without a note (GT zeroes the param) | 2149 | — |
| Arpeggio params with bit 7 set (GT: half-speed delay steps) | 2139 | 10 files |
| Command 6 rows (GT: keeps = set SR) | 2 | 2 files |
| Command 7 → F rows (unchanged semantics) | 505 | — |
| Command 7 $F0+ rows (GT: master volume D) | 10 | shinobi/wod |
| Command 7 $00 rows (GT: funktempo E from filter row 0 bytes 2-3) | 11 | 2 files |
| Pulse start bytes with bit 0 (GT: no-hard-restart flag) | 16 instruments | 3 files |
| Pulse start 0 with speed ≠ 0 (GT: no pulse program) | 12 instruments | 4 files |
| Pulse speeds > $7F (GT: halve-and-double, clamp ±127/128) | 5 | 3 files |
| Filter set rows | 629 | 17 files |
| Instrument filter bytes, file without a filter table | 8 | 2 files |
| cmd-5 filter pointers, file without a filter table | 26 | 2 files |
| Note bytes $5D/$60-$FE | 0 | — |
| Wave left $08-$0F | 0 | — |

## 3. Per-bug red → green (all via `src/tests/sid-sng-gt1-fix.test.ts`, 27 tests)

Red tests committed FIRST (`d0bd4aba`), against the old converter; the five fix commits turn
them green. Every test's header names its citations.

| Bug | Red → green | Commit |
|---|---|---|
| Filter set-row bytes backwards (gsong.c:621-625): b0 = res<<4\|channels verbatim as the GT2 row's right byte, b1 bits 4-6 the passband in the left byte; cutoff row only when b2 ≠ 0 | test `a set row: byte 1 bits 4-6 are the passband...` red, then green | `2330efc4` |
| Filter algorithm (gsong.c:602-669): sequential rows 1..numfilter (numfilter = max of instrument bytes, cmd-5 params, every row's byte3, clamped ≤63); zero rows map to the current end and pad blank rows when pointed at; adjacency falls through; jumps via the map; row 0 never converted (its bytes 2-3 are the funktempo source, gsong.c:698); zero-time modulation emits no rows (gsong.c:637-647); OOB reads (pointer/next > 63 — GT reads past `filtermap[64]`) guarded and reported | tests `converts rows 1..numfilter in order...`, `a zero-time modulation that jumps elsewhere is its jump row alone`, `reports master volume and voice-3-off bits...`, `guards the reads GoatTracker makes out of bounds...`, `without a filter table...` | `2330efc4` |
| Command 6 kept = set SR (gsong.c:574-590 has no case for it) | test `keeps command 6 (set SR) with its parameter` | `59a58058` |
| Command 7 (gsong.c:581-589, 694-699; gtable.c:857-883 MST_FUNKTEMPO +1): <$F0 → F, ≥$F0 → D with the low nibble, $00 → E pointing at the 1-based speed row (ft[2], ft[3]&0x0f); no table → zeros (GT reads uninitialized memory, gsong.c:341/602 — commented) | test `command 7: below $F0 tempo, $F0 up master volume, 00 funktempo...` (+ the no-table case) | `59a58058` |
| Arpeggio (gsong.c:700-803): note-only rule (cleared parameters elsewhere, gsong.c:800-802); per (instrument, param) keying (arpmap[i][param]); program = the instrument's wave lefts (gsong.c:732-744) then X, Y, 0 (gsong.c:748-757) with bit 7 as each step's left byte = 1-frame delay (half speed); played by a cloned `0XY` instrument (gsong.c:762-776), command 8 only when the 63 slots run out (gsong.c:777-780); overflow → command 0 param 0 remembered per (instrument, param) (gsong.c:758); name extension only under 13 chars (gsong.c:769); clones start after the highest used instrument, overwriting an unused slot (gsong.c:598) | tests `clones the instrument per (instrument, param)...`, `a name of 13+ characters...`, `clones start after the highest instrument...`, `when the 63 instrument slots run out...`, `when the wave table cannot hold the program...` | `a4214995` |
| Pulse bit 0 = no hard restart, masked out of the width (gsong.c:381-382); start 0 → no program whatever the speed (gsong.c:419); floored sweep times (gsong.c:450, 469, 489, 512); halve-and-double speed (gsong.c:458/477/496/519 + 816-830): up = min(127, add&0xfe), down = −min(128, add&0xfe), speed-1 rows are timed no-ops and not doubled; GT's phase-3 loop-backs (jump to program row 2 when the start lies between the turns, else jump to the first fall row, hlpos+1); splits at 127 frames; speed 0 = set + stop | tests `bit 0 of the start byte...`, `a zero start width makes no program...`, `floors the sweep times...`, `otherwise sweeps up to the high limit...`, `splits sweeps longer than 127 frames`, `clamps a doubled speed...`, `speed 1 halves to a timed no-op...`, `speed 0 holds the width` | `5d28cb59` |
| Note bytes outside $00-$5C (except $5E/$5F/$FF) rest like GT (gsong.c:559-560 — GT wraps and rests), reported (0 corpus occurrences); wave lefts $08-$0F → \|0xE0 (gsong.c:396-397, 0 occurrences) | tests `rests note bytes $5D and $60-$9E silently...`, `rests $9F-$FE too...`, `ORs wavetable lefts $08-$0F...` | `5c401847` |

Corpus-facing pins in the same file: the 16 no-hard-restart instruments (2 galwaytest, 5+1
clone wod, 9+4 clones b.o.f.h.) and the two command-6 rows keep command 6.

## 4. Count deltas (AFTER, re-pinned `79b0d6c9`)

| Kind | Before | After | What changed |
|---|---|---|---|
| gt1-convert | 55 (49 arp programs, 5 pulse clamps, 1 zero-time modulation) | **77** | 73 arpeggio instruments (one per (instrument, param), clone path) + 4 pulse speeds the halve-and-double changes; the zero-time-modulation note is gone (GT emits no rows) |
| gt1-dropped | 41 (26 filter pointers + 8 instrument filter bytes in no-table files, 5 pulse no-sweep, 2 command 6) | **25** | 21 filter pointers in the two no-table files (pointer-0 rows are silent A00s now — GT's filtermap[0] = 0), 3 wod set-row losses (voice-3-off ×2, master volume ×1), 1 next-row-past-63 (aeuk/jingle); the no-sweep and command-6 drops are conversions now |
| quiet GT1 files | 7 | **8** | tarantula imports with nothing to report |

Per-file note lists (after): the corpus test's pinned lists; a full dump is preserved at
`.ai/scratch/gt1-notes-after.txt` (untracked, from the fixed converter). GTS5-side pins
untouched: table-padded 2, no-gateoff 1, loop-transpose 3, 57 quiet GTS5 files.

Round trip: **83/83** import → export (GTS5) → import doc-equal, writer at a fixed point, and
the re-import reports nothing — re-verified after every fix (corpus test, final full-suite run).

## 5. Which of the 22 songs sound different now, and why

**20 of 22.** The two unchanged: `cadaver/goattracker_classical_example` (only F-tempo rows,
which the old code already kept) and `cadaver/goattracker_drum_example` (no affected bytes at
all). Everything else touches at least one fixed semantic:

- **Arpeggio files (10):** aeuk/streets, aeuk/unused_jingle, barfington/research_facility,
  cadaver/covert_ops_in_2d_funktempo, dojo, mw1 title, covert_ops_in_2d, investigations,
  mw_title_remix (+2x), warlord, wod, b.o.f.h. — the loop order is now X, Y, 0 (was 0, X, Y),
  2139 rows run at half speed (bit 7 = a 1-frame delay per step), 2149 noteless rows no longer
  restart an arpeggio every row, and each program now first replays its instrument's wave
  lefts. All audible; the noteless-row fix alone changes 10 files' textures.
- **Filter-table files (17):** 629 set rows re-routed — resonance now comes from byte 0's
  high nibble (not byte 1's), the passband from byte 1 bits 4-6, the channel mask from byte 0
  verbatim. The typical `80 0F` row now sets resonance 8 (was 0) — audible wherever a cutoff
  sweep follows.
- **shinobi/wod** — everything at once: 10 `7 $F0+` rows now set master volume (D), 10 `7 00`
  rows are funktempo (E) from filter row 0, 3 arpeggio params at half speed, 5 instruments
  without hard restart, pulse speed $80 halve-doubled, voice-3-off filter bits dropped with
  notes. The most-changed song in the corpus.
- **yehar/b.o.f.h.** — 9 instruments without hard restart, 3 pulse speeds halve-doubled
  (±127/128), 5 start-0 pulse programs removed (the width no longer gets zeroed on those
  notes), arpeggios fixed; its 21 filter pointers still drop (GT reads uninitialized stack
  memory for the missing table — unreproducible, documented).
- **cadaver/galwaytest, tarantula, covert_ops(_in_2d), dojo, tarantula's neighbours** — the
  16 no-hard-restart attacks, 12 start-0 pulse programs removed, 2 command-6 rows now apply
  SR = $00 (gate-off releases instantly instead of keeping the old SR), tarantula quiet.
- **cadaver/maximum_rastertime_test** — its $F0 pulse speed now sweeps at +127/−128 (was
  +127/−127) with floored leg times; the smallest audible delta in the corpus.

## 6. Gates (final, this branch, after the fixes)

| Gate | Result | File |
|---|---|---|
| `npm run test:run` | **257 files / 4174 tests passed, exit 0** (baseline +1 file = `sid-sng-gt1-fix.test.ts`, +27 tests) | `.ai/checks-s55-test.txt` |
| `npx vue-tsc --noEmit` | clean, exit 0 | `.ai/checks-s55-vuetsc.txt` |
| `npm run lint` | clean, exit 0 | `.ai/checks-s55-lint.txt` |
| `gitleaks detect --no-git --source .` | no leaks, exit 0 | `.ai/checks-s55-gitleaks.txt` |
| `cargo test` (pinned base; `git diff ac35c660..HEAD -- rust-wasm public` is empty) | stays at the base's **384 passed / 1 failed (pre-existing AHX) / 1 ignored** — no Rust change, no wasm rebuild | `.ai/checks-s55-cargo-baseline.txt` |

## 7. Resolution: the 3 "unresolved older-GT1-subversion" files

Resolved: **there is no older GT1 sub-version in GT's loader.** gsong.c:330 is the one GTS!
branch and it has no version switch; betaconv.c reads GTS2 only (betaconv.c:83) and says
nothing about GTS!. The odd-looking pulse bytes (limits $01-$0F, speeds $80-$F0 in
cadaver/maximum_rastertime_test, shinobi/wod, yehar/b.o.f.h.) go through the same
halve-double-clamp math as every other file (gsong.c:816-830 applies to `ident[3] < '4'`,
which `GTS!` is, `'!' < '4'`). The fixed conversion now does exactly that (clamps included,
comment at `gt-sng-gt1.ts` — "That math applies to every GTS! file: gsong.c:330 is the one
GTS! branch, with no sub-version switch"), and the corpus pin test asserts the result
(`clamps a doubled speed to +127/-128 (the odd-looking corpus bytes are GT's own math)`).

## 8. Branch state

- Branch `agent/sid-gt1fix-0923a` off `ac35c66037ea81f9af4b34aef6a1fe643c163efb`; 7 commits;
  tree clean; **no push, no merge, no rebase**; nothing outside `src/audio/tracker/sid-doc/`
  and `src/tests/` touched; Rust/public untouched (0 diffs).
- Commits: `d0bd4aba` red tests · `2330efc4` filter table · `59a58058` commands 6/7 ·
  `a4214995` arpeggio · `5d28cb59` pulse · `5c401847` note/wave bytes · `79b0d6c9` re-pin +
  prettier · this verdict + the D-log addendum (docs).
- Files: `src/audio/tracker/sid-doc/gt-sng-gt1.ts` (the conversion),
  `src/tests/sid-sng-gt1-fix.test.ts` (red-first pins, 27 tests),
  `src/tests/sid-sng-corpus.test.ts` + `src/tests/sid-sng-import.test.ts` (re-pins/coverage),
  `.ai/sid-import-dlog.md` (S5.5 addendum), `.ai/sid-gt1fix-verdict.md` (this file).
