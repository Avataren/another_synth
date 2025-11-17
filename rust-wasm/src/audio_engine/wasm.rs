use crate::automation::AutomationFrame;
use crate::biquad::FilterType;
use crate::effect_stack::EffectStack;
use crate::graph::{Connection, ConnectionKey, ModulationTransformation, ModulationType, NodeId};
use crate::impulse_generator::ImpulseResponseGenerator;
use crate::nodes::morph_wavetable::{
    MipmappedWavetable, WavetableMorphCollection, WavetableSynthBank,
};
use crate::nodes::{
    generate_mipmapped_bank_dynamic, AnalogOscillator, AnalogOscillatorStateUpdate,
    ArpeggiatorGenerator, Chorus, Convolver, Delay, Envelope, EnvelopeConfig, FilterCollection,
    FilterSlope, Freeverb, GlobalVelocityNode, Lfo, LfoLoopMode, LfoRetriggerMode, LfoWaveform,
    Limiter, Mixer, NoiseGenerator, NoiseType, NoiseUpdate, SampleData, Sampler, SamplerLoopMode,
    Waveform, WavetableBank, WavetableOscillator, WavetableOscillatorStateUpdate,
};
use crate::traits::{AudioNode, PortId};
use crate::voice::Voice;
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, io::Cursor, rc::Rc, sync::Arc};

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;
#[cfg(feature = "wasm")]
use web_sys::{console, js_sys};

use hound;
use std::error::Error;
const EFFECT_NODE_ID_OFFSET: usize = 10_000;

#[cfg(feature = "wasm")]
fn log_console(message: &str) {
    console::log_1(&message.into());
}

#[cfg(not(feature = "wasm"))]
fn log_console(_message: &str) {}

