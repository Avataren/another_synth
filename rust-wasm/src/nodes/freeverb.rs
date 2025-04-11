use crate::graph::ModulationSource;
use crate::traits::{AudioNode, PortId};
use rustc_hash::FxHashMap;
use std::any::Any;
use std::simd::f32x4;
use std::simd::num::SimdFloat;

/// A single comb filter with a one-pole lowpass in the feedback loop.
struct CombFilter {
    buffer: Vec<f32>,
    buffer_size: usize,
    index: usize,
    feedback: f32,
    filter_store: f32,
    damp1: f32, // Usually equal to the damp parameter (0..1)
    damp2: f32, // 1 - damp1
}

impl CombFilter {
    /// Create a new comb filter.
    pub fn new(delay_samples: usize, feedback: f32, damp: f32) -> Self {
        let damp1 = damp.clamp(0.0, 1.0);
        let damp2 = 1.0 - damp1;
        Self {
            buffer: vec![0.0; delay_samples],
            buffer_size: delay_samples,
            index: 0,
            feedback,
            filter_store: 0.0,
            damp1,
            damp2,
        }
    }

    /// Process a single sample.
    #[inline(always)]
    pub fn process(&mut self, input: f32) -> f32 {
        let output = self.buffer[self.index];
        // One-pole lowpass for internal damping.
        self.filter_store = output * self.damp1 + self.filter_store * self.damp2;
        // Write back new input plus feedback.
        self.buffer[self.index] = input + self.filter_store * self.feedback;
        self.index = (self.index + 1) % self.buffer_size;
        output
    }

    /// Reset internal state.
    pub fn reset(&mut self) {
        self.buffer.fill(0.0);
        self.filter_store = 0.0;
        self.index = 0;
    }
}

/// A single allpass filter.
struct AllpassFilter {
    buffer: Vec<f32>,
    buffer_size: usize,
    index: usize,
    feedback: f32, // Typically 0.5 in Freeverb.
}

impl AllpassFilter {
    /// Create a new allpass filter.
    pub fn new(delay_samples: usize, feedback: f32) -> Self {
        Self {
            buffer: vec![0.0; delay_samples],
            buffer_size: delay_samples,
            index: 0,
            feedback,
        }
    }

    /// Process one sample.
    #[inline(always)]
    pub fn process(&mut self, input: f32) -> f32 {
        let bufout = self.buffer[self.index];
        let output = bufout - input;
        self.buffer[self.index] = input + bufout * self.feedback;
        self.index = (self.index + 1) % self.buffer_size;
        output
    }

    /// Reset the filter.
    pub fn reset(&mut self) {
        self.buffer.fill(0.0);
        self.index = 0;
    }
}

/// The Freeverb reverb node.
pub struct Freeverb {
    enabled: bool,
    sample_rate: f32,

    // Parameters
    room_size: f32, // 0..1; controls comb filter feedback.
    damp: f32,      // 0..1; dampening inside comb filters.
    wet: f32,       // Wet mix level.
    dry: f32,       // Dry mix level.
    width: f32,     // Stereo width (0 = narrow, 1 = wide).

    // 8 comb filters per channel.
    comb_filters_l: Vec<CombFilter>,
    comb_filters_r: Vec<CombFilter>,

    // 4 allpass filters per channel.
    allpass_filters_l: Vec<AllpassFilter>,
    allpass_filters_r: Vec<AllpassFilter>,

    // Precomputed stereo wet mix coefficients.
    wet1: f32,
    wet2: f32,
}

