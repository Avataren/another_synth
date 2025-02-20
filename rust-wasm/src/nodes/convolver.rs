use rustfft::{num_complex::Complex, FftPlanner};
use std::any::Any;
use std::collections::HashMap;
use std::error::Error;
use std::io::Cursor;
use std::simd::{f32x4, StdFloat};
use wasm_bindgen::prelude::*;

use crate::graph::{ModulationProcessor, ModulationSource, ModulationType};
use crate::traits::{AudioNode, PortId};

pub struct Convolver {
    enabled: bool,
    impulse_response_l: Vec<f32>,
    impulse_response_r: Vec<f32>,
    ir_spectrum_l: Vec<Complex<f32>>,
    ir_spectrum_r: Vec<Complex<f32>>,
    fft_size: usize,
    overlap_add_buffer_l: Vec<f32>,
    overlap_add_buffer_r: Vec<f32>,
    temp_buffer: Vec<Complex<f32>>,
    forward_fft: std::sync::Arc<dyn rustfft::Fft<f32>>,
    inverse_fft: std::sync::Arc<dyn rustfft::Fft<f32>>,
    wet_level: f32,
}

impl Convolver {
    /// Loads an impulse response from raw WAV data bytes.
    /// Returns a tuple of (left_channel, Option<right_channel>).
    pub fn load_impulse_response(
        data: &[u8],
    ) -> Result<(Vec<f32>, Option<Vec<f32>>), Box<dyn Error>> {
        let cursor = Cursor::new(data);
        let mut wav_reader = hound::WavReader::new(cursor)?;
        let spec = wav_reader.spec();
        let channels = spec.channels as usize;

        if channels > 2 {
            return Err("WAV files with more than 2 channels are not supported".into());
        }

        // Read samples from the WAV (handling various bit depths/formats)
        let raw_samples: Vec<f32> = match (spec.bits_per_sample, spec.sample_format) {
            (32, hound::SampleFormat::Float) => {
                wav_reader.samples::<f32>().map(|s| s.unwrap()).collect()
            }
            (16, hound::SampleFormat::Int) => wav_reader
                .samples::<i16>()
                .map(|s| s.unwrap() as f32 / i16::MAX as f32)
                .collect(),
            (24, hound::SampleFormat::Int) => {
                let shift = 32 - 24;
                wav_reader
                    .samples::<i32>()
                    .map(|s| (s.unwrap() << shift >> shift) as f32 / 8_388_607.0)
                    .collect()
            }
            (32, hound::SampleFormat::Int) => wav_reader
                .samples::<i32>()
                .map(|s| s.unwrap() as f32 / i32::MAX as f32)
                .collect(),
            (bits, format) => {
                return Err(format!(
                    "Unsupported WAV format: bits_per_sample={} sample_format={:?}",
                    bits, format
                )
                .into())
            }
        };

        // Split channels if stereo
        match channels {
            1 => Ok((raw_samples, None)),
            2 => {
                let mut left = Vec::with_capacity(raw_samples.len() / 2);
                let mut right = Vec::with_capacity(raw_samples.len() / 2);

                for chunk in raw_samples.chunks_exact(2) {
                    left.push(chunk[0]);
                    right.push(chunk[1]);
                }

                Ok((left, Some(right)))
            }
            _ => unreachable!(), // We checked for >2 channels earlier
        }
    }

    // #[wasm_bindgen]
    pub fn import_impulse_response(&mut self, data: &[u8]) -> Result<(), JsValue> {
        let (ir_left, ir_right) =
            Self::load_impulse_response(data).map_err(|e| JsValue::from_str(&e.to_string()))?;

        self.set_impulse_response(ir_left, ir_right);
        Ok(())
    }

