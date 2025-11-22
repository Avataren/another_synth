import AudioSystem from 'src/audio/AudioSystem';
import InstrumentV2 from 'src/audio/instrument-v2';
import type { AudioAsset, Patch } from 'src/audio/types/preset-types';
import { parseAudioAssetId } from 'src/audio/serialization/patch-serializer';

export interface SongBankSlot {
  instrumentId: string;
  patch: Patch;
}

interface ActiveInstrument {
  instrument: InstrumentV2;
  patchId: string;
}

export class TrackerSongBank {
  private readonly audioSystem: AudioSystem;
  private readonly masterGain: GainNode;
  private readonly desired: Map<string, Patch> = new Map();
  private readonly instruments: Map<string, ActiveInstrument> = new Map();
  private readonly activeNotes: Map<string, Set<number>> = new Map();

  constructor() {
    this.audioSystem = new AudioSystem();
    this.masterGain = this.audioSystem.audioContext.createGain();
    this.masterGain.gain.value = 1.0;
    this.masterGain.connect(this.audioSystem.destinationNode);
  }

  get output(): AudioNode {
    return this.masterGain;
  }

  async syncSlots(slots: SongBankSlot[]): Promise<void> {
    const nextDesired = new Map<string, Patch>();
    for (const slot of slots) {
      if (!slot.instrumentId) continue;
      nextDesired.set(slot.instrumentId, slot.patch);
    }
    this.desired.clear();
    for (const [id, patch] of nextDesired.entries()) {
      this.desired.set(id, patch);
    }

    const wantedIds = new Set(nextDesired.keys());
    for (const [id, active] of this.instruments.entries()) {
      if (!wantedIds.has(id)) {
        active.instrument.outputNode.disconnect();
        this.instruments.delete(id);
        this.activeNotes.delete(id);
      }
    }

    for (const [instrumentId, patch] of nextDesired.entries()) {
      await this.ensureInstrument(instrumentId, patch);
    }
  }

  async prepareInstrument(instrumentId?: string): Promise<void> {
    if (!instrumentId) return;
    const patch = this.desired.get(instrumentId);
    if (!patch) return;
    await this.ensureInstrument(instrumentId, patch);
  }

  dispose() {
    for (const active of this.instruments.values()) {
      active.instrument.outputNode.disconnect();
    }
    this.instruments.clear();
    this.activeNotes.clear();
    this.masterGain.disconnect();
  }

  allNotesOff() {
    for (const [instrumentId, active] of this.instruments.entries()) {
      const notes = this.activeNotes.get(instrumentId);
      if (notes) {
        for (const note of notes) {
          active.instrument.noteOff(note);
        }
        notes.clear();
      }
      // Also send a gate-low in case the set was empty but a gate is stuck
      active.instrument.allNotesOff();
    }
  }

  noteOn(instrumentId: string | undefined, midi: number, velocity = 100) {
    if (instrumentId === undefined) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    active.instrument.noteOn(midi, velocity);

    const notes = this.activeNotes.get(instrumentId) ?? new Set<number>();
    notes.add(midi);
    this.activeNotes.set(instrumentId, notes);
  }

  noteOff(instrumentId: string | undefined, midi?: number) {
    if (instrumentId === undefined) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;

    const notes = this.activeNotes.get(instrumentId);
    if (!notes || notes.size === 0) {
      if (midi !== undefined) {
        active.instrument.noteOff(midi);
      }
      return;
    }

    if (midi === undefined) {
      for (const note of notes) {
        active.instrument.noteOff(note);
      }
      notes.clear();
      return;
    }

    if (notes.has(midi)) {
      active.instrument.noteOff(midi);
      notes.delete(midi);
    } else {
      active.instrument.noteOff(midi);
    }
  }

  private async ensureInstrument(instrumentId: string, patch: Patch): Promise<void> {
    const patchId = patch?.metadata?.id;
    if (!patchId) return;

    const existing = this.instruments.get(instrumentId);
    if (existing?.patchId === patchId) return;

    if (existing) {
      existing.instrument.outputNode.disconnect();
      this.instruments.delete(instrumentId);
    }

    const memory = new WebAssembly.Memory({
      initial: 256,
      maximum: 1024,
      shared: true,
    });
    const instrument = new InstrumentV2(
      this.masterGain,
      this.audioSystem.audioContext,
      memory,
    );

    const ready = await this.waitForInstrumentReady(instrument);
    if (!ready) {
      instrument.outputNode.disconnect();
      return;
    }

    await instrument.loadPatch(patch);
    await this.restoreAudioAssets(instrument, patch);
    this.instruments.set(instrumentId, { instrument, patchId });
  }

  private async restoreAudioAssets(instrument: InstrumentV2, patch: Patch): Promise<void> {
    const assets = patch.audioAssets;
    if (!assets || Object.keys(assets).length === 0) {
      return;
    }

    for (const [assetId, asset] of Object.entries(assets) as [string, AudioAsset][]) {
      try {
        const parsed = parseAudioAssetId(assetId);
        if (!parsed) continue;
        const { nodeType, nodeId } = parsed;

        const binaryData = atob(asset.base64Data);
        const bytes = new Uint8Array(binaryData.length);
        for (let i = 0; i < binaryData.length; i++) {
          bytes[i] = binaryData.charCodeAt(i);
        }

        if (nodeType === 'sample') {
          await instrument.importSampleData(nodeId, bytes);
        } else if (nodeType === 'impulse_response') {
          await instrument.importImpulseWaveformData(nodeId, bytes);
        } else if (nodeType === 'wavetable') {
          await instrument.importWavetableData(nodeId, bytes);
        }
      } catch (error) {
        console.error(`[TrackerSongBank] Failed to restore audio asset ${assetId}:`, error);
      }
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
        console.warn('[TrackerSongBank] Timed out waiting for instrument readiness');
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return true;
  }
}
