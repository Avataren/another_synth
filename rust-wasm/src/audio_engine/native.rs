use crate::automation::AutomationFrame;
use crate::biquad::FilterType;
use crate::effect_stack::EffectStack;
use crate::graph::{Connection, ModulationTransformation, ModulationType};
use crate::impulse_generator::ImpulseResponseGenerator;
use crate::nodes::morph_wavetable::WavetableSynthBank;
use crate::nodes::{
    AnalogOscillator, AnalogOscillatorStateUpdate, Chorus, Convolver, Delay, Envelope,
    EnvelopeConfig, FilterCollection, FilterSlope, Freeverb, Lfo, Limiter, Mixer, Waveform,
    WavetableBank, WavetableOscillator, WavetableOscillatorStateUpdate,
};
//NoiseGenerator, NoiseUpdate,
use crate::traits::{AudioNode, PortId};
use crate::voice::Voice;
use crate::NodeId;
use rustc_hash::FxHashMap;
use std::{cell::RefCell, rc::Rc, sync::Arc, time::Instant};

const DEFAULT_NUM_VOICES: usize = 8;
const MAX_TABLE_SIZE: usize = 2048;
const DEFAULT_BLOCK_SIZE: usize = 128;
const MACRO_COUNT: usize = 4;

pub struct AudioEngine {
    voices: Vec<Voice>,
    sample_rate: f32,
    num_voices: usize,
    wavetable_synthbank: Rc<RefCell<WavetableSynthBank>>,
    wavetable_banks: Arc<FxHashMap<Waveform, Arc<WavetableBank>>>,
    effect_stack: EffectStack,
    ir_generator: ImpulseResponseGenerator,
    cpu_time_accum: f64,
    audio_time_accum: f64,
    last_cpu_usage: f32,
    block_size: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WasmNoiseType {
    White,
    Pink,
    Brownian,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WasmModulationType {
    VCA,
    Bipolar,
    Additive,
}

#[derive(Debug, Clone, Copy)]
pub struct NoiseUpdateParams {
    pub noise_type: WasmNoiseType,
    pub cutoff: f32,
    pub gain: f32,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy)]
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

impl AudioEngine {
    pub fn new(sample_rate: f32, num_voices: usize) -> Self {
        Self::new_with_block_size(sample_rate, num_voices, DEFAULT_BLOCK_SIZE)
    }

    pub fn new_with_block_size(sample_rate: f32, num_voices: usize, block_size: usize) -> Self {
        let block_size = block_size.max(1);
        let wavetable_synthbank = Rc::new(RefCell::new(WavetableSynthBank::new(sample_rate)));

        let mut banks = FxHashMap::default();
        banks.insert(
            Waveform::Sine,
            Arc::new(
                WavetableBank::new(Waveform::Sine, MAX_TABLE_SIZE, sample_rate)
                    .expect("Failed to create Sine wavetable bank"),
            ),
        );
        banks.insert(
            Waveform::Saw,
            Arc::new(
                WavetableBank::new(Waveform::Saw, MAX_TABLE_SIZE, sample_rate)
                    .expect("Failed to create Saw wavetable bank"),
            ),
        );
        banks.insert(
            Waveform::Square,
            Arc::new(
                WavetableBank::new(Waveform::Square, MAX_TABLE_SIZE, sample_rate)
                    .expect("Failed to create Square wavetable bank"),
            ),
        );
        banks.insert(
            Waveform::Triangle,
            Arc::new(
                WavetableBank::new(Waveform::Triangle, MAX_TABLE_SIZE, sample_rate)
                    .expect("Failed to create Triangle wavetable bank"),
            ),
        );

        let initial_voice_count = if num_voices == 0 {
            DEFAULT_NUM_VOICES
        } else {
            num_voices
        };

        Self {
            voices: Vec::new(),
            sample_rate,
            num_voices: initial_voice_count,
            wavetable_synthbank,
            wavetable_banks: Arc::new(banks),
            effect_stack: EffectStack::new(block_size),
            ir_generator: ImpulseResponseGenerator::new(sample_rate),
            cpu_time_accum: 0.0,
            audio_time_accum: 0.0,
            last_cpu_usage: 0.0,
            block_size,
        }
    }

