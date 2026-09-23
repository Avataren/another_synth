// Instrument lifecycle for TrackerSongBank.
//
// Extracted verbatim from song-bank.ts (arch-review §2b + N4, 2026-09-23):
// ensureInstrument/ensureInstrumentInternal, patch normalisation
// (normalizePatch*), asset restoration (restoreAudioAssets/parseWavInfo),
// state application (applyNodeStates/applySamplerStates/
// applyMacrosFromPatch), reuse-keying (getPatchReuseKey) and teardown
// (teardownInstrument). Moved as ONE gated unit; the state these read and
// maintain -- pendingInstruments (per-id init promises) and restoredAssets
// (per-id imported-asset dedup) -- moved with them. Bank-owned state the
// lifecycle touches (instruments/activeNotes maps, eventQueue, voice
// registry, pool, format profile, generation, resume flags) is injected; the
// bank keeps ownership and its own readers.
//
// Zero behavior change: bodies are the moved song-bank code with only the
// `this.` reads of injected state routed through `deps` (functions for
// mutable bank state, shared objects by reference).

import type AudioSystem from 'src/audio/AudioSystem';
import type { FormatProfile } from '@another-synth/tracker-playback';
import InstrumentV2 from 'src/audio/instrument-v2';
import ModInstrument from 'src/audio/mod-instrument';
import { VOICES_PER_ENGINE } from '../worklet-config';
import { PooledInstrument } from 'src/audio/pooled-instrument-factory';
import type { WorkletPool } from 'src/audio/worklet-pool';
import type {
  AudioAsset,
  Patch,
  MacroRouteState,
} from 'src/audio/types/preset-types';
import {
  deserializePatch,
  type DeserializedPatch,
  parseAudioAssetId,
} from 'src/audio/serialization/patch-serializer';
import {
  WasmModulationType,
  ModulationTransformation,
  PortId,
} from 'app/public/wasm/audio_processor';
import {
  synthLayoutToPatchLayout,
  type SynthLayout,
  type FilterState,
  type EnvelopeConfig,
  type LfoState,
  type SamplerState,
  type GlideState,
  type ConvolverState,
  type DelayState,
  type ChorusState,
  type ReverbState,
  type CompressorState,
  type SaturationState,
  type BitcrusherState,
} from 'src/audio/types/synth-layout';
import type OscillatorState from 'src/audio/models/OscillatorState';
import {
  PRESET_SCHEMA_VERSION,
  type PatchMetadata,
  type SynthState,
} from 'src/audio/types/preset-types';
import {
  combineDetuneParts,
  frequencyFromDetune,
} from 'src/audio/utils/sampler-detune';
import { useUserSettingsStore } from 'src/stores/user-settings-store';
import type { ScheduledEventQueue } from './scheduled-events';
import { isSamplerInstrumentType } from './instrument-types';
import type { TrackVoiceRegistry } from './track-voice-registry';
import type { ActiveInstrument } from './song-bank';
import type { BankInstrument } from './bank-instrument';

/**
 * Resume bookkeeping shared with the bank: the lifecycle arm these flags
 * when it builds an instrument against a suspended context, and the bank
 * reads them in syncSlots, ensureAudioContextRunning and the context's
 * onstatechange handler to rebuild instruments on resume.
 */
export interface ResumeFlags {
  wasSuspended: boolean;
  needsAudioContextResume: boolean;
}

export interface InstrumentLifecycleDeps {
  readonly audioSystem: AudioSystem;
  readonly masterGain: GainNode;
  readonly audioContext: AudioContext;
  /** Read live: setModuleFormat can swap this between builds. */
  readonly formatProfile: () => FormatProfile;
  readonly useWorkletPooling: () => boolean;
  /** Read live: dispose() nulls the pool; lifecycle must see that. */
  readonly workletPool: () => WorkletPool | null;
  /** All live instruments, by id. Shared with the bank. */
  readonly instruments: Map<string, ActiveInstrument>;
  /** Per-instrument active note sets. Shared with the bank. */
  readonly activeNotes: Map<string, Map<number, Set<number>>>;
  readonly eventQueue: ScheduledEventQueue;
  readonly voices: TrackVoiceRegistry;
  /** Monotonic build generation; stale builds are discarded on mismatch. */
  readonly generation: () => number;
  readonly flags: ResumeFlags;
}

