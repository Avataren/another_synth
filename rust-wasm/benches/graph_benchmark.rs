// benches/graph_benchmark.rs
#![feature(test)]
extern crate test;

use audio_processor::{
    AudioGraph, Connection, Envelope, EnvelopeConfig, ModulatableOscillator, PortId,
};
use test::Bencher;

const BUFFER_SIZE: usize = 1024; // Increased from 128
const SAMPLE_RATE: f32 = 44100.0;

struct TestPatch {
    graph: AudioGraph,
}

impl TestPatch {
    fn new(sample_rate: f32, buffer_size: usize) -> Self {
        let mut graph = AudioGraph::new(buffer_size);

        // Add nodes
        let env_id = graph.add_node(Box::new(Envelope::new(
            sample_rate,
            EnvelopeConfig::default(),
        )));

        let osc_id = graph.add_node(Box::new(ModulatableOscillator::new(sample_rate)));

        // Connect envelope to oscillator's gain
        graph.connect(Connection {
            from_node: env_id,
            from_port: PortId::AudioOutput0,
            to_node: osc_id,
            to_port: PortId::GainMod,
            amount: 1.0,
        });

        Self { graph }
    }
}

#[bench]
fn bench_simple_patch_long(b: &mut Bencher) {
    let mut patch = TestPatch::new(SAMPLE_RATE, BUFFER_SIZE);
    let mut output_left = vec![0.0f32; BUFFER_SIZE];
    let mut output_right = vec![0.0f32; BUFFER_SIZE];
    let gate = vec![1.0f32; BUFFER_SIZE];
    let freq = vec![440.0f32; BUFFER_SIZE];

    b.iter(|| {
        // Process multiple times to simulate longer runtime
        for _ in 0..10 {
            patch.graph.set_gate(&gate);
            patch.graph.set_frequency(&freq);
            patch
                .graph
                .process_audio(&mut output_left, &mut output_right);
        }
    });
}

#[bench]
fn bench_multi_voice_patch(b: &mut Bencher) {
    let mut graph = AudioGraph::new(BUFFER_SIZE);
    let num_voices = 8; // 8-voice polyphony

    let mut voice_nodes = Vec::new();

    // Create multiple voices
    for _ in 0..num_voices {
        let env_id = graph.add_node(Box::new(Envelope::new(
            SAMPLE_RATE,
            EnvelopeConfig::default(),
        )));

        let osc_id = graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE)));

        // Connect envelope to oscillator
        graph.connect(Connection {
            from_node: env_id,
            from_port: PortId::AudioOutput0,
            to_node: osc_id,
            to_port: PortId::GainMod,
            amount: 1.0 / num_voices as f32, // Normalize output
        });

        voice_nodes.push((env_id, osc_id));
    }

    let mut output_left = vec![0.0f32; BUFFER_SIZE];
    let mut output_right = vec![0.0f32; BUFFER_SIZE];
    let gate = vec![1.0f32; BUFFER_SIZE];
    let freq = vec![440.0f32; BUFFER_SIZE];

    b.iter(|| {
        // Process multiple times
        for _ in 0..10 {
            graph.set_gate(&gate);
            graph.set_frequency(&freq);
            graph.process_audio(&mut output_left, &mut output_right);
        }
    });
}

#[bench]
fn bench_complex_modulation(b: &mut Bencher) {
    let mut graph = AudioGraph::new(BUFFER_SIZE);

    // Create a complex FM synthesis patch
    let carrier_env = graph.add_node(Box::new(Envelope::new(
        SAMPLE_RATE,
        EnvelopeConfig::default(),
    )));

    let modulator_env = graph.add_node(Box::new(Envelope::new(
        SAMPLE_RATE,
        EnvelopeConfig {
            attack: 0.05,
            decay: 0.2,
            sustain: 0.3,
            release: 0.4,
            ..EnvelopeConfig::default()
        },
    )));

    let carrier = graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE)));
    let modulator = graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE)));
    let sub_modulator = graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE)));

    // Complex modulation routing
    graph.connect(Connection {
        from_node: carrier_env,
        from_port: PortId::AudioOutput0,
        to_node: carrier,
        to_port: PortId::GainMod,
        amount: 1.0,
    });

    graph.connect(Connection {
        from_node: modulator_env,
        from_port: PortId::AudioOutput0,
        to_node: modulator,
        to_port: PortId::GainMod,
        amount: 1.0,
    });

    graph.connect(Connection {
        from_node: modulator,
        from_port: PortId::AudioOutput0,
        to_node: carrier,
        to_port: PortId::FrequencyMod,
        amount: 2.0,
    });

    graph.connect(Connection {
        from_node: sub_modulator,
        from_port: PortId::AudioOutput0,
        to_node: modulator,
        to_port: PortId::FrequencyMod,
        amount: 1.0,
    });

    let mut output_left = vec![0.0f32; BUFFER_SIZE];
    let mut output_right = vec![0.0f32; BUFFER_SIZE];
    let gate = vec![1.0f32; BUFFER_SIZE];
    let freq = vec![440.0f32; BUFFER_SIZE];

    b.iter(|| {
        // Process multiple times with frequency modulation
        for i in 0..10 {
            graph.set_gate(&gate);
            // Modulate frequency over time
            let freq_mod = freq
                .iter()
                .map(|f| f * (1.0 + (i as f32 * 0.1)))
                .collect::<Vec<_>>();
            graph.set_frequency(&freq_mod);
            graph.process_audio(&mut output_left, &mut output_right);
        }
    });
}
