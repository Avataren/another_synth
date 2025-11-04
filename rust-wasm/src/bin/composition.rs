use audio_processor::audio_engine::native::AudioEngine;
use audio_processor::automation::AutomationFrame;
use audio_processor::biquad::FilterType;
use audio_processor::graph::{ModulationTransformation, ModulationType};
use audio_processor::nodes::{
    AnalogOscillatorStateUpdate, FilterSlope, Waveform, WavetableOscillatorStateUpdate,
};
use audio_processor::traits::PortId;
use rayon::prelude::*;

const MACRO_COUNT: usize = 4;
const MACRO_BUFFER_LEN: usize = 128;
const REFERENCE_SAMPLE_RATE: f32 = 48_000.0;
const REFERENCE_BLOCK_SIZE: usize = 512;

/// Represents a single note in a sequence
#[derive(Debug, Clone, Copy)]
pub struct Note {
    pub frequency: f32,
    pub velocity: f32,
    pub duration_blocks: usize, // How many reference blocks (512 @ 48kHz) this note lasts
}

impl Note {
    pub fn new(midi_note: u8, velocity: f32, duration_blocks: usize) -> Self {
        let frequency = 440.0 * 2f32.powf((midi_note as f32 - 69.0) / 12.0);
        Self {
            frequency,
            velocity,
            duration_blocks,
        }
    }

    pub fn rest(duration_blocks: usize) -> Self {
        Self {
            frequency: 0.0,
            velocity: 0.0,
            duration_blocks,
        }
    }
}

/// Timing configuration used to scale note durations
struct TimingConfig {
    sample_rate: f32,
    block_size: usize,
}

impl TimingConfig {
    fn new(sample_rate: f32, block_size: usize) -> Self {
        Self {
            sample_rate: sample_rate.max(1.0),
            block_size: block_size.max(1),
        }
    }

    fn block_size(&self) -> usize {
        self.block_size
    }

    fn note_duration_samples(&self, reference_blocks: usize) -> usize {
        // Duration of one reference block (ENGINE_BLOCK_SIZE at REFERENCE_SAMPLE_RATE)
        let reference_block_duration = REFERENCE_BLOCK_SIZE as f32 / REFERENCE_SAMPLE_RATE;
        let duration_seconds = reference_blocks as f32 * reference_block_duration;
        let samples = (duration_seconds * self.sample_rate).round() as usize;
        samples.max(1)
    }
}

struct SequenceNote {
    frequency: f32,
    velocity: f32,
    duration_samples: usize,
}

/// A sequence of notes with timing information
pub struct NoteSequence {
    notes: Vec<SequenceNote>,
    current_index: usize,
    samples_into_current_note: usize,
    block_size: usize,
}

impl NoteSequence {
    pub fn new(notes: Vec<Note>, timing: &TimingConfig) -> Self {
        let converted_notes = notes
            .into_iter()
            .map(|note| SequenceNote {
                frequency: note.frequency,
                velocity: note.velocity,
                duration_samples: timing.note_duration_samples(note.duration_blocks),
            })
            .collect();

        Self {
            notes: converted_notes,
            current_index: 0,
            samples_into_current_note: 0,
            block_size: timing.block_size(),
        }
    }

    pub fn advance(&mut self) -> (f32, f32) {
        if self.notes.is_empty() {
            return (0.0, 0.0);
        }

        let current_note = &self.notes[self.current_index];
        let remaining_samples = current_note
            .duration_samples
            .saturating_sub(self.samples_into_current_note);

        // Gate stays on while we have more than one block of audio left
        let gate = if current_note.frequency > 0.0 && remaining_samples > self.block_size {
            1.0
        } else {
            0.0
        };

        let frequency = current_note.frequency;

        self.samples_into_current_note = self
            .samples_into_current_note
            .saturating_add(self.block_size);

        if self.samples_into_current_note >= current_note.duration_samples {
            self.samples_into_current_note = 0;
            self.current_index = (self.current_index + 1) % self.notes.len();
        }

        (gate, frequency)
    }
}

/// A single track with its own synth engine and sequence
pub struct Track {
    pub name: String,
    pub engine: AudioEngine,
    pub frame: AutomationFrame,
    pub sequence: NoteSequence,
    pub gain: f32,
    left_buffer: Vec<f32>,
    right_buffer: Vec<f32>,
}

