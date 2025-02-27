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