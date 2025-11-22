-- when you make new key discoveries or important insights, append that knowledge to this file

# Agent Notes for `another_synth`

This file captures key context discovered while debugging patch loading, envelopes, and the audio graph in the Rust/WASM engine. Future agents should follow these guidelines when touching related code.

## Project Overview

- Core DSP lives in `rust-wasm/` (crate name `audio_processor`), compiled for both:
  - **WASM**: used by the browser audio worklet (`src/audio/worklets/synth-worklet.ts`).
  - **Native host**: used by the demo binary (`rust-wasm/src/bin/native_demo.rs`, feature `native-host`).
- The high-level UI / patch editor is in TypeScript under `src/audio/**` and uses a worklet + WASM module exported from `rust-wasm/pkg/audio_processor.js`.

## Audio Graph & Global Nodes

- The runtime graph is `rust-wasm/src/graph/graph.rs` (`AudioGraph`).
- `AudioGraph::new(buffer_size)` **always** creates three global nodes for each voice:
  - `GlobalVelocityNode` (velocity shaping, has `AudioOutput0`, `GlobalGate` input).
  - `GlobalFrequencyNode` (frequency + detune, outputs `GlobalFrequency`).
  - `GateMixer` (gate combinator, inputs `GlobalGate` + `ArpGate`, outputs `CombinedGate`).
- `AudioGraph::add_node_with_id` automatically adds “system” connections if a new node exposes these ports:
  - If the node has `PortId::GlobalFrequency`, it is auto‑connected from the global frequency node’s `GlobalFrequency` output.
  - If the node has `PortId::CombinedGate`, it is auto‑connected from the global gate mixer (`GateMixer`) `CombinedGate` output.
- `Voice` objects in `rust-wasm/src/voice.rs` own an `AudioGraph` and track:
  - `global_frequency_node`, `global_velocity_node`, `global_gatemixer_node` IDs in the graph.
  - `output_node` used by `AudioGraph` to choose which node feeds the final left/right outputs.

## Gate / Envelope Wiring (very important)

- The **gate path** at runtime is:
  1. Host / worklet sets a per‑voice scalar gate value.
  2. `Voice::process_audio` calls:
     - `graph.set_gate(&[current_gate])` → fills the global gate buffer (`gate_buffer_idx`) with the gate value.
     - `graph.set_frequency` / `set_velocity` for pitch and velocity.
  3. `GateMixer` reads:
     - `PortId::GlobalGate` from the global gate buffer.
     - `PortId::ArpGate` from the arpeggiator if present.
     - Outputs `PortId::CombinedGate` = `GlobalGate * ArpGate`.
  4. Any node with a `PortId::CombinedGate` **input** (notably `Envelope`, `Glide`, some LFOs) will be auto‑wired from `GateMixer` as described above.
- `Envelope` (`rust-wasm/src/nodes/envelope.rs`):
  - Exposes ports: `CombinedGate` (input), `AttackMod` (input), `AudioOutput0` (output).
  - Uses `CombinedGate` to drive its internal `trigger(gate_on: bool)` logic.
  - Tracks gate edges (`last_gate_value`) to enter `Attack` on rising edge and `Release` on falling edge.
  - If `CombinedGate` is not connected, or always zero, envelopes will appear “stuck” and not react to gate off.

When debugging “envelope not reacting to gate off” after any change, always verify:

- `GateMixer` exists and is connected:
  - It should be created either by `AudioGraph::new` (on fresh graphs) **or** as a `gatemixer` node created from a patch.
- There is at least one connection from `GateMixer` to `Envelope` for `PortId::CombinedGate`:
  - Either auto‑connected by `AudioGraph::add_node_with_id`, or explicitly present in the patch layout with `target: 26` (CombinedGate).
- Host gate pulses (TS `instrument-v2.ts`) now retrigger stolen mono voices by sending a brief gate-off/on, but this is **suppressed when Glide/portamento is active (active && time > 0)** to preserve slides. Glide state is cached from patch `glides` and `updateGlideState`; if mono envelopes stop retriggering, check that no glide is marked active.
- Those mono retrigger pulses need to last at least one audio quantum. A 1ms pulse was too short and occasionally got quantized away because the automation adapter only samples the first frame value; use ~5ms (>= quantumFrames/sampleRate) so the next block sees gate=0 and envelopes retrigger reliably when voiceLimit=1.
- Worklet now broadcasts its `blockSize` (derived from the output buffer length) and InstrumentV2 tracks it per-session; the gate pulse uses this `quantumFrames` so custom/native block sizes can still guarantee a full-frame gate-low. If block size changes mid-run, the broadcast updates and pulses adapt automatically.

## Patch Format & Loader

### Rust patch types

- `rust-wasm/src/audio_engine/patch.rs` defines:
  - `PatchFile` → top‑level patch: `metadata`, `synth_state`, and `audio_assets`.
  - `SynthState` → engine state including:
    - `layout: Layout` with per‑voice `VoiceLayout` (nodes + connections).
    - Per‑node state maps (`oscillators`, `wavetable_oscillators`, `envelopes`, `lfos`, etc.).
  - `VoiceLayout`:
    - `nodes: HashMap<String, Vec<PatchNode>>` keyed by node type (e.g. `"oscillator"`, `"gatemixer"`, `"envelope"`).
    - `connections: Vec<PatchConnection>` describing modulation/audio connections.
  - `PatchConnection`:
    - `from_id`, `to_id` (UUID strings).
    - `target` (u32 port ID, must match `PortId::from_u32` mapping).
    - `amount`, `modulation_type` (i32), `modulation_transform` (i32).

### Shared patch loader helpers

- `rust-wasm/src/audio_engine/patch_loader.rs` provides helpers:
  - `parse_node_id(&str) -> NodeId` (UUID parsing).
  - `port_id_from_u32`, `modulation_type_from_i32`, `modulation_transform_from_i32`.
  - `NODE_CREATION_ORDER`: canonical order for creating nodes from a patch:
    - `"global_frequency"`, `"global_velocity"`, `"gatemixer"`, `"mixer"`, `"filter"`, `"oscillator"`, `"wavetable_oscillator"`, `"sampler"`, `"envelope"`, `"lfo"`, `"noise"`, `"arpeggiator_generator"`.
  - `patch_connection_to_connection` mirrors the translation from `PatchConnection` to `graph::Connection`.
  - These conversion helpers now return `PatchLoaderResult<T>` and are consumed by the WASM loader; keep new patch-related conversions centralized here so both WASM and native stay aligned on validation logic.

### WASM engine: patch loading