impl Track {
    pub fn new(
        name: String,
        engine: AudioEngine,
        sequence: NoteSequence,
        gain: f32,
        block_size: usize,
    ) -> Self {
        let frame = AutomationFrame::with_dimensions(1, MACRO_COUNT, MACRO_BUFFER_LEN);
        Self {
            name,
            engine,
            frame,
            sequence,
            gain,
            left_buffer: vec![0.0; block_size],
            right_buffer: vec![0.0; block_size],
        }
    }

    pub fn process_block(&mut self) {
        let (gate, frequency) = self.sequence.advance();

        self.frame.set_voice_values(0, gate, frequency, 0.8, 1.0);

        self.left_buffer.fill(0.0);
        self.right_buffer.fill(0.0);

        self.engine.process_with_frame(
            &self.frame,
            self.gain,
            &mut self.left_buffer,
            &mut self.right_buffer,
        );
    }

    pub fn get_output(&self) -> (&[f32], &[f32]) {
        (&self.left_buffer, &self.right_buffer)
    }
}

unsafe impl Send for Track {}

/// Main composition with multiple tracks
pub struct Composition {
    pub tracks: Vec<Track>,
    pub master_gain: f32,
}

impl Composition {
    pub fn new(sample_rate: f32, block_size: usize) -> Result<Self, String> {
        let timing = TimingConfig::new(sample_rate, block_size);
        let mut tracks = Vec::new();

        // BASS TRACK - Deep, punchy bass
        let bass_sequence = create_bass_sequence(&timing);
        let bass_engine = create_bass_synth(sample_rate, timing.block_size())?;
        tracks.push(Track::new(
            "Bass".to_string(),
            bass_engine,
            bass_sequence,
            0.5,
            timing.block_size(),
        ));

        // PAD TRACK - Atmospheric chords
        let pad_sequence = create_pad_sequence(&timing);
        let pad_engine = create_pad_synth(sample_rate, timing.block_size())?;
        tracks.push(Track::new(
            "Pad".to_string(),
            pad_engine,
            pad_sequence,
            0.35,
            timing.block_size(),
        ));

        // LEAD TRACK - Melodic lead
        let lead_sequence = create_lead_sequence(&timing);
        let lead_engine = create_lead_synth(sample_rate, timing.block_size())?;
        tracks.push(Track::new(
            "Lead".to_string(),
            lead_engine,
            lead_sequence,
            0.5,
            timing.block_size(),
        ));

        // ARPEGGIO TRACK - Rhythmic texture
        let arp_sequence = create_arp_sequence(&timing);
        let arp_engine = create_arp_synth(sample_rate, timing.block_size())?;
        tracks.push(Track::new(
            "Arp".to_string(),
            arp_engine,
            arp_sequence,
            0.3, // Resonance
            timing.block_size(),
        ));

        Ok(Self {
            tracks,
            master_gain: 0.4,
        })
    }

    pub fn process_block(&mut self, output_left: &mut [f32], output_right: &mut [f32]) {
        output_left.fill(0.0);
        output_right.fill(0.0);

        self.tracks.par_iter_mut().for_each(|track| {
            track.process_block();
        });

        for track in &self.tracks {
            let (left, right) = track.get_output();

            for (i, (out_l, out_r)) in output_left
                .iter_mut()
                .zip(output_right.iter_mut())
                .enumerate()
            {
                if i < left.len() {
                    *out_l += left[i] * self.master_gain;
                    *out_r += right[i] * self.master_gain;
                }
            }
        }
    }
}

// ============================================================================
// SYNTH PATCH CREATORS
// ============================================================================

