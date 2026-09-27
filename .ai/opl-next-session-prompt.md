Continue the OPL work in `.ai/plan-opl.md`: next is **O6 (A2M parse)**, the first half of the
Adlib Tracker II track. Read the plan first, especially §3 (Adlib Tracker II), §4 (oracles and
licensing), §4.1 (corpus) and the O2 and O5 landing records. D0–D5 are settled; do not re-ask
them. The S3M engine issues still open are in `.ai/task-s3m-open-issues.md`. They are **not**
this session's work.

## Where things stand (main, all pushed; live as v0.4.25)

- `rust-wasm/src/opl/` is an OPL3 chip that matches ymfm sample for sample (OPL2 mode = NEW=0,
  4-op, rhythm, 18 channels, per-channel L/R). `OplRenderer` (wasm) plays register writes
  stamped by frame. It has per-channel scope taps (`set_taps_enabled`, `read_tap`, ±1 = one
  operator's full swing).
- The worklet is `opl-audio-processor` (`src/audio/worklets/opl-core.ts` + `opl-worklet.ts`).
  Output 0 is stereo; outputs 1..18 are the channel taps. Commands: `writes`, `set-gain`,
  `set-channel-mask`, `set-taps`, `panic`, `dispose`.
- S3M AdLib playback is complete in the app (O5). `S3mOplDriver` is in the library.
  `OplOutput` (`src/audio/tracker/opl-output.ts`) owns the node, batching, mute mask, scope
  wiring and the per-file mix gain (`s3mOplMixGain`, OpenMPT's balance). There is a
  "Scream Tracker 3 AdLib" demo collection (`public/demos/s3m-adlib/`).
- None of that is A2M-specific. A2M is a different shape: a **Rust player** next to the chip
  that ticks and writes registers itself, like `rust-wasm/src/ahx/` and `rust-wasm/src/sid/`
  (§3). It is not the TS engine plus a driver.

## Task: O6 — parse every A2M in the corpus, or refuse it truthfully

- Corpus: `src/tests/fixtures/opl/a2m/` (277 `.a2m` files; its README is the manifest). All are
  `_A2module_`, version byte at offset 14; versions 1, 5, 9, 10, 11 (145 files), 12, 13, 14.
  There are no `.a2t` files. The README names a tier-1 list covering every version.
- **Licensing first (D1, §4 is UNVERIFIED here).** Before reading any Adlib Tracker II source,
  confirm its license. Port or study only permissive sources. AdPlug (LGPL) is a **render
  oracle only**: build and run it, never copy from it, the same rule as gt2reloc and
  Nuked OPL3. If no permissive description of the format or its packers exists, stop and
  tell Morten what you found before going on.
- Pin the format per version against the real files: header, song data, patterns, instruments
  and macro tables, and **which versions are compressed with which packer**. Several packers
  are used across versions. Record what you measure in the plan with the
  MEASURED/INFERRED/UNVERIFIED labels.
- Where it lives: `rust-wasm/src/opl/a2/` (parser + decompressors), producing a song model the
  O7 player will consume. Parse in Rust (D3: playback only, no TS parser or editor grid).
- Gate: a Rust corpus test in which every file either parses or refuses with a one-line,
  true reason (E15 discipline: never a silent partial parse). Also: per-version tier-1 spot
  checks of decoded fields (song name, order list, instrument count, a pattern cell or two)
  against an independent reading. Make one mutation per decompressor (flip a bit) to
  show the gate has teeth.
- End with an O6 landing record in the plan. Commit per batch; do not push unless asked.

After O6, **stop and report**. Do not start O7 (the player, worklet class and tracker hookup)
unless asked.

## Environment notes

- Rust needs nightly on PATH:
  `export PATH="$HOME/.rustup/toolchains/nightly-x86_64-unknown-linux-gnu/bin:$PATH"`.
  Run the OPL tests with `cd rust-wasm && cargo test --lib opl::`.
- Any change under `rust-wasm/src` needs `npm run build:wasm`, then `npm run build:worklets`.
  Commit `public/wasm` and **all** `public/worklets/*.js`, then verify with
  `npm run check:artifacts`. Every file under `rust-wasm/src` is hashed, test fixtures
  included, so even a test-only Rust change needs the rebuild.
- `npm run test:run` is the one-shot suite; `npm run test` is watch mode and never exits.
  Worklet tests can time out under memory pressure (a dev server plus Chromium running); re-run
  the failing files alone before believing a failure.
- Type-check: two known errors in `packages/tracker-playback/src/__tests__/engine-pattern-delay.spec.ts`
  and `engine-s3m-note-delay.spec.ts`, plus about 95 Vue component-prop errors in
  `src/tests/ahx-*`. Only new errors matter.
- `.ai/` is gitignored; add plan files with `git add -f`.
- The shell's `ls` is aliased (icons, leading spaces); use `printf '%s\n' *` or `find` in
  scripts.
- To drive the app: `npm run dev` serves `http://localhost:9000/synth/`. Claude in Chrome may be
  disconnected; a cached Playwright works headless
  (`/home/avataren/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core`, Chromium 1234).
  In the tracker, Space is **Play Pattern**; use the "Play Song" button.
- Deploy flow when Morten asks for it: commit, `git push`, `./deploy-local.sh` (bumps and tags
  a release; it deploys to the public Pi), then `git push --follow-tags`.