- File: `rust-wasm/src/audio_engine/wasm.rs`.
- Key steps in `AudioEngine::init_with_patch` (WASM/exported as `initWithPatch`):
  1. Deserialize `PatchFile` with **detailed serde-path-to-error logging** for debugging.
  2. Replace voices with `Voice::new(id, block_size)` and `clear()` their graphs.
  3. Reset `global_frequency_node`, `global_velocity_node`, `global_gatemixer_node` to `None` on each voice.
  4. Rebuild nodes from the canonical voice (`layout.voices[0]`) via `build_nodes_from_canonical_voice`:
     - Uses `NODE_CREATION_ORDER`.
     - Instantiates each node type and records global node IDs per voice (`global_frequency_node`, `global_velocity_node`, `global_gatemixer_node`).
  5. `connect_from_canonical_voice`:
     - For each `PatchConnection` in the canonical voice:
       - `to_port` = `port_id_from_u32(connection.target)?` (errors if unknown).
       - `modulation_type` and `modulation_transform` mapped from i32.
       - Determines `from_port` by inspecting the source node’s `get_ports()` in voice 0:
         - Picks the first port with `is_output = true`, or defaults to `PortId::AudioOutput0`.
       - Calls `connect_nodes` with the computed ports and modulation config.
  6. Applies per‑node state (`update_oscillator`, `update_wavetable_oscillator`, `update_envelope`, etc.).
  7. Imports `audio_assets` (sampler samples, convolver IRs, wavetables).

### Native engine: patch loading (bug fixed)

- File: `rust-wasm/src/audio_engine/native.rs`.
- API: `AudioEngine::init_with_patch(&mut self, patch_json: &str) -> Result<usize, String>`.
- Flow mirrors the WASM implementation:
  1. Parse `PatchFile` via `serde_json::from_str`.
  2. Rebuild `self.voices` (`Voice::new`).
  3. For each voice, `voice.clear()` and reset `global_*` node IDs to `None`.
  4. Rebuild nodes with `build_nodes_from_canonical_voice`.
  5. Wire connections with `connect_from_canonical_voice`.
  6. Apply per‑node state via `apply_patch_states`.

**Important native bug (fixed):**

- The original `build_nodes_from_canonical_voice` used:

  ```rust
  for voice in &mut self.voices {
      let node = self.create_node_from_type(node_type, &id)?;
      voice.graph.add_node_with_id(id, node);
      // ...
  }
  ```

  This mixed a mutable borrow of `self.voices` with an immutable borrow of `self` (`self.create_node_from_type`), leading to borrow conflicts and preventing the native patch path from building graphs correctly.

- The fixed version uses index‑based access to avoid aliasing:

  ```rust
  for voice_index in 0..self.voices.len() {
      let node = self.create_node_from_type(node_type, &id)?;
      {
          let voice = &mut self.voices[voice_index];
          voice.graph.add_node_with_id(id, node);
          // update global_* IDs and output node per voice
      }
  }
  ```

If you change native patch logic, make sure WASM and native stay structurally aligned, and avoid any borrow patterns that mix `&mut self.voices` with other `&self` calls in the same loop.

## Frontend Patch / Connection Flow

- Patches on the JS side use `src/audio/types/preset-types.ts` (`Patch`, `SynthState`, etc.) and `src/audio/types/synth-layout.ts` (`SynthLayout`, `VoiceLayout`, `NodeConnection`).
- Serialization:
  - `src/audio/serialization/patch-serializer.ts` converts the live `SynthLayout` + state maps into a `Patch`.
  - When sending a patch to the worklet, `Instrument.loadPatch`:
    - Deep‑clones the patch to strip Vue reactivity.
    - Sets `audioAssets` to `{}` (assets are restored separately).
    - Validates JSON (no `undefined`, no NaN/Infinity) and posts `{ type: 'loadPatch', patchJson }` to the worklet.
- In the worklet (`src/audio/worklets/synth-worklet.ts`):
  - `handleLoadPatch` calls `audioEngine.initWithPatch(patchJson)` (WASM function).
  - Then calls `initializeVoices()` which:
    - Calls `audioEngine.get_current_state()` (WASM), producing `EngineState` with nodes + connections for voice 0.
    - Converts this into the UI `SynthLayout` (`voiceLayouts`) that the store uses.

### Connection updates (modulation routing)

- UI route editing uses:
  - `src/audio/modulation-route-manager.ts` to compute available targets/ports.
  - It calls `store.updateConnection(NodeConnectionUpdate)` with:
    - `fromId`, `toId`, `target` (`PortId`), `amount`, optional `modulationType`, `modulationTransformation`, and `isRemoving`.
- `audio-system-store.ts`:
  - Queues connection updates and eventually calls `currentInstrument.updateConnection(plainConnection)`.
- `Instrument.updateConnection`:
  - Sends `{ type: 'updateConnection', connection }` to the worklet.
- Worklet’s `handleUpdateConnection`:
  - If `isRemoving`, calls `audioEngine.remove_specific_connection(fromId, toId, targetPort)`.
  - Otherwise:
    1. Calls `remove_specific_connection` to clear any existing connection for that `(from, to, targetPort)` triple.
    2. Calls `audioEngine.connect_nodes(fromId, PortId.AudioOutput0, toId, targetPort, amount, modulationType, modulationTransform)`.
    3. Requests a state sync so the UI sees the new connections.

This means the **port ID in the patch (`target`) is authoritative** for where the envelope or other node is driven.

## Testing & Debugging Tips

- Real patch example for reference: `rust-wasm/tests/real_patch.json`.
  - Useful to see how connections are encoded, including:
    - GlobalFrequency → various nodes (`target: 9` = `PortId::GlobalFrequency`).
    - GateMixer → Envelope (`target: 26` = `PortId::CombinedGate`).
    - Envelope → Mixer gain (`target: 17` = `PortId::GainMod`).
- Serialization tests live in `rust-wasm/src/audio_engine/patch_serialization_spec.rs`:
  - `serialize_graph_to_patch` turns an `AudioGraph` into a `PatchFile`.
  - `apply_patch_to_graph` reconstructs a graph from a `PatchFile`.
  - `test_patch_serialization_roundtrip` ensures layout + connections survive a roundtrip.
  - `test_apply_patch_after_deserialization` validates that node IDs from the original graph map correctly in a newly initialized engine.
- When debugging patches:
  - On WASM: use the detailed logging in `AudioEngine::init_with_patch` for serde errors and sampler connections.
  - On native: `init_with_patch` uses the same `PatchFile` structs; prefer aligning changes with the WASM implementation.

### New discovery: graph clearing and gate buffer aliasing

- `AudioGraph::clear` must **not** reset the entire `AudioBufferPool` with `release_all()` while voices/macros are alive.
  - Doing so made the dedicated `gate_buffer_idx` and macro buffers “available” again, so subsequent `add_node_with_id` calls could re-use those indices for node ports.
  - This caused `graph.set_gate` to write into a buffer that was then immediately cleared at the start of `process_audio_with_macros`, effectively zeroing the global gate signal and leaving envelopes/mixer gain at 0 (silence) after a patch load.
- The fix is to have `AudioGraph::clear`:
  - Explicitly `release` only node-owned and temp buffers (`node_buffers`, `temp_buffer_indices`).
  - Leave `gate_buffer_idx` and macro buffers untouched so they remain dedicated.
  - Clear graph structures (`nodes`, `connections`, `input_connections`, `processing_order`, `node_buffers`, `temp_buffer_indices`) and reset `global_*` and `output_node` to `None`.
- When debugging “sound disappears after calling `initWithPatch` / applying a patch”, check that:
  - `AudioGraph::clear` has this selective buffer release behavior.
  - `gate_buffer_idx` is **not** present in `node_buffers` and remains stable across patch reloads.
  - Voices’ `output_node` still points at the mixer rebuilt from the canonical voice.

