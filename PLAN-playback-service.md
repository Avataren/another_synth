# Plan: Persistent Playback Service

## Goal
Enable song playback to continue uninterrupted when navigating between pages, with the TrackerPage UI staying in sync when returning.

## Current Architecture Problems

1. **PlaybackEngine is created/destroyed with TrackerPage** - Playback stops on navigation
2. **Playback state is in component refs** - `playbackRow`, `playbackMode`, `mutedTracks`, `soloedTracks` are lost
3. **Event subscriptions are tied to component lifecycle** - Position updates stop when leaving
4. **No way to restore playback position** - Returning to TrackerPage loses context

## Proposed Solution: TrackerPlaybackStore

Create a new Pinia store that owns the PlaybackEngine and all playback state. This store will be a singleton that survives navigation.

### Key Design Principles

1. **Minimize resource usage** - Only keep what's necessary running
2. **Lazy initialization** - Don't create audio resources until needed
3. **Single source of truth** - All playback state in one store
4. **Efficient UI updates** - Use Vue reactivity, avoid polling

## New Store: `tracker-playback-store.ts`

### State to Persist

```typescript
interface TrackerPlaybackState {
  // Transport state
  isPlaying: boolean;
  isPaused: boolean;
  playbackMode: 'pattern' | 'song';

  // Position
  playbackRow: number;
  currentSequenceIndex: number;

  // Track state
  mutedTracks: Set<number>;
  soloedTracks: Set<number>;

  // Settings
  autoScroll: boolean;
}
```

### What Lives Outside Pinia (non-reactive singletons)

```typescript
// These can't be in Pinia state (not serializable)
let playbackEngine: PlaybackEngine | null = null;
let positionSubscription: (() => void) | null = null;
let stateSubscription: (() => void) | null = null;
```

### Store Actions

```typescript
// Initialization
initializeEngine(song: PlaybackSong): void
disposeEngine(): void

// Transport controls
play(mode: 'pattern' | 'song'): Promise<void>
pause(): void
stop(): void
seek(row: number): void

// Track controls
toggleMute(trackIndex: number): void
toggleSolo(trackIndex: number): void
isTrackAudible(trackIndex: number): boolean

// Song updates (when editing while playing)
updateSong(song: PlaybackSong): void
setBpm(bpm: number): void
setLength(rows: number): void
```

### Event Broadcasting

Use a simple event emitter pattern for components to subscribe to position updates without tight coupling:

```typescript
// In store
const positionListeners = new Set<(row: number, patternId: string) => void>();

function onPosition(callback): () => void {
  positionListeners.add(callback);
  return () => positionListeners.delete(callback);
}

// Internally, forward PlaybackEngine events to listeners
playbackEngine.on('position', (pos) => {
  playbackRow.value = pos.row;
  positionListeners.forEach(cb => cb(pos.row, pos.patternId));
});
```

## Changes to Existing Code

### 1. TrackerAudioStore (`tracker-audio-store.ts`)

**Keep**: `songBank` singleton, `editingSlotNumber`
**Remove**: `isPlaying` (move to playback store)

### 2. TrackerPage.vue

**Remove**:
- PlaybackEngine creation
- `isPlaying`, `playbackRow`, `playbackMode` refs
- `mutedTracks`, `soloedTracks` refs
- `useTrackerPlayback` composable usage (most of it)

**Add**:
- Use `useTrackerPlaybackStore()` for all playback state
- Subscribe to position events on mount, unsubscribe on unmount
- UI binds directly to store state

**Keep**:
- Track audio nodes for visualization (computed from store state)
- UI components and styling
- Keyboard handling (delegates to store)

### 3. useTrackerPlayback.ts

**Convert to thin wrapper** that delegates to store:
- Keep visualization-related code (track audio nodes)
- Remove PlaybackEngine management
- Remove state that moves to store

### 4. useTrackerSongBuilder.ts

**Keep as-is** - Still needed to build PlaybackSong from TrackerStore data

### 5. PlaybackEngine

