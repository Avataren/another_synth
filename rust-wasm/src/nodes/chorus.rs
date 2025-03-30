use rustc_hash::FxHashMap;
use std::any::Any;
use std::f32::consts::PI;
use std::simd::f32x4;

use crate::graph::ModulationSource;
use crate::traits::{AudioNode, PortId};

const TWO_PI: f32 = 2.0 * PI;
const MAX_PROCESS_BUFFER_SIZE: usize = 1024;
static ZERO_BUFFER: [f32; MAX_PROCESS_BUFFER_SIZE] = [0.0; MAX_PROCESS_BUFFER_SIZE];

// --- Smoothing ---
#[inline(always)]
fn smooth_parameter(current: f32, target: f32, coefficient: f32) -> f32 {
    current * coefficient + target * (1.0 - coefficient)
}

// --- Interpolation ---
#[inline(always)]
fn lerp(y0: f32, y1: f32, fraction: f32) -> f32 {
    y0 + fraction * (y1 - y0)
}

#[inline(always)]
fn cubic_hermite(y_neg1: f32, y0: f32, y1: f32, y2: f32, fraction: f32) -> f32 {
    let frac_sq = fraction * fraction;
    let frac_cub = frac_sq * fraction;
    let c0 = y0;
    let c1 = 0.5 * (y1 - y_neg1);
    let c2 = y_neg1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
    let c3 = 0.5 * (y2 - y_neg1) + 1.5 * (y0 - y1);
    ((c3 * fraction + c2) * fraction + c1) * fraction + c0
}

pub struct Chorus {
    enabled: bool,
    delay_buffer_left: Vec<f32>,
    delay_buffer_right: Vec<f32>,
    write_index: usize,
    max_delay_samples: usize,
    sample_rate: f32,
    inv_sample_rate: f32,
    target_base_delay_samples: f32,
    target_depth_samples: f32,
    target_lfo_rate_hz: f32,
    target_feedback: f32,
    target_mix: f32,
    target_lfo_stereo_phase_offset_rad: f32,
    current_base_delay_samples: f32,
    current_depth_samples: f32,
    current_lfo_phase_increment: f32,
    current_feedback: f32,
    current_mix: f32,
    lfo_phase_left: f32,
    lfo_phase_right: f32,
    param_smooth_coeff: f32,
}

impl Chorus {
    pub fn new(
        sample_rate: f32,
        max_base_delay_ms: f32,
        base_delay_ms: f32,
        depth_ms: f32,
        lfo_rate_hz: f32,
        feedback: f32,
        mix: f32,
        stereo_phase_offset_deg: f32,
    ) -> Self {
        assert!(sample_rate > 0.0, "Sample rate must be positive");
        assert!(
            max_base_delay_ms >= 0.0,
            "Max base delay must be non-negative"
        );

        let min_required_buffer_padding = 4;
        let max_total_delay_ms = max_base_delay_ms + depth_ms.abs();
        let required_samples_for_delay =
            (max_total_delay_ms / 1000.0 * sample_rate).ceil() as usize;
        let safety_margin = 4;
        let max_delay_samples =
            required_samples_for_delay + min_required_buffer_padding + safety_margin;

        let inv_sample_rate = 1.0 / sample_rate;
        let initial_base_delay_samples = (base_delay_ms / 1000.0 * sample_rate).max(0.0);
        let initial_depth_samples = (depth_ms / 1000.0 * sample_rate).max(0.0);
        let initial_lfo_rate_hz = lfo_rate_hz.max(0.0);
        let initial_lfo_phase_increment = TWO_PI * initial_lfo_rate_hz * inv_sample_rate;
        let initial_feedback = feedback.clamp(0.0, 0.98);
        let initial_mix = mix.clamp(0.0, 1.0);
        let initial_lfo_stereo_phase_offset_rad = stereo_phase_offset_deg.to_radians();

        let smoothing_time_ms = 15.0;
        let smoothing_time_samples = smoothing_time_ms * 0.001 * sample_rate;
        let param_smooth_coeff = if smoothing_time_samples > 0.0 {
            (-TWO_PI / smoothing_time_samples).exp()
        } else {
            0.0
        };

        Self {
            enabled: true,
            delay_buffer_left: vec![0.0; max_delay_samples],
            delay_buffer_right: vec![0.0; max_delay_samples],
            write_index: 0,
            max_delay_samples,
            sample_rate,
            inv_sample_rate,
            target_base_delay_samples: initial_base_delay_samples,
            target_depth_samples: initial_depth_samples,
            target_lfo_rate_hz: initial_lfo_rate_hz,
            target_feedback: initial_feedback,
            target_mix: initial_mix,
            target_lfo_stereo_phase_offset_rad: initial_lfo_stereo_phase_offset_rad,
            current_base_delay_samples: initial_base_delay_samples,
            current_depth_samples: initial_depth_samples,
            current_lfo_phase_increment: initial_lfo_phase_increment,
            current_feedback: initial_feedback,
            current_mix: initial_mix,
            lfo_phase_left: 0.0,
            lfo_phase_right: initial_lfo_stereo_phase_offset_rad.rem_euclid(TWO_PI),
            param_smooth_coeff,
        }
    }