## Wavetable Missing Data Panic (Critical Fix - 2025)

**Problem**: The synth would crash with "RuntimeError: unreachable" panic when loading patches with wavetable oscillators.

**Root Cause**:
- When a patch is loaded via `loadPatch`, wavetable oscillator nodes are created immediately
- Audio processing starts before `restoreAudioAssets` imports the wavetable data
- The wavetable oscillator's `process()` method tried to access a non-existent wavetable collection
- Original code: `bank_ref.get_collection(&self.collection_name).unwrap_or_else(|| panic!("Missing..."))`
- Result: panic during audio processing

**Fix**: The wavetable oscillator now gracefully handles missing wavetables by outputting silence until the data is loaded:

```rust
// Gracefully handle missing wavetable (output silence until it's loaded)
let collection = {
    let bank_ref = self.wavetable_bank.borrow();
    match bank_ref.get_collection(&self.collection_name) {
        Some(coll) => coll.clone(),
        None => {
            // Wavetable not loaded yet - output silence
            if let Some(buf) = outputs.get_mut(&PortId::AudioOutput0) {
                buf[..buffer_size].fill(0.0);
            }
            if let Some(buf) = outputs.get_mut(&PortId::AudioOutput1) {
                buf[..buffer_size].fill(0.0);
            }
            return;
        }
    }
};
```

**Files affected**:
- `rust-wasm/src/nodes/wavetable_oscillator.rs:617-628`

**Important**: This is a race condition between patch loading and asset restoration. The oscillator must handle the case where it exists but has no data yet.

## Automation Adapter & Voice Count (Critical Fix - 2025)

**Problem**: The synth would crash with "table index is out of bounds" errors when switching patches or performing paste operations.

**Root Cause**:
- Web Audio API `parameterDescriptors` are **statically defined with 8 voices** in `synth-worklet.ts`
- When loading patches with fewer voices, the `AutomationAdapter` was being created with the patch's voice count
- The parameters object always contains data for all 8 voices, but the automation frame had fewer voice slots
- Result: out-of-bounds access when Rust tried to populate the frame from all parameter slots

**Fix**: The `AutomationAdapter` must **always** be created with 8 voices to match the static parameter descriptors, regardless of the actual patch voice count:

```typescript
// CORRECT: Always use 8 voices
this.automationAdapter = new AutomationAdapter(
  8, // Fixed to match parameter descriptors
  this.macroCount,
  this.macroBufferSize,
);

// WRONG: Using patch voice count causes crashes
this.automationAdapter = new AutomationAdapter(
  this.numVoices, // DON'T DO THIS
  this.macroCount,
  this.macroBufferSize,
);
```

**Files affected**:
- `synth-worklet.ts:489` - `handleLoadPatch` method
- `synth-worklet.ts:1361` - `process` method fallback initialization

**Important**: When debugging audio processing crashes, always check that the automation adapter dimensions match the parameter descriptor definitions.

## CPU Usage Sampling & Borrow Conflicts

**Issue**: "recursive use of an object" errors during CPU usage sampling.

**Cause**: The `get_cpu_usage()` method can be called via message handler while `process_with_frame()` is running, causing RefCell borrow conflicts in Rust.

**Fix**: CPU usage handler now silently skips sampling when conflicts occur (this is expected and not an error). The handler also checks `!this.ready` to avoid sampling during initialization.

## General Guidance for Future Changes

- Keep **WASM and native** implementations of patch logic, node creation, and connection wiring as parallel as possible.
- Be careful when:
  - Changing `PortId` enum values; they must remain aligned between Rust, the JS bindings, and the TS enums.
  - Adding new node types: update `NODE_CREATION_ORDER`, `get_current_state` serialization, and TS `VoiceNodeType`.
  - Touching envelope or gate logic: verify `CombinedGate` wiring and gate thresholds (`> 0.0`) still make sense.
  - **Modifying parameter descriptors**: If you change the number of voices or parameters, ensure the `AutomationAdapter` is always created with matching dimensions.
- Before assuming an envelope bug, check:
  - Is the envelope's `config.active` flag true?
  - Is there a `GateMixer` node and a `CombinedGate` connection into the envelope?
  - Does the patch layout for voice 0 contain the expected `gatemixer → envelope` connection with `target: 26`?
- Host builds that enable the `wasm` feature still compile the crate for non-`wasm32` targets, so `audio_engine::mod` now exposes stub `WasmNoiseType`/`WasmModulationType` enums for that configuration. Keep those shims so `automation.rs` and other shared modules continue to compile in host toolchains.
- TS Store canonical voice syncing:
  - Because patch serialization now only writes `canonicalVoice` plus a `voiceCount`, the UI must keep the canonical copy in sync with live edits. `src/stores/audio-system-store.ts` now calls `syncCanonicalVoiceWithFirstVoice()` after each connection update so the first voice and `canonicalVoice` stay identical.
  - Without this, saving/loading would resurrect deleted routes or drop new connections, leading to silent voices after a patch switch. If you add other layout mutations (node creation, delete, drag reorder), ensure they also refresh the canonical voice before serializing.
- Worklet layout sync only returns a single voice:
  - `get_current_state` / `getNodeLayout` currently emit a single canonical voice. When the store ingests that layout it MUST preserve the previous `voiceCount` and explicitly clone the canonical voice across all voices; otherwise any sync (like after deleting a node) would reset `voiceCount` to `1` and future patches would instantiate only one voice.
  - See `updateSynthLayout` in `audio-system-store.ts` for the logic that uses the existing `voiceCount` fallback and regenerates the per-voice array. Keep this in mind if the worklet ever starts reporting multiple voices or a `voiceCount` field.
  - In addition to copying the canonical voice, `updateSynthLayout` now falls back to the instrument's configured `num_voices` when `voiceCount` isn't present yet (the first patch load). Without this fallback, patch serialization would embed `voiceCount = 1` and the Rust engine would only rebuild a single voice after deleting nodes and reloading a patch, making the synth sound monophonic.
- Deleting nodes exposes rough edges in the multi-voice flow:
  - `AudioGraph::delete_node` drops the node and related connections in every voice, but it does **not** rewire the per-voice output node. If the mixer/output node is deleted, all voices go silent until another node becomes the graph output. Don’t allow deleting the mixer or plan to promote another node to `output_node`.
  - Because `voiceLayouts` in the worklet are cloned from a single canonical layout, UI state (node names, IDs) is mirrored across voices. Deleting a node from voice 0 and swapping patches relies on `removeNodeFromLayout` + `syncCanonicalVoiceWithFirstVoice` to update `canonicalVoice`; any omission there will resurrect the deleted node on the next load. Whenever you add new layout mutations (node creation, drag/drop ordering, batch deletes), make sure they also call `syncCanonicalVoiceWithFirstVoice` so patch serialization remains authoritative.

## New discovery: Patch layout now canonical + voice count

