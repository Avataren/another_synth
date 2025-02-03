use std::any::Any;
use std::collections::HashMap;
use std::simd::{f32x4, StdFloat};
use wasm_bindgen::prelude::wasm_bindgen;
use web_sys::console;

use crate::graph::{ModulationProcessor, ModulationSource, ModulationType};
use crate::traits::{AudioNode, PortId};

/// Updated state struct with a new `feedback_amount` field.
#[wasm_bindgen]
pub struct OscillatorStateUpdate {
    pub phase_mod_amount: f32,
    pub freq_mod_amount: f32,
    pub detune_oct: f32,
    pub detune_semi: f32,
    pub detune_cents: f32,
    pub detune: f32,
    pub hard_sync: bool,
    pub gain: f32,
    pub active: bool,
    pub feedback_amount: f32,
}

#[wasm_bindgen]
impl OscillatorStateUpdate {
    #[wasm_bindgen(constructor)]
    pub fn new(
        phase_mod_amount: f32,
        freq_mod_amount: f32,
        detune_oct: f32,
        detune_semi: f32,
        detune_cents: f32,
        detune: f32,
        hard_sync: bool,
        gain: f32,
        active: bool,
        feedback_amount: f32,
    ) -> Self {
        Self {
            phase_mod_amount,
            freq_mod_amount,
            detune_oct,
            detune_semi,
            detune_cents,
            detune,
            hard_sync,
            gain,
            active,
            feedback_amount,
        }
    }
}

pub struct ModulatableOscillator {
    phase: f32,
    frequency: f32,
    phase_mod_amount: f32,
    freq_mod_amount: f32,
    detune: f32,
    gain: f32,
    sample_rate: f32,
    active: bool,
    feedback_amount: f32, // base feedback amount from the update
    last_output: f32,     // previous output sample (for feedback)
    last_feedback: f32,   // output before the previous sample (for feedback)
}

impl ModulatableOscillator {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            phase: 0.0,
            frequency: 440.0,
            phase_mod_amount: 1.0,
            freq_mod_amount: 1.0,
            detune: 0.0,
            gain: 1.0,
            sample_rate,
            active: true,
            feedback_amount: 0.0, // default: no feedback
            last_output: 0.0,
            last_feedback: 0.0,
        }
    }

    /// Update parameters including the new feedback parameter.
    pub fn update_params(&mut self, params: &OscillatorStateUpdate) {
        self.phase_mod_amount = params.phase_mod_amount;
        self.freq_mod_amount = params.freq_mod_amount;
        self.detune = params.detune;
        self.gain = params.gain;
        self.feedback_amount = params.feedback_amount; // update feedback parameter
        self.set_active(params.active);
    }

    fn get_detuned_frequency(&self, base_freq: f32) -> f32 {
        let multiplier = 2.0f32.powf(self.detune / 1200.0);
        base_freq * multiplier
    }
}

impl ModulationProcessor for ModulatableOscillator {
    fn get_modulation_type(&self, port: PortId) -> ModulationType {
        match port {
            PortId::FrequencyMod => ModulationType::Bipolar,
            PortId::PhaseMod => ModulationType::Additive,
            PortId::ModIndex => ModulationType::VCA,
            PortId::GainMod => ModulationType::VCA,
            PortId::FeedbackMod => ModulationType::Additive,
            _ => ModulationType::VCA,
        }
    }
}

