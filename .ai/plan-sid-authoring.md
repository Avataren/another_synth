# Plan: SID authoring — edit, create, export `.sng`, `.sid`, `.prg`

Status: **AGREED 2026-09-25 (D1-D3 decided by Morten, see §2). Nothing landed.** Follows `.ai/plan-sid-tracking.md`
(S0–S5.19 landed: chip, GT-parity player, `.sng` import, grid editing, instrument page).

Brief (Morten, 2026-09-25): make GoatTracker songs editable and exportable — edit the
song, create new instruments, create a new GT song from scratch, export to GT format,
and later export `.sid` and `.prg` (PSID, or ideally our own branded playback demo).

---

## 1. Where we are (measured 2026-09-25, `c2530916`)

| Capability | State | Where |
|---|---|---|
| Doc model | **Done, GT-shaped** (orderlists per channel, shared pattern pool, 4 step tables, 63 instruments, subsongs) | `src/audio/tracker/sid-doc/types.ts` |
| `.sng` import (GTS5 + GT1 `GTS!`) | Done, 83/83 corpus round-trip | `gt-sng-read.ts`, `gt-sng-gt1.ts` |
| `.sng` writer | **Written, not reachable from the UI** | `gt-sng-write.ts` (`exportGtSong`) |
| Pattern cell editing | Done: note / instrument / command cells, undo, shared-pattern write-back | `grid.ts`, `tracker-store.ts` `syncSidWriteBack` |
| Instrument page | Done: ADSR, waveform bits, first-frame, gate timer, table rows, table templates, **add instrument** | `SidInstrumentPage.vue`, `sid-instrument-edit.ts`, `sid-table-rows.ts` |
| Song structure (orderlists, pattern pool, lengths, subsongs) | **Ops only for `setSidOrderEntry`; no UI.** The grid refuses structure edits by design (`grid.ts` header) | `ops.ts` |
| Song texts, tempo, multispeed | Ops exist (`setSidSongTexts`, `setSidTiming`), no UI | `ops.ts` |
| New SID song | `createNewSidDoc` exists, **not wired** (New Song only resets to the native format) | `doc.ts`, `TrackerPage.vue:2350` |
| Export dialog | Registry has AHX, HVL, placeholders; **no SID row** | `song-export/registry.ts` |
| `.sid` / `.prg` | Nothing | — |
| GT oracle | `gtref` (GT's `gplay.c`, headless) dumps all 25 registers per frame; 83/84 corpus songs exact vs our Rust player | `.ai/sid-oracle/` |

### The blocker nobody would see until export

There are **two instrument dialects** in the doc, and the exporter only accepts one:

- **GT-style** (`waveform == 0`, what the importer writes): the wave/pulse/filter tables set
  everything; follows GT's first-frame rules (`player.rs:1070`).
- **App-style** (own `waveform` / `pulseWidth` / `filter`): what `DEFAULT_SID_INSTRUMENT`
  is (`waveform 0x40, pulseWidth 0x800`), so **every instrument made by "add instrument",
  and instrument 1 of every `createNewSidDoc` song**.

`gtSongExportProblem` refuses the second kind (`gt-sng-write.ts`). So today a user who
creates an instrument can never export the song to GoatTracker. The exporter also refuses
any `doc.tempo != 6`, which `createNewSidDoc({ tempo })` allows.

This is the first thing to fix, because every later phase (`.sng`, `.sid`, `.prg`) writes
GT's data format and runs GT's rules.

---

## 2. Decisions

**D1. One instrument dialect: GT-native. DECIDED (Morten, 2026-09-25): "make it all
goattracker-style instruments".** No conversion path: the tracker has no users yet, so the
app-style dialect is **removed**, not migrated.
- `SidInstrument` loses `waveform`, `pulseWidth` and `filter`; the wave/pulse/filter
  tables set them, as in GT. The SID file codec bumps its version; the old version is
  refused on load (no files in the wild; demos are `.sng`).
- `player.rs` loses its non-GT branch (`gt_style`, `player.rs:1070`): GT's first-frame and
  filter-routing rules apply to every instrument. Settles `sid_decisions.md` §2.
- The instrument page keeps its "simple" controls (waveform boxes, pulse width, filter)
  but they edit the instrument's own table rows (the `SidWaveTarget` machinery already does
  this for wave-table rows).
