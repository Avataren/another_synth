// convolver.rs

use fft_convolver::FFTConvolver;
use std::any::Any;
use std::collections::HashMap;

// Import ModulationProcessor and ModulationSource from the graph module.
use crate::graph::{ModulationProcessor, ModulationSource};
use crate::traits::{AudioNode, PortId};

/// A Convolver that uses FFTConvolver for fast convolution processing.
/// It supports stereo input/output with a wet/dry mix and normalizes the impulse response using an equal‑power method.
pub struct Convolver {
    enabled: bool,
    /// One or more FFTConvolver instances.
    /// For stereo processing a mono IR is duplicated to create two convolvers.
    convolvers: Vec<FFTConvolver<f32>>,
    /// Length (in samples) of the impulse response.
    impulse_length: usize,
    /// Tail counter for output after input silence.
    tail_count: usize,
    /// Wet/dry mix level (0.0 = dry, 1.0 = fully wet).
    pub wet_level: f32,
    /// Partition size used to initialize FFTConvolver (e.g. render quantum size * 8).
    partition_size: usize,
}

impl Convolver {
    /// Create a new Convolver using a mono impulse response.
    /// The mono IR is normalized and then duplicated for stereo processing.
    ///
    /// * `impulse_response` - A mono impulse response as a Vec<f32>.
    /// * `partition_size` - The FFT block size (e.g. 128*8 = 1024).
    pub fn new(impulse_response: Vec<f32>, partition_size: usize) -> Self {
        // Compute equal‑power (RMS) normalization scale.
        let gain_calibration = 0.00125;
        let gain_calibration_sample_rate = 44100.0;
        let min_power = 0.000125;
        let length = impulse_response.len();
        let mut power: f32 = impulse_response.iter().map(|&s| s * s).sum::<f32>();
        power = (power / (length as f32)).sqrt();
        if !power.is_finite() || power.is_nan() || power < min_power {
            power = min_power;
        }
        let mut scale = 1.0 / power;
        scale *= gain_calibration;
        // For simplicity, assume IR sample rate is 44100.
        scale *= gain_calibration_sample_rate / 44100.0;

        // Scale the impulse response.
        let mut scaled_ir = impulse_response.clone();
        for sample in scaled_ir.iter_mut() {
            *sample *= scale;
        }

        // Duplicate the mono IR to create two FFTConvolver instances for stereo output.
        let mut conv_left = FFTConvolver::<f32>::default();
        conv_left
            .init(partition_size, &scaled_ir)
            .expect("Unable to initialize left convolver");
        let mut conv_right = FFTConvolver::<f32>::default();
        conv_right
            .init(partition_size, &scaled_ir)
            .expect("Unable to initialize right convolver");

        Self {
            enabled: true,
            convolvers: vec![conv_left, conv_right],
            impulse_length: length,
            tail_count: 0,
            wet_level: 0.2,
            partition_size,
        }
    }

    /// Create a new Convolver using a multi‑channel impulse response.
    /// The IR must have 1, 2, or 4 channels. If only one channel is provided, it will be duplicated for stereo output.
    ///
    /// * `impulse_response` - A vector of channels (each a Vec<f32>).
    /// * `partition_size` - The FFT block size.
    pub fn new_multi_channel(impulse_response: Vec<Vec<f32>>, partition_size: usize) -> Self {
        let num_ir_channels = impulse_response.len();
        assert!(
            [1, 2, 4].contains(&num_ir_channels),
            "Impulse response must have 1, 2, or 4 channels"
        );
        let length = impulse_response[0].len();
        // Compute RMS power across all channels.
        let total_samples = num_ir_channels * length;
        let mut power: f32 = impulse_response
            .iter()
            .flat_map(|ch| ch.iter())
            .map(|&s| s * s)
            .sum();
        power = (power / (total_samples as f32)).sqrt();
        let min_power = 0.000125;
        if !power.is_finite() || power.is_nan() || power < min_power {
            power = min_power;
        }
        let gain_calibration = 0.00125;
        let gain_calibration_sample_rate = 44100.0;
        let mut scale = 1.0 / power;
        scale *= gain_calibration;
        scale *= gain_calibration_sample_rate / 44100.0;

        // If IR is mono, duplicate it so we have two convolvers.
        let num_convolvers = if num_ir_channels == 1 {
            2
        } else {
            num_ir_channels
        };
        let mut convolvers = Vec::with_capacity(num_convolvers);
        for i in 0..num_convolvers {
            let channel = if num_ir_channels == 1 { 0 } else { i };
            let mut scaled_channel = impulse_response[channel].clone();
            for sample in scaled_channel.iter_mut() {
                *sample *= scale;
            }
            let mut conv = FFTConvolver::<f32>::default();
            conv.init(partition_size, &scaled_channel)
                .expect("Unable to initialize convolver");
            convolvers.push(conv);
        }

        Self {
            enabled: true,
            convolvers,
            impulse_length: length,
            tail_count: 0,
            wet_level: 0.2,
            partition_size,
        }
    }

