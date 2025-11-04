#!/bin/bash
# Test script to check if chorus is causing issues

echo "Building native demo..."
cargo build --bin native_demo --features native-host --release

echo ""
echo "Running native demo for 5 seconds..."
timeout 5 ./target/release/native_demo --host JACK

echo ""
echo "Test completed"