fn create_bass_synth(sample_rate: f32, block_size: usize) -> Result<AudioEngine, String> {
    let mut engine = AudioEngine::new_with_block_size(sample_rate, 1, block_size);
    engine.init(sample_rate, 1);

    // Create nodes - Note: these return usize directly in native builds
    let mixer_id = engine.create_mixer()?;
    let filter_id = engine.create_filter()?;
    let osc1_id = engine.create_oscillator()?;
    let osc2_id = engine.create_oscillator()?;
    let env_id = engine.create_envelope()?;
    let mod_env_id = engine.create_envelope()?;

    println!(
        "🎸 Bass synth nodes - Mixer: {}, Filter: {}, Osc1: {}, Osc2: {}, Env: {}, Mod Env: {}",
        mixer_id, filter_id, osc1_id, osc2_id, env_id, mod_env_id
    );

    // Configure envelope - punchy attack, moderate release
    engine.update_envelope(env_id, 0.001, 0.05, 0.2, 0.2, 1.0, 1.0, 1.0, true)?;
    // Modulation envelope: slower ramp then settles low for continued movement
    engine.update_envelope(mod_env_id, 0.05, 0.7, 0.5, 0.2, 1.0, -2.3, 1.0, true)?;

    // Lower oscillator 2 by two octaves to act as the modulator
    engine.update_oscillator(
        osc2_id,
        &AnalogOscillatorStateUpdate {
            phase_mod_amount: 0.0,
            detune: -2400.0,
            hard_sync: false,
            gain: 1.0,
            active: true,
            feedback_amount: 0.0,
            waveform: Waveform::Sine,
            unison_voices: 1,
            spread: 10.0,
        },
    )?;

    // Configure filter - OPEN IT UP for more bass presence
    engine.update_filters(
        filter_id,
        500.0, // Higher cutoff
        0.4,   // Less resonance
        1.0,
        0.0,
        220.0,
        0.5,
        1, // gain=1.0 is critical!
        FilterType::LowPass,
        FilterSlope::Db24,
    )?;

    // Oscillator 2 drives phase modulation on oscillator 1
    engine.connect_nodes(
        osc2_id,
        PortId::AudioOutput0,
        osc1_id,
        PortId::PhaseMod,
        1.0,
        ModulationType::Additive,
        ModulationTransformation::None,
    )?;

    // Mod envelope shapes oscillator 1's modulation index
    engine.connect_nodes(
        mod_env_id,
        PortId::AudioOutput0,
        osc1_id,
        PortId::ModIndex,
        20.0,
        ModulationType::Additive,
        ModulationTransformation::None,
    )?;

    // Connect carrier oscillator into filter
    engine.connect_nodes(
        osc1_id,
        PortId::AudioOutput0,
        filter_id,
        PortId::AudioInput0,
        0.9, // Higher - was 0.7
        ModulationType::Additive,
        ModulationTransformation::None,
    )?;

    // Connect filter to mixer
    engine.connect_nodes(
        filter_id,
        PortId::AudioOutput0,
        mixer_id,
        PortId::AudioInput0,
        1.0,
        ModulationType::Additive,
        ModulationTransformation::None,
    )?;

    // Envelope controls mixer gain
    engine.connect_nodes(
        env_id,
        PortId::AudioOutput0,
        mixer_id,
        PortId::GainMod,
        1.0,
        ModulationType::VCA,
        ModulationTransformation::None,
    )?;

    engine.connect_nodes(
        filter_id,
        PortId::AudioOutput0,
        mixer_id,
        PortId::AudioInput0,
        1.0,
        ModulationType::Additive,
        ModulationTransformation::None,
    )?;

    Ok(engine)
}

fn create_pad_synth(sample_rate: f32, block_size: usize) -> Result<AudioEngine, String> {
    let mut engine = AudioEngine::new_with_block_size(sample_rate, 1, block_size);
    engine.init(sample_rate, 1);

    let mixer_id = engine.create_mixer()?;
    let filter_id = engine.create_filter()?;
    let osc1_id = engine.create_wavetable_oscillator()?;
    let osc2_id = engine.create_wavetable_oscillator()?;
    let osc3_id = engine.create_wavetable_oscillator()?;
    let env_id = engine.create_envelope()?;

    // Slow, evolving envelope for pads
    engine.update_envelope(env_id, 0.3, 0.5, 0.7, 1.5, 0.0, 0.0, 0.0, true)?;

    // Warm filter
    engine.update_filters(
        filter_id,
        2500.0, // Cutoff
        0.3,    // Resonance
        1.0,
        0.0,
        220.0,
        0.5,
        1, // gain=1.0 is critical!
        FilterType::LowPass,
        FilterSlope::Db12,
    )?;

    // Three oscillators for richness
    engine.connect_nodes(
        osc1_id,
        PortId::AudioOutput0,
        filter_id,
        PortId::AudioInput0,
        0.4,
        ModulationType::Additive,
        ModulationTransformation::None,
    )?;

    engine.connect_nodes(
        osc2_id,
        PortId::AudioOutput0,
        filter_id,
        PortId::AudioInput0,
        0.4,
        ModulationType::Additive,
        ModulationTransformation::None,
    )?;

    engine.connect_nodes(
        osc3_id,
        PortId::AudioOutput0,
        filter_id,
        PortId::AudioInput0,
        0.4,
        ModulationType::Additive,
        ModulationTransformation::None,
    )?;

    // Filter to mixer
    engine.connect_nodes(
        filter_id,
        PortId::AudioOutput0,
        mixer_id,
        PortId::AudioInput0,
        1.0,
        ModulationType::Additive,
        ModulationTransformation::None,
    )?;

    // Envelope on mixer
    engine.connect_nodes(
        env_id,
        PortId::AudioOutput0,
        mixer_id,
        PortId::GainMod,
        1.0,
        ModulationType::VCA,
        ModulationTransformation::None,
    )?;

    Ok(engine)
}

