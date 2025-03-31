use rustc_hash::FxHashMap;
use std::any::Any;
use std::f32::consts::{PI, TAU};

use crate::graph::ModulationSource; // Assuming this path is correct for your project
use crate::traits::{AudioNode, PortId}; // Assuming this path is correct

const MAX_PROCESS_BUFFER_SIZE: usize = 128;
static ZERO_BUFFER: [f32; MAX_PROCESS_BUFFER_SIZE] = [0.0; MAX_PROCESS_BUFFER_SIZE];

// --- FIR Filter Implementation ---
#[derive(Clone)]
struct FirFilter {
    coefficients: Vec<f32>,
    buffer: Vec<f32>,
    buffer_pos: usize,
}

impl FirFilter {
    fn new(coefficients: Vec<f32>) -> Self {
        let buffer_len = coefficients.len();
        assert!(buffer_len > 0, "FIR filter must have at least one tap.");
        Self {
            coefficients,
            buffer: vec![0.0; buffer_len],
            buffer_pos: 0,
        }
    }

    #[inline(always)]
    fn process(&mut self, input: f32) -> f32 {
        let buffer_len = self.buffer.len();
        debug_assert_eq!(
            self.coefficients.len(),
            buffer_len,
            "FIR coeff/buffer length mismatch"
        );

        self.buffer[self.buffer_pos] = input;

        let mut output = 0.0;
        let current_pos = self.buffer_pos;
        let mut read_pos = current_pos;

        for &coeff in &self.coefficients {
            output += coeff * self.buffer[read_pos];
            read_pos = if read_pos == 0 {
                buffer_len - 1
            } else {
                read_pos - 1
            };
        }

        self.buffer_pos = (self.buffer_pos + 1) % buffer_len;
        output
    }

    fn reset(&mut self) {
        self.buffer.fill(0.0);
        self.buffer_pos = 0;
    }

    #[inline(always)]
    #[allow(dead_code)] // Keep if potentially useful elsewhere, but mark unused for now
    fn process_zeros(&mut self, count: usize) -> Vec<f32> {
        let mut outputs = Vec::with_capacity(count);
        for _ in 0..count {
            outputs.push(self.process(0.0));
        }
        outputs
    }
}

// --- FIR Coefficient Generation ---
fn generate_fir_coeffs(
    num_taps: usize,
    cutoff_normalized: f32,
    window: fn(usize, usize) -> f32,
) -> Vec<f32> {
    assert!(num_taps > 0, "Number of taps must be positive.");
    assert!(
        num_taps % 2 != 0,
        "Use an odd number of taps for a Type 1 linear phase FIR (zero delay at center)."
    );
    assert!(
        cutoff_normalized > 0.0 && cutoff_normalized < 0.5,
        "Normalized cutoff must be between 0 and 0.5"
    );

    let mut coeffs = vec![0.0; num_taps];
    let center = (num_taps / 2) as isize;
    let mut sum = 0.0;

    for i in 0..num_taps {
        let n = i as isize - center;
        let val = if n == 0 {
            2.0 * cutoff_normalized
        } else {
            (TAU * cutoff_normalized * n as f32).sin() / (PI * n as f32)
        };
        let win_val = window(i, num_taps);
        coeffs[i] = val * win_val;
        sum += coeffs[i];
    }

    if sum.abs() > 1e-6 {
        let inv_sum = 1.0 / sum;
        for c in coeffs.iter_mut() {
            *c *= inv_sum;
        }
    } else {
        eprintln!("Warning: FIR filter coefficient sum is near zero. Check parameters. Setting center tap to 1.");
        coeffs.fill(0.0);
        if num_taps > 0 {
            coeffs[center as usize] = 1.0;
        }
    }
    coeffs
}

fn blackman_window(n: usize, num_taps: usize) -> f32 {
    if num_taps <= 1 {
        return 1.0;
    }
    let m = (num_taps - 1) as f32;
    let nn = n as f32;
    0.42 - 0.5 * (TAU * nn / m).cos() + 0.08 * (2.0 * TAU * nn / m).cos()
}