fn import_wav_hound_reader<R: std::io::Read>(
    reader: R,
    base_size: usize,
) -> Result<WavetableMorphCollection, Box<dyn Error>> {
    let mut wav_reader = hound::WavReader::new(reader)?;
    let spec = wav_reader.spec();
    let sample_rate = spec.sample_rate as f32;

    // Read samples from the WAV (handling various bit depths/formats).
    let samples: Vec<f32> = match (spec.bits_per_sample, spec.sample_format) {
        (32, hound::SampleFormat::Float) => {
            wav_reader.samples::<f32>().map(|s| s.unwrap()).collect()
        }
        (16, hound::SampleFormat::Int) => wav_reader
            .samples::<i16>()
            .map(|s| s.unwrap() as f32 / i16::MAX as f32)
            .collect(),
        (24, hound::SampleFormat::Int) => {
            let shift = 32 - 24;
            wav_reader
                .samples::<i32>()
                .map(|s| (s.unwrap() << shift >> shift) as f32 / 8_388_607.0)
                .collect()
        }
        (32, hound::SampleFormat::Int) => wav_reader
            .samples::<i32>()
            .map(|s| s.unwrap() as f32 / i32::MAX as f32)
            .collect(),
        (bits, format) => {
            return Err(format!(
                "Unsupported WAV format: bits_per_sample={} sample_format={:?}",
                bits, format
            )
            .into())
        }
    };

    let total_samples = samples.len();
    if total_samples % base_size != 0 {
        eprintln!(
            "Warning: {} extra samples will be ignored (not a complete wavetable)",
            total_samples % base_size
        );
    }
    let num_cycles = total_samples / base_size;
    log_console(&format!("Number of complete wavetables: {}", num_cycles));

    let mut collection = WavetableMorphCollection::new();

    for i in 0..num_cycles {
        let start = i * base_size;
        let end = start + base_size;
        let cycle_samples = samples[start..end].to_vec();

        // Generate a mipmapped bank using our dynamic method.
        let bank = generate_mipmapped_bank_dynamic(cycle_samples, base_size, sample_rate)?;
        // Wrap the bank in your collection’s expected type (for example, MipmappedWavetable).
        let mipmapped = MipmappedWavetable { bank };
        collection.add_wavetable(mipmapped);
    }

    Ok(collection)
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WasmNoiseType {
    White = 0,
    Pink = 1,
    Brownian = 2,
}

impl From<WasmNoiseType> for NoiseType {
    fn from(wasm_type: WasmNoiseType) -> Self {
        match wasm_type {
            WasmNoiseType::White => NoiseType::White,
            WasmNoiseType::Pink => NoiseType::Pink,
            WasmNoiseType::Brownian => NoiseType::Brownian,
        }
    }
}

#[derive(Deserialize)]
struct JsEnvelopeConfig {
    active: bool,
    attack: f32,
    decay: f32,
    sustain: f32,
    release: f32,
    #[serde(rename = "attackCurve")]
    attack_curve: f32,
    #[serde(rename = "decayCurve")]
    decay_curve: f32,
    #[serde(rename = "releaseCurve")]
    release_curve: f32,
}
impl From<JsEnvelopeConfig> for EnvelopeConfig {
    fn from(js_conf: JsEnvelopeConfig) -> Self {
        EnvelopeConfig {
            attack: js_conf.attack,
            decay: js_conf.decay,
            sustain: js_conf.sustain,
            release: js_conf.release,
            attack_curve: js_conf.attack_curve,
            decay_curve: js_conf.decay_curve,
            release_curve: js_conf.release_curve,
            attack_smoothing_samples: 16, // a sensible default
            active: js_conf.active,
        }
    }
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub struct NoiseUpdateParams {
    pub noise_type: WasmNoiseType,
    pub cutoff: f32,
    pub gain: f32,
    pub enabled: bool,
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
impl NoiseUpdateParams {
    #[cfg_attr(feature = "wasm", wasm_bindgen(constructor))]
    pub fn new(
        noise_type: WasmNoiseType,
        cutoff: f32,
        gain: f32,
        enabled: bool,
    ) -> NoiseUpdateParams {
        NoiseUpdateParams {
            noise_type,
            cutoff,
            gain,
            enabled,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub enum WasmModulationType {
    VCA = 0,
    Bipolar = 1,
    Additive = 2,
}

impl From<WasmModulationType> for ModulationType {
    fn from(wasm_type: WasmModulationType) -> Self {
        match wasm_type {
            WasmModulationType::VCA => ModulationType::VCA,
            WasmModulationType::Bipolar => ModulationType::Bipolar,
            WasmModulationType::Additive => ModulationType::Additive,
        }
    }
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub struct AudioEngine {
    voices: Vec<Voice>,
    sample_rate: f32,
    num_voices: usize,
    wavetable_synthbank: Rc<RefCell<WavetableSynthBank>>,
    wavetable_banks: Arc<FxHashMap<Waveform, Arc<WavetableBank>>>,
    effect_stack: EffectStack,
    ir_generator: ImpulseResponseGenerator,
    cpu_time_accum: f64,   // accumulated processing time (seconds)
    audio_time_accum: f64, // accumulated quantum time (seconds)
    last_cpu_usage: f32,   // last computed average (%)
    block_size: usize,
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub struct LfoUpdateParams {
    pub lfo_id: usize,
    pub frequency: f32,
    pub phase_offset: f32,
    pub waveform: u8,
    pub use_absolute: bool,
    pub use_normalized: bool,
    pub trigger_mode: u8,
    pub gain: f32,
    pub active: bool,
    pub loop_mode: usize,
    pub loop_start: f32,
    pub loop_end: f32,
}

#[derive(Serialize, Debug)]
struct EngineState {
    voices: Vec<VoiceState>,
}

#[derive(Serialize, Debug)]
struct VoiceState {
    id: usize,
    nodes: Vec<NodeState>,
    connections: Vec<ConnectionState>,
}

#[derive(Serialize, Debug)]
struct NodeState {
    id: usize,
    node_type: String,
}

#[derive(Serialize, Debug)]
struct ConnectionState {
    from_id: usize,
    to_id: usize,
    target: u32,
    amount: f32,
    modulation_type: WasmModulationType,
    modulation_transform: ModulationTransformation,
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
impl LfoUpdateParams {
    #[cfg_attr(feature = "wasm", wasm_bindgen(constructor))]
    pub fn new(
        lfo_id: usize,
        frequency: f32,
        phase_offset: f32,
        waveform: u8,
        use_absolute: bool,
        use_normalized: bool,
        trigger_mode: u8,
        gain: f32,
        active: bool,
        loop_mode: usize,
        loop_start: f32,
        loop_end: f32,
    ) -> LfoUpdateParams {
        LfoUpdateParams {
            lfo_id,
            frequency,
            phase_offset,
            waveform,
            use_absolute,
            use_normalized,
            trigger_mode,
            gain,
            active,
            loop_mode,
            loop_start,
            loop_end,
        }
    }
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
impl AudioEngine {
    #[cfg_attr(feature = "wasm", wasm_bindgen(constructor))]
    pub fn new(sample_rate: f32) -> Self {
        let num_voices = 8;
        let max_table_size = 2048;
        let buffer_size = 128;
        log_console(&format!(
            "INITIALIZING AUDIO ENGINE WITH {} VOICES",
            num_voices
        ));
        log_console(&format!("Creating WavetableSynthBank"));
        let wavetable_synthbank = Rc::new(RefCell::new(WavetableSynthBank::new(sample_rate)));
        let mut banks = FxHashMap::default();
        log_console(&format!("Creating Sine"));
        banks.insert(
            Waveform::Sine,
            Arc::new(
                WavetableBank::new(Waveform::Sine, max_table_size, sample_rate)
                    .expect("Failed to create Sine wavetable bank"),
            ),
        );
        log_console(&format!("Creating Saw",));
        banks.insert(
            Waveform::Saw,
            Arc::new(
                WavetableBank::new(Waveform::Saw, max_table_size, sample_rate)
                    .expect("Failed to create Saw wavetable bank"),
            ),
        );
        banks.insert(
            Waveform::Square,
            Arc::new(
                WavetableBank::new(Waveform::Square, max_table_size, sample_rate)
                    .expect("Failed to create Square wavetable bank"),
            ),
        );
        banks.insert(
            Waveform::Triangle,
            Arc::new(
                WavetableBank::new(Waveform::Triangle, max_table_size, sample_rate)
                    .expect("Failed to create Triangle wavetable bank"),
            ),
        );

        Self {
            voices: Vec::new(),
            sample_rate,
            num_voices,
            wavetable_synthbank,
            wavetable_banks: Arc::new(banks),
            effect_stack: EffectStack::new(buffer_size),
            ir_generator: ImpulseResponseGenerator::new(sample_rate),
            cpu_time_accum: 0.0,
            audio_time_accum: 0.0,
            last_cpu_usage: 0.0,
            block_size: buffer_size,
        }
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn init(&mut self, sample_rate: f32, num_voices: usize) {
        self.sample_rate = sample_rate;
        self.num_voices = num_voices;

        self.voices = (0..num_voices)
            .map(|id| Voice::new(id, self.block_size))
            .collect();
        self.add_chorus().unwrap();
        self.add_delay(2000.0, 500.0, 0.5, 0.1).unwrap();
        self.add_freeverb(0.95, 0.5, 0.3, 0.7, 1.0).unwrap();
        self.add_plate_reverb(2.0, 0.6, sample_rate).unwrap();
        self.add_limiter().unwrap();
        //self.add_hall_reverb(2.0, 0.8, sample_rate).unwrap();
        log_console(&format!("plate reverb added"));
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn remove_connection(
        &mut self,
        from_node: usize,
        from_port: PortId,
        to_node: usize,
        to_port: PortId,
    ) -> Result<(), JsValue> {
        for (_i, voice) in self.voices.iter_mut().enumerate() {
            voice.graph.remove_connection(&Connection {
                from_node: NodeId(from_node),
                from_port,
                to_node: NodeId(to_node),
                to_port,
                amount: 0.0, // The amount doesn't matter for removal
                modulation_type: ModulationType::VCA, // neither does modulation_type
                modulation_transform: ModulationTransformation::None,
            });
        }
        Ok(())
    }

    #[cfg(feature = "wasm")]
    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn get_current_state(&self) -> JsValue {
        // Use voice 0 as the canonical layout.
        if let Some(voice) = self.voices.get(0) {
            // Here we assume that the nodes vector was built by add_node
            // so the index matches the node's id.
            let mut nodes: Vec<NodeState> = voice
                .graph
                .nodes
                .iter()
                .enumerate()
                .map(|(i, node)| {
                    NodeState {
                        id: i, // This is the same as the node's assigned id.
                        node_type: node.node_type().to_string(),
                    }
                })
                .collect();

            // Append the effect stack's nodes with an offset.
            let effect_nodes: Vec<NodeState> = self
                .effect_stack
                .effects
                .iter()
                .enumerate()
                .map(|(i, effect)| NodeState {
                    id: EFFECT_NODE_ID_OFFSET + i, // ensure uniqueness by offsetting
                    node_type: effect.node.node_type().to_string(),
                })
                .collect();
            nodes.extend(effect_nodes);

            // Collect the voice's connections as before.
            let connections: Vec<ConnectionState> = voice
                .graph
                .connections
                .values()
                .map(|conn| ConnectionState {
                    from_id: conn.from_node.0,
                    to_id: conn.to_node.0,
                    target: conn.to_port as u32,
                    amount: conn.amount,
                    modulation_type: match conn.modulation_type {
                        ModulationType::VCA => WasmModulationType::VCA,
                        ModulationType::Bipolar => WasmModulationType::Bipolar,
                        ModulationType::Additive => WasmModulationType::Additive,
                    },
                    modulation_transform: conn.modulation_transform,
                })
                .collect();

            let canonical_voice = VoiceState {
                id: 0,
                nodes,
                connections,
            };

            let engine_state = EngineState {
                voices: vec![canonical_voice],
            };

            serde_wasm_bindgen::to_value(&engine_state).unwrap()
        } else {
            let engine_state = EngineState { voices: vec![] };
            serde_wasm_bindgen::to_value(&engine_state).unwrap()
        }
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn process_audio(
        &mut self,
        gates: &[f32],
        frequencies: &[f32],
        gains: &[f32],
        velocities: &[f32],
        macro_values: &[f32],
        master_gain: f32,
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) {
        // Begin CPU measurement:
        #[cfg(feature = "wasm")]
        let start = js_sys::Date::now();
        #[cfg(not(feature = "wasm"))]
        let start = std::time::Instant::now();
        // Create temporary buffers for voice mixing
        let mut mix_left = vec![0.0; output_left.len()];
        let mut mix_right = vec![0.0; output_right.len()];

        let mut voice_left = vec![0.0; output_left.len()];
        let mut voice_right = vec![0.0; output_right.len()];

        // Process all voices and mix them
        for (i, voice) in self.voices.iter_mut().enumerate() {
            let gate = gates.get(i).copied().unwrap_or(0.0);
            let frequency = frequencies.get(i).copied().unwrap_or(440.0);
            let gain = gains.get(i).copied().unwrap_or(1.0);
            let velocity = velocities.get(i).copied().unwrap_or(0.0);

            voice.current_gate = gate;
            voice.current_frequency = frequency;
            voice.current_velocity = velocity;

            // Update macro values
            for macro_idx in 0..4 {
                let macro_start = i * 4 * 128 + (macro_idx * 128);
                if macro_start + 128 <= macro_values.len() {
                    let values = &macro_values[macro_start..macro_start + 128];
                    let _ = voice.update_macro(macro_idx, values);
                }
            }

            voice_left.fill(0.0);
            voice_right.fill(0.0);

            // Process voice audio
            voice.process_audio(&mut voice_left, &mut voice_right);

            // Mix voice into main mix buffers with gain
            for (i, (left, right)) in voice_left.iter().zip(voice_right.iter()).enumerate() {
                mix_left[i] += left * gain;
                mix_right[i] += right * gain;
            }
        }

        // Process through effect stack
        self.effect_stack
            .process_audio(&mix_left, &mix_right, output_left, output_right);

        // Apply master gain after effects
        if master_gain != 1.0 {
            for sample in output_left.iter_mut() {
                *sample *= master_gain;
            }
            for sample in output_right.iter_mut() {
                *sample *= master_gain;
            }
        }

        #[cfg(feature = "wasm")]
        let elapsed_sec = {
            let end = js_sys::Date::now();
            (end - start) / 1000.0
        };

        #[cfg(not(feature = "wasm"))]
        let elapsed_sec = start.elapsed().as_secs_f64();
        // The available time per quantum (128 samples) is:
        let quantum_sec = 128.0 / self.sample_rate as f64;
        // Accumulate processing and quantum times:
        self.cpu_time_accum += elapsed_sec;
        self.audio_time_accum += quantum_sec;
        // Update average once enough quantum time has passed (e.g. 100ms):
        if self.audio_time_accum >= 0.1 {
            self.last_cpu_usage = ((self.cpu_time_accum / self.audio_time_accum) * 100.0) as f32;
            self.cpu_time_accum = 0.0;
            self.audio_time_accum = 0.0;
        }
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn process_with_frame(
        &mut self,
        frame: &AutomationFrame,
        master_gain: f32,
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) {
        self.process_audio(
            frame.gates(),
            frame.frequencies(),
            frame.gains(),
            frame.velocities(),
            frame.macro_buffers(),
            master_gain,
            output_left,
            output_right,
        );
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn get_cpu_usage(&self) -> f32 {
        self.last_cpu_usage
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn add_delay(
        &mut self,
        max_delay_ms: f32,
        delay_ms: f32,
        feedback: f32,
        mix: f32,
    ) -> Result<usize, JsValue> {
        let delay = Delay::new(self.sample_rate, max_delay_ms, delay_ms, feedback, mix);
        Ok(self.effect_stack.add_effect(Box::new(delay)))
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn add_freeverb(
        &mut self,
        room_size: f32,
        damp: f32,
        wet: f32,
        dry: f32,
        width: f32,
    ) -> Result<usize, JsValue> {
        let reverb = Freeverb::new(self.sample_rate, room_size, damp, wet, dry, width);
        Ok(self.effect_stack.add_effect(Box::new(reverb)))
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn add_hall_reverb(
        &mut self,
        decay_time: f32,
        room_size: f32,
        sample_rate: f32,
    ) -> Result<usize, JsValue> {
        // Validate parameters before processing
        let decay_time = decay_time.clamp(0.1, 10.0);
        let rsize = room_size.clamp(0.0, 1.0);
        // Generate hall reverb impulse response
        let ir = self.ir_generator.hall(decay_time, rsize);

        if ir.is_empty() {
            return Err(JsValue::from_str("Generated impulse response is empty"));
        }

        // Create convolver with bounds checking
        let mut convolver = Convolver::new(ir, 128, sample_rate);
        convolver.set_wet_level(0.1);
        Ok(self.effect_stack.add_effect(Box::new(convolver)))
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn add_plate_reverb(
        &mut self,
        decay_time: f32,
        diffusion: f32,
        sample_rate: f32,
    ) -> Result<usize, JsValue> {
        // Validate parameters before processing
        let decay_time = decay_time.clamp(0.1, 10.0);
        let diffusion = diffusion.clamp(0.0, 1.0);
        // Generate plate reverb impulse response
        let ir = self.ir_generator.plate(decay_time, diffusion);

        if ir.is_empty() {
            return Err(JsValue::from_str("Generated impulse response is empty"));
        }

        // Create convolver with bounds checking
        let mut convolver = Convolver::new(ir, 128, sample_rate);
        convolver.set_wet_level(0.1);
        convolver.set_enabled(false);
        Ok(self.effect_stack.add_effect(Box::new(convolver)))
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn reorder_effects(&mut self, from_idx: usize, to_idx: usize) -> Result<(), JsValue> {
        self.effect_stack.reorder_effects(from_idx, to_idx);
        Ok(())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn remove_effect(&mut self, index: usize) -> Result<(), JsValue> {
        self.effect_stack.remove_effect(index);
        Ok(())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn delete_node(&mut self, node_id: usize) -> Result<(), JsValue> {
        let node_id = NodeId(node_id);

        log_console(&format!("Attempting to delete node with ID: {}", node_id.0));

        // Check if this is a special node that shouldn't be deleted
        if let Some(voice) = self.voices.first() {
            // Log the global node IDs for debugging
            log_console(&format!(
                "Global node IDs - Frequency: {:?}, Velocity: {:?}, GateMixer: {:?}",
                voice.graph.global_frequency_node.map(|n| n.0),
                voice.graph.global_velocity_node.map(|n| n.0),
                voice.graph.global_gatemixer_node.map(|n| n.0)
            ));

            if voice.graph.global_frequency_node == Some(node_id)
                || voice.graph.global_velocity_node == Some(node_id)
                || voice.graph.global_gatemixer_node == Some(node_id)
            {
                return Err(JsValue::from_str(&format!(
                    "Cannot delete node {} as it is a system node",
                    node_id.0
                )));
            }

            // Check if this is the output node
            if voice.graph.output_node == Some(node_id) {
                return Err(JsValue::from_str(&format!(
                    "Cannot delete node {} as it is the output node",
                    node_id.0
                )));
            }
        }

        // Check if it's an effect node (if node_id >= EFFECT_NODE_ID_OFFSET)
        if node_id.0 >= EFFECT_NODE_ID_OFFSET {
            let effect_index = node_id.0 - EFFECT_NODE_ID_OFFSET;
            if effect_index < self.effect_stack.effects.len() {
                self.effect_stack.remove_effect(effect_index);
                log_console(&format!("Effect {} successfully removed", node_id.0));
                return Ok(());
            } else {
                return Err(JsValue::from_str(&format!(
                    "Effect with id {} not found",
                    node_id.0
                )));
            }
        }

        // Log node type information for debugging
        if let Some(voice) = self.voices.first() {
            if let Some(node) = voice.graph.get_node(node_id) {
                log_console(&format!(
                    "Node {} is of type: {}, with {} connections",
                    node_id.0,
                    node.node_type(),
                    voice
                        .graph
                        .connections
                        .values()
                        .filter(|conn| conn.from_node == node_id || conn.to_node == node_id)
                        .count()
                ));
            }
        }

        // Find what connections need to be removed across all voices
        let mut connections_to_remove = Vec::new();
        if let Some(voice) = self.voices.first() {
            connections_to_remove = voice
                .graph
                .connections
                .iter()
                .filter(|(_, conn)| conn.from_node == node_id || conn.to_node == node_id)
                .map(|(key, _)| key.clone())
                .collect();
        }

        // Stage 1: Remove connections in all voices
        for voice in &mut self.voices {
            for key in &connections_to_remove {
                voice.graph.connections.remove(key);
            }
            voice.graph.input_connections.remove(&node_id);
            for inputs in voice.graph.input_connections.values_mut() {
                inputs.retain(|(_, _, _, from_node, _, _)| *from_node != node_id);
            }
        }

        // Stage 2: Release buffers and remove the node itself
        for (voice_idx, voice) in self.voices.iter_mut().enumerate() {
            // Skip if node doesn't exist in this voice
            if node_id.0 >= voice.graph.nodes.len() {
                log_console(&format!(
                    "Node {} does not exist in voice {}",
                    node_id.0, voice_idx
                ));
                continue;
            }

            let buffers_to_release: Vec<_> = voice
                .graph
                .node_buffers
                .iter()
                .filter_map(|((id, port), &buffer_idx)| {
                    if *id == node_id {
                        Some((buffer_idx, *port))
                    } else {
                        None
                    }
                })
                .collect();

            for (buffer_idx, _) in &buffers_to_release {
                voice.graph.buffer_pool.release(*buffer_idx);
            }

            voice.graph.node_buffers.retain(|(id, _), _| *id != node_id);
            voice.graph.processing_order.retain(|&idx| idx != node_id.0);

            // Remove the node
            if node_id.0 < voice.graph.nodes.len() {
                voice.graph.nodes.remove(node_id.0);
            }
        }

        // Stage 3: Update all node references consistently across all voices
        for (voice_idx, voice) in self.voices.iter_mut().enumerate() {
            log_console(&format!("Updating references in voice {}", voice_idx));

            // Update connections with new node IDs
            let updated_connections: FxHashMap<_, _> = voice
                .graph
                .connections
                .iter()
                .map(|(_key, conn)| {
                    let mut new_conn = conn.clone();

                    if new_conn.from_node.0 > node_id.0 {
                        new_conn.from_node = NodeId(new_conn.from_node.0 - 1);
                    }
                    if new_conn.to_node.0 > node_id.0 {
                        new_conn.to_node = NodeId(new_conn.to_node.0 - 1);
                    }

                    // Create a completely new key using the ConnectionKey::new constructor
                    let new_key = ConnectionKey::new(
                        new_conn.from_node,
                        new_conn.from_port,
                        new_conn.to_node,
                        new_conn.to_port,
                    );

                    (new_key, new_conn)
                })
                .collect();

            voice.graph.connections.clear();
            voice.graph.connections.extend(updated_connections);

            // Update node buffers
            let updated_buffers: FxHashMap<_, _> = voice
                .graph
                .node_buffers
                .iter()
                .filter_map(|((id, port), &buffer_idx)| {
                    if id.0 > node_id.0 {
                        Some(((NodeId(id.0 - 1), *port), buffer_idx))
                    } else if id.0 != node_id.0 {
                        Some(((*id, *port), buffer_idx))
                    } else {
                        None
                    }
                })
                .collect();

            voice.graph.node_buffers.clear();
            voice.graph.node_buffers.extend(updated_buffers);

            // Update processing order
            for idx in &mut voice.graph.processing_order {
                if *idx > node_id.0 {
                    *idx -= 1;
                }
            }

            // Update input_connections
            let mut updated_inputs = FxHashMap::default();
            for (target, inputs) in &voice.graph.input_connections {
                let new_target = if target.0 > node_id.0 {
                    NodeId(target.0 - 1)
                } else {
                    *target
                };

                let new_inputs: Vec<_> = inputs
                    .iter()
                    .map(
                        |(port, buffer, amount, from_node, mod_type, mod_transform)| {
                            let new_from = if from_node.0 > node_id.0 {
                                NodeId(from_node.0 - 1)
                            } else {
                                *from_node
                            };

                            (*port, *buffer, *amount, new_from, *mod_type, *mod_transform)
                        },
                    )
                    .collect();

                if new_target != *target {
                    log_console(&format!(
                        "Updating input connections: {} -> {}",
                        target.0, new_target.0
                    ));
                }

                updated_inputs.insert(new_target, new_inputs);
            }

            voice.graph.input_connections = updated_inputs;

            // Update special node references
            if let Some(output_id) = voice.graph.output_node {
                if output_id.0 > node_id.0 {
                    let new_id = NodeId(output_id.0 - 1);
                    log_console(&format!(
                        "Updating output node: {} -> {}",
                        output_id.0, new_id.0
                    ));
                    voice.graph.output_node = Some(new_id);
                }
            }

            // Also update the voice's output_node if needed
            if voice.output_node.0 > node_id.0 {
                let old_id = voice.output_node.0;
                voice.output_node = NodeId(voice.output_node.0 - 1);
                log_console(&format!(
                    "Updating voice output node: {} -> {}",
                    old_id, voice.output_node.0
                ));
            }
        }

        log_console(&format!(
            "Node {} successfully deleted from all voices",
            node_id.0
        ));
        Ok(())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn update_noise(
        &mut self,
        noise_id: usize,
        params: &NoiseUpdateParams,
    ) -> Result<(), JsValue> {
        for voice in &mut self.voices {
            if let Some(node) = voice.graph.get_node_mut(NodeId(noise_id)) {
                if let Some(noise) = node.as_any_mut().downcast_mut::<NoiseGenerator>() {
                    noise.update(NoiseUpdate {
                        noise_type: params.noise_type.into(),
                        cutoff: params.cutoff * self.sample_rate,
                        gain: params.gain,
                        enabled: params.enabled,
                    });
                } else {
                    return Err(JsValue::from_str("Node is not a NoiseGenerator"));
                }
            } else {
                return Err(JsValue::from_str("Node not found"));
            }
        }
        Ok(())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn update_velocity(
        &mut self,
        node_id: usize,
        sensitivity: f32,
        randomize: f32,
    ) -> Result<(), JsValue> {
        for voice in &mut self.voices {
            if let Some(node) = voice.graph.get_node_mut(NodeId(node_id)) {
                if let Some(velocity) = node.as_any_mut().downcast_mut::<GlobalVelocityNode>() {
                    velocity.set_sensitivity(sensitivity);
                    velocity.set_randomize(randomize);
                } else {
                    return Err(JsValue::from_str("Node is not a GlobalVelocityNode"));
                }
            } else {
                return Err(JsValue::from_str("Node not found"));
            }
        }
        Ok(())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn get_gate_mixer_node_id(&mut self) -> NodeId {
        for voice in &mut self.voices {
            return voice.graph.global_gatemixer_node.unwrap();
        }
        NodeId(0)
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn update_envelope(
        &mut self,
        node_id: usize,
        attack: f32,
        decay: f32,
        sustain: f32,
        release: f32,
        attack_curve: f32,
        decay_curve: f32,
        release_curve: f32,
        active: bool,
    ) -> Result<(), JsValue> {
        let mut errors: Vec<String> = Vec::new();

        // Iterate over all voices and attempt to update the envelope.
        for (i, voice) in self.voices.iter_mut().enumerate() {
            if let Some(node) = voice.graph.get_node_mut(NodeId(node_id)) {
                if let Some(env) = node.as_any_mut().downcast_mut::<Envelope>() {
                    let config = EnvelopeConfig {
                        attack,
                        decay,
                        sustain,
                        release,
                        attack_curve,
                        decay_curve,
                        release_curve,
                        attack_smoothing_samples: 16,
                        active,
                    };
                    env.update_config(config);
                    env.set_active(active);
                } else {
                    errors.push(format!("Voice {}: Node is not an Envelope", i));
                }
            } else {
                errors.push(format!("Voice {}: Node not found", i));
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(JsValue::from_str(&errors.join("; ")))
        }
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn get_envelope_preview(
        sample_rate: f32,
        js_config: JsValue,
        preview_duration: f32,
    ) -> Result<js_sys::Float32Array, JsValue> {
        // Deserialize the JS object into our helper struct.
        let js_conf: JsEnvelopeConfig = serde_wasm_bindgen::from_value(js_config)
            .map_err(|err| JsValue::from_str(&err.to_string()))?;

        // Convert it into our internal EnvelopeConfig.
        let config: EnvelopeConfig = js_conf.into();

        // Create a temporary envelope and generate the preview.
        let envelope = Envelope::new(sample_rate, config);
        let preview_values = envelope.preview(preview_duration);

        // Convert Vec<f32> into a Float32Array.
        let array = js_sys::Float32Array::new_with_length(preview_values.len() as u32);
        for (i, &value) in preview_values.iter().enumerate() {
            array.set_index(i as u32, value);
        }
        Ok(array)
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn update_wavetable_oscillator(
        &mut self,
        oscillator_id: usize,
        params: &WavetableOscillatorStateUpdate,
    ) -> Result<(), JsValue> {
        for voice in &mut self.voices {
            let node = voice
                .graph
                .get_node_mut(NodeId(oscillator_id))
                .ok_or_else(|| JsValue::from_str("Node not found in one of the voices"))?;
            let osc = node
                .as_any_mut()
                .downcast_mut::<WavetableOscillator>()
                .ok_or_else(|| {
                    JsValue::from_str("Node is not a WavetableOscillator in one of the voices")
                })?;
            osc.update_params(params);
        }
        Ok(())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn import_wave_impulse(&mut self, effect_id: usize, data: &[u8]) -> Result<(), JsValue> {
        use rubato::{
            Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType,
            WindowFunction,
        };
        use std::io::Cursor;

        log_console("Starting import_wave_impulse");

        // Create a hound reader from the data.
        let cursor = Cursor::new(data);
        let mut reader =
            hound::WavReader::new(cursor).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let spec = reader.spec();
        log_console(&format!(
            "WAV spec: sample_rate={}, channels={}, bits_per_sample={}, sample_format={:?}",
            spec.sample_rate, spec.channels, spec.bits_per_sample, spec.sample_format
        ));
        let num_channels = spec.channels;

        // Read the samples in f32 form.
        let samples: Vec<f32> = match (spec.bits_per_sample, spec.sample_format) {
            (32, hound::SampleFormat::Float) => {
                reader.samples::<f32>().map(|s| s.unwrap()).collect()
            }
            (16, hound::SampleFormat::Int) => reader
                .samples::<i16>()
                .map(|s| s.unwrap() as f32 / i16::MAX as f32)
                .collect(),
            (24, hound::SampleFormat::Int) => {
                let shift = 32 - 24;
                reader
                    .samples::<i32>()
                    .map(|s| (s.unwrap() << shift >> shift) as f32 / 8_388_607.0)
                    .collect()
            }
            (32, hound::SampleFormat::Int) => reader
                .samples::<i32>()
                .map(|s| s.unwrap() as f32 / i32::MAX as f32)
                .collect(),
            (bits, format) => {
                return Err(JsValue::from_str(&format!(
                    "Unsupported WAV format: bits_per_sample={} sample_format={:?}",
                    bits, format
                )))
            }
        };

        log_console(&format!("Read {} samples", samples.len()));

        // If the WAV is multi‑channel, average the channels to obtain a mono impulse response.
        let mut ir = if num_channels == 1 {
            samples
        } else {
            let mut mono = Vec::with_capacity(samples.len() / num_channels as usize);
            for chunk in samples.chunks(num_channels as usize) {
                let avg = chunk.iter().sum::<f32>() / (num_channels as f32);
                mono.push(avg);
            }
            mono
        };

        log_console(&format!("Mono IR length: {}", ir.len()));
        if ir.is_empty() {
            return Err(JsValue::from_str("Impulse response is empty"));
        }

        // Locate the effect in the effect stack using the given id (subtracting the offset).
        let index = effect_id
            .checked_sub(EFFECT_NODE_ID_OFFSET)
            .ok_or_else(|| JsValue::from_str("Invalid effect id"))?;
        if index >= self.effect_stack.effects.len() {
            return Err(JsValue::from_str("Effect id not found in effect stack"));
        }

        // Attempt to downcast the effect node to a Convolver.
        let effect = &mut self.effect_stack.effects[index];
        if let Some(convolver) = effect.node.as_any_mut().downcast_mut::<Convolver>() {
            let partition_size = convolver.partition_size;
            let target_sample_rate = convolver.sample_rate;
            let wet_level = convolver.wet_level;
            log_console(&format!(
                "Convolver target sample rate: {}",
                target_sample_rate
            ));

            // If the IR's sample rate doesn't match the target sample rate, resample it.
            if spec.sample_rate as f32 != target_sample_rate {
                log_console(&format!(
                    "Resampling needed: IR sample rate {} != target {}",
                    spec.sample_rate, target_sample_rate
                ));
                let conversion_ratio = target_sample_rate as f64 / spec.sample_rate as f64;
                log_console(&format!("Conversion ratio: {}", conversion_ratio));
                let chunk_size = 1024; // fixed chunk size
                log_console(&format!("Using chunk size: {}", chunk_size));

                // Set up the interpolation parameters per the rubato example.
                let params = SincInterpolationParameters {
                    sinc_len: 256,
                    f_cutoff: 0.95,
                    interpolation: SincInterpolationType::Linear,
                    oversampling_factor: 256,
                    window: WindowFunction::BlackmanHarris2,
                };

                // Create a SincFixedIn resampler for 1 channel.
                let mut resampler =
                    SincFixedIn::<f64>::new(conversion_ratio, 2.0, params, chunk_size, 1).map_err(
                        |e| JsValue::from_str(&format!("Resampler creation error: {:?}", e)),
                    )?;

                // Convert the IR to f64.
                let ir_f64: Vec<f64> = ir.iter().map(|&x| x as f64).collect();
                let mut resampled_output: Vec<f64> = Vec::new();

                // Process the IR in blocks of `chunk_size`.
                let mut pos = 0;
                while pos < ir_f64.len() {
                    let end = (pos + chunk_size).min(ir_f64.len());
                    let mut block = ir_f64[pos..end].to_vec();
                    if block.len() < chunk_size {
                        // Pad with zeros to fill the chunk.
                        block.resize(chunk_size, 0.0);
                    }
                    let input_block = vec![block]; // one channel
                    let out = resampler.process(&input_block, None).map_err(|e| {
                        JsValue::from_str(&format!("Resampling process error: {:?}", e))
                    })?;
                    // Append the output (first channel) to our accumulator.
                    resampled_output.extend(out[0].iter());
                    pos += chunk_size;
                }

                // Now flush any remaining samples using process_partial.
                let partial = resampler
                    .process_partial::<Vec<f64>>(None, None)
                    .map_err(|e| JsValue::from_str(&format!("Resampler flush error: {:?}", e)))?;
                resampled_output.extend(partial[0].iter());
                log_console(&format!(
                    "Resampled output length: {}",
                    resampled_output.len()
                ));

                // Replace IR with the resampled output (convert back to f32).
                ir = resampled_output.into_iter().map(|x| x as f32).collect();
                log_console(&format!("Final IR length after resampling: {}", ir.len()));
            } else {
                log_console("No resampling needed");
            }

            // Create a new convolver using the (resampled) impulse response.
            let new_convolver = Convolver::new(ir, partition_size, target_sample_rate);
            effect.node = Box::new(new_convolver);
            // Restore the original wet level.
            if let Some(new_conv) = effect.node.as_any_mut().downcast_mut::<Convolver>() {
                new_conv.set_wet_level(wet_level);
            }
            log_console("Impulse response imported successfully");
            Ok(())
        } else {
            Err(JsValue::from_str("Effect is not a Convolver"))
        }
    }

    /// Refactored import_wavetable function that uses the hound-based helper.
    /// It accepts the WAV data as a byte slice, uses a Cursor to create a reader,
    /// builds a new morph collection from the data, adds it to the synth bank under
    /// the name "imported", and then updates all wavetable oscillators to use it.
    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn import_wavetable(
        &mut self,
        node_id: usize,
        data: &[u8],
        base_size: usize,
    ) -> Result<(), JsValue> {
        // Wrap the incoming data in a Cursor and call the hound helper.
        let cursor = Cursor::new(data);
        let collection = import_wav_hound_reader(cursor, base_size)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        // Clear the existing collections so only one is kept.
        self.wavetable_synthbank.borrow_mut().collections.clear();
        // Add the new collection to the synth bank.
        self.wavetable_synthbank
            .borrow_mut()
            .add_collection("imported", collection);

        // Update the oscillator's active wavetable to the newly imported collection.
        for voice in &mut self.voices {
            let node = voice
                .graph
                .get_node_mut(NodeId(node_id))
                .ok_or_else(|| JsValue::from_str("Node not found in one of the voices"))?;
            let osc = node
                .as_any_mut()
                .downcast_mut::<WavetableOscillator>()
                .ok_or_else(|| {
                    JsValue::from_str("Node is not a WavetableOscillator in one of the voices")
                })?;
            osc.set_current_wavetable("imported");
        }

        Ok(())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn update_oscillator(
        &mut self,
        oscillator_id: usize,
        params: &AnalogOscillatorStateUpdate,
    ) -> Result<(), JsValue> {
        for voice in &mut self.voices {
            let node = voice
                .graph
                .get_node_mut(NodeId(oscillator_id))
                .ok_or_else(|| JsValue::from_str("Node not found in one of the voices"))?;
            let osc = node
                .as_any_mut()
                .downcast_mut::<AnalogOscillator>()
                .ok_or_else(|| {
                    JsValue::from_str("Node is not an AnalogOscillator in one of the voices")
                })?;
            osc.update_params(params);
        }
        Ok(())
    }

    pub fn update_delay(
        &mut self,
        node_id: usize,
        delay_ms: f32,
        feedback: f32,
        wet_mix: f32,
        enabled: bool,
    ) {
        // Calculate the effect index based on the provided node_id.
        let effect_id = node_id - EFFECT_NODE_ID_OFFSET;

        // Try to get a mutable reference to the effect at that index.
        if let Some(effect) = self.effect_stack.effects.get_mut(effect_id) {
            // Attempt to downcast the boxed AudioNode to a Convolver.
            if let Some(delay) = effect.node.as_any_mut().downcast_mut::<Delay>() {
                delay.set_delay_ms(delay_ms);
                delay.set_feedback(feedback);
                delay.set_mix(wet_mix);
                delay.set_active(enabled);
            } else {
                // Log a warning if the node at that index isn't a Convolver.
                log_console(&format!("Effect at index {} is not a Delay", effect_id));
            }
        } else {
            // Log a warning if there is no effect at that index.
            log_console(&format!("No effect found at index {}", effect_id));
        }
    }

    pub fn update_convolver(&mut self, node_id: usize, wet_mix: f32, enabled: bool) {
        // Calculate the effect index based on the provided node_id.
        let effect_id = node_id - EFFECT_NODE_ID_OFFSET;

        // Try to get a mutable reference to the effect at that index.
        if let Some(effect) = self.effect_stack.effects.get_mut(effect_id) {
            // Attempt to downcast the boxed AudioNode to a Convolver.
            if let Some(convolver) = effect.node.as_any_mut().downcast_mut::<Convolver>() {
                convolver.set_wet_level(wet_mix);
                convolver.set_enabled(enabled);
            } else {
                // Log a warning if the node at that index isn't a Convolver.
                log_console(&format!("Effect at index {} is not a Convolver", effect_id));
            }
        } else {
            // Log a warning if there is no effect at that index.
            log_console(&format!("No effect found at index {}", effect_id));
        }
    }
    #[cfg_attr(feature = "wasm", wasm_bindgen)]

    pub fn add_limiter(&mut self) -> Result<usize, JsValue> {
        let mut limiter = Limiter::new(self.sample_rate, -0.5, 0.1, 50.0, 1.5, true);
        limiter.set_active(true);
        Ok(self.effect_stack.add_effect(Box::new(limiter)))
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]

    pub fn add_chorus(&mut self) -> Result<usize, JsValue> {
        let mut chorus = Chorus::new(
            self.sample_rate,
            // max_base_delay_ms: Needs to accommodate the base delay + depth.
            // max base delay in ms:
            65.0,
            // base_delay_ms: The central delay time. 20-30ms is typical for chorus.
            15.0,
            // depth_ms: How much the delay time varies. 2-7ms is a common range.
            5.0,
            // lfo_rate_hz: Speed of the warble. Slow rates are classic chorus.
            // 0.3 - 0.8 Hz is a good starting range.
            0.5,
            // feedback: Usually low or zero for standard chorus. High feedback -> flanger.
            0.3,
            // mix: 0.5 gives an equal blend of dry and wet signal. Standard starting point.
            0.5,
            // stereo_phase_offset_deg: Creates stereo width. 90 degrees is common
            // and effective. 0 would be mono LFO. 180 is also common.
            90.0,
        );
        chorus.set_active(false);
        Ok(self.effect_stack.add_effect(Box::new(chorus)))
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn update_reverb(
        &mut self,
        node_id: usize,
        active: bool,
        room_size: f32,
        damp: f32,
        wet: f32,
        dry: f32,
        width: f32,
    ) {
        let effect_id = node_id - EFFECT_NODE_ID_OFFSET;

        // Try to get a mutable reference to the effect at that index.
        if let Some(effect) = self.effect_stack.effects.get_mut(effect_id) {
            // Attempt to downcast the boxed AudioNode to a Convolver.
            if let Some(reverb) = effect.node.as_any_mut().downcast_mut::<Freeverb>() {
                reverb.set_room_size(room_size);
                reverb.set_damp(damp);
                reverb.set_wet(wet);
                reverb.set_dry(dry);
                reverb.set_width(width);
                reverb.set_active(active);
            } else {
                // Log a warning if the node at that index isn't a Convolver.
                log_console(&format!("Effect at index {} is not a reverb", effect_id));
            }
        } else {
            // Log a warning if there is no effect at that index.
            log_console(&format!("No effect found at index {}", effect_id));
        }
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn update_chorus(
        &mut self,
        node_id: usize,
        active: bool,
        base_delay_ms: f32,
        depth_ms: f32,
        lfo_rate_hz: f32,
        feedback: f32,
        feedback_filter: f32,
        mix: f32,
        stereo_phase_offset_deg: f32,
    ) {
        let effect_id = node_id - EFFECT_NODE_ID_OFFSET;

        // Try to get a mutable reference to the effect at that index.
        if let Some(effect) = self.effect_stack.effects.get_mut(effect_id) {
            // Attempt to downcast the boxed AudioNode to a Convolver.
            if let Some(chorus) = effect.node.as_any_mut().downcast_mut::<Chorus>() {
                chorus.set_base_delay_ms(base_delay_ms);
                chorus.set_depth_ms(depth_ms);
                chorus.set_rate_hz(lfo_rate_hz);
                chorus.set_feedback(feedback);
                chorus.set_mix(mix);
                chorus.set_stereo_phase_offset_deg(stereo_phase_offset_deg);
                chorus.set_feedback_filter_cutoff(feedback_filter * self.sample_rate);
                chorus.set_active(active);
            } else {
                // Log a warning if the node at that index isn't a Convolver.
                log_console(&format!("Effect at index {} is not a chorus", effect_id));
            }
        } else {
            // Log a warning if there is no effect at that index.
            log_console(&format!("No effect found at index {}", effect_id));
        }
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn create_envelope(&mut self) -> Result<JsValue, JsValue> {
        let mut envelope_id = NodeId(0);
        for voice in &mut self.voices {
            envelope_id = voice.graph.add_node(Box::new(Envelope::new(
                self.sample_rate,
                EnvelopeConfig::default(),
            )));
        }
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &"envelopeId".into(), &(envelope_id.0.into()))?;

        Ok(obj.into())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn create_arpeggiator(&mut self) -> Result<JsValue, JsValue> {
        let mut arp_id = NodeId(0);
        let mut gate_mixer_id = NodeId(0);
        for voice in &mut self.voices {
            let mut arp = ArpeggiatorGenerator::new();
            arp.create_test_pattern(self.sample_rate, 0.225);
            arp_id = voice.graph.add_node(Box::new(arp));
            gate_mixer_id = voice.graph.global_gatemixer_node.unwrap();
        }
        self.connect_nodes(
            arp_id.0,
            PortId::ArpGate,
            gate_mixer_id.0,
            PortId::ArpGate,
            1.0,
            Some(WasmModulationType::VCA),
            ModulationTransformation::None,
        )
        .unwrap();
        Ok(JsValue::from(arp_id.0))
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn create_mixer(&mut self) -> Result<JsValue, JsValue> {
        let mut mixer_id = NodeId(0);
        for voice in &mut self.voices {
            mixer_id = voice.graph.add_node(Box::new(Mixer::new()));
            voice.graph.set_output_node(mixer_id);
        }
        // Just return the ID directly like other nodes
        Ok(JsValue::from(mixer_id.0))
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn create_lfo(&mut self) -> Result<JsValue, JsValue> {
        let mut lfo_id = NodeId(0);
        for voice in &mut self.voices {
            lfo_id = voice.graph.add_node(Box::new(Lfo::new(self.sample_rate)));
        }
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &"lfoId".into(), &(lfo_id.0.into()))?;

        Ok(obj.into())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn create_filter(&mut self) -> Result<usize, JsValue> {
        let mut filter_id = NodeId(0);
        for voice in &mut self.voices {
            filter_id = voice
                .graph
                .add_node(Box::new(FilterCollection::new(self.sample_rate)));
        }
        Ok(filter_id.0)
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn create_noise(&mut self) -> Result<usize, JsValue> {
        let mut noise_id = NodeId(0);
        for voice in &mut self.voices {
            noise_id = voice
                .graph
                .add_node(Box::new(NoiseGenerator::new(self.sample_rate)));
        }
        Ok(noise_id.0)
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn create_oscillator(&mut self) -> Result<usize, JsValue> {
        let mut osc_id = NodeId(0);
        for voice in &mut self.voices {
            osc_id = voice.graph.add_node(Box::new(AnalogOscillator::new(
                self.sample_rate,
                Waveform::Sine,
                self.wavetable_banks.clone(), // pass the shared banks
            )));
        }
        Ok(osc_id.0)
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn create_wavetable_oscillator(&mut self) -> Result<usize, JsValue> {
        let mut osc_id = NodeId(0);
        for voice in &mut self.voices {
            osc_id = voice.graph.add_node(Box::new(WavetableOscillator::new(
                self.sample_rate,
                self.wavetable_synthbank.clone(),
            )));
        }
        Ok(osc_id.0)
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn create_sampler(&mut self) -> Result<usize, JsValue> {
        let sample_data = Rc::new(RefCell::new(SampleData::new()));
        let mut sampler_id = NodeId(0);
        for voice in &mut self.voices {
            let mut sampler = Sampler::new(self.sample_rate);
            sampler.set_sample_data(sample_data.clone());
            sampler_id = voice.graph.add_node(Box::new(sampler));
        }
        Ok(sampler_id.0)
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn import_sample(&mut self, sampler_id: usize, data: &[u8]) -> Result<(), JsValue> {
        use std::io::Cursor;

        log_console("Starting import_sample");

        // Create a hound reader from the data
        let cursor = Cursor::new(data);
        let mut reader =
            hound::WavReader::new(cursor).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let spec = reader.spec();
        log_console(&format!(
            "WAV spec: sample_rate={}, channels={}, bits_per_sample={}, sample_format={:?}",
            spec.sample_rate, spec.channels, spec.bits_per_sample, spec.sample_format
        ));

        // Read the samples in f32 form
        let samples: Vec<f32> = match (spec.bits_per_sample, spec.sample_format) {
            (32, hound::SampleFormat::Float) => {
                reader.samples::<f32>().map(|s| s.unwrap()).collect()
            }
            (16, hound::SampleFormat::Int) => reader
                .samples::<i16>()
                .map(|s| s.unwrap() as f32 / i16::MAX as f32)
                .collect(),
            (24, hound::SampleFormat::Int) => {
                let shift = 32 - 24;
                reader
                    .samples::<i32>()
                    .map(|s| (s.unwrap() << shift >> shift) as f32 / 8_388_607.0)
                    .collect()
            }
            (32, hound::SampleFormat::Int) => reader
                .samples::<i32>()
                .map(|s| s.unwrap() as f32 / i32::MAX as f32)
                .collect(),
            (bits, format) => {
                return Err(JsValue::from_str(&format!(
                    "Unsupported WAV format: bits_per_sample={} sample_format={:?}",
                    bits, format
                )))
            }
        };

        log_console(&format!("Read {} samples", samples.len()));

        // Create new sample data
        let sample_data = Rc::new(RefCell::new(SampleData::new()));
        sample_data.borrow_mut().load_from_wav(
            samples,
            spec.channels as usize,
            spec.sample_rate as f32,
        );

        // Update all sampler nodes with the new sample data
        for voice in &mut self.voices {
            if let Some(node) = voice.graph.get_node_mut(NodeId(sampler_id)) {
                if let Some(sampler) = node.as_any_mut().downcast_mut::<Sampler>() {
                    sampler.set_sample_data(sample_data.clone());
                } else {
                    return Err(JsValue::from_str("Node is not a Sampler"));
                }
            } else {
                return Err(JsValue::from_str("Node not found"));
            }
        }

        log_console("Sample imported successfully");
        Ok(())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn update_sampler(
        &mut self,
        sampler_id: usize,
        frequency: f32,
        gain: f32,
        loop_mode: u8,
        loop_start: f32,
        loop_end: f32,
        root_note: f32,
    ) -> Result<(), JsValue> {
        let loop_mode = match loop_mode {
            0 => SamplerLoopMode::Off,
            1 => SamplerLoopMode::Loop,
            2 => SamplerLoopMode::PingPong,
            _ => SamplerLoopMode::Off,
        };

        for voice in &mut self.voices {
            if let Some(node) = voice.graph.get_node_mut(NodeId(sampler_id)) {
                if let Some(sampler) = node.as_any_mut().downcast_mut::<Sampler>() {
                    sampler.set_base_frequency(frequency);
                    sampler.set_base_gain(gain);
                    sampler.set_loop_mode(loop_mode);
                    sampler.set_loop_start(loop_start);
                    sampler.set_loop_end(loop_end);
                    sampler.set_root_note(root_note);
                } else {
                    return Err(JsValue::from_str("Node is not a Sampler"));
                }
            } else {
                return Err(JsValue::from_str("Node not found"));
            }
        }
        Ok(())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn update_filters(
        &mut self,
        filter_id: usize,
        cutoff: f32,
        resonance: f32,
        gain: f32,
        key_tracking: f32,
        comb_frequency: f32,
        comb_dampening: f32,
        _oversampling: u32,
        filter_type: FilterType,
        filter_slope: FilterSlope,
    ) -> Result<(), JsValue> {
        for voice in &mut self.voices {
            if let Some(node) = voice.graph.get_node_mut(NodeId(filter_id)) {
                if let Some(filter) = node.as_any_mut().downcast_mut::<FilterCollection>() {
                    filter.set_filter_type(filter_type);
                    filter.set_filter_slope(filter_slope);
                    //if (cutoff > 0.01) {
                    filter.set_params(cutoff, resonance);
                    //} else {
                    //filter.set_params(comb_frequency, resonance);
                    //}
                    filter.set_comb_target_frequency(comb_frequency);
                    filter.set_comb_dampening(comb_dampening);
                    filter.set_gain_db(gain * 24.0 - 12.0);
                    //log key_tracking
                    log_console(&format!("key_tracking is {}", key_tracking));
                    filter.set_keyboard_tracking_sensitivity(key_tracking);
                    //filter.set_oversampling_factor(oversampling);
                } else {
                    return Err(JsValue::from_str("Node is not a Filter"));
                }
            } else {
                return Err(JsValue::from_str("Node not found"));
            }
        }
        Ok(())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn get_filter_ir_waveform(
        &mut self,
        node_id: usize,
        waveform_length: usize,
    ) -> Result<Vec<f32>, JsValue> {
        for voice in &mut self.voices {
            if let Some(node) = voice.graph.get_node_mut(NodeId(node_id)) {
                if let Some(filter) = node.as_any_mut().downcast_mut::<FilterCollection>() {
                    return Ok(filter.generate_frequency_response(waveform_length));
                } else {
                    return Err(JsValue::from_str("Node is not a Filter"));
                }
            } else {
                return Err(JsValue::from_str("Node not found"));
            }
        }
        Ok(vec![])
    }

    /// Update all LFOs across all   voices. This is called by the host when the user
    /// changes an LFO's settings.
    pub fn update_lfos(&mut self, params: LfoUpdateParams) {
        for voice in &mut self.voices {
            if let Some(node) = voice.graph.get_node_mut(NodeId(params.lfo_id)) {
                if let Some(lfo) = node.as_any_mut().downcast_mut::<Lfo>() {
                    // Convert u8 to LfoWaveform
                    //log_console(&format!("waveform is {}", params.waveform));
                    let waveform = match params.waveform {
                        0 => LfoWaveform::Sine,
                        1 => LfoWaveform::Triangle,
                        2 => LfoWaveform::Square,
                        3 => LfoWaveform::Saw,
                        4 => LfoWaveform::InverseSaw,
                        _ => LfoWaveform::Sine,
                    };

                    let loopmode = match params.loop_mode {
                        0 => LfoLoopMode::Off,
                        1 => LfoLoopMode::Loop,
                        2 => LfoLoopMode::PingPong,
                        _ => LfoLoopMode::Off,
                    };

                    lfo.set_gain(params.gain);
                    lfo.set_phase_offset(params.phase_offset);
                    lfo.set_frequency(params.frequency);
                    lfo.set_waveform(waveform);
                    lfo.set_use_absolute(params.use_absolute);
                    lfo.set_use_normalized(params.use_normalized);
                    lfo.set_retrigger_mode(LfoRetriggerMode::from_u8(params.trigger_mode));
                    lfo.set_active(params.active);
                    lfo.set_loop_mode(loopmode);
                    lfo.set_loop_start(params.loop_start);
                    lfo.set_loop_end(params.loop_end);
                }
            }
        }
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn get_lfo_waveform(
        &mut self,
        waveform: u8,
        phase_offset: f32,
        frequency: f32,
        buffer_size: usize,
        use_absolute: bool,
        use_normalized: bool,
    ) -> Result<Vec<f32>, JsValue> {
        let waveform = match waveform {
            0 => LfoWaveform::Sine,
            1 => LfoWaveform::Triangle,
            2 => LfoWaveform::Square,
            3 => LfoWaveform::Saw,
            4 => LfoWaveform::InverseSaw,
            _ => return Err(JsValue::from_str("Invalid waveform type")),
        };

        Ok(Lfo::get_waveform_data(
            waveform,
            phase_offset,
            frequency,
            buffer_size,
            use_absolute,
            use_normalized,
        ))
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn connect_nodes(
        &mut self,
        from_node: usize,
        from_port: PortId,
        to_node: usize,
        to_port: PortId,
        amount: f32,
        modulation_type: Option<WasmModulationType>,
        modulation_transform: ModulationTransformation,
    ) -> Result<(), JsValue> {
        // console::log_1(
        //     &format!(
        //         "RUST: Connecting nodes: from={}, to={}, modulation type={:?}",
        //         from_node, to_node, modulation_type
        //     )
        //     .into(),
        // );
        let connection = Connection {
            from_node: NodeId(from_node),
            from_port,
            to_node: NodeId(to_node),
            to_port,
            amount,
            modulation_type: modulation_type
                .map(ModulationType::from)
                .unwrap_or_default(),
            modulation_transform,
        };

        for voice in &mut self.voices {
            voice.graph.add_connection(connection.clone());
        }
        Ok(())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn remove_specific_connection(
        &mut self,
        from_node: usize,
        to_node: usize,
        to_port: PortId,
    ) -> Result<(), JsValue> {
        log_console(&format!(
            "Removing connection: from={}, to={}, port={:?}",
            from_node, to_node, to_port
        ));

        for voice in &mut self.voices {
            voice
                .graph
                .remove_specific_connection(NodeId(from_node), NodeId(to_node), to_port);
        }

        Ok(())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn connect_macro(
        &mut self,
        voice_index: usize,
        macro_index: usize,
        target_node: usize,
        target_port: PortId,
        amount: f32,
    ) -> Result<(), JsValue> {
        log_console(&format!(
            "Connecting macro: voice={}, macro={}, node={}, port={:?}, amount={}",
            voice_index, macro_index, target_node, target_port, amount
        ));

        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;

        voice
            .add_macro_modulation(macro_index, NodeId(target_node), target_port, amount)
            .map_err(|e| JsValue::from_str(&e))
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen)]
    pub fn reset(&mut self) {
        // Clear all voices
        for voice in &mut self.voices {
            voice.clear();
        }
    }
}