- `rust-wasm/src/audio_engine/patch.rs` `Layout` carries `voiceCount` + `canonicalVoice` plus helper methods (`resolved_voice_count`, `canonical_voice`) so loaders no longer inspect `voices.len()`. Always use those helpers so both native + wasm stay aligned.
- TypeScript patch serialization now converts runtime layouts into `{ voiceCount, canonicalVoice }` via `synthLayoutToPatchLayout` and expands them back with `patchLayoutToSynthLayout`. The UI `SynthLayout` still keeps a per-voice array for editing, but patches only persist the canonical voice to avoid duplication.
- Frontend store (`audio-system-store`) keeps `voiceCount` + `canonicalVoice` copies in `this.synthLayout` so saving patches preserves the configured polyphony even though only one voice layout is serialized.

## Startup bank loading

- During boot the Pinia audio store now calls `loadSystemBankIfPresent()` before falling back to `initializeNewPatchSession`.
- This routine fetches `${import.meta.env.BASE_URL}system-bank.json`. If the file exists and passes `importBankFromJSON` validation, its first patch is applied immediately and `currentBank` is replaced with the parsed bank.
- Missing/empty/invalid `system-bank.json` simply returns `false`, so the existing default patch creation flow still runs and creates the baseline bank.

## Default patch template for new patches

- The store now exposes `createNewPatchFromTemplate(name)` which is used both by the "New Patch" button and by `initializeNewPatchSession`.
- When `public/default-patch.json` exists it clones that patch, assigns fresh metadata (`createDefaultPatchMetadata`), applies it to the synth, and inserts it into the current bank as the new patch.
- If the default file is missing or fails validation the method falls back to the older `prepareStateForNewPatch` + `saveCurrentPatch` path so the user still gets a blank patch rather than an error.

## Backend store migration (2025-??)

- When moving helpers/services to `layout-store`/`connection-store`, keep the legacy `useAudioSystemStore().synthLayout` updated by cloning the cache after each layout mutation. Components still read from the legacy store until Phase 4 finishes, so skipping this mirror leaves the UI blind to new connections/layout changes.
- `src/stores/legacy-store-bridge.ts` now owns the compatibility layer back to `useAudioSystemStore`. All helpers should call the cache store actions (`layoutStore.commitLayoutChange()` or `nodeStateStore.pushStatesToLegacyStore()`) instead of touching `audioSystemStore` directly so we keep a single place that clones data back into the legacy store.
- Helpers that previously called `store.updateSynthLayout` (worklet loader, sync manager) should now update `layout-store` + run `node-state-store.initializeDefaultStates()`, then mirror the resulting layout into the audio system store for backward compatibility.

## New discovery: worklet createNode message field

- `InstrumentV2` (and `WorkletMessageBuilder.createNode`) send `{ type: 'createNode', nodeType: VoiceNodeType }`, but the worklet handler previously looked at `data.node`. This mismatch produced `Missing creation case for: undefined` whenever the UI tried to create new nodes. The worklet now accepts either field (`node` or `nodeType`) and logs a clear error if both are missing.

## New discovery: Sampler detune support

- Sampler nodes now mirror oscillator detune controls. `SamplerState` carries `detune_oct`, `detune_semi`, `detune_cents`, and `detune`, and `normalizeSamplerState` in `src/audio/utils/sampler-detune.ts` keeps these fields consistent with the sampler's stored `frequency`.
- `node-state-store.buildSamplerUpdatePayload` derives the tuned base frequency from the total detune amount before calling `update_sampler`, so the WASM signature stays the same. Patch serialization/deserialization upgrades old patches by running `normalizeSamplerState`, so existing presets continue to load while new detune settings persist.

## New discovery: Effect components must read from node-state-store

- Delay, Convolver, and Reverb components now source their state from `node-state-store` instead of the legacy `audio-system-store`. When effect components write directly to the legacy mirrors, any other store (like the delay panel) that calls `pushStatesToLegacyStore()` wipes their values, causing side effects (e.g., toggling Delay enabling Reverb). Always bind effect UI state to `node-state-store`, persist via `pushStatesToLegacyStore()`, and then call the instrument update so that patches load/save consistently and UI toggles don't interfere with each other.

## New discovery: Legacy audio-system-store fully removed

- The `audio-system-store` façade, its legacy bridge, and associated tests have been deleted. Runtime audio control now flows through the focused stores (`instrument-store`, `layout-store`, `node-state-store`, `connection-store`, and `patch-store`).
- UI components should access node state exclusively via `node-state-store`, layout data from `layout-store`, and the instrument/audio context via `useInstrumentStore()`. Avoid storing mirrored maps or calling the removed legacy helpers.
- `useInstrumentStore()` owns the `AudioSystem`, `InstrumentV2`, and the `AudioSyncManager`. Boot code initializes this store before patch loading; any component that previously depended on `useAudioSystemStore` must switch to `useInstrumentStore`.
- Because there is no legacy mirroring, do not expect `pushStatesToLegacyStore` or `mirrorLayoutToLegacyStore` to exist—state updates should directly mutate the focused stores and call the instrument APIs as needed.

## New discovery: Patch categories & tree selection

- `PatchMetadata` now exposes an optional `category` string that stores a slash-delimited hierarchy (e.g. `"FM/Lead"`). Use the helpers in `src/utils/patch-category.ts` (`normalizePatchCategory`, `categorySegments`, `DEFAULT_PATCH_CATEGORY`) whenever reading or mutating categories so the store, serializer, and UI stay in sync.
- Preset selection in `PresetManager.vue` uses a `QTree` grouped by these categories and provides an inline category input. Blank categories fall back to `DEFAULT_PATCH_CATEGORY` ("Uncategorized"), so saving with an empty field intentionally clears the category and moves the patch under that bucket.

## New discovery: Saturation/drive effect in effect stack

- A soft-clip saturation effect now lives on the global effect stack (created after the compressor, ID = `EFFECT_NODE_ID_OFFSET + index`, currently `10006` by default). Default state: drive `2.0`, mix `0.5`, active `false` to avoid changing legacy patches.
- Patches serialize `saturations` alongside other effects: each entry has `{ id, drive, mix, active }`. Serde defaults make the field optional for old patches.
- TS layout/types add `VoiceNodeType.Saturation` plus `saturationStates` in `node-state-store`; `SaturationComponent` drives UI updates and patch saving, and the worklet message type `updateSaturation` forwards changes to `AudioEngine::update_saturation`.

---

# Web App Architecture Improvements (2025)

## Overview of Architectural Refactoring

The web app architecture for the WASM synth has been significantly improved to address fragility, tight coupling, and state management issues. The following sections document the new architecture patterns that should be followed going forward.

## Core Architectural Principles

1. **Single Source of Truth**: WASM engine is authoritative for all audio state
2. **Layered Architecture**: Clear separation between WASM, adapter, worklet, and UI layers
3. **Type Safety**: Comprehensive TypeScript types for all message passing
4. **Error Recovery**: All operations use Promise-based patterns with timeout handling
5. **Decoupling**: No direct WASM imports outside the adapter layer

## New Architecture Components

### 1. Typed Message Protocol (`src/audio/types/worklet-messages.ts`)

**Purpose**: Eliminates the ad-hoc message passing that was scattered across files.

**Key Features**:
- Defines all 30+ message types with full TypeScript interfaces
- `WorkletMessageBuilder` for type-safe message construction
- `WorkletMessageValidator` for runtime validation
- Supports both request/response and fire-and-forget patterns