// --- DC Blocker (First-Order High-Pass Filter) ---
#[derive(Clone, Copy, Debug)]
struct DcBlocker {
    // y[n] = x[n] - x[n-1] + alpha * y[n-1]
    x_prev: f32,
    y_prev: f32,
    alpha: f32, // Filter coefficient, close to 1.0
}

impl DcBlocker {
    fn new(alpha: f32) -> Self {
        Self {
            x_prev: 0.0,
            y_prev: 0.0,
            // Ensure alpha is reasonable, clamp if necessary, though calculation should handle it
            alpha: alpha.clamp(0.9, 0.99999),
        }
    }

    #[inline(always)]
    fn process(&mut self, input: f32) -> f32 {
        let output = input - self.x_prev + self.alpha * self.y_prev;
        self.x_prev = input;
        // Denormal prevention: Add and subtract a tiny value.
        // Might not be strictly necessary depending on target FPU, but good practice.
        self.y_prev = output + 1.0e-18 - 1.0e-18;
        output
    }

    fn reset(&mut self) {
        self.x_prev = 0.0;
        self.y_prev = 0.0;
    }
}

/// Calculates the coefficient `alpha` for a first-order IIR DC blocker (HPF).
/// alpha = R*C / (R*C + dt) where dt = 1/sample_rate
/// R*C = 1 / (TAU * cutoff_hz)
fn dc_blocker_alpha(cutoff_hz: f32, sample_rate: f32) -> f32 {
    if cutoff_hz <= 0.0 || sample_rate <= 0.0 {
        return 1.0; // Effectively bypasses the filter
    }
    let rc = 1.0 / (TAU * cutoff_hz);
    let dt = 1.0 / sample_rate;
    rc / (rc + dt)
}

// --- Helper Functions ---
#[inline(always)]
fn smooth_parameter(current: f32, target: f32, coefficient: f32) -> f32 {
    current * coefficient + target * (1.0 - coefficient)
}

// --- Chorus Struct Definition ---
pub struct Chorus {
    enabled: bool,
    sample_rate: f32, // Store original sample rate for DC blocker calculation
    oversample_factor: usize,
    internal_sample_rate: f32,
    inv_internal_sample_rate: f32,
    delay_buffer_left: Vec<f32>,
    delay_buffer_right: Vec<f32>,
    upsampled_input_left: Vec<f32>,
    upsampled_input_right: Vec<f32>,
    processed_oversampled_left: Vec<f32>,
    processed_oversampled_right: Vec<f32>,
    write_index: usize,
    max_delay_samples: usize,
    max_safe_read_delay: f32,
    lfo_phase_left: f32,
    lfo_phase_right: f32,
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
    param_smooth_coeff: f32,
    upsample_filter_left: FirFilter,
    upsample_filter_right: FirFilter,
    downsample_filter_left: FirFilter,
    downsample_filter_right: FirFilter,
    // DC Blockers for output stage
    output_dc_blocker_l: DcBlocker,
    output_dc_blocker_r: DcBlocker,
}

