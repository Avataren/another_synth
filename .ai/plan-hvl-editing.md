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