impl AudioNode for ModulatableOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::GlobalFrequency, false);
        ports.insert(PortId::FrequencyMod, false);
        ports.insert(PortId::PhaseMod, false);
        ports.insert(PortId::ModIndex, false);
        ports.insert(PortId::GainMod, false);
        ports.insert(PortId::FeedbackMod, false);
        ports.insert(PortId::AudioOutput0, true);
        ports
    }

    fn process(
        &mut self,
        inputs: &std::collections::HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut std::collections::HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        use std::simd::{f32x4, StdFloat};
        const TWO_PI: f32 = 2.0 * std::f32::consts::PI;

        // Process modulation inputs for each port.
        let freq_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::FrequencyMod),
            0.0,
            PortId::FrequencyMod,
        );
        let phase_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::PhaseMod),
            0.0,
            PortId::PhaseMod,
        );
        let gain_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::GainMod),
            1.0,
            PortId::GainMod,
        );
        let mod_index = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::ModIndex),
            1.0,
            PortId::ModIndex,
        );
        // For feedback modulation, we want additive accumulation, so start at 0.
        let feedback_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::FeedbackMod),
            0.0,
            PortId::FeedbackMod,
        );

        // Get base frequency from GlobalFrequency if available.
        let base_freq = if let Some(freq_sources) = inputs.get(&PortId::GlobalFrequency) {
            if !freq_sources.is_empty() {
                freq_sources[0].buffer.clone()
            } else {
                vec![self.frequency; buffer_size]
            }
        } else {
            vec![self.frequency; buffer_size]
        };

        if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
            // If feedback is being used (nonzero base feedback or any modulation present),
            // we need to process sample-by-sample to handle the recursive dependency.
            let use_scalar = (self.feedback_amount != 0.0)
                || (!feedback_mod.is_empty() && feedback_mod.iter().any(|&v| v != 0.0));

            if use_scalar {
                // Scalar (sample-by-sample) processing for sample-accurate feedback.
                for i in 0..buffer_size {
                    // Retrieve per-sample modulation values.
                    let freq_sample = base_freq[i];
                    let freq_mod_sample = freq_mod[i];
                    let phase_mod_sample = phase_mod[i];
                    let gain_mod_sample = gain_mod[i];
                    let mod_index_sample = mod_index[i];
                    let feedback_mod_sample = feedback_mod[i];

                    // Calculate effective frequency (after detuning and frequency modulation).
                    let detuned_freq = self.get_detuned_frequency(freq_sample);
                    let modulated_freq = detuned_freq * (1.0 + freq_mod_sample);
                    let phase_inc = TWO_PI * modulated_freq / self.sample_rate;
                    self.phase += phase_inc;

                    // Compute phase modulation input.
                    let input_phase_mod =
                        phase_mod_sample * self.phase_mod_amount * mod_index_sample;

                    // Compute the feedback multiplier. Using additive accumulation:
                    // - If no modulation is present, feedback_mod_sample is 0 and fb_multiplier is 1.
                    // - Otherwise, fb_multiplier scales the base feedback.
                    let fb_multiplier = feedback_mod_sample + 1.0;
                    let effective_feedback = self.feedback_amount * fb_multiplier;
                    // Scale the effective feedback by π/2 (adjust this factor as needed).
                    let scaled_feedback = effective_feedback * (std::f32::consts::PI / 2.0);

                    // Compute feedback contribution using the average of the last two output samples.
                    let feedback_val =
                        (self.last_output + self.last_feedback) * 0.5 * scaled_feedback;

                    // Final phase includes the base phase, phase modulation input, and feedback contribution.
                    let modulated_phase = self.phase + input_phase_mod + feedback_val;
                    let sine = modulated_phase.sin();
                    let sample = sine * self.gain * gain_mod_sample;

                    // Update feedback history for the next sample.
                    self.last_feedback = self.last_output;
                    self.last_output = sample;

                    // Write the sample to the output buffer.
                    output[i] = sample;

                    // Wrap the phase to avoid numerical overflow.
                    if self.phase >= TWO_PI {
                        self.phase -= TWO_PI;
                    }
                }
            } else {
                // If there's no feedback, we can use the SIMD path for efficiency.
                for i in (0..buffer_size).step_by(4) {
                    let end = (i + 4).min(buffer_size);

                    // Frequency chunk.
                    let mut freq_chunk = [0.0; 4];
                    freq_chunk[0..end - i].copy_from_slice(&base_freq[i..end]);
                    let base_freq_simd = f32x4::from_array(freq_chunk);

                    // Frequency modulation chunk.
                    let mut freq_mod_chunk = [0.0; 4];
                    freq_mod_chunk[0..end - i].copy_from_slice(&freq_mod[i..end]);
                    let freq_mod_simd = f32x4::from_array(freq_mod_chunk);

                    // Phase modulation chunk.
                    let mut phase_chunk = [0.0; 4];
                    phase_chunk[0..end - i].copy_from_slice(&phase_mod[i..end]);
                    let phase_mod_simd = f32x4::from_array(phase_chunk);

                    // Gain modulation chunk.
                    let mut gain_chunk = [1.0; 4];
                    gain_chunk[0..end - i].copy_from_slice(&gain_mod[i..end]);
                    let gain_mod_simd = f32x4::from_array(gain_chunk);

                    // Mod index chunk.
                    let mut mod_index_chunk = [1.0; 4];
                    mod_index_chunk[0..end - i].copy_from_slice(&mod_index[i..end]);
                    let mod_index_simd = f32x4::from_array(mod_index_chunk);

                    // Calculate detuned and modulated frequency.
                    let detuned_freq = f32x4::from_array([
                        self.get_detuned_frequency(base_freq_simd.to_array()[0]),
                        self.get_detuned_frequency(base_freq_simd.to_array()[1]),
                        self.get_detuned_frequency(base_freq_simd.to_array()[2]),
                        self.get_detuned_frequency(base_freq_simd.to_array()[3]),
                    ]);
                    let modulated_freq = detuned_freq * (f32x4::splat(1.0) + freq_mod_simd);
                    let phase_inc =
                        f32x4::splat(TWO_PI) * modulated_freq / f32x4::splat(self.sample_rate);

                    // Generate cumulative phases.
                    let phases = f32x4::from_array([
                        self.phase,
                        self.phase + phase_inc.to_array()[0],
                        self.phase + phase_inc.to_array()[0] + phase_inc.to_array()[1],
                        self.phase
                            + phase_inc.to_array()[0]
                            + phase_inc.to_array()[1]
                            + phase_inc.to_array()[2],
                    ]);

                    // Apply phase modulation.
                    let phase_mod_depth = mod_index_simd * f32x4::splat(self.phase_mod_amount);
                    let scaled_phase_mod = phase_mod_simd * phase_mod_depth;
                    let modulated_phase = phases + scaled_phase_mod;

                    // Generate output.
                    let sine = modulated_phase.sin();
                    let result = sine * f32x4::splat(self.gain) * gain_mod_simd;

                    let output_array = result.to_array();
                    output[i..end].copy_from_slice(&output_array[0..end - i]);

                    // Update the phase by summing the increments.
                    self.phase += phase_inc.to_array()[0..end - i].iter().sum::<f32>();
                    self.phase %= TWO_PI;
                }
            }
        }
    }

    fn reset(&mut self) {
        self.phase = 0.0;
        self.last_output = 0.0;
        self.last_feedback = 0.0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn is_active(&self) -> bool {
        self.active
    }

    fn set_active(&mut self, active: bool) {
        self.active = active;
    }

    fn node_type(&self) -> &str {
        "oscillator"
    }
}
