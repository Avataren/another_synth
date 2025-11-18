use crate::graph::{ModulationSource, ModulationType};
use crate::traits::{AudioNode, PortId};
use rustc_hash::FxHashMap;
use std::any::Any;
use std::rc::Rc;
use std::cell::RefCell;

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};

/// Sample loop mode
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum SamplerLoopMode {
    Off = 0,      // One-shot playback, no looping
    Loop = 1,     // Loop between loop_start and loop_end
    PingPong = 2, // Bounce back and forth between loop_start and loop_end
}

/// Sample trigger mode
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum SamplerTriggerMode {
    FreeRunning = 0,  // Always plays
    Gate = 1,         // Retriggers on rising gate edge, ignores gate off
    OneShot = 2,      // Plays once per gate trigger, ignores gate until complete
}

/// Shared sample data structure
#[derive(Clone)]
pub struct SampleData {
    /// Sample buffer (interleaved if stereo: [L, R, L, R, ...])
    pub samples: Vec<f32>,
    /// Number of channels (1 = mono, 2 = stereo)
    pub channels: usize,
    /// Sample rate of the loaded sample
    pub sample_rate: f32,
    /// Original root note (MIDI note number, default 60 = C4)
    pub root_note: f32,
}

impl SampleData {
    pub fn new() -> Self {
        Self {
            samples: Vec::new(),
            channels: 1,
            sample_rate: 44100.0,
            root_note: 60.0, // Middle C
        }
    }

    pub fn load_from_wav(&mut self, samples: Vec<f32>, channels: usize, sample_rate: f32) {
        self.samples = samples;
        self.channels = channels;
        self.sample_rate = sample_rate;
    }

    #[inline]
    pub fn len(&self) -> usize {
        if self.channels == 0 {
            0
        } else {
            self.samples.len() / self.channels
        }
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// Get interpolated sample at a given position (in frames, not samples)
    /// Returns (left, right) tuple. For mono, both channels return the same value.
    #[inline]
    fn get_sample_interpolated(&self, position: f32) -> (f32, f32) {
        if self.samples.is_empty() {
            return (0.0, 0.0);
        }

        let frame_count = self.len();
        let position = position.clamp(0.0, (frame_count - 1) as f32);

        let index = position.floor() as usize;
        let frac = position - index as f32;
        let next_index = (index + 1).min(frame_count - 1);

        if self.channels == 1 {
            // Mono - linear interpolation
            let sample1 = self.samples[index];
            let sample2 = self.samples[next_index];
            let value = sample1 + (sample2 - sample1) * frac;
            (value, value)
        } else {
            // Stereo - linear interpolation per channel
            let left1 = self.samples[index * 2];
            let right1 = self.samples[index * 2 + 1];
            let left2 = self.samples[next_index * 2];
            let right2 = self.samples[next_index * 2 + 1];

            let left = left1 + (left2 - left1) * frac;
            let right = right1 + (right2 - right1) * frac;
            (left, right)
        }
    }
}

impl Default for SampleData {
    fn default() -> Self {
        Self::new()
    }
}

/// Sampler node - plays back audio samples with pitch control and looping
pub struct Sampler {
    // Shared sample data
    sample_data: Rc<RefCell<SampleData>>,

    // Parameters
    sample_rate: f32,          // Engine sample rate
    base_frequency: f32,       // Base frequency (440 Hz = A4)
    base_gain: f32,            // Output gain
    trigger_mode: SamplerTriggerMode,
    loop_mode: SamplerLoopMode,
    loop_start: f32,           // Loop start point (in frames)
    loop_end: f32,             // Loop end point (in frames)
    active: bool,

    // State
    playhead: f32,             // Current playback position (in frames)
    direction: f32,            // 1.0 = forward, -1.0 = reverse (for ping-pong)
    last_gate: f32,            // Previous gate value
    is_playing: bool,          // Whether currently playing
    oneshot_complete: bool,    // For OneShot mode

