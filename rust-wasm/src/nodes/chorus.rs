use rustc_hash::FxHashMap;
use std::any::Any;
use std::f32::consts::PI;

use crate::graph::ModulationSource;
use crate::traits::{AudioNode, PortId};

const TWO_PI: f32 = 2.0 * PI;
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
        self.buffer[self.buffer_pos] = input;
        let mut output = 0.0;
        for i in 0..self.coefficients.len() {
            let buffer_idx = (self.buffer_pos + buffer_len - i) % buffer_len;
            output += self.coefficients[i] * self.buffer[buffer_idx];
        }
        self.buffer_pos = (self.buffer_pos + 1) % buffer_len;
        output
    }

    fn reset(&mut self) {
        self.buffer.fill(0.0);
        self.buffer_pos = 0;
    }

    #[inline(always)]
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
            (TWO_PI * cutoff_normalized * n as f32).sin() / (PI * n as f32)
        };
        let win_val = window(i, num_taps);
        coeffs[i] = val * win_val;
        sum += coeffs[i];
    }

    if sum.abs() > 1e-6 {
        for c in coeffs.iter_mut() {
            *c /= sum;
        }
    } else {
        eprintln!("Warning: FIR filter coefficient sum is near zero. Check parameters.");
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
    0.42 - 0.5 * (TWO_PI * nn / m).cos() + 0.08 * (4.0 * PI * nn / m).cos()
}

// --- Helper Functions ---
#[inline(always)]
fn smooth_parameter(current: f32, target: f32, coefficient: f32) -> f32 {
    current * coefficient + target * (1.0 - coefficient)
}

#[inline(always)]
fn sinc(x: f32) -> f32 {
    if x.abs() < 1e-6 {
        1.0
    } else {
        (PI * x).sin() / (PI * x)
    }
}

