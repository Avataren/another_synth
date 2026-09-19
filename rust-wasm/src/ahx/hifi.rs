//! Band-limited ("hi-fi") oscillators for the AHX/HVL mixer, built the way the
//! rest of this crate builds mipmapped wavetables (`nodes/wavetable.rs`):
//! construct the spectrum, zero every bin above a level's Nyquist, inverse-FFT.
//!
//! ## What the reference does, and why it aliases
//!
//! A voice plays a cyclic table of `N = 4 << wave_length` signed bytes (4..128)
//! straight out of `voice_buffer`, nearest-neighbour at a 16.16 step: no
//! interpolation, no band limit. Read at a step of `f0` cycles per output
//! sample, the staircase's harmonics -- and the images of the staircase itself
//! -- above Nyquist fold back below it. On a high note that lands as
//! inharmonic garbage, including energy far below the pitch.
//!
//! ## What hi-fi does
//!
//! The waveform the reference *means* is the continuous staircase
//! `s(t) = x[floor(t * N)]`. Its Fourier series is exact and closed-form:
//!
//! ```text
//! c_0 = X_0 / N
//! c_k = X_(k mod N) * e^(-i*pi*k/N) * sin(pi*k/N) / (pi*k)        (k >= 1)
//! ```
//!
//! with `X` the N-point DFT of the table (the `sin` term is the zero-order
//! hold's sinc, so the staircase images are kept -- below Nyquist they are
//! part of the sound). A mip level keeps harmonics `1..=H`, inverse-FFTs them
//! into a [`TABLE_SIZE`]-point cycle and is used only while
//! `H * f0 <= Nyquist`, so nothing above Nyquist exists to fold. That is the
//! whole idea: the reference sound, minus exactly the part that cannot be
//! represented.
//!
//! * **Levels** are a geometric ladder of harmonic counts (`LEVELS_PER_OCTAVE`
//!   per octave, from [`MAX_HARMONICS`] down to 1) and are built lazily, the
//!   first time a voice needs one.
//! * **Sources** are keyed by the table's *contents*, not by a parameter pair.
//!   That covers every way AHX makes a table without enumerating them: the
//!   per-frame square duty (`CalcSquare`'s 32 widths, subsampled per wave
//!   length), the filter-sweep rows (a lowpass/highpass row is just a
//!   different table), triangle and sawtooth at each wave length. Equal
//!   contents share one spectrum and one set of levels.
//! * **DC is kept** (the reference's squares carry a duty-dependent DC and its
//!   sawtooth a half-LSB one); `wavetable.rs` zeroes DC because its sources are
//!   symmetric. The Nyquist bin is never populated: `H <= TABLE_SIZE / 8`.
//!
//! ## The AHX filter
//!
//! AHX's "filter" is not a stage on the oscillator output: it is baked into
//! the wave tables (`waveform::gen_filter_waves`, 31 low- and 31 high-pass
//! rows selected by `filter.pos`). A voice on a filtered row simply plays a
//! different `N`-byte table, and hi-fi band-limits *that* table. The filter
//! response is therefore untouched (resonant peaks and all, up to Nyquist);
//! only what could not have been represented is removed. Nothing is filtered
//! twice and nothing here depends on the filter's internals.
//!
//! ## What stays reference-authentic
//!
//! * **Noise** (`WAVEFORM_NOISE`): a 0x280-byte pseudo-random buffer, not a
//!   periodic table, so there is no harmonic series to truncate. Its aliasing
//!   is a different problem and a different fix (a noise source has no
//!   fundamental to fold). It plays the reference path.
//! * **Ring modulation**: the modulator stays the reference's byte table. The
//!   product of two waves has sum and difference partials that neither
//!   factor's band limit bounds, so band-limiting the factors would not
//!   deliver what it promises.
//!
//! Hi-fi is off in the engine by default and, off, is not merely equivalent
//! but *the same code path*: the mixer's `HIFI` const-generic is `false`, and
//! nothing here runs. The render goldens hold byte for byte. (The *app* turns
//! it on by default -- the `ahxHifi` setting -- through `AhxPlayer::set_hifi`;
//! the engine's own default, and the golden harness that drives it directly,
//! are unaffected.)
//!
//! ## Prewarm: no table is ever built on the audio thread
//!
//! Building a level is an inverse FFT plus a quantise (~0.1 ms), and a tick
//! on many voices can want a dozen cold ones at once -- against a 2.7 ms
//! render quantum. So the product path never builds while rendering: the
//! bank has three [`BankMode`]s. `Lazy` (the engine default, what the tests
//! use) builds on demand. `Prewarm` builds on demand too, but never evicts and
//! stops at the cap. `Locked` only *looks up*: a miss is counted, and the voice
//! takes the nearest built level with fewer partials of the same table (duller,
//! never aliased), or failing that the reference path for that tick.
//! `AhxEngine::prewarm_hifi` runs the song's ticks (no mixing) in `Prewarm`
//! mode, then locks; see there for what that covers.
//!
//! Zero new dependencies: `rustfft` is what `wavetable.rs` already uses.

