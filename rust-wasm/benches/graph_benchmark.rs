// // benches/graph_benchmark.rs
// #![feature(test)]
// extern crate test;

// use audio_processor::{
//     AudioGraph, Connection, Envelope, EnvelopeConfig, ModulatableOscillator, PortId,
// };
// use test::Bencher;

// const BUFFER_SIZE: usize = 128;
// const SAMPLE_RATE: f32 = 44100.0;

// struct TestPatch {
//     graph: AudioGraph,
// }

// impl TestPatch {
//     fn new(sample_rate: f32, buffer_size: usize) -> Self {
//         let mut graph = AudioGraph::new(buffer_size);

//         // Add nodes
//         let env_id = graph.add_node(Box::new(Envelope::new(
//             sample_rate,
//             EnvelopeConfig::default(),
//         )));

//         let osc_id = graph.add_node(Box::new(ModulatableOscillator::new(sample_rate)));

//         // Connect envelope to oscillator's gain
//         graph.connect(Connection {
//             from_node: env_id,
//             from_port: PortId::AudioOutput0,
//             to_node: osc_id,
//             to_port: PortId::GainMod,
//             amount: 1.0,
//         });

//         Self { graph }
//     }
// }

// #[bench]
// fn bench_simple_patch_long(b: &mut Bencher) {
//     let mut patch = TestPatch::new(SAMPLE_RATE, BUFFER_SIZE);
//     let mut output_left = vec![0.0f32; BUFFER_SIZE];
//     let mut output_right = vec![0.0f32; BUFFER_SIZE];
//     let gate = vec![1.0f32; BUFFER_SIZE];
//     let freq = vec![440.0f32; BUFFER_SIZE];

//     b.iter(|| {
//         // Process multiple times to simulate longer runtime
//         for _ in 0..10 {
//             patch.graph.set_gate(&gate);
//             patch.graph.set_frequency(&freq);
//             patch
//                 .graph
//                 .process_audio(&mut output_left, &mut output_right);
//         }
//     });
// }

// #[bench]
// fn bench_multi_voice_patch(b: &mut Bencher) {
//     let mut graph = AudioGraph::new(BUFFER_SIZE);
//     let num_voices = 8; // 8-voice polyphony

//     let mut voice_nodes = Vec::new();

//     // Create multiple voices
//     for _ in 0..num_voices {
//         let env_id = graph.add_node(Box::new(Envelope::new(
//             SAMPLE_RATE,
//             EnvelopeConfig::default(),
//         )));

//         let osc_id = graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE)));

//         // Connect envelope to oscillator
//         graph.connect(Connection {
//             from_node: env_id,
//             from_port: PortId::AudioOutput0,
//             to_node: osc_id,
//             to_port: PortId::GainMod,
//             amount: 1.0 / num_voices as f32, // Normalize output
//         });

//         voice_nodes.push((env_id, osc_id));
//     }

//     let mut output_left = vec![0.0f32; BUFFER_SIZE];
//     let mut output_right = vec![0.0f32; BUFFER_SIZE];
//     let gate = vec![1.0f32; BUFFER_SIZE];
//     let freq = vec![440.0f32; BUFFER_SIZE];

//     b.iter(|| {
//         // Process multiple times
//         for _ in 0..10 {
//             graph.set_gate(&gate);
//             graph.set_frequency(&freq);
//             graph.process_audio(&mut output_left, &mut output_right);
//         }
//     });
// }

// #[bench]
// fn bench_complex_modulation(b: &mut Bencher) {
//     let mut graph = AudioGraph::new(BUFFER_SIZE);

//     // Create a complex FM synthesis patch
//     let carrier_env = graph.add_node(Box::new(Envelope::new(
//         SAMPLE_RATE,
//         EnvelopeConfig::default(),
//     )));

//     let modulator_env = graph.add_node(Box::new(Envelope::new(
//         SAMPLE_RATE,
//         EnvelopeConfig {
//             attack: 0.05,
//             decay: 0.2,
//             sustain: 0.3,
//             release: 0.4,
//             ..EnvelopeConfig::default()
//         },
//     )));

