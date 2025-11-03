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
    carry_left: Vec<f32>,
    carry_right: Vec<f32>,
    carry_available: usize,
    step: usize,
    block_progress: usize,
    blocks_per_step: usize,
    call_count: usize,
}

unsafe impl Send for DemoState {}

fn main() -> anyhow::Result<()> {
    let (device, mut config, sample_format, host_label) = select_output_device()?;

    println!("=== INITIAL CONFIG ===");
    println!("Requested buffer size: Fixed({})", BLOCK_SIZE);
    println!("Config before modification: {:?}", config.buffer_size);

    config.buffer_size = BufferSize::Fixed(BLOCK_SIZE as u32);

    println!("Config after modification: {:?}", config.buffer_size);

    let sample_rate = config.sample_rate.0 as f32;
    let device_name = device
        .name()
        .unwrap_or_else(|_| "Unknown device".to_string());

    println!("Sample rate: {}", sample_rate);
    println!("Channels: {}", config.channels);

    let num_voices = 1;
    let mut engine = AudioEngine::new(sample_rate, num_voices);
    engine.init(sample_rate, num_voices);

    setup_synth_patch(&mut engine)?;

    let frame = AutomationFrame::with_dimensions(num_voices, MACRO_COUNT, MACRO_BUFFER_LEN);

    println!("=== BUFFER ALLOCATION ===");
    println!("Allocating left/right buffers of size: {}", BLOCK_SIZE);

    let state = DemoState {
        engine,
        frame,
        left: vec![0.0; BLOCK_SIZE],
        right: vec![0.0; BLOCK_SIZE],
        carry_left: vec![0.0; BLOCK_SIZE],
        carry_right: vec![0.0; BLOCK_SIZE],
        carry_available: 0,
        step: 0,
        block_progress: 0,
        blocks_per_step: 120,
        call_count: 0,
    };

    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(device, config, state)?,
        SampleFormat::I16 => build_stream::<i16>(device, config, state)?,
        SampleFormat::U16 => build_stream::<u16>(device, config, state)?,
        other => panic!("unsupported sample format: {other:?}"),
    };

    stream.play()?;

    println!("\n=== STREAMING STARTED ===");
    println!(
        "Host: '{}', Device: '{}', Sample Rate: {} Hz, Block Size: {}",
        host_label, device_name, sample_rate, BLOCK_SIZE
    );
    println!("Playing sequence of 4 notes...");
    println!("Watch for buffer size mismatches below...\n");

    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn setup_synth_patch(engine: &mut AudioEngine) -> anyhow::Result<()> {
    println!("Setting up synth patch...");

    let mixer_id = engine
        .create_mixer()
        .map_err(|e| anyhow!("Failed to create mixer: {}", e))?;
    let filter_id = engine
        .create_filter()
        .map_err(|e| anyhow!("Failed to create filter: {}", e))?;

    engine
        .update_filters(
            filter_id,
            2000.0,
            0.3,
            0.0,
            0.0,
            220.0,
            0.5,
            1,
            audio_processor::biquad::FilterType::LowPass,
            audio_processor::nodes::FilterSlope::Db24,
        )
        .map_err(|e| anyhow!("Failed to configure filter: {}", e))?;

    let wt_osc_id = engine
        .create_wavetable_oscillator()
        .map_err(|e| anyhow!("Failed to create wavetable oscillator: {}", e))?;
    let osc_id = engine
        .create_oscillator()
        .map_err(|e| anyhow!("Failed to create oscillator: {}", e))?;
    let envelope_id = engine
        .create_envelope()
        .map_err(|e| anyhow!("Failed to create envelope: {}", e))?;

    engine
        .update_envelope(envelope_id, 0.005, 0.1, 0.7, 0.1, 0.0, 0.0, 0.0, true)
        .map_err(|e| anyhow!("Failed to configure envelope: {}", e))?;

    let _lfo_id = engine
        .create_lfo()
        .map_err(|e| anyhow!("Failed to create LFO: {}", e))?;

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
        .map_err(|e| anyhow!("Failed to connect envelope to mixer: {}", e))?;

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

    engine
        .connect_nodes(
            osc_id,
            PortId::AudioOutput0,
            wt_osc_id,
            PortId::PhaseMod,
            0.02,
            ModulationType::Additive,
            ModulationTransformation::None,
        )
        .map_err(|e| anyhow!("Failed to connect oscillator FM: {}", e))?;

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
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let mut error_reported = false;
    let mut first_call = true;

    let stream = device.build_output_stream(
        &config,
        move |data: &mut [T], _| {
            if first_call {
                println!("\n=== FIRST AUDIO CALLBACK ===");
                println!(
                    "CPAL buffer size: {} samples ({} frames)",
                    data.len(),
                    data.len() / channels
                );
                println!("Channels: {}", channels);
                println!("Our left/right buffer size: {}", state.left.len());
                first_call = false;
            }

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
    f32: FromSample<T>,
{
    state.call_count += 1;

    if state.call_count % 100 == 0 {
        println!("\n=== PROCESS_BLOCK (call {}) ===", state.call_count);
        println!("output buffer: {} samples", output.len());
        println!("channels: {}", channels);
        println!("frames requested: {}", output.len() / channels);
        println!("carry available: {} frames", state.carry_available);
    }

    if channels == 0 {
        return Err("no output channels available");
    }

    if output.len() % channels != 0 {
        return Err("output buffer length not divisible by channel count");
    }

    let total_frames = output.len() / channels;
    let mut frames_written = 0;

    while frames_written < total_frames {
        // First, consume any carried-over samples
        if state.carry_available > 0 {
            let frames_to_copy = (total_frames - frames_written).min(state.carry_available);
            let carry_start = BLOCK_SIZE - state.carry_available;

            for i in 0..frames_to_copy {
                let output_pos = (frames_written + i) * channels;
                let carry_pos = carry_start + i;

                for ch in 0..channels {
                    let value = match ch {
                        0 => state.carry_left[carry_pos],
                        1 => state.carry_right[carry_pos],
                        _ => 0.0,
                    };
                    output[output_pos + ch] = T::from_sample::<f32>(value);
                }
            }

            frames_written += frames_to_copy;
            state.carry_available -= frames_to_copy;

            if frames_written >= total_frames {
                break;
            }
        }

        // Generate a new 128-frame block
        let step = &SEQUENCE[state.step];
        let gate = if state.block_progress < state.blocks_per_step - 2 {
            1.0
        } else {
            0.0
        };

        state
            .frame
            .set_voice_values(0, gate, step.frequency, step.velocity, 1.0);
        state.frame.set_macro_value(0, 0, step.macro_value);
        state
            .frame
            .set_macro_value(0, 1, 1.0 - step.macro_value.clamp(0.0, 1.0));

        state.left.fill(0.0);
        state.right.fill(0.0);

        state
            .engine
            .process_with_frame(&state.frame, 0.5, &mut state.left, &mut state.right);

        // Advance sequence state once per generated block
        state.block_progress += 1;
        if state.block_progress >= state.blocks_per_step {
            state.block_progress = 0;
            state.step = (state.step + 1) % SEQUENCE.len();
        }

        // Copy what we need from this block
        let frames_needed = total_frames - frames_written;
        let frames_to_copy = frames_needed.min(BLOCK_SIZE);

        for i in 0..frames_to_copy {
            let output_pos = (frames_written + i) * channels;

            for ch in 0..channels {
                let value = match ch {
                    0 => state.left[i],
                    1 => state.right[i],
                    _ => 0.0,
                };
                output[output_pos + ch] = T::from_sample::<f32>(value);
            }
        }

        frames_written += frames_to_copy;

        // Store any unused samples for next callback
        if frames_to_copy < BLOCK_SIZE {
            let unused = BLOCK_SIZE - frames_to_copy;
            state.carry_left.copy_from_slice(&state.left);
            state.carry_right.copy_from_slice(&state.right);
            state.carry_available = unused;
        }
    }

    if state.call_count % 100 == 0 {
        let max_val = output
            .iter()
            .map(|s| {
                let f: f32 = s.to_sample();
                f.abs()
            })
            .fold(0.0f32, |max, val| max.max(val));
        println!("Processed {} frames", total_frames);
        println!("Peak output level: {:.4}", max_val);
    }

    Ok(())
}
