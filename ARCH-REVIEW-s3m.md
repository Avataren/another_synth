# Architecture Review — Playback Routines, ahead of S3M/IT

Branch: `agent/arch-review-s3m` · Base: `main` (`d27521b`) · 2026-09-03
Scope: analysis only, no production code changes. Grounded in the code as of this commit.

Verified sizes (this checkout of main; the reported 1961/1918 for effect-processor/engine
are stale by a few commits):

| File | Lines |
|---|---|
| `src/audio/tracker/song-bank.ts` | 2949 |
| `src/audio/mod-instrument.ts` | 2105 |
| `packages/tracker-playback/src/effect-processor.ts` | 1862 |
| `packages/tracker-playback/src/engine.ts` | 1894 |

Decisions consulted and respected: D2, D17–D21, D23, D46, D50, D52, D73, D78.

---

## 1. Strengths to preserve — where S3M is already cheap

**The FormatProfile pattern is the backbone, and it works.** `packages/tracker-playback/src/format-profile.ts:231`
already defines a placeholder `S3M_PROFILE`, and `profileForFormat` (`format-profile.ts:241`)
dispatches through a `Record<ModuleFormat, FormatProfile>` (`format-profile.ts:228`). The
hook points are all present:

- `engine.ts:483-485` derives the profile from `song.moduleFormat` and hands it to every
  track state (D17 plumbing, one place, no signature churn).
- `TrackEffectState` carries the profile (`effect-processor.ts:176-341`), so handlers read
  semantics from `state.profile` instead of branching.
- The pitch-model seam (D18) means S3M's Amiga-style period table is a new
  `createS3mPitchModel()` away, not an engine change.

**Critically: I grepped the effect processor and engine for inline format branches and
found none.** There is no `format === 'xm'` anywhere in
`packages/tracker-playback/src/`. The only format branches outside the profile are the
native-vs-module split, which is architectural (see §2) rather than a format fork:
`song-bank.ts:811-812` (`channelsAreMonophonic`), `engine.ts:1293`
(`shouldRetriggerLastNote(..., moduleFormat === 'native')`). This is exactly what D2
predicted: the differences live in one enumerable data object. Adding S3M semantics means
filling in `S3M_PROFILE` fields, not touching dispatch.

**Parser/import separation is proven.** `formats/xm.ts` (460 lines) reports the file
faithfully and interprets nothing (D23); mapping to `ModuleSong`, tracker entries and
instrument slots lives in `xm-import.ts` (551 lines). S3M follows the same seam:
`formats/s3m.ts` → `ModuleSong` → `s3m-import.ts`. The import path already proves the
pattern works against two different encodings (MOD's word-based sample layout, XM's
delta-coded PCM).

**The voice-addressing rule was paid down once, centrally.** D78's
`resolveCommandVoice` (`song-bank.ts:1660`) is the single resolution path for all
per-voice commands. The class of bug that was found five times per format (D29, D55, D65,
D68, D77) now has one enforcement point, so S3M inherits correctness instead of
re-deriving it.

**The instrument layer is format-blind.** `mod-instrument.ts` contains no format branch
at all — its only format-flavoured content is the XM autovibrato cent-conversion
constant (`mod-instrument.ts:598-600`), which is data about the *sampler-state payload*,
not a dispatch. Engine ⇄ instrument communication is a narrow command surface
(`song-bank.ts:1715-1939`: pitch, volume, pan, envelope position, sample offset,
retrigger), addressed per voice. Nothing in that surface forces a format branch.

**Per-pattern rows, per-song format tag, per-channel voice pools** (Phase 1 landed) and
the retired 9xx synthetic-param hack (D46) were all the load-bearing groundwork; S3M
inherits all of it.

## 2. Where it fights S3M/IT — concrete coupling points

### 2a. The text-macro effect encoding is the real blocker, not the effect-processor switches (D52 applies to S3M ×20)

The task asked whether `effect-processor.ts`'s ~8 `switch (effect.type)` statements
(`effect-processor.ts:542, 645, 964, 1436, 1563, 1663, 1719, 1801`) scale for a third
format with different command letters. **Answer: yes — they are not the problem.** The
switches dispatch on the normalized `EffectType` union (`types.ts:69-101`), whose members
are format-neutral *behaviours* (`portaUp`, `tonePorta`, `volSlide`, …). A letter-based
format maps its letters onto the same union and all switches keep working. This is the
whole point of the pipeline: `parseEffectCommand` normalizes → processor dispatches on
behaviour → profile supplies format semantics.

