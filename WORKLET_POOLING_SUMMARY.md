# Worklet Pooling: Complete Design Summary

## Problem Statement

**Current Issue:** Each instrument creates its own AudioWorkletNode
- Song with 7 MOD instruments → **7 worklets** × 2 engines = 14 engines (should be 2!)
- Each worklet → **16 voices** but MOD instruments only use **4 voices** each
- **Massive resource waste:** 7 WASM instances, 7 worklet threads, ~350KB memory overhead

**Your symptom:** "I press 3 notes and hold them, on the third note the sound goes away"
- Not a routing issue - it's **7 separate instruments fighting for resources**
- Each instrument thinks it owns the full 16-voice range
- Voice allocation conflicts cause notes to steal from each other

## Solution Architecture

### Component 1: WorkletPool (`src/audio/worklet-pool.ts`)

**Purpose:** Centralized management of shared AudioWorkletNodes

**Key Features:**
- Creates worklets on-demand when pool is full
- Allocates voice ranges to instruments (e.g., "Instrument 01 gets voices 0-3")
- Tracks allocations per worklet
- Supports deallocation and compaction
- Provides statistics for monitoring

**API:**
```typescript
class WorkletPool {
  // Allocate voices for an instrument
  async allocateVoices(instrumentId: string, voiceCount: number): Promise<VoiceAllocation>

  // Release voices when instrument is disposed
  deallocateVoices(instrumentId: string): void

  // Get current allocation for an instrument
  getAllocation(instrumentId: string): VoiceAllocation | undefined

  // Statistics
  getStats(): {
    workletCount: number;
    totalVoices: number;
    allocatedVoices: number;
    freeVoices: number;
    allocations: Array<{...}>;
  }

  // Cleanup
  dispose(): void
  resetAllocations(): void
  compact(): void
}
```

**Allocation Example:**
```
Song with 7 MOD instruments (4 voices each):

Worklet 0 (16 voices):
├─ Instrument "01": voices 0-3   (engine 0, voices 0-3)
├─ Instrument "02": voices 4-7   (engine 0, voices 4-7)
├─ Instrument "03": voices 8-11  (engine 1, voices 0-3)
└─ Instrument "04": voices 12-15 (engine 1, voices 4-7)

Worklet 1 (16 voices):
├─ Instrument "05": voices 0-3   (engine 0, voices 0-3)
├─ Instrument "06": voices 4-7   (engine 0, voices 4-7)
└─ Instrument "07": voices 8-11  (engine 1, voices 0-3)
```

### Component 2: PooledInstrument (`src/audio/pooled-instrument-factory.ts`)

**Purpose:** Lightweight instrument wrapper that uses shared worklets

**Key Features:**
- Implements same interface as InstrumentV2 (drop-in replacement)
- Maps local voice indices (0-3) to global worklet voice indices (e.g., 4-7)
- Manages parameter names with offset: `gate_engine0_voice4` instead of `gate_engine0_voice0`
- Doesn't own the worklet - just uses allocated voice range
- Dispose only silences voices, doesn't destroy worklet

**Voice Mapping:**
```typescript
// Instrument allocated voices 4-7 on worklet
instrument.noteOn(60, 127); // Local voice 0
  → worklet parameter: gate_engine0_voice4
     (global voice 4 = engine 0, voice 4)

instrument.noteOn(64, 127); // Local voice 1
  → worklet parameter: gate_engine0_voice5
     (global voice 5 = engine 0, voice 5)
```

### Component 3: SongBank Integration

**Modified Methods:**

1. **Constructor:** Create WorkletPool
   ```typescript
   this.workletPool = new WorkletPool(
     this.audioSystem.audioContext,
     this.masterGain
   );
   ```

2. **ensureInstrumentInternal:** Use PooledInstrument for MOD files
   ```typescript
   if (this.useWorkletPooling && isModInstrument && this.workletPool) {
     const allocation = await this.workletPool.allocateVoices(instrumentId, 4);
     instrument = new PooledInstrument(destination, audioContext, allocation);
   }
   ```

3. **teardownInstrument:** Deallocate from pool
   ```typescript
   if (this.workletPool && active.instrument instanceof PooledInstrument) {
     this.workletPool.deallocateVoices(instrumentId);
   }
   ```

4. **resetForNewSong:** Reset allocations but keep worklets
   ```typescript
   this.workletPool?.resetAllocations();
   ```

5. **dispose:** Dispose pool
   ```typescript
   this.workletPool?.dispose();
   ```

## Implementation Files

### Created Files:
1. ✅ `src/audio/worklet-pool.ts` - WorkletPool class
2. ✅ `src/audio/pooled-instrument-factory.ts` - PooledInstrument class
3. ✅ `src/audio/instrument-v2-pooled.ts` - Alternative approach (not used, kept for reference)
4. ✅ `WORKLET_POOLING.md` - Integration guide
5. ✅ `WORKLET_POOLING_SUMMARY.md` - This file

