# S5.15 research notes — 6581 R4AR die-revision calibration

Collected 2026-09-24 by main-side subagent run bc3d6d2c (Joi). Public knowledge only; zero GPL.
NOTE: web_search provider was unavailable during this run; research = direct fetches of named sources.

## Sources (fetched 2026-09-24)

- S1: Wikipedia, "MOS Technology 6581", section "Revisions".
  https://en.wikipedia.org/wiki/MOS_Technology_6581
- S2: C64-Wiki, "SID", sections "Chip variations" and "Trivia".
  https://www.c64-wiki.com/wiki/SID
- S3: Wikipedia references for the revision claim: chipmusic.org forum thread "C64 SID
  shootout - 6581 vs 8580" (https://chipmusic.org/forums/topic/17495/) and polynominal.com
  "commodore-64-sid-6581-8580" (https://www.polynominal.com/commodore-64-sid-6581-8580/commodore-64-sid-6581-8580.html).

## Facts

- F1 (S1): The 6581 revisions after R1 were R2, R3, R4 and R4AR. Quote: "No substantial
  alterations were made between these revisions, only minor changes to the
  protection/buffering of the input pins, adjustment of the silicon grade, and changes to
  packaging."
- F2 (S2, Chip variations table): production windows — 6581 1982-1985; 6581R3 1985-1986;
  6581R4 1986 (16/1986-30/1986); **6581R4AR 22/1986-06/1987**; 8580R5 1987-1992.
- F3 (S2, Trivia): the volume-register design flaw in the original 6581 ("Every time the
  volume register value was altered, an audible click could be heard") was used to play
  samples via $D418; "In the later 8580 model this bug was fixed and samples were inaudible".
- F4 (S1): "The 6581's filter has a non-linear cutoff range, varies wildly between chips,
  and often distorts, while the 8580's filter has a linear cutoff range, is more consistent
  between chips". No per-revision filter parameters are given in the public record.
- F5 (S2, Pinout): 6581 external filter caps 470 pF (pins 1+2 / 3+4); 8580 20 nF; 6581 Vdd
  12 V vs 8580 9 V.

## Trait classification (what is R4AR-specific vs generic-6581)

- Filter cutoff curve: **GENERIC-6581.** The public record documents 6581-vs-8580
  nonlinearity (F4) but no R4AR-specific anchors. S5.12's measured curve stays the
  baseline; the R4AR profile refines nothing on public evidence → legitimate finding
  (do NOT force differences).
- $80 step position/shape: **NOT SPECIFIED in the public record I could reach.** No
  fetched source separates R4AR's step position/shape from other 6581 revisions. Marked
  GENERIC-6581; do not invent a revision-specific step.
- Volume-DAC nonlinearity (digi-buzz trait): **GENERIC-6581 vs 8580** (F3). Public record:
  loud digi on 6581, near-silent on 8580. Per-bit weights of the 4-bit volume DAC are not
  verified from the public record → any concrete table must be marked INFERRED.
- Output-stage DC levels: **GENERIC-6581.** S2's MIX_DC_6581 = 0.5 (already INFERRED in
  chip.rs header) stays; the public record gives no revision-specific DC numbers.

## Conclusion for calibration

R4AR is the last and most common 6581 revision (F2) and the public record treats R2-R4AR
as audibly equivalent (F1). Therefore the R4AR profile = the refined generic-6581
characteristics (S5.12 measured cutoff curve + S2 output stage + NEW volume-DAC
nonlinearity), structured as revision data in ONE swappable module so the later R3 pass
can add a profile (which, on current public evidence, will be near-identical or identical).

## Honest caveats

- Without a real R4AR chip on the bench, calibration is literature-based.
- web_search was unavailable; die-analysis pages (siliconpr0n 6581; die-shot writeups)
  were unreachable (403/404) in this run — if they contain per-revision filter or volume
  data, that is UNVERIFIED here, not absent.
- Volume-DAC nonlinearity table: no verified public per-bit weights; implement as
  INFERRED, conservative, and disclose in code comments + verdict.
