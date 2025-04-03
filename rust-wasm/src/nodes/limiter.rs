use rustc_hash::FxHashMap;
use std::any::Any;
use std::f32; // Use f32::EPSILON if needed for comparisons

use crate::graph::ModulationSource;
use crate::traits::{AudioNode, PortId};

const MAX_PROCESS_BUFFER_SIZE: usize = 128;
static ZERO_BUFFER: [f32; MAX_PROCESS_BUFFER_SIZE] = [0.0; MAX_PROCESS_BUFFER_SIZE];

// --- Helper Functions ---
#[inline(always)]
fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db * 0.05) // 0.05 is 1/20
}

#[inline(always)]
fn calculate_smooth_coeff(time_ms: f32, sample_rate: f32) -> f32 {
    if time_ms <= 0.0 || sample_rate <= 0.0 {
        return 1.0; // Instantaneous change
    }
    // Calculate time constant in samples
    let time_samples = time_ms * 0.001 * sample_rate;
    if time_samples < 1.0 {
        return 1.0; // Effectively instantaneous if time is less than one sample
    }
    // Standard one-pole smoothing coefficient formula
    (-1.0 / time_samples).exp()
}

// --- Limiter Struct Definition ---
pub struct Limiter {
    enabled: bool,
    sample_rate: f32,

    // --- Parameters (Targets) ---
    target_threshold_db: f32,
    target_attack_ms: f32,
    target_release_ms: f32,
    target_lookahead_ms: f32, // Optional lookahead time
    target_stereo_link: bool, // Apply same gain reduction to L/R?

    // --- Parameters (Internal/Smoothed) ---
    current_threshold_linear: f32,
    attack_coeff: f32,  // Coefficient for envelope attack
    release_coeff: f32, // Coefficient for envelope release

    // --- State Variables ---
    envelope_l: f32, // Current detected envelope level (linear)
    envelope_r: f32,
    gain_reduction_l: f32, // Current gain reduction factor applied (linear, <= 1.0)
    gain_reduction_r: f32,

    // --- Lookahead ---
    lookahead_buffer_l: Vec<f32>,
    lookahead_buffer_r: Vec<f32>,
    lookahead_samples: usize,
    lookahead_write_index: usize,
    lookahead_read_delay: usize, // How many samples behind write index to read
}

impl Limiter {
    pub fn new(
        sample_rate: f32,
        threshold_db: f32, // E.g., -0.1 dBFS
        attack_ms: f32,    // E.g., 0.1 ms (very fast)
        release_ms: f32,   // E.g., 50.0 ms
        lookahead_ms: f32, // E.g., 1.5 ms
        stereo_link: bool, // E.g., true
    ) -> Self {
        assert!(sample_rate > 0.0, "Sample rate must be positive");
        assert!(attack_ms >= 0.0, "Attack time must be non-negative");
        assert!(release_ms > 0.0, "Release time must be positive"); // Release needs time to recover
        assert!(lookahead_ms >= 0.0, "Lookahead time must be non-negative");

        let attack_coeff = calculate_smooth_coeff(attack_ms, sample_rate);
        let release_coeff = calculate_smooth_coeff(release_ms, sample_rate);
        let current_threshold_linear = db_to_linear(threshold_db);

        // Calculate lookahead buffer size and indices
        let lookahead_samples = (lookahead_ms * 0.001 * sample_rate).ceil() as usize;
        let lookahead_buffer_size = if lookahead_samples > 0 {
            lookahead_samples + 1
        } else {
            1
        }; // Need at least size 1 even if no lookahead
        let lookahead_read_delay = lookahead_samples; // Read 'delay' samples behind write index

        Self {
            enabled: true,
            sample_rate,
            target_threshold_db: threshold_db,
            target_attack_ms: attack_ms,
            target_release_ms: release_ms,
            target_lookahead_ms: lookahead_ms,
            target_stereo_link: stereo_link,
            current_threshold_linear,
            attack_coeff,
            release_coeff,
            envelope_l: 0.0, // Start envelope at 0
            envelope_r: 0.0,
            gain_reduction_l: 1.0, // Start with no gain reduction
            gain_reduction_r: 1.0,
            lookahead_buffer_l: vec![0.0; lookahead_buffer_size],
            lookahead_buffer_r: vec![0.0; lookahead_buffer_size],
            lookahead_samples,
            lookahead_write_index: 0,
            lookahead_read_delay,
        }
    }

    // --- Parameter Setters ---
    pub fn set_threshold_db(&mut self, db: f32) {
        self.target_threshold_db = db;
        // Update linear threshold immediately - smoothing gain is enough
        self.current_threshold_linear = db_to_linear(db);
    }

