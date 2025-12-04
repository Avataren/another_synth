# Project Guidelines for Claude

## Build Commands
- Build all: `npm run build`  
- WASM: `npm run build:wasm`
- Worklets: `npm run build:worklets`
- Development: `npm run dev`

## Lint & Test Commands
- Lint: `npm run lint`
- Format: `npm run format`
- Test all: `npm run test`
- Single test: `npm run test -- -t "test pattern"`

## Code Style
- TypeScript: strict typing, explicit interfaces
- Naming: PascalCase for components, kebab-case for files
- Quotes: single quotes, semicolons required
- Imports: use TypeScript's `type-imports`

## Vue Components
- Use Vue 3 with Composition API and `<script setup>`
- Props with explicit TypeScript interfaces
- Components should emit events for parent handling

## Architecture
- Vue/Quasar for UI, Pinia for state
- Rust-compiled WebAssembly for audio processing
- DSP algorithms in TS and Rust
- Audio worklets for real-time processing

## Audio Worklet Configuration
- Multi-engine architecture: Multiple AudioEngine instances per worklet
- Configuration: `src/audio/worklet-config.ts`
- Default: 2 engines × 8 voices = 16 total voices, 129 AudioParams
- Maximum: 3 engines (193 params) due to 256 AudioParam limit
- To change engine count: Edit `ENGINES_PER_WORKLET` constant
- Each engine has independent effects chain (reverb, delay, etc.)
- Voice allocation is automatic round-robin across all voices