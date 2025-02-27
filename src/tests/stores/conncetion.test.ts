import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock store and methods
const store = {
    updateConnection: vi.fn(),
};

// Mock props
const props = {
    sourceId: 999, // just an arbitrary source node id
};

// Mock getAvailableParams to always return at least one parameter option
function getAvailableParams(_targetId: number) {
    return [
        { value: ModulationTarget.Gain, label: 'Gain' },
        { value: ModulationTarget.Frequency, label: 'Frequency' },
    ];
}

// Enums and interfaces as placeholders
enum ModulationTarget {
    Gain = 1,
    Frequency = 0,
    PhaseMod = 4
}

interface RouteConfig {
    targetId: number;
    target: ModulationTarget;
    amount: number;
}

interface RouteUpdate {
    targetId?: number;
    target?: ModulationTarget;
    amount?: number;
}

// interface TargetNode {
//     id: number;
//     name: string;
// }

// The activeRoutes array is what we're manipulating
const activeRoutes = { value: [] as RouteConfig[] };

// This is the updateRoute function we are testing
function updateRoute(index: number, update: RouteUpdate) {
    const oldRoute = activeRoutes.value[index];
    if (!oldRoute) return;

    const updatedRoute: RouteConfig = {
        targetId: oldRoute.targetId,
        target: oldRoute.target,
        amount: oldRoute.amount,
    };

    let targetChanged = false;
    let parameterChanged = false;

    // Check targetId
    if (update.targetId !== undefined) {
        const newTargetId = update.targetId;
        if (newTargetId !== oldRoute.targetId) {
            updatedRoute.targetId = newTargetId;
            targetChanged = true;
            // Validate parameter
            const params = getAvailableParams(newTargetId);
            if (params.length > 0 && !params.some(p => p.value === updatedRoute.target)) {
                updatedRoute.target = params[0]!.value;
                parameterChanged = true;
            }
        }
    }

    // Check parameter
    if (update.target !== undefined) {
        const newTargetValue = update.target;
        if (newTargetValue !== oldRoute.target) {
            updatedRoute.target = newTargetValue;
            parameterChanged = true;
        }
    }

    // Check amount
    if (update.amount !== undefined) {
        updatedRoute.amount = update.amount;
    }

    const connectionChanged = targetChanged || parameterChanged;
    if (connectionChanged) {
        // Remove old connection
        store.updateConnection({
            fromId: props.sourceId,
            toId: oldRoute.targetId,
            target: oldRoute.target,
            amount: 0,
            isRemoving: true,
        });
    }

    activeRoutes.value[index] = updatedRoute;

    // Add/update new connection
    store.updateConnection({
        fromId: props.sourceId,
        toId: updatedRoute.targetId,
        target: updatedRoute.target,
        amount: updatedRoute.amount,
    });
}

// Now we write tests

describe('updateRoute function', () => {
    beforeEach(() => {
        // Reset mocks and routes
        store.updateConnection.mockClear();
        activeRoutes.value = [];
    });

    it('should not remove an existing envelope route when adding a new LFO route to the same target parameter', () => {
        // Suppose we start with an envelope-to-gain route at index 0
        activeRoutes.value.push({
            targetId: 100,
            target: ModulationTarget.Gain,
            amount: 1.0,
        });

        // Add another route, LFO-to-gain, at index 1
        activeRoutes.value.push({
            targetId: 100,
            target: ModulationTarget.Gain,
            amount: 0.5,
        });

        // Initially, we have two routes pointing to the same target parameter but from different indexes
        expect(activeRoutes.value.length).toBe(2);

        // Now, simulate updating the LFO route at index 1 - just changing the amount
        updateRoute(1, { amount: 0.7 });

        // Check store calls
        // Because we only changed amount (and not targetId or target), connectionChanged is false
        // So we should NOT remove the old connection (no removal call)
        // And we should only update the new connection once
        const calls = store.updateConnection.mock.calls;
        expect(calls.length).toBe(1);
        expect(calls[0]![0]).toEqual({
            fromId: props.sourceId,
            toId: 100,
            target: ModulationTarget.Gain,
            amount: 0.7,
        });

        // The first route (envelope route at index 0) should remain unchanged
        expect(activeRoutes.value[0]).toEqual({
            targetId: 100,
            target: ModulationTarget.Gain,
            amount: 1.0,
        });
    });

    it('should remove the old connection if target node changes', () => {
        // Start with a single route
        activeRoutes.value.push({
            targetId: 200,
            target: ModulationTarget.Gain,
            amount: 1.0,
        });

        // Change targetId to a new node
        updateRoute(0, { targetId: 201 });

        // Verify calls
        const calls = store.updateConnection.mock.calls;

        // First call should remove old connection
        expect(calls[0]![0]).toEqual({
            fromId: props.sourceId,
            toId: 200,
            target: ModulationTarget.Gain,
            amount: 0,
            isRemoving: true
        });

        // Second call should add the new connection
        expect(calls[1]![0]).toEqual({
            fromId: props.sourceId,
            toId: 201,
            target: ModulationTarget.Gain,
            amount: 1.0
        });
    });
});
