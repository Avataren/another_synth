use rustc_hash::FxHashMap;
use std::any::Any;

use crate::graph::{ModulationSource, ModulationTransformation, ModulationType};
use crate::traits::{AudioNode, PortId};

pub struct Glide {
    sample_rate: f32,
    rise_time: f32,
    fall_time: f32,
    rise_alpha: f32,
    fall_alpha: f32,
    current: f32,
    active: bool,
    last_gate_value: f32,
}

impl Glide {
    pub fn new(sample_rate: f32, rise_time: f32, fall_time: f32) -> Self {
        let sample_rate = sample_rate.max(1.0);
        let rise_time = rise_time.max(0.0);
        let fall_time = fall_time.max(0.0);

        let rise_alpha = Self::time_to_alpha(sample_rate, rise_time);
        let fall_alpha = Self::time_to_alpha(sample_rate, fall_time);

        Self {
            sample_rate,
            rise_time,
            fall_time,
            rise_alpha,
            fall_alpha,
            current: 0.0,
            active: true,
            last_gate_value: 0.0,
        }
    }

    fn time_to_alpha(sample_rate: f32, time_sec: f32) -> f32 {
        if time_sec <= 0.0 {
            1.0
        } else {
            let tau_samples = (time_sec * sample_rate).max(1.0);
            1.0 - (-1.0 / tau_samples).exp()
        }
    }

    pub fn set_sample_rate(&mut self, sample_rate: f32) {
        self.sample_rate = sample_rate.max(1.0);
        self.rise_alpha = Self::time_to_alpha(self.sample_rate, self.rise_time);
        self.fall_alpha = Self::time_to_alpha(self.sample_rate, self.fall_time);
    }

    pub fn set_rise_time(&mut self, rise_time: f32) {
        self.rise_time = rise_time.max(0.0);
        self.rise_alpha = Self::time_to_alpha(self.sample_rate, self.rise_time);
    }

    pub fn set_fall_time(&mut self, fall_time: f32) {
        self.fall_time = fall_time.max(0.0);
        self.fall_alpha = Self::time_to_alpha(self.sample_rate, self.fall_time);
    }

    #[inline]
    fn next_value(&mut self, target: f32) -> f32 {
        let alpha = if target >= self.current {
            self.rise_alpha
        } else {
            self.fall_alpha
        };
        let delta = target - self.current;
        self.current += alpha * delta;
        self.current
    }
}

impl AudioNode for Glide {
    fn get_ports(&self) -> FxHashMap<PortId, bool> {
        [
            (PortId::AudioInput0, false),
            (PortId::CombinedGate, false),
            (PortId::AudioOutput0, true),
        ]
        .into_iter()
        .collect()
    }

    fn process(
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        if !self.active {
            if let Some(out) = outputs.get_mut(&PortId::AudioOutput0) {
                out[..buffer_size].fill(0.0);
            }
            return;
        }

        let input = inputs
            .get(&PortId::AudioInput0)
            .and_then(|sources| sources.first())
            .map(|src| &src.buffer[..buffer_size])
            .unwrap_or(&[][..]);

        let output = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(buf) => buf,
            None => return,
        };

        // Optional gate input (CombinedGate). If present, we use it to
        // detect new note-ons and bypass glide on 0 -> 1 edges so that
        // each new gated note starts at its correct frequency.
        let gate_buffer = inputs
            .get(&PortId::CombinedGate)
            .and_then(|sources| sources.first())
            .map(|src| &src.buffer[..buffer_size]);

        if input.is_empty() {
            output[..buffer_size].fill(self.current);
            if let Some(gates) = gate_buffer {
                if !gates.is_empty() {
                    self.last_gate_value = gates[gates.len().saturating_sub(1)];
                }
            }
            return;
        }

        // If we have a gate buffer, treat the gate as block-rate and
        // disable glide on 0 -> 1 edges (new notes).
        if let Some(gates) = gate_buffer {
            if !gates.is_empty() {
                let gate_now = gates[0];
                let was_open = self.last_gate_value > 0.5;
                let is_open = gate_now > 0.5;

                if is_open && !was_open {
                    // New gate edge: start directly at target without interpolation.
                    let len = input.len().min(buffer_size);
                    output[..len].copy_from_slice(&input[..len]);
                    if len > 0 {
                        self.current = input[len - 1];
                    }
                    if len < buffer_size {
                        output[len..buffer_size].fill(self.current);
                    }
                    self.last_gate_value = gates[gates.len().saturating_sub(1)];
                    return;
                }

                self.last_gate_value = gates[gates.len().saturating_sub(1)];
            }
        }

        let len = input.len().min(buffer_size);
        for i in 0..len {
            output[i] = self.next_value(input[i]);
        }
        if len < buffer_size {
            output[len..buffer_size].fill(self.current);
        }
    }

    fn reset(&mut self) {
        self.current = 0.0;
        self.last_gate_value = 0.0;
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
        if !active {
            self.reset();
        }
    }

    fn name(&self) -> &str {
        "Glide"
    }

    fn node_type(&self) -> &str {
        "glide"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glide_zero_time_is_passthrough() {
        let sample_rate = 48_000.0;
        let mut node = Glide::new(sample_rate, 0.0, 0.0);
        let buffer_size = 16;

        let input: Vec<f32> = (0..buffer_size).map(|i| i as f32).collect();

        let mut inputs: FxHashMap<PortId, Vec<ModulationSource>> = FxHashMap::default();
        inputs.insert(
            PortId::AudioInput0,
            vec![ModulationSource {
                buffer: input.clone(),
                amount: 1.0,
                mod_type: ModulationType::Additive,
                transformation: ModulationTransformation::None,
            }],
        );

        let mut out_buf = vec![0.0; buffer_size];
        let mut outputs: FxHashMap<PortId, &mut [f32]> = FxHashMap::default();
        outputs.insert(PortId::AudioOutput0, &mut out_buf[..]);

        node.process(&inputs, &mut outputs, buffer_size);

        assert_eq!(out_buf, input);
    }

    #[test]
    fn glide_smooths_step_input() {
        let sample_rate = 1.0;
        let mut node = Glide::new(sample_rate, 1.0, 1.0);
        let buffer_size = 8;

        let mut input = vec![0.0; buffer_size];
        for i in 4..buffer_size {
            input[i] = 1.0;
        }

        let mut inputs: FxHashMap<PortId, Vec<ModulationSource>> = FxHashMap::default();
        inputs.insert(
            PortId::AudioInput0,
            vec![ModulationSource {
                buffer: input.clone(),
                amount: 1.0,
                mod_type: ModulationType::Additive,
                transformation: ModulationTransformation::None,
            }],
        );

        let mut out_buf = vec![0.0; buffer_size];
        let mut outputs: FxHashMap<PortId, &mut [f32]> = FxHashMap::default();
        outputs.insert(PortId::AudioOutput0, &mut out_buf[..]);

        node.process(&inputs, &mut outputs, buffer_size);

        for i in 0..4 {
            assert!((out_buf[i] - 0.0).abs() < 1e-6);
        }

        assert!(out_buf[4] > 0.0 && out_buf[4] < 1.0);
        assert!(out_buf[5] > out_buf[4]);
        assert!(out_buf[6] > out_buf[5]);
        assert!(out_buf[7] > out_buf[6]);
        assert!(out_buf[7] < 1.0);
    }
}