    pub fn new(impulse_response_l: Vec<f32>, impulse_response_r: Option<Vec<f32>>) -> Self {
        let ir_r = impulse_response_r.unwrap_or_else(|| impulse_response_l.clone());
        let fft_size = (impulse_response_l.len() * 2).next_power_of_two();
        let mut planner = FftPlanner::new();
        let forward_fft = planner.plan_fft_forward(fft_size);
        let inverse_fft = planner.plan_fft_inverse(fft_size);

        // Prepare the impulse response spectrums
        let mut ir_spectrum_l = vec![Complex::new(0.0, 0.0); fft_size];
        let mut ir_spectrum_r = vec![Complex::new(0.0, 0.0); fft_size];

        // Left channel
        for (i, &sample) in impulse_response_l.iter().enumerate() {
            ir_spectrum_l[i] = Complex::new(sample, 0.0);
        }
        forward_fft.process(&mut ir_spectrum_l);

        // Right channel
        for (i, &sample) in ir_r.iter().enumerate() {
            ir_spectrum_r[i] = Complex::new(sample, 0.0);
        }
        forward_fft.process(&mut ir_spectrum_r);

        Self {
            enabled: true,
            impulse_response_l,
            impulse_response_r: ir_r,
            ir_spectrum_l,
            ir_spectrum_r,
            fft_size,
            overlap_add_buffer_l: vec![0.0; fft_size],
            overlap_add_buffer_r: vec![0.0; fft_size],
            temp_buffer: vec![Complex::new(0.0, 0.0); fft_size],
            forward_fft,
            inverse_fft,
            wet_level: 0.5,
        }
    }

    pub fn set_impulse_response(
        &mut self,
        impulse_response_l: Vec<f32>,
        impulse_response_r: Option<Vec<f32>>,
    ) {
        let ir_r = impulse_response_r.unwrap_or_else(|| impulse_response_l.clone());

        // Check if we need to resize our FFT
        let new_fft_size = (impulse_response_l.len() * 2).next_power_of_two();
        if new_fft_size != self.fft_size {
            self.fft_size = new_fft_size;
            let mut planner = FftPlanner::new();
            self.forward_fft = planner.plan_fft_forward(new_fft_size);
            self.inverse_fft = planner.plan_fft_inverse(new_fft_size);

            // Resize buffers
            self.overlap_add_buffer_l = vec![0.0; new_fft_size];
            self.overlap_add_buffer_r = vec![0.0; new_fft_size];
            self.temp_buffer = vec![Complex::new(0.0, 0.0); new_fft_size];
        }

        // Update impulse responses
        self.impulse_response_l = impulse_response_l;
        self.impulse_response_r = ir_r;

        // Recompute FFT of impulse responses
        self.ir_spectrum_l = vec![Complex::new(0.0, 0.0); self.fft_size];
        self.ir_spectrum_r = vec![Complex::new(0.0, 0.0); self.fft_size];

        // Left channel
        for (i, &sample) in self.impulse_response_l.iter().enumerate() {
            self.ir_spectrum_l[i] = Complex::new(sample, 0.0);
        }
        self.forward_fft.process(&mut self.ir_spectrum_l);

        // Right channel
        for (i, &sample) in self.impulse_response_r.iter().enumerate() {
            self.ir_spectrum_r[i] = Complex::new(sample, 0.0);
        }
        self.forward_fft.process(&mut self.ir_spectrum_r);

        // Clear the overlap buffers
        self.overlap_add_buffer_l.fill(0.0);
        self.overlap_add_buffer_r.fill(0.0);
    }

