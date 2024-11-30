const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const rootDir = __dirname;
const targetDir = path.join(rootDir, '..', 'public', 'wasm');

// Helper function to copy directory recursively
function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log(`Copied ${entry.name} to ${destPath}`);
    }
  }
}

// Set environment variables for Rust compilation
process.env.RUSTFLAGS =
  '-C target-feature=+atomics,+bulk-memory,+mutable-globals';

try {
  // Ensure target directory exists and is empty
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  console.log('Building Rust project with atomics...');
  execSync(
    'cargo build --target wasm32-unknown-unknown --release -Z build-std=std,panic_abort',
    {
      cwd: rootDir,
      stdio: 'inherit',
    },
  );

  console.log('Running wasm-bindgen...');
  const wasmPath = path.join(
    rootDir,
    'target',
    'wasm32-unknown-unknown',
    'release',
    'wasm_audio_worklet.wasm',
  );

  const outDir = path.join(rootDir, 'pkg');

  execSync(
    `wasm-bindgen ${wasmPath} --out-dir ${outDir} --target web --split-linked-modules`,
    {
      cwd: rootDir,
      stdio: 'inherit',
    },
  );

  // Copy everything from pkg to public/wasm
  console.log('Copying files to public/wasm/...');
  copyDir(outDir, targetDir);

  console.log('Build completed successfully!');
} catch (error) {
  console.error('Build failed:', error);
  process.exit(1);
}
