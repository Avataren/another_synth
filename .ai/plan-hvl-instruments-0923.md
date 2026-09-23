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
2. **Write edits through to the doc.** `updateAhxInstrument`
   (`tracker-store.ts:1054-1065`) writes `slot.ahxData = played` and records the
   edit for the engine; for HVL it must *additionally* write the played
   instrument into `doc.instruments[slotNumber-1]`, because the file builder
   takes the doc's set. `HvlDoc.instruments` (`ahx-doc/types.ts:76`) is
   `readonly` pending exactly this decision — relax it to a mutable
   `AhxInstrument[]` and rewrite the comment (the "read-only until … P3
   decides" text is the old deferral, now superseded).
3. **Rename the same way.** `setInstrumentName` (`tracker-store.ts:882-891`)
   already mirrors a rename into `slot.ahxData.name` for AHX slots; for an HVL
   doc it must also reach `doc.instruments[n-1]`, same reason.
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

### Undo/snapshot (MEASURED, P2 record + store code)

Snapshots clone `instrumentSlots` (`tracker-store.ts:647-648`) and carry
`ahxDoc` by reference (`:612`, `:631-665`). After an undo the slot's `ahxData`
and the doc's instrument are distinct copies with equal values; each later edit
writes both again (steps 2-3), so they never disagree in value.

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

(filled at completion)
