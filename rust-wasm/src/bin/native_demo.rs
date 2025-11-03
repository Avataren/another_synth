#![cfg(feature = "native-host")]

use std::time::Duration;

use anyhow::anyhow;
use audio_processor::audio_engine::native::AudioEngine;
use audio_processor::automation::AutomationFrame;
use audio_processor::graph::{ModulationTransformation, ModulationType};
use audio_processor::traits::PortId;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Sample, SampleFormat, SizedSample, StreamConfig};
use dasp_sample::FromSample;
const BLOCK_SIZE: usize = 128;
const MACRO_COUNT: usize = 4;
const MACRO_BUFFER_LEN: usize = 64;
const SEQUENCE: [NoteStep; 4] = [
    NoteStep {
        frequency: 261.63,
        velocity: 0.9,
        macro_value: 0.2,
    },
    NoteStep {
        frequency: 329.63,
        velocity: 0.8,
        macro_value: 0.6,
    },
    NoteStep {
        frequency: 392.0,
        velocity: 0.85,
        macro_value: 0.4,
    },
    NoteStep {
        frequency: 523.25,
        velocity: 0.95,
        macro_value: 0.75,
    },
];

struct NoteStep {
    frequency: f32,
    velocity: f32,
    macro_value: f32,
}

struct DemoState {
    engine: AudioEngine,
    frame: AutomationFrame,
    left: Vec<f32>,
    right: Vec<f32>,
    step: usize,
    block_progress: usize,
    blocks_per_step: usize,
}

unsafe impl Send for DemoState {}

fn main() -> anyhow::Result<()> {
    let (device, mut config, sample_format, host_label) = select_output_device()?;
    config.buffer_size = BufferSize::Fixed(BLOCK_SIZE as u32);

    let sample_rate = config.sample_rate.0 as f32;
    let device_name = device
        .name()
        .unwrap_or_else(|_| "Unknown device".to_string());

    let num_voices = 1;
    let mut engine = AudioEngine::new(sample_rate, num_voices);
    engine.init(sample_rate, num_voices);

    // Create nodes and setup connections (matching web worklet)
    setup_synth_patch(&mut engine)?;

    let frame = AutomationFrame::with_dimensions(num_voices, MACRO_COUNT, MACRO_BUFFER_LEN);

    let state = DemoState {
        engine,
        frame,
        left: vec![0.0; BLOCK_SIZE],
        right: vec![0.0; BLOCK_SIZE],
        step: 0,
        block_progress: 0,
        blocks_per_step: 6,
    };

    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(device, config, state)?,
        SampleFormat::I16 => build_stream::<i16>(device, config, state)?,
        SampleFormat::U16 => build_stream::<u16>(device, config, state)?,
        other => panic!("unsupported sample format: {other:?}"),
    };

    stream.play()?;

    println!(
        "Streaming audio on host '{host_label}' using '{device_name}' at {sample_rate} Hz with block size {BLOCK_SIZE}."
    );
    println!("Playing sequence of 4 notes...");

    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// Setup a basic synth patch matching the web worklet initialization
fn setup_synth_patch(engine: &mut AudioEngine) -> anyhow::Result<()> {
    println!("Setting up synth patch...");

    // Create mixer (output node)
    let mixer_id = engine
        .create_mixer()
        .map_err(|e| anyhow!("Failed to create mixer: {}", e))?;
    println!("Created mixer: {}", mixer_id);

    // Create filter
    let filter_id = engine
        .create_filter()
        .map_err(|e| anyhow!("Failed to create filter: {}", e))?;
    println!("Created filter: {}", filter_id);

    // Create oscillators
    let wt_osc_id = engine
        .create_wavetable_oscillator()
        .map_err(|e| anyhow!("Failed to create wavetable oscillator: {}", e))?;
    println!("Created wavetable oscillator: {}", wt_osc_id);

    let osc_id = engine
        .create_oscillator()
        .map_err(|e| anyhow!("Failed to create oscillator: {}", e))?;
    println!("Created oscillator: {}", osc_id);

    // Create envelope
    let envelope_id = engine
        .create_envelope()
        .map_err(|e| anyhow!("Failed to create envelope: {}", e))?;
    println!("Created envelope: {}", envelope_id);

    // Create LFO (optional)
    let _lfo_id = engine
        .create_lfo()
        .map_err(|e| anyhow!("Failed to create LFO: {}", e))?;
    println!("Created LFO: {}", _lfo_id);

    // Connect filter to mixer's audio input
    engine
        .connect_nodes(
            filter_id,
            PortId::AudioOutput0,
            mixer_id,
            PortId::AudioInput0,
            1.0,
            ModulationType::Additive,
            ModulationTransformation::None,
        )
        .map_err(|e| anyhow!("Failed to connect filter to mixer: {}", e))?;
    println!("Connected filter -> mixer");

    // Connect envelope to mixer's gain input
    engine
        .connect_nodes(
            envelope_id,
            PortId::AudioOutput0,
            mixer_id,
            PortId::GainMod,
            1.0,
            ModulationType::VCA,
            ModulationTransformation::None,
        )
        .map_err(|e| anyhow!("Failed to connect envelope to mixer gain: {}", e))?;
    println!("Connected envelope -> mixer gain");

    // Connect wavetable oscillator to filter
    engine
        .connect_nodes(
            wt_osc_id,
            PortId::AudioOutput0,
            filter_id,
            PortId::AudioInput0,
            1.0,
            ModulationType::Additive,
            ModulationTransformation::None,
        )
        .map_err(|e| anyhow!("Failed to connect oscillator to filter: {}", e))?;
    println!("Connected oscillator -> filter");

    // Connect analog oscillator to wavetable oscillator's phase mod (FM)
    engine
        .connect_nodes(
            osc_id,
            PortId::AudioOutput0,
            wt_osc_id,
            PortId::PhaseMod,
            1.0,
            ModulationType::Additive,
            ModulationTransformation::None,
        )
        .map_err(|e| anyhow!("Failed to connect oscillator FM: {}", e))?;
    println!("Connected analog osc -> wavetable osc phase mod");

    println!("Synth patch setup complete!");
    Ok(())
}

