// convolver.rs

use fft_convolver::FFTConvolver;
use std::any::Any;
use std::collections::HashMap;

// Import ModulationProcessor and ModulationSource from the graph module.
use crate::graph::{ModulationProcessor, ModulationSource}; // Ensure these paths are correct
use crate::traits::{AudioNode, PortId}; // Ensure these paths are correct

/// Helper function to ensure a Vec has at least a certain size, filling with a value if resizing,
/// and truncating if it's too long.
fn ensure_buffer_size_and_fill(buffer: &mut Vec<f32>, required_size: usize, fill_value: f32) {
    if buffer.len() < required_size {
        buffer.resize_with(required_size, || fill_value);
    }
    buffer.truncate(required_size);
}

/// A Convolver that uses FFTConvolver for fast convolution processing.
/// (Doc comment unchanged)
pub struct Convolver {
    enabled: bool,
    convolvers: Vec<FFTConvolver<f32>>,
    impulse_length: usize,
    tail_count: usize,
    pub wet_level: f32,
    pub partition_size: usize,
    pub sample_rate: f32,
    fallback_zero_buffer: Vec<f32>,
    fallback_mix_buffer: Vec<f32>,
}

impl Convolver {
    // --- new, set_wet_level, set_enabled, new_multi_channel ---
    // (Implementations unchanged)
    pub fn new(impulse_response: Vec<f32>, partition_size: usize, sample_rate: f32) -> Self {
        Self::new_multi_channel(vec![impulse_response], partition_size, sample_rate)
    }
    pub fn set_wet_level(&mut self, wet_level: f32) {
        self.wet_level = wet_level.clamp(0.0, 1.0);
    }
    pub fn set_enabled(&mut self, enabled: bool) {
        self.set_active(enabled);
    }
    pub fn new_multi_channel(
        impulse_response: Vec<Vec<f32>>,
        partition_size: usize,
        sample_rate: f32,
    ) -> Self {
        let num_ir_channels = impulse_response.len();
        assert!(
            !impulse_response.is_empty(),
            "Impulse response cannot be empty"
        );
        assert!(
            [1, 2, 4].contains(&num_ir_channels),
            "Impulse response must have 1, 2, or 4 channels (provided {})",
            num_ir_channels
        );
        let length = impulse_response[0].len();
        assert!(length > 0, "Impulse response channels cannot be empty");
        let total_samples = impulse_response.iter().map(|ch| ch.len()).sum::<usize>();
        let mut power: f32 = impulse_response
            .iter()
            .flat_map(|ch| ch.iter())
            .map(|&s| s * s)
            .sum();
        if total_samples > 0 && power > 0.0 {
            power = (power / (total_samples as f32)).sqrt();
        } else {
            power = 0.0;
        }
        let min_power = 0.000125;
        if !power.is_finite() || power < min_power {
            power = min_power;
        }
        let gain_calibration = 0.00125;
        let gain_calibration_sample_rate = 44100.0;
        let mut scale = 1.0 / power;
        scale *= gain_calibration;
        if sample_rate > 0.0 && gain_calibration_sample_rate > 0.0 {
            scale *= gain_calibration_sample_rate / sample_rate;
        }
        let num_convolvers = if num_ir_channels == 1 { 2 } else { 2 };
        let mut convolvers = Vec::with_capacity(num_convolvers);
        for i in 0..num_convolvers {
            let ir_channel_index = if num_ir_channels == 1 {
                0
            } else {
                i % num_ir_channels
            };
            let mut scaled_channel = impulse_response[ir_channel_index].clone();
            for sample in scaled_channel.iter_mut() {
                *sample *= scale;
            }
            let mut conv = FFTConvolver::<f32>::default();
            conv.init(partition_size, &scaled_channel)
                .unwrap_or_else(|e| {
                    panic!(
                        "Unable to initialize convolver {} using IR channel {}: {:?}",
                        i, ir_channel_index, e
                    )
                });
            convolvers.push(conv);
        }
        Self {
            enabled: true,
            convolvers,
            impulse_length: length,
            tail_count: 0,
            wet_level: 0.2,
            partition_size,
            sample_rate,
            fallback_zero_buffer: Vec::new(),
            fallback_mix_buffer: Vec::new(),
        }
    }

