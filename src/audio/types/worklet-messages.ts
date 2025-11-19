// src/audio/types/worklet-messages.ts
/**
 * Typed message protocol for communication between main thread and audio worklet.
 *
 * This file defines:
 * - All message types that can be sent to/from the worklet
 * - Request/Response patterns for mutations
 * - Type-safe message builders
 * - Runtime validation utilities
 */

import type {
  EnvelopeConfig,
  FilterState,
  LfoState,
  OscillatorState,
  SamplerState,
  ConvolverState,
  DelayState,
  ChorusState,
  ReverbState,
  NodeConnectionUpdate,
  SynthLayout,
} from './synth-layout';
import type { Patch } from './preset-types';

// ============================================================================
// Base Message Types
// ============================================================================

/** Base interface for all messages with unique IDs for request/response matching */
export interface BaseMessage {
  type: string;
  messageId?: string; // Optional ID for request/response correlation
}

/** Response wrapper for async operations */
export interface OperationResponse extends BaseMessage {
  type: 'operationResponse';
  messageId: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

// ============================================================================
// Initialization Messages (Main → Worklet)
// ============================================================================

export interface WasmBinaryMessage extends BaseMessage {
  type: 'wasm-binary';
  wasmBinary: ArrayBuffer;
}

export interface InitializeMessage extends BaseMessage {
  type: 'initialize';
  sampleRate: number;
  numVoices: number;
}

// ============================================================================
// Patch & Layout Messages (Bidirectional)
// ============================================================================

export interface LoadPatchMessage extends BaseMessage {
  type: 'loadPatch';
  patchJson: string;
}

export interface SynthLayoutMessage extends BaseMessage {
  type: 'synthLayout';
  layout: SynthLayout;
}

export interface StateUpdatedMessage extends BaseMessage {
  type: 'stateUpdated';
  state: SynthLayout;
}

// ============================================================================
// Node State Update Messages (Main → Worklet)
// ============================================================================

export interface UpdateOscillatorMessage extends BaseMessage {
  type: 'updateOscillator';
  oscillatorId: string;
  state: OscillatorState;
}

export interface UpdateWavetableOscillatorMessage extends BaseMessage {
  type: 'updateWavetableOscillator';
  oscillatorId: string;
  state: OscillatorState;
}

export interface UpdateEnvelopeMessage extends BaseMessage {
  type: 'updateEnvelope';
  envelopeId: string;
  state: EnvelopeConfig;
}

export interface UpdateFilterMessage extends BaseMessage {
  type: 'updateFilter';
  filterId: string;
  state: FilterState;
}

export interface UpdateLfoMessage extends BaseMessage {
  type: 'updateLfo';
  lfoId: string;
  state: LfoState;
}

export interface UpdateSamplerMessage extends BaseMessage {
  type: 'updateSampler';
  samplerId: string;
  state: Partial<SamplerState>;
}

export interface UpdateConvolverMessage extends BaseMessage {
  type: 'updateConvolver';
  convolverId: string;
  state: ConvolverState;
}

export interface UpdateDelayMessage extends BaseMessage {
  type: 'updateDelay';
  delayId: string;
  state: DelayState;
}

export interface UpdateChorusMessage extends BaseMessage {
  type: 'updateChorus';
  chorusId: string;
  state: ChorusState;
}

export interface UpdateReverbMessage extends BaseMessage {
  type: 'updateReverb';
  reverbId: string;
  state: ReverbState;
}

// ============================================================================
// Connection Messages (Main → Worklet)
// ============================================================================

export interface UpdateConnectionMessage extends BaseMessage {
  type: 'updateConnection';
  connection: NodeConnectionUpdate;
}

export interface GetConnectionsMessage extends BaseMessage {
  type: 'getConnections';
}

export interface ConnectionsResponseMessage extends BaseMessage {
  type: 'connectionsResponse';
  messageId: string;
  connections: NodeConnectionUpdate[];
}

// ============================================================================
// Node Creation/Deletion Messages (Main → Worklet)
// ============================================================================

export interface CreateNodeMessage extends BaseMessage {
  type: 'createNode';
  nodeType: string;
  nodeId?: string;
}

export interface DeleteNodeMessage extends BaseMessage {
  type: 'deleteNode';
  nodeId: string;
}

export interface NodeCreatedMessage extends BaseMessage {
  type: 'nodeCreated';
  messageId: string;
  nodeId: string;
  nodeType: string;
}

// ============================================================================
// Audio Asset Messages (Main → Worklet)
// ============================================================================

export interface UploadSampleMessage extends BaseMessage {
  type: 'uploadSample';
  samplerId: string;
  audioBuffer: Float32Array;
  sampleRate: number;
  channels: number;
  fileName?: string;
}

export interface UploadImpulseResponseMessage extends BaseMessage {
  type: 'uploadImpulseResponse';
  convolverId: string;
  audioBuffer: Float32Array;
  sampleRate: number;
  channels: number;
  fileName?: string;
}

export interface UploadWavetableMessage extends BaseMessage {
  type: 'uploadWavetable';
  oscillatorId: string;
  wavetable: Float32Array;
  wavetableName?: string;
}

// ============================================================================
// Performance Messages (Main → Worklet)
// ============================================================================

export interface NoteOnMessage extends BaseMessage {
  type: 'noteOn';
  noteNumber: number;
  velocity: number;
}

export interface NoteOffMessage extends BaseMessage {
  type: 'noteOff';
  noteNumber: number;
}

export interface SetMacroMessage extends BaseMessage {
  type: 'setMacro';
  macroIndex: number;
  value: number;
}

// ============================================================================
// Status Messages (Worklet → Main)
// ============================================================================

export interface ReadyMessage extends BaseMessage {
  type: 'ready';
}

export interface ErrorMessage extends BaseMessage {
  type: 'error';
  error: string;
  context?: string;
}

export interface PerformanceStatsMessage extends BaseMessage {
  type: 'performanceStats';
  cpuLoad: number;
  voiceCount: number;
}

// ============================================================================
// Union Type of All Messages
// ============================================================================

export type WorkletMessage =
  // Initialization
  | WasmBinaryMessage
  | InitializeMessage
  | ReadyMessage
  // Patch & Layout
  | LoadPatchMessage
  | SynthLayoutMessage
  | StateUpdatedMessage
  // Node Updates
  | UpdateOscillatorMessage
  | UpdateWavetableOscillatorMessage
  | UpdateEnvelopeMessage
  | UpdateFilterMessage
  | UpdateLfoMessage
  | UpdateSamplerMessage
  | UpdateConvolverMessage
  | UpdateDelayMessage
  | UpdateChorusMessage
  | UpdateReverbMessage
  // Connections
  | UpdateConnectionMessage
  | GetConnectionsMessage
  | ConnectionsResponseMessage
  // Node Creation/Deletion
  | CreateNodeMessage
  | DeleteNodeMessage
  | NodeCreatedMessage
  // Audio Assets
  | UploadSampleMessage
  | UploadImpulseResponseMessage
  | UploadWavetableMessage
  // Performance
  | NoteOnMessage
  | NoteOffMessage
  | SetMacroMessage
  // Status
  | ErrorMessage
  | PerformanceStatsMessage
  | OperationResponse;

// ============================================================================
// Message Builders (Type-safe construction)
// ============================================================================

export class WorkletMessageBuilder {
  private static generateMessageId(): string {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  static loadPatch(patchJson: string, withResponse = true): LoadPatchMessage {
    return {
      type: 'loadPatch',
      patchJson,
      ...(withResponse && { messageId: this.generateMessageId() }),
    };
  }

  static updateEnvelope(envelopeId: string, state: EnvelopeConfig, withResponse = true): UpdateEnvelopeMessage {
    return {
      type: 'updateEnvelope',
      envelopeId,
      state,
      ...(withResponse && { messageId: this.generateMessageId() }),
    };
  }

  static updateConnection(connection: NodeConnectionUpdate, withResponse = true): UpdateConnectionMessage {
    return {
      type: 'updateConnection',
      connection,
      ...(withResponse && { messageId: this.generateMessageId() }),
    };
  }

  static deleteNode(nodeId: string, withResponse = true): DeleteNodeMessage {
    return {
      type: 'deleteNode',
      nodeId,
      ...(withResponse && { messageId: this.generateMessageId() }),
    };
  }

  static createNode(nodeType: string, nodeId?: string, withResponse = true): CreateNodeMessage {
    return {
      type: 'createNode',
      nodeType,
      nodeId,
      ...(withResponse && { messageId: this.generateMessageId() }),
    };
  }

  static noteOn(noteNumber: number, velocity: number): NoteOnMessage {
    return {
      type: 'noteOn',
      noteNumber,
      velocity,
    };
  }

  static noteOff(noteNumber: number): NoteOffMessage {
    return {
      type: 'noteOff',
      noteNumber,
    };
  }

  static operationResponse(
    messageId: string,
    success: boolean,
    data?: unknown,
    error?: string
  ): OperationResponse {
    return {
      type: 'operationResponse',
      messageId,
      success,
      data,
      error,
    };
  }
}

// ============================================================================
// Message Validation
// ============================================================================

export class WorkletMessageValidator {
  /**
   * Validates that a message has all required fields for its type.
   * Returns an error message if invalid, null if valid.
   */
  static validate(message: WorkletMessage): string | null {
    if (!message.type) {
      return 'Message missing required "type" field';
    }

    switch (message.type) {
      case 'loadPatch':
        if (!(message as LoadPatchMessage).patchJson) {
          return 'loadPatch message missing patchJson';
        }
        break;

      case 'updateEnvelope':
        const envMsg = message as UpdateEnvelopeMessage;
        if (!envMsg.envelopeId || !envMsg.state) {
          return 'updateEnvelope missing envelopeId or state';
        }
        break;

      case 'updateConnection':
        const connMsg = message as UpdateConnectionMessage;
        if (!connMsg.connection) {
          return 'updateConnection missing connection';
        }
        break;

      case 'noteOn':
        const noteOnMsg = message as NoteOnMessage;
        if (typeof noteOnMsg.noteNumber !== 'number' || typeof noteOnMsg.velocity !== 'number') {
          return 'noteOn missing noteNumber or velocity';
        }
        break;

      case 'noteOff':
        const noteOffMsg = message as NoteOffMessage;
        if (typeof noteOffMsg.noteNumber !== 'number') {
          return 'noteOff missing noteNumber';
        }
        break;

      // Add more validation as needed
    }

    return null; // Valid
  }

  /**
   * Type guard to check if a message is a specific type
   */
  static isMessageType<T extends WorkletMessage>(
    message: WorkletMessage,
    type: string
  ): message is T {
    return message.type === type;
  }
}
