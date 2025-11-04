# Chorus Effect Fix for Native Builds

## Problem
The chorus effect was breaking audio in native builds but working fine in web builds.

## Root Causes

### 1. Build Configuration Issue
**The main issue**: The `wasm` feature is enabled by default in `Cargo.toml`, causing wasm-bindgen code to be included in native builds, which panics at runtime.

**Solution**: Always build native binaries with:
```bash
cargo build --bin native_demo --no-default-features --features native-host --release
```

Or use the helper script:
```bash
./build_native.sh
```

### 2. Numerical Stability Issues
The chorus effect's feedback loop could accumulate NaN/Inf values differently on native vs WASM platforms due to subtle differences in floating-point handling and SIMD operations.

**Fixes applied** to `src/nodes/chorus.rs`:

1. **Feedback Loop Protection**: Added NaN/Inf checks and clamping to prevent unbounded signal growth
   - Check delayed signals for validity before processing
   - Check filtered signals after feedback filter
   - Clamp write values to ±10.0 to prevent extreme values

2. **FeedbackFilter Safety**: Added state clamping to ±100.0 and NaN detection

3. **DcBlocker Safety**: Added NaN/Inf detection with automatic reset

## Testing
To verify the chorus works:

1. Build correctly:
   ```bash
   cargo build --bin native_demo --no-default-features --features native-host --release
   ```

2. Run the demo:
   ```bash
   ./target/release/native_demo --host JACK
   ```

3. The chorus is enabled in the Lead synth track (line 524 of `src/bin/composition.rs`)

## Technical Details

### Why the Build Flag Matters
- Default features: `default = ["wasm"]` in Cargo.toml
- Without `--no-default-features`, both `wasm` AND `native-host` features are enabled
- The `#[cfg_attr(feature = "wasm", wasm_bindgen)]` attributes become active
- wasm-bindgen functions panic on non-wasm32 targets

### Numerical Stability Improvements
The safety checks prevent:
- Feedback loop instability from causing signal explosion
- NaN propagation from uninitialized or corrupted filter states
- Platform-specific floating-point edge cases
- SIMD rounding differences between architectures

All checks are designed to be minimal-impact on performance while providing robustness across platforms.