    /// Process a block of audio using the internal convolvers (calculates wet signal).
    pub fn process_block_wet_signal(
        &mut self,
        inputs: &[&[f32]],
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) {
        // (Implementation unchanged)
        if self.convolvers.len() < 2 {
            eprintln!("Convolver Error: Insufficient convolvers for stereo processing.");
            output_left.fill(0.0);
            output_right.fill(0.0);
            return;
        }
        let buffer_len = output_left.len();
        if output_right.len() != buffer_len {
            eprintln!("Convolver Error: Output L/R buffer length mismatch.");
            output_left.fill(0.0);
            output_right.fill(0.0);
            return;
        }
        match inputs.first() {
            Some(input_l) if inputs.len() >= 2 => {
                let input_r = inputs[1];
                if input_l.len() >= buffer_len && input_r.len() >= buffer_len {
                    let _ = self.convolvers[0].process(&input_l[..buffer_len], output_left);
                    let _ = self.convolvers[1].process(&input_r[..buffer_len], output_right);
                } else {
                    eprintln!("Convolver Warning: Input/Output buffer length mismatch (stereo). Silencing.");
                    output_left.fill(0.0);
                    output_right.fill(0.0);
                }
            }
            Some(input_mono) => {
                if input_mono.len() >= buffer_len {
                    let _ = self.convolvers[0].process(&input_mono[..buffer_len], output_left);
                    let _ = self.convolvers[1].process(&input_mono[..buffer_len], output_right);
                } else {
                    eprintln!(
                        "Convolver Warning: Input/Output buffer length mismatch (mono). Silencing."
                    );
                    output_left.fill(0.0);
                    output_right.fill(0.0);
                }
            }
            None => {
                output_left.fill(0.0);
                output_right.fill(0.0);
            }
        }
        let is_silent = inputs
            .iter()
            .all(|channel| channel.iter().all(|&s| s.abs() < 1e-10));
        if is_silent {
            self.tail_count += buffer_len;
        } else {
            self.tail_count = 0;
        }
    }

    /// Reset internal state.
    pub fn reset_state(&mut self) {
        // (Implementation unchanged)
        self.tail_count = 0;
    }
}

// ============================================================
// Implement the AudioNode trait for graph integration
// ============================================================
impl AudioNode for Convolver {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        // (Implementation unchanged)
        [
            (PortId::AudioInput0, false),
            (PortId::AudioInput1, false),
            (PortId::AudioOutput0, true),
            (PortId::AudioOutput1, true),
            (PortId::WetDryMix, false),
        ]
        .iter()
        .cloned()
        .collect()
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // --- Handle Disabled State ---
        if !self.enabled || self.convolvers.is_empty() {
            // (Passthrough logic unchanged)
            let maybe_in_l_buf = inputs
                .get(&PortId::AudioInput0)
                .and_then(|v| v.first())
                .map(|s| &s.buffer);
            let maybe_in_r_buf = inputs
                .get(&PortId::AudioInput1)
                .and_then(|v| v.first())
                .map(|s| &s.buffer);
            let fill_or_copy = |out_opt: Option<&mut &mut [f32]>, in_opt: Option<&&Vec<f32>>| {
                if let Some(out_slice) = out_opt {
                    if let Some(in_buf_ref) = in_opt {
                        let in_buf = *in_buf_ref;
                        if in_buf.len() >= buffer_size {
                            out_slice[..buffer_size].copy_from_slice(&in_buf[..buffer_size]);
                        } else {
                            out_slice[..buffer_size].fill(0.0);
                        }
                    } else {
                        out_slice[..buffer_size].fill(0.0);
                    }
                }
            };
            fill_or_copy(
                outputs.get_mut(&PortId::AudioOutput0),
                maybe_in_l_buf.as_ref(),
            );
            fill_or_copy(
                outputs.get_mut(&PortId::AudioOutput1),
                maybe_in_r_buf.or(maybe_in_l_buf).as_ref(),
            );
            return;
        }

        // --- Prepare Fallback Buffers (Mutable borrow ends here) ---
        ensure_buffer_size_and_fill(&mut self.fallback_zero_buffer, buffer_size, 0.0);
        let clamped_level = self.wet_level.clamp(0.0, 1.0);
        ensure_buffer_size_and_fill(&mut self.fallback_mix_buffer, buffer_size, clamped_level);
        // Mutable borrow of `self` for fallback buffers ends here.

        // --- Get Input Source Buffer Options ---
        let input_l_source_buffer_opt: Option<&[f32]> = inputs
            .get(&PortId::AudioInput0)
            .and_then(|s| s.first())
            .map(|s| &s.buffer[..buffer_size]);
        let input_r_source_buffer_opt: Option<&[f32]> = inputs
            .get(&PortId::AudioInput1)
            .and_then(|s| s.first())
            .map(|s| &s.buffer[..buffer_size]);
        let wet_mix_source_buffer_opt: Option<&[f32]> = inputs
            .get(&PortId::WetDryMix)
            .and_then(|s| s.first())
            .map(|s| &s.buffer[..buffer_size]);

