# Plan: Top-bar play functional from the stopped state (store replay API)

Origin (Morten, 2026-09-22 14:55, verbatim): "The controls are visible now, but the play button is
disabled, so fix is worthless." — he's right. `plan-fullscreen-transport.md` made the top-bar
cluster always visible (merge `f79610f8`) and parked one-click start as "option B: store replay
API". This plan takes option B, minimally: **top-bar play ENABLED and FUNCTIONAL when a song is
loaded-and-stopped; pressing it starts playback of that song from the beginning.**

Worktree `topbar-play`, branch `agent/topbar-play-t1`, from main `87155305`. **Engine (rust-wasm)
untouched. Audio graph untouched. `public/demos` untouched. TrackerPage byte-for-byte unchanged.**
Scope: `src/stores/tracker-playback-store.ts` (state retention + `playLast`), `src/layouts/
MainLayout.vue` (enabled logic + tooltip), tests.

Labels: **MEASURED** = ran/observed it in this run (grep/read or gate output). **INFERRED** = read
from code, not executed. **UNVERIFIED** = listed in §7.

## 0. Measured start path and stop semantics (read first)

1. **The production start path is the store's `play(song, mode, startRow, startSequenceIndex)`**
   (`tracker-playback-store.ts`). TrackerPage reaches it via
   `host.play(mode, startRow)` → `playbackStore.play(buildPlaybackSong(mode), mode, startRow,
   currentSequenceIndex.value)` (`useTrackerSongHost.ts:267–279`). Jukebox reaches the same store
   through its own song host (`JukeboxPage.vue:327` `host.playbackStore`, stop at `:444`).
   **MEASURED** (read this run).
2. **`buildPlaybackSong(source, mode)`** (`packages/tracker-playback/src/playback-song-builder.ts:
   450`) builds a fresh plain `Song` from tracker/song-host state on every call — the page never
   caches it, and the store never sees it again after `play`/`loadSong`. The store keeps
   `hasSongLoaded` (stays `true` through stop) but **retains no `PlaybackSong`** — grep: no
   `lastSong`/`currentSong` ref in `tracker-playback-store.ts`. **MEASURED.** That is exactly the
   gap `plan-fullscreen-transport.md` D-B named.
3. **"Stopped" tears nothing down.** Non-AHX `stop()`: `engine.stop()`, `playbackRow=0`, notes off,
   state flags cleared — the engine and its loaded song stay alive. AHX `stop()`: `ahxEpoch++`,
   `transport.stop()`, `ahxPlace={position:0,row:0}`, state cleared — the worklet keeps the song
   bytes loaded (`isLoaded(bytes)` stays true), and `currentAhxSource()` still holds them. So a
   replay needs no re-init of the engine at all: re-entering the existing `play()` path re-loads
   (cheap idempotence for AHX: `transport.isLoaded` + `seek`) or loads the engine song again
   (non-AHX: `engine.loadSong` + `prepareInstruments`). **MEASURED** (read both `stop()` and
   `play()`/`playAhx()` bodies).
4. **Fresh load with no song ever played**: `hasSongLoaded` is `false`, nothing in the store or
   engine to replay. Decision (smaller decision S1 for Morten): play stays **disabled** with an
   honest tooltip. Auto-loading a corpus demo from the top bar was rejected as too magic — the
   tracker page's demo picker already owns "first song" semantics.
5. **Both load choke points are in the store.** `loadSong()` dispatches to `loadAhxSong()` for
   `moduleFormat === 'ahx'`; every start (`play`, `playAhx`→`loadAhxSong`, page `initializePlayback`)
   funnels through one of them. Retaining the song at those two success points captures "the
   last-loaded song" for every caller, tracker page and jukebox alike. **MEASURED.**

## 1. The decisions that shape the fix

