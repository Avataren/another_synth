#![cfg(feature = "native-host")]

#[path = "native_demo/audio_buffer.rs"]
mod audio_buffer;
#[path = "native_demo/audio_renderer.rs"]
mod audio_renderer;
#[path = "composition.rs"]
mod composition;
#[path = "native_demo/cpal_host.rs"]
mod cpal_host;

use std::env;
use std::time::Duration;

use audio_renderer::AudioRenderer;
use composition::Composition;
use cpal_host::{AudioHost, AudioHostOptions};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = env::args().collect();

    // Handle --list-hosts flag
    if args.iter().any(|arg| arg == "--list-hosts") {
        println!("=== AVAILABLE AUDIO HOSTS ===\n");
        let hosts = AudioHost::list_hosts();
        if hosts.is_empty() {
            println!("No audio hosts found!");
            return Ok(());
        }
        for host in hosts {
            let device_status = if host.has_default_device {
                "has default device"
            } else {
                "no default device"
            };
            println!("  - {} ({}, id: {:?})", host.name, device_status, host.id);
        }
        println!(
            "\nUsage: {} [--host <host_name>] [--buffer-size <frames>]",
            args[0]
        );
        println!("Example: {} --host ALSA --buffer-size 128", args[0]);
        return Ok(());
    }

    // Parse CLI arguments
    let mut preferred_host_name: Option<String> = None;
    let mut requested_buffer_size: Option<usize> = None;

    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--host" => {
                if index + 1 >= args.len() {
                    return Err(anyhow::anyhow!("Expected value after --host"));
                }
                preferred_host_name = Some(args[index + 1].clone());
                index += 2;
            }
            "--buffer-size" => {
                if index + 1 >= args.len() {
                    return Err(anyhow::anyhow!(
                        "Expected value after --buffer-size (e.g. 128)"
                    ));
                }
                let value = args[index + 1].parse::<usize>().map_err(|err| {
                    anyhow::anyhow!("Invalid buffer size '{}': {}", args[index + 1], err)
                })?;
                if value == 0 {
                    return Err(anyhow::anyhow!("Buffer size must be greater than zero"));
                }
                requested_buffer_size = Some(value);
                index += 2;
            }
            "--list-hosts" => {
                index += 1;
            }
            _ => {
                index += 1;
            }
        }
    }

    let preferred_host = preferred_host_name.as_deref();

    if let Some(host) = preferred_host {
        println!("=== REQUESTING HOST: {} ===\n", host);
    }

    if let Some(size) = requested_buffer_size {
        println!("Requested buffer size: {} frames\n", size);
    }

    println!("=== CREATING COMPOSITION ===");

    let options = AudioHostOptions {
        preferred_host: preferred_host_name,
        buffer_size: requested_buffer_size,
    };

    let host = AudioHost::with_options(
        |sample_rate, block_size| {
            let composition =
                Composition::new(sample_rate, block_size).expect("Failed to create composition");

            println!(
                "Composition created with {} tracks:",
                composition.tracks.len()
            );
            for track in &composition.tracks {
                println!("  - {}", track.name);
            }

            composition
        },
        options,
    )?;

    let host_config = host.config();
    println!(
        "\nEngine configured: sample_rate={} Hz, channels={}, block_size={} (host: {}, device: {})",
        host_config.sample_rate,
        host_config.channels,
        host_config.buffer_size,
        host_config.host_name,
        host_config.device_name
    );

    println!("\n🎵 Musical composition in A minor");
    println!("   4 tracks: Bass, Pads, Lead, Arpeggio");
    println!("   Press Ctrl+C to stop\n");

    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

impl AudioRenderer for Composition {
    fn process_block(&mut self, output_left: &mut [f32], output_right: &mut [f32]) {
        self.process_block(output_left, output_right);
    }
}

unsafe impl Send for Composition {}