    // Scratch buffers for modulation
    mod_scratch_add: Vec<f32>,
    mod_scratch_mult: Vec<f32>,
    gate_buffer: Vec<f32>,
    scratch_freq_add: Vec<f32>,
    scratch_freq_mult: Vec<f32>,
    scratch_gain_add: Vec<f32>,
    scratch_gain_mult: Vec<f32>,
}

impl Sampler {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_data: Rc::new(RefCell::new(SampleData::new())),
            sample_rate,
            base_frequency: 440.0, // A4
            base_gain: 1.0,
            trigger_mode: SamplerTriggerMode::Gate,
            loop_mode: SamplerLoopMode::Off,
            loop_start: 0.0,
            loop_end: 0.0,
            active: true,
            playhead: 0.0,
            direction: 1.0,
            last_gate: 0.0,
            is_playing: false,
            oneshot_complete: false,
            mod_scratch_add: vec![0.0; 128],
            mod_scratch_mult: vec![1.0; 128],
            gate_buffer: vec![0.0; 128],
            scratch_freq_add: vec![0.0; 128],
            scratch_freq_mult: vec![1.0; 128],
            scratch_gain_add: vec![0.0; 128],
            scratch_gain_mult: vec![1.0; 128],
        }
    }

    /// Get a shared reference to the sample data
    pub fn get_sample_data(&self) -> Rc<RefCell<SampleData>> {
        self.sample_data.clone()
    }

    /// Set the sample data
    pub fn set_sample_data(&mut self, data: Rc<RefCell<SampleData>>) {
        self.sample_data = data;
        // Reset playback state
        self.playhead = 0.0;
        self.direction = 1.0;
        self.is_playing = false;
        self.oneshot_complete = false;

        // Update loop_end to sample length if not set
        let sample_len = self.sample_data.borrow().len() as f32;
        if self.loop_end <= 0.0 {
            self.loop_end = sample_len;
        }
    }

    pub fn set_base_frequency(&mut self, frequency: f32) {
        self.base_frequency = frequency.max(0.001);
    }

    pub fn set_base_gain(&mut self, gain: f32) {
        self.base_gain = gain.clamp(0.0, 10.0);
    }

    pub fn set_loop_mode(&mut self, mode: SamplerLoopMode) {
        self.loop_mode = mode;
    }

    pub fn set_loop_start(&mut self, start: f32) {
        self.loop_start = start.max(0.0);
    }

    pub fn set_loop_end(&mut self, end: f32) {
        self.loop_end = end;
    }

    pub fn set_trigger_mode(&mut self, mode: SamplerTriggerMode) {
        self.trigger_mode = mode;
    }

    pub fn set_root_note(&mut self, note: f32) {
        self.sample_data.borrow_mut().root_note = note;
    }

    fn ensure_scratch_buffers(&mut self, size: usize) {
        let resize_if_needed = |buf: &mut Vec<f32>, default_val: f32| {
            if buf.len() < size {
                buf.resize(size, default_val);
            }
        };
        resize_if_needed(&mut self.mod_scratch_add, 0.0);
        resize_if_needed(&mut self.mod_scratch_mult, 1.0);
        resize_if_needed(&mut self.gate_buffer, 0.0);
        resize_if_needed(&mut self.scratch_freq_add, 0.0);
        resize_if_needed(&mut self.scratch_freq_mult, 1.0);
        resize_if_needed(&mut self.scratch_gain_add, 0.0);
        resize_if_needed(&mut self.scratch_gain_mult, 1.0);
    }

    fn collect_modulation(
        &mut self,
        port: PortId,
        sources: &FxHashMap<PortId, Vec<ModulationSource>>,
        size: usize,
    ) -> (Vec<f32>, Vec<f32>) {
        let add_buf = &mut self.mod_scratch_add[..size];
        let mult_buf = &mut self.mod_scratch_mult[..size];
        add_buf.fill(0.0);
        mult_buf.fill(1.0);

        if let Some(mods) = sources.get(&port) {
            for modulation_source in mods {
                let amount = modulation_source.amount;
                let mod_type = modulation_source.mod_type;
                for i in 0..size {
                    let value = modulation_source.buffer.get(i).copied().unwrap_or(0.0);
                    match mod_type {
                        ModulationType::Additive => {
                            add_buf[i] += value * amount;
                        }
                        ModulationType::VCA | ModulationType::Bipolar => {
                            mult_buf[i] *= 1.0 + value * amount;
                        }
                    }
                }
            }
        }

        (add_buf.to_vec(), mult_buf.to_vec())
    }
}

