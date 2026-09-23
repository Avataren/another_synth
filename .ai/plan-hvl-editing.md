# Plan: full HVL editing + creation (parity with AHX editing)

Researched 2026-09-23, read-only, main checkout `2bd5963e`. Prepared for Morten's
decision; nothing here is landed. Labels: **MEASURED** (verified in this session,
file:line), **INFERRED** (reasoning stated), **UNVERIFIED** (needs a check before
implementation). A parallel fix pass (`agent/hvl-ux-fix-0923a`, worktree
`hvl-ux-fix1`) is investigating HVL transpose format support right now — its
outcome may update §2 and P2 and should be read before P2 is scoped.

---

## 1. Current state map

### 1.1 What parses today (two decoders, one of them full-fidelity)

**Rust** (`rust-wasm/src/ahx/format.rs`) parses the *complete* HVL structure:
header, subsongs, per-position per-channel track+transpose, tracks with the 5-byte
step and the `0x3f` blank-step escape, 22-byte instrument core + 5-byte HVL PList
entries, `mixgain`/`defstereo` (`parse_hvl`, format.rs:493-628; `Position { track,
transpose }` format.rs:160-164). It is the engine's decoder.

**But the Rust `Song` cannot re-save a file losslessly.** MEASURED drops:
- the blank-first-track flag (bit 7 of header byte 6) — track 0 is synthesized
  blank without remembering whether the file stored it (format.rs:514-518);
- the raw restart value before clamping (format.rs:604-608);
- the position of the name table (re-derived, not read);
- the loader-ignored bits of instrument cores (bytes 9-11, top 2 bits of b19);
- Latin-1 names are decoded with `from_utf8_lossy` (format.rs:209-213), mangling
  non-ASCII; the TS parser does not.

**TypeScript** has the real round-trip pair: `packages/tracker-playback`
`parseAhx` (reader, formats/ahx) + app-side `serializeAhx`
(`src/audio/tracker/song-export/ahx-writer.ts:176-292`). The writer already writes
**both** AHX and HVL — 5-byte steps, blank-step escape, channel count, mix gain,
defstereo — and is byte-exact over the whole 100-file corpus with `base`
(`ahx-writer-corpus.test.ts:1-90`: 77 .ahx + **23 .hvl**, updated 2026-09-23).
Without `base`, 7 files differ with documented diffs (`:24-64`). The corpus's one
exception: `meltwater_10ch.hvl` round-trips as source + one trailing NUL, because
the file omits the last (empty) instrument name's terminator (`:57-64`).

Inherent parse normalizations that are NOT undone and are documented
(ahx-writer.ts:20-24): restart ≥ positionNr clamps, AHX subsong start past end → 0,
AHX v0 filter-toggle param strip, and the blank-step escape (an all-zero 5-byte
step re-encodes as `0x3f` — 4 bytes shorter; corpus files all use the escape).

The Rust side has **no encoder at all** (rust-wasm/src/ahx contains no serialize
function). Nothing re-saves from Rust today.

### 1.2 How a song plays

The worklet engine plays **file bytes only** — never a doc model. Load path:
`applySongFile` (`useTrackerFileIO.ts:362`) → song-bank/playback store
`loadSong` → engine `load-song`. Live editing for AHX works by *rebuilding the
file* from doc+slots (`buildAhxFile`), then a debounced reload: edits call
`commitAhxDoc` → `publishAhxBytes` (`tracker-store.ts:1531-1569`), the playback
store's `handleAhxStructureChange` schedules `ahxReloadScheduler` (350 ms idle /
2 s max, `ahx-reload.ts`) when playing, or keeps a space map when paused
(`tracker-playback-store.ts:623-645`). HVL gets this whole pipeline for free the
moment it has a doc — no engine change is needed.

### 1.3 Why HVL's grid is a read-only mirror

`tracker-store.ts:510-529`: `isAhxEditable = moduleFormat==='ahx' && ahxDoc`,
`isReadOnly = ahx && !ahxDoc`. HVL never gets a doc:
- `docFromSong` throws for HVL — "Only AHX songs have an editable doc; HVL songs
  stay read-only." (`ahx-doc/doc.ts:47-49`);
- the load path skips attaching a doc for non-AHX (tracker-store.ts:1313: `if
  (!record || record.format !== 'ahx') return;`);
- the doc type is hardwired: `format: 'ahx'`, `AHX_CHANNELS = 4`
  (`ahx-doc/types.ts:4,19,35` — comment: "HVL's variable width has no doc (plan
  section 6)").

So HVL songs play from their file with the grid as an eye-mirror. Every edit
surface gates on these: edit mode (`readOnlyHint` "AHX/HVL songs are read-only",
TrackerPage.vue:1128), the transpose header chip (needs `isAhxEditable`,
TrackerPage.vue:1140-1167 → `setAhxPositionTranspose` guard tracker-store.ts:1584),
add/remove track, instrument slot UI, and **the sequence panel is read-only for
every AHX song too** — `:readonly="isReadOnly || isAhxSong"` (TrackerPage.vue:320).

The row-model projection deliberately drops transposes: one synthesized pattern per
position, `entry.note` renders the raw step note "ignoring transpose"
(`packages/tracker-playback/src/import/ahx-patterns.ts:1-28`; `projection.ts:29`
mirrors positions with `transpose: [0,0,0,0]` in the docless path).

### 1.4 What the exporters do today

- **HVL export row** (`hvl-exporter.ts`): writes the *original source bytes* back
  with the store title swapped in — only the title reaches the file; grid edits and
  author/BPM are silently not written (its own doc comment, hvl-exporter.ts:1-10).
- **HVL→AHX conversion** (`hvl-to-ahx.ts`): converts to AHX only when the tune
  fits 4 channels / no second FX column / no HVL-only `EF1` / AHX-writable
  instruments; **none of the 23 demo HVL files fits** (4ch cap alone kills them).
- **AHX export row** (`ahx-exporter.ts`): trusts the embedded `data.ahxFile`
  without a format check (`plan`, ahx-exporter.ts:61-67 returns decoded bytes as
  `file` unconditionally) — INFERRED risk: an HVL song's embedded HVL bytes can be
  handed to the user as `.ahx` if `data.ahxFile` is ever populated for one.

### 1.5 AHX editing end-to-end (the pipeline to replicate)