**Usage Example**:
```typescript
import { WorkletMessageBuilder } from '@/audio/types/worklet-messages';

// Type-safe message creation
const message = WorkletMessageBuilder.updateEnvelope(
  envelopeId,
  config,
  true // withResponse
);
```

**Migration Path**:
- Replace all `workletNode.port.postMessage({ type: '...' })` with message builders
- Add message validation before sending
- Use the `WorkletMessage` union type for handlers

### 2. WASM Type Adapter (`src/audio/adapters/wasm-type-adapter.ts`)

**Purpose**: Centralizes all type conversions between Rust/WASM and TypeScript.

**Eliminates Duplicate Code**:
Previously, type conversion logic was duplicated in:
- `synth-worklet.ts` (lines 700-761)
- `audio-system-store.ts` (lines 804-835, 1106-1150)
- `synth-layout.ts` (lines 399-426)

**Key Functions**:
- `rustNodeTypeToTS()` / `tsNodeTypeToRust()` - Node type conversions
- `rustModulationTypeToTS()` / `tsModulationTypeToRust()` - Modulation enum conversions
- `normalizeConnection()` / `denormalizeConnection()` - Connection format conversions
- `validatePortId()`, `validateFiniteNumber()`, `sanitizeForWasm()` - Validation utilities

**Usage Example**:
```typescript
import { rustNodeTypeToTS, normalizeConnection } from '@/audio/adapters/wasm-type-adapter';

// Convert node types
const tsType = rustNodeTypeToTS('analog_oscillator'); // VoiceNodeType.Oscillator

// Normalize connections
const normalized = normalizeConnection(rawConnection);
```

**Important**: ALL type conversions should now go through this adapter. Do NOT add new conversion logic elsewhere.

### 3. WASM Engine Adapter (`src/audio/adapters/wasm-engine-adapter.ts`)

**Purpose**: Decouples the worklet from direct WASM imports.

**Problem Solved**: Previously, the worklet imported 10+ types directly from `audio_processor.js`, making any WASM API change require worklet changes.

**Key Features**:
- Clean, typed interface to all WASM operations
- Automatic validation of all inputs (no NaN/Infinity/undefined to WASM)
- Proper error handling and logging
- Encapsulates WASM initialization complexity
- Makes testing and mocking possible

**Architecture**:
```
Worklet → WasmEngineAdapter → WASM AudioEngine
         (clean interface)   (raw bindings)
```

**Usage Example**:
```typescript
import { WasmEngineAdapter } from '@/audio/adapters/wasm-engine-adapter';

const adapter = new WasmEngineAdapter();
const result = adapter.initialize({
  sampleRate: 44100,
  numVoices: 8,
  wasmBinary: arrayBuffer
});

if (!result.success) {
  console.error('Init failed:', result.error);
}

// Type-safe operations
adapter.updateEnvelope(envelopeId, config);
adapter.connectNodes(fromId, fromPort, toId, toPort, amount, modType, transform);
```

**Migration Path**:
- Replace all `this.audioEngine.method()` calls in the worklet with `this.engineAdapter.method()`
- Remove direct WASM imports from the worklet
- Let the adapter handle all validation and error cases

### 4. Request/Response Message Handler (`src/audio/adapters/message-handler.ts`)

**Purpose**: Replaces fire-and-forget message passing with Promise-based operations.

**Problem Solved**: Previously, most operations had no confirmation, error handling, or retry logic. This caused:
- Silent failures
- Race conditions
- No way to know when operations completed
- Difficult debugging

**Key Features**:
- **Automatic message queuing** during initialization
- **Timeout handling** (default 5s, configurable)
- **Operation tracking** with unique message IDs
- **Error recovery** with clear error messages
- **Initialization sequence** management

**Usage Example**:
```typescript
import { WorkletMessageHandler } from '@/audio/adapters/message-handler';
import { WorkletMessageBuilder } from '@/audio/types/worklet-messages';

const handler = new WorkletMessageHandler({ debug: true });
handler.attachToWorklet(workletNode);

// Promise-based operation
try {
  await handler.sendMessage(
    WorkletMessageBuilder.updateEnvelope(id, config)
  );
  console.log('Envelope updated successfully');
} catch (error) {
  console.error('Update failed:', error);
}

// Fire-and-forget for performance-critical messages
handler.sendFireAndForget(
  WorkletMessageBuilder.noteOn(60, 100)
);
```

### Message Handler & Layout Sync (2025-03)

- When attaching `WorkletMessageHandler` to the worklet port, do **not** clobber listeners that mirror layout updates into Pinia. The loader (`audio-processor-loader.ts`) must use `port.addEventListener('message', ...)` so `synthLayout`/`stateUpdated` broadcasts continue flowing even after the handler sets `port.onmessage`.
- The initial `ready` message fires before `InstrumentV2` attaches the handler, so the handler now auto-calls `markInitialized()` when it sees `initialState`, `synthLayout`, or `stateUpdated` broadcasts. Without this the handler never leaves the queued state and `waitForInstrumentReady()` times out, preventing patch loads.
- WASM message payloads are strict: `updateOscillator`/`updateWavetableOscillator` expect a `newState` field, filter updates expect `config`, and effect updates expect a `nodeId` string that may be a pseudo numeric ID (`EFFECT_NODE_ID_OFFSET + index`). Keep `InstrumentV2`, the type definitions in `worklet-messages.ts`, and any handler classes in sync with these names or the worklet will throw when it tries to read missing properties.

**Initialization Sequence**:
1. Worklet sends `ready` message
2. Handler calls `markInitialized()`
3. All queued operations are processed in order
4. New operations execute immediately

**Migration Path**:
- Replace `Instrument` class's manual promise handling with `WorkletMessageHandler`
- Update worklet to send `operationResponse` messages for mutations
- Use `sendFireAndForget()` only for MIDI/performance messages

## State Management Architecture

### Previous Issues

1. **Multiple sources of truth**:
   - Pinia store had 15+ state maps
   - `SynthLayout` duplicated node info
   - Instrument class had its own layout copy
   - WASM had internal state
   - No synchronization strategy

2. **Optimistic updates without confirmation**:
   - Store updated layout before WASM confirmed
   - Worklet sent `stateUpdated` after the change
   - Result: double updates, conflicts

3. **Massive god store**:
   - `audio-system-store.ts`: 2445 lines, 97 state properties, 85+ methods
   - Mixed concerns: patch I/O, state management, UI state, serialization, asset management

### New Architecture (Recommended)

**Principle**: WASM is the single source of truth. Store is a read-only cache.

```
┌─────────────────────────────────────────────────────┐
│                    UI Components                    │
│         (Read from store, send commands)            │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│              Pinia Store (Read-Only Cache)          │
│  - Caches WASM state for UI rendering               │
│  - Dispatches commands to Instrument                │
│  - No mutation logic                                │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│              Instrument Class (Facade)              │
│  - Uses WorkletMessageHandler                       │
│  - Returns Promises for all operations              │
│  - No state storage                                 │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│                 Audio Worklet                       │
│  - Uses WasmEngineAdapter                           │
│  - Sends operationResponse for mutations            │
│  - Sends stateUpdated broadcasts                    │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│            WASM AudioEngine (Authority)             │
│  - Single source of truth                           │
│  - All state lives here                             │
└─────────────────────────────────────────────────────┘
```

