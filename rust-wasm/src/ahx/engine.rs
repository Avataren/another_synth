//! `AhxEngine`: the transport + mixer around the per-channel `Voice`s.
//! Ported from `hvl_InitSubsong` (`hvl_replay.c:67-113`), `hvl_process_step`
//! and its three effect passes (`:621-979`), `hvl_play_irq` (`:1635-1697`),
//! `hvl_mixchunk` (`:1699-1800`) and `hvl_DecodeFrame` (`:1802-1817`).
//!
//! Plain Rust, no wasm bindings (P3 scope). Output is interleaved `i16`
//! stereo, exactly what `hvl_DecodeFrame` writes, so it can be compared
//! byte-for-byte against the C reference (see `tests/ahx_render_golden.rs`).
//!
//! ## Channel count
//!
//! The song decides: AHX is always 4 voices, HVL plays its native
//! `(buf[8]>>2)+4` (`hvl_load_hvl:399`, `ht_Channels`). The one boundary point
//! is [`AhxEngine::new`]; nothing downstream knows a channel count of its own.
//! Voices beyond the fourth follow the reference unchanged: default pan repeats
//! L/R/R/L per group of four (`hvl_InitSubsong:90-108`) and every voice mixes
//! through the same `hvl_mixchunk` loop. The reference sizes its voice array at
//! [`MAX_CHANNELS`]; a wider (malformed) song is clamped to it and
//! [`AhxEngine::dropped_channels`] says how many were cut -- 0 for every real
//! file. [`AhxEngine::with_channel_cap`] truncates on purpose so tests can
//! compare a partial channel count against the reference; it is a
//! verification hook, not a product mode.

use super::format::{Song, SongFormat, Step, MAX_CHANNELS};
use super::hifi::{BankMode, HifiBank, FRAC_BITS};
use super::voice::{panning_left, panning_right, Voice};
use super::waveform::WAVES;
use super::wrap_i16;

/// `defgain[]`, `hvl_load_ahx` (`hvl_replay.c:127`). AHX carries no mix gain
/// in the file; the caller's stereo-separation choice picks it.
const AHX_DEFGAIN: [i32; 5] = [71, 72, 76, 85, 100];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineError {
    /// `freq / 50 / speed_multiplier == 0` (sample rate too low to render a tick).
    SampleRateTooLow,
    /// The song has no positions or no tracks to play.
    EmptySong,
    /// `with_channel_cap(.., 0)`: an engine needs at least one voice.
    InvalidChannelCap,
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::SampleRateTooLow => write!(f, "sample rate too low for a 50 Hz tick"),
            EngineError::EmptySong => write!(f, "song has no positions or tracks"),
            EngineError::InvalidChannelCap => write!(f, "channel cap must be at least 1"),
        }
    }
}

impl std::error::Error for EngineError {}

/// The `ht_*` transport fields (`hvl_replay.h:190-226`). Types follow the
/// reference: the 16-bit ones wrap on store.
#[derive(Debug, Clone, Default)]
struct Transport {
    tempo: i32,
    pos_nr: i32,
    note_nr: i32,
    pos_jump: i32,
    pos_jump_note: i32,
    pattern_break: bool,
    get_new_position: bool,
    step_wait_frames: i32,
    song_end_reached: bool,
    playing_time: u32,
}

/// What [`AhxEngine::prewarm_hifi`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HifiPrewarm {
    /// Engine ticks simulated, over all subsongs.
    pub ticks: u64,
    /// Song laps walked (a lap ends where the engine raises its end flag).
    pub laps: u32,
    /// Mip tables cached afterwards.
    pub tables: usize,
    /// Distinct table contents cached afterwards.
    pub sources: usize,
    /// Every subsong went `PREWARM_QUIET_LAPS` laps in a row without wanting a
    /// table it had not built. False: a tick cap or the cache cap stopped it.
    pub converged: bool,
    /// The cache filled up: some tables were left out.
    pub cache_full: bool,
}

/// Laps in a row that must add no table before a subsong's simulation stops.
/// Voices carry their state across a wrap (a sweep is not back where it
/// started when the song is), so lap 2 is not lap 1 again; the cache stops
/// growing when the state's orbit has been walked.
const PREWARM_QUIET_LAPS: u32 = 2;

/// Cap on simulated ticks per subsong, for songs that never raise the end
/// flag (a `Bxx` loop back) or never stop finding new tables: 15 minutes at
/// 50 Hz, scaled by the speed multiplier (which multiplies the tick rate).
const PREWARM_MAX_TICKS: u64 = 50 * 60 * 15;

/// Frames each voice's capture ring holds (a power of two, so the write index
/// wraps with a mask). 2048 frames is ~46 ms at 44.1 kHz.
pub const CAPTURE_FRAMES: usize = 2048;
const CAPTURE_MASK: usize = CAPTURE_FRAMES - 1;

/// Per-voice scope capture (see [`AhxEngine::enable_capture`]): one ring of
/// `CAPTURE_FRAMES` mono `i16` per voice, voice-major, plus the total number
/// of frames written. Write-only from the mixer's side: nothing in the mix
/// reads it back.
struct Capture {
    ring: Vec<i16>,
    written: u64,
}

impl Capture {
    fn new(channels: usize) -> Self {
        Capture { ring: vec![0; channels * CAPTURE_FRAMES], written: 0 }
    }

    fn clear(&mut self) {
        self.ring.fill(0);
        self.written = 0;
    }
}

