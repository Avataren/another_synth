//! `AhxPlayer`: the wasm-facing shell around [`AhxEngine`] (P4).
//!
//! The engine renders interleaved `i16` stereo, exactly what `hvl_DecodeFrame`
//! writes, because that is what the bit-exact goldens compare. An
//! `AudioWorkletProcessor` wants planar `f32` in `[-1, 1)`, one channel array
//! per output. This module is that adapter and nothing else: no DSP, no
//! transport decisions, so the bit-exactness proven in `tests/` is untouched
//! (the adapter is tested against the engine's own `i16` stream).
//!
//! The wasm-bindgen attribute is `cfg_attr`-gated on the `wasm` feature the
//! same way `audio_engine/wasm.rs` does it, so the whole class also compiles
//! and is unit-tested natively.

use super::engine::{AhxEngine, ENGINE_CHANNELS};
use super::format;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

/// Full-scale divisor for `i16 -> f32`. `-32768` maps to exactly `-1.0` and
/// `32767` to just under `1.0`, so the conversion is lossless in `f32` and
/// never exceeds full scale.
const I16_SCALE: f32 = 1.0 / 32768.0;

/// `i16 -> f32`, `[-32768, 32767] -> [-1.0, 32767/32768]`.
#[inline]
pub fn i16_to_f32(s: i16) -> f32 {
    s as f32 * I16_SCALE
}

/// De-interleaves `interleaved` (`L, R, L, R, ...`) into `left`/`right`,
/// converting to `f32` and applying `gain`. Processes
/// `min(interleaved.len() / 2, left.len(), right.len())` frames and returns
/// that count; anything beyond it in `left`/`right` is left untouched.
pub fn deinterleave_to_f32(interleaved: &[i16], left: &mut [f32], right: &mut [f32], gain: f32) -> usize {
    let frames = (interleaved.len() / 2).min(left.len()).min(right.len());
    for i in 0..frames {
        left[i] = i16_to_f32(interleaved[2 * i]) * gain;
        right[i] = i16_to_f32(interleaved[2 * i + 1]) * gain;
    }
    frames
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub struct AhxPlayer {
    engine: AhxEngine,
    /// Reused across `render` calls; grows once to the largest block seen
    /// (the audio thread is not supposed to allocate in steady state).
    scratch: Vec<i16>,
    gain: f32,
    playing: bool,
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
impl AhxPlayer {
    /// Parses an AHX (`THX`) or HVL file and builds a paused player.
    /// `stereo_mode` (0..=4) is AHX's stereo-separation setting; HVL files
    /// carry their own. Songs wider than the fixed-4 engine play their first
    /// four channels, see [`dropped_channels`](Self::dropped_channels).
    #[cfg_attr(feature = "wasm", wasm_bindgen(constructor))]
    pub fn new(bytes: &[u8], sample_rate: u32, stereo_mode: u8) -> Result<AhxPlayer, String> {
        let song = format::parse(bytes).map_err(|e| e.to_string())?;
        let engine = AhxEngine::new(song, sample_rate, stereo_mode).map_err(|e| e.to_string())?;
        Ok(AhxPlayer { engine, scratch: Vec::new(), gain: 1.0, playing: false })
    }

    pub fn play(&mut self) {
        self.playing = true;
    }

    /// Stops rendering (the output is silence) without losing the position.
    pub fn pause(&mut self) {
        self.playing = false;
    }

    /// Back to the start of `subsong` (0 = the main song), paused. `false`
    /// for an out-of-range subsong, in which case nothing changes.
    pub fn restart(&mut self, subsong: usize) -> bool {
        let ok = self.engine.init_subsong(subsong);
        if ok {
            self.playing = false;
        }
        ok
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    /// Linear output gain, clamped to `[0, 2]`; NaN is ignored.
    pub fn set_gain(&mut self, gain: f32) {
        if !gain.is_nan() {
            self.gain = gain.clamp(0.0, 2.0);
        }
    }

    /// Fills `left`/`right` with planar `f32` and returns the number of
    /// frames written (`min(left.len(), right.len())`). While paused the
    /// engine does not advance and the output is zeroed.
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) -> usize {
        let frames = left.len().min(right.len());
        if !self.playing {
            left[..frames].fill(0.0);
            right[..frames].fill(0.0);
            return frames;
        }
        if self.scratch.len() < frames * 2 {
            self.scratch.resize(frames * 2, 0);
        }
        self.engine.render_block(&mut self.scratch[..frames * 2]);
        deinterleave_to_f32(&self.scratch[..frames * 2], left, right, self.gain)
    }

    pub fn sample_rate(&self) -> u32 {
        self.engine.sample_rate()
    }

    pub fn channels(&self) -> usize {
        self.engine.channels()
    }

    /// The fixed voice count of the engine (`ENGINE_CHANNELS`).
    pub fn engine_channels() -> usize {
        ENGINE_CHANNELS
    }

    /// Song channels that do not fit the fixed-4 engine and are not played.
    pub fn dropped_channels(&self) -> usize {
        self.engine.dropped_channels()
    }

    pub fn position(&self) -> i32 {
        self.engine.pos_nr()
    }

    pub fn row(&self) -> i32 {
        self.engine.note_nr()
    }

    /// Ticks per row (the song's current speed).
    pub fn tempo(&self) -> i32 {
        self.engine.tempo()
    }

    /// Ticks played so far (50 Hz x speed multiplier).
    pub fn ticks(&self) -> u32 {
        self.engine.ticks_played()
    }

    /// Set once the song has reached its end (it then loops from its restart
    /// position, as the reference does); cleared by [`restart`](Self::restart).
    pub fn song_end_reached(&self) -> bool {
        self.engine.song_end_reached()
    }

    pub fn song_name(&self) -> String {
        self.engine.song().name.clone()
    }

    pub fn position_count(&self) -> usize {
        self.engine.song().position_nr as usize
    }

    pub fn track_length(&self) -> usize {
        self.engine.song().track_length as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn i16_conversion_hits_the_full_scale_endpoints_exactly() {
        assert_eq!(i16_to_f32(i16::MIN), -1.0);
        assert_eq!(i16_to_f32(0), 0.0);
        assert_eq!(i16_to_f32(16384), 0.5);
        assert!(i16_to_f32(i16::MAX) < 1.0);
        assert_eq!(i16_to_f32(i16::MAX), 32767.0 / 32768.0);
    }

    #[test]
    fn deinterleave_splits_channels_and_applies_gain() {
        let src = [100i16, -200, 300, -400, 500, -600];
        let (mut l, mut r) = ([9.0f32; 3], [9.0f32; 3]);
        assert_eq!(deinterleave_to_f32(&src, &mut l, &mut r, 1.0), 3);
        assert_eq!(l, [100.0 / 32768.0, 300.0 / 32768.0, 500.0 / 32768.0]);
        assert_eq!(r, [-200.0 / 32768.0, -400.0 / 32768.0, -600.0 / 32768.0]);
        deinterleave_to_f32(&src, &mut l, &mut r, 0.5);
        assert_eq!(l[0], 50.0 / 32768.0);
    }

    #[test]
    fn deinterleave_stops_at_the_shortest_buffer_and_leaves_the_rest() {
        let src = [1i16, 2, 3, 4, 5, 6];
        let (mut l, mut r) = ([7.0f32; 4], [7.0f32; 2]);
        assert_eq!(deinterleave_to_f32(&src, &mut l, &mut r, 1.0), 2);
        assert_eq!(l[2], 7.0);
        assert_eq!(deinterleave_to_f32(&src[..1], &mut l, &mut r, 1.0), 0);
    }
}
