# OPL corpus

Fixtures for the OPL work in `.ai/plan-opl.md`. Fetched 2026-09-27 from modland:

- `s3m-adlib/` — `ftp.modland.com/pub/modules/Ad Lib/Screamtracker 3 AdLib/` (42 files, all of it)
- `a2m/` — `ftp.modland.com/pub/modules/Ad Lib/AdLib Tracker 2/` (277 files, all of it
  except `Konakonaa/matte-black-furnace.snm`, a SnevenTracker module, not A2M)

Layout is `<composer>/<file>` as modland has it. Every file's size matched the listing.
`.as3m` is modland's name for some AdLib S3Ms; the bytes are ordinary `SCRM` files.

Kept outside `public/demos/` on purpose: an AdLib S3M there would be listed by the demo
browser and play with its AdLib channels silent until the OPL core lands.

`sun.s3m` (25 AdLib instruments, 7 AdLib channels) is already vendored in
`public/demos/s3m/` and pinned by `src/tests/s3m-corpus.test.ts`.

## What the scan found

S3M (channel settings 16..29 = AdLib, instrument type byte):

- **No type 3+ (drum) instruments in any file.** Every AdLib instrument is type 2 (melodic).
- Six files enable 10–12 AdLib channel settings, so they include drum (B) channels even
  without drum instruments: the four `- unknown/(opl2) *` files with 10–12, and
  `Omega/redemptions.s3m` with 10.
- Mixed PCM + AdLib: the three `Manwe/` files (29–51 PCM instruments next to 4–24 AdLib).
- Tracker: mostly ST3.20 (`cwt` 0x1320), some ST3.00/3.01, and four OpenMPT-saved files
  (`cwt` 0x51xx: `Soda7/`, `Viraxor/` ×2, `Yomaru Kasuga/`).

A2M (header `_A2module_`, version byte at offset 14). There are no `_A2tiny_module_` (.a2t) files.

| Version | Files | Composers |
|---|---|---|
| 1 | 11 | Subz3ro, Nula |
| 5 | 27 | Nula, DJ Speedstar, Malfunction, Corona688, Drx, Subz3ro |
| 9 | 38 | Benjamin Gerardin, Nula, Subz3ro |
| 10 | 1 | Subz3ro |
| 11 | 145 | Brendan Bailey (88), OxygenStar, Diode Milliampere, MadBrain, Encore, … |
| 12 | 8 | Diode Milliampere |
| 13 | 17 | Konakonaa, Kvee, Malfunction, Meritaehti |
| 14 | 30 | Televicious, Konakonaa, Malfunction, Peter Gantar |

## Tier 1 (test these first)

Modland carries no ratings, and The Mod Archive hosts almost no A2M. So tier 1 is picked
by composer standing (Subz3ro wrote Adlib Tracker II; Purple Motion and Skaven are Future
Crew) and by coverage: every A2M version, and every S3M category above.

S3M:

| File | Why |
|---|---|
| `Purple Motion/starport bbs introtune.s3m` | ST3.00, 9 AdLib channels, AdLib only |
| `Skaven/starport bbs introtune 2 v2.s3m` | ST3.00, AdLib only |
| `Skaven/first adlib attempt.as3m` | 30 instruments, PCM channels enabled |
| `Manwe/and this is ultrasound.s3m` | mixed: 51 PCM + 24 AdLib |
| `Manwe/serious rocking-horse.s3m` | mixed, 10 PCM channels |
| `Manwe/rotagilla.s3m` | mixed, only 4 AdLib instruments |
| `Bisqwit/some kind of church theme.s3m` | ST3.20, AdLib only |
| `Mayaman/mystic reflections.s3m` | 30 AdLib instruments |
| `Omega/redemptions.s3m` | a drum (B) channel enabled |
| `- unknown/(opl2) rance 4.1 - bird.s3m` | 59 instruments, 10 AdLib channels |
| `Basehead/a vision.s3m` | ST3.01 |
| `Viraxor/koakuma.s3m` | saved by OpenMPT |

A2M:

| File | Version |
|---|---|
| `Subz3ro/intro-tune coop.a2m` | 1 |
| `Nula/super mario.a2m` | 1 |
| `Nula/prehistorik.a2m` | 5 |
| `Malfunction/little boring trance.a2m` | 5 |
| `Nula/onward.a2m` | 9 |
| `Subz3ro/1942.a2m` | 9 |
| `Subz3ro/psychedelic sound synthesis.a2m` | 10 (the only one) |
| `MadBrain/oskari the heimfanker.a2m` | 11 |
| `Diode Milliampere/samsara.a2m` | 11 |
| `Diode Milliampere/keys.a2m` | 12 |
| `Diode Milliampere/endless scroll.a2m` | 12 |
| `Malfunction/opl303.a2m` | 13 |
| `Kvee/paradox #3.a2m` | 13 |
| `Konakonaa/ETWARAWK.A2M` | 14 (largest file, 37 KB) |
| `Malfunction/fm-tronikk (aka altair street dancer).a2m` | 14 |
| `Televicious/boom.a2m` | 14 |
| `NAB622/corridors of time.a2m` | 11. Morten's favourite; heavy use of macros; hardware reference below |

## Extra file (not from modland)

`a2m/NAB622/corridors of time.a2m` comes from NAB622's own MediaFire folder, linked from
the video "Corridors of Time - Adlib Tracker (OPL3)" (youtube.com/watch?v=DEhbdVYSVMQ):
`mediafire.com/folder/v2jnw5e5zp755`, where it is named `Corridor.A2M` (6 897 bytes,
fetched 2026-09-27).

The same folder holds `Corridors of Time.flac`, which NAB622 recorded **from a real Sound
Blaster 16 CT2290** (an OPL3). It is too big to vendor (24 MB). A local copy is at
`.ai/opl-ref/corridors-of-time-sb16-ct2290.flac` (gitignored). It is the only
real-hardware render in the corpus, so it is the A/B reference for the chip core and the
A2M player.

What the A2M files declare (O6 parser, 2026-09-27). This counts header flags and
instrument data, not whether a pattern plays them:

| Version | Files | 4-op (tracks or instrument pairs) | Percussion flag | Percussion instruments | Panning (instrument, lock or macro) |
|---|---|---|---|---|---|
| 1 | 11 | 0 | 0 | 0 | 0 |
| 5 | 27 | 0 | 0 | 0 | 13 |
| 9 | 38 | 0 | 1 | 0 | 2 |
| 10 | 1 | 0 | 0 | 0 | 1 |
| 11 | 146 | 13 | 6 | 13 | 40 |
| 12 | 8 | 0 | 5 | 4 | 6 |
| 13 | 17 | 1 | 0 | 1 | 12 |
| 14 | 30 | 8 | 5 | 7 | 25 |
| all | 278 | 22 | 17 | 25 | 99 |