const INTERPOLATION_MARGIN: usize = 3; // Samples needed for cubic interpolation edges
const DC_BLOCKER_CUTOFF_HZ: f32 = 10.0; // Cutoff for DC blocking HPF

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
        oversample_factor: usize,
    ) -> Self {
        assert!(sample_rate > 0.0, "Sample rate must be positive");
        assert!(
            max_base_delay_ms >= 0.0,
            "Max base delay must be non-negative"
        );
        assert!(
            oversample_factor == 1 || oversample_factor == 2 || oversample_factor == 4,
            "Oversample factor must be 1, 2 or 4"
        );

        let internal_sample_rate = sample_rate * oversample_factor as f32;
        let inv_internal_sample_rate = if internal_sample_rate > 0.0 {
            1.0 / internal_sample_rate
        } else {
            0.0
        };

        // Calculate required delay buffer size based on max modulated delay
        // Add some margin for modulation depth and interpolation
        let max_modulated_delay_ms = max_base_delay_ms + 20.0; // Heuristic extra margin
        let required_samples_for_delay =
            (max_modulated_delay_ms / 1000.0 * internal_sample_rate).ceil() as usize;

        // Total buffer needs space for delay + interpolation margin
        let max_delay_samples = required_samples_for_delay + INTERPOLATION_MARGIN;
        // Maximum delay we can safely read without reading into potentially unwritten future samples
        let max_safe_read_delay = (max_delay_samples - INTERPOLATION_MARGIN).max(0) as f32;

        // Initial parameter values converted to internal sample rate units
        let initial_base_delay_samples = (base_delay_ms / 1000.0 * internal_sample_rate).max(0.0);
        let initial_depth_samples = (depth_ms / 1000.0 * internal_sample_rate * 0.5).abs(); // Depth is half peak-to-peak
        let initial_lfo_rate_hz = lfo_rate_hz.max(0.0);
        let initial_lfo_phase_increment = TAU * initial_lfo_rate_hz * inv_internal_sample_rate;
        let initial_feedback = feedback.clamp(-0.98, 0.98); // Limit feedback slightly below +/-1
        let initial_mix = mix.clamp(0.0, 1.0);
        let initial_lfo_stereo_phase_offset_rad = stereo_phase_offset_deg.to_radians();

        // Parameter smoothing coefficient calculation
        let smoothing_time_ms = 2.0;
        let param_smooth_coeff = if internal_sample_rate > 0.0 {
            let smoothing_time_samples_internal = smoothing_time_ms * 0.001 * internal_sample_rate;
            if smoothing_time_samples_internal > 1.0 {
                // exp(-1 / time_constant_samples)
                (-1.0 / smoothing_time_samples_internal).exp()
            } else {
                0.0 // Instant change if smoothing time is too short
            }
        } else {
            0.0
        };

        // Setup oversampling filters
        let (
            upsample_filter_left,
            upsample_filter_right,
            downsample_filter_left,
            downsample_filter_right,
        ) = if oversample_factor > 1 {
            // Design FIR filters for anti-aliasing / anti-imaging
            let normalized_cutoff = 0.5 / oversample_factor as f32;
            // Set cutoff slightly below Nyquist to allow for transition band
            let filter_cutoff = normalized_cutoff * 0.90;
            // Number of taps - more taps = sharper filter, higher CPU cost. Must be odd.
            let num_taps = 63;
            let base_coeffs = generate_fir_coeffs(num_taps, filter_cutoff, blackman_window);

            // Upsampling filter needs gain compensation
            let mut upsample_coeffs = base_coeffs.clone();
            let gain = oversample_factor as f32;
            for c in upsample_coeffs.iter_mut() {
                *c *= gain;
            }
            // Downsampling filter uses the base coefficients (gain = 1)
            let downsample_coeffs = base_coeffs;

            (
                FirFilter::new(upsample_coeffs.clone()),
                FirFilter::new(upsample_coeffs),
                FirFilter::new(downsample_coeffs.clone()),
                FirFilter::new(downsample_coeffs),
            )
        } else {
            // No oversampling, use simple pass-through filters (single tap = 1.0)
            let pass_through_coeffs = vec![1.0];
            (
                FirFilter::new(pass_through_coeffs.clone()),
                FirFilter::new(pass_through_coeffs.clone()),
                FirFilter::new(pass_through_coeffs.clone()),
                FirFilter::new(pass_through_coeffs),
            )
        };

        // Allocate intermediate buffers (sized for max possible block size * oversample factor)
        let max_buf_size_oversampled = MAX_PROCESS_BUFFER_SIZE * oversample_factor;

        // Initialize DC Blockers using the *original* sample rate
        let dc_alpha = dc_blocker_alpha(DC_BLOCKER_CUTOFF_HZ, sample_rate);
        let output_dc_blocker_l = DcBlocker::new(dc_alpha);
        let output_dc_blocker_r = DcBlocker::new(dc_alpha);

        Self {
            enabled: true,
            sample_rate, // Store original sample rate
            oversample_factor,
            internal_sample_rate,
            inv_internal_sample_rate,
            delay_buffer_left: vec![0.0; max_delay_samples],
            delay_buffer_right: vec![0.0; max_delay_samples],
            upsampled_input_left: vec![0.0; max_buf_size_oversampled],
            upsampled_input_right: vec![0.0; max_buf_size_oversampled],
            processed_oversampled_left: vec![0.0; max_buf_size_oversampled],
            processed_oversampled_right: vec![0.0; max_buf_size_oversampled],
            write_index: 0,
            max_delay_samples,
            max_safe_read_delay,
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
            lfo_phase_right: initial_lfo_stereo_phase_offset_rad.rem_euclid(TAU), // Ensure phase starts within 0..TAU
            param_smooth_coeff,
            upsample_filter_left,
            upsample_filter_right,
            downsample_filter_left,
            downsample_filter_right,
            output_dc_blocker_l,
            output_dc_blocker_r,
        }
    }

    // --- Parameter Setters (update target values) ---
    pub fn set_base_delay_ms(&mut self, delay_ms: f32) {
        self.target_base_delay_samples = (delay_ms * 0.001 * self.internal_sample_rate).max(0.0);
    }
    pub fn set_depth_ms(&mut self, depth_ms: f32) {
        // Depth parameter typically controls half the peak-to-peak modulation range
        self.target_depth_samples = (depth_ms * 0.001 * self.internal_sample_rate * 0.5).abs();
    }
    pub fn set_rate_hz(&mut self, rate_hz: f32) {
        self.target_lfo_rate_hz = rate_hz.max(0.0);
    }
    pub fn set_feedback(&mut self, feedback: f32) {
        self.target_feedback = feedback.clamp(-0.98, 0.98); // Keep slightly away from instability
    }
    pub fn set_mix(&mut self, mix: f32) {
        self.target_mix = mix.clamp(0.0, 1.0);
    }
    pub fn set_stereo_phase_offset_deg(&mut self, offset_deg: f32) {
        self.target_lfo_stereo_phase_offset_rad = offset_deg.to_radians();
        // Update the *current* right phase immediately based on the new offset relative to the left
        self.lfo_phase_right =
            (self.lfo_phase_left + self.target_lfo_stereo_phase_offset_rad).rem_euclid(TAU);
    }

    /// Reads from the delay buffer using cubic interpolation.
    #[inline(always)]
    fn read_cubic_interpolated(
        buffer: &[f32],
        delay_samples: f32,       // Desired delay in samples (can be fractional)
        write_index: usize,       // Current write position in the buffer
        max_delay_samples: usize, // Total size of the delay buffer
        max_safe_read_delay: f32, // Max delay readable without hitting interpolation margin
    ) -> f32 {
        // Clamp delay to ensure we don't read too close to the write head where interpolation fails
        let clamped_delay = delay_samples.clamp(0.0, max_safe_read_delay);

        // Calculate the floating point read position, wrapping around the buffer
        let read_pos_float = (write_index as f32 - clamped_delay + max_delay_samples as f32)
            % max_delay_samples as f32;

        let index_frac = read_pos_float.fract(); // Fractional part for interpolation (t)
        let index_int = read_pos_float.floor() as usize; // Integer part

        // Calculate the indices of the 4 points needed for cubic interpolation, wrapping around
        let i_1 = (index_int + max_delay_samples - 1) % max_delay_samples; // y-1
        let i0 = index_int; // y0
        let i1 = (index_int + 1) % max_delay_samples; // y1
        let i2 = (index_int + 2) % max_delay_samples; // y2

        // Get the sample values at these points
        let p0 = buffer[i_1]; // y-1
        let p1 = buffer[i0]; // y0
        let p2 = buffer[i1]; // y1
        let p3 = buffer[i2]; // y2

        // Catmull-Rom cubic interpolation formula
        let t = index_frac;
        let t2 = t * t;
        let t3 = t2 * t;

        0.5 * ((2.0 * p1)
            + (-p0 + p2) * t
            + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
            + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3)
    }

    // --- MAIN PROCESS FUNCTION ---
    #[inline(never)] // Don't inline the whole process block
    pub fn process_block(
        // Renamed to avoid conflict with trait method if called directly
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // --- Basic Sanity Checks ---
        if buffer_size == 0 {
            return; // Nothing to process
        }
        if buffer_size > MAX_PROCESS_BUFFER_SIZE {
            eprintln!(
                "Chorus Error: process buffer_size ({}) exceeds MAX_PROCESS_BUFFER_SIZE ({}). Zeroing output.",
                buffer_size, MAX_PROCESS_BUFFER_SIZE
            );
            // Safely zero output buffers (Error 1 & 2 Fix Applied)
            if let Some(out_l) = outputs.get_mut(&PortId::AudioOutput0) {
                let len = out_l.len();
                let fill_len = buffer_size.min(len);
                out_l[..fill_len].fill(0.0);
            }
            if let Some(out_r) = outputs.get_mut(&PortId::AudioOutput1) {
                let len = out_r.len();
                let fill_len = buffer_size.min(len);
                out_r[..fill_len].fill(0.0);
            }
            return;
        }

        // --- Get Output Buffer Pointers/Slices Safely ---
        // Use raw pointer for left temporarily to allow mutable borrow of right later
        let out_left_ptr: *mut [f32] = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(slice_ref_mut) => *slice_ref_mut as *mut [f32],
            None => {
                eprintln!("Chorus Error: Missing AudioOutput0");
                // Try to zero the right output if it exists
                if let Some(out_r) = outputs.get_mut(&PortId::AudioOutput1) {
                    let len = out_r.len();
                    let fill_len = buffer_size.min(len);
                    out_r[..fill_len].fill(0.0);
                }
                return;
            }
        };
        // Now get the right output slice mutably
        let out_right: &mut [f32] = match outputs.get_mut(&PortId::AudioOutput1) {
            Some(slice_ref_mut) => slice_ref_mut,
            None => {
                eprintln!("Chorus Error: Missing AudioOutput1");
                // Zero the left output using the pointer (Error 3 Fix Applied)
                unsafe {
                    let out_left_slice = &mut *out_left_ptr;
                    let len = out_left_slice.len();
                    let fill_len = buffer_size.min(len);
                    out_left_slice[..fill_len].fill(0.0);
                }
                return;
            }
        };

        // --- Handle Disabled State (Passthrough) ---
        if !self.enabled {
            // Get input slices, falling back to zeros or left channel for mono->stereo
            let left_in_slice = inputs
                .get(&PortId::AudioInput0)
                .and_then(|v| v.first())
                .map_or(&ZERO_BUFFER[..buffer_size], |s| s.buffer.as_slice());
            let right_in_slice = inputs
                .get(&PortId::AudioInput1)
                .and_then(|v| v.first())
                .map_or(left_in_slice, |s| s.buffer.as_slice()); // Use left if right missing

            // Safely perform the copy using calculated minimum length
            unsafe {
                let out_left = &mut *out_left_ptr; // Dereference pointer safely now
                let proc_len = buffer_size
                    .min(left_in_slice.len())
                    .min(right_in_slice.len())
                    .min(out_left.len())
                    .min(out_right.len());

                if proc_len > 0 {
                    out_left[..proc_len].copy_from_slice(&left_in_slice[..proc_len]);
                    out_right[..proc_len].copy_from_slice(&right_in_slice[..proc_len]);
                }

                // Zero remaining parts of output buffers if they are longer
                if proc_len < out_left.len() {
                    out_left[proc_len..].fill(0.0);
                }
                if proc_len < out_right.len() {
                    out_right[proc_len..].fill(0.0);
                }
            }
            return; // Finished processing (passthrough)
        }

        // --- Get Input Buffers (Enabled State) ---
        let left_in_slice = inputs
            .get(&PortId::AudioInput0)
            .and_then(|v| v.first())
            .map_or(&ZERO_BUFFER[..buffer_size], |s| s.buffer.as_slice());
        let right_in_slice = inputs
            .get(&PortId::AudioInput1)
            .and_then(|v| v.first())
            .map_or(left_in_slice, |s| s.buffer.as_slice()); // Use left if right missing

        // --- Determine Actual Processing Length (minimum of all involved buffers) ---
        let process_len = {
            let len_l = unsafe { (*out_left_ptr).len() }; // Get len from pointer safely
            let len_r = out_right.len();
            buffer_size
                .min(len_l)
                .min(len_r)
                .min(left_in_slice.len())
                .min(right_in_slice.len())
        };

        // If calculated length is zero, zero outputs and return
        if process_len == 0 {
            unsafe {
                let out_left = &mut *out_left_ptr;
                // (Error 4 & 5 Fix Applied)
                let len_l = out_left.len();
                let fill_len_l = len_l.min(buffer_size); // Use buffer_size as requested max
                out_left[..fill_len_l].fill(0.0);

                let len_r = out_right.len();
                let fill_len_r = len_r.min(buffer_size);
                out_right[..fill_len_r].fill(0.0);
            }
            return;
        }

        // Get actual input slices based on process_len
        let left_in = &left_in_slice[..process_len];
        let right_in = &right_in_slice[..process_len];

        // --- Smooth Parameters (Per Block) ---
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
        // Calculate target phase increment based on potentially changed rate
        let target_lfo_phase_increment =
            TAU * self.target_lfo_rate_hz * self.inv_internal_sample_rate;
        self.current_lfo_phase_increment = smooth_parameter(
            self.current_lfo_phase_increment,
            target_lfo_phase_increment,
            coeff,
        );
        // Note: LFO phase offset change takes effect immediately in the setter

        // --- Upsampling (if enabled) ---
        let oversample_factor = self.oversample_factor;
        let internal_buffer_len = process_len * oversample_factor;

        // Get slices of the internal oversampled buffers
        let upsampled_l = &mut self.upsampled_input_left[..internal_buffer_len];
        let upsampled_r = &mut self.upsampled_input_right[..internal_buffer_len];
        let processed_l = &mut self.processed_oversampled_left[..internal_buffer_len];
        let processed_r = &mut self.processed_oversampled_right[..internal_buffer_len];

        if oversample_factor > 1 {
            let mut up_idx = 0;
            let up_filter_l = &mut self.upsample_filter_left;
            let up_filter_r = &mut self.upsample_filter_right;
            for i in 0..process_len {
                // Process the actual input sample
                upsampled_l[up_idx] = up_filter_l.process(left_in[i]);
                upsampled_r[up_idx] = up_filter_r.process(right_in[i]);
                up_idx += 1;
                // Process zeros for interpolation samples
                for _ in 1..oversample_factor {
                    upsampled_l[up_idx] = up_filter_l.process(0.0);
                    upsampled_r[up_idx] = up_filter_r.process(0.0);
                    up_idx += 1;
                }
            }
        } else {
            // No oversampling: Just copy input to the 'upsampled' buffer (which is same size)
            upsampled_l[..process_len].copy_from_slice(left_in);
            upsampled_r[..process_len].copy_from_slice(right_in);
        }

        // --- Core Chorus Processing Loop (Oversampled Domain) ---
        {
            // Inner scope to limit mutable borrows of self
            // Cache frequently used values from self
            let mut lfo_phase_left = self.lfo_phase_left;
            let mut lfo_phase_right = self.lfo_phase_right;
            let phase_inc = self.current_lfo_phase_increment;
            let base_delay = self.current_base_delay_samples;
            let depth = self.current_depth_samples;
            let feedback = self.current_feedback;
            let mix = self.current_mix;
            let dry_level = 1.0 - mix;
            let wet_level = mix;
            let max_delay_samples = self.max_delay_samples;
            let max_safe_read_delay = self.max_safe_read_delay;
            let mut current_write_index = self.write_index;
            let delay_buf_l = &mut self.delay_buffer_left; // Mutable borrow
            let delay_buf_r = &mut self.delay_buffer_right; // Mutable borrow

            for i in 0..internal_buffer_len {
                // Calculate LFO modulation for delay times
                let lfo_val_left = lfo_phase_left.sin();
                let lfo_val_right = lfo_phase_right.sin();

                let delay_smpls_left = base_delay + lfo_val_left * depth;
                let delay_smpls_right = base_delay + lfo_val_right * depth;

                // Read delayed samples using interpolation
                let delayed_left = Self::read_cubic_interpolated(
                    delay_buf_l, // Pass borrowed slice
                    delay_smpls_left,
                    current_write_index,
                    max_delay_samples,
                    max_safe_read_delay,
                );
                let delayed_right = Self::read_cubic_interpolated(
                    delay_buf_r, // Pass borrowed slice
                    delay_smpls_right,
                    current_write_index,
                    max_delay_samples,
                    max_safe_read_delay,
                );

                // Get current input sample (already upsampled)
                let current_input_l = upsampled_l[i];
                let current_input_r = upsampled_r[i];

                // Calculate feedback term
                let feedback_term_l = feedback * delayed_left;
                let feedback_term_r = feedback * delayed_right;

                // Calculate value to write into delay line (input + feedback)
                // Optional: apply soft clipping here if feedback can cause overload
                let write_val_left = (current_input_l + feedback_term_l).tanh(); // Example soft clip
                let write_val_right = (current_input_r + feedback_term_r).tanh(); // Example soft clip

                delay_buf_l[current_write_index] = write_val_left;
                delay_buf_r[current_write_index] = write_val_right;

                // Calculate output sample (dry/wet mix)
                processed_l[i] = current_input_l * dry_level + delayed_left * wet_level;
                processed_r[i] = current_input_r * dry_level + delayed_right * wet_level;

                // Advance LFO phases
                lfo_phase_left = (lfo_phase_left + phase_inc).rem_euclid(TAU);
                lfo_phase_right = (lfo_phase_right + phase_inc).rem_euclid(TAU);

                // Advance write index
                current_write_index = (current_write_index + 1) % max_delay_samples;
            }

            // Write back updated state to self
            self.lfo_phase_left = lfo_phase_left;
            self.lfo_phase_right = lfo_phase_right;
            self.write_index = current_write_index;
        } // End inner scope, mutable borrows of delay buffers released

        // --- Downsampling and Output ---
        unsafe {
            // Get mutable slices from the pointers/map references, sized to process_len
            let out_left = &mut (*out_left_ptr)[..process_len];
            let out_right = &mut out_right[..process_len];

            if oversample_factor > 1 {
                let mut out_idx = 0;
                let down_filter_l = &mut self.downsample_filter_left;
                let down_filter_r = &mut self.downsample_filter_right;

                // Process downsampling filters
                for i in 0..internal_buffer_len {
                    let filtered_l = down_filter_l.process(processed_l[i]);
                    let filtered_r = down_filter_r.process(processed_r[i]);

                    // Decimate: Take only the first sample of each oversampled group
                    if i % oversample_factor == 0 {
                        if out_idx < process_len {
                            // Write the downsampled value
                            out_left[out_idx] = filtered_l;
                            out_right[out_idx] = filtered_r;
                            out_idx += 1;
                        } else {
                            // This shouldn't happen if logic is correct, but good to check
                            eprintln!("Chorus Error: Output buffer overrun during downsampling!");
                            break;
                        }
                    }
                }
                // Assertion for debugging: check if we filled the output buffer exactly
                debug_assert!(
                    out_idx == process_len,
                    "Downsampling mismatch: expected {}, got {}",
                    process_len,
                    out_idx
                );

                // --- Apply DC Blocker to the final downsampled output ---
                for i in 0..process_len {
                    out_left[i] = self.output_dc_blocker_l.process(out_left[i]);
                    out_right[i] = self.output_dc_blocker_r.process(out_right[i]);
                }
            } else {
                // No oversampling
                // Copy directly from processed buffer
                out_left[..process_len].copy_from_slice(&processed_l[..process_len]);
                out_right[..process_len].copy_from_slice(&processed_r[..process_len]);

                // --- Apply DC Blocker to the output ---
                for i in 0..process_len {
                    out_left[i] = self.output_dc_blocker_l.process(out_left[i]);
                    out_right[i] = self.output_dc_blocker_r.process(out_right[i]);
                }
            }

            // --- Final Clipping (Optional but Recommended) ---
            // Prevent hard clips if processing introduced large values
            for i in 0..process_len {
                out_left[i] = out_left[i].clamp(-1.0, 1.0);
                out_right[i] = out_right[i].clamp(-1.0, 1.0);
            }

            // Zero any remaining part of the output buffers if they were larger than process_len
            // This is needed if the input buffers were shorter than the output buffers
            let out_left_full = &mut *out_left_ptr;
            if process_len < out_left_full.len() {
                out_left_full[process_len..].fill(0.0);
            }
            // out_right is already the full slice from the map
            if process_len < out_right.len() {
                out_right[process_len..].fill(0.0);
            }
        } // end unsafe block
    } // end process_block

    /// Resets the internal state of the Chorus node.
    pub fn reset_state(&mut self) {
        // Renamed to avoid conflict with trait method
        self.delay_buffer_left.fill(0.0);
        self.delay_buffer_right.fill(0.0);
        self.write_index = 0;
        self.lfo_phase_left = 0.0;
        // Reset right phase based on current offset target
        self.lfo_phase_right = self.target_lfo_stereo_phase_offset_rad.rem_euclid(TAU);

        // Reset filters if oversampling is used
        if self.oversample_factor > 1 {
            self.upsample_filter_left.reset();
            self.upsample_filter_right.reset();
            self.downsample_filter_left.reset();
            self.downsample_filter_right.reset();
        }

        // Reset DC blockers
        self.output_dc_blocker_l.reset();
        self.output_dc_blocker_r.reset();

        // Reset smoothed parameters to target values instantly
        self.current_base_delay_samples = self.target_base_delay_samples;
        self.current_depth_samples = self.target_depth_samples;
        self.current_lfo_phase_increment =
            TAU * self.target_lfo_rate_hz * self.inv_internal_sample_rate;
        self.current_feedback = self.target_feedback;
        self.current_mix = self.target_mix;

        // Clear intermediate buffers (optional, but good practice)
        self.upsampled_input_left.fill(0.0);
        self.upsampled_input_right.fill(0.0);
        self.processed_oversampled_left.fill(0.0);
        self.processed_oversampled_right.fill(0.0);
    }

    // --- Methods required by AudioNode trait implementation below ---
    fn node_type_str(&self) -> &str {
        "chorus"
    }
    fn is_node_active(&self) -> bool {
        self.enabled
    }
    fn set_node_active(&mut self, active: bool) {
        if active && !self.enabled {
            // Reset state when activating to avoid stale buffer contents
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
} // impl Chorus

// --- AudioNode Trait Implementation ---
impl AudioNode for Chorus {
    fn get_ports(&self) -> FxHashMap<PortId, bool> {
        FxHashMap::from_iter([
            (PortId::AudioInput0, false), // Input, not output
            (PortId::AudioInput1, false), // Input, not output
            (PortId::AudioOutput0, true), // Output
            (PortId::AudioOutput1, true), // Output
        ])
    }

    /// Main processing function called by the audio graph.
    fn process(
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // Delegate to the main block processing method
        self.process_block(inputs, outputs, buffer_size);
    }

    /// Resets the node's internal state.
    fn reset(&mut self) {
        self.reset_state();
    }

    // --- Boilerplate Any casting for downcasting ---
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self.as_any_internal_mut()
    }
    fn as_any(&self) -> &dyn Any {
        self.as_any_internal()
    }

    /// Returns whether the node is currently active/enabled.
    fn is_active(&self) -> bool {
        self.is_node_active()
    }

    /// Sets the active/enabled state of the node.
    fn set_active(&mut self, active: bool) {
        self.set_node_active(active);
    }

    /// Returns a string identifier for the node type.
    fn node_type(&self) -> &str {
        self.node_type_str()
    }
}
