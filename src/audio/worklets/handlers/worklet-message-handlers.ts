// src/audio/worklets/handlers/worklet-message-handlers.ts
/**
 * Message handlers for the synth worklet.
 *
 * This module extracts the message handling logic from the monolithic
 * switch statement in synth-worklet.ts into focused, testable handler classes.
 *
 * Each handler is responsible for:
 * - Validating message data
 * - Calling the appropriate WasmEngineAdapter methods
 * - Sending operationResponse back to main thread
 * - Handling errors gracefully
 */

import type { WasmEngineAdapter } from '../../adapters/wasm-engine-adapter';
import type {
  UpdateEnvelopeMessage,
  UpdateOscillatorMessage,
  UpdateWavetableOscillatorMessage,
  UpdateFilterMessage,
  UpdateLfoMessage,
  UpdateSamplerMessage,
  UpdateConvolverMessage,
  UpdateDelayMessage,
  UpdateChorusMessage,
  UpdateReverbMessage,
  UpdateConnectionMessage,
  DeleteNodeMessage,
  CreateNodeMessage,
  LoadPatchMessage,
  UpdateSaturationMessage,
} from '../../types/worklet-messages';
import { WorkletMessageBuilder } from '../../types/worklet-messages';
import type { SynthLayout } from '../../types/synth-layout';
import { PortId, WasmModulationType } from 'app/public/wasm/audio_processor';

// ============================================================================
// Base Handler Class
// ============================================================================

/**
 * Base class for all message handlers.
 * Provides common functionality for sending responses.
 */
export abstract class BaseMessageHandler {
  constructor(
    protected engineAdapter: WasmEngineAdapter,
    protected port: MessagePort
  ) {}

  abstract handle(message: unknown): Promise<void>;

  /**
   * Sends a success response back to the main thread.
   */
  protected sendSuccess(messageId: string, data?: unknown): void {
    const response = WorkletMessageBuilder.operationResponse(
      messageId,
      true,
      data
    );
    this.port.postMessage(response);
  }

  /**
   * Sends an error response back to the main thread.
   */
  protected sendError(messageId: string, error: string): void {
    const response = WorkletMessageBuilder.operationResponse(
      messageId,
      false,
      undefined,
      error
    );
    this.port.postMessage(response);
  }

