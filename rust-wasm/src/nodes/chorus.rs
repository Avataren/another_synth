use rustc_hash::FxHashMap;
use std::any::Any;
use std::f32::consts::{PI, TAU};

use crate::graph::ModulationSource; // Assuming these paths are correct for your project
use crate::traits::{AudioNode, PortId};

const MAX_PROCESS_BUFFER_SIZE: usize = 128;
static ZERO_BUFFER: [f32; MAX_PROCESS_BUFFER_SIZE] = [0.0; MAX_PROCESS_BUFFER_SIZE];

// ────────────────
// FIR Filter Implementation (Unchanged)
// ────────────────
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
    #[allow(dead_code)]
    fn process_zeros(&mut self, count: usize) -> Vec<f32> {
        let mut outputs = Vec::with_capacity(count);
        for _ in 0..count {
            outputs.push(self.process(0.0));
        }
        outputs
    }
}

// ────────────────
// FIR Coefficient Generation (Unchanged)
// ────────────────
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

// ────────────────
// DC Blocker (First-Order High-Pass Filter) – Unchanged
// ────────────────
#[derive(Clone, Copy, Debug)]
struct DcBlocker {
    x_prev: f32,
    y_prev: f32,
    alpha: f32,
}

impl DcBlocker {
    fn new(alpha: f32) -> Self {
        Self {
            x_prev: 0.0,
            y_prev: 0.0,
            alpha: alpha.clamp(0.9, 0.99999),
        }
    }

    #[inline(always)]
    fn process(&mut self, input: f32) -> f32 {
        let output = input - self.x_prev + self.alpha * self.y_prev;
        self.x_prev = input;
        self.y_prev = output + 1.0e-18 - 1.0e-18; // Denormal fix
        output
    }

    fn reset(&mut self) {
        self.x_prev = 0.0;
        self.y_prev = 0.0;
    }
}

fn dc_blocker_alpha(cutoff_hz: f32, sample_rate: f32) -> f32 {
    if cutoff_hz <= 0.0 || sample_rate <= 0.0 {
        return 1.0;
    }
    let rc = 1.0 / (TAU * cutoff_hz);
    let dt = 1.0 / sample_rate;
    rc / (rc + dt)
}

#[inline(always)]
fn smooth_parameter(current: f32, target: f32, coefficient: f32) -> f32 {
    current * coefficient + target * (1.0 - coefficient)
}

// ────────────────
// Optimized Chorus DSP Node with Hardcoded 4× Oversampling and Cascaded FIR (Multipass)
// ────────────────

// Here we hardcode oversample factor to 4.
const OVERSAMPLE: usize = 4;
const INTERPOLATION_MARGIN: usize = 3;
const DC_BLOCKER_CUTOFF_HZ: f32 = 10.0;