    /// Process a block of audio.
    ///
    /// * `inputs` is a slice of input channels (each a slice of f32 samples).
    /// * `dry_inputs` is the unprocessed (dry) signal.
    /// * `outputs` is a mutable slice of output channels.
    ///
    /// This method routes stereo or mono signals appropriately.
    pub fn process_block(
        &mut self,
        inputs: &[&[f32]],
        dry_inputs: &[&[f32]],
        outputs: &mut [&mut [f32]],
    ) {
        if !self.enabled || self.convolvers.is_empty() {
            // Passthrough dry signal.
            for (out, dry) in outputs.iter_mut().zip(dry_inputs.iter()) {
                out.copy_from_slice(dry);
            }
            return;
        }

        // Stereo processing.
        if inputs.len() >= 2 && self.convolvers.len() >= 2 {
            let input_left = inputs[0];
            let input_right = inputs[1];
            let mut wet_left = vec![0.0; input_left.len()];
            let mut wet_right = vec![0.0; input_right.len()];
            let _ = self.convolvers[0].process(input_left, &mut wet_left);
            let _ = self.convolvers[1].process(input_right, &mut wet_right);
            for i in 0..input_left.len() {
                outputs[0][i] = wet_left[i];
                outputs[1][i] = wet_right[i];
            }
        }
        // Mono input duplicated for stereo output.
        else if inputs.len() == 1 && self.convolvers.len() >= 2 {
            let input = inputs[0];
            let mut wet_left = vec![0.0; input.len()];
            let mut wet_right = vec![0.0; input.len()];
            let _ = self.convolvers[0].process(input, &mut wet_left);
            let _ = self.convolvers[1].process(input, &mut wet_right);
            for i in 0..input.len() {
                outputs[0][i] = wet_left[i];
                outputs[1][i] = wet_right[i];
            }
        } else {
            // Fallback: copy dry signal.
            for (out, dry) in outputs.iter_mut().zip(dry_inputs.iter()) {
                out.copy_from_slice(dry);
            }
        }

        // Simple tail handling: if all inputs are silent, increment tail counter.
        let is_silent = inputs
            .iter()
            .all(|channel| channel.iter().all(|&s| s == 0.0));
        if is_silent {
            self.tail_count += outputs[0].len();
        } else {
            self.tail_count = 0;
        }
    }

    /// Reset internal state (e.g. tail counter).
    pub fn reset_state(&mut self) {
        self.tail_count = 0;
        // Optionally reset internal FFTConvolver state here.
    }

    /// Enable or disable the convolver.
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }
}

//
// Implement the AudioNode trait so that this node can be used in your audio graph.
//

impl AudioNode for Convolver {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::AudioInput0, false);
        ports.insert(PortId::AudioInput1, false);
        ports.insert(PortId::AudioOutput0, true);
        ports.insert(PortId::AudioOutput1, true);
        ports.insert(PortId::WetDryMix, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        if !self.enabled {
            return;
        }
        // Process modulation sources to obtain audio input buffers.
        let audio_in_l =
            self.process_modulations(buffer_size, inputs.get(&PortId::AudioInput0), 0.0);
        let audio_in_r =
            self.process_modulations(buffer_size, inputs.get(&PortId::AudioInput1), 0.0);
        let wet_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::WetDryMix), self.wet_level);

        let input_left: &[f32] = &audio_in_l;
        let input_right: &[f32] = &audio_in_r;
        let dry_left: &[f32] = &audio_in_l;
        let dry_right: &[f32] = &audio_in_r;

        // Remove mutable references from the HashMap to avoid double-borrow issues.
        let mut out_l = outputs.remove(&PortId::AudioOutput0).unwrap();
        let mut out_r = outputs.remove(&PortId::AudioOutput1).unwrap();

        {
            // Prepare a temporary mutable slice array for process_block.
            let output_slices: &mut [&mut [f32]] = &mut [out_l, out_r];
            self.process_block(
                &[input_left, input_right],
                &[dry_left, dry_right],
                output_slices,
            );
        }

        // Apply wet/dry mix modulation.
        for i in 0..buffer_size {
            out_l[i] = out_l[i] * wet_mod[i] + audio_in_l[i] * (1.0 - wet_mod[i]);
            out_r[i] = out_r[i] * wet_mod[i] + audio_in_r[i] * (1.0 - wet_mod[i]);
        }

        // Reinsert the output slices back into the HashMap.
        outputs.insert(PortId::AudioOutput0, out_l);
        outputs.insert(PortId::AudioOutput1, out_r);
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
    }

    fn node_type(&self) -> &str {
        "convolver"
    }
}

//
// Use the default implementation provided for ModulationProcessor.
//
impl ModulationProcessor for Convolver {}