**Update Flow**:
1. UI calls `store.updateEnvelope(id, config)`
2. Store calls `instrument.updateEnvelope(id, config)` → returns Promise
3. Instrument uses message handler → sends typed message
4. Worklet receives message → calls `engineAdapter.updateEnvelope()`
5. WASM updates internal state
6. Worklet sends `operationResponse` (success/failure)
7. Promise resolves/rejects in UI
8. Worklet sends `stateUpdated` broadcast
9. Store updates cache from broadcast
10. UI reactively updates

**Benefits**:
- No race conditions (operation completes before state update)
- Clear error handling at every layer
- Store stays in sync with WASM
- No optimistic updates that can fail

## Migration Strategy

### Phase 1: Add New Adapters (✅ Complete)
- [x] Create typed message protocol
- [x] Create WASM type adapter
- [x] Create WASM engine adapter
- [x] Create message handler

### Phase 2: Update Worklet (✅ Foundation Complete, Migration In Progress)
- [x] Create `WasmEngineAdapter` with all required WASM methods
- [x] Create message handler classes (`worklet-message-handlers.ts`)
- [x] Create `WorkletHandlerRegistry` for routing messages
- [ ] Migrate worklet to use `WasmEngineAdapter` (incremental)
- [ ] Replace manual type conversions with `wasm-type-adapter` (incremental)
- [ ] Add `operationResponse` messages for all mutations (incremental)

### Phase 3: Update Instrument Class (✅ Complete)
- [x] Create InstrumentV2 with `WorkletMessageHandler` integration
- [x] Remove duplicate state storage (no more synthLayout in Instrument)
- [x] Make all mutation methods return Promises
- [x] Add comprehensive error handling with timeouts
- [x] Add compatibility methods for backward compatibility
- [x] Integrate InstrumentV2 into audio-system-store
- [x] Update audio-asset-extractor to use InstrumentV2

### Phase 4: Refactor Store (✅ COMPLETED)
- [x] Split into focused stores (PatchStore, NodeStateStore, ConnectionStore, AssetStore, LayoutStore)
- [x] Remove mutation logic (keep only cache updates)
- [x] Remove duplicate type conversions (using wasm-type-adapter)
- [x] Use typed messages everywhere
- [x] Migrate components to use focused stores

#### Refactoring Results:
**audio-system-store.ts**: Reduced from 2,442 lines to 290 lines (88% reduction)
- Removed all patch/bank management methods → `patch-store.ts`
- Removed all node state update methods → `node-state-store.ts`
- Removed all connection management methods → `connection-store.ts`
- Removed all layout manipulation methods → `layout-store.ts`
- Removed all asset management methods → `asset-store.ts`
- Kept only: core audio infrastructure, mirrored state (via bridge), and backward-compatible getters

#### Focused Store Architecture:
1. **patch-store.ts** (693 lines)
   - Patch/bank CRUD operations
   - Import/export functionality
   - Template management
   - Delegates to other stores for layout, state, and assets

2. **node-state-store.ts** (460 lines)
   - All node state caches (oscillators, filters, envelopes, LFOs, samplers, etc.)
   - State initialization and defaults
   - Applies state changes to WASM
   - Mirrors state to legacy store via bridge

3. **connection-store.ts** (147 lines)
   - Connection queue management
   - Connection update processing
   - Node deletion cleanup
   - Updates layout store after connection changes

4. **asset-store.ts** (51 lines)
   - Audio asset management (samples, impulses, wavetables)
   - Asset restoration to WASM

5. **layout-store.ts** (300 lines)
   - SynthLayout structure management
   - Node/connection CRUD operations
   - Type conversions using wasm-type-adapter
   - Mirrors layout to legacy store via bridge

6. **legacy-store-bridge.ts** (75 lines)
   - Centralized state mirroring
   - Keeps audio-system-store in sync for backward compatibility
   - No business logic, only state copying

#### Migration Pattern:
**All domain logic now follows**: Focused Store → WASM/Worklet → Cache Update via Bridge
- Domain operations live in focused stores
- WASM operations go through InstrumentV2/adapters
- Cache updates flow back through legacy-store-bridge
- Components can gradually migrate to focused stores while legacy getters provide compatibility

#### Components Updated:
- `pinia-audio-system.ts`: Uses patch-store for initialization
- `PresetManager.vue`: Uses patch-store for all patch/bank operations
- Other components: Continue using audio-system-store getters (read-only) until migrated

#### Technical Debt Resolved:
- ✅ Eliminated 2,000+ lines of duplicate code
- ✅ Centralized type conversions in wasm-type-adapter
- ✅ Clear separation of concerns
- ✅ Maintained backward compatibility
- ✅ All functionality preserved

### Phase 5: Testing & Documentation (Pending)
- [ ] Add unit tests for adapters
- [ ] Add integration tests for message flow
- [ ] Update component documentation
- [ ] Create architecture diagrams

## Best Practices for Future Development

### DO:
✅ Use `WorkletMessageBuilder` for all messages
✅ Use `WasmEngineAdapter` for all WASM operations
✅ Use `wasm-type-adapter` for all type conversions
✅ Return Promises for all async operations
✅ Validate inputs before sending to WASM
✅ Handle errors at every layer
✅ Use the message handler for operation queuing

### DON'T:
❌ Import WASM types directly outside the adapter layer
❌ Add type conversion logic outside `wasm-type-adapter.ts`
❌ Use fire-and-forget for mutations (only for performance-critical MIDI)
❌ Duplicate state across layers
❌ Update UI optimistically without confirmation
❌ Add more responsibilities to the god store

## Common Pitfalls to Avoid

1. **Breaking the adapter layer**: If you need to add a WASM method, add it to `WasmEngineAdapter` first, then use it through the adapter.

2. **Skipping validation**: Always use `validateFiniteNumber()`, `sanitizeForWasm()`, etc. before sending data to WASM. NaN/Infinity will crash WASM.

3. **Forgetting message IDs**: If you want a response, ensure the message has a `messageId`. Use `WorkletMessageBuilder` which adds them automatically.

4. **Race conditions during init**: Always check `handler.isInitialized()` or use `sendMessage()` which queues automatically.

5. **Mixing old and new patterns**: Don't use `postMessage()` directly when you have the message handler available.

## Debugging Tips

### Enable Debug Logging
```typescript
const handler = new WorkletMessageHandler({ debug: true });
```

### Check Pending Operations
```typescript
console.log('Pending:', handler.getPendingCount());
console.log('Queued:', handler.getQueuedCount());
```

### Trace Message Flow
1. Check browser console for `[MessageHandler]` logs
2. Check `[WasmEngineAdapter]` logs for WASM errors
3. Use browser DevTools to inspect `postMessage()` calls

### Common Issues

**"Operation timed out"**:
- Worklet didn't send `operationResponse`
- Check worklet message handler implementation