`ahx-doc/` holds the edit model (immutable, `markRaw`, frozen): types/doc/ops
(setStep, insert/delete position, makeUnique, setTranspose, …), size budget,
projection, build-file, new-song, edit-guard, slots, latin1
(`ahx-doc/index.ts:1-32`). Instruments live in `slot.ahxData` (single source of
truth); `buildAhxFile(doc, slots, title)` joins them and passes `{ base: doc.base }`
(ahx-writer.ts:223-224, plan-ahx-editing.md:224). Edits: grid → write-back watcher
(`syncAhxWriteBack`, tracker-store.ts:1405-1490) → `commitAhxDoc` → byte publish →
debounced engine reload (§1.2). Save flow: `data.ahxFile` in `.cmod` v5
(song-edit B2b, `useTrackerFileIO.ts:411-412`).

**But AHX editing is itself unfinished**: `createNewAhxDoc` and position ops exist
with no UI/store caller (only `resetToNewSong` native path, TrackerPage.vue:2438,
2445-2456 — no NewSongDialog); the planned position panel was removed in favor of
the header chip (merge `5179928c`); the sequence panel is still read-only for AHX
(§1.3). "Parity with AHX" therefore means parity with AHX *as it is today*, plus
the HVL deltas — not parity with the full song-edit plan.

## 2. Format ground truth (primary evidence, no web needed)

The vendored reference is in-repo: `.ai/ahx/references/hvl_replay.c` (1817 lines),
`hvl_replay.h`, `hvl.h`, `hvl_tables.c`.

- **Per-position, per-channel transpose: yes.** `struct hvl_position { uint8
  pos_Track[MAX_CHANNELS]; int8 pos_Transpose[MAX_CHANNELS]; }` (hvl_replay.h:75-79).
  The file stores 2 bytes per channel per position (`bptr += posn*chnn*2`,
  hvl_replay.c:353). The Rust decoder retains it (format.rs:543-560) and the writer
  re-serializes it (ahx-writer.ts:238-244). So HVL transpose is parsed, written and
  played (engine reads file bytes) — only the UI/projection ignores it today (§1.3).
- **Nothing in HVL is missing from the song model.** Ring modulation, panning (FX
  0x7, hvl_replay.c:636-642), the version-1 misc-flags effect, second FX column —
  all are *commands/data* the model carries, not extra file sections. (Checked
  against hvl_replay.c:330-549 loader and :620-660 FX dispatch; cross-checked by
  the Claude opus-5.5 investigation run.)
- **No unknown chunks / padding to preserve.** HVL is a fully specified fixed
  layout after the 16-byte header; there is no "extra data" class. MEASURED via
  the corpus: decode→encode→decode is byte-identical for 23/23 HVL files with
  `base` (meltwater: 1-byte trailing-NUL normalization, documented and pinned).
- **Channel count**: `(buf[8]>>2)+4` → up to 67 encodable; the engine and the
  reference are hard-capped at `MAX_CHANNELS == 16` (format.rs:13-17,
  hvl_replay.h). Writer allows 67 (`ahx-writer.ts:60`) — a mismatch to cap in the
  editor (§4). Corpus max is 10 (meltwater_10ch.hvl).
- **Notes**: HVL notes are 6-bit-ish in practice but the byte field is u8, except
  note 63 (`0x3f`) which is reserved for the blank-step escape — the writer
  refuses note 63 (ahx-writer.ts:176-180). An HVL editor must refuse or remap it.
- **Versions**: HVL 0..1 only; `EF1` (fx `0xE`, param `0xF1`) is HVL-1-only
  semantics (hvl-to-ahx.ts:44-46 check). Round-trip pins: `ahx-writer-corpus.test.ts`
  (byte-exact, meltwater exception), `ahx-exporter-corpus.test.ts`,
  `song-export-hvl.test.ts` (title-only export), `ahx-readonly-audit.test.ts`
  (pins exact read-only flag counts per file — will need updating for every gate
  change).

## 3. Gap map (what must exist)

| Area | Gap | Where |
|---|---|---|
| Doc model | `AhxDoc` is AHX+4ch only: needs format tag, `channels` (from position width), `mixgain`/`defstereo`, HVL size budget (variable: blank step 1 byte, else 5) | `ahx-doc/types.ts`, `doc.ts`, `size-budget.ts` |
| Write-back | Channel loops hardcode `AHX_CHANNELS` (tracker-store.ts:1415, 1472); generalize to position width | `tracker-store.ts`, `useTrackerEditing` |
| Store gates | New capability, e.g. `isHvlEditable` (or doc-driven `isEditable`); attach doc on HVL load; undo/snapshot paths | `tracker-store.ts:510-529, 1313` |
| Writer | None — `serializeAhx` already writes HVL. Keep in app, library stays a reader (house rule, ahx-writer.ts:8-9) | none |
| Exporter | `hvl-exporter.ts` serialize from doc (title **and edits**); AHX exporter format guard; HVL→AHX stays as-is | `song-export/*` |
| Instruments | `ModuleFormat` has no `'hvl'`; comment warns stamping HVL slots `'ahx'` would be wrong (`ahx-import.ts:18-21`). Decide: add `'hvl'` slot format vs. defer HVL instrument editing | `instrument-types.ts`, `instrument-slots.ts` |
| UI | Second FX column hidden behind a setting (TrackerPage.vue:1197); transpose chip needs HVL channel labels ×N; paste/clipboard gates assume 4; spectrum analyzer maps hardcoded [0,3]/[1,2] stereo (TrackerSpectrumAnalyzer.vue:303-304); hints say "AHX" | `TrackerPage.vue`, pattern canvas |
| Sequence panel | Read-only for ALL AHX songs (TrackerPage.vue:320); decide whether HVL editing turns sequence editing on or keeps it off | `TrackerPage.vue` |
| Creation | No new-song UI at all for AHX; HVL needs `createNewHvlDoc` (channel count 4-16, version 1, default instruments, mixgain/defstereo defaults) | `ahx-doc/new-song.ts`, new dialog |
| Tests | `ahx-doc-corpus.test.ts` covers AHX docs only; `ahx-readonly-audit.test.ts` pins counts; write-back channel loop untested beyond 4 | `src/tests/` |

## 4. Staged pass plan (each independently landable)