    pub fn init(&mut self, sample_rate: f32, num_voices: usize) {
        let voice_count = if num_voices == 0 {
            DEFAULT_NUM_VOICES
        } else {
            num_voices
        };

        self.sample_rate = sample_rate;
        self.num_voices = voice_count;
        self.voices = (0..voice_count)
            .map(|id| Voice::new(id, self.block_size))
            .collect();

        self.effect_stack = EffectStack::new(self.block_size);
        self.ir_generator = ImpulseResponseGenerator::new(sample_rate);

        let mut chorus = Chorus::new(sample_rate, 65.0, 15.0, 5.0, 0.5, 0.3, 0.5, 90.0);
        chorus.set_active(false);
        self.effect_stack.add_effect(Box::new(chorus));

        let mut delay = Delay::new(sample_rate, 2000.0, 500.0, 0.5, 0.1);
        delay.set_active(false);
        self.effect_stack.add_effect(Box::new(delay));

        let mut reverb = Freeverb::new(sample_rate, 0.95, 0.5, 0.3, 0.7, 1.0);
        reverb.set_active(false);
        self.effect_stack.add_effect(Box::new(reverb));

        let plate_ir = self.ir_generator.plate(2.0, 0.6);
        let partition_size = self.block_size.next_power_of_two().max(32);
        let mut plate = Convolver::new(plate_ir, partition_size, sample_rate);
        plate.set_wet_level(0.1);
        plate.set_enabled(false);
        self.effect_stack.add_effect(Box::new(plate));

        let mut limiter = Limiter::new(sample_rate, -0.5, 0.1, 50.0, 1.5, true);
        limiter.set_active(true);
        self.effect_stack.add_effect(Box::new(limiter));
    }

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
        let voice_macro_span = self.voices.len().saturating_mul(MACRO_COUNT);
        let macro_buffer_len = if voice_macro_span == 0 {
            0
        } else {
            macro_values.len() / voice_macro_span
        };
        self.process_audio_internal(
            gates,
            frequencies,
            gains,
            velocities,
            macro_values,
            macro_buffer_len,
            master_gain,
            output_left,
            output_right,
        );
    }