use rustc_hash::FxHashMap;
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::sync::Arc;

/// Samples per band-limited cycle (a power of two). At the top level
/// (`MAX_HARMONICS` = 512) that is 8 points per period of the highest
/// partial, where linear interpolation costs under half a dB.
pub const TABLE_SIZE: usize = 4096;

/// Most partials a level can hold; `TABLE_SIZE / 8`. Only reached for
/// fundamentals below `Nyquist / 512` (~47 Hz at 48 kHz), where the reference's
/// own tables have long run out of content that matters.
pub const MAX_HARMONICS: usize = TABLE_SIZE / 8;

/// Mip levels per octave of pitch. 2 keeps the audible brightness step when a
/// slide or vibrato crosses a level under ~3 dB at the top of the band, while
/// a song only ever touches two or three levels per source.
pub const LEVELS_PER_OCTAVE: usize = 2;

/// `log2(MAX_HARMONICS) * LEVELS_PER_OCTAVE`: from 512 partials down to 1 (the
/// last rung rounds `512 * 2^(-17/2)` = 1.4 to 1, so 1 is not repeated).
pub const LEVEL_COUNT: usize = 9 * LEVELS_PER_OCTAVE;

/// Fixed-point fraction bits of a table sample: entries are the waveform
/// (`i8` scale) times 16, so the table's own rounding sits 24 dB under the
/// reference's `i8` quantisation instead of at it.
pub const FRAC_BITS: u32 = 4;

/// Mask for a 16.16 table phase.
const PHASE_MASK: u64 = ((TABLE_SIZE as u64) << 16) - 1;

/// Tables kept before the cache is dropped and rebuilt on demand. Tables are
/// pure functions of their key, so eviction can only cost time, never change
/// a sample.
///
/// The ceiling is bigger than the tables alone: each table is 8 KiB, so 4096
/// of them are 32 MiB, and every cached table hangs off a [`Source`] that is
/// not counted here -- 513 `Complex<f32>` (4104 B), its `<= 128 B` key and an
/// 18-slot level array (288 B), ~4.5 KiB each. A source holds at least one
/// table, so there are at most 4096 of them: up to ~18 MiB more, ~50 MiB in
/// all. A real song sits far below (tens of sources, a few hundred tables).
const MAX_CACHED_TABLES: usize = 4096;

/// Partials kept by level `j`: `MAX_HARMONICS * 2^(-j / LEVELS_PER_OCTAVE)`,
/// rounded, never below 1.
pub fn level_harmonics(level: usize) -> usize {
    let h = MAX_HARMONICS as f64 * (-(level as f64) / LEVELS_PER_OCTAVE as f64).exp2();
    (h.round() as usize).max(1)
}

/// The level for a voice stepping `f0` cycles per output sample: the first
/// (richest) level whose top partial is strictly under Nyquist
/// (`H * f0 < 0.5`; a partial exactly at Nyquist has no defined phase to
/// keep, so it is dropped too). A fundamental at or above Nyquist gets the
/// 1-partial level.
pub fn level_for(f0_cycles_per_sample: f64) -> usize {
    (0..LEVEL_COUNT).find(|&l| (level_harmonics(l) as f64) * f0_cycles_per_sample < 0.5).unwrap_or(LEVEL_COUNT - 1)
}

/// What a voice keeps between mixer calls: one band-limited cycle and how it
/// maps onto the voice's `0x280`-byte position.
#[derive(Clone)]
pub struct HifiOsc {
    table: Arc<[i16]>,
    /// `TABLE_SIZE / N`: the mixer position counts bytes of a `0x280` buffer
    /// that holds `0x280 / N` whole cycles, so `pos * ratio` is table phase.
    ratio: u64,
}

