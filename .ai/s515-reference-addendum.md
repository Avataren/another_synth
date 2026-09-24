# S5.15 ADDENDUM (Morten, 14:26) — REFERENCE IMPLEMENTATIONS REQUIRED

Fold into the RESEARCH phase before any code: ground the R4AR profile in reference implementations from reputable sources, not just prose.

Priority order:
1. **reSID** (Dag Lem's reSID / reSIDfp — the de-facto reference SID emulator, GPL). Extract FACTS with file:line citations: its 6581 filter model (FilterModelConfig6581, fit_6581 curve), cutoff ladder fit, DAC model. GPL — copy ZERO code/bytes; derive our own values, mark INFERRED. CRITICAL QUESTION: is reSID's 6581 model parameterized by die revision at all? If revision-generic, record that as a legitimate finding — the trait stays GENERIC-6581 in our profile.
2. **Cross-check emulators:** reSIDfp (Java, JSIDPlay2's engine), jsSID, cSID_lite (Hermit). Cite file:line for any revision-specific handling.
3. **Published measurements:** die-revision surveys, per-revision filter-curve datasets, DAC nonlinearity measurements (kevtris' die-level work, SID FAQ revision notes, filter-measurement threads). Cite URLs.
4. **Die-shot reverse-engineering writeups** (dSID etc.) for what physically differs R3 vs R4AR (gate geometry, DAC ladder resistors).

Per trait (cutoff curve + $80 step, volume-DAC nonlinearity, output DC): record which sources give R4AR-specific numbers, which only generic-6581, which conflict. Cross-check at least two independent sources per trait before marking it R4AR-specific in the profile. Two-source rule: single-source claims get INFERRED + flagged.

All other brief rules unchanged (no GPL bytes, no push, no merge, never amend, gates to .ai/checks-s515-*.txt, verdict .ai/sid-r4ar-verdict.md must carry the reference-implementation table).

---

# S5.15 ADDENDUM FINDINGS (2026-09-24, ~14:55) — reference-implementation hunt results

Method: direct fetches (web_search provider still down). Sources fetched raw; facts only,
zero bytes copied. file:line citations below.

## R1. reSID (Dag Lem) — daglem/reSID, GPL
CROSS-CHECK STATUS: fetched. CRITICAL QUESTION ANSWERED: **reSID is NOT parameterized by
die revision.** The only model parameter is `chip_model` with exactly two values
(MOS6581 / MOS8580); the per-model config array is `model_filter[2]` —
src/filter.h:448, set via `set_chip_model(chip_model model)` (src/filter.h:348,
src/filter.cc:443). No die-revision field exists anywhere in the engine.

Facts with citations:
- 6581 cutoff: an 11-bit cutoff DAC `DAC<11> f0_dac` (src/filter.h:438) drives the filter;
  `Vw = Vw_bias + f.f0_dac[fc]` (src/filter.cc, set_w0, ~line 527). Revision-generic.
- 8580 cutoff is a linear ramp `w0 = 82355*(fc+1)>>11`, marked "FIXME: temporary cutoff
  code for MOS 8580" (same set_w0 block) — i.e. even reSID's 8580 cutoff is an admitted
  approximation, not a measured ladder fit.
- Resonance, 6581: `1/Q ~ ~res/8`, derived from die photographs of the resonance ladder,
  "assuming an ideal op-amp and ideal resistors" (src/filter.cc:~605-612); 8580 uses a
  measured exponential table `_1024_div_Q_table` (src/filter.cc:~648+).
- VOLUME DAC: "From die photographs of the bandpass and volume 'resistor' ladders it
  follows that gain ~ vol/8 and 1/Q ~ ~res/8" (src/filter.cc:284-285) — reSID models the
  6581 volume ladder as gain proportional to vol under an IDEAL-ladder assumption:
  approximately linear. No per-bit nonlinearity table, no $D418 digi-buzz modeling.
- Op-amp transfer: measured on real 6581 chips via Michael Huth's 2008 die photographs;
  "All measured chips have op-amps with output voltages within the range of
  0.81V - 10.31V" (src/filter.cc:29-34; src/filter.h:53-56). Revision-generic (chips
  measured without recording die revision).
- Output DC: no explicit output-stage DC model in reSID's filter; the digi-pop trait is
  NOT modeled (nothing in filter.cc/voice.cc/sid.cc references volume-register DC steps).

## R2. reSIDfp (drfiemost/residfp, clone of libsidplayfp's residfp) — fetched
CROSS-CHECK STATUS: fetched (libsidplayfp master itself has no FilterModelConfig path; the
submodule/vendor layout differs — note as UNREACHABLE detail, not absence of data).
File structure: Filter6581.cpp/.h, Filter8580.cpp/.h, Integrator8580.cpp/.h, Dac.cpp,
OpAmp.cpp — parameterized by CHIP MODEL only (6581 vs 8580 as separate classes), no
die-revision parameter anywhere in the tree listing (API contents of repo root, 2026-09-24).
Same critical answer: revision-generic.

## R3. jsSID v0.9.1 (Hermit's engine, og2t/jsSID jsSID.js, 2016) — fetched
CROSS-CHECK STATUS: fetched. Revision-generic: `SIDm` is only 6581.0 or 8580.0
(jsSID.js, setmodel/prSIDm; prSIDm read from .sid flags byte 0x77).
Facts with citations (all jsSID.js, single-minified-line file):
- 6581 cutoff: single exponential with 20 kHz ceiling:
  `ctf_ratio_6581 = -2*3.14*(20000/256)/smpr`; `if(ctf<24) ctf=0.035; else
  ctf=1-1.263*exp(ctf*ctf_ratio_6581)`. 8580: `1-exp(ctf*ctfr)` with 12.5 kHz ceiling
  (`ctfr`). No $80-step modeling, no per-revision curves.
- Resonance, 6581: piecewise `reso=(res>0x5F)?8/(res>>4):1.41` — approximation.
- Volume: linear `(output/SCALE)*(M[SIDaddr+0x18]&0xF)` — linear VOL/15 scaling, no
  per-bit nonlinearity, no digi-buzz modeling.

## R4. Published measurements / die-level
- kevtris, "Remarked SID Chips Sold as New" (http://kevtris.org/Projects/sid/remarked_sids.html,
  fetched 2026-09-24): genuine R2/R3/R4AR chips identified by package/date-code; his
  listening-test CONTROLS used an R2 SID and an R4AR SID interchangeably — no per-revision
  characteristic measurements. Chip-to-chip variance dominates: multiple same-revision
  chips with dead/whistling/distorted filters. Supports F4 (chip variance > revision variance).
- siliconpr0n MOS 6581 die-shot archive: direct fetch 403, Wayback capture not retrievable
  (404) — UNREACHABLE this run; any per-revision die data there is UNVERIFIED, not absent.
- esaulenka die-analysis repos: none SID-related found (GitHub user listing checked).
- cSID_lite (Hermit): no reachable repository found via GitHub search — UNREACHABLE.
  (Hermit's jsSID v0.9.1, R3 above, is his engine and is covered.)
- dSID / die-shot writeups on R3 vs R4AR gate geometry / DAC ladder: no reachable source
  found this run (web_search down; direct fetches 403/404) — UNVERIFIED.

## Per-trait verdict (two-source rule)

| Trait | R4AR-specific numbers? | Sources |
|---|---|---|
| Cutoff curve + $80 step | NO — generic-6581 only | reSID (R1, filter.h:448/f0_dac), reSIDfp (R2 class split), jsSID (R3 exp curve), Wikipedia F4, kevtris R4. ZERO revision-specific anchors anywhere. CONFLICT note: jsSID's generic 6581 curve (exp to 20 kHz) differs in shape from S5.12's measured anchors — different approximations of the same revision-generic trait; we keep the measured S5.12 anchors. |
| Volume-DAC nonlinearity | NO — generic-6581 vs 8580 | reSID: ideal ladder, gain ~ vol/8 (filter.cc:284-285); jsSID: linear (jsSID.js). Both treat 6581 volume as ~linear; the digi-loud trait (C64-Wiki F3) is documented but no emulator models per-bit weights. Our INFERRED [1,2,3.9,7.6] table stays single-source INFERRED, correctly flagged. |
| Output DC | NO — generic-6581 | reSID/jsSID model no output DC / digi pop at all; S2's MIX_DC_6581=0.5 remains our own INFERRED value, correctly flagged. |

## Reconciliation with the landed profile (38991b25)

- NO reference implementation gives R4AR-specific (or even R3-vs-R4AR) numbers for any
  trait. Per the two-source rule: every trait stays GENERIC-6581 in the R4AR profile.
- Profile values are therefore UNCHANGED (cutoff = S5.12 measured anchors; DC/gain = S2;
  volume table = INFERRED). This addendum changes documentation only.
- Cross-check consistency: our near-linear INFERRED volume weights sit between reSID's
  ideal-ladder (linear) treatment and the documented-but-unmodeled digi trait; the audible
  digi loudness in our model comes from the S2 mixer-DC step (also INFERRED) — consistent
  with both references' structure.
- The revision-module design stands: R3 later will likely produce a near-identical
  profile; the swap point is one constant (SID6581_REVISION) plus one profile struct.