    fn process_block(
        &mut self,
        input_l: &[f32],
        input_r: &[f32],
        output_l: &mut [f32],
        output_r: &mut [f32],
    ) {
        let block_size = input_l.len();

        // Process left channel
        {
            // Prepare input buffer
            for i in 0..block_size {
                self.temp_buffer[i] = Complex::new(input_l[i], 0.0);
            }
            for i in block_size..self.fft_size {
                self.temp_buffer[i] = Complex::new(0.0, 0.0);
            }

            // Forward FFT
            self.forward_fft.process(&mut self.temp_buffer);

            // Multiply with IR spectrum
            for i in 0..self.fft_size {
                self.temp_buffer[i] = self.temp_buffer[i] * self.ir_spectrum_l[i];
            }

            // Inverse FFT
            self.inverse_fft.process(&mut self.temp_buffer);

            // Overlap-add
            for i in 0..block_size {
                output_l[i] =
                    self.overlap_add_buffer_l[i] + self.temp_buffer[i].re / self.fft_size as f32;
            }

            // Update overlap buffer
            self.overlap_add_buffer_l.copy_within(block_size.., 0);
            for i in (self.fft_size - block_size)..self.fft_size {
                self.overlap_add_buffer_l[i] = 0.0;
            }
        }

        // Process right channel
        {
            // Prepare input buffer
            for i in 0..block_size {
                self.temp_buffer[i] = Complex::new(input_r[i], 0.0);
            }
            for i in block_size..self.fft_size {
                self.temp_buffer[i] = Complex::new(0.0, 0.0);
            }

            // Forward FFT
            self.forward_fft.process(&mut self.temp_buffer);

            // Multiply with IR spectrum
            for i in 0..self.fft_size {
                self.temp_buffer[i] = self.temp_buffer[i] * self.ir_spectrum_r[i];
            }

            // Inverse FFT
            self.inverse_fft.process(&mut self.temp_buffer);

            // Overlap-add
            for i in 0..block_size {
                output_r[i] =
                    self.overlap_add_buffer_r[i] + self.temp_buffer[i].re / self.fft_size as f32;
            }

            // Update overlap buffer
            self.overlap_add_buffer_r.copy_within(block_size.., 0);
            for i in (self.fft_size - block_size)..self.fft_size {
                self.overlap_add_buffer_r[i] = 0.0;
            }
        }
    }
}

impl ModulationProcessor for Convolver {}

impl AudioNode for Convolver {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::AudioInput0, false); // Left input
        ports.insert(PortId::AudioInput1, false); // Right input
        ports.insert(PortId::AudioOutput0, true); // Left output
        ports.insert(PortId::AudioOutput1, true); // Right output
        ports.insert(PortId::WetDryMix, false); // Wet/dry mix control
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

        // Get wet/dry mix modulation
        let wet_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::WetDryMix), self.wet_level);

        // Get input audio
        let audio_in_l =
            self.process_modulations(buffer_size, inputs.get(&PortId::AudioInput0), 0.0);
        let audio_in_r =
            self.process_modulations(buffer_size, inputs.get(&PortId::AudioInput1), 0.0);

        // Create temporary buffers for wet signals
        let mut wet_buffer_l = vec![0.0; buffer_size];
        let mut wet_buffer_r = vec![0.0; buffer_size];

        // Process convolution
        self.process_block(
            &audio_in_l,
            &audio_in_r,
            &mut wet_buffer_l,
            &mut wet_buffer_r,
        );

        // Mix dry and wet signals for both channels
        for (output_port, wet_buffer, dry_buffer) in [
            (PortId::AudioOutput0, &wet_buffer_l, &audio_in_l),
            (PortId::AudioOutput1, &wet_buffer_r, &audio_in_r),
        ] {
            if let Some(out) = outputs.get_mut(&output_port) {
                for i in (0..buffer_size).step_by(4) {
                    let end = (i + 4).min(buffer_size);

                    let wet_chunk = {
                        let mut chunk = [0.0; 4];
                        chunk[0..end - i].copy_from_slice(&wet_buffer[i..end]);
                        f32x4::from_array(chunk)
                    };

                    let dry_chunk = {
                        let mut chunk = [0.0; 4];
                        chunk[0..end - i].copy_from_slice(&dry_buffer[i..end]);
                        f32x4::from_array(chunk)
                    };

                    let mix_chunk = {
                        let mut chunk = [0.0; 4];
                        chunk[0..end - i].copy_from_slice(&wet_mod[i..end]);
                        f32x4::from_array(chunk)
                    };

                    let output =
                        wet_chunk * mix_chunk + dry_chunk * (f32x4::splat(1.0) - mix_chunk);
                    out[i..end].copy_from_slice(&output.to_array()[0..end - i]);
                }
            }
        }
    }

    fn reset(&mut self) {
        self.overlap_add_buffer_l.fill(0.0);
        self.overlap_add_buffer_r.fill(0.0);
        self.temp_buffer.fill(Complex::new(0.0, 0.0));
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