impl HifiOsc {
    /// The band-limited value at 16.16 buffer position `pos`, in `i8` scale
    /// times `1 << FRAC_BITS`; linearly interpolated.
    #[inline]
    pub fn sample(&self, pos: u32) -> i32 {
        let p = (pos as u64 * self.ratio) & PHASE_MASK;
        let i = (p >> 16) as usize;
        let frac = (p & 0xffff) as i32;
        let a = self.table[i] as i32;
        let b = self.table[(i + 1) & (TABLE_SIZE - 1)] as i32;
        a + (((b - a) * frac) >> 16)
    }
}

/// One table's spectrum plus the levels built from it so far.
struct Source {
    /// `c_0..=c_MAX_HARMONICS`, in `i8` units.
    coeffs: Vec<Complex<f32>>,
    levels: [Option<Arc<[i16]>>; LEVEL_COUNT],
}

/// How a [`HifiBank`] treats a table it does not have yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BankMode {
    /// Build it. At the cap, drop everything and start over.
    Lazy,
    /// Build it, but never evict: at the cap, stop building (`is_full`).
    Prewarm,
    /// Never build: count a miss and degrade (see the module docs). This is
    /// the mode the audio thread runs in once a song is prewarmed.
    Locked,
}

/// Lazy cache of band-limited cycles, keyed by table contents.
pub struct HifiBank {
    inverse: Arc<dyn Fft<f32>>,
    sources: FxHashMap<Box<[i8]>, Source>,
    cached_tables: usize,
    scratch: Vec<Complex<f32>>,
    mode: BankMode,
    /// Lookups a `Locked` bank could not serve from the exact level.
    misses: u64,
    /// A `Prewarm` bank wanted a table past the cap.
    full: bool,
}

impl Default for HifiBank {
    fn default() -> Self {
        Self::new()
    }
}

impl HifiBank {
    pub fn new() -> Self {
        let mut planner = FftPlanner::new();
        HifiBank {
            inverse: planner.plan_fft_inverse(TABLE_SIZE),
            sources: FxHashMap::default(),
            cached_tables: 0,
            scratch: vec![Complex::new(0.0, 0.0); TABLE_SIZE],
            mode: BankMode::Lazy,
            misses: 0,
            full: false,
        }
    }

    pub fn mode(&self) -> BankMode {
        self.mode
    }

    /// Switches mode. Entering `Prewarm` forgets an earlier `is_full`;
    /// entering `Locked` zeroes the miss count, so it counts from the lock.
    pub fn set_mode(&mut self, mode: BankMode) {
        match mode {
            BankMode::Prewarm => self.full = false,
            BankMode::Locked => self.misses = 0,
            BankMode::Lazy => {}
        }
        self.mode = mode;
    }

    /// Lookups since the bank was locked that the exact table could not
    /// serve. Zero means the audio thread built nothing and degraded nowhere.
    pub fn misses(&self) -> u64 {
        self.misses
    }

    /// A prewarm wanted more tables than the cache holds.
    pub fn is_full(&self) -> bool {
        self.full
    }

    /// Distinct table contents seen so far (diagnostics and tests).
    pub fn source_count(&self) -> usize {
        self.sources.len()
    }

    /// Mip tables built and currently cached.
    pub fn table_count(&self) -> usize {
        self.cached_tables
    }

    /// The oscillator for one cycle (`cycle.len()` is `4 << wave_length`) read
    /// at `f0_cycles_per_sample`; `None` for a silent table (the reference
    /// path already plays exactly that) and, in `Locked` mode, when the source
    /// has no level at or below the wanted one.
    pub fn oscillator(&mut self, cycle: &[i8], f0_cycles_per_sample: f64) -> Option<HifiOsc> {
        let n = cycle.len();
        debug_assert!(n.is_power_of_two() && (4..=128).contains(&n));
        if cycle.iter().all(|&b| b == 0) {
            return None;
        }
        let level = level_for(f0_cycles_per_sample);
        let table = match self.mode {
            BankMode::Locked => self.lookup(cycle, level),
            BankMode::Lazy | BankMode::Prewarm => self.get_or_build(cycle, level),
        }?;
        Some(HifiOsc { table, ratio: (TABLE_SIZE / n) as u64 })
    }

