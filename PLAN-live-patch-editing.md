# Plan: Live Patch Editing During Playback

## Goal
When clicking "Edit" on an instrument slot in the Tracker, the patch editor should:
1. Edit the **exact instance** used in the song (not load from a bank)
2. Hide bank selection and patch browsing UI (this is a song-specific edit)
3. Apply changes **instantly** to the playing instrument
4. Allow the user to tweak sounds while the song plays

## Current State Analysis

### What Already Exists
- `TrackerSongBank.updatePatchLive(instrumentId, patch)` - applies patch to running instrument
- `TrackerAudioStore.updatePatchLive(slotNumber, patch)` - wrapper that formats instrument ID
- `InstrumentV2.loadPatch(patch)` - applies patch parameters to worklet (works on running instruments)
- `trackerStore.editingSlot` - tracks which slot is being edited
- `songBank` singleton persists across page navigation
- Playback now persists across navigation (from previous refactor)

### What's Missing
1. **Live updates not triggered** - `saveSongPatch()` updates the store but doesn't call `updatePatchLive()`
2. **UI not restricted** - Patch editor shows full bank browser when editing song patches
3. **No real-time feedback** - Changes only apply when explicitly saving
4. **No debouncing** - Need to prevent overwhelming the audio worklet with rapid updates

## Implementation Plan

### Phase 1: Restricted UI Mode for Song Patch Editing

**Goal:** When editing a song patch, show a simplified UI without bank/patch selection.

**Files to modify:**
- `src/pages/IndexPage.vue` - Main patch editor page

**Changes:**
1. Add a computed `isSongPatchEditMode` based on `editingSlot !== null`
2. Hide the following UI elements when in song patch edit mode:
   - Bank selector dropdown
   - Patch list/browser
   - "Save to Bank" buttons
   - "Load Patch" functionality
3. Show a clear header indicating "Editing Song Patch: [Instrument Name]"
4. Add a prominent "Back to Tracker" button
5. Show current slot number and instrument name

### Phase 2: Real-Time Patch Updates

**Goal:** Apply patch changes instantly to the playing instrument.

**Files to modify:**
- `src/pages/IndexPage.vue` - Add live update calls
- `src/stores/tracker-audio-store.ts` - May need adjustments

**Changes:**
1. Create a `applyPatchLive()` function that:
   - Serializes current patch state
   - Calls `trackerAudioStore.updatePatchLive()`
   - Updates `trackerStore.songPatches` for persistence

2. Add debounced patch application:
   - 100-200ms debounce to batch rapid knob turns
   - Immediate application for discrete changes (on/off toggles)

3. Watch for patch parameter changes and trigger live updates:
   - Use Vue watchers on key patch state
   - Or hook into existing parameter change events

### Phase 3: Automatic Change Detection

**Goal:** Detect when the user changes any parameter and apply it live.

**Files to modify:**
- `src/stores/patch-store.ts` - Add change notification mechanism
- `src/pages/IndexPage.vue` - Subscribe to changes

**Changes:**
1. Add a `patchChanged` event/flag to patch-store that fires when parameters change
2. In IndexPage, watch for this event and trigger debounced live update
3. Ensure audio assets (samples, IR) are handled correctly:
   - Sample changes may need special handling
   - Convolver IR changes need async loading

### Phase 4: Edge Case Handling

**Goal:** Handle all edge cases gracefully.

**Scenarios to handle:**
1. **Playback stops while editing** - Just update the store, no live update needed
2. **Playback starts while editing** - Apply current patch state to the instrument
3. **Voice count changes** - May need special handling for active notes
4. **Sample/wavetable changes** - Async asset loading during playback
5. **Navigation away from patch editor** - Auto-save changes to song patch
6. **Multiple rapid edits** - Debouncing handles this

### Phase 5: Polish and UX

**Goal:** Make the experience smooth and intuitive.

**Changes:**
1. Visual indicator showing "Live" mode when playback is active
2. Visual feedback when changes are applied (subtle flash/highlight)
3. Undo support for patch changes during editing session
4. Keyboard shortcut to toggle back to tracker (e.g., Escape)

## File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/pages/IndexPage.vue` | Major | Add restricted UI mode, live update logic, debouncing |
| `src/stores/tracker-audio-store.ts` | Minor | Possibly add change notification |
| `src/stores/patch-store.ts` | Minor | Add patch change detection/notification |
| `src/audio/tracker/song-bank.ts` | None | Already has `updatePatchLive()` |

## Implementation Order

1. **Phase 1** - UI restrictions (visible progress, safe changes)
2. **Phase 2** - Basic live updates on explicit save
3. **Phase 3** - Automatic real-time updates with debouncing
4. **Phase 4** - Edge case handling
5. **Phase 5** - Polish

## Testing Plan

1. Start playback in tracker
2. Click Edit on a playing instrument
3. Verify UI shows restricted mode (no bank browser)
4. Turn a knob - verify sound changes immediately
5. Toggle filter on/off - verify immediate change
6. Change oscillator waveform - verify immediate change
7. Stop playback - verify edits are preserved
8. Navigate back to tracker - verify patch is saved
9. Start playback again - verify edited patch sounds correct
10. Test rapid knob movements - verify no audio glitches

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Audio glitches from rapid updates | Medium | High | Debouncing, parameter smoothing |
| Race conditions | Low | Medium | Proper async handling |
| Memory leaks from watchers | Low | Medium | Proper cleanup on unmount |
| Breaking existing patch editor | Low | High | Feature flag, careful conditional logic |

## Success Criteria

- [ ] Editing song patch shows restricted UI
- [ ] Parameter changes apply instantly during playback
- [ ] No audio glitches during normal editing
- [ ] Changes persist when navigating back to tracker
- [ ] Playback continues uninterrupted during editing
- [ ] Works with all parameter types (knobs, toggles, dropdowns)
