use crate::automation::AutomationFrame;
use crate::effect_stack::EffectStack;
use crate::impulse_generator::ImpulseResponseGenerator;
use crate::nodes::morph_wavetable::WavetableSynthBank;
use crate::nodes::{
    Chorus, Convolver, Delay, Freeverb, Limiter, Waveform, WavetableBank,
};
use crate::traits::AudioNode;
use crate::voice::Voice;
use rustc_hash::FxHashMap;
use std::{cell::RefCell, rc::Rc, sync::Arc, time::Instant};

const DEFAULT_NUM_VOICES: usize = 8;
const MAX_TABLE_SIZE: usize = 2048;
const BUFFER_SIZE: usize = 128;

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
            effect_stack: EffectStack::new(BUFFER_SIZE),
            ir_generator: ImpulseResponseGenerator::new(sample_rate),
            cpu_time_accum: 0.0,
            audio_time_accum: 0.0,
            last_cpu_usage: 0.0,
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
        self.voices = (0..voice_count).map(Voice::new).collect();

        self.effect_stack = EffectStack::new(BUFFER_SIZE);
        self.ir_generator = ImpulseResponseGenerator::new(sample_rate);

        let mut chorus = Chorus::new(
            sample_rate,
            65.0,
            15.0,
            5.0,
            0.5,
            0.3,
            0.5,
            90.0,
        );
        chorus.set_active(false);
        self.effect_stack.add_effect(Box::new(chorus));

        let delay = Delay::new(sample_rate, 2000.0, 500.0, 0.5, 0.1);
        self.effect_stack.add_effect(Box::new(delay));

        let reverb = Freeverb::new(sample_rate, 0.95, 0.5, 0.3, 0.7, 1.0);
        self.effect_stack.add_effect(Box::new(reverb));

        let plate_ir = self.ir_generator.plate(2.0, 0.6);
        let mut plate = Convolver::new(plate_ir, BUFFER_SIZE, sample_rate);
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
        let start = Instant::now();

        let mut mix_left = vec![0.0; output_left.len()];
        let mut mix_right = vec![0.0; output_right.len()];
        let mut voice_left = vec![0.0; output_left.len()];
        let mut voice_right = vec![0.0; output_right.len()];

        for (i, voice) in self.voices.iter_mut().enumerate() {
            let gate = gates.get(i).copied().unwrap_or(0.0);
            let frequency = frequencies.get(i).copied().unwrap_or(440.0);
            let gain = gains.get(i).copied().unwrap_or(1.0);
            let velocity = velocities.get(i).copied().unwrap_or(0.0);

            voice.current_gate = gate;
            voice.current_frequency = frequency;
            voice.current_velocity = velocity;

            for macro_idx in 0..4 {
                let macro_start = i * 4 * 128 + (macro_idx * 128);
                if macro_start + 128 <= macro_values.len() {
                    let values = &macro_values[macro_start..macro_start + 128];
                    let _ = voice.update_macro(macro_idx, values);
                }
            }

            voice_left.fill(0.0);
            voice_right.fill(0.0);

            voice.process_audio(&mut voice_left, &mut voice_right);

            for (sample_idx, (left, right)) in
                voice_left.iter().zip(voice_right.iter()).enumerate()
            {
                mix_left[sample_idx] += left * gain;
                mix_right[sample_idx] += right * gain;
            }
        }

        self.effect_stack
            .process_audio(&mix_left, &mix_right, output_left, output_right);

        if master_gain != 1.0 {
            for sample in output_left.iter_mut() {
                *sample *= master_gain;
            }
            for sample in output_right.iter_mut() {
                *sample *= master_gain;
            }
        }

        let elapsed_sec = start.elapsed().as_secs_f64();
        let quantum_sec = 128.0 / self.sample_rate as f64;
        self.cpu_time_accum += elapsed_sec;
        self.audio_time_accum += quantum_sec;
        if self.audio_time_accum >= 0.1 {
            self.last_cpu_usage = ((self.cpu_time_accum / self.audio_time_accum) * 100.0) as f32;
            self.cpu_time_accum = 0.0;
            self.audio_time_accum = 0.0;
        }
    }

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

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    pub fn num_voices(&self) -> usize {
        self.num_voices
    }
}

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

        let mut frame = AutomationFrame::with_dimensions(engine.num_voices(), 4, 128);
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