fn build_stream<T>(
    device: cpal::Device,
    config: StreamConfig,
    mut state: DemoState,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: Sample + SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    let mut error_reported = false;

    let stream = device.build_output_stream(
        &config,
        move |data: &mut [T], _| {
            if let Err(err) = process_block(data, channels, &mut state) {
                if !error_reported {
                    eprintln!("audio callback error: {err}");
                    error_reported = true;
                }
            }
        },
        move |err| {
            eprintln!("stream error: {err}");
        },
        None,
    )?;

    Ok(stream)
}

fn select_output_device() -> anyhow::Result<(cpal::Device, StreamConfig, SampleFormat, String)> {
    let mut last_error: Option<anyhow::Error> = None;

    for host_id in cpal::available_hosts() {
        let host = cpal::host_from_id(host_id)?;
        let host_name = host_id.name().to_string();

        let Some(device) = host.default_output_device() else {
            last_error = Some(anyhow!("host {host_name} has no default output device"));
            continue;
        };

        match device.default_output_config() {
            Ok(supported) => {
                let sample_format = supported.sample_format();
                let config = supported.config();
                return Ok((device, config, sample_format, host_name));
            }
            Err(err) => {
                last_error = Some(anyhow!(
                    "failed to query default output config for host {host_name}: {err}"
                ));
            }
        }

        match device.supported_output_configs() {
            Ok(mut configs) => {
                if let Some(supported) = configs.next() {
                    let sample_format = supported.sample_format();
                    let config = supported.with_max_sample_rate().config();
                    return Ok((device, config, sample_format, host_name));
                }
            }
            Err(err) => {
                last_error = Some(anyhow!(
                    "failed to enumerate output configs for host {host_name}: {err}"
                ));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow!("no usable output device found")))
}

fn process_block<T>(
    output: &mut [T],
    channels: usize,
    state: &mut DemoState,
) -> Result<(), &'static str>
where
    T: Sample + FromSample<f32>,
{
    if channels == 0 {
        return Err("no output channels available");
    }

    if output.len() % channels != 0 {
        return Err("output buffer length not divisible by channel count");
    }

    let step = &SEQUENCE[state.step];

    // Set voice parameters
    state
        .frame
        .set_voice_values(0, 1.0, step.frequency, step.velocity, 1.0);
    state.frame.set_macro_value(0, 0, step.macro_value);
    state
        .frame
        .set_macro_value(0, 1, 1.0 - step.macro_value.clamp(0.0, 1.0));

    // Process audio
    state
        .engine
        .process_with_frame(&state.frame, 0.8, &mut state.left, &mut state.right);

    // Interleave output
    for (frame_index, sample_chunk) in output.chunks_mut(channels).enumerate() {
        let left_sample = state.left.get(frame_index).copied().unwrap_or(0.0);
        let right_sample = state.right.get(frame_index).copied().unwrap_or(left_sample);

        for (channel_index, slot) in sample_chunk.iter_mut().enumerate() {
            let value = match channel_index {
                0 => left_sample,
                1 => right_sample,
                _ => 0.0,
            };
            *slot = T::from_sample::<f32>(value);
        }
    }

    // Advance sequence
    state.block_progress += 1;
    if state.block_progress >= state.blocks_per_step {
        state.block_progress = 0;
        state.step = (state.step + 1) % SEQUENCE.len();
    }

    Ok(())
}