**"Not attached to worklet"**:
- Handler wasn't attached with `attachToWorklet()`
- Worklet node not created yet

**"Message queue full"**:
- Worklet never sent `ready` message
- Initialization failed silently
- Check WASM initialization errors

## Implementation Notes

### Timeout Preservation in Message Queue
The message handler preserves custom timeout values through the initialization queue:
- When `sendMessage(msg, customTimeout)` is called before initialization, both the message and timeout are stored in the queue
- When `markInitialized()` drains the queue, each message is sent with its original timeout
- This prevents pre-initialization operations from silently receiving the wrong timeout value

**Why this matters**: Without timeout preservation, a caller requesting a 30-second timeout for a large patch load could time out at 5 seconds if the message was queued during initialization, leading to confusing failures.

### Worklet Handler Architecture
The worklet message handling has been refactored from a 30+ case switch statement into modular handler classes:

**Handler Registry** (`src/audio/worklets/handlers/worklet-message-handlers.ts`):
- `BaseMessageHandler` - Base class with automatic error handling and response sending
- Individual handlers for each message type (EnvelopeHandler, OscillatorHandler, etc.)
- `WorkletHandlerRegistry` - Central router that dispatches messages to appropriate handlers
- All handlers use `WasmEngineAdapter` instead of direct WASM imports
- Automatic `operationResponse` sending for all operations

**Benefits**:
- Each handler is testable in isolation
- Clear separation of concerns
- Type-safe message handling
- Consistent error handling across all operations
- Easy to add new handlers

**Incremental Migration Strategy**:
The worklet can be migrated incrementally without breaking existing functionality:
1. Keep existing switch statement handlers working
2. Add handler registry as parallel system
3. Migrate one message type at a time to use registry
4. Test each migration independently
5. Remove old handler when registry version is confirmed working

**Example Migration**:
```typescript
// OLD: Direct WASM call in switch statement
case 'updateEnvelope':
  this.audioEngine!.update_envelope(data.envelopeId, data.config);
  break;

// NEW: Routed through handler registry
case 'updateEnvelope':
  await this.handlerRegistry.route(event.data);
  // Handler automatically sends operationResponse
  break;
```

### Critical Bug Fixes in WasmEngineAdapter
During Phase 2 development, code review identified critical API mismatches in the initial `WasmEngineAdapter` implementation. These have been **fixed**:

**Issues Found & Resolved**:
1. **Oscillator Updates** - Was passing plain objects where WASM expects `AnalogOscillatorStateUpdate` class instances
   - **Fix**: Now constructs `new AnalogOscillatorStateUpdate(...)` with all required positional args

2. **Envelope Updates** - Was passing object where WASM expects 8 positional arguments
   - **Fix**: Now calls `update_envelope(id, attack, decay, sustain, release, attackCurve, decayCurve, releaseCurve, active)`

3. **LFO Updates** - Was passing array of plain objects where WASM expects single `WasmLfoUpdateParams` instance
   - **Fix**: Now constructs `new WasmLfoUpdateParams(...)` with all 12 positional args

4. **Noise Updates** - Was passing plain object where WASM expects `NoiseUpdateParams` instance
   - **Fix**: Now constructs `new NoiseUpdateParams(type, cutoff, gain, enabled)`

5. **Effect Updates** - Chorus, Reverb, Delay were passing objects where WASM expects positional arguments
   - **Fix**: Now calls with positional args (e.g., `update_chorus(nodeId, active, baseDelayMs, depthMs, ...)`)

**Impact**: Without these fixes, all node update operations routed through the adapter would have thrown type errors at runtime. The adapter now correctly matches the actual WASM API surface.

**Methodology**: Fixed by examining the existing worklet code to understand the correct WASM API, then updating the adapter to construct proper WASM class instances and call methods with correct signatures.

### Phase 3: Instrument Class Refactoring

**Overview**: The original `Instrument` class has been completely refactored into `InstrumentV2` as a drop-in replacement that uses the new architecture components.

**Problems with Original Instrument**:
- 1000 lines with 34 public methods
- Only 2 methods returned Promises (updateEnvelopeState, and async data exports)
- 32+ methods used fire-and-forget postMessage() with no error handling
- Stored duplicate synthLayout state locally
- Manual Promise construction with event listeners for each async operation
- No timeout handling except for a few hardcoded 2-5 second timeouts
- No operation queuing during initialization

**InstrumentV2 Improvements**:
1. **WorkletMessageHandler Integration**:
   - All mutation operations now return Promises via message handler
   - Automatic timeout handling (10s default, 30s for large operations like patch loading)
   - Automatic queuing during initialization with timeout preservation
   - Comprehensive error handling at every layer

2. **Single Source of Truth**:
   - Removed duplicate `synthLayout` storage
   - WASM is the authoritative source for all audio state
   - `updateLayout()` method is now a no-op for compatibility

3. **Promise-Based Operations**:
   - `loadPatch()`: Now returns `Promise<void>` with 30s timeout
   - `deleteNode()`: Now returns `Promise<void>`
   - `createNode()`: Now returns `Promise<{ nodeId: string; nodeType: string }>`
   - All update methods (updateEnvelope, updateOscillator, etc.): Now return `Promise<void>`
   - `updateConnection()`: Now returns `Promise<void>`

4. **Fire-and-Forget Only Where Appropriate**:
   - MIDI operations (`noteOn`, `noteOff`) remain fire-and-forget for low latency
   - Asset imports (wavetable, sample, impulse data) remain fire-and-forget for large transfers
   - Everything else uses Promise-based operations

5. **Backward Compatibility**:
   - Added compatibility aliases: `note_on()` → `noteOn()`, `note_off()` → `noteOff()`
   - Added all missing methods from original Instrument:
     - `getWasmNodeConnections()` - Get layout from WASM
     - `getEnvelopePreview()` - Preview envelope shape
     - `getFilterResponse()` - Alias to `getFilterIRWaveform()`
     - `getLfoWaveform()` - Get LFO waveform preview
     - `updateArpeggiatorPattern()` - Update arpeggiator pattern
     - `updateArpeggiatorStepDuration()` - Update arpeggiator timing
     - `remove_specific_connection()` - Remove specific connection
     - `updateWavetable()` - No-op, deprecated in favor of `importWavetableData()`
     - `updateLayout()` - No-op, no longer stores layout

6. **Export Method Compatibility**:
   - `exportSamplerData()`: Returns `{ samples: Float32Array, sampleRate, channels, rootNote }` matching original
   - `exportConvolverData()`: Returns `{ samples: Float32Array, sampleRate, channels }` matching original

**Integration into Application**:
- Updated `audio-system-store.ts` to use `InstrumentV2` instead of `Instrument`
- Updated import: `import InstrumentV2 from 'src/audio/instrument-v2'`
- Updated type annotation: `currentInstrument: null as InstrumentV2 | null`
- Updated instantiation: `new InstrumentV2(destination, audioContext, memory)`
- Made `loadPatch()` call async with `await`
- Removed `updateLayout()` call (no longer needed)
- Updated `audio-asset-extractor.ts` to use `InstrumentV2` type

**File**: `src/audio/instrument-v2.ts` (600+ lines)