    pub fn set_attack_ms(&mut self, ms: f32) {
        let safe_ms = ms.max(0.0); // Ensure non-negative
        self.target_attack_ms = safe_ms;
        self.attack_coeff = calculate_smooth_coeff(safe_ms, self.sample_rate);
    }

    pub fn set_release_ms(&mut self, ms: f32) {
        let safe_ms = ms.max(f32::EPSILON * 1000.0); // Ensure positive
        self.target_release_ms = safe_ms;
        self.release_coeff = calculate_smooth_coeff(safe_ms, self.sample_rate);
    }

    pub fn set_stereo_link(&mut self, link: bool) {
        self.target_stereo_link = link;
        // If unlinking, reset gains potentially? Or let them diverge naturally.
        // Let's let them diverge naturally for now. Reset on activation might be better.
    }

    // Note: Changing lookahead requires resizing buffers, which is complex.
    // Usually, lookahead is fixed after initialization or requires a full reset/recreation.
    // We'll omit a `set_lookahead_ms` for simplicity here. If needed, it would
    // call `reset_state` and reallocate/recalculate lookahead parameters.

    // --- MAIN PROCESS FUNCTION ---
    #[inline(never)]
    pub fn process_block(
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // --- Basic Sanity Checks & Output Buffer Handling ---
        if buffer_size == 0 {
            return;
        }
        if buffer_size > MAX_PROCESS_BUFFER_SIZE {
            eprintln!(
                "Limiter Error: process buffer_size ({}) exceeds MAX_PROCESS_BUFFER_SIZE ({}). Zeroing output.",
                buffer_size, MAX_PROCESS_BUFFER_SIZE
            );
            // --- FIX 1 & 2 Applied ---
            if let Some(out_l) = outputs.get_mut(&PortId::AudioOutput0) {
                let len = out_l.len(); // Calculate len first
                let fill_len = buffer_size.min(len);
                out_l[..fill_len].fill(0.0); // Use calculated len
            }
            if let Some(out_r) = outputs.get_mut(&PortId::AudioOutput1) {
                let len = out_r.len(); // Calculate len first
                let fill_len = buffer_size.min(len);
                out_r[..fill_len].fill(0.0); // Use calculated len
            }
            return;
        }

        let out_left_ptr: *mut [f32] = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(slice_ref_mut) => *slice_ref_mut as *mut [f32],
            None => {
                eprintln!("Limiter Error: Missing AudioOutput0");
                // --- FIX 3 Applied ---
                if let Some(out_r) = outputs.get_mut(&PortId::AudioOutput1) {
                    let len = out_r.len(); // Calculate len first
                    let fill_len = buffer_size.min(len);
                    out_r[..fill_len].fill(0.0); // Use calculated len
                }
                return;
            }
        };
        let out_right: &mut [f32] = match outputs.get_mut(&PortId::AudioOutput1) {
            Some(slice_ref_mut) => slice_ref_mut,
            None => {
                eprintln!("Limiter Error: Missing AudioOutput1");
                // --- FIX 4 Applied ---
                unsafe {
                    let out_left_slice = &mut *out_left_ptr;
                    let len = out_left_slice.len(); // Calculate len first
                    let fill_len = buffer_size.min(len);
                    out_left_slice[..fill_len].fill(0.0); // Use calculated len
                }
                return;
            }
        };

        // --- Handle Disabled State (Passthrough) ---
        if !self.enabled {
            let left_in_slice = inputs
                .get(&PortId::AudioInput0)
                .and_then(|v| v.first())
                .map_or(&ZERO_BUFFER[..buffer_size], |s| s.buffer.as_slice());
            let right_in_slice = inputs
                .get(&PortId::AudioInput1)
                .and_then(|v| v.first())
                .map_or(left_in_slice, |s| s.buffer.as_slice());
            unsafe {
                let out_left = &mut *out_left_ptr;
                // Calculate lengths first
                let len_l = out_left.len();
                let len_r = out_right.len();
                let in_len_l = left_in_slice.len();
                let in_len_r = right_in_slice.len();
                let proc_len = buffer_size
                    .min(in_len_l)
                    .min(in_len_r)
                    .min(len_l)
                    .min(len_r);

                if proc_len > 0 {
                    out_left[..proc_len].copy_from_slice(&left_in_slice[..proc_len]);
                    out_right[..proc_len].copy_from_slice(&right_in_slice[..proc_len]);
                }
                // Zero remaining parts using calculated lengths
                if proc_len < len_l {
                    out_left[proc_len..len_l].fill(0.0);
                }
                if proc_len < len_r {
                    out_right[proc_len..len_r].fill(0.0);
                }
            }
            return;
        }

