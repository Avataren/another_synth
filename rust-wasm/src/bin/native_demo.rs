#![cfg(feature = "native-host")]

use std::time::Duration;

use anyhow::anyhow;
use audio_processor::audio_engine::native::AudioEngine;
use audio_processor::automation::AutomationFrame;
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

    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
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

    state.frame.gates_mut().fill(0.0);
    state.frame.frequencies_mut().fill(step.frequency);
    state.frame.velocities_mut().fill(0.0);
    state.frame.gains_mut().fill(1.0);
    state.frame.macro_buffers_mut().fill(0.0);

    state
        .frame
        .set_voice_values(0, 1.0, step.frequency, step.velocity, 1.0);
    state.frame.set_macro_value(0, 0, step.macro_value);
    state
        .frame
        .set_macro_value(0, 1, 1.0 - step.macro_value.clamp(0.0, 1.0));

    state
        .engine
        .process_with_frame(&state.frame, 0.8, &mut state.left, &mut state.right);

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

    state.block_progress += 1;
    if state.block_progress >= state.blocks_per_step {
        state.block_progress = 0;
        state.step = (state.step + 1) % SEQUENCE.len();
    }

    Ok(())
}
