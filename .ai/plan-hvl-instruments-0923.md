# plan-hvl-instruments-0923.md — HVL instruments visible in the list, editable

Branch `agent/hvl-instruments-0923a` off `main` @ `693dcfd7` (== origin/main, fetched
2026-09-23 before start). Supersedes, on Morten's explicit instruction (12:29,
"still not editable, or even showing up in the instrument list"), the P2 Option-1
record and P3 DEFER record in `.ai/plan-hvl-editing.md` §9: HVL instruments are
now surfaced in the instrument list and edited through the same editor machinery
AHX uses. `HvlDoc.instruments` stays the file's instrument source (P3 landed
state, `build-file.ts:84` `fileInstrumentSlots`); the plan decides the smallest
honest way to bridge it to the slot table the list renders.

## 1. Root cause (MEASURED, file:line)

The instrument list is a pure projection of `trackerStore.instrumentSlots`
(`src/pages/TrackerPage.vue:559-666`, rows over `instrumentSlots` with
`instrumentBadgeLabel(slot)` at :567-579). An HVL song never fills that table:

- `src/stores/tracker-store.ts:1364` (`adoptAhxDoc`):
  `if (fromFile) slots = song.format === 'ahx' ? buildAhxSlots(song) : [];`
  — HVL songs are given **no slots at all**, deliberately, per the old deferral.
- `src/audio/tracker/ahx-import.ts:56` (fresh import): the same condition,
  `instrumentSlots: song.format === 'ahx' ? buildAhxSlots(song) : []`.
- `src/stores/tracker-store.ts:1079-1100` (`checkAhxInstrument`): an instrument
  edit requires a slot with `isAhxSlot(slot) && slot.ahxData`; with no slots it
  returns `{ reason: 'Slot N holds no AHX instrument.' }` → `updateAhxInstrument`
  answers `'rejected'` for every HVL instrument (pinned at
  `src/tests/song-export-hvl.test.ts:162`).
- The UI still says so: `src/pages/TrackerPage.vue:1214-1218`, hint
  "HVL instruments come from the song's file and cannot be edited yet".

So the data is there the whole time — `HvlDoc.instruments` (`ahx-doc/types.ts:76`,
instrument `n` at index `n-1`, parsed from the file, verified equal to the parse
for all 22 corpus files) — and the gap is purely "no slots are built from it".

## 2. The proposed mapping (INFERRED, verified against the save path)

The slots are the list's rendering surface; the doc is the file's instrument
source. `buildAhxFile` → `fileInstrumentSlots` (`ahx-doc/build-file.ts:84-87`)
reads `doc.instruments` for HVL and **ignores slots**, so:

1. **Build slots for HVL too.** `buildAhxSlots(song)` (`ahx-doc/slots.ts:17-37`)
   already does the right thing for either format: one filled slot per
   `song.instrumentNr`, `instrumentType 'ahx'`, `instrumentFormat 'ahx'`,
   `ahxData` = the parsed instrument, names seeded from the instrument's name.
   It needs no change — only the two format-gated call sites above drop the
   gate (`:1364` and `ahx-import.ts:56`).
2. **Write edits through to the doc, copy-on-write.** `updateAhxInstrument`
   (`tracker-store.ts:1054-1065`) writes `slot.ahxData = played` and records the
   edit for the engine; for an HVL doc it must *additionally* get the played
   instrument into `doc.instruments[slotNumber-1]`, because the file builder
   takes the doc's set. The doc is immutable by design — `createSnapshot`
   (`tracker-store.ts:585-613`, comment at :602 "a reference: it is immutable")
   keeps the doc **by reference** and the editor pushes history *before* the
   edit (`useAhxPListEditing.ts:75→79`), so any in-place mutation also corrupts
   every undo snapshot. Every doc change therefore replaces the doc
   copy-on-write: `this.ahxDoc = { ...doc, instruments:
   doc.instruments.map((ins, i) => i === slotNumber-1 ? played : ins) }` with
   the `ahxRevision` bump every doc change makes (all sites :634, :716, :1199,
   :1579). `HvlDoc.instruments` (`ahx-doc/types.ts:76`) stays `readonly` — the
   spread builds a new doc holding a new array, so the readonly type stands and
   its comment gains the new decision. This replacement is quiet: it must NOT
   call `publishAhxBytes`/`commitAhxDoc` — an instrument tweak is heard through
   the recorded-edit hot apply (`recordAhxInstrumentEdit`, `ahx-player.ts:244`,
   "without reloading the song"), exactly as AHX instrument edits are; a full
   byte replacement would reload a playing song on every tweak. The rebuilt
   file picks the edit up at the next flush point (`currentAhxBytes` →
   `buildAhxFile` reads the doc).
