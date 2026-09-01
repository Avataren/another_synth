# Task

Fix a jukebox end-of-song issue in another_synth.

## Desired behavior

When a song reaches its last pattern and that pattern's jump/order position
points BACKWARD (to an earlier position in the track order, or to an earlier
pattern), the jukebox must treat it as the **end of the song** and move on.

Without this, songs whose last pattern loops back to an earlier pattern repeat
forever, and the jukebox never advances to the next song.

## Notes

- Relevant code: `src/stores/jukebox-store.ts`, `src/composables/useJukeboxPlayer.ts`,
  `src/composables/useTrackerSongHost.ts`, `src/stores/tracker-playback-store.ts`.
- There are existing tests for song end: `src/tests/tracker-song-end.test.ts` and
  `src/tests/stores/jukebox-store.test.ts` — extend them to cover the backward-jump case.
- Be careful to only treat a backward jump as end-of-song when it happens at the
  LAST pattern of the song; normal backward jumps mid-song (e.g. pattern loops)
  must keep working.

## Deliverables

1. Implementation on a branch `agent/jukebox-end-of-song`.
2. Tests passing: `npm run test` (or the repo's configured test/lint/build commands).
3. Gitleaks clean: `gitleaks detect --no-git --source .` must report no findings.
4. Commits on the branch, saved check output in `.ai/`, no push.
