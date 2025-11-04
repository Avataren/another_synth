//! CPAL-based audio host for native playback
//!
//! This module handles CPAL-specific functionality: device selection,
//! stream configuration, and sample format conversion.

use crate::audio_buffer::AudioBuffer;
use crate::audio_renderer::AudioRenderer;
use anyhow::Context;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Sample, SampleFormat, SizedSample, StreamConfig, SupportedBufferSize};
use dasp_sample::FromSample;

const DEFAULT_BLOCK_SIZE: usize = 128;

/// Configuration for the audio host
#[derive(Debug, Clone)]
pub struct AudioHostConfig {
    pub sample_rate: f32,
    pub channels: u16,
    pub buffer_size: usize,
    pub device_name: String,
    pub host_name: String,
}

/// Audio host that manages CPAL playback
pub struct AudioHost {
    _stream: cpal::Stream,
    config: AudioHostConfig,
}

impl AudioHost {
    /// Create and start a new audio host with the given renderer factory
    ///
    /// The factory function receives (sample_rate, block_size) and should create
    /// the renderer with those parameters.
    pub fn new<R, F>(factory: F) -> anyhow::Result<Self>
    where
        R: AudioRenderer,
        F: FnOnce(f32, usize) -> R,
    {
        let (device, config, sample_format, host_name, buffer_range, block_size_hint) =
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

        println!("Sample rate: {} Hz", sample_rate);
        println!("Channels: {}", config.channels);

        let engine_block_size = configured_frames.max(DEFAULT_BLOCK_SIZE);

        // Create the renderer with the actual audio parameters
        let renderer = factory(sample_rate, engine_block_size);

        let host_config = AudioHostConfig {
            sample_rate,
            channels: config.channels,
            buffer_size: engine_block_size,
            device_name: device_name.clone(),
            host_name: host_name.clone(),
        };

        let buffer = AudioBuffer::new(renderer, engine_block_size);

        let stream = match sample_format {
            SampleFormat::F32 => build_stream::<f32, R>(device, config, buffer)?,
            SampleFormat::I16 => build_stream::<i16, R>(device, config, buffer)?,
            SampleFormat::U16 => build_stream::<u16, R>(device, config, buffer)?,
            other => anyhow::bail!("unsupported sample format: {:?}", other),
        };

        stream.play().context("failed to start stream")?;

        println!("\n=== NOW PLAYING ===");
        println!(
            "Host: '{}', Device: '{}', Sample Rate: {} Hz",
            host_name, device_name, sample_rate
        );
        println!(
            "Host Block: {}, Engine Block: {}",
            configured_frames, engine_block_size
        );

        Ok(Self {
            _stream: stream,
            config: host_config,
        })
    }

    /// Get the audio configuration
    pub fn config(&self) -> &AudioHostConfig {
        &self.config
    }
}

/// Select an output device and configure it
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
            last_error = Some(anyhow::anyhow!(
                "host {} has no default output device",
                host_name
            ));
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
                last_error = Some(anyhow::anyhow!(
                    "failed to query default output config for host {}: {}",
                    host_name,
                    err
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
                last_error = Some(anyhow::anyhow!(
                    "failed to enumerate output configs for host {}: {}",
                    host_name,
                    err
                ));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("no usable output device found")))
}

/// Choose an appropriate buffer size based on device capabilities
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

/// Build an output stream for the given sample type
fn build_stream<T, R>(
    device: cpal::Device,
    config: StreamConfig,
    mut buffer: AudioBuffer<R>,
) -> anyhow::Result<cpal::Stream>
where
    T: Sample + SizedSample + FromSample<f32>,
    f32: FromSample<T>,
    R: AudioRenderer,
{
    let channels = config.channels as usize;
    let mut error_reported = false;
    let mut first_call = true;

    let stream = device
        .build_output_stream(
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

                if let Err(err) = process_cpal_callback(data, channels, &mut buffer) {
                    if !error_reported {
                        eprintln!("Audio callback error: {}", err);
                        error_reported = true;
                    }
                }
            },
            move |err| {
                eprintln!("Stream error: {}", err);
            },
            None,
        )
        .context("failed to build stream")?;

    Ok(stream)
}

/// Process CPAL callback: get audio from buffer and convert to target sample format
fn process_cpal_callback<T, R>(
    output: &mut [T],
    channels: usize,
    buffer: &mut AudioBuffer<R>,
) -> Result<(), &'static str>
where
    T: Sample + FromSample<f32>,
    f32: FromSample<T>,
    R: AudioRenderer,
{
    buffer.call_count += 1;
    let total_frames = output.len() / channels;

    if buffer.call_count % 1000 == 0 {
        println!("♪ Processing... (call {})", buffer.call_count);
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

    let mut frames_written = 0;

    while frames_written < total_frames {
        if buffer.carry_available == 0 {
            // Generate a fresh block from the renderer
            buffer.carry_left.fill(0.0);
            buffer.carry_right.fill(0.0);

            buffer
                .renderer
                .process_block(&mut buffer.carry_left, &mut buffer.carry_right);

            buffer.carry_index = 0;
            buffer.carry_available = buffer.engine_block_size;

            continue;
        }

        let frames_to_copy = (total_frames - frames_written).min(buffer.carry_available);

        for i in 0..frames_to_copy {
            let output_pos = (frames_written + i) * channels;
            let carry_pos = buffer.carry_index + i;

            for ch in 0..channels {
                let value = match ch {
                    0 => buffer.carry_left[carry_pos],
                    1 => buffer.carry_right[carry_pos],
                    _ => 0.0,
                };
                output[output_pos + ch] = T::from_sample::<f32>(value);
            }
        }

        frames_written += frames_to_copy;
        buffer.carry_index += frames_to_copy;
        buffer.carry_available -= frames_to_copy;
    }

    Ok(())
}