    fn process_audio_internal(
        &mut self,
        gates: &[f32],
        frequencies: &[f32],
        gains: &[f32],
        velocities: &[f32],
        macro_values: &[f32],
        macro_buffer_len: usize,
        master_gain: f32,
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) {
        // DEBUG: Check what we're actually receiving
        static mut CALL_COUNT: usize = 0;
        unsafe {
            CALL_COUNT += 1;
            if CALL_COUNT % 1000 == 0 {
                eprintln!("ENGINE process_audio_internal call {}:", CALL_COUNT);
                eprintln!(
                    "  output_left.len()={}, output_right.len()={}",
                    output_left.len(),
                    output_right.len()
                );
                eprintln!("  self.block_size={}", self.block_size);
            }
        }

        let start = Instant::now();

        // CRITICAL FIX: Always allocate buffers at the engine's block_size,
        // not the requested output size. This ensures the graph's buffer pool
        // and all node processing work with consistent buffer sizes.
        let mut mix_left = vec![0.0; self.block_size];
        let mut mix_right = vec![0.0; self.block_size];
        let mut voice_left = vec![0.0; self.block_size];
        let mut voice_right = vec![0.0; self.block_size];

        let voice_macro_stride = MACRO_COUNT * macro_buffer_len;

        for (i, voice) in self.voices.iter_mut().enumerate() {
            let gate = gates.get(i).copied().unwrap_or(0.0);
            let frequency = frequencies.get(i).copied().unwrap_or(440.0);
            let gain = gains.get(i).copied().unwrap_or(1.0);
            let velocity = velocities.get(i).copied().unwrap_or(0.0);

            voice.current_gate = gate;
            voice.current_frequency = frequency;
            voice.current_velocity = velocity;

            if macro_buffer_len > 0 {
                for macro_idx in 0..MACRO_COUNT {
                    let macro_start = i * voice_macro_stride + macro_idx * macro_buffer_len;
                    if macro_start + macro_buffer_len <= macro_values.len() {
                        let values = &macro_values[macro_start..macro_start + macro_buffer_len];
                        let _ = voice.update_macro(macro_idx, values);
                    }
                }
            }

            voice_left.fill(0.0);
            voice_right.fill(0.0);

            // Process the full block_size
            voice.process_audio(&mut voice_left, &mut voice_right);

            // Mix voices together
            for (sample_idx, (left, right)) in voice_left.iter().zip(voice_right.iter()).enumerate()
            {
                mix_left[sample_idx] += left * gain;
                mix_right[sample_idx] += right * gain;
            }
        }

        // Process effects with full block_size buffers
        // Allocate temporary output buffers at block_size
        let mut effect_left = vec![0.0; self.block_size];
        let mut effect_right = vec![0.0; self.block_size];

        self.effect_stack
            .process_audio(&mix_left, &mix_right, &mut effect_left, &mut effect_right);

        // Apply master gain
        if master_gain != 1.0 {
            for sample in effect_left.iter_mut() {
                *sample *= master_gain;
            }
            for sample in effect_right.iter_mut() {
                *sample *= master_gain;
            }
        }

        // CRITICAL: Only copy the requested number of samples to the output
        let copy_len = output_left.len().min(self.block_size);
        output_left[..copy_len].copy_from_slice(&effect_left[..copy_len]);
        output_right[..copy_len].copy_from_slice(&effect_right[..copy_len]);

        // Zero any remaining output if output buffers are longer than what we produced
        if copy_len < output_left.len() {
            output_left[copy_len..].fill(0.0);
        }
        if copy_len < output_right.len() {
            output_right[copy_len..].fill(0.0);
        }

        let elapsed_sec = start.elapsed().as_secs_f64();
        let quantum_sec = self.block_size as f64 / self.sample_rate as f64;
        self.cpu_time_accum += elapsed_sec;
        self.audio_time_accum += quantum_sec;
        if self.audio_time_accum >= 0.1 {
            self.last_cpu_usage = ((self.cpu_time_accum / self.audio_time_accum) * 100.0) as f32;
            self.cpu_time_accum = 0.0;
            self.audio_time_accum = 0.0;
        }
    }

    pub fn block_size(&self) -> usize {
        self.block_size
    }

