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

## General Guidance for Future Changes

- Keep **WASM and native** implementations of patch logic, node creation, and connection wiring as parallel as possible.
- Be careful when:
  - Changing `PortId` enum values; they must remain aligned between Rust, the JS bindings, and the TS enums.
  - Adding new node types: update `NODE_CREATION_ORDER`, `get_current_state` serialization, and TS `VoiceNodeType`.
  - Touching envelope or gate logic: verify `CombinedGate` wiring and gate thresholds (`> 0.0`) still make sense.
- Before assuming an envelope bug, check:
  - Is the envelope’s `config.active` flag true?
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