pub struct AhxEngine {
    song: Song,
    waves: &'static [i8],
    freq: u32,
    freq_f: f64,
    channels: usize,
    dropped_channels: usize,
    mixgain: i32,
    defstereo: usize,
    /// `ht_Version`. Only HVL files set it (`hvl_load_hvl:384`); the AHX
    /// loader leaves it uninitialised in the reference, so AHX is 0 here.
    version: u8,
    voices: Vec<Voice>,
    t: Transport,
    /// `freq / 50 / speed_multiplier` (`hvl_DecodeFrame:1806`).
    tick_samples: usize,
    tick_remaining: usize,
    /// `None` (the default) means the mixer runs the capture-free
    /// monomorphisation of `mix_chunk`.
    capture: Option<Capture>,
    /// Bit `i` set: voice `i` is muted (contributes 0 to the mix).
    mute_mask: u32,
    /// Any bit set: only the voices with their bit set are heard.
    solo_mask: u32,
    /// `Some` while hi-fi rendering is on (see `hifi.rs`); the bank is the
    /// lazy mip cache. `None` (the default) is the reference mixer, untouched.
    hifi: Option<HifiBank>,
    /// The subsong `init_subsong` last started; `seek` replays this one.
    subsong: usize,
    /// When set, a position that runs off its last row starts over instead of
    /// moving on (see [`set_loop_position`](AhxEngine::set_loop_position)).
    loop_position: bool,
}

/// How a [`seek`](AhxEngine::seek) got to its target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeekKind {
    /// The song's own flow reaches the target, and the engine was replayed
    /// (tick by tick, mixing skipped) to it: every voice is exactly as if the
    /// song had been rendered from the top to that point.
    Exact,
    /// The song's flow never lands on the target (a `Bxx` jumps over the
    /// position, a `Dxx` breaks out before the row), so the engine starts
    /// there cold: fresh voices, the default speed.
    Cold,
}

/// A replay that has not reached its target after this many ticks gives up:
/// a song that jumps back on itself forever (`Bxx` to an earlier position with
/// no song end) would otherwise never finish. 400 000 ticks is over two hours
/// at 50 Hz; a replay tick costs a few microseconds.
const MAX_SEEK_TICKS: u32 = 400_000;

impl AhxEngine {
    /// `defstereo` (0..=4) is only used for AHX songs (stereo separation and
    /// mix gain, `hvl_load_ahx:182-185`); HVL songs carry their own. Plays
    /// every channel of the song (see the module docs).
    pub fn new(song: Song, freq: u32, defstereo: u8) -> Result<Self, EngineError> {
        Self::build(song, freq, defstereo, MAX_CHANNELS)
    }

    /// As [`new`](Self::new) but plays at most the first `cap` channels
    /// (clamped to `MAX_CHANNELS`). Verification hook, not a product mode:
    /// hidden from the docs, and a cap of 0 is an error rather than a silent
    /// zero-voice engine.
    #[doc(hidden)]
    pub fn with_channel_cap(song: Song, freq: u32, defstereo: u8, cap: usize) -> Result<Self, EngineError> {
        if cap == 0 {
            return Err(EngineError::InvalidChannelCap);
        }
        Self::build(song, freq, defstereo, cap)
    }

    fn build(song: Song, freq: u32, defstereo: u8, cap: usize) -> Result<Self, EngineError> {
        let tick_samples = (freq / 50 / song.speed_multiplier.max(1) as u32) as usize;
        if tick_samples == 0 {
            return Err(EngineError::SampleRateTooLow);
        }
        if song.positions.is_empty() || song.tracks.is_empty() {
            return Err(EngineError::EmptySong);
        }

        let channels = song.channels.min(cap.min(MAX_CHANNELS));
        let (defstereo, mixgain) = match song.format {
            SongFormat::Ahx => {
                let d = (defstereo as usize).min(4);
                (d, AHX_DEFGAIN[d] * 256 / 100)
            }
            SongFormat::Hvl => {
                let d = (song.defstereo.unwrap_or(0) as usize).min(4);
                (d, ((song.mixgain_raw.unwrap_or(0) as i32) << 8) / 100)
            }
        };
        let version = if song.format == SongFormat::Hvl { song.version } else { 0 };

        let mut engine = AhxEngine {
            waves: WAVES.as_slice(),
            freq,
            freq_f: freq as f64,
            channels,
            dropped_channels: song.channels - channels,
            mixgain,
            defstereo,
            version,
            voices: Vec::new(),
            t: Transport::default(),
            tick_samples,
            tick_remaining: 0,
            capture: None,
            mute_mask: 0,
            solo_mask: 0,
            hifi: None,
            subsong: 0,
            loop_position: false,
            song,
        };
        engine.init_subsong(0);
        Ok(engine)
    }

    /// `hvl_InitSubsong`, `hvl_replay.c:67-113`. Returns `false` for an
    /// out-of-range subsong number.
    pub fn init_subsong(&mut self, nr: usize) -> bool {
        if nr > self.song.subsong_nr as usize {
            return false;
        }
        let pos_nr = if nr > 0 { self.song.subsongs[nr - 1] as i32 } else { 0 };
        self.subsong = nr;
        self.t = Transport {
            tempo: 6,
            pos_nr,
            get_new_position: true,
            ..Transport::default()
        };

        // hvl_reset_some_stuff (`:26-64`) is a fresh Voice; the pan fields it
        // does not touch are then (re)set here, as InitSubsong does before it.
        self.voices = (0..self.channels)
            .map(|i| {
                let mut v = Voice::new();
                v.set_default_pan(i, self.defstereo);
                v
            })
            .collect();
        self.tick_remaining = 0;
        // A rewound song must not show the previous run's tail.
        if let Some(c) = self.capture.as_mut() {
            c.clear();
        }
        true
    }