export class InstrumentLifecycle {
  private readonly pendingInstruments: Map<string, Promise<void>> = new Map();
  private readonly restoredAssets: Map<string, Set<string>> = new Map();

  constructor(private readonly deps: InstrumentLifecycleDeps) {}

  /** Drop pending init promises (resetForNewSong path). */
  clearPendingInstruments() {
    this.pendingInstruments.clear();
  }

  /** Drop the imported-asset dedup set (dispose path). */
  clearRestoredAssets() {
    this.restoredAssets.clear();
  }

  public async ensureInstrument(
    instrumentId: string,
    patch: Patch,
  ): Promise<void> {
    const generation = this.deps.generation();
    // Check if this instrument is already being initialized
    const pending = this.pendingInstruments.get(instrumentId);
    if (pending) {
      await pending;
      return;
    }

    // Start initialization and track the promise
    const initPromise = this.ensureInstrumentInternal(
      instrumentId,
      patch,
      generation,
    );
    this.pendingInstruments.set(instrumentId, initPromise);

    try {
      await initPromise;
    } finally {
      // Clean up the pending promise when done
      this.pendingInstruments.delete(instrumentId);
    }
  }

  private async ensureInstrumentInternal(
    instrumentId: string,
    patch: Patch,
    generation: number,
  ): Promise<void> {
    // A created-but-suspended context is enough for instrument/worklet
    // construction (fresh-tab deep links); only playback needs 'running'.
    // Only a closed context genuinely blocks construction. If still
    // suspended, needsAudioContextResume is armed (set by the bounded resume
    // attempt in syncSlots or here) and the onstatechange handler rebuilds
    // instruments built this way when the context becomes running.
    const contextState = this.deps.audioContext.state;
    if (contextState === 'closed') {
      console.warn(
        `[SongBank] Skipping ensureInstrument for ${instrumentId} because AudioContext is closed. needsResume=${this.deps.flags.needsAudioContextResume}`,
      );

      return;
    }
    if (contextState !== 'running') {
      this.deps.flags.wasSuspended = true;
      this.deps.flags.needsAudioContextResume = true;
      console.warn(
        `[SongBank] Building instrument ${instrumentId} while AudioContext is ${contextState}; it will be rebuilt when the context resumes.`,
      );
    }
    const normalizedPatch = this.normalizePatch(patch);
    const deserialized = deserializePatch(normalizedPatch);
    const patchId = normalizedPatch?.metadata?.id;
    if (!patchId) return;
    const patchReuseKey = this.getPatchReuseKey(normalizedPatch);
    const hasPortamento = this.hasActivePortamento(normalizedPatch);

    const existing = this.deps.instruments.get(instrumentId);
    const canReuse =
      existing &&
      existing.patchId === patchId &&
      patchReuseKey !== null &&
      existing.patchReuseKey === patchReuseKey;

    if (canReuse) {
      // console.log(
      //   `[SongBank] Reusing existing instrument: ${instrumentId} (skipping state reapplication to preserve live audio)`,
      // );
      existing.hasPortamento = hasPortamento;
      this.normalizeVoiceGain(existing.instrument);
      // Skip restoreAudioAssets, applyNodeStates, and applyMacros when reusing
      // These would reset effect buffers (delays, reverbs) and interrupt live playback
      // The instrument already has the correct patch loaded from previous sync
      // Verify connection is still intact, reconnect if needed
      if (existing.instrument.outputNode.numberOfOutputs === 0) {
        console.warn(
          `[SongBank] Instrument ${instrumentId} was disconnected, reconnecting...`,
        );
        existing.instrument.outputNode.connect(this.deps.masterGain);
      }
      await this.deps.eventQueue.flushPendingScheduledEvents(instrumentId);
      return;
    }

    if (existing) {
      console.log(
        `[SongBank] Tearing down existing instrument (different patch): ${instrumentId}`,
      );
      this.teardownInstrument(instrumentId);
    }

    console.log(`[SongBank] Creating new instrument: ${instrumentId}`);

    // Check if this is a MOD instrument and user has simplified MOD instruments enabled
    const userSettings = useUserSettingsStore();
    const isModInstrument = isSamplerInstrumentType(
      normalizedPatch.metadata.instrumentType,
    );
    // ModInstrument's per-voice pitch automation (e.g. 3xx tone portamento)
    // is scheduled directly on the native AudioParam (see
    // ModInstrument.setVoiceFrequencyAtTime), and MOD import/playback is
    // tuned against this path, so it defaults to ON (see SETTINGS_VERSION v1
    // in user-settings-store.ts). Users can still opt back into routing MOD
    // instruments through the full WASM synth.
    //
    // NOTE: this is app-global today. Per PLAN-module-format-support.md (D4),
    // engine choice should move into the per-song FormatProfile; ModInstrument
    // does implement XM's tracker volume/pan envelopes, auto-vibrato and
    // per-channel voice ownership, so this is an architecture cleanup rather
    // than a functional gap.
    //
    // The per-song `FormatProfile.instrumentEngine` wins when present; no
    // song sets it yet, so the global setting still decides for all of them.
    const instrumentEngine =
      this.deps.formatProfile().instrumentEngine ??
      (userSettings.settings.useSimplifiedModInstruments
        ? 'sampler'
        : 'worklet');
    const useSimplified = instrumentEngine === 'sampler';

    // DETAILED DEBUGGING
    console.log('[SongBank] === INSTRUMENT CREATION DEBUG ===');
    console.log(`[SongBank]   instrumentId: ${instrumentId}`);
    console.log(
      `[SongBank]   instrumentType: ${normalizedPatch.metadata.instrumentType}`,
    );
    console.log(`[SongBank]   isModInstrument: ${isModInstrument}`);
    console.log(`[SongBank]   useSimplified: ${useSimplified}`);
    console.log(`[SongBank]   useWorkletPooling: ${this.deps.useWorkletPooling()}`);
    console.log(
      `[SongBank]   workletPool exists: ${this.deps.workletPool() !== null}`,
    );
    console.log(
      `[SongBank]   Decision: ${
        isModInstrument && useSimplified
          ? 'ModInstrument'
          : this.deps.useWorkletPooling() && isModInstrument && this.deps.workletPool()
            ? 'PooledInstrument'
            : 'InstrumentV2 (LEGACY - CREATES OWN WORKLET!)'
      }`,
    );

    let instrument: InstrumentV2 | ModInstrument | PooledInstrument;
    // Read once for the branch below (original read this.workletPool at the
    // condition and again at allocateVoices with no await between; identical
    // here).
    const workletPool = this.deps.workletPool();

    if (isModInstrument && useSimplified) {
      // Option 1: Use ModInstrument (native Web Audio API, no worklet)
      console.log(`[SongBank] Creating ModInstrument for ${instrumentId}`);
      instrument = new ModInstrument(
        this.deps.masterGain,
        this.deps.audioSystem.audioContext,
        { pitchModel: this.deps.formatProfile().pitch },
      );

      await instrument.loadPatch(normalizedPatch);
      console.log(
        `[SongBank] ModInstrument ${instrumentId} loaded, isReady=${instrument.isReady}`,
      );
    } else if (this.deps.useWorkletPooling() && workletPool) {
      // Option 2: Use PooledInstrument (shared worklet, efficient for tracker playback)
      console.log(
        `[SongBank] Creating PooledInstrument for ${instrumentId} via WorkletPool`,
      );

      // Use the patch's requested voice count (clamped to per-engine limit)
      const requestedVoices = Math.max(
        1,
        Math.min(
          VOICES_PER_ENGINE,
          normalizedPatch?.synthState?.layout?.voiceCount ??
            normalizedPatch?.synthState?.layout?.voices?.length ??
            VOICES_PER_ENGINE,
        ),
      );

      const allocation = await workletPool.allocateVoices(
        instrumentId,
        requestedVoices,
      );

      console.log(
        `[SongBank] Allocated voices ${allocation.startVoice}-${allocation.endVoice - 1} on worklet ${allocation.workletIndex} for ${instrumentId}`,
      );

      // Create pooled instrument with the allocation
      instrument = new PooledInstrument(
        this.deps.masterGain,
        this.deps.audioSystem.audioContext,
        instrumentId,
        allocation,
      );

      await instrument.loadPatch(normalizedPatch);
      console.log(
        `[SongBank] PooledInstrument ${instrumentId} loaded, isReady=${instrument.isReady}`,
      );

      // Log pool statistics
      const stats = workletPool.getStats();
      console.log(
        `[SongBank] Pool stats: ${stats.workletCount} worklets, ${stats.allocatedVoices}/${stats.totalVoices} voices allocated`,
      );

      await this.restoreAudioAssets(
        instrumentId,
        instrument,
        normalizedPatch,
        deserialized,
      );

      // Normalize sampler loop points/detune for pooled instruments (patch stores normalized values)
      this.applySamplerStates(instrument, deserialized.samplers);

      // Apply macro values/routes so pooled instruments match the patch (e.g., vibrato depth).
      this.applyMacrosFromPatch(instrument, normalizedPatch);
    } else {
      // Option 3: Use InstrumentV2 (own worklet, for patch editor or non-MOD instruments)
      console.log(`[SongBank] Creating InstrumentV2 for ${instrumentId}`);
      const memory = new WebAssembly.Memory({
        initial: 256,
        maximum: 1024,
        shared: true,
      });
      instrument = new InstrumentV2(
        this.deps.masterGain,
        this.deps.audioSystem.audioContext,
        memory,
      );

      const ready = await this.waitForInstrumentReady(instrument);
      if (!ready) {
        console.warn('[TrackerSongBank] Instrument initialization timeout');
        instrument.outputNode.disconnect();
        return;
      }
      console.log(
        `[SongBank] Instrument ${instrumentId} worklet ready, loading patch...`,
      );

      await instrument.loadPatch(normalizedPatch);
      console.log(
        `[SongBank] Instrument ${instrumentId} patch loaded, isReady=${instrument.isReady}`,
      );
      // Give WASM time to finish building all voice node structures before updating states
      // Reduced from 100ms to 20ms - loadPatch already waits for synthLayout response,
      // this additional delay just ensures voice structures are built. Conservative reduction
      // maintains stability while reducing stutter on laptops
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Apply assets and node state in parallel to avoid serial stalls (only for InstrumentV2)
      await Promise.all([
        this.restoreAudioAssets(
          instrumentId,
          instrument,
          normalizedPatch,
          deserialized,
        ),
        this.applyNodeStates(instrument, deserialized),
      ]);

      this.applyMacrosFromPatch(instrument, normalizedPatch);
    }

    this.normalizeVoiceGain(instrument);
    if (generation !== this.deps.generation()) {
      console.warn(
        `[SongBank] Discarding instrument ${instrumentId} from previous generation`,
      );
      instrument.dispose();
      return;
    }
    this.deps.instruments.set(instrumentId, {
      instrument,
      patchId,
      patchReuseKey,
      hasPortamento,
    });
    await this.deps.eventQueue.flushPendingScheduledEvents(instrumentId);
  }