pub struct Chorus {
    enabled: bool,
    sample_rate: f32,
    // Internal (oversampled) sample rate is fixed to 4× the original:
    internal_sample_rate: f32,
    inv_internal_sample_rate: f32,
    delay_buffer_left: Vec<f32>,
    delay_buffer_right: Vec<f32>,
    // Buffers for intermediate upsampling and delay processing:
    // “Stage 1” is the output of the first FIR pass (upsample cascade)
    upsample_stage1_left: Vec<f32>,
    upsample_stage1_right: Vec<f32>,
    // Final upsampled input after multipass FIR filtering
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
    // Cascaded (multipass) upsampling FIR filters per channel:
    upsample_filter1_left: FirFilter,
    upsample_filter1_right: FirFilter,
    upsample_filter2_left: FirFilter,
    upsample_filter2_right: FirFilter,
    // Cascaded (multipass) downsampling FIR filters per channel:
    downsample_filter1_left: FirFilter,
    downsample_filter1_right: FirFilter,
    downsample_filter2_left: FirFilter,
    downsample_filter2_right: FirFilter,
    // DC Blockers for output stage
    output_dc_blocker_l: DcBlocker,
    output_dc_blocker_r: DcBlocker,
    scratch_downsample_stage: Vec<f32>,
    scratch_downsampled: Vec<f32>,
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
        // Remove oversample factor parameter – we hardcode 4× oversampling.
    ) -> Self {
        assert!(sample_rate > 0.0, "Sample rate must be positive");
        let max_buf_size_oversampled = MAX_PROCESS_BUFFER_SIZE * OVERSAMPLE;
        let internal_sample_rate = sample_rate * OVERSAMPLE as f32;
        let inv_internal_sample_rate = 1.0 / internal_sample_rate;

        // Calculate delay buffer length using a heuristic margin.
        let max_modulated_delay_ms = max_base_delay_ms + 20.0;
        let required_samples_for_delay =
            (max_modulated_delay_ms / 1000.0 * internal_sample_rate).ceil() as usize;
        let max_delay_samples = required_samples_for_delay + INTERPOLATION_MARGIN;
        let max_safe_read_delay = (max_delay_samples - INTERPOLATION_MARGIN).max(0) as f32;

        // Convert initial parameters to internal sample rate units
        let initial_base_delay_samples = (base_delay_ms / 1000.0 * internal_sample_rate).max(0.0);
        let initial_depth_samples = (depth_ms / 1000.0 * internal_sample_rate * 0.5).abs();
        let initial_lfo_rate_hz = lfo_rate_hz.max(0.0);
        let initial_lfo_phase_increment = TAU * initial_lfo_rate_hz * inv_internal_sample_rate;
        let initial_feedback = feedback.clamp(-0.98, 0.98);
        let initial_mix = mix.clamp(0.0, 1.0);
        let initial_lfo_stereo_phase_offset_rad = stereo_phase_offset_deg.to_radians();

        let smoothing_time_ms = 0.1;
        let param_smooth_coeff = if internal_sample_rate > 0.0 {
            let smoothing_samples = smoothing_time_ms * 0.001 * internal_sample_rate;
            if smoothing_samples > 1.0 {
                (-1.0 / smoothing_samples).exp()
            } else {
                0.0
            }
        } else {
            0.0
        };

        // ---------- FIR Multipass Filter Design for Oversampling ----------
        // We use cascaded FIR filters on both the up- and downsampling stages.
        // For upsampling the original code multiplied the FIR coefficients by OVERSAMPLE (4),
        // but here we cascade two filters with gain 2 each so that 2 × 2 = 4.
        // We choose a slightly lower tap count for each stage (e.g. 31 taps) for efficiency.
        let num_taps = 31; // Must be odd.
        let normalized_cutoff = 0.5 / OVERSAMPLE as f32;
        // Reduce the cutoff a little for a transition band:
        let filter_cutoff = normalized_cutoff * 0.90;
        let base_coeffs = generate_fir_coeffs(num_taps, filter_cutoff, blackman_window);

        // Prepare upsampling coefficients – multiply by 2 for each stage:
        let mut up_coeffs = base_coeffs.clone();
        for c in up_coeffs.iter_mut() {
            *c *= 2.0;
        }
        // For downsampling, no extra gain compensation is needed.
        let down_coeffs = base_coeffs;

        // Create the cascaded FIR filters:
        let upsample_filter1_left = FirFilter::new(up_coeffs.clone());
        let upsample_filter1_right = FirFilter::new(up_coeffs.clone());
        let upsample_filter2_left = FirFilter::new(up_coeffs.clone());
        let upsample_filter2_right = FirFilter::new(up_coeffs.clone());
        let downsample_filter1_left = FirFilter::new(down_coeffs.clone());
        let downsample_filter1_right = FirFilter::new(down_coeffs.clone());
        let downsample_filter2_left = FirFilter::new(down_coeffs.clone());
        let downsample_filter2_right = FirFilter::new(down_coeffs);

        // Allocate buffers – note that oversampled block size is MAX_PROCESS_BUFFER_SIZE * OVERSAMPLE.
        let max_buf_size_oversampled = MAX_PROCESS_BUFFER_SIZE * OVERSAMPLE;
        Self {
            enabled: true,
            sample_rate,
            internal_sample_rate,
            inv_internal_sample_rate,
            delay_buffer_left: vec![0.0; max_delay_samples],
            delay_buffer_right: vec![0.0; max_delay_samples],
            // Buffers for the multipass upsampling stages:
            upsample_stage1_left: vec![0.0; max_buf_size_oversampled],
            upsample_stage1_right: vec![0.0; max_buf_size_oversampled],
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
            lfo_phase_right: initial_lfo_stereo_phase_offset_rad.rem_euclid(TAU),
            param_smooth_coeff,
            upsample_filter1_left,
            upsample_filter1_right,
            upsample_filter2_left,
            upsample_filter2_right,
            downsample_filter1_left,
            downsample_filter1_right,
            downsample_filter2_left,
            downsample_filter2_right,
            output_dc_blocker_l: DcBlocker::new(dc_blocker_alpha(
                DC_BLOCKER_CUTOFF_HZ,
                sample_rate,
            )),
            output_dc_blocker_r: DcBlocker::new(dc_blocker_alpha(
                DC_BLOCKER_CUTOFF_HZ,
                sample_rate,
            )),
            scratch_downsample_stage: vec![0.0; max_buf_size_oversampled],
            scratch_downsampled: vec![0.0; max_buf_size_oversampled],
        }
    }

    // Parameter setters remain unchanged (they update target values)
    pub fn set_base_delay_ms(&mut self, delay_ms: f32) {
        self.target_base_delay_samples = (delay_ms * 0.001 * self.internal_sample_rate).max(0.0);
    }
    pub fn set_depth_ms(&mut self, depth_ms: f32) {
        self.target_depth_samples = (depth_ms * 0.001 * self.internal_sample_rate * 0.5).abs();
    }
    pub fn set_rate_hz(&mut self, rate_hz: f32) {
        self.target_lfo_rate_hz = rate_hz.max(0.0);
    }
    pub fn set_feedback(&mut self, feedback: f32) {
        self.target_feedback = feedback.clamp(-0.98, 0.98);
    }
    pub fn set_mix(&mut self, mix: f32) {
        self.target_mix = mix.clamp(0.0, 1.0);
    }
    pub fn set_stereo_phase_offset_deg(&mut self, offset_deg: f32) {
        self.target_lfo_stereo_phase_offset_rad = offset_deg.to_radians();
        self.lfo_phase_right =
            (self.lfo_phase_left + self.target_lfo_stereo_phase_offset_rad).rem_euclid(TAU);
    }

    /// Cubic interpolation (unchanged except that clamping is done externally)
    #[inline(always)]
    fn read_cubic_interpolated(
        buffer: &[f32],
        delay_samples: f32,
        write_index: usize,
        max_delay_samples: usize,
    ) -> f32 {
        let read_pos_float = (write_index as f32 - delay_samples + max_delay_samples as f32)
            % max_delay_samples as f32;
        let index_frac = read_pos_float.fract();
        let index_int = read_pos_float.floor() as usize;
        let i_1 = (index_int + max_delay_samples - 1) % max_delay_samples;
        let i0 = index_int;
        let i1 = (index_int + 1) % max_delay_samples;
        let i2 = (index_int + 2) % max_delay_samples;
        let p0 = buffer[i_1];
        let p1 = buffer[i0];
        let p2 = buffer[i1];
        let p3 = buffer[i2];
        let t = index_frac;
        let t2 = t * t;
        let t3 = t2 * t;
        0.5 * ((2.0 * p1)
            + (-p0 + p2) * t
            + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
            + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3)
    }

    // ────────────────
    // Main Processing Function
    // ────────────────
    #[inline(never)]
    pub fn process_block(
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
            if let Some(out) = outputs.get_mut(&PortId::AudioOutput0) {
                let fill_len = buffer_size.min(out.len());
                {
                    let out_slice = &mut out[..fill_len];
                    out_slice.fill(0.0);
                }
            }
            if let Some(out_r) = outputs.get_mut(&PortId::AudioOutput1) {
                let fill_len = buffer_size.min(out_r.len());
                {
                    let out_r_slice = &mut out_r[..fill_len];
                    out_r_slice.fill(0.0);
                }
            }
            return;
        }

        // --- Get Output Buffer Pointers/Slices Safely ---
        let out_left_ptr: *mut [f32] = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(slice_ref_mut) => *slice_ref_mut as *mut [f32],
            None => {
                if let Some(out_r) = outputs.get_mut(&PortId::AudioOutput1) {
                    let fill_len = buffer_size.min(out_r.len());
                    {
                        let out_r_slice = &mut out_r[..fill_len];
                        out_r_slice.fill(0.0);
                    }
                }
                return;
            }
        };
        let out_right: &mut [f32] = match outputs.get_mut(&PortId::AudioOutput1) {
            Some(slice_ref_mut) => slice_ref_mut,
            None => {
                unsafe {
                    let out_left = &mut *out_left_ptr;
                    let fill_len = buffer_size.min(out_left.len());
                    {
                        let out_slice = &mut out_left[..fill_len];
                        out_slice.fill(0.0);
                    }
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
                let proc_len = buffer_size
                    .min(left_in_slice.len())
                    .min(right_in_slice.len())
                    .min(out_left.len())
                    .min(out_right.len());

                out_left[..proc_len].copy_from_slice(&left_in_slice[..proc_len]);
                out_right[..proc_len].copy_from_slice(&right_in_slice[..proc_len]);

                if proc_len < out_left.len() {
                    let fill_slice = &mut out_left[proc_len..];
                    fill_slice.fill(0.0);
                }
                if proc_len < out_right.len() {
                    let fill_slice = &mut out_right[proc_len..];
                    fill_slice.fill(0.0);
                }
            }
            return;
        }

        // --- Get Input Buffers (Enabled State) ---
        let left_in_slice = inputs
            .get(&PortId::AudioInput0)
            .and_then(|v| v.first())
            .map_or(&ZERO_BUFFER[..buffer_size], |s| s.buffer.as_slice());
        let right_in_slice = inputs
            .get(&PortId::AudioInput1)
            .and_then(|v| v.first())
            .map_or(left_in_slice, |s| s.buffer.as_slice());
        let process_len = buffer_size
            .min(left_in_slice.len())
            .min(right_in_slice.len())
            .min(unsafe { (*out_left_ptr).len() })
            .min(out_right.len());

        if process_len == 0 {
            // Update left channel using the raw pointer.
            unsafe {
                let out_left = &mut *out_left_ptr;
                let fill_len_left = buffer_size.min(out_left.len());
                out_left[..fill_len_left].fill(0.0);
            }
            // Update right channel from the already borrowed out_right.
            let fill_len_right = buffer_size.min(out_right.len());
            out_right[..fill_len_right].fill(0.0);
            return;
        }

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
        let target_lfo_phase_increment =
            TAU * self.target_lfo_rate_hz * self.inv_internal_sample_rate;
        self.current_lfo_phase_increment = smooth_parameter(
            self.current_lfo_phase_increment,
            target_lfo_phase_increment,
            coeff,
        );

        // --- UPSAMPLING (Multipass FIR Cascaded) ---
        let internal_buffer_len = process_len * OVERSAMPLE;
        {
            // First pass: apply FIR filter stage 1 on input and insert zeros.
            let mut up_idx = 0;
            let filter1_l = &mut self.upsample_filter1_left;
            let filter1_r = &mut self.upsample_filter1_right;
            for i in 0..process_len {
                self.upsample_stage1_left[up_idx] = filter1_l.process(left_in_slice[i]);
                self.upsample_stage1_right[up_idx] = filter1_r.process(right_in_slice[i]);
                up_idx += 1;
                self.upsample_stage1_left[up_idx] = filter1_l.process(0.0);
                self.upsample_stage1_right[up_idx] = filter1_r.process(0.0);
                up_idx += 1;
                self.upsample_stage1_left[up_idx] = filter1_l.process(0.0);
                self.upsample_stage1_right[up_idx] = filter1_r.process(0.0);
                up_idx += 1;
                self.upsample_stage1_left[up_idx] = filter1_l.process(0.0);
                self.upsample_stage1_right[up_idx] = filter1_r.process(0.0);
                up_idx += 1;
            }
        }
        // Second pass: process the stage1 output through FIR filter stage 2.
        for i in 0..internal_buffer_len {
            self.upsampled_input_left[i] = self
                .upsample_filter2_left
                .process(self.upsample_stage1_left[i]);
            self.upsampled_input_right[i] = self
                .upsample_filter2_right
                .process(self.upsample_stage1_right[i]);
        }

        // --- CORE CHORUS PROCESSING (Oversampled Domain) ---
        {
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
            let delay_buf_l = &mut self.delay_buffer_left;
            let delay_buf_r = &mut self.delay_buffer_right;
            const MIN_DELAY_SAMPLES_CUBIC: f32 = 2.0;
            let min_target_delay = base_delay - depth;
            let effective_base_delay = if min_target_delay < MIN_DELAY_SAMPLES_CUBIC {
                base_delay + (MIN_DELAY_SAMPLES_CUBIC - min_target_delay)
            } else {
                base_delay
            };

            for i in 0..internal_buffer_len {
                let lfo_val_left = lfo_phase_left.sin();
                let lfo_val_right = lfo_phase_right.sin();
                let target_delay_l = effective_base_delay + lfo_val_left * depth;
                let target_delay_r = effective_base_delay + lfo_val_right * depth;
                let delay_smpls_left = target_delay_l.min(max_safe_read_delay).max(0.0);
                let delay_smpls_right = target_delay_r.min(max_safe_read_delay).max(0.0);
                let delayed_left = Self::read_cubic_interpolated(
                    delay_buf_l,
                    delay_smpls_left,
                    current_write_index,
                    max_delay_samples,
                );
                let delayed_right = Self::read_cubic_interpolated(
                    delay_buf_r,
                    delay_smpls_right,
                    current_write_index,
                    max_delay_samples,
                );
                let current_input_l = self.upsampled_input_left[i];
                let current_input_r = self.upsampled_input_right[i];
                let feedback_term_l = feedback * delayed_left;
                let feedback_term_r = feedback * delayed_right;
                let write_val_left = current_input_l + feedback_term_l;
                let write_val_right = current_input_r + feedback_term_r;
                delay_buf_l[current_write_index] = write_val_left;
                delay_buf_r[current_write_index] = write_val_right;
                self.processed_oversampled_left[i] =
                    current_input_l * dry_level + delayed_left * wet_level;
                self.processed_oversampled_right[i] =
                    current_input_r * dry_level + delayed_right * wet_level;
                lfo_phase_left = (lfo_phase_left + phase_inc).rem_euclid(TAU);
                lfo_phase_right = (lfo_phase_right + phase_inc).rem_euclid(TAU);
                current_write_index = (current_write_index + 1) % max_delay_samples;
            }
            self.lfo_phase_left = lfo_phase_left;
            self.lfo_phase_right = lfo_phase_right;
            self.write_index = current_write_index;
        }

        // --- DOWNSAMPLING (Multipass FIR Cascaded) ---
        unsafe {
            let out_left = &mut *out_left_ptr;
            let out_left_slice = &mut out_left[..process_len];
            let out_right_slice = &mut out_right[..process_len];

            // Instead of allocating a new vector here, use the pre-allocated scratch buffer.
            // Ensure you only work with the necessary length.
            let downsample_stage = &mut self.scratch_downsample_stage[..internal_buffer_len];
            {
                let filter1_l = &mut self.downsample_filter1_left;
                let filter1_r = &mut self.downsample_filter1_right;
                for i in 0..internal_buffer_len {
                    downsample_stage[i] = filter1_l.process(self.processed_oversampled_left[i]);
                    self.processed_oversampled_right[i] =
                        filter1_r.process(self.processed_oversampled_right[i]);
                }
            }

            let downsampled = &mut self.scratch_downsampled[..internal_buffer_len];
            {
                let filter2_l = &mut self.downsample_filter2_left;
                let filter2_r = &mut self.downsample_filter2_right;
                for i in 0..internal_buffer_len {
                    downsampled[i] = filter2_l.process(downsample_stage[i]);
                    self.processed_oversampled_right[i] =
                        filter2_r.process(self.processed_oversampled_right[i]);
                }
            }

            // Decimate: take every OVERSAMPLE-th sample.
            let mut out_idx = 0;
            for i in (0..internal_buffer_len).step_by(OVERSAMPLE) {
                if out_idx < process_len {
                    out_left_slice[out_idx] = downsampled[i];
                    out_right_slice[out_idx] = self.processed_oversampled_right[i];
                    out_idx += 1;
                } else {
                    eprintln!("Chorus Error: Output buffer overrun during downsampling!");
                    break;
                }
            }
            debug_assert!(
                out_idx == process_len,
                "Downsampling mismatch: expected {} samples, got {}",
                process_len,
                out_idx
            );

            // Apply DC blockers on final outputs.
            for i in 0..process_len {
                out_left_slice[i] = self.output_dc_blocker_l.process(out_left_slice[i]);
                out_right_slice[i] = self.output_dc_blocker_r.process(out_right_slice[i]);
            }

            if process_len < out_left.len() {
                let fill_slice = &mut out_left[process_len..];
                fill_slice.fill(0.0);
            }
            if process_len < out_right.len() {
                let fill_slice = &mut out_right[process_len..];
                fill_slice.fill(0.0);
            }
        }
    }

    pub fn reset_state(&mut self) {
        self.delay_buffer_left.fill(0.0);
        self.delay_buffer_right.fill(0.0);
        self.write_index = 0;
        self.lfo_phase_left = 0.0;
        self.lfo_phase_right = self.target_lfo_stereo_phase_offset_rad.rem_euclid(TAU);
        // Reset FIR filters for both cascaded passes.
        self.upsample_filter1_left.reset();
        self.upsample_filter1_right.reset();
        self.upsample_filter2_left.reset();
        self.upsample_filter2_right.reset();
        self.downsample_filter1_left.reset();
        self.downsample_filter1_right.reset();
        self.downsample_filter2_left.reset();
        self.downsample_filter2_right.reset();
        self.output_dc_blocker_l.reset();
        self.output_dc_blocker_r.reset();
        self.current_base_delay_samples = self.target_base_delay_samples;
        self.current_depth_samples = self.target_depth_samples;
        self.current_lfo_phase_increment =
            TAU * self.target_lfo_rate_hz * self.inv_internal_sample_rate;
        self.current_feedback = self.target_feedback;
        self.current_mix = self.target_mix;
        self.upsample_stage1_left.fill(0.0);
        self.upsample_stage1_right.fill(0.0);
        self.upsampled_input_left.fill(0.0);
        self.upsampled_input_right.fill(0.0);
        self.processed_oversampled_left.fill(0.0);
        self.processed_oversampled_right.fill(0.0);
    }

    fn node_type_str(&self) -> &str {
        "chorus"
    }
    fn is_node_active(&self) -> bool {
        self.enabled
    }
    fn set_node_active(&mut self, active: bool) {
        if active && !self.enabled {
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
}

impl AudioNode for Chorus {
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
