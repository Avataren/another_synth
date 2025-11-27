# Tracker AudioWorklet Scheduling (Tracker)

This note describes how tracker playback schedules work into the synth worklet today and where we could improve it.

## Current scheduling pipeline
- **PlaybackEngine lookahead**: `packages/tracker-playback/src/engine.ts:38-112` selects an AudioContext-backed scheduler when available and falls back to a 16 ms interval. It uses a 0.5 s lookahead window (`SCHEDULE_AHEAD_TIME`) driven by `requestAnimationFrame` while visible and a 16 ms interval when hidden (`switchToRAF`/`switchToInterval`).
- **Row timing**: On `play()`, `startScheduledPlayback` seeds `nextRowTime` with `audioContext.currentTime` (`engine.ts:281-303`). `scheduleAhead` advances `nextRowTime` cumulatively by `getMsPerRow` so tempo/speed changes applied in earlier rows stay in effect (`engine.ts:318-372`).
- **Per-row dispatch**: `scheduleRow` first applies Fxx tempo/speed and position commands so later steps use the updated timing (`engine.ts:401-435`). It then walks each step, scheduling:
  - Note on/off events via the `scheduledNoteHandler` with absolute audio times (`engine.ts:455-508`).
  - Per-tick effects (portamento, vibrato, tremolo, retrig, note cut/delay) by scheduling pitch/volume/retrigger events at `time + tick * secPerTick` (`engine.ts:511-518`, `engine.ts:520-520` and onward).
  - Macro automation via `scheduledMacroHandler` when present.
  Position commands (Bxx/Dxx) are handed off to the host via `positionCommandHandler` after the row is scheduled.
- **SongBank as the scheduled handler**: In tracker mode, the `scheduledNoteHandler` comes from `TrackerSongBank` (`src/audio/tracker/song-bank.ts:592-681`). It:
  - Ensures per-track mono behaviour by gating off the previously used voice for that track unless portamento is active (`song-bank.ts:420-435`).
  - Emits scheduled gate/frequency/gain changes through `InstrumentV2.noteOnAtTime` / `noteOffAtTime`.
  - Uses a gate-low lead of one render quantum (or ≥5 ms fallback) so envelopes see a retrigger even on mono voices (`song-bank.ts:430-435`).
- **Instrument → Worklet scheduling**: `InstrumentV2.noteOnAtTime` writes directly to `AudioParam` timelines on the worklet node (`gate_*`, `frequency_*`, `gain_*`) using `setValueAtTime` (`src/audio/instrument-v2.ts:956-995`). On retriggers it emits a short gate pulse sized to the worklet’s reported block size to guarantee an edge the worklet can see (`instrument-v2.ts:971-986`, block size is learned from the worklet’s `blockSize` message at startup).
- **Context readiness and patch prep**: `TrackerSongBank.syncSlots` waits for the AudioContext to be running (polling for up to 10 s) and recreates instruments after a resume to avoid stale worklets (`song-bank.ts:138-220`). `PlaybackEngine.play` awaits `prepareInstruments()` so patch loading finishes before scheduling (`engine.ts:232-246`).
- **Hidden-tab behaviour**: The scheduling loop continues with a throttled 16 ms interval (`engine.ts:153-168`). Row scheduling still uses absolute `audioContext.currentTime`, but the loop depends on timers firing frequently enough to maintain the 0.5 s lookahead.

## Current pain points
- **Dropped events while suspended/unready**: If `noteOnAtTime` arrives while the context is suspended or the instrument is still spinning up, the call logs a warning and returns without rescheduling, so early playback after resume can lose notes (`song-bank.ts:598-675`).
- **Main-thread timing sensitivity**: The 0.5 s lookahead assumes the scheduling loop wakes at least twice a second. Heavy throttling (background tabs or long tasks) can stall the loop long enough to miss the window and bunch or drop rows.
- **Debug-only immediate path**: `noteOnAtTime` falls back to an immediate `noteOn` when the target time is <10 ms away and assumes voice 0 (`song-bank.ts:642-655`). This bypasses track voice bookkeeping and scheduled gate pulses, so jitter near “now” can produce inconsistent retriggers.
- **Lack of drift/jitter telemetry**: We don’t record how close `scheduleAhead` runs to its deadline or whether events are being scheduled late, making it hard to tune `SCHEDULE_AHEAD_TIME` or detect timer throttling in the field.

## Possible improvements
1) **Queue while resuming**: Add a small buffer in `SongBank` that stores scheduled note/automation events whenever the context is suspended or an instrument is pending, then flushes them once `ensureAudioContextRunning()` succeeds. This would prevent silent first bars after a resume or patch swap.
2) **Adaptive lookahead & throttling guard**: Increase the lookahead (e.g., to 1–2 s) when the document is hidden or when we detect the scheduling loop running late, or move the lookahead loop into a Worker/AudioWorklet to avoid tab throttling entirely.
3) **Remove/guard the immediate path**: Gate the “useImmediate” branch in `noteOnAtTime` behind a debug flag and keep production scheduling on the AudioParam timeline so voice tracking and gate pulses stay consistent even when events land close to `currentTime`.
4) **Add jitter instrumentation**: Track the delta between `scheduleUntil` and the actual call time, plus how far scheduled rows are into the future. Emit warnings or back off BPM/advance lookahead automatically when the loop is consistently late.
5) **Pre-flight readiness checks**: Let `PlaybackEngine` ask `SongBank` for a “ready at time T” promise per instrument so it can defer scheduling a pattern until every referenced instrument has signalled readiness, instead of logging and dropping events when a slot is still loading.