  private normalizeVoiceGain(instrument: BankInstrument) {
    // Ensure voice gains aren't left at a previous automation value (e.g. 0)
    instrument.setGainForAllVoices(1);
  }

  public async restoreAudioAssets(
    instrumentId: string,
    instrument: InstrumentV2 | PooledInstrument,
    patch: Patch,
    deserialized: DeserializedPatch,
  ): Promise<void> {
    const assets = patch.audioAssets;
    if (!assets || Object.keys(assets).length === 0) {
      return;
    }

    // Track imported assets per instrument to avoid re-importing (expensive for wavetables).
    let seen = this.restoredAssets.get(instrumentId);
    if (!seen) {
      seen = new Set<string>();
      this.restoredAssets.set(instrumentId, seen);
    }

    const assetEntries = Object.entries(assets) as [string, AudioAsset][];
    for (const [assetId, asset] of assetEntries) {
      try {
        if (seen.has(assetId)) continue;
        const parsed = parseAudioAssetId(assetId);
        if (!parsed) continue;
        const { nodeType, nodeId } = parsed;

        const binaryData = atob(asset.base64Data);
        const bytes = new Uint8Array(binaryData.length);
        for (let i = 0; i < binaryData.length; i++) {
          bytes[i] = binaryData.charCodeAt(i);
        }

        if (nodeType === 'sample') {
          const wavInfo = this.parseWavInfo(bytes);
          if (wavInfo) {
            const samplerState = deserialized.samplers.get(nodeId);
            if (samplerState) {
              deserialized.samplers.set(nodeId, {
                ...samplerState,
                sampleLength: wavInfo.frames,
                sampleRate: wavInfo.sampleRate,
                channels: wavInfo.channels,
              });
            }
          }
          await instrument.importSampleData(nodeId, bytes);
        } else if (nodeType === 'impulse_response') {
          await instrument.importImpulseWaveformData(nodeId, bytes);
        } else if (nodeType === 'wavetable') {
          await instrument.importWavetableData(nodeId, bytes);
        }
        seen.add(assetId);
      } catch (error) {
        console.error(
          `[TrackerSongBank] Failed to restore audio asset ${assetId}:`,
          error,
        );
      }
    }
  }