        // --- Get Input Buffers & Determine Process Length ---
        let left_in_slice = inputs
            .get(&PortId::AudioInput0)
            .and_then(|v| v.first())
            .map_or(&ZERO_BUFFER[..buffer_size], |s| s.buffer.as_slice());
        let right_in_slice = inputs
            .get(&PortId::AudioInput1)
            .and_then(|v| v.first())
            .map_or(left_in_slice, |s| s.buffer.as_slice());
        let process_len = {
            let len_l = unsafe { (*out_left_ptr).len() };
            let len_r = out_right.len();
            let in_len_l = left_in_slice.len();
            let in_len_r = right_in_slice.len();
            buffer_size
                .min(len_l)
                .min(len_r)
                .min(in_len_l)
                .min(in_len_r)
        };
        if process_len == 0 {
            // Zero outputs safely if process_len is 0
            unsafe {
                let out_left = &mut *out_left_ptr;
                let len_l = out_left.len();
                let fill_len_l = len_l.min(buffer_size); // Recalculate fill length based on buffer_size request
                out_left[..fill_len_l].fill(0.0);

                let len_r = out_right.len();
                let fill_len_r = len_r.min(buffer_size);
                out_right[..fill_len_r].fill(0.0);
            }
            return;
        }
        let left_in = &left_in_slice[..process_len];
        let right_in = &right_in_slice[..process_len];

        // --- Get Output Slices ---
        let (out_left, out_right) = unsafe {
            (
                &mut (*out_left_ptr)[..process_len],
                &mut out_right[..process_len],
            )
        };

        // --- Core Limiter Processing Loop ---
        {
            // ... (Core limiter logic remains the same) ...
            let threshold_lin = self.current_threshold_linear;
            let attack_c = self.attack_coeff;
            let release_c = self.release_coeff;
            let stereo_link = self.target_stereo_link;

            let mut envelope_l = self.envelope_l;
            let mut envelope_r = self.envelope_r;
            let mut gain_reduction_l = self.gain_reduction_l;
            let mut gain_reduction_r = self.gain_reduction_r;

            let lookahead_buf_l = &mut self.lookahead_buffer_l;
            let lookahead_buf_r = &mut self.lookahead_buffer_r;
            let lookahead_buf_len = lookahead_buf_l.len();
            let mut write_idx = self.lookahead_write_index;
            let read_delay = self.lookahead_read_delay;
            let has_lookahead = read_delay > 0 && lookahead_buf_len > 1;

            for i in 0..process_len {
                let input_l = left_in[i];
                let input_r = right_in[i];

                // --- Lookahead Handling ---
                let (delayed_l, delayed_r) = if has_lookahead {
                    let read_idx = (write_idx + lookahead_buf_len - read_delay) % lookahead_buf_len;
                    let dl = lookahead_buf_l[read_idx];
                    let dr = lookahead_buf_r[read_idx];
                    lookahead_buf_l[write_idx] = input_l;
                    lookahead_buf_r[write_idx] = input_r;
                    write_idx = (write_idx + 1) % lookahead_buf_len;
                    (dl, dr)
                } else {
                    (input_l, input_r)
                };

                // --- Envelope Detection (Peak) ---
                let peak_l = input_l.abs();
                let peak_r = input_r.abs();

                if peak_l > envelope_l {
                    envelope_l = peak_l * (1.0 - attack_c) + envelope_l * attack_c;
                } else {
                    envelope_l = peak_l * (1.0 - release_c) + envelope_l * release_c;
                }
                envelope_l += f32::EPSILON * 0.1; // Denormal prevention

                if peak_r > envelope_r {
                    envelope_r = peak_r * (1.0 - attack_c) + envelope_r * attack_c;
                } else {
                    envelope_r = peak_r * (1.0 - release_c) + envelope_r * release_c;
                }
                envelope_r += f32::EPSILON * 0.1; // Denormal prevention

                // --- Gain Calculation ---
                let (target_gain_l, target_gain_r) = if stereo_link {
                    let max_envelope = envelope_l.max(envelope_r);
                    if max_envelope > threshold_lin {
                        let gain = (threshold_lin / max_envelope).min(1.0); // Ensure gain <= 1.0
                        (gain, gain)
                    } else {
                        (1.0, 1.0)
                    }
                } else {
                    let gain_l = if envelope_l > threshold_lin {
                        (threshold_lin / envelope_l).min(1.0)
                    } else {
                        1.0
                    };
                    let gain_r = if envelope_r > threshold_lin {
                        (threshold_lin / envelope_r).min(1.0)
                    } else {
                        1.0
                    };
                    (gain_l, gain_r)
                };

                // --- Apply Gain Reduction Smoothing ---
                if target_gain_l < gain_reduction_l {
                    gain_reduction_l =
                        target_gain_l * (1.0 - attack_c) + gain_reduction_l * attack_c;
                } else {
                    gain_reduction_l =
                        target_gain_l * (1.0 - release_c) + gain_reduction_l * release_c;
                }

                if target_gain_r < gain_reduction_r {
                    gain_reduction_r =
                        target_gain_r * (1.0 - attack_c) + gain_reduction_r * attack_c;
                } else {
                    gain_reduction_r =
                        target_gain_r * (1.0 - release_c) + gain_reduction_r * release_c;
                }

                // Prevent gain from exceeding 1.0 due to smoothing overshoot
                gain_reduction_l = gain_reduction_l.min(1.0);
                gain_reduction_r = gain_reduction_r.min(1.0);

                // --- Apply Gain ---
                out_left[i] = delayed_l * gain_reduction_l;
                out_right[i] = delayed_r * gain_reduction_r;
            }

            // Write back final state to self
            self.envelope_l = envelope_l;
            self.envelope_r = envelope_r;
            self.gain_reduction_l = gain_reduction_l;
            self.gain_reduction_r = gain_reduction_r;
            if has_lookahead {
                self.lookahead_write_index = write_idx;
            }
        } // End inner scope

