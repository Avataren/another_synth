use std::any::Any;
use std::collections::HashMap;
use std::simd::{f32x4, Simd, StdFloat};
use std::sync::OnceLock;

use wasm_bindgen::prelude::wasm_bindgen;

use crate::graph::{
    ModulationProcessor, ModulationSource, ModulationTransformation, ModulationType,
};
use crate::traits::{AudioNode, PortId};

// --- Enums, LfoTables, Constants remain the same ---
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LfoWaveform {
    Sine,
    Triangle,
    Square,
    Saw,
    InverseSaw,
}
impl LfoWaveform {
    #[inline(always)]
    fn normalized_phase_offset(self) -> f32 {
        match self {
            LfoWaveform::Sine | LfoWaveform::Triangle => -0.25,
            _ => 0.0,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LfoRetriggerMode {
    FreeRunning,
    Retrigger,
    OneShot,
}
impl LfoRetriggerMode {
    pub fn from_u8(value: u8) -> Self {
        match value {
            0 => LfoRetriggerMode::FreeRunning,
            1 => LfoRetriggerMode::Retrigger,
            2 => LfoRetriggerMode::OneShot,
            _ => LfoRetriggerMode::FreeRunning,
        }
    }
}
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LfoLoopMode {
    Off = 0,
    Loop = 1,
    PingPong = 2,
}
struct LfoTables {
    /* ... fields ... */ sine: Vec<f32>,
    triangle: Vec<f32>,
    square: Vec<f32>,
    saw: Vec<f32>,
    inverse_saw: Vec<f32>,
}
const TABLE_SIZE: usize = 1024;
const TABLE_MASK: usize = TABLE_SIZE - 1;
const TABLE_SIZE_F32: f32 = TABLE_SIZE as f32;
static LFO_TABLES: OnceLock<LfoTables> = OnceLock::new();
impl LfoTables {
    fn new() -> Self {
        let mut sine = vec![0.0; TABLE_SIZE];
        let mut triangle = vec![0.0; TABLE_SIZE];
        let mut square = vec![0.0; TABLE_SIZE];
        let mut saw = vec![0.0; TABLE_SIZE];
        let mut inverse_saw = vec![0.0; TABLE_SIZE];

        for i in 0..TABLE_SIZE {
            let phase_rad = 2.0 * std::f32::consts::PI * (i as f32) / TABLE_SIZE_F32;
            let phase_norm = i as f32 / TABLE_SIZE_F32;

            sine[i] = phase_rad.sin();
            triangle[i] = 2.0 * (2.0 * (phase_norm + 0.25).fract() - 1.0).abs() - 1.0;
            square[i] = if phase_norm < 0.5 { 1.0 } else { -1.0 };
            saw[i] = 2.0 * phase_norm - 1.0;
            inverse_saw[i] = 1.0 - 2.0 * phase_norm;
        }

        Self {
            sine,
            triangle,
            square,
            saw,
            inverse_saw,
        }
    }
    #[inline(always)]
    fn get_table(&self, waveform: LfoWaveform) -> &[f32] {
        match waveform {
            LfoWaveform::Sine => &self.sine,
            LfoWaveform::Triangle => &self.triangle,
            LfoWaveform::Square => &self.square,
            LfoWaveform::Saw => &self.saw,
            LfoWaveform::InverseSaw => &self.inverse_saw,
        }
    }
}

// --- LFO Node Struct ---
pub struct Lfo {
    // Parameters
    sample_rate: f32,
    base_frequency: f32,
    base_gain: f32,
    waveform: LfoWaveform,
    phase_offset: f32,
    use_absolute: bool,
    use_normalized: bool,
    pub retrigger_mode: LfoRetriggerMode,
    loop_mode: LfoLoopMode,
    loop_start: f32,
    loop_end: f32,
    active: bool,

    // State
    phase: f32,
    direction: f32,
    last_gate: f32,   // Stores the gate value from the *previous sample* processed
    is_running: bool, // Tracks if phase should advance (esp. for OneShot completion)
    oneshot_held_value: f32,

    // === Scratch Buffers ===
    mod_scratch_add: Vec<f32>,
    mod_scratch_mult: Vec<f32>,
    gate_buffer: Vec<f32>,
    scratch_freq_add: Vec<f32>,
    scratch_freq_mult: Vec<f32>,
    scratch_gain_add: Vec<f32>,
    scratch_gain_mult: Vec<f32>,
}

impl Lfo {
    pub fn new(sample_rate: f32) -> Self {
        LFO_TABLES.get_or_init(LfoTables::new);
        let initial_capacity = 128;

        Self {
            sample_rate,
            base_frequency: 1.0,
            base_gain: 1.0,
            waveform: LfoWaveform::Sine,
            phase_offset: 0.0,
            use_absolute: false,
            use_normalized: false,
            retrigger_mode: LfoRetriggerMode::FreeRunning,
            loop_mode: LfoLoopMode::Loop,
            loop_start: 0.0,
            loop_end: 1.0,
            active: true,
            phase: 0.0,
            direction: 1.0,
            last_gate: 0.0,   // Initialize gate as low
            is_running: true, // Start running in FreeRunning mode
            oneshot_held_value: 0.0,
            mod_scratch_add: vec![0.0; initial_capacity],
            mod_scratch_mult: vec![1.0; initial_capacity],
            gate_buffer: vec![0.0; initial_capacity],
            scratch_freq_add: vec![0.0; initial_capacity],
            scratch_freq_mult: vec![1.0; initial_capacity],
            scratch_gain_add: vec![0.0; initial_capacity],
            scratch_gain_mult: vec![1.0; initial_capacity],
        }
    }

    fn ensure_scratch_buffers(&mut self, size: usize) {
        let mut resize_if_needed = |buf: &mut Vec<f32>, default_val: f32| {
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

    // --- Parameter Setters ---
    pub fn set_gain(&mut self, gain: f32) {
        self.base_gain = gain.max(0.0);
    }
    pub fn set_frequency(&mut self, freq: f32) {
        self.base_frequency = freq.max(0.0);
    }
    pub fn set_waveform(&mut self, waveform: LfoWaveform) {
        self.waveform = waveform;
    }
    pub fn set_phase_offset(&mut self, offset: f32) {
        self.phase_offset = offset;
    }
    pub fn set_use_absolute(&mut self, use_absolute: bool) {
        self.use_absolute = use_absolute;
    }
    pub fn set_use_normalized(&mut self, use_normalized: bool) {
        self.use_normalized = use_normalized;
    }

    pub fn set_retrigger_mode(&mut self, mode: LfoRetriggerMode) {
        if mode != self.retrigger_mode {
            self.retrigger_mode = mode;
            self.reset_state_for_mode(self.last_gate > 0.0); // Pass current gate state
        }
    }

    pub fn set_loop_mode(&mut self, loop_mode: LfoLoopMode) {
        if loop_mode != self.loop_mode {
            self.loop_mode = loop_mode;
            if loop_mode != LfoLoopMode::PingPong {
                self.direction = 1.0;
            }
            // Optionally reset phase when loop mode changes? Depends on desired behavior.
            // self.reset_state_for_mode(self.last_gate > 0.0);
        }
    }
    pub fn set_loop_start(&mut self, start: f32) {
        self.loop_start = start.clamp(0.0, 1.0).min(self.loop_end);
        // Clamp current phase if it falls outside new range
        self.phase = self.phase.clamp(self.loop_start, self.loop_end);
    }
    pub fn set_loop_end(&mut self, end: f32) {
        self.loop_end = end.clamp(self.loop_start, 1.0); // Ensure end >= start
                                                         // Clamp current phase if it falls outside new range
        self.phase = self.phase.clamp(self.loop_start, self.loop_end);
    }

    /// Internal state reset logic. Sets phase, direction, and initial running state.
    /// `should_run_now` indicates if the LFO should start in a running state immediately
    /// (e.g., for FreeRunning, or if gate is high for Retrigger/OneShot).
    fn reset_state_for_mode(&mut self, should_run_now: bool) {
        self.phase = self.loop_start;
        self.direction = 1.0;
        self.is_running = match self.retrigger_mode {
            // FreeRunning always starts (or continues) running
            LfoRetriggerMode::FreeRunning => true,
            // Retrigger/OneShot start running only if told to
            LfoRetriggerMode::Retrigger | LfoRetriggerMode::OneShot => should_run_now,
        };
        // Resetting oneshot_held_value on any reset seems reasonable
        self.oneshot_held_value = 0.0;
    }

    #[inline(always)]
    fn lookup_sample_at_phase(&self, phase_value: f32) -> f32 {
        // ... (lookup_sample_at_phase remains the same) ...
        let tables = LFO_TABLES.get().expect("LFO tables not initialized");
        let table = tables.get_table(self.waveform);
        let extra_phase = if self.use_normalized {
            self.waveform.normalized_phase_offset()
        } else {
            0.0
        };
        let effective_phase = (phase_value + self.phase_offset + extra_phase).rem_euclid(1.0);
        let table_index_f = effective_phase * TABLE_SIZE_F32;
        let index1 = (table_index_f as usize) & TABLE_MASK;
        let index2 = (index1 + 1) & TABLE_MASK;
        let fraction = table_index_f - table_index_f.floor();
        let sample1 = table[index1];
        let sample2 = table[index2];
        let mut sample = sample1 + (sample2 - sample1) * fraction;
        if self.use_absolute {
            sample = sample.abs();
        }
        if self.use_normalized {
            sample = (sample + 1.0) * 0.5;
        }
        sample
    }

    /// Advances phase for one sample based on mode. Manages `is_running` for OneShot.
    #[inline(always)]
    fn internal_advance_phase(&mut self, phase_increment: f32) {
        if !self.is_running {
            return;
        } // Don't advance if stopped

        match self.loop_mode {
            LfoLoopMode::Off => {
                // Only advance if running (relevant for OneShot)
                self.phase += phase_increment * self.direction; // Direction should be 1.0
                if self.phase >= self.loop_end {
                    self.phase = self.loop_end; // Clamp at end
                    self.is_running = false; // Stop running
                    self.oneshot_held_value = self.lookup_sample_at_phase(self.phase);
                    // Store final value
                }
            }
            LfoLoopMode::Loop => {
                self.phase += phase_increment * self.direction;
                let loop_width = (self.loop_end - self.loop_start).max(1e-9);
                if self.phase >= self.loop_end {
                    let overflow = self.phase - self.loop_end;
                    self.phase = self.loop_start + overflow % loop_width;
                } else if self.phase < self.loop_start {
                    let underflow = self.loop_start - self.phase;
                    self.phase = self.loop_end - underflow % loop_width;
                }
            }
            LfoLoopMode::PingPong => {
                self.phase += phase_increment * self.direction;
                if self.direction > 0.0 && self.phase >= self.loop_end {
                    self.phase = self.loop_end - (self.phase - self.loop_end);
                    self.direction = -1.0;
                } else if self.direction < 0.0 && self.phase <= self.loop_start {
                    self.phase = self.loop_start + (self.loop_start - self.phase);
                    self.direction = 1.0;
                }
                self.phase = self.phase.clamp(self.loop_start, self.loop_end);
            }
        }
    }

    /// Public method to advance phase for a buffer when inactive (FreeRunning only).
    pub fn advance_phase_for_buffer(&mut self, buffer_size: usize) {
        if self.retrigger_mode != LfoRetriggerMode::FreeRunning || !self.is_running {
            return;
        }
        // Use base frequency - modulation isn't available here
        let total_phase_increment = (self.base_frequency * buffer_size as f32) / self.sample_rate;

        // --- Simulate advancement using loop logic (approximated) ---
        match self.loop_mode {
            LfoLoopMode::Off => { /* Should not be running if Off and FreeRunning? Logic error? Ignore for now. */
            }
            LfoLoopMode::Loop => {
                let loop_width = (self.loop_end - self.loop_start).max(1e-9);
                self.phase = self.loop_start
                    + (self.phase - self.loop_start + total_phase_increment * self.direction)
                        .rem_euclid(loop_width);
            }
            LfoLoopMode::PingPong => {
                let loop_width = (self.loop_end - self.loop_start).max(1e-9);
                let num_half_cycles = (total_phase_increment / loop_width).floor();
                let remainder_inc = total_phase_increment.rem_euclid(loop_width);

                if num_half_cycles % 2.0 != 0.0 {
                    self.direction *= -1.0;
                }

                let effective_start_phase = if self.direction > 0.0 {
                    self.loop_start
                } else {
                    self.loop_end
                };
                self.phase = effective_start_phase + remainder_inc * self.direction;

                if self.direction > 0.0 && self.phase >= self.loop_end {
                    self.phase = self.loop_end - (self.phase - self.loop_end);
                    self.direction = -1.0;
                } else if self.direction < 0.0 && self.phase <= self.loop_start {
                    self.phase = self.loop_start + (self.loop_start - self.phase);
                    self.direction = 1.0;
                }
                self.phase = self.phase.clamp(self.loop_start, self.loop_end);
            }
        }
    }

    pub fn get_waveform_data(
        waveform: LfoWaveform,
        phase_offset: f32,
        cycles_per_buffer: f32, // Frequency interpretation for visualization
        buffer_size: usize,
        use_absolute: bool,
        use_normalized: bool,
    ) -> Vec<f32> {
        // Ensure tables are initialized
        let tables = LFO_TABLES.get_or_init(LfoTables::new);
        let table = tables.get_table(waveform);
        let mut buffer = vec![0.0; buffer_size];
        if buffer_size == 0 {
            return buffer;
        } // Handle zero size

        // Calculate phase increment per sample for visualization
        let phase_increment = cycles_per_buffer / (buffer_size as f32);
        let mut current_phase = 0.0;

        let extra_phase_offset = if use_normalized {
            waveform.normalized_phase_offset()
        } else {
            0.0
        } + phase_offset;

        // Could use SIMD here as in original, but scalar is simpler for clarity
        for i in 0..buffer_size {
            let effective_phase = (current_phase + extra_phase_offset).rem_euclid(1.0);
            let table_index_f = effective_phase * TABLE_SIZE_F32;
            let index1 = (table_index_f as usize) & TABLE_MASK;
            let index2 = (index1 + 1) & TABLE_MASK;
            let fraction = table_index_f - table_index_f.floor();

            let sample1 = table[index1];
            let sample2 = table[index2];
            let mut sample = sample1 + (sample2 - sample1) * fraction;

            if use_absolute {
                sample = sample.abs();
            }
            if use_normalized {
                sample = (sample + 1.0) * 0.5;
            }

            buffer[i] = sample;

            current_phase += phase_increment;
            // No need to wrap current_phase here, rem_euclid handles it
        }
        buffer
    }
} // End impl Lfo

// --- ModulationProcessor Implementation ---
impl ModulationProcessor for Lfo {}

// --- AudioNode Implementation ---
impl AudioNode for Lfo {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        [
            (PortId::FrequencyMod, false), // Modulation for frequency
            (PortId::GainMod, false),      // Modulation for output gain/amplitude
            (PortId::CombinedGate, false), // Gate input for retriggering/one-shot
            (PortId::AudioOutput0, true),  // LFO output signal
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
        // --- 0) Early exit and Buffer Preparation ---
        if !self.active {
            if let Some(output_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
                output_buffer[..buffer_size].fill(0.0);
            }
            if self.retrigger_mode == LfoRetriggerMode::FreeRunning {
                // Ensure free-running LFOs advance phase even when node is inactive
                self.advance_phase_for_buffer(buffer_size);
            }
            return;
        }
        self.ensure_scratch_buffers(buffer_size);
        let output_buffer = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(buffer) => buffer,
            None => return,
        };

        // --- 1) Process Modulation Inputs ---
        // ... (gate, freq, gain modulation processing unchanged) ...
        self.gate_buffer[..buffer_size].fill(0.0);
        if let Some(gate_sources) = inputs.get(&PortId::CombinedGate) {
            for source in gate_sources {
                Self::apply_add(
                    &source.buffer,
                    &mut self.gate_buffer[..buffer_size],
                    source.amount,
                    source.transformation,
                );
            }
        }
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
            PortId::FrequencyMod,
            &mut self.scratch_freq_add,
            &mut self.scratch_freq_mult,
            0.0,
            1.0,
        );
        process_mod_input(
            PortId::GainMod,
            &mut self.scratch_gain_add,
            &mut self.scratch_gain_mult,
            0.0,
            1.0,
        );

        // --- 2) Main Processing Loop (Sample by Sample) ---
        for i in 0..buffer_size {
            // --- Handle Gate Input & Retriggering ---
            let current_gate = self.gate_buffer[i];
            let is_gate_high = current_gate > 0.0;
            let rising_edge = is_gate_high && self.last_gate <= 0.0;

            if rising_edge {
                match self.retrigger_mode {
                    LfoRetriggerMode::Retrigger | LfoRetriggerMode::OneShot => {
                        self.phase = self.loop_start;
                        self.direction = 1.0;
                        self.is_running = true; // Start/Restart running on rising edge
                        self.oneshot_held_value = 0.0; // Clear potential held value on new trigger
                    }
                    LfoRetriggerMode::FreeRunning => {} // No action needed
                }
            }
            // Update last_gate for next sample's edge detection
            self.last_gate = current_gate;

            // --- Determine if LFO should run *this sample* ---
            // This check combines activation state and gate state for relevant modes
            let run_this_sample = match self.retrigger_mode {
                LfoRetriggerMode::FreeRunning => true, // Always runs if active
                LfoRetriggerMode::Retrigger => is_gate_high, // Runs only if gate is high
                LfoRetriggerMode::OneShot => self.is_running, // Runs if flag is set (until completion)
            };

            // --- Calculate Per-Sample Parameters ---
            let current_freq =
                (self.base_frequency + self.scratch_freq_add[i]) * self.scratch_freq_mult[i];
            let current_gain =
                (self.base_gain + self.scratch_gain_add[i]) * self.scratch_gain_mult[i];

            // --- Calculate Output Sample ---
            let output_sample = if run_this_sample {
                let value = self.lookup_sample_at_phase(self.phase);
                // Advance phase if we are supposed to be running
                let phase_increment = (current_freq / self.sample_rate).max(0.0);
                self.internal_advance_phase(phase_increment);
                value
            } else {
                // Not running this sample
                if self.retrigger_mode == LfoRetriggerMode::OneShot && !self.is_running {
                    // OneShot finished, hold value
                    self.oneshot_held_value
                } else {
                    // Retrigger mode when gate is low, or other stopped states
                    // Output value at loop_start
                    self.lookup_sample_at_phase(self.loop_start)
                }
            };

            // Apply final gain and write to output
            output_buffer[i] = output_sample * current_gain.max(0.0);
        }
    } // End process

    // --- reset and other trait methods ---
    fn reset(&mut self) {
        // Reset state based on mode, assume gate is low initially
        self.reset_state_for_mode(false);
        self.last_gate = 0.0;
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
        if active == self.active {
            return; // No change
        }
        self.active = active;

        if active {
            // --- LFO is becoming ACTIVE ---
            // We need to ensure `is_running` is correctly set.
            // Option 1: Always restart based on mode (simplest)
            // self.reset_state_for_mode(self.last_gate > 0.0); // Reset based on *last known* gate

            // Option 2: More robust - set running based on mode only, let `process` handle gate state
            self.is_running = match self.retrigger_mode {
                LfoRetriggerMode::FreeRunning => true, // FreeRunning should always run if active
                LfoRetriggerMode::Retrigger => self.last_gate > 0.0, // Start running only if gate was high
                LfoRetriggerMode::OneShot => {
                    // If OneShot was already finished, activating shouldn't restart it without a new trigger.
                    // If it wasn't finished, it should continue.
                    // This logic is tricky. Let's reset based on last known gate, assuming activation
                    // should behave like a trigger if gate is high.
                    if self.last_gate > 0.0 {
                        // Treat activation like a trigger if gate is high
                        self.phase = self.loop_start;
                        self.direction = 1.0;
                        true // Start running
                    } else {
                        // Gate is low, remain stopped until next trigger
                        false
                    }
                }
            };
            // Don't reset phase here unless explicitly desired when activating while gate high.
            // The logic above restarts OneShot/Retrigger if gate was high.
        } else {
            // --- LFO is becoming INACTIVE ---
            // No state change needed usually, `process` handles the early exit.
            // `advance_phase_for_buffer` will handle FreeRunning.
            // We could optionally reset phase here if desired when stopping.
            // self.reset();
        }
    }
    // fn reset(&mut self) {
    //     // Reset state based on mode, assume gate is low initially for a full reset
    //     self.reset_state_for_mode(false); // Pass false, requires trigger to start if not FreeRunning
    //     self.last_gate = 0.0; // Reset gate memory
    // }
    fn node_type(&self) -> &str {
        "lfo"
    }
} // End impl AudioNode for Lfo
