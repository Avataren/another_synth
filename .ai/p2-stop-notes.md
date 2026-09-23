# P2 stop notes: plan contradicts code (agent/hvl-edit-p2-0923a, 2026-09-23)

**Status: STOPPED after commit 1 (+ a red test). Morten needs to make a decision before P2 can go on.**
Do **not** merge `87528052` without that decision (see "Consequence").

## The contradiction

The plan says HVL gets the AHX edit pipeline for free once it has a doc:

- §1.2 (plan-hvl-editing.md:58-59): "HVL gets this whole pipeline for free the
  moment it has a doc — no engine change is needed."
- §1.5 (:101-104): "Instruments live in `slot.ahxData` (single source of truth);
  `buildAhxFile(doc, slots, title)` joins them".
- §4 P2 row: "Reuses the file-bytes reload path".
- §3 "Instruments" row and §4 P3 row put the instrument-slot decision in **P3**
  ("add `'hvl'` slot format vs defer instrument editing").

The code: **HVL songs have no instrument slots at all.**

- `src/audio/tracker/ahx-import.ts:18-21` (doc comment) and `:57`:
  `instrumentSlots: song.format === 'ahx' ? buildAhxSlots(song) : []` —
  deliberate ("An HVL song keeps no slots for now: it needs an
  `instrumentFormat` of its own, and stamping it `ahx` would be wrong").
- `src/audio/tracker/ahx-doc/build-file.ts` `instrumentsFromSlots`: the file's
  instruments are *only* the slots' `ahxData`. No slots, no instruments.

So the P2 byte pipeline (`publishAhxBytes`/`currentAhxBytes` →
`buildAhxFile(doc, instrumentSlots, title)`) writes an HVL file with **zero
instruments** for every HVL song. P2 depends on the decision that the plan
schedules for P3.

## Evidence (measured on this branch, tip `87528052` + the red test)

- meltwater_10ch.hvl: source `instrumentNr` 10; store slots with `ahxData`: 0.
  One grid edit on channel 5 → published bytes re-parse with `instrumentNr` 0;
  file 8207 → 7589 bytes.
- `src/tests/hvl-edit-matrix.test.ts` (committed red): 6 of 17 fail, all for
  this reason — "edit" (`expected +0 to be 3` / `to be 10`), "undo and redo"
  and "snapshot" (re-parsed song differs in `instrumentNr`/`instruments`), at 4
  and 10 channels. The other 11 pass (width, transpose, paste, second effect
  column, note 63, AHX rules unchanged).

Why nothing caught it:
- P1's `hvl-doc-corpus.test.ts:105` builds the slots itself from
  `song.instruments`, so its `buildAhxFile` byte-exactness never ran on the
  store's (empty) HVL slots.
- The red test `hvl-writeback-10ch.test.ts` (fb70a7d2) compares tracks,
  positions and transposes only; its premise (edits land in the published
  bytes) is right, it just does not look at instruments. Not edited.

## Consequence of commit 1 as it stands

With `87528052`, every path that publishes HVL bytes installs an
instrument-less song in the engine — silence at the next reload/Play:
a grid edit, a transpose-chip change, undo/redo (`applySnapshot` republish),
**and a title rename** (`flushAhxBytes` publishes silently on the next Play).
An unedited HVL song is still byte-identical (the publish key is primed at
load, and `applySongFile` installs the record), so loading and playing is fine;
the first edit is not. The Jukebox snapshot of an edited HVL song would carry
the gutted bytes too.

## What is done on the branch (and still valid whichever way this goes)

- `87528052` feat(tracker-store): unified doc slot — HVL editable, write-back
  at doc width. Red test 0/4 → 4/4. All §8 deviation-1 readers audited
  (list in the commit body). Channel loops at `docChannels`; ops/entries/
  edit-guard format-aware (second effect column, note-63 refusal with notice
  + revert). HVL `.cmod` save still refused and no `ahxFile` for HVL (P3).
- Red test `hvl-edit-matrix.test.ts` (this stop's commit).

Not done: commit 2 UI polish (readOnlyHint wording), commit 3 (transpose chip
comments/shared path — the editable chip already works for HVL through the
doc path, `TrackerPage.vue:1141-1205`, because `ahxPositionChannels` maps the
doc position's N channels), commit 4 (playback-routing test, readonly-audit
re-measure — the audit pins did not move so far), plan §9 full status and
the final gate run.

## The decision needed (options, with a recommendation)

1. **HVL doc carries its instruments until P3** (recommended, smallest):
   `HvlDoc.instruments` (readonly, from the parse), `buildAhxFile` uses them
   for an HVL doc; slots stay empty, no instrument UI changes, no
   `ModuleFormat`/`instrumentFormat` work. P3 then moves them to slots if it
   decides on `'hvl'` slots. Touches `ahx-doc/types.ts`, `doc.ts`,
   `build-file.ts`; the corpus tests stay byte-exact (same instruments).
2. **Pull P3's slot decision into P2**: give HVL imports slots
   (`buildAhxSlots` + an `'hvl'` `instrumentFormat`). Opens the HVL
   instrument editor, `canEditSlot`, route guard, `ModuleFormat` — plan §6
   risk 6 says keep instrument editing out of the first three passes.
3. **Fall back to `doc.base`'s instruments in `buildAhxFile`** when an HVL doc
   has no slot instruments. No model change, but `base` is documented as
   "held for the blank-first-track flag and inert instrument bits", and a
   base-less HVL doc (P4 new song) would still write none.

Until one is chosen, the branch should not be merged; P2 can resume from
`87528052` once the instrument source exists (the red matrix test is the
check).