    /// Puts the engine at `(pos, row)` of the current subsong, at a tick
    /// boundary, so the next `render_block` starts on that row's first sample.
    /// `None` (nothing changes) when either is out of range.
    ///
    /// The engine has no random access: a voice's state at a row is the whole
    /// song before it. So this replays the subsong from its start, running the
    /// transport and the voices tick by tick but *not mixing*. The mixer's
    /// only effect on the engine is to advance each voice's sample phase
    /// (`sample_pos`, `ring_sample_pos`), which is modular arithmetic on the
    /// tick's delta, so [`skip_mix`](Self::skip_mix) applies it in closed form.
    /// The result is bit-identical to rendering from the top to the same tick
    /// (`tests/ahx_seek.rs` renders both and compares them), at the cost of
    /// one `play_irq` per tick instead of one per sample per voice. Measured
    /// on the corpus (native release, hi-fi on): the deepest row of the longest
    /// song (128 positions, 29k ticks) takes about 10 ms, the worst of any song
    /// 15 ms, typically 2-5 ms; a render quantum is 3 ms, so a seek on the
    /// audio thread costs a few quanta, at the moment the old voices are being
    /// cut anyway.
    ///
    /// Injecting state instead (jumping the transport and giving the voices
    /// the values they "would" have) was rejected: a voice's wave phase,
    /// envelope, vibrato, filter and square sweeps, portamento and ring
    /// modulation are all history, and reproducing them without replaying is
    /// a second implementation of the whole voice to keep bit-exact.
    ///
    /// The replay always runs in the song's own flow, whatever
    /// [`set_loop_position`](Self::set_loop_position) says: it is put back
    /// afterwards, and a loop that keeps the replay on the first position
    /// would never get anywhere. Mute/solo, hi-fi and capture are untouched
    /// (capture's ring is cleared, as after a restart).
    pub fn seek(&mut self, pos: usize, row: usize) -> Option<SeekKind> {
        if pos >= self.song.position_nr as usize || row >= self.song.track_length as usize {
            return None;
        }
        let looping = std::mem::replace(&mut self.loop_position, false);
        self.init_subsong(self.subsong);
        let mut kind = SeekKind::Cold;
        for _ in 0..=MAX_SEEK_TICKS {
            // The top of a row: its step is what the next tick plays.
            if self.t.step_wait_frames == 0 && self.t.pos_nr == pos as i32 && self.t.note_nr == row as i32 {
                kind = SeekKind::Exact;
                // Reached by the wrap to the restart position: a seek is a
                // fresh start there, not the end of the song.
                self.t.song_end_reached = false;
                break;
            }
            // The song has wrapped: everything it will ever play was played.
            if self.t.song_end_reached {
                break;
            }
            self.play_irq();
            self.skip_mix(self.tick_samples);
        }
        if kind == SeekKind::Cold {
            self.init_subsong(self.subsong);
            self.t.pos_nr = pos as i32;
            self.t.note_nr = row as i32;
        }
        self.loop_position = looping;
        Some(kind)
    }

    /// What `mix_chunk` leaves behind for `samples` frames, without the mix:
    /// each voice's phase moved on by `samples * delta`, modulo the wave
    /// length. `mix_chunk` wraps a phase at `END` only when it reaches it, so
    /// it may store one still `>= END`; the next chunk reduces it before use,
    /// which is what this does at once.
    fn skip_mix(&mut self, samples: usize) {
        const END: u64 = 0x280 << 16;
        for v in self.voices.iter_mut().take(self.channels) {
            v.sample_pos = ((v.sample_pos as u64 % END + samples as u64 * v.delta as u64) % END) as u32;
            if v.ring_mix_active {
                v.ring_sample_pos =
                    ((v.ring_sample_pos as u64 % END + samples as u64 * v.ring_delta as u64) % END) as u32;
            }
        }
    }

    /// Loop the current position: when it runs off its last row it starts over
    /// at row 0 rather than moving to the next one, and never reaches the
    /// song's end. `Bxx` and `Dxx` still take effect (they move the loop),
    /// which is what "play pattern" does for the other formats. Off by
    /// default; off is the reference transport, byte for byte.
    pub fn set_loop_position(&mut self, on: bool) {
        self.loop_position = on;
    }

    pub fn loop_position(&self) -> bool {
        self.loop_position
    }

    /// Turns per-voice waveform capture on or off. Off by default. While on,
    /// `mix_chunk` also records each voice's own contribution (after ring
    /// modulation and volume, before pan and mix gain) into a
    /// [`CAPTURE_FRAMES`]-frame ring, for [`read_channel_snapshot`](Self::read_channel_snapshot).
    /// It only ever *reads* the values the mix already computed, so the mixed
    /// output is bit-identical either way (`capture_never_changes_mixed_samples`,
    /// and the render goldens run with capture on as well as off). Turning it
    /// off frees the rings; turning it on when it already is keeps them.
    pub fn enable_capture(&mut self, on: bool) {
        match (on, self.capture.is_some()) {
            (true, false) => self.capture = Some(Capture::new(self.channels)),
            (false, true) => self.capture = None,
            _ => {}
        }
    }

    pub fn capture_enabled(&self) -> bool {
        self.capture.is_some()
    }

    /// Turns band-limited ("hi-fi") oscillators on or off. Off by default.
    /// Off is the reference render, byte for byte -- the mixer instance that
    /// runs then has no hi-fi code in it -- so this is the one switch between
    /// "what the reference plays" and "the reference minus its aliasing"; see
    /// `hifi.rs` for exactly what changes. Song state and timing never depend
    /// on it, so it can be flipped mid-song (the next tick picks it up), and
    /// it survives a rewind.
    pub fn set_hifi(&mut self, on: bool) {
        match (on, self.hifi.is_some()) {
            (true, false) => self.hifi = Some(HifiBank::new()),
            (false, true) => {
                self.hifi = None;
                for v in self.voices.iter_mut() {
                    v.hifi = None;
                }
            }
            _ => {}
        }
    }

    pub fn hifi_enabled(&self) -> bool {
        self.hifi.is_some()
    }

