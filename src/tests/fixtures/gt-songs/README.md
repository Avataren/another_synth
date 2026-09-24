# GoatTracker corpus fixture

The S5 `.sng` importer's acceptance corpus (`src/tests/sid-sng-corpus.test.ts`
pins the counts). The same 84 files are deployed as song data in
`public/songs/goattracker/`; this copy is the tests' own, so curating the
public set never moves a test. `../gt-songs-corrupt/sleepwalk.sng` is the one
corrupt-as-published file, kept to prove it is refused.

These are GoatTracker song files (`.sng`): song **data**, the compositions of
their authors, not program code. They were curated on 2026-09-23 from
**ModLand** (https://modland.com), the GoatTracker section
(`/pub/modules/GoatTracker/`, all nine artist folders: Aeuk, Ansgaros,
Barfington, Cadaver, Mch, Shinobi, Spock, Stinsen, Yehar). One more was added
on 2026-09-24, with Morten's authorization: Kalachnikov's `sid-warrior.sng`,
from ModLand's GoatTracker 2 section (`/pub/modules/GoatTracker 2/`). Thanks
to ModLand for keeping them, and to the composers for writing them. Copyright
stays with the composers (the copyright line inside each file says whose).

84 files: 62 `GTS5` (GoatTracker 2) and 22 `GTS!` (GoatTracker 1). One more
file in the folders, Spock's `sleepwalk.sng`, is corrupt as published (its
pattern data desyncs under every layout) and is not included here.

