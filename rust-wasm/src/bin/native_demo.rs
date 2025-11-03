#![cfg(feature = "native-host")]

mod composition;

use std::time::Duration;

use anyhow::anyhow;
use composition::Composition;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Sample, SampleFormat, SizedSample, StreamConfig, SupportedBufferSize};
use dasp_sample::FromSample;

const DEFAULT_BLOCK_SIZE: usize = 128;

struct DemoState {
    composition: Composition,
    engine_block_size: usize,
    host_block_size: usize,
    carry_left: Vec<f32>,
    carry_right: Vec<f32>,
    carry_available: usize,
    carry_index: usize,
    call_count: usize,
}

impl DemoState {
    fn new(composition: Composition, engine_block_size: usize, host_block_size: usize) -> Self {
        let engine_block_size = engine_block_size.max(1);
        let host_block_size = host_block_size.max(1);

        Self {
            composition,
            engine_block_size,
            host_block_size,
            carry_left: vec![0.0; engine_block_size],
            carry_right: vec![0.0; engine_block_size],
            carry_available: 0,
            carry_index: 0,
            call_count: 0,
        }
    }
}

unsafe impl Send for DemoState {}

fn choose_buffer_size(supported: SupportedBufferSize) -> (BufferSize, Option<(u32, u32)>, usize) {
    match supported {
        SupportedBufferSize::Range { min, max } => {
            let desired = DEFAULT_BLOCK_SIZE as u32;
            let clamped = desired.clamp(min, max);
            (
                BufferSize::Fixed(clamped),
                Some((min, max)),
                clamped as usize,
            )
        }
        SupportedBufferSize::Unknown => (
            BufferSize::Fixed(DEFAULT_BLOCK_SIZE as u32),
            None,
            DEFAULT_BLOCK_SIZE,
        ),
    }
}

fn main() -> anyhow::Result<()> {
    let (device, config, sample_format, host_label, buffer_range, block_size_hint) =
        select_output_device()?;

    println!("=== AUDIO CONFIGURATION ===");
    let target_frames = block_size_hint as u32;
    if let Some((min, max)) = buffer_range {
        println!("Device buffer size range: {}..={} frames", min, max);
        println!("Target buffer size: {} frames", target_frames);
    } else {
        println!(
            "Device did not report buffer range; requesting {} frames",
            target_frames
        );
    }

    let configured_frames = match config.buffer_size {
        BufferSize::Fixed(actual) => {
            println!("Configured CPAL buffer size: {} frames", actual);
            if actual != target_frames {
                println!(
                    "Adjusted from target {} frames to comply with device limits",
                    target_frames
                );
            }
            actual as usize
        }
        BufferSize::Default => {
            println!("Configured CPAL buffer size: default");
            block_size_hint
        }
    };

    let sample_rate = config.sample_rate.0 as f32;
    let device_name = device
        .name()
        .unwrap_or_else(|_| "Unknown device".to_string());

    println!("Sample rate: {}", sample_rate);
    println!("Channels: {}", config.channels);

    let engine_block_size = configured_frames.max(DEFAULT_BLOCK_SIZE);

    println!("\n=== CREATING COMPOSITION ===");
    let composition =
        Composition::new(sample_rate, engine_block_size).map_err(|e| anyhow!("{}", e))?;

    println!(
        "Composition created with {} tracks:",
        composition.tracks.len()
    );
    for track in &composition.tracks {
        println!("  - {}", track.name);
    }

    let state = DemoState::new(composition, engine_block_size, configured_frames);

    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(device, config, state)?,
        SampleFormat::I16 => build_stream::<i16>(device, config, state)?,
        SampleFormat::U16 => build_stream::<u16>(device, config, state)?,
        other => panic!("unsupported sample format: {other:?}"),
    };

    stream.play()?;

    println!("\n=== NOW PLAYING ===");
    println!(
        "Host: '{}', Device: '{}', Sample Rate: {} Hz",
        host_label, device_name, sample_rate
    );
    println!(
        "Host Block: {}, Engine Block: {}",
        configured_frames, engine_block_size
    );
    println!("\n🎵 Musical composition in A minor");
    println!("   4 tracks: Bass, Pads, Lead, Arpeggio");
    println!("   Press Ctrl+C to stop\n");

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
                    "CPAL buffer: {} samples ({} frames)",
                    data.len(),
                    data.len() / channels
                );
                println!("Channels: {}", channels);
                first_call = false;
            }

            if let Err(err) = process_block(data, channels, &mut state) {
                if !error_reported {
                    eprintln!("Audio callback error: {err}");
                    error_reported = true;
                }
            }
        },
        move |err| {
            eprintln!("Stream error: {err}");
        },
        None,
    )?;

    Ok(stream)
}

fn select_output_device() -> anyhow::Result<(
    cpal::Device,
    StreamConfig,
    SampleFormat,
    String,
    Option<(u32, u32)>,
    usize,
)> {
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
                let (buffer_size, range, block_size) =
                    choose_buffer_size(supported.buffer_size().clone());
                let mut config = supported.config();
                config.buffer_size = buffer_size;
                return Ok((device, config, sample_format, host_name, range, block_size));
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
                    let supported_config = supported.with_max_sample_rate();
                    let (buffer_size, range, block_size) =
                        choose_buffer_size(supported_config.buffer_size().clone());
                    let mut config = supported_config.config();
                    config.buffer_size = buffer_size;
                    return Ok((device, config, sample_format, host_name, range, block_size));
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
    let total_frames = output.len() / channels;

    if state.call_count % 1000 == 0 {
        println!("♪ Processing... (call {})", state.call_count);
    }

    if channels == 0 {
        return Err("no output channels available");
    }

    if output.len() % channels != 0 {
        return Err("output buffer length not divisible by channel count");
    }

    if total_frames == 0 {
        return Ok(());
    }

    state.host_block_size = total_frames;

    let mut frames_written = 0;

    while frames_written < total_frames {
        if state.carry_available == 0 {
            // Generate a fresh block from the composition
            state.carry_left.fill(0.0);
            state.carry_right.fill(0.0);

            state
                .composition
                .process_block(&mut state.carry_left, &mut state.carry_right);

            state.carry_index = 0;
            state.carry_available = state.engine_block_size;

            continue;
        }

        let frames_to_copy = (total_frames - frames_written).min(state.carry_available);

        for i in 0..frames_to_copy {
            let output_pos = (frames_written + i) * channels;
            let carry_pos = state.carry_index + i;

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
        state.carry_index += frames_to_copy;
        state.carry_available -= frames_to_copy;
    }

    Ok(())
}
