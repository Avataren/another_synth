# Project Guidelines for Claude

## Build Commands
- Build all: `npm run build`
- WASM: `npm run build:wasm`
- Worklets: `npm run build:worklets`
- Playback library: `npm run build:tracker-playback`
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

## Tracker Playback Library
- `packages/tracker-playback` is an npm workspace published as
  `@another-synth/tracker-playback` — the standalone replay core, with no Vue,
  Pinia, Quasar or WASM dependency.
- It owns the whole import path: parsers (MOD/XM/S3M), the row model
  (`tracker-types.ts`), note/effect parsing (`note-utils.ts`), both halves of
  each importer (`import/*-patterns.ts` and `import/*-samples.ts`), the
  instrument descriptor (`tracker-sample.ts`), the `PlaybackSong` builder, the
  engine and the effect processor.
- The app resolves the package to **source**, not `dist` — aliased in
  `vitest.config.ts`, `quasar.config.ts` and `tsconfig.json`. So nothing has to
  be built before `quasar dev`, and nothing in CI exercises `dist`.
- Import it by package name (`@another-synth/tracker-playback`), never by a
  relative path into `packages/`. Add new modules to its `index.ts`; it uses
  `export *`, so exported names must stay globally unique across the package.
- Sound too: `TrackerSink` (the 21-member interface a sound source provides),
  `TrackerSamplerInstrument` (the Web Audio voice) and `StandaloneTrackerSink`
  (a lean player over them).
- What stays app-side: `sampler-patch-builder.ts`, the adapter from the
  library's `TrackerSample` to this app's `Patch`; `instrument-slots.ts`, which
  fills the editor's instrument slots from it; `song-bank.ts`, which implements
  `TrackerSink` with the mixer, recording and live patch editing the editor
  needs; and `mod-instrument.ts`, now a 109-line subclass that adds `loadPatch`.
  The `*-import.ts` files are assembly only. See
  `PLAN-tracker-playback-library.md`.
- Do not widen the library to emit a `Patch`. That boundary is deliberate: a
  `Patch` is the app's synth preset, and a consumer wanting a module player
  should never see one.

## Audio Worklet Configuration
- Multi-engine architecture: Multiple AudioEngine instances per worklet
- Configuration: `src/audio/worklet-config.ts`
- Default: 2 engines × 8 voices = 16 total voices, 129 AudioParams
- Maximum: 3 engines (193 params) due to 256 AudioParam limit
- To change engine count: Edit `ENGINES_PER_WORKLET` constant
- Each engine has independent effects chain (reverb, delay, etc.)
- Voice allocation is automatic round-robin across all voices