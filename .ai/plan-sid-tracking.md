# Plan: SID tracking (SID synth + GT `.sng` import/export + native-C64 `.sid` export)

Status: **PROPOSED — plan-only research pass 2026-09-23. Not scheduled; nothing landed.**
Supersedes and extends `.ai/plan-sid-format.md` (agreed with Morten 2026-09-21) per Morten's
brief 2026-09-23 13:42 (verbatim intent): *"plan out support for sid tracking. This involves
creating an extremely convincingly sounding sid synth in rust, possibly support 2 sids at
once, import and export of goatracker, and export of .sid programs that works on a native
c64. If possible, also import of .sid to our goatracker format. Goatracker is open source.
We already have some of this written down in a document."*

Labels: **MEASURED** (verified in this session, file:line or fetched doc), **INFERRED**
(reasoning stated), **UNVERIFIED** (needs a check before the batch that depends on it).
Nothing here is landed; every batch runs through the standing coder/reviewer discipline.

---

## 0. What carries forward from the old plan (2026-09-21) — attribution

Still holds, kept by name:
- **S0 spike first, Morten's ears as the accept criterion** (plan-sid-format.md §3/§5/§6). The
  6581 filter is "the hard 20%" — kill it cheaply before committing. Re-derived below as S0/S2.
- **Simulation, not hardware samples** (§6, decision 1).
- **Zero new deps** (§4); vendored third-party wasm only for a hypothetical foreign-`.sid`
  *playback* module, only after a verified permissive license; **reSID-fp is GPL and out** (§2).
- **E15 refusal discipline** for every exporter/importer: refusal text TRUE against the engine
  and the target format, short one-liners per D131 (verified shape: `ahx-writer.ts` `fail()`
  messages, e.g. the blank-first-track refusal at :218 and the U+00FF refusal at :143 — MEASURED).
- **Export binary may differ from GT's output** as long as it sounds and loads right (§6, decision 2).
- **GT size budgets become the size guard** — generalized, not dead (§4).

Changed by the new brief:
- **`.sng` is now import AND export** (old plan had export only, S4).
- **`.sid` export must run on a native C64** (old plan only said "loads in a real SID player").
- **Dual SID (2 chips, 6 voices) is in scope** as an optional, flag-decided feature.
- **`.sid` import re-examined explicitly** — verdict below is still *defer*, with fresh reasoning.

---

## 1. Scope section A — the convincing SID synth (Rust, zero deps)

### 1.1 What "convincing" means and what cycle-exactness costs

