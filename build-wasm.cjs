const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const RUST_DIR = path.join(__dirname, 'rust-wasm');
const WASM_DIST = path.join(__dirname, 'public', 'wasm');

const WASM_PACK_VERSION = '0.13.1';

function getLocalWasmPackCandidates() {
  const candidates = [];
  const binName = process.platform === 'win32' ? 'wasm-pack.cmd' : 'wasm-pack';

  // Prefer a project-local installation if it exists
  candidates.push(path.join(__dirname, 'node_modules', '.bin', binName));

  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    const cargoBin =
      process.platform === 'win32'
        ? path.join(homeDir, '.cargo', 'bin', 'wasm-pack.exe')
        : path.join(homeDir, '.cargo', 'bin', 'wasm-pack');
    candidates.push(cargoBin);
  }

  // Finally rely on PATH resolution as a fallback
  candidates.push('wasm-pack');

  return candidates;
}

function ensureWasmPack() {
  for (const candidate of getLocalWasmPackCandidates()) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch (error) {
      // Ignore resolution errors and keep looking.
    }
  }

  console.log('⬇️  Installing wasm-pack via cargo...');
  try {
    execFileSync('cargo', ['install', 'wasm-pack', '--version', WASM_PACK_VERSION], {
      stdio: 'inherit',
    });
  } catch (installError) {
    throw new Error(
      'Failed to install wasm-pack automatically. Please install it manually (https://rustwasm.github.io/wasm-pack/installer/) and retry.',
    );
  }

  // After installing, try to find it again so we can return the concrete path.
  for (const candidate of getLocalWasmPackCandidates()) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch (error) {
      // Ignore and continue – the installation should have created one of these.
    }
  }

  throw new Error('wasm-pack installation succeeded but the binary could not be located.');
}

function buildWasm() {
  try {
    console.log('🦀 Building Rust WebAssembly...');
    const wasmPackBinary = ensureWasmPack();
    const enableWasmOpt = Boolean(
      process.env.ENABLE_WASM_OPT && !['0', 'false', 'no'].includes(process.env.ENABLE_WASM_OPT.toLowerCase()),
    );

    const wasmPackArgs = ['build'];
    if (!enableWasmOpt) {
      console.log('⚙️  Skipping wasm-opt (set ENABLE_WASM_OPT=1 to enable).');
      wasmPackArgs.push('--no-opt');
    }

    wasmPackArgs.push('--target', 'web', '--release', '.');

    execFileSync(wasmPackBinary, wasmPackArgs, {
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
