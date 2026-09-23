# S5 follow-up — GT2-source cross-check verdict (branch agent/sid-crosscheck-0923a, base f7c5fef5)

Sources, read for FACTS only (no GPL code copied anywhere in the tree): GoatTracker 2 C source
(leafo/goattracker2, `/tmp/gt2-src/src`) and `goat_tracker_commands.pdf` (a ONE-page reference
card; cited as "PDF p.1" plus its column). Line numbers are for that checkout.

Two corrections to the brief's source map:
- `betaconv.c` is **not** a GTS!→GTS2 converter. It opens only `GTS2` files (betaconv.c:83) and
  converts early GT2 betas with 47 instruments to the 63-instrument format (betaconv.c:43-47). It
  is silent on GT1.
- GT2's GT1 converter is `gsong.c:329-845` (`loadsong`'s `GTS!` branch plus the post-load passes
  at gsong.c:809-845). `gfile.c` has no song loader (it is the file browser).

## (a) Verdicts

### Player pins (D-log §6)

| Pin | Verdict | Citation |
|---|---|---|
| `3 00` = tie-note: no retrigger / envelope restart | **CONFIRMED** | gplay.c:354-399 (new-note init skips first wave, wave/pulse/filter pointer reload and AD/SR when `newcommand == CMD_TONEPORTA`); gplay.c:922-933 (the pre-note gate-off and hard-restart ADSR are skipped for command 3); gplay.c:510-514 (a command-3 note falls through to the table/effect code instead of ending the frame); CMD_TONEPORTA = 3, gcommon.h:7 |
| `3 00` = pitch moves instantly to the target | **CONFIRMED** | gplay.c:802-811 (tick-N effect: `cmddata == 0` → frequency = the note's table frequency, vibrato phase reset); gplay.c:418-422 (tick 0 stores command/param); GT1 import keeps `3 00` (gtable.c:862 returns −1 for 0, so gsong.c:685-686 writes 0); PDF p.1 command column "3ST Slide to note. As above, or ST = 00 slides instantly." |
| Wave-table delay row: note AFTER the wait, row lasts delay + 1 frames | **CONFIRMED** | gplay.c:693-700 (left ≤ WAVELASTDELAY, gcommon.h:57 = $0F: counter ≠ value → increment and jump to TICKNEFFECTS, the note is not read); gplay.c:703-722 (counter reset, pointer advance, then the right column sets the note); PDF p.1 wave column "01-0F Delay step by 1-15 frames". The minor-chord example is not in the PDF (one-page card); it is readme §3.4.1 |

Tie-note details that differ from our player (recorded, NOT changed; the batch is docs-only):
1. Phase: GT's realtime optimisation defaults on (goattrk2.c:55 `optimizerealtime = 1`) and
   tick-N effects are skipped on tick 0 (gplay.c:728), so GT makes the jump on tick 1; we make it
   when the row is read (tick 0). Exception in GT: a wave-table note row on tick 0 moves the pitch
   to the new base note at once (gplay.c:714-722 use `cptr->note`, already updated at gplay.c:350).
2. Interaction: GT re-asserts the base pitch every tick while `3 00` stands but still lets
   wave-table note rows through (those frames skip the effects, gplay.c:722); our `wave_note`
   suppresses wave-table notes under any portamento (player.rs `wave_note`, `porta` = cmd 1-3).

### GT1 conversion (D-log §2) — vs gsong.c's GT1 loader

| Decision | Verdict | Citation / what GT does |
|---|---|---|
| Notes $00-$5C → C-0..G#7 | CONFIRMED | gsong.c:558-560 (note + $60) |
| $5E key off, $5F rest, $FF end | CONFIRMED | gsong.c:563-572; OLDKEYOFF/OLDREST gcommon.h:53-54 |
| $5D (and $60-$FE) refused | DIFFERS | gsong.c:559-560: result > $BC → rest, so $5D is a rest (unsigned wrap makes $A0+ garbage). None in the corpus |
| Instrument: 31 × (AD, SR, pulse, speed, low, high, filter, wave length) + 16-byte name + inline wave pairs | CONFIRMED | gsong.c:369-405 (`c = 1..31`, wave length / 2 pairs at :383) |
| Pulse start and limits = top 8 bits of the width | CONFIRMED | gsong.c:437-438 (set row $80\|p>>4, p<<4), :444-447 (×16) |
| Pulse byte bit 0 | **MISSED by us** | gsong.c:381-382: bit 0 = "no hard restart" (gate timer \|= $80), masked out of the width. We keep it in the width and always set hard restart. 16 instruments / 3 files (cadaver/galwaytest, shinobi/wod, yehar/b.o.f.h.) |
| Wavetable: GT2 encoding; $FF jumps 1-based, relocated | CONFIRMED | gsong.c:385-398 (`ptr = fw + 1`; jump right += ptr − 1 when non-zero) |
| Pre-2.18 left $08-$0F | CONFIRMED (no corpus rows) | gsong.c:396-397 (→ $E8-$EF) |
| Identical wave programs shared | DIFFERS (benign) | GT never shares wave programs; it shares identical pulse settings (gsong.c:423-432) and drops a 2-byte empty program (gsong.c:407-416) |
| Pulse: limit sweep → time rows, start → high then high ↔ low forever | CONFIRMED in shape | gsong.c:441-530: phase 1 start → high, phase 2 high → low, phase 3 back to start (jump to the row after the set row) when the start is inside the limits, else low → high and jump to phase 2; same trajectory as ours in the normal case. Times are floored (gsong.c:450, 469, 489, 512); ours are ceiled. Speed 0 → set + stop, as ours (gsong.c:531-538) |
| Pulse speed ×1 (GT2's own unit) | CONFIRMED (net) | GT writes speed/2 (gsong.c:458, 477, 496, 519), then the pre-v2.4 pass applies to GTS! too (`ident[3] = '!' < '4'`) and doubles every pulse speed, clamping to 127/−128 (gsong.c:816-830). Net ×1 (low bit lost), clamp at $7F exactly as ours |
| Pulse program when start = 0 but speed ≠ 0 | DIFFERS | GT makes none (gsong.c:419 `if (pulse[c])`) |
| Filter set row: byte 0 bits 0-2 passband, bits 4-6 channels; byte 1 = res<<4\|volume | **CONTRADICTED** | gsong.c:621-625: GT2 row left = $80 + (byte 1 & $70), right = byte 0 verbatim. So byte 0 = resonance<<4 \| channel mask (SID $D417 layout), byte 1 = mode<<4 \| volume ($D418 layout). Corpus agrees with GT: 604 of 643 set rows are `80 0F` (res 8, no channel, no mode, volume F), others `F1 1F`, `C1 3F`, `F4 5F` (res F/C, channel 1/3, LP / LP+BP / LP+HP). Our reading routes the wrong channels and takes resonance from the mode nibble |
| Filter modulation: control 0, byte 1 time, byte 2 signed speed, split at $7F | CONFIRMED | gsong.c:633-647 |
| Cutoff row after the set row | CONFIRMED | gsong.c:626-631 (GT omits it when byte 2 = 0; we always write it) |
| Byte 3 = next row: jump, fall-through when adjacent | CONFIRMED | gsong.c:649-665 (jump unless next = row + 1, then remapped) |
| Self-looping set row → stop | DIFFERS (equivalent sound) | GT jumps to itself (re-sets every frame); we stop |
| Zero-time modulation → one still frame | DIFFERS | GT emits no row (gsong.c:638 `while (time)` skipped) |
| Filter row 0 | DIFFERS (not reached in the corpus) | GT converts rows 1..n only (gsong.c:614); row 0 bytes 2-3 are the funk-tempo pair (gsong.c:698) |
| Filter table optional at end of file | stays INFERRED | GT freads 256 bytes unconditionally (gsong.c:602) into an uninitialised stack buffer (gsong.c:341); it never detects a missing table. Our "optional" is the corpus measurement (5/22 files end after the patterns) |
| Instrument filter byte / command 5 → filter-table pointer | CONFIRMED | gsong.c:379-380, 576-578, 667-669, 690-692 (through the row map) |
| Defaults: first wave $09, gate timer 2 | CONFIRMED | gsong.c:347 `clearsong` → ginstr.c:210-221 (gate timer 2 × multiplier, multiplier 1 by default goattrk2.c:48; first wave $09); the `< '5'` pass (gsong.c:832-844) leaves $09 alone |
| Hard restart on | DIFFERS for 16 instruments | pulse bit 0, above |
| Packing instrument<<3 \| command | CONFIRMED | gsong.c:553-554 |
| 0XY arpeggio → looping wave program | CONFIRMED in kind, **DIFFERS in detail** | gsong.c:700-803. (1) Only on a row with a note; otherwise the parameter is zeroed (gsong.c:704, 800-802). 2149 corpus rows carry 0XY without a note; we turn each into command 8, which restarts the program every row. (2) Order X, Y, 0 (gsong.c:749-757); ours 0, X, Y. (3) Bit 7 of XY is the step's left byte, a 1-frame delay, so the arpeggio runs at half speed (gsong.c:749, 752, 755); we mask it off. 2139 rows in 10 files. (4) The program first replays the instrument's wave left column (gsong.c:732-744) and is reached by a cloned instrument named `…0XY` (gsong.c:762-776); command 8 only when instrument slots run out (gsong.c:777-780) |
| 1/2/3 → speed row 4 × param; 3 00 stays tie-note | CONFIRMED | gsong.c:681-686 → gtable.c:881-883 (<<2), gtable.c:862 (0 → no row) |
| 4XY → speed row (X, Y<<4) | CONFIRMED | gsong.c:687-688 → gtable.c:866-868 |
| 5 → A | CONFIRMED | gsong.c:576-578 |
| 6 dropped | **CONTRADICTED** | GT has no case for 6 (gsong.c:574-590): it stays GT2 command 6, set SR. 2 corpus rows, both `6 00` |
| 7 → F with the same parameter | **PARTLY CONTRADICTED** | gsong.c:581-589: parameter < $F0 → F (confirmed), $F0-$FF → D master volume (low nibble). 10 rows, shinobi/wod. gsong.c:695-699: `7 00` → E funk tempo built from filter-table row 0 bytes 2-3. 11 rows, cadaver/covert_ops_in_2d_funktempo and shinobi/wod |
| Trailing unused empty instruments trimmed | CONFIRMED in kind | GT's save writes up to the highest instrument used by a pattern (gsong.c:1333) or with any non-zero AD/SR/pointer/vibrato byte (gsong.c:46-53); the name is ignored, where we also keep a named instrument. betaconv.c:172-179 applies the same rule to GT2 betas |

Corpus counts in this table come from a throwaway raw GTS! byte walker (`/tmp/gt1probe.py`,
own code, not committed). "Our corpus round-trips" still holds (the D-log's round-trip invariant
is doc → GTS5 → doc and is not affected). But the CONTRADICTED/MISSED rows mean several GT1
songs do not sound as GT2 plays them.

## (b) Tie-note row count (the review's should-fix)

**Definition**: raw pattern rows: every pattern stored in the file counted once, **NOT
orderlist-expanded**, over the 61 GTS5 fixtures in `src/tests/fixtures/gt-songs/`. A row is
counted when command = 3 and parameter = $00. **Headline lens: rows with a real note**
($60-$BC, doc note 1..93). That is where the pin changes what you hear, because there is a pitch
to jump to. A key-off or rest under `3 00` has no target.

**Method**: two independent counts with identical results.
1. A throwaway vitest (`src/tests/s5x-tie-count.test.ts`, run once and then deleted as the brief
   prefers) that imports each file with the landed `importGtSong` (`gt-sng-read.ts`) and walks
   `doc.patterns[*].rows`.
2. A separate raw-byte Python walker (`/tmp/gts5tie.py`, own code, not committed). It asserts that
   each file is consumed exactly and reads the 4-byte rows directly.

| Lens | Rows | Files |
|---|---|---|
| (a) all `3 00` rows | 5406 | 57 |
| (b) with a real note — **headline** | **4791** | **56** |
| (c) non-rest (note or key-off) | 4930 | 56 |
| (of which key-off) | 139 | 8 |
| (other lenses, for reference) referenced-by-an-orderlist patterns only, real note | 4764 | 55 |
| orderlist-expanded once (repeats counted, no loop), real note | 7787 | 55 |
| distinct (note, instrument, cmd, param) tuples | 1501 | 56 |

**Result**: the D-log's original "4791 rows in 56 of the 61 GTS5 files" re-derives exactly. It
was the real-note, raw-pattern count; the only defect was that the method was not stated. The
reviewer's walker (1755 real notes / 1883 non-rest / 56 files) does **not** reproduce. The 56-file
figure agrees, but the row counts are 2.7× lower under both of the reviewer's lenses, and none of
the alternative lenses above lands near 1755. The per-file rows are in the test output (largest:
stinsen/diminishing_returns 324, unleash_the_cheese 336, lethargic 328, balcony_princess 292). The
D-log §6 and the `player.rs` comment now state 4791 / 56 with the method and the 4930 non-rest
figure.

## (c) Gates

- `cd rust-wasm && cargo test --features native-host --no-fail-fast` → `.ai/checks-s5x-cargo.txt`:
  **384 passed / 1 failed / 1 ignored**. This is identical to the baseline run on the untouched
  tree in this worktree and to `.ai/checks-s5-cargo.txt`. The one failure is pre-existing and
  unrelated: `manifest_covers_every_fixture` (rust-wasm/tests/ahx_render_golden.rs:419, AHX). The
  brief's "1 filtered" is this failure; nothing is filtered out. No count moved.
- `gitleaks detect --no-git --source .` → `.ai/checks-s5x-gitleaks.txt`: no leaks found (exit 0).
- Frontend untouched; no frontend build run. (The scratch vitest ran through symlinked
  `node_modules` and `.quasar`, both removed before commit.)
- Both check files are under the gitignored `.ai/`; they stay local and are not committed.

## (d) Still INFERRED / open

- **GT1 filter table optional at end**: GT's loader does not model absence (gsong.c:602), so
  this rests on the corpus measurement alone.
- **Pulse bytes of maximum_rastertime_test, b.o.f.h. and wod** (limits $01-$0F, speeds $80-$F0):
  gsong.c treats them like any other file (speed/2 then ×2, clamped), so GT would clamp them too.
  The "older GT1 sub-version" guess stays unresolved; the source has no version switch.
- **Behaviour deltas found here, NOT fixed** (docs-only batch). Should-fix list for a GT1
  conversion pass: filter set-row byte assignment; arpeggio bit 7 speed, note-only rule and
  X-Y-0 order; command 6 → SR; command 7 $F0+ → D and 7 00 → E; pulse bit 0 → no hard restart;
  $5D → rest. Also the two tie-note frame details under (a).
- The GTS5 §1 INFERRED items (NUL-terminated text, $E0 = −16, tempo 6, table padding) were
  outside this batch's scope and were not re-checked against gsong.c:189-246.
