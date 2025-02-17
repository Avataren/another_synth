use std::{collections::HashMap, rc::Rc};
use web_sys::console;

/// Cubic interpolation helper. Assumes the samples slice is cyclic.
pub fn cubic_interp(samples: &[f32], pos: f32) -> f32 {
    let n = samples.len();
    let i = pos.floor() as isize;
    let frac = pos - i as f32;
    let idx = |j: isize| -> f32 {
        let index = ((i + j).rem_euclid(n as isize)) as usize;
        samples[index]
    };
    let p0 = idx(-1);
    let p1 = idx(0);
    let p2 = idx(1);
    let p3 = idx(2);
    let a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    let b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
    let c = -0.5 * p0 + 0.5 * p2;
    let d = p1;
    a * frac * frac * frac + b * frac * frac + c * frac + d
}

/// A single synthesis wavetable stored at a fixed base resolution (e.g. 1024 samples).
pub struct SynthWavetable {
    pub samples: Vec<f32>,
    pub base_size: usize, // number of samples (e.g. 1024)
}

impl SynthWavetable {
    pub fn new(samples: Vec<f32>, base_size: usize) -> Self {
        Self { samples, base_size }
    }
}

/// A collection of wavetables used for morphing between different waveforms.
/// (For example, a single collection might hold sine, saw, square, and triangle.)
pub struct WavetableMorphCollection {
    pub wavetables: Vec<SynthWavetable>,
}

impl WavetableMorphCollection {
    pub fn new() -> Self {
        Self {
            wavetables: Vec::new(),
        }
    }

    /// Add a new wavetable to the collection.
    pub fn add_wavetable(&mut self, wavetable: SynthWavetable) {
        self.wavetables.push(wavetable);
    }

    /// Generate a test morph collection containing basic waveforms.
    pub fn generate_test_collection(base_size: usize) -> Self {
        let mut collection = Self::new();
        collection.add_wavetable(generate_sine_table(base_size));
        collection.add_wavetable(generate_triangle_table(base_size));
        collection.add_wavetable(generate_saw_table(base_size));
        collection.add_wavetable(generate_square_table(base_size));
        collection
    }

    /// Given a morph value (0.0–1.0), select a pair of adjacent wavetables (and mix factor)
    /// to be used for interpolation.
    pub fn select_pair_by_morph(&self, morph: f32) -> (&SynthWavetable, &SynthWavetable, f32) {
        let num_tables = self.wavetables.len();
        if num_tables == 0 {
            panic!("WavetableMorphCollection is empty!");
        }
        let clamped = morph.clamp(0.0, 1.0);
        let float_index = clamped * (num_tables as f32 - 1.0);
        let lower_index = float_index.floor() as usize;
        let upper_index = if lower_index < num_tables - 1 {
            lower_index + 1
        } else {
            lower_index
        };
        let mix = float_index - lower_index as f32;
        (
            &self.wavetables[lower_index],
            &self.wavetables[upper_index],
            mix,
        )
    }

    /// Lookup a sample given a phase (0.0–1.0) and a morph value (0.0–1.0).
    /// This uses cubic interpolation within each table and then linearly interpolates between tables.
    pub fn lookup_sample(&self, phase: f32, morph: f32) -> f32 {
        let (wavetable1, wavetable2, mix) = self.select_pair_by_morph(morph);
        let pos = phase * wavetable1.base_size as f32;
        let sample1 = cubic_interp(&wavetable1.samples, pos);
        let sample2 = cubic_interp(&wavetable2.samples, pos);
        sample1 + mix * (sample2 - sample1)
    }
}

/// A bank of wavetable morph collections, keyed by a name.
/// (For example, you might have one collection called "default" that holds several waveforms.)
pub struct WavetableSynthBank {
    pub collections: HashMap<String, Rc<WavetableMorphCollection>>,
}

impl WavetableSynthBank {
    pub fn new() -> Self {
        let base_size = 1024;
        let mut collections = HashMap::new();
        collections.insert(
            "default".to_string(),
            Rc::new(WavetableMorphCollection::generate_test_collection(
                base_size,
            )),
        );
        Self { collections }
    }

    /// Add a new collection to the bank.
    pub fn add_collection(
        &mut self,
        name: impl Into<String>,
        collection: WavetableMorphCollection,
    ) {
        self.collections.insert(name.into(), Rc::new(collection));
    }

    /// Retrieve a collection by name.
    pub fn get_collection(&self, name: &str) -> Option<Rc<WavetableMorphCollection>> {
        self.collections.get(name).cloned()
    }
}

/// --- Waveform Generators ---
pub fn generate_sine_table(base_size: usize) -> SynthWavetable {
    let samples: Vec<f32> = (0..base_size)
        .map(|i| {
            let phase = i as f32 / base_size as f32;
            (2.0 * std::f32::consts::PI * phase).sin()
        })
        .collect();
    console::log_1(&format!("Generated sine table (size: {})", base_size).into());
    SynthWavetable::new(samples, base_size)
}

pub fn generate_saw_table(base_size: usize) -> SynthWavetable {
    let samples: Vec<f32> = (0..base_size)
        .map(|i| {
            let phase = i as f32 / base_size as f32;
            2.0 * phase - 1.0
        })
        .collect();
    console::log_1(&format!("Generated saw table (size: {})", base_size).into());
    SynthWavetable::new(samples, base_size)
}

pub fn generate_square_table(base_size: usize) -> SynthWavetable {
    let samples: Vec<f32> = (0..base_size)
        .map(|i| {
            let phase = i as f32 / base_size as f32;
            if phase < 0.5 {
                1.0
            } else {
                -1.0
            }
        })
        .collect();
    console::log_1(&format!("Generated square table (size: {})", base_size).into());
    SynthWavetable::new(samples, base_size)
}

pub fn generate_triangle_table(base_size: usize) -> SynthWavetable {
    let samples: Vec<f32> = (0..base_size)
        .map(|i| {
            let phase = i as f32 / base_size as f32;
            if phase < 0.5 {
                4.0 * phase - 1.0
            } else {
                3.0 - 4.0 * phase
            }
        })
        .collect();
    console::log_1(&format!("Generated triangle table (size: {})", base_size).into());
    SynthWavetable::new(samples, base_size)
}