fn create_lead_synth(sample_rate: f32, block_size: usize) -> Result<AudioEngine, String> {
    let mut engine = AudioEngine::new_with_block_size(sample_rate, 1, block_size);
    engine.init(sample_rate, 1);

    let mixer_id = engine.create_mixer()?;
    let filter_id = engine.create_filter()?;
    let osc_id = engine.create_wavetable_oscillator()?;
    let mod_osc_id = engine.create_oscillator()?;
    let env_id = engine.create_envelope()?;
    let filter_env_id = engine.create_envelope()?;

    engine.update_wavetable_oscillator(
        osc_id,
        &WavetableOscillatorStateUpdate {
            phase_mod_amount: 0.0,
            detune: 0.0,
            hard_sync: false,
            gain: 1.0,
            active: true,
            feedback_amount: 0.0,
            unison_voices: 1,
            spread: 0.0,
            wavetable_index: 2.0, // Saw slot in default bank
        },
    )?;

    engine.update_oscillator(
        mod_osc_id,
        &AnalogOscillatorStateUpdate {
            phase_mod_amount: 0.0,
            detune: 0.0,
            hard_sync: false,
            gain: 1.0,
            active: true,
            feedback_amount: 0.0,
            waveform: Waveform::Saw,
            unison_voices: 1,
            spread: 10.0,
        },
    )?;

    engine.set_chorus_active(true);
    engine.set_delay_active(true);
    engine.set_reverb_active(true);

    // Plucky envelope
    engine.update_envelope(env_id, 0.005, 0.1, 0.5, 0.3, 0.0, 0.0, 0.0, true)?;

    // Filter envelope
    engine.update_envelope(filter_env_id, 0.01, 0.2, 0.3, 0.2, 0.0, 0.0, 0.0, true)?;

    // Bright filter that's modulated
    engine.update_filters(
        filter_id,
        3500.0,
        0.5,
        1.0,
        0.0,
        220.0,
        0.5,
        1, // gain=1.0 is critical!
        FilterType::LowPass,
        FilterSlope::Db24,
    )?;

    // FM modulation for brightness
    engine.connect_nodes(
        mod_osc_id,
        PortId::AudioOutput0,
        osc_id,
        PortId::PhaseMod,
        0.5,
        ModulationType::Additive,
        ModulationTransformation::None,
    )?;

    // Oscillator to filter
    engine.connect_nodes(
        osc_id,
        PortId::AudioOutput0,
        filter_id,
        PortId::AudioInput0,
        1.0,
        ModulationType::Additive,
        ModulationTransformation::None,
    )?;

    // Filter to mixer
    engine.connect_nodes(
        filter_id,
        PortId::AudioOutput0,
        mixer_id,
        PortId::AudioInput0,
        1.0,
        ModulationType::Additive,
        ModulationTransformation::None,
    )?;

    // Amplitude envelope
    engine.connect_nodes(
        env_id,
        PortId::AudioOutput0,
        mixer_id,
        PortId::GainMod,
        1.0,
        ModulationType::VCA,
        ModulationTransformation::None,
    )?;

    // Filter envelope to cutoff
    engine.connect_nodes(
        filter_env_id,
        PortId::AudioOutput0,
        filter_id,
        PortId::CutoffMod,
        0.6,
        ModulationType::VCA,
        ModulationTransformation::None,
    )?;

    Ok(engine)
}

