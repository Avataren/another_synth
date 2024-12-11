use crate::{
    AudioGraph, AudioNode, Connection, Envelope, EnvelopeConfig, ModulatableOscillator, NodeId,
    PortId,
};

#[derive(Debug)]
pub struct Voice {
    pub id: usize,
    #[allow(dead_code)]
    sample_rate: f32,
    pub graph: AudioGraph,
    pub oscillator_id: NodeId,
    pub envelope_id: NodeId,

    // Voice state
    pub current_gate: f32,
    pub current_frequency: f32,
    pub current_gain: f32,
    pub active: bool,
}

impl Voice {
    pub fn new(id: usize, sample_rate: f32, envelope_config: EnvelopeConfig) -> Self {
        let buffer_size = 128;
        let mut graph = AudioGraph::new(buffer_size);

        let oscillator_id = graph.add_node(Box::new(ModulatableOscillator::new(sample_rate)));
        let envelope_id = {
            let env = Box::new(Envelope::new(sample_rate, envelope_config));
            graph.add_node(env)
        };

        graph.connect(Connection {
            from_node: envelope_id,
            from_port: PortId::AudioOutput0,
            to_node: oscillator_id,
            to_port: PortId::GainMod,
            amount: 1.0,
        });

        Self {
            id,
            sample_rate,
            graph,
            oscillator_id,
            envelope_id,
            current_gate: 0.0,
            current_frequency: 440.0,
            current_gain: 1.0,
            active: false,
        }
    }

    pub fn update_active_state(&mut self) {
        if let Some(node) = self.graph.get_node(self.envelope_id) {
            if let Some(env) = node.as_any().downcast_ref::<Envelope>() {
                // Voice is active if gate is high or envelope is still producing sound
                self.active = self.current_gate > 0.0 || env.is_active();
            }
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn get_current_gate(&self) -> f32 {
        self.current_gate
    }
    pub fn get_current_frequency(&self) -> f32 {
        self.current_frequency
    }
    pub fn get_current_gain(&self) -> f32 {
        self.current_gain
    }
}

#[cfg(test)]
mod voice_tests {
    use super::*;

    const BUFFER_SIZE: usize = 128; // Match AudioGraph's buffer size

    fn create_test_voice() -> Voice {
        let config = EnvelopeConfig {
            attack: 0.01,
            decay: 0.1,
            sustain: 0.5,
            release: 0.3,
            attack_curve: 0.0,
            decay_curve: 0.0,
            release_curve: 0.0,
            attack_smoothing_samples: 0,
        };
        Voice::new(0, 44100.0, config)
    }

    // Helper function to process audio in chunks
    fn process_samples(voice: &mut Voice, num_samples: usize) {
        let mut left_buf = vec![0.0; BUFFER_SIZE];
        let mut right_buf = vec![0.0; BUFFER_SIZE];

        let num_chunks = (num_samples + BUFFER_SIZE - 1) / BUFFER_SIZE;
        for _ in 0..num_chunks {
            voice.graph.process_audio(&mut left_buf, &mut right_buf);
        }
    }

    #[test]
    fn test_voice_initially_inactive() {
        let mut voice = create_test_voice();
        voice.update_active_state();
        assert!(
            !voice.is_active(),
            "Voice should be inactive when first created"
        );
    }

    #[test]
    fn test_voice_active_on_gate_high() {
        let mut voice = create_test_voice();
        voice.current_gate = 1.0;
        voice.update_active_state();
        assert!(
            voice.is_active(),
            "Voice should be active when gate is high"
        );
    }

    #[test]
    fn test_voice_inactive_after_release() {
        let mut voice = create_test_voice();

        // First trigger the voice
        voice.graph.set_gate(&[1.0]);
        voice.current_gate = 1.0;
        voice.update_active_state();
        assert!(voice.is_active(), "Voice should be active after trigger");

        // Release the voice
        voice.graph.set_gate(&[0.0]);
        voice.current_gate = 0.0;

        // Process enough samples to complete the release phase
        let samples_needed = (voice.sample_rate * 0.5) as usize; // 0.5 seconds
        process_samples(&mut voice, samples_needed);

        voice.update_active_state();
        assert!(
            !voice.is_active(),
            "Voice should be inactive after release phase completes"
        );
    }

    #[test]
    fn test_voice_active_during_release() {
        let mut voice = create_test_voice();

        // Trigger the voice
        voice.graph.set_gate(&[1.0]);
        voice.current_gate = 1.0;
        // Process one buffer to let envelope respond to gate
        process_samples(&mut voice, BUFFER_SIZE);
        voice.update_active_state();

        println!("After trigger - Active: {}", voice.is_active());
        if let Some(node) = voice.graph.get_node(voice.envelope_id) {
            if let Some(env) = node.as_any().downcast_ref::<Envelope>() {
                println!("After trigger - Phase: {:?}", env.get_phase());
            }
        }

        // Release the voice
        voice.graph.set_gate(&[0.0]);
        voice.current_gate = 0.0;
        // Process one buffer to let envelope enter release phase
        process_samples(&mut voice, BUFFER_SIZE);

        if let Some(node) = voice.graph.get_node(voice.envelope_id) {
            if let Some(env) = node.as_any().downcast_ref::<Envelope>() {
                println!("After release processing - Phase: {:?}", env.get_phase());
            }
        }

        voice.update_active_state();
        println!("Final active state: {}", voice.is_active());

        assert!(
            voice.is_active(),
            "Voice should still be active during release phase"
        );
    }

    #[test]
    fn test_voice_retrigger_during_release() {
        let mut voice = create_test_voice();

        // Initial trigger and release
        voice.graph.set_gate(&[1.0]);
        voice.current_gate = 1.0;
        voice.update_active_state();

        voice.graph.set_gate(&[0.0]);
        voice.current_gate = 0.0;

        // Process partially through release
        process_samples(&mut voice, 441);

        // Retrigger
        voice.graph.set_gate(&[1.0]);
        voice.current_gate = 1.0;
        voice.update_active_state();

        assert!(
            voice.is_active(),
            "Voice should be active after retrigger during release"
        );
    }
}
