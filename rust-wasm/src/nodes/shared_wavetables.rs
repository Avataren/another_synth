//////////////////////////////
/// shared_wavetables.rs
//////////////////////////////
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Arc;

use super::{Waveform, WavetableBank};

pub static WAVETABLE_BANKS: Lazy<HashMap<Waveform, Arc<WavetableBank>>> = Lazy::new(|| {
    let sample_rate = 48000.0; // Adjust as needed.
    let max_table_size = 2048; // Starting size.
    let mut map = HashMap::new();
    map.insert(
        Waveform::Sine,
        Arc::new(WavetableBank::new(
            Waveform::Sine,
            max_table_size,
            sample_rate,
        )),
    );
    map.insert(
        Waveform::Saw,
        Arc::new(WavetableBank::new(
            Waveform::Saw,
            max_table_size,
            sample_rate,
        )),
    );
    map.insert(
        Waveform::Square,
        Arc::new(WavetableBank::new(
            Waveform::Square,
            max_table_size,
            sample_rate,
        )),
    );
    map.insert(
        Waveform::Triangle,
        Arc::new(WavetableBank::new(
            Waveform::Triangle,
            max_table_size,
            sample_rate,
        )),
    );
    map
});
