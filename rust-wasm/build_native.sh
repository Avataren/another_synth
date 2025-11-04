#!/bin/bash
# Build script for native demo
# This disables the wasm feature which is enabled by default

echo "Building native demo (release mode)..."
cargo build --bin native_demo --no-default-features --features native-host --release

if [ $? -eq 0 ]; then
    echo ""
    echo "Build successful!"
    echo "Run with: ./target/release/native_demo [--host JACK|ALSA] [--buffer-size 128]"
    echo ""
    echo "Available options:"
    echo "  --list-hosts        List available audio hosts"
    echo "  --host <name>       Use specific audio host (JACK, ALSA, etc.)"
    echo "  --buffer-size <N>   Set buffer size in frames"
fi