3. **Rename the same way.** `setInstrumentName` (`tracker-store.ts:882-891`)
   already mirrors a rename into `slot.ahxData.name` for AHX slots; for an HVL
   doc it must also replace the doc copy-on-write with the renamed instrument
   at `doc.instruments[n-1]` (same pattern, same quietness, same `ahxRevision`
   bump), same reason as step 2. The rename composable also pushes history
   before committing (`useTrackerInstruments.commitInstrumentRename`), so
   copy-on-write is what makes rename undoable.
4. **Growth guard against the file's real instruments.** `checkAhxInstrument`
   counts the slots' instruments (`tracker-store.ts:1100-1102`); for HVL the
   file's set is the doc's (`fileInstruments`, `build-file.ts:87-89`). Switch
   the count to `fileInstruments(this.ahxDoc, this.instrumentSlots)` — byte-for-
   byte identical result for AHX (the doc holds no instruments there, so it is
   the slots), and the doc-derived set for HVL.
5. **UI hint update.** `TrackerPage.vue:1214-1218` hint becomes "HVL
   instruments are numbered in order and edited in their own editor" — the same
   text AHX gets, since the same editor now serves both.
6. **Badge stays 'AHX'.** `instrumentFormat` is `'ahx'` for these slots (data
   lineage: AHX-wire-compatible cores, widened PList rows; `ModuleFormat` has no
   `'hvl'` value and adding one is a library change out of scope). The list
   badge therefore reads AHX; that is the lineage, not the song format.

### Editor machinery reuse (INFERRED)

`AhxInstrumentPage` resolves the slot from `instrumentSlots`
(`src/pages/AhxInstrumentPage.vue:742-749`), already keys its PList command set
off the song's format (`:925`, HVL has more commands), and edits through
`trackerStore.updateAhxInstrument` (`:968-969`). `canEditSlot`/
`resolveInstrumentEditorRoute` (`instrument-types.ts:181-201`) route an
`ahx`-typed slot with `ahxData` straight to `ahx-instrument-display`. With
slots built, the whole AHX editor path serves HVL with no page change.

### Playback and publish path (MEASURED for the mechanism, pinned by a new test)

`updateAhxInstrument` ends in `recordAhxInstrumentEdit(slotNumber,
serializeAhxInstrument(played, format))` (`tracker-store.ts:1064`) — the same
edit-record → worklet-apply channel the HVL grid edits use, whose publish and
reload behavior `hvl-engine-sync.test.ts` pins. `serializeAhxInstrument` and
`sanitizeAhxInstrument` take the format (`'hvl'` widens PList rows). An
unedited HVL song still plays its file's own bytes (`useTrackerFileIO.ts:404-424`);
the first instrument edit publishes rebuilt bytes, exactly like the first grid
edit does.

### Save-path implications (MEASURED)

- Unedited HVL: slots now exist but `fileInstrumentSlots` still ignores them
  (`build-file.ts:84-87`); `buildAhxFile(doc, …)` output is unchanged, so the
  corpus round-trip byte-exactness (`hvl-doc-corpus.test.ts`, 22 files) and the
  trailing-NUL pin survive untouched.
- Edited HVL: the edit lives in `doc.instruments` (step 2), so the rebuild
  carries it; the grid-edit matrix's meltwater invariant (file = source +
  1 + growth, `hvl-edit-matrix.test.ts:316-342`) extends to instrument edits.
- AHX: `doc.format !== 'hvl'` everywhere above → every change is a no-op; the
  AHX byte-identical pins (`ahx-exporter-store.test.ts`, corpus tests) must stay
  green with zero modification.

### Undo/snapshot (MEASURED, corrected after the first coder stop)

Snapshots keep `ahxDoc` **by reference** (`tracker-store.ts:612`, immutability
is the invariant the comment at :602 states) and deep-clone
`instrumentSlots` (:608). The editor pushes history before the edit, so the
snapshot's doc is the pre-edit doc — which copy-on-write replacement (steps 2-3)
never touches. `applySnapshot` (:631-665) reinstates the pre-edit doc, clones
the pre-edit slots back, and rebuilds/publishes the bytes from the doc
(`publishAhxBytes({ resetEdits: true })`), so undo restores the instrument in
the editor, the doc and the bytes together. In-place mutation (the plan's
original step 2) would have corrupted exactly this; see the stopped first
attempt in `.ai/hvl-inst-stop-notes.md` (kept, uncommitted, as the record).

## 3. Changed pins (deliberate, on Morten's instruction)

- `src/tests/song-export-hvl.test.ts:162` — `updateAhxInstrument` on HVL flips
  `'rejected'` → `'applied'`.
- `src/tests/hvl-edit-matrix.test.ts:316+` — "no slot holds an instrument" (P2
  Option-1 pin) flips: the 10-ch song now lists 10 AHX slots.