| Pass | Scope | Size | Engine? | Gates that move |
|---|---|---|---|---|
| **P1** HVL doc model + load-with-doc | Extend `ahx-doc` to carry HVL (format, channels, mixgain/defstereo, HVL size budget), `docFromSong` HVL branch, store attaches doc for HVL, projection mirrors from doc. **No editing yet** — grid reads from doc, writes still refused. | L | No (TS only) | new `hvl-doc-corpus.test.ts` (docFromSong→buildAhxFile == source, 23 files, meltwater pinned); `ahx-readonly-audit` updated; no behavioral UI change |
| **P2** Grid editing + transpose chip + playback reload | Un-gate (`isHvlEditable`), write-back loops → channel count, undo, second FX column editing, note-63 refusal, paste gates, transpose chip for N channels. Reuses the file-bytes reload path — **zero rust-wasm changes**. | L | No | store edit-matrix tests for HVL, writeback test with 10ch fixture (meltwater), playback routing test, readonly-audit updated |
| **P3** Save/export from doc + format guard | `hvl-exporter` serializes doc (title + edits, `base` path for untouched songs), AHX exporter refuses non-AHX embedded bytes, corpus suite extended with mutated round-trips. Includes the **instrument-slot decision** (add `'hvl'` format vs defer instrument editing to a later pass — recommend defer: AHX slots' editor assumes 22-byte core + PList, HVL's is compatible wire-wise but the slot plumbing is per-format). | M | No | export dialog tests, song-export-hvl test rewrite (edits now land), writer corpus stays green |
| **P4** New HVL song creation | `createNewHvlDoc` (channels 4-16 picker, defaults: version 1, blank 4/16ch, default instrument set, mixgain 0x40/defstereo reference defaults — UNVERIFIED against Hively's own defaults, pin from Hively or ask Morten), new-song dialog shared with AHX. | M | No | new-song tests, end-to-end create→edit→save→reload |

P1 alone is landable and harmless. P2 is the pass where HVL becomes "editable";
its channel-count generalization is the dangerous part (§6). P3 and P4 are safe
follow-ups; P4 also finally delivers the AHX new-song dialog that song-edit B5
left unbuilt.

## 5. Sequencing vs the arch-review queue

The queue (`arch-review-2026-09-22.md:196-205`) is: N1 (1st) → N3 (2nd) →
**N4 song-bank lifecycle split (3rd)** → N2 transports (4th). The song-bank split
(P3/N4) is next per the standing plan.

Recommendation:
- **N4 first** (as queued): it introduces the shared instrument interface that
  removes the `as InstrumentV2` casts — exactly the plumbing the HVL
  instrument-slot decision (§3, P3) sits on top of. Doing HVL instrument work
  before N4 would mean writing against the union it is about to delete.
- **P1 may run alongside N4**: it is pure `ahx-doc/` TS, touches no store, no
  song-bank, no engine. No worktree collision if P1 takes its own worktree.
- **P2 after N4 lands**: it edits `tracker-store`/playback wiring that N4's
  characterization tests will be pinning; interleaving would re-paint those tests.
- **Do not interleave with the in-flight `hvl-ux-fix-0923a` transpose pass**;
  fold its outcome into P2's scope instead (it may already fix the transpose
  display/format question P2 would otherwise absorb).

## 6. Honest risks

1. **This is Song-Edit round two.** The AHX editor took roughly: export/writer
   corpus plan → B1 → B2a (+review round) → B2b → B3 (+review blocker fix) →
   B4/B5 PList passes → instrument-page passes (merge evidence: `328f12ed`,
   `45962cbc`, `4dab3a9e`, `d5123cef`, `8493e8c8`, `397fdf6e`, `334a5b47`, plus
   later UX fix passes) — **8+ landed batches over ~4 days, several with
   re-review rounds**. HVL inherits that architecture (the big win) but
   multiplies the surface: variable channels ×16, second FX column, and a
   half-finished AHX editing stack (no new-song UI, sequence panel read-only,
   no position panel) that P2/P4 must finish *for HVL* and arguably for AHX too.
2. **The channel-count generalization is the sharpest risk.** Every loop that
   says `AHX_CHANNELS` today is a silent-edit-loss bug for channels 5-16 if
   missed: the write-back (tracker-store.ts:1415, 1472), paste/clipboard, the
   projection, the spectrum analyzer. Channels 1-4 will test green while 5-16
   silently drop edits. Mitigation: P2's first commit must be the 10-channel
   fixture (meltwater) with a red write-back test.
3. **note 63 (`0x3f`) cannot be encoded** — the editor needs an explicit refusal
   UX, not a writer throw mid-save.
4. **16-channel UI strain**: grid width, transpose chip labels, "Add/remove
   track" affordances, mixer-ish panels all assume 4 columns today. Expect a UI
   pass inside P2/P4, not a free ride.
5. **Export today already loses HVL edits** (title-only, hvl-exporter.ts:1-10) —
   users may currently type into the (refused) grid with no data loss because
   edits are refused; once editing unlocks, P3 must land promptly or an editable
   HVL song silently can't save its edits.
6. **Instrument editing is deliberately out of the first three passes.** HVL
   instruments are byte-compatible at the core level (`serializeAhxInstrument`
   handles both) but slot plumbing, ModuleFormat, and the instrument editor UI
   are per-format. Recommend a separate later pass with its own corpus.
7. **Doc-less HVL songs (recovered `.cmod` without bytes)** stay read-only, same
   as AHX today — acceptable, mirrors existing behaviour.
8. **Not modeled in either format's editor**: subsong editing, per-version
   semantics differences — same boundary the AHX plan drew (plan-ahx-editing.md
   §8.14). HVL subsongs exist in the model and survive round-trips; editing them
   is out of scope.

## 7. Bottom line

The feature is safe to stage and much smaller than it looks from the outside,
because the expensive pieces already exist: a byte-exact HVL **writer**,
byte-exact **corpus round-trips** (23 HVL files), a proven **doc → rebuild →
reload** editing pipeline, and an engine that plays HVL from file natively. The
real work is (a) widening the doc model and every 4-channel assumption, and (b)
finishing editor affordances that even AHX doesn't have yet (new song, sequence
panel). Recommended first pass: **P1 (doc model + load-with-doc)** — pure TS, no
engine touch, landable independently, and it produces the corpus test harness
P2 needs.

---

## 8. P1 status — landed on `agent/hvl-doc-0923a` (2026-09-23, not pushed/merged)

Commits: `b55c4b46` feat(ahx-doc): carry HVL songs in the doc model ·
`7f612e8d` feat(tracker-store): attach a read-only HVL doc at load.

### What the doc model now covers
- `AhxDoc = AhxFormatDoc | HvlDoc` (`ahx-doc/types.ts:46-63`). The AHX variant
  keeps its old shape exactly (no `channels` key), so AHX docs and every AHX
  test are unchanged. `HvlDoc` adds `channels` (4..16, `HVL_MIN/MAX_CHANNELS`,
  types.ts:4-12), `mixgainRaw` (header byte 14) and `defstereo` (byte 15).
