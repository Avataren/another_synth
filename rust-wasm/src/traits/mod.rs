use std::any::Any;
use std::collections::HashMap;
// src/traits/mod.rs
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PortId {
    AudioInput0,
    AudioInput1,
    AudioInput2,
    AudioInput3,
    AudioOutput0,
    AudioOutput1,
    AudioOutput2,
    AudioOutput3,
    Gate,
    GlobalFrequency,
    Frequency,
    FrequencyMod,
    PhaseMod,
    ModIndex,
    CutoffMod,
    ResonanceMod,
    GainMod,
    EnvelopeMod,
    StereoPan,
}

impl PortId {
    pub fn is_audio_input(&self) -> bool {
        matches!(
            self,
            PortId::AudioInput0 | PortId::AudioInput1 | PortId::AudioInput2 | PortId::AudioInput3
        )
    }

    pub fn is_audio_output(&self) -> bool {
        matches!(
            self,
            PortId::AudioOutput0
                | PortId::AudioOutput1
                | PortId::AudioOutput2
                | PortId::AudioOutput3
        )
    }

    pub fn is_modulation_input(&self) -> bool {
        matches!(
            self,
            PortId::FrequencyMod
                | PortId::PhaseMod
                | PortId::GainMod
                | PortId::CutoffMod
                | PortId::ResonanceMod
                | PortId::EnvelopeMod
        )
    }

    pub fn to_input_index(&self) -> Option<usize> {
        match self {
            PortId::AudioInput0 => Some(0),
            PortId::AudioInput1 => Some(1),
            PortId::AudioInput2 => Some(2),
            PortId::AudioInput3 => Some(3),
            _ => None,
        }
    }

    pub fn to_output_index(&self) -> Option<usize> {
        match self {
            PortId::AudioOutput0 => Some(0),
            PortId::AudioOutput1 => Some(1),
            PortId::AudioOutput2 => Some(2),
            PortId::AudioOutput3 => Some(3),
            _ => None,
        }
    }

    pub fn from_input_index(index: usize) -> Option<Self> {
        match index {
            0 => Some(PortId::AudioInput0),
            1 => Some(PortId::AudioInput1),
            2 => Some(PortId::AudioInput2),
            3 => Some(PortId::AudioInput3),
            _ => None,
        }
    }

    pub fn from_output_index(index: usize) -> Option<Self> {
        match index {
            0 => Some(PortId::AudioOutput0),
            1 => Some(PortId::AudioOutput1),
            2 => Some(PortId::AudioOutput2),
            3 => Some(PortId::AudioOutput3),
            _ => None,
        }
    }
}

pub trait AudioNode: Any {
    fn get_ports(&self) -> HashMap<PortId, bool>;

    fn process(
        &mut self,
        inputs: &HashMap<PortId, &[f32]>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    );

    fn reset(&mut self);

    fn as_any_mut(&mut self) -> &mut dyn Any;
    fn as_any(&self) -> &dyn Any;

    // Active state management
    fn is_active(&self) -> bool;
    fn set_active(&mut self, active: bool);

    // Optional method to handle state changes
    fn on_active_changed(&mut self) {}

    // Helper to determine if node should be processed
    fn should_process(&self) -> bool {
        self.is_active()
    }
}
