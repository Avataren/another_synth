// src/audio/worklet-pool.ts
/**
 * WorkletPool manages shared AudioWorkletNode instances across multiple instruments.
 *
 * Instead of creating one worklet per instrument (wasteful), the pool allocates
 * voices from shared worklets, maximizing resource utilization.
 *
 * Architecture:
 * - Each worklet has ENGINES_PER_WORKLET engines (typically 2)
 * - Each engine has VOICES_PER_ENGINE voices (typically 8)
 * - Total voices per worklet = ENGINES_PER_WORKLET × VOICES_PER_ENGINE (typically 16)
 *
 * Example allocation for 7 MOD instruments (4 voices each):
 * - Worklet 0: Instruments 01(0-3), 02(4-7), 03(8-11), 04(12-15)
 * - Worklet 1: Instruments 05(0-3), 06(4-7), 07(8-11)
 */

import { createStandardAudioWorklet } from './audio-processor-loader';
import {
  ENGINES_PER_WORKLET,
  TOTAL_VOICES,
  VOICES_PER_ENGINE,
} from './worklet-config';

/**
 * Voice allocation record for an instrument
 */
export interface VoiceAllocation {
  /** The shared worklet node */
  workletNode: AudioWorkletNode;
  /** Index of this worklet in the pool */
  workletIndex: number;
  /** Starting voice index (global within worklet, 0-15) */
  startVoice: number;
  /** Ending voice index (exclusive, 0-16) */
  endVoice: number;
  /** Number of voices allocated */
  voiceCount: number;
  /** Shared memory instance for this worklet */
  memory: WebAssembly.Memory;
}

/**
 * Internal worklet tracking
 */
interface PooledWorklet {
  node: AudioWorkletNode;
  memory: WebAssembly.Memory;
  allocations: Map<string, { startVoice: number; endVoice: number }>; // Track which instruments own which voices
}

export class WorkletPool {
  private worklets: PooledWorklet[] = [];
  private audioContext: AudioContext;
  private destination: AudioNode;
  private allocations: Map<string, VoiceAllocation> = new Map();

  constructor(audioContext: AudioContext, destination: AudioNode) {
    this.audioContext = audioContext;
    this.destination = destination;
  }

  /**
   * Allocate voices for an instrument from the pool.
   * Creates new worklets as needed when existing ones are full.
   *
   * @param instrumentId - Unique identifier for the instrument (e.g., "01", "02")
   * @param voiceCount - Number of voices needed (typically 4 for MOD instruments)
   * @returns Voice allocation record
   */
  async allocateVoices(instrumentId: string, voiceCount: number): Promise<VoiceAllocation> {
    // Check if this instrument already has an allocation (reuse case)
    const existing = this.allocations.get(instrumentId);
    if (existing) {
      console.log(`[WorkletPool] Reusing allocation for ${instrumentId}: voices ${existing.startVoice}-${existing.endVoice - 1}`);
      return existing;
    }

    // Validate voice count
    if (voiceCount < 1 || voiceCount > TOTAL_VOICES) {
      throw new Error(`Invalid voice count: ${voiceCount}. Must be 1-${TOTAL_VOICES}`);
    }

    // Try to find an existing worklet with enough free voices in a single engine slice
    for (let i = 0; i < this.worklets.length; i++) {
      const worklet = this.worklets[i]!;
      const startVoice = this.findContiguousRange(worklet, voiceCount);

      if (startVoice !== null) {
        const endVoice = startVoice + voiceCount;

        worklet.allocations.set(instrumentId, { startVoice, endVoice });

        const allocation: VoiceAllocation = {
          workletNode: worklet.node,
          workletIndex: i,
          startVoice,
          endVoice,
          voiceCount,
          memory: worklet.memory,
        };

        this.allocations.set(instrumentId, allocation);

        const remaining = TOTAL_VOICES - this.getAllocatedVoiceCount(worklet);
        console.log(
          `[WorkletPool] Allocated ${voiceCount} voices for ${instrumentId} on worklet ${i}: voices ${startVoice}-${endVoice - 1} (${remaining} free remaining)`
        );

        return allocation;
      }
    }

    // No worklet has enough space - create a new one
    console.log(`[WorkletPool] Creating new worklet ${this.worklets.length} for ${instrumentId}`);
    const newWorklet = await this.createWorklet();

    const startVoice = 0;
    const endVoice = voiceCount;

    newWorklet.allocations.set(instrumentId, { startVoice, endVoice });

    const allocation: VoiceAllocation = {
      workletNode: newWorklet.node,
      workletIndex: this.worklets.length - 1,
      startVoice,
      endVoice,
      voiceCount,
      memory: newWorklet.memory,
    };

    this.allocations.set(instrumentId, allocation);

    console.log(
      `[WorkletPool] Allocated ${voiceCount} voices for ${instrumentId} on new worklet ${allocation.workletIndex}: voices ${startVoice}-${endVoice - 1}`
    );

    return allocation;
  }

  /**
   * Release voices allocated to an instrument.
   * Note: This doesn't physically free the voices in the worklet (WASM continues running),
   * but allows the pool to reuse them for new instruments.
   *
   * @param instrumentId - Instrument to deallocate
   */
  deallocateVoices(instrumentId: string): void {
    const allocation = this.allocations.get(instrumentId);
    if (!allocation) {
      console.warn(`[WorkletPool] Cannot deallocate ${instrumentId}: no allocation found`);
      return;
    }

    const worklet = this.worklets[allocation.workletIndex];
    if (!worklet) {
      console.warn(`[WorkletPool] Cannot deallocate ${instrumentId}: worklet ${allocation.workletIndex} not found`);
      this.allocations.delete(instrumentId);
      return;
    }

    // Remove from worklet's allocation tracking
    worklet.allocations.delete(instrumentId);

    // If this was the last allocation in the worklet, we could potentially recycle it
    // For now, we keep worklets alive to avoid recreation overhead
    // Future optimization: destroy worklets that have been empty for a while

    this.allocations.delete(instrumentId);

    console.log(
      `[WorkletPool] Deallocated ${allocation.voiceCount} voices for ${instrumentId} from worklet ${allocation.workletIndex}`
    );
  }

