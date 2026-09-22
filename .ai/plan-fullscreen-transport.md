# Plan: Fullscreen transport — stop/play/pause always visible in the top bar

Origin (Morten, 2026-09-22 14:35, verbatim): "In 'fullscreen mode' the controls to stop, and play
pause are gone. We have these controls in the top bar, but only while playing. They should always
be visible in the top bar I think."

Clarification (Morten, relayed 14:36, verbatim): "By fullscreen I mean the mode where the tracker ui
is minimized, not browser f11 fullscreen." — Confirmed: this plan targets the app's OWN fullscreen
mode, the `isFullscreen` ref in `TrackerPage.vue` toggled by the ⛶ "Full screen pattern" toolbar
button and the keyboard "Toggle fullscreen" command (`keyboard/commands/utility.ts:17-20`). It was
never the browser Fullscreen API (no `requestFullscreen` anywhere in src — MEASURED grep). The
mode: pattern canvas dominates, the page's top grid (song/patterns/instruments panels) is hidden,
and the app's own top bar — `MainLayout.vue`'s header — remains. That is the top bar in scope.

Worktree `fullscreen-trans-0922a`, branch `agent/fullscreen-transport-0922a`, from main `c027f2a2`
(the corpus commit had just landed on main; it touches only `public/demos/*` + corpus test
constants and is left alone). **Engine (rust-wasm) untouched. Audio graph untouched.** Scope:
top-bar transport UI + tests. The parallel corpus deploy run owns `public/demos/*` — not touched.

Labels: **MEASURED** = ran/observed it in this run (grep/read/mount or gate output). **INFERRED**
= read from code, not executed. **UNVERIFIED** = listed in §7.

## 0. Root cause (read first)

**The top bar's transport cluster is conditional on playback state; fullscreen removes the only
other transport, so a stopped song in fullscreen has no transport affordance at all.**

Two pieces, both MEASURED (read this run):

1. `src/layouts/MainLayout.vue:24` — the app header (the real top bar, shared by every page)
   renders the playback indicator — a pause/play toggle, a stop button and a Playing/Paused
   status pill — under `v-if="isPlaying || isPaused"`. **Stopped ⇒ the whole cluster is removed
   from the DOM.** This is the exact "only while playing" Morten reported.
2. `src/pages/TrackerPage.vue:305` — the page's own full transport (play pattern / play song /
   pause / stop / volume, `TrackerPage.vue:467–511`) lives in the song panel inside `.top-grid`,
   which carries `v-show="!isFullscreen && (!isMobileLayout || mobilePanel !== null)"`. Entering
   fullscreen (`isFullscreen` ref, the ⛶ toolbar button / keyboard toggle, `TrackerPage.vue:1726`,
   not the browser Fullscreen API) hides that grid.

Net effect: in fullscreen while stopped, the desktop toolbar (`.tracker-toolbar`,
`TrackerPage.vue:186–303`: Export MP3, ± Track, New/Load/Save/Export/Demos/Jukebox, toggles,
Edit, ⛶) has **no transport button of any kind** — INFERRED from the template read; the toolbar
contains no `handlePlay*`/`handlePause`/`handleStop` handler (MEASURED grep).

## 1. The decisions that shape the fix (read first)

**D-A. The fix is visibility, not reachability: the header indicator is always rendered; a button
is enabled only when its action has something to act on.** One rule, applied to both buttons:
`stopped` ⇒ toggle and stop disabled; `paused` ⇒ toggle (resume) and stop enabled; `playing` ⇒
toggle (pause) and stop enabled. The cluster gains a `is-stopped` muted state and the status pill
grows a third label, `Stopped`, so the always-visible cluster states itself honestly instead of
flickering into existence only when playback starts. Pause/Resume/Stop behavior and the existing
store calls (`playbackStore.pause/resume/stop`) are untouched — this plan changes template
visibility and disabled-state only.

**D-B. "Idle play starts the song" was weighed and NOT taken in this pass.** A header play button
that starts playback when nothing is loaded cannot reach the real start path: the store's
`play(song, mode, …)` needs a `PlaybackSong` and the store does not retain the last-loaded song
(grep: no `lastSong`/`currentSong` ref in `tracker-playback-store.ts`); the actual start path is
page-scoped — `TrackerPage` → `useTrackerSongHost.play(mode, startRow)` → `buildPlaybackSong(mode)`
(`useTrackerSongHost.ts:267–279`) — and `buildPlaybackSong` needs the song host's bank state that
the layout never sees. Duplicating a hand-built `PlaybackSong` in the layout would bypass the
production load path (the house rule against fixtures that don't construct the system the way
production does), and exposing a replay API on the store is a store-surface change beyond this
UX fix. Stopped-state play is therefore disabled with an honest title. §4 has the follow-up if
Morten wants one-click start from the top bar.

