const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const RUST_DIR = path.join(__dirname, 'rust-wasm');
const WASM_DIST = path.join(__dirname, 'public', 'wasm');

function buildWasm() {
  try {
    console.log('🦀 Building Rust WebAssembly...');
    execSync('wasm-pack build --target web --release .', {
      cwd: RUST_DIR,
      stdio: 'inherit',
    });

    // Ensure the wasm directory exists
    if (!fs.existsSync(WASM_DIST)) {
      fs.mkdirSync(WASM_DIST, { recursive: true });
    }

    // Copy the generated files
    fs.copyFileSync(
      path.join(RUST_DIR, 'pkg', 'audio_processor.js'),
      path.join(WASM_DIST, 'audio_processor.js'),
    );
    fs.copyFileSync(
      path.join(RUST_DIR, 'pkg', 'audio_processor_bg.wasm'),
      path.join(WASM_DIST, 'audio_processor_bg.wasm'),
    );

    console.log('✅ WebAssembly build complete!');
    return true;
  } catch (error) {
    console.error('❌ WebAssembly build failed:', error);
    return false;
  }
}

// Handle command line arguments
const args = process.argv.slice(2);
const watchMode = args.includes('--watch');

if (watchMode) {
  console.log('👀 Watching Rust files for changes...');

  let buildInProgress = false;

  // Watch Rust source files
  chokidar
    .watch(path.join(RUST_DIR, 'src', '**', '*.rs'), {
      ignoreInitial: false,
    })
    .on('change', async (path) => {
      // Prevent multiple simultaneous builds
      if (buildInProgress) {
        console.log('⏳ Build already in progress, skipping...');
        return;
      }

      console.log(`🔄 Rust file changed: ${path}`);
      buildInProgress = true;
      buildWasm();
      buildInProgress = false;
    })
    .on('error', (error) => {
      console.error('❌ Watcher error:', error);
      buildInProgress = false;
    });
} else {
  // In non-watch mode, exit with error code if build fails
  if (!buildWasm()) {
    process.exit(1);
  }
}
