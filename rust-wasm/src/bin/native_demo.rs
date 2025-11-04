#![cfg(feature = "native-host")]

mod audio_buffer;
mod audio_renderer;
mod composition;
mod cpal_host;

use std::time::Duration;

use anyhow;
use audio_renderer::AudioRenderer;
use composition::Composition;
use cpal_host::AudioHost;

fn main() -> anyhow::Result<()> {
    println!("=== CREATING COMPOSITION ===");

    let _host = AudioHost::new(|sample_rate, block_size| {
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
    })?;

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