  private applyMacrosFromPatch(
    instrument: InstrumentV2 | PooledInstrument,
    patch: Patch,
  ) {
    const macros = patch?.synthState?.macros;
    if (!macros) return;

    if (Array.isArray(macros.values)) {
      macros.values.forEach((value, index) => {
        if (Number.isFinite(value)) {
          instrument.setMacro(index, Number(value));
        }
      });
    }

    if (Array.isArray(macros.routes)) {
      (macros.routes as MacroRouteState[]).forEach((route) => {
        if (!route || route.targetId === undefined) return;

        const macroIndex = Number(route.macroIndex);
        if (!Number.isFinite(macroIndex) || macroIndex < 0) return;

        const targetPort = Number(route.targetPort ?? PortId.AudioInput0);
        const amount = Number(route.amount ?? 0);
        const modulationType =
          (route.modulationType as WasmModulationType | undefined) ??
          WasmModulationType.Additive;
        const modulationTransformation =
          (route.modulationTransformation as
            | ModulationTransformation
            | undefined) ?? ModulationTransformation.None;

        instrument.connectMacroRoute({
          macroIndex,
          targetId: route.targetId,
          targetPort: targetPort as PortId,
          amount,
          modulationType,
          modulationTransformation,
        });
      });
    }
  }

  private async waitForInstrumentReady(
    instrument: InstrumentV2,
    timeoutMs = 8000,
    pollMs = 50,
  ): Promise<boolean> {
    const start = Date.now();
    while (!instrument.isReady) {
      if (Date.now() - start > timeoutMs) {
        console.warn(
          '[TrackerSongBank] Timed out waiting for instrument readiness',
        );
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return true;
  }

  public hasActivePortamento(patch: Patch): boolean {
    const glides = patch?.synthState?.glides;
    if (!glides) return false;
    return Object.values(glides).some((glide) => {
      if (!glide) return false;
      const time = Number(glide.time ?? 0);
      const active = !!glide.active;
      return active && time > 0;
    });
  }

  /**
   * Normalize a patch so tracker playback uses the same upgraded shapes
   * as the patch editor (fills missing fields, canonical voice, etc.).
   */
  public normalizePatch(patch: Patch): Patch {
    try {
      const deserialized = deserializePatch(patch);
      const metadata = this.normalizePatchMetadata(patch.metadata);
      const synthState: SynthState = {
        layout: this.normalizePatchLayout(deserialized.layout),
        oscillators: this.mapToRecord(deserialized.oscillators),
        wavetableOscillators: this.mapToRecord(
          deserialized.wavetableOscillators,
        ),
        filters: this.mapToRecord(deserialized.filters),
        envelopes: this.mapToRecord(deserialized.envelopes),
        lfos: this.mapToRecord(deserialized.lfos),
        samplers: this.mapToRecord(deserialized.samplers),
        glides: this.mapToRecord(deserialized.glides),
        convolvers: this.mapToRecord(deserialized.convolvers),
        delays: this.mapToRecord(deserialized.delays),
        choruses: this.mapToRecord(deserialized.choruses),
        reverbs: this.mapToRecord(deserialized.reverbs),
        compressors: this.mapToRecord(deserialized.compressors),
        saturations: this.mapToRecord(deserialized.saturations),
        bitcrushers: this.mapToRecord(deserialized.bitcrushers),
      };

      if (deserialized.noise !== undefined) {
        synthState.noise = deserialized.noise;
      }
      if (deserialized.velocity !== undefined) {
        synthState.velocity = deserialized.velocity;
      }
      if (deserialized.macros) {
        synthState.macros = {
          values: deserialized.macros.values ?? [],
          routes: deserialized.macros.routes ?? [],
        };
      }

      return {
        metadata,
        synthState,
        audioAssets: this.mapToRecord(deserialized.audioAssets),
      };
    } catch (error) {
      console.warn(
        '[TrackerSongBank] Failed to normalize patch; using raw patch',
        error,
      );
      return patch;
    }
  }

  private normalizePatchLayout(layout: SynthLayout): SynthState['layout'] {
    return synthLayoutToPatchLayout(layout);
  }

  private normalizePatchMetadata(metadata: PatchMetadata): PatchMetadata {
    const safeTags = Array.isArray(metadata?.tags)
      ? [...metadata.tags]
      : undefined;
    const created = metadata?.created ?? metadata?.modified ?? 0;
    const modified = metadata?.modified ?? metadata?.created ?? created;
    return {
      id: metadata?.id ?? `song-patch-${created || Date.now()}`,
      name: metadata?.name ?? 'Untitled',
      created,
      modified,
      version: metadata?.version ?? PRESET_SCHEMA_VERSION,
      ...(typeof metadata?.category === 'string'
        ? { category: metadata.category }
        : {}),
      ...(typeof metadata?.author === 'string'
        ? { author: metadata.author }
        : {}),
      ...(safeTags ? { tags: safeTags } : {}),
      ...(typeof metadata?.description === 'string'
        ? { description: metadata.description }
        : {}),
      ...(metadata?.instrumentType
        ? { instrumentType: metadata.instrumentType }
        : {}),
    };
  }

  private mapToRecord<T>(map: Map<string, T>): Record<string, T> {
    const record: Record<string, T> = {};
    map.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }

  private async applyNodeStates(
    instrument: InstrumentV2,
    deserialized: DeserializedPatch,
  ): Promise<void> {
    deserialized.oscillators.forEach(
      (state: OscillatorState, nodeId: string) => {
        instrument.updateOscillatorState(nodeId, { ...state, id: nodeId });
      },
    );

    deserialized.wavetableOscillators.forEach(
      (state: OscillatorState, nodeId: string) => {
        instrument.updateWavetableOscillatorState(nodeId, {
          ...state,
          id: nodeId,
        });
      },
    );

    const envelopePromises: Promise<void>[] = [];
    deserialized.envelopes.forEach((state: EnvelopeConfig, nodeId: string) => {
      envelopePromises.push(
        instrument.updateEnvelopeState(nodeId, {
          ...state,
          id: nodeId,
        }),
      );
    });

    deserialized.lfos.forEach((state: LfoState, nodeId: string) => {
      instrument.updateLfoState(nodeId, {
        id: nodeId,
        frequency: state.frequency,
        phaseOffset: state.phaseOffset ?? 0,
        waveform: state.waveform,
        useAbsolute: state.useAbsolute,
        useNormalized: state.useNormalized,
        triggerMode: state.triggerMode,
        gain: state.gain,
        active: state.active,
        loopMode: state.loopMode,
        loopStart: state.loopStart,
        loopEnd: state.loopEnd,
      });
    });

    deserialized.filters.forEach((state: FilterState, nodeId: string) => {
      instrument.updateFilterState(nodeId, { ...state, id: nodeId });
    });

    deserialized.glides.forEach((state: GlideState, nodeId: string) => {
      instrument.updateGlideState(nodeId, { ...state, id: nodeId });
    });

    deserialized.convolvers.forEach((state: ConvolverState, nodeId: string) => {
      instrument.updateConvolverState(nodeId, { ...state, id: nodeId });
    });

    deserialized.delays.forEach((state: DelayState, nodeId: string) => {
      instrument.updateDelayState(nodeId, { ...state, id: nodeId });
    });

    deserialized.choruses.forEach((state: ChorusState, nodeId: string) => {
      instrument.updateChorusState(nodeId, { ...state, id: nodeId });
    });

    deserialized.reverbs.forEach((state: ReverbState, nodeId: string) => {
      instrument.updateReverbState(nodeId, { ...state, id: nodeId });
    });

    deserialized.compressors.forEach(
      (state: CompressorState, nodeId: string) => {
        instrument.updateCompressorState(nodeId, { ...state, id: nodeId });
      },
    );

    deserialized.saturations.forEach(
      (state: SaturationState, nodeId: string) => {
        instrument.updateSaturationState(nodeId, { ...state, id: nodeId });
      },
    );

    deserialized.bitcrushers.forEach(
      (state: BitcrusherState, nodeId: string) => {
        instrument.updateBitcrusherState(nodeId, { ...state, id: nodeId });
      },
    );

    this.applySamplerStates(instrument, deserialized.samplers);

    await Promise.all(envelopePromises);
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }

  private buildSamplerUpdatePayload(state: SamplerState) {
    const sampleLength = Math.max(
      1,
      state.sampleLength || state.sampleRate || 1,
    );
    const loopStartNorm = this.clamp01(state.loopStart ?? 0);
    const requestedEnd = this.clamp01(state.loopEnd ?? 1);
    const minDelta = 1 / sampleLength;
    const loopEndNorm =
      requestedEnd <= loopStartNorm + minDelta
        ? Math.min(1, loopStartNorm + minDelta)
        : requestedEnd;
    const detuneCents = Number.isFinite(state.detune)
      ? (state.detune as number)
      : combineDetuneParts(
          state.detune_oct ?? 0,
          state.detune_semi ?? 0,
          state.detune_cents ?? 0,
        );
    const tuningFrequency = frequencyFromDetune(detuneCents);

    return {
      frequency: tuningFrequency,
      // Avoid silent samplers when gain is 0 (common for MOD imports that rely on Axx/Cxx to fade in)
      gain: state.gain === 0 ? 1 : state.gain,
      loopMode: state.loopMode,
      loopStart: loopStartNorm * sampleLength,
      loopEnd: loopEndNorm * sampleLength,
      rootNote: state.rootNote,
      triggerMode: state.triggerMode,
      active: state.active,
    };
  }

  private applySamplerStates(
    instrument: InstrumentV2 | PooledInstrument,
    samplers: Map<string, SamplerState>,
  ) {
    samplers.forEach((state: SamplerState, nodeId: string) => {
      instrument.updateSamplerState(
        nodeId,
        this.buildSamplerUpdatePayload(state),
      );
    });
  }

  /**
   * Minimal WAV header parser to extract sample rate, channels, and frame count.
   */
  private parseWavInfo(
    bytes: Uint8Array,
  ): { sampleRate: number; channels: number; frames: number } | null {
    const getString = (offset: number, length: number) =>
      String.fromCharCode(...bytes.slice(offset, offset + length));
    const getUint32LE = (offset: number) =>
      ((bytes[offset] ?? 0) |
        ((bytes[offset + 1] ?? 0) << 8) |
        ((bytes[offset + 2] ?? 0) << 16) |
        ((bytes[offset + 3] ?? 0) << 24)) >>>
      0;
    const getUint16LE = (offset: number) =>
      ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;

    if (bytes.length < 44) return null;
    if (getString(0, 4) !== 'RIFF' || getString(8, 4) !== 'WAVE') return null;

    let offset = 12;
    let fmtSampleRate = 0;
    let fmtChannels = 0;
    let bitsPerSample = 16;
    let dataSize = 0;

    while (offset + 8 <= bytes.length) {
      const chunkId = getString(offset, 4);
      const chunkSize = getUint32LE(offset + 4);
      const next = offset + 8 + chunkSize;
      if (chunkId === 'fmt ') {
        fmtChannels = getUint16LE(offset + 10);
        fmtSampleRate = getUint32LE(offset + 12);
        bitsPerSample = getUint16LE(offset + 22);
      } else if (chunkId === 'data') {
        dataSize = chunkSize;
      }
      offset = next;
    }

    if (!fmtSampleRate || !fmtChannels || !dataSize) return null;
    const bytesPerSample = (bitsPerSample / 8) * fmtChannels;
    if (!bytesPerSample) return null;
    const frames = Math.floor(dataSize / bytesPerSample);
    return {
      sampleRate: fmtSampleRate,
      channels: fmtChannels,
      frames,
    };
  }

  /**
   * Key used to decide whether a slot's currently-live instrument can be
   * reused as-is (same key) or must be torn down and rebuilt (different
   * key). Deliberately just `id:revision`, not a hash of the patch's
   * content: `metadata.revision` is only ever incremented by patchStore
   * when a real, detected edit is saved (see patchStore.isDirty /
   * IndexPage.vue saveSongPatch) -- unlike `metadata.modified`, which used
   * to be bumped on every save regardless of whether anything actually
   * changed, forcing a rebuild (and losing live envelope/oscillator/LFO
   * phase) on every no-op editor visit. Comparing the explicit revision is
   * both cheaper and more honest about what it's actually testing than
   * hashing a multi-KB JSON blob of synthState + audioAssets on every sync.
   */
  public getPatchReuseKey(patch: Patch): string | null {
    const id = patch?.metadata?.id;
    if (!id) return null;
    return `${id}:${patch?.metadata?.revision ?? 0}`;
  }

  public teardownInstrument(instrumentId: string) {
    const active = this.deps.instruments.get(instrumentId);
    if (!active) return;

    const isPooled = active.instrument instanceof PooledInstrument;
    const isModInstrument = active.instrument instanceof ModInstrument;
    const instrumentType = isPooled
      ? 'PooledInstrument'
      : isModInstrument
        ? 'ModInstrument'
        : 'InstrumentV2';
    console.log(
      `[SongBank] Tearing down instrument ${instrumentId}, type: ${instrumentType}`,
    );

    try {
      active.instrument.dispose();
    } catch (error) {
      console.warn('[TrackerSongBank] Failed to dispose instrument', error);
    }

    // Deallocate from pool if this is a pooled instrument
    const pool = this.deps.workletPool();
    if (isPooled && pool) {
      pool.deallocateVoices(instrumentId);
      console.log(`[SongBank] Deallocated ${instrumentId} from WorkletPool`);
    }

    this.deps.instruments.delete(instrumentId);
    this.deps.activeNotes.delete(instrumentId);
    this.deps.voices.removeInstrument(instrumentId);
    this.restoredAssets.delete(instrumentId);
  }
}
