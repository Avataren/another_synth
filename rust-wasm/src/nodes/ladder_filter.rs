use std::any::Any;
use std::f32::consts::PI; // Import PI for calculations

// Import necessary types
use crate::graph::{ModulationProcessor, ModulationSource};
use crate::traits::{AudioNode, PortId};
// Import the fast_tanh function if it's in a shared utils module, otherwise define it here or copy it.
// Assuming it might be available via crate::utils::math::fast_tanh
// use crate::utils::math::fast_tanh;

// If fast_tanh is not in utils, define it here (copy from filter_collection example)
use once_cell::sync::Lazy;
use rustc_hash::FxHashMap;
static TANH_LUT: Lazy<[f32; 1024]> = Lazy::new(|| {
    let mut lut = [0.0; 1024];
    let x_min = -5.0;
    let x_max = 5.0;
    let step = (x_max - x_min) / 1023.0;
    for i in 0..1024 {
        let x = x_min + i as f32 * step;
        lut[i] = x.tanh();
    }
    lut
});

#[inline(always)]
fn fast_tanh(x: f32) -> f32 {
    const LUT_SIZE_MINUS_1_F: f32 = 1023.0;
    const X_MIN: f32 = -5.0;
    const X_MAX: f32 = 5.0;
    const INV_RANGE: f32 = 1.0 / (X_MAX - X_MIN);

    let clamped = x.clamp(X_MIN, X_MAX);
    let normalized = (clamped - X_MIN) * INV_RANGE * LUT_SIZE_MINUS_1_F;
    let index_f = normalized.floor();
    let index = index_f as usize;
    let frac = normalized - index_f;

    unsafe {
        let y0 = TANH_LUT.get_unchecked(index);
        if index < 1023 {
            let y1 = TANH_LUT.get_unchecked(index + 1);
            y0 + (y1 - y0) * frac
        } else {
            *y0
        }
    }
}
// End of fast_tanh definition if copied

/// A 24 dB/octave Moog‑style ladder filter node.
pub struct LadderFilter {
    // Parameters
    sample_rate: f32,
    base_cutoff: f32,    // Hz
    base_resonance: f32, // normalized (0–1)
    base_gain_db: f32,   // Gain in dB (applied at output)
    enabled: bool,

    // Smoothed parameters (state)
    smoothed_cutoff: f32,
    smoothed_resonance: f32, // normalized (0-1)
    smoothing_factor: f32,   // e.g., 0.05

    // Filter state
    stages: [f32; 4], // State variables for the four 1-pole stages

    // === Scratch Buffers ===
    mod_scratch_add: Vec<f32>,
    mod_scratch_mult: Vec<f32>,
    audio_in_buffer: Vec<f32>, // Holds combined audio input
    scratch_cutoff_add: Vec<f32>,
    scratch_cutoff_mult: Vec<f32>,
    scratch_res_add: Vec<f32>,
    scratch_res_mult: Vec<f32>,
    // Optionally add gain modulation scratch buffers if gain is modulated
    // scratch_gain_add: Vec<f32>,
    // scratch_gain_mult: Vec<f32>,
}

impl LadderFilter {
    /// Create a new LadderFilter with the given sample rate.
    pub fn new(sample_rate: f32) -> Self {
        let initial_capacity = 128; // Default buffer size
        let base_cutoff = 20000.0;
        let base_resonance = 0.0;
        let base_gain_db = 0.0; // Default to 0dB gain

        Self {
            sample_rate,
            base_cutoff,
            base_resonance,
            base_gain_db,
            enabled: true,

            smoothed_cutoff: base_cutoff,
            smoothed_resonance: base_resonance,
            smoothing_factor: 0.05, // Adjust for desired smoothing speed

            stages: [0.0; 4],

            // Initialize scratch buffers
            mod_scratch_add: vec![0.0; initial_capacity],
            mod_scratch_mult: vec![1.0; initial_capacity],
            audio_in_buffer: vec![0.0; initial_capacity],
            scratch_cutoff_add: vec![0.0; initial_capacity],
            scratch_cutoff_mult: vec![1.0; initial_capacity],
            scratch_res_add: vec![0.0; initial_capacity],
            scratch_res_mult: vec![1.0; initial_capacity],
            // scratch_gain_add: vec![0.0; initial_capacity],
            // scratch_gain_mult: vec![1.0; initial_capacity],
        }
    }