//     let carrier = graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE)));
//     let modulator = graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE)));
//     let sub_modulator = graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE)));

//     // Complex modulation routing
//     graph.connect(Connection {
//         from_node: carrier_env,
//         from_port: PortId::AudioOutput0,
//         to_node: carrier,
//         to_port: PortId::GainMod,
//         amount: 1.0,
//     });

//     graph.connect(Connection {
//         from_node: modulator_env,
//         from_port: PortId::AudioOutput0,
//         to_node: modulator,
//         to_port: PortId::GainMod,
//         amount: 1.0,
//     });

//     graph.connect(Connection {
//         from_node: modulator,
//         from_port: PortId::AudioOutput0,
//         to_node: carrier,
//         to_port: PortId::FrequencyMod,
//         amount: 2.0,
//     });

//     graph.connect(Connection {
//         from_node: sub_modulator,
//         from_port: PortId::AudioOutput0,
//         to_node: modulator,
//         to_port: PortId::FrequencyMod,
//         amount: 1.0,
//     });

//     let mut output_left = vec![0.0f32; BUFFER_SIZE];
//     let mut output_right = vec![0.0f32; BUFFER_SIZE];
//     let gate = vec![1.0f32; BUFFER_SIZE];
//     let freq = vec![440.0f32; BUFFER_SIZE];

//     b.iter(|| {
//         // Process multiple times with frequency modulation
//         for i in 0..10 {
//             graph.set_gate(&gate);
//             // Modulate frequency over time
//             let freq_mod = freq
//                 .iter()
//                 .map(|f| f * (1.0 + (i as f32 * 0.1)))
//                 .collect::<Vec<_>>();
//             graph.set_frequency(&freq_mod);
//             graph.process_audio(&mut output_left, &mut output_right);
//         }
//     });
// }

// // Add this to your existing benchmark file

// #[bench]
// fn bench_complex_synth(b: &mut Bencher) {
//     let mut graph = AudioGraph::new(128);

//     // Create multiple oscillators (3 per voice, 4 voices)
//     let mut oscillators = Vec::new();
//     let mut envelopes = Vec::new();

//     // Create 4 voices, each with 3 oscillators
//     for _ in 0..4 {
//         let mut voice_oscillators = Vec::new();

//         // Main envelope
//         let amp_env = graph.add_node(Box::new(Envelope::new(
//             SAMPLE_RATE,
//             EnvelopeConfig {
//                 attack: 0.01,
//                 decay: 0.3,
//                 sustain: 0.7,
//                 release: 0.5,
//                 ..EnvelopeConfig::default()
//             },
//         )));

//         // Filter envelope
//         let filter_env = graph.add_node(Box::new(Envelope::new(
//             SAMPLE_RATE,
//             EnvelopeConfig {
//                 attack: 0.05,
//                 decay: 0.2,
//                 sustain: 0.3,
//                 release: 0.4,
//                 ..EnvelopeConfig::default()
//             },
//         )));

//         // Mod envelope
//         let mod_env = graph.add_node(Box::new(Envelope::new(
//             SAMPLE_RATE,
//             EnvelopeConfig {
//                 attack: 0.1,
//                 decay: 1.0,
//                 sustain: 0.0,
//                 release: 0.3,
//                 ..EnvelopeConfig::default()
//             },
//         )));

//         envelopes.push((amp_env, filter_env, mod_env));

//         // Create 3 oscillators per voice
//         for _i in 0..3 {
//             let osc = graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE)));
//             voice_oscillators.push(osc);

//             // Connect amp envelope to each oscillator
//             graph.connect(Connection {
//                 from_node: amp_env,
//                 from_port: PortId::AudioOutput0,
//                 to_node: osc,
//                 to_port: PortId::GainMod,
//                 amount: 0.33, // Mix oscillators equally
//             });
//         }
//         oscillators.push(voice_oscillators);
//     }