    pub fn set_base_delay_ms(&mut self, delay_ms: f32) {
        self.target_base_delay_samples = (delay_ms / 1000.0 * self.sample_rate).max(0.0);
    }
    pub fn set_depth_ms(&mut self, depth_ms: f32) {
        self.target_depth_samples = (depth_ms / 1000.0 * self.sample_rate).max(0.0);
    }
    pub fn set_rate_hz(&mut self, rate_hz: f32) {
        self.target_lfo_rate_hz = rate_hz.max(0.0);
    }
    pub fn set_feedback(&mut self, feedback: f32) {
        self.target_feedback = feedback.clamp(0.0, 0.98);
    }
    pub fn set_mix(&mut self, mix: f32) {
        self.target_mix = mix.clamp(0.0, 1.0);
    }
    pub fn set_stereo_phase_offset_deg(&mut self, offset_deg: f32) {
        self.target_lfo_stereo_phase_offset_rad = offset_deg.to_radians();
        self.lfo_phase_right =
            (self.lfo_phase_left + self.target_lfo_stereo_phase_offset_rad).rem_euclid(TWO_PI);
    }

    #[inline(always)]
    fn read_cubic_interpolated(&self, buffer: &[f32], delay_samples: f32) -> f32 {
        let max_safe_delay = (self.max_delay_samples - 3).max(0) as f32;
        let clamped_delay = delay_samples.clamp(0.0, max_safe_delay);
        let read_pos_float = (self.write_index as f32 - clamped_delay
            + self.max_delay_samples as f32)
            % self.max_delay_samples as f32;
        let read_index_0 = read_pos_float.floor() as usize;
        let fraction = read_pos_float.fract();
        let read_index_neg1 = (read_index_0 + self.max_delay_samples - 1) % self.max_delay_samples;
        let read_index_1 = (read_index_0 + 1) % self.max_delay_samples;
        let read_index_2 = (read_index_0 + 2) % self.max_delay_samples;
        let y_neg1 = buffer[read_index_neg1];
        let y0 = buffer[read_index_0];
        let y1 = buffer[read_index_1];
        let y2 = buffer[read_index_2];
        cubic_hermite(y_neg1, y0, y1, y2, fraction)
    }
}

impl AudioNode for Chorus {
    fn get_ports(&self) -> FxHashMap<PortId, bool> {
        let mut ports = FxHashMap::default();
        ports.insert(PortId::AudioInput0, false);
        ports.insert(PortId::AudioInput1, false);
        ports.insert(PortId::AudioOutput0, true);
        ports.insert(PortId::AudioOutput1, true);
        ports
    }