**Important Correction (Post Code Review)**:
After code review, InstrumentV2 was updated to work with the **current** worklet implementation:
- Most operations are now **fire-and-forget** (not Promise-based) because the worklet doesn't send `operationResponse` yet
- Only envelope updates and data exports return Promises (worklet already supports these)
- Fixed message type mismatches:
  - `updateConvolver` → `updateConvolverState`
  - `updateDelay` → `updateDelayState`
  - `exportSamplerData` → `exportSampleData`
- The worklet now accepts both the legacy `updateDelayState`/`updateConvolverState` and the newer `updateDelay`/`updateConvolver` message names so InstrumentV2 stays compatible even if its message builder lags behind future refactors.
- When Phase 2 (worklet migration) is complete, more operations will become Promise-based

**Benefits**:
- Works correctly with current worklet (no timeouts)
- Uses correct message types that worklet expects
- Envelope updates have proper Promise-based error handling (worklet supports it)
- No duplicate state storage
- Drop-in replacement - existing code continues to work
- Foundation ready for Phase 2 migration to full Promise-based operations

## Files Changed/Added

### New Files (Phases 1-3):
- `src/audio/types/worklet-messages.ts` - Message protocol (442 lines)
- `src/audio/adapters/wasm-type-adapter.ts` - Type conversions (395 lines)
- `src/audio/adapters/wasm-engine-adapter.ts` - WASM wrapper (450+ lines)
- `src/audio/adapters/message-handler.ts` - Request/response handler (376 lines)
- `src/audio/worklets/handlers/worklet-message-handlers.ts` - Worklet message handlers (485 lines)
- `src/audio/instrument-v2.ts` - Refactored Instrument class (600+ lines)

### Modified Files (Phase 3):
- `src/stores/audio-system-store.ts` - Updated to use InstrumentV2
  - Line 4: Import changed to `import InstrumentV2 from 'src/audio/instrument-v2'`
  - Line 153: Type changed to `currentInstrument: null as InstrumentV2 | null`
  - Line 2043: Instantiation changed to `new InstrumentV2(...)`
  - Line 544: Made `loadPatch()` async with `await`
  - Line 549-550: Removed `updateLayout()` call (replaced with comment explaining why)
- `src/audio/serialization/audio-asset-extractor.ts` - Updated type imports
  - Line 5: Import changed to `import type InstrumentV2 from '../instrument-v2'`
  - Lines 12, 51, 93: Function signatures updated to use `InstrumentV2` type

### Files Needing Updates (Phase 4):
- `src/audio/worklets/synth-worklet.ts` - Migrate to handler registry (Phase 2, incremental)
- `src/stores/audio-system-store.ts` - Simplify, remove mutations (Phase 4)
- `src/audio/types/synth-layout.ts` - Remove duplicate conversions (Phase 4)
- Components using Instrument - May need to handle new Promise returns (as needed)

## New discovery: node names + convolver message cloning (2025-03)

- The WASM engine always reports default node names from `AudioNode::name()` (e.g., "Analog Oscillator", "Gate Mixer"), so a worklet layout sync can overwrite custom labels. `layout-store` now treats those default strings as generic, and preserves existing names whenever they exist even if the incoming layout carries defaults. The default-name set lives in `DEFAULT_NODE_NAMES` inside `layout-store`.
- Worklet `handleLoadPatch` now reapplies node names from the patch JSON onto the voice layouts before broadcasting `synthLayout`, and caches the id→name map to reapply on every layout post. Custom labels like “Amp Envelope” survive the roundtrip even though the WASM engine reports default names. `layout-store` also avoids overriding incoming custom names when nodes arrive in object form.
- Fire-and-forget convolver updates can throw `DataCloneError` when Vue proxies or reactive Maps are passed to `postMessage`. `InstrumentV2.updateConvolverState` now unwraps with `toRaw` and JSON clones the payload (also forcing `id`), so callers should route convolver updates through that method instead of posting reactive objects directly.
- Preset toolbar now exposes a 1–8 voice dropdown. Selecting a new value updates `layout-store`’s `voiceCount`, serializes the current patch with that count, and reapplies it via `patch-store.setVoiceCount`, so per-patch polyphony is preserved on reload.

## New discovery: Glide / Portamento handling (2025)

- Glide now uses a single `time` field (legacy `riseTime`/`fallTime` still accepted) and only slews while the gate is high; on gate-off it latches to the target immediately instead of continuing to drift.
- `GlideState::resolved_time()` in Rust and `normalizeGlideState` in TS collapse old patches by taking the max of legacy rise/fall times when `time` is absent or zero.
- WASM and native builders now always wire `GateMixer -> Glide (CombinedGate)` after constructing the graph so the glide sees gate changes even though `gatemixer` is created after `glide` in `NODE_CREATION_ORDER`.
- `InstrumentV2.noteOn` skips the brief gate off/on pulse when `voiceLimit === 1`, preventing stolen monophonic voices from dropping gate (which could kill the new note) and enabling legato portamento.

## New discovery: Stereo compressor effect (2025)

- The global effect stack now includes a compressor after the limiter (effect index 5 → node ID `10005`). Patch states carry it via `compressors` maps (`SynthState.compressors` in Rust/patch JSON, `compressorStates` in TS) with fields `thresholdDb`, `ratio`, `attackMs`, `releaseMs`, `makeupGainDb`, `mix`, and `active`.
- WASM/native expose `update_compressor` and the worklet handles `updateCompressor` messages. UI controls live in `CompressorComponent.vue` and appear in the Effects column; patches serialize/deserialize compressor state, while older patches default safely because the map is optional/defaulted.

## Playbook: Adding a New Node (Rust + WASM + UI)

- **Rust node + wiring**
  - Implement the node in `rust-wasm/src/nodes/` and export it from `nodes/mod.rs`.
  - Add a `*State` struct to `audio_engine/patch.rs`, extend `SynthState` maps, and update `patch_serialization_spec.rs` defaults.
  - Register creation in WASM/native: import the node, expose add/update methods, include default instance in `init`/`init_with_patch`, and apply state during `apply_patch_states`/`init_with_patch`.
  - If using the global effect stack, remember `EFFECT_NODE_ID_OFFSET`; add update routing in `update_*` with downcast + bounds checks.

- **Ports and node types**
  - If it needs new ports, extend `PortId` (Rust + TS enum) and `wasm-type-adapter` mappings.
  - Add the node type string to `wasm-type-adapter` (Rust↔TS) and `DEFAULT_NODE_NAMES` in `layout-store`.
  - Update the worklet’s `initializeVoices` mapping so `nodesByType` contains the new `VoiceNodeType`.

- **Patch serialization**
  - Extend TS `Patch/SynthState` interfaces and `serializeCurrentPatch`/`deserializePatch` to include the new map.
  - Update validators (required keys if appropriate) and any asset extraction if the node carries audio data.

- **Stores & UI**
  - Add state map + defaults in `node-state-store`, apply to WASM in `applyPreservedStatesToWasm`, and purge on delete.
  - Add instrument methods + worklet message handlers (`updateX`), plus `WorkletMessage` types/builders if needed.
  - Add UI component and hook it into the add-node menu and layout columns; align toggle/knob layout with existing effects.