    /// `Locked`: the exact level, else the nearest built level with fewer
    /// partials (duller, still band-limited), else nothing.
    fn lookup(&mut self, cycle: &[i8], level: usize) -> Option<Arc<[i16]>> {
        let source = self.sources.get(cycle);
        if let Some(t) = source.and_then(|s| s.levels[level].as_ref()) {
            return Some(t.clone());
        }
        self.misses += 1;
        source?.levels[level..].iter().flatten().next().cloned()
    }

    fn get_or_build(&mut self, cycle: &[i8], level: usize) -> Option<Arc<[i16]>> {
        let have = self.sources.get(cycle).is_some_and(|s| s.levels[level].is_some());
        if !have && self.cached_tables >= MAX_CACHED_TABLES {
            if self.mode == BankMode::Prewarm {
                self.full = true;
                return None;
            }
            self.sources.clear();
            self.cached_tables = 0;
        }
        if !self.sources.contains_key(cycle) {
            self.sources.insert(cycle.into(), Source { coeffs: staircase_spectrum(cycle), levels: Default::default() });
        }
        let source = self.sources.get_mut(cycle).expect("inserted above");
        Some(match &source.levels[level] {
            Some(t) => t.clone(),
            None => {
                let t = build_level(&*self.inverse, &mut self.scratch, &source.coeffs, level_harmonics(level));
                source.levels[level] = Some(t.clone());
                self.cached_tables += 1;
                t
            }
        })
    }
}

/// Exact Fourier coefficients `c_0..=MAX_HARMONICS` of the zero-order-held
/// staircase of `cycle` (see the module docs), via a direct `N`-point DFT
/// (`N <= 128`, so ~16k multiply-adds; not worth a planner).
fn staircase_spectrum(cycle: &[i8]) -> Vec<Complex<f32>> {
    let n = cycle.len();
    let twiddle: Vec<(f64, f64)> = (0..n)
        .map(|m| {
            let a = -2.0 * std::f64::consts::PI * m as f64 / n as f64;
            (a.cos(), a.sin())
        })
        .collect();
    let dft: Vec<(f64, f64)> = (0..n)
        .map(|k| {
            let (mut re, mut im) = (0.0, 0.0);
            for (j, &x) in cycle.iter().enumerate() {
                let (c, s) = twiddle[(j * k) % n];
                re += x as f64 * c;
                im += x as f64 * s;
            }
            (re, im)
        })
        .collect();

    let mut out = Vec::with_capacity(MAX_HARMONICS + 1);
    out.push(Complex::new((dft[0].0 / n as f64) as f32, 0.0));
    for k in 1..=MAX_HARMONICS {
        let (xr, xi) = dft[k % n];
        let theta = std::f64::consts::PI * k as f64 / n as f64;
        // e^(-i*theta) * sin(theta) / (pi*k)
        let g = theta.sin() / (std::f64::consts::PI * k as f64);
        let (gr, gi) = (theta.cos() * g, -theta.sin() * g);
        out.push(Complex::new((xr * gr - xi * gi) as f32, (xr * gi + xi * gr) as f32));
    }
    out
}

