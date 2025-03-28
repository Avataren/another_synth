use std::f32::consts::PI;
use wasm_bindgen::prelude::wasm_bindgen;

/// FilterType enum, trait, and biquad implementations follow below.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq)] // Added Debug for easier printing if needed
pub enum FilterType {
    LowPass,
    LowShelf,
    Peaking,
    HighShelf,
    Notch,
    HighPass,
    Ladder, // Note: Biquad coefficients are not calculated for Ladder/Comb
    Comb,   // Note: Biquad coefficients are not calculated for Ladder/Comb
    BandPass,
}

/// Trait defining the basic filter interface.
pub trait Filter {
    fn process(&mut self, input: f32) -> f32;
    fn reset(&mut self);
    // Optional: Add methods for setting parameters if needed outside direct struct access
    // fn set_frequency(&mut self, freq: f32);
    // fn set_q(&mut self, q: f32);
    // fn set_gain_db(&mut self, gain: f32);
    // fn set_type(&mut self, filter_type: FilterType);
}

/// A second‑order (12 dB/octave) biquad filter using Direct Form I.
#[derive(Clone, Copy, Debug)] // Added Debug
pub struct Biquad {
    // Parameters
    pub filter_type: FilterType,
    pub sample_rate: f32,
    pub frequency: f32,
    pub q: f32,
    pub gain_db: f32,
    // Coefficients
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32, // Note: a0 is normalized to 1
    a2: f32,
    // State variables (Direct Form I)
    x1: f32, // Input delay 1
    x2: f32, // Input delay 2
    y1: f32, // Output delay 1
    y2: f32, // Output delay 2
}

impl Biquad {
    /// Creates a new Biquad filter instance.
    pub fn new(
        filter_type: FilterType,
        sample_rate: f32,
        frequency: f32,
        q: f32,
        gain_db: f32,
    ) -> Self {
        let mut filter = Self {
            filter_type,
            sample_rate: sample_rate.max(1.0), // Ensure positive sample rate
            frequency: frequency.clamp(10.0, sample_rate * 0.499), // Clamp freq
            q: q.max(0.01),                    // Ensure positive Q
            gain_db,
            b0: 1.0, // Initialize coeffs to pass-through-ish (b0=1, others=0)
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            x1: 0.0, // Initialize state to zero
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        };
        filter.update_coefficients(); // Calculate initial coefficients
        filter
    }

    /// Normalizes filter coefficients for certain types to ensure unity gain at DC or Nyquist.
    /// This is often unnecessary if coefficients are derived correctly, but can help stability.
    /// RBJ cookbook coefficients generally don't require this if implemented carefully.
    #[allow(dead_code)] // Keep for reference, but RBJ coeffs are often pre-normalized
    fn normalize_coeffs(&mut self) {
        // Normalization factor (denominator of transfer function H(z) at z=1 or z=-1)
        let norm_factor = match self.filter_type {
            // Normalize LowPass/Notch gain at DC (z=1)
            FilterType::LowPass | FilterType::Notch => {
                (self.b0 + self.b1 + self.b2) / (1.0 + self.a1 + self.a2)
            }
            // Normalize HighPass gain at Nyquist (z=-1)
            FilterType::HighPass => (self.b0 - self.b1 + self.b2) / (1.0 - self.a1 + self.a2),
            // Other types (Shelving, Peaking, Bandpass) have gain defined by gain_db
            _ => 1.0, // No normalization needed
        };

        // Avoid division by zero or near-zero
        if norm_factor.abs() > 1e-8 {
            self.b0 /= norm_factor;
            self.b1 /= norm_factor;
            self.b2 /= norm_factor;
        }
    }

