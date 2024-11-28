// src/utils/wasmLoader.ts

interface WasmExports {
  allocateF32Array: (length: number) => number;
  createBufferOffsets: (
    output: number,
    frequency: number,
    gain: number,
    detune: number,
    gate: number,
    oscillator1State: number,
    oscillator2State: number,
  ) => number;
  fillSine: (
    offsetsPtr: number,
    envPtr: number,
    length: number,
    sampleRate: number,
  ) => void;
  createEnvelopeState: (
    attackTime: number,
    decayTime: number,
    sustainLevel: number,
    releaseTime: number,
  ) => number;
  createOscillatorState: () => number;
}

export async function loadWasmModule(
  path: string,
  memory: WebAssembly.Memory,
): Promise<WasmExports> {
  const response = await fetch(path);

  if (!response.ok) {
    throw new Error(`Failed to fetch WASM module: ${response.statusText}`);
  }

  const { instance } = await WebAssembly.instantiateStreaming(response, {
    env: {
      memory,
      // Add any environment imports you need for the WASM module here
      abort(
        message: number,
        fileName: number,
        lineNumber: number,
        columnNumber: number,
      ) {
        console.error(
          `Abort called at ${message}, ${fileName}:${lineNumber}:${columnNumber}`,
        );
      },
    },
  });

  return instance.exports as unknown as WasmExports;
}

// export async function loadAndCompileWasm(): Promise<WebAssembly.Module> {
//     const wasmPath = new URL('/public/wasm/release.wasm', import.meta.url).href; // Correct path for the public directory
//     console.log('Fetching WASM from:', wasmPath);

//     const response = await fetch(wasmPath);
//     if (!response.ok) {
//         throw new Error(`Failed to fetch WASM: ${response.statusText}`);
//     }

//     const wasmBuffer = await response.arrayBuffer();
//     return WebAssembly.compile(wasmBuffer);

// }

export async function loadWasmBinary(path: string): Promise<ArrayBuffer> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to fetch WASM binary: ${response.statusText}`);
  }
  return response.arrayBuffer();
}