    fn process(
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // --- Safety Check: Ensure buffer_size doesn't exceed our static zero buffer ---
        if buffer_size > MAX_PROCESS_BUFFER_SIZE {
            eprintln!(
                "Chorus Error: process buffer_size ({}) exceeds MAX_PROCESS_BUFFER_SIZE ({}). Zeroing output.",
                buffer_size, MAX_PROCESS_BUFFER_SIZE
            );
            if let Some(out_left) = outputs.get_mut(&PortId::AudioOutput0) {
                // *** FIX: Calculate length first ***
                let len_to_fill = buffer_size.min(out_left.len());
                out_left[..len_to_fill].fill(0.0);
            }
            if let Some(out_right) = outputs.get_mut(&PortId::AudioOutput1) {
                // *** FIX: Calculate length first ***
                let len_to_fill = buffer_size.min(out_right.len());
                out_right[..len_to_fill].fill(0.0);
            }
            return;
        }

        // --- Handle Disabled State ---
        if !self.enabled {
            let outs = outputs.get_many_mut([&PortId::AudioOutput0, &PortId::AudioOutput1]);
            if let [Some(out_left), Some(out_right)] = outs {
                // Attempt pass-through if inputs connected
                if let (Some(left_src_vec), Some(right_src_vec)) = (
                    inputs.get(&PortId::AudioInput0),
                    inputs.get(&PortId::AudioInput1),
                ) {
                    if let (Some(left_src), Some(right_src)) =
                        (left_src_vec.first(), right_src_vec.first())
                    {
                        // Copy input to output (length checked correctly here)
                        let copy_len = buffer_size.min(out_left.len()).min(left_src.buffer.len());
                        out_left[..copy_len].copy_from_slice(&left_src.buffer[..copy_len]);

                        let copy_len_r =
                            buffer_size.min(out_right.len()).min(right_src.buffer.len());
                        out_right[..copy_len_r].copy_from_slice(&right_src.buffer[..copy_len_r]);

                        // Zero any remaining parts of output if needed
                        if copy_len < out_left.len() {
                            // No len calculation needed here, just use copy_len
                            out_left[copy_len..].fill(0.0);
                        }
                        if copy_len_r < out_right.len() {
                            // No len calculation needed here
                            out_right[copy_len_r..].fill(0.0);
                        }
                    } else {
                        // Inputs connected but vectors empty? Zero output.
                        // *** FIX: Calculate length first ***
                        let len_to_fill_l = buffer_size.min(out_left.len());
                        out_left[..len_to_fill_l].fill(0.0);
                        let len_to_fill_r = buffer_size.min(out_right.len());
                        out_right[..len_to_fill_r].fill(0.0);
                    }
                } else {
                    // Inputs not connected, zero output
                    // *** FIX: Calculate length first ***
                    let len_to_fill_l = buffer_size.min(out_left.len());
                    out_left[..len_to_fill_l].fill(0.0);
                    let len_to_fill_r = buffer_size.min(out_right.len());
                    out_right[..len_to_fill_r].fill(0.0);
                }
            }
            return;
        }

        // --- Get Input Buffers (or zero buffer if disconnected) ---
        let left_in = inputs
            .get(&PortId::AudioInput0)
            .and_then(|sources| sources.first())
            .map(|src| &src.buffer[..buffer_size])
            .unwrap_or(&ZERO_BUFFER[..buffer_size]);

        let right_in = inputs
            .get(&PortId::AudioInput1)
            .and_then(|sources| sources.first())
            .map(|src| &src.buffer[..buffer_size])
            .unwrap_or(&ZERO_BUFFER[..buffer_size]);

        // --- Get Output Buffers ---
        let [Some(out_left), Some(out_right)] =
            outputs.get_many_mut([&PortId::AudioOutput0, &PortId::AudioOutput1])
        else {
            eprintln!("Chorus Error: Missing required stereo output buffers!");
            return;
        };

        // Ensure output slices match buffer_size for safety in processing loop
        // (This re-borrowing is fine and common)
        let out_left = &mut out_left[..buffer_size];
        let out_right = &mut out_right[..buffer_size];

        // --- Parameter Smoothing (per-block) ---
        let coeff = self.param_smooth_coeff;
        self.current_base_delay_samples = smooth_parameter(
            self.current_base_delay_samples,
            self.target_base_delay_samples,
            coeff,
        );
        self.current_depth_samples =
            smooth_parameter(self.current_depth_samples, self.target_depth_samples, coeff);
        self.current_feedback =
            smooth_parameter(self.current_feedback, self.target_feedback, coeff);
        self.current_mix = smooth_parameter(self.current_mix, self.target_mix, coeff);
        let target_lfo_phase_increment = TWO_PI * self.target_lfo_rate_hz * self.inv_sample_rate;
        self.current_lfo_phase_increment = smooth_parameter(
            self.current_lfo_phase_increment,
            target_lfo_phase_increment,
            coeff,
        );

        // --- Prepare Processing Variables ---
        let mut current_lfo_phase_left = self.lfo_phase_left;
        let mut current_lfo_phase_right = self.lfo_phase_right;
        let phase_inc = self.current_lfo_phase_increment;
        let base_delay = self.current_base_delay_samples;
        let depth = self.current_depth_samples;
        let feedback = self.current_feedback;
        let mix = self.current_mix;
        let dry_level_simd = f32x4::splat(1.0 - mix);
        let wet_level_simd = f32x4::splat(mix);

        let mut i = 0;
        while i < buffer_size {
            let chunk_len = (buffer_size - i).min(4);

            let mut in_left_arr = [0.0; 4];
            let mut in_right_arr = [0.0; 4];
            let mut delayed_left_arr = [0.0; 4];
            let mut delayed_right_arr = [0.0; 4];
            let mut write_back_left_arr = [0.0; 4];
            let mut write_back_right_arr = [0.0; 4];

            // --- Per-Sample Processing ---
            for k in 0..chunk_len {
                let current_input_idx = i + k;
                let lfo_mod_left = current_lfo_phase_left.sin();
                let lfo_mod_right = current_lfo_phase_right.sin();
                let delay_smpls_left = (base_delay + lfo_mod_left * depth).max(0.0);
                let delay_smpls_right = (base_delay + lfo_mod_right * depth).max(0.0);
                delayed_left_arr[k] =
                    self.read_cubic_interpolated(&self.delay_buffer_left, delay_smpls_left);
                delayed_right_arr[k] =
                    self.read_cubic_interpolated(&self.delay_buffer_right, delay_smpls_right);
                in_left_arr[k] = left_in[current_input_idx];
                in_right_arr[k] = right_in[current_input_idx];
                write_back_left_arr[k] = in_left_arr[k] + feedback * delayed_left_arr[k];
                write_back_right_arr[k] = in_right_arr[k] + feedback * delayed_right_arr[k];
                current_lfo_phase_left = (current_lfo_phase_left + phase_inc).rem_euclid(TWO_PI);
                current_lfo_phase_right = (current_lfo_phase_right + phase_inc).rem_euclid(TWO_PI);
            }

            // --- Write to Delay Buffer ---
            let write_start_index = self.write_index;
            for k in 0..chunk_len {
                let current_write_idx = (write_start_index + k) % self.max_delay_samples;
                self.delay_buffer_left[current_write_idx] = write_back_left_arr[k];
                self.delay_buffer_right[current_write_idx] = write_back_right_arr[k];
            }

            // --- SIMD Mixing and Output Writing ---
            let in_left_vec = f32x4::from_array(in_left_arr);
            let in_right_vec = f32x4::from_array(in_right_arr);
            let delayed_left_vec = f32x4::from_array(delayed_left_arr);
            let delayed_right_vec = f32x4::from_array(delayed_right_arr);
            let mixed_left_vec = in_left_vec * dry_level_simd + delayed_left_vec * wet_level_simd;
            let mixed_right_vec =
                in_right_vec * dry_level_simd + delayed_right_vec * wet_level_simd;

            out_left[i..i + chunk_len].copy_from_slice(&mixed_left_vec.to_array()[..chunk_len]);
            out_right[i..i + chunk_len].copy_from_slice(&mixed_right_vec.to_array()[..chunk_len]);

            // --- Advance Write Pointer and Loop Index ---
            self.write_index = (self.write_index + chunk_len) % self.max_delay_samples;
            i += chunk_len;
        }

        // --- Store final LFO phases ---
        self.lfo_phase_left = current_lfo_phase_left;
        self.lfo_phase_right = current_lfo_phase_right;
    }