    /// Ensure all scratch buffers have at least `size` capacity.
    fn ensure_scratch_buffers(&mut self, size: usize) {
        let resize_if_needed = |buf: &mut Vec<f32>, default_val: f32| {
            if buf.len() < size {
                buf.resize(size, default_val);
            }
        };
        resize_if_needed(&mut self.mod_scratch_add, 0.0);
        resize_if_needed(&mut self.mod_scratch_mult, 1.0);
        resize_if_needed(&mut self.audio_in_buffer, 0.0);
        resize_if_needed(&mut self.scratch_cutoff_add, 0.0);
        resize_if_needed(&mut self.scratch_cutoff_mult, 1.0);
        resize_if_needed(&mut self.scratch_res_add, 0.0);
        resize_if_needed(&mut self.scratch_res_mult, 1.0);
        // resize_if_needed(&mut self.scratch_gain_add, 0.0);
        // resize_if_needed(&mut self.scratch_gain_mult, 1.0);
    }

    /// Set the base cutoff (Hz) and resonance (normalized 0–1).
    pub fn set_params(&mut self, cutoff: f32, resonance: f32) {
        // Clamp base frequency to avoid issues near 0 Hz or Nyquist
        self.base_cutoff = cutoff.clamp(10.0, self.sample_rate * 0.49);
        self.base_resonance = resonance.clamp(0.0, 1.0);
        // Smoothed values will catch up in the process loop
    }

    /// Set the base output gain in dB.
    pub fn set_gain_db(&mut self, gain_db: f32) {
        self.base_gain_db = gain_db;
        // Actual gain multiplier applied per-sample based on this base value (and maybe modulation)
    }

    // Removed set_gain_normalized, prefer set_gain_db

    /// Reset the filter's internal state variables.
    pub fn reset_state(&mut self) {
        self.stages = [0.0; 4];
        // Reset smoothed parameters to base values
        self.smoothed_cutoff = self.base_cutoff;
        self.smoothed_resonance = self.base_resonance;
    }

    /// Process a single audio sample through the ladder filter.
    #[inline(always)]
    fn process_one_sample(&mut self, input: f32, cutoff: f32, resonance_norm: f32) -> f32 {
        // --- Calculate Coefficients ---
        // Thermal voltage (VT) - typically 26mV, influences saturation. Not explicitly modelled here.
        // let vt = 0.026;

        // Map cutoff frequency to filter coefficient 'g'. Pre-warp frequency.
        // This uses the relationship derived from the analog circuit's time constant.
        let g = (PI * cutoff / self.sample_rate).tan(); // Similar to one-pole cutoff coef
        let g_inv = 1.0 / (1.0 + g); // Normalization for feedback stage in implicit Euler

        // Map normalized resonance (0-1) to feedback amount 'k'.
        // The factor 4.0 is common, but can be tuned. Higher values increase resonance intensity.
        let k = resonance_norm * 4.0;

        // --- Filter Stages (Implicit Euler Integration with Tanh Saturation) ---
        // Feedback is taken from the output of the last stage (stages[3])
        let feedback_signal = k * self.stages[3];
        let input_stage_value = input - feedback_signal;

        // Process each stage using the fast_tanh approximation
        // This implements y[n] = y[n-1] + g * (tanh(x[n]) - tanh(y[n-1])) with feedback implicit
        // Or simplified: y[n] = y[n-1] + 2.0*g/(1+g) * (tanh(x[n]) - tanh(y[n-1]))
        // Let's use the structure from FilterCollection's ladder for consistency:
        let s0 = fast_tanh(input_stage_value);
        let s1 = fast_tanh(self.stages[0]);
        let s2 = fast_tanh(self.stages[1]);
        let s3 = fast_tanh(self.stages[2]);
        let s4 = fast_tanh(self.stages[3]); // tanh of previous output

        let stage_update_factor = 2.0 * g * g_inv; // Combine factors

        self.stages[0] += stage_update_factor * (s0 - s1);
        self.stages[1] += stage_update_factor * (s1 - s2);
        self.stages[2] += stage_update_factor * (s2 - s3);
        self.stages[3] += stage_update_factor * (s3 - s4);

        // Output is the signal from the last stage
        let output = self.stages[3];

        // Apply output gain (converted from dB)
        output * 10f32.powf(self.base_gain_db / 20.0)
    }
}

// Implement the modulation processor trait
impl ModulationProcessor for LadderFilter {}

impl AudioNode for LadderFilter {
    fn get_ports(&self) -> FxHashMap<PortId, bool> {
        [
            (PortId::AudioInput0, false),  // Input audio signal
            (PortId::CutoffMod, false),    // Modulation for cutoff frequency
            (PortId::ResonanceMod, false), // Modulation for resonance (0-1)
            // (PortId::GainMod, false),   // Optional: Modulation for gain
            (PortId::AudioOutput0, true), // Output filtered audio
        ]
        .iter()
        .cloned()
        .collect()
    }

