#![cfg(feature = "native-host")]

use std::time::Duration;

use anyhow::anyhow;
use audio_processor::audio_engine::native::AudioEngine;
use audio_processor::automation::AutomationFrame;
use audio_processor::graph::{ModulationTransformation, ModulationType};
use audio_processor::traits::PortId;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Sample, SampleFormat, SizedSample, StreamConfig, SupportedBufferSize};
use dasp_sample::FromSample;

const DEFAULT_BLOCK_SIZE: usize = 128;
const MACRO_COUNT: usize = 4;
const MACRO_BUFFER_LEN: usize = 128;
const DEFAULT_BLOCKS_PER_STEP: usize = 120;

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
    engine_block_size: usize,
    host_block_size: usize,
    carry_left: Vec<f32>,
    carry_right: Vec<f32>,
    carry_available: usize,
    carry_index: usize,
    step: usize,
    block_progress: usize,
    blocks_per_step: usize,
    call_count: usize,
}

impl DemoState {
    fn new(
        engine: AudioEngine,
        frame: AutomationFrame,
        engine_block_size: usize,
        host_block_size: usize,
        blocks_per_step: usize,
    ) -> Self {
        let engine_block_size = engine_block_size.max(1);
        let host_block_size = host_block_size.max(1);

        if engine_block_size < host_block_size {
            eprintln!(
                "⚠️  WARNING: Engine block size ({}) is smaller than host block size ({})!",
                engine_block_size, host_block_size
            );
            eprintln!(
                "    This may cause buffer underruns. Consider increasing engine block size."
            );
        }

        debug_assert_eq!(
            engine.block_size(),
            engine_block_size,
            "Engine block size mismatch with demo state configuration"
        );
        Self {
            engine,
            frame,
            left: vec![0.0; engine_block_size],
            right: vec![0.0; engine_block_size],
            engine_block_size,
            host_block_size,
            carry_left: vec![0.0; engine_block_size],
            carry_right: vec![0.0; engine_block_size],
            carry_available: 0,
            carry_index: 0,
            step: 0,
            block_progress: 0,
            blocks_per_step,
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

    println!("=== INITIAL CONFIG ===");
    let target_frames = block_size_hint as u32;
    if let Some((min, max)) = buffer_range {
        println!("Device reports buffer size range: {}..={} frames", min, max);
        println!("Target buffer size: {} frames", target_frames);
    } else {
        println!(
            "Device did not report a buffer range; requesting {} frames",
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

    let num_voices = 1;
    let engine_block_size = configured_frames
        .max(DEFAULT_BLOCK_SIZE)
        .max(MACRO_BUFFER_LEN);
    let mut engine = AudioEngine::new_with_block_size(sample_rate, num_voices, engine_block_size);
    engine.init(sample_rate, num_voices);

    setup_synth_patch(&mut engine)?;

    let frame = AutomationFrame::with_dimensions(num_voices, MACRO_COUNT, MACRO_BUFFER_LEN);

    println!("=== BUFFER ALLOCATION ===");
    println!(
        "Host buffer size: {} frames, engine block size: {} frames",
        configured_frames, engine_block_size
    );

    let total_frames_per_step = DEFAULT_BLOCK_SIZE * DEFAULT_BLOCKS_PER_STEP;
    let mut blocks_per_step = (total_frames_per_step + engine_block_size - 1) / engine_block_size;
    if blocks_per_step == 0 {
        blocks_per_step = 1;
    }

    println!("Blocks per step (scaled): {}", blocks_per_step);

    let state = DemoState::new(
        engine,
        frame,
        engine_block_size,
        configured_frames,
        blocks_per_step,
    );

    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(device, config, state)?,
        SampleFormat::I16 => build_stream::<i16>(device, config, state)?,
        SampleFormat::U16 => build_stream::<u16>(device, config, state)?,
        other => panic!("unsupported sample format: {other:?}"),
    };

    stream.play()?;

    println!("\n=== STREAMING STARTED ===");
    println!(
        "Host: '{}', Device: '{}', Sample Rate: {} Hz, Host Block: {}, Engine Block: {}",
        host_label, device_name, sample_rate, configured_frames, engine_block_size
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
            for sample in data.iter_mut() {
                *sample = T::from_sample(0.0f32);
            }
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

    // Add diagnostic logging for buffer mismatches (every 1000 calls, not every call)
    // Add diagnostic logging for buffer mismatches
    if state.call_count % 1000 == 0 {
        println!("\n=== PROCESS_BLOCK (call {}) ===", state.call_count);
        println!("output buffer: {} samples", output.len());
        println!("channels: {}", channels);
        println!("frames requested: {}", total_frames);
        println!("carry available: {} frames", state.carry_available);
        println!("carry index: {}", state.carry_index);
        println!(
            "engine block size: {}, host block size (observed): {}",
            state.engine_block_size, total_frames
        );

        // Check for buffer size variability (this is expected on Linux/ALSA)
        if total_frames != state.host_block_size && state.call_count > 1000 {
            println!(
                "⚠️  Host buffer size changed from {} to {} frames (this is normal on ALSA)",
                state.host_block_size, total_frames
            );
        }

        // Verify carry buffer integrity
        if state.carry_index + state.carry_available != state.engine_block_size {
            println!(
                "❌ ERROR: Carry buffer accounting error! index={}, available={}, should sum to {}",
                state.carry_index, state.carry_available, state.engine_block_size
            );
        }
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

    // Removed the problematic check:
    // if total_frames > state.engine_block_size {
    //     return Err("requested frames exceed engine block size");
    // }

    let mut frames_written = 0;

    while frames_written < total_frames {
        if state.carry_available == 0 {
            // Produce a fresh block from the engine and stage it in the carry buffers.
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

            // CRITICAL: The engine always processes at block_size (128 frames)
            // regardless of what the host requests
            state
                .engine
                .process_with_frame(&state.frame, 0.5, &mut state.left, &mut state.right);

            // Verify the engine produced the expected amount
            debug_assert_eq!(
                state.left.len(),
                state.engine_block_size,
                "Engine produced wrong buffer size!"
            );
            debug_assert_eq!(
                state.right.len(),
                state.engine_block_size,
                "Engine produced wrong buffer size!"
            );

            state.carry_left.copy_from_slice(&state.left);
            state.carry_right.copy_from_slice(&state.right);
            state.carry_index = 0;
            state.carry_available = state.engine_block_size;

            // Advance sequence state once per generated block
            state.block_progress += 1;
            if state.block_progress >= state.blocks_per_step {
                state.block_progress = 0;
                state.step = (state.step + 1) % SEQUENCE.len();
            }

            continue;
        }

        // Calculate safe copy size with explicit bounds checking
        let frames_remaining = total_frames - frames_written;
        let frames_in_carry = state.carry_available;
        let frames_until_buffer_end = state.engine_block_size.saturating_sub(state.carry_index);

        let frames_to_copy = frames_remaining
            .min(frames_in_carry)
            .min(frames_until_buffer_end);

        // Safety check - this should never trigger with above logic
        if frames_to_copy == 0 {
            eprintln!(
                "ERROR: frames_to_copy is 0! remaining={}, in_carry={}, until_end={}",
                frames_remaining, frames_in_carry, frames_until_buffer_end
            );
            return Err("zero frames to copy");
        }

        if state.carry_index + frames_to_copy > state.engine_block_size {
            eprintln!(
                "ERROR: Carry buffer overflow! carry_index={}, frames_to_copy={}, buffer_size={}",
                state.carry_index, frames_to_copy, state.engine_block_size
            );
            return Err("carry buffer overflow detected");
        }

        // Copy from carry buffer to output
        for i in 0..frames_to_copy {
            let output_pos = (frames_written + i) * channels;
            let carry_pos = state.carry_index + i;

            // Additional bounds check
            debug_assert!(
                carry_pos < state.carry_left.len(),
                "carry_pos {} exceeds buffer size {}",
                carry_pos,
                state.carry_left.len()
            );
            debug_assert!(
                output_pos + channels <= output.len(),
                "output_pos {} exceeds output buffer size {}",
                output_pos,
                output.len()
            );

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

        // Verify consistency
        debug_assert_eq!(
            state.carry_index + state.carry_available,
            state.engine_block_size,
            "Carry buffer accounting error!"
        );
    }

    // Validate we filled the entire output buffer
    if state.call_count % 1000 == 0 {
        let max_val = output
            .iter()
            .map(|s| {
                let f: f32 = s.to_sample();
                f.abs()
            })
            .fold(0.0f32, |max, val| max.max(val));

        println!("✓ Processed {} frames successfully", frames_written);
        println!("  Peak output level: {:.4}", max_val);

        // Check for incomplete fills
        if frames_written < total_frames {
            println!(
                "⚠️  WARNING: Only filled {}/{} frames!",
                frames_written, total_frames
            );
        }
    }

    Ok(())
}
