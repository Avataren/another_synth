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
pub use nodes::EnvelopeConfig;
pub use nodes::{Envelope, ModulatableOscillator};
pub use traits::{AudioNode, PortId};
pub use utils::*;
pub use voice::Voice;

use wasm_bindgen::prelude::*;
use web_sys::{console, js_sys};

#[wasm_bindgen]
pub struct AudioProcessor {
    voices: Vec<Voice>,
    sample_rate: f32,
    num_voices: usize,
    envelope_config: EnvelopeConfig,
}

#[wasm_bindgen]
impl AudioProcessor {
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

        self.voices = (0..num_voices)
            .map(|id| Voice::new(id, sample_rate))
            .collect();
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
    pub fn create_fm_voice(&mut self, voice_index: usize) -> Result<JsValue, JsValue> {
        let voice = self
            .voices
            .get_mut(voice_index)
            .ok_or_else(|| JsValue::from_str("Invalid voice index"))?;

        let carrier_id = voice
            .graph
            .add_node(Box::new(ModulatableOscillator::new(self.sample_rate)));

        let modulator_id = voice
            .graph
            .add_node(Box::new(ModulatableOscillator::new(self.sample_rate)));

        let envelope_id = voice.graph.add_node(Box::new(Envelope::new(
            self.sample_rate,
            EnvelopeConfig::default(),
        )));

        // Set the carrier as the output node
        voice.output_node = carrier_id;

        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &"carrierId".into(), &(carrier_id.0.into()))?;
        js_sys::Reflect::set(&obj, &"modulatorId".into(), &(modulator_id.0.into()))?;
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
                Ok(())
            } else {
                Err(JsValue::from_str("Node is not an Envelope"))
            }
        } else {
            Err(JsValue::from_str("Node not found"))
        }
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
}
