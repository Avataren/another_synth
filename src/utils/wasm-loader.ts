// src/utils/wasmLoader.ts


export async function loadAndCompileWasm(): Promise<WebAssembly.Module> {
    const wasmPath = new URL('/public/wasm/release.wasm', import.meta.url).href; // Correct path for the public directory
    console.log('Fetching WASM from:', wasmPath);

    const response = await fetch(wasmPath);
    if (!response.ok) {
        throw new Error(`Failed to fetch WASM: ${response.statusText}`);
    }

    const wasmBuffer = await response.arrayBuffer();
    return WebAssembly.compile(wasmBuffer);
}

export async function loadWasmBinary(path: string): Promise<ArrayBuffer> {
    const response = await fetch(path);
    if (!response.ok) {
        throw new Error(`Failed to fetch WASM binary: ${response.statusText}`);
    }
    return response.arrayBuffer();
}