- Tests that build own-waveform instruments get table-row instruments instead: Rust
  `tests_s5.rs`, `tests_s510.rs`, `tests_s512.rs`, `tests/sid_gate_off.rs`, the `.asid`
  fixtures; TS `sid-doc`, `sid-table-rows`, `sid-instrument-page`, `sid-sng-export` tests
  and `helpers/sid-chain-song.ts`. The corpus register gates must not move (imports are
  already GT-style).

**D2. `.sid`/`.prg` player: GoatTracker's own playroutine first, our own later. DECIDED
(Morten, 2026-09-25): GT's player as the first step; a custom player is the goal once
everything works (Phase 7).**
`/tmp/gt2-src/src/player.s` (1 808 lines) states: *"This playroutine source code does not
fall under the GPL license! Use it, or song binaries created from it freely for any
purpose, commercial or noncommercial."* That is the 6502 routine every exported GT tune
runs, and the one our Rust player was already matched against (the "Ballad" note in
`sid_decisions.md` §3 is about it). So:
- we ship `player.s` (with its licence header) and assemble it at export time;
- we write our **own** TS assembler for the subset of the Exomizer-assembler dialect it
  uses (`.IF/.ELSE/.ENDIF`, `=` defines, labels, `<`/`>`, `.BYTE`), ~500 lines;
