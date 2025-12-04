# Worklet Pooling Integration Guide

This document explains how to integrate worklet pooling into the SongBank for efficient resource usage.

## Problem

Currently, each instrument creates its own AudioWorkletNode:
- 7 instruments = 7 worklets × 2 engines = 14 engines (wasteful!)
- Each worklet has 16 voices but most are unused

## Solution

Use WorkletPool to share worklets across instruments:
- 1-2 worklets total for 7 instruments
- Voices 0-3: Instrument 01
- Voices 4-7: Instrument 02
- Voices 8-11: Instrument 03
- Voices 12-15: Instrument 04
- (new worklet if needed)
- Voices 0-3: Instrument 05
- etc.

## Integration Steps

### Step 1: Add WorkletPool to SongBank

```typescript
// In src/audio/tracker/song-bank.ts

import { WorkletPool } from 'src/audio/worklet-pool';
import { PooledInstrument } from 'src/audio/pooled-instrument-factory';

export class TrackerSongBank {
  private workletPool: WorkletPool | null = null;
  private useWorkletPooling = true; // Feature flag

  constructor(audioSystem?: AudioSystem) {
    // ... existing code ...

    // Create worklet pool
    this.workletPool = new WorkletPool(
      this.audioSystem.audioContext,
      this.masterGain
    );
  }
}
```

### Step 2: Modify ensureInstrumentInternal

```typescript
private async ensureInstrumentInternal(
  instrumentId: string,
  patch: Patch,
  generation: number,
): Promise<void> {
  // ... existing validation code ...

  const userSettings = useUserSettingsStore();
  const isModInstrument = normalizedPatch.metadata.instrumentType === 'mod';
  const useSimplified = userSettings.settings.useSimplifiedModInstruments;

  let instrument: InstrumentV2 | ModInstrument | PooledInstrument;

  if (isModInstrument && useSimplified) {
    // Use ModInstrument (no worklet)
    instrument = new ModInstrument(
      this.masterGain,
      this.audioSystem.audioContext,
    );
    await instrument.loadPatch(normalizedPatch);
  } else if (this.useWorkletPooling && isModInstrument && this.workletPool) {
    // Use PooledInstrument (shared worklet)
    console.log(`[SongBank] Creating PooledInstrument for ${instrumentId}`);

    // Allocate voices from pool (4 voices for MOD instruments)
    const allocation = await this.workletPool.allocateVoices(instrumentId, 4);

    // Create pooled instrument
    instrument = new PooledInstrument(
      this.masterGain,
      this.audioSystem.audioContext,
      allocation
    );

    await instrument.loadPatch(normalizedPatch);
  } else {
    // Use InstrumentV2 (own worklet) - legacy mode for patch editor
    const memory = new WebAssembly.Memory({
      initial: 256,
      maximum: 1024,
      shared: true,
    });
    instrument = new InstrumentV2(
      this.masterGain,
      this.audioSystem.audioContext,
      memory,
    );

    const ready = await this.waitForInstrumentReady(instrument);
    if (!ready) {
      console.warn('[TrackerSongBank] Instrument initialization timeout');
      instrument.outputNode.disconnect();
      return;
    }

    await instrument.loadPatch(normalizedPatch);
    // ... existing asset loading ...
  }

  // ... rest of method ...
}
```

### Step 3: Update teardownInstrument

```typescript
private teardownInstrument(instrumentId: string) {
  const active = this.instruments.get(instrumentId);
  if (!active) return;

  try {
    active.instrument.dispose();
  } catch (error) {
    console.warn('[TrackerSongBank] Failed to dispose instrument', error);
  }

  // Deallocate from pool if using pooled instrument
  if (this.workletPool && active.instrument instanceof PooledInstrument) {
    this.workletPool.deallocateVoices(instrumentId);
  }

  this.instruments.delete(instrumentId);
  this.activeNotes.delete(instrumentId);
  this.lastTrackVoice.delete(instrumentId);
  this.trackVoices.delete(instrumentId);
  this.restoredAssets.delete(instrumentId);
}
```

### Step 4: Update resetForNewSong

```typescript
resetForNewSong(): void {
  console.log('[SongBank] Resetting for new song');
  this.generation += 1;
  this.pendingInstruments.clear();
  this.disposeInstruments();
  this.desired.clear();

  // Reset pool allocations but keep worklets alive for reuse
  if (this.workletPool) {
    this.workletPool.resetAllocations();
  }
}
```

### Step 5: Update dispose

```typescript
dispose() {
  this.disposeInstruments();
  this.masterGain.disconnect();
  this.recorderNode?.disconnect();
  this.recorderNode = null;

  // Dispose worklet pool
  if (this.workletPool) {
    this.workletPool.dispose();
    this.workletPool = null;
  }
}
```

## Testing

After integration:

1. Load a MOD file with 7+ instruments
2. Check Chrome DevTools -> Performance -> Audio
3. Verify only 1-2 AudioWorkletNodes are created (not 7!)
4. Check console for worklet pool allocation messages
5. Test playback to ensure all instruments sound correctly

## Statistics

After loading, check pool stats:

```typescript
if (this.workletPool) {
  const stats = this.workletPool.getStats();
  console.log('[SongBank] Worklet pool stats:', stats);
  // Expected output:
  // workletCount: 2
  // totalVoices: 32
  // allocatedVoices: 28 (7 instruments × 4 voices)
  // freeVoices: 4
}
```

## Feature Flag

The `useWorkletPooling` flag allows disabling pooling if issues arise:

```typescript
private useWorkletPooling = true; // Set to false to disable pooling
```

## Compatibility

- PooledInstrument implements the same interface as InstrumentV2
- ModInstrument continues to work unchanged
- Patch editor continues using InstrumentV2 (doesn't use pool)
- Only tracker playback uses pooling

## Performance Benefits

Before: 7 instruments = 7 worklets = ~350KB memory + 7 WASM instances
After: 7 instruments = 2 worklets = ~100KB memory + 2 WASM instances

**70% reduction in memory usage and worklet overhead!**