impl Freeverb {
    /// Create a new Freeverb node.
    ///
    /// * `sample_rate` - Audio sample rate in Hz.
    /// * `room_size` - 0 to 1 value controlling reverb time.
    /// * `damp` - 0 to 1 value controlling lowpass damping.
    /// * `wet` - Processed (wet) level.
    /// * `dry` - Unprocessed (dry) level.
    /// * `width` - Stereo width (0 = narrow, 1 = wide).
    pub fn new(
        sample_rate: f32,
        room_size: f32,
        damp: f32,
        wet: f32,
        dry: f32,
        width: f32,
    ) -> Self {
        let room_size = room_size.clamp(0.0, 1.0);
        let damp = damp.clamp(0.0, 1.0);
        let wet = wet.clamp(0.0, 1.0);
        let dry = dry.clamp(0.0, 1.0);
        let width = width.clamp(0.0, 1.0);

        // Original Freeverb delay lengths (for 44.1kHz)
        let comb_tunings_l = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
        // Right channel: slightly offset delays for stereo.
        let comb_tunings_r: Vec<i32> = comb_tunings_l.iter().map(|&t| t + 23).collect();
        let scale = sample_rate / 44100.0;
        let comb_filters_l: Vec<CombFilter> = comb_tunings_l
            .iter()
            .map(|&t| {
                let delay_samples = ((t as f32) * scale).round() as usize;
                CombFilter::new(delay_samples, room_size, damp)
            })
            .collect();
        let comb_filters_r: Vec<CombFilter> = comb_tunings_r
            .iter()
            .map(|&t| {
                let delay_samples = ((t as f32) * scale).round() as usize;
                CombFilter::new(delay_samples, room_size, damp)
            })
            .collect();

        let allpass_tunings = [556, 441, 341, 225];
        let allpass_filters_l: Vec<AllpassFilter> = allpass_tunings
            .iter()
            .map(|&t| {
                let delay_samples = ((t as f32) * scale).round() as usize;
                AllpassFilter::new(delay_samples, 0.5)
            })
            .collect();
        let allpass_filters_r: Vec<AllpassFilter> = allpass_tunings
            .iter()
            .map(|&t| {
                let delay_samples = ((t as f32) * scale).round() as usize;
                AllpassFilter::new(delay_samples, 0.5)
            })
            .collect();

        // Stereo wet mix coefficients.
        let wet1 = wet * (width / 2.0 + 0.5);
        let wet2 = wet * (0.5 - width / 2.0);

        Self {
            enabled: true,
            sample_rate,
            room_size,
            damp,
            wet,
            dry,
            width,
            comb_filters_l,
            comb_filters_r,
            allpass_filters_l,
            allpass_filters_r,
            wet1,
            wet2,
        }
    }

    /// Adjust the room size (affecting comb filter feedback).
    pub fn set_room_size(&mut self, room_size: f32) {
        self.room_size = room_size.clamp(0.0, 1.0);
        for comb in self.comb_filters_l.iter_mut() {
            comb.feedback = self.room_size;
        }
        for comb in self.comb_filters_r.iter_mut() {
            comb.feedback = self.room_size;
        }
    }

    /// Adjust the damping.
    pub fn set_damp(&mut self, damp: f32) {
        self.damp = damp.clamp(0.0, 1.0);
        for comb in self.comb_filters_l.iter_mut() {
            comb.damp1 = self.damp;
            comb.damp2 = 1.0 - self.damp;
        }
        for comb in self.comb_filters_r.iter_mut() {
            comb.damp1 = self.damp;
            comb.damp2 = 1.0 - self.damp;
        }
    }

    /// Adjust the wet mix.
    pub fn set_wet(&mut self, wet: f32) {
        self.wet = wet.clamp(0.0, 1.0);
        self.update_wet_mix();
    }

    /// Adjust the dry mix.
    pub fn set_dry(&mut self, dry: f32) {
        self.dry = dry.clamp(0.0, 1.0);
    }

    /// Adjust the stereo width.
    pub fn set_width(&mut self, width: f32) {
        self.width = width.clamp(0.0, 1.0);
        self.update_wet_mix();
    }

    fn update_wet_mix(&mut self) {
        self.wet1 = self.wet * (self.width / 2.0 + 0.5);
        self.wet2 = self.wet * (0.5 - self.width / 2.0);
    }

    /// Reset all filters.
    pub fn reset_filters(&mut self) {
        for comb in self.comb_filters_l.iter_mut() {
            comb.reset();
        }
        for comb in self.comb_filters_r.iter_mut() {
            comb.reset();
        }
        for ap in self.allpass_filters_l.iter_mut() {
            ap.reset();
        }
        for ap in self.allpass_filters_r.iter_mut() {
            ap.reset();
        }
    }
}

impl AudioNode for Freeverb {
    fn get_ports(&self) -> FxHashMap<PortId, bool> {
        let mut ports = FxHashMap::default();
        ports.insert(PortId::AudioInput0, false); // Left input
        ports.insert(PortId::AudioInput1, false); // Right input
        ports.insert(PortId::AudioOutput0, true); // Left output
        ports.insert(PortId::AudioOutput1, true); // Right output
        ports
    }

