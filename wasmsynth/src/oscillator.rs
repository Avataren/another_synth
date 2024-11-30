use std::rc::Rc;
use std::sync::atomic::{AtomicU8, Ordering};

// A simple sine oscillator with variable frequency and volume.
pub struct Oscillator {
    params: Rc<Params>, // Use Rc to manage shared ownership
    accumulator: u32,
}

impl Oscillator {
    pub fn new(params: Rc<Params>) -> Self {
        Self {
            params,
            accumulator: 0,
        }
    }

    pub fn process(&mut self, output: &mut [f32]) -> bool {
        // This method is called in the audio process thread.
        // Process audio samples based on current frequency and volume.
        for a in output {
            let frequency = self.params.frequency.load(Ordering::Relaxed);
            let volume = self.params.volume.load(Ordering::Relaxed);
            self.accumulator += u32::from(frequency);
            *a = (self.accumulator as f32 / 512.).sin() * (volume as f32 / 100.);
        }
        true
    }
}

// Parameters that can be shared and updated between threads.
#[derive(Default)]
pub struct Params {
    // Use atomics for parameters so they can be set in the main thread and
    // fetched by the audio process thread without further synchronization.
    frequency: AtomicU8,
    volume: AtomicU8,
}

impl Params {
    pub fn set_frequency(&self, frequency: u8) {
        self.frequency.store(frequency, Ordering::Relaxed);
    }

    pub fn set_volume(&self, volume: u8) {
        self.volume.store(volume, Ordering::Relaxed);
    }
}