**The actual blocker is upstream of the processor, in storage and parsing.**
`TrackerEntryData.macro` (`src/components/tracker/tracker-types.ts:3-5`) stores effects
as 3-character *text* in the tracker's own MOD/XM-derived dialect, and
`parseEffectCommand` (`src/audio/tracker/note-utils.ts:223`) decodes that text against
**one** fixed command table with no format parameter. Two consequences for S3M:

1. **Letter collisions.** S3M writes effects as letters (A tempo, B position jump,
   C break, D volume slide, E/F porta down/up, G glissando, H vibrato, I tremor,
   J arpeggio, K/L combined slides, O offset, P panning, Q retrigger, R fine vibrato,
   S extended, T tempo, U fine porta, V global volume, X pan). `parseEffectCommand`
   already treats bare letters `M/N/O/P` as macro shorthands *before* the effect table
   (`note-utils.ts:213-220`), which is precisely the `Pxy` collision D52 recorded and
   deliberately left: "the string carries no format tag, so the two readings are
   genuinely ambiguous." For S3M this is not one letter — it is ~18 of 20 letters
   colliding with the macro shorthand table and with each other's current reading.
   Importing an S3M module through `parseEffectCommand` as it stands will silently
   reinterpret nearly every effect row.
2. **No raw-byte channel.** The plan's outstanding Phase 2 item — *"Carry raw
   `(cmd, param)` bytes on `TrackerEntryData` alongside the text macro"*
   (PLAN-module-format-support.md:214-216) — exists because the text encoding is lossy
   (`Pxy`/macro-3 is its known symptom, D52). The XM volume column got its own field
   (D50) rather than an encoding fix. S3M is the format that makes the debt come due:
   its effect set shares bytes with MOD/XM semantics while meaning different things
   (e.g. S3M `Dxy` volume-slide dual-nibble, `Sxy` extended effects that overlap MOD's
   `Exy` numbering with entirely different subtypes).