    /// Recalculates the filter coefficients based on current parameters.
    /// Uses formulas from the Audio EQ Cookbook by Robert Bristow-Johnson.
    pub fn update_coefficients(&mut self) {
        // Pre-calculations
        let a = 10f32.powf(self.gain_db / 40.0); // Amplitude for Shelving/Peaking
        let omega = 2.0 * PI * self.frequency / self.sample_rate;
        let sn = omega.sin();
        let cs = omega.cos();
        let alpha = sn / (2.0 * self.q); // Q related term

        // Temporary coefficient variables
        let mut b0 = 1.0;
        let mut b1 = 0.0;
        let mut b2 = 0.0;
        let mut a0 = 1.0; // a0 is the normalization factor
        let mut a1 = 0.0;
        let mut a2 = 0.0;

        match self.filter_type {
            FilterType::LowPass => {
                a0 = 1.0 + alpha;
                b0 = (1.0 - cs) / 2.0;
                b1 = 1.0 - cs;
                b2 = (1.0 - cs) / 2.0;
                a1 = -2.0 * cs;
                a2 = 1.0 - alpha;
            }
            FilterType::HighPass => {
                a0 = 1.0 + alpha;
                b0 = (1.0 + cs) / 2.0;
                b1 = -(1.0 + cs);
                b2 = (1.0 + cs) / 2.0;
                a1 = -2.0 * cs;
                a2 = 1.0 - alpha;
            }
            FilterType::BandPass => {
                // Constant skirt gain, peak gain = Q
                a0 = 1.0 + alpha;
                b0 = alpha; // Or sn / 2.0 or self.q * alpha ? RBJ: alpha
                b1 = 0.0;
                b2 = -alpha; // Or -sn / 2.0 or -self.q * alpha ? RBJ: -alpha
                a1 = -2.0 * cs;
                a2 = 1.0 - alpha;
            }
            // FilterType::BandPass => { // Constant peak gain 0dB
            //     a0 = 1.0 + alpha;
            //     b0 = sn / 2.0; // Q value affects bandwidth here
            //     b1 = 0.0;
            //     b2 = -sn / 2.0;
            //     a1 = -2.0 * cs;
            //     a2 = 1.0 - alpha;
            // }
            FilterType::Notch => {
                a0 = 1.0 + alpha;
                b0 = 1.0;
                b1 = -2.0 * cs;
                b2 = 1.0;
                a1 = -2.0 * cs;
                a2 = 1.0 - alpha;
            }
            FilterType::Peaking => {
                a0 = 1.0 + alpha / a;
                b0 = 1.0 + alpha * a;
                b1 = -2.0 * cs;
                b2 = 1.0 - alpha * a;
                a1 = -2.0 * cs;
                a2 = 1.0 - alpha / a;
            }
            FilterType::LowShelf => {
                let sqrt_a = a.sqrt();
                let beta = 2.0 * sqrt_a * alpha; // Term based on sqrt(A) and alpha
                a0 = (a + 1.0) + (a - 1.0) * cs + beta;
                b0 = a * ((a + 1.0) - (a - 1.0) * cs + beta);
                b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cs);
                b2 = a * ((a + 1.0) - (a - 1.0) * cs - beta);
                a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cs);
                a2 = (a + 1.0) + (a - 1.0) * cs - beta;
            }
            FilterType::HighShelf => {
                let sqrt_a = a.sqrt();
                let beta = 2.0 * sqrt_a * alpha;
                a0 = (a + 1.0) - (a - 1.0) * cs + beta;
                b0 = a * ((a + 1.0) + (a - 1.0) * cs + beta);
                b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cs);
                b2 = a * ((a + 1.0) + (a - 1.0) * cs - beta);
                a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cs);
                a2 = (a + 1.0) - (a - 1.0) * cs - beta;
            }
            FilterType::Ladder | FilterType::Comb => {
                // Biquad coefficients are not used for these types in FilterCollection
                // Set to pass-through state
                b0 = 1.0;
                b1 = 0.0;
                b2 = 0.0;
                a0 = 1.0;
                a1 = 0.0;
                a2 = 0.0;
            }
        }

        // Normalize coefficients by a0
        // Avoid division by zero, though a0 should generally be > 0 for stable filters
        if a0.abs() > 1e-8 {
            self.b0 = b0 / a0;
            self.b1 = b1 / a0;
            self.b2 = b2 / a0;
            self.a1 = a1 / a0;
            self.a2 = a2 / a0;
        } else {
            // Handle potential error case: set to pass-through
            self.b0 = 1.0;
            self.b1 = 0.0;
            self.b2 = 0.0;
            self.a1 = 0.0;
            self.a2 = 0.0;
            // Log error?
            // web_sys::console::error_1(&"Biquad coefficient calculation resulted in a0 near zero!".into());
        }

        // Optional: Apply explicit normalization (usually not needed with RBJ)
        // self.normalize_coeffs();
    }
}

impl Filter for Biquad {
    /// Processes one sample using Direct Form I.
    #[inline(always)]
    fn process(&mut self, input: f32) -> f32 {
        // Calculate output: y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
        let output = self.b0 * input + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;

        // Update state variables for next sample
        self.x2 = self.x1; // x[n-2] = x[n-1]
        self.x1 = input; // x[n-1] = x[n]
        self.y2 = self.y1; // y[n-2] = y[n-1]
        self.y1 = output; // y[n-1] = y[n]

        // Return potentially denormal-clipped output
        // Avoids performance issues on some platforms if output becomes extremely small
        if output.abs() < 1e-18 {
            0.0
        } else {
            output
        }
    }

    /// Resets the filter's internal state variables to zero.
    fn reset(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }
}

/// A cascaded biquad filter (two biquad stages in series) for a steeper 24 dB/octave slope.
#[derive(Clone, Copy, Debug)] // Added Debug
pub struct CascadedBiquad {
    pub first: Biquad,
    pub second: Biquad,
}

impl CascadedBiquad {
    /// Creates a new CascadedBiquad with the same parameters for both stages.
    pub fn new(
        filter_type: FilterType,
        sample_rate: f32,
        frequency: f32,
        q: f32,       // Q per stage
        gain_db: f32, // Total gain, usually applied to one stage or split
    ) -> Self {
        // Default: Apply full gain to the second stage for simplicity
        let q_stage = q.max(0.501); // Ensure Q slightly > 0.5 for stability
        Self {
            first: Biquad::new(filter_type, sample_rate, frequency, q_stage, 0.0), // First stage no gain
            second: Biquad::new(filter_type, sample_rate, frequency, q_stage, gain_db), // Second stage full gain
        }
    }

    /// Creates a new CascadedBiquad allowing different gain settings per stage.
    /// **This function is moved here from impl Biquad.**
    pub fn new_with_gain_split(
        filter_type: FilterType,
        sample_rate: f32,
        frequency: f32,
        q: f32,        // Q per stage
        gain_db1: f32, // Gain for first stage
        gain_db2: f32, // Gain for second stage
    ) -> Self {
        // Ensure Q is stable for each stage
        let q_stage = q.max(0.501);
        // Create the two biquad instances
        let first = Biquad::new(filter_type, sample_rate, frequency, q_stage, gain_db1);
        let second = Biquad::new(filter_type, sample_rate, frequency, q_stage, gain_db2);
        // Coefficients are calculated inside Biquad::new

        // Return the CascadedBiquad struct
        Self { first, second }
    }
}

impl Filter for CascadedBiquad {
    /// Processes one sample through both stages sequentially.
    #[inline(always)]
    fn process(&mut self, input: f32) -> f32 {
        // Process through the first stage
        let temp = self.first.process(input);
        // Process the result through the second stage
        self.second.process(temp)
    }

    /// Resets the state variables of both internal biquad stages.
    fn reset(&mut self) {
        self.first.reset();
        self.second.reset();
    }
}
