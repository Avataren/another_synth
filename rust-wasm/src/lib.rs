#![feature(portable_simd)]

mod audio;
mod graph;
mod macros;
mod nodes;
mod processing;
mod traits;
mod utils;
mod voice;

use std::rc::Rc;
use std::{collections::HashMap, sync::Arc};

pub use graph::AudioGraph;
use graph::ModulationType;
pub use graph::{Connection, ConnectionId, NodeId};
pub use macros::{MacroManager, ModulationTarget};
use nodes::morph_wavetable::{self, WavetableSynthBank};
use nodes::{
    AnalogOscillator, AnalogOscillatorStateUpdate, Lfo, LfoTriggerMode, LfoWaveform, LpFilter,
    Mixer, NoiseGenerator, NoiseType, NoiseUpdate, Waveform, WavetableBank, WavetableOscillator,
};
pub use nodes::{Envelope, EnvelopeConfig, ModulatableOscillator, OscillatorStateUpdate};
use serde::Deserialize;
use serde::Serialize;
pub use traits::{AudioNode, PortId};
pub use utils::*;
pub use voice::Voice;

use wasm_bindgen::prelude::*;
use web_sys::{console, js_sys};

#[wasm_bindgen]
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
    id: Option<u32>,
    active: bool,
    attack: f32,
    decay: f32,
    sustain: f32,
    release: f32,
    attackCurve: f32,
    decayCurve: f32,
    releaseCurve: f32,
}
impl From<JsEnvelopeConfig> for EnvelopeConfig {
    fn from(js_conf: JsEnvelopeConfig) -> Self {
        EnvelopeConfig {
            attack: js_conf.attack,
            decay: js_conf.decay,
            sustain: js_conf.sustain,
            release: js_conf.release,
            attack_curve: js_conf.attackCurve,
            decay_curve: js_conf.decayCurve,
            release_curve: js_conf.releaseCurve,
            attack_smoothing_samples: 16, // a sensible default
            active: js_conf.active,
        }
    }
}

#[wasm_bindgen]
pub struct NoiseUpdateParams {
    pub noise_type: WasmNoiseType,
    pub cutoff: f32,
    pub gain: f32,
    pub enabled: bool,
}

#[wasm_bindgen]
impl NoiseUpdateParams {
    #[wasm_bindgen(constructor)]
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
#[wasm_bindgen]
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

#[wasm_bindgen]
pub struct AudioEngine {
    voices: Vec<Voice>,
    sample_rate: f32,
    num_voices: usize,
    wavetable_synthbank: Rc<WavetableSynthBank>,
    wavetable_banks: Arc<HashMap<Waveform, Arc<WavetableBank>>>,
}

#[wasm_bindgen]
pub struct LfoUpdateParams {
    pub lfo_id: usize,
    pub frequency: f32,
    pub waveform: u8,
    pub use_absolute: bool,
    pub use_normalized: bool,
    pub trigger_mode: u8,
    pub gain: f32,
    pub active: bool,
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
}

#[wasm_bindgen]
impl LfoUpdateParams {
    #[wasm_bindgen(constructor)]
    pub fn new(
        lfo_id: usize,
        frequency: f32,
        waveform: u8,
        use_absolute: bool,
        use_normalized: bool,
        trigger_mode: u8,
        gain: f32,
        active: bool,
    ) -> LfoUpdateParams {
        LfoUpdateParams {
            lfo_id,
            frequency,
            waveform,
            use_absolute,
            use_normalized,
            trigger_mode,
            gain,
            active,
        }
    }
}

#[wasm_bindgen]
impl AudioEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let num_voices = 8;

        // Create the wavetable banks using the actual sample_rate.
        let max_table_size = 2048;
        let min_table_size = 64;
        let lowest_top_freq_hz = 20.0;
        let wavetable_synthbank = Rc::new(WavetableSynthBank::new());
        let mut banks = HashMap::new();
        banks.insert(
            Waveform::Sine,
            Arc::new(WavetableBank::new(
                Waveform::Sine,
                max_table_size,
                min_table_size,
                lowest_top_freq_hz,
                sample_rate,
            )),
        );
        banks.insert(
            Waveform::Saw,
            Arc::new(WavetableBank::new(
                Waveform::Saw,
                max_table_size,
                min_table_size,
                lowest_top_freq_hz,
                sample_rate,
            )),
        );
        banks.insert(
            Waveform::Square,
            Arc::new(WavetableBank::new(
                Waveform::Square,
                max_table_size,
                min_table_size,
                lowest_top_freq_hz,
                sample_rate,
            )),
        );
        banks.insert(
            Waveform::Triangle,
            Arc::new(WavetableBank::new(
                Waveform::Triangle,
                max_table_size,
                min_table_size,
                lowest_top_freq_hz,
                sample_rate,
            )),
        );

