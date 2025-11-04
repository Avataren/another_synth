#![cfg(feature = "native-host")]

mod audio_buffer;
mod audio_renderer;
mod composition;
mod cpal_host;

use std::env;
use std::time::Duration;

use anyhow;
use audio_renderer::AudioRenderer;
use composition::Composition;
use cpal_host::AudioHost;

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
            println!("  - {} ({})", host.name, device_status);
        }
        println!("\nUsage: {} [--host <host_name>]", args[0]);
        println!("Example: {} --host ALSA", args[0]);
        return Ok(());
    }

    // Parse --host argument
    let preferred_host = args
        .windows(2)
        .find(|w| w[0] == "--host")
        .map(|w| w[1].as_str());

    if let Some(host) = preferred_host {
        println!("=== REQUESTING HOST: {} ===\n", host);
    }

    println!("=== CREATING COMPOSITION ===");

    let _host = AudioHost::with_host_preference(
        |sample_rate, block_size| {
            let composition = Composition::new(sample_rate, block_size)
                .expect("Failed to create composition");

            println!(
                "Composition created with {} tracks:",
                composition.tracks.len()
            );
            for track in &composition.tracks {
                println!("  - {}", track.name);
            }

            composition
        },
        preferred_host,
    )?;

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