    pub fn process_with_frame(
        &mut self,
        frame: &AutomationFrame,
        master_gain: f32,
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) {
        self.process_audio_internal(
            frame.gates(),
            frame.frequencies(),
            frame.gains(),
            frame.velocities(),
            frame.macro_buffers(),
            frame.macro_buffer_len(),
            master_gain,
            output_left,
            output_right,
        );
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    pub fn num_voices(&self) -> usize {
        self.num_voices
    }

    fn set_effect_active(&mut self, index: usize, active: bool) {
        if let Some(effect) = self.effect_stack.effects.get_mut(index) {
            effect.node.set_active(active);
        }
    }

    pub fn set_chorus_active(&mut self, active: bool) {
        self.set_effect_active(0, active);
    }

    pub fn set_delay_active(&mut self, active: bool) {
        self.set_effect_active(1, active);
    }

    pub fn set_reverb_active(&mut self, active: bool) {
        self.set_effect_active(2, active);
    }

    // Node creation methods
    pub fn create_oscillator(&mut self) -> Result<usize, String> {
        let mut osc_id = NodeId(0);
        for voice in &mut self.voices {
            osc_id = voice.graph.add_node(Box::new(AnalogOscillator::new(
                self.sample_rate,
                Waveform::Sine,
                self.wavetable_banks.clone(),
            )));
        }
        Ok(osc_id.0)
    }

    pub fn create_wavetable_oscillator(&mut self) -> Result<usize, String> {
        let mut osc_id = NodeId(0);
        for voice in &mut self.voices {
            osc_id = voice.graph.add_node(Box::new(WavetableOscillator::new(
                self.sample_rate,
                self.wavetable_synthbank.clone(),
            )));
        }
        Ok(osc_id.0)
    }

    pub fn create_mixer(&mut self) -> Result<usize, String> {
        let mut mixer_id = NodeId(0);
        for voice in &mut self.voices {
            mixer_id = voice.graph.add_node(Box::new(Mixer::new()));
            voice.graph.set_output_node(mixer_id);
        }
        Ok(mixer_id.0)
    }

    pub fn create_envelope(&mut self) -> Result<usize, String> {
        let mut envelope_id = NodeId(0);
        for voice in &mut self.voices {
            envelope_id = voice.graph.add_node(Box::new(Envelope::new(
                self.sample_rate,
                EnvelopeConfig::default(),
            )));
        }
        Ok(envelope_id.0)
    }

    pub fn create_lfo(&mut self) -> Result<usize, String> {
        let mut lfo_id = NodeId(0);
        for voice in &mut self.voices {
            lfo_id = voice.graph.add_node(Box::new(Lfo::new(self.sample_rate)));
        }
        Ok(lfo_id.0)
    }

    pub fn create_filter(&mut self) -> Result<usize, String> {
        let mut filter_id = NodeId(0);
        for voice in &mut self.voices {
            filter_id = voice
                .graph
                .add_node(Box::new(FilterCollection::new(self.sample_rate)));
        }
        Ok(filter_id.0)
    }

    // pub fn create_noise(&mut self) -> Result<usize, String> {
    //     let mut noise_id = NodeId(0);
    //     for voice in &mut self.voices {
    //         noise_id = voice
    //             .graph
    //             .add_node(Box::new(NoiseGenerator::new(self.sample_rate)));
    //     }
    //     Ok(noise_id.0)
    // }

    // Connection methods
    pub fn connect_nodes(
        &mut self,
        from_node: usize,
        from_port: PortId,
        to_node: usize,
        to_port: PortId,
        amount: f32,
        modulation_type: ModulationType,
        modulation_transform: ModulationTransformation,
    ) -> Result<(), String> {
        let connection = Connection {
            from_node: NodeId(from_node),
            from_port,
            to_node: NodeId(to_node),
            to_port,
            amount,
            modulation_type,
            modulation_transform,
        };

        for voice in &mut self.voices {
            voice.graph.add_connection(connection.clone());
        }
        Ok(())
    }

    // Parameter update methods
    pub fn update_oscillator(
        &mut self,
        oscillator_id: usize,
        params: &AnalogOscillatorStateUpdate,
    ) -> Result<(), String> {
        for voice in &mut self.voices {
            let node = voice
                .graph
                .get_node_mut(NodeId(oscillator_id))
                .ok_or_else(|| "Node not found in one of the voices".to_string())?;
            let osc = node
                .as_any_mut()
                .downcast_mut::<AnalogOscillator>()
                .ok_or_else(|| {
                    "Node is not an AnalogOscillator in one of the voices".to_string()
                })?;
            osc.update_params(params);
        }
        Ok(())
    }

    pub fn update_wavetable_oscillator(
        &mut self,
        oscillator_id: usize,
        params: &WavetableOscillatorStateUpdate,
    ) -> Result<(), String> {
        for voice in &mut self.voices {
            let node = voice
                .graph
                .get_node_mut(NodeId(oscillator_id))
                .ok_or_else(|| "Node not found in one of the voices".to_string())?;
            let osc = node
                .as_any_mut()
                .downcast_mut::<WavetableOscillator>()
                .ok_or_else(|| {
                    "Node is not a WavetableOscillator in one of the voices".to_string()
                })?;
            osc.update_params(params);
        }
        Ok(())
    }

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
    ) -> Result<(), String> {
        let mut errors: Vec<String> = Vec::new();

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
            Err(errors.join("; "))
        }
    }

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
    ) -> Result<(), String> {
        for voice in &mut self.voices {
            if let Some(node) = voice.graph.get_node_mut(NodeId(filter_id)) {
                if let Some(filter) = node.as_any_mut().downcast_mut::<FilterCollection>() {
                    filter.set_filter_type(filter_type);
                    filter.set_filter_slope(filter_slope);
                    filter.set_params(cutoff, resonance);
                    filter.set_comb_target_frequency(comb_frequency);
                    filter.set_comb_dampening(comb_dampening);
                    filter.set_gain_db(gain * 24.0 - 12.0);
                    filter.set_keyboard_tracking_sensitivity(key_tracking);
                } else {
                    return Err("Node is not a Filter".to_string());
                }
            } else {
                return Err("Node not found".to_string());
            }
        }
        Ok(())
    }

    // pub fn update_noise(
    //     &mut self,
    //     noise_id: usize,
    //     params: &NoiseUpdateParams,
    // ) -> Result<(), String> {
    //     for voice in &mut self.voices {
    //         if let Some(node) = voice.graph.get_node_mut(NodeId(noise_id)) {
    //             if let Some(noise) = node.as_any_mut().downcast_mut::<NoiseGenerator>() {
    //                 noise.update(NoiseUpdate {
    //                     noise_type: params.noise_type.into(),
    //                     cutoff: params.cutoff * self.sample_rate,
    //                     gain: params.gain,
    //                     enabled: params.enabled,
    //                 });
    //             } else {
    //                 return Err("Node is not a NoiseGenerator".to_string());
    //             }
    //         } else {
    //             return Err("Node not found".to_string());
    //         }
    //     }
    //     Ok(())
    // }
}