**D-A'. Replay = re-enter the real `play()` path with the retained song.** The store gains
`lastPlaybackSong` + `lastPlaybackMode` (set on every successful load, AHX and not) and one new
action, `playLast()`: when stopped and a song is retained, `await play(lastPlaybackSong,
lastPlaybackMode, 0, 0)` — startRow 0, startSequenceIndex 0. Nothing is hand-built, no engine API
is added, and the AHX branch inside `play()` keeps its own fresh-bytes rule
(`flushAhxBytes()` + `currentAhxSource()`), so an AHX replay is audibly the *current* edit state,
not a stale snapshot. Pause/resume/stop semantics and `TrackerPage` are untouched.

**D-B'. Replay restarts from the beginning.** Typical play-after-stop transport semantics
(stop → play ⇒ top of the song); mid-song resume is already the paused toggle's job
(resume in place, unchanged). Noted as smaller decision S2 — Morten can veto toward "play from the
selected position".

**D-C'. Stopped + nothing replayable stays disabled, with an honest tooltip.** The old tooltip
("Start playback from the tracker page") is wrong in fullscreen — the tracker page is the current
page there. New stopped-state tooltips: song retained ⇒ "Play from the beginning"; nothing ever
loaded ⇒ "No song loaded yet". Stop stays disabled while stopped (inert/no-op — unchanged rule
from the previous pass). Pill stays `Stopped`.

**D-D'. `canReplay` is store-owned, not layout-guessed.** The store exposes a `canReplay` computed
(`!isPlaying && !isPaused && lastPlaybackSong !== null`); the layout only reads it. The layout must
not re-derive engine truth from `hasSongLoaded` alone (a song can be loaded while paused/playing).

## 2. What changes

- `src/stores/tracker-playback-store.ts` — two refs (`lastPlaybackSong: Ref<PlaybackSong | null>`,
  `lastPlaybackMode: Ref<PlaybackMode>`), a `recordLastSong(song, mode)` helper called at the two
  success points (end of `loadAhxSong`'s success path, end of `loadSong`'s success path),
  `canReplay` computed, `playLast()` action. All exported.
- `src/layouts/MainLayout.vue` — toggle button `:disable="playbackState === 'stopped' &&
  !canReplay"` (playing/paused unchanged); `togglePlayPause` gains the stopped branch →
  `void playbackStore.playLast()`; `toggleTitle` grows the two honest stopped-state labels; the
  D-A comment updated to the new rule. Stop button and pill untouched.
- `src/tests/main-layout-playback-indicator.test.ts` — mock store grows `canReplay` + `playLast`;
  the old stopped no-op test is *re-scoped* (still true when nothing is replayable), new pins:
  stopped+retained ⇒ toggle enabled, click → `playLast()`, tooltip "Play from the beginning";
  stopped+nothing ⇒ toggle disabled, tooltip "No song loaded yet". The four existing pins (cluster
  present in all states; playing/paused routing; paused stop routing) keep their assertions.
- `src/tests/playback-store-replay.test.ts` — new store-level suite: real
  `useTrackerPlaybackStore` with the heavy deps mocked (fake `PlaybackEngine`, fake song bank,
  fake tracker store); pins: successful load records the song; `playLast()` while stopped calls
  `play` with (retained song, retained mode, 0, 0); `playLast()` no-op while playing/paused and
  with nothing retained; `stop()` leaves retention intact; AHX song retention goes through the
  same record point.

## 3. Alternatives considered

| Option | Verdict | Why |
| --- | --- | --- |
| A. Store retains last song + `playLast()` re-enters `play()` (chosen) | taken | minimal store surface; replay is the production start path (house rule: construct the system the way production does); works for AHX (fresh bytes) and non-AHX alike; covers jukebox via the same choke points |
| B. Page registers a replay callback with the store (`setTrackAudioNodeSetter` precedent) | rejected | registration lifecycle questions (unmount, other pages), and the store would hold a page closure — a bigger, less inspectable surface than two refs |
| C. Rebuild the song inside the store at replay time from `trackerStore` | rejected | duplicates `buildPlaybackSong`'s source assembly (`useTrackerSongBuilder.source()`), which the plan D-B already established the store cannot see correctly |
| D. Top-bar play loads the first corpus demo when nothing is loaded | rejected (S1) | too magic; the demo picker owns "first song" |

