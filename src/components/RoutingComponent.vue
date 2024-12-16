<template>
  <div class="routing-section">
    <q-expansion-item
      group="routing"
      icon="share"
      label="Modulation Routing"
      header-class="bg-dark text-white"
      dark
      expand-icon-class="text-white"
    >
      <q-card dark class="bg-dark">
        <q-card-section>
          <q-btn
            color="primary"
            icon="add"
            label="Add Routing"
            @click="addNewRoute"
            class="q-mb-md"
          />

          <div
            v-for="(route, index) in activeRoutes"
            :key="index"
            class="route-item q-mb-sm"
          >
            <div class="row q-col-gutter-sm items-center">
              <!-- Target Node Selection -->
              <div class="col-4">
                <q-select
                  :model-value="route.targetId"
                  @update:model-value="
                    (val) => {
                      console.log('Target select changed:', {
                        oldVal: route.targetId,
                        newVal: val,
                      });
                      updateRoute(index, { targetId: val });
                    }
                  "
                  :options="availableTargetNodes"
                  label="Target"
                  dense
                  dark
                  filled
                  option-value="id"
                  option-label="name"
                />
              </div>

              <!-- Parameter Selection -->
              <div class="col-4">
                <q-select
                  :model-value="route.target"
                  @update:model-value="
                    (val) => {
                      console.log('Parameter select changed:', {
                        oldVal: route.target,
                        newVal: val,
                      });
                      updateRoute(index, { target: val });
                    }
                  "
                  :options="getAvailableParams(route.targetId)"
                  label="Parameter"
                  dense
                  dark
                  filled
                />
              </div>

              <!-- Amount Slider -->
              <div class="col-3">
                <q-slider
                  :model-value="route.amount"
                  @update:model-value="
                    updateRoute(index, { amount: $event ?? 0 })
                  "
                  :min="-1"
                  :max="1"
                  :step="0.01"
                  label
                  label-always
                  dark
                />
              </div>

              <!-- Delete Button -->
              <div class="col-1">
                <q-btn
                  flat
                  round
                  color="negative"
                  icon="delete"
                  @click="removeRoute(index)"
                  dense
                />
              </div>
            </div>
          </div>
        </q-card-section>
      </q-card>
    </q-expansion-item>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import type { ModulationTargetOption } from 'src/audio/types/synth-layout';
import { ModulationTarget, VoiceNodeType } from 'src/audio/types/synth-layout';

interface Props {
  sourceId: number;
}

interface TargetNode {
  id: number;
  name: string;
  type: VoiceNodeType;
}

interface RouteConfig {
  targetId: number;
  target: ModulationTarget;
  amount: number;
}

type RouteUpdate = {
  targetId?: number | TargetNode;
  target?: ModulationTarget | ModulationTargetOption;
  amount?: number;
};

const props = defineProps<Props>();
const store = useAudioSystemStore();
const activeRoutes = ref<RouteConfig[]>([]);

// Get all available target nodes (using voice 0 as reference)
const availableTargetNodes = computed((): TargetNode[] => {
  const nodes: TargetNode[] = [];
  const voice = store.synthLayout?.voices[0];
  if (!voice) return nodes;

  // Get all nodes in the voice
  for (const type of Object.values(VoiceNodeType)) {
    const typeNodes = voice.nodes[type];
    typeNodes.forEach((node, index) => {
      // Don't include self as target
      if (node.id !== props.sourceId) {
        nodes.push({
          id: node.id,
          name: `${type} ${index + 1}`,
          type: type,
        });
      }
    });
  }

  return nodes;
});

// Get available parameters based on target node type
const getAvailableParams = (targetId: number): ModulationTargetOption[] => {
  const targetNode = availableTargetNodes.value.find((n) => n.id === targetId);
  if (!targetNode) {
    console.log('No target node found for id:', targetId);
    return [];
  }

  let params: ModulationTargetOption[];
  switch (targetNode.type) {
    case VoiceNodeType.Oscillator:
      params = [
        { value: ModulationTarget.Frequency, label: 'Frequency' },
        { value: ModulationTarget.PhaseMod, label: 'Phase' },
        { value: ModulationTarget.Gain, label: 'Gain' },
      ];
      break;
    case VoiceNodeType.Filter:
      params = [
        { value: ModulationTarget.FilterCutoff, label: 'Cutoff' },
        { value: ModulationTarget.FilterResonance, label: 'Resonance' },
      ];
      break;
    default:
      params = [];
  }

  console.log('Available params for target:', {
    targetId,
    targetType: targetNode.type,
    params,
  });

  return params;
};