- `src/tests/hvl-doc-corpus.test.ts` — the doc-vs-parse equality pins stay;
  any "no slots" assertion there updates the same way.

## 4. New tests

- `hvl-edit-matrix.test.ts`: meltwater_10ch — instrument 1 edit via
  `updateAhxInstrument` → `'applied'`; list shows 10 selectable instruments with
  their file names; export → re-import → `instrumentNr` 10, edited value
  survives, unedited instruments byte-identical; undo restores the doc
  instrument and the slot.
- AHX regressions: existing suite suffices (byte-identical corpus, exporter
  store, plist-canvas parity) — no new AHX test needed.

## 5. Constraints honored

- No `rust-wasm/` changes (all edits are `src/` TS/Vue).
- No audible change to unedited playback (unedited songs keep file bytes,
  `useTrackerFileIO.ts:404-424`); AHX path untouched.
- No `public/demos/` commits; demo bytes are read by tests only.
- Gates on the branch tip: `npm run test:run`, `npm run lint`,
  `npx vue-tsc --noEmit`, `gitleaks detect --no-git`, `npm run check:artifacts`.

## 6. UNVERIFIED going in

- That the worklet's `applyInstrument` path accepts HVL-width PList rows on a
  hot apply (the mechanism is shared with AHX; `ahx-player.ts:244` documents it;
  the new matrix test exercises the record, the page test pins the editor, but
  no test listens to a real worklet).
- That no third pin outside §3 asserts empty HVL slots (sweep with
  `rg "format === 'ahx' \\? buildAhxSlots|no slot holds"` at implementation time).

## 7. Deviations and implementation record

Implemented 2026-09-23 on `agent/hvl-instruments-0923a` (second coder pass,
revision-2 copy-on-write design). Plan premises checked against the code
before any edit; none were contradicted.

### What changed (file:line at the implementation commit)

- Step 1, slots for HVL: `src/stores/tracker-store.ts:1390` (`adoptAhxDoc`,
  `slots = buildAhxSlots(song)`) and `src/audio/tracker/ahx-import.ts:57`
  (`instrumentSlots: buildAhxSlots(song)`). Doc comments updated (adoptAhxDoc
  header, ahx-import module header).
- Steps 2-3, copy-on-write write-through: new store action
  `replaceHvlDocInstrument` (`tracker-store.ts:906`). For an HVL doc it sets
  `this.ahxDoc = { ...doc, instruments: doc.instruments.map(...) }` and bumps
  `ahxRevision`. It is quiet: no `commitAhxDoc`/`publishAhxBytes`. AHX docs
  are a no-op. It is called from `updateAhxInstrument` after
  `slot.ahxData = played` (`:1086`) and from `setInstrumentName`'s rename
  mirror (`:892`). The docstring of `updateAhxInstrument` now covers HVL.
- Step 4, growth guard: `checkAhxInstrument` counts
  `fileInstruments(this.ahxDoc, this.instrumentSlots)` (`:1125`); the stale
  "HVL has no slots" doc line was replaced.
- Step 5, UI hint: `src/pages/TrackerPage.vue:1218` "HVL instruments are
  numbered in order and edited in their own editor".
- `HvlDoc.instruments` stays `readonly` (`ahx-doc/types.ts:78`); its comment
  records the copy-on-write decision. Comment-only updates:
  `ahx-doc/build-file.ts` (`fileInstrumentSlots`),
  `song-export/ahx-exporter.ts` and `song-export/hvl-exporter.ts` headers
  (they said an HVL song has no slots). Exporter code is unchanged.
- No `rust-wasm/`, `public/demos/`, `ModuleFormat` or badge change. HVL slots
  keep `instrumentFormat: 'ahx'`.

### Tests

- Flipped (§3): `song-export-hvl.test.ts:156`. `updateAhxInstrument` on HVL
  now returns `'applied'`, the exported file carries the edited volume, and
  the other instruments are unchanged. `hvl-edit-matrix.test.ts:335`:
  meltwater lists slots 1-10 with the file's names (or the import's
  "Instrument NN" fallback for an empty name), `ahx`/`ahx`, `canEditSlot`
  true, and `ahxData` equal to the parse.
- Also flipped, found by the §6 sweep (the sweep's rg pattern missed them;
  the full test run found them). Each asserted HVL songs have no slots:
  - `ahx-import.test.ts` "leaves HVL songs without instrument slots" now
    asserts one `ahx`/`ahx` slot per instrument.
  - `ahx-store-persistence.test.ts:210` and `hvl-save-export.test.ts:155`
    now assert the listed instruments equal the file's.
  - `song-export-hvl.test.ts` "is written from the converted model alone":
    `instrumentSlots` is no longer `[]`. The test now proves the slots are
    ignored: the export is identical after the slots are cleared.