    fn reset(&mut self) {
        self.delay_buffer_left.fill(0.0);
        self.delay_buffer_right.fill(0.0);
        self.write_index = 0;
        self.lfo_phase_left = 0.0;
        self.lfo_phase_right = self.target_lfo_stereo_phase_offset_rad.rem_euclid(TWO_PI);
        self.current_base_delay_samples = self.target_base_delay_samples;
        self.current_depth_samples = self.target_depth_samples;
        self.current_lfo_phase_increment = TWO_PI * self.target_lfo_rate_hz * self.inv_sample_rate;
        self.current_feedback = self.target_feedback;
        self.current_mix = self.target_mix;
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
        if active && !self.enabled {
            self.reset();
        }
        self.enabled = active;
    }
    fn node_type(&self) -> &str {
        "chorus"
    }
}

// --- Main function (Example Usage / Test Stub) ---
/*
fn main() {
    let sample_rate = 44100.0;
    let buffer_size = 512;

    let mut chorus = Chorus::new(sample_rate, 25.0, 15.0, 5.0, 0.5, 0.3, 0.5, 90.0);

    let mut input_map: FxHashMap<PortId, Vec<ModulationSource>> = FxHashMap::default();
    let mut output_map: FxHashMap<PortId, &mut [f32]> = FxHashMap::default();

    let mut input_buffer_left = [0.0f32; MAX_PROCESS_BUFFER_SIZE];
    let mut input_buffer_right = [0.0f32; MAX_PROCESS_BUFFER_SIZE];
    let mut phase = 0.0;
    let phase_inc = 440.0 * TWO_PI / sample_rate;
    for i in 0..buffer_size {
        let sample = phase.sin() * 0.5;
        input_buffer_left[i] = sample;
        input_buffer_right[i] = sample; // Mono input
        phase = (phase + phase_inc).rem_euclid(TWO_PI);
    }

    // Need owned sources or ensure lifetimes work if using references
    let input_mod_left = ModulationSource { buffer: input_buffer_left };
    let input_mod_right = ModulationSource { buffer: input_buffer_right };

    input_map.insert(PortId::AudioInput0, vec![input_mod_left.clone()]); // Clone needed if ModSource moved/dropped
    input_map.insert(PortId::AudioInput1, vec![input_mod_right.clone()]);


    let mut output_buffer_left = vec![0.0f32; buffer_size];
    let mut output_buffer_right = vec![0.0f32; buffer_size];

    output_map.insert(PortId::AudioOutput0, &mut output_buffer_left);
    output_map.insert(PortId::AudioOutput1, &mut output_buffer_right);

    println!("Processing first block...");
    chorus.process(&input_map, &mut output_map, buffer_size);

    println!("Setting new rate and processing second block...");
    chorus.set_rate_hz(2.0);
    // Update input buffers if necessary for subsequent blocks
    chorus.process(&input_map, &mut output_map, buffer_size);

    // Access output data via the mutable references in the map
    let final_out_left = output_map.get(&PortId::AudioOutput0).unwrap();
    let sum_left: f32 = final_out_left.iter().map(|x| x.abs()).sum();

    println!("Processing finished.");
    println!("Sum of absolute values in left output (Block 2): {}", sum_left);
     if sum_left > 1e-6 { // Use tolerance for float comparison
         println!("Output seems to contain non-zero values.");
    } else {
         println!("Warning: Output might be silent or near-silent.");
    }
}
*/