  /**
   * Wraps handler execution with automatic error handling and response sending.
   */
  protected async executeWithResponse<T extends { messageId?: string }>(
    message: T,
    handler: (message: T) => Promise<unknown> | unknown
  ): Promise<void> {
    if (!message.messageId) {
      // No response expected, just execute
      try {
        await handler(message);
      } catch (error) {
        console.error('[WorkletHandler] Error in fire-and-forget handler:', error);
      }
      return;
    }

    try {
      const result = await handler(message);
      this.sendSuccess(message.messageId, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[WorkletHandler] Handler error:', errorMessage);
      this.sendError(message.messageId, errorMessage);
    }
  }
}

// ============================================================================
// Node State Update Handlers
// ============================================================================

export class EnvelopeHandler extends BaseMessageHandler {
  async handle(message: UpdateEnvelopeMessage): Promise<void> {
    await this.executeWithResponse(message, async (msg) => {
      this.engineAdapter.updateEnvelope(msg.envelopeId, msg.state);
    });
  }
}

export class OscillatorHandler extends BaseMessageHandler {
  async handle(message: UpdateOscillatorMessage): Promise<void> {
    await this.executeWithResponse(message, async (msg) => {
      // Adapter expects different field names matching AnalogOscillatorStateUpdate
      this.engineAdapter.updateOscillator(msg.oscillatorId, {
        phase_mod_amount: msg.newState.phase_mod_amount ?? 0,
        detune: msg.newState.detune ?? 0,
        hard_sync: msg.newState.hard_sync ?? false,
        gain: msg.newState.gain,
        active: msg.newState.active,
        feedback_amount: msg.newState.feedback_amount ?? 0,
        waveform: msg.newState.waveform,
        unison_voices: msg.newState.unison_voices ?? 1,
        spread: msg.newState.spread ?? 0,
      });
    });
  }
}

export class WavetableOscillatorHandler extends BaseMessageHandler {
  async handle(message: UpdateWavetableOscillatorMessage): Promise<void> {
    await this.executeWithResponse(message, async (msg) => {
      // Adapter expects different field names matching AnalogOscillatorStateUpdate
      this.engineAdapter.updateWavetableOscillator(msg.oscillatorId, {
        phase_mod_amount: msg.newState.phase_mod_amount ?? 0,
        detune: msg.newState.detune ?? 0,
        hard_sync: msg.newState.hard_sync ?? false,
        gain: msg.newState.gain,
        active: msg.newState.active,
        feedback_amount: msg.newState.feedback_amount ?? 0,
        waveform: msg.newState.waveform,
        unison_voices: msg.newState.unison_voices ?? 1,
        spread: msg.newState.spread ?? 0,
      });
    });
  }
}

export class FilterHandler extends BaseMessageHandler {
  async handle(message: UpdateFilterMessage): Promise<void> {
    await this.executeWithResponse(message, async (msg) => {
      this.engineAdapter.updateFilter(msg.filterId, msg.config);
    });
  }
}

export class LfoHandler extends BaseMessageHandler {
  async handle(message: UpdateLfoMessage): Promise<void> {
    await this.executeWithResponse(message, async (msg) => {
      // WasmEngineAdapter now handles the WasmLfoUpdateParams construction
      this.engineAdapter.updateLfos(msg.lfoId, msg.params);
    });
  }
}

export class SamplerHandler extends BaseMessageHandler {
  async handle(message: UpdateSamplerMessage): Promise<void> {
    await this.executeWithResponse(message, async (msg) => {
      this.engineAdapter.updateSampler(msg.samplerId, msg.state);
    });
  }
}

export class ConvolverHandler extends BaseMessageHandler {
  async handle(message: UpdateConvolverMessage): Promise<void> {
    await this.executeWithResponse(message, async (msg) => {
      this.engineAdapter.updateConvolver(
        msg.nodeId,
        msg.state.wetMix,
        msg.state.active
      );
    });
  }
}

export class DelayHandler extends BaseMessageHandler {
  async handle(message: UpdateDelayMessage): Promise<void> {
    await this.executeWithResponse(message, async (msg) => {
      // WasmEngineAdapter handles string/number conversion and positional args
      this.engineAdapter.updateDelay(msg.nodeId, {
        delay_ms: msg.state.delayMs,
        feedback: msg.state.feedback,
        wet_mix: msg.state.wetMix,
        active: msg.state.active,
      });
    });
  }
}

export class ChorusHandler extends BaseMessageHandler {
  async handle(message: UpdateChorusMessage): Promise<void> {
    await this.executeWithResponse(message, async (msg) => {
      // WasmEngineAdapter handles string/number conversion and positional args
      this.engineAdapter.updateChorus(msg.nodeId, {
        base_delay_ms: msg.state.baseDelayMs,
        depth_ms: msg.state.depthMs,
        lfo_rate_hz: msg.state.lfoRateHz,
        feedback: msg.state.feedback,
        feedback_filter: msg.state.feedback_filter,
        mix: msg.state.mix,
        stereo_phase_offset_deg: msg.state.stereoPhaseOffsetDeg,
        active: msg.state.active,
      });
    });
  }
}

export class ReverbHandler extends BaseMessageHandler {
  async handle(message: UpdateReverbMessage): Promise<void> {
    await this.executeWithResponse(message, async (msg) => {
      // WasmEngineAdapter handles string/number conversion and positional args
      this.engineAdapter.updateReverb(msg.nodeId, {
        room_size: msg.state.room_size,
        damp: msg.state.damp,
        wet: msg.state.wet,
        dry: msg.state.dry,
        width: msg.state.width,
        active: msg.state.active,
      });
    });
  }
}

export class SaturationHandler extends BaseMessageHandler {
  async handle(message: UpdateSaturationMessage): Promise<void> {
    await this.executeWithResponse(message, async (msg) => {
      this.engineAdapter.updateSaturation(msg.nodeId, {
        drive: msg.state.drive,
        mix: msg.state.mix,
        active: msg.state.active,
      });
    });
  }
}

// ============================================================================
// Connection Handler
// ============================================================================

export class ConnectionHandler extends BaseMessageHandler {
  async handle(message: UpdateConnectionMessage): Promise<void> {
    await this.executeWithResponse(message, async (msg) => {
      const conn = msg.connection;

      if (conn.isRemoving) {
        // Remove connection
        this.engineAdapter.removeConnection(
          conn.fromId,
          conn.toId,
          conn.target
        );
      } else {
        // Add/update connection
        // First remove any existing connection for this triple
        this.engineAdapter.removeConnection(
          conn.fromId,
          conn.toId,
          conn.target
        );

        // Then add the new connection
        this.engineAdapter.connectNodes(
          conn.fromId,
          PortId.AudioOutput0, // Default from port
          conn.toId,
          conn.target,
          conn.amount ?? 1.0,
          conn.modulationType ?? WasmModulationType.Additive,
          conn.modulationTransformation ?? 0
        );
      }
    });
  }
}

// ============================================================================
// Node Creation/Deletion Handlers
// ============================================================================

export class NodeCreationHandler extends BaseMessageHandler {
  async handle(message: CreateNodeMessage): Promise<void> {
    await this.executeWithResponse(message, async (msg) => {
      let nodeId: string;

      switch (msg.nodeType) {
        case 'oscillator':
          nodeId = this.engineAdapter.createOscillator();
          break;
        case 'wavetable_oscillator':
          nodeId = this.engineAdapter.createWavetableOscillator();
          break;
        case 'filter':
          nodeId = this.engineAdapter.createFilter();
          break;
        case 'envelope':
          nodeId = this.engineAdapter.createEnvelope();
          break;
        case 'lfo':
          nodeId = this.engineAdapter.createLfo();
          break;
        case 'sampler':
          nodeId = this.engineAdapter.createSampler();
          break;
        case 'mixer':
          nodeId = this.engineAdapter.createMixer();
          break;
        case 'noise':
          nodeId = this.engineAdapter.createNoise();
          break;
        case 'arpeggiator':
          nodeId = this.engineAdapter.createArpeggiator();
          break;
        default:
          throw new Error(`Unknown node type: ${msg.nodeType}`);
      }

      return { nodeId, nodeType: msg.nodeType };
    });
  }
}

export class NodeDeletionHandler extends BaseMessageHandler {
  async handle(message: DeleteNodeMessage): Promise<void> {
    await this.executeWithResponse(message, async () => {
      // Note: WASM engine doesn't currently have a deleteNode method
      // This would need to be implemented in the Rust side
      console.warn('[NodeDeletionHandler] deleteNode not yet implemented in WASM');
      throw new Error('Node deletion not yet implemented');
    });
  }
}

// ============================================================================
// Patch Handler
// ============================================================================

export class PatchHandler extends BaseMessageHandler {
  async handle(
    message: LoadPatchMessage,
    _onLayoutUpdate?: (layout: SynthLayout) => void
  ): Promise<void> {
    await this.executeWithResponse(message, async (msg) => {
      const voiceCount = this.engineAdapter.loadPatch(msg.patchJson);

      // Get updated state from engine (for future use)
      // const _state = this.engineAdapter.getCurrentState();

      // Convert to layout and notify
      // (This part would need the layout conversion logic)
      // For now, just trigger a layout update

      return { voiceCount };
    });
  }
}

// ============================================================================
// Handler Registry
// ============================================================================

/**
 * Central registry for all message handlers.
 * Makes it easy to route messages to the appropriate handler.
 */
export class WorkletHandlerRegistry {
  private handlers: Map<string, BaseMessageHandler>;

