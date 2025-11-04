//! CPAL-based audio host for native playback
//!
//! This module handles CPAL-specific functionality: device selection,
//! stream configuration, and sample format conversion.

use crate::audio_buffer::AudioBuffer;
use crate::audio_renderer::AudioRenderer;
use anyhow::Context;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    BufferSize, HostId, Sample, SampleFormat, SizedSample, StreamConfig, SupportedBufferSize,
};
use dasp_sample::FromSample;

// Audio configuration constants
// Note: CPAL buffer sizes (host block) affect latency
// Engine block size affects how often the audio engine is called
// Playback speed is determined solely by sample rate
const JACK_HOST_BUFFER: usize = 128; // JACK CPAL callback size
const ALSA_HOST_BUFFER: usize = 256; // ALSA CPAL callback size
const DEFAULT_HOST_BUFFER: usize = 256;

// Engine block size - keep same for all hosts unless overridden
const ENGINE_BLOCK_SIZE: usize = 128;
const TARGET_CHANNELS: u16 = 2;

// Preferred sample rate for consistent playback speed across all hosts
const PREFERRED_SAMPLE_RATE: u32 = 48000;

/// Information about an available audio host
#[derive(Debug, Clone)]
pub struct HostInfo {
    pub id: HostId,
    pub name: String,
    pub has_default_device: bool,
}

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

/// Configuration options for audio host creation
#[derive(Debug, Clone)]
pub struct AudioHostOptions {
    pub preferred_host: Option<String>,
    pub buffer_size: Option<usize>,
}

impl Default for AudioHostOptions {
    fn default() -> Self {
        Self {
            preferred_host: None,
            buffer_size: None,
        }
    }
}

impl AudioHost {
    /// List all available audio hosts on the system
    pub fn list_hosts() -> Vec<HostInfo> {
        let mut hosts = Vec::new();

        for host_id in cpal::available_hosts() {
            if let Ok(host) = cpal::host_from_id(host_id) {
                let has_default_device = host.default_output_device().is_some();
                hosts.push(HostInfo {
                    id: host_id,
                    name: host_id.name().to_string(),
                    has_default_device,
                });
            }
        }

        hosts
    }

    /// Create and start a new audio host with the given renderer factory
    ///
    /// The factory function receives (sample_rate, block_size) and should create
    /// the renderer with those parameters.
    pub fn new<R, F>(factory: F) -> anyhow::Result<Self>
    where
        R: AudioRenderer,
        F: FnOnce(f32, usize) -> R,
    {
        Self::with_options(factory, AudioHostOptions::default())
    }

    /// Create and start a new audio host with a preferred host selection
    ///
    /// The factory function receives (sample_rate, block_size) and should create
    /// the renderer with those parameters.
    ///
    /// If `preferred_host` is provided, it will try to use that host first before
    /// falling back to other available hosts.
    pub fn with_host_preference<R, F>(
        factory: F,
        preferred_host: Option<&str>,
    ) -> anyhow::Result<Self>
    where
        R: AudioRenderer,
        F: FnOnce(f32, usize) -> R,
    {
        let options = AudioHostOptions {
            preferred_host: preferred_host.map(String::from),
            buffer_size: None,
        };
        Self::with_options(factory, options)
    }