//     // Create 4 LFO modulators
//     let mut lfos = Vec::new();
//     for _ in 0..4 {
//         let lfo = graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE)));
//         lfos.push(lfo);
//     }

//     // Complex modulation matrix
//     for (voice_idx, voice_oscs) in oscillators.iter().enumerate() {
//         let (_amp_env, _filter_env, mod_env) = envelopes[voice_idx];

//         // LFO to oscillator frequency modulation
//         for (osc_idx, &osc) in voice_oscs.iter().enumerate() {
//             graph.connect(Connection {
//                 from_node: lfos[osc_idx % 2], // Alternate between first two LFOs
//                 from_port: PortId::AudioOutput0,
//                 to_node: osc,
//                 to_port: PortId::FrequencyMod,
//                 amount: 0.1,
//             });

//             // Mod envelope to frequency
//             graph.connect(Connection {
//                 from_node: mod_env,
//                 from_port: PortId::AudioOutput0,
//                 to_node: osc,
//                 to_port: PortId::FrequencyMod,
//                 amount: 0.2,
//             });
//         }

//         // Cross modulation between oscillators
//         graph.connect(Connection {
//             from_node: voice_oscs[0],
//             from_port: PortId::AudioOutput0,
//             to_node: voice_oscs[1],
//             to_port: PortId::PhaseMod,
//             amount: 0.3,
//         });

//         graph.connect(Connection {
//             from_node: voice_oscs[1],
//             from_port: PortId::AudioOutput0,
//             to_node: voice_oscs[2],
//             to_port: PortId::FrequencyMod,
//             amount: 0.15,
//         });
//     }

//     // LFO modulation of other LFOs
//     graph.connect(Connection {
//         from_node: lfos[0],
//         from_port: PortId::AudioOutput0,
//         to_node: lfos[1],
//         to_port: PortId::FrequencyMod,
//         amount: 0.2,
//     });

//     graph.connect(Connection {
//         from_node: lfos[2],
//         from_port: PortId::AudioOutput0,
//         to_node: lfos[3],
//         to_port: PortId::PhaseMod,
//         amount: 0.25,
//     });

//     let mut output_left = vec![0.0f32; 128];
//     let mut output_right = vec![0.0f32; 128];
//     let gate = vec![1.0f32; 128];
//     let freq = vec![440.0f32; 128];

//     b.iter(|| {
//         for i in 0..10 {
//             graph.set_gate(&gate);
//             // Slight frequency modulation to simulate realistic usage
//             let freq_mod = freq
//                 .iter()
//                 .map(|f| f * (1.0 + (i as f32 * 0.01)))
//                 .collect::<Vec<_>>();
//             graph.set_frequency(&freq_mod);
//             graph.process_audio(&mut output_left, &mut output_right);
//         }
//     });
// }

// // Test just buffer operations
// #[bench]
// fn bench_buffer_operations(b: &mut Bencher) {
//     let mut graph = AudioGraph::new(BUFFER_SIZE);
//     let _osc = graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE)));

//     let mut output_left = vec![0.0f32; BUFFER_SIZE];
//     let mut output_right = vec![0.0f32; BUFFER_SIZE];
//     let freq = vec![440.0f32; BUFFER_SIZE];

//     b.iter(|| {
//         graph.set_frequency(&freq);
//         graph.process_audio(&mut output_left, &mut output_right);
//     });
// }

// // Test single node without modulation
// #[bench]
// fn bench_single_oscillator(b: &mut Bencher) {
//     let mut graph = AudioGraph::new(BUFFER_SIZE);
//     let _osc = graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE)));

//     let mut output_left = vec![0.0f32; BUFFER_SIZE];
//     let mut output_right = vec![0.0f32; BUFFER_SIZE];
//     let freq = vec![440.0f32; BUFFER_SIZE];

//     // Set up initial state
//     graph.set_frequency(&freq);

//     b.iter(|| {
//         graph.process_audio(&mut output_left, &mut output_right);
//     });
// }