impl AudioNode for Sampler {
    fn get_ports(&self) -> FxHashMap<PortId, bool> {
        let mut ports = FxHashMap::default();
        ports.insert(PortId::AudioOutput0, true); // Left output
        ports.insert(PortId::AudioOutput1, true); // Right output
        ports.insert(PortId::GlobalGate, false);  // Gate input
        ports.insert(PortId::GlobalFrequency, false); // Note pitch from voice
        ports.insert(PortId::FrequencyMod, false);    // Frequency modulation
        ports.insert(PortId::GainMod, false);         // Gain modulation
        ports
    }

    fn process(
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        if !self.active {
            return;
        }

        self.ensure_scratch_buffers(buffer_size);

        // Get gate buffer
        {
            let gate_buf = &mut self.gate_buffer[..buffer_size];
            gate_buf.fill(1.0);
            if let Some(gate_sources) = inputs.get(&PortId::GlobalGate) {
                if !gate_sources.is_empty() {
                    let first_gate = &gate_sources[0];
                    for i in 0..buffer_size {
                        gate_buf[i] = first_gate.buffer.get(i).copied().unwrap_or(0.0);
                    }
                }
            }
        }

        // Collect frequency modulation
        let (freq_add, freq_mult) =
            self.collect_modulation(PortId::FrequencyMod, inputs, buffer_size);

        // Collect gain modulation
        let (gain_add, gain_mult) = self.collect_modulation(PortId::GainMod, inputs, buffer_size);

        let sample_data = self.sample_data.borrow();

        // Calculate playback rate based on frequency
        // Frequency is in Hz, need to convert to playback rate
        let sample_len = sample_data.len() as f32;

        // Get output buffers - must split to get two mutable references
        let has_left = outputs.contains_key(&PortId::AudioOutput0);
        let has_right = outputs.contains_key(&PortId::AudioOutput1);

        if sample_len <= 0.0 {
            // No sample loaded, output silence
            if has_left {
                if let Some(buf) = outputs.get_mut(&PortId::AudioOutput0) {
                    for s in buf[..buffer_size].iter_mut() {
                        *s = 0.0;
                    }
                }
            }
            if has_right {
                if let Some(buf) = outputs.get_mut(&PortId::AudioOutput1) {
                    for s in buf[..buffer_size].iter_mut() {
                        *s = 0.0;
                    }
                }
            }
            return;
        }

        // Calculate the base playback rate
        // Convert MIDI note to frequency: freq = 440 * 2^((note - 69) / 12)
        let root_freq = 440.0 * 2.0_f32.powf((sample_data.root_note - 69.0) / 12.0);
        let sample_rate_ratio = sample_data.sample_rate / self.sample_rate;

        let global_freq_source = inputs
            .get(&PortId::GlobalFrequency)
            .and_then(|sources| sources.first());

        // Process samples directly to output
        let tuning_ratio = if self.base_frequency <= 0.0 {
            1.0
        } else {
            self.base_frequency / 440.0
        };

        for i in 0..buffer_size {
            let gate = self.gate_buffer[i];

            // Handle gate triggers
            let gate_rising = gate > 0.5 && self.last_gate <= 0.5;
            match self.trigger_mode {
                SamplerTriggerMode::FreeRunning => {
                    self.is_playing = true;
                }
                SamplerTriggerMode::Gate => {
                    if gate_rising {
                        self.playhead = 0.0;
                        self.direction = 1.0;
                        self.is_playing = true;
                    }
                }
                SamplerTriggerMode::OneShot => {
                    if gate_rising && !self.is_playing {
                        self.playhead = 0.0;
                        self.direction = 1.0;
                        self.is_playing = true;
                        self.oneshot_complete = false;
                    }
                }
            }
            self.last_gate = gate;

            // Calculate frequency for this sample
            let base_pitch = global_freq_source
                .and_then(|src| src.buffer.get(i).copied())
                .unwrap_or(440.0);
            let freq = ((base_pitch + freq_add[i]) * freq_mult[i]) * tuning_ratio;
            let playback_rate = (freq / root_freq) * sample_rate_ratio;

            // Calculate gain for this sample
            let gain = (self.base_gain + gain_add[i]) * gain_mult[i];

            // Get sample value at current playhead
            let (left, right) = if self.is_playing {
                let (l, r) = sample_data.get_sample_interpolated(self.playhead);
                (l * gain, r * gain)
            } else {
                (0.0, 0.0)
            };

            // Store to scratch buffers
            self.scratch_freq_add[i] = left;
            self.scratch_freq_mult[i] = right;

            // Inline playhead advancement to avoid borrow issues
            if self.is_playing {
                let loop_start = self.loop_start.clamp(0.0, sample_len - 1.0);
                let loop_end = self.loop_end.clamp(loop_start + 1.0, sample_len);

                match self.loop_mode {
                    SamplerLoopMode::Off => {
                        // One-shot playback - play once and stop at the end
                        self.playhead += playback_rate * self.direction;
                        if self.playhead >= sample_len {
                            self.playhead = sample_len - 1.0;
                            self.is_playing = false;
                            if self.trigger_mode == SamplerTriggerMode::OneShot {
                                self.oneshot_complete = true;
                            }
                        } else if self.playhead < 0.0 {
                            self.playhead = 0.0;
                        }
                    }
                    SamplerLoopMode::Loop => {
                        self.playhead += playback_rate * self.direction;
                        if self.playhead >= loop_end {
                            let overflow = self.playhead - loop_end;
                            let loop_width = loop_end - loop_start;
                            self.playhead = loop_start + (overflow % loop_width);
                        } else if self.playhead < loop_start {
                            let underflow = loop_start - self.playhead;
                            let loop_width = loop_end - loop_start;
                            self.playhead = loop_end - (underflow % loop_width);
                        }
                    }
                    SamplerLoopMode::PingPong => {
                        self.playhead += playback_rate * self.direction;
                        if self.direction > 0.0 && self.playhead >= loop_end {
                            self.playhead = loop_end - (self.playhead - loop_end);
                            self.direction = -1.0;
                        } else if self.direction < 0.0 && self.playhead <= loop_start {
                            self.playhead = loop_start + (loop_start - self.playhead);
                            self.direction = 1.0;
                        }
                    }
                }
            }
        }

        // Copy from scratch buffers to outputs
        if has_left {
            if let Some(buf) = outputs.get_mut(&PortId::AudioOutput0) {
                buf[..buffer_size].copy_from_slice(&self.scratch_freq_add[..buffer_size]);
            }
        }
        if has_right {
            if let Some(buf) = outputs.get_mut(&PortId::AudioOutput1) {
                buf[..buffer_size].copy_from_slice(&self.scratch_freq_mult[..buffer_size]);
            }
        }
    }

    fn reset(&mut self) {
        self.playhead = 0.0;
        self.direction = 1.0;
        self.last_gate = 0.0;
        self.is_playing = false;
        self.oneshot_complete = false;
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

    fn name(&self) -> &str {
        "Sampler"
    }

    fn node_type(&self) -> &str {
        "Sampler"
    }
}