- `docChannels(doc)` (doc.ts:52) is the width every channel loop should ask.
- `docFromSong` HVL branch (doc.ts:59): builds an `HvlDoc`; throws only for an
  HVL song wider than 16 channels (engine/reference cap — such a file keeps its
  import display). `docToSong` (doc.ts:94) writes format, width and mix bytes.
- Size budget (size-budget.ts:28-54): HVL = 16 + 2·subsongs + 2·channels·positions
  + Σ(stored steps: 1 blank / 5 other) + instruments with 5-byte PList rows.
  `ahxInstrumentBytes(instruments, format = 'ahx')`. Proven equal to `nameOffset`
  for all 23 HVL files, with and without `base`.
- Projection: `projectTracks` uses `docChannels` (projection.ts:38);
  new `projectDisplayPatterns` (projection.ts:25) = the import's grid (latch,
  clamp) with stable `ahx-pos-<n>` ids and `positionTranspose`.

### Load path
- `adoptAhxDoc` (tracker-store.ts:1338-1341): an `'hvl'` source record goes to
  `adoptHvlDoc` (tracker-store.ts:1377-1392) → `hvlDoc` + grid rebuilt with
  `projectDisplayPatterns`, sequence = stable ids, current pattern kept by index.
- Embedded `data.ahxFile` that decodes to HVL: explicitly refused
  (tracker-store.ts:1349) — same behaviour as before, now that `docFromSong`
  no longer throws for it.
- `hvlDoc` cleared on `loadSongFile` (:1183) and `resetToNewSong` (:719);
  carried by reference in snapshots (:612, :636).

### Deviations (each justified)
1. **Separate `hvlDoc` field instead of `ahxDoc`.** The plan says "store
   attaches doc for HVL". Putting it in `ahxDoc` would flip `isAhxEditable`/
   `isReadOnly` (both key on `ahxDoc !== null`) and reach ~15 readers that are
   edit/publish/save paths: `publishAhxBytes` (installs bytes tagged
   `format:'ahx'`), `flushAhxBytes` on a title change, `serializeSong` embedding
   a rebuilt `ahxFile` (the AHX-exporter risk of §1.4), the write-back watcher,
   `applySnapshot`'s republish, instrument growth guards, useTrackerFileIO:411.
   Each would need a format guard now and un-guarding in P2. A separate
   display-only field guarantees no gate, playback or save change in P1.
   **P2's first job: move `hvlDoc` into `ahxDoc` while auditing exactly those
   readers** (they are the §6 risk list).
2. **Display projection, not the editable one.** "Grid renders from the doc,
   display parity" + "no behavioural UI change": HVL uses
   `projectDisplayPatterns`, which a corpus test proves equal to the import's
   grid (modulo ids) for all 23 files. The editable projection
   (`projectAhxPatterns`: no latch, no clamp) would visibly drop latched
   instrument numbers. P2 switches to `projectAhxPatterns` when it opens edits.
