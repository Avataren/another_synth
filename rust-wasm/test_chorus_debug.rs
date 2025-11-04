use audio_processor::nodes::Chorus;
use audio_processor::traits::{AudioNode, PortId};
use audio_processor::graph::ModulationSource;
use rustc_hash::FxHashMap;

fn main() {
    let sample_rate = 48000.0;
    let mut chorus = Chorus::new(sample_rate, 65.0, 15.0, 5.0, 0.5, 0.3, 0.5, 90.0);
    chorus.set_active(true);
    
    let buffer_size = 128;
    
    // Create test input - a simple sine wave
    let mut input_left = vec![0.0f32; buffer_size];
    let mut input_right = vec![0.0f32; buffer_size];
    for i in 0..buffer_size {
        let t = i as f32 / sample_rate;
        let freq = 440.0;
        let sample = (2.0 * std::f32::consts::PI * freq * t).sin() * 0.5;
        input_left[i] = sample;
        input_right[i] = sample;
    }
    
    println!("Input signal - first 10 samples:");
    for i in 0..10 {
        println!("  input[{}] = {}", i, input_left[i]);
    }
    
    let mut output_left = vec![0.0f32; buffer_size];
    let mut output_right = vec![0.0f32; buffer_size];
    
    let mut inputs = FxHashMap::default();
    inputs.insert(PortId::AudioInput0, vec![audio_processor::graph::ModulationSource {
        buffer: input_left.clone(),
        amount: 1.0,
        mod_type: audio_processor::graph::ModulationType::Additive,
        transformation: audio_processor::graph::ModulationTransformation::None,
    }]);
    inputs.insert(PortId::AudioInput1, vec![audio_processor::graph::ModulationSource {
        buffer: input_right.clone(),
        amount: 1.0,
        mod_type: audio_processor::graph::ModulationType::Additive,
        transformation: audio_processor::graph::ModulationTransformation::None,
    }]);
    
    let mut outputs: FxHashMap<PortId, &mut [f32]> = FxHashMap::default();
    outputs.insert(PortId::AudioOutput0, &mut output_left);
    outputs.insert(PortId::AudioOutput1, &mut output_right);
    
    chorus.process(&inputs, &mut outputs, buffer_size);
    
    println!("\nOutput signal - first 10 samples:");
    for i in 0..10 {
        println!("  output[{}] = {}", i, output_left[i]);
    }
    
    let max_output = output_left.iter().map(|x| x.abs()).fold(0.0f32, f32::max);
    println!("\nMax output amplitude: {}", max_output);
    
    if max_output < 0.001 {
        println!("ERROR: Output is essentially silent!");
    } else {
        println!("Output has signal (good)");
    }
}