**D-C. Everything else that hides or gates transport stays exactly as it is.** The fullscreen
`v-show` on `.top-grid` (`TrackerPage.vue:305`) is the fullscreen mode's whole point — pattern and
nothing else — and stays. The mobile strip's always-visible transport (`TrackerPage.vue:47–67`),
the song panel's transport, Jukebox's transport, the IndexPage banner — untouched. This fix is
top-bar-scoped by Morten's own words ("visible in the top bar").

**D-D. Testids follow the repo convention** (`data-testid`, camel-ish names as in
`song-export-open`, `ahx-audition-*`): `playback-indicator` (cluster), `playback-toggle`
(pause/play/resume button), `playback-stop`. MainLayout had no testids before.

## 2. What changed

- `src/layouts/MainLayout.vue` — template: drop the `v-if`; render `.playback-indicator`
  unconditionally with a state class `is-playing/is-paused/is-stopped`; `:disable` on both
  buttons; status label Playing/Paused/Stopped. Script: three computed (`playbackState`,
  `toggleTitle`, `statusLabel`); `togglePlayPause`/`handleStop` bodies unchanged. Style: a muted
  `is-stopped` variant reusing the existing `.playback-indicator` palette; disabled buttons get
  the existing Quasar disabled look (no new component system).
- `src/tests/main-layout-playback-indicator.test.ts` — new. Mounts MainLayout with a mocked
  `tracker-playback-store` built on `defineStore` inside the `vi.mock` async factory (so
  `storeToRefs` in the component works against a real store shape), Quasar components stubbed
  (repo convention, cf. `ahx-instrument-page-play.test.ts`). Pins: cluster present in all three
  states; stopped ⇒ both buttons disabled + `Stopped` label; playing ⇒ pause icon, click calls
  `pause()`; paused ⇒ play icon, click calls `resume()`, stop click calls `stop()`.

## 3. Alternatives considered

| Option | Verdict | Why |
| --- | --- | --- |
| A. Header indicator always visible, disabled when idle (chosen) | taken | smallest honest change; store/engine untouched; matches "always visible in the top bar" |
| B. Header idle-play starts the last-loaded song | deferred to Morten | needs a store replay API (`lastSong` retention + `playLast()`) — new store surface, and the start path must stay the page's real one |
| C. Add a transport row to the fullscreen `.tracker-toolbar` | rejected | duplicates transport in two top bars (header + toolbar) with two mode/state sources; Morten pointed at the top bar that already has the controls |
| D. Keep header cluster but render it with `v-show` instead of `v-if` | rejected | invisible-but-present is the same UX bug; disabled-but-visible states the truth |

## 4. For Morten's eyeball

- The top bar now always shows [play/pause] [stop] with a status pill (Playing/Paused/Stopped).
  While stopped both buttons are greyed; the pill says Stopped. If you'd rather the stopped-state
  play button actually **start** the song from the top bar, that's option B — say the word and it
  becomes a small follow-up with a store replay API.
- In fullscreen, the page toolbar still shows no transport by design (pattern and nothing else);
  the top bar is the transport surface there.

## 5. Gates

Targeted suites (`main-layout-playback-indicator.test.ts` + existing layout/store-adjacent
suites), `npx eslint` on touched files, `npx vue-tsc --noEmit` (`.vue` files touched — the
`vue-tsc` requirement, not bare `tsc`). `.quasar/` copied + `node_modules/@quasar` symlinked into
the worktree (MEASURED done at run start).

## 6. Verification (filled at run end)

- [x] vitest targeted: `main-layout-playback-indicator.test.ts` — 4 passed (MEASURED,
      2026-09-22 14:43; mount of MainLayout with mocked playback store)
- [x] eslint: `src/layouts/MainLayout.vue` + the new test — clean, exit 0 (MEASURED)
- [x] vue-tsc --noEmit: clean, exit 0 (MEASURED; the first pass caught the mock-vs-real-store
      typing gap — `store.calls` — fixed by driving the store through an explicit mock type)
- [x] no `public/demos` paths touched: `git diff --name-only main..HEAD | grep -c demos` = 0
      (MEASURED at commit time)

## 7. UNVERIFIED

- Nothing outstanding. Not verified by hand in a browser (headless run): the visual states
  (muted `is-stopped` cluster, pill labels) are pinned by the component test, not by eyeball.
  Nothing here relies on playback-audible behavior — no audio path changed.