Names follow the house convention (lowercase, runs of anything else become
`_`, under the artist's folder); the table maps each to its ModLand name.
Two tokens in a name mean something to the importer, because a `.sng` file
cannot store them: `6581`/`8580` (the SID chip the song was written for) and
`2x` (GoatTracker's speed multiplier). See
`src/audio/tracker/sid-doc/gt-sng-common.ts` (`gtSongHintsFromName`).

| File | ModLand path (`/pub/modules/GoatTracker/…`) | Format | Bytes | sha256 (first 16) | Title / author (from the file) |
|---|---|---|---|---|---|
| `aeuk/metal_warrior_4_streets.sng` | `Aeuk/metal%20warrior%204%20-%20streets.sng` | GTS! | 8598 | `34da331cf5ecacc7` | Streets / Aeuk & Cadaver |
| `aeuk/metal_warrior_4_unused_jingle.sng` | `Aeuk/metal%20warrior%204%20-%20unused%20jingle.sng` | GTS! | 2039 | `76c1a81382c0061b` | (empty: GoatTracker 1 file) |
| `ansgaros/metal_warrior_4_forest_encounter.sng` | `Ansgaros/metal%20warrior%204%20-%20forest%20encounter.sng` | GTS! | 6857 | `2cf6c68c0a14f31f` | (empty: GoatTracker 1 file) |
| `barfington/barfington_s_nintendometal.sng` | `Barfington/barfington%27s%20nintendometal.sng` | GTS! | 6702 | `6afdcecab3301129` | Barfington's nintendometal |
| `barfington/metal_warrior_4_research_facility.sng` | `Barfington/metal%20warrior%204%20-%20research%20facility.sng` | GTS! | 5584 | `18af18cc587f2ce8` | (empty: GoatTracker 1 file) |
| `cadaver/covert_ops_in_2d_funktempo.sng` | `Cadaver/covert%20ops%20in%202d%20%28funktempo%29.sng` | GTS! | 5697 | `76424e6ac976530e` | Covert Ops in 2D (funktempo) / Cadaver |
| `cadaver/dojo.sng` | `Cadaver/dojo.sng` | GTS! | 7641 | `cee3451227d8cda8` | Dojo / Cadaver |
| `cadaver/galwaytest.sng` | `Cadaver/galwaytest.sng` | GTS! | 2025 | `45710ea8ce9daf14` | (empty: GoatTracker 1 file) |
| `cadaver/goattracker_classical_example.sng` | `Cadaver/goattracker%20classical%20example.sng` | GTS! | 2522 | `99cb99aab743dd2c` | GoatTracker classical example / Lasse Öörni |
| `cadaver/goattracker_drum_example.sng` | `Cadaver/goattracker%20drum%20example.sng` | GTS! | 1538 | `cfb0defe77036d85` | GoatTracker drum example / Lasse Öörni |
| `cadaver/goattracker_example_mw1_title.sng` | `Cadaver/goattracker%20example%20%28mw1%20title%29.sng` | GTS! | 3226 | `d7860d64b0d82d67` | GoatTracker example (MW1 title) / Lasse Öörni |
| `cadaver/maximum_rastertime_test.sng` | `Cadaver/maximum%20rastertime%20test.sng` | GTS! | 1226 | `31d4cd23c0c87329` | Maximum rastertime test / Lasse Öörni |
| `cadaver/metal_warrior_4_covert_ops_in_2d.sng` | `Cadaver/metal%20warrior%204%20-%20covert%20ops%20in%202d.sng` | GTS! | 5697 | `de75a04d9532859a` | Covert Ops in 2D / Cadaver |
| `cadaver/metal_warrior_4_investigations.sng` | `Cadaver/metal%20warrior%204%20-%20investigations.sng` | GTS! | 8611 | `41944cae212d4fa8` | Investigations / Cadaver |
| `cadaver/metal_warrior_4_the_chosen_path.sng` | `Cadaver/metal%20warrior%204%20-%20the%20chosen%20path.sng` | GTS! | 6556 | `de76c558615c0cd9` | The Chosen Path / Cadaver |
| `cadaver/mw_title_remix.sng` | `Cadaver/mw%20title%20remix.sng` | GTS! | 3482 | `1f84d1673cbc7b4c` | MW Title Remix / Cadaver |
| `cadaver/mw_title_remix_2x_speed.sng` | `Cadaver/mw%20title%20remix%2C%202x-speed.sng` | GTS! | 3482 | `6f0b53890d34af40` | MW Title Remix, 2x-speed / Cadaver |
| `cadaver/nintendo_style.sng` | `Cadaver/nintendo-style.sng` | GTS! | 3201 | `e652f7b206a74087` | Nintendo-style / Cadaver |
| `cadaver/tarantula.sng` | `Cadaver/tarantula.sng` | GTS! | 6818 | `310c791f027bc5e7` | (empty: GoatTracker 1 file) |
| `cadaver/warlord.sng` | `Cadaver/warlord.sng` | GTS! | 7174 | `fa3efe2ad8e885d3` | (empty: GoatTracker 1 file) |
| `kalachnikov/sid_warrior.sng` | `/pub/modules/GoatTracker 2/Kalachnikov/sid-warrior.sng` (GoatTracker 2 section; added 2026-09-24; no chip or `2x` token: untagged, the loader's defaults apply) | GTS5 | 10722 | `d4aba14293b1ab87` | Sid-Warrior / Kalachnikov |
| `mch/alien_funk.sng` | `Mch/alien%20funk.sng` | GTS5 | 19083 | `f5a6b844bd148190` | Alien Funk / Michal Brzeski (Mch) |
| `mch/attitude_14.sng` | `Mch/attitude%2014.sng` | GTS5 | 9536 | `2c10d6a788b0bc89` | Attitude #14 / Michal Brzeski (Mch) |
| `mch/balcony_princess.sng` | `Mch/balcony%20princess.sng` | GTS5 | 28497 | `9d03d02a3fa6240b` | balcony princess / mch/genesis project^msl |
| `mch/golden_moments.sng` | `Mch/golden%20moments.sng` | GTS5 | 22932 | `31a922017c5abba7` | Golden Moments / Michal Brzeski (Mch) |
| `mch/graffiti_intro.sng` | `Mch/graffiti%20intro.sng` | GTS5 | 6460 | `cc8070678d364b89` | Graffiti Intro / Michal Brzeski (Mch) |
| `mch/groove_machine.sng` | `Mch/groove%20machine.sng` | GTS5 | 13620 | `7bd95891cb4ba456` | Groove Machine / Michal Brzeski (Michu) |
| `mch/gubbdata_2016_invitation.sng` | `Mch/gubbdata%202016%20invitation.sng` | GTS5 | 6714 | `68912a7b9a762c9d` | Gubbdata 2016 Invitation / Michal Brzeski (Mch) |
| `mch/homunculi_tune_1.sng` | `Mch/homunculi%20tune%201.sng` | GTS5 | 12566 | `89e4a5ab8f53eeea` | Homunculi (Tune 1) / Michal Brzeski (Mch) |
| `mch/homunculi_tune_2.sng` | `Mch/homunculi%20tune%202.sng` | GTS5 | 40675 | `1f72be66e6be999f` | Homunculi (Tune 2) / Michal Brzeski (Mch) |
| `mch/hybrid_song.sng` | `Mch/hybrid%20song.sng` | GTS5 | 23106 | `20d14604265bb3fc` | Hybrid song (Funky Stars) / Michal Brzeski (Mch) |
| `mch/in_a_rush.sng` | `Mch/in%20a%20rush.sng` | GTS5 | 14968 | `94198e1299e1c5a1` | In A Rush / Michal Brzeski (Michu) |
| `mch/midnight_dream.sng` | `Mch/midnight%20dream.sng` | GTS5 | 10402 | `2e2b8e38dcce7849` | Midnight Dream / Michal Brzeski (Mch) |
| `mch/on_the_road_once_again.sng` | `Mch/on%20the%20road%20once%20again.sng` | GTS5 | 24470 | `0335cae0c69de2ad` | On the Road Once Again / Michal Brzeski (Mch) |
| `mch/pagans_mind.sng` | `Mch/pagans%20mind.sng` | GTS5 | 18286 | `4192cbd52f1a63ca` | Pagan's Mind / Michal Brzeski (Mch) |
| `mch/plasma_intro.sng` | `Mch/plasma%20intro.sng` | GTS5 | 10451 | `a4222410c9ed83b8` | Plasma Intro / Michal Brzeski (Mch) |
| `mch/pocket_tomb.sng` | `Mch/pocket%20tomb.sng` | GTS5 | 9026 | `c1833161b73fcbb8` | Pocket Tomb / MCH/Genesis*Project/Dream |
| `mch/sky_captain.sng` | `Mch/sky%20captain.sng` | GTS5 | 11171 | `ae55539d0135fa92` | Sky Captain / MCH/Genesis*Project/Dream |
| `mch/two_years_in_gp.sng` | `Mch/two%20years%20in%20gp.sng` | GTS5 | 5210 | `9e97cda59bd1f4c5` | Two years in G*P / Michal Brzeski (Mch) |
| `shinobi/wod.sng` | `Shinobi/wod.sng` | GTS! | 12328 | `54776c65cd46637a` | Wings of Death -level 2 / Shinobi |
| `stinsen/alcorythm_ffff.sng` | `Stinsen/alcorythm_ffff.sng` | GTS5 | 14366 | `70b8976a849a2f3f` | Alcorythm / Stinsen |
| `stinsen/archaic_groove.sng` | `Stinsen/archaic_groove.sng` | GTS5 | 37452 | `7f0b54d8dc2ad563` | Archaic Groove / Stinsen |
| `stinsen/arpling.sng` | `Stinsen/arpling.sng` | GTS5 | 18240 | `eb61005a9a28968a` | The Ugly Arpling / Stinsen |
| `stinsen/bait.sng` | `Stinsen/bait.sng` | GTS5 | 37993 | `c7139d47d064af29` | Bait & Switch / Stinsen |
| `stinsen/ballad.sng` | `Stinsen/ballad.sng` | GTS5 | 39446 | `65f1c2f2566ec305` | (empty: GoatTracker 1 file) |
| `stinsen/christmas_boogie.sng` | `Stinsen/christmas_boogie.sng` | GTS5 | 5547 | `ce75b3627ad945f6` | Christmas Boogie (wip) / Stinsen |
| `stinsen/classical.sng` | `Stinsen/classical.sng` | GTS5 | 2558 | `d99f8475516979f9` | (empty: GoatTracker 1 file) |
| `stinsen/coconut_conundrum.sng` | `Stinsen/coconut_conundrum.sng` | GTS5 | 10760 | `7390d97b052382e4` | Coconut Conundrum / Stinsen |
| `stinsen/defunkt_final_fv_po_ro_6581_ffff.sng` | `Stinsen/defunkt_final_fv_po_ro_6581_ffff.sng` | GTS5 | 21783 | `d4dfaafab389bcd4` | Defunkt / Stinsen |
| `stinsen/diminishing_returns.sng` | `Stinsen/diminishing_returns.sng` | GTS5 | 18760 | `9106317451a1857c` | Diminishing Returns (wip) / Stinsen |
| `stinsen/double_rainbow_2x.sng` | `Stinsen/double_rainbow_2x.sng` | GTS5 | 21633 | `3d551288aad4e27f` | Double Rainbow / Stinsen |
| `stinsen/endless_summer.sng` | `Stinsen/endless_summer.sng` | GTS5 | 11667 | `6f0a2e146e37a776` | Endless summer (wip) / Stinsen |
| `stinsen/failedfunk.sng` | `Stinsen/failedfunk.sng` | GTS5 | 2014 | `68b4fa1120e957b6` | (empty: GoatTracker 1 file) |
| `stinsen/feeling_pink.sng` | `Stinsen/feeling_pink.sng` | GTS5 | 55268 | `36dd556b89feafff` | (empty: GoatTracker 1 file) |
| `stinsen/flumbos_keps.sng` | `Stinsen/flumbos_keps.sng` | GTS5 | 55062 | `b02106b4c02da1f0` | (empty: GoatTracker 1 file) |
| `stinsen/forced_entry.sng` | `Stinsen/forced_entry.sng` | GTS5 | 50043 | `cf073929b1496600` | Forced Entry (wip) / Stinsen |
| `stinsen/game_tune.sng` | `Stinsen/game_tune.sng` | GTS5 | 9045 | `c75b06302a61d4f2` | Game tune / Stinsen |
| `stinsen/gremlinfunk.sng` | `Stinsen/gremlinfunk.sng` | GTS5 | 6179 | `ae7d4716a69325ce` | Gremlinfunk / Stinsen |
| `stinsen/iguana.sng` | `Stinsen/iguana.sng` | GTS5 | 14502 | `eb45bf263f71743f` | Iguana / Stinsen & MCH |
| `stinsen/jeroenimo.sng` | `Stinsen/jeroenimo.sng` | GTS5 | 16011 | `7a81c5b28b29cc4f` | Jeroenimo (wip) / Stinsen |
| `stinsen/jogeir.sng` | `Stinsen/jogeir.sng` | GTS5 | 36595 | `fb3b0227a2d33ebb` | (empty: GoatTracker 1 file) |
| `stinsen/lethargic.sng` | `Stinsen/lethargic.sng` | GTS5 | 22996 | `cb720f4a1f811d45` | Lethargic / Stinsen |
| `stinsen/lolo_sawtooth_only.sng` | `Stinsen/lolo_sawtooth_only.sng` | GTS5 | 8439 | `d4a139726c348eaf` | Lolo / Stinsen |
| `stinsen/nordic_scene_review.sng` | `Stinsen/nordic_scene_review.sng` | GTS5 | 20543 | `10d08c720993baf9` | Nordic Scene Review / Stinsen |
| `stinsen/pirate.sng` | `Stinsen/pirate.sng` | GTS5 | 11415 | `7a202099044d0ed7` | (empty: GoatTracker 1 file) |
| `stinsen/premonition_fv_po_ro_ffff.sng` | `Stinsen/premonition_fv_po_ro_ffff.sng` | GTS5 | 31118 | `0c9e7dfe0cbe40d0` | Premonition / Stinsen |
| `stinsen/quaralline_2x.sng` | `Stinsen/quaralline_2x.sng` | GTS5 | 18504 | `bbc9b0346cefd3b7` | Quaralline / Stinsen |
| `stinsen/relapse.sng` | `Stinsen/relapse.sng` | GTS5 | 9134 | `1e56352134706489` | Relapse / Stinsen |
| `stinsen/reverb.sng` | `Stinsen/reverb.sng` | GTS5 | 1888 | `a9bce8195093028c` | (empty: GoatTracker 1 file) |
| `stinsen/running_on_empty_ffff.sng` | `Stinsen/running_on_empty_ffff.sng` | GTS5 | 16812 | `037a2c22d924762b` | Running on empty / Stinsen |
| `stinsen/safari.sng` | `Stinsen/safari.sng` | GTS5 | 4645 | `111052e0a4810605` | (empty: GoatTracker 1 file) |
| `stinsen/scarabaeus_0f00_fv_po_ro.sng` | `Stinsen/scarabaeus_0f00_fv_po_ro.sng` | GTS5 | 19964 | `70821c188765d3d9` | Scarabaeus / Stinsen |
| `stinsen/shadow.sng` | `Stinsen/shadow.sng` | GTS5 | 11467 | `a51b188b9c041309` | Shadow Introq / Stinsen |
| `stinsen/sidetracked.sng` | `Stinsen/sidetracked.sng` | GTS5 | 19479 | `77bdd46ae3a39599` | Sidetracked / Stinsen |
| `stinsen/sniff.sng` | `Stinsen/sniff.sng` | GTS5 | 5344 | `e3a03f3629f5a05c` | (empty: GoatTracker 1 file) |
| `stinsen/space_2x.sng` | `Stinsen/space_2x.sng` | GTS5 | 26919 | `97c3915bb0674a50` | Space Cheddar / Stinsen |
| `stinsen/sunset_shuffle_po_ro_ffff.sng` | `Stinsen/sunset_shuffle_po_ro_ffff.sng` | GTS5 | 14126 | `49aa793966f32fe5` | Sunset Shuffle (wip) / Stinsen |
| `stinsen/trainwreck.sng` | `Stinsen/trainwreck.sng` | GTS5 | 44960 | `69897409115d1ddf` | Trainwreck / Stinsen |
| `stinsen/tribal.sng` | `Stinsen/tribal.sng` | GTS5 | 1432 | `e63843c055f13c55` | (empty: GoatTracker 1 file) |
| `stinsen/tribal18.sng` | `Stinsen/tribal18.sng` | GTS5 | 26525 | `645e17598b779836` | (empty: GoatTracker 1 file) |
| `stinsen/tribal_tribunal.sng` | `Stinsen/tribal_tribunal.sng` | GTS5 | 16243 | `a287a1fd749b27a5` | Tribal Tribunal / Stinsen |
| `stinsen/unleash_the_cheese.sng` | `Stinsen/unleash_the_cheese.sng` | GTS5 | 20101 | `bfa86b446a33b9b1` | Unleash the cheese / Stinsen |
| `stinsen/upsandowns.sng` | `Stinsen/upsandowns.sng` | GTS5 | 51104 | `b22d817272503070` | Klegg & Stinsen |
| `yehar/b_o_f_h_ingame_death_victory.sng` | `Yehar/b.o.f.h.%20ingame%2C%20death%2C%20victory.sng` | GTS! | 7403 | `b5042f224a178013` | B.O.F.H. Ingame, Death, Victory / Olli Niemitalo |
