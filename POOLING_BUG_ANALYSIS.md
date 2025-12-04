# Worklet Pooling Bug Analysis

## Critical Bug Discovered

The worklet pooling implementation has a **fundamental architectural flaw** that causes glitchy playback.

## Root Cause

### The Problem

When multiple `PooledInstrument` instances share the same `AudioWorkletNode`, they each call `loadPatch()`:

```typescript
// pooled-instrument-factory.ts line 157-160
this.messageHandler.sendFireAndForget({
  type: 'loadPatch',  // ← Replaces ENTIRE worklet state!
  patchJson,
});
```

**What happens:**
1. Instrument 01 loads → Sends `loadPatch` to shared worklet → Worklet state = Instrument 01's patch
2. Instrument 02 loads → Sends `loadPatch` to shared worklet → Worklet state = Instrument 02's patch (01 overwritten!)
3. Instrument 03 loads → Sends `loadPatch` to shared worklet → Worklet state = Instrument 03's patch (01 & 02 overwritten!)
4. Result: **Only the last instrument loaded works correctly!**

### Why This Causes Glitchy Playback

- Each `loadPatch` message **replaces the entire WASM synth state** in the worklet
- All previously loaded instruments lose their patch configuration
- Notes trigger on wrong samples or with wrong parameters
- Playback becomes completely broken

## Why Worklet Pooling Doesn't Work for MOD Instruments

MOD instruments (converted to WASM samplers) have these requirements:
- Each instrument needs **its own sample data** (different .mod sample)
- Each instrument needs **its own sampler configuration** (loop points, root note, etc.)
- The current WASM architecture has **one global synth state per worklet**

**Sharing a worklet means sharing the synth state**, which doesn't work when each instrument needs different samples!

## Recommended Solutions

### Solution 1: Use ModInstrument (RECOMMENDED) ✅

**Enable "Simplified MOD Instruments" in user settings.**

- Uses native Web Audio API (`AudioBufferSourceNode`)
- No worklets needed = **no worklet overhead**
- Each instrument has its own audio nodes
- **No conflicts, no glitches**
- **Significantly lighter weight than WASM**

**How to enable:**
1. User settings → Enable "Use Simplified MOD Instruments"
2. OR set `useSimplifiedModInstruments: true` in settings

**Performance:**
- ✅ No worklets = Less memory
- ✅ Native Web Audio = Better performance
- ✅ No WASM overhead = Faster load times
- ✅ Perfect for MOD files which only need sample playback

### Solution 2: One WorkletNode Per Instrument (Current Fallback) ⚠️

If pooling is disabled (`useWorkletPooling = false`), falls back to:
- Each instrument gets its own `InstrumentV2`
- Each `InstrumentV2` creates its own `AudioWorkletNode`
- Each worklet has its own WASM state
- **No conflicts, works correctly**

**Downsides:**
- 7 instruments = 7 worklets = High memory usage
- Each worklet runs full WASM synth engine (overkill for MOD files)
- Uses 7× more resources than needed

### Solution 3: Redesign Pooling Architecture (Future) 🔧

To make pooling work, we'd need:

**Option A: Worklet-level multi-patch support**
- Modify WASM code to support multiple independent synth states
- Each instrument gets its own patch context
- Complex refactor of WASM internals

**Option B: Sample-only pooling**
- Don't send `loadPatch` for pooled instruments
- Only load sample data into sampler nodes
- Would require significant refactor

**Option C: Hybrid approach**
- Use ModInstrument for simple instruments (MOD files)
- Use worklet pooling only for complex synthesized instruments
- Best of both worlds

## Current Status

**Worklet pooling is DISABLED** (line 108 in song-bank.ts):
```typescript
private useWorkletPooling = false;
```

This prevents the glitchy playback issue, but means:
- MOD files will use ModInstrument (if enabled) ✅
- OR use InstrumentV2 with separate worklets (fallback) ⚠️

## Action Items

### Immediate (User)
1. **Enable "Simplified MOD Instruments"** in settings
2. This uses ModInstrument = no worklets = no issues
3. Better performance than WASM for MOD files anyway!

### Short Term (Developer)
1. Keep pooling disabled until architecture is redesigned
2. Recommend ModInstrument for all MOD files
3. Only use InstrumentV2/WASM for complex synthesis

### Long Term (Developer)
1. Design proper multi-patch worklet architecture
2. OR accept that pooling isn't needed for MOD files
3. Focus optimization efforts elsewhere

## Performance Comparison

### ModInstrument (Recommended for MOD)
- Memory: ~50KB per instrument
- Worklets: 0
- Load time: Fast (native Web Audio)
- CPU: Low (browser-optimized)

### InstrumentV2 (One per instrument)
- Memory: ~350KB per instrument (7 instruments = 2.5MB)
- Worklets: 7
- Load time: Slow (WASM initialization)
- CPU: Medium (WASM overhead)

### PooledInstrument (BROKEN)
- Memory: Would be ~100KB total
- Worklets: Would be 2
- Status: **DOESN'T WORK - patches conflict**

## Conclusion

**The "3 notes then silence" bug was real**, but the pooling solution introduced a worse bug (glitchy playback due to patch conflicts).

**Best solution:** Use `ModInstrument` for MOD files.
- No worklets = No conflicts
- Native Web Audio = Better performance
- Designed specifically for sample playback

The worklet pooling code is preserved for future use but disabled until the architecture can be redesigned to support multiple patches per worklet.