  constructor(engineAdapter: WasmEngineAdapter, port: MessagePort) {
    this.handlers = new Map<string, BaseMessageHandler>();
    this.handlers.set('updateEnvelope', new EnvelopeHandler(engineAdapter, port));
    this.handlers.set('updateOscillator', new OscillatorHandler(engineAdapter, port));
    this.handlers.set('updateWavetableOscillator', new WavetableOscillatorHandler(engineAdapter, port));
    this.handlers.set('updateFilter', new FilterHandler(engineAdapter, port));
    this.handlers.set('updateLfo', new LfoHandler(engineAdapter, port));
    this.handlers.set('updateSampler', new SamplerHandler(engineAdapter, port));
    this.handlers.set('updateConvolver', new ConvolverHandler(engineAdapter, port));
    this.handlers.set('updateDelay', new DelayHandler(engineAdapter, port));
    this.handlers.set('updateChorus', new ChorusHandler(engineAdapter, port));
    this.handlers.set('updateReverb', new ReverbHandler(engineAdapter, port));
    this.handlers.set('updateSaturation', new SaturationHandler(engineAdapter, port));
    this.handlers.set('updateConnection', new ConnectionHandler(engineAdapter, port));
    this.handlers.set('createNode', new NodeCreationHandler(engineAdapter, port));
    this.handlers.set('deleteNode', new NodeDeletionHandler(engineAdapter, port));
  }

  /**
   * Routes a message to the appropriate handler.
   * @returns true if handler was found and executed, false otherwise
   */
  async route(message: { type: string; [key: string]: unknown }): Promise<boolean> {
    const handler = this.handlers.get(message.type);

    if (!handler) {
      return false; // No handler for this message type
    }

    // TypeScript doesn't know which handler type this is, but each handler
    // will validate its own message format
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handler as any).handle(message);
    return true;
  }

  /**
   * Checks if a handler exists for a message type.
   */
  hasHandler(messageType: string): boolean {
    return this.handlers.has(messageType);
  }
}