/// One mip level: bins `1..=harmonics` (and their conjugates) populated, every
/// other bin zero -- `wavetable.rs`'s truncation -- then one inverse FFT.
fn build_level(inverse: &dyn Fft<f32>, scratch: &mut [Complex<f32>], coeffs: &[Complex<f32>], harmonics: usize) -> Arc<[i16]> {
    scratch.fill(Complex::new(0.0, 0.0));
    let m = TABLE_SIZE as f32;
    scratch[0] = coeffs[0] * m;
    for k in 1..=harmonics {
        let v = coeffs[k] * m;
        scratch[k] = v;
        scratch[TABLE_SIZE - k] = v.conj();
    }
    inverse.process(scratch);
    // rustfft's inverse is unscaled: dividing by M gives sum_k c_k e^(+i..)
    // and the `* m` above already put the coefficients on that scale.
    let scale = (1 << FRAC_BITS) as f32 / m;
    scratch.iter().map(|c| (c.re * scale).round().clamp(i16::MIN as f32, i16::MAX as f32) as i16).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_ladder_runs_from_full_band_to_one_partial() {
        assert_eq!(level_harmonics(0), MAX_HARMONICS);
        assert_eq!(level_harmonics(LEVEL_COUNT - 1), 1);
        for l in 1..LEVEL_COUNT {
            assert!(level_harmonics(l) < level_harmonics(l - 1));
        }
    }

    #[test]
    fn level_choice_never_lets_a_partial_pass_nyquist() {
        for i in 1..2000 {
            let f0 = i as f64 * 0.00025; // 0.00025 .. 0.5 cycles/sample
            let l = level_for(f0);
            assert!(level_harmonics(l) as f64 * f0 < 0.5 || l == LEVEL_COUNT - 1, "f0 {f0} level {l}");
            // ... and it is the richest such level.
            if l > 0 {
                assert!(level_harmonics(l - 1) as f64 * f0 >= 0.5, "f0 {f0}: level {} would also fit", l - 1);
            }
        }
        assert_eq!(level_for(0.0), 0);
        assert_eq!(level_for(0.9), LEVEL_COUNT - 1);
    }

    #[test]
    fn a_partial_exactly_at_nyquist_is_dropped() {
        // 4 partials at f0 = 0.125 sit exactly on Nyquist (0.5): not kept.
        let f0 = 0.125;
        assert_eq!(4.0 * f0, 0.5);
        let h = level_harmonics(level_for(f0));
        assert!((h as f64) * f0 < 0.5, "level keeps {h} partials");
    }

    fn osc(cycle: &[i8], f0: f64) -> HifiOsc {
        HifiBank::new().oscillator(cycle, f0).unwrap()
    }

    /// Value at the middle of table cell `j` of an `n`-point cycle.
    fn cell_mid(o: &HifiOsc, n: usize, j: usize) -> f64 {
        // buffer position of the cell's middle, 16.16
        let pos = ((j as f64 + 0.5) * 65536.0) as u32;
        assert!(n <= 128);
        o.sample(pos) as f64 / (1 << FRAC_BITS) as f64
    }

    #[test]
    fn full_band_level_reproduces_the_staircase_it_was_built_from() {
        // The lowest pitch selects level 0 (512 partials): mid-cell values
        // must sit on the reference's own bytes, away from the Gibbs edges.
        let cycle: [i8; 4] = [0, 0x7f, 0, -128];
        let o = osc(&cycle, 1e-5);
        for (j, &x) in cycle.iter().enumerate() {
            let v = cell_mid(&o, 4, j);
            assert!((v - x as f64).abs() < 2.0, "cell {j}: {v} vs {x}");
        }
    }

    #[test]
    fn a_wider_table_keeps_its_cells_too() {
        let cycle: Vec<i8> = (0..128).map(|i| if i < 100 { -128 } else { 127 }).collect();
        let o = osc(&cycle, 1e-5);
        for &j in &[10usize, 50, 90, 110, 120] {
            let v = cell_mid(&o, 128, j);
            assert!((v - cycle[j] as f64).abs() < 8.0, "cell {j}: {v}");
        }
    }

    #[test]
    fn dc_is_preserved() {
        let cycle: Vec<i8> = (0..128).map(|i| if i < 100 { -100 } else { 50 }).collect();
        let mean = cycle.iter().map(|&b| b as f64).sum::<f64>() / 128.0;
        for f0 in [1e-5, 0.01, 0.1] {
            let o = osc(&cycle, f0);
            // Mean of the interpolated table over one cycle.
            let total: f64 = (0..TABLE_SIZE).map(|i| o.sample((i as u64 * (128u64 << 16) / TABLE_SIZE as u64) as u32) as f64).sum();
            let got = total / TABLE_SIZE as f64 / (1 << FRAC_BITS) as f64;
            assert!((got - mean).abs() < 0.3, "f0 {f0}: mean {got} vs {mean}");
        }
    }

    #[test]
    fn a_level_has_no_energy_above_its_partial_count() {
        let cycle: Vec<i8> = (0..64).map(|i| if i < 20 { -128 } else { 127 }).collect();
        let mut bank = HifiBank::new();
        let f0 = 0.05; // 10 partials fit under Nyquist
        let o = bank.oscillator(&cycle, f0).unwrap();
        let h = level_harmonics(level_for(f0));
        assert!(h as f64 * f0 < 0.5);
        let mut spec: Vec<Complex<f32>> = o.table.iter().map(|&s| Complex::new(s as f32, 0.0)).collect();
        FftPlanner::new().plan_fft_forward(TABLE_SIZE).process(&mut spec);
        let peak = spec[1..=h].iter().map(|c| c.norm()).fold(0.0, f32::max);
        let above = spec[h + 2..TABLE_SIZE / 2].iter().map(|c| c.norm()).fold(0.0, f32::max);
        assert!(above < peak * 1e-3, "energy above H={h}: {above} vs peak {peak}");
    }

    #[test]
    fn silent_table_falls_back_and_equal_contents_share_levels() {
        let mut bank = HifiBank::new();
        assert!(bank.oscillator(&[0i8; 8], 0.01).is_none());
        let a: Vec<i8> = (0..32).map(|i| if i < 9 { 10 } else { -10 }).collect();
        bank.oscillator(&a, 0.01).unwrap();
        bank.oscillator(&a.clone(), 0.01).unwrap();
        assert_eq!((bank.source_count(), bank.table_count()), (1, 1));
        bank.oscillator(&a, 0.2).unwrap();
        assert_eq!((bank.source_count(), bank.table_count()), (1, 2));
    }

    fn table_ptr(o: &HifiOsc) -> *const i16 {
        o.table.as_ptr()
    }

    #[test]
    fn a_locked_bank_never_builds_and_degrades_to_a_duller_level() {
        let cycle: Vec<i8> = (0..32).map(|i| if i < 9 { 90 } else { -30 }).collect();
        let mut bank = HifiBank::new();
        // Prewarm two levels: the one for a slow note and a coarser one.
        let slow = bank.oscillator(&cycle, 0.01).unwrap();
        let coarse = bank.oscillator(&cycle, 0.2).unwrap();
        let built = bank.table_count();
        bank.set_mode(BankMode::Locked);
        assert_eq!(bank.misses(), 0);

        // Exact hits are free and count nothing.
        assert_eq!(table_ptr(&bank.oscillator(&cycle, 0.01).unwrap()), table_ptr(&slow));
        assert_eq!(bank.misses(), 0);

        // A pitch that wants a level in between: served by the next coarser
        // one built (fewer partials -- never aliased), counted, nothing built.
        let mid_f0 = 0.05;
        assert!(level_for(mid_f0) > level_for(0.01) && level_for(mid_f0) < level_for(0.2));
        assert_eq!(table_ptr(&bank.oscillator(&cycle, mid_f0).unwrap()), table_ptr(&coarse));
        assert_eq!((bank.misses(), bank.table_count()), (1, built));

        // A table never seen has nothing to stand in for it: reference path.
        let other: Vec<i8> = (0..32).map(|i| if i < 20 { 90 } else { -30 }).collect();
        assert!(bank.oscillator(&other, 0.01).is_none());
        assert_eq!(bank.table_count(), built, "a locked bank built a table");
        assert_eq!(bank.source_count(), 1);
    }

    #[test]
    fn a_locked_miss_with_nothing_coarser_falls_back_to_the_reference() {
        let cycle: Vec<i8> = (0..16).map(|i| if i < 5 { 60 } else { -20 }).collect();
        let mut bank = HifiBank::new();
        bank.oscillator(&cycle, 0.2).unwrap(); // only a coarse level exists
        bank.set_mode(BankMode::Locked);
        // A slow note wants a far richer level than the one built: the built
        // one has *fewer* partials, so it is the stand-in that exists.
        assert!(bank.oscillator(&cycle, 0.001).is_some());
        // But a fast note asking for a coarser level than anything built has none.
        let fast = level_for(0.45);
        assert!(fast > level_for(0.2));
        assert!(bank.oscillator(&cycle, 0.45).is_none());
        assert_eq!(bank.misses(), 2);
    }

    #[test]
    fn locking_zeroes_the_miss_count_and_prewarm_never_evicts() {
        let cycle: Vec<i8> = (0..8).map(|i| if i < 3 { 50 } else { -50 }).collect();
        let mut bank = HifiBank::new();
        bank.set_mode(BankMode::Locked);
        assert!(bank.oscillator(&cycle, 0.01).is_none());
        assert_eq!(bank.misses(), 1);
        bank.set_mode(BankMode::Prewarm);
        bank.oscillator(&cycle, 0.01).unwrap();
        assert!(!bank.is_full());
        bank.set_mode(BankMode::Locked);
        assert_eq!(bank.misses(), 0);
    }
}
