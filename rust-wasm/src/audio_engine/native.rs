use crate::effect_stack::EffectStack;
use crate::impulse_generator::ImpulseResponseGenerator;
use crate::nodes::morph_wavetable::WavetableSynthBank;
use crate::nodes::{
    Chorus, Convolver, Delay, Freeverb, Limiter, Waveform, WavetableBank,
};
use crate::traits::AudioNode;
use crate::voice::Voice;
use rustc_hash::FxHashMap;
use std::{cell::RefCell, rc::Rc, sync::Arc};

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

    pub fn process_with_frame(
        &mut self,
        _frame: &crate::automation::AutomationFrame,
        _master_gain: f32,
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) {
        output_left.fill(0.0);
        output_right.fill(0.0);
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    pub fn num_voices(&self) -> usize {
        self.num_voices
    }
}