  /**
   * Get the current allocation for an instrument (if any)
   */
  getAllocation(instrumentId: string): VoiceAllocation | undefined {
    return this.allocations.get(instrumentId);
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    workletCount: number;
    totalVoices: number;
    allocatedVoices: number;
    freeVoices: number;
    allocations: Array<{ instrumentId: string; workletIndex: number; voices: string }>;
  } {
    const totalVoices = this.worklets.length * TOTAL_VOICES;
    let allocatedVoices = 0;

    const allocations: Array<{ instrumentId: string; workletIndex: number; voices: string }> = [];

    for (const [instrumentId, alloc] of this.allocations.entries()) {
      allocatedVoices += alloc.voiceCount;
      allocations.push({
        instrumentId,
        workletIndex: alloc.workletIndex,
        voices: `${alloc.startVoice}-${alloc.endVoice - 1}`,
      });
    }

    return {
      workletCount: this.worklets.length,
      totalVoices,
      allocatedVoices,
      freeVoices: totalVoices - allocatedVoices,
      allocations,
    };
  }

  /**
   * Dispose of all worklets and clear allocations
   */
  dispose(): void {
    console.log(`[WorkletPool] Disposing pool with ${this.worklets.length} worklets`);

    for (const worklet of this.worklets) {
      try {
        worklet.node.disconnect();
      } catch (e) {
        console.warn('[WorkletPool] Error disconnecting worklet:', e);
      }
    }

    this.worklets = [];
    this.allocations.clear();
  }

  /**
   * Create a new worklet and add it to the pool
   */
  private async createWorklet(): Promise<PooledWorklet> {
    // Create shared memory for this worklet
    const memory = new WebAssembly.Memory({
      initial: 256,
      maximum: 1024,
      shared: true,
    });

    // Create worklet node
    const node = await createStandardAudioWorklet(this.audioContext);

    // Connect to destination
    node.connect(this.destination);

    const pooledWorklet: PooledWorklet = {
      node,
      memory,
      allocations: new Map(),
    };

    this.worklets.push(pooledWorklet);

    return pooledWorklet;
  }

  /**
   * Reset all allocations without destroying worklets.
   * Useful when loading a new song - keeps worklets alive for reuse.
   */
  resetAllocations(): void {
    console.log(`[WorkletPool] Resetting allocations (keeping ${this.worklets.length} worklets alive)`);

    // Clear allocation tracking but keep worklets
    for (const worklet of this.worklets) {
      worklet.allocations.clear();
    }

    this.allocations.clear();
  }

  /**
   * Compact the pool by destroying empty worklets.
   * Call this after deallocating many instruments to free resources.
   */
  compact(): void {
    const before = this.worklets.length;
    let destroyed = 0;

    // Keep only worklets that have active allocations
    this.worklets = this.worklets.filter((worklet, index) => {
      if (worklet.allocations.size === 0) {
        console.log(`[WorkletPool] Destroying empty worklet ${index}`);
        try {
          worklet.node.disconnect();
        } catch (e) {
          console.warn('[WorkletPool] Error disconnecting worklet:', e);
        }
        destroyed++;
        return false;
      }
      return true;
    });

    if (destroyed > 0) {
      console.log(`[WorkletPool] Compacted pool: ${before} → ${this.worklets.length} worklets (freed ${destroyed})`);

      // Update worklet indices in allocations
      this.reallocateIndices();
    }
  }

  /**
   * Update allocation indices after compaction
   */
  private reallocateIndices(): void {
    for (const [instrumentId, allocation] of this.allocations.entries()) {
      const newIndex = this.worklets.findIndex(w => w.node === allocation.workletNode);
      if (newIndex !== -1 && newIndex !== allocation.workletIndex) {
        allocation.workletIndex = newIndex;
        console.log(`[WorkletPool] Updated ${instrumentId} worklet index: ${allocation.workletIndex} → ${newIndex}`);
      }
    }
  }
  /**
   * Find a contiguous free voice range within a single engine.
   * Ensures no allocation crosses an engine boundary.
   */
  private findContiguousRange(
    worklet: PooledWorklet,
    voiceCount: number,
  ): number | null {
    for (let engineIndex = 0; engineIndex < ENGINES_PER_WORKLET; engineIndex++) {
      const engineStart = engineIndex * VOICES_PER_ENGINE;
      const engineEnd = engineStart + VOICES_PER_ENGINE;

      // Collect occupied ranges within this engine slice
      const occupied: Array<{ start: number; end: number }> = [];
      for (const range of worklet.allocations.values()) {
        const start = Math.max(range.startVoice, engineStart);
        const end = Math.min(range.endVoice, engineEnd);
        if (start < end) {
          occupied.push({ start, end });
        }
      }

      occupied.sort((a, b) => a.start - b.start);

      let cursor = engineStart;
      for (const range of occupied) {
        if (voiceCount <= range.start - cursor) {
          return cursor;
        }
        cursor = Math.max(cursor, range.end);
      }

      if (engineEnd - cursor >= voiceCount) {
        return cursor;
      }
    }

    return null;
  }

  private getAllocatedVoiceCount(worklet: PooledWorklet): number {
    let total = 0;
    for (const range of worklet.allocations.values()) {
      total += range.endVoice - range.startVoice;
    }
    return total;
  }
}
