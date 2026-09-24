# S5.16 research notes: R3-specific 6581 data (what exists, what doesn't)

Task 15:36, rule 15:22 — spec VALUES from GPL emulators are freely adoptable,
no attribution ceremony (cited here for OUR traceability only; code needs no
source mention). Code STRUCTURE still never copied.

## Sources consulted (2026-09-24)

- reSID 1.0 (github.com/daglem/reSID @ master): `src/filter.cc:29-70`
  (6581 op-amp transfer, "measured on MOS 6581R4AR 0687 14"; 8580 table
  measured on CSG 8580R5 1690 25), `filter.cc` model_filter_init (6581 DAC
  parameters: dac_zero 6.65, dac_scale 2.63, 2R/R 2.20, term=false; Vdd
  12.18, Vth 1.31, Ut 26 mV, k 1.0, C 470 pF, uCox 20e-6, WL_vcr 9/1,
  WL_snake 1/115, voice range 1.5 V @ DC 5.0 V), `src/dac.h:39-126` (the
  R-2R network math: missing bit-0 termination, 2R/R ~ 2.20 approximation,
  bit superposition; the 8580: terminated, 2.00, "no discontinuities"),
  `src/siddefs.h.in:63` (chip_model = MOS6581 | MOS8580 — no die revision).
- reSIDfp / libsidplayfp (github.com/drfiemost/residfp @ master):
  `Dac.cpp:53-121` kinkedDac (same 2.20/no-term parameters for MOS6581),
  `FilterModelConfig.cpp:47-90` (the same R4AR-measured op-amp table),
  `FilterModelConfig.cpp` EKV VCR constants (uCox 20e-6, WL_vcr 9, Ut 26 mV,
  Vth 1.31, C 470 pF), `Filter6581.h` (die-reverse-engineered circuit:
  R24 ~ 1.5 MOhm from FCmin 220 Hz, R1 ~ R24/24 ~ 64 kOhm; VCR "snake"
  topology; setFilterCurve(curvePosition) — the per-chip dark/light
  adjustment), `FilterModelConfig.h` getDacZero (curve position shifts
  dac_zero).
- C64-Wiki "SID": production periods — 6581 21/1982-30/1985, 6581R3
  42/1985-07/1986, 6581R4 16/1986-30/1986, 6581R4AR 22/1986-06/1987,
  8580R5 06/1987-19/1992. NO trait differences listed per 6581 revision.
- Wikipedia "MOS Technology 6581": R1 prototype; then R2, R3, R4, R4AR
  "no substantial alterations ... only minor changes to the
  protection/buffering of the input pins, adjustment of the silicon grade,
  and changes to packaging."
- web_search: UNAVAILABLE in this environment (no provider) — the hunt for
  third-party per-revision measurement datasets relied on direct fetches of
  the known primary sources above. Kevtris' die work and HVSC/STIL revision
  notes were not directly reachable in this run; the absence claims below
  are grounded in the reference engines (which parameterize NO die revision
  anywhere) plus the two encyclopedic sources.

## Classification per trait

| Trait | Class | Evidence |
|---|---|---|
| Filter/op-amp transfer | R4AR-only (measured on R4AR) | reSID filter.cc:29-70 "MOS 6581R4AR 0687 14" |
| f0 DAC kink (2R/R 2.20, no bit-0 term) | R4AR-only measurement, GENERIC-6581 claim | reSID dac.h:39-126 ("All MOS 6581 DACs..."), reSIDfp Dac.cpp |
| Volume DAC per-bit weights | unknown for EVERY 6581 revision | both engines model volume DAC IDEAL (reSID filter.cc:283-295, reSIDfp Filter6581.cpp:44-46); no source measures it |
| Cutoff anchor figures (220/420/1600/6000/4600/9500/14500/18000) | shared-6581 (community, chip-spread) | S5.12 anchors, .ai/sid-chip-comparison-report.md §6.3 |
| Voice/mixer DC | shared-6581, INFERRED in our engine | S2 INFERRED; reference values voice 1.5 V @ 5.0 V DC (R4AR-measured set) |
| Silicon grade / chip-to-chip spread | revision-adjacent, not per-revision data | Wikipedia "adjustment of the silicon grade"; reSID adjust_filter_bias; reSIDfp setFilterCurve |
| $D418 volume-write click | shared-6581 (R3/R4/R4AR all) vs 8580 | C64-Wiki trivia |
| **R3-specific anything** | **NOT FOUND** | see below |

## The honest headline

**The public record contains no R3-specific measured trait.** Neither
reference engine parameterizes die revision at all (reSID siddefs.h.in:63:
MOS6581|8580; reSIDfp likewise). The only 6581 whose filter parts were
measured in the published record is the R4AR 0687 14. Per-revision R3/R4
differences in the encyclopedic record are production dates and packaging
only ("no substantial alterations"). Third-party per-revision filter
measurement datasets could not be located (web_search unavailable; the
primary sources above carry no revision split).

Therefore the R3 profile INHERITS the entire R4AR-measured model, marked
INHERITED on every field — never presented as measured-on-R3.

## What the research DID yield (adopted into S5.16)

1. The measured R4AR parameter set (SPEC, adoptable values): 2R/R 2.20, no
   bit-0 termination, dac_zero 6.65 V, dac_scale 2.63 V, Vth 1.31 V,
   voice DC 5.0 V, Ut 26 mV, C 470 pF, uCox 20e-6, WL_vcr 9/1, WL_snake
   1/115, op-amp working point 4.54 V, R24 ~ 1.5 MOhm / R1 ~ 64 kOhm.
2. Re-derivation check: our Rust re-derivation of the kinked ladder (plain
   circuit math, structure not copied) reproduces the published per-bit
   effective weights EXACTLY — [1.0000, 1.4545, 2.5702, 4.8542, ...]
   normalized to bit 0, converging to a 1.9387 factor for the top bits.
   The ladder sums to exactly 1.0000 at all bits set.
3. The kink's consequence, previously hand-authored: the sum of the low ten
   bits outweighs the top bit (0.5158 vs 0.4842 of full scale), so the f0
   DAC output DROPS ~6% at $7F -> $80 — the measured cutoff step-down at
   FC_HI $80 is DAC physics, not a hand-authored special case. ~6% dips
   also occur at every FC_HI bit boundary from 0x10 up; the reference
   dac.h comment confirms "severe discontinuities" on 6581 DACs.
4. The static map limit (see verdict): a pure closed-form drive-law map
   from one parameter set cannot reproduce the measured static anchors
   (mid-range misfit 2-3x). reSID/reSIDfp avoid the problem by solving the
   integrator dynamically per clock; a static TPT map needs the measured
   anchors as its calibration skeleton.

## Kept for later (not S5.16 scope)

- Full solve-gain adoption of the measured op-amp transfer for the summer /
  mixer / gain stages (reSID-style); our SAT_6581 tanh limiter stays
  INFERRED.
- If a measured R3 trait ever surfaces (die shots, per-revision filter
  sweeps), its profile field moves from INHERITED to SPEC.
