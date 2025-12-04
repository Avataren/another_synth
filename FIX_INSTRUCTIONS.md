# How to Fix Glitchy MOD Playback - IMMEDIATE SOLUTION

## The Problem

The worklet pooling implementation has a bug where multiple instruments overwrite each other's state in the shared worklet, causing glitchy playback.

## The Solution (2 minutes)

**Enable "Simplified MOD Instruments" in your settings.** This uses `ModInstrument` which:
- ✅ No worklets = No conflicts
- ✅ Better performance for MOD files
- ✅ Native Web Audio API
- ✅ Designed specifically for sample playback

## How to Enable

### Option 1: Via UI (if settings UI exists)
1. Open Settings
2. Find "Use Simplified MOD Instruments"
3. Enable it
4. Reload the MOD file

### Option 2: Via Code (if no UI)
Find your user settings store and set:
```typescript
useSimplifiedModInstruments: true
```

### Option 3: Default for Everyone
In `src/stores/user-settings-store.ts`, change the default:
```typescript
useSimplifiedModInstruments: true  // Change from false to true
```

## What This Does

**Before (with worklet pooling bug):**
```
Instrument 01 loads → Worklet state = Patch 01
Instrument 02 loads → Worklet state = Patch 02 (01 overwritten!)
Instrument 03 loads → Worklet state = Patch 03 (01 & 02 overwritten!)
Result: GLITCHY - only last instrument works
```

**After (with ModInstrument):**
```
Instrument 01 → AudioBufferSourceNode with Sample 01
Instrument 02 → AudioBufferSourceNode with Sample 02
Instrument 03 → AudioBufferSourceNode with Sample 03
Result: PERFECT - all instruments independent
```

## Verification

After enabling, check console logs when loading a MOD file:
```
✅ Should see: [SongBank] Creating ModInstrument for 01
❌ Should NOT see: [SongBank] Creating InstrumentV2 for 01
❌ Should NOT see: [SongBank] Creating PooledInstrument for 01
```

## Why This Is Better Anyway

ModInstrument is actually **better** for MOD files than WASM-based synthesis:

| Feature | ModInstrument | InstrumentV2 (WASM) |
|---------|---------------|---------------------|
| Memory per instrument | ~50KB | ~350KB |
| Worklets needed | 0 | 1 per instrument |
| Load time | Fast | Slow (WASM init) |
| CPU usage | Low (native) | Medium (WASM) |
| Sample playback | ✅ Native | ✅ Via WASM |
| Complex synthesis | ❌ No | ✅ Yes |

For MOD files (which only need sample playback), ModInstrument is the right tool!

## Debugging

If still seeing issues after enabling:

1. **Check the logs:**
   ```javascript
   // Look for this in console:
   [SongBank] === INSTRUMENT CREATION DEBUG ===
   [SongBank]   instrumentType: mod
   [SongBank]   isModInstrument: true
   [SongBank]   useSimplified: true  ← Should be true!
   [SongBank]   Decision: ModInstrument  ← Should be ModInstrument!
   ```

2. **Hard refresh browser:** Ctrl+Shift+R (Cmd+Shift+R on Mac)

3. **Check setting value:**
   ```javascript
   // In browser console:
   useUserSettingsStore().settings.useSimplifiedModInstruments
   // Should return: true
   ```

## Status of Worklet Pooling

- **Current status:** DISABLED (line 108 in song-bank.ts)
- **Reason:** Patch conflict bug causes glitchy playback
- **Future:** May be redesigned with proper multi-patch support

For now, ModInstrument is the recommended approach for MOD files.

## If ModInstrument Doesn't Work

If you encounter issues with ModInstrument:
1. Report the specific issue
2. Fallback: Disable pooling AND disable simplified MOD instruments
3. This uses one InstrumentV2 per instrument (works but uses more resources)

But ModInstrument should work perfectly for MOD files - it's what it was designed for!