        // --- Zero remaining output buffer parts ---
        // Also apply fix here for consistency, using full buffer lengths
        unsafe {
            let out_left_full = &mut *out_left_ptr;
            let len_l = out_left_full.len();
            if process_len < len_l {
                out_left_full[process_len..len_l].fill(0.0);
            }
            // out_right is already the full slice from the map
            if let Some(full_out_right) = outputs.get_mut(&PortId::AudioOutput1) {
                let full_len_r = full_out_right.len();
                if process_len < full_len_r {
                    full_out_right[process_len..full_len_r].fill(0.0);
                }
            }
        }
    } // end process_block

    /// Resets the internal state of the Limiter node.
    pub fn reset_state(&mut self) {
        self.envelope_l = 0.0;
        self.envelope_r = 0.0;
        self.gain_reduction_l = 1.0;
        self.gain_reduction_r = 1.0;

        // Reset lookahead buffer state
        self.lookahead_buffer_l.fill(0.0);
        self.lookahead_buffer_r.fill(0.0);
        self.lookahead_write_index = 0;

        // Recalculate coefficients and linear threshold based on current targets
        self.attack_coeff = calculate_smooth_coeff(self.target_attack_ms, self.sample_rate);
        self.release_coeff = calculate_smooth_coeff(self.target_release_ms, self.sample_rate);
        self.current_threshold_linear = db_to_linear(self.target_threshold_db);
        // Note: Lookahead samples/delay remain unchanged unless explicitly recalculated.
    }

    // --- Methods required by AudioNode trait implementation below ---
    fn node_type_str(&self) -> &str {
        "limiter"
    }
    fn is_node_active(&self) -> bool {
        self.enabled
    }
    fn set_node_active(&mut self, active: bool) {
        if active && !self.enabled {
            // Reset state when activating to avoid pops/clicks from old state
            self.reset_state();
        }
        self.enabled = active;
    }
    fn as_any_internal_mut(&mut self) -> &mut dyn Any {
        self
    }
    fn as_any_internal(&self) -> &dyn Any {
        self
    }
} // impl Limiter

// --- AudioNode Trait Implementation ---
impl AudioNode for Limiter {
    fn get_ports(&self) -> FxHashMap<PortId, bool> {
        FxHashMap::from_iter([
            (PortId::AudioInput0, false),
            (PortId::AudioInput1, false),
            (PortId::AudioOutput0, true),
            (PortId::AudioOutput1, true),
        ])
    }

    fn process(
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        self.process_block(inputs, outputs, buffer_size);
    }

    fn reset(&mut self) {
        self.reset_state();
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self.as_any_internal_mut()
    }
    fn as_any(&self) -> &dyn Any {
        self.as_any_internal()
    }
    fn is_active(&self) -> bool {
        self.is_node_active()
    }
    fn set_active(&mut self, active: bool) {
        self.set_node_active(active);
    }
    fn node_type(&self) -> &str {
        self.node_type_str()
    }
}