        // --- FIX for E0502: Clone necessary fallback slices if inputs missing ---
        // This avoids holding a borrow of `self.fallback_*_buffer` across the `&mut self` call.
        // Cloning a slice of f32 might have a small performance cost, but is often acceptable.
        // Alternative: Use unsafe code or RefCell if performance is absolutely critical and
        // profiling shows this clone to be a bottleneck.

        let conv_input_l: std::borrow::Cow<[f32]> = input_l_source_buffer_opt
            .map(std::borrow::Cow::Borrowed) // If input exists, borrow it
            .unwrap_or_else(|| {
                std::borrow::Cow::Owned(self.fallback_zero_buffer[..buffer_size].to_vec())
            }); // If input missing, clone fallback

        // Note: conv_input_r doesn't need Cow because it just borrows conv_input_l or input_r_source_buffer_opt
        let conv_input_r: &[f32] = input_r_source_buffer_opt.unwrap_or(&conv_input_l); // Fallback R uses L's choice (borrow is fine here)

        let dry_l_for_mix: std::borrow::Cow<[f32]> = input_l_source_buffer_opt
            .map(std::borrow::Cow::Borrowed)
            .unwrap_or_else(|| {
                std::borrow::Cow::Owned(self.fallback_zero_buffer[..buffer_size].to_vec())
            });

        // Note: dry_r_for_mix doesn't need Cow
        let dry_r_for_mix: &[f32] = input_r_source_buffer_opt.unwrap_or(&dry_l_for_mix); // Fallback R uses L's choice

        let wet_mix_mod: std::borrow::Cow<[f32]> = wet_mix_source_buffer_opt
            .map(std::borrow::Cow::Borrowed)
            .unwrap_or_else(|| {
                std::borrow::Cow::Owned(self.fallback_mix_buffer[..buffer_size].to_vec())
            });

        // Now, conv_input_l, dry_l_for_mix, wet_mix_mod are either borrowed from `inputs`
        // or are owned `Vec`s (via Cow::Owned). No active borrows of `self` remain from this stage.

        // --- Get Output Buffers (Remove temporarily) ---
        let mut out_l_buffer_opt = outputs.remove(&PortId::AudioOutput0);
        let mut out_r_buffer_opt = outputs.remove(&PortId::AudioOutput1);

        // --- Process Block ---
        if let (Some(out_l_buffer), Some(out_r_buffer)) =
            (&mut out_l_buffer_opt, &mut out_r_buffer_opt)
        {
            let wet_l_slice = &mut out_l_buffer[..buffer_size];
            let wet_r_slice = &mut out_r_buffer[..buffer_size];

            // Use the potentially owned Cow slices here by dereferencing (&*conv_input_l)
            let input_slices_for_conv: &[&[f32]] = &[&*conv_input_l, &*conv_input_r];

            // --- Call process_block_wet_signal (mutable borrow of self) ---
            // This mutable borrow is now fine.
            self.process_block_wet_signal(input_slices_for_conv, wet_l_slice, wet_r_slice);
            // `wet_l_slice` and `wet_r_slice` now contain the WET signal.

            // --- Apply Wet/Dry Mix (In-place) ---
            // Use the potentially owned Cow slices here by dereferencing
            for i in 0..buffer_size {
                let wet_l = wet_l_slice[i];
                let wet_r = wet_r_slice[i];
                let dry_l = dry_l_for_mix[i]; // Indexing Cow works like slice
                let dry_r = dry_r_for_mix[i]; // Indexing Cow works like slice
                let mix_factor = wet_mix_mod[i].clamp(0.0, 1.0); // Indexing Cow works like slice

                wet_l_slice[i] = wet_l * mix_factor + dry_l * (1.0 - mix_factor);
                wet_r_slice[i] = wet_r * mix_factor + dry_r * (1.0 - mix_factor);
            }
        } else {
            eprintln!(
                "Convolver: Missing required output buffer(s) (L or R). No processing performed."
            );
        }

        // --- Reinsert Output Buffers ---
        if let Some(out_l) = out_l_buffer_opt {
            outputs.insert(PortId::AudioOutput0, out_l);
        }
        if let Some(out_r) = out_r_buffer_opt {
            outputs.insert(PortId::AudioOutput1, out_r);
        }
    }

    // --- Other trait methods ---
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
        if !active && self.enabled {
            self.reset_state();
        }
        self.enabled = active;
    }
    fn node_type(&self) -> &str {
        "convolver"
    }
}

impl ModulationProcessor for Convolver {}
