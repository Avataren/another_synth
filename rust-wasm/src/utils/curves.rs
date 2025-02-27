// src/utils/curves.rs
pub fn get_curved_value(position: f32, curve: f32) -> f32 {
    if curve.abs() < 0.001 {
        return position;
    }

    let alpha = (curve.abs()).exp();

    if curve > 0.0 {
        // Exponential curve
        ((position * (1.0 + alpha).ln()).exp() - 1.0) / alpha
    } else {
        // Logarithmic curve
        (1.0 + position * alpha).ln() / (1.0 + alpha).ln()
    }
}