### Modified Files (integration required):
1. ⏳ `src/audio/tracker/song-bank.ts` - Add WorkletPool integration
   - Import WorkletPool and PooledInstrument
   - Add workletPool field
   - Modify ensureInstrumentInternal
   - Modify teardownInstrument
   - Modify resetForNewSong
   - Modify dispose

## Testing Checklist

### Phase 1: Verification
- [ ] Rebuild worklets: `npm run build:worklets`
- [ ] Hard refresh browser (Ctrl+Shift+R)
- [ ] Load a MOD file with 7+ instruments
- [ ] Open Chrome DevTools → Performance → Audio
- [ ] Verify **2 worklets** created (not 7)

### Phase 2: Functional Testing
- [ ] Play song - all instruments audible
- [ ] Test note triggering - no disappearing notes
- [ ] Test mute/solo - works correctly
- [ ] Test pattern switching - no glitches
- [ ] Load different MOD file - pool reallocates correctly
- [ ] Load new song - pool resets without leaks

### Phase 3: Statistics
- [ ] Check console for pool stats after loading:
  ```
  [SongBank] Worklet pool stats: {
    workletCount: 2,
    totalVoices: 32,
    allocatedVoices: 28,  // 7 instruments × 4 voices
    freeVoices: 4
  }
  ```

### Phase 4: Edge Cases
- [ ] Load song with 1 instrument - 1 worklet
- [ ] Load song with 20 instruments - scales to multiple worklets
- [ ] Rapidly switch songs - no worklet leaks
- [ ] Stop/dispose - clean shutdown

## Performance Benefits

### Before (Current):
```
7 instruments:
  - 7 AudioWorkletNodes
  - 7 WASM instances (~50KB each = 350KB)
  - 14 engines (7 worklets × 2)
  - 112 voices (7 worklets × 16) - but only 28 used!
  - 7 MessagePorts
  - High memory overhead
```

### After (With Pooling):
```
7 instruments:
  - 2 AudioWorkletNodes (saves 5 worklets!)
  - 2 WASM instances (~50KB each = 100KB) (saves 250KB!)
  - 4 engines (2 worklets × 2)
  - 32 voices (2 worklets × 16) - 28 used, 4 free
  - 2 MessagePorts (saves 5 ports)
  - ~70% memory reduction
```

### Resource Savings:
- **Memory:** 350KB → 100KB (71% reduction)
- **Worklet threads:** 7 → 2 (71% reduction)
- **WASM instances:** 7 → 2 (71% reduction)
- **Engines:** 14 → 4 (71% reduction)

## Compatibility Matrix

| Component | Uses Pooling? | Notes |
|-----------|--------------|-------|
| Tracker playback (MOD) | ✅ Yes | PooledInstrument |
| Tracker playback (non-MOD) | ❌ No | InstrumentV2 (optional) |
| Patch editor | ❌ No | InstrumentV2 (own worklet) |
| ModInstrument mode | N/A | No worklet at all |

## Feature Flags

```typescript
// In SongBank constructor
private useWorkletPooling = true; // Enable/disable pooling

// In user settings (future)
useSimplifiedModInstruments: false // Force ModInstrument (no WASM)
useWorkletPooling: true            // Enable shared worklets
```

## Migration Path

### Step 1: Create pooling infrastructure ✅
- WorkletPool class
- PooledInstrument class

### Step 2: Integrate into SongBank ⏳
- Add pool initialization
- Modify instrument creation
- Update cleanup logic

### Step 3: Testing & Validation ⏳
- Unit tests
- Integration tests
- Performance profiling

### Step 4: Production Deployment
- Feature flag enabled by default
- Monitor for issues
- Fallback to legacy mode if needed

## Debugging

### Enable Pool Logging:
All pool operations log to console:
```
[WorkletPool] Creating new worklet 0 for 01
[WorkletPool] Allocated 4 voices for 01 on new worklet 0: voices 0-3
[PooledInstrument] Created with 4 voices (global indices 0-3)
[WorkletPool] Allocated 4 voices for 02 on worklet 0: voices 4-7 (8 free remaining)
```

### Common Issues:

1. **"No gate param for voice X"**
   - Worklet not rebuilt after config change
   - Fix: `npm run build:worklets` + hard refresh

2. **"Notes disappearing"**
   - Voice allocation conflict (current issue)
   - Fix: Enable worklet pooling

3. **"All instruments silent"**
   - Pool not created or allocation failed
   - Check: `this.workletPool !== null`

4. **"Wrong voice playing"**
   - Voice offset not applied correctly
   - Check: PooledInstrument.localToGlobal() mapping

## Next Steps

1. **Integrate into SongBank** (see `WORKLET_POOLING.md`)
2. **Test with problematic MOD files**
3. **Monitor pool statistics**
4. **Verify resource usage in DevTools**
5. **Enable by default once stable**

## Questions?

- Worklet pool stats: `songBank.workletPool.getStats()`
- Voice allocation: `songBank.workletPool.getAllocation(instrumentId)`
- Disable pooling: `songBank.useWorkletPooling = false`