- we write our **own** packer: doc → the data layout `player.s` reads (orderlists,
  packed patterns, instrument columns, tables). `greloc.c` (GT's relocator) is GPL, so it
  is a reference for facts only, like `gplay.c` has been — no code copied.

This is a far smaller and safer job than a from-scratch 6502 player, and the result is
bit-for-bit GT's behaviour on a real C64. It also builds everything the custom player
needs later: the 6502 test emulator, the per-frame register gate, the PSID/PRG wrappers,
and the assembler.
*Rejected:* pre-rendered register dump per frame — huge (25 regs × 50 Hz), doesn't loop
cleanly, not what "GoatTracker export" means. **Action before Phase 4:** confirm the
licence line in the upstream GT 2.7x `player.s` (the local copy's header says 2.68).

**D3. `.sid` wrapper: PSID v2. DECIDED (Morten took the recommendation, 2026-09-25).** This
reverses the old plan's RSID pick. GT's routine is init/play shaped, which is exactly PSID; PSID is what HVSC,
sidplayfp, DeepSID and every hardware SID player expect. Multispeed songs set a CIA timer
in init with the speed bit set, as GT's own exports do. "Runs on a native C64" is covered
by the `.prg` export (D4), which drives the player from its own IRQ. RSID stays optional.

**D4. `.prg` in two steps.** First a plain `.prg` (BASIC `SYS` stub + IRQ shell + player +
data, a text screen with title/author) — small and useful on its own. Then the **branded
demo** as a separate phase once there is a brand to draw: logo (charset or bitmap),
colours, maybe raster bars/scroller/VU. That needs design input from you, so it is not
scheduled until assets exist.

**D5. Scope limits for this plan.** Single SID only (dual SID stays S7 of the old plan).
No `.sid` import. Chip model and multispeed are not in a `.sng` (reported as notes, as now);
they ARE written into `.sid`/`.prg` (PSID flags, CIA timer).

**D6. Tempo for new songs.** Keep `doc.tempo = 6` for everything we create; the song
settings panel's "tempo" writes/updates an `F` command on row 0 of voice 1's first pattern
(GT's own way). Fixes the exporter refusal without a format change. `sid_decisions.md` §4
(tempo `6*mult-1` at multispeed) gets fixed in the same phase since it touches the same code.

---

## 3. Phases

Each phase is independently landable and useful. Gates follow the existing discipline
(red-first, true refusal texts, corpus counts unchanged, `npm run test:run`, cargo, lint,
vue-tsc).

### Phase 1 — `.sng` export in the dialog + GT-native instruments (S)

**Progress (2026-09-25, branch `agent/sid-authoring-p1-0925a`): part 1a LANDED on the branch —
the dialect removal (D1).** Done:
- Rust `song.rs`: `Instrument` has no `waveform`/`pulse_width`/`filter`; `InstrumentFilter`
  gone; ASID file version 2 (9-byte instrument), version 1 refused. `player.rs`: the non-GT
  trigger branch and `gt_style` are gone; every instrument runs GT's first-frame rules.
- TS mirror: `types.ts`, `doc.ts` (`SID_FILE_VERSION = 2`), `sid-file-codec.ts`, both `.sng`
  readers, `gt-sng-write.ts` (own-field refusal gone), `ops.ts`, the simulator
  (`sid-instrument-visuals.ts`, parity fixture regenerated from Rust and matching).
- New instruments and new songs sound: `DEFAULT_SID_INSTRUMENT` = GT's new instrument
  (first-frame $09, gate timer 2, hard restart); `newSidInstrument` and `createNewSidDoc`
  append `NEW_SID_INSTRUMENT_WAVE_ROWS` (41 00, FF 00) / `_PULSE_ROWS` (88 00, FF 00) and
  point at them; gate timer = `newSidGateTimer(multiplier)`.
- Instrument page: waveform boxes edit the sounding byte (first-frame / wave row / wave
  command; no "instrument's own" target); Pulse card's Start width edits the pulse table's
  first width row or appends one (`setSidInstrumentStartWidth`); Filter card edits the
  filter table's mode + cutoff rows or appends them (`setSidInstrumentFilterStart`), with
  mode, resonance, cutoff (8-bit) and per-voice routing boxes. Templates seed from table
  rows (`sidInstrumentWaveform` etc.).
- Fixtures regenerated through the app chain: `s3-chain.asid`, `s59-drum-example.asid`,
  `sid-visuals-parity.json`; wasm rebuilt. Test expectations moved only where GT's
  rules say so (table starts the frame after the note; fresh channel width 0; the note
  frame keeps the old pitch when a wave table sets it) — each commented in place.

**Part 1b (2026-09-25, uncommitted on `main`) — the `.sng` row and the `gtref` gate. Phase 1 DONE.**
- `song-export/sng-exporter.ts` (`sngExporter`, id `sng`, "GoatTracker 2 song"), in the registry
  after HVL. It writes the song's doc (`data.sidFile`) with `exportGtSong`; the writer's refusal
  is the row's reason, its notes (chip model, `-S`) the row's warnings. A title/author edited
  in the store (no longer the import's derivation of the doc text) is written into the doc
  text (latin-1, 32 chars, `SNG_TEXT_NOTE` when altered). A GT1 song with an empty name gets
  the title it showed (its file name) as its name. AHX/HVL rows now say "SID songs can't be
  saved as …". Tests: `song-export-sng.test.ts`, registry and dialog tests (a SID song
  downloads a `.sng` that imports as the song).
- **Gate, measured:** `.ai/sid-oracle/export_roundtrip.ts` (`SP=<dir> npx vite-node --config
  vitest.config.ts …`, needs `<dir>/rt/`) imports all 84 corpus songs, exports them (and each
  with one added instrument), checks each export imports back doc-equal; then
  `run_export_roundtrip.sh` runs `gtref` on every subsong (102), 4000 frames, all 25 registers:
  - original vs export: **62/62 GTS5 subsongs byte-identical** register streams (GT1 originals
    can't go through `gtref`; they are covered by doc-equality and the existing Rust gate);
  - export vs export + new instrument: **99/100 identical**; 2 songs skipped (wave table full,
    the app refuses the add). The one difference is GT's behaviour: `cadaver/maximum_rastertime_test`
    (GT1) ends its pulse table with `FF 02`, a jump to itself, as GT's own GT1 converter writes it
    (`gsong.c` "Pulse jump back to beginning"); GT runs that row as a pulse set and walks off the
    table's end into the appended rows. Adding rows in GoatTracker does the same.
  - Note: the writer's orderlist encoding is not byte-identical to GT's (Alien Funk 24 bytes
    shorter) but plays identically.

**Next:** Phase 2 (song structure editing) or Phase 3 (new SID song) — Morten's pick.

Original part-1b brief, for reference:
- `SongExportFormatId` += `'sng'`; `sidExporter` in `song-export/` over `exportGtSong`;
  `check` = `gtSongExportProblem`, `warnings` = the writer's `notes` (chip model, `-S`).
- D1: remove the app-style dialect (model, codec, player, tests — see D1).
  `DEFAULT_SID_INSTRUMENT` gets GT's new-instrument defaults (`ginstr.c:216-220`: first
  wave `$09`, gate timer 2×multiplier); `newSidInstrument` appends its own wave rows
  (`41 00`, `FF 00`) and pulse row and points at them.
- The exporter's own-waveform refusal goes away with the fields.
- **Gate:** every corpus song imports → exports → `gtref` register stream identical to the
  original's; a new instrument added to a corpus song exports and plays in `gtref`;
  round-trip doc-equal; corpus register gates (cargo + `gtref`) unchanged by the
  dialect removal.

### Phase 2 — song structure editing (M/L)

**Progress (2026-09-25, branch `agent/sid-authoring-p2-0925`, uncommitted): DONE as the FLAT MODEL.**

**Decision (Morten, 2026-09-25): no separate Song panel. "The ui [should] be the same for all
songs": a SID song is edited as song-wide patterns + a sequence, like a native song, and
GoatTracker's per-voice structure is built from that ("destructure and optimize when saving").
Per-voice restarts are kept as metadata. Each position is its own copy (an edit no longer shows in
every place a GT pattern played; identical cells still compile to one GT pattern).** The first
pass built doc-level orderlist/pattern/subsong ops for a GT-shaped panel; they were dropped when
the flat model replaced the panel (only instrument delete/clone survive, `instrument-ops.ts`).

- `sid-doc/flat.ts`:
  - `SidFlatSubsong` = patterns by id (per voice a `SidFlatCell`: raw rows, transpose, and
    `start`, "this voice starts a GT pattern here"), a sequence of ids, per-voice `restarts`
    (sequence indexes). Raw rows, not grid entries: key-ons and clamped notes survive.
  - `flattenSidDoc` / `flattenSidSubsong`: a position wherever any voice starts a pattern and where
    a voice must loop back to. **Exact loops**: the flat song is made long enough (up to 64× the
    first pass) that every voice is at one of its own pattern starts at the end, so looping from
    there plays on as GT does for ever; if that doesn't fit GT (compile fails) every subsong falls
    back to its first pass, and a voice that loops into the middle of a pattern gets a cut there.
  - `compileSidFlatSong`: each voice cut exactly at its `start`s (+ position 0, its restart, a
    transpose change, 128 rows); identical patterns shared across voices and subsongs; consecutive
    identical entries → repeat (never across the restart). Refusals, true: >208 voice patterns,
    orderlist >254 bytes, empty sequence, wrong sizes, transpose outside −16..+14.
  - **Found and why `start` exists:** GT's playroutine skips a voice's pulse-table step on the
    frame it starts a pattern (gplay.c:853, `optimizepulse`, on by default; `player.rs` copies
    it), so WHERE a voice's patterns start is audible. Recutting freely made 81/102 subsongs
    differ; keeping the starts made them identical.
  - Song settings on the flat song: `sidFlatTempo`/`setSidFlatTempo` (D6: F on row 0 of voice 1 of
    the first position; removed for 6 at 1x; refused ≤ any gate timer — GT checks voice 1's,
    gplay.c:333 — and when that row has another command), `setSidFlatSpeed` (a subsong without F
    gets GT's implied 6×m as F; an F stays), `addSidFlatSubsong`, `sidImpliedTempo` (incl. GT's
    hidden tempo from instrument 63's AD), `sidMinTempo`, `sidDocForSubsong` (the doc with one
    subsong: what the transport hands the worklet — no Rust change for subsong playback).
- Store (`tracker-store.ts`): `sidFlat` + `sidSubsong` state. The grid/sequence are the projection
  of `sidFlat[sidSubsong]` (`projectSidFlatSubsong`); `syncSidWriteBack` now encodes edited cells
  into the flat song (`sidCellRowsFromEntries`), takes the sequence, compiles; a compile refusal
  puts grid + sequence back with the reason. The native pattern/sequence actions work for SID
  (`hasFixedSequence` = AHX only; `hasDocStructure` still locks voices and slots); restarts follow
  their positions through move/remove/delete. `createPattern` makes 3 blank voices; lengths ≤128.
  A loaded/new doc is kept as is until the first edit (unedited songs save/export byte-exact).
  Snapshots carry `sidFlat`, `sidSubsong`, pattern names. `editSidFlat` (one undo step) backs
  `setSidTempo`, `setSidSpeed`, `add/clone/deleteSidSubsong`; `selectSidSubsong` (not an edit).
  Doc-level edits (instrument page) keep the grid when patterns/orderlists are untouched, else
  re-flatten.
- Transport: places via the SEQUENCE (a pattern may be named twice), plays `sidDocForSubsong`.
- UI: TrackerPage song header for SID songs: Tempo (frames/row), Speed (1-16x), Subsong select +
  new/copy/delete; sequence editor and pattern length unlocked for SID (≤128). The tracker page
  now SHOWS the edit notice (it never did: grid refusals were silent there). SidInstrumentPage:
  Copy (with copies of its table rows) and Delete (asks in the page when rows use it, then clears
  them and renumbers).
- Tests: `sid-flat-song.test.ts` (flatten/compile, drift, exact loops, refusals, all 84 corpus songs:
  same rows, same pattern starts except 3 documented voices, compile∘flatten identity),
  `sid-song-structure.test.ts` (store: shared ids, restarts through moves/removes, 128 clamp,
  254-byte refusal put back, undo byte-exact, save/load, subsongs), `sid-song-settings.test.ts`
  (instrument ops, tempo/speed/subsong ops and store actions + undo), page tests for Copy/Delete,
  playback test for subsong 1. `sid-grid-writeback.test.ts` rewritten where it pinned the old
  shared-pattern semantics. vitest 4306 passing, vue-tsc, eslint clean. No Rust change.
- **Gates, measured** (relinked gtref2 with MULT):
  - `flat_gate.ts` + `run_flat_gate.sh`: every corpus subsong, import → flatten → compile vs the
    import, **30 000 frames (past every loop), all 25 registers: 102/102 identical in gtref AND
    102/102 in our Rust player**. GT patterns 5303 → 3618 (sharing).
  - `structure_gate.ts` + `run_structure_gate.sh`, driving the REAL store actions: A, music-neutral
    edits (move there and back, append+remove, unsequenced new pattern, tempo to itself, new
    subsong) → **102/102 original subsongs identical in gtref**; B, 11 GTS5 songs with
    music-changing edits (new pattern with notes, moves, removes, length, tempo, 2×, new subsong
    with notes) → **33/33 subsongs gtref vs our player exact**, all 11 differ from the originals.
  - Browser (quasar dev, Chrome): New Song → SID, New Pattern (sequence grows), Tempo 8 (F08 in the
    grid; playback measured 6.25 rows/s = 50/8), Play through both positions, + subsong (stops,
    shows subsong 1 with F08), switch back, 2x (F kept), tempo 2 refused with the reason shown.
- Known approximations: (1) a voice that must loop into the middle of its pattern and whose exact
  loop doesn't fit GT gets a pattern cut at its loop row — one skipped pulse step there per loop
  (corpus: forest_encounter sub 1 v1+v2, investigations v2; inaudible there, gtref identical).
  (2) `sid_decisions.md` §4 still open: a multispeed subsong WITHOUT an F on its first row starts
  at GT's 6×mult but at our player's 6. Everything the app writes has the F, but a user can delete
  it (found by the gate when a helper wiped it). Cheapest fix: the player starts at 6×mult.
  (3) An imported song whose exact loop is long shows a longer grid (e.g. nintendometal
  1144 → 6376 rows): that is the song until its voices line up again.
  (4) Pattern names and unsequenced patterns are the editor's only; a save keeps the compiled doc.

**Next:** Morten's review/merge; then maybe: §4 fix in `player.rs`; a per-voice transpose control
in the grid header (cells keep transposes but only import sets them); grid conveniences
(insert/delete row per pattern already work — they are native now); Phase 4 (.sid).

GT's orderlist and pattern pool can't go through the tracker's one-sequence grid (that
is why the grid refuses them), so this is a dedicated **Song panel** in GT's own shape.
- Ops (pure, `ops.ts`, each one undo step via `editSidDoc`):
  insert/delete/move order entry, set restart, set transpose/repeat;
  new pattern / clone pattern / set pattern length (1..128) / delete unused pattern;
  delete & clone instrument (renumbering every row that names it);
  add/delete/select subsong; texts; tempo (D6); multispeed; chip model (exists).
  Table insert/delete already remap every pointer, jump, wave command and pattern
  command (`sid-table-rows.ts` `remapReferences`); instrument delete/clone and pattern
  delete need the same treatment for rows and orderlists.
- UI: per-voice orderlist columns (pattern number, transpose, repeat, restart marker),
  pattern list with length and users, subsong selector; playhead follows the orderlist.
  Grid shows the chosen subsong (`projectSidPatterns(doc, subsong)` already takes it).
- Grid conveniences that map cleanly onto one pattern: insert/delete row inside a cell's
  pattern (shifts that pattern only), "edit this pattern only" (clone-on-write when a
  pattern is shared, opt-in).
- Open question: per-channel cursors (`sid_decisions.md` §5) — defer unless the panel
  makes the drift visible.
- **Gate:** op-level round-trip tests; structure edits on corpus songs still export and
  match `gtref`; undo restores byte-identical docs.

### Phase 3 — new SID song from scratch (S)

**Progress (2026-09-25, branch `agent/sid-authoring-p3-0925`, uncommitted): SID part DONE; AHX not joined.**
- `createNewSidDoc(options)` (`sid-doc/doc.ts`): chip model, multispeed (1-16), pattern rows
  (1-128), `songName`/`author`, tempo per D6. `doc.tempo` is always 6. The tempo option is
  frames per row at the multispeed rate (GT's F semantics), 3-127, default 6 × multiplier
  (GT's own start). It is written as `F<tempo>` on row 0 of voice 1's pattern whenever it is not
  6 at 1x. So at multispeed the command is always there, and GT and our player start alike
  without the §4 fix. New refusal, measured: a tempo ≤ the new instrument's gate timer
  (2 × mult) makes GT **stop the song** (`gplay.c:333`, "illegally high gatetimer"; ours plays
  on). So the minimum tempo is 2 × mult + 1. All refusals are thrown with the true reason.
- Store `resetToNewSidSong(options)` = `adoptSidDoc(createNewSidDoc(options))`.
  `useTrackerFileIO.applyNewSong(reset)` shares `applySongFile`'s tail (`replaceSong`: stop, bank
  reset, module format, slot sync, post-FX AUTO reset, `initializePlayback`), so a new SID song
  is wired exactly like a `.sng` load. The host exposes it.
- `components/tracker/NewSongDialog.vue` replaces the old confirm. It offers Native / SID
  (GoatTracker) and SID options: chip, speed, tempo (follows 6×mult until edited; min follows
  the gate timer), and pattern rows. `createNewSidDoc`'s refusal is the dialog's message and
  disables the button. TrackerPage: native → the old path; SID →
  `applyNewSong(() => resetToNewSidSong(opts))`.
- Tests: `sid-new-song.test.ts` (doc, store, and a gate test: notes typed through the real grid
  composables → `sngExporter` from `serializeSong()` → imports doc-equal), and
  `new-song-dialog.test.ts`. The grid harness moved to `tests/helpers/sid-grid-harness.ts`
  (shared with `sid-grid-writeback.test.ts`).
- **Gate, measured:** `.ai/sid-oracle/new_song_gate.ts` makes 16 new songs (1x/2x/4x; default
  tempo, the lowest legal one, and 9; 16 and 64 rows; both chips) with notes and key-offs on all
  three voices. Each `.sng` imports back doc-equal. `run_new_song_gate.sh` compares `gtref` with
  our Rust player (new dev tool `rust-wasm/examples/sid_regs.rs`, which dumps the 25 registers
  per frame in `gtref`'s format): **16/16 register-identical, 4000 frames, all 25 registers**.
  GT's start offset is 6×mult−1 frames (5/11/23).
- **Oracle caveat found:** the `/tmp/gtref/gtref` binary predated `harness.c`'s `MULT` support
  and played every song at 1x. It was relinked from the objects in `/tmp/gtref` (`gcc -I. -Ibme
  -c harness.c; g++ harness.o gplay.o gsid.o resid_*.o resid-fp_*.o -lm`); check with MULT=1 vs
  MULT=2 on a song with no F command, whose outputs must differ. Phase 1's export round-trip was
  re-run with the relinked binary: the result is unchanged (162 pairs, the one known GT1
  difference).

**Next:** (a) AHX joins the dialog (`createNewAhxDoc` exists; needs an `adoptAhxDoc`-style
entry from a doc, not a file); (b) the song settings tempo (Phase 2 / D6) should apply the
same gate-timer rule, and the `.sng` exporter might warn when any instrument's gate timer is
≥ a row length the song sets (GT stops); (c) `sid_decisions.md` §4 (start tempo 6×mult for
imported multispeed songs without an F) is still open. New songs avoid it by writing F.
(d) Not yet tried in a browser: New Song → SID → type → play → export.

- New Song dialog gains a format choice (Native / SID-GoatTracker; AHX's `createNewAhxDoc`
  is in the same unwired state and can join the same dialog).
- `createNewSidDoc`: chip model, multispeed, pattern length; GT-native instrument 1;
  tempo per D6. Store action `resetToNewSidSong(options)` wiring doc, slots, song bank
  and the SID transport (same path a `.sng` load takes).
- **Gate:** new song → type notes → export `.sng` → `gtref` plays it register-identical to
  our player; load back → doc-equal.

### Phase 4 — `.sid` export (PSID v2) (M/L)
- `packages/…` or `src/audio/tracker/sid-export/`:
  - `asm6502.ts` — our mini assembler (dialect of `player.s`), with its own unit tests
    against hand-assembled opcodes.
  - `gt-pack.ts` — doc → packed song data at an address; feature defines chosen from what
    the song uses (start with everything on; strip later as a size optimisation).
  - `psid.ts` — 124-byte v2 header: name/author/released, load/init/play, songs =
    subsongs, speed bits, flags (PAL, 6581/8580 from `chipModel`).
- Export dialog row "C64 SID (.sid)" with a load-address option ($1000 default).
- **Test harness (the key gate):** a small 6502 CPU emulator (own code, test-only, Rust or
  TS) that runs init + N play calls and captures $D400-$D418 per frame. Then, across the
  corpus, `.sng` → doc → `.sid` → emulator register stream must equal `gtref` (and so our
  Rust player) frame for frame, all subsongs, after the known start offset.
- Local manual check in VICE `vsid` / sidplayfp; you on real hardware for the final word.
- Size guard: refuse (true reason) when player + data would overflow the chosen memory map.

### Phase 5 — `.prg` export, plain (S/M)
- BASIC stub (`10 SYS 2061`), IRQ shell calling play once per frame (or CIA-timed at
  multispeed), subsong keys 1-9, a text screen with title/author/"made with another_synth".
- Also offer raw `.bin` at an address (GT's third format) for people linking the tune
  into their own code.
- **Gate:** same emulator harness, now booting the `.prg` from the stub; VICE `x64sc` smoke.

### Phase 6 — branded playback demo (M, needs design input)
Same player+data blob as Phase 5, with a demo shell: logo (charset/bitmap), colour
scheme, raster effects, scroller with song text, per-voice VU from the ghost registers.
Kept under a fixed raster budget so it never disturbs the player. **Needs from you:** logo
art (or permission to draw a PETSCII/charset one), colours, what the scroller says.

### Phase 7 — our own 6502 playroutine (L, later)
Morten's goal once the GT-player path works (D2). Replaces `player.s` behind the same
packer interface and wrappers. It must play the same doc to the same register stream,
so the Phase 4 emulator gate carries over unchanged: GT's player becomes the oracle.
Worth doing for what GT's routine can't give: our branding in the binary, a smaller or
faster routine for demos, and room for features beyond GT (dual SID, our own commands).

---

## 4. Order and sizing

1 → 3 → 2 → 4 → 5 → 6 is the order that gets a usable "make a song and take it to GT"
loop soonest (Phase 3 is small and makes Phase 2 testable from a clean slate). Phase 4
can start in parallel with Phase 2 (different files: `sid-export/` vs store/UI), after
the D2 licence confirmation.

| Phase | Size | Depends on |
|---|---|---|
| 1 `.sng` export + GT-native instruments | S | — |
| 3 New SID song | S | 1 |
| 2 Song structure editing | M/L | 1 |
| 4 `.sid` (PSID) | M/L | 1, D2 check |
| 5 `.prg` plain | S/M | 4 |
| 6 Branded demo | M | 5, brand assets |
| 7 Custom player | L | 4 harness |

## 5. Risks

- **Packer correctness** is the whole of Phase 4: the per-frame emulator comparison
  against `gtref` over 83 songs is what makes it safe; without that harness, don't ship.
- **Dialect removal** touches the Rust player, which is at 83/84 GT parity: only the
  non-GT branch may go; the corpus register comparison is the gate.
- **GT start-up offset** (our first note 5 frames before GT's, `sid_decisions.md`): the
  `.sid` will match GT, so it will be 5 frames "late" vs the editor. Harmless, but
  comparisons must align on it.
- **Multispeed in PSID** relies on the CIA timer set in init; some players handle that
  poorly. Test in sidplayfp and VICE.
- **Licence:** `player.s` free (verify upstream); `greloc.c`, `gplay.c`, reSID are GPL —
  facts only, as before.