// --- Chorus Struct Definition ---
pub struct Chorus {
    enabled: bool,
    oversample_factor: usize,
    original_sample_rate: f32,
    internal_sample_rate: f32,
    inv_internal_sample_rate: f32,
    delay_buffer_left: Vec<f32>,
    delay_buffer_right: Vec<f32>,
    write_index: usize,
    max_delay_samples: usize,
    max_safe_read_delay: f32,
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
    upsample_filter_left: FirFilter,
    upsample_filter_right: FirFilter,
    downsample_filter_left: FirFilter,
    downsample_filter_right: FirFilter,
    upsampled_input_left: Vec<f32>,
    upsampled_input_right: Vec<f32>,
    processed_oversampled_left: Vec<f32>,
    processed_oversampled_right: Vec<f32>,
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
        oversample_factor: usize,
    ) -> Self {
        assert!(sample_rate > 0.0, "Sample rate must be positive");
        assert!(
            max_base_delay_ms >= 0.0,
            "Max base delay must be non-negative"
        );
        assert!(
            oversample_factor == 2 || oversample_factor == 4,
            "Oversample factor must be 2 or 4"
        );

        let internal_sample_rate = sample_rate * oversample_factor as f32;
        let inv_internal_sample_rate = 1.0 / internal_sample_rate;

        // Use a symmetric kernel from -a to a.
        let lanczos_a: usize = 3;
        // Set margin to lanczos_a to safely cover the full kernel range.
        let interpolation_points_margin = lanczos_a;

        let max_modulated_delay_ms = max_base_delay_ms + depth_ms.abs();
        let required_samples_for_delay =
            (max_modulated_delay_ms / 1000.0 * internal_sample_rate).ceil() as usize;

        let max_delay_samples = required_samples_for_delay + interpolation_points_margin;
        let max_safe_read_delay = (max_delay_samples - interpolation_points_margin).max(0) as f32;

        let initial_base_delay_samples = (base_delay_ms / 1000.0 * internal_sample_rate).max(0.0);
        let initial_depth_samples = (depth_ms / 1000.0 * internal_sample_rate).abs();
        let initial_lfo_rate_hz = lfo_rate_hz.max(0.0);
        let initial_lfo_phase_increment = TWO_PI * initial_lfo_rate_hz * inv_internal_sample_rate;
        let initial_feedback = feedback.clamp(0.0, 0.98);
        let initial_mix = mix.clamp(0.0, 1.0);
        let initial_lfo_stereo_phase_offset_rad = stereo_phase_offset_deg.to_radians();

        let smoothing_time_ms = 3.0;
        let smoothing_time_samples_internal = smoothing_time_ms * 0.001 * internal_sample_rate;
        let param_smooth_coeff = if smoothing_time_samples_internal > 1.0 {
            (-TWO_PI / smoothing_time_samples_internal).exp()
        } else {
            0.0
        };

        let normalized_cutoff = 0.5 / oversample_factor as f32;
        let filter_cutoff = normalized_cutoff * 0.90;
        let num_taps = 63; // Example number of taps
        let base_coeffs = generate_fir_coeffs(num_taps, filter_cutoff, blackman_window);

        let mut upsample_coeffs = base_coeffs.clone();
        let gain = oversample_factor as f32;
        for c in upsample_coeffs.iter_mut() {
            *c *= gain;
        }
        let downsample_coeffs = base_coeffs;

        let max_buf_size_oversampled = MAX_PROCESS_BUFFER_SIZE * oversample_factor;

        Self {
            enabled: true,
            oversample_factor,
            original_sample_rate: sample_rate,
            internal_sample_rate,
            inv_internal_sample_rate,
            delay_buffer_left: vec![0.0; max_delay_samples],
            delay_buffer_right: vec![0.0; max_delay_samples],
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
            lfo_phase_right: initial_lfo_stereo_phase_offset_rad.rem_euclid(TWO_PI),
            param_smooth_coeff,
            upsample_filter_left: FirFilter::new(upsample_coeffs.clone()),
            upsample_filter_right: FirFilter::new(upsample_coeffs),
            downsample_filter_left: FirFilter::new(downsample_coeffs.clone()),
            downsample_filter_right: FirFilter::new(downsample_coeffs),
            upsampled_input_left: vec![0.0; max_buf_size_oversampled],
            upsampled_input_right: vec![0.0; max_buf_size_oversampled],
            processed_oversampled_left: vec![0.0; max_buf_size_oversampled],
            processed_oversampled_right: vec![0.0; max_buf_size_oversampled],
        }
    }

    pub fn set_base_delay_ms(&mut self, delay_ms: f32) {
        self.target_base_delay_samples = (delay_ms / 1000.0 * self.internal_sample_rate).max(0.0);
    }
    pub fn set_depth_ms(&mut self, depth_ms: f32) {
        self.target_depth_samples = (depth_ms / 1000.0 * self.internal_sample_rate).abs();
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
    fn read_bandlimited_interpolated(
        buffer: &[f32],
        delay_samples: f32,
        write_index: usize,
        max_delay_samples: usize,
        max_safe_read_delay: f32,
    ) -> f32 {
        let clamped_delay = delay_samples.clamp(0.0, max_safe_read_delay);
        let read_pos_float = (write_index as f32 - clamped_delay + max_delay_samples as f32)
            % max_delay_samples as f32;

        let i0 = read_pos_float.floor() as isize;
        let a: isize = 3;
        let mut accumulator = 0.0;
        let mut weight_sum = 0.0;

        // Use a symmetric kernel from -a to a.
        for n_offset in -a..=a {
            let n = i0 + n_offset;
            let x = read_pos_float - (n as f32);
            if x.abs() < (a as f32) {
                let lanczos_weight = sinc(x) * sinc(x / (a as f32));
                let buffer_index = ((n % max_delay_samples as isize) + max_delay_samples as isize)
                    % max_delay_samples as isize;
                let sample = buffer[buffer_index as usize];
                accumulator += sample * lanczos_weight;
                weight_sum += lanczos_weight;
            }
        }

        if weight_sum.abs() > 1e-6 {
            accumulator / weight_sum
        } else {
            let fallback_index = ((i0 % max_delay_samples as isize) + max_delay_samples as isize)
                % max_delay_samples as isize;
            buffer[fallback_index as usize]
        }
    }

    pub fn process(
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        if buffer_size == 0 {
            return;
        }
        if buffer_size > MAX_PROCESS_BUFFER_SIZE {
            eprintln!(
                "Chorus Error: process buffer_size ({}) exceeds MAX_PROCESS_BUFFER_SIZE ({}). Zeroing output.",
                buffer_size, MAX_PROCESS_BUFFER_SIZE
            );
            let left = (*outputs.get_mut(&PortId::AudioOutput0).unwrap_or_else(|| {
                eprintln!("Chorus Error: Missing AudioOutput0 buffer!");
                std::process::abort();
            })) as *mut [f32];
            let right = (*outputs.get_mut(&PortId::AudioOutput1).unwrap_or_else(|| {
                eprintln!("Chorus Error: Missing AudioOutput1 buffer!");
                std::process::abort();
            })) as *mut [f32];
            let (out_left, out_right) = unsafe { (&mut *left, &mut *right) };
            let len_l = out_left.len();
            let len_r = out_right.len();
            out_left[..buffer_size.min(len_l)].fill(0.0);
            out_right[..buffer_size.min(len_r)].fill(0.0);
            return;
        }

        // --- Disabled processing branch ---
        if !self.enabled {
            let left = (*outputs.get_mut(&PortId::AudioOutput0).unwrap_or_else(|| {
                eprintln!("Chorus Error: Missing AudioOutput0 buffer while disabled!");
                std::process::abort();
            })) as *mut [f32];
            let right = (*outputs.get_mut(&PortId::AudioOutput1).unwrap_or_else(|| {
                eprintln!("Chorus Error: Missing AudioOutput1 buffer while disabled!");
                std::process::abort();
            })) as *mut [f32];
            let (out_left, out_right) = unsafe { (&mut *left, &mut *right) };
            let out_len_l = out_left.len();
            let out_len_r = out_right.len();
            let process_len_l = buffer_size.min(out_len_l);
            let process_len_r = buffer_size.min(out_len_r);
            let left_in_src = inputs.get(&PortId::AudioInput0).and_then(|v| v.first());
            let right_in_src = inputs.get(&PortId::AudioInput1).and_then(|v| v.first());
            match (left_in_src, right_in_src) {
                (Some(left_src), Some(right_src)) => {
                    let copy_len_l = process_len_l.min(left_src.buffer.len());
                    out_left[..copy_len_l].copy_from_slice(&left_src.buffer[..copy_len_l]);
                    if copy_len_l < process_len_l {
                        out_left[copy_len_l..process_len_l].fill(0.0);
                    }
                    let copy_len_r = process_len_r.min(right_src.buffer.len());
                    out_right[..copy_len_r].copy_from_slice(&right_src.buffer[..copy_len_r]);
                    if copy_len_r < process_len_r {
                        out_right[copy_len_r..process_len_r].fill(0.0);
                    }
                }
                (Some(left_src), None) => {
                    let copy_len_l = process_len_l.min(left_src.buffer.len());
                    out_left[..copy_len_l].copy_from_slice(&left_src.buffer[..copy_len_l]);
                    if copy_len_l < process_len_l {
                        out_left[copy_len_l..process_len_l].fill(0.0);
                    }
                    out_right.fill(0.0);
                }
                (None, Some(right_src)) => {
                    out_left.fill(0.0);
                    let copy_len_r = process_len_r.min(right_src.buffer.len());
                    out_right[..copy_len_r].copy_from_slice(&right_src.buffer[..copy_len_r]);
                    if copy_len_r < process_len_r {
                        out_right[copy_len_r..process_len_r].fill(0.0);
                    }
                }
                (None, None) => {
                    out_left.fill(0.0);
                    out_right.fill(0.0);
                }
            }
            return;
        }

        // --- Enabled processing branch ---
        let left_in_slice = inputs
            .get(&PortId::AudioInput0)
            .and_then(|s| s.first())
            .map(|s| s.buffer.as_slice())
            .unwrap_or(&ZERO_BUFFER[..buffer_size]);
        let right_in_slice = inputs
            .get(&PortId::AudioInput1)
            .and_then(|s| s.first())
            .map(|s| s.buffer.as_slice())
            .unwrap_or(&ZERO_BUFFER[..buffer_size]);

        let left = (*outputs.get_mut(&PortId::AudioOutput0).unwrap_or_else(|| {
            eprintln!("Chorus Error: Missing AudioOutput0 buffer for processing!");
            std::process::abort();
        })) as *mut [f32];
        let right = (*outputs.get_mut(&PortId::AudioOutput1).unwrap_or_else(|| {
            eprintln!("Chorus Error: Missing AudioOutput1 buffer for processing!");
            std::process::abort();
        })) as *mut [f32];
        let (out_left, out_right) = unsafe { (&mut *left, &mut *right) };

        let process_len = buffer_size
            .min(out_left.len())
            .min(out_right.len())
            .min(left_in_slice.len())
            .min(right_in_slice.len());
        if process_len == 0 {
            return;
        }
        let out_left = &mut out_left[..process_len];
        let out_right = &mut out_right[..process_len];
        let left_in = &left_in_slice[..process_len];
        let right_in = &right_in_slice[..process_len];

        // Smooth parameters
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
            TWO_PI * self.target_lfo_rate_hz * self.inv_internal_sample_rate;
        self.current_lfo_phase_increment = smooth_parameter(
            self.current_lfo_phase_increment,
            target_lfo_phase_increment,
            coeff,
        );

        let oversample_factor = self.oversample_factor;
        let internal_buffer_len = process_len * oversample_factor;

        let upsampled_l = &mut self.upsampled_input_left[..internal_buffer_len];
        let upsampled_r = &mut self.upsampled_input_right[..internal_buffer_len];
        let processed_l = &mut self.processed_oversampled_left[..internal_buffer_len];
        let processed_r = &mut self.processed_oversampled_right[..internal_buffer_len];

        // Upsampling
        {
            let mut up_idx = 0;
            let up_filter_l = &mut self.upsample_filter_left;
            let up_filter_r = &mut self.upsample_filter_right;
            for i in 0..process_len {
                upsampled_l[up_idx] = up_filter_l.process(left_in[i]);
                upsampled_r[up_idx] = up_filter_r.process(right_in[i]);
                up_idx += 1;
                for _ in 1..oversample_factor {
                    upsampled_l[up_idx] = up_filter_l.process(0.0);
                    upsampled_r[up_idx] = up_filter_r.process(0.0);
                    up_idx += 1;
                }
            }
        }

        // Processing in oversampled domain
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

            for i in 0..internal_buffer_len {
                let lfo_mod_left = lfo_phase_left.sin();
                let lfo_mod_right = lfo_phase_right.sin();
                let delay_smpls_left = (base_delay + lfo_mod_left * depth).max(0.0);
                let delay_smpls_right = (base_delay + lfo_mod_right * depth).max(0.0);

                let delayed_left = Self::read_bandlimited_interpolated(
                    delay_buf_l,
                    delay_smpls_left,
                    current_write_index,
                    max_delay_samples,
                    max_safe_read_delay,
                );
                let delayed_right = Self::read_bandlimited_interpolated(
                    delay_buf_r,
                    delay_smpls_right,
                    current_write_index,
                    max_delay_samples,
                    max_safe_read_delay,
                );

                let current_upsampled_in_l = upsampled_l[i];
                let current_upsampled_in_r = upsampled_r[i];
                let feedback_term_l = feedback * delayed_left;
                let feedback_term_r = feedback * delayed_right;
                let write_val_left = (current_upsampled_in_l + feedback_term_l); //.clamp(-1.0, 1.0);
                let write_val_right = (current_upsampled_in_r + feedback_term_r); //.clamp(-1.0, 1.0);

                delay_buf_l[current_write_index] = write_val_left;
                delay_buf_r[current_write_index] = write_val_right;

                processed_l[i] = current_upsampled_in_l * dry_level + delayed_left * wet_level;
                processed_r[i] = current_upsampled_in_r * dry_level + delayed_right * wet_level;

                lfo_phase_left = (lfo_phase_left + phase_inc).rem_euclid(TWO_PI);
                lfo_phase_right = (lfo_phase_right + phase_inc).rem_euclid(TWO_PI);
                current_write_index = (current_write_index + 1) % max_delay_samples;
            }

            self.lfo_phase_left = lfo_phase_left;
            self.lfo_phase_right = lfo_phase_right;
            self.write_index = current_write_index;
        }

        // Downsampling
        {
            let mut out_idx = 0;
            let down_filter_l = &mut self.downsample_filter_left;
            let down_filter_r = &mut self.downsample_filter_right;
            for i in 0..internal_buffer_len {
                let filtered_l = down_filter_l.process(processed_l[i]);
                let filtered_r = down_filter_r.process(processed_r[i]);
                if i % oversample_factor == 0 {
                    if out_idx < process_len {
                        out_left[out_idx] = filtered_l;
                        out_right[out_idx] = filtered_r;
                        out_idx += 1;
                    } else {
                        eprintln!("Chorus Error: Output buffer overrun during downsampling (internal logic error)");
                        break;
                    }
                }
            }
            debug_assert!(
                out_idx == process_len,
                "Downsampling mismatch: expected {}, got {}",
                process_len,
                out_idx
            );
        }
    }

    fn reset(&mut self) {
        self.delay_buffer_left.fill(0.0);
        self.delay_buffer_right.fill(0.0);
        self.write_index = 0;
        self.lfo_phase_left = 0.0;
        self.lfo_phase_right = self.target_lfo_stereo_phase_offset_rad.rem_euclid(TWO_PI);
        self.upsample_filter_left.reset();
        self.upsample_filter_right.reset();
        self.downsample_filter_left.reset();
        self.downsample_filter_right.reset();
        self.current_base_delay_samples = self.target_base_delay_samples;
        self.current_depth_samples = self.target_depth_samples;
        self.current_lfo_phase_increment =
            TWO_PI * self.target_lfo_rate_hz * self.inv_internal_sample_rate;
        self.current_feedback = self.target_feedback;
        self.current_mix = self.target_mix;
        self.upsampled_input_left.fill(0.0);
        self.upsampled_input_right.fill(0.0);
        self.processed_oversampled_left.fill(0.0);
        self.processed_oversampled_right.fill(0.0);
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
        Chorus::process(self, inputs, outputs, buffer_size);
    }
    fn reset(&mut self) {
        Chorus::reset(self);
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
        self.set_active(active);
    }
    fn node_type(&self) -> &str {
        self.node_type()
    }
}