    /// Create and start a new audio host with full configuration options
    ///
    /// The factory function receives (sample_rate, block_size) and should create
    /// the renderer with those parameters.
    pub fn with_options<R, F>(factory: F, options: AudioHostOptions) -> anyhow::Result<Self>
    where
        R: AudioRenderer,
        F: FnOnce(f32, usize) -> R,
    {
        let (device, config, sample_format, host_name, buffer_range, block_size_hint) =
            select_output_device(options.preferred_host.as_deref(), options.buffer_size)?;

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

        // Use a fixed engine block size for consistent musical timing across hosts
        let engine_block_size = options.buffer_size.unwrap_or(ENGINE_BLOCK_SIZE).max(1);
        if engine_block_size != block_size_hint {
            println!(
                "Engine block size fixed at {} frames (host target: {})",
                engine_block_size, block_size_hint
            );
        }

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
fn select_output_device(
    preferred_host: Option<&str>,
    custom_buffer_size: Option<usize>,
) -> anyhow::Result<(
    cpal::Device,
    StreamConfig,
    SampleFormat,
    String,
    Option<(u32, u32)>,
    usize,
)> {
    let mut last_error: Option<anyhow::Error> = None;
    let available_hosts = cpal::available_hosts();

    // Print available hosts
    println!("=== AVAILABLE AUDIO HOSTS ===");
    for host_id in &available_hosts {
        let host_name = host_id.name();
        let marker = if Some(host_name) == preferred_host {
            " (preferred)"
        } else {
            ""
        };
        println!("  - {}{}", host_name, marker);
    }
    println!();

    // Build host priority list: preferred first, then others
    let mut host_priority = Vec::new();
    if let Some(preferred) = preferred_host {
        if let Some(&host_id) = available_hosts.iter().find(|&h| h.name() == preferred) {
            host_priority.push(host_id);
        }
    }
    for host_id in available_hosts {
        if !host_priority.contains(&host_id) {
            host_priority.push(host_id);
        }
    }

    for host_id in host_priority {
        let host = cpal::host_from_id(host_id)?;
        let host_name = host_id.name().to_string();

        let Some(device) = host.default_output_device() else {
            last_error = Some(anyhow::anyhow!(
                "host {} has no default output device",
                host_name
            ));
            continue;
        };

        // Enumerate supported configs once so we can prefer stereo output
        let supported_configs = match device.supported_output_configs() {
            Ok(configs) => configs.collect::<Vec<_>>(),
            Err(err) => {
                last_error = Some(anyhow::anyhow!(
                    "failed to enumerate output configs for host {}: {}",
                    host_name,
                    err
                ));
                Vec::new()
            }
        };

        // First pass: prefer configs that expose stereo output
        for supported in supported_configs.iter().cloned() {
            if supported.channels() != TARGET_CHANNELS {
                continue;
            }

            let sample_format = supported.sample_format();
            if !matches!(
                sample_format,
                SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16
            ) {
                continue;
            }

            if supported.min_sample_rate().0 <= PREFERRED_SAMPLE_RATE
                && supported.max_sample_rate().0 >= PREFERRED_SAMPLE_RATE
            {
                let supported_config =
                    supported.with_sample_rate(cpal::SampleRate(PREFERRED_SAMPLE_RATE));
                let (buffer_size, range, block_size) = choose_buffer_size(
                    supported_config.buffer_size().clone(),
                    &host_name,
                    custom_buffer_size,
                );
                let mut config = supported_config.config();
                config.buffer_size = buffer_size;
                config.channels = TARGET_CHANNELS;
                println!(
                    "Using preferred sample rate: {} Hz (format: {:?}, channels: {})",
                    PREFERRED_SAMPLE_RATE, sample_format, config.channels
                );
                return Ok((
                    device,
                    config,
                    sample_format,
                    host_name.clone(),
                    range,
                    block_size,
                ));
            }
        }

        // Second pass: fall back to any supported config with the preferred sample rate
        for supported in supported_configs.into_iter() {
            let sample_format = supported.sample_format();

            if !matches!(
                sample_format,
                SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16
            ) {
                continue;
            }

            if supported.min_sample_rate().0 <= PREFERRED_SAMPLE_RATE
                && supported.max_sample_rate().0 >= PREFERRED_SAMPLE_RATE
            {
                let supported_config =
                    supported.with_sample_rate(cpal::SampleRate(PREFERRED_SAMPLE_RATE));
                let (buffer_size, range, block_size) = choose_buffer_size(
                    supported_config.buffer_size().clone(),
                    &host_name,
                    custom_buffer_size,
                );
                let mut config = supported_config.config();
                config.buffer_size = buffer_size;
                println!(
                    "Using preferred sample rate: {} Hz (format: {:?}, channels: {})",
                    PREFERRED_SAMPLE_RATE, sample_format, config.channels
                );
                return Ok((device, config, sample_format, host_name, range, block_size));
            }
        }

        // Fall back to default config if preferred sample rate not available
        match device.default_output_config() {
            Ok(supported) => {
                let sample_format = supported.sample_format();
                let (buffer_size, range, block_size) = choose_buffer_size(
                    supported.buffer_size().clone(),
                    &host_name,
                    custom_buffer_size,
                );
                let mut config = supported.config();
                config.buffer_size = buffer_size;
                println!(
                    "Using device default sample rate: {} Hz (preferred {} Hz not available, format: {:?})",
                    config.sample_rate.0, PREFERRED_SAMPLE_RATE, sample_format
                );
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
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("no usable output device found")))
}

/// Choose an appropriate buffer size based on device capabilities and host type
fn choose_buffer_size(
    supported: SupportedBufferSize,
    host_name: &str,
    custom_buffer_size: Option<usize>,
) -> (BufferSize, Option<(u32, u32)>, usize) {
    // Use custom buffer size if provided, otherwise use host-specific defaults
    let preferred_buffer_size = if let Some(custom) = custom_buffer_size {
        custom
    } else {
        match host_name {
            "JACK" => JACK_HOST_BUFFER, // JACK handles low latency well
            "ALSA" => ALSA_HOST_BUFFER, // ALSA needs larger buffers to avoid underruns
            _ => DEFAULT_HOST_BUFFER,   // Safe default for other hosts
        }
    };

    match supported {
        SupportedBufferSize::Range { min, max } => {
            // For JACK, use Default unless custom buffer size is specified
            // JACK dynamically changes buffer sizes and we handle this via carry buffer
            if host_name == "JACK" && custom_buffer_size.is_none() {
                return (
                    BufferSize::Default, // Let JACK use its configured size
                    Some((min, max)),
                    preferred_buffer_size, // Host target size (engine may override internally)
                );
            }

            let desired = preferred_buffer_size as u32;
            let clamped = desired.clamp(min, max);

            if clamped != desired {
                println!(
                    "Note: Requested buffer size {} adjusted to {} (device limits: {}-{})",
                    desired, clamped, min, max
                );
            }

            (
                BufferSize::Fixed(clamped),
                Some((min, max)),
                clamped as usize, // Host target size (engine may override internally)
            )
        }
        SupportedBufferSize::Unknown => (
            BufferSize::Fixed(preferred_buffer_size as u32),
            None,
            preferred_buffer_size, // Host target size (engine may override internally)
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
///
/// This function handles variable buffer sizes by using a carry buffer strategy:
/// - The audio renderer works with fixed-size blocks (engine_block_size)
/// - CPAL callbacks may request any number of frames (can vary between calls)
/// - We maintain a carry buffer that accumulates samples from the renderer
/// - Each callback pulls from the carry buffer and generates new blocks as needed
///
/// This approach ensures:
/// - The audio engine always processes consistent block sizes
/// - CPAL hosts can use their preferred (potentially variable) buffer sizes
/// - Smooth audio playback across different hosts (ALSA, Jack, PulseAudio, etc.)
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

    // Fill the output buffer, generating new blocks as needed
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