    /// Builds, ahead of playback, the band-limited tables the song will ask
    /// for, then locks the bank so the render path can never build one (see
    /// `hifi.rs`). A no-op returning the default while hi-fi is off.
    ///
    /// The engine is deterministic and hi-fi never feeds back into song
    /// state, so what a song will ask for is found by *running* it: every
    /// subsong from its start, ticks only (no mixing), lap after lap until
    /// [`PREWARM_QUIET_LAPS`] laps in a row add nothing (or the tick cap).
    /// That is exact for the tables (the filter row, square width and wave
    /// length a voice actually holds on each tick, at its actual pitch) where
    /// a static walk of the instrument list could only over-approximate: a
    /// filter sweep and a square sweep across 63 rows and 32 widths would be
    /// ~20k tables per wave length. It does not touch the real playback state:
    /// voices, transport, tick phase and capture are set aside and put back,
    /// so it can run mid-song.
    ///
    /// What it cannot promise is that playback never reaches a state the
    /// simulation did not: the lock is what makes that harmless. A miss
    /// degrades to a duller level for a tick and is counted in
    /// [`hifi_misses`](Self::hifi_misses) -- never a build on the audio thread.
    pub fn prewarm_hifi(&mut self) -> HifiPrewarm {
        let Some(bank) = self.hifi.as_mut() else {
            return HifiPrewarm::default();
        };
        bank.set_mode(BankMode::Prewarm);

        let saved_voices = std::mem::take(&mut self.voices);
        let saved_t = std::mem::take(&mut self.t);
        // `init_subsong` below walks every subsong; playback stays on its own.
        let saved_subsong = self.subsong;
        let saved_remaining = self.tick_remaining;
        let saved_capture = self.capture.take();

        let cap = PREWARM_MAX_TICKS * self.song.speed_multiplier.max(1) as u64;
        let (mut ticks, mut laps, mut converged) = (0u64, 0u32, true);
        for subsong in 0..=self.song.subsong_nr as usize {
            self.init_subsong(subsong);
            let (mut subsong_ticks, mut quiet) = (0u64, 0u32);
            let mut tables_at_lap_start = self.hifi_table_count();
            loop {
                self.play_irq();
                subsong_ticks += 1;
                if self.t.song_end_reached {
                    self.t.song_end_reached = false;
                    laps += 1;
                    let tables = self.hifi_table_count();
                    quiet = if tables == tables_at_lap_start { quiet + 1 } else { 0 };
                    tables_at_lap_start = tables;
                    if quiet >= PREWARM_QUIET_LAPS {
                        break;
                    }
                }
                let full = self.hifi.as_ref().is_some_and(HifiBank::is_full);
                if subsong_ticks >= cap || full {
                    converged = false;
                    break;
                }
            }
            ticks += subsong_ticks;
        }

        self.voices = saved_voices;
        self.t = saved_t;
        self.subsong = saved_subsong;
        self.tick_remaining = saved_remaining;
        self.capture = saved_capture;

        let bank = self.hifi.as_mut().expect("still on");
        bank.set_mode(BankMode::Locked);
        HifiPrewarm {
            ticks,
            laps,
            tables: bank.table_count(),
            sources: bank.source_count(),
            converged,
            cache_full: bank.is_full(),
        }
    }

    /// Band-limited lookups since the last prewarm that the exact table could
    /// not serve; zero while hi-fi is off or the bank is not locked yet.
    /// Zero after a prewarm means the audio thread built nothing and degraded
    /// nowhere.
    pub fn hifi_misses(&self) -> u64 {
        self.hifi.as_ref().map_or(0, HifiBank::misses)
    }

    /// Mip tables the bank holds (0 while hi-fi is off).
    pub fn hifi_table_count(&self) -> usize {
        self.hifi.as_ref().map_or(0, HifiBank::table_count)
    }

    /// Whether the bank is locked (prewarmed) rather than building lazily.
    pub fn hifi_locked(&self) -> bool {
        self.hifi.as_ref().is_some_and(|b| b.mode() == BankMode::Locked)
    }

    /// Live mute/solo. Bit `i` of `mute` mutes voice `i`; when `solo` has any
    /// bit set, only the voices with their solo bit set are heard (a soloed
    /// voice that is also muted stays silent). A silenced voice still runs --
    /// its oscillator, envelope and effects advance exactly as if it were
    /// audible -- it just contributes 0 to the mix, so un-muting it picks up
    /// in step and the song timing never depends on the state. With both masks
    /// 0 (the default) the mixer sees the unmodified voice volumes: the output
    /// is bit-identical to an engine that never heard of this
    /// (`mute_solo_off_is_bit_identical`, and the render goldens). The state
    /// belongs to the engine, not the song position: a rewind keeps it.
    ///
    /// Capture records what the mixer used, so a silenced voice's scope trace
    /// is flat: the scopes show what you hear.
    pub fn set_mute_solo(&mut self, mute: u32, solo: u32) {
        self.mute_mask = mute;
        self.solo_mask = solo;
    }

    /// `(mute, solo)` as last set.
    pub fn mute_solo(&self) -> (u32, u32) {
        (self.mute_mask, self.solo_mask)
    }

    /// Whether the mix currently drops voice `i` (muted, or not soloed while
    /// some other voice is).
    pub fn voice_silenced(&self, i: usize) -> bool {
        let bit = 1u32.checked_shl(i as u32).unwrap_or(0);
        self.mute_mask & bit != 0 || (self.solo_mask != 0 && self.solo_mask & bit == 0)
    }

    /// The output gain applied after the voices are summed (`ahx_defgain`).
    #[doc(hidden)]
    pub fn mix_gain(&self) -> i32 {
        self.mixgain
    }

    /// Fills `out` with the most recent `out.len()` points of `voice`'s
    /// waveform, oldest first, and returns how many it wrote: 0 with capture
    /// off, an out-of-range `voice`, or an empty `out`.
    ///
    /// The window is `CAPTURE_FRAMES` frames, decimated by box-averaging, so
    /// `out.len()` is capped at `CAPTURE_FRAMES` and the window shrinks to
    /// `out.len() * (CAPTURE_FRAMES / out.len())` frames when that does not
    /// divide evenly. A voice's full-scale value is `+-8192` (`s8 * volume 64`).
    /// Writes only into `out`; no allocation.
    pub fn read_channel_snapshot(&self, voice: usize, out: &mut [i16]) -> usize {
        let Some(c) = self.capture.as_ref() else { return 0 };
        if voice >= self.channels || out.is_empty() {
            return 0;
        }
        let n = out.len().min(CAPTURE_FRAMES);
        let stride = CAPTURE_FRAMES / n;
        let ring = &c.ring[voice * CAPTURE_FRAMES..(voice + 1) * CAPTURE_FRAMES];
        // Frames not written yet read as the ring's initial zeros; the
        // wrapping subtraction keeps the low bits (all the mask looks at) right.
        let start = c.written.wrapping_sub((n * stride) as u64) as usize;
        for (k, o) in out[..n].iter_mut().enumerate() {
            let base = start.wrapping_add(k * stride);
            let sum: i32 = (0..stride).map(|m| ring[(base + m) & CAPTURE_MASK] as i32).sum();
            *o = (sum / stride as i32) as i16;
        }
        n
    }

