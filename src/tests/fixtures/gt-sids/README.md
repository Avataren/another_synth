# GoatTracker's own `.sid` files for the `.sid` exporter's tests

Written by GoatTracker 2.77's command-line packer, `gt2reloc`, from the `.sng`
our `.sng` exporter writes for each song's imported doc
(`exportGtSong(importGtSong(gt-songs/<song>))`), so that `exportSid` of the same doc must
give the same bytes (plan-sid-authoring.md phase 4, `.ai/sid-oracle/psid_gate.ts`).

| File | Song (`gt-songs/`) | gt2reloc options |
|---|---|---|
| `alien_funk.opt.sid` | `mch/alien_funk.sng` | `-S1 -M0` (GoatTracker's default, optimized) |
| `alien_funk.sid` | `mch/alien_funk.sng` | `-S1 -M0 -I0` (disable optimization: the export dialog's build) |
| `mw_title_remix_2x_speed.sid` | `cadaver/mw_title_remix_2x_speed.sng` | `-S2 -M0 -I0` (2x: CIA timer stub) |
| `sniff.8580.sid` | `stinsen/sniff.sng` | `-S1 -M1 -I0` (8580 flag) |

`gt2reloc` was built from the GoatTracker 2.77 source release with a local oracle
patch that is not part of this repository: a `break` after its `-I` option
(upstream it falls through into `-J`, so `-I0` also turns on full buffering) and an
`-M<0|1>` option for the PSID model flag (upstream always writes 6581).

The files hold GoatTracker's playroutine (`player.s`, outside the GPL by its own
header) and the songs' data.
