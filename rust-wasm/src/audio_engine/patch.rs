use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::nodes::{
    AnalogOscillatorStateUpdate, EnvelopeConfig, FilterSlope, WavetableOscillatorStateUpdate,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct PatchFile {
    pub metadata: PatchMetadata,
    #[serde(rename = "synthState")]
    pub synth_state: SynthState,
    #[serde(rename = "audioAssets", default)]
    pub audio_assets: HashMap<String, AudioAsset>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PatchMetadata {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SynthState {
    pub layout: Layout,
    #[serde(default)]
    pub oscillators: HashMap<String, AnalogOscillatorStateUpdate>,
    #[serde(default, rename = "wavetableOscillators")]
    pub wavetable_oscillators: HashMap<String, WavetableOscillatorStateUpdate>,
    #[serde(default)]
    pub envelopes: HashMap<String, EnvelopeConfig>,
    #[serde(default)]
    pub lfos: HashMap<String, LfoState>,
    #[serde(default)]
    pub filters: HashMap<String, FilterState>,
    #[serde(default)]
    pub samplers: HashMap<String, SamplerState>,
    #[serde(default)]
    pub convolvers: HashMap<String, ConvolverState>,
    #[serde(default)]
    pub delays: HashMap<String, DelayState>,
    #[serde(default)]
    pub choruses: HashMap<String, ChorusState>,
    #[serde(default)]
    pub reverbs: HashMap<String, ReverbState>,
    #[serde(default)]
    pub noise: Option<NoiseState>,
    #[serde(default)]
    pub velocity: Option<VelocityState>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Layout {
    pub voices: Vec<VoiceLayout>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VoiceLayout {
    pub id: usize,
    #[serde(default)]
    pub nodes: HashMap<String, Vec<PatchNode>>,
    #[serde(default)]
    pub connections: Vec<PatchConnection>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PatchNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PatchConnection {
    #[serde(rename = "fromId")]
    pub from_id: String,
    #[serde(rename = "toId")]
    pub to_id: String,
    pub target: u32,
    pub amount: f32,
    #[serde(rename = "modulationType")]
    pub modulation_type: i32,
    #[serde(rename = "modulationTransformation")]
    pub modulation_transform: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LfoState {
    #[serde(rename = "id")]
    pub lfo_id: String,
    pub frequency: f32,
    #[serde(rename = "phaseOffset")]
    pub phase_offset: f32,
    pub waveform: u8,
    #[serde(rename = "useAbsolute")]
    pub use_absolute: bool,
    #[serde(rename = "useNormalized")]
    pub use_normalized: bool,
    #[serde(rename = "triggerMode")]
    pub trigger_mode: u8,
    pub gain: f32,
    pub active: bool,
    #[serde(rename = "loopMode")]
    pub loop_mode: usize,
    #[serde(rename = "loopStart")]
    pub loop_start: f32,
    #[serde(rename = "loopEnd")]
    pub loop_end: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FilterState {
    pub id: String,
    pub cutoff: f32,
    pub resonance: f32,
    #[serde(rename = "keytracking")]
    pub key_tracking: f32,
    #[serde(rename = "comb_frequency")]
    pub comb_frequency: f32,
    #[serde(rename = "comb_dampening")]
    pub comb_dampening: f32,
    pub oversampling: u32,
    pub gain: f32,
    #[serde(rename = "filter_type")]
    pub filter_type: i32,
    #[serde(rename = "filter_slope")]
    pub filter_slope: FilterSlope,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SamplerState {
    pub id: String,
    pub frequency: f32,
    pub gain: f32,
    #[serde(rename = "loopMode")]
    pub loop_mode: u8,
    #[serde(rename = "loopStart")]
    pub loop_start: f32,
    #[serde(rename = "loopEnd")]
    pub loop_end: f32,
    #[serde(rename = "rootNote")]
    pub root_note: f32,
    #[serde(rename = "triggerMode")]
    pub trigger_mode: u8,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ConvolverState {
    pub id: String,
    #[serde(rename = "wetMix")]
    pub wet_mix: f32,
    pub active: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DelayState {
    pub id: String,
    #[serde(rename = "delayMs")]
    pub delay_ms: f32,
    pub feedback: f32,
    #[serde(rename = "wetMix")]
    pub wet_mix: f32,
    pub active: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChorusState {
    pub id: String,
    pub active: bool,
    #[serde(rename = "baseDelayMs")]
    pub base_delay_ms: f32,
    #[serde(rename = "depthMs")]
    pub depth_ms: f32,
    #[serde(rename = "lfoRateHz")]
    pub lfo_rate_hz: f32,
    pub feedback: f32,
    #[serde(rename = "feedback_filter")]
    pub feedback_filter: f32,
    pub mix: f32,
    #[serde(rename = "stereoPhaseOffsetDeg")]
    pub stereo_phase_offset_deg: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReverbState {
    pub id: String,
    pub active: bool,
    #[serde(rename = "room_size")]
    pub room_size: f32,
    pub damp: f32,
    pub wet: f32,
    pub dry: f32,
    pub width: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NoiseState {
    #[serde(rename = "noiseType")]
    pub noise_type: u8,
    pub cutoff: f32,
    pub gain: f32,
    #[serde(rename = "is_enabled")]
    pub is_enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VelocityState {
    pub sensitivity: f32,
    pub randomize: f32,
    pub active: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AudioAsset {
    pub id: String,
    #[serde(rename = "type")]
    pub asset_type: AudioAssetType,
    #[serde(rename = "base64Data")]
    pub base64_data: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AudioAssetType {
    Sample,
    ImpulseResponse,
    Wavetable,
}