3. **Field name `mixgainRaw`, not `mixgain`** — matches `AhxSong.mixgainRaw`
   (it is the raw byte; the replayer's gain is `(b<<8)/100`, hvl_replay.c:406).
4. `projectTracks` generalized to `docChannels` (doc module, not the store
   write-back loops) — needed for the model to be internally consistent; AHX
   identical (4). Store loops at tracker-store.ts write-back remain 4-channel (P2).
5. Two store callers pass `this.ahxDoc.format` to `ahxInstrumentBytes`
   (:1103, :1432) so totals match `instrumentGrowthRefusal`'s internal math;
   no-op for AHX (the only doc there in P1).

### Readonly audit
No delta. `ahx-readonly-audit.test.ts` pins unchanged (store 4, selection 7,
Jukebox 0, TrackerPage 25). One doc comment was worded to avoid a spurious hit.

### Tests
- New `src/tests/hvl-doc-corpus.test.ts` (10): 23 files; header fields; model
  lossless (`docToSong(docFromSong(parse)) == parse`); `base` serialize and
  `buildAhxFile` byte-exact (meltwater +1 NUL pinned); doc→serialize→parse ==
  parse with/without base; size budget == nameOffset; PList row widths; display
  projection == import grid; `projectTracks` at HVL width.
- New `src/tests/hvl-doc-channels.test.ts` (7) — **P2's structural guard**:
  meltwater_10ch.hvl and a synthesized 16-channel song (distinct track content,
  2nd FX column and both-sign transposes per channel) keep every channel's
  tracks and per-position transposes through parse→docFromSong→serialize→parse
  (base and no base); 17 channels has no doc; store load attaches `hvlDoc` with
  all 10/16 channels, gates unchanged `[true,false,true]`, `ahxDoc` null, engine
  bytes untouched, no `ahxFile` on save, history refused; loads clear it; a
  17-channel song keeps its (16-capped) import display. Note: meltwater only
  transposes channel 2, so the 16-ch song is what guards channels 5-16's
  transposes.
- Changed: `ahx-doc-ops.test.ts` "refuses an HVL song" → "gives an HVL song an
  HVL doc" (intended behaviour change); `synthetic()` typed as `AhxFormatDoc`.

### Gates (outputs in `.ai/checks-P1-*.txt`)
| Gate | Result |
|---|---|
| Baseline `npx vitest run` | 235 files / 3841 tests, pass |
| `npx vitest run` after | 237 files / 3858 tests, pass (+17 new) |
| `npx eslint --ext .js,.ts,.vue ./` | 0 errors, 0 warnings |
| `npx vue-tsc --noEmit` | 0 errors |
| `gitleaks detect --no-git --source .` | no leaks |
| `npm run check:artifacts` | ok |
| `ahx-doc-corpus`, `ahx-writer-corpus` (100 files) | pass (in full run) |

### Notes for P2/P3
- `songNameFor`'s fallback is `'Imported AHX'`; an HVL with an empty name
  imports as `'Imported HVL'`, so `buildAhxFile` would write that title into
  the file. No corpus HVL has an empty name (test passes); fix in P3.
- The ops (`ops.ts`) and `edit-guard.ts` still use `AHX_CHANNELS`; nothing
  hands them an HVL doc in P1.

## Landing record (2026-09-23, agent/hvl-doc-0923a P1)

Merge: `eeb6055d` (`git merge --no-ff`, parents `b8815689` + `22668ae9`, message:
"Merge agent/hvl-doc-0923a: HVL doc model (review PASS on 22668ae9)") on LOCAL main,
not pushed at merge time. The branch was based on `6123b5f4`, which still had
`chiprolled.hvl` (removed on main by `6d02f6d2`), so the branch's new
`src/tests/hvl-doc-corpus.test.ts` carried stale corpus pins `toBe(23)` and the vitest
gate failed on main after merge.

### Re-measure commit (documented, no amend)

First re-measured, then fixed: `public/demos/ahx/` has **22 .hvl** + 77 .ahx = 99 total;
`chiprolled.hvl` confirmed absent. Pin-fix commit `6cb62fcf`
("test(hvl-doc): re-measure corpus pin 23→22 after chiprolled.hvl removal (documented
re-measure)"), a follow-up commit on main — NO amend, no history rewrite.

**Scope note (delegated decision):** the task brief listed the two `toBe(23)` pins plus
the names "reads the 23 HVL files"/"all 23", but `all 23` appears in 6 test names and a
`last updated at 23 .hvl files` re-measure comment. Updating only some would leave the
file self-contradictory, so every corpus-size reference was updated (2 pins + 6 test
names + 1 comment) — 9 lines, nothing else.

### Review reference

Delta re-review **PASS** on branch tip `22668ae9` (per merge commit message; the branch
carried its own `.ai/checks-P1-*.txt` gate outputs and P1 status section above).

### Post-merge gates on main after `6cb62fcf` (real exit codes, this run)

| Gate | Result | Exit |
|---|---|---|
| npm run test:run (vitest full) | 237 files / 3851 tests passed (62.45s) | 0 |
| npm run lint (eslint .js,.ts,.vue) | no findings | 0 |
| npx vue-tsc --noEmit | clean | 0 |
| gitleaks detect --no-git | no leaks (3.44 GB scanned, 1m24s) | 0 |
| npm run check:artifacts | worklets + wasm match sources | 0 |

### Push

`git push origin main`: `b8815689..6cb62fcf main -> main`, exit 0, no force.

### Deploy

`scripts/deploy.sh` → `avatar@192.168.50.161:~/repos/docker-info-ws-server/html/synth`.
Build succeeded (spa mode, 37 JS files); wasm rebuilt per script design (freshness via
`SOURCE_HASH.json`); script self-verification `Deployed and verified
(3d2af47ed5258f81684b971fbcd14c7a)` (index.html md5); deploy exit 0.

**Fresh md5 spot-check (local `dist/spa` ↔ remote, all identical): 3/3**

| File | md5 |
|---|---|
| index.html | `3d2af47ed5258f81684b971fbcd14c7a` |
| demos/index.json | `5ce336fd304f097e036523b53ed45f62` |
| wasm/audio_processor_bg.wasm | `0b9548f882892c38b7574b9d106ca8ad` |

## 9. P2 status (agent/hvl-edit-p2-0923a, not merged) — COMPLETE (Option 1)

Branch `agent/hvl-edit-p2-0923a`, not pushed, not merged, not deployed. Commits
on top of P1 (`9367d23c`): `fb70a7d2` red 10-ch write-back test · `87528052`
unified doc slot · `044d1bd2` red edit matrix (the stop) · `c953c336` Option 1 ·
`251a0dd8` playback routing test · `2ccbdb14` HVL-aware hints · this docs commit.

### Decision record (2026-09-23)
- **Blocker** (`.ai/p2-stop-notes.md`): HVL imports keep no instrument slots
  (`ahx-import.ts:57`), so `buildAhxFile(doc, slots, title)` wrote every edited
  HVL file with 0 instruments (meltwater 10 → 0, 8207 → 7589 bytes).
- **Decision (Morten via main, final): Option 1: the HVL doc carries its own
  instruments until P3.** Options 2 (pull P3's `'hvl'` slot format into P2)
  and 3 (fall back to `doc.base`'s instruments) were rejected.
- **Rationale:** smallest change, no UI change (nothing instrument-related
  opens), corpus byte-exact (same instruments, same writer).
- **Instrument EDITING for HVL stays deferred to P3's slot decision** (§3
  Instruments row, §4 P3, §6 risk 6). No P3 scope was opened: HVL save/export
  still refused (the title-only exporter gap stays flagged), no new-song work,
  no AHX-exporter format guard, no `ModuleFormat`/`instrumentFormat` change, no
  rust-wasm change. If P3 chooses `'hvl'` slots, it moves `HvlDoc.instruments`
  into them and `fileInstrumentSlots` goes back to "slots for both".

### What moved
- `c953c336` feat(ahx-doc): HvlDoc carries its instrument set
  - `ahx-doc/types.ts:76` `HvlDoc.instruments` (readonly, instrument n at index
    n-1; required on HVL, absent on AHX, so AHX docs keep their exact shape).
  - `ahx-doc/doc.ts:21` `PLACEHOLDER_INSTRUMENT` (moved from build-file.ts, same
    value as the parser's `defaultInstrument`); `:41` `copyInstrument` (the doc
    shares no object with the parse, as with its steps); `:114` docFromSong
    fills it; `:131` `docToSong`'s instrument list now defaults to the doc's own
    (`:154` `ownInstruments`: placeholder + HVL instruments, none for AHX), so
    `docToSong(docFromSong(parse)) == parse` holds with no list given. Every
    explicit-list caller (projection, tests) is unchanged.
  - `ahx-doc/build-file.ts:72` `fileInstrumentSlots` (AHX → the slots,
    unchanged; HVL → the doc's instruments), `:77` `fileInstruments`; `:90`
    `buildAhxFile` writes through them. Same latin-1 pass, same writer, 5-byte
    HVL PList rows and `ahxInstrumentBytes(…, format)` unchanged.
  - `stores/tracker-store.ts:1395` `ahxOpContext` counts `fileInstruments`:
    before, an HVL song's instrument bytes were 0, so the 64 KiB size guard
    undercounted by every instrument (found while wiring, fixed, test-pinned).
  - Tests: `hvl-edit-matrix.test.ts` 11/17 → 18/18 (+1 at `:316`: meltwater
    after a channel-10 edit re-parses with `instrumentNr` 10, instruments equal,
    `nameOffset` growth == the doc's size-budget growth, string table = source
    + the pinned trailing NUL, so file = source + 1 + growth; no slot holds an
    instrument; `ahxOpContext` == the source's instrument bytes).
    `hvl-doc-corpus.test.ts` 10 → 12 (`:92`: doc instruments == parse's, copies,
    `docToSong` with no list == parse, all 22; `buildAhxFile` with the store's
    empty slots and with a stray slot byte-exact, budget via `fileInstruments`
    == nameOffset, all 22).
- `251a0dd8` test: `src/tests/hvl-engine-sync.test.ts` (5, new), the playback
  routing test on `ahx-engine-sync.test.ts`'s harness (real stores, transport,
  reload scheduler, real loader; fake worklet client), meltwater_10ch, edits on
  channel 10. Unedited: the worklet is handed the file byte for byte, tagged
  HVL; flush/snapshot/save/stop+Play keep the same array, announce nothing, load
  nothing new. Playing: an edit publishes at once (one structure change) and
  after `AHX_RELOAD_IDLE_MS` one load/seek/play burst of the edited file with
  all 10 instruments. Stopped: nothing sent; the next Play loads it once. Undo
  while playing reloads the file's own song (parse == source).
- `2ccbdb14` fix(tracker-page): the P2 UI polish left at the stop (§3 UI "hints
  say AHX"). Text only: `TrackerPage.vue:1206` `hvlDocChannels`; channel hint
  says the HVL song's own width, instrument hint says HVL instruments come from
  the file and cannot be edited yet (P3), length hint says AHX or HVL,
  `readOnlyHint` (`:1130`) no longer claims every AHX/HVL song is read-only.
  `tracker-store.ts:525` `isReadOnly` doc comment updated. No condition changed.

### P2 row (§4) verified
| Item | Status |
|---|---|
| Un-gate (`isAhxEditable` for HVL with a doc) | `87528052`; matrix "loads editable" |
| Write-back loops at `docChannels` | `87528052`; `hvl-writeback-10ch` 4/4 (file unchanged) |
| Undo/redo, snapshot carry the doc (and its instruments) by reference | matrix undo/redo + snapshot, 4 and 10 ch, green |
| Second FX column editing | `87528052`; matrix green (display still the existing user setting, unchanged) |
| Note-63 refusal | `87528052`; matrix pre-guard + write-back revert green |
| Paste gates at N channels | `87528052`; matrix incl. the width refusal green |
| Transpose chip N channels | works through the doc (`TrackerPage.vue` `ahxPositionChannels`); matrix transpose green |
| Reuses the file-bytes reload path, zero rust-wasm | `hvl-engine-sync.test.ts`; no rust-wasm diff |
| Readonly audit updated | re-measured: pins unchanged (store 4, selection 7, Jukebox 0, TrackerPage 25), test green |

### Gates at code tip `2ccbdb14` (outputs `.ai/checks-p2-*.txt`, real exit codes)
| Gate | Result | Exit |
|---|---|---|
| `npm run test:run` | 240 files / 3880 tests passed (3872 before + 8 new) | 0 |
| `npm run lint` | no findings | 0 |
| `npx vue-tsc --noEmit` | clean | 0 |
| `gitleaks detect --no-git` | no leaks | 0 |
| `npm run check:artifacts` | worklets + wasm match sources | 0 |

Corpus: 22 .hvl byte-exact with base (meltwater_10ch trailing-NUL exception
unchanged), also through `buildAhxFile` with the store's empty slots; 77 .ahx
untouched (`ahx-writer-corpus`, `ahx-doc-corpus` green, unchanged).

### Deviations (honest)
1. **One extra commit** beyond the planned three: `2ccbdb14` (hint text). It is
   a P2 item from the stop notes' own list, kept separate so the Option 1
   commit stays pure.
2. **`ahxOpContext` changed** (not named in the stop notes' Option 1 file list):
   without it the size guard for HVL counted 0 instrument bytes. Test-pinned.
3. **`docToSong`'s `instruments` parameter became optional** (default = the
   doc's own). Needed for the stated lossless property without an explicit
   list; all existing callers pass one and behave as before.
4. The hint strings have no test (the suite never mounts `TrackerPage`).
5. Still open for P3, unchanged: HVL `.cmod` save/`ahxFile` refused, exporter
   title-only for HVL, `'Imported HVL'` fallback title note (§8), HVL
   instrument editing / slots. The spectrum analyzer's 4-channel stereo map
   (§3 UI) was not in the P2 row and was not touched.

### Record of the stop (kept)

Stopped on a plan/code contradiction; details and options in `.ai/p2-stop-notes.md`.
§1.2/§1.5/§4-P2 assume HVL reuses `buildAhxFile(doc, slots, title)` for free, but
HVL imports keep no instrument slots (`ahx-import.ts:57`), so every rebuilt HVL
file has 0 instruments (meltwater: 10 → 0, 8207 → 7589 bytes after one edit).
The instrument source is the P3 slot decision (§3, §4-P3); P2 needs it first.

- Landed on the branch: `87528052` unified doc slot (hvlDoc → ahxDoc, every
  deviation-1 reader audited, write-back at `docChannels`, format-aware
  ops/entries/edit-guard, HVL save still refused / no `ahxFile` — P3).
- Red test before/after: `hvl-writeback-10ch.test.ts` 0/4 → 4/4 (unchanged file).
- New red test: `hvl-edit-matrix.test.ts` 11/17 pass; the 6 failures are the
  missing instruments (edit, undo/redo, snapshot at 4 and 10 channels).
- Exporter gap (unchanged, P3): HVL export is still title-only from the source bytes.
- Do not merge before the instrument-source decision (stop notes, option 1 recommended).

## Landing record (2026-09-23, agent/hvl-edit-p2-0923a P2)

Merge: `b275799c` (`git merge --no-ff`, parents `9367d23c` + `fefc1066`, message:
"Merge branch 'agent/hvl-edit-p2-0923a': HVL editing P2 (review PASS on fefc1066)")
on main at `9367d23c` == `origin/main`, no conflicts, no main movement since review.
Branch worktree `.ai/worktrees/hvl-edit-p2` clean at tip `fefc1066`, no owner marker /
foreign writer at land time.

### Review reference

**PASS on branch tip `fefc1066`.** Reviewer's verified highlights: 10-channel
write-back red-at-parent proof (`hvl-writeback-10ch.test.ts` 0/4 → 4/4, file bytes
unchanged), edit-matrix 18/18, Option-1 instrument carry corpus byte-exact (22 .hvl),
AHX paths unchanged (77 .ahx). Branch carried its own `.ai/checks-p2-*.txt` outputs
and `.ai/p2-stop-notes.md` decision record (Option 1, Morten via main).

### Post-merge gates on merged main `b275799c` (real exit codes, this run)

| Gate | Result | Exit |
|---|---|---|
| npm run test:run | 240 files / 3880 tests passed (65.00s) | 0 |
| npm run lint (eslint .js,.ts,.vue) | no findings | 0 |
| npx vue-tsc --noEmit | clean | 0 |
| gitleaks detect --no-git | no leaks (3.63 GB scanned, 1m31s) | 0 |
| npm run check:artifacts | worklets + wasm match sources | 0 |

### Push

`git push origin main`: `9367d23c..b275799c main -> main`, exit 0, no force.

### Deploy

`scripts/deploy.sh` → `avatar@192.168.50.161:~/repos/docker-info-ws-server/html/synth`.
Build succeeded (spa mode, 37 JS files / 12 CSS); wasm rebuilt per script design. This
branch touches no rust-wasm/ and `SOURCE_HASH.json`'s `sourceHash` (rust sources) is
unchanged; the rebuild's output hash drift vs the committed wasm is the known local
rebuild non-determinism, self-consistent with the local `SOURCE_HASH.json` and green
`check:artifacts` (pre-existing since the P1 deploy, not introduced by this branch).
Script self-verification `Deployed and verified (68a95542c35f3b5eff45a564120b4705)`
(index.html md5); deploy exit 0.

**Fresh md5 spot-check (local `dist/spa` ↔ remote, all identical): 4/4**
`index.html`, `demos/index.json`, `wasm/audio_processor_bg.wasm`, `worklets/ahx-worklet.js`.

Worktree: owner marker absent/cleared; worktree left in place for P3.

## 10. P3 status (agent/hvl-edit-p3-0923a, not merged) — COMPLETE (defer outcome)

Branch `agent/hvl-edit-p3-0923a` from `eb93ad3a` (main after the P2 landing);
not pushed, not merged, not deployed. Commits: `1d9aec5c` red save/export
matrix · `4a371ad1` empty-name fallback fix · `f89968f8` `.cmod` save ·
`0a0fe258` exporters + AHX guard · `f436709f` test helper (jsdom Blob) ·
`e626aadd` mutated corpus round-trips · this docs commit.

### Save/export semantics actually implemented
- **`.cmod` save** (`serializeSong`, `tracker-store.ts:1161`): an HVL song with
  a doc now embeds `data.ahxFile`, like an AHX one. The bytes come from
  `savedAhxBytes` (`:1173`): while nothing was edited since the load, the doc's
  `base`, i.e. **the source file byte for byte, with no rebuild**. "Nothing was
  edited" means `ahxPublishKey()` still equals the new `AhxSyncCache.loaded`
  key (`:462`, set at `adoptAhxDoc` `:1381`). That key holds the doc revision,
  the title and the slots, so an undo back to the original still counts as
  touched and takes the rebuild, which only differs for meltwater's trailing
  NUL. After any edit the embedded bytes are the `buildAhxFile` rebuild, which
  is the same file the engine plays.
- **Load**: `decodeAhxFile` accepts AHX and HVL and reports `format`
  (`ahx-file-codec.ts:27,52`). `adoptAhxDoc` takes an embedded HVL file as the
  song's doc and gives it no slots, because the doc carries its instruments
  (`tracker-store.ts:1364`). The P1/P2 refusal of an embedded HVL file is gone.
- **`handleSaveSongFile`** (`useTrackerFileIO.ts:198`) refuses only a song
  that has no doc. Doc-less HVL songs, such as a `.cmod` without bytes or a
  17-channel file, are still refused, the same as AHX (§6 risk 7).
- **`applySongFile`** (`useTrackerFileIO.ts:423`): an HVL doc with no source
  record, such as the Jukebox's `snapshotEditorSong`, which now carries
  `ahxFile` and so attaches no record, plays `doc.base`. Without this it would
  have played silence. Test-pinned.
- **HVL exporter** (`hvl-exporter.ts`): the embedded file is the authority and
  is exported as it is, with its edits, instruments and title. An embedded AHX
  file is refused with "AHX songs can't be saved as HVL." (`:44`). A song with
  no embedded file, such as a fresh import, uses its source record: if the
  title is untouched, the source bytes are returned as they are (`:81`, no
  rebuild); otherwise the title is written through `serializeAhx` with
  `base`, as before. Description updated (`:95`).
- **AHX exporter format guard** (`ahx-exporter.ts:69`): it hands out an
  embedded file only when that file is AHX. An embedded HVL file is converted
  like an HVL source record (`convertHvlToAhx`, which carries the edits) or
  refused with the conversion's reason. It is never written out as `.ahx`
  bytes.
- **Empty-name fallback (§8 note)** (`build-file.ts:13,45`): `songNameFor`
  compares the title with the fallback for the song's own format
  (`importFallbackTitle`). An HVL file whose name is empty therefore keeps an
  empty name through edits and saves; before this fix the first edit wrote
  'Imported HVL' into the file. The import (`ahx-import.ts`) and the export
  helper (`ahx-export-shared.ts`) now share this one definition. A title the
  user types is still written, even if it is 'Imported AHX'.

### Instrument-slot decision: DEFER (plan recommendation held; code agrees)
No `'hvl'` ModuleFormat or slot format was added. `HvlDoc.instruments` (P2
Option 1) remains the instrument source, and HVL instrument editing remains
closed: no UI opens, and `updateAhxInstrument` still rejects because HVL songs
have no slots. The code does not contradict the plan. Deferring still gives
byte-exact saves:
`fileInstrumentSlots` writes the doc's instruments. The new tests show every
instrument surviving edit → save → reload → export for all 22 files, and the
edited files re-save byte-exact. No stop notes were needed. The only UI change
is the `TrackerPage.vue` comment on the instruments hint, which now records
the decision; the hint text is unchanged.

### Tests
- `src/tests/hvl-save-export.test.ts` (new, 39): 16 targeted tests plus 22 corpus
  files plus 1 corpus-size pin, all through the real store and real
  `useTrackerFileIO` (including zip `.cmod` save and reopen). **Red first**:
  at `1d9aec5c` on the P2 code, 14/16 targeted tests failed (the 2 passes are
  pins: the doc-less refusal and the nameless fixture's own sanity). Re-checked
  at the P2 tip `eb93ad3a` with the final file: 36/39 fail; the 3 passes are
  those pins plus the corpus-size count.
- AHX guard red: after the codec was widened and before `0a0fe258`, the AHX
  row reported meltwater as `enabled` and wrote HVL magic `[72,86,76]` as
  `.ahx` (the conversion test failed: expected THX).
- `hvl-doc-corpus.test.ts` 12 → 15 (`:217`): mutated doc round-trips over all
  22 files (a unique track, a note plus second-column effect, and a transpose
  on the last channel). The rebuilt file parses as the edited doc, keeps its
  instruments and mix, `nameOffset` matches the size budget, and it re-saves
  byte-exact. meltwater is pinned. **These pass on the P2 code too** (checked
  at `eb93ad3a`): they are coverage pins for the doc and writer, not a fix.
- Intended pin changes: song-export-hvl and ahx-exporter-corpus now expect the
  untouched meltwater export to be exactly the source (the song-export-hvl
  test re-proves that the rebuild would still add the NUL; the writer-level
  +1 NUL pins in `ahx-writer-corpus` and `hvl-doc-corpus` are unchanged).
  The HVL row description is updated in the registry and dialog tests. In
  ahx-store-persistence, the 'an HVL file' bad-`ahxFile` case became a
  positive test, and its `applyLikeFileIO` mirror follows the new
  `applySongFile` branch. The hvl-doc-channels "no ahxFile on save" pin now
  expects the source bytes.
- AHX paths: the full suite includes the 77 .ahx files in `ahx-writer-corpus`,
  `ahx-doc-corpus` and `ahx-exporter-corpus`. All are green, and their count
  pins are unchanged. The readonly audit pins are unchanged.

### Gates at code tip `e626aadd` (outputs `.ai/checks-p3-*.txt`, real exit codes)
| Gate | Result | Exit |
|---|---|---|
| `npm run test:run` | 241 files / 3922 tests passed (3880 + 42 new) | 0 |
| `npm run lint` | no findings | 0 |
| `npx vue-tsc --noEmit` | clean | 0 |
| `gitleaks detect --no-git` | no leaks (182 MB scanned in this worktree) | 0 |
| `npm run check:artifacts` | worklets + wasm match sources | 0 |

No diff under `rust-wasm/` or `packages/`. The engine plays the same bytes as
before: the source for an untouched song, the rebuild after an edit.

### Deviations (honest)
1. **Creating new HVL songs is not done.** `createNewHvlDoc`, the new-song
   dialog, and the channel picker are P4 scope in the plan's §4, so they are
   out of scope here.
2. **The AHX guard converts instead of refusing outright.** An embedded HVL
   file goes through `convertHvlToAhx` and is refused only when it does not
   fit, just as an HVL source record already did. A flat refusal would have
   removed the existing HVL→AHX conversion from every HVL song that has a doc,
   because since this pass their snapshots carry `ahxFile` (§3: "HVL→AHX
   stays as-is"). HVL bytes are still never exported as `.ahx`.
3. **The exporter's record path also skips the rebuild when the title is
   untouched**, not just the `.cmod` path. This is why meltwater's untouched
   export changed from source+NUL to the exact source (pins updated and
   explained above).
4. **Finding:** P2's "exporter title-only" gap was already smaller in the
   running app than recorded. The dialog's `snapshotEditorSong` attached the
   *published* (edited) engine bytes as the record, so export already carried
   grid edits after P2 (measured with a probe at `eb93ad3a`). What was missing
   was the `.cmod` save, correct `.cmod`-only exports, the AHX guard, and the
   empty-name fix. The exporter now reads the doc's file directly instead of
   relying on that side channel.
5. **The intermediate commit `f89968f8` is not green on its own**: 13 failing
   (measured with a full run of that commit). 9 are new P3 tests in
   `hvl-save-export` that stay red until the exporter commit. 4 are existing
   tests: `ahx-exporter-corpus` "exporting every unedited .hvl" and "refusing
   all 22 .hvl as AHX" (in between, the AHX row really did leak HVL bytes,
   which is the guard's red), and `song-export-hvl`'s two store-path tests.
   `0a0fe258` fixes all 13. Save and exporters were split into two commits
   for review. Every gate was run at the tip; do not land `f89968f8` alone.
6. Not touched, as instructed: the sequence panel, the spectrum analyzer, and
   subsongs.

## Landing record (2026-09-23, agent/hvl-edit-p3-0923a P3)

Merge: `71b4a810` (`git merge --no-ff`, parents `eb93ad3a` + `e1fc93f4`, message:
"Merge branch 'agent/hvl-edit-p3-0923a': HVL editing P3 (review PASS on e1fc93f4)")
on main at `eb93ad3a` == `origin/main`, no conflicts, no main movement since review.
Branch worktree `.ai/worktrees/hvl-edit-p3` clean at tip `e1fc93f4` (code tip `d7893041`,
last 2 commits docs-only), no owner marker / foreign writer at land time. Main tree
carried the expected pre-existing deploy leftovers (demos/index.json + SOURCE_HASH.json +
wasm, rebuild non-determinism since the P1 deploy); the branch touches no `public/` paths,
so the merge was unaffected.

### Review reference

**PASS on branch tip `e1fc93f4`.** Red-first 36/39 proven at parent; original-bytes embed
pin; instrument DEFER verified; exporter authority verified.

### Post-merge gates on merged main `71b4a810` (real exit codes, this run)

| Gate | Result | Exit |
|---|---|---|
| npm run test:run | 241 files / 3922 tests passed (63.99s) | 0 |
| npm run lint (eslint .js,.ts,.vue) | no findings | 0 |
| npx vue-tsc --noEmit | clean | 0 |
| gitleaks detect --no-git | no leaks (3.82 GB scanned, 1m34s) | 0 |
| npm run check:artifacts | worklets + wasm match sources | 0 |
| npm run check:artifacts (re-run post-deploy) | worklets + wasm match sources | 0 |

### Push

`git push origin main`: `eb93ad3a..71b4a810 main -> main`, exit 0, no force.

### Deploy

`scripts/deploy.sh` → `avatar@192.168.50.161:~/repos/docker-info-ws-server/html/synth`.
Script self-verification `Deployed and verified (c51cd65c80d0e0b84eb2bf588bc86719)`
(index.html md5); deploy exit 0. wasm rebuilt per script design; this branch touches no
rust-wasm/ and `SOURCE_HASH.json`'s `sourceHash` (rust sources) is unchanged; the rebuild's
output hash drift vs the committed wasm is the known local rebuild non-determinism,
self-consistent with the local `SOURCE_HASH.json` and green `check:artifacts` both
pre-deploy and post-deploy.

**Fresh md5 spot-check (local `dist/spa` ↔ remote, all identical): 4/4**
`index.html` (c51cd65c…), `demos/index.json` (caf6c41f…), `wasm/audio_processor_bg.wasm`
(178c2b86…), `worklets/ahx-worklet.js` (0b1e28a2…).

Worktree: owner marker absent/cleared; worktree left in place.