        Self {
            voices: Vec::new(),
            sample_rate,
            num_voices,
            wavetable_synthbank,
            wavetable_banks: Arc::new(banks),
        }
    }

    #[wasm_bindgen]
    pub fn init(&mut self, sample_rate: f32, num_voices: usize) {
        self.sample_rate = sample_rate;
        self.num_voices = num_voices;

        self.voices = (0..num_voices).map(Voice::new).collect();
    }

    #[wasm_bindgen]
    pub fn remove_connection(
        &mut self,
        from_node: usize,
        from_port: PortId,
        to_node: usize,
        to_port: PortId,
    ) -> Result<(), JsValue> {
        for (i, voice) in self.voices.iter_mut().enumerate() {
            voice.graph.remove_connection(&Connection {
                from_node: NodeId(from_node),
                from_port,
                to_node: NodeId(to_node),
                to_port,
                amount: 0.0, // The amount doesn't matter for removal
                modulation_type: ModulationType::VCA, // neither does modulation_type
            });
        }
        Ok(())
    }

    #[wasm_bindgen]
    pub fn get_current_state(&self) -> JsValue {
        // Use voice 0 as the canonical layout.
        if let Some(voice) = self.voices.get(0) {
            // Here we assume that the nodes vector was built by add_node
            // so the index matches the node's id.
            let nodes: Vec<NodeState> = voice
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
                        ModulationType::Additive | _ => WasmModulationType::Additive,
                    },
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

    #[wasm_bindgen]
    pub fn process_audio(
        &mut self,
        gates: &[f32],
        frequencies: &[f32],
        gains: &[f32],
        macro_values: &[f32],
        master_gain: f32,
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) {
        output_left.fill(0.0);
        output_right.fill(0.0);

        let mut voice_left = vec![0.0; output_left.len()];
        let mut voice_right = vec![0.0; output_right.len()];

        for (i, voice) in self.voices.iter_mut().enumerate() {
            let gate = gates.get(i).copied().unwrap_or(0.0);
            let frequency = frequencies.get(i).copied().unwrap_or(440.0);
            let gain = gains.get(i).copied().unwrap_or(1.0);

            // Update macro values
            for macro_idx in 0..4 {
                let macro_start = i * 4 * 128 + (macro_idx * 128);
                if macro_start + 128 <= macro_values.len() {
                    let values = &macro_values[macro_start..macro_start + 128];
                    let _ = voice.update_macro(macro_idx, values);
                }
            }

            // Update voice parameters
            voice.current_gate = gate;
            voice.current_frequency = frequency;

            // Skip if voice is inactive and no new gate
            if !voice.is_active() && gate <= 0.0 {
                continue;
            }

            voice_left.fill(0.0);
            voice_right.fill(0.0);

            // Process voice and update its state
            voice.process_audio(&mut voice_left, &mut voice_right);
            voice.update_active_state();

            // Mix if voice has gate or is still active
            if gate > 0.0 || voice.is_active() {
                for (i, (left, right)) in voice_left.iter().zip(voice_right.iter()).enumerate() {
                    output_left[i] += left * gain;
                    output_right[i] += right * gain;
                }
            }
        }

        // Apply master gain
        if master_gain != 1.0 {
            for sample in output_left.iter_mut() {
                *sample *= master_gain;
            }
            for sample in output_right.iter_mut() {
                *sample *= master_gain;
            }
        }
    }

    #[wasm_bindgen]
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
                        cutoff: params.cutoff,
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

    #[wasm_bindgen]
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
        console::log_1(
            &format!(
                "RUST: envelope curves: attack_curve={}, decay_curve={}, release_curve={}",
                attack_curve, decay_curve, release_curve
            )
            .into(),
        );

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

    #[wasm_bindgen]
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

    #[wasm_bindgen]
    pub fn update_oscillator(
        &mut self,
        voice_index: usize,
        oscillator_id: usize,
        params: &AnalogOscillatorStateUpdate,
    ) -> Result<(), JsValue> {
        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;

        if let Some(node) = voice.graph.get_node_mut(NodeId(oscillator_id)) {
            if let Some(osc) = node.as_any_mut().downcast_mut::<AnalogOscillator>() {
                osc.update_params(params);
                Ok(())
            } else {
                Err(JsValue::from_str("Node is not an Oscillator"))
            }
        } else {
            Err(JsValue::from_str("Node not found"))
        }
    }

    #[wasm_bindgen]
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

    #[wasm_bindgen]
    pub fn create_mixer(&mut self) -> Result<JsValue, JsValue> {
        let mut mixer_id = NodeId(0);
        for voice in &mut self.voices {
            mixer_id = voice.graph.add_node(Box::new(Mixer::new()));
            voice.graph.set_output_node(mixer_id);
        }
        // Just return the ID directly like other nodes
        Ok(JsValue::from(mixer_id.0))
    }

    #[wasm_bindgen]
    pub fn create_lfo(&mut self) -> Result<JsValue, JsValue> {
        let mut lfo_id = NodeId(0);
        for voice in &mut self.voices {
            lfo_id = voice.graph.add_node(Box::new(Lfo::new(self.sample_rate)));
        }
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &"lfoId".into(), &(lfo_id.0.into()))?;

        Ok(obj.into())
    }

    #[wasm_bindgen]
    pub fn create_filter(&mut self) -> Result<usize, JsValue> {
        let mut filter_id = NodeId(0);
        for voice in &mut self.voices {
            filter_id = voice
                .graph
                .add_node(Box::new(LpFilter::new(self.sample_rate)));
        }
        Ok(filter_id.0)
    }

    #[wasm_bindgen]
    pub fn create_noise(&mut self) -> Result<usize, JsValue> {
        let mut noise_id = NodeId(0);
        for voice in &mut self.voices {
            noise_id = voice
                .graph
                .add_node(Box::new(NoiseGenerator::new(self.sample_rate)));
        }
        Ok(noise_id.0)
    }

    #[wasm_bindgen]
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

    #[wasm_bindgen]
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

    #[wasm_bindgen]
    pub fn update_filters(
        &mut self,
        filter_id: usize,
        cutoff: f32,
        resonance: f32,
    ) -> Result<(), JsValue> {
        for voice in &mut self.voices {
            if let Some(node) = voice.graph.get_node_mut(NodeId(filter_id)) {
                if let Some(filter) = node.as_any_mut().downcast_mut::<LpFilter>() {
                    filter.set_params(cutoff, resonance);
                } else {
                    return Err(JsValue::from_str("Node is not a Filter"));
                }
            } else {
                return Err(JsValue::from_str("Node not found"));
            }
        }
        Ok(())
    }

    /// Update all LFOs across all   voices. This is called by the host when the user
    /// changes an LFO's settings.
    pub fn update_lfos(&mut self, params: LfoUpdateParams) {
        for voice in &mut self.voices {
            if let Some(node) = voice.graph.get_node_mut(NodeId(params.lfo_id)) {
                if let Some(lfo) = node.as_any_mut().downcast_mut::<Lfo>() {
                    // Convert u8 to LfoWaveform
                    let waveform = match params.waveform {
                        0 => LfoWaveform::Sine,
                        1 => LfoWaveform::Triangle,
                        2 => LfoWaveform::Square,
                        3 => LfoWaveform::Saw,
                        _ => LfoWaveform::Sine,
                    };

                    lfo.set_gain(params.gain);
                    lfo.set_frequency(params.frequency);
                    lfo.set_waveform(waveform);
                    lfo.set_use_absolute(params.use_absolute);
                    lfo.set_use_normalized(params.use_normalized);
                    lfo.set_trigger_mode(LfoTriggerMode::from_u8(params.trigger_mode));
                    lfo.set_active(params.active);
                }
            }
        }
    }

    #[wasm_bindgen]
    pub fn get_lfo_waveform(
        &mut self,
        waveform: u8,
        buffer_size: usize,
    ) -> Result<Vec<f32>, JsValue> {
        let waveform = match waveform {
            0 => LfoWaveform::Sine,
            1 => LfoWaveform::Triangle,
            2 => LfoWaveform::Square,
            3 => LfoWaveform::Saw,
            _ => return Err(JsValue::from_str("Invalid waveform type")),
        };

        Ok(Lfo::get_waveform_data(waveform, buffer_size))
    }

    #[wasm_bindgen]
    pub fn connect_nodes(
        &mut self,
        from_node: usize,
        from_port: PortId,
        to_node: usize,
        to_port: PortId,
        amount: f32,
        modulation_type: Option<WasmModulationType>,
    ) -> Result<(), JsValue> {
        console::log_1(
            &format!(
                "RUST: Connecting nodes: from={}, to={}, modulation type={:?}",
                from_node, to_node, modulation_type
            )
            .into(),
        );
        let connection = Connection {
            from_node: NodeId(from_node),
            from_port,
            to_node: NodeId(to_node),
            to_port,
            amount,
            modulation_type: modulation_type
                .map(ModulationType::from)
                .unwrap_or_default(),
        };

        for voice in &mut self.voices {
            voice.graph.add_connection(connection.clone());
        }
        Ok(())
    }

    #[wasm_bindgen]
    pub fn remove_specific_connection(
        &mut self,
        from_node: usize,
        to_node: usize,
        to_port: PortId,
    ) -> Result<(), JsValue> {
        console::log_1(
            &format!(
                "Removing connection: from={}, to={}, port={:?}",
                from_node, to_node, to_port
            )
            .into(),
        );

        for voice in &mut self.voices {
            voice
                .graph
                .remove_specific_connection(NodeId(from_node), NodeId(to_node), to_port);
        }

        Ok(())
    }

    #[wasm_bindgen]
    pub fn connect_macro(
        &mut self,
        voice_index: usize,
        macro_index: usize,
        target_node: usize,
        target_port: PortId,
        amount: f32,
    ) -> Result<(), JsValue> {
        console::log_1(
            &format!(
                "Connecting macro: voice={}, macro={}, node={}, port={:?}, amount={}",
                voice_index, macro_index, target_node, target_port, amount
            )
            .into(),
        );

        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;

        voice
            .add_macro_modulation(macro_index, NodeId(target_node), target_port, amount)
            .map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn reset(&mut self) {
        // Clear all voices
        for voice in &mut self.voices {
            voice.clear();
        }
    }
}