fn create_arp_synth(sample_rate: f32, block_size: usize) -> Result<AudioEngine, String> {
    let mut engine = AudioEngine::new_with_block_size(sample_rate, 1, block_size);
    engine.init(sample_rate, 1);

    let mixer_id = engine.create_mixer()?;
    let filter_id = engine.create_filter()?;
    let osc_id = engine.create_oscillator()?;
    let env_id = engine.create_envelope()?;

    // Short, percussive envelope
    engine.update_envelope(env_id, 0.001, 0.02, 0.0, 0.05, 0.0, 0.0, 0.0, true)?;

    // Bright filter
    engine.update_filters(
        filter_id,
        4000.0,
        0.4,
        1.0,
        0.0,
        220.0,
        0.5,
        1, // gain=1.0 is critical!
        FilterType::LowPass,
        FilterSlope::Db12,
    )?;

    engine.connect_nodes(
        osc_id,
        PortId::AudioOutput0,
        filter_id,
        PortId::AudioInput0,
        1.0,
        ModulationType::Additive,
        ModulationTransformation::None,
    )?;

    engine.connect_nodes(
        filter_id,
        PortId::AudioOutput0,
        mixer_id,
        PortId::AudioInput0,
        1.0,
        ModulationType::Additive,
        ModulationTransformation::None,
    )?;

    engine.connect_nodes(
        env_id,
        PortId::AudioOutput0,
        mixer_id,
        PortId::GainMod,
        1.0,
        ModulationType::VCA,
        ModulationTransformation::None,
    )?;

    Ok(engine)
}

// ============================================================================
// NOTE SEQUENCES
// ============================================================================

fn create_bass_sequence(timing: &TimingConfig) -> NoteSequence {
    // Key: A minor
    // Bassline: A - C - D - E pattern
    let notes = vec![
        Note::new(57 - 12, 0.9, 32),  // A3 (was A2) - doubled duration
        Note::new(57, 0.85, 32),      // A3
        Note::new(60 - 12, 0.88, 32), // C4 (was C3)
        Note::new(60, 0.85, 32),      // C4
        Note::new(62 - 12, 0.87, 32), // D4 (was D3)
        Note::new(62, 0.84, 32),      // D4
        Note::new(64 - 12, 0.89, 32), // E4 (was E3)
        Note::new(64, 0.86, 16),      // E4
        Note::new(62 - 12, 0.87, 16), // D4 (passing)
    ];
    NoteSequence::new(notes, timing)
}

fn create_pad_sequence(timing: &TimingConfig) -> NoteSequence {
    // Long, sustained chords in A minor
    let notes = vec![
        Note::new(57, 0.6, 128), // A3 (Am chord root) - doubled duration
        Note::new(60, 0.6, 128), // C4 (Am to C progression)
        Note::new(62, 0.6, 128), // D4
        Note::new(64, 0.6, 128), // E4
    ];
    NoteSequence::new(notes, timing)
}

fn create_lead_sequence(timing: &TimingConfig) -> NoteSequence {
    // Melodic phrase in A minor
    let notes = vec![
        Note::rest(64),          // Start with silence - doubled
        Note::new(69, 0.8, 16),  // A4 - doubled duration
        Note::new(72, 0.82, 16), // C5
        Note::new(76, 0.85, 24), // E5
        Note::new(74, 0.8, 8),   // D5
        Note::new(72, 0.82, 32), // C5
        Note::rest(16),
        Note::new(69, 0.8, 16),  // A4
        Note::new(67, 0.78, 16), // G4
        Note::new(69, 0.85, 48), // A4
        Note::rest(32),
        Note::new(72, 0.8, 16),  // C5
        Note::new(74, 0.82, 16), // D5
        Note::new(76, 0.85, 32), // E5
        Note::new(77, 0.83, 32), // F5
        Note::new(76, 0.8, 48),  // E5
    ];
    NoteSequence::new(notes, timing)
}

fn create_arp_sequence(timing: &TimingConfig) -> NoteSequence {
    // Fast arpeggios
    let notes = vec![
        Note::new(69, 0.5, 8), // A4 - doubled duration
        Note::new(72, 0.5, 8), // C5
        Note::new(76, 0.5, 8), // E5
        Note::new(72, 0.5, 8), // C5
        Note::new(69, 0.5, 8), // A4
        Note::new(72, 0.5, 8), // C5
        Note::new(76, 0.5, 8), // E5
        Note::new(81, 0.5, 8), // A5
        // Variation
        Note::new(72, 0.5, 8), // C5
        Note::new(76, 0.5, 8), // E5
        Note::new(79, 0.5, 8), // G5
        Note::new(76, 0.5, 8), // E5
        Note::new(72, 0.5, 8), // C5
        Note::new(76, 0.5, 8), // E5
        Note::new(79, 0.5, 8), // G5
        Note::new(84, 0.5, 8), // C6
    ];
    NoteSequence::new(notes, timing)
}