## 4. Smaller decisions for Morten

- **S1. Nothing ever loaded ⇒ top-bar play disabled** with tooltip "No song loaded yet". Alternative
  would auto-load a corpus demo; rejected as too magic this pass.
- **S2. Replay starts from the beginning** (stop→play ⇒ top of song; startRow 0, position 0).
  Alternative: play from the currently selected sequence position (the page's own Play Song
  semantics). Say the word and it flips.
- **S3. Non-AHX snapshot staleness window.** The retained `PlaybackSong` is the object that last
  went through `play()`. AHX replays are audibly fresh (the store re-flushes bytes inside
  `playAhx`). Non-AHX songs edited *while stopped* and then started from the top bar replay the
  pre-edit snapshot (the page's own Play button rebuilds fresh). The page's transpose paths already
  hot-rebuild while *playing*, so the window is stop → edit → top-bar play. Accepted for this
  minimal pass; the full fix (store-owned rebuild or a page-registered provider) is a separate
  decision if the window bothers Morten.

## 5. Gates

Targeted suites (`main-layout-playback-indicator.test.ts`, new `playback-store-replay.test.ts`),
eslint on touched files, `npx vue-tsc --noEmit` (`.vue` files touched — the vue-tsc requirement,
not bare `tsc`). `.quasar/` copied + `node_modules/@quasar` symlinked into the worktree
(MEASURED done at run start).

## 6. Verification (filled at run end)

- [x] vitest targeted suites: `playback-store-replay.test.ts` 6 passed +
      `main-layout-playback-indicator.test.ts` 6 passed (4 original pins kept,
      2 new) — 12/12 (MEASURED, 2026-09-22 15:01; log
      `.ai/checks-topbar-play-t1.txt`)
- [x] eslint touched files: clean, exit 0 (MEASURED)
- [x] vue-tsc --noEmit: clean, exit 0 (MEASURED; first pass caught 16 TS
      errors in the new store-level test only — 'mod' not a ModuleFormat,
      and array-index narrowing needing explicit guards; store/layout clean
      from the first pass; re-run clean)
- [x] no `public/demos` paths touched: `git diff main --name-only -- public`
      → empty; `src/pages/TrackerPage.vue` diff vs main → empty
      (byte-for-byte unchanged) (MEASURED at commit time)

## 7. UNVERIFIED

- Not verified by hand in a browser (headless run): the audible replay is pinned by
  the store-level test's `play` routing assertions, not by ear. No audio-path code changed.

## Landed (2026-09-22)

Merged `agent/topbar-play-t1` tip `abb5ea9d` into main as `9b2fcda1` (no-ff,
"merge: top-bar play functional from stopped (agent/topbar-play-t1)"), pushed
`87155305..9b2fcda1` to origin. Tip was unchanged from review (still `abb5ea9d`),
worktree owner marker absent, main tree clean with no deploy residue. Pre-merge
preflight: main HEAD == origin/main == `87155305`. Post-merge gates on main green:
targeted suites 12/12 (main-layout-playback-indicator + playback-store-replay,
`TARGETED_EXIT=0`), eslint `LINT_EXIT=0`, `vue-tsc --noEmit` `VUETSC_EXIT=0`
(log `/tmp/topbar-play-gates.log`). Deployed via `scripts/deploy.sh` (checksum of
script `439f0c032a0119f4573ba08d4cd8e3f8`) to avatar@192.168.50.161, DEPLOY_EXIT=0,
log `.ai/deploy-topbar-play-20260922.log`; script-verified index.html checksum
`1a547c7fef16bf5c2711271dac39e455` plus independent md5 byte-match local vs remote:
index.html (`1a547c7fef16bf5c2711271dac39e455`),
wasm/audio_processor_bg.wasm (`660f3c70e72d0b87e2ed2dadc65eee42`),
demos/index.json (`c01cfe00793310fc4bf06f71e252ecab`) — all identical. Reviewer
PASS on `abb5ea9d` remains the code evidence. Branch + worktree left in place;
no force-push, no history rewrite.