// // Test connection overhead without modulation
// #[bench]
// fn bench_connection_overhead(b: &mut Bencher) {
//     let mut graph = AudioGraph::new(BUFFER_SIZE);

//     // Create a chain of 5 pass-through oscillators
//     let mut nodes = Vec::new();
//     for _ in 0..5 {
//         nodes.push(graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE))));
//     }

//     // Connect them in series
//     for i in 0..4 {
//         graph.connect(Connection {
//             from_node: nodes[i],
//             from_port: PortId::AudioOutput0,
//             to_node: nodes[i + 1],
//             to_port: PortId::AudioInput0,
//             amount: 1.0,
//         });
//     }

//     let mut output_left = vec![0.0f32; BUFFER_SIZE];
//     let mut output_right = vec![0.0f32; BUFFER_SIZE];
//     let freq = vec![440.0f32; BUFFER_SIZE];

//     // Set up initial state
//     graph.set_frequency(&freq);

//     b.iter(|| {
//         graph.process_audio(&mut output_left, &mut output_right);
//     });
// }

// // Test steady-state envelope processing
// #[bench]
// fn bench_envelope_steady_state(b: &mut Bencher) {
//     let mut graph = AudioGraph::new(BUFFER_SIZE);

//     let _env = graph.add_node(Box::new(Envelope::new(
//         SAMPLE_RATE,
//         EnvelopeConfig::default(),
//     )));

//     let mut output_left = vec![0.0f32; BUFFER_SIZE];
//     let mut output_right = vec![0.0f32; BUFFER_SIZE];
//     let gate = vec![1.0f32; BUFFER_SIZE];

//     // Put the envelope into sustain state
//     graph.set_gate(&gate);
//     for _ in 0..100 {
//         graph.process_audio(&mut output_left, &mut output_right);
//     }

//     b.iter(|| {
//         graph.process_audio(&mut output_left, &mut output_right);
//     });
// }

// // Test parallel processing overhead
// #[bench]
// fn bench_parallel_nodes(b: &mut Bencher) {
//     let mut graph = AudioGraph::new(BUFFER_SIZE);

//     // Create 8 parallel oscillators without connections
//     for _ in 0..8 {
//         graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE)));
//     }

//     let mut output_left = vec![0.0f32; BUFFER_SIZE];
//     let mut output_right = vec![0.0f32; BUFFER_SIZE];
//     let freq = vec![440.0f32; BUFFER_SIZE];

//     // Set up initial state
//     graph.set_frequency(&freq);

//     b.iter(|| {
//         graph.process_audio(&mut output_left, &mut output_right);
//     });
// }

// // Test buffer size impact
// #[bench]
// fn bench_large_buffer(b: &mut Bencher) {
//     const LARGE_BUFFER_SIZE: usize = 1024;
//     let mut graph = AudioGraph::new(LARGE_BUFFER_SIZE);
//     let _osc = graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE)));

//     let mut output_left = vec![0.0f32; LARGE_BUFFER_SIZE];
//     let mut output_right = vec![0.0f32; LARGE_BUFFER_SIZE];
//     let freq = vec![440.0f32; LARGE_BUFFER_SIZE];

//     // Set up initial state
//     graph.set_frequency(&freq);

//     b.iter(|| {
//         graph.process_audio(&mut output_left, &mut output_right);
//     });
// }

// // Test FxHashMap lookup overhead
// #[bench]
// fn bench_node_lookup(b: &mut Bencher) {
//     // Create graph with nodes once, outside the benchmark loop
//     let mut graph = AudioGraph::new(BUFFER_SIZE);
//     let mut nodes = Vec::new();

//     for _ in 0..100 {
//         nodes.push(graph.add_node(Box::new(ModulatableOscillator::new(SAMPLE_RATE))));
//     }

//     let mut output_left = vec![0.0f32; BUFFER_SIZE];
//     let mut output_right = vec![0.0f32; BUFFER_SIZE];

//     // Only measure the process_audio call
//     b.iter(|| {
//         graph.process_audio(&mut output_left, &mut output_right);
//     });
// }
