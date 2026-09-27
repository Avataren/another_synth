**Resume O7 from `.ai/opl-o7-progress.md` (handoff, 2026-09-27, session 2) — read it first; it
supersedes the task list below where they differ. D1 is relaxed for debugging: AT2's source is
at `.ai/at2-src` (read for semantics, write fresh Rust; AdPlug's player source stays unread).**

Continue the OPL work in `.ai/plan-opl.md`: next is **O7 (the A2M player)**, the second half of
the Adlib Tracker II track. Read the plan first, especially §3 (Adlib Tracker II), §4 (oracles
and licensing), §6 (D0–D6, all settled; do not re-ask them) and the O2, O5 and **O6** landing
records. The S3M engine issues still open are in `.ai/task-s3m-open-issues.md`. They are **not**
this session's work.

## Where things stand (main; O6 committed, not pushed)

- `rust-wasm/src/opl/` is an OPL3 chip that matches ymfm sample for sample (OPL2 mode = NEW=0,
  4-op, rhythm, 18 channels, per-channel L/R, per-channel scope taps). `OplRenderer` (wasm)
  plays register writes stamped by frame. The worklet is `opl-audio-processor`
  (`src/audio/worklets/opl-core.ts` + `opl-worklet.ts`); S3M AdLib playback uses it through
  `OplOutput` (`src/audio/tracker/opl-output.ts`).
- **O6:** `rust-wasm/src/opl/a2/` parses all 278 corpus `.a2m` files (versions 1, 5, 9–14)
  into `A2mSong` (`model.rs`): instruments (11 FM bytes, panning, finetune, voice type), v9+
  FM/arpeggio/vibrato macros, order (128 **raw** bytes), tempo, speed, flags, pattern length,
  tracks, macro speed-up, 4-op and lock flags, v14 rows-per-beat and tempo finetune, and
  patterns as row-major cells (note, instrument, two effects). Effect numbers are stored as
  the file has them. v1–4 (0–15) and v5–8 (0–35) must be mapped to the v9+ set. Nothing is
  exported to wasm yet.
- **Oracle:** AdPlug + libbinio, built static under `.ai/adplug-oracle/prefix` (gitignored;
  rebuild from github.com/adplug/{libbinio,adplug} with cmake if it is gone).
  `rust-wasm/src/opl/a2/oracle/` has the black-box harnesses and `regen.sh`. AdPlug is LGPL:
  **run it, never read its player source** (`a2m-v2.cpp` is adapted from AT2's GPL code). D6
  allowed reading `unlzh.c` only, and that is done.
- **Format reference:** the AT2 authors' `techinfo.htm`, saved at `.ai/a2m-ref/` (text in
  `techinfo.txt`). It has the effect table (89 effects + extended commands), the vibrato and
  tremolo tables and the file layouts. It says nothing about playback timing, order-list markers
  or macro semantics. Those are what O7 has to pin, against the oracle.
- Real hardware: *Corridors of Time* recorded from an SB16 CT2290 (OPL3) at
  `.ai/opl-ref/corridors-of-time-sb16-ct2290.flac`. The corpus README lists tier-1 files.

## Task: O7 — play A2M in Rust and in the app

Shape (§3): a **Rust player next to the chip** that ticks and writes registers itself, like
`rust-wasm/src/ahx/player.rs` (`AhxPlayer`, `#[cfg_attr(feature = "wasm", wasm_bindgen)]`) and
`rust-wasm/src/sid/`. Not the TS engine plus a driver.

1. **Oracle first.** Before writing effect code, build a register-write trace oracle: a small
   `Copl` subclass (public `opl.h` interface: `write(reg, val)`, `setchip`) that logs every
   write AdPlug's player makes, per tick (`update()`), for a tier-1 file. Pin semantics from
   traces, the way O3 pinned ST3 against its own register writes. Do this at least for timing
   (tempo/speed/macro speed-up → tick rate), the order list (what values ≥ 0x80 mean; AdPlug
   reports 0 orders, so trace it), note → F-number/block (finetune), volume → TL, panning, 4-op
   and percussion. Render WAVs from the same harness (AdPlug ships a Nuked OPL3 wrapper) for
   audio A/B.
2. **Player** in `rust-wasm/src/opl/a2/player.rs`: song position, rows, ticks, effects
   (both columns), FM/arpeggio/vibrato macros, 4-op pairs, percussion mode, OPL3 panning, and
   the flag bits (volume scaling, locks, depths). It writes registers into a `Chip` and renders
   through the existing resampler. Map v1–8 effect numbers explicitly, from traces, not guesses.
3. **Wasm class** `A2Player` and a worklet (or an `opl-audio-processor` mode) with the same API
   as SID/AHX: load, play/pause, seek to order/row, loop, mute/solo per channel, scope taps.
4. **Tracker hookup** like AHX/SID (see `src/audio/tracker/ahx-player.ts`, `ahx-import.ts`,
   `ahx-song-transport.ts`): open an `.a2m`, show position, play song, mute/solo, scopes.
   Playback only (D3): no A2M pattern editing.
5. **Refuse truthfully** at load when a song uses something the player cannot do yet. Never
   play a silent partial song.

Gate: register-trace equality against AdPlug per tier-1 file for the ticks you claim, with
any divergence explained in the landing record (AdPlug is a port and may itself differ from
AT2, so say which you follow and why). Also audio A/B against AdPlug renders; *Corridors of
Time* against the SB16 recording (level and character, not bit-exact); `npm run test:run`
green; and Morten's ears. Commit per batch, do not push unless asked, and end with an O7
landing record in the plan.

## Environment notes

- Rust needs nightly on PATH:
  `export PATH="$HOME/.rustup/toolchains/nightly-x86_64-unknown-linux-gnu/bin:$PATH"`.
  Run the OPL tests with `cd rust-wasm && cargo test --lib opl::` (the a2 corpus tests take
  about 7 s in debug).
- Any change under `rust-wasm/src` (test files and TSVs included, since every file is hashed)
  needs `npm run build:wasm`, then `npm run build:worklets`. Commit `public/wasm` and **all**
  changed `public/worklets/*.js`, and verify with `npm run check:artifacts`.
- `npm run test:run` is the one-shot suite; `npm run test` is watch mode and never exits.
  Worklet tests can time out under memory pressure; re-run failing files alone first.
- Type-check: two known errors in `packages/tracker-playback/src/__tests__/engine-pattern-delay.spec.ts`
  and `engine-s3m-note-delay.spec.ts`, plus about 95 Vue component-prop errors in
  `src/tests/ahx-*`. Only new errors matter.
- `rustfmt` the files you touch (the crate as a whole is not fmt-clean; don't reformat others).
- `.ai/` is gitignored; add plan files with `git add -f`.
- The shell's `ls` is aliased (icons, leading spaces); use `printf '%s\n' *` or `find` in
  scripts. Don't `pkill -f` with a pattern that matches your own command line.
- To drive the app: `npm run dev` serves `http://localhost:9000/synth/`. Claude in Chrome may be
  disconnected; a cached Playwright works headless
  (`/home/avataren/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core`, Chromium 1234).
  In the tracker, Space is **Play Pattern**; use the "Play Song" button.
- Deploy flow when Morten asks for it: commit, `git push`, `./deploy-local.sh` (bumps and tags
  a release; it deploys to the public Pi), then `git push --follow-tags`.
