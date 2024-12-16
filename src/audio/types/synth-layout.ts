// src/audio/types/synth-layout.ts

// Define the types of nodes we can have in a voice
export enum VoiceNodeType {
    Oscillator = 'oscillator',
    Envelope = 'envelope',
    LFO = 'lfo',
    Filter = 'filter'
}

// Define the possible modulation targets
export enum ModulationTarget {
    Frequency = 'frequency',
    Gain = 'gain',
    FilterCutoff = 'cutoff',
    FilterResonance = 'resonance',
    PhaseMod = 'phase_mod',
    ModIndex = 'mod_index',
    PWM = 'pwm',
    Pan = 'pan',
}

export interface LfoState {
    id?: number;
    frequency: number;
    waveform: number;
    useAbsolute: boolean;
    useNormalized: boolean;
    triggerMode: number;
    active: boolean;
}


export interface FilterConfig {
    type: 'lowpass' | 'highpass' | 'bandpass';
}

// Represents a node in the voice with its configuration
export interface VoiceNode {
    id: number;
    type: VoiceNodeType;
    config?: FilterConfig; // Only filters need config for now
}

// Represents the routing between nodes
export interface NodeConnection {
    fromId: number;
    toId: number;
    target: ModulationTarget;
    amount: number;
}

// The complete layout of a voice
export interface VoiceLayout {
    id: number;
    nodes: {
        [VoiceNodeType.Oscillator]: VoiceNode[];
        [VoiceNodeType.Envelope]: VoiceNode[];
        [VoiceNodeType.LFO]: VoiceNode[];
        [VoiceNodeType.Filter]: VoiceNode[];
    };
    connections: NodeConnection[];
}

// Global nodes that are shared across all voices
export interface GlobalNodes {
    masterGain?: number;
    effectsChain?: VoiceNode[];
}

// The complete synth layout
export interface SynthLayout {
    voices: VoiceLayout[];
    globalNodes: GlobalNodes;
    metadata?: {
        maxVoices: number;
        maxOscillators: number;
        maxEnvelopes: number;
        maxLFOs: number;
        maxFilters: number;
    };
}

export type LayoutUpdateMessage = {
    type: 'synthLayout';
    layout: SynthLayout;
};

// Helper functions
export const getNodesOfType = (voice: VoiceLayout, type: VoiceNodeType): VoiceNode[] => {
    return voice.nodes[type] || [];
};

export const findNodeById = (voice: VoiceLayout, id: number): VoiceNode | undefined => {
    return Object.values(voice.nodes)
        .flat()
        .find(node => node.id === id);
};

export const findNodeConnections = (voice: VoiceLayout, nodeId: number): NodeConnection[] => {
    return voice.connections.filter(conn =>
        conn.fromId === nodeId || conn.toId === nodeId
    );
};

export const findModulationTargets = (voice: VoiceLayout, sourceId: number): Array<{
    nodeId: number;
    target: ModulationTarget;
    amount: number;
}> => {
    return voice.connections
        .filter(conn => conn.fromId === sourceId)
        .map(conn => ({
            nodeId: conn.toId,
            target: conn.target,
            amount: conn.amount
        }));
};

// Example of creating a default voice layout
export const createDefaultVoiceLayout = (voiceId: number, startingNodeId: number): VoiceLayout => {
    let currentNodeId = startingNodeId;

    const layout: VoiceLayout = {
        id: voiceId,
        nodes: {
            [VoiceNodeType.Oscillator]: [
                { id: currentNodeId++, type: VoiceNodeType.Oscillator },
                { id: currentNodeId++, type: VoiceNodeType.Oscillator }
            ],
            [VoiceNodeType.Envelope]: [
                { id: currentNodeId++, type: VoiceNodeType.Envelope },
                { id: currentNodeId++, type: VoiceNodeType.Envelope }
            ],
            [VoiceNodeType.LFO]: [
                { id: currentNodeId++, type: VoiceNodeType.LFO },
                { id: currentNodeId++, type: VoiceNodeType.LFO }
            ],
            [VoiceNodeType.Filter]: [
                {
                    id: currentNodeId++,
                    type: VoiceNodeType.Filter,
                    config: {
                        type: 'lowpass',
                    }
                }
            ]
        },
        connections: []
    };

    // Add default connections
    const [osc1, osc2] = layout.nodes[VoiceNodeType.Oscillator];
    const [ampEnv] = layout.nodes[VoiceNodeType.Envelope];
    const filter = layout.nodes[VoiceNodeType.Filter][0]!;

    layout.connections = [
        // Basic signal flow
        { fromId: osc1!.id, toId: filter.id, target: ModulationTarget.Gain, amount: 1.0 },
        { fromId: osc2!.id, toId: filter.id, target: ModulationTarget.Gain, amount: 1.0 },

        // Default envelope routing
        { fromId: ampEnv!.id, toId: filter.id, target: ModulationTarget.Gain, amount: 1.0 }
    ];

    return layout;
};