**No changes needed** - Engine itself is fine, just needs different ownership

## Implementation Steps

### Phase 1: Create the Store (no breaking changes)

1. Create `src/stores/tracker-playback-store.ts`
2. Move PlaybackEngine instance management to store
3. Move playback state to store
4. Add position event broadcasting
5. Keep existing TrackerPage code working (dual paths)

### Phase 2: Migrate TrackerPage

1. Update TrackerPage to use new store
2. Remove local playback state
3. Update useTrackerPlayback to be visualization-only
4. Test playback works as before

### Phase 3: Enable Persistent Playback

1. Remove engine cleanup on page unmount
2. Add position restoration on page mount
3. Test navigation while playing
4. Handle edge cases (song changes while on other page)

### Phase 4: Cleanup

1. Remove dead code from TrackerPage
2. Remove unused parts of useTrackerPlayback
3. Update any other pages that might need playback info
4. Add playback indicator to header/nav (optional)

## Resource Efficiency Considerations

### What keeps running during navigation:
- PlaybackEngine scheduling loop (requestAnimationFrame)
- AudioContext and all audio processing
- Position event emitting

### What stops:
- UI updates (no listeners when TrackerPage unmounted)
- Visualization (waveforms not rendered)
- Track audio node tracking (recreated on return)

### Memory footprint:
- PlaybackEngine: ~50KB including song data
- Event listeners: Minimal (Set of functions)
- Mute/solo state: ~100 bytes

### CPU usage when playing but not viewing TrackerPage:
- Same as before (audio processing is the main cost)
- Position events still fire but no listeners = no work
- No DOM updates = significant savings

## Edge Cases to Handle

1. **Song edited while playing on another page**
   - Store tracks if song structure changed
   - On return, re-sync if needed

2. **Pattern deleted while it's playing**
   - Stop playback or jump to valid pattern

3. **BPM changed from another page**
   - Already handled by TrackerStore watch

4. **Instrument changed while playing**
   - Already works via TrackerSongBank live updates

5. **Browser tab hidden**
   - Already handled by PlaybackEngine visibility API

## File Changes Summary

| File | Change Type |
|------|-------------|
| `src/stores/tracker-playback-store.ts` | **NEW** |
| `src/stores/tracker-audio-store.ts` | Minor - remove `isPlaying` |
| `src/pages/TrackerPage.vue` | Major - use new store |
| `src/composables/useTrackerPlayback.ts` | Major - simplify to visualization only |
| `src/composables/useTrackerSongBuilder.ts` | None |
| `packages/tracker-playback/src/engine.ts` | None |

## Testing Plan

1. Basic playback works (play, pause, stop, seek)
2. Mute/solo works during playback
3. Navigate away and back - playback continues
4. Navigate away and back - UI shows correct position
5. Edit pattern while playing - changes heard
6. Stop on other page, return - correct state shown
7. Multiple rapid navigations - no crashes
8. Long playback session - no memory leaks

## Estimated Effort

- Phase 1: 2-3 hours (create store, no breaking changes)
- Phase 2: 2-3 hours (migrate TrackerPage)
- Phase 3: 1-2 hours (enable persistence)
- Phase 4: 1 hour (cleanup)

Total: ~8 hours of focused work

## Alternative Approaches Considered

### 1. Keep PlaybackEngine in TrackerPage, serialize state
- **Rejected**: Complex state serialization, audio gaps during restore

### 2. Use Web Worker for playback
- **Rejected**: Can't access AudioContext from worker, adds complexity

### 3. Keep page mounted but hidden
- **Rejected**: Vue Router doesn't support this well, wastes memory

### 4. Use Vue's keep-alive
- **Rejected**: Keeps entire component tree, expensive for TrackerPage

## Decision

The store-based approach is the cleanest solution because:
- Follows existing Pinia patterns in the codebase
- Minimal changes to working code
- No audio interruption during navigation
- Efficient resource usage
- Easy to extend (e.g., add playback indicator to nav)
