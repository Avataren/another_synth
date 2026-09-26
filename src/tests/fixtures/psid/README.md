# `.sid` fixtures for the PSID importer

The test tunes of `.ai/plan-psid-import.md`: C64 SID files of many players, which the
importer runs on its emulated C64 and transcribes into GoatTracker songs; one of them is a
GoatTracker export itself (`vibratotest.sid`).
These are music files, the compositions of their authors; copyright stays with them (the
header of each file names the author and the release). Thanks to the composers, and to the
High Voltage SID Collection (HVSC), where the Hubbard, Galway, Daglish, Hülsbeck, Joseph and Tel files come from.

The same files, all but `vibratotest.sid` (a test tune), are published as the demo browser's
C64 SID collection (`public/demos/sid/<composer>/`).

Names follow the house convention (lowercase, runs of anything else become `_`, under the
composer's folder, HVSC style: `hubbard_rob` for `/MUSICIANS/H/Hubbard_Rob/`).

| File | Source | Header (type, subsongs, start, load-end, init, play) | Bytes | sha256 (first 16) | Title / author / released |
|---|---|---|---|---|---|
| `hubbard_rob/commando.sid` | Provided by Morten, 2026-09-26 (HVSC `/MUSICIANS/H/Hubbard_Rob/Commando.sid`) | PSID v2, 19, 1, `$5000-$5FC6`, `$5FB2`, `$5012` | 4165 | `5295378dacb06593` | Commando / Rob Hubbard / 1985 Elite |
| `hubbard_rob/crazy_comets.sid` | Provided by Morten, 2026-09-26 (HVSC `.../Crazy_Comets.sid`) | PSID v2, 17, 1, `$5000-$610F`, `$6100`, `$500C` | 4494 | `1666b2d22866794f` | Crazy Comets / Rob Hubbard / 1985 Martech |
| `hubbard_rob/knucklebusters.sid` | Provided by Morten, 2026-09-26 (HVSC `.../Knucklebusters.sid`) | PSID v2, 11, 2, `$0400-$1F8B`, `$1EC0`, `$1ED4` | 7178 | `67490d1ecfa63488` | Knucklebusters / Rob Hubbard / 1986 Melbourne House |
| `hubbard_rob/chimera.sid` | Provided by Morten, 2026-09-26 (HVSC `.../Chimera.sid`) | **RSID** v2, 4, 1, `$9F80-$CF99`, `$9F80`, 0 (own interrupt) | 12440 | `440f530aaa50eb64` | Chimera / Rob Hubbard / 1985 Firebird |
| `galway_martin/arkanoid.sid` | Provided by Morten, 2026-09-26 (HVSC `/MUSICIANS/G/Galway_Martin/Arkanoid.sid`) | **RSID** v2, 20, 1, `$2000-$45EB`, `$4000`, 0 (own interrupt) | 9834 | `9a576463b6d9e46f` | Arkanoid / Martin Galway / 1987 Imagine |
| `galway_martin/comic_bakery.sid` | Provided by Morten, 2026-09-26 (HVSC `.../Comic_Bakery.sid`) | PSID v2, 14, 1, `$7F00-$9FFF`, `$7F00`, `$7F03` | 8574 | `acebc4eecfa1d76f` | Comic Bakery / Martin Galway / 1986 Imagine |
| `galway_martin/commando_high_score.sid` | Provided by Morten, 2026-09-26 (HVSC `.../Commando_High-Score.sid`) | PSID v2, 1, 1, `$0816-$174B`, `$081F`, `$0816` | 4020 | `30e2282f3babff79` | Commando High-Score / Martin Galway / 1986 Martin Galway |
| `galway_martin/ocean_loader_1.sid` | Provided by Morten, 2026-09-26 (HVSC `.../Ocean_Loader_1.sid`) | PSID v2, 1, 1, `$A000-$B42D`, `$B428`, `$A003` | 5292 | `dbd32b5c317b29d5` | Ocean Loader 1 / Martin Galway / 1985 Ocean |
| `galway_martin/ocean_loader_2.sid` | Provided by Morten, 2026-09-26 (HVSC `.../Ocean_Loader_2.sid`) | PSID v2, 1, 1, `$A000-$ACFA`, `$A000`, `$A04E` | 3449 | `dafb11f112fec7be` | Ocean Loader 2 / Martin Galway / 1985 Ocean |
| `daglish_ben/krakout.sid` | Provided by Morten, 2026-09-26 (HVSC `/MUSICIANS/D/Daglish_Ben/Krakout.sid`) | PSID v2, 22, 1, `$E000-$F77F`, `$F720`, `$E001` | 6142 | `9521efa1982da374` | Krakout / Ben Daglish / 1987 Gremlin Graphics |
| `daglish_ben/last_ninja.sid` | Provided by Morten, 2026-09-26 (HVSC `.../Last_Ninja.sid`) | PSID v2, 11, 3, `$2000-$AAA2`, `$2003`, `$2000` | 35617 | `b33d3134c624082a` | The Last Ninja / Ben Daglish & Anthony Lees / 1987 System 3 |
| `huelsbeck_chris/great_giana_sisters.sid` | Provided by Morten, 2026-09-26 (HVSC `/MUSICIANS/H/Huelsbeck_Chris/Great_Giana_Sisters.sid`) | **RSID** v2, 23, 1, `$71E3-$CCF9`, `$CC86`, 0 (own interrupt) | 23445 | `014764e6ee11df4b` | The Great Giana Sisters / Chris Hülsbeck / 1987 Time Warp |
| `huelsbeck_chris/r_type.sid` | Provided by Morten, 2026-09-26 (HVSC `.../R-Type.sid`) | PSID v2, 14, 1, `$3194-$CFEF`, `$3194`, `$6370` | 40666 | `a03665c42e2aeb1a` | R-Type / Chris Hülsbeck & Ramiro Vaca / 1988 Activision |
| `joseph_richard/defender_of_the_crown.sid` | ChiptuneSAK's test data (`tests/data/Defender_of_the_Crown.sid` at `c64cryptoboy/ChiptuneSAK@8759135`, 2022-01-24); ChiptuneSAK's note: "Cinemaware, 1986, later released as freeware" | PSID v2, 10, 1, `$804C-$AA99`, `$A9B7`, `$A900`; every subsong CIA-timed (speed `$3FF`) | 10956 | `c8d12f77d9ac9066` | Defender of the Crown / Richard Joseph / 1987 Cinemaware |
| `tel_jeroen/golden_axe.sid` | Provided by Morten, 2026-09-26 (HVSC `/MUSICIANS/T/Tel_Jeroen/Golden_Axe.sid`) | PSID v2, 23, 1, `$1000-$46F5`, `$10E8`, `$1074`; clock unspecified (flags `$20`), **8580** | 14196 | `c20e8eef9c9af543` | Golden Axe / Jeroen Tel / 1990 Probe Software/Virgin |
| `tel_jeroen/robocop_3.sid` | Provided by Morten, 2026-09-26 (HVSC `.../RoboCop_3.sid`) | PSID v2, 20, 1, `$1FC0-$489F`, `$1FC3`, `$1FC0`; PAL, **8580** (flags `$24`) | 10590 | `d32e0e38a9c9fcb4` | RoboCop 3 / Jeroen Tel / 1992 Ocean |
| `chiptunesak/vibratotest.sid` | ChiptuneSAK's test data (`tests/data/vibratotest.sid`, same commit; MIT-licensed repository). A GoatTracker export (player at `$1000`) | PSID v2, 1, 1, `$1000-$1B60`, `$1000`, `$1003`; **NTSC** (flags `$18`) | 3039 | `e26c1748158f7956` | " TUNE-TITLE..." / "AUTHOR NAME" |

The two Jeroen Tel tunes (the Maniacs of Noise player) are for the 8580, the rest for the
6581; all but `vibratotest.sid` (NTSC) and `golden_axe.sid` (clock unspecified, played as PAL)
are PAL.

## Wanted next

HVSC (`hvsc.c64.org`), ModLand and CSDb were not reachable from the session that added
these (the environment's network policy denied them). Tunes that would widen the players
covered, HVSC paths under `/MUSICIANS/`:

- `G/Galway_Martin/Wizball.sid`, `G/Galway_Martin/Parallax.sid` (more of Galway's filter work)
- `T/Tel_Jeroen/Cybernoid_II.sid` (Maniacs of Noise player, multispeed)
- `G/Gray_Matt/Last_Ninja_2.sid`
- `F/Follin_Tim/Ghouls_n_Ghosts.sid`
- `H/Hubbard_Rob/Monty_on_the_Run.sid`, `H/Hubbard_Rob/Delta.sid`, `H/Hubbard_Rob/Sanxion.sid`
- a GoatTracker 2 tune from HVSC (exact-unpack path), e.g. any of Cadaver's.
