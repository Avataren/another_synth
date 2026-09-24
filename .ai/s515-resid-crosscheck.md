# S5.15 cross-check: reSID 1.0 / reSIDfp 6581 spec values vs our profile

Post-landing verification against the de-facto reference engines (raw sources,
file:line citations; values adopted as spec data — Morten 15:22: attribution not
required, code structure still not copied).

## Findings

1. **Reference 6581 filter model IS measured from an R4AR chip.** reSID 1.0
   `src/filter.cc:29-70` `opamp_voltage_6581`: "measured on MOS 6581R4AR 0687 14"
   (33-pt transfer, 0.81–10.31 V). reSIDfp `FilterModelConfig.cpp:47-90` carries
   the identical table. Consequence: our R4AR target aligns with the chassis the
   reference engines actually measured — the public record's "GENERIC-6581" prose
   hides that the reference measurement IS R4AR.
2. **No die-revision parameterization in either engine** (reSID
   `src/siddefs.h.in:63`: `enum chip_model { MOS6581, MOS8580 }`). Confirms the
   S5.15 addendum finding; our profile structure goes beyond both engines.
3. **Volume DAC: both engines model it IDEAL.** reSID `filter.cc:283-295`:
   die photographs of the volume ladder → "gain ~ vol/8", 16 ideal gain tables.
   reSIDfp `Filter6581.cpp:44-46` + `FilterModelConfig.cpp:199-218`: same. The
   kinked DAC (`Dac.cpp:53-121`, 2R/R=2.20, no bit-0 termination for 6581) is
   applied ONLY to the 11-bit cutoff DAC (`filter.cc:351`), never to volume.
4. **Our inferred weights [1,2,3.9,7.6] vs sourced ideal [1,2,4,8]:** per-bit
   ratios 1.000/1.000/0.975/0.950; max step divergence ±0.92 %FS (vol 7/8),
   within the ≤1 %FS claim in the verdict. Numerically sane; NOT upgradeable to
   "sourced" — no source measures volume-DAC nonlinearity, the engines don't
   model it at all. The $D418 digi-buzz trait stays our deliberate extension
   beyond reSID/reSIDfp, INFERRED, verdict by ear.
5. **Legacy fit_6581 is dead upstream:** current reSID 1.0 and reSIDfp replaced
   the 0.16-era polynomial fit with the measured op-amp transfer + kinked 11-bit
   f0 DAC. Our S5.12 anchors came from tools/fit_6581_filter.py (that legacy
   lineage). Refinement candidate for a later pass: adopt the measured op-amp
   transfer values (spec data, freely adoptable) + kinked 11-bit f0 weights
   [1.000, 1.4545, 2.5702, 4.8542]-style ladder for cutoff — closer to the
   reference engines than anchor interpolation.

## Key citations
- github.com/daglem/reSID @ master: filter.cc:29-70,126-147,283-295,351; dac.h:39-126;
  filter.h:359,387-388; siddefs.h.in:63
- github.com/drfiemost/residfp @ master: Dac.cpp:53-121; Filter6581.cpp:44-46,68-73;
  FilterModelConfig.cpp:47-90,104-122,124,199-218; FilterModelConfig.h:44
- All GPL-2.0-or-later; values-only adoption per Morten 15:22.
