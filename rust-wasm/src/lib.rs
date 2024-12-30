#![feature(portable_simd)]

mod audio;
mod graph;
mod macros;
mod nodes;
mod processing;
mod traits;
mod utils;
mod voice;

pub use graph::AudioGraph;
pub use graph::{Connection, ConnectionId, NodeId};
pub use macros::{MacroManager, ModulationTarget};
pub use nodes::{Envelope, EnvelopeConfig, ModulatableOscillator, OscillatorStateUpdate};
use nodes::{Lfo, LfoTriggerMode, LfoWaveform};
use serde::Serialize;
pub use traits::{AudioNode, PortId};
pub use utils::*;
pub use voice::Voice;

use wasm_bindgen::prelude::*;
use web_sys::{console, js_sys};

#[wasm_bindgen]
pub struct AudioEngine {
    voices: Vec<Voice>,
    sample_rate: f32,
    num_voices: usize,
    envelope_config: EnvelopeConfig,
}

#[wasm_bindgen]
pub struct LfoUpdateParams {
    pub lfo_id: usize,
    pub frequency: f32,
    pub waveform: u8,
    pub use_absolute: bool,
    pub use_normalized: bool,
    pub trigger_mode: u8,
    pub active: bool, // Add this field
}

#[derive(Serialize)]
struct EngineState {
    voices: Vec<VoiceState>,
}

#[derive(Serialize)]
struct VoiceState {
    id: usize,
    nodes: Vec<NodeState>,
    connections: Vec<ConnectionState>,
}

#[derive(Serialize)]
struct NodeState {
    id: usize,
    node_type: String,
}

#[derive(Serialize)]
struct ConnectionState {
    from_id: usize,
    to_id: usize,
    target: u32,
    amount: f32,
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
        active: bool, // Add this parameter
    ) -> LfoUpdateParams {
        LfoUpdateParams {
            lfo_id,
            frequency,
            waveform,
            use_absolute,
            use_normalized,
            trigger_mode,
            active,
        }
    }
}