- New: `hvl-edit-matrix.test.ts:376` "an HVL instrument edit
  (meltwater_10ch.hvl)" has two tests:
  1. Edit test. After `pushHistory` then `updateAhxInstrument(1, volume)`:
     - it returns `'applied'` and the doc is a new object;
     - the snapshot's doc is the untouched original;
     - quiet: `currentAhxInstrumentEdits` grows by one, `currentAhxSource()`
       is still the source array (same identity) and `onAhxStructureChange`
       never fires;
     - `currentAhxBytes()` re-parses with `instrumentNr` 10, instrument 1
       equals source + volume, and instruments 2-10 are equal both as
       serialized wire bytes and as parsed objects;
     - the HVL export of the saved song equals that rebuild;
     - undo restores the doc (same reference as the original), the slot
       (equal to the parse) and the engine bytes.
  2. Rename test: `setInstrumentName(2, ...)` replaces the doc copy-on-write,
     the rebuilt file carries the name, and undo restores doc and slot name.
- Red check: with `replaceHvlDocInstrument` stubbed to return early, the two
  new matrix tests and the flipped `song-export-hvl` edit test fail (3
  failed); they pass with it in place.
- AHX pins untouched and green, unmodified: `ahx-exporter-store.test.ts`,
  `hvl-doc-corpus.test.ts`, `plist-canvas-parity.test.ts`,
  `ahx-instrument-page-plist-edit.test.ts`.

### Gates (branch tip, full output in `.ai/checks-hvli-*.txt`)

| gate | exit |
|---|---|
| `npm run test:run` (241 files, 3924 tests passed) | 0 |
| `npm run lint` | 0 |
| `npx vue-tsc --noEmit` | 0 |
| `gitleaks detect --no-git --source .` ("no leaks found") | 0 |
| `npm run check:artifacts` | 0 |

The first full test run exited 1 with the 3 extra "no slots" pins listed
above. They were flipped per §3 and every gate was rerun; the table shows
the rerun.

### Deviations

1. The doc gets a shallow copy of the instrument (`{ ...instrument }`), not
   `played` itself. Reason: `setInstrumentName` renames by writing
   `slot.ahxData.name` in place (the only in-place write to `ahxData` in
   `src/`). If the doc held the same object as the slot, a later rename would
   also rename the doc instrument, and with it every undo snapshot that holds
   that doc. This is the same invariant the plan protects. `name` is the only
   field written in place, so a shallow copy is enough. The design is
   otherwise exactly as planned.
2. The write-through is one shared action (`replaceHvlDocInstrument`), not
   two inline copies. The behaviour is the one planned.
3. The four extra pin flips listed under Tests. Plan §3 allowed for them;
   they are recorded here.
4. Still unverified (§6): no test listens to a real worklet, so hot-applying
   HVL-width PList rows is exercised only at the record level.

---

## Landing record (2026-09-23, main-session lander)

- Branch `agent/hvl-instruments-0923a` @ `018f97ef` (3 commits
  `3f062810`→`97850fac`→`018f97ef`) merged into `main` with
  `git merge --no-ff` → merge commit **`a2db88eb`** (base at merge time:
  `5fd3b347` = origin/main, after the jkb-spectrum landing). No conflicts.
- Review: PASS (as delegated; review PASS recorded pre-landing).
- Pre-land verification: branch tip unchanged (`018f97ef`), worktree clean,
  no owner marker / foreign writer.

**Gates (merged main @ a2db88eb, real exit codes):**

| Gate | Command | Result |
| --- | --- | --- |
| tests | `npm run test:run` | 0 — 242 files / 3930 tests passed |
| lint | `npm run lint` | 0 |
| types | `npx vue-tsc --noEmit` | 0 |
| secrets | `gitleaks detect --no-git` | 0 (no leaks) |
| artifacts | `npm run check:artifacts` | 0 |

Raw outputs: `.ai/checks-land-hvli-{test,lint,tsc,gitleaks,artifacts}.txt`.

**Deploy:** `bash scripts/deploy.sh` → exit 0, "Deployed and verified"
(`594d0a147896eccb4e859c66ac45c295`). Log:
`.ai/deploy-hvl-instruments-20260923.log`. MD5 spot-check local(dist/spa) ↔
remote avatar@192.168.50.161:~/repos/docker-info-ws-server/html/synth — all
matched: index.html `594d0a14…`, demos/index.json `eeb79da2…`,
wasm/audio_processor_bg.wasm `62ad8309…`, worklets/ahx-worklet.js
`0b1e2828…`.

**Wasm drift (known/benign):** this deploy's rebuild regenerated only
`public/demos/index.json` (wasm itself reproduced byte-identical this run —
wasm-bindgen permutation drift is intermittent, per P4/P6 precedent).
Stashed, not committed: stash `wasm-rebuild-drift-post-hvli-land-20260923`.
