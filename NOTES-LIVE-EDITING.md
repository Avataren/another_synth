# Live Patch Editing During Playback - Architecture Notes

## Goal
Allow users to edit instrument patches while a song is playing in the tracker, hearing real-time changes.

## Current State (as of 2025-11-26)
The feature is **disabled** due to architecture issues. The groundwork is partially in place but needs further work.

## What Works
- `TrackerSongBank` is now a singleton managed by `tracker-audio-store.ts`
- The songBank persists across page navigation
- `updatePatchLive()` method exists on songBank to hot-swap patches on active instruments
- Basic watcher infrastructure exists in IndexPage.vue (currently disabled)

## What Doesn't Work

### Problem 1: PlaybackEngine lives in TrackerPage
The `PlaybackEngine` instance is created inside `TrackerPage.vue` and destroyed when navigating away. This means:
- Playback stops when navigating to the patch editor
- The playback scheduling, row position, and timing all get lost
- Returning to TrackerPage creates a fresh PlaybackEngine

### Problem 2: Playback State is Local
These refs live in TrackerPage and are destroyed on navigation:
- `isPlaying`
- `playbackRow`
- `playbackMode`
- `autoScroll`

The `trackerAudioStore` has `isPlaying` but it's just a copy synced from TrackerPage, not the source of truth.

### Problem 3: Update Loop Spam
When we tried enabling live updates, the deep watchers on `nodeStateStore.$state` and `layoutStore.synthLayout` fired repeatedly during:
- Initial patch load when navigating to editor
- Any state change that triggers WASM updates which trigger more state changes

We added a 500ms delay before enabling updates, but it's a band-aid.

## Attempted Solutions

### What We Tried
1. Keep playback running on unmount if `trackerStore.editingSlot !== null`
   - Result: Song kept playing but UI was disconnected, stop button didn't work, pattern position not visible

2. Add `liveUpdateEnabled` flag with delay
   - Result: Reduced spam but didn't eliminate it; still caused audio glitches

## Recommended Architecture for Future

### Option A: Persistent Playback Service
Move PlaybackEngine to a service/store that persists across navigation:

```typescript
// stores/playback-store.ts
export const usePlaybackStore = defineStore('playback', {
  state: () => ({
    isPlaying: false,
    playbackRow: 0,
    playbackMode: 'pattern' as 'pattern' | 'song',
    // ... other playback state
  }),
  actions: {
    // PlaybackEngine instance managed here
    // All playback control methods here
  }
});
```

TrackerPage would then:
- Connect to this store for playback state
- Display the playback position from the store
- Call store actions for play/stop/pause

### Option B: Side Panel Editor
Instead of navigating away, open the patch editor in a side panel or modal while staying on TrackerPage. This avoids the navigation problem entirely.

### Option C: Detached Audio Preview
When editing a song patch, don't try to sync with the running song. Instead:
- Stop playback when editing (current behavior)
- Provide a "preview" button that plays a test note through the instrument being edited
- User can hear changes without the complexity of syncing to playback

## Files Involved
- `src/stores/tracker-audio-store.ts` - Singleton songBank holder
- `src/pages/TrackerPage.vue` - PlaybackEngine, playback state, unmount logic
- `src/pages/IndexPage.vue` - Live update watchers (currently disabled)
- `src/audio/tracker/song-bank.ts` - `updatePatchLive()` method
- `src/composables/useTrackerPlayback.ts` - Playback composable

## Other Bug Fixed in This Session
**Cursor getting stuck during note entry** - The patch SELECT dropdown was capturing keyboard focus. Fixed by:
- Adding `onPatchSelectAndBlur()` to blur the select immediately after selection
- Adding `refocusTracker()` to return focus to the tracker container
- The keyboard handler skips events when target is INPUT/TEXTAREA/SELECT