The round-trip path compounds this: `xm-import.ts` has `xmEffectToMacro` (evidenced by
D52's reference to it, `PLAN...md:913-915`) mapping XM numerics *into the same text
dialect*. An S3M importer would need an `s3mEffectToMacro` that must *collide* with the
shorthand table by construction. Adding format-tagged raw bytes to the entry (the planned
item) removes the collision class for S3M, IT and any future format at once.

### 2b. `song-bank.ts` god-class: blocker? No — but it caps review safety

The claim of ~40 private fields is right in spirit: I count 68 `private` declarations
(fields + methods), with the field block at `song-bank.ts:96-167`. The class genuinely
carries five distinct subsystems:

| Subsystem | Evidence |
|---|---|
| Voice allocation & replacement policy | `song-bank.ts:647-1097` (track-notes map, last-voice maps, `trackVoiceOwner`, releasing-voice bookkeeping, `gateOff*` family 855-1059, `endVoiceForReplacement` 827) |
| Scheduled-event queueing | `enqueueScheduledEvent`/`getEnqueueTimestamp`/`flushPendingScheduledEvents` (723-802), `pendingScheduledEvents` (144-145) |
| Recording | `ensureRecorderNode` (1097), `recorderNode`/`recordedBuffers`/`recording` (148-150), `queryWorkletCpu` (2911) |
| Worklet pooling & asset restore | `workletPool` (151), `getWorkletPoolStats` (288), `ensureInstrument`/`ensureInstrumentInternal` (2007-2035), `restoreAudioAssets` (2273), `normalizePatch` (2411), `buildSamplerUpdatePayload` (2600) |
| Monitors & volume | `getInstrumentOutput`/`getTrackMonitor`/`getMonitorSink` (216-267), `trackMonitors`/`monitorSink` (140-141), master/user volume (363-410) |

**Is it a blocker for S3M? No.** None of these five interact with format semantics except
the voice-replacement policy, which is already behind `channelsAreMonophonic`
(`song-bank.ts:811-812`) — a boolean, not a format fork, and S3M (4/8/16 monophonic
channels) is served by the existing module path. S3M work would proceed without touching
recording, pooling, or monitors at all.

**But it is a review-safety liability.** Every S3M fix will land in a file whose voice
rules were misaddressed five times (D78) and where one private-method change can silently
affect recording or monitor routing. The 2949-line class also makes the plan's own lesson
(D11: "trace it to the point where it touches an AudioParam") expensive to follow. It is
the right thing to split, for the *next* ten formats, before behaviour grows more.

### 2c. `mod-instrument.ts` vs the engine: does it force format branches?

**Mostly no, and the exceptions are known and contained.** The instrument is driven
exclusively through the per-voice command surface (`song-bank.ts:1715-1939`) plus the
sampler-state payload built in `buildSamplerUpdatePayload` (`song-bank.ts:2600`). It has
zero references to `ModuleFormat`. Format-specific behaviour inside it arrives as *data*
in `samplerState` (e.g. `trackerAutoVibrato` fields, `mod-instrument.ts:1601`), which is
the right shape.

Three real interactions to watch, none a forced branch today:

- **Autovibrato depth conversion** (`mod-instrument.ts:580-620`): the cents-per-period
  constant is correct for XM's linear table (64 units/semitone) and *approximated* for the
  Amiga table, which the comment flags for revisit (`mod-instrument.ts:596-599`). S3M uses
  Amiga periods, so this approximation becomes the *norm* rather than the corner case. It
  does not need a branch — it needs the conversion to be supplied by the pitch model
  (D18 pattern) rather than hard-coded.
- **`calculatePlaybackRate`** (`mod-instrument.ts:1085`) compares musical Hz against A440,
  which works because the pitch models emit musical Hz (D19). Fine for S3M as long as its
  profile's model follows the same contract.
- **Per-channel volume/pan semantics** arrive via macro 0 / note-on pan; S3M's per-channel
  global volume would ride the same `setVoiceVolumeAtTime` path. No branch needed.

The one place the engine itself branches on format (`engine.ts:1293`) is a native-vs-module
question ("is this song polyphonic-authored?"), not a per-format dispatch. IT will add
nothing here.

**Summary of coupling risk ranking:** (1) text-macro encoding/parse (must fix), (2)
autovibrato conversion via pitch model (small, before S3M sounds right), (3) god-class
split (important, not S3M-gating), (4) effect-processor switches (no change needed).

## 3. Split proposals, per monolith

Each split below is *cohesive-subsystem extraction* (D2-compliant: moving whole units,
not scattering branches). Rated **mechanical** (pure move, no behaviour change, existing
tests cover) or **behavioural** (touches live logic; needs characterization tests first).

### 3a. `song-bank.ts` (2949 lines) — split into 4 files + facade

Suggested structure under `src/audio/tracker/`:

| New file | Contents | Lines moved (approx.) | Kind |
|---|---|---|---|
| `scheduled-events.ts` | `PendingScheduledEvent`, enqueue/timestamp/flush machinery (723-802) + `cancelAllScheduled` (1330) | ~120 | **Mechanical** |
| `recorder.ts` | `ensureRecorderNode`, recorded-buffers, recording state (148-150, 1097-1116, 2911+), plus `queryWorkletCpu` | ~200 | **Mechanical** (recording is read-side only) |
| `track-voice-registry.ts` | `lastTrackVoice`, `trackVoiceOwner`, `trackReleasingVoices` maps + their helpers (`getTrackNotes` 647, `set/peek/clearLastVoiceForTrack` 665-722, `rememberReleasingVoice` 870, `cutReleasingVoicesForTrack` 895) and **`resolveCommandVoice` (1660) with it** | ~350 | **Behavioural** — this is D78's enforcement point; move it as one unit with the maps it reads, and keep `tracker-channel-voice-addressing.test.ts` green as the gate |
| `instrument-lifecycle.ts` | `ensureInstrument(IfDesired/Internal)` (2007-2035, 1423), `teardownInstrument` (2716), `restoreAudioAssets` (2273), `normalizePatch*` (2411-2492), `applyMacrosFromPatch` (2334), `waitForInstrumentReady` (2378) | ~500 | **Behavioural** (touches async ensure paths) |

Keep in `song-bank.ts`: the class shell, voice *dispatch* (`dispatchNoteOn/OffAtTime`
1430-1660, `noteOnAtTime`/`noteOffAtTime` 1222-1330), gate-off policy, monitors/volume.
That leaves a ~1400-line orchestrator whose remaining concern is genuinely "what happens
to a voice when". `channelsAreMonophonic` (811) stays in the bank — it is a
replacement-policy concern, not registry data.

Practical note: `worklet-pool` interaction (`workletPool` 151, `getWorkletPoolStats` 288)
stays in the bank for now; it is small and pooled-instrument behaviour was already once
silent-killed by a stub (D11), so a move buys little and risks exactly that again.

### 3b. `mod-instrument.ts` (2105 lines) — split into 3 files

| New file | Contents | Lines (approx.) | Kind |
|---|---|---|---|
| `sample-buffer.ts` | Buffer conditioning: oversampling, `conditionedMono`, mip buffers (163-166, fields + their build code), loop-region preparation, `parseWavInfo`-adjacent normalization (song-bank-side 2649 stays) | ~450 | **Mechanical** |
| `voice-pool.ts` | `ActiveVoice` (127), voice map, round-robin, `trackVoices`/`releasingVoices` (218-229), allocation/steal/return logic | ~350 | **Behavioural** — per-channel ownership and release-slot reuse are the two documented past bug classes (`mod-instrument.ts:214-227`); gate on existing channel-addressing tests |
| `autovibrato.ts` | `startAutoVibrato`/`stopAutoVibrato` (580-683) | ~120 | **Mechanical**, and the natural home for the pitch-model-supplied cent conversion (§2c) |

What remains is the note lifecycle (noteOn/noteOff, `calculatePlaybackRate` 1085,
fadeout/envelope application) — a coherent ~1100-line core.

### 3c. `effect-processor.ts` (1862 lines) — split, conservatively

The switches are fine; the file's problem is that it mixes three concerns:

| New file | Contents | Lines (approx.) | Kind |
|---|---|---|---|
| `effect-state.ts` | `TrackEffectState` (176-341), `createTrackEffectState` (341-413), the slide/volume helpers (`resetVolumeSlide` 581 → `primeVolumeSlide` 645, `resolveVolumeSlideDelta` 608, `clampVolume` 555, `velocityFromVolume` 577) | ~400 | **Mechanical** |
| `waveforms.ts` | `getWaveformValue` + waveform tables (528-555), vibrato/tremolo shape math (102-158) | ~150 | **Mechanical** |
| keep `effect-processor.ts` | `processEffectTick0` (786), `processEffectTickN` (1348), volume-command classification (1663-1810) | ~1300 | — |

Resist the temptation to split per `EffectType`: D2's warning is about *branches*, and the
tick0/tickN switch pairs per effect type are the readable heart of the file. Splitting
per-effect into files would make each individual effect harder to audit, not easier.

### 3d. `note-utils.ts` / entry encoding — the S3M-enabling split (behavioural)

Out of scope as a "monolith" (367 lines) but the highest-leverage change: introduce the
planned raw `(cmd, param)` fields on `TrackerEntryData` (Phase 2 outstanding item), make
`parseEffectCommand` format-aware or bypass it for raw-carrying entries, and keep the
text dialect only for hand-authored/native rows (which must keep the M/N/O/P shorthand —
that is what prevents D52 from being resolved by simply reordering). See §4 item P1.

## 4. Prioritized refactor plan for S3M readiness

Sizes are rough working estimates, in commit-sized units.

**P1 — Raw effect bytes on `TrackerEntryData` (blocking).** *(1–2 commits; the largest
single item, ~3–5 days with tests)* The Phase 2 checkbox that never landed
(`PLAN...md:214-216`). Without it, an S3M importer must express ~20 letter commands
through a MOD/XM text dialect that collides with the macro shorthands by design (D52).
Mechanics: add `effectCommand?: string; effectParam?: number` (raw bytes in hex/number,
like D50's `volumeCommand`), have `xm-import.ts` and `s3m-import.ts` write raw fields,
`useTrackerSongBuilder.ts:130-155` prefer raw fields over re-parsing text, keep
`parseEffectCommand` for hand-authored rows only. Backwards-compatible (raw is optional),
so it can land incrementally with XM as the proving format before any S3M code exists.

**P2 — Split `song-bank.ts` along §3a (do before S3M feature work).** *(2–3 commits,
mechanical parts landable independently)*. Order: scheduled-events + recorder first
(safe, shrinks the file ~320 lines), then the voice registry move as one unit with the
D78 test gate. Rationale: S3M work will concentrate in voice addressing and dispatch;
doing this split first means every S3M diff is reviewable against a ~1400-line file
instead of 2949.

**P3 — S3M `FormatProfile` fields + pitch model (S3M Phase 5 proper).** *(1–2 commits)*
Fill `S3M_PROFILE` (`format-profile.ts:231`): real `portamentoUnitScale` (S3M shares the
Amiga period scale → 1, unlike XM's 4), `volumeSlideHasMemory` (ST3 remembers → true),
`finetuneFromNibble` (S3M Amiga-style signed eighth-semitone), an Amiga-family pitch
model with S3M's 8363-Hz calibration and note range, `volumeSlideUnit` still 1/64. This
is pure data per D2/D17 — the machinery needs zero changes.

**P4 — Autovibrato depth conversion supplied by the pitch model (D18 pattern).**
*(1 commit, small)* Move the hardcoded `100/64` cents-per-unit (`mod-instrument.ts:598`)
into the pitch-model interface so S3M periods convert exactly. Do *not* wait for "an
Amiga-table module sounds off" — with S3M the approximate path is the common path.

**P5 — `formats/s3m.ts` + `s3m-import.ts`.** *(3–5 commits)* D23 discipline: parser
reports, importer maps. Sample data can be MPCM/unsigned-8-bit/PCM16 with the signed-raw
oddity — the D22 delta-masking precedent covers the word-size care this needs.

**P6 — `mod-instrument.ts` / `effect-processor.ts` splits (§3b, §3c).** *(2–4 commits,
incremental, any time)* Real value for review safety, no S3M dependency. Can land after
S3M ships without costing anything — they do not change where S3M work happens the way
P2 does.

**Speculative — wait until S3M lands:** an Adlib/OPL channel type in the data model
(Phase 5 note says "Adlib channels ignored" — keep ignoring until a real S3M with FM
samples is in hand); an "effect-command table per format" abstraction for
`parseEffectCommand` (if P1's raw bytes suffice, this never needs to exist); splitting
`engine.ts` (1894 lines — its `scheduleRow` at `engine.ts:1088` is the biggest single
method at ~400 lines, but it is the most regression-sensitive code in the repo and
nothing in it is format-branchy; leave it until there is a concrete second consumer of a
split piece).

## 5. Where "don't refactor now" is the right call

- **`engine.ts` (1894 lines).** Working playback, 1205 green tests, recent audit trail
  (see the decision log's Aug-30 entries, each shipped with its own test). Nothing in it
  dispatches per format; S3M touches it only through `profileForFormat` and one
  `=== 'native'` check (`engine.ts:1293`). Splitting it now buys no S3M readiness and
  risks the scheduler. Revisit only if P1 forces `dispatchCommands` to grow format
  branches — at which point the split targets itself.
- **The effect-processor switches (§2a).** Eight switches over a normalized,
  format-neutral union. Leave them.
- **`channelsAreMonophonic` as a boolean.** S3M is monophonic-per-channel like MOD/XM; if
  IT's default NNA behaviour ever needs a third policy, *that* is when it becomes a
  `VoiceReplacementPolicy` on `FormatProfile` — not before.
- **The D52 text encoding, in the hand-authored path.** P1 adds raw bytes alongside; it
  does not need to remove the text dialect, and native songs depend on it (M/N/O/P
  shorthand). Removing it would be a migration (D3-class risk) with zero S3M benefit.
- **Worklet pooling.** `workletPool`/`getWorkletPoolStats` stay put per §3a's note — the
  D11 stub history is the reason to leave an already-proven path alone.

### One-sentence verdict

The format-extension spine (FormatProfile, parser/import separation, D78's single
resolution path) is in good shape and S3M's semantics will be cheap; the two genuine
obstacles are the un-carried raw effect bytes (P1 — planned but still open, and S3M's
letter commands are exactly the collision D52 predicted) and the reviewability of
`song-bank.ts` (P2) — everything else can wait.