unsafe impl Send for AudioEngine {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Connection, ModulationTransformation, ModulationType};
    use crate::nodes::{AnalogOscillator, Mixer};
    use crate::PortId;

    #[cfg(not(feature = "wasm"))]
    #[test]
    fn process_with_frame_outputs_audio_when_gate_is_active() {
        let sample_rate = 48_000.0;
        let mut engine = AudioEngine::new(sample_rate, 1);
        engine.init(sample_rate, 1);

        let voice = engine.voices.get_mut(0).expect("voice should exist");
        let osc_id = voice.graph.add_node(Box::new(AnalogOscillator::new(
            sample_rate,
            Waveform::Sine,
            engine.wavetable_banks.clone(),
        )));
        let mixer_id = voice.graph.add_node(Box::new(Mixer::new()));
        voice.graph.set_output_node(mixer_id);

        voice.graph.add_connection(Connection {
            from_node: osc_id,
            from_port: PortId::AudioOutput0,
            to_node: mixer_id,
            to_port: PortId::AudioInput0,
            amount: 1.0,
            modulation_type: ModulationType::Additive,
            modulation_transform: ModulationTransformation::None,
        });

        let mut frame = AutomationFrame::with_dimensions(engine.num_voices(), MACRO_COUNT, 64);
        frame.set_voice_values(0, 1.0, 440.0, 1.0, 1.0);

        let mut left = [0.0f32; 128];
        let mut right = [0.0f32; 128];

        engine.process_with_frame(&frame, 1.0, &mut left, &mut right);
        engine.process_with_frame(&frame, 1.0, &mut left, &mut right);

        let has_signal = left
            .iter()
            .chain(right.iter())
            .any(|&sample| sample.abs() > 1e-6);

        assert!(has_signal, "expected audio output after gate activation");
    }
}