    pub fn sample_rate(&self) -> u32 {
        self.freq
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    pub fn dropped_channels(&self) -> usize {
        self.dropped_channels
    }

    pub fn song(&self) -> &Song {
        &self.song
    }

    pub fn voice(&self, i: usize) -> &Voice {
        &self.voices[i]
    }

    pub fn tempo(&self) -> i32 {
        self.t.tempo
    }

    pub fn pos_nr(&self) -> i32 {
        self.t.pos_nr
    }

    pub fn note_nr(&self) -> i32 {
        self.t.note_nr
    }

    pub fn song_end_reached(&self) -> bool {
        self.t.song_end_reached
    }

    /// `ht_PlayingTime`: ticks played so far.
    pub fn ticks_played(&self) -> u32 {
        self.t.playing_time
    }

    /// Samples produced per tick (`hvl_DecodeFrame`'s `samples`).
    pub fn samples_per_tick(&self) -> usize {
        self.tick_samples
    }

    /// Renders `out.len() / 2` stereo frames, interleaved `L, R, L, R...`.
    /// Any block size works: a tick that does not fit is finished by the
    /// next call. Rendering `samples_per_tick() * speed_multiplier` frames
    /// from a fresh engine reproduces one `hvl_DecodeFrame` call exactly.
    pub fn render_block(&mut self, out: &mut [i16]) {
        let frames = out.len() / 2;
        let mut done = 0usize;
        while done < frames {
            if self.tick_remaining == 0 {
                self.play_irq();
                self.tick_remaining = self.tick_samples;
            }
            let n = self.tick_remaining.min(frames - done);
            let chunk = &mut out[done * 2..(done + n) * 2];
            match (self.capture.is_some(), self.hifi.is_some()) {
                (false, false) => self.mix_chunk::<false, false>(n, chunk),
                (true, false) => self.mix_chunk::<true, false>(n, chunk),
                (false, true) => self.mix_chunk::<false, true>(n, chunk),
                (true, true) => self.mix_chunk::<true, true>(n, chunk),
            }
            self.tick_remaining -= n;
            done += n;
        }
    }

    fn step_at(&self, track: usize, note: i32) -> Step {
        // Out-of-range reads are UB in the reference (`ht_Tracks[256][64]`
        // with unvalidated track/row numbers); an empty step is the safe
        // reading. Reachable e.g. via `Dxx` with xx == track_length.
        self.song
            .tracks
            .get(track)
            .and_then(|t| if note >= 0 { t.get(note as usize) } else { None })
            .copied()
            .unwrap_or_default()
    }

    /// `hvl_play_irq`, `hvl_replay.c:1635-1697`.
    fn play_irq(&mut self) {
        let position_nr = self.song.position_nr as i32;

        if self.t.step_wait_frames == 0 {
            if self.t.get_new_position {
                let cur = self.t.pos_nr as usize;
                let nextpos = if self.t.pos_nr + 1 == position_nr { 0 } else { cur + 1 };
                for i in 0..self.channels {
                    let v = &mut self.voices[i];
                    v.track = self.song.positions[cur].track[i] as usize;
                    v.transpose = self.song.positions[cur].transpose[i] as i32;
                    v.next_track = self.song.positions[nextpos].track[i] as usize;
                    v.next_transpose = self.song.positions[nextpos].transpose[i] as i32;
                }
                self.t.get_new_position = false;
            }

            for i in 0..self.channels {
                self.process_step(i);
            }
            self.t.step_wait_frames = self.t.tempo;
        }

        for i in 0..self.channels {
            self.process_frame(i);
        }

        self.t.playing_time += 1;
        self.t.step_wait_frames = (self.t.step_wait_frames - 1) & 0xffff;
        if self.t.step_wait_frames == 0 {
            if !self.t.pattern_break {
                self.t.note_nr += 1;
                if self.t.note_nr >= self.song.track_length as i32 {
                    self.t.pos_jump = if self.loop_position { self.t.pos_nr } else { self.t.pos_nr + 1 };
                    self.t.pos_jump_note = 0;
                    self.t.pattern_break = true;
                }
            }

            if self.t.pattern_break {
                self.t.pattern_break = false;
                self.t.pos_nr = self.t.pos_jump;
                self.t.note_nr = self.t.pos_jump_note;
                // `==` in the reference; a jump *past* the end (e.g. `B99`)
                // would index out of `ht_Positions`, so treat it the same.
                if self.t.pos_nr >= position_nr {
                    self.t.song_end_reached = true;
                    self.t.pos_nr = self.song.restart as i32;
                }
                self.t.pos_jump_note = 0;
                self.t.pos_jump = 0;
                self.t.get_new_position = true;
            }
        }

        for i in 0..self.channels {
            self.voices[i].set_audio(self.waves, self.freq_f);
        }
        if let Some(bank) = self.hifi.as_mut() {
            for v in self.voices.iter_mut().take(self.channels) {
                v.select_hifi(bank);
            }
        }
    }

    /// The per-frame half of `hvl_process_frame` that needs song/transport
    /// access; the DSP body is `Voice::process_frame_dsp`.
    fn process_frame(&mut self, i: usize) {
        if !self.voices[i].track_on {
            return;
        }

        // Note-delay re-entry, `hvl_replay.c:1132-1138`.
        if self.voices[i].note_delay_on {
            if self.voices[i].note_delay_wait <= 0 {
                self.process_step(i);
            } else {
                self.voices[i].note_delay_wait -= 1;
            }
        }

        // Look-ahead for HardCut, `:1140-1149`.
        let next_inst = if self.voices[i].hard_cut != 0 {
            let v = &self.voices[i];
            if self.t.note_nr + 1 < self.song.track_length as i32 {
                self.step_at(v.track, self.t.note_nr + 1).instrument
            } else {
                self.step_at(v.next_track, 0).instrument
            }
        } else {
            0
        };

        let voice = &mut self.voices[i];
        let ins = &self.song.instruments[voice.instrument_idx as usize];
        voice.process_frame_dsp(ins, self.waves, self.t.tempo, next_inst);
    }

    /// `hvl_process_step`, `hvl_replay.c:814-979`.
    fn process_step(&mut self, i: usize) {
        if !self.voices[i].track_on {
            return;
        }
        self.voices[i].volume_slide_up = 0;
        self.voices[i].volume_slide_down = 0;

        let track = self.song.positions[self.t.pos_nr as usize].track[i] as usize;
        let step = self.step_at(track, self.t.note_nr);
        let mut note = step.note as i32;
        let instr = step.instrument;

        // Note delay (1.6), `:831-869`.
        let mut donenotedel = false;
        let voice = &mut self.voices[i];
        if (step.fx & 0xf) == 0xe && (step.fx_param & 0xf0) == 0xd0 {
            if voice.note_delay_on {
                voice.note_delay_on = false;
                donenotedel = true;
            } else if ((step.fx_param & 0x0f) as i32) < self.t.tempo {
                voice.note_delay_wait = (step.fx_param & 0x0f) as i32;
                if voice.note_delay_wait != 0 {
                    voice.note_delay_on = true;
                    return;
                }
            }
        }
        if !donenotedel && (step.fxb & 0xf) == 0xe && (step.fxb_param & 0xf0) == 0xd0 {
            if voice.note_delay_on {
                voice.note_delay_on = false;
            } else if ((step.fxb_param & 0x0f) as i32) < self.t.tempo {
                voice.note_delay_wait = (step.fxb_param & 0x0f) as i32;
                if voice.note_delay_wait != 0 {
                    voice.note_delay_on = true;
                    return;
                }
            }
        }

        if note != 0 {
            voice.override_transpose = 1000; // 1.5
        }

        let track_length = self.song.track_length as i32;
        stepfx_1(&mut self.t, voice, track_length, (step.fx & 0xf) as i32, step.fx_param as i32);
        stepfx_1(&mut self.t, voice, track_length, (step.fxb & 0xf) as i32, step.fxb_param as i32);

        if instr != 0 && instr <= self.song.instrument_nr {
            let ins = &self.song.instruments[instr as usize];
            voice.trigger_instrument(instr, ins);
        }

        voice.period_slide_on = false;

        stepfx_2(voice, (step.fx & 0xf) as i32, step.fx_param as i32, &mut note);
        stepfx_2(voice, (step.fxb & 0xf) as i32, step.fxb_param as i32, &mut note);

        if note != 0 {
            voice.track_period = note;
            voice.plant_period = true;
        }

        for (fx, param) in [(step.fx & 0xf, step.fx_param), (step.fxb & 0xf, step.fxb_param)] {
            stepfx_3(&mut self.voices, i, self.version, fx as i32, param as i32);
        }
    }

    /// `hvl_mixchunk`, `hvl_replay.c:1699-1800`, writing interleaved stereo.
    /// `CAPTURE` is a compile-time switch: the `false` instance is the mixer
    /// with no capture code in it at all. The `true` instance is the same
    /// arithmetic plus one store per voice per frame of a value the mix has
    /// already computed.
    ///
    /// `HIFI` is the same kind of switch: the `false` instance is the
    /// reference arithmetic exactly. The `true` instance reads each voice's
    /// band-limited table (`i8` scale times `1 << FRAC_BITS`) where it has
    /// one, and the reference byte (shifted up to the same scale) where it
    /// does not, carries that scale through the sums, and drops it after the
    /// mix gain in 64-bit so the wider intermediate cannot wrap.
    fn mix_chunk<const CAPTURE: bool, const HIFI: bool>(&mut self, mut samples: usize, out: &mut [i16]) {
        const END: u32 = 0x280 << 16;
        let chans = self.channels;
        let mut delta = [0u32; MAX_CHANNELS];
        let mut rdelta = [0u32; MAX_CHANNELS];
        let mut vol = [0i32; MAX_CHANNELS];
        let mut pos = [0u32; MAX_CHANNELS];
        let mut rpos = [0u32; MAX_CHANNELS];
        let mut panl = [0i32; MAX_CHANNELS];
        let mut panr = [0i32; MAX_CHANNELS];
        let mut ring = [false; MAX_CHANNELS];

        // A silenced voice mixes at volume 0: `j` is then exactly 0, and
        // everything else about the voice (position, ring mod) advances as usual.
        let gated = self.mute_mask != 0 || self.solo_mask != 0;
        for i in 0..chans {
            let v = &self.voices[i];
            delta[i] = v.delta;
            vol[i] = if gated && self.voice_silenced(i) { 0 } else { v.voice_volume };
            pos[i] = v.sample_pos;
            panl[i] = v.pan_mult_left;
            panr[i] = v.pan_mult_right;
            rdelta[i] = v.ring_delta;
            rpos[i] = v.ring_sample_pos;
            ring[i] = v.ring_mix_active;
        }

        let mut o = 0usize;
        // Capture bookkeeping; every use is behind `CAPTURE`, and render_block
        // picks that instance only when a capture is present.
        let mut written = if CAPTURE { self.capture.as_ref().map_or(0, |c| c.written) } else { 0 };
        while samples > 0 {
            let mut loops = samples;
            for i in 0..chans {
                if pos[i] >= END {
                    pos[i] -= END;
                }
                let cnt = (END.wrapping_sub(pos[i]).wrapping_sub(1) / delta[i]).wrapping_add(1) as usize;
                loops = loops.min(cnt);

                if ring[i] {
                    if rpos[i] >= END {
                        rpos[i] -= END;
                    }
                    let cnt = (END.wrapping_sub(rpos[i]).wrapping_sub(1) / rdelta[i]).wrapping_add(1) as usize;
                    loops = loops.min(cnt);
                }
            }

            samples -= loops;

            for _ in 0..loops {
                let mut a: i32 = 0;
                let mut b: i32 = 0;
                for i in 0..chans {
                    let v = &self.voices[i];
                    let s = if HIFI {
                        match &v.hifi {
                            Some(h) => h.sample(pos[i]),
                            None => (v.voice_buffer[(pos[i] >> 16) as usize] as i32) << FRAC_BITS,
                        }
                    } else {
                        v.voice_buffer[(pos[i] >> 16) as usize] as i32
                    };
                    let j = if ring[i] {
                        let r = v.ring_voice_buffer[(rpos[i] >> 16) as usize] as i32;
                        rpos[i] = rpos[i].wrapping_add(rdelta[i]);
                        ((s * r) >> 7) * vol[i]
                    } else {
                        s * vol[i]
                    };
                    if CAPTURE {
                        if let Some(c) = self.capture.as_mut() {
                            let scope = if HIFI { j >> FRAC_BITS } else { j };
                            c.ring[i * CAPTURE_FRAMES + ((written as usize) & CAPTURE_MASK)] = scope as i16;
                        }
                    }
                    a = a.wrapping_add((j * panl[i]) >> 7);
                    b = b.wrapping_add((j * panr[i]) >> 7);
                    pos[i] = pos[i].wrapping_add(delta[i]);
                }

                if HIFI {
                    a = ((a as i64 * self.mixgain as i64) >> (8 + FRAC_BITS)) as i32;
                    b = ((b as i64 * self.mixgain as i64) >> (8 + FRAC_BITS)) as i32;
                } else {
                    a = a.wrapping_mul(self.mixgain) >> 8;
                    b = b.wrapping_mul(self.mixgain) >> 8;
                }
                out[o] = a.clamp(-0x8000, 0x7fff) as i16;
                out[o + 1] = b.clamp(-0x8000, 0x7fff) as i16;
                o += 2;
                if CAPTURE {
                    written = written.wrapping_add(1);
                }
            }
        }
        if CAPTURE {
            if let Some(c) = self.capture.as_mut() {
                c.written = written;
            }
        }

        for i in 0..chans {
            self.voices[i].sample_pos = pos[i];
            self.voices[i].ring_sample_pos = rpos[i];
        }
    }
}

/// `hvl_process_stepfx_1`, `hvl_replay.c:621-685`: transport-affecting and
/// pre-trigger effects.
fn stepfx_1(t: &mut Transport, voice: &mut Voice, track_length: i32, fx: i32, param: i32) {
    match fx {
        0x0 => {
            // Position Jump HI.
            if (param & 0x0f) > 0 && (param & 0x0f) <= 9 {
                t.pos_jump = param & 0xf;
            }
        }
        0x5 | 0xa => {
            // Volume slide (+ tone portamento).
            voice.volume_slide_down = param & 0x0f;
            voice.volume_slide_up = param >> 4;
        }
        0x7 => {
            // Panning.
            let mut p = param;
            if p > 127 {
                p -= 256;
            }
            voice.pan = (p + 128) as u32;
            voice.set_pan = (p + 128) as u32; // 1.4
            voice.pan_mult_left = panning_left(voice.pan as usize);
            voice.pan_mult_right = panning_right(voice.pan as usize);
        }
        0xb => {
            // Position jump.
            t.pos_jump = (t.pos_jump * 100 + (param & 0x0f) + (param >> 4) * 10) & 0xffff;
            t.pattern_break = true;
            if t.pos_jump <= t.pos_nr {
                t.song_end_reached = true;
            }
        }
        0xd => {
            // Pattern break.
            t.pos_jump = (t.pos_nr + 1) & 0xffff;
            t.pos_jump_note = (param & 0x0f) + (param >> 4) * 10;
            t.pattern_break = true;
            if t.pos_jump_note > track_length {
                t.pos_jump_note = 0;
            }
        }
        0xe => {
            // Extended: only note cut lives in this pass (1.6: 0xd removed).
            if (param >> 4) == 0xc && (param & 0x0f) < t.tempo {
                voice.note_cut_wait = param & 0x0f;
                if voice.note_cut_wait != 0 {
                    voice.note_cut_on = true;
                    voice.hard_cut_release = false;
                }
            }
        }
        0xf => {
            // Speed.
            t.tempo = param;
            if param == 0 {
                t.song_end_reached = true;
            }
        }
        _ => {}
    }
}

/// `hvl_process_stepfx_2`, `hvl_replay.c:687-718`: effects that read or
/// consume the row's note.
fn stepfx_2(voice: &mut Voice, fx: i32, param: i32, note: &mut i32) {
    match fx {
        0x9 => {
            // Set squarewave offset. The decoder hands over the raw byte
            // (P2 contract, commit 1c2f6b0); the shift by this voice's
            // wavelength happens here, where `vc_WaveLength` is known.
            voice.square.pos = param >> (5 - voice.wave_length).max(0);
            voice.square.ignore = true;
        }
        0x3 | 0x5 => {
            // Tone portamento (0x3 falls through into 0x5's body).
            if fx == 0x3 && param != 0 {
                voice.period_slide_speed = param;
            }
            if *note != 0 {
                let target = crate::ahx::voice::PERIOD_TAB[(*note as usize).min(60)] as i32;
                let mut diff = crate::ahx::voice::PERIOD_TAB[(voice.track_period as usize).min(60)] as i32;
                diff -= target;
                let new = diff + voice.period_slide_period;
                if new != 0 {
                    voice.period_slide_limit = wrap_i16(-diff);
                }
            }
            voice.period_slide_on = true;
            voice.period_slide_with_limit = true;
            *note = 0;
        }
        _ => {}
    }
}

/// `hvl_process_stepfx_3`, `hvl_replay.c:720-812`: effects applied after the
/// note/instrument are in place. Takes the whole voice slice because effect
/// `0xC` tier 2 (`0x50..=0x90`) sets *every* voice's master volume
/// (`:758-759`), in the middle of this voice's own effect processing.
fn stepfx_3(voices: &mut [Voice], i: usize, version: u8, fx: i32, param: i32) {
    let voice = &mut voices[i];
    match fx {
        0x01 => {
            voice.period_slide_speed = -param;
            voice.period_slide_on = true;
            voice.period_slide_with_limit = false;
        }
        0x02 => {
            voice.period_slide_speed = param;
            voice.period_slide_on = true;
            voice.period_slide_with_limit = false;
        }
        0x04 => {
            // Filter override.
            if param == 0 || param == 0x40 {
                return;
            }
            if param < 0x40 {
                voice.filter.ignore = param;
                return;
            }
            if param > 0x7f {
                return;
            }
            voice.filter.pos = param - 0x40;
        }
        0x0c => {
            let mut p = param & 0xff;
            if p <= 0x40 {
                voice.note_max_volume = p;
                return;
            }
            p -= 0x50; // 1.6
            if p < 0 {
                return;
            }
            if p <= 0x40 {
                for v in voices.iter_mut() {
                    v.track_master_volume = p;
                }
                return;
            }
            p -= 0xa0 - 0x50; // 1.6
            if p < 0 {
                return;
            }
            if p <= 0x40 {
                voice.track_master_volume = p;
            }
        }
        0xe => match param >> 4 {
            0x1 => {
                // Fineslide up.
                voice.period_slide_period = wrap_i16(voice.period_slide_period - (param & 0x0f));
                voice.plant_period = true;
            }
            0x2 => {
                // Fineslide down.
                voice.period_slide_period = wrap_i16(voice.period_slide_period + (param & 0x0f));
                voice.plant_period = true;
            }
            0x4 => {
                // Vibrato control.
                voice.vibrato_depth = param & 0x0f;
            }
            0x0a => {
                voice.note_max_volume = (voice.note_max_volume + (param & 0x0f)).min(0x40);
            }
            0x0b => {
                voice.note_max_volume = (voice.note_max_volume - (param & 0x0f)).max(0);
            }
            0x0f => {
                // Misc flags (1.5), `ht_Version >= 1` only.
                if version >= 1 && (param & 0xf) == 1 {
                    voice.override_transpose = voice.transpose;
                }
            }
            _ => {}
        },
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voices(n: usize) -> Vec<Voice> {
        (0..n).map(|_| Voice::new()).collect()
    }

    // Effect 0xC tiers (`hvl_replay.c:746-767`). Not reached by any fixture,
    // so the render goldens cannot prove them; tested directly instead.
    #[test]
    fn effect_c_tier_1_sets_this_voices_note_volume_only() {
        let mut v = voices(3);
        stepfx_3(&mut v, 1, 0, 0x0c, 0x20);
        assert_eq!(v[1].note_max_volume, 0x20);
        assert_eq!(v[0].note_max_volume, 0);
        assert_eq!(v[2].note_max_volume, 0);
    }

    #[test]
    fn effect_c_tier_2_broadcasts_master_volume_to_every_voice() {
        let mut v = voices(3);
        stepfx_3(&mut v, 1, 0, 0x0c, 0x50 + 0x18);
        assert!(v.iter().all(|x| x.track_master_volume == 0x18));
    }

    #[test]
    fn effect_c_tier_3_sets_only_this_voices_master_volume() {
        let mut v = voices(3);
        stepfx_3(&mut v, 2, 0, 0x0c, 0xa0 + 0x05);
        assert_eq!(v[2].track_master_volume, 0x05);
        assert_eq!(v[0].track_master_volume, 0x40);
    }

    #[test]
    fn effect_c_gap_between_tiers_is_ignored() {
        let mut v = voices(2);
        stepfx_3(&mut v, 0, 0, 0x0c, 0x45);
        assert_eq!(v[0].note_max_volume, 0);
        assert_eq!(v[0].track_master_volume, 0x40);
    }

    // The int16 stores (`wrap_i16`): a runaway period slide wraps modulo 2^16
    // exactly like the reference's `int16 vc_PeriodSlidePeriod`.
    #[test]
    fn fineslide_wraps_like_an_int16_member() {
        let mut v = voices(1);
        v[0].period_slide_period = i16::MAX as i32;
        stepfx_3(&mut v, 0, 0, 0xe, 0x20 | 0x01); // E21: fineslide down by 1
        assert_eq!(v[0].period_slide_period, i16::MIN as i32);
    }

    #[test]
    fn misc_flags_override_transpose_needs_version_1() {
        let mut v = voices(1);
        v[0].transpose = 5;
        stepfx_3(&mut v, 0, 0, 0xe, 0xf1);
        assert_eq!(v[0].override_transpose, 1000, "version 0 must ignore EF1");
        stepfx_3(&mut v, 0, 1, 0xe, 0xf1);
        assert_eq!(v[0].override_transpose, 5);
    }

    #[test]
    fn filter_override_routes_by_range() {
        let mut v = voices(1);
        stepfx_3(&mut v, 0, 0, 0x04, 0x10); // < 0x40: stash for PList cmd 0
        assert_eq!(v[0].filter.ignore, 0x10);
        stepfx_3(&mut v, 0, 0, 0x04, 0x40 + 0x0a); // 0x41..=0x7f: set now
        assert_eq!(v[0].filter.pos, 0x0a);
        v[0].filter.pos = 32;
        stepfx_3(&mut v, 0, 0, 0x04, 0x40); // 0x40 and 0: no-ops
        stepfx_3(&mut v, 0, 0, 0x04, 0x80); // > 0x7f: no-op
        assert_eq!(v[0].filter.pos, 32);
    }

    #[test]
    fn pattern_break_beyond_track_length_restarts_at_row_zero() {
        let mut t = Transport { pos_nr: 3, ..Transport::default() };
        let mut v = Voice::new();
        stepfx_1(&mut t, &mut v, 16, 0xd, 0x50); // D50 -> row 50 > 16
        assert!(t.pattern_break);
        assert_eq!(t.pos_jump, 4);
        assert_eq!(t.pos_jump_note, 0);
        stepfx_1(&mut t, &mut v, 64, 0xd, 0x12); // D12 -> row 12
        assert_eq!(t.pos_jump_note, 12);
    }

    #[test]
    fn speed_zero_ends_the_song() {
        let mut t = Transport { tempo: 6, ..Transport::default() };
        let mut v = Voice::new();
        stepfx_1(&mut t, &mut v, 64, 0xf, 0);
        assert!(t.song_end_reached);
    }
}
