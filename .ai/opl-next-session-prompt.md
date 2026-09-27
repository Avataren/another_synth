Continue the OPL work in `.ai/plan-opl.md`: next is **O5 (app wiring)**. Read the plan first,
especially the O2, O3 and O3b landing records. D0–D5 are settled; do not re-ask them. The
S3M engine issues still open after O3b are tracked separately in
`.ai/task-s3m-open-issues.md`. They are **not** this session's work unless O5 runs into one.

## Where things stand (main, all committed, not pushed)

- `rust-wasm/src/opl/` is an OPL3 chip that is sample-exact against ymfm. `OplRenderer`
  (wasm) plays register writes stamped by frame. The worklet is `opl-audio-processor`
  (`src/audio/worklets/opl-core.ts` + `opl-worklet.ts`). Its commands are `writes` (a
  Float64Array of (AudioContext seconds, reg, val) triples), `set-gain`,
  `set-channel-mask`, `panic` and `dispose`; it reports `late-writes` and `error`.
- `S3mOplDriver` (`packages/tracker-playback/src/opl-driver.ts`) is sink-side. It turns a
  sink's note-on/off, pitch and volume events for AdLib instruments into ST3-exact register
  writes on an `OplRegisterTarget`. Since O3b it holds a tick's retrigger and TL write until
  that tick settles. It flushes on the next event on the channel at a later time, at the end
  of the current task (`queueMicrotask`), or on an explicit `driver.flush()`. A host that
  batches writes to the worklet should call `flush()` before posting a batch.
- The engine options an OPL host must pass:
  - `steppedTickAutomation: (id) => driver.handles(id)` (slides tick by tick);
  - `oplInstrument: (id) => driver.handles(id)` (new in O3b: ST3 keeps the vibrato phase
    across an AdLib note).

  The pitch handler's optional 7th argument is the pitch `source`; pass it to
  `driver.setPitch`.
- The reference wiring is the test harness `playThroughDriver` in
  `src/tests/s3m-adlib-st3-trace.test.ts`: every engine callback, mapped onto the driver.
- The gate is `src/tests/s3m-adlib-st3-trace.test.ts`. 8 of 10 tier-1 songs match ST3's
  register writes on every tick; koakuma (361) and first-adlib-attempt (1) are pinned. Render
  WAVs with `OPL_WAV_DIR=<dir>`. Renders sit at −8 to −21 dBFS RMS and clip the chip's
  16-bit output on ≤ 0.26 % of samples.

## Task: O5

- `song-bank.ts` / its `TrackerSink` routes events for OPL instruments (`driver.handles(id)`)
  to an `S3mOplDriver`. The driver's target batches writes to the OPL worklet (flush the
  driver first). Channel map: `s3mAdlibChannelForTrack`. The file's amiga-limits flag goes
  to the driver.
- A mixer channel for the OPL worklet with sensible headroom (see the loudness figures
  above).
- Pass `steppedTickAutomation` **and** `oplInstrument` in `tracker-playback-store.ts`.
- Mute/solo through the worklet's channel mask (`set-channel-mask`).
- `driver.reset` at song start; `panic` + `allNotesOff` on stop/seek.
- Update the instrument panel, and the `InstrumentSlot` / import-warning text that still
  says OPL is inactive ("imported, but the app does not play OPL yet").
- An optional injected OPL target for `StandaloneTrackerSink`.
- Gate: a mixed PCM+AdLib song (`src/tests/fixtures/opl/s3m-adlib/Manwe/`) plays in the
  app, and `npm run test:run` is green (one shot, not watch mode).
- Check it in the browser with the run skill or Claude in Chrome. The user's ears are the
  final accept: ask them to listen to starport (Purple Motion) and a Manwe song.
- End with an O5 landing record in the plan. Commit per batch; do not push.

After O5, **stop and report**. Do not continue to O6/O7 (Adlib Tracker II) unless asked.

## Environment notes

- Rust needs nightly on PATH:
  `export PATH="$HOME/.rustup/toolchains/nightly-x86_64-unknown-linux-gnu/bin:$PATH"`.
- Any change under `rust-wasm/src` needs `npm run build:wasm`, then
  `npm run build:worklets`. Commit `public/wasm` and **all** `public/worklets/*.js`, then
  verify with `npm run check:artifacts`. A change to `opl-core.ts`/`opl-worklet.ts` alone
  needs `build:worklets`.
- `npm run check:tracker-playback-dist` fails on clean HEAD here (a build tool is missing,
  exit 127). That is pre-existing; nothing in CI builds `dist`.
- Import the library by package name (`@another-synth/tracker-playback`). New modules go in
  its `index.ts` (`export *`), so names must stay unique across the package.
- Type-check: about 95 pre-existing Vue component-prop errors in `src/tests/ahx-*`; only new
  errors matter.
- `.ai/` is gitignored; add plan files with `git add -f`.
- The shell's `ls` is aliased (icons, leading spaces); use `printf '%s\n' *` or `find` in
  scripts.