impl Default for AudioEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl AudioEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let num_voices = 8;
        let sample_rate = 44100.0;
        let envelope_config = EnvelopeConfig::default();

        Self {
            voices: Vec::new(),
            sample_rate,
            num_voices,
            envelope_config,
        }
    }

    #[wasm_bindgen]
    pub fn init(&mut self, sample_rate: f32, num_voices: usize) {
        self.sample_rate = sample_rate;
        self.num_voices = num_voices;

        self.voices = (0..num_voices).map(Voice::new).collect();
    }

    #[wasm_bindgen]
    pub fn remove_voice_connection(
        &mut self,
        voice_index: usize,
        from_node: usize,
        from_port: PortId,
        to_node: usize,
        to_port: PortId,
    ) -> Result<(), JsValue> {
        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;

        voice.graph.remove_connection(&Connection {
            from_node: NodeId(from_node),
            from_port,
            to_node: NodeId(to_node),
            to_port,
            amount: 0.0, // The amount doesn't matter for removal
        });

        Ok(())
    }

    #[wasm_bindgen]
    pub fn get_current_state(&self) -> JsValue {
        let voices: Vec<VoiceState> = self
            .voices
            .iter()
            .enumerate()
            .map(|(i, voice)| {
                let nodes: Vec<NodeState> = voice
                    .graph
                    .nodes
                    .iter()
                    .enumerate()
                    .map(|(ni, node)| {
                        let node_type = if node
                            .as_any()
                            .downcast_ref::<ModulatableOscillator>()
                            .is_some()
                        {
                            "oscillator".to_string()
                        } else if node.as_any().downcast_ref::<Envelope>().is_some() {
                            "envelope".to_string()
                        } else if node.as_any().downcast_ref::<Lfo>().is_some() {
                            "lfo".to_string()
                        } else {
                            "unknown".to_string()
                        };

                        NodeState { id: ni, node_type }
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
                    })
                    .collect();

                VoiceState {
                    id: i,
                    nodes,
                    connections,
                }
            })
            .collect();

        let engine_state = EngineState { voices };
        serde_wasm_bindgen::to_value(&engine_state).unwrap()
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
    pub fn initialize_voice(
        &mut self,
        voice_index: usize,
        num_oscillators: usize,
    ) -> Result<JsValue, JsValue> {
        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;

        // Create oscillators
        let mut oscillator_ids = Vec::new();
        for _ in 0..num_oscillators {
            let osc_id = voice.add_oscillator(self.sample_rate);
            oscillator_ids.push(osc_id.0); // Already using .0 here
        }

        // Create envelope
        let envelope_id = voice.graph.add_node(Box::new(Envelope::new(
            self.sample_rate,
            EnvelopeConfig::default(),
        )));
        voice.envelope = envelope_id;

        // Set the first oscillator as the initial output node
        if !oscillator_ids.is_empty() {
            voice.set_output_node(NodeId(oscillator_ids[0]));
        }

        // Create return object with all IDs
        let obj = js_sys::Object::new();

        // Add oscillator IDs
        let oscillators_array = js_sys::Array::new();
        for id in oscillator_ids {
            oscillators_array.push(&JsValue::from(id));
        }
        js_sys::Reflect::set(&obj, &"oscillatorIds".into(), &oscillators_array)?;

        // Add envelope ID - get the inner value
        js_sys::Reflect::set(&obj, &"envelopeId".into(), &JsValue::from(envelope_id.0))?;

        Ok(obj.into())
    }

    #[wasm_bindgen]
    pub fn create_envelope(&mut self, voice_index: usize) -> Result<JsValue, JsValue> {
        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;

        let envelope_id = voice.graph.add_node(Box::new(Envelope::new(
            self.sample_rate,
            EnvelopeConfig::default(),
        )));

        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &"envelopeId".into(), &(envelope_id.0.into()))?;

        Ok(obj.into())
    }

    #[wasm_bindgen]
    pub fn update_envelope(
        &mut self,
        voice_index: usize,
        node_id: usize,
        attack: f32,
        decay: f32,
        sustain: f32,
        release: f32,
        active: bool,
    ) -> Result<(), JsValue> {
        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;

        if let Some(node) = voice.graph.get_node_mut(NodeId(node_id)) {
            if let Some(env) = node.as_any_mut().downcast_mut::<Envelope>() {
                let config = EnvelopeConfig {
                    attack,
                    decay,
                    sustain,
                    release,
                    ..Default::default()
                };
                env.update_config(config);
                env.set_active(active);
                Ok(())
            } else {
                Err(JsValue::from_str("Node is not an Envelope"))
            }
        } else {
            Err(JsValue::from_str("Node not found"))
        }
    }

    #[wasm_bindgen]
    pub fn update_oscillator(
        &mut self,
        voice_index: usize,
        oscillator_id: usize,
        params: &OscillatorStateUpdate,
    ) -> Result<(), JsValue> {
        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;

        if let Some(node) = voice.graph.get_node_mut(NodeId(oscillator_id)) {
            if let Some(osc) = node.as_any_mut().downcast_mut::<ModulatableOscillator>() {
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
    pub fn create_lfo(&mut self, voice_index: usize) -> Result<JsValue, JsValue> {
        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;

        let lfo_id = voice.graph.add_node(Box::new(Lfo::new(self.sample_rate)));

        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &"lfoId".into(), &(lfo_id.0.into()))?;

        Ok(obj.into())
    }

    pub fn update_lfo(
        &mut self,
        voice_index: usize,
        params: LfoUpdateParams,
    ) -> Result<(), JsValue> {
        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;

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

                lfo.set_frequency(params.frequency);
                lfo.set_waveform(waveform);
                lfo.set_use_absolute(params.use_absolute);
                lfo.set_use_normalized(params.use_normalized);
                lfo.set_trigger_mode(LfoTriggerMode::from_u8(params.trigger_mode));
                lfo.set_active(params.active);
                Ok(())
            } else {
                Err(JsValue::from_str("Node is not an LFO"))
            }
        } else {
            Err(JsValue::from_str("Node not found"))
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
    pub fn connect_voice_nodes(
        &mut self,
        voice_index: usize,
        from_node: usize,
        from_port: PortId,
        to_node: usize,
        to_port: PortId,
        amount: f32,
    ) -> Result<(), JsValue> {
        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;
        console::log_1(&format!("(wasm) Connecting voice {:?}", voice_index).into());
        voice.graph.connect(Connection {
            from_node: NodeId(from_node),
            from_port,
            to_node: NodeId(to_node),
            to_port,
            amount,
        });

        Ok(())
    }

    #[wasm_bindgen]
    pub fn remove_specific_connection(
        &mut self,
        voice_index: usize,
        from_node: usize,
        from_port: PortId,
        to_node: usize,
        to_port: PortId,
    ) -> Result<(), JsValue> {
        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;

        voice.graph.remove_specific_connection(
            NodeId(from_node),
            from_port,
            NodeId(to_node),
            to_port,
        );

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

    pub fn connect_nodes(
        &mut self,
        voice_index: usize,
        from_node: usize,
        from_port: PortId,
        to_node: usize,
        to_port: PortId,
        amount: f32,
    ) -> Result<(), JsValue> {
        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;

        voice.graph.connect(Connection {
            from_node: NodeId(from_node),
            from_port,
            to_node: NodeId(to_node),
            to_port,
            amount,
        });

        Ok(())
    }

    pub fn add_oscillator(&mut self, voice_index: usize) -> Result<usize, JsValue> {
        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;

        let osc_id = voice
            .graph
            .add_node(Box::new(ModulatableOscillator::new(self.sample_rate)));

        Ok(osc_id.0)
    }

    #[wasm_bindgen]
    pub fn reset(&mut self) {
        // Clear all voices
        for voice in &mut self.voices {
            voice.clear();
        }
    }
}
