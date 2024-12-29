import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { ModulationTarget, VoiceNodeType, type VoiceLayout } from 'src/audio/types/synth-layout';
import type { SynthLayout } from 'src/audio/types/synth-layout';
import type Instrument from 'src/audio/instrument';

describe('Routing System Tests', () => {
    let store: ReturnType<typeof useAudioSystemStore>;

    const createTestLayout = (): SynthLayout => ({
        voices: [
            {
                id: 0,
                nodes: {
                    [VoiceNodeType.Oscillator]: [
                        { id: 1, type: VoiceNodeType.Oscillator },
                        { id: 2, type: VoiceNodeType.Oscillator }
                    ],
                    [VoiceNodeType.Envelope]: [
                        { id: 3, type: VoiceNodeType.Envelope }
                    ],
                    [VoiceNodeType.LFO]: [
                        { id: 4, type: VoiceNodeType.LFO }
                    ],
                    [VoiceNodeType.Filter]: [
                        { id: 5, type: VoiceNodeType.Filter }
                    ]
                },
                connections: []
            }
        ],
        globalNodes: {},
        metadata: {
            maxVoices: 8,
            maxOscillators: 2,
            maxEnvelopes: 2,
            maxLFOs: 2,
            maxFilters: 1,
            stateVersion: 0
        }
    });

    // Helper function to safely get connections
    const getConnections = () => {
        if (!store.synthLayout?.voices[0]?.connections) {
            throw new Error('Store not properly initialized');
        }
        return store.synthLayout.voices[0].connections;
    };

    beforeEach(() => {
        setActivePinia(createPinia());
        store = useAudioSystemStore();
        store.currentInstrument = {
            createModulation: vi.fn(),
            updateConnection: vi.fn()
        } as unknown as Instrument;
        store.updateSynthLayout(createTestLayout());
    });

    it('should properly initialize the synth layout with connections array', () => {
        const layout = createTestLayout();
        store.updateSynthLayout(layout);

        if (!store.synthLayout?.voices[0]) {
            throw new Error('Store layout not properly initialized');
        }

        expect(store.synthLayout).toBeTruthy();
        expect(store.synthLayout.voices[0]).toBeTruthy();
        expect(Array.isArray(store.synthLayout.voices[0].connections)).toBe(true);
        expect(store.currentInstrument).toBeTruthy();
    });

    it('should add a new modulation connection', () => {
        const connection = {
            fromId: 3,
            toId: 1,
            target: ModulationTarget.Gain,
            amount: 0.5
        };

        store.updateConnection(connection);
        const connections = getConnections();

        expect(connections).toHaveLength(1);
        expect(connections[0]).toEqual(connection);
    });

    it('should allow multiple modulation sources to the same target', () => {
        const envConnection = {
            fromId: 3,
            toId: 1,
            target: ModulationTarget.Gain,
            amount: 0.5
        };

        const lfoConnection = {
            fromId: 4,
            toId: 1,
            target: ModulationTarget.Gain,
            amount: 0.3
        };

        store.updateConnection(envConnection);
        store.updateConnection(lfoConnection);

        const connections = getConnections();
        expect(connections).toHaveLength(2);
        expect(connections).toContainEqual(envConnection);
        expect(connections).toContainEqual(lfoConnection);
    });

    it('should only update amount for existing connection with same source/target/parameter', () => {
        const initialConnection = {
            fromId: 3,
            toId: 1,
            target: ModulationTarget.Gain,
            amount: 0.5
        };

        const updatedConnection = {
            ...initialConnection,
            amount: 0.7
        };

        store.updateConnection(initialConnection);
        store.updateConnection(updatedConnection);

        const connections = getConnections();
        expect(connections).toHaveLength(1);
        const firstConnection = connections[0];
        if (!firstConnection) {
            throw new Error('Connection not found');
        }
        expect(firstConnection.amount).toBe(0.7);
    });

    it('should allow different parameters from same source to same target', () => {
        const gainModulation = {
            fromId: 4,
            toId: 1,
            target: ModulationTarget.Gain,
            amount: 0.5
        };

        const freqModulation = {
            fromId: 4,
            toId: 1,
            target: ModulationTarget.Frequency,
            amount: 0.3
        };

        store.updateConnection(gainModulation);
        store.updateConnection(freqModulation);

        const connections = getConnections();
        expect(connections).toHaveLength(2);
        expect(connections).toContainEqual(gainModulation);
        expect(connections).toContainEqual(freqModulation);
    });

    it('should update connections consistently across all voices', () => {
        const multiVoiceLayout = createTestLayout();
        if (!multiVoiceLayout.voices[0]?.nodes) {
            throw new Error('First voice not properly initialized');
        }

        const secondVoice: VoiceLayout = {
            id: 1,
            nodes: { ...multiVoiceLayout.voices[0].nodes },
            connections: []
        };
        multiVoiceLayout.voices.push(secondVoice);
        store.updateSynthLayout(multiVoiceLayout);

        const connection = {
            fromId: 3,
            toId: 1,
            target: ModulationTarget.Gain,
            amount: 0.5
        };

        store.updateConnection(connection);

        // Assert store layout exists
        if (!store.synthLayout) {
            throw new Error('Store layout not initialized');
        }

        const voice0 = store.synthLayout.voices[0];
        const voice1 = store.synthLayout.voices[1];

        if (!voice0?.connections || !voice1?.connections) {
            throw new Error('Voice connections not properly initialized');
        }

        expect(voice0.connections).toHaveLength(1);
        expect(voice1.connections).toHaveLength(1);

        const connection0 = voice0.connections[0];
        const connection1 = voice1.connections[0];

        if (!connection0 || !connection1) {
            throw new Error('Connections not found');
        }

        expect(connection0).toEqual(connection);
        expect(connection1).toEqual(connection);
    });

    it('should remove only the specific connection when explicitly removing it', () => {
        // Add two different modulations
        const envConnection = {
            fromId: 3,
            toId: 1,
            target: ModulationTarget.Gain,
            amount: 0.5
        };

        const lfoConnection = {
            fromId: 4,
            toId: 1,
            target: ModulationTarget.Gain,
            amount: 0.3
        };

        store.updateConnection(envConnection);
        store.updateConnection(lfoConnection);

        // Remove only the LFO connection using explicit removal flag
        store.updateConnection({
            ...lfoConnection,
            amount: 0,
            isRemoving: true
        });

        const connections = getConnections();
        expect(connections).toHaveLength(1);
        expect(connections[0]).toEqual(envConnection);
    });

    // Add a new test for zero amount behavior
    it('should allow zero amount without removing connection', () => {
        const connection = {
            fromId: 3,
            toId: 1,
            target: ModulationTarget.Gain,
            amount: 0.5
        };

        // Add initial connection
        store.updateConnection(connection);

        // Update to zero amount
        store.updateConnection({
            ...connection,
            amount: 0
        });

        const connections = getConnections();
        expect(connections).toHaveLength(1);
        expect(connections[0]).toEqual({
            ...connection,
            amount: 0
        });
    });

    it('should handle multiple parameter modulations from the same source', () => {
        const connections = [
            {
                fromId: 4,
                toId: 1,
                target: ModulationTarget.Gain,
                amount: 0.5
            },
            {
                fromId: 4,
                toId: 1,
                target: ModulationTarget.Frequency,
                amount: 0.3
            },
            {
                fromId: 4,
                toId: 1,
                target: ModulationTarget.PhaseMod,
                amount: 0.2
            }
        ];

        connections.forEach(conn => store.updateConnection(conn));

        const storedConnections = getConnections();
        expect(storedConnections).toHaveLength(3);
        connections.forEach(conn => {
            expect(storedConnections).toContainEqual(conn);
        });
    });

    it('should preserve existing gain modulation when adding new gain modulation', () => {
        // Setup initial envelope to gain modulation
        const envToGainConnection = {
            fromId: 2, // Envelope
            toId: 0,   // Oscillator 1
            target: ModulationTarget.Gain,
            amount: 1.0
        };

        // Add envelope modulation first
        store.updateConnection(envToGainConnection);

        // Add LFO to gain modulation
        const lfoToGainConnection = {
            fromId: 4, // LFO
            toId: 0,   // Oscillator 1
            target: ModulationTarget.Gain,
            amount: 0.5
        };

        // Add LFO modulation
        store.updateConnection(lfoToGainConnection);

        // Get the connections
        const connections = store.synthLayout?.voices[0]!.connections;

        // Verify both connections exist
        expect(connections).toBeDefined();
        expect(connections).toHaveLength(2);
        expect(connections).toContainEqual(envToGainConnection);
        expect(connections).toContainEqual(lfoToGainConnection);

        // Verify exact amounts are preserved
        const envConnection = connections?.find(c => c.fromId === 2);
        const lfoConnection = connections?.find(c => c.fromId === 4);
        expect(envConnection?.amount).toBe(1.0);
        expect(lfoConnection?.amount).toBe(0.5);
    });
});