const updateRoute = (index: number, update: RouteUpdate) => {
  console.log('updateRoute:', { index, update });
  const route = activeRoutes.value[index];
  if (!route) return;

  // Create a new route object with updates
  const updatedRoute: RouteConfig = {
    ...route,
  };

  // Handle target node change
  if (update.targetId !== undefined) {
    // Extract ID if we received a full node object
    const newTargetId =
      typeof update.targetId === 'object'
        ? (update.targetId as TargetNode).id
        : update.targetId;

    console.log('Target changed:', {
      oldTarget: route.targetId,
      newTarget: newTargetId,
    });

    // First remove the old connection
    store.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: 0, // Remove old connection
    });

    updatedRoute.targetId = newTargetId;

    // When changing target, set a default parameter if we don't already have one
    const params = getAvailableParams(newTargetId);
    console.log('Available params for new target:', params);

    if (params.length > 0) {
      // Keep existing parameter if it's valid for new target, otherwise use first available
      const isCurrentParamValid = params.some((p) => p.value === route.target);
      updatedRoute.target = isCurrentParamValid
        ? route.target
        : params[0]!.value;

      console.log('Parameter selection:', {
        keptExisting: isCurrentParamValid,
        oldParam: route.target,
        newParam: updatedRoute.target,
      });
    }
  }

  // Handle parameter change
  if (update.target !== undefined) {
    // Remove old connection first
    store.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: 0,
    });

    updatedRoute.target =
      typeof update.target === 'number' ? update.target : update.target.value;
  }

  // Handle amount change - but don't remove connection when amount is 0
  if (update.amount !== undefined) {
    updatedRoute.amount = update.amount;
  }

  // Update local state
  activeRoutes.value[index] = updatedRoute;

  // Then create the new connection
  store.updateConnection({
    fromId: props.sourceId,
    toId: updatedRoute.targetId,
    target: updatedRoute.target,
    amount: updatedRoute.amount,
  });
};

const addNewRoute = () => {
  const defaultTarget = availableTargetNodes.value[0];
  if (!defaultTarget) return;

  const defaultParams = getAvailableParams(defaultTarget.id);
  if (defaultParams.length === 0) return;

  const firstParam = defaultParams[0];
  if (!firstParam) return;

  console.log('Creating new route with params:', {
    targetId: defaultTarget.id,
    target: firstParam.value,
  });

  // Create new route with default values but tiny non-zero amount
  const newRoute: RouteConfig = {
    targetId: defaultTarget.id,
    target: firstParam.value,
    amount: 0.0001, // Start with tiny amount instead of 0
  };

  // Add to active routes
  activeRoutes.value.push(newRoute);

  // Immediately create the connection
  store.updateConnection({
    fromId: props.sourceId,
    toId: newRoute.targetId,
    target: newRoute.target,
    amount: newRoute.amount,
  });
};

const removeRoute = (index: number) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  // Remove connection by setting amount to 0
  store.updateConnection({
    fromId: props.sourceId,
    toId: route.targetId,
    target: route.target,
    amount: 0,
  });

  // Remove from local state
  activeRoutes.value.splice(index, 1);
};

// Initialize existing connections on mount
onMounted(() => {
  const connections = store.getNodeConnections(props.sourceId);
  activeRoutes.value = connections.map((conn) => ({
    targetId: conn.toId,
    target:
      typeof conn.target === 'number'
        ? conn.target
        : (conn.target as ModulationTargetOption).value,
    amount: conn.amount,
  }));
});

// Watch for external connection changes
watch(
  () => store.getNodeConnections(props.sourceId),
  (newConnections) => {
    type ConnectionType = {
      fromId: number;
      toId: number;
      target: ModulationTarget | ModulationTargetOption;
      amount: number;
    };

    const getTargetValue = (
      target: ModulationTarget | ModulationTargetOption,
    ): ModulationTarget => {
      if (typeof target === 'number') {
        return target;
      }
      return (target as ModulationTargetOption).value;
    };

    // Only update if we have a different number of connections
    // or if connections are actually different
    const currentConnections = activeRoutes.value.map((route) => ({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: route.amount,
    }));

    // Create a comparison function that ignores object references
    const compareConnections = (a: ConnectionType[], b: ConnectionType[]) => {
      if (a.length !== b.length) return false;
      return a.every((conn, i) => {
        const newConn = b[i];
        if (!newConn) return false;
        return (
          conn.fromId === newConn.fromId &&
          conn.toId === newConn.toId &&
          getTargetValue(conn.target) === getTargetValue(newConn.target) &&
          conn.amount === newConn.amount
        );
      });
    };

    if (!compareConnections(currentConnections, newConnections)) {
      // Update routes without triggering new connections
      activeRoutes.value = newConnections.map((conn) => ({
        targetId: conn.toId,
        target: getTargetValue(conn.target),
        amount: conn.amount,
      }));
    }
  },
  { deep: true },
);
</script>

<style scoped>
.routing-section {
  margin: 1rem 0;
}

.route-item {
  padding: 0.5rem;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
}

:deep(.q-field__label) {
  color: rgba(255, 255, 255, 0.7);
}

:deep(.q-slider__track) {
  background: rgba(255, 255, 255, 0.28);
}

:deep(.q-slider__thumb) {
  background: white;
}
</style>