- **Cycle-exact** (gate-level, 985 248 Hz PAL clock, every waveform/ADSR/filter event at the
  die's own phase) is the reSID/resid-fp project. INFERRED: it is not tractable inside our
  browser worklet — the real-time cost is ~20× oversampling per voice plus the 6581 filter's
  nonlinear inter-sample behaviour, and reSID-fp itself is GPL so even its *design* can only be
  consulted, never copied. A real-time engine runs at the output sample rate (44.1/48 kHz).
- **Sample-rate approximation buys**: the full waveform/TAB behaviour of the *digital* parts
  (waveform 12-bit tables, PWM, ring-mod/sync truth, ADSR rate tables, noise LFSR), and the
  filter as a per-sample nonlinear resonant 3-pole approximation. This is what GoatTracker
  itself does via reSID under GPL — ours must be an independent derivation.
- **What it cannot buy exactly**: inter-chip variance (every real 6581 filters differently —
  there is no "the 6581 sound", there is a distribution), some 6581 digi/sample playback
  artefacts, and waveform-6581 combined-waveform marginal peaks. These become honest caveats,
  not blockers: pick a representative chip model and validate against recordings *of that
  class* of chip.

### 1.2 Fidelity strategy per subsystem (all INFERRED from public hardware knowledge, no GPL source consulted)

| Subsystem | Strategy | Risk |
|---|---|---|
| Waveforms (tri/saw/pulse) | The three pure waveforms are exact combinational logic over the 12-bit phase accumulator — implement the real boolean functions, not approximations. Pulse width from the register exactly. | Low |
| **Waveform 6581 quirks** | The 6581's combined waveforms (e.g. saw+tri, pulse+tri) are NOT the ideal XOR/AND of bits — they have the measured "long/run-down" distortion and waveform 0 with test-bit edge behaviour. Plan: a per-waveform correction pass derived from published measured tables/datasheet knowledge, **not** copied from GPL code. 8580 combined waveforms are cleaner and model first. | Medium |
| Ring mod + sync | Exact semantics are cheap at sample rate: sync = MSB-of-osc-B change resets osc A phase; ring mod = triangle output XOR NOT MSB(osc B) when ring+tri bits set. Pin both with hand-derived traces (oscillator-lockout edge cases included). | Low |
| ADSR | Use the real per-chip ADSR rate tables (6581 and 8580 tables differ — published measurements exist). Model the 6581 attack-curve nonlinearity (Lankila's measured ~1.5 ms floor/curve shape) as a table lookup, not the ideal exponential. | Medium |
| Noise | 23-bit LFSR at the chip's own step logic; 6581/8580 differ in LFSR start/shift quirks — model per chip. Sample-rate noise misses some ultra-fast LFSR aliasing; accept, note it. | Low |
| **Filter** | The decisive subsystem. 8580: closer-to-ideal 3-pole resonant LP/BP with its cutoff curve — first target (see D1). 6581: cutoff nonlinearity (input-dependent cutoff shift) + resonance character, approximated as a static nonlinear remap of the cutoff register + level-dependent peak gain — S2's whole job. "Megazeux-style" cutoff tricks ride on the register semantics, which are exact in both models. | **High — this is S0's gate** |
| Output stage | DC offset + level differences between chips (6581 has the famous DC-bias/leak), simple per-chip gain/offset calibration against reference recordings. | Low |

### 1.3 Where it lands in the engine

- New Rust module tree beside the AHX/HVL player: `rust-wasm/src/sid/` (voice.rs, waveform.rs,
  adsr.rs, filter.rs, chip6581.rs / chip8580.rs, player.rs). The AHX engine's shape is the
  template — `rust-wasm/src/ahx/` already splits voice/waveform/envelope/filter_sweep/player
  (MEASURED: `ls rust-wasm/src/ahx/` → engine.rs, envelope.rs, filter_sweep.rs, format.rs,
  hifi.rs, player.rs, plist.rs, voice.rs, waveform.rs).
- The band-limit work in the engine's voice/filter path (rust-wasm/src/audio_engine/) is
  relevant for output band-limiting, not for the chip model itself — SID is oscillator-into-
  filter, not sample playback.

---

## 2. Scope section B — dual SID (optional, flag-decided)

- **Reality of the feature**: 2 chips × 3 voices = 6 voices, a second chip base address
  ($D400 / $D420 / …), stereo placement (chip 1 left, chip 2 right is the GT convention).
- **GoatTracker mapping**: GT supports two SIDs (its songs carry a stereo/SID2 page; its readme
  §3 "Song data" and §5.1 "Playroutine options" document the dual-SID playroutine options —
  readme fetched 2026-09-23, MEASURED as documentation existence; exact STEREO-command encoding
  to be pinned from GT source `gssystem.cpp`/readme §3.2 at S7 time, UNVERIFIED).
- **Engine accommodation**: the tracker side already supports dynamic track counts and N-channel
  patterns (PLAN-module-format-support.md §2.3: `addTrack`/`removeTrack`, verified present in
  tracker-store.ts:289-320 per that doc). A 6-channel SID song is a plain 6-track song with a
  format tag; the *engine* question is the worklet voice pool (currently 16 voices, 2 engines ×
  8) and where a second chip's output pans in the graph. INFERRED: fine — SID voices are
  dedicated (per-channel, like D32), 6 ≤ 16, and stereo is a post-chip pan.
- **Correspondence rule for GT dual-SID songs**: GT chip-1 voices 1-3 → our channels 1-3,
  chip-2 voices 1-3 → channels 4-6; GT's stereo pan command maps to a per-channel pan where the
  engine has one, else refusal-with-reason. Flag: `dualSid` on the format profile; single-SID
  songs are the default path and dual is additive.

---

## 3. Scope section C — GoatTracker `.sng` import (new)

- **Format source**: GT2's own readme documents the full format — readme.txt §6.1 "GoatTracker
  v2 song (.SNG) format": 6.1.1 song header, 6.1.2 orderlists, 6.1.3 instruments, 6.1.4 tables
  (wave/pulse/filter/speed tables), 6.1.5 patterns header, 6.1.6 patterns; §6.2 instruments.
  Fetched and confirmed 2026-09-23 (leafo/goattracker2 mirror, v2.72). **Exact byte offsets get
  pinned from §6.1 at S5 implementation time and cited in the batch's D-log** (MEASURED at
  corpus curation 2026-09-23: full-parse validation against GT2's own loader `loadsong.c`,
  leafo mirror; rerunnable validator + fetched spec sources in /tmp/gt-curate/).
- **What GT songs contain that our SidDoc must carry**: instruments with waveform/arpeggio,
  pulse and filter tables (GT's uniform step tables), speed table, per-instrument ADSR and
  filter params, orderlists, patterns with GT effect columns, GT's "first frame/multispeed"
  conventions (readme §3.5 "Playback details", §3.7 "Multispeed tips").
- **Import mapping**: GT tables map onto our PList rows (the PList is already the per-tick
  register plan machinery — AHX/HVL instruments ride it today); GT effect columns map to our
  effect vocabulary where equivalents exist.
- **Refusal discipline**: refusal-with-reason for GT features we cannot faithfully represent
  (same E15 shape as the AHX exporter). Expected candidates: GT multispeed tunings we render at
  a different rate, GT fx we have no equivalent for, tempo/timing semantics mismatches.
- **Round-trip gate**: import(export(x)) == x on the curated GT corpus — DONE 2026-09-23:
  84 `.sng` fetched from ModLand (all 9 artist folders, 0 download failures), **83 valid**,
  0 duplicates, 1 corrupt-as-published excluded (Spock/sleepwalk.sng, reason recorded).
  Staged in `/tmp/gt-curate/` (candidates-full.json, REPORT.md, cand/, validate.py); deploy
  into `public/songs` waits for S5. **Dual-SID: none found** — every ModLand GT file parses
  as 3-channel mono, so S7 dual-SID test files must come from the GT2 distribution's example
  songs or another source.
- **Format facts measured from the corpus (2026-09-23)**: the wild has TWO formats —
  61×`GTS5` (GT2 4-table) and 22×`GTS!` (GoatTracker v1); no GTS2/3/4 occur in the wild even
  though GT2's loader accepts them → **S5 dispatches on magic, not extension**. `GTS!` differs
  structurally: fixed 31 instruments (no count prefix), inline per-instrument wavetables,
  3-byte pattern rows, trailing 256-byte filtertable; **5 of 22 GTS! files END without the
  filtertable** (GT2's own loader would read past EOF on them) → S5 treats the filtertable as
  OPTIONAL. Rest of §6.1 layout confirmed exact (100-byte info block, 25-byte instruments,
  4×(n+2n) tables, len×4 patterns). GT1 files mostly have empty title/author — identify by
  filename.
- **License** (MEASURED via fetch): GoatTracker v2.72 readme states "Distributed under GNU
  General Public License"; the repo's `copying` file is GPL v2. **Format facts are fine to
  implement from; GPL code is NOT vendored into our zero-dep engine.** GT's playback is reSID
  (also GPL) — reading GT/reSID *source* for interop facts is not vendoring, but copying tables
  or code is. This plan treats GT's readme (docs) as the spec and the C64 hardware as ground
  truth, not GT's C code.

---

## 4. Scope section D — `.sid` export that runs on a native C64

- **Wrapper** (MEASURED from libsidplayfp `PSID.cpp`, fetched 2026-09-23 — used as the format
  spec reference, not vendored): 118-byte v1 header layout — magic 'PSID'/'RSID', version,
  data offset, load, init, play, songs, start, 32-bit speed bitmask, 32-char name/author/
  released; v2 adds flags (video standard PAL/NTSC, SID model 6581/8580 bits, compatibility
  bits), relocStartPage/relocPages, and `sidChipBase2` (v3) / `sidChipBase3` (v4) for extra
  chips. Second-SID encoding verified: the byte holds a page offset, valid only even, invalid
  ranges $00–$41/$80–$DF mean "no second SID" (PSID.cpp `validateAddress`). RSID rules
  verified from the same source header comment: play/load/speed reserved 0, init must not sit
  under ROM/IO, load address ≥ $07E8.
- **Choice: RSID v2** (recommendation, decision for Morten): RSID means "runs on a real C64",
  which is exactly the requirement. Our player sets up its own 50 Hz CIA Timer A IRQ in init;
  play = 0 with per-song init (RSID semantics). PSID-only playback modes are the fallback if a
  specific PC player demands it — mark as a later compatibility pass, not the target.
- **Player driver**: hand-assembled 6502 kernel (zero deps — we emit bytes; no assembler
  dependency), ~3-voice first (6-voice dual-SID variant behind the S8 flag), holding:
  - init: copy registers/data, init instruments, start CIA IRQ;
  - play: per-tick PList driver — the same per-tick register-plan concept as our PList rows,
    precompiled at export time into compact frame data (register/value/frame-delay), plus a
    small effect kernel for the handful of continuous effects (pulse sweep, filter sweep,
    ADSR-gated retrigger) that cannot be fully pre-baked per frame.
- **Memory plan**: player+data placed via the v2 relocation fields; keep out of zero page and
  the $D000 IO area; single-SID target ≈ 2–4 KiB total (INFERRED, sanity estimate from GT's
  own converted-SID sizes).
- **Validation ladder (honest)**: (1) loads and plays in VICE (x64) and sidplayfp headless —
  scriptable in CI; (2) spectral compare of our `.sid` playback vs our engine playback (golden
  rig); (3) **true native-C64 confirmation needs Morten's hardware** (or real 6581 via HardSID)
  — stated as a caveat, never claimed by a test. VICE passes are necessary, not sufficient.

---

## 5. Scope section E — `.sid` import: verdict (re-examined, honest)

**Verdict: DEFER — keep the old plan's recommendation.** Re-examined with fresh eyes:

- (a) *Vendor a wasm SID core for playback-only*: does not produce an editable song; it only
  plays foreign `.sid`s. License first (reSID-fp GPL = out; jsSID licence UNVERIFIED — hard
  precondition before any such module). Not import.
- (b) *Register-capture import*: play the `.sid` in an emulated environment, log SID register
  writes per frame, reconstruct something PList-shaped. Lossy and one-way by nature (register
  streams do not decompose uniquely into instruments/patterns), enormous effort (needs a C64
  CPU+CIA core or a vendored one, plus a reconstruction heuristic), and the result would never
  round-trip. The old plan's "possible later experiment, one-way and lossy" framing stands.
- (c) *GT-player-specific detection*: fragile heuristics against GT's converted-SID output
  layout; brittle against every other player and against GT version changes. Not a foundation.
- **No cheap honest path was found.** The recommendation stays: no `.sid` import batch in this
  plan. If Morten ever wants foreign-`.sid` playback, it is a vendored, playback-only, licence-
  gated module — a separate decision, not part of SID tracking.

---

## 6. Batch plan (S-series, revised; not started)

Engine batches (S0–S2) are Rust-only and are gated on the S0 spike. Doc/editor batches (S3–S4)
follow the HVL P1→P2 structural model (doc model → editing → writer → create). Writer/importer
batches (S5–S6) follow the AHX exporter discipline. S7 dual-SID and S8 `.sid` export come last;
S9 is the recorded defer.

| Batch | Content | Size | Gate (checkable) |
|---|---|---|---|
| **S0 spike** | One SID voice in Rust (no deps), 8580 model first: pure waveforms, PWM, ADSR table, one filter candidate. Reference recording compare via the existing golden-rig spectral-compare workflow. Throwaway; verdict only. | S | Morten's ears: "SID enough" or named adjustments; spectral pins within an agreed dB band vs reference recording. Abort/adjust allowed by design. |
| **S1 voice core** | 3 voices + filter + per-chip model flag: waveforms, PWM, ring mod, sync, test bit, ADSR (per-chip tables), noise LFSR, 3-pole filter with resonance. Hand-derived goldens for ADSR/pitch/sync/ring edges. | L | Bit-exact golden traces vs hand-derived envelope/pitch math; sync/ring truth-table tests; Morten's ears on reference sounds. |
| **S2 6581 character pass** | 6581 filter nonlinearity approximation, combined-waveform quirks, ADSR curve, output-stage gain/DC calibration; per-song SID-model tag. | M | Spectral compare vs reference recordings of known tunes on both models; ears gate; per-model profile switch test-pinned. |
| **S3 song model + format profile** | `SidDoc` following the `AhxDoc`/`HvlDoc` tagged-union pattern; `moduleFormat` 'sid' threaded store→builder→engine (same chain as `setModuleFormat`, song-bank.ts:770 — MEASURED); SID instrument data blob in `.cmod`; pitch model = GT note table; PList rows at 50 Hz. | M | save/load/edit round-trip byte-exact; full suite unchanged; legacy songs unaffected. |
| **S4 editor integration** | SID instrument page + pattern canvas/playhead reuse (the PList canvas machinery transfers); channel 4-6 mapping for single/dual SID display. **Visual parity (Morten 2026-09-23 13:54): per-track waveform + spectrum hooks in BOTH TrackerPage and JukeboxPage, on par with the patched formats — SID songs carry real bank instruments, so `spectrumTrackNodes` must return real per-track taps for `'sid'` (never the `moduleFormat === 'ahx' → []` master-fallback branch, `useTrackerSongHost.ts`, jkb-spectrum fix 510c6fba); SID instrument page gets a visuals feed on the `ahx-instrument-visuals` model.** | M | T-canvas parity gates pass for SID songs; instrument editor round-trips through slots; real-load-path test pins non-null per-track spectrum taps + waveform hooks for a real SID song in tracker AND jukebox (red on unfixed code per the jt_letgo rule); analyzer renders SID tracks at the same quad/stereo resolution as native formats. |
| **S5 GT `.sng` import** | Parser per readme §6.1 (header/orderlists/instruments/tables/patterns) → SidDoc; refusal-with-reason for unfaithful features. | M/L | import(export(x)) == x on the GT corpus (83 validated files curated 2026-09-23 in /tmp/gt-curate/; GTS! dual-format + optional-filtertable rules measured — see §3); every refusal text TRUE. |
| **S6 GT `.sng` export** | Writer: notes/orderlists/instruments/tables out; GT size budgets as the guard (generalized from the AHX budget discipline). | M | GT loads our files (headless GT build or Morten's machine — the honest verification path); parse-our-own-output round-trips. |
| **S7 dual SID** (optional) | `dualSid` flag; 6 voices, second chip address, stereo placement; GT STEREO/SID2 mapping. | M | GT dual-SID corpus songs import+play; single-SID songs bit-identical to pre-S7 behaviour (flag-gated). |
| **S8 `.sid` export (RSID v2)** | RSID v2 wrapper + 6502 player kernel + register/PList frame data; single-SID first, dual behind S7. | M/L | Loads+plays in VICE and sidplayfp; spectral sanity vs engine; Morten's ears via VICE; native C64 = Morten's hardware, stated as caveat. |
| **S9 `.sid` import** | **Not a batch.** Deferred verdict recorded (§5). | — | — |

### Sequencing vs the current queue
The open queue as of 2026-09-23 morning: the HVL pipeline has landed P1–P3 (merge records in
`.ai/plan-hvl-editing.md` §8–10); HVL P4 (new-song creation) remains, and the song-bank
lifecycle work sits in the arch-review queue. **SID starts fresh after Morten approves this
plan** — S0 (Rust spike, own worktree, no store/engine touch) can in principle run alongside
HVL P4 without collision, but the recommendation is to finish P4 first so the queue stays
legible. S3/S4 (store-side) should not interleave with any song-bank lifecycle batch.

### Standing rules (from the old plan, §4 — all still apply)
Zero new deps; goldens untouched and hand-derived first; no `public/` change beyond committed
rebuilds; E15 true refusal texts everywhere; D-number + changelog entry per landed batch
(`PLAN-module-format-support.md` §8); `--no-ff` merges; read-only reviewers with negative
controls; worktree exclusivity rules; never land a FAIL.

---

## 7. Decisions for Morten (with recommendations)

1. **Default SID model: 8580 first, 6581 second.** 8580 is more self-consistent between
   individual chips and closer to the ideal digital model, so it is the faster path to
   "convincing"; the 6581 character pass (S2) follows with its variance caveat. Per-song model
   flag from the start so neither is hardwired. *Recommend: 8580 first.*
2. **Dual SID in plan, behind a flag, sequenced after single-SID parity.** It is additive
   (6 voices ≤ engine capacity) but doubles S8's player complexity. *Recommend: plan S7/S8-dual
   now, implement after S8-single sounds right.*
3. **`.sid` import stays deferred** (§5). *Recommend: confirm the defer.*
4. **`.sid` wrapper: RSID v2, own CIA-IRQ player.** PSID/built-in-player compat is a later
   optional pass if a specific PC player misbehaves. *Recommend RSID.*
5. **GT corpus needed**: S5/S6 gates need real `.sng` files (GT ships example songs in its zip;
   Morten's own songs are better). *Ask Morten to point at a GT corpus at S5 time.*
6. **Timing**: after HVL P4 (and not interleaved with the song-bank lifecycle batch). S0 spike
   may run earlier in its own worktree if Morten wants the risk retired early.

---

## 8. Risks / honest caveats

1. **The 6581 filter is the hard 20%** — carried from the old plan (§5.2), now quantified: it
   is nonlinear, input-dependent, and varies chip-to-chip; S0 exists to kill it cheaply. If S0
   fails, fallback is 8580-only with a documented 6581 approximation.
2. **File compat ≠ sound compat** (carried, §5.1): GT's sound comes from reSID; ours will not
   be bit-equal to GT's output through any player. Gates are ears + spectral, never "identical
   to GT".
3. **GPL contamination discipline is load-bearing**: GT and reSID are GPL; libsidplayfp is GPL.
   Format facts, offsets and docs are fine; source or numeric tables copied from them are NOT.
   Every table in our engine must be derived from hardware/datasheet/public-domain
   measurements, with the derivation noted in the batch. (reSID-fp GPL = out; jsSID licence
   unverified — gate before any vendoring idea.)
4. **Native-C64 verification is partly outside CI**: VICE/sidplayfp are scriptable; a real 6581
   is Morten's ears/hardware. Never claim "works on a real C64" from a VICE pass alone.
5. **`.sid` size budgets**: register-frame data for a full song can exceed the C64 memory a
   player can reasonably occupy; the S8 export must refuse (E15, true reason) when the compiled
   frame data does not fit the planned memory map, the same way the AHX writer refuses.
6. **Timing semantics**: GT multispeed/frame conventions vs our 50 Hz PList tick is a real
   mapping risk (GT readme §3.5/§3.7); expect refusals or a rate-conversion decision in S5,
   decided with measured examples, not guessed.
7. **Voice pool**: 6-voice dual-SID is within the current 16-voice worklet pool, but the pool is
   also serving other instruments; if the SID engine needs chip-accurate per-voice scheduling,
   the pool sizing gets revisited in S7 (engine-side change, flagged there).

---

## 9. Citation verification (this pass)

Verified by reading/fetching in this session:
- `song-bank.ts:149` `private moduleFormat: ModuleFormat = DEFAULT_MODULE_FORMAT;` and
  `:770` `setModuleFormat(...)` → `profileForFormat` (MEASURED, read this session).
- `packages/tracker-playback/src/format-profile.ts:304-310` `instrumentEngine?: 'sampler' |
  'worklet'` on the profile (the staged-engine flag the brief referenced) (MEASURED).
- `ahx-writer.ts` refusal shape: `fail(...)` messages at :143 and the blank-first-track refusal
  ~:218 (MEASURED); E15 discipline per D131/D132.
- `rust-wasm/src/ahx/` module layout (voice.rs, waveform.rs, envelope.rs, filter_sweep.rs,
  player.rs, format.rs; `parse` at format.rs:678) (MEASURED via directory listing + grep).
- PSID/RSID header structure, RSID rules, second-SID encoding: libsidplayfp `src/sidtune/
  PSID.cpp` (fetched 2026-09-23; GPL source used as format reference only) (MEASURED).
- GoatTracker licence GPL v2 + readme §6.1 documents the `.sng` format: leafo/goattracker2
  mirror, readme.txt v2.72 and `copying` (fetched 2026-09-23) (MEASURED). Exact `.sng` byte
  offsets: UNVERIFIED here — pinned from §6.1 during S5.
- Old plan decisions carried forward with attribution: `.ai/plan-sid-format.md` §2, §3, §4, §6.
### Landing records
- **S0 spike** — accepted by delegation 2026-09-23 14:27 (ears gate waived; demos rendered, 22/22 spike tests; verdict `.ai/worktrees/sid-spike/.ai/sid-spike-verdict.md` in worktree). Throwaway, not landed.
- **S1 voice core** — merged `4f76a8d3` 2026-09-23 ~15:10 (branch `agent/sid-voice-core-0923a` @ `9ef5cacf`, review PASS). Post-merge gates: 329/1/1 = baseline exactly; gitleaks clean.
- **S2 6581 pass** — merged `3cf01ba1` 2026-09-23 ~16:28 (branch `agent/sid-6581-0923a` @ `edf34ea8`, review PASS, 0 blockers). Post-merge gates: **352 passed / 1 failed (pre-existing fixture-count) / 1 ignored** = S2 coder's final exactly; gitleaks clean. Minor: comment typo "32 values" vs 33 array — noted for a later sweep.
- **S3 song model** — merged `9f481242` 2026-09-23 ~17:45 (branch `agent/sid-song-model-0923a` @ `cc289760`, review PASS, reviewer run `7cafcb8e`; TS↔Rust format agreement confirmed via shared chain fixture, pitch 278/7493/56576 re-derived on both sides). Gates: frontend 3954/2 (+22, same 2 pre-existing freshness fails), cargo 370/1/1 (+18), lint/vue-tsc/gitleaks clean. Post-merge gates pending → see land-s3 files.