    fn process(
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // --- 0) Early exit and Buffer Preparation ---
        if !self.enabled {
            if let Some(output_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
                output_buffer[..buffer_size].fill(0.0);
            }
            return;
        }

        self.ensure_scratch_buffers(buffer_size);

        let output_buffer = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(buffer) => buffer,
            None => return,
        };

        // --- 1) Process Modulation Inputs ---

        // Audio Input (simple additive mix)
        self.audio_in_buffer[..buffer_size].fill(0.0);
        if let Some(audio_sources) = inputs.get(&PortId::AudioInput0) {
            for source in audio_sources {
                Self::apply_add(
                    &source.buffer,
                    &mut self.audio_in_buffer[..buffer_size],
                    source.amount,
                    source.transformation,
                );
            }
        }

        // Generic modulation input processing helper
        let mut process_mod_input = |port_id: PortId,
                                     target_add: &mut [f32],
                                     target_mult: &mut [f32],
                                     default_add: f32,
                                     default_mult: f32| {
            let sources = inputs.get(&port_id);
            if sources.map_or(false, |s| !s.is_empty()) {
                Self::accumulate_modulations_inplace(
                    buffer_size,
                    sources.map(|v| v.as_slice()),
                    &mut self.mod_scratch_add,
                    &mut self.mod_scratch_mult,
                );
                target_add[..buffer_size].copy_from_slice(&self.mod_scratch_add[..buffer_size]);
                target_mult[..buffer_size].copy_from_slice(&self.mod_scratch_mult[..buffer_size]);
            } else {
                target_add[..buffer_size].fill(default_add);
                target_mult[..buffer_size].fill(default_mult);
            }
        };

        process_mod_input(
            PortId::CutoffMod,
            &mut self.scratch_cutoff_add,
            &mut self.scratch_cutoff_mult,
            0.0,
            1.0,
        );
        process_mod_input(
            PortId::ResonanceMod,
            &mut self.scratch_res_add,
            &mut self.scratch_res_mult,
            0.0,
            1.0,
        );
        // Process gain mod if enabled
        // process_mod_input(PortId::GainMod, &mut self.scratch_gain_add, &mut self.scratch_gain_mult, 0.0, 1.0);

        // --- 2) Main Processing Loop (Sample by Sample) ---
        // Ladder filter state is highly sensitive, process sample-by-sample
        for i in 0..buffer_size {
            // Calculate target parameters for this sample
            let target_cutoff =
                (self.base_cutoff + self.scratch_cutoff_add[i]) * self.scratch_cutoff_mult[i];
            let target_resonance =
                (self.base_resonance + self.scratch_res_add[i]) * self.scratch_res_mult[i];

            // Clamp target values
            let target_cutoff_clamped = target_cutoff.clamp(10.0, self.sample_rate * 0.49);
            let target_resonance_clamped = target_resonance.clamp(0.0, 1.0); // Resonance is normalized

            // Apply smoothing
            let smoothing_factor = self.smoothing_factor;
            self.smoothed_cutoff +=
                smoothing_factor * (target_cutoff_clamped - self.smoothed_cutoff);
            self.smoothed_resonance +=
                smoothing_factor * (target_resonance_clamped - self.smoothed_resonance);

            // Re-clamp smoothed values to ensure stability
            self.smoothed_cutoff = self.smoothed_cutoff.clamp(10.0, self.sample_rate * 0.49);
            self.smoothed_resonance = self.smoothed_resonance.clamp(0.0, 1.0);

            // Process one audio sample using the smoothed parameters
            let input_sample = self.audio_in_buffer[i];
            let filtered_sample = self.process_one_sample(
                input_sample,
                self.smoothed_cutoff,
                self.smoothed_resonance,
            );

            // Apply gain modulation if implemented
            // let target_gain = (self.base_gain + self.scratch_gain_add[i]) * self.scratch_gain_mult[i];
            // smoothed_gain += smoothing_factor * (target_gain - smoothed_gain);
            // output_buffer[i] = filtered_sample * smoothed_gain;

            // Write output (apply final gain)
            output_buffer[i] = filtered_sample; // Gain is applied inside process_one_sample now
        }
    }

    fn reset(&mut self) {
        self.reset_state();
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn is_active(&self) -> bool {
        self.enabled
    }

    fn set_active(&mut self, active: bool) {
        self.enabled = active;
        if !active {
            self.reset(); // Reset state when deactivated
        }
    }

    fn node_type(&self) -> &str {
        "ladderfilter"
    }
}
