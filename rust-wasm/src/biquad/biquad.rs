use std::f32::consts::PI;
use wasm_bindgen::prelude::wasm_bindgen;

/// FilterType enum, trait, and biquad implementations follow below.
#[wasm_bindgen]
#[derive(Clone, Copy, PartialEq)]
pub enum FilterType {
    LowPass,
    LowShelf,
    Peaking,
    HighShelf,
    Notch,
    HighPass,
    Ladder,
    Comb,
    BandPass,
}

/// Trait defining the basic filter interface.
pub trait Filter {
    fn process(&mut self, input: f32) -> f32;
    fn reset(&mut self);
}

/// A second‑order (12 dB/octave) biquad filter.
#[derive(Clone, Copy)]
pub struct Biquad {
    pub filter_type: FilterType,
    pub sample_rate: f32,
    pub frequency: f32,
    pub q: f32,
    pub gain_db: f32,
    pub b0: f32,
    pub b1: f32,
    pub b2: f32,
    pub a1: f32,
    pub a2: f32,
    pub x1: f32,
    pub x2: f32,
    pub y1: f32,
    pub y2: f32,
}

impl Biquad {
    pub fn new(
        filter_type: FilterType,
        sample_rate: f32,
        frequency: f32,
        q: f32,
        gain_db: f32,
    ) -> Self {
        let mut filter = Self {
            filter_type,
            sample_rate,
            frequency,
            q,
            gain_db,
            b0: 0.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        };
        filter.update_coefficients();
        filter
    }

    fn normalize(&mut self) {
        match self.filter_type {
            FilterType::LowPass | FilterType::Notch => {
                let denominator = 1.0 + self.a1 + self.a2;
                if denominator.abs() > 1e-6 {
                    let dc_gain = (self.b0 + self.b1 + self.b2) / denominator;
                    if dc_gain.abs() > 1e-6 {
                        self.b0 /= dc_gain;
                        self.b1 /= dc_gain;
                        self.b2 /= dc_gain;
                    }
                }
            }
            _ => {}
        }
    }

    pub fn update_coefficients(&mut self) {
        let omega = 2.0 * PI * self.frequency / self.sample_rate;
        if self.filter_type == FilterType::LowShelf && omega.abs() < 1e-6 {
            let a = 10f32.powf(self.gain_db / 40.0);
            self.b0 = a;
            self.b1 = 0.0;
            self.b2 = 0.0;
            self.a1 = 0.0;
            self.a2 = 0.0;
            return;
        }

        let sn = omega.sin();
        let cs = omega.cos();
        let alpha = sn / (2.0 * self.q);

        match self.filter_type {
            FilterType::LowShelf => {
                let a = 10f32.powf(self.gain_db / 40.0);
                let sqrt_a = a.sqrt();
                let shelf_alpha = sn / 2.0 * (2.0f32).sqrt();
                let a0 = (a + 1.0) + (a - 1.0) * cs + 2.0 * sqrt_a * shelf_alpha;
                self.b0 = a * ((a + 1.0) - (a - 1.0) * cs + 2.0 * sqrt_a * shelf_alpha) / a0;
                self.b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cs) / a0;
                self.b2 = a * ((a + 1.0) - (a - 1.0) * cs - 2.0 * sqrt_a * shelf_alpha) / a0;
                self.a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cs) / a0;
                self.a2 = ((a + 1.0) + (a - 1.0) * cs - 2.0 * sqrt_a * shelf_alpha) / a0;
            }
            FilterType::HighShelf => {
                let a = 10f32.powf(self.gain_db / 40.0);
                let sqrt_a = a.sqrt();
                let shelf_alpha = sn / 2.0 * (2.0f32).sqrt();
                let a0 = (a + 1.0) - (a - 1.0) * cs + 2.0 * sqrt_a * shelf_alpha;
                self.b0 = a * ((a + 1.0) + (a - 1.0) * cs + 2.0 * sqrt_a * shelf_alpha) / a0;
                self.b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cs) / a0;
                self.b2 = a * ((a + 1.0) + (a - 1.0) * cs - 2.0 * sqrt_a * shelf_alpha) / a0;
                self.a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cs) / a0;
                self.a2 = ((a + 1.0) - (a - 1.0) * cs - 2.0 * sqrt_a * shelf_alpha) / a0;
            }
            FilterType::Peaking => {
                let a = 10f32.powf(self.gain_db / 40.0);
                let a0 = 1.0 + alpha / a;
                self.b0 = (1.0 + alpha * a) / a0;
                self.b1 = -2.0 * cs / a0;
                self.b2 = (1.0 - alpha * a) / a0;
                self.a1 = -2.0 * cs / a0;
                self.a2 = (1.0 - alpha / a) / a0;
            }
            FilterType::Notch => {
                let a0 = 1.0 + alpha;
                self.b0 = 1.0 / a0;
                self.b1 = -2.0 * cs / a0;
                self.b2 = 1.0 / a0;
                self.a1 = -2.0 * cs / a0;
                self.a2 = (1.0 - alpha) / a0;
            }
            FilterType::HighPass => {
                let a0 = 1.0 + alpha;
                self.b0 = ((1.0 + cs) / 2.0) / a0;
                self.b1 = (-(1.0 + cs)) / a0;
                self.b2 = ((1.0 + cs) / 2.0) / a0;
                self.a1 = (-2.0 * cs) / a0;
                self.a2 = (1.0 - alpha) / a0;
            }
            FilterType::LowPass => {
                let a0 = 1.0 + alpha;
                self.b0 = ((1.0 - cs) / 2.0) / a0;
                self.b1 = (1.0 - cs) / a0;
                self.b2 = ((1.0 - cs) / 2.0) / a0;
                self.a1 = (-2.0 * cs) / a0;
                self.a2 = (1.0 - alpha) / a0;
            }
            FilterType::BandPass => {
                let a0 = 1.0 + alpha;
                self.b0 = sn / 2.0 / a0;
                self.b1 = 0.0;
                self.b2 = -sn / 2.0 / a0;
                self.a1 = -2.0 * cs / a0;
                self.a2 = (1.0 - alpha) / a0;
            }
            _ => {}
        }
        match self.filter_type {
            FilterType::LowPass | FilterType::Notch => self.normalize(),
            _ => {}
        }
    }
}

impl Filter for Biquad {
    fn process(&mut self, input: f32) -> f32 {
        let output = self.b0 * input + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = input;
        self.y2 = self.y1;
        self.y1 = output;
        output
    }

    fn reset(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }
}

/// A cascaded biquad filter (two biquad stages in series) for a steeper 24 dB/octave slope.
#[derive(Clone, Copy)]
pub struct CascadedBiquad {
    pub first: Biquad,
    pub second: Biquad,
}

impl CascadedBiquad {
    pub fn new(
        filter_type: FilterType,
        sample_rate: f32,
        frequency: f32,
        q: f32,
        gain_db: f32,
    ) -> Self {
        Self {
            first: Biquad::new(filter_type, sample_rate, frequency, q, gain_db),
            second: Biquad::new(filter_type, sample_rate, frequency, q, gain_db),
        }
    }
}

impl Filter for CascadedBiquad {
    fn process(&mut self, input: f32) -> f32 {
        let temp = self.first.process(input);
        self.second.process(temp)
    }

    fn reset(&mut self) {
        self.first.reset();
        self.second.reset();
    }
}
