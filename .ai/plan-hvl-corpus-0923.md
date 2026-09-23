# Plan: HVL corpus curated batch 16 (2026-09-23)

Landing the 16 shortlisted HVL candidates (Morten approved "Land them", 07:07) into
`public/demos/ahx/`, branch `agent/hvl-corpus-0923a`, worktree `.ai/worktrees/hvl-corpus`.
Base: `main` @ 7316ba9e. Curation evidence: `/tmp/hvl-curate/` (REPORT.md,
candidates-full.json — ModLand provenance URLs + md5s + P0 parse measurements).

## The 16 (title / author / tier / measured)

| # | file | author | tier | md5 | ch | pos | instr | bytes |
|---|------|--------|------|-----|----|-----|-------|-------|
| 1 | forsaken.hvl | Virgill | RM | 97e9d003 | 6 | 29 | 15 | 7609 |
| 2 | mijikai_tobikomi.hvl | Monk | RM + >4ch | c70a85da | 11 | 17 | 18 | 16888 |
| 3 | hexplosion.hvl | AceMan | RM + >4ch | a51da09f | 16 | 45 | 36 | 38965 |
| 4 | meltwater_10ch.hvl | Syphus | >4ch/heavy pan | 9a009111 | 10 | 19 | 10 | 8207 |
| 5 | lanterns.hvl | AceMan | >4ch | dca2f0ef | 16 | 37 | 28 | 17958 |
| 6 | incognito_crust.hvl | m0d | RM | 0f78c8a8 | 6 | 58 | 27 | 8291 |
| 7 | yoake_no_myoujou.hvl | Varthall | >4ch | 5117d770 | 16 | 19 | 15 | 22387 |
| 8 | drop_table.hvl | Syphus | >4ch | b5a51705 | 12 | 30 | 16 | 12778 |
| 9 | afterstorm.hvl | Syphus | RM + >4ch | 702fa89d | 12 | 22 | 17 | 8699 |
| 10 | sweeties.hvl | Syphus | RM + >4ch | 90d4241e | 10 | 28 | 13 | 12052 |
| 11 | a_little_cyberfunk.hvl | JazzCat | >4ch | 435c2464 | 8 | 49 | 13 | 9581 |
| 12 | galactic_emeralds.hvl | Monk | >4ch | 87276220 | 10 | 24 | 19 | 18392 |
| 13 | there_you_are.hvl | Xeron | >4ch | 412d80da | 6 | 48 | 5 | 3191 |
| 14 | unexpected_horse.hvl | Monk | RM + >4ch | e63632f6 | 10 | 116 | 7 | 5327 |
| 15 | ring_modulation_test_song.hvl | Xeron | RM reference | 04afab6a | 4 | 6 | 3 | 427 |
| 16 | top_gun_anthem.hvl | Syphus | >4ch + recognition | e223153b | 12 | 21 | 10 | 10564 |

(md5s = first 8 hex of the full md5, verified against cand.md5 before staging.)

## Staging procedure

1. Verify candidates: md5sum -c over all 43 fetched files (all OK), magic bytes via file(1)
   (all Hively Tracker Song v0/v1, valid version field).
2. Copy the 16 into `public/demos/ahx/` renamed to the house convention
   (lowercase, underscore-separated: `meltwater (10ch).hvl` → `meltwater_10ch.hvl`, etc.).
3. Re-index with `scripts/refresh-demos.sh` (index.json is generated — never hand-edited):
   238 songs total, +16 HVL entries, no existing entry changed (diff verified: only the
   16 added entries + the `generated` timestamp).
4. Re-measure every corpus-size/content pin fresh (see below), full gates, stop on branch.

## Pin re-measures (all MEASURED by running the suites on the staged corpus, not guessed)

- `plist-track.test.ts`: files 84→100, instruments 1290→**1542**; lossless name updated.
- `ahx-plist-row-core.test.ts`: CORPUS 84→**100**.
- `ahx-writer-corpus.test.ts`: corpus 84→100 (hvl 7→23), (A) checked 84→100,
  (B) identical 77→**92** / explained 7→**8**, fixed-point 84→100.
- `ahx-exporter-corpus.test.ts`: .hvl round-trip + AHX-refusal checked 7→**23**.
- `song-export-hvl.test.ts`: CHANNELS_USED extended with the 16 measured highest-reached
  tracks (a_little_cyberfunk 8, afterstorm 12, drop_table 12, forsaken 6,
  galactic_emeralds 10, hexplosion 16, incognito_crust 6, lanterns 16, meltwater_10ch 10,
  mijikai_tobikomi 11, ring_modulation_test_song 3, sweeties 10, there_you_are 6,
  top_gun_anthem 12, unexpected_horse 10, yoake_no_myoujou 16).

Note: yesterday's corpus-add15 commit (c027f2a2) landed without its pins; f75201a0 fixed
them retroactively. This batch updates the pins in the same landing.

## Surprises found and resolved (not improvised — measured)

1. **meltwater_10ch.hvl does not round-trip byte-identically** (raw writer with base,
   raw writer without base, and the through-store exporter path all agree): output is the
   source plus exactly one trailing NUL byte (8208 vs 8207). Cause, measured: the source
   string table (129 bytes) ends right after `"greetez to alle\0"` and omits the final
   (empty) instrument 10 name's terminator; `parseAhx` reads instrument 10 as `""`, and the
   writer canonically emits that name's NUL. `parse(parse(out))` deep-equals `parse(src)`;
   `hvlExporter.check` is ok; playback identical. All 15 other new files round-trip
   byte-identically through both paths. Handled with the house documented-exception pattern
   (same mechanism as EXPLICIT_BLANK_TRACK_0 / INERT_BYTE_19_BITS): `TRAILING_NAME_NUL`
   lists the file and asserts the exact one-byte delta + parse equivalence. The alternative
   — changing the writer — is out of scope (src/ non-test change, forbidden here).
2. **ring_modulation_test_song.hvl is refused as AHX for a different reason**: it fits 4
   tracks but uses the second effect column ("This song uses a second effect column, which
   AHX files don't have. Export it as HVL instead."). The refusal tests now expect the
   per-file reason. This was anticipated as impossible ("all .hvl use more than 4 channels")
   — the corpus grew a 4-channel HVL, so the test premise changed.
3. **chiprolled.hvl title fix: nothing to fix.** The task ordered a title fix in index.json
   ("byte-identical to Xeron's never gonna give you up.hvl — mislabeled title"). Measured:
   the index entry for chiprolled.hvl already reads `"never gonna give you up"` — the
   embedded title, md5-proven correct (0af72bfe, identical to Xeron's ModLand file), and it
   has since the file was added (2c69573b). The mislabel is only the *filename*
   (`chiprolled.hvl`), which "no file changes" forbids touching. No commit made; if the
   filename itself should be fixed (breaking nothing — the file is referenced by fixture
   name in ~10 test files), that is a separate decision.

## Verification — gates, measured 2026-09-23 07:22–07:24

- `npm run test:run`: **235 files / 3831 tests, all passed** (62.8 s).
- eslint (`--max-warnings=0`): exit 0.
- `vue-tsc --noEmit`: exit 0.
- `gitleaks detect --no-git`: no leaks found (161.7 MB scanned).
- `npm run check:artifacts`: worklets + wasm match sources.
- Load/play coverage: every new file parses (`plist-track`/`plist-row-core` over all 100),
  imports through the store path and round-trips (`exporter-corpus`, `song-export-hvl`,
  `writer-corpus`), and corpus instruments render through the real wasm engine
  (`plist-row-core` oracle tests over the new corpus).