    fn process(
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // Retrieve input buffers; if absent, use a zero buffer.
        let left_in = inputs
            .get(&PortId::AudioInput0)
            .and_then(|sources| sources.first())
            .map(|src| &src.buffer[..buffer_size])
            .unwrap_or_else(|| {
                static ZERO_BUFFER: [f32; 1024] = [0.0; 1024];
                &ZERO_BUFFER[..buffer_size.min(ZERO_BUFFER.len())]
            });
        let right_in = inputs
            .get(&PortId::AudioInput1)
            .and_then(|sources| sources.first())
            .map(|src| &src.buffer[..buffer_size])
            .unwrap_or_else(|| {
                static ZERO_BUFFER: [f32; 1024] = [0.0; 1024];
                &ZERO_BUFFER[..buffer_size.min(ZERO_BUFFER.len())]
            });
        let outs = outputs.get_many_mut([&PortId::AudioOutput0, &PortId::AudioOutput1]);
        let [Some(out_left), Some(out_right)] = outs else {
            panic!("Missing stereo output buffers");
        };
        let out_left: &mut [f32] = *out_left;
        let out_right: &mut [f32] = *out_right;

        // Process sample-by-sample.
        for i in 0..buffer_size {
            let input_l = left_in[i];
            let input_r = right_in[i];

            // --- Comb Filter Processing with SIMD accumulation ---
            // Process the eight comb filters for left channel.
            let c0 = self.comb_filters_l[0].process(input_l);
            let c1 = self.comb_filters_l[1].process(input_l);
            let c2 = self.comb_filters_l[2].process(input_l);
            let c3 = self.comb_filters_l[3].process(input_l);
            let c4 = self.comb_filters_l[4].process(input_l);
            let c5 = self.comb_filters_l[5].process(input_l);
            let c6 = self.comb_filters_l[6].process(input_l);
            let c7 = self.comb_filters_l[7].process(input_l);
            // Group into two SIMD vectors and horizontally sum.
            let vec_l1 = f32x4::from_array([c0, c1, c2, c3]);
            let vec_l2 = f32x4::from_array([c4, c5, c6, c7]);
            let comb_sum_l = vec_l1.reduce_sum() + vec_l2.reduce_sum();

            // Process the eight comb filters for right channel.
            let cr0 = self.comb_filters_r[0].process(input_r);
            let cr1 = self.comb_filters_r[1].process(input_r);
            let cr2 = self.comb_filters_r[2].process(input_r);
            let cr3 = self.comb_filters_r[3].process(input_r);
            let cr4 = self.comb_filters_r[4].process(input_r);
            let cr5 = self.comb_filters_r[5].process(input_r);
            let cr6 = self.comb_filters_r[6].process(input_r);
            let cr7 = self.comb_filters_r[7].process(input_r);
            let vec_r1 = f32x4::from_array([cr0, cr1, cr2, cr3]);
            let vec_r2 = f32x4::from_array([cr4, cr5, cr6, cr7]);
            let comb_sum_r = vec_r1.reduce_sum() + vec_r2.reduce_sum();

            // --- Allpass Filter Processing (sequential) ---
            let mut reverb_l = comb_sum_l;
            for ap in self.allpass_filters_l.iter_mut() {
                reverb_l = ap.process(reverb_l);
            }
            let mut reverb_r = comb_sum_r;
            for ap in self.allpass_filters_r.iter_mut() {
                reverb_r = ap.process(reverb_r);
            }

            // --- Final Mixing ---
            // Compute dry and wet mixes.
            let left_dry = input_l * self.dry;
            let right_dry = input_r * self.dry;
            // Stereo cross-mixing yields a wider stereo image.
            out_left[i] = left_dry + self.wet1 * reverb_l + self.wet2 * reverb_r;
            out_right[i] = right_dry + self.wet1 * reverb_r + self.wet2 * reverb_l;
        }
    }

    fn reset(&mut self) {
        self.reset_filters();
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn is_active(&self) -> bool {
        self.enabled
    }

    fn set_active(&mut self, active: bool) {
        self.enabled = active;
        if active {
            self.reset();
        }
    }

    fn node_type(&self) -> &str {
        "freeverb"
    }
}
